// Copyright (c) 2026 Asya Hafidh <msanifuasiya@gmail.com>. All Rights Reserved.
// Proprietary and confidential. See LICENSE in the repository root.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { dayIsOpen, dayOpensAt, dayClosesAt, parseDaySchedule, pickSigningDay, resolveSchedule } from '../src/lib/days.js';
import { DAY_SIGN_OPENS_BEFORE_MS, DAY_SIGN_CLOSES_AFTER_MS } from '../src/lib/constants.js';

const day = {
  startAt: new Date('2026-10-05T06:00:00Z'),
  endAt: new Date('2026-10-05T10:00:00Z')
};

describe('day signing window', () => {
  test('opens 30 minutes before the day starts and closes 2 hours after it ends', () => {
    assert.equal(DAY_SIGN_OPENS_BEFORE_MS, 30 * 60 * 1000);
    assert.equal(DAY_SIGN_CLOSES_AFTER_MS, 2 * 60 * 60 * 1000);
    assert.equal(dayOpensAt(day).toISOString(), '2026-10-05T05:30:00.000Z');
    assert.equal(dayClosesAt(day).toISOString(), '2026-10-05T12:00:00.000Z');
  });

  test('is closed just before opening and open at the boundaries', () => {
    assert.equal(dayIsOpen(day, Date.parse('2026-10-05T05:29:59.000Z')), false);
    assert.equal(dayIsOpen(day, Date.parse('2026-10-05T05:30:00.000Z')), true);
    assert.equal(dayIsOpen(day, Date.parse('2026-10-05T12:00:00.000Z')), true);
    assert.equal(dayIsOpen(day, Date.parse('2026-10-05T12:00:01.000Z')), false);
  });

  test('is open during the day itself', () => {
    assert.equal(dayIsOpen(day, Date.parse('2026-10-05T08:00:00.000Z')), true);
  });
});

const mk = (d) => ({ startAt: new Date(`2026-10-0${d}T06:00:00Z`), endAt: new Date(`2026-10-0${d}T14:00:00Z`) });

describe('parseDaySchedule', () => {
  test('accepts ordered, non-overlapping days', () => {
    const r = parseDaySchedule([mk(2), mk(3), mk(4)].map((d) => ({ startAt: d.startAt.toISOString(), endAt: d.endAt.toISOString() })));
    assert.equal(r.days.length, 3);
  });
  test('rejects empty, backwards, overlapping and oversized schedules', () => {
    assert.ok(parseDaySchedule([]).error);
    assert.ok(parseDaySchedule([{ startAt: '2026-10-02T10:00:00Z', endAt: '2026-10-02T09:00:00Z' }]).error);
    assert.ok(parseDaySchedule([
      { startAt: '2026-10-02T06:00:00Z', endAt: '2026-10-02T14:00:00Z' },
      { startAt: '2026-10-02T13:00:00Z', endAt: '2026-10-02T15:00:00Z' }
    ]).error);
    assert.ok(parseDaySchedule(Array.from({ length: 32 }, () => ({}))).error);
  });
});

describe('pickSigningDay', () => {
  const days = [mk(2), mk(3), mk(4)];
  test('picks the open day', () => {
    assert.equal(pickSigningDay(days, Date.parse('2026-10-03T07:00:00Z')), days[1]);
  });
  test('before the event it is day 1, between days it is the latest started day', () => {
    assert.equal(pickSigningDay(days, Date.parse('2026-09-30T07:00:00Z')), days[0]);
    assert.equal(pickSigningDay(days, Date.parse('2026-10-03T20:00:00Z')), days[1]);
  });
  test('after the last day it is the last day', () => {
    assert.equal(pickSigningDay(days, Date.parse('2026-10-08T07:00:00Z')), days[2]);
  });
});

describe('single-day events', () => {
  const f = { startAt: new Date('2026-10-05T06:00:00Z'), endAt: new Date('2026-10-05T10:00:00Z') };

  test('a body with no days becomes exactly one day with the event times', () => {
    const s = resolveSchedule({}, f);
    assert.equal(s.days.length, 1);
    assert.equal(s.startAt, f.startAt);
    assert.equal(s.endAt, f.endAt);
  });

  test('an explicit one-day list behaves the same', () => {
    const s = resolveSchedule({ days: [{ startAt: f.startAt.toISOString(), endAt: f.endAt.toISOString() }] }, f);
    assert.equal(s.days.length, 1);
    assert.equal(s.endAt.toISOString(), f.endAt.toISOString());
  });

  test('the only day is always the one picked for signing, before, during and after', () => {
    const only = [{ startAt: f.startAt, endAt: f.endAt }];
    for (const now of ['2026-10-01T00:00:00Z', '2026-10-05T07:00:00Z', '2026-10-20T00:00:00Z']) {
      assert.equal(pickSigningDay(only, Date.parse(now)), only[0]);
    }
  });
});