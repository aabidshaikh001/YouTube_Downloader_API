# YouTube Downloader API — database-free

A REST API that downloads YouTube videos and audio with **yt-dlp +
FFmpeg**, built for a Chrome extension and deployable on **Render
Free** with its native Node runtime — **no Docker**.

**No database. No external storage. No Redis. No ORM.**

- Job tracking lives in one in-memory JavaScript `Map` — when the
  server restarts, every job is gone. That is the design.
- Finished files live only in the server's temporary filesystem
  (`/tmp/youtube-downloader/<jobId>/`) and are deleted after
  30 minutes (or when the job is deleted / expires).
- All downloads are spawned with `child_process.spawn()` using an
  argument array — never a shell, never string concatenation with a
  user URL.

## Endpoints

| Method | Path | What it does |
| --- | --- | --- |
| GET | `/health` | API + yt-dlp + ffmpeg/ffprobe status |
| GET | `/api/video/info?url=...` | Title, thumbnail, channel, duration, description, upload date, resolutions, formats, codecs, sizes, FPS, audio-only formats |
| GET | `/api/video/formats?url=...` | Only the resolutions that actually exist (144p–2160p), split into combined / video-only / audio-only |
| POST | `/api/video/download` | `{ url, quality, format }` → `{ jobId, status: "queued" }` (202) |
| POST | `/api/video/audio` | `{ url, format, quality }` → `{ jobId, status: "queued" }` (202) |
| GET | `/api/video/jobs/:jobId` | Status, progress, speed, ETA, bytes |
| GET | `/api/video/jobs/:jobId/download` | Streams the finished file (`Content-Disposition: attachment`) |
| DELETE | `/api/video/jobs/:jobId` | Cancel a running job, or delete a finished one and its files |

Job statuses: `queued → fetching_info → downloading → processing → completed`, or `failed` / `expired`. A missing job id returns `404 JOB_NOT_FOUND`.

## Quick start

### Local

```bash
npm install
npm start          # http://localhost:3000
```

Install `yt-dlp` separately. It is detected from the project `bin`
folder (`bin/yt-dlp.exe` on Windows), or from your PATH; alternatively,
set `YTDLP_PATH` to its full path. On Windows, you can install it with
`winget install yt-dlp.yt-dlp`. FFmpeg and ffprobe use the bundled
`ffmpeg-static` and `ffprobe-static` binaries by default; set
`FFMPEG_PATH` and `FFPROBE_PATH` to override them (see Configuration).
On Render those are set for you: yt-dlp is downloaded by the build
command, and ffmpeg/ffprobe come from the `ffmpeg-static` and
`ffprobe-static` npm packages (prebuilt binaries, installed by
`npm ci` — no apt, no Docker).

### Render (free)

1. Push this repo to GitHub.
2. Render dashboard → **New → Blueprint** → pick the repo. `render.yaml`
   creates the Web Service (native Node runtime, free plan, Singapore
   region). The build installs dependencies (including the static
   ffmpeg/ffprobe binaries) and downloads the yt-dlp standalone
   binary; the start command is `node src/server.js`.
3. Note the URL, e.g. `https://youtube-downloader-api.onrender.com`.

Render sets `PORT` itself; the app binds `0.0.0.0`.

## Configuration

Copy `.env.example` to `.env` for local runs. On Render, set the
same keys in the dashboard (Environment).

| Variable | Default | What it does |
| --- | --- | --- |
| `PORT` / `HOST` | `3000` / `0.0.0.0` | Listen address (Render sets `PORT`) |
| `MAX_CONCURRENT_DOWNLOADS` | `2` | Downloads running at once; the rest queue in RAM |
| `MAX_DOWNLOAD_SIZE_MB` | `500` | Largest video accepted (checked before + during download) |
| `DOWNLOAD_TIMEOUT_MINUTES` | `20` | A download running longer is killed |
| `JOB_TTL_MINUTES` | `30` | How long a finished file stays downloadable |
| `CLEANUP_INTERVAL_MINUTES` | `5` | How often expired jobs + orphaned files are swept |
| `RATE_LIMIT_MAX` | `100` | Requests per IP per 15 min |
| `DOWNLOAD_RATE_LIMIT_MAX` | `20` | Download starts per IP per 15 min |
| `CORS_ORIGINS` | *(empty)* | Comma-separated web origins; `chrome-extension://` and localhost are always allowed |
| `YTDLP_PATH` / `FFMPEG_PATH` / `FFPROBE_PATH` | `yt-dlp` / `ffmpeg` / `ffprobe` | Binary locations. On Render these are set in `render.yaml`: `./bin/yt-dlp` (downloaded by the build command) and the static binaries from the `ffmpeg-static` / `ffprobe-static` packages. |
| `YTDLP_NO_CHECK_CERTIFICATES` | `false` | Only for networks that intercept TLS (corporate/sandbox proxies) |
| `DOWNLOADS_DIR` | OS temp dir | Override the temp download root |

