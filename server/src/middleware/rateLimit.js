// Copyright (c) 2026 Asya Hafidh <msanifuasiya@gmail.com>. All Rights Reserved.
// Proprietary and confidential. See LICENSE in the repository root.

import rateLimit from 'express-rate-limit';

// Keyed on IP alone (express-rate-limit v7's default keyGenerator already
// IPv6-normalizes req.ip) -- login/reset attempts are infrequent enough
// per-admin that a per-IP cap is sufficient brute-force/enumeration
// protection at this scale without extra per-email bookkeeping.
// LOGIN_RATE_LIMIT exists only so the tenant fence check, which signs in many test
// accounts from one machine, can run; leave it unset in production.
export const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: Number(process.env.LOGIN_RATE_LIMIT) || 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: 'TOO_MANY_ATTEMPTS', message: 'Too many login attempts. Try again later.' }
});

// A request to join is a public form, so it is slow by design: a handful an hour from one place.
export const signupLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: Number(process.env.SIGNUP_RATE_LIMIT) || 6,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: 'TOO_MANY_ATTEMPTS', message: 'Too many requests from here. Please try again later.' }
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

// Phone-number check-in for later days is a guessable-credential route, so it
// gets a much tighter per-IP cap than ordinary sign-in.
// Typing the live code. A whole room can share one Wi-Fi address, so this allows far more than the
// check-in limit, while still making a guess at six digits pointless.
export const liveCodeLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 80,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: 'TOO_MANY_ATTEMPTS', message: 'Too many tries. Wait a few minutes and try again.' }
});

// Pairing a screen with the short code from the organiser's page. Only wrong codes count, so a venue
// full of laptops pairing from one Wi-Fi address is fine while guessing is not.
export const pairScreenLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 12,
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: 'TOO_MANY_ATTEMPTS', message: 'Too many wrong codes. Wait a few minutes, then ask for a new one.' }
});

// A paired screen asks again at every change of code. Several can share one venue address.
export const screenPollLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: 'TOO_MANY_REQUESTS' }
});

export const checkInLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 12,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: 'TOO_MANY_ATTEMPTS', message: 'Too many attempts. Please wait a few minutes and try again, or ask the organiser to help.' }
});
