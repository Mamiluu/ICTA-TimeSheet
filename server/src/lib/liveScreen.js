// Copyright (c) 2026 Asya Hafidh <msanifuasiya@gmail.com>. All Rights Reserved.
// Proprietary and confidential. See LICENSE in the repository root.

import crypto from 'node:crypto';
import QRCode from 'qrcode';
import { currentCode, currentShortCode, nextChangeAt, STEP_MS } from './liveCode.js';
import { orgBaseUrl } from './tenantHost.js';

// Screens paired to an event's live code. An organiser who wants the code on several laptops around a
// venue adds a screen, gets a short pairing code, and types it on each laptop. The laptop then holds a long
// secret of its own and shows the code; it never has the organiser's password and can do nothing else.

export const PAIR_TTL_MS = 10 * 60 * 1000;
export const MAX_SCREENS_PER_EVENT = 10;
// A screen stops working this long after the event ends, so a laptop left behind goes quiet on its own.
export const SCREEN_GRACE_MS = 12 * 60 * 60 * 1000;
// A screen asks again at every change of code (at most five minutes), so this long without a request
// means it has been closed or has lost its connection.
export const ONLINE_MS = 7 * 60 * 1000;

// No 0, 1, I, L or O: a code read off one laptop and typed on another must not be ambiguous.
const PAIR_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const PAIR_LENGTH = 6;

export function newPairCode() {
  let out = '';
  for (let i = 0; i < PAIR_LENGTH; i += 1) out += PAIR_ALPHABET[crypto.randomInt(PAIR_ALPHABET.length)];
  return out;
}

// What someone typed, as a code, or null. Case, spaces and dashes do not matter.
export function cleanPairCode(raw) {
  const s = String(raw ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (s.length !== PAIR_LENGTH) return null;
  return [...s].every((c) => PAIR_ALPHABET.includes(c)) ? s : null;
}

export const showPairCode = (code) => `${code.slice(0, 3)}-${code.slice(3)}`;

export function newScreenToken() {
  const raw = `ls_${crypto.randomBytes(24).toString('base64url')}`;
  return { raw, hash: hashToken(raw) };
}

export const hashToken = (raw) => crypto.createHash('sha256').update(String(raw)).digest('hex');

export function cleanLabel(raw, fallback) {
  const s = String(raw ?? '').replace(/\s+/g, ' ').trim().slice(0, 40);
  return s || fallback;
}

// Where a screen is in its life, for the organiser's list.
export function screenStatus(screen, now = Date.now()) {
  if (screen.revokedAt) return 'REVOKED';
  if (!screen.tokenHash) return screen.pairExpiresAt && new Date(screen.pairExpiresAt).getTime() > now ? 'WAITING' : 'CODE_EXPIRED';
  return screen.lastSeenAt && now - new Date(screen.lastSeenAt).getTime() < ONLINE_MS ? 'ONLINE' : 'OFFLINE';
}

export const screensCloseAt = (event) => new Date(event.endAt).getTime() + SCREEN_GRACE_MS;

// Why a paired screen, or one being paired, may not show the code now, or null when it may.
export function screenRefusal(event, now = Date.now()) {
  if (!event || event.deletedAt) return { error: 'GONE', message: 'This event no longer exists.' };
  if (!event.liveCode || !event.liveSecret) return { error: 'NOT_LIVE', message: 'The live code has been switched off for this event.' };
  if (now > screensCloseAt(event)) return { error: 'ENDED', message: 'This event has ended, so the screen has stopped.' };
  return null;
}

// What a live code screen draws: the QR of the sign-in link with the code of this moment in it, the same
// code as six digits, and when it changes. Shared by the organiser's own screen and paired screens.
export async function livePayload(event, now = Date.now()) {
  const code = currentCode(event.liveSecret, event.id, now);
  const url = `${await orgBaseUrl(event.organisationId)}/attend?event=${encodeURIComponent(event.slug)}&k=${code}`;
  const qr = await QRCode.toDataURL(url, { width: 640, margin: 1, errorCorrectionLevel: 'M' });
  const short = currentShortCode(event.liveSecret, event.id, now);
  return {
    name: event.name,
    virtual: event.locationType === 'VIRTUAL',
    qr,
    short: short.slice(0, 3) + ' ' + short.slice(3),
    changesAt: nextChangeAt(now),
    now,
    stepMs: STEP_MS
  };
}