## How a download works

1. `POST /api/video/download` validates the URL (YouTube only, and
   the hostname must resolve to a public IP — SSRF guard), checks for
   a duplicate job for the same URL + quality + format, creates a job
   in the Map (`queued`) and returns `202 { jobId }`.
2. The queue worker (max 2 at a time) fetches metadata, then runs
   yt-dlp with `--newline` and parses progress (`%`, speed, ETA,
   bytes) into the Map in real time.
3. Format selection prefers **H.264 video + AAC audio** merged into
   MP4 (`bestvideo[vcodec^=avc1]+bestaudio[ext=m4a]`, with fallbacks).
   AV1 is avoided when an H.264 copy exists. If the only copy is
   VP9/AV1, the file is re-encoded to H.264 + AAC **only then** —
   otherwise it is a remux (stream copy, no quality loss).
4. The finished file is served from `/api/video/jobs/:jobId/download`
   until `JOB_TTL_MINUTES` passes, then deleted by the cleanup loop.

## Testing

```bash
# against a local server (npm start first)
bash test-api.sh

# against a deployed Render URL
BASE_URL=https://youtube-downloader-api.onrender.com bash test-api.sh
```

The script tests health, info, formats, a 144p video download (poll
→ file download → MP4 check), an MP3 audio download, job deletion,
invalid URL, unsupported domain, missing job, and documents the
rate-limit check. The download tests use a real YouTube video and can
take a few minutes on a slow connection.

## Chrome extension integration

See `extension-integration/` — an MV3-compatible client
(`api-client.js`), service-worker wiring (`background-example.js`)
and popup wiring (`popup-example.js`), plus its own README. The
client retries on 502/503 (Render Free cold starts) and treats a 404
on a job id as "expired — start a new download". The extension never
holds video bytes: the finished file is downloaded by the browser
from the API's `/download` URL via `chrome.downloads.download`.

## Render Free limits — read this

- **Cold starts:** a free instance sleeps after ~15 min idle. The
  first request after that takes 30–60 s (sometimes 502/503). The
  extension client retries; `curl` users should just retry once.
- **RAM:** 512 MB. Two concurrent downloads + one FFmpeg re-encode
  fit; do not raise `MAX_CONCURRENT_DOWNLOADS` on the free plan.
- **Disk:** ephemeral and small. Finished files are deleted after
  30 min and partial files on failure, but a 500 MB download of a
  long 4K video can still fill it — lower `MAX_DOWNLOAD_SIZE_MB`
  if you see disk errors.
- **Restarts:** Render restarts the instance on deploy and
  occasionally otherwise. Every job is lost on restart — the client
  must handle `404 JOB_NOT_FOUND` by starting a new download.

## Security

- Only YouTube hostnames are accepted; the hostname is resolved and
  rejected if it points at a private/loopback address (SSRF guard).
- yt-dlp is spawned with an argument array — no shell, no
  concatenation, no injection.
- Output filenames come from a sanitized title + a fixed
  `output.<ext>` template inside a per-job temp directory — no
  directory traversal, no user-controlled paths.
- Internal server paths are never returned (the job object sent to
  clients omits `filePath`).
- Rate limiting (global + stricter on download starts), Helmet
  headers, JSON body capped at 100 KB, no stack traces in
  production.
- CORS: only the user's own extension (`chrome-extension://`),
  localhost and origins listed in `CORS_ORIGINS`.

## Project structure

```
src/
├── server.js            # listen, cleanup loop, graceful shutdown
├── app.js               # express app: helmet, CORS, limits, routes
├── routes/
│   ├── health.routes.js
│   └── video.routes.js
├── controllers/
│   └── video.controller.js
├── services/
│   ├── ytdlp.service.js     # spawn-based yt-dlp: info, formats, download
│   ├── download.service.js  # queue + job lifecycle + cancellation
│   ├── ffmpeg.service.js    # ffprobe + H.264 conversion (last resort)
│   └── job.service.js       # the in-memory Map
├── utils/
│   ├── validators.js    # URL allowlist, SSRF DNS check, filenames
│   ├── fileCleanup.js   # expiry + orphan sweep loop
│   ├── logger.js
│   └── response.js
├── middleware/
│   ├── errorHandler.js
│   └── rateLimiter.js
└── config/
    └── config.js
render.yaml
package.json
.env.example
test-api.sh
extension-integration/   # MV3 client + wiring examples
downloads/               # placeholder only — the server uses the OS temp dir
```

## License

MIT.
