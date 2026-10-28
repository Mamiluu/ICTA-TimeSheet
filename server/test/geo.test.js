// Copyright (c) 2026 Asya Hafidh <msanifuasiya@gmail.com>. All Rights Reserved.
// Proprietary and confidential. See LICENSE in the repository root.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { distanceM, geoStatusFor, validPoint } from '../src/lib/geo.js';

const venue = { geoCheck: true, locationType: 'PHYSICAL', latitude: -4.0435, longitude: 39.6682, geoRadiusM: 300 };
// 0.001 degrees of latitude is about 111 metres.
const at = (northM) => ({ lat: venue.latitude + northM / 111320, lng: venue.longitude });

test('distance between two points is close to the real figure', () => {
  assert.ok(Math.abs(distanceM(0, 0, 0.001, 0) - 111) <= 2);
  assert.equal(distanceM(-4.0435, 39.6682, -4.0435, 39.6682), 0);
});

test('a signer is at the venue, near, far, or has not shared a location', () => {
  assert.equal(geoStatusFor(venue, at(50)).status, 'AT_VENUE');
  assert.equal(geoStatusFor(venue, at(700)).status, 'NEAR');
  assert.equal(geoStatusFor(venue, at(5000)).status, 'FAR');
  assert.deepEqual(geoStatusFor(venue, null), { status: 'NOT_SHARED', distanceM: null });
  assert.deepEqual(geoStatusFor(venue, { lat: 'x', lng: 1 }), { status: 'NOT_SHARED', distanceM: null });
});

test('a poor fix gets some benefit of the doubt, but only a little', () => {
  assert.equal(geoStatusFor(venue, { ...at(420), accuracy: 150 }).status, 'AT_VENUE');
  assert.equal(geoStatusFor(venue, { ...at(420), accuracy: 5000 }).status, 'AT_VENUE', 'accuracy is capped at 150 m');
  assert.equal(
    geoStatusFor(venue, { ...at(600), accuracy: 5000 }).status,
    'NEAR',
    'a huge claimed error cannot make a distant point count'
  );
});

test('events that do not check location store nothing', () => {
  assert.equal(geoStatusFor({ ...venue, geoCheck: false }, at(10)), null);
  assert.equal(geoStatusFor({ ...venue, locationType: 'VIRTUAL' }, at(10)), null);
  assert.equal(geoStatusFor({ ...venue, latitude: null }, at(10)), null);
});

test('a pin has to be in Kenya', () => {
  assert.equal(validPoint(-1.29, 36.82), true);
  assert.equal(validPoint(51.5, -0.12), false);
  assert.equal(validPoint(NaN, 36), false);
});
