'use strict';

const { spawn } = require('child_process');
const config = require('../config/config');

// Thin wrapper around ffprobe / ffmpeg. No shell is ever used —
// arguments are passed as an array to spawn().

function run(cmd, args, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { shell: false, windowsHide: true });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${cmd} timed out`));
    }, timeoutMs);
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('error', e => {
      clearTimeout(timer);
      reject(new Error(`${cmd} is not available: ${e.message}`));
    });
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`${cmd} failed (exit ${code}): ${err.trim().slice(0, 300)}`));
    });
  });
}

async function checkAvailable() {
  const out = { ffmpeg: false, ffprobe: false };
  try {
    await run(config.ffmpegPath, ['-version'], 10000);
    out.ffmpeg = true;
  } catch (e) { /* not available */ }
  try {
    await run(config.ffprobePath, ['-version'], 10000);
    out.ffprobe = true;
  } catch (e) { /* not available */ }
  return out;
}

// ffprobe -> { videoCodec, audioCodec, width, height, durationSec, sizeBytes }
async function probe(filePath) {
  const out = await run(config.ffprobePath, [
    '-v', 'quiet', '-print_format', 'json',
    '-show_streams', '-show_format', filePath,
  ], 30000);
  const data = JSON.parse(out);
  let video = null;
  let audio = null;
  for (const s of data.streams || []) {
    if (s.codec_type === 'video' && !video) {
      video = { codec: s.codec_name, width: s.width, height: s.height };
    } else if (s.codec_type === 'audio' && !audio) {
      audio = { codec: s.codec_name };
    }
  }
  return {
    videoCodec: video ? video.codec : null,
    audioCodec: audio ? audio.codec : null,
    width: video ? video.width : null,
    height: video ? video.height : null,
    durationSec: data.format && data.format.duration ? parseFloat(data.format.duration) : null,
    sizeBytes: data.format && data.format.size ? parseInt(data.format.size, 10) : null,
  };
}

// Re-encode to H.264 + AAC (yuv420p, fast-start) — only used when
// the downloaded file's video codec is not already H.264. Everything
// else is a remux (stream copy), never a re-encode.
function convertToH264(inputPath, outputPath, onProgress) {
  return new Promise((resolve, reject) => {
    const args = [
      '-y', '-v', 'info',
      '-i', inputPath,
      '-c:v', 'libx264', '-crf', '20', '-preset', 'veryfast',
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '192k',
      '-movflags', '+faststart',
      outputPath,
    ];
    const child = spawn(config.ffmpegPath, args, { shell: false, windowsHide: true });
    let err = '';
    child.stderr.on('data', d => {
      const text = d.toString();
      err += text;
      // ffmpeg prints "time=00:00:12.34" lines while encoding.
      const m = text.match(/time=(\d+):(\d+):(\d+\.\d+)/);
      if (m && onProgress) {
        const secs = (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]);
        onProgress(secs);
      }
    });
    child.on('error', e => reject(new Error(`ffmpeg is not available: ${e.message}`)));
    child.on('close', code => {
      if (code === 0) resolve(outputPath);
      else reject(new Error(`ffmpeg conversion failed (exit ${code}): ${err.trim().slice(-300)}`));
    });
  });
}

module.exports = { run, checkAvailable, probe, convertToH264 };
