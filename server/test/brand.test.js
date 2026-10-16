// Copyright (c) 2026 Asya Hafidh <msanifuasiya@gmail.com>. All Rights Reserved.
// Proprietary and confidential. See LICENSE in the repository root.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHex, contrastRatio, checkAccent, darken, wash, toHex } from '../src/lib/color.js';
import { detectImage } from '../src/lib/imageSniff.js';
import { cleanBranding } from '../src/lib/brandInput.js';
import { brandFromOrg, monogram, monogramSvg, emailBrand } from '../src/lib/brand.js';

test('colours: parse, normalise and reject', () => {
  assert.deepEqual(parseHex('#c8102e'), { r: 200, g: 16, b: 46 });
  assert.deepEqual(parseHex('C8102E'), { r: 200, g: 16, b: 46 });
  assert.equal(parseHex('#fff'), null);
  assert.equal(parseHex('red'), null);
  assert.equal(parseHex(undefined), null);
  assert.equal(toHex({ r: 200, g: 16, b: 46 }), '#c8102e');
});

test('contrast against white: black is 21, white is 1, and the current red passes', () => {
  assert.equal(Math.round(contrastRatio('#000000', '#ffffff')), 21);
  assert.equal(Math.round(contrastRatio('#ffffff', '#ffffff')), 1);
  assert.ok(contrastRatio('#c8102e', '#ffffff') >= 4.5);
});

test('an accent that is too light is refused, a dark one is accepted and normalised', () => {
  assert.match(checkAccent('#ffd700').error, /too light/);
  assert.match(checkAccent('blue').error, /six hexadecimal/);
  assert.deepEqual(checkAccent('#006600'), { hex: '#006600' });
  assert.deepEqual(checkAccent('C8102E'), { hex: '#c8102e' });
});

test('darker and washed variants stay valid colours', () => {
  assert.match(darken('#c8102e', 0.2), /^#[0-9a-f]{6}$/);
  assert.ok(contrastRatio(darken('#c8102e', 0.2), '#ffffff') > contrastRatio('#c8102e', '#ffffff'));
  assert.match(wash('#c8102e', 0.92), /^#[0-9a-f]{6}$/);
  assert.ok(parseHex(wash('#c8102e', 0.92)).r > 240);
});

test('an uploaded logo is judged by its bytes, and SVG is not accepted', () => {
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(20)]);
  const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(20)]);
  const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(10)]);
  assert.equal(detectImage(png), 'image/png');
  assert.equal(detectImage(jpg), 'image/jpeg');
  assert.equal(detectImage(webp), 'image/webp');
  assert.equal(detectImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')), null);
  assert.equal(detectImage(Buffer.from('GIF89a' + 'x'.repeat(20))), null);
  assert.equal(detectImage(Buffer.alloc(3)), null);
  assert.equal(detectImage('not a buffer'), null);
});

test('the default organisation looks the way it always has, with nothing entered', () => {
  const b = brandFromOrg({ slug: 'icta', name: 'ICT Authority', shortName: 'ICTA' });
  assert.equal(b.orgName, 'ICT Authority');
  assert.equal(b.logoUrl, '/assets/icta_logo_cropped.png');
  assert.equal(b.accent, '#c8102e');
  assert.ok(b.addressLines.length > 0);
});

test('another organisation gets its own name, letterhead, accent and a generated logo', () => {
  const b = brandFromOrg({
    slug: 'kplc',
    name: 'Kenya Power',
    displayName: 'Kenya Power and Lighting',
    address: 'Stima Plaza\nKolobot Road\n',
    phone: '+254 20 1',
    website: 'https://kplc.co.ke',
    accentColor: '#006600',
    logoMime: null,
    logoVersion: 0
  });
  assert.equal(b.orgName, 'Kenya Power and Lighting');
  assert.deepEqual(b.addressLines, ['Stima Plaza', 'Kolobot Road']);
  assert.equal(b.accent, '#006600');
  assert.equal(b.logoUrl, '/api/org-logo/kplc');
  assert.equal(
    brandFromOrg({ slug: 'kplc', name: 'Kenya Power', logoMime: 'image/png', logoVersion: 3 }).logoUrl,
    '/api/org-logo/kplc?v=3'
  );
});

