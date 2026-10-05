// Copyright (c) 2026 Asya Hafidh <msanifuasiya@gmail.com>. All Rights Reserved.
// Proprietary and confidential. See LICENSE in the repository root.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { newSealCode, digestOf, SEAL_CODE_PATTERN } from '../src/lib/seal.js';

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
