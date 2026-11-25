'use strict';

const express = require('express');
const health = require('../services/health.service');

const router = express.Router();

// GET /health — also what Render calls for its health check.
// Answers instantly from the background probe (see health.service).
// It used to spawn `yt-dlp --version` on every call; on a cold free
// instance that took longer than Render's 5 s health-check timeout,
// so Render kept killing the service and it 502'd in a loop.
// Before the first probe finishes, the service reports "starting"
// with 200 so Render does not kill it during startup.
router.get('/', (req, res) => {
  const s = health.getState();
  if (!s.probed) {
    return res.status(200).json({
      success: true,
      status: 'starting',
      services: { api: true, ytDlp: null, ffmpeg: null, ffprobe: null },
      ytDlpVersion: null,
      uptimeSec: Math.round(process.uptime()),
    });
  }
  const services = {
    api: true,
    ytDlp: s.ytDlpVersion !== null,
    ffmpeg: s.ffmpeg,
    ffprobe: s.ffprobe,
  };
  const allOk = Object.values(services).every(Boolean);
  return res.status(allOk ? 200 : 503).json({
    success: allOk,
    status: allOk ? 'ok' : 'degraded',
    services,
    ytDlpVersion: s.ytDlpVersion,
    uptimeSec: Math.round(process.uptime()),
  });
});

module.exports = router;
