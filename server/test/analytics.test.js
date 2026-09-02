// Copyright (c) 2026 Asya Hafidh <msanifuasiya@gmail.com>. All Rights Reserved.
// Proprietary and confidential. See LICENSE in the repository root.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { bucketByDay, countsByKey } from '../src/lib/analytics.js';

describe('bucketByDay', () => {
  test('always returns exactly `days` entries, zero-filled, even with no data', () => {
    const now = new Date('2026-03-10T12:00:00Z');
    const buckets = bucketByDay([], 7, 'Africa/Nairobi', now);
    assert.equal(buckets.length, 7);
    assert.ok(buckets.every((b) => b.count === 0));
  });

  test('the last bucket is always "today" in the given timezone', () => {
    const now = new Date('2026-03-10T12:00:00Z'); // 15:00 in Nairobi, still 10 Mar
    const buckets = bucketByDay([], 3, 'Africa/Nairobi', now);
    assert.equal(buckets[buckets.length - 1].date, '2026-03-10');
  });

  test('counts an instant into the correct local day even near UTC midnight', () => {
    // 23:30 UTC on the 9th is 02:30 on the 10th in Nairobi (UTC+3) -- must
    // land in the 10th's bucket, not the 9th's.
    const now = new Date('2026-03-10T12:00:00Z');
    const instant = new Date('2026-03-09T23:30:00Z');
    const buckets = bucketByDay([instant], 3, 'Africa/Nairobi', now);
    const day10 = buckets.find((b) => b.date === '2026-03-10');
    const day9 = buckets.find((b) => b.date === '2026-03-09');
    assert.equal(day10.count, 1);
    assert.equal(day9.count, 0);
  });

  test('multiple instants on the same local day accumulate', () => {
    const now = new Date('2026-03-10T12:00:00Z');
    const instants = [new Date('2026-03-10T06:00:00Z'), new Date('2026-03-10T07:00:00Z'), new Date('2026-03-10T08:00:00Z')];
    const buckets = bucketByDay(instants, 1, 'Africa/Nairobi', now);
    assert.deepEqual(buckets, [{ date: '2026-03-10', count: 3 }]);
  });

  test('an instant older than the requested window is silently excluded, not put in the oldest bucket', () => {
    const now = new Date('2026-03-10T12:00:00Z');
    const tooOld = new Date('2026-01-01T00:00:00Z');
    const buckets = bucketByDay([tooOld], 3, 'Africa/Nairobi', now);
    assert.ok(buckets.every((b) => b.count === 0));
  });
});

describe('countsByKey', () => {
  test('every requested key is present even when the group data has no rows for it', () => {
    const result = countsByKey([], ['ACTIVE', 'FLAGGED_FOR_REMOVAL', 'RETIRED'], 'status');
    assert.deepEqual(result, { ACTIVE: 0, FLAGGED_FOR_REMOVAL: 0, RETIRED: 0 });
  });

  test('fills in real counts from a Prisma-groupBy-shaped input', () => {
    const groups = [
      { status: 'ACTIVE', _count: { _all: 12 } },
      { status: 'RETIRED', _count: { _all: 2 } }
    ];
    const result = countsByKey(groups, ['ACTIVE', 'FLAGGED_FOR_REMOVAL', 'RETIRED'], 'status');
    assert.deepEqual(result, { ACTIVE: 12, FLAGGED_FOR_REMOVAL: 0, RETIRED: 2 });
  });

  test('a null grouping key (e.g. consent never asked) is tracked under the string "null"', () => {
    const groups = [
      { photoVideoConsent: true, _count: { _all: 5 } },
      { photoVideoConsent: null, _count: { _all: 3 } }
    ];
    const result = countsByKey(groups, [true, false, null], 'photoVideoConsent');
    assert.deepEqual(result, { true: 5, false: 0, null: 3 });
  });
});
