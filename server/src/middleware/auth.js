// Copyright (c) 2026 Asya Hafidh <msanifuasiya@gmail.com>. All Rights Reserved.
// Proprietary and confidential. See LICENSE in the repository root.

import { loadSessionUser } from '../lib/session.js';

// Attaches req.user if a valid session cookie is present; never rejects by
// itself. Downstream routes/guards decide what to do with an absent user.
// Runs on every request, so a DB hiccup here must reach the error handler
// via next(err) rather than crash the process as an unhandled rejection.
export function attachUser(req, res, next) {
  loadSessionUser(req)
    .then((user) => { req.user = user; next(); })
    .catch(next);
}

export function requireRole(role) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ ok: false, error: 'NOT_AUTHENTICATED' });
    if (req.user.role !== role) return res.status(403).json({ ok: false, error: 'FORBIDDEN' });
    next();
  };
}
