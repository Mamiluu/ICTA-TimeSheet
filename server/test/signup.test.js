// Copyright (c) 2026 Asya Hafidh <msanifuasiya@gmail.com>. All Rights Reserved.
// Proprietary and confidential. See LICENSE in the repository root.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanSignup, verifyLinkExpired } from '../src/lib/signup.js';
import { cleanDomain, isPlatformHost, checkPointsAt, hostKey } from '../src/lib/domains.js';

const good = {
  organisationName: '  Kenya  Power ',
  contactName: ' Jane Wanjiku ',
  contactEmail: 'Jane@KPLC.co.ke',
  phone: '+254 700 000 000',
  message: 'We run field trainings.'
};

test('sign-up: a complete request is tidied', () => {
  assert.deepEqual(cleanSignup(good).value, {
    organisationName: 'Kenya Power',
    contactName: 'Jane Wanjiku',
    contactEmail: 'jane@kplc.co.ke',
    phone: '+254 700 000 000',
    message: 'We run field trainings.'
  });
});

test('sign-up: phone and message are optional', () => {
  const r = cleanSignup({ ...good, phone: '', message: '' });
  assert.equal(r.value.phone, null);
  assert.equal(r.value.message, null);
});

test('sign-up: refuses what it cannot use', () => {
  assert.ok(cleanSignup({ ...good, organisationName: 'ab' }).error);
  assert.ok(cleanSignup({ ...good, contactName: 'J' }).error);
  assert.ok(cleanSignup({ ...good, contactEmail: 'not-an-email' }).error);
  assert.ok(cleanSignup({ ...good, phone: 'call me' }).error);
});

test('sign-up: the hidden field catches automated forms', () => {
  assert.deepEqual(cleanSignup({ ...good, website: 'http://spam.example' }), { bot: true });
});

test('sign-up: the confirmation link lasts two days', () => {
  const now = Date.UTC(2026, 9, 23, 12);
  assert.equal(verifyLinkExpired(new Date(now - 47 * 3600 * 1000), now), false);
  assert.equal(verifyLinkExpired(new Date(now - 49 * 3600 * 1000), now), true);
});

test("domains: only a proper name under the organisation's own domain is accepted", () => {
  assert.equal(cleanDomain('Attend.KPLC.co.ke'), 'attend.kplc.co.ke');
  assert.equal(cleanDomain('https://attend.kplc.co.ke/login'), 'attend.kplc.co.ke');
  assert.equal(cleanDomain('attend.kplc.co.ke.'), 'attend.kplc.co.ke');
  assert.equal(cleanDomain('kplc.co.ke'), 'kplc.co.ke'.split('.').length < 3 ? null : 'kplc.co.ke');
  assert.equal(cleanDomain('kplc.com'), null, 'a bare domain is not accepted');
  assert.equal(cleanDomain('192.168.0.1'), null);
  assert.equal(cleanDomain('bad_name.kplc.co.ke'), null);
  assert.equal(cleanDomain('-bad.kplc.co.ke'), null);
  assert.equal(cleanDomain('a.b.c1'), null);
  assert.equal(cleanDomain(''), null);
  assert.equal(cleanDomain(undefined), null);
});

test("domains: the platform's own names cannot be claimed", () => {
  assert.equal(isPlatformHost('icta-attendance.onrender.com', 'icta-attendance.onrender.com'), true);
  assert.equal(isPlatformHost('x.icta-attendance.onrender.com', 'icta-attendance.onrender.com'), true);
  assert.equal(isPlatformHost('attend.kplc.co.ke', 'icta-attendance.onrender.com'), false);
  assert.equal(isPlatformHost('evilicta-attendance.onrender.com', 'icta-attendance.onrender.com'), false);
});

test('domains: a CNAME to the platform passes, anything else does not', async () => {
  const to = (records) => async () => records;
  assert.deepEqual(await checkPointsAt('attend.kplc.co.ke', 'platform.onrender.com', to(['platform.onrender.com.'])), {
    ok: true,
    found: ['platform.onrender.com'],
    reason: null
  });
  assert.equal((await checkPointsAt('attend.kplc.co.ke', 'platform.onrender.com', to(['elsewhere.example.com']))).reason, 'WRONG_TARGET');
  const none = async () => {
    throw Object.assign(new Error('x'), { code: 'ENODATA' });
  };
  assert.equal((await checkPointsAt('attend.kplc.co.ke', 'platform.onrender.com', none)).reason, 'NO_RECORD');
  const broken = async () => {
    throw Object.assign(new Error('x'), { code: 'ETIMEOUT' });
  };
  assert.equal((await checkPointsAt('attend.kplc.co.ke', 'platform.onrender.com', broken)).reason, 'LOOKUP_FAILED');
});

test("domains: a request's host name is read as a wildcard name, an own address, or the platform itself", () => {
  assert.equal(hostKey('platform.onrender.com', 'platform.onrender.com', null), null);
  assert.deepEqual(hostKey('kplc.attend.example.org', 'platform.onrender.com', 'attend.example.org'), { kind: 'slug', value: 'kplc' });
  assert.deepEqual(
    hostKey('a.b.attend.example.org', 'platform.onrender.com', 'attend.example.org'),
    { kind: 'domain', value: 'a.b.attend.example.org' },
    'only one label counts as an organisation name'
  );
  assert.deepEqual(hostKey('Attend.KPLC.co.ke:443', 'platform.onrender.com', 'attend.example.org'), {
    kind: 'domain',
    value: 'attend.kplc.co.ke'
  });
  assert.equal(hostKey('', 'platform.onrender.com', null), null);
});
