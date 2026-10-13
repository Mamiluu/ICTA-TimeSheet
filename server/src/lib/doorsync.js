// Copyright (c) 2026 Asya Hafidh <msanifuasiya@gmail.com>. All Rights Reserved.
// Proprietary and confidential. See LICENSE in the repository root.

import crypto from 'node:crypto';

// Offline door scanning: a phone with no signal keeps its scans and sends them
// later. Two things make that safe. A pass is identified by a one-way
// fingerprint (sha256 of its secret id), so the device never has to store the
// secret itself; and every scan carries the time it really happened, which the
// server checks before it believes it.

export const ID_HASH_PATTERN = /^[0-9a-f]{64}$/;
export const SCAN_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const SCAN_FUTURE_SLACK_MS = 5 * 60 * 1000;

export function sha256Hex(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

// A phone's clock can be a little off, so a scan that claims to be slightly in
// the future is treated as "now". A scan older than a week is refused rather
// than guessed at: that is a device that sat unsynced for too long.
export function sanitizeScanTime(input, now = Date.now()) {
  const t = input == null || input === '' ? NaN : new Date(input).getTime();
  if (Number.isNaN(t)) return { ok: true, at: new Date(now) };
  if (t > now + SCAN_FUTURE_SLACK_MS) return { ok: true, at: new Date(now) };
  if (t < now - SCAN_MAX_AGE_MS) return { ok: false, error: 'SCAN_TOO_OLD' };
  return { ok: true, at: new Date(Math.min(t, now)) };
}

export function indexByIdHash(attendees) {
  return new Map(attendees.map((a) => [sha256Hex(a.clientId), a]));
}

// Accepts either the pass id itself (older callers) or its fingerprint.
export function resolveAttendee(index, { clientId, idHash }) {
  if (typeof idHash === 'string' && ID_HASH_PATTERN.test(idHash)) return index.get(idHash) || null;
  if (typeof clientId === 'string' && clientId.trim()) return index.get(sha256Hex(clientId.trim())) || null;
  return null;
}
