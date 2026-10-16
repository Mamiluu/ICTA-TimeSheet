// Copyright (c) 2026 Asya Hafidh <msanifuasiya@gmail.com>. All Rights Reserved.
// Proprietary and confidential. See LICENSE in the repository root.

import { Router } from 'express';
import { prisma } from '../lib/prisma.js';
import { ah } from '../lib/asyncHandler.js';
import { randomToken, hashToken } from '../lib/tokens.js';
import { sendSignupVerifyEmail } from '../lib/mailer.js';
import { logger } from '../lib/logger.js';
import { cleanSignup, verifyLinkExpired } from '../lib/signup.js';
import { platformBase } from '../lib/tenantHost.js';
import { signupLimiter } from '../middleware/rateLimit.js';

// Organisations asking to join. Nothing here creates an organisation: a request must have its
// email address confirmed and then be approved by the platform owner. It answers the same way
// whatever happens, so it cannot be used to find out which addresses are already registered.
export const signupRouter = Router();

const SAME_ANSWER = { ok: true, message: 'Thank you. If the details are right, we have sent a confirmation link to your email address. Open it to finish your request.' };

signupRouter.post('/', signupLimiter, ah(async (req, res) => {
  const parsed = cleanSignup(req.body);
  if (parsed.bot) return res.json(SAME_ANSWER);
  if (parsed.error) return res.status(400).json({ ok: false, error: 'INVALID_REQUEST', message: parsed.error });
  const v = parsed.value;

  // Someone who already has an account here gets nothing sent, and the same answer.
  const existingUser = await prisma.user.findUnique({ where: { email: v.contactEmail }, select: { id: true } });
  if (existingUser) return res.json(SAME_ANSWER);

  const open = await prisma.organisationRequest.findFirst({ where: { contactEmail: v.contactEmail, status: { in: ['UNVERIFIED', 'PENDING'] } } });
  if (open && open.status === 'PENDING') return res.json(SAME_ANSWER);

  const raw = randomToken();
  const data = { ...v, status: 'UNVERIFIED', tokenHash: hashToken(raw), createdAt: new Date() };
  if (open) await prisma.organisationRequest.update({ where: { id: open.id }, data });
  else await prisma.organisationRequest.create({ data });

  const url = `${platformBase()}/signup.html?verify=${encodeURIComponent(raw)}`;
  sendSignupVerifyEmail(v.contactEmail, url, v.contactName).catch((err) => logger.error('sendSignupVerifyEmail failed', { stack: err.stack }));
  res.json(SAME_ANSWER);
}));

signupRouter.post('/verify', signupLimiter, ah(async (req, res) => {
  const token = String(req.body.token || '');
  const request = token ? await prisma.organisationRequest.findUnique({ where: { tokenHash: hashToken(token) } }) : null;
  if (!request || request.status !== 'UNVERIFIED') return res.status(400).json({ ok: false, error: 'INVALID_LINK', message: 'This link is not valid any more. If you already confirmed, your request is waiting for review.' });
  if (verifyLinkExpired(request.createdAt)) return res.status(400).json({ ok: false, error: 'EXPIRED', message: 'This link has expired. Send your request again to get a new one.' });
  await prisma.organisationRequest.update({ where: { id: request.id }, data: { status: 'PENDING', emailVerifiedAt: new Date(), tokenHash: null } });
  res.json({ ok: true, message: 'Your email address is confirmed. We will review your request and write to you at that address.' });
}));