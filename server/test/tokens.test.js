// Copyright (c) 2026 Asya Hafidh <msanifuasiya@gmail.com>. All Rights Reserved.
// Proprietary and confidential. See LICENSE in the repository root.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomToken, hashToken, consumeToken } from '../src/lib/tokens.js';

describe('randomToken / hashToken', () => {
  test('two generated tokens are never equal', () => {
    assert.notEqual(randomToken(), randomToken());
  });

  test('hashing is deterministic', () => {
    assert.equal(hashToken('same-input'), hashToken('same-input'));
  });

  test('hashing never returns the raw input back (no accidental identity hash)', () => {
    const raw = randomToken();
    assert.notEqual(hashToken(raw), raw);
  });
});

// A minimal in-memory stand-in for the slice of Prisma's client that
// consumeToken actually uses, so its compare-and-set concurrency guarantee
// can be exercised without a real database. Mirrors the two calls
// consumeToken makes: a lookup by unique tokenHash, then a conditional
// bulk update gated on consumedAt still being null.
function fakeClient(initialTokens) {
  const rows = new Map(initialTokens.map((t) => [t.tokenHash, { ...t }]));
  return {
    authToken: {
      findUnique: async ({ where: { tokenHash } }) => {
        const row = rows.get(tokenHash);
        return row ? { ...row } : null;
      },
      updateMany: async ({ where, data }) => {
        const row = [...rows.values()].find((r) => r.id === where.id);
        if (!row || (where.consumedAt === null && row.consumedAt !== null)) {
          return { count: 0 };
        }
        Object.assign(row, data);
        return { count: 1 };
      }
    },
    _rows: rows
  };
}

describe('consumeToken', () => {
  test('a fresh, unexpired token of the right type consumes successfully', async () => {
    const raw = 'raw-activation-token';
    const client = fakeClient([
      { id: 't1', userId: 'u1', type: 'ACTIVATION', tokenHash: hashToken(raw), expiresAt: new Date(Date.now() + 60_000), consumedAt: null }
    ]);
    const result = await consumeToken(raw, 'ACTIVATION', client);
    assert.deepEqual(result, { ok: true, userId: 'u1' });
  });

  test('an unknown token is rejected as INVALID_TOKEN', async () => {
    const client = fakeClient([]);
    const result = await consumeToken('never-issued', 'ACTIVATION', client);
    assert.deepEqual(result, { ok: false, error: 'INVALID_TOKEN' });
  });

  test('a token of the wrong type is rejected as INVALID_TOKEN', async () => {
    const raw = 'raw-reset-token';
    const client = fakeClient([
      {
        id: 't1',
        userId: 'u1',
        type: 'PASSWORD_RESET',
        tokenHash: hashToken(raw),
        expiresAt: new Date(Date.now() + 60_000),
        consumedAt: null
      }
    ]);
    const result = await consumeToken(raw, 'ACTIVATION', client);
    assert.deepEqual(result, { ok: false, error: 'INVALID_TOKEN' });
  });

  test('an expired token is rejected as EXPIRED_TOKEN', async () => {
    const raw = 'raw-expired-token';
    const client = fakeClient([
      { id: 't1', userId: 'u1', type: 'ACTIVATION', tokenHash: hashToken(raw), expiresAt: new Date(Date.now() - 1000), consumedAt: null }
    ]);
    const result = await consumeToken(raw, 'ACTIVATION', client);
    assert.deepEqual(result, { ok: false, error: 'EXPIRED_TOKEN' });
  });

  test('a second use of an already-consumed token is rejected as ALREADY_USED', async () => {
    const raw = 'raw-once-token';
    const client = fakeClient([
      { id: 't1', userId: 'u1', type: 'ACTIVATION', tokenHash: hashToken(raw), expiresAt: new Date(Date.now() + 60_000), consumedAt: null }
    ]);
    const first = await consumeToken(raw, 'ACTIVATION', client);
    const second = await consumeToken(raw, 'ACTIVATION', client);
    assert.equal(first.ok, true);
    assert.deepEqual(second, { ok: false, error: 'ALREADY_USED' });
  });

  test('two concurrent consumptions of the same token: exactly one wins', async () => {
    const raw = 'raw-racing-token';
    const client = fakeClient([
      { id: 't1', userId: 'u1', type: 'ACTIVATION', tokenHash: hashToken(raw), expiresAt: new Date(Date.now() + 60_000), consumedAt: null }
    ]);
    const [a, b] = await Promise.all([consumeToken(raw, 'ACTIVATION', client), consumeToken(raw, 'ACTIVATION', client)]);
    const outcomes = [a, b];
    const winners = outcomes.filter((r) => r.ok);
    const losers = outcomes.filter((r) => !r.ok);
    assert.equal(winners.length, 1, 'exactly one of the two racing calls succeeds');
    assert.equal(losers.length, 1);
    assert.equal(losers[0].error, 'ALREADY_USED');
  });
});
