// Copyright (c) 2026 Asya Hafidh <msanifuasiya@gmail.com>. All Rights Reserved.
// Proprietary and confidential. See LICENSE in the repository root.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  newSecret,
  codeFor,
  currentCode,
  currentShortCode,
  shortCodeIsValid,
  codeIsValid,
  makeProof,
  proofIsValid,
  liveCheck,
  stepOf,
  STEP_MS,
  KEY_GRACE_STEPS,
  PROOF_TTL_MS
} from '../src/lib/liveCode.js';

const secret = newSecret();
const ev = { id: 'evt-1', liveCode: true, liveSecret: secret };
const t0 = Date.UTC(2026, 9, 29, 6, 0, 30);

test('the code of this minute is accepted', () => {
  assert.equal(codeIsValid(secret, ev.id, currentCode(secret, ev.id, t0), t0), true);
});

test('a code stops working a few minutes after it was made', () => {
  const code = currentCode(secret, ev.id, t0);
  assert.equal(codeIsValid(secret, ev.id, code, t0 + KEY_GRACE_STEPS * STEP_MS), true);
  assert.equal(codeIsValid(secret, ev.id, code, t0 + (KEY_GRACE_STEPS + 1) * STEP_MS), false);
});

test('a code from the future, another event or another secret is refused', () => {
  assert.equal(codeIsValid(secret, ev.id, codeFor(secret, ev.id, stepOf(t0) + 1), t0), false);
  assert.equal(codeIsValid(secret, 'evt-2', currentCode(secret, ev.id, t0), t0), false);
  assert.equal(codeIsValid(newSecret(), ev.id, currentCode(secret, ev.id, t0), t0), false);
  assert.equal(codeIsValid(secret, ev.id, '', t0), false);
  assert.equal(codeIsValid(secret, ev.id, undefined, t0), false);
  assert.equal(codeIsValid(secret, ev.id, 'x'.repeat(16), t0), false);
});

test('a proof lasts longer than a code, and only for its own event', () => {
  const { proof, expiresAt } = makeProof(secret, ev.id, t0);
  assert.equal(expiresAt, t0 + PROOF_TTL_MS);
  assert.equal(proofIsValid(secret, ev.id, proof, t0 + 10 * STEP_MS), true);
  assert.equal(proofIsValid(secret, ev.id, proof, expiresAt + 1), false);
  assert.equal(proofIsValid(secret, 'evt-2', proof, t0), false);
  assert.equal(
    proofIsValid(
      secret,
      ev.id,
      proof.replace(/.$/, (c) => (c === 'a' ? 'b' : 'a')),
      t0
    ),
    false
  );
});

test('a proof cannot be stretched by editing its expiry', () => {
  const { proof } = makeProof(secret, ev.id, t0);
  const sig = proof.slice(proof.indexOf('.') + 1);
  assert.equal(proofIsValid(secret, ev.id, `${t0 + 3 * PROOF_TTL_MS}.${sig}`, t0), false);
  assert.equal(proofIsValid(secret, ev.id, `${t0 + 5000}.${sig}`, t0), false);
});

test('liveCheck asks for nothing when the event does not use the code', () => {
  assert.deepEqual(liveCheck({ id: 'e', liveCode: false }, {}), { required: false, ok: true, via: null });
  assert.equal(liveCheck(null, {}).required, false);
});

test('liveCheck tells a missing code from an expired one', () => {
  assert.equal(liveCheck(ev, {}, t0).state, 'MISSING');
  const old = currentCode(secret, ev.id, t0);
  assert.equal(liveCheck(ev, { key: old }, t0 + 10 * STEP_MS).state, 'EXPIRED');
  assert.equal(liveCheck(ev, { key: old }, t0).via, 'key');
  assert.equal(liveCheck(ev, { proof: makeProof(secret, ev.id, t0).proof }, t0 + STEP_MS * 10).via, 'proof');
});
test('the typed code is six digits, accepted for a few minutes, and never confused with another event', () => {
  const code = currentShortCode(secret, ev.id, t0);
  assert.match(code, /^\d{6}$/);
  assert.equal(shortCodeIsValid(secret, ev.id, code, t0), true);
  assert.equal(shortCodeIsValid(secret, ev.id, `${code.slice(0, 3)} ${code.slice(3)}`, t0), true);
  assert.equal(shortCodeIsValid(secret, ev.id, code, t0 + KEY_GRACE_STEPS * STEP_MS), true);
  assert.equal(shortCodeIsValid(secret, ev.id, code, t0 + (KEY_GRACE_STEPS + 1) * STEP_MS), false);
  assert.equal(shortCodeIsValid(secret, 'evt-2', code, t0), false);
  assert.equal(shortCodeIsValid(secret, ev.id, '12345', t0), false);
  assert.equal(shortCodeIsValid(secret, ev.id, '', t0), false);
  assert.equal(shortCodeIsValid(secret, ev.id, undefined, t0), false);
});

test('typed codes are spread out, not one repeated value', () => {
  const seen = new Set();
  for (let i = 0; i < 50; i++) seen.add(currentShortCode(secret, ev.id, t0 + i * STEP_MS));
  assert.ok(seen.size > 45);
});
