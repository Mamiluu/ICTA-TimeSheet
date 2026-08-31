// Copyright (c) 2026 Asya Hafidh <msanifuasiya@gmail.com>. All Rights Reserved.
// Proprietary and confidential. See LICENSE in the repository root.

import { Router } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { normalizePhone, normalizeEmail, isValidEmailShape, parseEventDate } from '../lib/normalize.js';
import { attendanceLimiter } from '../middleware/rateLimit.js';
import { ah } from '../lib/asyncHandler.js';
import { MAX_ATTENDANCE_PER_EVENT, SIGNATURE_REQUEST_TTL_MS, EVENT_LINK_VISIBILITY_MS } from '../lib/constants.js';
import { randomToken, hashToken } from '../lib/tokens.js';
import { writeAudit, verifyChain } from '../lib/audit.js';
import { sendAttendanceConfirmationEmail } from '../lib/mailer.js';

// Fire-and-forget, same discipline as writeAudit's own .catch(() => {})
// below: a Brevo outage or a malformed address must never fail the
// attendee's actual sign-in, which already succeeded by the time this
// runs. Every county's events flow through this one route, so this is the
// only place this needs wiring up, not per-admin config.
function sendConfirmationIfEmailed(row, event) {
  if (!row.email || !isValidEmailShape(row.email)) return;
  sendAttendanceConfirmationEmail(row.email, {
    name: row.name,
    eventName: event.name,
    eventDate: event.date,
    eventLocation: event.location,
    county: event.county,
    recordId: row.id,
    recordedAt: row.createdAt
  }).catch((err) => console.error('attendance confirmation email failed', err));
}

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
    hasPendingSignatureRequest: !!r.signatureRequestTokenHash,
    status: r.status,
    statusReason: r.statusReason,
    statusAt: r.statusAt
  };
}

// Same shape as publicRow, but for the one endpoint (my-attendance below)
// where echoing clientId back is safe: the caller had to already know it to
// ask the question in the first place, so this never teaches anyone
// anything they didn't already know about their own row.
function ownRow(r) {
  return { ...publicRow(r), clientId: r.clientId };
}

// Anchored to the event's own `date` field, not createdAt -- an admin
// routinely creates an event days or weeks ahead of when it actually
// happens, and anchoring to creation time would let the window lapse
// before the event even took place. The link is still open for sign-ins
// from the moment the event is created (no lower bound), it just keeps
// counting the close-by point from the event date itself, not from
// whenever the admin happened to set it up.
function linkClosesAt(event) {
  const eventDate = parseEventDate(event.date) || event.createdAt;
  return new Date(eventDate.getTime() + EVENT_LINK_VISIBILITY_MS);
}

function isLinkExpired(event) {
  return Date.now() > linkClosesAt(event).getTime();
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
  // County alone isn't enough now that a county can have multiple active
  // admins (see the per-county cap migration, which lets Nairobi run up to
  // 3) -- without also checking ownerId here, any of that county's admins
  // could manage every other one's events, not just their own.
  return user.role === 'COUNTY_ADMIN' && user.county === event.county && event.ownerId === user.id;
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

  // The public sign-in link closes after EVENT_LINK_VISIBILITY_MS -- for anyone who
  // isn't the owning admin (including a kiosk-forced view, since that's
  // still meant for a walk-in attendee, not the organizer). The owning
  // admin's own dashboard tools (Open/Export CSV/Print) all still work
  // past this: Export/Print go through the separate, always-open
  // /api/admin/events/:id/attendance route, and Open re-hits this same
  // route with a real admin session, which `manage` above already lets
  // through.
  if (!manage && isLinkExpired(event)) {
    return res.json({
      ok: true,
      event: { id: event.slug, name: event.name, date: event.date, location: event.location },
      expired: true,
      rows: [],
      submittedCount: 0,
      capacity: MAX_ATTENDANCE_PER_EVENT,
      canManage: false
    });
  }

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
    canManage: manage,
    // Deliberately narrower than canManage: a county admin can still view
    // the full roster and use the kiosk convenience tools for their own
    // event, but correcting an attendee's own submitted details (see the
    // admin-edit endpoint below) is reserved for a super admin only.
    canEditAttendance: manage && req.user.role === 'SUPER_ADMIN',
    // Lets the attendee page give a "closing soon" heads-up in the last
    // stretch of the window -- not sensitive (it's the event's own date
    // plus the fixed public window, see linkClosesAt above), and never
    // sent once already expired (that branch returns above instead).
    linkClosesAt: linkClosesAt(event)
  });
}));

