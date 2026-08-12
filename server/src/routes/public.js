// Copyright (c) 2026 Asya Hafidh <msanifuasiya@gmail.com>. All Rights Reserved.
// Proprietary and confidential. See LICENSE in the repository root.

import { Router } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { normalizePhone, normalizeEmail } from '../lib/normalize.js';
import { attendanceLimiter } from '../middleware/rateLimit.js';
import { ah } from '../lib/asyncHandler.js';
import { MAX_ATTENDANCE_PER_EVENT } from '../lib/constants.js';
import { randomToken, hashToken } from '../lib/tokens.js';

export const publicRouter = Router();

// The client already refuses to let a visitor save a blank canvas (see the
// hasInk latch in index.html's signature modal), but that is a UX guard
// running in a browser we don't control -- a stale cached copy of the page,
// a direct API call, or any future client that skips it would otherwise
// still get a row written with signature: ''. This is the actual
// enforcement boundary: reject anything that isn't a real drawn signature,
// regardless of what submitted it.
function isBlankSignature(signature) {
  const s = String(signature || '').trim();
  return !s || s.length < 100 || !s.startsWith('data:image/');
}

function publicRow(r) {
  return {
    id: r.id,
    timestamp: r.createdAt,
    name: r.name,
    org: r.organization,
    email: r.email,
    phone: r.phone,
    signature: r.signature,
    hasPendingSignatureRequest: !!r.signatureRequestTokenHash
  };
}

// Same shape as publicRow, but for the one endpoint (my-attendance below)
// where echoing clientId back is safe: the caller had to already know it to
// ask the question in the first place, so this never teaches anyone
// anything they didn't already know about their own row.
function ownRow(r) {
  return { ...publicRow(r), clientId: r.clientId };
}

// This route has no requireRole guard -- the sheet itself is meant to be
// readable by anyone holding the event link/QR, the same way a physical
// clipboard sitting at a venue is readable by anyone standing there.
// req.user is still populated when a session cookie is present (see
// attachUser in index.js, mounted ahead of every router), so it costs
// nothing to also tell a legitimately logged-in admin "you manage this
// one" -- purely to reveal the on-page kiosk convenience tools (add a row
// on someone's behalf, clear local drafts). Export/print for the record
// are deliberately NOT unlocked here; those go through the audited
// /api/admin/events/:id/attendance path from the admin's own dashboard.
function canManageEvent(user, event) {
  if (!user) return false;
  if (user.role === 'SUPER_ADMIN') return true;
  return user.role === 'COUNTY_ADMIN' && user.county === event.county;
}

publicRouter.get('/events/:slug', ah(async (req, res) => {
  const event = await prisma.event.findUnique({ where: { slug: req.params.slug } });
  if (!event || event.deletedAt) return res.json({ ok: false, error: 'Event not found' });

  // ?kiosk=1 is an explicit, one-way downgrade: even a genuine admin
  // session sees this exact link exactly the way an anonymous attendee
  // would. It exists for the physical-device case a pure link/session
  // model can't cover -- an organizer's own laptop, still logged in,
  // handed to a walk-in to type their own row. Without this, that shared
  // device would render the full roster from the admin's own privileged
  // session regardless of how sealed the link is for everyone else. The
  // admin dashboard hands out this exact URL as a distinct "Kiosk link" --
  // see admin.html -- so the choice to use it is deliberate, not a trap
  // toggled by a stray query string on the normal link.
  const kiosk = req.query.kiosk === '1' || req.query.kiosk === 'true';
  const manage = kiosk ? false : canManageEvent(req.user, event);

  // The roster itself is sealed: a plain visitor holding the event
  // link/QR only ever learns the event details and how many people have
  // signed in so far -- never who else signed in. Only a session that
  // genuinely manages this event (its own county admin, or a super admin --
  // see canManageEvent above) gets the full roster, the same way the old
  // paper clipboard was only ever handed to a stranger, never left with
  // them. Each visitor's own row is recovered separately via
  // POST /events/:slug/my-attendance, keyed by the clientId only their own
  // browser knows.
  const [submittedCount, attendance] = await Promise.all([
    prisma.attendance.count({ where: { eventId: event.id } }),
    manage
      ? prisma.attendance.findMany({ where: { eventId: event.id }, orderBy: { createdAt: 'asc' } })
      : Promise.resolve([])
  ]);

  res.json({
    ok: true,
    event: { id: event.slug, name: event.name, date: event.date, location: event.location },
    rows: attendance.map(publicRow),
    submittedCount,
    capacity: MAX_ATTENDANCE_PER_EVENT,
    canManage: manage
  });
}));

