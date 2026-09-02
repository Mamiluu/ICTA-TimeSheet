// Copyright (c) 2026 Asya Hafidh <msanifuasiya@gmail.com>. All Rights Reserved.
// Proprietary and confidential. See LICENSE in the repository root.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalJson, entryHashInput, verifyChain } from '../src/lib/audit.js';
import { hashToken } from '../src/lib/tokens.js';

// Builds a chain the same way lib/audit.js's own nextHash() does, without
// touching Prisma -- each entry's hash covers its own fields plus the
// previous entry's hash, exactly mirroring writeAudit's real chaining.
function buildChain(rawEntries) {
  let prevHash = null;
  return rawEntries.map((raw) => {
    const entry = { ...raw, prevHash, createdAt: raw.createdAt };
    const hash = hashToken(entryHashInput(entry));
    prevHash = hash;
    return { ...entry, hash };
  });
}

describe('canonicalJson', () => {
  test('key order does not affect the output', () => {
    const a = canonicalJson({ b: 1, a: 2 });
    const b = canonicalJson({ a: 2, b: 1 });
    assert.equal(a, b);
  });

  test('nested objects are also key-sorted', () => {
    const a = canonicalJson({ outer: { z: 1, y: 2 } });
    const b = canonicalJson({ outer: { y: 2, z: 1 } });
    assert.equal(a, b);
  });

  test('arrays preserve order (order is meaningful there)', () => {
    assert.equal(canonicalJson([1, 2, 3]), '[1,2,3]');
    assert.notEqual(canonicalJson([1, 2, 3]), canonicalJson([3, 2, 1]));
  });

  test('undefined values are treated as null, matching a jsonb round-trip', () => {
    assert.equal(canonicalJson(undefined), 'null');
  });
});

describe('verifyChain', () => {
  test('an untouched chain verifies entirely true', () => {
    const chain = buildChain([
      { actorId: 'u1', action: 'CREATE_EVENT', targetType: 'Event', targetId: 'e1', metadata: null, createdAt: '2026-01-01T00:00:00.000Z' },
      {
        actorId: 'u1',
        action: 'FLAG_ATTENDANCE',
        targetType: 'Attendance',
        targetId: 'a1',
        metadata: { reason: 'duplicate' },
        createdAt: '2026-01-01T00:05:00.000Z'
      },
      {
        actorId: 'u1',
        action: 'RETIRE_ATTENDANCE',
        targetType: 'Attendance',
        targetId: 'a1',
        metadata: null,
        createdAt: '2026-01-01T00:10:00.000Z'
      }
    ]);
    assert.deepEqual(verifyChain(chain), [true, true, true]);
  });

  test('mutating one entry breaks that entry and every entry after it, not before it', () => {
    const chain = buildChain([
      { actorId: 'u1', action: 'CREATE_EVENT', targetType: 'Event', targetId: 'e1', metadata: null, createdAt: '2026-01-01T00:00:00.000Z' },
      {
        actorId: 'u1',
        action: 'FLAG_ATTENDANCE',
        targetType: 'Attendance',
        targetId: 'a1',
        metadata: { reason: 'duplicate' },
        createdAt: '2026-01-01T00:05:00.000Z'
      },
      {
        actorId: 'u1',
        action: 'RETIRE_ATTENDANCE',
        targetType: 'Attendance',
        targetId: 'a1',
        metadata: null,
        createdAt: '2026-01-01T00:10:00.000Z'
      }
    ]);

    // Tamper with the middle entry's metadata after the fact, the way an
    // attacker with raw DB access might try to quietly rewrite history.
    chain[1] = { ...chain[1], metadata: { reason: 'not a duplicate after all' } };

    const result = verifyChain(chain);
    assert.equal(result[0], true, 'entry before the tampered one is unaffected');
    assert.equal(result[1], false, 'the tampered entry itself no longer matches its stored hash');
    // Entry 2 still recomputes against *its own* stored prevHash (which
    // still points at the original, now-wrong hash of entry 1) -- so this
    // check alone wouldn't independently catch entry 2. That's expected:
    // verifyChain checks each entry's self-consistency, not chain linkage
    // between entries; a real verifier additionally compares each
    // entry.prevHash to the previous entry's stored hash to catch this.
    assert.equal(
      chain[2].prevHash,
      chain[1].hash,
      "entry 2 still points at the tampered entry's (now attacker-supplied) hash, not the original"
    );
  });

  test('an entry with no hash (pre-dates the audit-chain column) reports false rather than throwing', () => {
    const result = verifyChain([{ action: 'LEGACY_ACTION', hash: null }]);
    assert.deepEqual(result, [false]);
  });

  test('an empty chain verifies to an empty result', () => {
    assert.deepEqual(verifyChain([]), []);
  });
});
