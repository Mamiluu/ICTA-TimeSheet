// Copyright (c) 2026 Asya Hafidh <msanifuasiya@gmail.com>. All Rights Reserved.
// Proprietary and confidential. See LICENSE in the repository root.

import { Router } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { normalizePhone, normalizeEmail } from '../lib/normalize.js';
import { attendanceLimiter } from '../middleware/rateLimit.js';
import { ah } from '../lib/asyncHandler.js';

export const publicRouter = Router();

function publicRow(r) {
  return {
    id: r.id,
    timestamp: r.createdAt,
    name: r.name,
    org: r.organization,
    email: r.email,
    phone: r.phone,
    signature: r.signature
  };
}

publicRouter.get('/events/:slug', ah(async (req, res) => {
  const event = await prisma.event.findUnique({
    where: { slug: req.params.slug },
    include: { attendance: { orderBy: { createdAt: 'asc' } } }
  });
  if (!event || event.deletedAt) return res.json({ ok: false, error: 'Event not found' });

  res.json({
    ok: true,
    event: { id: event.slug, name: event.name, date: event.date, location: event.location },
    rows: event.attendance.map(publicRow)
  });
}));

publicRouter.post('/events/:slug/attendance', attendanceLimiter, ah(async (req, res) => {
  const event = await prisma.event.findUnique({ where: { slug: req.params.slug } });
  if (!event || event.deletedAt) return res.json({ ok: false, error: 'Unknown event' });

  const clientId = String(req.body.clientId || '');
  const phone = String(req.body.phone || '');
  const phoneNormalized = normalizePhone(phone);
  if (!phoneNormalized) return res.json({ ok: false, error: 'INVALID_PHONE', message: 'Enter a valid Kenyan phone number.' });
  const emailNormalized = normalizeEmail(req.body.email);

  // Idempotency guard first: if this exact submission (by client-generated
  // id) already made it in -- e.g. the first request succeeded but the
  // response was lost on a flaky connection and the client retried --
  // return the existing row instead of creating a duplicate.
  if (clientId) {
    const existing = await prisma.attendance.findUnique({
      where: { eventId_clientId: { eventId: event.id, clientId } }
    });
    if (existing) return res.json({ ok: true, id: existing.id, duplicate: true });
  }

  try {
    const row = await prisma.attendance.create({
      data: {
        eventId: event.id,
        clientId: clientId || undefined,
        name: String(req.body.name || ''),
        organization: req.body.org ? String(req.body.org) : null,
        email: req.body.email ? String(req.body.email) : null,
        emailNormalized,
        phone,
        phoneNormalized,
        signature: String(req.body.signature || '')
      }
    });
    return res.json({ ok: true, id: row.id });
  } catch (err) {
    // One phone/email = one attendee per event, enforced by the DB unique
    // constraints below rather than a racy read-then-check -- two devices
    // submitting the same phone number at nearly the same instant both
    // attempt the insert, Postgres guarantees exactly one wins.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      const target = Array.isArray(err.meta?.target) ? err.meta.target.join(',') : String(err.meta?.target || '');
      if (target.includes('clientId')) {
        const existing = await prisma.attendance.findUnique({ where: { eventId_clientId: { eventId: event.id, clientId } } });
        if (existing) return res.json({ ok: true, id: existing.id, duplicate: true });
      }
      return res.json({ ok: false, error: 'ALREADY_SIGNED', message: 'This phone number or email has already signed in for this event.' });
    }
    throw err;
  }
}));
