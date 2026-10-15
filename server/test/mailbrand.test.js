// Copyright (c) 2026 Asya Hafidh <msanifuasiya@gmail.com>. All Rights Reserved.
// Proprietary and confidential. See LICENSE in the repository root.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sendActivationEmail, sendPasswordResetEmail } from '../src/lib/mailer.js';
import { brandFromOrg, emailBrand } from '../src/lib/brand.js';

// Captures what would be sent to Brevo instead of sending it.
async function capture(run) {
  const real = globalThis.fetch;
  process.env.BREVO_API_KEY = 'test-key';
  process.env.PUBLIC_APP_URL = 'https://attend.example.org';
  let sent = null;
  globalThis.fetch = async (url, init) => {
    sent = JSON.parse(init.body);
    return { ok: true, text: async () => '' };
  };
  try {
    await run();
  } finally {
    globalThis.fetch = real;
  }
  return sent;
}

const kplc = emailBrand(brandFromOrg({ slug: 'kplc', name: 'Kenya Power', accentColor: '#006600', logoMime: null, logoVersion: 0 }));

test("an organisation's email carries its own name, logo and accent colour", async () => {
  const sent = await capture(() => sendActivationEmail('a@b.ke', 'https://x/activate', 'Nairobi', null, null, kplc));
  assert.equal(sent.sender.name, 'Kenya Power — Event Attendance');
  assert.match(sent.subject, /Kenya Power/);
  assert.match(sent.htmlContent, /https:\/\/attend\.example\.org\/api\/org-logo\/kplc/);
  assert.match(sent.htmlContent, /background:#006600/);
  assert.doesNotMatch(sent.htmlContent, /ICT Authority|#c8102e/);
});

test('with no organisation in hand the email keeps the platform default look', async () => {
  const sent = await capture(() => sendPasswordResetEmail('a@b.ke', 'https://x/reset'));
  assert.match(sent.subject, /ICT Authority/);
  assert.match(sent.htmlContent, /#c8102e/);
  assert.match(sent.htmlContent, /icta_logo_cropped\.png/);
});

test('an organisation name is escaped inside the message, not trusted as markup', async () => {
  const evil = emailBrand(brandFromOrg({ slug: 'bad', name: 'Evil <script>alert(1)</script> Ltd', logoMime: null, logoVersion: 0 }));
  const sent = await capture(() => sendActivationEmail('a@b.ke', 'https://x/activate', null, null, 'Evil <b>Ltd</b>', evil));
  assert.doesNotMatch(sent.htmlContent, /<script>alert/);
  assert.doesNotMatch(sent.htmlContent, /<b>Ltd<\/b>/);
  assert.match(sent.htmlContent, /&lt;script&gt;/);
});
