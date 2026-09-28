const crypto = require('crypto');
const { AppError, unauthorized } = require('../errors');

const bearer = req => {
  const h = req.get('authorization') || '';
  return h.toLowerCase().startsWith('bearer ') ? h.slice(7).trim() : undefined;
};

const safeEqual = (a, b) => {
  const ba = Buffer.from(String(a)), bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
};

// Admin API protection until user accounts exist: a single token from ADMIN_TOKEN.
function requireAdmin(adminToken) {
  return (req, res, next) => {
    const token = bearer(req) || req.get('x-admin-token');
    if (!token || !safeEqual(token, adminToken)) return next(new AppError('Admin token required', 401));
    next();
  };
}

// Device auth: X-API-Key header, Authorization: Bearer <key>, or ?key= (for very limited firmware).
function requireDevice(registry) {
  return (req, res, next) => {
    const key = req.get('x-api-key') || bearer(req) || req.query.key;
    if (!key) return next(unauthorized());
    try {
      req.device = registry.authenticate(key);
      next();
    } catch (err) { next(err); }
  };
}

// Simple fixed-window rate limit per device (in memory; use Redis when running several instances).
function rateLimit({ perMinute = 600, keyFn }) {
  const windows = new Map();
  return (req, res, next) => {
    const key = keyFn(req);
    const minute = Math.floor(Date.now() / 60_000);
    const w = windows.get(key);
    if (!w || w.minute !== minute) windows.set(key, { minute, count: 1 });
    else if (++w.count > perMinute) {
      res.setHeader('Retry-After', String(60 - Math.floor((Date.now() / 1000) % 60)));
      return next(new AppError(`Rate limit exceeded (${perMinute} requests/minute)`, 429));
    }
    if (windows.size > 10_000) for (const [k, v] of windows) if (v.minute !== minute) windows.delete(k);
    next();
  };
}

// Catches async errors so every handler can simply throw
const wrap = fn => (req, res, next) => {
  try {
    const out = fn(req, res, next);
    if (out && typeof out.catch === 'function') out.catch(next);
  } catch (err) { next(err); }
};

function errorHandler(logger = console) {
  // eslint-disable-next-line no-unused-vars
  return (err, req, res, next) => {
    let status = err.status || err.statusCode || 500;
    let message = err.message;
    if (err.type === 'entity.parse.failed') message = 'Request body is not valid JSON';
    if (err.type === 'entity.too.large') { status = 413; message = 'Request body is too large'; }
    if (status >= 500) { logger.error(err); message = 'Internal server error'; }
    if (res.headersSent) return res.end();
    res.status(status).json({ error: message, ...(err.details ? { details: err.details } : {}) });
  };
}

module.exports = { requireAdmin, requireDevice, rateLimit, wrap, errorHandler };
