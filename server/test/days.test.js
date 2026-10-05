// Copyright (c) 2026 Asya Hafidh <msanifuasiya@gmail.com>. All Rights Reserved.
// Proprietary and confidential. See LICENSE in the repository root.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { dayIsOpen, dayOpensAt, dayClosesAt } from '../src/lib/days.js';
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
