// Copyright (c) 2026 Asya Hafidh <msanifuasiya@gmail.com>. All Rights Reserved.
// Proprietary and confidential. See LICENSE in the repository root.

import { Router } from 'express';
import { prisma } from '../lib/prisma.js';
import { ah } from '../lib/asyncHandler.js';
import { pairScreenLimiter, screenPollLimiter } from '../middleware/rateLimit.js';
import { cleanPairCode, newScreenToken, hashToken, screenRefusal, livePayload } from '../lib/liveScreen.js';

// What a paired live code screen may do, with no sign-in: swap a pairing code for its own secret, and ask
// for the code to show. Nothing here reads attendance or changes anything about the event.
export const screenRouter = Router();

const NO_STORE = 'no-store';

screenRouter.post('/pair', pairScreenLimiter, ah(async (req, res) => {
  res.set('Cache-Control', NO_STORE);
  const code = cleanPairCode(req.body.code);
  const wrong = () => res.status(404).json({ ok: false, error: 'BAD_CODE', message: 'That code is not right, or it has run out. Ask for a new one on the admin page.' });
  if (!code) return wrong();

  const now = new Date();
  const screen = await prisma.liveScreen.findFirst({ where: { pairCode: code, tokenHash: null, revokedAt: null, pairExpiresAt: { gt: now } }, include: { event: true } });
  if (!screen) return wrong();
  const refusal = screenRefusal(screen.event, now.getTime());
  if (refusal) return res.status(409).json({ ok: false, ...refusal });

  // The code is used once: the update only goes through while the screen is still waiting.
  const { raw, hash } = newScreenToken();
  const done = await prisma.liveScreen.updateMany({
    where: { id: screen.id, tokenHash: null, revokedAt: null, pairCode: code },
    data: { tokenHash: hash, pairCode: null, pairExpiresAt: null, pairedAt: now, lastSeenAt: now }
  });
  if (!done.count) return wrong();
  res.json({ ok: true, token: raw, label: screen.label, name: screen.event.name });
}));

screenRouter.post('/live', screenPollLimiter, ah(async (req, res) => {
  res.set('Cache-Control', NO_STORE);
  const token = String(req.body.token || '');
  const screen = token.length >= 20 && token.length <= 80 ? await prisma.liveScreen.findUnique({ where: { tokenHash: hashToken(token) }, include: { event: true } }) : null;
  if (!screen) return res.status(404).json({ ok: false, error: 'UNKNOWN', message: 'This screen is not set up. Pair it again from the admin page.' });
  if (screen.revokedAt) return res.status(410).json({ ok: false, error: 'REMOVED', message: 'This screen was removed by the organiser.' });
  const refusal = screenRefusal(screen.event);
  if (refusal) return res.status(410).json({ ok: false, ...refusal });

  // Once a minute at most is plenty for the organiser to see which screens are alive.
  const now = new Date();
  await prisma.liveScreen.updateMany({
    where: { id: screen.id, OR: [{ lastSeenAt: null }, { lastSeenAt: { lt: new Date(now.getTime() - 60 * 1000) } }] },
    data: { lastSeenAt: now }
  });
  res.json({ ok: true, label: screen.label, ...(await livePayload(screen.event, now.getTime())) });
}));
