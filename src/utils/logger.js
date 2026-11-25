'use strict';

// Tiny structured logger — stdout only, no files, no services.
function ts() {
  return new Date().toISOString();
}

function log(level, msg, meta) {
  const line = `[${ts()}] ${level.toUpperCase()} ${msg}`;
  if (meta !== undefined) {
    // eslint-disable-next-line no-console
    console.log(line, typeof meta === 'string' ? meta : JSON.stringify(meta));
  } else {
    // eslint-disable-next-line no-console
    console.log(line);
  }
}

module.exports = {
  info: (msg, meta) => log('info', msg, meta),
  warn: (msg, meta) => log('warn', msg, meta),
  error: (msg, meta) => log('error', msg, meta),
};
