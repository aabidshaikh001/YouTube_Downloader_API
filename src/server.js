'use strict';

const http = require('http');
const config = require('./config/config');
const logger = require('./utils/logger');
const app = require('./app');
const jobService = require('./services/job.service');
const healthService = require('./services/health.service');
const { startCleanupLoop, removeDirQuiet } = require('./utils/fileCleanup');

jobService.ensureBaseDir();

// Background service probe (yt-dlp / ffmpeg / ffprobe versions) —
// runs on a schedule, never inside a request, so /health answers
// instantly. See services/health.service.js for why this matters.
healthService.start();

// Background cleanup: expire + remove old jobs and orphaned files.
// The callback removes an expired job's whole temp directory.
startCleanupLoop(jobService.jobs, id => removeDirQuiet(jobService.jobDir(id)));

const server = http.createServer(app);

server.listen(config.port, config.host, () => {
  logger.info(`YouTube Downloader API listening on ${config.host}:${config.port} (env: ${config.nodeEnv})`);
  logger.info(`Jobs: in-memory only, TTL ${config.jobTtlMinutes} min, cleanup every ${config.cleanupIntervalMinutes} min, max ${config.maxConcurrentDownloads} concurrent, max ${config.maxDownloadSizeMB} MB`);
});

// Graceful shutdown: stop taking requests, kill any running
// downloads, then exit. Temp files are left to the OS (ephemeral
// disk) — a restart loses all jobs by design.
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`Received ${signal} — shutting down`);
  server.close(() => {
    for (const [id, job] of jobService.jobs) {
      jobService.deleteJob(id);
    }
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 10000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
