// Copyright (c) 2026 Asya Hafidh <msanifuasiya@gmail.com>. All Rights Reserved.
// Proprietary and confidential. See LICENSE in the repository root.

import { Router } from 'express';
import { prisma } from '../lib/prisma.js';
import { ah } from '../lib/asyncHandler.js';
import { randomToken, hashToken } from '../lib/tokens.js';
import { sendSignupVerifyEmail, sendSignupNoticeEmail } from '../lib/mailer.js';
import { logger } from '../lib/logger.js';
import { cleanSignup, verifyLinkExpired, safeEmailError } from '../lib/signup.js';
import { platformBase } from '../lib/tenantHost.js';
import { signupLimiter } from '../middleware/rateLimit.js';

// Organisations asking to join. Nothing here creates an organisation: a request must have its
// email address confirmed and then be approved by the platform owner. It answers the same way
// whatever happens, so it cannot be used to find out which addresses are already registered.
export const signupRouter = Router();

const SAME_ANSWER = { ok: true, message: 'Thank you. If the details are right, we have sent a confirmation link to your email address. Open it to finish your request.' };

// Sends the confirmation link and writes down how that went, so a request whose email never arrived
// shows up for the owner (with the reason) instead of vanishing.
export async function deliverVerifyEmail(request, raw) {
  const url = `${platformBase()}/signup?verify=${encodeURIComponent(raw)}`;
  try {
    await sendSignupVerifyEmail(request.contactEmail, url, request.contactName);
    await prisma.organisationRequest.update({ where: { id: request.id }, data: { verifyEmailSentAt: new Date(), verifyEmailError: null } });
    return { sent: true };
  } catch (err) {
    logger.error('sendSignupVerifyEmail failed', { stack: err.stack });
    const error = safeEmailError(err.message);
    await prisma.organisationRequest.update({ where: { id: request.id }, data: { verifyEmailSentAt: null, verifyEmailError: error } }).catch(() => {});
    return { sent: false, error };
  }
}

signupRouter.post('/', signupLimiter, ah(async (req, res) => {
  const parsed = cleanSignup(req.body);
  if (parsed.bot) return res.json(SAME_ANSWER);
  if (parsed.error) return res.status(400).json({ ok: false, error: 'INVALID_REQUEST', message: parsed.error });
  const v = parsed.value;
  const tell = (kind) => sendSignupNoticeEmail(v.contactEmail, v.contactName, kind, `${platformBase()}/login`).catch((err) => logger.error('sendSignupNoticeEmail failed', { stack: err.stack }));

  // The answer on the page is the same whatever is true, so nobody can probe for registered addresses;
  // the email is what tells the real owner of the address what applies to them.
  const existingUser = await prisma.user.findUnique({ where: { email: v.contactEmail }, select: { id: true } });
  if (existingUser) { tell('EXISTING'); return res.json(SAME_ANSWER); }

  const open = await prisma.organisationRequest.findFirst({ where: { contactEmail: v.contactEmail, status: { in: ['UNVERIFIED', 'PENDING'] } } });
  if (open && open.status === 'PENDING') { tell('WAITING'); return res.json(SAME_ANSWER); }

  const raw = randomToken();
  const data = { ...v, status: 'UNVERIFIED', tokenHash: hashToken(raw), createdAt: new Date(), verifyEmailSentAt: null, verifyEmailError: null };
  const request = open ? await prisma.organisationRequest.update({ where: { id: open.id }, data }) : await prisma.organisationRequest.create({ data });

  deliverVerifyEmail(request, raw);
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