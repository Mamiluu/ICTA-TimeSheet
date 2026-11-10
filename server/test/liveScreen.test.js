// Copyright (c) 2026 Asya Hafidh <msanifuasiya@gmail.com>. All Rights Reserved.
// Proprietary and confidential. See LICENSE in the repository root.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  newPairCode,
  cleanPairCode,
  showPairCode,
  newScreenToken,
  hashToken,
  cleanLabel,
  screenStatus,
  screenRefusal,
  screensCloseAt,
  ONLINE_MS,
  SCREEN_GRACE_MS
} from '../src/lib/liveScreen.js';

const NOW = Date.parse('2026-11-11T09:00:00Z');
const live = { liveCode: true, liveSecret: 'x', deletedAt: null, endAt: new Date(NOW + 3600 * 1000) };

test('a pairing code is six characters with nothing easy to misread', () => {
  for (let i = 0; i < 200; i += 1) {
    const c = newPairCode();
    assert.match(c, /^[A-HJKMNP-Z2-9]{6}$/);
    assert.equal(cleanPairCode(c), c);
  }
});

test('a typed code is accepted whatever its case, spaces or dash', () => {
  assert.equal(cleanPairCode('k7m-4qx'), 'K7M4QX');
  assert.equal(cleanPairCode(' K7M 4QX '), 'K7M4QX');
  assert.equal(showPairCode('K7M4QX'), 'K7M-4QX');
});

test('a code that cannot have been made here is refused', () => {
  assert.equal(cleanPairCode(''), null);
  assert.equal(cleanPairCode('K7M4Q'), null);
  assert.equal(cleanPairCode('K7M4QXX'), null);
  assert.equal(cleanPairCode('K7M4Q0'), null, 'a zero is never in a code');
  assert.equal(cleanPairCode('K7M4QI'), null, 'nor is the letter I');
  assert.equal(cleanPairCode(null), null);
});

test('a screen secret is long, unique, and only its hash is kept', () => {
  const a = newScreenToken();
  const b = newScreenToken();
  assert.match(a.raw, /^ls_[A-Za-z0-9_-]{32}$/);
  assert.notEqual(a.raw, b.raw);
  assert.equal(a.hash, hashToken(a.raw));
  assert.notEqual(a.hash, a.raw);
  assert.equal(a.hash.length, 64);
});

test('a screen name is tidied and has a fallback', () => {
  assert.equal(cleanLabel('  Main   entrance ', 'Screen 1'), 'Main entrance');
  assert.equal(cleanLabel('', 'Screen 2'), 'Screen 2');
  assert.equal(cleanLabel(undefined, 'Screen 3'), 'Screen 3');
  assert.equal(cleanLabel('x'.repeat(100), 'Screen').length, 40);
});

test('where a screen is in its life', () => {
  const waiting = { tokenHash: null, pairExpiresAt: new Date(NOW + 60000), revokedAt: null };
  assert.equal(screenStatus(waiting, NOW), 'WAITING');
  assert.equal(screenStatus({ ...waiting, pairExpiresAt: new Date(NOW - 1) }, NOW), 'CODE_EXPIRED');
  const paired = { tokenHash: 'h', pairExpiresAt: null, revokedAt: null, lastSeenAt: new Date(NOW - 60000) };
  assert.equal(screenStatus(paired, NOW), 'ONLINE');
  assert.equal(screenStatus({ ...paired, lastSeenAt: new Date(NOW - ONLINE_MS - 1) }, NOW), 'OFFLINE');
  assert.equal(screenStatus({ ...paired, lastSeenAt: null }, NOW), 'OFFLINE');
  assert.equal(screenStatus({ ...paired, revokedAt: new Date(NOW) }, NOW), 'REVOKED');
});

test('a screen shows the code only while the event is live and not long over', () => {
  assert.equal(screenRefusal(live, NOW), null);
  assert.equal(screenRefusal(null, NOW).error, 'GONE');
  assert.equal(screenRefusal({ ...live, deletedAt: new Date() }, NOW).error, 'GONE');
  assert.equal(screenRefusal({ ...live, liveCode: false }, NOW).error, 'NOT_LIVE');
  assert.equal(screenRefusal({ ...live, liveSecret: null }, NOW).error, 'NOT_LIVE');
  const over = new Date(NOW - 1000).getTime();
  assert.equal(screenRefusal({ ...live, endAt: new Date(over) }, NOW), null, 'still working just after the event');
  assert.equal(screenRefusal({ ...live, endAt: new Date(NOW - SCREEN_GRACE_MS - 1) }, NOW).error, 'ENDED');
  assert.equal(screensCloseAt(live), live.endAt.getTime() + SCREEN_GRACE_MS);
});
