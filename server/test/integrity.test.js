// Copyright (c) 2026 Asya Hafidh <msanifuasiya@gmail.com>. All Rights Reserved.
// Proprietary and confidential. See LICENSE in the repository root.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeIntegrity, buildMatrix, BULK_SIGNATURES_PER_MINUTE } from '../src/lib/integrity.js';

const day1 = { id: 'd1', position: 1, startAt: new Date('2026-10-05T06:00:00Z'), endAt: new Date('2026-10-05T14:00:00Z') };
const day2 = { id: 'd2', position: 2, startAt: new Date('2026-10-06T06:00:00Z'), endAt: new Date('2026-10-06T14:00:00Z') };
const people = ['Ann', 'Ben', 'Cy', 'Dee', 'Eli', 'Fay'].map((name, i) => ({
  id: `p${i}`,
  name,
  organization: 'TDA',
  phone: `07000000${i}`
}));
const sig = (p, day, extra = {}) => ({
  attendanceId: p,
  dayId: day.id,
  method: 'DEVICE',
  signedAt: new Date('2026-10-05T07:00:00Z'),
  signatureSha256: `h-${p}-${day.id}`,
  imported: false,
  ...extra
});
const codes = (r) => r.map((f) => f.code);

describe('analyzeIntegrity', () => {
  test('a clean record has no findings', () => {
    const sigs = [sig('p0', day1), sig('p1', day1, { signedAt: new Date('2026-10-05T07:05:00Z') })];
    assert.deepEqual(analyzeIntegrity({ people, days: [day1], signatures: sigs }), []);
  });

  test('the same signature image on two people is flagged for review', () => {
    const sigs = [sig('p0', day1, { signatureSha256: 'same' }), sig('p1', day1, { signatureSha256: 'same' })];
    const r = analyzeIntegrity({ people, days: [day1], signatures: sigs });
    assert.deepEqual(codes(r), ['DUPLICATE_SIGNATURE']);
    assert.equal(r[0].severity, 'review');
    assert.deepEqual(r[0].people.sort(), ['p0', 'p1']);
  });

  test('one person reusing their own signature on another day is normal', () => {
    const sigs = [
      sig('p0', day1, { signatureSha256: 'mine' }),
      sig('p0', day2, { signatureSha256: 'mine', signedAt: new Date('2026-10-06T07:00:00Z') })
    ];
    assert.deepEqual(analyzeIntegrity({ people, days: [day1, day2], signatures: sigs }), []);
  });

  test('door stamps and imported signatures are never compared', () => {
    const sigs = [
      sig('p0', day1, { method: 'DOOR', signatureSha256: 'stamp' }),
      sig('p1', day1, { method: 'DOOR', signatureSha256: 'stamp' }),
      sig('p2', day1, { imported: true, signatureSha256: 'initials' }),
      sig('p3', day1, { imported: true, signatureSha256: 'initials' })
    ];
    assert.deepEqual(analyzeIntegrity({ people, days: [day1], signatures: sigs }), []);
  });

  test('many signatures in one minute are flagged, but door scans do not count', () => {
    const t = new Date('2026-10-05T07:00:10Z');
    const many = Array.from({ length: BULK_SIGNATURES_PER_MINUTE }, (_, i) => sig(`x${i}`, day1, { signedAt: t }));
    assert.ok(codes(analyzeIntegrity({ people, days: [day1], signatures: many })).includes('BULK_SIGNING'));
    const doors = many.map((s) => ({ ...s, method: 'DOOR' }));
    assert.ok(!codes(analyzeIntegrity({ people, days: [day1], signatures: doors })).includes('BULK_SIGNING'));
  });

  test('a signature before the day opens or after it closes is flagged', () => {
    const late = sig('p0', day1, { signedAt: new Date('2026-10-05T20:00:00Z') });
    const early = sig('p1', day1, { signedAt: new Date('2026-10-05T04:00:00Z') });
    const r = analyzeIntegrity({ people, days: [day1], signatures: [late, early] });
    assert.deepEqual(codes(r), ['OUTSIDE_WINDOW']);
    assert.match(r[0].title, /^2 signatures/);
  });

  test('a reopened day extends its window', () => {
    const reopened = { ...day1, reopenedUntil: new Date('2026-10-06T00:00:00Z') };
    const s = sig('p0', day1, { signedAt: new Date('2026-10-05T20:00:00Z') });
    assert.deepEqual(analyzeIntegrity({ people, days: [reopened], signatures: [s] }), []);
  });

  test('a phone-heavy day is a note, not a review item', () => {
    const sigs = people.slice(0, 5).map((p) => sig(p.id, day1, { method: 'PHONE' }));
    const r = analyzeIntegrity({ people, days: [day1], signatures: sigs });
    assert.deepEqual(codes(r), ['PHONE_HEAVY_DAY']);
    assert.equal(r[0].severity, 'note');
  });

  test('frequent attendees are a note and review items sort first', () => {
    const sigs = [sig('p0', day1, { signatureSha256: 'same' }), sig('p1', day1, { signatureSha256: 'same' })];
    const r = analyzeIntegrity({ people, days: [day1], signatures: sigs, history: new Map([['p2', 7]]) });
    assert.deepEqual(codes(r), ['DUPLICATE_SIGNATURE', 'FREQUENT_ATTENDEE']);
  });
});

describe('buildMatrix', () => {
  test('marks each person per day and totals every day', () => {
    const sigs = [sig('p0', day1), sig('p0', day2), sig('p1', day1, { method: 'PHONE' })];
    const m = buildMatrix(people.slice(0, 3), [day1, day2], sigs);
    assert.deepEqual(
      m.rows.map((r) => r.daysAttended),
      [2, 1, 0]
    );
    assert.deepEqual(m.totals, [2, 1]);
    assert.equal(m.rows[1].days[0].method, 'PHONE');
    assert.equal(m.rows[1].days[1].signed, false);
  });
});
