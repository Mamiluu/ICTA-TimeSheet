// Copyright (c) 2026 Asya Hafidh <msanifuasiya@gmail.com>. All Rights Reserved.
// Proprietary and confidential. See LICENSE in the repository root.

import { Router } from 'express';
import { prisma } from '../lib/prisma.js';
import { requireRole } from '../middleware/auth.js';
import { writeAudit } from '../lib/audit.js';
import { eventSlugId, isValidMeetingLink } from '../lib/normalize.js';
import { isValidTimeZone } from '../lib/timezone.js';
import { ah } from '../lib/asyncHandler.js';
import { EVENT_LINK_VISIBILITY_MS } from '../lib/constants.js';

export const adminRouter = Router();
adminRouter.use(requireRole('COUNTY_ADMIN'));

function publicEvent(ev, count) {
  return {
    id: ev.id,
    slug: ev.slug,
    name: ev.name,
    description: ev.description,
    startAt: ev.startAt,
    endAt: ev.endAt,
    timezone: ev.timezone,
    locationType: ev.locationType,
    address: ev.address,
    latitude: ev.latitude,
    longitude: ev.longitude,
    meetingLink: ev.meetingLink,
    county: ev.county,
    createdAt: ev.createdAt,
    // So the dashboard can show "closes in Xd Yh" / "Closed" per event
    // (see public.js's linkClosesAt/isLinkExpired, the actual enforcement)
    // without duplicating that logic client-side. Anchored to the event's
    // own endAt now, not a parsed date string -- see the matching comment
    // in public.js.
    linkClosesAt: new Date(ev.endAt.getTime() + EVENT_LINK_VISIBILITY_MS),
    count: count ?? undefined
  };
}

// startAt/endAt arrive as ISO instant strings (the browser already
// resolved the admin's chosen local wall-clock time + timezone to a UTC
// instant before submitting -- see admin.html) -- this only checks they
// parse and that start comes before end, it doesn't do any zone math
// itself.
export function requireEventFields(body) {
  const name = String(body.name || '').trim();
  const description = body.description ? String(body.description).trim().slice(0, 2000) : null;
  const timezone = String(body.timezone || '').trim();
  const startAt = new Date(body.startAt);
  const endAt = new Date(body.endAt);
  const locationType = body.locationType === 'VIRTUAL' ? 'VIRTUAL' : 'PHYSICAL';
  const address = locationType === 'PHYSICAL' ? String(body.address || '').trim() : null;
  const meetingLink = locationType === 'VIRTUAL' ? String(body.meetingLink || '').trim() : null;
  // Only trusted when the admin actually picked a geocoded suggestion
  // (see admin.html's address autocomplete) -- anything else (missing,
  // non-numeric, or a virtual event where neither applies) is left null
  // rather than guessed at. A pin without a matching address would be
  // actively misleading on the attendee-facing map, so this only ever
  // carries a coordinate pair that came from a real lookup.
  const latitude = locationType === 'PHYSICAL' && Number.isFinite(Number(body.latitude)) ? Number(body.latitude) : null;
  const longitude = locationType === 'PHYSICAL' && Number.isFinite(Number(body.longitude)) ? Number(body.longitude) : null;

  const missing = [];
  if (!name) missing.push('event name');
  if (isNaN(startAt.getTime())) missing.push('start date/time');
  if (isNaN(endAt.getTime())) missing.push('end date/time');
  if (!timezone) missing.push('time zone');
  if (locationType === 'PHYSICAL' && !address) missing.push('address');
  if (locationType === 'VIRTUAL' && !meetingLink) missing.push('meeting link');

  return { name, description, startAt, endAt, timezone, locationType, address, latitude, longitude, meetingLink, missing };
}

export function validateEventFields(f) {
  if (f.missing.length) {
    return { ok: false, error: 'MISSING_FIELDS', message: `Please fill in ${f.missing.join(', ')}.` };
  }
  if (f.startAt.getTime() >= f.endAt.getTime()) {
    return { ok: false, error: 'INVALID_RANGE', message: 'The event must end after it starts.' };
  }
  if (!isValidTimeZone(f.timezone)) {
    return { ok: false, error: 'INVALID_TIMEZONE', message: 'That time zone isn\'t recognized.' };
  }
  if (f.locationType === 'VIRTUAL' && !isValidMeetingLink(f.meetingLink)) {
    return { ok: false, error: 'INVALID_MEETING_LINK', message: 'Enter a valid meeting link (starting with http:// or https://).' };
  }
  return null;
}

adminRouter.get('/events', ah(async (req, res) => {
  const events = await prisma.event.findMany({
    // Each admin's dashboard lists only events they themselves created --
    // county is where the cap is enforced, not a shared workspace, so a
    // county with multiple admins (see per-county cap migration) doesn't
    // mean they share each other's events.
    where: { county: req.user.county, ownerId: req.user.id, deletedAt: null },
    orderBy: { createdAt: 'desc' },
    include: { _count: { select: { attendance: true } } }
  });
  res.json({ ok: true, events: events.map((ev) => publicEvent(ev, ev._count.attendance)) });
}));

