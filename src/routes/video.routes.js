'use strict';

const express = require('express');
const controller = require('../controllers/video.controller');
const { downloadLimiter } = require('../middleware/rateLimiter');

const router = express.Router();

// Read-only lookups (no download started).
router.get('/info', controller.getInfo);
router.get('/formats', controller.getFormats);

// Start a download — stricter rate limit (a download is expensive).
router.post('/download', downloadLimiter, controller.startDownload);
router.post('/audio', downloadLimiter, controller.startAudio);

// One job: status, finished file, delete/cancel.
router.get('/jobs/:jobId', controller.getJob);
router.get('/jobs/:jobId/download', controller.downloadFile);
router.delete('/jobs/:jobId', controller.deleteJob);

module.exports = router;
