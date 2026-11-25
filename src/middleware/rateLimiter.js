'use strict';

const rateLimit = require('express-rate-limit');
const config = require('../config/config');

function limiterHandler(req, res) {
  return res.status(429).json({
    success: false,
    error: {
      code: 'RATE_LIMITED',
      message: 'Too many requests — please wait a moment and try again.',
    },
  });
}

// General API limit: applies to every route.
const apiLimiter = rateLimit({
  windowMs: config.rateLimitWindowMinutes * 60 * 1000,
  max: config.rateLimitMax,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: limiterHandler,
});

// Stricter limit on starting downloads — a download is expensive
// (a yt-dlp process + a merge + disk), so starting one is capped
// separately from plain reads.
const downloadLimiter = rateLimit({
  windowMs: config.rateLimitWindowMinutes * 60 * 1000,
  max: config.downloadRateLimitMax,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: limiterHandler,
});

module.exports = { apiLimiter, downloadLimiter };
