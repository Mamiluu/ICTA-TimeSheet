// Copyright (c) 2026 Asya Hafidh <msanifuasiya@gmail.com>. All Rights Reserved.
// Proprietary and confidential. See LICENSE in the repository root.

// Express 4 does not catch rejected promises thrown inside async route
// handlers -- an unhandled rejection there crashes the whole process rather
// than producing a 500 response. Every async handler in this app is wrapped
// with this so failures (a DB error, a failed SMTP send, etc.) are routed
// to the error-handling middleware in index.js instead of taking the server down.
export function ah(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}
