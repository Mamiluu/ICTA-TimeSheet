// Copyright (c) 2026 Asya Hafidh <msanifuasiya@gmail.com>. All Rights Reserved.
// Proprietary and confidential. See LICENSE in the repository root.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  accessOf,
  kindsFor,
  canAccessKind,
  dayStatus,
  payFor,
  buildPayRows,
  totalsOf,
  chunk,
  cleanPayee,
  cleanAuthority,
  csvCell,
  buildPayCsv,
  approvalCheck,
  sheetIsOpen,
  STAGE_LABEL
} from '../src/lib/duty.js';

const HOUR = 60 * 60 * 1000;
const day = (startOffsetH, now) => ({
  id: 'd' + startOffsetH,
  position: 1,
  startAt: new Date(now + startOffsetH * HOUR),
  endAt: new Date(now + (startOffsetH + 8) * HOUR)
});

test('access: who sees which kind of event', () => {
  assert.deepEqual(kindsFor({ role: 'COUNTY_ADMIN', access: 'ATTENDANCE' }), ['ATTENDANCE']);
  assert.deepEqual(kindsFor({ role: 'COUNTY_ADMIN', access: 'PAYMENT' }), ['DUTY_ROLL']);
  assert.deepEqual(kindsFor({ role: 'COUNTY_ADMIN', access: 'BOTH' }), ['ATTENDANCE', 'DUTY_ROLL']);
  assert.deepEqual(kindsFor({ role: 'COUNTY_ADMIN' }), ['ATTENDANCE'], 'an account with no setting keeps attendance sheets only');
  assert.equal(accessOf({ role: 'SUPER_ADMIN' }), 'BOTH');
  assert.deepEqual(kindsFor({ role: 'PLATFORM_ADMIN' }), [], 'the platform admin never sees event records');
  assert.deepEqual(kindsFor(null), []);
});

test('access: what the organisation has switched on caps what a person can reach', () => {
  const admin = { role: 'COUNTY_ADMIN', access: 'BOTH' };
  assert.deepEqual(kindsFor({ ...admin, organisation: { modules: ['ATTENDANCE'] } }), ['ATTENDANCE']);
  assert.deepEqual(kindsFor({ ...admin, organisation: { modules: ['PAYMENT'] } }), ['DUTY_ROLL']);
  assert.deepEqual(kindsFor({ ...admin, organisation: { modules: ['ATTENDANCE', 'PAYMENT'] } }), ['ATTENDANCE', 'DUTY_ROLL']);
  assert.deepEqual(
    kindsFor({ role: 'SUPER_ADMIN', organisation: { modules: ['ATTENDANCE'] } }),
    ['ATTENDANCE'],
    'even a department super admin'
  );
  assert.deepEqual(
    kindsFor({ ...admin, organisation: null }),
    ['ATTENDANCE', 'DUTY_ROLL'],
    'with no organisation loaded nothing is taken away'
  );
});

test('access: an event with no kind counts as an attendance sheet', () => {
  assert.equal(canAccessKind({ role: 'COUNTY_ADMIN', access: 'ATTENDANCE' }, undefined), true);
  assert.equal(canAccessKind({ role: 'COUNTY_ADMIN', access: 'PAYMENT' }, 'ATTENDANCE'), false);
  assert.equal(canAccessKind({ role: 'COUNTY_ADMIN', access: 'ATTENDANCE' }, 'DUTY_ROLL'), false);
});

test('dayStatus: unsigned cells become absent once the day has closed', () => {
  const now = Date.now();
  assert.equal(dayStatus(day(-48, now), true, now), 'SIGNED');
  assert.equal(dayStatus(day(-48, now), false, now), 'ABSENT');
  assert.equal(dayStatus(day(-2, now), false, now), 'OPEN');
  assert.equal(dayStatus(day(24, now), false, now), 'UPCOMING');
});

test('dayStatus: a reopened day is open again, not absent', () => {
  const now = Date.now();
  const d = { ...day(-48, now), reopenedUntil: new Date(now + HOUR) };
  assert.equal(dayStatus(d, false, now), 'OPEN');
});

test('pay: rate times days signed, never negative', () => {
  assert.equal(payFor(5000, 3), 15000);
  assert.equal(payFor(5000, 0), 0);
  assert.equal(payFor(-5, 3), 0);
});

