// Copyright (c) 2026 Asya Hafidh <msanifuasiya@gmail.com>. All Rights Reserved.
// Proprietary and confidential. See LICENSE in the repository root.

import crypto from 'node:crypto';

// The live code: a value shown on a screen at the venue that changes every five minutes. Signing an event
// that uses it needs a code made in the last ten minutes at most, so a link or a photo passed on to someone
// who is not there stops working almost at once. Nothing is stored per code: each one is a keyed hash
// of the event and the five minute slot, so the server can make it and check it from the event's secret alone.
//
// Filling in the form takes longer than a few minutes, so a valid code is exchanged for a proof that
// lasts a little longer (PROOF_TTL_MS). The proof is held by the page, never put in a link, so it
// cannot be passed on the way a link can.

// Five minutes, because phones are slow, networks buffer and people type slowly.
export const STEP_MS = 5 * 60 * 1000;
// A scanned code is good for the slot it was made in and the one before it, so one that was on screen a moment
// ago still works. In all a code is accepted for between five and ten minutes.
export const KEY_GRACE_STEPS = 1;
export const PROOF_TTL_MS = 20 * 60 * 1000;

export function newSecret() {
  return crypto.randomBytes(32).toString('hex');
}

const mac = (secret, text) => crypto.createHmac('sha256', secret).update(text).digest('base64url');

function same(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

export const stepOf = (now = Date.now()) => Math.floor(now / STEP_MS);

export function codeFor(secret, eventId, step) {
  return mac(secret, `k:${eventId}:${step}`).slice(0, 16);
}

// The same code as six digits, for people who cannot scan a screen (a virtual meeting) and type it
// instead. Six digits are guessable in principle, so typing one is rate limited, and it is only ever
// traded for a proof, never accepted on a signing request directly.
export function shortCodeFor(secret, eventId, step) {
  const n = crypto.createHmac('sha256', secret).update(`s:${eventId}:${step}`).digest().readUInt32BE(0) % 1000000;
  return String(n).padStart(6, '0');
}

export const currentShortCode = (secret, eventId, now = Date.now()) => shortCodeFor(secret, eventId, stepOf(now));

export function shortCodeIsValid(secret, eventId, typed, now = Date.now()) {
  const digits = String(typed || '').replace(/\D/g, '');
  if (!secret || digits.length !== 6) return false;
  const step = stepOf(now);
  let ok = false;
  for (let i = 0; i <= KEY_GRACE_STEPS; i++) {
    if (same(shortCodeFor(secret, eventId, step - i), digits)) ok = true;
  }
  return ok;
}

export function currentCode(secret, eventId, now = Date.now()) {
  return codeFor(secret, eventId, stepOf(now));
}

// When the code on screen right now stops being the newest one.
export function nextChangeAt(now = Date.now()) {
  return (stepOf(now) + 1) * STEP_MS;
}

export function codeIsValid(secret, eventId, code, now = Date.now()) {
  if (!secret || typeof code !== 'string' || code.length !== 16) return false;
  const step = stepOf(now);
  let ok = false;
  for (let i = 0; i <= KEY_GRACE_STEPS; i++) {
    if (same(codeFor(secret, eventId, step - i), code)) ok = true;
  }
  return ok;
}

export function makeProof(secret, eventId, now = Date.now()) {
  const expires = now + PROOF_TTL_MS;
  return { proof: `${expires}.${mac(secret, `p:${eventId}:${expires}`).slice(0, 24)}`, expiresAt: expires };
}

export function proofIsValid(secret, eventId, proof, now = Date.now()) {
  if (!secret || typeof proof !== 'string') return false;
  const dot = proof.indexOf('.');
  if (dot < 1) return false;
  const expires = Number(proof.slice(0, dot));
  if (!Number.isFinite(expires) || expires < now || expires > now + PROOF_TTL_MS) return false;
  return same(mac(secret, `p:${eventId}:${expires}`).slice(0, 24), proof.slice(dot + 1));
}

// What a request holds: `key` is a code scanned from the screen, `proof` is what one earlier earned.
// required is false for an event that does not use the live code, so callers can ask without checking.
export function liveCheck(event, { key, proof } = {}, now = Date.now()) {
  if (!event || !event.liveCode || !event.liveSecret) return { required: false, ok: true, via: null };
  if (codeIsValid(event.liveSecret, event.id, key, now)) return { required: true, ok: true, via: 'key' };
  if (proofIsValid(event.liveSecret, event.id, proof, now)) return { required: true, ok: true, via: 'proof' };
  return { required: true, ok: false, via: null, state: key ? 'EXPIRED' : 'MISSING' };
}

export const LIVE_REFUSAL = {
  MISSING: 'Scan the code shown on the screen at the venue to sign.',
  EXPIRED: 'That code has expired. Scan the code on the screen at the venue again.'
};
