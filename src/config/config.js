'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');
const ffmpegStatic = require('ffmpeg-static');
const ffprobeStatic = require('ffprobe-static');

function intEnv(name, fallback) {
  const v = parseInt(process.env[name], 10);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

function boolEnv(name, fallback) {
  if (process.env[name] === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(process.env[name]).toLowerCase());
}

function firstExisting(paths, fallback) {
  for (const candidate of paths) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  return fallback;
}

const binDir = path.resolve(__dirname, '..', '..', 'bin');
const bundledYtDlp = process.platform === 'win32'
  ? path.join(binDir, 'yt-dlp.exe')
  : path.join(binDir, 'yt-dlp');

// Render Free has ~512 MB RAM and a small ephemeral disk, and the
// instance sleeps after ~15 min idle. The defaults below are tuned
// for that: 2 concurrent downloads, 500 MB max file, 30 min file
// lifetime, cleanup every 5 min.
const config = {
  port: intEnv('PORT', 3000),
  host: process.env.HOST || '0.0.0.0',
  nodeEnv: process.env.NODE_ENV || 'development',

  maxConcurrentDownloads: intEnv('MAX_CONCURRENT_DOWNLOADS', 2),
  maxDownloadSizeMB: intEnv('MAX_DOWNLOAD_SIZE_MB', 500),
  downloadTimeoutMinutes: intEnv('DOWNLOAD_TIMEOUT_MINUTES', 20),
  jobTtlMinutes: intEnv('JOB_TTL_MINUTES', 30),
  cleanupIntervalMinutes: intEnv('CLEANUP_INTERVAL_MINUTES', 5),

  rateLimitWindowMinutes: intEnv('RATE_LIMIT_WINDOW_MINUTES', 15),
  rateLimitMax: intEnv('RATE_LIMIT_MAX', 100),
  downloadRateLimitMax: intEnv('DOWNLOAD_RATE_LIMIT_MAX', 20),

  // Comma-separated list of allowed web origins, e.g.
  // "https://myapp.com,https://admin.example.com".
  // chrome-extension:// origins are always allowed (they belong to
  // the user's own extension, not to a website), as is localhost.
  corsOrigins: (process.env.CORS_ORIGINS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean),

  ytdlpPath: process.env.YTDLP_PATH
    || firstExisting([bundledYtDlp, path.join(binDir, 'yt-dlp')], 'yt-dlp'),
  ffmpegPath: process.env.FFMPEG_PATH || ffmpegStatic || 'ffmpeg',
  ffprobePath: process.env.FFPROBE_PATH || ffprobeStatic.path || 'ffprobe',
  // Only for networks that intercept TLS (corporate / sandbox
  // proxies). Off by default — never enable it on a public server
  // unless you know the network does this.
  ytdlpNoCheckCertificates: boolEnv('YTDLP_NO_CHECK_CERTIFICATES', false),

  // Where finished files live until they expire. The OS temp dir by
  // default — nothing here survives a restart (by design).
  baseTmpDir: process.env.DOWNLOADS_DIR
    ? path.resolve(process.env.DOWNLOADS_DIR)
    : path.join(os.tmpdir(), 'youtube-downloader'),

  // A job that expired stays visible as "expired" for this long so a
  // polling client sees the final state once, then it is removed.
  expiredGraceMinutes: intEnv('EXPIRED_GRACE_MINUTES', 5),
};

module.exports = config;
