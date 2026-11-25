'use strict';

// One response shape everywhere: { success, ... } on success and
// { success: false, error: { code, message } } on failure.
function ok(res, data, status = 200) {
  return res.status(status).json({ success: true, ...data });
}

function created(res, data) {
  return ok(res, data, 201);
}

function accepted(res, data) {
  return ok(res, data, 202);
}

function fail(res, status, code, message) {
  return res.status(status).json({ success: false, error: { code, message } });
}

module.exports = { ok, created, accepted, fail };
