// Copyright (c) 2026 Asya Hafidh <msanifuasiya@gmail.com>. All Rights Reserved.
// Proprietary and confidential. See LICENSE in the repository root.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { orgSlug, isValidOrgSlug, cleanOrgName, cleanShortName } from '../src/lib/organisations.js';

test('slug is lower-case, dashed and at most 40 characters', () => {
  assert.equal(orgSlug('ICT Authority'), 'ict-authority');
  assert.equal(orgSlug('Kenya Power & Lighting Co.'), 'kenya-power-and-lighting-co');
  assert.ok(orgSlug('A very long organisation name that keeps on going and going').length <= 40);
  assert.doesNotMatch(orgSlug('A very long organisation name that keeps on going and going'), /-$/);
});

test('a usable slug has no double dashes and is not reserved', () => {
  assert.equal(isValidOrgSlug('icta'), true);
  assert.equal(isValidOrgSlug('kenya-power'), true);
  assert.equal(isValidOrgSlug('a'), false);
  assert.equal(isValidOrgSlug('-icta'), false);
  assert.equal(isValidOrgSlug('ic--ta'), false);
  assert.equal(isValidOrgSlug('IC TA'), false);
  assert.equal(isValidOrgSlug('owner'), false);
  assert.equal(isValidOrgSlug('www'), false);
});

test('names are trimmed and single-spaced, and must be a sensible length', () => {
  assert.equal(cleanOrgName('  Kenya   Power '), 'Kenya Power');
  assert.equal(cleanOrgName('ab'), null);
  assert.equal(cleanOrgName('!!!'), null);
  assert.equal(cleanOrgName('x'.repeat(101)), null);
  assert.equal(cleanOrgName(undefined), null);
});

test('short name is optional and capped', () => {
  assert.equal(cleanShortName(''), null);
  assert.equal(cleanShortName(' KPLC '), 'KPLC');
  assert.equal(cleanShortName('x'.repeat(40)).length, 20);
});
