'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const config = require('../config/config');
const { removeDirQuiet } = require('../utils/fileCleanup');

// The whole "database": one in-memory Map. When the process exits,
// every job is gone — that is the design, not a bug.
// A job never leaves this module except as a public copy (see
// publicJob), so callers cannot mutate it or see internal paths.
const jobs = new Map();

// Running yt-dlp child processes, by jobId — kept apart from the
// job object so the job stays plain JSON.
const running = new Map();

const STATUSES = ['queued', 'fetching_info', 'downloading', 'processing', 'completed', 'failed', 'expired'];

function jobDir(id) {
  return path.join(config.baseTmpDir, id);
}

function createJob({ videoUrl, title, kind, quality, format }) {
  const now = Date.now();
  const id = crypto.randomUUID();
  const job = {
    jobId: id,
    videoUrl,
    title: title || 'Untitled video',
    kind, // 'video' | 'audio'
    status: 'queued',
    progress: 0,
    speed: null, // bytes per second
    eta: null, // "MM:SS" string from yt-dlp
    downloadedBytes: 0,
    totalBytes: null,
    filePath: null,
    filename: null,
    format,
    quality,
    error: null,
    createdAt: now,
    updatedAt: now,
    expiresAt: now + config.jobTtlMinutes * 60 * 1000,
    removeAfter: null,
  };
  jobs.set(id, job);
  return job;
}

function getJob(id) {
  return jobs.get(id) || null;
}

// Find an active or queued job for the same download (duplicate
// prevention): starting the same URL + quality + format twice
// returns the first job instead of downloading twice.
function findDuplicate({ videoUrl, kind, quality, format }) {
  for (const job of jobs.values()) {
    if (
      job.videoUrl === videoUrl &&
      job.kind === kind &&
      job.quality === quality &&
      job.format === format &&
      ['queued', 'fetching_info', 'downloading', 'processing'].includes(job.status)
    ) {
      return job;
    }
  }
  return null;
}

function activeCount() {
  let n = 0;
  for (const job of jobs.values()) {
    if (['fetching_info', 'downloading', 'processing'].includes(job.status)) n++;
  }
  return n;
}

function nextQueued() {
  let oldest = null;
  for (const job of jobs.values()) {
    if (job.status === 'queued' && (!oldest || job.createdAt < oldest.createdAt)) {
      oldest = job;
    }
  }
  return oldest;
}

function touch(job, patch) {
  Object.assign(job, patch, { updatedAt: Date.now() });
}

function setRunning(id, child) {
  if (child) running.set(id, child);
  else running.delete(id);
}

function getRunning(id) {
  return running.get(id) || null;
}

// Kill a running download (if any), delete its temp files and drop
// the job from the Map. Returns true if a job existed.
function deleteJob(id) {
  const child = running.get(id);
  if (child) {
    try { child.kill('SIGKILL'); } catch (e) { /* already gone */ }
    running.delete(id);
  }
  removeDirQuiet(jobDir(id));
  return jobs.delete(id);
}

// Public copy: no filePath (an internal server path must never be
// exposed), no removeAfter. speed is also given as a human string
// for clients that do not want to format bytes themselves.
function publicJob(job) {
  if (!job) return null;
  const { filePath, removeAfter, ...pub } = job;
  return {
    ...pub,
    speedText: job.speed ? formatSpeed(job.speed) : null,
  };
}

function formatSpeed(bytesPerSec) {
  if (!bytesPerSec) return null;
  if (bytesPerSec >= 1024 * 1024) return `${(bytesPerSec / (1024 * 1024)).toFixed(2)} MB/s`;
  if (bytesPerSec >= 1024) return `${(bytesPerSec / 1024).toFixed(0)} KB/s`;
  return `${bytesPerSec} B/s`;
}

function ensureBaseDir() {
  fs.mkdirSync(config.baseTmpDir, { recursive: true });
}

module.exports = {
  jobs,
  STATUSES,
  jobDir,
  createJob,
  getJob,
  findDuplicate,
  activeCount,
  nextQueued,
  touch,
  setRunning,
  getRunning,
  deleteJob,
  publicJob,
  formatSpeed,
  ensureBaseDir,
};
