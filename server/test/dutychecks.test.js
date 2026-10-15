// Copyright (c) 2026 Asya Hafidh <msanifuasiya@gmail.com>. All Rights Reserved.
// Proprietary and confidential. See LICENSE in the repository root.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeDuty, countFindings, kenyaHoliday, localDate, dayWord } from '../src/lib/dutyChecks.js';

const TZ = 'Africa/Nairobi';
// 27 July 2026 is a Monday.
const day = (id, position, date) => ({ id, position, startAt: `${date}T06:00:00Z`, place: 'Mombasa' });
const days = [day('d1', 1, '2026-07-27'), day('d2', 2, '2026-07-28'), day('d3', 3, '2026-07-29')];
const person = (id, name, extra = {}) => ({
  id,
  name,
  idNumber: 'S-' + id,
  phoneNormalized: '2547' + id.padStart(8, '0'),
  payeeType: 'STAFF',
  jobRole: 'Driver',
  ratePerDay: 6500,
  addedAt: '2026-07-20T08:00:00Z',
  cells: days.map((d) => ({
    dayId: d.id,
    status: 'SIGNED',
    signedAt: `${d.startAt.slice(0, 10)}T0${3 + (Number(id) % 4)}:00:00Z`,
    sigHash: `h-${id}-${d.id}`
  })),
  ...extra
});
const codes = (f) => f.map((x) => x.code);

test('calendar: dates are read in the event time zone', () => {
  assert.equal(localDate('2026-07-27T22:30:00Z', TZ), '2026-07-28'); // 01:30 the next morning in Nairobi
  assert.equal(dayWord('2026-07-27'), 'Monday');
});

test('holidays: fixed days, Easter, and a Sunday holiday moving to Monday', () => {
  assert.equal(kenyaHoliday('2026-06-01'), 'Madaraka Day');
  assert.equal(kenyaHoliday('2026-04-03'), 'Good Friday');
  assert.equal(kenyaHoliday('2026-04-06'), 'Easter Monday');
  assert.equal(kenyaHoliday('2026-10-20'), 'Mashujaa Day');
  assert.equal(kenyaHoliday('2026-07-27'), null);
  // 1 June 2025 was a Sunday, so Monday 2 June was observed.
  assert.equal(kenyaHoliday('2025-06-02'), 'Madaraka Day (observed)');
});

test('a clean sheet has nothing to report', () => {
  assert.deepEqual(analyzeDuty({ rows: [person('1', 'Ruth'), person('2', 'Saida')], days, timeZone: TZ }), []);
});

test('double claim: signed the same date on another sheet', () => {
  const others = [
    {
      eventName: 'Smart board training',
      idNumber: 'S-1',
      phoneNormalized: '254700000001',
      signed: [{ date: '2026-07-28' }, { date: '2026-08-04' }]
    }
  ];
  const f = analyzeDuty({ rows: [person('1', 'Ruth')], days, timeZone: TZ, others });
  assert.deepEqual(codes(f), ['DOUBLE_CLAIM']);
  assert.equal(f[0].severity, 'review');
  assert.match(f[0].detail, /2026-07-28/);
  assert.doesNotMatch(f[0].detail, /2026-08-04/, 'only the overlapping date is named');
});

test('double claim: other sheet on different dates is fine', () => {
  const others = [{ eventName: 'Another', idNumber: 'S-1', phoneNormalized: '254700000001', signed: [{ date: '2026-09-01' }] }];
  assert.deepEqual(analyzeDuty({ rows: [person('1', 'Ruth')], days, timeZone: TZ, others }), []);
});

test('the same phone under a different ID on another sheet is flagged', () => {
  const others = [{ eventName: 'Other sheet', idNumber: 'S-99', phoneNormalized: '254700000001', signed: [{ date: '2026-09-01' }] }];
  const f = analyzeDuty({ rows: [person('1', 'Ruth')], days, timeZone: TZ, others });
  assert.deepEqual(codes(f), ['PHONE_SHARED']);
});

