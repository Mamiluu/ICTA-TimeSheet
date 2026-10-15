// Copyright (c) 2026 Asya Hafidh <msanifuasiya@gmail.com>. All Rights Reserved.
// Proprietary and confidential. See LICENSE in the repository root.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { supportState, isOpenState, cleanSupportRequest, supportAllowed } from '../src/lib/support.js';

const NOW = Date.UTC(2026, 9, 20, 12, 0, 0);
const HOUR = 60 * 60 * 1000;
const at = (h) => new Date(NOW + h * HOUR);

test('a request waits for an answer, and goes stale after three days', () => {
  assert.equal(supportState({ status: 'REQUESTED', createdAt: at(-5) }, NOW), 'PENDING');
  assert.equal(supportState({ status: 'REQUESTED', createdAt: at(-71) }, NOW), 'PENDING');
  assert.equal(supportState({ status: 'REQUESTED', createdAt: at(-73) }, NOW), 'LAPSED');
});

test('an approval is active until it runs out, then it is over', () => {
  assert.equal(supportState({ status: 'APPROVED', createdAt: at(-3), expiresAt: at(1) }, NOW), 'ACTIVE');
  assert.equal(supportState({ status: 'APPROVED', createdAt: at(-5), expiresAt: at(-1) }, NOW), 'ENDED');
  assert.equal(supportState({ status: 'APPROVED', createdAt: at(-5), expiresAt: null }, NOW), 'ENDED');
});

test('a refused or revoked grant stays that way', () => {
  assert.equal(supportState({ status: 'DENIED', createdAt: at(-1) }, NOW), 'DENIED');
  assert.equal(supportState({ status: 'REVOKED', createdAt: at(-1), expiresAt: at(5) }, NOW), 'REVOKED');
});

test('only a waiting or running grant counts as open', () => {
  assert.equal(isOpenState('PENDING'), true);
  assert.equal(isOpenState('ACTIVE'), true);
  for (const s of ['LAPSED', 'ENDED', 'DENIED', 'REVOKED']) assert.equal(isOpenState(s), false);
});

test('a request needs a real reason and a sensible length of time', () => {
  assert.deepEqual(cleanSupportRequest({ reason: '  A user cannot   log in to the portal ' }).value, {
    reason: 'A user cannot log in to the portal',
    hours: 4
  });
  assert.equal(cleanSupportRequest({ reason: 'help', hours: 4 }).error.length > 0, true);
  assert.ok(cleanSupportRequest({ reason: 'x'.repeat(301) }).error);
  assert.ok(cleanSupportRequest({ reason: 'A real reason here', hours: 0 }).error);
  assert.ok(cleanSupportRequest({ reason: 'A real reason here', hours: 25 }).error);
  assert.ok(cleanSupportRequest({ reason: 'A real reason here', hours: 1.5 }).error);
  assert.equal(cleanSupportRequest({ reason: 'A real reason here', hours: '8' }).value.hours, 8);
});

test("support can only read the administrator's overview pages, never change anything", () => {
  for (const p of ['/departments', '/super-admins', '/overview', '/audit', '/branding']) assert.equal(supportAllowed('GET', p), true);
  assert.equal(supportAllowed('POST', '/departments'), false);
  assert.equal(supportAllowed('PUT', '/branding'), false);
  assert.equal(supportAllowed('DELETE', '/super-admins'), false);
  assert.equal(supportAllowed('GET', '/support'), false, 'support cannot approve or even see its own grants');
  assert.equal(supportAllowed('GET', '/anchor'), false);
  assert.equal(supportAllowed('GET', '/departments/'), false);
});
