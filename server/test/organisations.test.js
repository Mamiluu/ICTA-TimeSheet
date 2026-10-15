// Copyright (c) 2026 Asya Hafidh <msanifuasiya@gmail.com>. All Rights Reserved.
// Proprietary and confidential. See LICENSE in the repository root.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { orgSlug, isValidOrgSlug, cleanOrgName, cleanShortName, billingState, extendPaidUntil } from '../src/lib/organisations.js';

test('slug is lower-case, dashed and at most 40 characters', () => {
  assert.equal(orgSlug('ICT Authority'), 'ict-authority');
  assert.equal(orgSlug('Kenya Power & Lighting Co.'), 'kenya-power-and-lighting-co');
  assert.ok(orgSlug('A very long organisation name that keeps on going and going').length <= 40);
  assert.doesNotMatch(orgSlug('A very long organisation name that keeps on going and going'), /-$/);
});

test('a usable slug has no double dashes and is not reserved', () => {
  assert.equal(isValidOrgSlug('icta'), true);
  assert.equal(isValidOrgSlug('kenya-power'), true);
  assert.equal(isValidOrgSlug('a'), false);
  assert.equal(isValidOrgSlug('-icta'), false);
  assert.equal(isValidOrgSlug('ic--ta'), false);
  assert.equal(isValidOrgSlug('IC TA'), false);
  assert.equal(isValidOrgSlug('owner'), false);
  assert.equal(isValidOrgSlug('www'), false);
});

test('names are trimmed and single-spaced, and must be a sensible length', () => {
  assert.equal(cleanOrgName('  Kenya   Power '), 'Kenya Power');
  assert.equal(cleanOrgName('ab'), null);
  assert.equal(cleanOrgName('!!!'), null);
  assert.equal(cleanOrgName('x'.repeat(101)), null);
  assert.equal(cleanOrgName(undefined), null);
});

test('short name is optional and capped', () => {
  assert.equal(cleanShortName(''), null);
  assert.equal(cleanShortName(' KPLC '), 'KPLC');
  assert.equal(cleanShortName('x'.repeat(40)).length, 20);
});

const NOW = Date.UTC(2026, 9, 16, 12, 0, 0);
const dayAt = (n) => new Date(NOW + n * 24 * 60 * 60 * 1000);

test('billing: where an organisation stands on its monthly payment', () => {
  assert.deepEqual(billingState(null, NOW), { state: 'NOT_SET', days: null });
  assert.equal(billingState(dayAt(30), NOW).state, 'PAID');
  assert.deepEqual(billingState(dayAt(5), NOW), { state: 'DUE_SOON', days: 5 });
  assert.equal(billingState(dayAt(7), NOW).state, 'DUE_SOON');
  assert.equal(billingState(dayAt(8), NOW).state, 'PAID');
  assert.deepEqual(billingState(dayAt(-4.5), NOW), { state: 'OVERDUE', days: 4 });
  assert.equal(billingState(dayAt(-0.2), NOW).state, 'OVERDUE');
});

test('a payment adds whole months from today, or from when the last one runs out', () => {
  assert.equal(extendPaidUntil(null, 1, NOW).toISOString().slice(0, 10), '2026-11-16');
  assert.equal(extendPaidUntil(dayAt(-20), 1, NOW).toISOString().slice(0, 10), '2026-11-16', 'a lapsed organisation counts from today');
  assert.equal(
    extendPaidUntil(Date.UTC(2026, 10, 20, 12), 1, NOW)
      .toISOString()
      .slice(0, 10),
    '2026-12-20',
    'paying early keeps the days already paid for'
  );
  assert.equal(
    extendPaidUntil(Date.UTC(2026, 0, 31, 12), 1, Date.UTC(2026, 0, 10))
      .toISOString()
      .slice(0, 10),
    '2026-02-28',
    'the end of a short month is not skipped past'
  );
  assert.equal(extendPaidUntil(null, 12, NOW).toISOString().slice(0, 10), '2027-10-16');
});
