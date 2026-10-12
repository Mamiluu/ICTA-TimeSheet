// Copyright (c) 2026 Asya Hafidh <msanifuasiya@gmail.com>. All Rights Reserved.
// Proprietary and confidential. See LICENSE in the repository root.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { certificateEligible, assembleCertificateSnapshot, certificateStillHolds, publicCertificateView } from '../src/lib/certificate.js';
import { digestOf } from '../src/lib/seal.js';

const event = { id: 'e1', name: 'Digital Hubs Review', county: 'Makueni', timezone: 'Africa/Nairobi', certificatesEnabled: true };
const attendee = { id: 'a1', name: 'Eric Chepkwony', organization: 'TDA', email: 'e@x.ke', phone: '0712345678' };
const days = [1, 2, 3].map((n) => ({ id: `d${n}`, position: n, startAt: `2026-10-0${n + 1}T06:00:00Z`, endAt: `2026-10-0${n + 1}T14:00:00Z` }));
const sig = (dayId, extra = {}) => ({ dayId, signature: `img-${dayId}`, signedAt: '2026-10-02T07:00:00Z', method: 'DEVICE', ...extra });

describe('certificateEligible', () => {
  test('only after the last day has ended', () => {
    assert.equal(certificateEligible(event, days, Date.parse('2026-10-03T00:00:00Z')), false);
    assert.equal(certificateEligible(event, days, Date.parse('2026-10-04T14:00:01Z')), true);
  });
  test('never when the organiser turned certificates off', () => {
    assert.equal(certificateEligible({ ...event, certificatesEnabled: false }, days, Date.parse('2027-01-01T00:00:00Z')), false);
  });
});

describe('certificate snapshot', () => {
  test('lists only the days the person signed, in order, with signature hashes', () => {
    const s = assembleCertificateSnapshot(event, attendee, days, [sig('d3'), sig('d1')]);
    assert.deepEqual(s.days.map((d) => d.position), [1, 3]);
    assert.equal(s.totalDays, 3);
    assert.match(s.days[0].signatureSha256, /^[0-9a-f]{64}$/);
  });

  test('holds no phone, email or signature image', () => {
    const text = JSON.stringify(assembleCertificateSnapshot(event, attendee, days, [sig('d1')]));
    assert.doesNotMatch(text, /0712345678|e@x\.ke|img-d1/);
  });

  test('digest is stable and changes if a signature changes', () => {
    const a = digestOf(assembleCertificateSnapshot(event, attendee, days, [sig('d1')]));
    const b = digestOf(assembleCertificateSnapshot(event, attendee, days, [sig('d1')]));
    const c = digestOf(assembleCertificateSnapshot(event, attendee, days, [sig('d1', { signature: 'other' })]));
    assert.equal(a, b);
    assert.notEqual(a, c);
  });
});

describe('certificateStillHolds', () => {
  const issued = assembleCertificateSnapshot(event, attendee, days, [sig('d1'), sig('d2')]);
  test('holds when later days were added', () => {
    const live = assembleCertificateSnapshot(event, attendee, days, [sig('d1'), sig('d2'), sig('d3')]);
    assert.equal(certificateStillHolds(issued, live), true);
  });
  test('fails when a listed day is gone or its signature changed', () => {
    assert.equal(certificateStillHolds(issued, assembleCertificateSnapshot(event, attendee, days, [sig('d1')])), false);
    assert.equal(certificateStillHolds(issued, assembleCertificateSnapshot(event, attendee, days, [sig('d1'), sig('d2', { signature: 'forged' })])), false);
  });
});

test('public view carries no hashes or ids', () => {
  const v = publicCertificateView(assembleCertificateSnapshot(event, attendee, days, [sig('d1')]));
  assert.doesNotMatch(JSON.stringify(v), /signatureSha256|attendeeId|eventId/);
  assert.equal(v.name, 'Eric Chepkwony');
});
