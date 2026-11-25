'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const config = require('../config/config');
const logger = require('../utils/logger');

// All yt-dlp calls go through spawn() with an argument array —
// never exec(), never a shell, never string concatenation with a
// user-provided URL.

function baseArgs() {
  const args = ['--no-playlist', '--no-warnings'];
  if (config.ytdlpNoCheckCertificates) args.push('--no-check-certificates');
  return args;
}

// YouTube sometimes answers the default (web) player client with
// "Sign in to confirm you're not a bot" for requests from datacenter
// IPs (Render, a VPS, …) — even for ordinary public videos. The
// Android player client usually gets through without a sign-in, but
// it only sees the legacy formats (often just the 360p combined
// format 18 on SABR-affected videos). So: try the web client first
// (full quality), and retry once with the Android client when the
// failure is a sign-in/bot error. Never the other way round —
// leading with Android would cap every video at 360p.
const ANDROID_ARGS = ['--extractor-args', 'youtube:player_client=android'];

function isSignInError(err) {
  return !!err && typeof err.message === 'string' && err.message.includes('sign-in');
}

// Insert extra args just before the URL (the last element).
function withAndroidArgs(args) {
  return [...args.slice(0, -1), ...ANDROID_ARGS, args[args.length - 1]];
}

function runJson(args, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = (attemptArgs, triedAndroid) => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return reject(new Error('yt-dlp timed out'));
      const child = spawn(config.ytdlpPath, attemptArgs, { shell: false, windowsHide: true });
      let out = '';
      let err = '';
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error('yt-dlp timed out'));
      }, remaining);
      child.stdout.on('data', d => { out += d; });
      child.stderr.on('data', d => { err += d; });
      child.on('error', e => {
        clearTimeout(timer);
        reject(new Error(`yt-dlp is not available: ${e.message}`));
      });
      child.on('close', code => {
        clearTimeout(timer);
        if (code === 0) {
          try {
            resolve(JSON.parse(out));
          } catch (e) {
            reject(new Error('yt-dlp returned unreadable data'));
          }
          return;
        }
        const error = new Error(friendlyError(err, code));
        if (!triedAndroid && isSignInError(error)) {
          logger.info('yt-dlp hit a sign-in/bot check — retrying with the Android player client');
          attempt(withAndroidArgs(attemptArgs), true);
          return;
        }
        reject(error);
      });
    };
    attempt(args, false);
  });
}

// Turn yt-dlp's stderr into a message a user can act on.
function friendlyError(stderr, code) {
  const text = (stderr || '').toLowerCase();
  if (text.includes('private video')) return 'This video is private.';
  if (text.includes('age')) return 'This video is age-restricted and cannot be downloaded.';
  if (text.includes('video unavailable') || text.includes('removed') || text.includes('deleted')) {
    return 'This video is unavailable (removed, deleted or private).';
  }
  if (text.includes('is not a valid url') || text.includes('unsupported url')) {
    return 'That URL is not a supported video link.';
  }
  if (text.includes('timed out') || text.includes('connection')) {
    return 'Could not reach YouTube — check the connection and try again.';
  }
  if (text.includes('sign in') || text.includes('log in')) {
    return 'This video needs a YouTube sign-in and cannot be downloaded.';
  }
  if (text.includes('requested format is not available') || text.includes('format is not available')) {
    return 'The selected quality is not available for this video — try a lower quality or "best".';
  }
  return `yt-dlp failed (exit ${code}).`;
}

async function getVersion(timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const child = spawn(config.ytdlpPath, ['--version'], { shell: false, windowsHide: true });
    let out = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('yt-dlp --version timed out')); }, timeoutMs);
    child.stdout.on('data', d => { out += d; });
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve(out.trim());
      else reject(new Error('yt-dlp --version failed'));
    });
  });
}

function pickThumbnail(thumbnails) {
  if (!Array.isArray(thumbnails) || thumbnails.length === 0) return null;
  const sorted = [...thumbnails].sort((a, b) => (b.width || 0) - (a.width || 0));
  return sorted[0].url || null;
}