test('buildPayRows counts only signed days and totals them', () => {
  const now = Date.now();
  const days = [
    { ...day(-72, now), id: 'a' },
    { ...day(-48, now), id: 'b' },
    { ...day(-24, now), id: 'c' }
  ];
  const payees = [
    { id: 'p1', ratePerDay: 4000 },
    { id: 'p2', ratePerDay: 2500 }
  ];
  const signed = new Map([
    ['p1', new Set(['a', 'b'])],
    ['p2', new Set(['c'])]
  ]);
  const rows = buildPayRows(payees, days, signed, now);
  assert.deepEqual(
    rows[0].cells.map((c) => c.status),
    ['SIGNED', 'SIGNED', 'ABSENT']
  );
  assert.equal(rows[0].amount, 8000);
  assert.equal(rows[1].amount, 2500);
  assert.deepEqual(totalsOf(rows), { people: 2, daysSigned: 3, amount: 10500 });
});

test('chunk splits fifteen days into pages of nine and six', () => {
  const pages = chunk(
    Array.from({ length: 15 }, (_, i) => i + 1),
    9
  );
  assert.deepEqual(
    pages.map((p) => p.length),
    [9, 6]
  );
});

test('cleanPayee accepts a staff member and defaults the organisation', () => {
  const r = cleanPayee({
    name: '  Saida   Athman ',
    payeeType: 'STAFF',
    idNumber: 'icta/0123',
    phone: '0712345678',
    ratePerDay: '6500',
    jobRole: 'Driver'
  });
  assert.equal(r.error, undefined);
  assert.equal(r.value.name, 'Saida Athman');
  assert.equal(r.value.idNumber, 'ICTA/0123');
  assert.equal(r.value.organisation, 'ICTA');
  assert.equal(r.value.ratePerDay, 6500);
});

test('cleanPayee needs an organisation for an external invitee', () => {
  const r = cleanPayee({ name: 'Ruth Njoroge', payeeType: 'EXTERNAL', idNumber: '12345678', phone: '0712345678', ratePerDay: 5000 });
  assert.match(r.error, /organisation/i);
  assert.equal(
    cleanPayee({
      name: 'Ruth Njoroge',
      payeeType: 'EXTERNAL',
      idNumber: '12345678',
      phone: '0712345678',
      ratePerDay: 5000,
      organisation: 'MoE'
    }).error,
    undefined
  );
});

test('cleanPayee rejects bad input', () => {
  const ok = { name: 'Ruth Njoroge', payeeType: 'STAFF', idNumber: 'A1234', phone: '0712345678', ratePerDay: 5000 };
  assert.ok(cleanPayee({ ...ok, name: 'R' }).error);
  assert.ok(cleanPayee({ ...ok, payeeType: 'OTHER' }).error);
  assert.ok(cleanPayee({ ...ok, idNumber: '1' }).error);
  assert.ok(cleanPayee({ ...ok, phone: '123' }).error);
  assert.ok(cleanPayee({ ...ok, ratePerDay: 12.5 }).error);
  assert.ok(cleanPayee({ ...ok, ratePerDay: -1 }).error);
  assert.ok(cleanPayee({ ...ok, ratePerDay: 99999999 }).error);
});

test('cleanAuthority needs both the officer and the reference', () => {
  assert.ok(cleanAuthority({ authorisedBy: 'Director', authorityRef: '' }).error);
  assert.ok(cleanAuthority({ authorisedBy: '', authorityRef: 'MEMO/1' }).error);
  assert.deepEqual(cleanAuthority({ authorisedBy: ' Director  ICT ', authorityRef: 'MEMO/1' }).value, {
    authorisedBy: 'Director ICT',
    authorityRef: 'MEMO/1'
  });
});

test('csv: quotes, and defuses spreadsheet formulas', () => {
  assert.equal(csvCell('plain'), 'plain');
  assert.equal(csvCell('a,b'), '"a,b"');
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell('=HYPERLINK("x")'), '"\'=HYPERLINK(""x"")"');
  assert.equal(csvCell('+254712345678'), "'+254712345678");
});

test('csv: one line per person plus a total', () => {
  const rows = [
    {
      name: 'A',
      payeeType: 'STAFF',
      idNumber: 'S1',
      organisation: 'ICTA',
      jobRole: 'Driver',
      phone: '0712',
      ratePerDay: 1000,
      cells: [{ status: 'SIGNED' }, { status: 'ABSENT' }],
      daysSigned: 1,
      amount: 1000
    }
  ];
  const csv = buildPayCsv(rows, [{ position: 1 }, { position: 2 }])
    .trim()
    .split('\r\n');
  assert.equal(csv.length, 3);
  assert.match(csv[1], /Signed,Absent,1,1000$/);
  assert.match(csv[2], /^,Total/);
});

// ---- Approval chain ----

const sheet = (stage) => ({ id: 'e1', ownerId: 'prep', departmentId: 'd1', dutyStage: stage });
const person = (id, role, paymentRole, extra = {}) => ({ id, role, paymentRole, access: 'PAYMENT', departmentId: 'd1', ...extra });
const step = (user, event, s, approvals = []) => approvalCheck({ user, event, step: s, approvals });

