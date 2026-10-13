// Copyright (c) 2026 Asya Hafidh <msanifuasiya@gmail.com>. All Rights Reserved.
// Proprietary and confidential. See LICENSE in the repository root.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { walletStatus, walletEntry } from '../src/lib/wallet.js';

const day = (n) => ({ startAt: `2026-10-0${n}T06:00:00Z`, endAt: `2026-10-0${n}T14:00:00Z` });
const days = [day(2), day(3), day(4)];
const at = (iso) => Date.parse(iso);

describe('walletStatus', () => {
  test('a withdrawn entry is withdrawn whatever the dates say', () => {
    assert.equal(walletStatus({ attendeeStatus: 'RETIRED', days, signedCount: 3, now: at('2026-11-01T00:00:00Z') }), 'WITHDRAWN');
  });

  test('before, during and between days', () => {
    const s = (iso) => walletStatus({ attendeeStatus: 'ACTIVE', days, signedCount: 1, now: at(iso) });
    assert.equal(s('2026-10-01T00:00:00Z'), 'UPCOMING');
    assert.equal(s('2026-10-02T07:00:00Z'), 'IN_PROGRESS');
    assert.equal(s('2026-10-02T20:00:00Z'), 'IN_PROGRESS'); // between day 1 and day 2
  });

  test('after the last day it reflects how many days were signed', () => {
    const after = at('2026-10-10T00:00:00Z');
    assert.equal(walletStatus({ attendeeStatus: 'ACTIVE', days, signedCount: 3, now: after }), 'ATTENDED');
    assert.equal(walletStatus({ attendeeStatus: 'ACTIVE', days, signedCount: 2, now: after }), 'PARTIAL');
    assert.equal(walletStatus({ attendeeStatus: 'ACTIVE', days, signedCount: 0, now: after }), 'MISSED');
  });

  test('flagged entries still count as attending', () => {
    assert.equal(
      walletStatus({ attendeeStatus: 'FLAGGED_FOR_REMOVAL', days: [day(2)], signedCount: 1, now: at('2026-10-10T00:00:00Z') }),
      'ATTENDED'
    );
  });
});

describe('walletEntry', () => {
  const event = {
    slug: 'budget-1',
    name: 'Budget Review',
    county: 'Makueni',
    startAt: days[0].startAt,
    endAt: days[2].endAt,
    timezone: 'Africa/Nairobi',
    certificatesEnabled: true
  };
  const attendee = { status: 'ACTIVE', phone: '0712345678', email: 'a@b.ke', signature: 'data:image/png;base64,xxx' };

  test('carries the certificate code when one has been issued', () => {
    const e = walletEntry({
      event,
      attendee,
      days,
      signedCount: 3,
      certificate: { id: 'ABCDE12345' },
      certificateReady: true,
      now: at('2026-10-10T00:00:00Z')
    });
    assert.equal(e.certificateCode, 'ABCDE12345');
    assert.equal(e.status, 'ATTENDED');
    assert.equal(e.daysSigned, 3);
    assert.equal(e.totalDays, 3);
  });

  test('never carries personal details', () => {
    const text = JSON.stringify(walletEntry({ event, attendee, days, signedCount: 1, certificate: null, certificateReady: false }));
    assert.doesNotMatch(text, /0712345678|a@b\.ke|data:image/);
  });
});