adminRouter.post('/events', ah(async (req, res) => {
  const f = requireEventFields(req.body);
  const err = validateEventFields(f);
  if (err) return res.status(400).json(err);
  // The date picker already blocks past days client-side; this is the
  // server-side backstop so the restriction can't be skipped by calling
  // the API directly. Only enforced on create -- editing an event that
  // already has a past start time (from before this check existed, or
  // simply because it's already underway) must stay possible without
  // forcing its time to change.
  if (f.startAt.getTime() < Date.now()) {
    return res.status(400).json({ ok: false, error: 'PAST_DATE', message: 'Event start can\'t be in the past.' });
  }

  const event = await prisma.event.create({
    data: {
      slug: eventSlugId(f.name), name: f.name, description: f.description,
      startAt: f.startAt, endAt: f.endAt, timezone: f.timezone,
      locationType: f.locationType, address: f.address, latitude: f.latitude, longitude: f.longitude, meetingLink: f.meetingLink,
      county: req.user.county, ownerId: req.user.id
    }
  });
  await writeAudit({
    actorId: req.user.id, action: 'EVENT_CREATE', targetType: 'Event', targetId: event.id,
    metadata: { name: f.name, startAt: f.startAt, endAt: f.endAt, timezone: f.timezone, locationType: f.locationType, address: f.address, meetingLink: f.meetingLink },
    req
  });

  res.json({ ok: true, event: publicEvent(event, 0) });
}));

// Helper function to find an event by ID and ensure it was created by the
// current admin -- county alone isn't ownership: a county can have up to 3
// active admins (see the per-county cap migration), and each one's events
// should stay private to them, not shared across every admin their county
// happens to have.
async function findOwnEvent(req) {
  const event = await prisma.event.findUnique({ where: { id: req.params.id } });
  if (!event || event.deletedAt || event.county !== req.user.county || event.ownerId !== req.user.id) return null;
  return event;
}

adminRouter.put('/events/:id', ah(async (req, res) => {
  const event = await findOwnEvent(req);
  if (!event) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });

  const f = requireEventFields(req.body);
  const err = validateEventFields(f);
  if (err) return res.status(400).json(err);

  const before = {
    name: event.name, description: event.description, startAt: event.startAt, endAt: event.endAt,
    timezone: event.timezone, locationType: event.locationType, address: event.address, meetingLink: event.meetingLink
  };
  const after = {
    name: f.name, description: f.description, startAt: f.startAt, endAt: f.endAt,
    timezone: f.timezone, locationType: f.locationType, address: f.address, meetingLink: f.meetingLink
  };
  // latitude/longitude are a full replace too (kept out of the audit
  // snapshot above since they're a derived precision detail, not
  // something a reviewer needs to see change) -- omitting them from the
  // update would leave a stale pin attached to whatever address used to
  // be here if this edit changed the address without re-picking a map
  // suggestion.
  const updated = await prisma.event.update({ where: { id: event.id }, data: { ...after, latitude: f.latitude, longitude: f.longitude } });
  await writeAudit({
    actorId: req.user.id,
    action: 'EVENT_UPDATE',
    targetType: 'Event',
    targetId: event.id,
    metadata: { before, after },
    req
  });

  res.json({ ok: true, event: publicEvent(updated) });
}));

adminRouter.delete('/events/:id', ah(async (req, res) => {
  const event = await findOwnEvent(req);
  if (!event) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });

  // Soft-delete the event by setting deletedAt to the current timestamp.
  await prisma.event.update({ where: { id: event.id }, data: { deletedAt: new Date() } });
  await writeAudit({ actorId: req.user.id, action: 'EVENT_DELETE', targetType: 'Event', targetId: event.id, metadata: { name: event.name }, req });

  res.json({ ok: true });
}));

function attendanceRow(r) {
  return {
    id: r.id,
    timestamp: r.createdAt,
    name: r.name,
    org: r.organization,
    email: r.email,
    phone: r.phone,
    signature: r.signature,
    status: r.status,
    statusReason: r.statusReason,
    statusAt: r.statusAt,
    photoVideoConsent: r.photoVideoConsent
  };
}

// Returns the attendance rows for a given event, in chronological order.
adminRouter.get('/events/:id/attendance', ah(async (req, res) => {
  const event = await findOwnEvent(req);
  if (!event) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });

  const attendance = await prisma.attendance.findMany({
    where: { eventId: event.id },
    orderBy: { createdAt: 'asc' }
  });
  await writeAudit({
    actorId: req.user.id,
    action: 'EVENT_ATTENDANCE_EXPORTED',
    targetType: 'Event',
    targetId: event.id,
    metadata: { name: event.name, rowCount: attendance.length },
    req
  });

  res.json({ ok: true, event: publicEvent(event), rows: attendance.map(attendanceRow) });
}));

adminRouter.get('/audit', ah(async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize, 10) || 25));

  const [total, entries] = await Promise.all([
    prisma.auditLog.count({ where: { actorId: req.user.id } }),
    prisma.auditLog.findMany({
      where: { actorId: req.user.id },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize
    })
  ]);

  res.json({ ok: true, entries, total, page, pageSize });
}));