test('only the preparer submits, and only while the sheet is open', () => {
  assert.equal(step(person('prep', 'COUNTY_ADMIN', 'PREPARER'), sheet('OPEN'), 'SUBMIT').ok, true);
  assert.equal(step(person('other', 'COUNTY_ADMIN', 'PREPARER'), sheet('OPEN'), 'SUBMIT').error, 'NOT_PREPARER');
  assert.equal(step(person('prep', 'COUNTY_ADMIN', 'PREPARER'), sheet('SUBMITTED'), 'SUBMIT').error, 'WRONG_STAGE');
});

test('certifying needs an authorising officer who did not prepare the sheet', () => {
  const approvals = [{ step: 'SUBMITTED', byId: 'prep' }];
  assert.equal(step(person('auth', 'COUNTY_ADMIN', 'AUTHORISER'), sheet('SUBMITTED'), 'CERTIFY', approvals).ok, true);
  assert.equal(
    step(person('boss', 'SUPER_ADMIN', 'PREPARER'), sheet('SUBMITTED'), 'CERTIFY', approvals).ok,
    true,
    'a department super admin can certify'
  );
  assert.equal(step(person('x', 'COUNTY_ADMIN', 'FINANCE'), sheet('SUBMITTED'), 'CERTIFY', approvals).error, 'NOT_AUTHORISER');
  assert.equal(step(person('x', 'COUNTY_ADMIN', 'PREPARER'), sheet('SUBMITTED'), 'CERTIFY', approvals).error, 'NOT_AUTHORISER');
  assert.equal(
    step(person('prep', 'COUNTY_ADMIN', 'AUTHORISER'), sheet('SUBMITTED'), 'CERTIFY', approvals).error,
    'CONFLICT',
    'the preparer cannot certify their own sheet'
  );
  assert.equal(step(person('auth', 'COUNTY_ADMIN', 'AUTHORISER'), sheet('OPEN'), 'CERTIFY', approvals).error, 'WRONG_STAGE');
});

test('verifying needs finance, and a person different from the preparer and the certifier', () => {
  const approvals = [
    { step: 'SUBMITTED', byId: 'prep' },
    { step: 'CERTIFIED', byId: 'auth' }
  ];
  assert.equal(step(person('fin', 'COUNTY_ADMIN', 'FINANCE'), sheet('CERTIFIED'), 'VERIFY', approvals).ok, true);
  assert.equal(
    step(person('auth', 'COUNTY_ADMIN', 'FINANCE'), sheet('CERTIFIED'), 'VERIFY', approvals).error,
    'CONFLICT',
    'the certifier cannot verify'
  );
  assert.equal(step(person('prep', 'COUNTY_ADMIN', 'FINANCE'), sheet('CERTIFIED'), 'VERIFY', approvals).error, 'CONFLICT');
  assert.equal(step(person('x', 'COUNTY_ADMIN', 'AUTHORISER'), sheet('CERTIFIED'), 'VERIFY', approvals).error, 'NOT_FINANCE');
});

test('a sheet can be returned from the stage it is waiting at, by the right person', () => {
  const sub = [{ step: 'SUBMITTED', byId: 'prep' }];
  assert.equal(step(person('auth', 'COUNTY_ADMIN', 'AUTHORISER'), sheet('SUBMITTED'), 'RETURN', sub).ok, true);
  assert.equal(step(person('fin', 'COUNTY_ADMIN', 'FINANCE'), sheet('SUBMITTED'), 'RETURN', sub).error, 'NOT_AUTHORISER');
  const cert = [...sub, { step: 'CERTIFIED', byId: 'auth' }];
  assert.equal(step(person('fin', 'COUNTY_ADMIN', 'FINANCE'), sheet('CERTIFIED'), 'RETURN', cert).ok, true);
  assert.equal(step(person('auth', 'COUNTY_ADMIN', 'AUTHORISER'), sheet('CERTIFIED'), 'RETURN', cert).error, 'NOT_FINANCE');
  assert.equal(step(person('auth', 'COUNTY_ADMIN', 'AUTHORISER'), sheet('OPEN'), 'RETURN', cert).error, 'WRONG_STAGE');
});

