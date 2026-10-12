// Copyright (c) 2026 Asya Hafidh <msanifuasiya@gmail.com>. All Rights Reserved.
// Proprietary and confidential. See LICENSE in the repository root.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { walkChain } from '../src/lib/anchor.js';
import { entryHashInput } from '../src/lib/audit.js';
import { hashToken } from '../src/lib/tokens.js';

function build(n) {
  const out = [];
  let prev = null;
  for (let i = 0; i < n; i++) {
    const e = { id: `e${i}`, actorId: null, action: 'X', targetType: null, targetId: null, metadata: { i }, createdAt: new Date(2026, 9, 1, 0, i), prevHash: prev };
    e.hash = hashToken(entryHashInput(e));
    prev = e.hash;
    out.push(e);
  }
  return out;
}

describe('walkChain', () => {
  test('an untouched chain has no mismatches or breaks', () => {
    const r = walkChain(build(4));
    assert.deepEqual([r.checked, r.hashMismatches.length, r.linkBreaks.length], [4, 0, 0]);
  });

  test('editing an entry is a hash mismatch', () => {
    const c = build(4);
    c[1].metadata = { i: 99 };
    assert.deepEqual(walkChain(c).hashMismatches, ['e1']);
  });

  test('removing an entry is a link break', () => {
    const c = build(4);
    c.splice(1, 1);
    assert.deepEqual(walkChain(c).linkBreaks, ['e2']);
  });

  test('entries written before chaining are skipped', () => {
    const c = [{ id: 'old', hash: null }, ...build(2)];
    assert.equal(walkChain(c).checked, 2);
  });
});
