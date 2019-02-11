'use strict';

const util = require('util');

const bodyParserMiddleware = require('../middlewares/body-parser');
const userMiddleware = require('../middlewares/user');
const { initializeProfilerMiddleware, finishProfilerMiddleware } = require('../middlewares/profiler');
const authorizationMiddleware = require('../middlewares/authorization');
const connectionParamsMiddleware = require('../middlewares/connection-params');
const errorMiddleware = require('../middlewares/error');
const rateLimitsMiddleware = require('../middlewares/rate-limit');
const { RATE_LIMIT_ENDPOINTS_GROUPS } = rateLimitsMiddleware;

function JobController(metadataBackend, userDatabaseService, jobService, statsdClient, userLimitsService) {
    this.metadataBackend = metadataBackend;
    this.userDatabaseService = userDatabaseService;
    this.jobService = jobService;
    this.statsdClient = statsdClient;
    this.userLimitsService = userLimitsService;
}

module.exports = JobController;

JobController.prototype.route = function (app) {
    const { base_url } = global.settings;
    const jobMiddlewares = composeJobMiddlewares(
        this.metadataBackend,
        this.userDatabaseService,
        this.jobService,
        this.statsdClient,
        this.userLimitsService
    );

    app.get(
        `${base_url}/jobs-wip`,
        bodyParserMiddleware(),
        listWorkInProgressJobs(this.jobService),
        sendResponse(),
        errorMiddleware()
    );
    app.post(
        `${base_url}/sql/job`,
        bodyParserMiddleware(),
        checkBodyPayloadSize(),
        jobMiddlewares('create', createJob, RATE_LIMIT_ENDPOINTS_GROUPS.JOB_CREATE)
    );
    app.get(
        `${base_url}/sql/job/:job_id`,
        bodyParserMiddleware(),
        jobMiddlewares('retrieve', getJob, RATE_LIMIT_ENDPOINTS_GROUPS.JOB_GET)
    );
    app.delete(
        `${base_url}/sql/job/:job_id`,
        bodyParserMiddleware(),
        jobMiddlewares('cancel', cancelJob, RATE_LIMIT_ENDPOINTS_GROUPS.JOB_DELETE)
    );
};

function composeJobMiddlewares (metadataBackend, userDatabaseService, jobService, statsdClient, userLimitsService) {
    return function jobMiddlewares (action, jobMiddleware, endpointGroup) {
        const forceToBeMaster = true;

        return [
            initializeProfilerMiddleware('job'),
            userMiddleware(metadataBackend),
            rateLimitsMiddleware(userLimitsService, endpointGroup),
            authorizationMiddleware(metadataBackend, forceToBeMaster),
            connectionParamsMiddleware(userDatabaseService),
            jobMiddleware(jobService),
            setServedByDBHostHeader(),
            finishProfilerMiddleware(),
            logJobResult(action),
            incrementSuccessMetrics(statsdClient),
            sendResponse(),
            incrementErrorMetrics(statsdClient),
            errorMiddleware()
        ];
    };
}

function cancelJob (jobService) {
    return function cancelJobMiddleware (req, res, next) {
        const { job_id } = req.params;

        jobService.cancel(job_id, (err, job) => {
            if (req.profiler) {
                req.profiler.done('cancelJob');
            }

            if (err) {
                return next(err);
            }

            res.body = job.serialize();

            next();
        });
    };
}

function getJob (jobService) {
    return function getJobMiddleware (req, res, next) {
        const { job_id } = req.params;

        jobService.get(job_id, (err, job) => {
            if (req.profiler) {
                req.profiler.done('getJob');
            }

            if (err) {
                return next(err);
            }

            res.body = job.serialize();

            next();
        });
    };
}

function createJob (jobService) {
    return function createJobMiddleware (req, res, next) {
        const params = Object.assign({}, req.query, req.body);

        var data = {
            user: res.locals.user,
            query: params.query,
            host: res.locals.userDbParams.host,
            port: global.settings.db_batch_port || res.locals.userDbParams.port,
            pass: res.locals.userDbParams.pass,
            dbname: res.locals.userDbParams.dbname,
            dbuser: res.locals.userDbParams.user
        };

        jobService.create(data, (err, job) => {
            if (req.profiler) {
                req.profiler.done('createJob');
            }

            if (err) {
                return next(err);
            }

            res.locals.job_id = job.job_id;

            res.statusCode = 201;
            res.body = job.serialize();

            next();
        });
    };
}

