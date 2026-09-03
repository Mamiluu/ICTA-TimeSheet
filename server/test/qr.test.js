// Copyright (c) 2026 Asya Hafidh <msanifuasiya@gmail.com>. All Rights Reserved.
// Proprietary and confidential. See LICENSE in the repository root.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import QRCode from 'qrcode';

// Not re-testing the qrcode package's own QR-encoding correctness (a
// well-established, widely used library) -- this just confirms our actual
// call in admin.js's GET /events/:id/qr produces a real PNG in this
// runtime, since that route (DB-backed via findOwnEvent) isn't itself unit
// tested without a live database.
describe('QR code generation (GET /api/admin/events/:id/qr)', () => {
  test('produces a real PNG for a realistic sign-in URL', async () => {
    const png = await QRCode.toBuffer('https://example.onrender.com/index.html?event=budget-review-20260305090000', {
      width: 180,
      margin: 1
    });
    assert.ok(Buffer.isBuffer(png));
    // PNG magic bytes -- confirms this is genuinely a PNG, not e.g. an SVG
    // string or an error object serialized by mistake.
    assert.deepEqual(png.subarray(0, 8), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  });

  test('different URLs produce different images', async () => {
    const a = await QRCode.toBuffer('https://example.onrender.com/index.html?event=event-a', { width: 180, margin: 1 });
    const b = await QRCode.toBuffer('https://example.onrender.com/index.html?event=event-b', { width: 180, margin: 1 });
    assert.notEqual(a.toString('base64'), b.toString('base64'));
  });

  test('rejects data too long to fit in a QR code rather than hanging or crashing the process', async () => {
    const tooLong = 'https://example.onrender.com/index.html?event=' + 'a'.repeat(5000);
    await assert.rejects(() => QRCode.toBuffer(tooLong));
  });
});
