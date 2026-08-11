// Copyright (c) 2026 Asya Hafidh <msanifuasiya@gmail.com>. All Rights Reserved.
// Proprietary and confidential. See LICENSE in the repository root.

import { Router } from 'express';
import { prisma } from '../lib/prisma.js';
import { hashPassword, verifyPassword, isPasswordAcceptable } from '../lib/password.js';
import { issueToken, consumeToken } from '../lib/tokens.js';
import { createSession, destroySession, destroyAllSessionsForUser } from '../lib/session.js';
import { sendPasswordResetEmail } from '../lib/mailer.js';
import { writeAudit } from '../lib/audit.js';
import { loginLimiter, forgotPasswordLimiter } from '../middleware/rateLimit.js';
import { ah } from '../lib/asyncHandler.js';

export const authRouter = Router();

authRouter.post('/login', loginLimiter, ah(async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  if (!email || !password) return res.status(400).json({ ok: false, error: 'MISSING_FIELDS' });

  const user = await prisma.user.findUnique({ where: { email } });
  const validPassword = user && user.status === 'ACTIVE' && (await verifyPassword(password, user.passwordHash));

  if (!validPassword) {
    return res.status(401).json({ ok: false, error: 'INVALID_CREDENTIALS' });
  }

  await createSession(res, user.id, req);
  await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
  await writeAudit({ actorId: user.id, action: 'LOGIN', req });

  res.json({ ok: true, user: { id: user.id, email: user.email, role: user.role, county: user.county } });
}));

authRouter.post('/logout', ah(async (req, res) => {
  if (req.user) await writeAudit({ actorId: req.user.id, action: 'LOGOUT', req });
  await destroySession(req, res);
  res.json({ ok: true });
}));

authRouter.get('/me', (req, res) => {
  if (!req.user) return res.status(401).json({ ok: false, error: 'NOT_AUTHENTICATED' });
  const { id, email, role, county } = req.user;
  res.json({ ok: true, user: { id, email, role, county } });
});

authRouter.post('/activate/:token', ah(async (req, res) => {
  const password = String(req.body.password || '');
  if (!isPasswordAcceptable(password)) {
    return res.status(400).json({ ok: false, error: 'WEAK_PASSWORD', message: 'Password must be at least 10 characters.' });
  }
  const passwordHash = await hashPassword(password);

  // Consuming the token and activating the account must succeed or fail
  // together -- consumeToken's own update is single-use precisely so a
  // link can't be replayed, but that guarantee turns into a trap if the
  // token gets marked consumed and the *account* update then fails for an
  // unrelated reason (a DB hiccup, etc.): the link is permanently burned
  // and the account is stuck PENDING forever with no way to retry. Wrapping
  // both in one transaction means a failure here rolls the token back to
  // unconsumed too, so the same link just works on retry.
  let user;
  try {
    user = await prisma.$transaction(async (tx) => {
      const result = await consumeToken(req.params.token, 'ACTIVATION', tx);
      if (!result.ok) {
        const err = new Error(result.error);
        err.tokenError = result.error;
        throw err;
      }
      return tx.user.update({ where: { id: result.userId }, data: { passwordHash, status: 'ACTIVE' } });
    });
  } catch (err) {
    if (err.tokenError) return res.status(400).json({ ok: false, error: err.tokenError });
    throw err;
  }

  // Best-effort: an audit-log write is a record of what happened, not a
  // precondition for it -- a hiccup here should never leave someone stuck
  // unable to activate an account that in fact just activated fine.
  writeAudit({ actorId: user.id, action: 'ACCOUNT_ACTIVATED', req }).catch((err) => console.error('writeAudit failed', err));

  res.json({ ok: true });
}));

authRouter.post('/forgot-password', forgotPasswordLimiter, ah(async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  // Always the same response, whether or not the email matches an account
  // or the account is active -- prevents using this endpoint to enumerate
  // which emails have accounts in the system.
  if (email) {
    const user = await prisma.user.findUnique({ where: { email } });
    if (user && user.status === 'ACTIVE') {
      const raw = await issueToken(user.id, 'PASSWORD_RESET');
      const resetUrl = `${process.env.PUBLIC_APP_URL}/reset-password.html?token=${encodeURIComponent(raw)}`;
      sendPasswordResetEmail(user.email, resetUrl).catch((err) => console.error('sendPasswordResetEmail failed', err));
      writeAudit({ actorId: user.id, action: 'PASSWORD_RESET_REQUESTED', req }).catch(() => {});
    }
  }
  res.json({ ok: true, message: 'If that email has an account, a reset link is on its way.' });
}));

authRouter.post('/reset-password/:token', ah(async (req, res) => {
  const password = String(req.body.password || '');
  if (!isPasswordAcceptable(password)) {
    return res.status(400).json({ ok: false, error: 'WEAK_PASSWORD', message: 'Password must be at least 10 characters.' });
  }
  const passwordHash = await hashPassword(password);

  // Same reasoning as /activate above: consuming the token and updating
  // the password must succeed or fail together, or a downstream hiccup
  // burns an otherwise-good reset link and leaves the account stuck on its
  // old (possibly compromised) password with no way to retry.
  let userId;
  try {
    userId = await prisma.$transaction(async (tx) => {
      const result = await consumeToken(req.params.token, 'PASSWORD_RESET', tx);
      if (!result.ok) {
        const err = new Error(result.error);
        err.tokenError = result.error;
        throw err;
      }
      await tx.user.update({ where: { id: result.userId }, data: { passwordHash } });
      return result.userId;
    });
  } catch (err) {
    if (err.tokenError) return res.status(400).json({ ok: false, error: err.tokenError });
    throw err;
  }

  // A password reset invalidates every other session for this account --
  // if someone else's session was open (or the reset was because the
  // account was compromised), it dies here rather than riding out its TTL.
  await destroyAllSessionsForUser(userId);
  writeAudit({ actorId: userId, action: 'PASSWORD_RESET_COMPLETED', req }).catch((err) => console.error('writeAudit failed', err));

  res.json({ ok: true });
}));