function mapFormat(f) {
  const vcodec = f.vcodec && f.vcodec !== 'none' ? f.vcodec : null;
  const acodec = f.acodec && f.acodec !== 'none' ? f.acodec : null;
  return {
    formatId: String(f.format_id),
    ext: f.ext || null,
    resolution: f.height ? `${f.height}p` : (f.format_note || null),
    height: f.height || null,
    width: f.width || null,
    fps: f.fps || null,
    videoCodec: vcodec,
    audioCodec: acodec,
    filesize: f.filesize || f.filesize_approx || null,
    bitrate: f.tbr || null,
    hasVideo: !!vcodec,
    hasAudio: !!acodec,
    kind: vcodec && acodec ? 'combined' : (vcodec ? 'video-only' : 'audio-only'),
    protocol: f.protocol || null,
  };
}

// Short-lived cache for video metadata. /info and /formats both
// call getInfo, and the extension usually calls one right after the
// other for the same video — without a cache that is two full
// yt-dlp runs (~5–15 s each) for the same video. Metadata barely
// changes within minutes, so successful results are cached for
// 10 minutes, keyed by video id (?t= or playlist params don't
// matter). Failures are never cached. Bounded to 200 entries;
// the oldest entry goes first.
const INFO_CACHE_TTL_MS = 10 * 60 * 1000;
const INFO_CACHE_MAX = 200;
const infoCache = new Map();

function videoIdFromUrl(url) {
  try {
    const u = new URL(String(url));
    if (u.hostname === 'youtu.be') return u.pathname.split('/').filter(Boolean)[0] || null;
    if (u.searchParams.get('v')) return u.searchParams.get('v');
    const parts = u.pathname.split('/').filter(Boolean);
    if ((parts[0] === 'shorts' || parts[0] === 'embed' || parts[0] === 'live' || parts[0] === 'v') && parts[1]) return parts[1];
    return null;
  } catch (e) {
    return null;
  }
}

function getCachedInfo(url) {
  const key = videoIdFromUrl(url) || String(url);
  const entry = infoCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) { infoCache.delete(key); return null; }
  return entry.data;
}

function setCachedInfo(url, data) {
  const key = videoIdFromUrl(url) || String(url);
  if (infoCache.size >= INFO_CACHE_MAX) {
    // Drop the oldest entry (Map keeps insertion order).
    const oldest = infoCache.keys().next().value;
    if (oldest !== undefined) infoCache.delete(oldest);
  }
  infoCache.set(key, { data, expiresAt: Date.now() + INFO_CACHE_TTL_MS });
}

// Full metadata for one video. Throws a friendly error on failure.
// Storyboard pseudo-formats (sb0/sb1/sb2, mhtml) are dropped — they
// are not downloadable video and would otherwise pollute the
// resolutions list with 27p/45p/90p entries.
async function getInfo(url) {
  const cached = getCachedInfo(url);
  if (cached) {
    logger.info(`getInfo cache hit for ${videoIdFromUrl(url) || url}`);
    return cached;
  }
  const data = await runJson([...baseArgs(), '--dump-single-json', url], 90000);
  const formats = (data.formats || [])
    .filter(f => f.ext !== 'mhtml' && !String(f.format_id || '').startsWith('sb'))
    .map(mapFormat);
  const heights = [...new Set(formats.filter(f => f.height).map(f => f.height))].sort((a, b) => a - b);
  const result = {
    id: data.id || null,
    title: data.title || 'Untitled video',
    thumbnail: pickThumbnail(data.thumbnails),
    channel: data.channel || data.uploader || null,
    channelId: data.channel_id || data.uploader_id || null,
    durationSec: data.duration || null,
    description: data.description || '',
    uploadDate: data.upload_date || null,
    viewCount: data.view_count ?? null,
    likeCount: data.like_count ?? null,
    webpageUrl: data.webpage_url || url,
    resolutions: heights.map(h => `${h}p`),
    formats,
    audioOnly: formats.filter(f => f.kind === 'audio-only'),
    combined: formats.filter(f => f.kind === 'combined'),
  };
  setCachedInfo(url, result);
  return result;
}

