// Copyright (c) 2026 Asya Hafidh <msanifuasiya@gmail.com>. All Rights Reserved.
// Proprietary and confidential. See LICENSE in the repository root.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { publicUser, departmentPaused, organisationSuspended } from '../src/lib/userView.js';

const user = {
  id: 'u1',
  email: 'a@b.ke',
  role: 'SUPER_ADMIN',
  county: null,
  passwordHash: 'secret-hash',
  department: { id: 'd1', name: 'Finance & Accounting', slug: 'finance', active: true }
};

describe('publicUser', () => {
  test('carries role and department, and never the password hash', () => {
    const v = publicUser(user);
    assert.deepEqual(v, {
      id: 'u1',
      email: 'a@b.ke',
      role: 'SUPER_ADMIN',
      county: null,
      access: 'BOTH',
      paymentRole: null,
      department: { id: 'd1', name: 'Finance & Accounting' },
      organisation: null,
      modules: ['ATTENDANCE', 'PAYMENT', 'DOOR_SCAN', 'CERTIFICATES']
    });
    assert.doesNotMatch(JSON.stringify(v), /secret-hash|slug/);
  });

  test('a county admin carries the access the super admin granted', () => {
    assert.equal(publicUser({ ...user, role: 'COUNTY_ADMIN', access: 'PAYMENT' }).access, 'PAYMENT');
    assert.equal(publicUser({ ...user, role: 'COUNTY_ADMIN' }).access, 'ATTENDANCE');
    assert.equal(publicUser({ ...user, role: 'PLATFORM_ADMIN', department: null }).access, null);
  });

  test('a county admin carries their payment role', () => {
    assert.equal(publicUser({ ...user, role: 'COUNTY_ADMIN', paymentRole: 'FINANCE' }).paymentRole, 'FINANCE');
    assert.equal(publicUser({ ...user, role: 'COUNTY_ADMIN' }).paymentRole, 'PREPARER');
  });

  test('carries the organisation, and the owner has none', () => {
    const org = { id: 'o1', name: 'ICT Authority', shortName: 'ICTA', status: 'ACTIVE', slug: 'icta' };
    assert.deepEqual(publicUser({ ...user, organisation: org }).organisation, { id: 'o1', name: 'ICT Authority', shortName: 'ICTA' });
    assert.equal(publicUser({ ...user, role: 'OWNER', department: null }).organisation, null);
  });

  test('carries what the organisation has switched on', () => {
    const org = { id: 'o1', name: 'X', shortName: null, status: 'ACTIVE', modules: ['ATTENDANCE'] };
    assert.deepEqual(publicUser({ ...user, organisation: org }).modules, ['ATTENDANCE']);
  });

  test('an account with no department, such as the platform admin, has none', () => {
    assert.equal(publicUser({ ...user, role: 'PLATFORM_ADMIN', department: null }).department, null);
  });
});

describe('departmentPaused', () => {
  test('only a department that is switched off pauses its people', () => {
    assert.equal(departmentPaused(user), false);
    assert.equal(departmentPaused({ ...user, department: { ...user.department, active: false } }), true);
    assert.equal(departmentPaused({ ...user, department: null }), false);
  });
});

describe('organisationSuspended', () => {
  test('only a suspended organisation locks its people out', () => {
    assert.equal(organisationSuspended({ organisation: { status: 'ACTIVE' } }), false);
    assert.equal(organisationSuspended({ organisation: { status: 'SUSPENDED' } }), true);
    assert.equal(organisationSuspended({ organisation: null }), false);
  });
});
