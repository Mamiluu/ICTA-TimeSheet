// Copyright (c) 2026 Asya Hafidh <msanifuasiya@gmail.com>. All Rights Reserved.
// Proprietary and confidential. See LICENSE in the repository root.

import crypto from 'node:crypto';
import { prisma } from './prisma.js';
import { ACTIVATION_TOKEN_TTL_MS, RESET_TOKEN_TTL_MS } from './constants.js';

function randomToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function hashToken(rawToken) {
  return crypto.createHash('sha256').update(rawToken).digest('hex');
}

// The raw token only ever exists in the emailed link -- the DB stores just
// its hash, so a leaked/backed-up database never exposes usable tokens.
export async function issueToken(userId, type) {
  const raw = randomToken();
  const ttl = type === 'ACTIVATION' ? ACTIVATION_TOKEN_TTL_MS : RESET_TOKEN_TTL_MS;
  await prisma.authToken.create({
    data: {
      userId,
      type,
      tokenHash: hashToken(raw),
      expiresAt: new Date(Date.now() + ttl)
    }
  });
  return raw;
}

// Atomically consumes a token: the WHERE clause requires consumedAt IS NULL,
// so of two concurrent requests racing on the same token, only one UPDATE
// can ever match a row -- the other affects zero rows and is treated as
// "already used." This is the compare-and-set that makes activation/reset
// links genuinely single-use under concurrency, not just by convention.
export async function consumeToken(rawToken, type) {
  const tokenHash = hashToken(rawToken);
  const token = await prisma.authToken.findUnique({ where: { tokenHash } });
  if (!token || token.type !== type) return { ok: false, error: 'INVALID_TOKEN' };
  if (token.expiresAt < new Date()) return { ok: false, error: 'EXPIRED_TOKEN' };
  if (token.consumedAt) return { ok: false, error: 'ALREADY_USED' };

  const result = await prisma.authToken.updateMany({
    where: { id: token.id, consumedAt: null },
    data: { consumedAt: new Date() }
  });
  if (result.count === 0) return { ok: false, error: 'ALREADY_USED' };

  return { ok: true, userId: token.userId };
}
