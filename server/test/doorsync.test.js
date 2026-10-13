// Copyright (c) 2026 Asya Hafidh <msanifuasiya@gmail.com>. All Rights Reserved.
// Proprietary and confidential. See LICENSE in the repository root.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeScanTime, indexByIdHash, resolveAttendee, sha256Hex, SCAN_MAX_AGE_MS, SCAN_FUTURE_SLACK_MS } from '../src/lib/doorsync.js';

const now = Date.parse('2026-10-13T12:00:00Z');

describe('sanitizeScanTime', () => {
  test('keeps a recent scan time as it was', () => {
    const r = sanitizeScanTime('2026-10-13T09:30:00Z', now);
    assert.equal(r.ok, true);
    assert.equal(r.at.toISOString(), '2026-10-13T09:30:00.000Z');
  });

  test('a missing or unreadable time means now', () => {
    for (const v of [undefined, null, '', 'not a date']) {
      assert.equal(sanitizeScanTime(v, now).at.getTime(), now);
    }
  });

  test('a time slightly in the future is treated as now, never later', () => {
    assert.equal(sanitizeScanTime(new Date(now + SCAN_FUTURE_SLACK_MS + 60000).toISOString(), now).at.getTime(), now);
    assert.equal(sanitizeScanTime(new Date(now + 1000).toISOString(), now).at.getTime(), now);
  });

  test('a scan older than a week is refused', () => {
    const r = sanitizeScanTime(new Date(now - SCAN_MAX_AGE_MS - 1000).toISOString(), now);
    assert.deepEqual(r, { ok: false, error: 'SCAN_TOO_OLD' });
    assert.equal(sanitizeScanTime(new Date(now - SCAN_MAX_AGE_MS + 1000).toISOString(), now).ok, true);
  });
});

describe('resolveAttendee', () => {
  const people = [
    { id: 'a1', clientId: 'aaaaaaaa-1111-2222-3333-444444444444' },
    { id: 'a2', clientId: 'bbbbbbbb-1111-2222-3333-444444444444' }
  ];
  const index = indexByIdHash(people);

  test('finds a person by the fingerprint of their pass', () => {
    assert.equal(resolveAttendee(index, { idHash: sha256Hex(people[1].clientId) }).id, 'a2');
  });

  test('still accepts the pass id itself', () => {
    assert.equal(resolveAttendee(index, { clientId: ` ${people[0].clientId} ` }).id, 'a1');
  });

  test('an unknown, malformed or empty reference finds nobody', () => {
    assert.equal(resolveAttendee(index, { idHash: 'f'.repeat(64) }), null);
    assert.equal(resolveAttendee(index, { idHash: 'short' }), null);
    assert.equal(resolveAttendee(index, {}), null);
    assert.equal(resolveAttendee(index, { clientId: '' }), null);
  });

  test('the fingerprint is not the secret', () => {
    assert.notEqual(sha256Hex(people[0].clientId), people[0].clientId);
    assert.equal(sha256Hex(people[0].clientId).length, 64);
  });
});
