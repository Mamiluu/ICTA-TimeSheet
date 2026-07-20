// Copyright (c) 2026 Asya Hafidh <msanifuasiya@gmail.com>. All Rights Reserved.
// Proprietary and confidential. See LICENSE in the repository root.

import rateLimit from 'express-rate-limit';

// Keyed on IP alone (express-rate-limit v7's default keyGenerator already
// IPv6-normalizes req.ip) -- login/reset attempts are infrequent enough
// per-admin that a per-IP cap is sufficient brute-force/enumeration
// protection at this scale without extra per-email bookkeeping.
export const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: 'TOO_MANY_ATTEMPTS', message: 'Too many login attempts. Try again later.' }
});

export const forgotPasswordLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: 'TOO_MANY_ATTEMPTS', message: 'Too many requests. Try again later.' }
});

export const attendanceLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: 'TOO_MANY_REQUESTS' }
});
