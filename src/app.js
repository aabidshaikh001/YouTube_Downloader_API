'use strict';

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const config = require('./config/config');
const healthRoutes = require('./routes/health.routes');
const videoRoutes = require('./routes/video.routes');
const { apiLimiter } = require('./middleware/rateLimiter');
const { notFound, errorHandler } = require('./middleware/errorHandler');

const app = express();

// Security headers.
app.use(helmet({
  // The file download is a same-origin / extension fetch; the
  // default cross-origin policies are fine, but the embedder
  // policy must not break a plain file download.
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: 'cross-origin' },
}));

// CORS: the user's own Chrome extension (chrome-extension://<id>)
// is always allowed, localhost is allowed, plus any origins listed
// in CORS_ORIGINS. A random website cannot call the API from a
// page — only the extension and the configured origins can.
app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true); // curl / server-to-server
    if (origin.startsWith('chrome-extension://')) return cb(null, true);
    if (origin.startsWith('http://localhost') || origin.startsWith('http://127.0.0.1')) return cb(null, true);
    if (config.corsOrigins.includes(origin)) return cb(null, true);
    return cb(new Error('Origin not allowed by CORS'));
  },
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

app.use(express.json({ limit: '100kb' }));
app.use(apiLimiter);

app.use('/health', healthRoutes);
app.use('/api/video', videoRoutes);

app.use(notFound);
app.use(errorHandler);

module.exports = app;
