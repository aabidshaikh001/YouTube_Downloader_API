'use strict';

const config = require('../config/config');
const logger = require('../utils/logger');
const { fail } = require('../utils/response');

function notFound(req, res) {
  return fail(res, 404, 'NOT_FOUND', `No route matches ${req.method} ${req.originalUrl}.`);
}

// Last middleware. Never leak a stack trace or an internal path to
// the client — log it, return a generic message.
function errorHandler(err, req, res, next) {
  logger.error(`Error on ${req.method} ${req.originalUrl}: ${err.message}`);
  if (config.nodeEnv !== 'production' && err.stack) {
    logger.error(err.stack);
  }
  if (res.headersSent) return next(err);
  const status = err.status && Number.isInteger(err.status) ? err.status : 500;
  const code = err.code || 'INTERNAL_ERROR';
  const message = status >= 500
    ? 'Something went wrong on the server. Try again in a moment.'
    : (err.message || 'Request failed.');
  return fail(res, status, code, message);
}

module.exports = { notFound, errorHandler };
