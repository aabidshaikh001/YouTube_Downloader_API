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

function processStartError(error) {
  if (error.code !== 'ENOENT') return error;
  const unavailable = new Error(
    'yt-dlp executable was not found. Install yt-dlp and add it to PATH, or set YTDLP_PATH to its executable.'
  );
  unavailable.code = 'YTDLP_UNAVAILABLE';
  return unavailable;
}

function runJson(args, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const child = spawn(config.ytdlpPath, args, { shell: false, windowsHide: true });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('yt-dlp timed out'));
    }, timeoutMs);
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('error', e => {
      clearTimeout(timer);
      reject(processStartError(e));
    });
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0) {
        try {
          resolve(JSON.parse(out));
        } catch (e) {
          reject(new Error('yt-dlp returned unreadable data'));
        }
      } else {
        reject(new Error(friendlyError(err, code)));
      }
    });
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

async function getVersion() {
  return new Promise((resolve, reject) => {
    const child = spawn(config.ytdlpPath, ['--version'], { shell: false, windowsHide: true });
    let out = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('yt-dlp --version timed out')); }, 15000);
    child.stdout.on('data', d => { out += d; });
    child.on('error', e => { clearTimeout(timer); reject(processStartError(e)); });
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

// Full metadata for one video. Throws a friendly error on failure.
async function getInfo(url) {
  const data = await runJson([...baseArgs(), '--dump-single-json', url], 90000);
  const formats = (data.formats || []).map(mapFormat);
  const heights = [...new Set(formats.filter(f => f.height).map(f => f.height))].sort((a, b) => a - b);
  return {
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
// owns the child process handle (for cancellation) via onSpawn.
function downloadMedia({ url, jobDir, kind, quality, format, onProgress, onSpawn, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const args = [...baseArgs(), '--newline'];
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
    }, timeoutMs);
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
      reject(processStartError(e));
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
      reject(new Error(friendlyError(stderrTail || err, code)));
    });
  });
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
