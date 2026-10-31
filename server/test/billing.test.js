// Copyright (c) 2026 Asya Hafidh <msanifuasiya@gmail.com>. All Rights Reserved.
// Proprietary and confidential. See LICENSE in the repository root.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanPrice, cleanBlurb, usageLevel, yearlySavingPct, catalog, suggestion, ORDERED, REQUESTABLE } from '../src/lib/billing.js';

test('a price is whole shillings or empty', () => {
  assert.deepEqual(cleanPrice('15,000', 'x'), { value: 15000 });
  assert.deepEqual(cleanPrice(' 2500 ', 'x'), { value: 2500 });
  assert.deepEqual(cleanPrice('', 'x'), { value: null });
  assert.deepEqual(cleanPrice(null, 'x'), { value: null });
  assert.deepEqual(cleanPrice(0, 'x'), { value: 0 });
  for (const bad of ['12.5', '-1', 'abc', '1e9', 100000001]) assert.ok(cleanPrice(bad, 'The price').error, String(bad));
});

test('a blurb is short plain text', () => {
  assert.equal(cleanBlurb('  For   small teams '), 'For small teams');
  assert.equal(cleanBlurb(''), null);
  assert.equal(cleanBlurb('x'.repeat(300)).length, 140);
});

test('a limit shows when it is close and when it is used up', () => {
  assert.equal(usageLevel(3, 5), 'ok');
  assert.equal(usageLevel(4, 5), 'warn');
  assert.equal(usageLevel(5, 5), 'full');
  assert.equal(usageLevel(6, 5), 'full');
  assert.equal(usageLevel(999, null), 'ok');
  assert.equal(usageLevel(0, undefined), 'ok');
});

test('a yearly price shows what it saves, and nothing when it saves nothing', () => {
  assert.equal(yearlySavingPct(10000, 100000), 17);
  assert.equal(yearlySavingPct(10000, 120000), null);
  assert.equal(yearlySavingPct(10000, 130000), null);
  assert.equal(yearlySavingPct(null, 100000), null);
  assert.equal(yearlySavingPct(10000, null), null);
});

test('the catalogue lists the offered plans in order, with prices only where set', () => {
  const c = catalog([{ plan: 'STANDARD', monthlyKes: 20000, yearlyKes: 200000, blurb: 'For a growing team' }]);
  assert.deepEqual(
    c.map((p) => p.key),
    ORDERED
  );
  const starter = c.find((p) => p.key === 'STARTER');
  assert.equal(starter.monthlyKes, null);
  assert.equal(starter.maxAdmins, 5);
  assert.equal(starter.modules.find((m) => m.key === 'DOOR_SCAN').on, false);
  const standard = c.find((p) => p.key === 'STANDARD');
  assert.equal(standard.monthlyKes, 20000);
  assert.equal(standard.savingPct, 17);
  assert.equal(standard.modules.find((m) => m.key === 'DOOR_SCAN').on, true);
  assert.equal(c.find((p) => p.key === 'FULL').maxEventsPerMonth, null);
});

test('Pilot is never offered, and Custom can be asked for', () => {
  assert.ok(!REQUESTABLE.includes('PILOT'));
  assert.ok(REQUESTABLE.includes('CUSTOM'));
  assert.ok(!ORDERED.includes('CUSTOM'));
});

test('an organisation near a limit is pointed at the smallest plan that fits', () => {
  const s = suggestion('STARTER', { used: 4, limit: 5 }, { used: 3, limit: 30 });
  assert.equal(s.plan, 'STANDARD');
  assert.match(s.reason, /4 of 5 administrator places/);
  const full = suggestion('STARTER', { used: 5, limit: 5 }, { used: 30, limit: 30 });
  assert.match(full.reason, /all 5 administrator places are taken and this month's 30 events are used up/);
});

test('a plan too small for the usage skips to one that fits', () => {
  const s = suggestion('STARTER', { used: 24, limit: 5 }, { used: 3, limit: 30 });
  assert.equal(s.plan, 'FULL');
});

test('no nudge when there is room, on the top plan, or off the ladder', () => {
  assert.equal(suggestion('STARTER', { used: 1, limit: 5 }, { used: 2, limit: 30 }), null);
  assert.equal(suggestion('FULL', { used: 99, limit: 100 }, { used: 5, limit: null }), null);
  assert.equal(suggestion('PILOT', { used: 17, limit: null }, { used: 57, limit: null }), null);
  assert.equal(suggestion('CUSTOM', { used: 8, limit: 8 }, { used: 1, limit: null }), null);
});