test("another organisation never borrows ICT Authority's address or contact details", () => {
  const b = brandFromOrg({ slug: 'kplc', name: 'Kenya Power' });
  assert.deepEqual(b.addressLines, []);
  assert.equal(b.phone, '');
  assert.equal(b.website, '');
  assert.equal(b.orgName, 'Kenya Power');
});

test('the generated logo uses initials and cannot carry markup', () => {
  assert.equal(monogram('Kenya Power'), 'KP');
  assert.equal(monogram('ICT Authority'), 'IA');
  assert.equal(monogram('Safaricom'), 'SA');
  const svg = monogramSvg('<script>alert(1)</script> Co', 'javascript:evil');
  assert.doesNotMatch(svg, /<script|javascript/);
  assert.match(svg, /fill="#c8102e"/);
});

test('emails get the logo as a full web address', () => {
  process.env.PUBLIC_APP_URL = 'https://attend.example.org/';
  assert.equal(emailBrand({ logoUrl: '/api/org-logo/kplc' }).logoUrl, 'https://attend.example.org/api/org-logo/kplc');
  assert.equal(emailBrand({ logoUrl: 'https://cdn.example/x.png' }).logoUrl, 'https://cdn.example/x.png');
});

test('branding input: empty fields mean use the default', () => {
  assert.deepEqual(cleanBranding({}).value, {
    displayName: null,
    address: null,
    phone: null,
    website: null,
    footerLine: null,
    accentColor: null
  });
});

test('branding input: a full, valid form is kept and tidied', () => {
  const r = cleanBranding({
    displayName: '  Kenya   Power ',
    address: 'Stima Plaza\r\n\r\n Kolobot Road ',
    phone: '+254 20 3201000',
    website: 'https://www.kplc.co.ke',
    accentColor: '006600'
  });
  assert.deepEqual(r.value, {
    displayName: 'Kenya Power',
    address: 'Stima Plaza\nKolobot Road',
    phone: '+254 20 3201000',
    website: 'https://www.kplc.co.ke',
    footerLine: null,
    accentColor: '#006600'
  });
});

test('branding input: refuses what it cannot print or trust', () => {
  assert.match(cleanBranding({ displayName: 'ab' }).error, /3 and 100/);
  assert.match(cleanBranding({ address: 'a\nb\nc\nd\ne' }).error, /four lines/);
  assert.match(cleanBranding({ address: 'x'.repeat(81) }).error, /80 characters/);
  assert.match(cleanBranding({ phone: 'call me' }).error, /phone/);
  assert.match(cleanBranding({ website: 'javascript:alert(1)' }).error, /http/);
  assert.match(cleanBranding({ website: 'https://a.com/<script>' }).error, /http/);
  assert.match(cleanBranding({ accentColor: '#ffff00' }).error, /too light/);
  assert.match(cleanBranding({ accentColor: 'nope' }).error, /six hexadecimal/);
});

test('the line at the foot of payment sheets: ICT Authority has its own, others only what they set', () => {
  assert.match(brandFromOrg(null).footerLine, /State Corporation/);
  assert.equal(brandFromOrg({ slug: 'kplc', name: 'Kenya Power' }).footerLine, '');
  assert.equal(brandFromOrg({ slug: 'kplc', name: 'Kenya Power', footerLine: 'Licensed by EPRA' }).footerLine, 'Licensed by EPRA');
  assert.equal(cleanBranding({ footerLine: '  Licensed   by EPRA ' }).value.footerLine, 'Licensed by EPRA');
  assert.ok(cleanBranding({ footerLine: 'x'.repeat(141) }).error);
});