test('approval is limited to the same department and to accounts with payment access', () => {
  const approvals = [{ step: 'SUBMITTED', byId: 'prep' }];
  assert.equal(
    step(person('auth', 'COUNTY_ADMIN', 'AUTHORISER', { departmentId: 'd2' }), sheet('SUBMITTED'), 'CERTIFY', approvals).error,
    'NO_ACCESS'
  );
  assert.equal(
    step(person('auth', 'COUNTY_ADMIN', 'AUTHORISER', { access: 'ATTENDANCE' }), sheet('SUBMITTED'), 'CERTIFY', approvals).error,
    'NO_ACCESS'
  );
  assert.equal(step(null, sheet('SUBMITTED'), 'CERTIFY', approvals).error, 'NO_ACCESS');
});

test('the sheet is only editable while it is open', () => {
  assert.equal(sheetIsOpen({ dutyStage: 'OPEN' }), true);
  assert.equal(sheetIsOpen({}), true);
  assert.equal(sheetIsOpen({ dutyStage: 'SUBMITTED' }), false);
  assert.equal(sheetIsOpen({ dutyStage: 'VERIFIED' }), false);
  assert.ok(STAGE_LABEL.CERTIFIED);
});

import { pickRecipients } from '../src/lib/dutyNotify.js';

test('marking a sheet as paid: only finance, only once, never the preparer', () => {
  const verified = (extra = {}) => ({ ...sheet('VERIFIED'), ...extra });
  assert.equal(step(person('fin', 'COUNTY_ADMIN', 'FINANCE'), verified(), 'PAY').ok, true);
  assert.equal(step(person('boss', 'SUPER_ADMIN', 'PREPARER'), verified(), 'PAY').ok, true, 'a super admin can');
  assert.equal(step(person('auth', 'COUNTY_ADMIN', 'AUTHORISER'), verified(), 'PAY').error, 'NOT_FINANCE');
  assert.equal(
    step(person('prep', 'COUNTY_ADMIN', 'FINANCE'), verified(), 'PAY').error,
    'CONFLICT',
    'the preparer cannot mark their own sheet as paid'
  );
  assert.equal(step(person('fin', 'COUNTY_ADMIN', 'FINANCE'), verified({ paidAt: new Date() }), 'PAY').error, 'ALREADY_PAID');
  assert.equal(step(person('fin', 'COUNTY_ADMIN', 'FINANCE'), sheet('CERTIFIED'), 'PAY').error, 'WRONG_STAGE');
});

const people = [
  { email: 'Boss@x.go.ke', role: 'SUPER_ADMIN', paymentRole: 'PREPARER', access: 'BOTH' },
  { email: 'officer@x.go.ke', role: 'COUNTY_ADMIN', paymentRole: 'AUTHORISER', access: 'PAYMENT' },
  { email: 'fin@x.go.ke', role: 'COUNTY_ADMIN', paymentRole: 'FINANCE', access: 'BOTH' },
  { email: 'prep@x.go.ke', role: 'COUNTY_ADMIN', paymentRole: 'PREPARER', access: 'PAYMENT' },
  { email: 'att@x.go.ke', role: 'COUNTY_ADMIN', paymentRole: 'FINANCE', access: 'ATTENDANCE' }
];

test('who is emailed when a payment sheet moves', () => {
  const pick = (kind, extra = {}) =>
    pickRecipients({ kind, users: people, preparerEmail: 'prep@x.go.ke', financeEmail: null, actorEmail: 'nobody@x.go.ke', ...extra });
  assert.deepEqual(pick('SUBMITTED'), ['officer@x.go.ke']);
  assert.deepEqual(pick('CERTIFIED'), ['fin@x.go.ke'], 'finance only, and not someone without payment access');
  assert.deepEqual(
    pick('CERTIFIED', { financeEmail: 'Finance@x.go.ke' }),
    ['fin@x.go.ke', 'finance@x.go.ke'],
    'the shared finance mailbox is told too'
  );
  assert.deepEqual(pick('RETURNED'), ['prep@x.go.ke']);
  assert.deepEqual(pick('VERIFIED'), ['fin@x.go.ke', 'prep@x.go.ke']);
  assert.deepEqual(pick('PAID'), ['prep@x.go.ke']);
});

test('emails fall back to the super admins when nobody holds the role, and skip whoever acted', () => {
  const noOfficer = people.filter((p) => p.paymentRole !== 'AUTHORISER');
  assert.deepEqual(pickRecipients({ kind: 'SUBMITTED', users: noOfficer, preparerEmail: 'prep@x.go.ke', actorEmail: 'x' }), [
    'boss@x.go.ke'
  ]);
  assert.deepEqual(
    pickRecipients({ kind: 'SUBMITTED', users: people, preparerEmail: 'prep@x.go.ke', actorEmail: 'OFFICER@x.go.ke' }),
    [],
    'the person who just acted is not emailed'
  );
  assert.deepEqual(pickRecipients({ kind: 'PAID', users: people, preparerEmail: null, actorEmail: 'x' }), []);
});
