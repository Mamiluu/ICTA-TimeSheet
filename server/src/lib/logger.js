// Copyright (c) 2026 Asya Hafidh <msanifuasiya@gmail.com>. All Rights Reserved.
// Proprietary and confidential. See LICENSE in the repository root.

import crypto from 'node:crypto';

// One JSON line per event to stdout/stderr -- Render (and any other
// container host) captures both as-is with no extra agent to install, and
// a JSON line is immediately queryable/filterable in whatever log viewer
// sits in front of it, unlike a free-text console.error(err) dump. No
// external logging service is wired in here (that would need an account
// and a DSN this codebase doesn't have) -- this is the honest, dependency-
// free floor: structured, correlatable logs, ready to be *shipped*
// somewhere later without changing a single call site.
function write(level, message, fields) {
  const line = {
    ts: new Date().toISOString(),
    level,
    message,
    ...fields
  };
  const out = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
  out.write(JSON.stringify(line) + '\n');
}

export const logger = {
  info: (message, fields) => write('info', message, fields),
  warn: (message, fields) => write('warn', message, fields),
  error: (message, fields) => write('error', message, fields)
};

// A short id handed back to the caller alongside a generic 500 message, and
// logged server-side against the full error -- lets an attendee or admin
// say "error ref abc123def" to support without ever needing the raw stack
// trace (or any other internal detail) to leave the server logs.
export function newErrorRef() {
  return crypto.randomBytes(4).toString('hex');
}

export function logRequestError(err, req, errorRef) {
  logger.error(err.message || 'Unhandled error', {
    errorRef,
    stack: err.stack,
    method: req.method,
    path: req.originalUrl,
    ip: req.ip,
    userId: req.user ? req.user.id : null
  });
}

// Access logging: one line per response, with enough to reconstruct traffic
// patterns and slow/erroring routes without a separate APM product. Skips
// /api/health so uptime pings (Render's own, or an external monitor) don't
// drown out real traffic in the log stream.
export function requestLogger(req, res, next) {
  if (req.path === '/api/health') return next();
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
    logger.info('request', {
      method: req.method,
      path: req.originalUrl,
      status: res.statusCode,
      durationMs: Math.round(durationMs),
      ip: req.ip
    });
  });
  next();
}