// Lets whoever manages this event (see canManageEvent above) generate a
// one-time link for a specific row that's missing a signature -- e.g. rows
// 154/168, submitted before the server enforced a real signature -- so the
// attendee can add it themselves from their own device. Gated the same way
// the roster GET above is (inline canManageEvent check against the event's
// county, rather than requireRole + the adminRouter's id-keyed routes)
// because the caller only knows this event by slug, same as everything
// else on this page.
publicRouter.post('/events/:slug/attendance/:rowId/request-signature', attendanceLimiter, ah(async (req, res) => {
  const event = await prisma.event.findUnique({ where: { slug: req.params.slug } });
  if (!event || event.deletedAt) return res.json({ ok: false, error: 'Event not found' });
  if (!canManageEvent(req.user, event)) return res.status(403).json({ ok: false, error: 'FORBIDDEN' });

  const row = await prisma.attendance.findFirst({ where: { id: req.params.rowId, eventId: event.id } });
  if (!row) return res.json({ ok: false, error: 'NOT_FOUND' });

  const raw = randomToken();
  const expiresAt = new Date(Date.now() + SIGNATURE_REQUEST_TTL_MS);
  await prisma.attendance.update({
    where: { id: row.id },
    data: { signatureRequestTokenHash: hashToken(raw), signatureRequestExpiresAt: expiresAt }
  });
  await writeAudit({ actorId: req.user.id, action: 'SIGNATURE_REQUESTED', targetType: 'Attendance', targetId: row.id, metadata: { name: row.name, eventId: event.id }, req }).catch(() => {});

  res.json({
    ok: true,
    link: `${process.env.PUBLIC_APP_URL}/sign.html?token=${encodeURIComponent(raw)}`,
    expiresAt
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
  // Mirrors the GET route's cutoff: the client already hides the form once
  // GET reports expired, this is the backstop against calling the API
  // directly. Applied to every submitter, including the owning admin's own
  // "add a row on someone's behalf" kiosk tool -- once the window closes,
  // the roster is final and further changes belong on the admin dashboard,
  // not the public link.
  if (isLinkExpired(event)) {
    return res.json({ ok: false, error: 'LINK_EXPIRED', message: 'Sign-in for this event has closed.' });
  }

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
    sendConfirmationIfEmailed(row, event);
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
  if (isLinkExpired(event)) {
    return res.json({ ok: false, error: 'LINK_EXPIRED', message: 'Sign-in for this event has closed.' });
  }

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
        signature: String(req.body.signature || ''),
        // Whatever route got a real signature onto this row -- the
        // attendee's own device via Edit, or a signature-recovery link --
        // any outstanding request for one is satisfied, so it stops
        // showing as pending in the admin dashboard.
        signatureRequestTokenHash: null,
        signatureRequestExpiresAt: null
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

// Fixes a mistake in an attendee's own entry -- a misspelled organization,
// a typo in their name -- without needing that attendee's device/clientId
// the way the self-service PATCH above does. Deliberately restricted to a
// super admin, not just anyone who can manage this event (contrast
// canManageEvent above, which also lets the owning county admin through
// for viewing/kiosk purposes) -- a county admin edits their own event's
// name/date/location via /api/admin/events, but not an attendee's
// submitted personal details. Also deliberately can't touch the
// signature: that stays the attendee's own act, recoverable only via the
// request-signature link above, never something an admin draws on someone
// else's behalf.
publicRouter.patch('/events/:slug/attendance/:rowId/admin-edit', ah(async (req, res) => {
  const event = await prisma.event.findUnique({ where: { slug: req.params.slug } });
  if (!event || event.deletedAt) return res.json({ ok: false, error: 'Event not found' });
  if (!req.user || req.user.role !== 'SUPER_ADMIN') return res.status(403).json({ ok: false, error: 'FORBIDDEN' });

  const row = await prisma.attendance.findFirst({ where: { id: req.params.rowId, eventId: event.id } });
  if (!row) return res.json({ ok: false, error: 'NOT_FOUND' });

  const phone = String(req.body.phone || '');
  const phoneNormalized = normalizePhone(phone);
  if (!phoneNormalized) return res.json({ ok: false, error: 'INVALID_PHONE', message: 'Enter a valid Kenyan phone number.' });
  const emailNormalized = normalizeEmail(req.body.email);

  try {
    const updated = await prisma.attendance.update({
      where: { id: row.id },
      data: {
        name: String(req.body.name || ''),
        organization: req.body.org ? String(req.body.org) : null,
        email: req.body.email ? String(req.body.email) : null,
        emailNormalized,
        phone,
        phoneNormalized
      }
    });
    await writeAudit({
      actorId: req.user.id,
      action: 'ATTENDANCE_EDIT',
      targetType: 'Attendance',
      targetId: row.id,
      metadata: {
        eventId: event.id,
        before: { name: row.name, organization: row.organization, email: row.email, phone: row.phone },
        after: { name: updated.name, organization: updated.organization, email: updated.email, phone: updated.phone }
      },
      req
    }).catch(() => {});
    return res.json({ ok: true, id: updated.id });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      return res.json({ ok: false, error: 'ALREADY_SIGNED', message: 'That phone number or email is already used by another attendee for this event.' });
    }
    throw err;
  }
}));

// A one-time link an admin generates for a specific attendance row (see
// POST /api/admin/events/:id/attendance/:rowId/request-signature) so
// someone whose row is missing a signature -- see the account of rows 154
// and 168 having gotten through with signature: '' before the check above
// existed -- can add it themselves from their own device, without needing
// the device they originally submitted from. The token is the only proof
// of "this is my row" here, so this deliberately returns nothing about any
// *other* attendee, same discipline as my-attendance above.
publicRouter.get('/signature-requests/:token', attendanceLimiter, ah(async (req, res) => {
  const tokenHash = hashToken(String(req.params.token || ''));
  const row = await prisma.attendance.findUnique({
    where: { signatureRequestTokenHash: tokenHash },
    include: { event: true }
  });
  if (!row || !row.signatureRequestExpiresAt || row.signatureRequestExpiresAt < new Date()) {
    return res.json({ ok: false, error: 'INVALID_TOKEN', message: 'This link has expired or was already used. Ask the event organizer to send a new one.' });
  }
  res.json({ ok: true, name: row.name, eventName: row.event.name, hasSignature: !isBlankSignature(row.signature) });
}));

publicRouter.post('/signature-requests/:token', attendanceLimiter, ah(async (req, res) => {
  const tokenHash = hashToken(String(req.params.token || ''));
  const row = await prisma.attendance.findUnique({ where: { signatureRequestTokenHash: tokenHash } });
  if (!row || !row.signatureRequestExpiresAt || row.signatureRequestExpiresAt < new Date()) {
    return res.json({ ok: false, error: 'INVALID_TOKEN', message: 'This link has expired or was already used. Ask the event organizer to send a new one.' });
  }
  if (isBlankSignature(req.body.signature)) {
    return res.json({ ok: false, error: 'MISSING_SIGNATURE', message: 'Please draw your signature before saving.' });
  }

  // updateMany + a WHERE on the still-live hash is the same
  // compare-and-set trick consumeToken uses: it's what makes the link
  // single-use under concurrency (e.g. opened twice) rather than by
  // convention only.
  const result = await prisma.attendance.updateMany({
    where: { id: row.id, signatureRequestTokenHash: tokenHash },
    data: {
      signature: String(req.body.signature),
      signatureRequestTokenHash: null,
      signatureRequestExpiresAt: null
    }
  });
  if (result.count === 0) {
    return res.json({ ok: false, error: 'INVALID_TOKEN', message: 'This link has already been used.' });
  }
  res.json({ ok: true });
}));
