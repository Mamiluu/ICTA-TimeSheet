// Copyright (c) 2026 Asya Hafidh <msanifuasiya@gmail.com>. All Rights Reserved.
// Proprietary and confidential. See LICENSE in the repository root.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalJson, entryHashInput, hashMatches, normaliseMetadata, verifyChain } from '../src/lib/audit.js';
import { hashToken } from '../src/lib/tokens.js';

const when = new Date('2026-10-21T10:00:00.000Z');

describe('hashing what is actually stored', () => {
  test('a date inside metadata is hashed as the text the database will give back', () => {
    const raw = { name: 'Forum', startAt: new Date('2026-10-21T10:00:00.000Z') };
    assert.deepEqual(normaliseMetadata(raw), { name: 'Forum', startAt: '2026-10-21T10:00:00.000Z' });
    assert.equal(canonicalJson(normaliseMetadata(raw)), canonicalJson(JSON.parse(JSON.stringify(raw))));
  });

  test('missing or empty metadata is left alone', () => {
    assert.equal(normaliseMetadata(undefined), undefined);
    assert.equal(normaliseMetadata(null), null);
  });

  test('a new entry (version 2) verifies, and changing a date in it is caught', () => {
    const e = {
      actorId: null,
      action: 'EVENT_CREATE',
      metadata: normaliseMetadata({ startAt: new Date(when) }),
      createdAt: when,
      prevHash: null,
      hashVersion: 2
    };
    e.hash = hashToken(entryHashInput(e));
    assert.equal(hashMatches(e), true);
    assert.equal(hashMatches({ ...e, metadata: { startAt: '2026-10-21T11:00:00.000Z' } }), false);
  });
});

describe('entries written before the fix (version 1)', () => {
  // The old code hashed the raw metadata, so a Date was an empty object, then stored the date as text.
  const legacy = () => {
    const e = {
      actorId: 'u1',
      action: 'EVENT_CREATE',
      targetType: 'Event',
      targetId: 'e1',
      metadata: { name: 'Forum', startAt: new Date(when) },
      createdAt: when,
      prevHash: null
    };
    e.hash = hashToken(entryHashInput(e));
    return { ...e, metadata: JSON.parse(JSON.stringify(e.metadata)), hashVersion: 1 };
  };

  test('still verify, even though their dates read back as text', () => {
    assert.equal(hashMatches(legacy()), true);
  });

  test('but changing anything other than a date is still caught', () => {
    const e = legacy();
    assert.equal(hashMatches({ ...e, metadata: { ...e.metadata, name: 'Changed' } }), false);
    assert.equal(hashMatches({ ...e, action: 'EVENT_DELETE' }), false);
  });

  test('the same leniency is not given to a newer entry', () => {
    const e = legacy();
    assert.equal(hashMatches({ ...e, hashVersion: 2 }), false);
  });

  test('verifyChain reports each entry on its own', () => {
    const ok = legacy();
    const bad = { ...legacy(), metadata: { name: 'Tampered', startAt: when.toISOString() } };
    assert.deepEqual(verifyChain([ok, bad, { ...ok, hash: null }]), [true, false, false]);
  });
});
