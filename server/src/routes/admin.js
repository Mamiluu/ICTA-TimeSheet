// Copyright (c) 2026 Asya Hafidh <msanifuasiya@gmail.com>. All Rights Reserved.
// Proprietary and confidential. See LICENSE in the repository root.

import { Router } from 'express';
import { prisma } from '../lib/prisma.js';
import { requireRole } from '../middleware/auth.js';
import { writeAudit } from '../lib/audit.js';
import { eventSlugId } from '../lib/normalize.js';
import { ah } from '../lib/asyncHandler.js';

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

adminRouter.get('/events', ah(async (req, res) => {
  const events = await prisma.event.findMany({
    where: { county: req.user.county, deletedAt: null },
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

  const event = await prisma.event.create({
    data: { slug: eventSlugId(name), name, date, location, county: req.user.county, ownerId: req.user.id }
  });
  await writeAudit({ actorId: req.user.id, action: 'EVENT_CREATE', targetType: 'Event', targetId: event.id, metadata: { name, date, location }, req });

  res.json({ ok: true, event: publicEvent(event, 0) });
}));

// Looks up the event scoped to the caller's own county and returns 404 (not
// 403) when it belongs to a different county, so a county admin can't use
// response codes to fingerprint which event ids exist outside their own turf.
async function findOwnEvent(req) {
  const event = await prisma.event.findUnique({ where: { id: req.params.id } });
  if (!event || event.deletedAt || event.county !== req.user.county) return null;
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

  // Soft delete -- attendance rows already submitted for this event are
  // deliberately preserved, matching the previous Apps Script backend's
  // behavior of never destroying real sign-in data on event deletion.
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

// The one path an admin's own printing/exporting is meant to go through
// (see index.html's ?admin=1 removal) -- name, phone, email, and a drawn
// signature are personal data, so pulling the full roster for a local
// download is logged just like every other admin action in this app, not
// treated as a free read just because the sheet itself is publicly
// viewable at the venue.
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
