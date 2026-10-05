// Copyright (c) 2026 Asya Hafidh <msanifuasiya@gmail.com>. All Rights Reserved.
// Proprietary and confidential. See LICENSE in the repository root.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { missingAttendeeField } from '../src/routes/public.js';

const complete = { name: 'Ann Wambui', org: 'ICTA', email: 'ann@example.com' };

describe('required attendee fields', () => {
  test('a complete entry has nothing missing', () => {
    assert.equal(missingAttendeeField(complete), null);
  });

  test('a blank or whitespace name is rejected', () => {
    assert.equal(missingAttendeeField({ ...complete, name: '   ' }), 'name');
  });

  test('a blank organization is rejected', () => {
    assert.equal(missingAttendeeField({ ...complete, org: '' }), 'organization');
  });

  test('an email is required', () => {
    assert.equal(missingAttendeeField({ ...complete, email: '' }), 'email address');
  });

  test('a malformed email is rejected', () => {
    assert.equal(missingAttendeeField({ ...complete, email: 'ann@' }), 'email address');
  });
});
