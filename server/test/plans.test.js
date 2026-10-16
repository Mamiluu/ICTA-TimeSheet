// Copyright (c) 2026 Asya Hafidh <msanifuasiya@gmail.com>. All Rights Reserved.
// Proprietary and confidential. See LICENSE in the repository root.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PLANS, MODULE_KEYS, hasModule, cleanPlanInput, withinLimit, monthStart } from '../src/lib/plans.js';

test('everything is on for an organisation with nothing recorded', () => {
  for (const m of MODULE_KEYS) assert.equal(hasModule({}, m), true);
  assert.equal(hasModule(null, 'PAYMENT'), true);
  assert.equal(hasModule({ modules: ['ATTENDANCE'] }, 'PAYMENT'), false);
  assert.equal(hasModule({ modules: ['ATTENDANCE'] }, 'ATTENDANCE'), true);
});

test('a plan fills in its own modules and limits', () => {
  const r = cleanPlanInput({ plan: 'starter' });
  assert.deepEqual(r.value, { plan: 'STARTER', modules: ['ATTENDANCE', 'CERTIFICATES'], maxAdmins: 5, maxEventsPerMonth: 30 });
  assert.deepEqual(cleanPlanInput({ plan: 'PILOT' }).value, {
    plan: 'PILOT',
    modules: MODULE_KEYS,
    maxAdmins: null,
    maxEventsPerMonth: null
  });
});

test('changing a plan by hand makes it custom, and the hand-set values win', () => {
  const r = cleanPlanInput({ plan: 'STARTER', modules: ['ATTENDANCE', 'PAYMENT'], maxAdmins: 8 });
  assert.deepEqual(r.value, { plan: 'CUSTOM', modules: ['ATTENDANCE', 'PAYMENT'], maxAdmins: 8, maxEventsPerMonth: 30 });
  assert.equal(cleanPlanInput({ plan: 'STARTER', maxEventsPerMonth: null }).value.plan, 'CUSTOM');
  assert.equal(
    cleanPlanInput({ plan: 'STARTER', maxEventsPerMonth: 30 }).value.plan,
    'STARTER',
    "sending the plan's own numbers does not make it custom"
  );
});

test('modules come out in the standard order whatever order they were sent', () => {
  assert.deepEqual(cleanPlanInput({ plan: 'CUSTOM', modules: ['CERTIFICATES', 'ATTENDANCE'] }).value.modules, [
    'ATTENDANCE',
    'CERTIFICATES'
  ]);
});

test('bad plan input is refused', () => {
  assert.ok(cleanPlanInput({ plan: 'GOLD' }).error);
  assert.ok(cleanPlanInput({}).error);
  assert.ok(cleanPlanInput({ plan: 'CUSTOM' }).error, 'a custom plan needs its modules');
  assert.ok(cleanPlanInput({ plan: 'CUSTOM', modules: [] }).error);
  assert.ok(cleanPlanInput({ plan: 'CUSTOM', modules: ['MAGIC'] }).error);
  assert.ok(cleanPlanInput({ plan: 'CUSTOM', modules: ['DOOR_SCAN', 'CERTIFICATES'] }).error, 'door scanning alone is not a product');
  assert.ok(cleanPlanInput({ plan: 'STARTER', maxAdmins: 0 }).error);
  assert.ok(cleanPlanInput({ plan: 'STARTER', maxAdmins: 1.5 }).error);
  assert.ok(cleanPlanInput({ plan: 'STARTER', maxEventsPerMonth: 1000000 }).error);
});

test('a limit of nothing means no limit, and a limit counts what is already used', () => {
  assert.equal(withinLimit(1000, null), true);
  assert.equal(withinLimit(4, 5), true);
  assert.equal(withinLimit(5, 5), false);
  assert.equal(withinLimit(0, 1), true);
});

test('the month starts on the first, in UTC', () => {
  assert.equal(monthStart(new Date(Date.UTC(2026, 9, 21, 15, 30))).toISOString(), '2026-10-01T00:00:00.000Z');
  assert.ok(PLANS.PILOT.maxAdmins === null);
});
