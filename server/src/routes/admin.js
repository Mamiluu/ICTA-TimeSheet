// Copyright (c) 2026 Asya Hafidh <msanifuasiya@gmail.com>. All Rights Reserved.
// Proprietary and confidential. See LICENSE in the repository root.

import { Router } from 'express';
import { prisma } from '../lib/prisma.js';
import { requireRole } from '../middleware/auth.js';
import { writeAudit } from '../lib/audit.js';
import { eventSlugId, parseEventDate } from '../lib/normalize.js';
import { ah } from '../lib/asyncHandler.js';
import { EVENT_LINK_VISIBILITY_MS } from '../lib/constants.js';

export const adminRouter = Router();
adminRouter.use(requireRole('COUNTY_ADMIN'));

function publicEvent(ev, count) {
  return {
    id: ev.id,
    slug: ev.slug,
    name: ev.name,
    date: ev.date,
    location: ev.location,
    county: ev.county,
    createdAt: ev.createdAt,
    // So the dashboard can show "closes in Xd Yh" / "Closed" per event
    // (see public.js's linkClosesAt/isLinkExpired, the actual enforcement)
    // without duplicating that logic client-side. Anchored to the event's
    // own date, not createdAt -- see the matching comment in public.js.
    linkClosesAt: new Date((parseEventDate(ev.date) || ev.createdAt).getTime() + EVENT_LINK_VISIBILITY_MS),
    count: count ?? undefined
  };
}

function requireFields(body) {
  const name = String(body.name || '').trim();
  const date = String(body.date || '').trim();
  const location = String(body.location || '').trim();
  const missing = [];
  if (!name) missing.push('event name');
  if (!date) missing.push('date');
  if (!location) missing.push('location');
  return { name, date, location, missing };
}

// YYYY-MM-DD, same shape as the `date` field, so it sorts/compares
// correctly as a plain string against it.
function todayIsoDate() {
  const now = new Date();
  return now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0');
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
  const { name, date, location, missing } = requireFields(req.body);
  if (missing.length) {
    return res.status(400).json({ ok: false, error: 'MISSING_FIELDS', message: `Please fill in ${missing.join(', ')}.` });
  }
  // The date picker already blocks past days client-side; this is the
  // server-side backstop so the restriction can't be skipped by calling
  // the API directly. Only enforced on create -- editing an event that
  // already has a past date (from before this check existed) must stay
  // possible without forcing its date to change.
  if (date < todayIsoDate()) {
    return res.status(400).json({ ok: false, error: 'PAST_DATE', message: 'Event date cannot be in the past.' });
  }

  const event = await prisma.event.create({
    data: { slug: eventSlugId(name), name, date, location, county: req.user.county, ownerId: req.user.id }
  });
  await writeAudit({ actorId: req.user.id, action: 'EVENT_CREATE', targetType: 'Event', targetId: event.id, metadata: { name, date, location }, req });

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

  const { name, date, location, missing } = requireFields(req.body);
  if (missing.length) {
    return res.status(400).json({ ok: false, error: 'MISSING_FIELDS', message: `Please fill in ${missing.join(', ')}.` });
  }

  const before = { name: event.name, date: event.date, location: event.location };
  const updated = await prisma.event.update({ where: { id: event.id }, data: { name, date, location } });
  await writeAudit({
    actorId: req.user.id,
    action: 'EVENT_UPDATE',
    targetType: 'Event',
    targetId: event.id,
    metadata: { before, after: { name, date, location } },
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
    signature: r.signature
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
