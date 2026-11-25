'use strict';

const ytdlp = require('./ytdlp.service');
const ffmpeg = require('./ffmpeg.service');
const logger = require('../utils/logger');

// Background service probe. The binaries (yt-dlp, ffmpeg, ffprobe)
// are checked on a schedule, never inside a request.
//
// Why: /health used to spawn `yt-dlp --version` on every call.
// On a cold, CPU-throttled free instance that spawn can take
// longer than 15 s (the Python zipapp starts slowly), while
// Render's health check times out after 5 s — so the health check
// itself failed, Render marked the instance failed and restarted
// it, and the service 502'd in a loop. The binary was fine; the
// check was the problem. Now /health answers instantly from the
// cached result of this probe, and the probe gets a full minute
// (it runs in the background, so a slow probe blocks nothing).
const PROBE_INTERVAL_MS = 5 * 60 * 1000;
const YTDLP_PROBE_TIMEOUT_MS = 60000;

let state = {
  probed: false,
  ytDlpVersion: null,
  ffmpeg: false,
  ffprobe: false,
  probedAt: null,
};
let timer = null;

async function probeOnce() {
  const [ytDlpVersion, tools] = await Promise.all([
    ytdlp.getVersion(YTDLP_PROBE_TIMEOUT_MS).catch(e => {
      logger.warn(`health probe: yt-dlp check failed: ${e.message}`);
      return null;
    }),
    ffmpeg.checkAvailable(),
  ]);
  state = {
    probed: true,
    ytDlpVersion,
    ffmpeg: tools.ffmpeg,
    ffprobe: tools.ffprobe,
    probedAt: Date.now(),
  };
  logger.info(`health probe: ytDlp=${ytDlpVersion !== null} (v${ytDlpVersion || 'n/a'}) ffmpeg=${tools.ffmpeg} ffprobe=${tools.ffprobe}`);
  return state;
}

function start() {
  if (timer) return;
  probeOnce().catch(() => {});
  timer = setInterval(() => { probeOnce().catch(() => {}); }, PROBE_INTERVAL_MS);
  timer.unref();
}

function getState() {
  return state;
}

module.exports = { start, getState, probeOnce };
