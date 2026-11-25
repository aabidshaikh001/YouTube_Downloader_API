'use strict';
/**
 * Service-worker wiring (background.js, Manifest V3).
 * Put api-client.js in the same folder and import it, or paste the
 * class above this file. The flow:
 *
 *   popup/content script  --(message)-->  background
 *   background            --(REST)------>  Render API
 *   background            --(poll)------>  Render API (job status)
 *   background            --(chrome.downloads)--> user's Downloads
 *
 * The finished file is downloaded by the browser itself from the
 * API's /download URL — the extension never holds the video bytes.
 */

// importScripts('api-client.js'); // if api-client.js is a classic script
const API_BASE = 'https://youtube-downloader-api.onrender.com'; // <-- your Render URL
const api = new DownloaderApi(API_BASE);

// Start a download and poll until it is done, then save the file.
async function downloadVideo(videoUrl, quality, format) {
  const { jobId, duplicate } = await api.startDownload(videoUrl, quality, format);
  console.log(`Download ${duplicate ? '(already running) ' : ''}started: ${jobId}`);

  const job = await api.waitForCompletion(jobId, j => {
    // Forward progress to the popup, e.g.:
    // chrome.runtime.sendMessage({ type: 'download-progress', jobId, progress: j.progress, status: j.status });
    console.log(`[${jobId}] ${j.status} ${j.progress}%`);
  });

  // The file is ready — let Chrome save it to the user's Downloads.
  await chrome.downloads.download({
    url: api.downloadUrl(jobId),
    filename: job.filename, // already a safe name from the server
    saveAs: false,
  });
  return job;
}

// Same flow for audio.
async function downloadAudio(videoUrl, format = 'mp3', quality = '192') {
  const { jobId } = await api.startAudio(videoUrl, format, quality);
  const job = await api.waitForCompletion(jobId, j => {
    console.log(`[${jobId}] ${j.status} ${j.progress}%`);
  });
  await chrome.downloads.download({
    url: api.downloadUrl(jobId),
    filename: job.filename,
    saveAs: false,
  });
  return job;
}

// Messages from the popup / content script.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'download-video') {
    downloadVideo(msg.url, msg.quality, msg.format)
      .then(job => sendResponse({ ok: true, job }))
      .catch(err => sendResponse({ ok: false, error: err.message, code: err.code }));
    return true; // keep the channel open for the async reply
  }
  if (msg.type === 'download-audio') {
    downloadAudio(msg.url, msg.format, msg.quality)
      .then(job => sendResponse({ ok: true, job }))
      .catch(err => sendResponse({ ok: false, error: err.message, code: err.code }));
    return true;
  }
  if (msg.type === 'cancel-download') {
    api.cancelJob(msg.jobId)
      .then(result => sendResponse({ ok: true, ...result }))
      .catch(err => sendResponse({ ok: false, error: err.message, code: err.code }));
    return true;
  }
  if (msg.type === 'get-formats') {
    api.getFormats(msg.url)
      .then(data => sendResponse({ ok: true, ...data }))
      .catch(err => sendResponse({ ok: false, error: err.message, code: err.code }));
    return true;
  }
});
