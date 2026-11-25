'use strict';
/**
 * Downloader API client — Manifest V3 compatible.
 * Drop this file into your Chrome extension (service worker or
 * popup) and use it as shown in background-example.js.
 *
 * Handles the two things a Render Free backend needs:
 *  1. Cold starts — a free instance sleeps after ~15 min idle, so
 *     the first request can take 30–60 s. Every request retries
 *     with backoff while the server wakes up.
 *  2. Expired jobs — a job (and its file) lives 30 min. A 404 on a
 *     job id means "gone" — start a new download, do not retry the
 *     same id forever.
 */
class DownloaderApi {
  constructor(baseUrl) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  async request(path, options = {}, retries = 3) {
    const url = `${this.baseUrl}${path}`;
    let delay = 1500;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const res = await fetch(url, {
          ...options,
          headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
        });
        // Render returns 502/503 while the instance is waking up.
        if ((res.status === 502 || res.status === 503) && attempt < retries) {
          await this.sleep(delay);
          delay *= 2;
          continue;
        }
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          const err = new Error(data?.error?.message || `Request failed (${res.status})`);
          err.status = res.status;
          err.code = data?.error?.code || 'REQUEST_FAILED';
          throw err;
        }
        return data;
      } catch (e) {
        // A network error on the first call is usually a cold start.
        if (attempt < retries && (e instanceof TypeError || e.status === 502 || e.status === 503)) {
          await this.sleep(delay);
          delay *= 2;
          continue;
        }
        throw e;
      }
    }
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // GET /health
  health() {
    return this.request('/health');
  }

  // GET /api/video/info?url=...
  getInfo(videoUrl) {
    return this.request(`/api/video/info?url=${encodeURIComponent(videoUrl)}`);
  }

  // GET /api/video/formats?url=...
  getFormats(videoUrl) {
    return this.request(`/api/video/formats?url=${encodeURIComponent(videoUrl)}`);
  }

  // POST /api/video/download — returns { jobId, status: 'queued' }
  startDownload(videoUrl, quality = '720p', format = 'mp4') {
    return this.request('/api/video/download', {
      method: 'POST',
      body: JSON.stringify({ url: videoUrl, quality, format }),
    });
  }

  // POST /api/video/audio — returns { jobId, status: 'queued' }
  startAudio(videoUrl, format = 'mp3', quality = '192') {
    return this.request('/api/video/audio', {
      method: 'POST',
      body: JSON.stringify({ url: videoUrl, format, quality }),
    });
  }

  // GET /api/video/jobs/:jobId
  getJob(jobId) {
    return this.request(`/api/video/jobs/${encodeURIComponent(jobId)}`);
  }

  // DELETE /api/video/jobs/:jobId — cancels a running job, or
  // deletes a finished/failed one and its files.
  cancelJob(jobId) {
    return this.request(`/api/video/jobs/${encodeURIComponent(jobId)}`, { method: 'DELETE' });
  }

  // The finished file. Open it in the browser, or hand the URL to
  // chrome.downloads.download (see background-example.js). It is a
  // plain GET, so no fetch wrapper is needed.
  downloadUrl(jobId) {
    return `${this.baseUrl}/api/video/jobs/${encodeURIComponent(jobId)}/download`;
  }

  // Poll until the job is completed / failed / expired.
  // onUpdate(job) is called after every poll (progress bar, etc.).
  // Resolves with the completed job; rejects on failed / expired /
  // missing job (404 -> the job is gone, start a new one).
  async waitForCompletion(jobId, onUpdate, { intervalMs = 2000, timeoutMs = 20 * 60 * 1000 } = {}) {
    const started = Date.now();
    for (;;) {
      const { job } = await this.getJob(jobId);
      if (onUpdate) onUpdate(job);
      if (job.status === 'completed') return job;
      if (job.status === 'failed') {
        throw new Error(job.error || 'Download failed.');
      }
      if (job.status === 'expired') {
        throw new Error('This download expired before it was fetched. Start a new download.');
      }
      if (Date.now() - started > timeoutMs) {
        throw new Error('Download is taking too long — check the job later or cancel it.');
      }
      await this.sleep(intervalMs);
    }
  }
}

// In a service worker: self.DownloaderApi = DownloaderApi;
// In a module: export default DownloaderApi;
if (typeof module !== 'undefined' && module.exports) module.exports = DownloaderApi;
