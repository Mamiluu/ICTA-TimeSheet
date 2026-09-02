// Copyright (c) 2026 Asya Hafidh <msanifuasiya@gmail.com>. All Rights Reserved.
// Proprietary and confidential. See LICENSE in the repository root.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { isValidTimeZone, formatInZone, formatEventWhen } from '../src/lib/timezone.js';

describe('isValidTimeZone', () => {
  test('accepts a real IANA zone', () => {
    assert.equal(isValidTimeZone('Africa/Nairobi'), true);
    assert.equal(isValidTimeZone('UTC'), true);
  });

  test('rejects a made-up zone name', () => {
    assert.equal(isValidTimeZone('Not/AZone'), false);
  });

  test('rejects non-string / empty input', () => {
    assert.equal(isValidTimeZone(''), false);
    assert.equal(isValidTimeZone(null), false);
    assert.equal(isValidTimeZone(undefined), false);
  });
});

describe('formatEventWhen', () => {
  test('renders a same-day event as a single compact range', () => {
    const start = new Date('2026-03-05T11:00:00Z'); // 14:00 in Nairobi (UTC+3)
    const end = new Date('2026-03-05T14:00:00Z'); // 17:00 in Nairobi
    const text = formatEventWhen(start, end, 'Africa/Nairobi');
    // en-GB's numeric hour is a 24h clock (no AM/PM), and the zone
    // abbreviation itself is CLDR-data-dependent ("EAT" vs a "GMT+3"
    // numeric fallback per zoneAbbreviation's own doc comment) -- assert
    // on the structure and the actual wall-clock time, not on which
    // abbreviation this particular Node build's ICU data happens to know.
    assert.match(text, /^Thu 5 Mar 2026 · 14:00 – 17:00 (EAT|GMT\+3)$/);
  });

  test('renders a multi-day event naming both dates', () => {
    const start = new Date('2026-03-05T06:00:00Z');
    const end = new Date('2026-03-07T06:00:00Z');
    const text = formatEventWhen(start, end, 'Africa/Nairobi');
    assert.match(text, /Thu 5 Mar,/);
    assert.match(text, /Sat 7 Mar,/);
  });

  test('a late-night event that crosses local midnight is judged by local calendar day, not UTC', () => {
    // 23:00-01:00 EAT (UTC+3) spans two UTC calendar days but is a single
    // local evening -- formatEventWhen must key off the event's own zone,
    // not the raw UTC date, or this would wrongly render as two days.
    const start = new Date('2026-03-05T20:00:00Z'); // 23:00 in Nairobi, 5 Mar
    const end = new Date('2026-03-05T22:00:00Z'); // 01:00 in Nairobi, 6 Mar
    const text = formatEventWhen(start, end, 'Africa/Nairobi');
    // Must render as spanning 5 Mar -> 6 Mar in Nairobi's own calendar,
    // never as a same-UTC-day event or a same-Nairobi-day event.
    assert.match(text, /^Thu 5 Mar, 23:00 – Fri 6 Mar, 1:00 (EAT|GMT\+3)$/);
  });
});

describe('formatInZone', () => {
  test('the same instant reads differently in different zones', () => {
    const instant = new Date('2026-06-01T12:00:00Z');
    const nairobi = formatInZone(instant, 'Africa/Nairobi', { hour: 'numeric', minute: '2-digit' });
    const utc = formatInZone(instant, 'UTC', { hour: 'numeric', minute: '2-digit' });
    assert.notEqual(nairobi, utc);
  });
});
