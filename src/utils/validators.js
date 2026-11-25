'use strict';

const dns = require('dns').promises;
const net = require('net');

// Only YouTube is supported. Anything else is rejected before any
// network call is made — this is the first SSRF defence.
const ALLOWED_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtu.be',
  'www.youtu.be',
  'youtube-nocookie.com',
  'www.youtube-nocookie.com',
]);

const VIDEO_FORMATS = new Set(['mp4', 'webm', 'mkv']);
const AUDIO_FORMATS = new Set(['mp3', 'm4a', 'aac', 'opus', 'wav', 'flac', 'ogg']);
const QUALITIES = new Set(['144', '240', '360', '480', '720', '1080', '1440', '2160', 'best']);
const AUDIO_QUALITIES = new Set(['64', '96', '128', '160', '192', '256', '320', 'best']);

// True for private / reserved / loopback addresses (IPv4 + IPv6).
function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 10) return true; // 10/8
    if (a === 127) return true; // 127/8 loopback
    if (a === 169 && b === 254) return true; // 169.254/16 link-local
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
    if (a === 192 && b === 168) return true; // 192.168/16
    if (a === 0 || a >= 224) return true; // 0/8 + multicast/reserved
    return false;
  }
  if (net.isIPv6(ip)) {
    const low = ip.toLowerCase();
    if (low === '::1') return true;
    if (low.startsWith('fc') || low.startsWith('fd')) return true; // fc00::/7 unique-local
    if (low.startsWith('fe8') || low.startsWith('fe9') || low.startsWith('fea') || low.startsWith('feb')) return true; // fe80::/10
    if (low.startsWith('::ffff:')) return isPrivateIp(low.slice(7)); // IPv4-mapped
    return false;
  }
  return true; // not an IP at all — treat as unsafe
}

// Parse + allowlist a URL. Returns the URL object, or throws an
// Error with a user-facing message.
function parseSupportedUrl(raw) {
  if (!raw || typeof raw !== 'string') {
    throw new Error('A "url" string is required.');
  }
  let u;
  try {
    u = new URL(raw.trim());
  } catch (e) {
    throw new Error('Invalid URL.');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error('Only http(s) URLs are supported.');
  }
  if (!ALLOWED_HOSTS.has(u.hostname.toLowerCase())) {
    throw new Error('Only YouTube URLs are supported (youtube.com, youtu.be, music.youtube.com).');
  }
  return u;
}

// Second SSRF defence: resolve the hostname and refuse it if it
// points at a private / loopback address. Fail closed — if DNS
// cannot be resolved, the URL is rejected.
async function assertPublicHost(hostname) {
  let addresses;
  try {
    addresses = await dns.lookup(hostname, { all: true });
  } catch (e) {
    throw new Error('Could not resolve the video host — try again.');
  }
  if (!addresses || addresses.length === 0) {
    throw new Error('Could not resolve the video host — try again.');
  }
  for (const a of addresses) {
    if (isPrivateIp(a.address)) {
      throw new Error('That host resolves to a private address and is blocked.');
    }
  }
}

async function validateVideoUrl(raw) {
  const u = parseSupportedUrl(raw);
  await assertPublicHost(u.hostname);
  return u.toString();
}

// "720p" / "720" / "best" -> 720 / null. Throws on anything else.
function parseQuality(raw, fallback = 'best') {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const s = String(raw).toLowerCase().replace(/p$/, '');
  if (s === 'best') return 'best';
  if (!QUALITIES.has(s)) {
    throw new Error('Quality must be one of 144p, 240p, 360p, 480p, 720p, 1080p, 1440p, 2160p or "best".');
  }
  return s;
}

function parseAudioQuality(raw, fallback = '192') {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const s = String(raw).toLowerCase().replace(/k$/, '');
  if (s === 'best') return 'best';
  if (!AUDIO_QUALITIES.has(s)) {
    throw new Error('Audio quality must be one of 64, 96, 128, 160, 192, 256, 320 or "best".');
  }
  return s;
}

function parseVideoFormat(raw, fallback = 'mp4') {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const s = String(raw).toLowerCase().replace(/^\./, '');
  if (!VIDEO_FORMATS.has(s)) {
    throw new Error('Video format must be mp4, webm or mkv.');
  }
  return s;
}

function parseAudioFormat(raw, fallback = 'mp3') {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const s = String(raw).toLowerCase().replace(/^\./, '');
  if (!AUDIO_FORMATS.has(s)) {
    throw new Error('Audio format must be mp3, m4a, aac, opus, wav, flac or ogg.');
  }
  return s;
}

// A filename that is safe to put in Content-Disposition and on disk:
// no path separators, no control characters, no leading dots, capped
// length. Never trust a video title on disk as-is.
function sanitizeFilename(name, ext) {
  const base = String(name || 'video')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .slice(0, 100) || 'video';
  return `${base}.${ext}`;
}

module.exports = {
  ALLOWED_HOSTS,
  VIDEO_FORMATS,
  AUDIO_FORMATS,
  isPrivateIp,
  parseSupportedUrl,
  assertPublicHost,
  validateVideoUrl,
  parseQuality,
  parseAudioQuality,
  parseVideoFormat,
  parseAudioFormat,
  sanitizeFilename,
};
