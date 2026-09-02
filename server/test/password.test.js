// Copyright (c) 2026 Asya Hafidh <msanifuasiya@gmail.com>. All Rights Reserved.
// Proprietary and confidential. See LICENSE in the repository root.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword, isPasswordAcceptable } from '../src/lib/password.js';

describe('isPasswordAcceptable', () => {
  test('rejects anything shorter than 10 characters', () => {
    assert.equal(isPasswordAcceptable('short1234'), false);
  });

  test('accepts a 10-character password with no composition rules', () => {
    assert.equal(isPasswordAcceptable('aaaaaaaaaa'), true);
  });

  test('rejects an absurdly long password', () => {
    assert.equal(isPasswordAcceptable('a'.repeat(201)), false);
  });

  test('rejects non-string input', () => {
    assert.equal(isPasswordAcceptable(12345678901), false);
    assert.equal(isPasswordAcceptable(undefined), false);
  });
});

describe('hashPassword / verifyPassword', () => {
  test('a hashed password verifies against its own plaintext', async () => {
    const hash = await hashPassword('correct horse battery staple');
    assert.equal(await verifyPassword('correct horse battery staple', hash), true);
  });

  test('the wrong plaintext fails verification', async () => {
    const hash = await hashPassword('correct horse battery staple');
    assert.equal(await verifyPassword('wrong password entirely', hash), false);
  });

  test('two hashes of the same password are salted differently', async () => {
    const a = await hashPassword('same password');
    const b = await hashPassword('same password');
    assert.notEqual(a, b);
  });

  test('verifying against a missing hash (e.g. a PENDING account) resolves false, never throws', async () => {
    assert.equal(await verifyPassword('anything', null), false);
    assert.equal(await verifyPassword('anything', undefined), false);
  });
});