// Only the formats that actually exist, grouped by height.
// Per height, the preferred format is the one that already has both
// tracks, else the best H.264 video-only copy.
const HEIGHTS = [144, 240, 360, 480, 720, 1080, 1440, 2160];

async function getFormats(url) {
  const info = await getInfo(url);
  const byHeight = {};
  for (const f of info.formats) {
    if (!f.height || !HEIGHTS.includes(f.height)) continue;
    const cur = byHeight[f.height];
    if (!cur) { byHeight[f.height] = f; continue; }
    const score = x => (x.kind === 'combined' ? 3 : 0)
      + ((x.videoCodec || '').startsWith('avc1') ? 2 : 0)
      + (x.ext === 'mp4' ? 1 : 0);
    if (score(f) > score(cur)) byHeight[f.height] = f;
  }
  const available = HEIGHTS.filter(h => byHeight[h]).map(h => ({
    height: h,
    resolution: `${h}p`,
    format: byHeight[h],
  }));
  return {
    id: info.id,
    title: info.title,
    thumbnail: info.thumbnail,
    durationSec: info.durationSec,
    available,
    audioOnly: info.audioOnly,
    combined: info.combined,
  };
}

// yt-dlp format selector for a requested quality.
// Prefer H.264 (avc1) + AAC (m4a) so the result is an MP4 that plays
// everywhere, with no re-encode. Fall back through the chain when a
// rendition does not exist; if the requested height does not exist
// at all, yt-dlp reports it and the caller returns a clear error.
function buildVideoSelector(quality, format) {
  const height = quality === 'best' ? null : parseInt(quality, 10);
  const h = height ? `[height<=${height}]` : '';
  const out = format || 'mp4';
  if (out === 'mp4') {
    // bestvideo with avc1 + m4a audio, merged to mp4; then any
    // bestvideo+bestaudio; then best at/below the height.
    return `bestvideo${h}[vcodec^=avc1]+bestaudio[ext=m4a]/bestvideo${h}+bestaudio/best${h}`;
  }
  if (out === 'webm') {
    return `bestvideo${h}[ext=webm]+bestaudio[ext=webm]/bestvideo${h}+bestaudio/best${h}`;
  }
  return `bestvideo${h}+bestaudio/best${h}`;
}

function parseSize(text) {
  // "25.00MiB" / "512.5KiB" / "1.2GiB" -> bytes
  const m = String(text || '').trim().match(/^([\d.]+)\s*([KMGT]i?B)?$/i);
  if (!m) return null;
  const n = parseFloat(m[1]);
  const unit = (m[2] || 'B').toUpperCase();
  const mult = { B: 1, KB: 1e3, MB: 1e6, GB: 1e9, KIB: 1024, MIB: 1024 ** 2, GIB: 1024 ** 3, TIB: 1024 ** 4 }[unit];
  return mult ? Math.round(n * mult) : null;
}

function parseSpeed(text) {
  // "2.00MiB/s" -> bytes per second
  const m = String(text || '').trim().match(/^([\d.]+)\s*([KMGT]i?B)\/s$/i);
  if (!m) return null;
  return parseSize(`${m[1]}${m[2]}`);
}

