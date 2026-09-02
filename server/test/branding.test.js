// Copyright (c) 2026 Asya Hafidh <msanifuasiya@gmail.com>. All Rights Reserved.
// Proprietary and confidential. See LICENSE in the repository root.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

// BRANDING is computed once at module load from process.env, so each
// variant is exercised in its own child process (via node:test's
// isolation is per-file, not per-test) -- simplest correct way to assert
// on both "unset" and "overridden" without reaching for jest-style module
// reset machinery this project doesn't otherwise use.
describe('BRANDING defaults', () => {
  test("every field defaults to this pilot's real current values when no env vars are set", async () => {
    const { BRANDING } = await import('../src/lib/branding.js');
    assert.equal(BRANDING.orgName, 'ICT Authority');
    assert.equal(BRANDING.productName, 'Event Attendance');
    assert.equal(BRANDING.phone, '+254 20 2089061');
    assert.equal(BRANDING.website, 'https://www.icta.go.ke');
    assert.deepEqual(BRANDING.addressLines, ['Teleposta Towers 12th Floor, Kenyatta Ave', 'PO Box 27150 - 00100 Nairobi Kenya']);
  });
});

describe('BRANDING overrides', () => {
  test('env vars override the defaults, and address lines split/trim/drop blanks', async () => {
    process.env.BRAND_ORG_NAME = 'County Assembly';
    process.env.BRAND_ADDRESS_LINES = '  Line One  \n\nLine Two';
    try {
      // A fresh dynamic import with a cache-busting query string reads
      // BRANDING's env-derived values again under the env set just above --
      // a plain re-import would hit Node's module cache and silently
      // return the same object computed on first import.
      const { BRANDING } = await import(`../src/lib/branding.js?t=${Date.now()}`);
      assert.equal(BRANDING.orgName, 'County Assembly');
      assert.deepEqual(BRANDING.addressLines, ['Line One', 'Line Two']);
    } finally {
      delete process.env.BRAND_ORG_NAME;
      delete process.env.BRAND_ADDRESS_LINES;
    }
  });
});
