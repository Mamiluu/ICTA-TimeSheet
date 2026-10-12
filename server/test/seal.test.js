// Copyright (c) 2026 Asya Hafidh <msanifuasiya@gmail.com>. All Rights Reserved.
// Proprietary and confidential. See LICENSE in the repository root.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { newSealCode, digestOf, SEAL_CODE_PATTERN, assembleEventSnapshot, summarizeSnapshot } from '../src/lib/seal.js';

const snapshot = {
  eventId: 'e1',
  dayPosition: 1,
  rows: [
    { attendanceId: 'a1', name: 'Ann', signed: true, signatureSha256: 'aa' },
    { attendanceId: 'a2', name: 'Ben', signed: false, signatureSha256: null }
  ]
};

describe('sheet seals', () => {
  test('codes are 10 characters from the Crockford alphabet', () => {
    for (let i = 0; i < 200; i++) {
      assert.match(newSealCode(), SEAL_CODE_PATTERN);
    }
  });

  test('codes avoid the look-alike letters I, L, O and U', () => {
    const codes = Array.from({ length: 200 }, newSealCode).join('');
    assert.doesNotMatch(codes, /[ILOU]/);
  });

  test('digest does not depend on key order', () => {
    const reordered = {
      rows: snapshot.rows,
      dayPosition: 1,
      eventId: 'e1'
    };
    assert.equal(digestOf(reordered), digestOf(snapshot));
  });

  test('digest changes when one signature hash changes', () => {
    const altered = structuredClone(snapshot);
    altered.rows[0].signatureSha256 = 'bb';
    assert.notEqual(digestOf(altered), digestOf(snapshot));
  });

  test('digest changes when a row is removed', () => {
    const altered = structuredClone(snapshot);
    altered.rows.pop();
    assert.notEqual(digestOf(altered), digestOf(snapshot));
  });
});

describe('whole-event seals', () => {
  const day = (n, signedB) => ({
    dayPosition: n,
    dayStartAt: `2026-10-0${n}T06:00:00.000Z`,
    dayEndAt: `2026-10-0${n}T14:00:00.000Z`,
    rows: [
      { attendanceId: 'a1', signed: true, signatureSha256: 'aa' },
      { attendanceId: 'a2', signed: signedB, signatureSha256: signedB ? 'bb' : null }
    ]
  });
  const event = { id: 'e1', name: 'Workshop' };

  test('summary reports per-day counts and no personal data', () => {
    const snap = assembleEventSnapshot(event, [day(1, true), day(2, false)]);
    assert.deepEqual(summarizeSnapshot(snap), {
      scope: 'EVENT',
      days: [
        { position: 1, rowCount: 2, signedCount: 2 },
        { position: 2, rowCount: 2, signedCount: 1 }
      ]
    });
  });

  test('altering one day changes the event digest', () => {
    const a = digestOf(assembleEventSnapshot(event, [day(1, true), day(2, true)]));
    const b = digestOf(assembleEventSnapshot(event, [day(1, true), day(2, false)]));
    assert.notEqual(a, b);
  });

  test('older one-day snapshots still summarise', () => {
    assert.equal(summarizeSnapshot(snapshot).scope, 'DAY');
    assert.equal(summarizeSnapshot(snapshot).days[0].signedCount, 1);
  });
});
