'use strict';

const fs = require('fs');
const ytdlp = require('../services/ytdlp.service');
const downloadService = require('../services/download.service');
const jobService = require('../services/job.service');
const { ok, accepted, fail } = require('../utils/response');
const {
  validateVideoUrl,
  parseQuality,
  parseAudioQuality,
  parseVideoFormat,
  parseAudioFormat,
} = require('../utils/validators');

// GET /api/video/info?url=...
async function getInfo(req, res, next) {
  try {
    const url = await validateVideoUrl(req.query.url);
    const info = await ytdlp.getInfo(url);
    return ok(res, { video: info });
  } catch (e) {
    const unavailable = e.code === 'YTDLP_UNAVAILABLE';
    return fail(res, unavailable ? 503 : 400, unavailable ? e.code : 'VIDEO_INFO_FAILED', e.message);
  }
}

// GET /api/video/formats?url=...
async function getFormats(req, res) {
  try {
    const url = await validateVideoUrl(req.query.url);
    const formats = await ytdlp.getFormats(url);
    return ok(res, { formats });
  } catch (e) {
    const unavailable = e.code === 'YTDLP_UNAVAILABLE';
    return fail(res, unavailable ? 503 : 400, unavailable ? e.code : 'FORMATS_FAILED', e.message);
  }
}

// POST /api/video/download  { url, quality, format }
async function startDownload(req, res) {
  try {
    const { url: rawUrl, quality: rawQuality, format: rawFormat } = req.body || {};
    const url = await validateVideoUrl(rawUrl);
    const quality = parseQuality(rawQuality, 'best');
    const format = parseVideoFormat(rawFormat, 'mp4');
    const { job, duplicate } = downloadService.startDownload({ url, quality, format });
    return accepted(res, {
      jobId: job.jobId,
      status: job.status,
      duplicate: !!duplicate,
      message: duplicate
        ? 'This download is already running — returning the existing job.'
        : 'Download queued.',
    });
  } catch (e) {
    return fail(res, 400, 'DOWNLOAD_START_FAILED', e.message);
  }
}

// POST /api/video/audio  { url, format, quality }
async function startAudio(req, res) {
  try {
    const { url: rawUrl, format: rawFormat, quality: rawQuality } = req.body || {};
    const url = await validateVideoUrl(rawUrl);
    const format = parseAudioFormat(rawFormat, 'mp3');
    const quality = parseAudioQuality(rawQuality, '192');
    const { job, duplicate } = downloadService.startAudio({ url, format, quality });
    return accepted(res, {
      jobId: job.jobId,
      status: job.status,
      duplicate: !!duplicate,
      message: duplicate
        ? 'This audio download is already running — returning the existing job.'
        : 'Audio download queued.',
    });
  } catch (e) {
    return fail(res, 400, 'AUDIO_START_FAILED', e.message);
  }
}

// GET /api/video/jobs/:jobId
function getJob(req, res) {
  const job = jobService.getJob(req.params.jobId);
  if (!job) {
    return fail(res, 404, 'JOB_NOT_FOUND', 'No job with that ID exists (it may have expired or the server restarted).');
  }
  return ok(res, { job: jobService.publicJob(job) });
}

// GET /api/video/jobs/:jobId/download
function downloadFile(req, res) {
  const job = jobService.getJob(req.params.jobId);
  if (!job) {
    return fail(res, 404, 'JOB_NOT_FOUND', 'No job with that ID exists (it may have expired or the server restarted).');
  }
  if (job.status === 'expired') {
    return fail(res, 410, 'JOB_EXPIRED', 'This file has expired and was deleted. Start a new download.');
  }
  if (job.status !== 'completed' || !job.filePath) {
    return fail(res, 409, 'JOB_NOT_READY', `This job is ${job.status} — the file is not ready to download yet.`);
  }
  if (!fs.existsSync(job.filePath)) {
    return fail(res, 410, 'FILE_GONE', 'The finished file is no longer on the server (it expired). Start a new download.');
  }
  // Stream the file; res.download sets Content-Type (from the
  // extension) and Content-Disposition with the safe filename
  // (already sanitized when the job completed).
  return res.download(job.filePath, job.filename, { dotfiles: 'deny' }, err => {
    if (err && !res.headersSent) {
      res.status(500).json({ success: false, error: { code: 'DOWNLOAD_FAILED', message: 'Could not send the file.' } });
    }
  });
}

// DELETE /api/video/jobs/:jobId — cancel a running job, or delete a
// finished/failed one, and remove its files.
function deleteJob(req, res) {
  const job = jobService.getJob(req.params.jobId);
  if (!job) {
    return fail(res, 404, 'JOB_NOT_FOUND', 'No job with that ID exists (it may have expired or the server restarted).');
  }
  const wasRunning = ['queued', 'fetching_info', 'downloading', 'processing'].includes(job.status);
  jobService.deleteJob(req.params.jobId);
  return ok(res, {
    jobId: req.params.jobId,
    cancelled: wasRunning,
    message: wasRunning ? 'Download cancelled and files removed.' : 'Job and files removed.',
  });
}

module.exports = {
  getInfo,
  getFormats,
  startDownload,
  startAudio,
  getJob,
  downloadFile,
  deleteJob,
};
