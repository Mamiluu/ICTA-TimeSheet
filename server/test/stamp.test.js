// Copyright (c) 2026 Asya Hafidh <msanifuasiya@gmail.com>. All Rights Reserved.
// Proprietary and confidential. See LICENSE in the repository root.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { doorStampDataUri, clockInZone } from '../src/lib/stamp.js';
import { isBlankSignature } from '../src/routes/public.js';

test('door stamp is an svg data uri that passes the signature-presence check', () => {
  const uri = doorStampDataUri('09:12');
  assert.match(uri, /^data:image\/svg\+xml;base64,/);
  assert.equal(isBlankSignature(uri), false);
  assert.match(Buffer.from(uri.split(',')[1], 'base64').toString(), /09:12/);
});

test('door stamp strips anything that is not a clock time', () => {
  const svg = Buffer.from(doorStampDataUri('<script>1</script>').split(',')[1], 'base64').toString();
  assert.doesNotMatch(svg, /script/);
});

test('clockInZone uses the event time zone', () => {
  assert.equal(clockInZone(new Date('2026-10-05T06:30:00Z'), 'Africa/Nairobi'), '09:30');
});