// Download one video (or audio) into jobDir. onProgress is called
// with { progress, speed, eta, downloadedBytes, totalBytes }.
// Returns the finished file path. Throws on failure. The caller
// owns the child process handle (for cancellation) via onSpawn —
// onSpawn is called again for the retry child, so the caller's
// handle always points at the currently running process.
// On a sign-in/bot failure, the download is retried once with the
// Android player client (see the note above ANDROID_ARGS); partial
// output files from the first attempt are removed first.
function downloadMedia({ url, jobDir, kind, quality, format, onProgress, onSpawn, timeoutMs }) {
  const deadline = Date.now() + timeoutMs;

  const cleanPartialOutputs = () => {
    try {
      for (const f of fs.readdirSync(jobDir)) {
        if (f.startsWith('output.')) {
          try { fs.unlinkSync(path.join(jobDir, f)); } catch (e) { /* already gone */ }
        }
      }
    } catch (e) { /* dir may not exist yet */ }
  };

  const attempt = (extraArgs, triedAndroid) => new Promise((resolve, reject) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return reject(new Error(`Download timed out after ${Math.round(timeoutMs / 60000)} minutes.`));
    const args = [...baseArgs(), ...extraArgs, '--newline'];
    const outputTemplate = path.join(jobDir, 'output.%(ext)s');
    if (kind === 'audio') {
      const audioFormat = format || 'mp3';
      const audioQuality = quality === 'best' ? '0' : `${quality}K`;
      args.push(
        '-f', 'bestaudio/best',
        '--extract-audio', '--audio-format', audioFormat,
        '--audio-quality', audioQuality,
        '-o', outputTemplate,
      );
    } else {
      args.push(
        '-f', buildVideoSelector(quality, format),
        '--merge-output-format', format || 'mp4',
        '--remux-video', format || 'mp4',
        '-o', outputTemplate,
      );
    }
    args.push(url);

    const child = spawn(config.ytdlpPath, args, { shell: false, windowsHide: true });
    if (onSpawn) onSpawn(child);
    let err = '';
    let stderrTail = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`Download timed out after ${Math.round(timeoutMs / 60000)} minutes.`));
    }, remaining);
    timer.unref();

    child.stdout.on('data', d => {
      const text = d.toString();
      // [download]  45.2% of   25.00MiB at    2.00MiB/s ETA 00:30
      const m = text.match(/\[download\]\s+([\d.]+)%\s+of\s+([\d.]+\s*[KMGT]i?B)(?:\s+at\s+([\d.]+\s*[KMGT]i?B\/s))?(?:\s+ETA\s+(\d+:\d+))?/);
      if (m && onProgress) {
        onProgress({
          progress: parseFloat(m[1]),
          totalBytes: parseSize(m[2]),
          speed: m[3] ? parseSpeed(m[3]) : null,
          eta: m[4] || null,
        });
      }
      const dest = text.match(/\[download\] Destination: (.+)/);
      if (dest) logger.info(`yt-dlp destination: ${path.basename(dest[1].trim())}`);
    });
    child.stderr.on('data', d => {
      const text = d.toString();
      err += text;
      stderrTail = (stderrTail + text).slice(-2000);
    });
    child.on('error', e => {
      clearTimeout(timer);
      reject(new Error(`yt-dlp is not available: ${e.message}`));
    });
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0) {
        // yt-dlp wrote output.<ext> (mp4, webm, mp3, …) into jobDir.
        try {
          const files = fs.readdirSync(jobDir)
            .filter(f => f.startsWith('output.') && !f.endsWith('.part') && !f.endsWith('.ytdl'));
          if (files.length === 0) {
            return reject(new Error('Download finished but no file was produced.'));
          }
          // The merged/extracted file is the largest output file.
          files.sort((a, b) => fs.statSync(path.join(jobDir, b)).size - fs.statSync(path.join(jobDir, a)).size);
          return resolve(path.join(jobDir, files[0]));
        } catch (e) {
          return reject(new Error(`Could not read the downloaded file: ${e.message}`));
        }
      }
      const error = new Error(friendlyError(stderrTail || err, code));
      if (!triedAndroid && isSignInError(error)) {
        logger.info('yt-dlp download hit a sign-in/bot check — retrying with the Android player client');
        cleanPartialOutputs();
        attempt(ANDROID_ARGS, true).then(resolve, reject);
        return;
      }
      reject(error);
    });
  });

  return attempt([], false);
}

module.exports = {
  getVersion,
  getInfo,
  getFormats,
  buildVideoSelector,
  downloadMedia,
  parseSize,
  parseSpeed,
};
