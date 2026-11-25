'use strict';

const express = require('express');
const ytdlp = require('../services/ytdlp.service');
const ffmpeg = require('../services/ffmpeg.service');
const logger = require('../utils/logger');

const router = express.Router();

// GET /health — also what Render calls for its health check.
// Checks the three services live (yt-dlp --version, ffmpeg/ffprobe
// -version) with a short timeout, so a broken install is visible.
router.get('/', async (req, res) => {
  const [ytDlpVersion, tools] = await Promise.all([
    ytdlp.getVersion().catch(e => { logger.warn(`health: yt-dlp check failed: ${e.message}`); return null; }),
    ffmpeg.checkAvailable(),
  ]);
  const services = {
    api: true,
    ytDlp: ytDlpVersion !== null,
    ffmpeg: tools.ffmpeg,
    ffprobe: tools.ffprobe,
  };
  const allOk = Object.values(services).every(Boolean);
  return res.status(allOk ? 200 : 503).json({
    success: allOk,
    status: allOk ? 'ok' : 'degraded',
    services,
    ytDlpVersion: ytDlpVersion || null,
    uptimeSec: Math.round(process.uptime()),
  });
});

module.exports = router;
