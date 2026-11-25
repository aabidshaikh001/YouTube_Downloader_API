# Extension integration

Three files — copy them into your extension, change `API_BASE`, done.

## Files

| File | What it is |
| --- | --- |
| `api-client.js` | The REST client. `getInfo`, `getFormats`, `startDownload`, `startAudio`, `getJob`, `cancelJob`, `downloadUrl`, `waitForCompletion` (polling). |
| `background-example.js` | Service-worker wiring: messages from the popup, download → poll → `chrome.downloads.download`. |
| `popup-example.js` | Popup wiring: quality buttons from the formats that actually exist, start/cancel, status text. |

## Set the API base URL

In `background-example.js`:

```js
const API_BASE = 'https://youtube-downloader-api.onrender.com'; // your Render URL
```

## manifest.json

The extension must be allowed to call the API host:

```json
{
  "manifest_version": 3,
  "permissions": ["downloads", "tabs"],
  "host_permissions": ["https://youtube-downloader-api.onrender.com/*"],
  "background": { "service_worker": "background.js" }
}
```

(`host_permissions` for the API host, `downloads` for saving the
finished file. No extra permissions are needed — the extension never
holds the video bytes; the browser downloads the finished file
straight from the API's `/download` URL.)

## The flow

1. Popup asks the background for formats (`get-formats`).
2. Background calls `GET /api/video/formats?url=...` and returns only
   the resolutions that actually exist.
3. User picks a quality → background calls `POST /api/video/download`.
4. Background polls `GET /api/video/jobs/:jobId` every 2 s
   (`waitForCompletion`) and forwards progress to the popup.
5. When the job is `completed`, the background calls
   `chrome.downloads.download({ url: api.downloadUrl(jobId) })` —
   the file lands in the user's Downloads folder with the server's
   safe filename.
6. Cancel at any time: `DELETE /api/video/jobs/:jobId` kills the
   yt-dlp process and deletes the temp files.

## Cold starts (Render Free)

A free Render instance sleeps after ~15 min idle. The first request
after that takes 30–60 s and can return 502/503. `api-client.js`
retries every request up to 3 times with exponential backoff, so the
popup should just show "Starting… (the server may take a minute to
wake up)" and wait.

## Expired jobs

A job and its file live 30 min (`JOB_TTL_MINUTES`). If `getJob`
returns 404 (`JOB_NOT_FOUND`), the job is gone — start a new
download instead of retrying the same id. `waitForCompletion`
already turns that into an error the popup can show.