function listWorkInProgressJobs (jobService) {
    return function listWorkInProgressJobsMiddleware (req, res, next) {
        jobService.listWorkInProgressJobs((err, list) => {
            if (err) {
                return next(err);
            }

            res.body = list;

            next();
        });
    };
}

function getMaxQuerySizeInKBs(user) {
    // TODO: implement
    //return 32;
}

function max_limit_query_size_in_bytes() {
    // TODO: get the username somehow
    const user = null;
    return ( getMaxQuerySizeInKBs(user) || DEFAULT_MAX_LIMIT_QUERY_SIZE_IN_KB ) * ONE_KILOBYTE_IN_BYTES;
}

function max_limit_query_size_in_kb() {
    return max_limit_query_size_in_bytes / ONE_KILOBYTE_IN_BYTES;
}

function checkBodyPayloadSize () {
    return function checkBodyPayloadSizeMiddleware(req, res, next) {
        const payload = JSON.stringify(req.body);
        const payload_length = payload.length;
        const payload_max_size_bytes = max_limit_query_size_in_bytes();

        if (payload_length > payload_max_size_bytes) {
            return next(new Error(getMaxSizeErrorMessage(payload_length, payload_max_size_bytes)), res);
        }

        next();
    };
}

const ONE_KILOBYTE_IN_BYTES = 1024;
const DEFAULT_MAX_LIMIT_QUERY_SIZE_IN_KB = 16;
const DEFAULT_MAX_LIMIT_QUERY_SIZE_IN_BYTES = DEFAULT_MAX_LIMIT_QUERY_SIZE_IN_KB * ONE_KILOBYTE_IN_BYTES;

function getMaxSizeErrorMessage(payload_length, payload_max_size_bytes) {
    return util.format(
        [
            'Your payload is too large: %s bytes. Max size allowed is %s bytes (%skb).',
            'Are you trying to import data?.',
            'Please, check out import api http://docs.cartodb.com/cartodb-platform/import-api/'
        ].join(' '),
        payload_length,
        payload_max_size_bytes,
        Math.round(payload_max_size_bytes / ONE_KILOBYTE_IN_BYTES)
    );
}

module.exports.DEFAULT_MAX_LIMIT_QUERY_SIZE_IN_BYTES = DEFAULT_MAX_LIMIT_QUERY_SIZE_IN_BYTES;
module.exports.getMaxSizeErrorMessage = getMaxSizeErrorMessage;

function setServedByDBHostHeader () {
    return function setServedByDBHostHeaderMiddleware (req, res, next) {
        const { userDbParams } = res.locals;

        if (userDbParams.host) {
            res.header('X-Served-By-DB-Host', res.locals.userDbParams.host);
        }

        next();
    };
}

function logJobResult (action) {
    return function logJobResultMiddleware (req, res, next) {
        if (process.env.NODE_ENV !== 'test') {
            console.info(JSON.stringify({
                type: 'sql_api_batch_job',
                username: res.locals.user,
                action: action,
                job_id: req.params.job_id || res.locals.job_id
            }));
        }

        next();
    };
}

const METRICS_PREFIX = 'sqlapi.job';

function incrementSuccessMetrics (statsdClient) {
    return function incrementSuccessMetricsMiddleware (req, res, next) {
        if (statsdClient !== undefined) {
            statsdClient.increment(`${METRICS_PREFIX}.success`);
        }

        next();
    };
}

function incrementErrorMetrics (statsdClient) {
    return function incrementErrorMetricsMiddleware (err, req, res, next) {
        if (statsdClient !== undefined) {
            statsdClient.increment(`${METRICS_PREFIX}.error`);
        }

        next(err);
    };
}

function sendResponse () {
    return function sendResponseMiddleware (req, res) {
        res.status(res.statusCode || 200).send(res.body);
    };
}
