// Copyright (c) 2026 Asya Hafidh <msanifuasiya@gmail.com>. All Rights Reserved.
// Proprietary and confidential. See LICENSE in the repository root.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { normalizePhone, normalizeEmail, isValidEmailShape, isValidMeetingLink, slugify, eventSlugId } from '../src/lib/normalize.js';

describe('normalizePhone', () => {
  test('accepts a local 07... number and rewrites it to +254', () => {
    assert.equal(normalizePhone('0712345678'), '+254712345678');
  });

  test('accepts an already-international +254 number unchanged', () => {
    assert.equal(normalizePhone('+254712345678'), '+254712345678');
  });

  test('accepts a bare 254... number and adds the leading +', () => {
    assert.equal(normalizePhone('254712345678'), '+254712345678');
  });

  test('strips spaces and hyphens before matching', () => {
    assert.equal(normalizePhone('0712 345-678'), '+254712345678');
  });

  test('two attendees typing the same number in different shapes normalize identically', () => {
    const a = normalizePhone('0712345678');
    const b = normalizePhone('+254 712-345-678');
    assert.equal(a, b);
  });

  test('rejects a number of the wrong length', () => {
    assert.equal(normalizePhone('071234567'), null);
    assert.equal(normalizePhone('07123456789'), null);
  });

  test('rejects garbage input', () => {
    assert.equal(normalizePhone('not a phone'), null);
    assert.equal(normalizePhone(''), null);
    assert.equal(normalizePhone(undefined), null);
  });
});

describe('normalizeEmail', () => {
  test('lowercases and trims', () => {
    assert.equal(normalizeEmail('  Jane.Doe@Example.COM  '), 'jane.doe@example.com');
  });

  test('empty input normalizes to null, not an empty string', () => {
    assert.equal(normalizeEmail(''), null);
    assert.equal(normalizeEmail('   '), null);
    assert.equal(normalizeEmail(undefined), null);
  });
});

describe('isValidEmailShape', () => {
  test('accepts a plausible address', () => {
    assert.equal(isValidEmailShape('jane@example.com'), true);
  });

  test('rejects a value with no @ or no dot', () => {
    assert.equal(isValidEmailShape('not-an-email'), false);
    assert.equal(isValidEmailShape('jane@example'), false);
  });

  test('rejects markup-looking values so they never render unescaped in an admin table', () => {
    assert.equal(isValidEmailShape('<script>@x.com'), false);
    assert.equal(isValidEmailShape('a"b@x.com'), false);
  });

  test('rejects an over-length address', () => {
    const long = 'a'.repeat(250) + '@x.com';
    assert.equal(isValidEmailShape(long), false);
  });

  test('rejects non-string input without throwing', () => {
    assert.equal(isValidEmailShape(null), false);
    assert.equal(isValidEmailShape(42), false);
  });
});

describe('isValidMeetingLink', () => {
  test('accepts http and https URLs', () => {
    assert.equal(isValidMeetingLink('https://zoom.us/j/123'), true);
    assert.equal(isValidMeetingLink('http://example.com'), true);
  });

  test('rejects non-http(s) schemes', () => {
    assert.equal(isValidMeetingLink('javascript:alert(1)'), false);
    assert.equal(isValidMeetingLink('ftp://example.com'), false);
  });

  test('rejects unparseable or oversized input', () => {
    assert.equal(isValidMeetingLink('not a url'), false);
    assert.equal(isValidMeetingLink('https://x.com/' + 'a'.repeat(2000)), false);
  });
});

describe('slugify / eventSlugId', () => {
  test('lowercases, collapses non-alphanumerics to single hyphens, trims edges', () => {
    assert.equal(slugify('Huduma Whitebox — Sensitization!!'), 'huduma-whitebox-sensitization');
  });

  test('falls back to "event" for input with nothing slug-worthy', () => {
    assert.equal(slugify('###'), 'event');
  });

  test('caps length at 40 characters', () => {
    const s = slugify('a'.repeat(100));
    assert.ok(s.length <= 40);
  });

  test('eventSlugId appends a 14-digit timestamp to the slug', () => {
    const id = eventSlugId('Budget Review');
    const [slugPart, stamp] = id.split(/-(\d{14})$/).filter(Boolean);
    assert.equal(slugPart, 'budget-review');
    assert.match(stamp, /^\d{14}$/);
  });
});
