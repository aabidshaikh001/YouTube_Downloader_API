'use strict';

const fs = require('fs');
const path = require('path');
const config = require('../config/config');
const logger = require('../utils/logger');
const jobService = require('./job.service');
const ytdlp = require('./ytdlp.service');
const ffmpeg = require('./ffmpeg.service');
const { sanitizeFilename } = require('../utils/validators');
const { removeDirQuiet, removeFileQuiet } = require('../utils/fileCleanup');

// The queue: at most MAX_CONCURRENT_DOWNLOADS jobs run at once.
// Everything else waits in the Map with status "queued" — RAM only,
// no queue table. A worker loop picks the next job when a slot frees.

let workerRunning = false;

function maybeStartWorker() {
  if (workerRunning) return;
  workerRunning = true;
  setImmediate(runQueue);
}

async function runQueue() {
  try {
    while (jobService.activeCount() < config.maxConcurrentDownloads) {
      const job = jobService.nextQueued();
      if (!job) break;
      // Run in the background — do not await here, so several jobs
      // can run up to the concurrency limit.
      processJob(job).catch(e => {
        logger.error(`Job ${job.jobId} failed: ${e.message}`);
      });
      // Let the next iteration see the updated active count.
      await new Promise(r => setImmediate(r));
    }
  } finally {
    workerRunning = false;
    // If jobs are still queued (all slots were busy), the next
    // finished job restarts the worker.
  }
}

function restartWorkerIfNeeded() {
  if (jobService.nextQueued() && jobService.activeCount() < config.maxConcurrentDownloads) {
    maybeStartWorker();
  }
}

async function processJob(job) {
  const dir = jobService.jobDir(job.jobId);
  try {
    jobService.ensureBaseDir();
    fs.mkdirSync(dir, { recursive: true });

    // 1) Fetch metadata: title, and the size limit check.
    jobService.touch(job, { status: 'fetching_info', progress: 0 });
    let info;
    try {
      info = await ytdlp.getInfo(job.videoUrl);
    } catch (e) {
      throw new Error(e.message);
    }
    jobService.touch(job, { title: info.title || job.title });
    const maxBytes = config.maxDownloadSizeMB * 1024 * 1024;
    const approxBytes = (info.formats || [])
      .filter(f => f.filesize)
      .sort((a, b) => (b.filesize || 0) - (a.filesize || 0))[0]?.filesize;
    if (approxBytes && approxBytes > maxBytes) {
      throw new Error(`This video is too large (about ${Math.round(approxBytes / 1024 / 1024)} MB — the limit is ${config.maxDownloadSizeMB} MB).`);
    }

    // 2) Download with yt-dlp (progress -> the Map, in real time).
    jobService.touch(job, { status: 'downloading', progress: 0 });
    const timeoutMs = config.downloadTimeoutMinutes * 60 * 1000;
    let producedPath;
    try {
      producedPath = await ytdlp.downloadMedia({
        url: job.videoUrl,
        jobDir: dir,
        kind: job.kind,
        quality: job.quality,
        format: job.format,
        timeoutMs,
        onSpawn: child => jobService.setRunning(job.jobId, child),
        onProgress: p => {
          const patch = { progress: Math.min(100, Math.max(0, Math.round(p.progress || 0))) };
          if (p.totalBytes) patch.totalBytes = p.totalBytes;
          if (p.speed) patch.speed = p.speed;
          if (p.eta) patch.eta = p.eta;
          if (p.totalBytes && p.progress) {
            patch.downloadedBytes = Math.round((p.totalBytes * p.progress) / 100);
          }
          if (patch.downloadedBytes && patch.downloadedBytes > maxBytes) {
            const child = jobService.getRunning(job.jobId);
            if (child) child.kill('SIGKILL');
          }
          jobService.touch(job, patch);
        },
      });
    } finally {
      jobService.setRunning(job.jobId, null);
    }

    // 3) Processing: make sure a video download is a playable MP4.
    // yt-dlp already merged to mp4 when asked. Only re-encode when
    // the video codec is not H.264 (e.g. only VP9/AV1 was available).
    jobService.touch(job, { status: 'processing', progress: 100 });
    let finalPath = producedPath;
    let finalExt = path.extname(producedPath).replace(/^\./, '').toLowerCase();
    if (job.kind === 'video' && (job.format === 'mp4')) {
      try {
        const probe = await ffmpeg.probe(producedPath);
        if (probe.videoCodec && probe.videoCodec !== 'h264') {
          logger.info(`Job ${job.jobId}: video is ${probe.videoCodec}, converting to H.264`);
          const converted = path.join(dir, 'output-converted.mp4');
          await ffmpeg.convertToH264(producedPath, converted);
          removeFileQuiet(producedPath);
          finalPath = converted;
          finalExt = 'mp4';
        }
      } catch (e) {
        // Probing/conversion failing must not lose a finished file.
        logger.warn(`Job ${job.jobId}: post-processing skipped (${e.message})`);
      }
    }
    // Remove any intermediate files (partial downloads, .ytdl, …).
    for (const f of fs.readdirSync(dir)) {
      const full = path.join(dir, f);
      if (full !== finalPath) removeFileQuiet(full);
    }

    const stat = fs.statSync(finalPath);
    const filename = sanitizeFilename(job.title, finalExt);
    jobService.touch(job, {
      status: 'completed',
      progress: 100,
      downloadedBytes: stat.size,
      totalBytes: stat.size,
      filePath: finalPath,
      filename,
      speed: null,
      eta: null,
      expiresAt: Date.now() + config.jobTtlMinutes * 60 * 1000,
    });
    logger.info(`Job ${job.jobId} completed: ${filename} (${Math.round(stat.size / 1024 / 1024)} MB)`);
  } catch (e) {
    // Failure: no partial files left behind, no half job.
    jobService.setRunning(job.jobId, null);
    removeDirQuiet(dir);
    jobService.touch(job, {
      status: 'failed',
      error: e.message || 'Download failed.',
      speed: null,
      eta: null,
    });
    logger.error(`Job ${job.jobId} failed: ${e.message}`);
  } finally {
    restartWorkerIfNeeded();
  }
}

function startDownload({ url, quality, format }) {
  const existing = jobService.findDuplicate({ videoUrl: url, kind: 'video', quality, format });
  if (existing) {
    logger.info(`Duplicate video download — returning existing job ${existing.jobId}`);
    return { job: existing, duplicate: true };
  }
  const job = jobService.createJob({ videoUrl: url, title: null, kind: 'video', quality, format });
  logger.info(`Video download queued: ${job.jobId} (${url} @ ${quality}, ${format})`);
  maybeStartWorker();
  return { job, duplicate: false };
}

function startAudio({ url, format, quality }) {
  const existing = jobService.findDuplicate({ videoUrl: url, kind: 'audio', quality, format });
  if (existing) {
    logger.info(`Duplicate audio download — returning existing job ${existing.jobId}`);
    return { job: existing, duplicate: true };
  }
  const job = jobService.createJob({ videoUrl: url, title: null, kind: 'audio', quality, format });
  logger.info(`Audio download queued: ${job.jobId} (${url}, ${format} ${quality})`);
  maybeStartWorker();
  return { job, duplicate: false };
}

module.exports = { startDownload, startAudio, processJob, restartWorkerIfNeeded };
