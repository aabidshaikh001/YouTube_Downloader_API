# YouTube Downloader API — Docker image (Render Free).
# Node 20 (matches engines.node in package.json). yt-dlp is the
# standalone binary (no pip), ffmpeg/ffprobe come from Debian.
FROM node:20-slim

# curl (yt-dlp download + healthcheck), ffmpeg/ffprobe, python3
# (yt-dlp needs a Python interpreter for some extractors).
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl ffmpeg python3 ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# yt-dlp standalone binary — /usr/local/bin is on PATH, so the app
# finds it with no YTDLP_PATH set (render.yaml pins it anyway).
RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
      -o /usr/local/bin/yt-dlp \
  && chmod +x /usr/local/bin/yt-dlp \
  && yt-dlp --version

WORKDIR /app

# Install Node deps first (cached layer) — npm ci needs package-lock.json.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Then the app code.
COPY . .
RUN chown -R node:node /app

# Run as the non-root node user (provided by the base image).
USER node

# Render sets PORT itself (default 10000); the server binds 0.0.0.0:$PORT.
ENV NODE_ENV=production
EXPOSE 10000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -fsS http://127.0.0.1:${PORT:-10000}/health || exit 1

CMD ["node", "src/server.js"]