// Lets a visitor's own device recover exactly its own row(s) -- and nobody
// else's -- after a reload, refresh, or revisit. clientIds are random
// UUIDs generated client-side at submit time and never echoed back to any
// *other* visitor (see publicRow above), so presenting one back here is
// proof of authorship, not a lookup key anyone could guess or enumerate.
publicRouter.post('/events/:slug/my-attendance', attendanceLimiter, ah(async (req, res) => {
  const event = await prisma.event.findUnique({ where: { slug: req.params.slug } });
  if (!event || event.deletedAt) return res.json({ ok: false, error: 'Unknown event' });

  const clientIds = Array.isArray(req.body.clientIds)
    ? [...new Set(req.body.clientIds.map(String).filter(Boolean))].slice(0, 25)
    : [];
  if (!clientIds.length) return res.json({ ok: true, rows: [] });

  const rows = await prisma.attendance.findMany({
    where: { eventId: event.id, clientId: { in: clientIds } }
  });
  res.json({ ok: true, rows: rows.map(ownRow) });
}));

publicRouter.post('/events/:slug/attendance', attendanceLimiter, ah(async (req, res) => {
  const event = await prisma.event.findUnique({ where: { slug: req.params.slug } });
  if (!event || event.deletedAt) return res.json({ ok: false, error: 'Unknown event' });

  const clientId = String(req.body.clientId || '');
  const phone = String(req.body.phone || '');
  const phoneNormalized = normalizePhone(phone);
  if (!phoneNormalized) return res.json({ ok: false, error: 'INVALID_PHONE', message: 'Enter a valid Kenyan phone number.' });
  if (isBlankSignature(req.body.signature)) {
    return res.json({ ok: false, error: 'MISSING_SIGNATURE', message: 'A signature is required — please draw it before submitting.' });
  }
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

  // A soft pilot-scale ceiling, not a security invariant like the county
  // admin cap -- a count-then-insert check is good enough here. Worst case
  // under a flood of simultaneous submissions right at the boundary is a
  // handful of rows past 500, not a broken guarantee.
  const attendeeCount = await prisma.attendance.count({ where: { eventId: event.id } });
  if (attendeeCount >= MAX_ATTENDANCE_PER_EVENT) {
    return res.json({ ok: false, error: 'EVENT_FULL', message: 'This event has reached its maximum of ' + MAX_ATTENDANCE_PER_EVENT + ' attendees.' });
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

// Lets a visitor correct their own already-submitted row (typo in name,
// wrong digit in phone, etc). There are no visitor accounts, so clientId
// -- the random id their browser generated at submit time -- is the only
// proof of "this is my row"; it works because publicRow() below never
// echoes clientId back to anyone, so no other visitor's browser ever
// learns it.
publicRouter.patch('/events/:slug/attendance/:clientId', attendanceLimiter, ah(async (req, res) => {
  const event = await prisma.event.findUnique({ where: { slug: req.params.slug } });
  if (!event || event.deletedAt) return res.json({ ok: false, error: 'Unknown event' });

  const clientId = String(req.params.clientId || '');
  const existing = await prisma.attendance.findUnique({
    where: { eventId_clientId: { eventId: event.id, clientId } }
  });
  if (!existing) {
    return res.json({ ok: false, error: 'NOT_FOUND', message: 'This entry can only be edited from the device it was submitted on.' });
  }

  const phone = String(req.body.phone || '');
  const phoneNormalized = normalizePhone(phone);
  if (!phoneNormalized) return res.json({ ok: false, error: 'INVALID_PHONE', message: 'Enter a valid Kenyan phone number.' });
  if (isBlankSignature(req.body.signature)) {
    return res.json({ ok: false, error: 'MISSING_SIGNATURE', message: 'A signature is required — please draw it before saving.' });
  }
  const emailNormalized = normalizeEmail(req.body.email);

  try {
    const row = await prisma.attendance.update({
      where: { id: existing.id },
      data: {
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
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      return res.json({ ok: false, error: 'ALREADY_SIGNED', message: 'That phone number or email is already used by another attendee for this event.' });
    }
    throw err;
  }
}));