test('identical signature images are flagged, across days and across people', () => {
  const a = person('1', 'Ruth');
  a.cells[1].sigHash = a.cells[0].sigHash;
  assert.deepEqual(codes(analyzeDuty({ rows: [a], days, timeZone: TZ })), ['SAME_SIGNATURE_DAYS']);

  const b = person('2', 'Saida');
  const c = person('3', 'Wilfred');
  c.cells[0].sigHash = b.cells[0].sigHash;
  const f = analyzeDuty({ rows: [b, c], days, timeZone: TZ });
  assert.deepEqual(codes(f), ['SAME_SIGNATURE_PEOPLE']);
  assert.match(f[0].detail, /Saida and Wilfred/);
});

test('weekend and holiday days that carry signatures are noted', () => {
  const wk = [day('s1', 1, '2026-08-01'), day('s2', 2, '2026-06-01')]; // a Saturday and Madaraka Day
  const r = person('1', 'Ruth', {
    cells: [
      { dayId: 's1', status: 'SIGNED', sigHash: 'a' },
      { dayId: 's2', status: 'SIGNED', sigHash: 'b' }
    ]
  });
  const f = analyzeDuty({ rows: [r], days: wk, timeZone: TZ });
  assert.deepEqual(codes(f).sort(), ['HOLIDAY', 'WEEKEND']);
  assert.ok(f.every((x) => x.severity === 'note'));
});

test('a weekend day nobody signed is not mentioned', () => {
  const wk = [day('s1', 1, '2026-08-01')];
  const r = person('1', 'Ruth', { cells: [{ dayId: 's1', status: 'ABSENT' }] });
  assert.deepEqual(analyzeDuty({ rows: [r], days: wk, timeZone: TZ }), []);
});

test('a rate well above the group is noted, but only with enough people to compare', () => {
  const rows = [person('1', 'A'), person('2', 'B'), person('3', 'C', { ratePerDay: 15000 })];
  const f = analyzeDuty({ rows, days, timeZone: TZ });
  assert.deepEqual(codes(f), ['RATE_HIGH']);
  assert.equal(f[0].payeeIds[0], '3');
  assert.deepEqual(codes(analyzeDuty({ rows: rows.slice(1), days, timeZone: TZ })), [], 'two people are not enough to call one an outlier');
});

test('people added after the start are noted', () => {
  const rows = [person('1', 'Ruth'), person('2', 'Saida', { addedAt: '2026-07-27T09:00:00Z' })];
  const f = analyzeDuty({ rows, days, timeZone: TZ });
  assert.deepEqual(codes(f), ['LATE_ADDED']);
  assert.match(f[0].detail, /Saida/);
});

test('many people signing within two minutes is noted once per day', () => {
  const mk = (id) =>
    person(id, 'P' + id, { cells: [{ dayId: 'd1', status: 'SIGNED', signedAt: `2026-07-27T06:0${id}:10Z`, sigHash: 'x' + id }] });
  const f = analyzeDuty({
    rows: [mk('1'), mk('2'), mk('3'), mk('4')].map((r) => ({
      ...r,
      cells: r.cells.map((c) => ({ ...c, signedAt: '2026-07-27T06:00:30Z' }))
    })),
    days: [days[0]],
    timeZone: TZ
  });
  assert.deepEqual(codes(f), ['CLUSTERED_SIGNING']);
  const spread = analyzeDuty({ rows: [mk('1'), mk('2'), mk('3'), mk('4')], days: [days[0]], timeZone: TZ });
  assert.deepEqual(codes(spread), [], 'signatures a minute apart each are spread out');
});

test('findings come with the ones that need review first, and can be counted', () => {
  const a = person('1', 'Ruth', { addedAt: '2026-07-27T09:00:00Z' });
  a.cells[1].sigHash = a.cells[0].sigHash;
  const f = analyzeDuty({ rows: [a], days, timeZone: TZ });
  assert.equal(f[0].severity, 'review');
  assert.deepEqual(countFindings(f), { review: 1, notes: 1 });
});
