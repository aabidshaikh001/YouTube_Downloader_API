'use strict';
/**
 * Popup wiring (popup.js) — quality picker + progress bar.
 * Assumes background-example.js is registered and api-client.js is
 * available. The popup asks the background for formats, shows the
 * ones that actually exist, starts the download, and polls progress
 * through the background (the popup can close; the download keeps
 * going in the service worker).
 */

const QUALITY_ORDER = ['2160p', '1440p', '1080p', '720p', '480p', '360p', '240p', '144p'];

async function loadFormats(videoUrl) {
  const res = await chrome.runtime.sendMessage({ type: 'get-formats', url: videoUrl });
  if (!res.ok) throw new Error(res.error);
  // res.formats.available = [{ height, resolution, format }]
  return res.formats.available;
}

function renderQualityButtons(available) {
  const wrap = document.getElementById('qualities');
  wrap.innerHTML = '';
  const present = new Set(available.map(a => a.resolution));
  for (const q of QUALITY_ORDER) {
    if (!present.has(q)) continue;
    const btn = document.createElement('button');
    btn.textContent = q;
    btn.addEventListener('click', () => startDownload(q));
    wrap.appendChild(btn);
  }
  // Audio-only option
  const audioBtn = document.createElement('button');
  audioBtn.textContent = 'Audio (MP3)';
  audioBtn.addEventListener('click', () => startAudio());
  wrap.appendChild(audioBtn);
}

let currentJobId = null;

async function startDownload(quality) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  setStatus(`Starting ${quality}… (the server may take a minute to wake up)`);
  const res = await chrome.runtime.sendMessage({
    type: 'download-video', url: tab.url, quality, format: 'mp4',
  });
  if (!res.ok) return setStatus(`Failed: ${res.error}`);
  currentJobId = res.job.jobId;
  setStatus(`Done — saved as ${res.job.filename}`);
}

async function startAudio() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  setStatus('Starting MP3…');
  const res = await chrome.runtime.sendMessage({
    type: 'download-audio', url: tab.url, format: 'mp3', quality: '192',
  });
  if (!res.ok) return setStatus(`Failed: ${res.error}`);
  currentJobId = res.job.jobId;
  setStatus(`Done — saved as ${res.job.filename}`);
}

async function cancelCurrent() {
  if (!currentJobId) return;
  await chrome.runtime.sendMessage({ type: 'cancel-download', jobId: currentJobId });
  setStatus('Download cancelled.');
  currentJobId = null;
}

function setStatus(text) {
  document.getElementById('status').textContent = text;
}

document.getElementById('cancel')?.addEventListener('click', cancelCurrent);
