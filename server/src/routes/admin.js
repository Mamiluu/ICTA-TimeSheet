// Copyright (c) 2026 Asya Hafidh <msanifuasiya@gmail.com>. All Rights Reserved.
// Proprietary and confidential. See LICENSE in the repository root.

import { Router } from 'express';
import { prisma } from '../lib/prisma.js';
import { requireRole } from '../middleware/auth.js';
import { writeAudit } from '../lib/audit.js';
import { newSealCode, digestOf, buildDaySnapshot, buildEventSnapshot } from '../lib/seal.js';
import { eventSlugId, isValidMeetingLink } from '../lib/normalize.js';
import { isValidTimeZone } from '../lib/timezone.js';
import { ah } from '../lib/asyncHandler.js';
import { resolveSchedule, dayClosesAt, REOPEN_DEFAULT_HOURS, REOPEN_MAX_HOURS } from '../lib/days.js';
import { EVENT_LINK_VISIBILITY_MS } from '../lib/constants.js';
import { bucketByDay, countsByKey, summarizeDays } from '../lib/analytics.js';
import { doorStampDataUri, clockInZone } from '../lib/stamp.js';
import { loadClaimPackData } from '../lib/integrity.js';
import { sanitizeScanTime, indexByIdHash, resolveAttendee, sha256Hex } from '../lib/doorsync.js';
import { notifyDaySigned } from './public.js';
import QRCode from 'qrcode';

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
    certificatesEnabled: ev.certificatesEnabled,
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
  // On unless the admin switches it off.
  const certificatesEnabled = body.certificatesEnabled !== false;
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

  return { name, description, startAt, endAt, timezone, locationType, address, latitude, longitude, meetingLink, certificatesEnabled, missing };
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
    where: { county: req.user.county, ownerId: req.user.id, departmentId: req.user.departmentId, deletedAt: null },
    orderBy: { createdAt: 'desc' },
    include: {
      _count: { select: { attendance: true } },
      days: { orderBy: { position: 'asc' }, select: { id: true, position: true, startAt: true, endAt: true, reopenedUntil: true } }
    }
  });
  res.json({ ok: true, events: events.map((ev) => ({ ...publicEvent(ev, ev._count.attendance), days: ev.days })) });
}));

// Aggregate-only: counts and day buckets, never a list of who's in them --
// the roster itself already carries that (via the sealed roster's own
// admin-scoped view). Answers "how is this county's attendance trending"
// without adding a second way to browse individual attendees.
adminRouter.get('/analytics', ah(async (req, res) => {
  const events = await prisma.event.findMany({
    where: { county: req.user.county, ownerId: req.user.id, departmentId: req.user.departmentId, deletedAt: null },
    select: { id: true }
  });
  const eventIds = events.map((e) => e.id);
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  const [statusGroups, consentGroups, recent] = await Promise.all([
    prisma.attendance.groupBy({ by: ['status'], where: { eventId: { in: eventIds } }, _count: { _all: true } }),
    prisma.attendance.groupBy({ by: ['photoVideoConsent'], where: { eventId: { in: eventIds } }, _count: { _all: true } }),
    prisma.attendance.findMany({ where: { eventId: { in: eventIds }, createdAt: { gte: since } }, select: { createdAt: true } })
  ]);

  res.json({
    ok: true,
    totalEvents: events.length,
    byStatus: countsByKey(statusGroups, ['ACTIVE', 'FLAGGED_FOR_REMOVAL', 'RETIRED'], 'status'),
    byConsent: countsByKey(consentGroups, [true, false, null], 'photoVideoConsent'),
    trend: bucketByDay(recent.map((r) => r.createdAt), 30)
  });
}));

adminRouter.post('/events', ah(async (req, res) => {
  const f = requireEventFields(req.body);
  const err = validateEventFields(f);
  if (err) return res.status(400).json(err);
  // The date picker already blocks past days client-side; the check below
  // is the server-side backstop so the restriction can't be skipped by
  // calling the API directly. Only enforced on create -- editing an event
  // that already has a past start time (from before this check existed, or
  // simply because it's already underway) must stay possible without
  // forcing its time to change.
  const sched = resolveSchedule(req.body, f);
  if (sched.error) return res.status(400).json({ ok: false, error: 'INVALID_DAYS', message: sched.error });
  const { days, startAt, endAt } = sched;
  if (startAt.getTime() < Date.now()) {
    return res.status(400).json({ ok: false, error: 'PAST_DATE', message: 'Event start can\'t be in the past.' });
  }

  const event = await prisma.event.create({
    data: {
      slug: eventSlugId(f.name), name: f.name, description: f.description,
      startAt, endAt, timezone: f.timezone,
      locationType: f.locationType, address: f.address, latitude: f.latitude, longitude: f.longitude, meetingLink: f.meetingLink, certificatesEnabled: f.certificatesEnabled,
      county: req.user.county, ownerId: req.user.id, departmentId: req.user.departmentId,
      days: { create: days.map((d, i) => ({ position: i + 1, startAt: d.startAt, endAt: d.endAt })) }
    }
  });
  await writeAudit({
    actorId: req.user.id, action: 'EVENT_CREATE', targetType: 'Event', targetId: event.id,
    metadata: { name: f.name, startAt, endAt, dayCount: days.length, timezone: f.timezone, locationType: f.locationType, address: f.address, meetingLink: f.meetingLink },
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

// Rendered entirely on this server (the `qrcode` package, a local library
// with no network calls of its own) rather than by pointing an <img> at a
// third-party QR-rendering API -- the previous approach handed every
// event's real sign-in URL to api.qrserver.com on every view, which is
// exactly the kind of unnecessary third party this pilot otherwise avoids.
// PUBLIC_APP_URL is reused unchanged from the activation/reset-link
// construction elsewhere (auth.js, superadmin.js) rather than trusting
// anything from the request, so this can't be made to encode an arbitrary
// URL by a caller.
adminRouter.get('/events/:id/qr', ah(async (req, res) => {
  const event = await findOwnEvent(req);
  if (!event) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });

  const url = `${process.env.PUBLIC_APP_URL}/index.html?event=${encodeURIComponent(event.slug)}`;
  const png = await QRCode.toBuffer(url, { width: 180, margin: 1 });
  res.set('Content-Type', 'image/png');
  res.set('Cache-Control', 'private, max-age=3600');
  res.send(png);
}));

adminRouter.put('/events/:id', ah(async (req, res) => {
  const event = await findOwnEvent(req);
  if (!event) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });

  const f = requireEventFields(req.body);
  const err = validateEventFields(f);
  if (err) return res.status(400).json(err);

  const sched = resolveSchedule(req.body, f);
  if (sched.error) return res.status(400).json({ ok: false, error: 'INVALID_DAYS', message: sched.error });

  // Days are matched by position. A day that disappears from the schedule
  // is only dropped if nobody signed it and no sheet was sealed for it --
  // otherwise those signatures would be lost from the record.
  const existingDays = await prisma.eventDay.findMany({
    where: { eventId: event.id },
    orderBy: { position: 'asc' },
    include: { _count: { select: { signatures: true, seals: true } } }
  });
  const dropped = existingDays.filter((d) => d.position > sched.days.length);
  const blocked = dropped.filter((d) => d._count.signatures > 0 || d._count.seals > 0);
  if (blocked.length) {
    const n = blocked.reduce((sum, d) => sum + d._count.signatures, 0);
    return res.status(409).json({
      ok: false,
      error: 'DAYS_HAVE_SIGNATURES',
      message: `Day ${blocked.map((d) => d.position).join(', ')} already has ${n} signature(s) or a sealed sheet, so it can't be removed. Keep those days in the schedule.`
    });
  }

  const before = {
    name: event.name, description: event.description, startAt: event.startAt, endAt: event.endAt,
    timezone: event.timezone, locationType: event.locationType, address: event.address, meetingLink: event.meetingLink
  };
  const after = {
    name: f.name, description: f.description, startAt: sched.startAt, endAt: sched.endAt,
    timezone: f.timezone, locationType: f.locationType, address: f.address, meetingLink: f.meetingLink
  };
  // latitude/longitude are a full replace too (kept out of the audit
  // snapshot above since they're a derived precision detail, not
  // something a reviewer needs to see change) -- omitting them from the
  // update would leave a stale pin attached to whatever address used to
  // be here if this edit changed the address without re-picking a map
  // suggestion.
  const have = new Set(existingDays.map((d) => d.position));
  const updated = await prisma.$transaction(async (tx) => {
    if (dropped.length) await tx.eventDay.deleteMany({ where: { id: { in: dropped.map((d) => d.id) } } });
    for (const [i, d] of sched.days.entries()) {
      const position = i + 1;
      if (have.has(position)) {
        await tx.eventDay.updateMany({ where: { eventId: event.id, position }, data: { startAt: d.startAt, endAt: d.endAt } });
      } else {
        await tx.eventDay.create({ data: { eventId: event.id, position, startAt: d.startAt, endAt: d.endAt } });
      }
    }
    return tx.event.update({
      where: { id: event.id },
      data: { ...after, latitude: f.latitude, longitude: f.longitude, certificatesEnabled: f.certificatesEnabled }
    });
  });
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
    photoVideoConsent: r.photoVideoConsent,
    signedDays: (r.daySignatures || []).map((s) => ({ dayId: s.dayId, signedAt: s.signedAt, method: s.method }))
  };
}

// Returns the attendance rows for a given event, in chronological order.
adminRouter.get('/events/:id/attendance', ah(async (req, res) => {
  const event = await findOwnEvent(req);
  if (!event) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });

  const [attendance, days] = await Promise.all([
    prisma.attendance.findMany({
      where: { eventId: event.id },
      orderBy: { createdAt: 'asc' },
      include: { daySignatures: { select: { dayId: true, signedAt: true, method: true } } }
    }),
    prisma.eventDay.findMany({ where: { eventId: event.id }, orderBy: { position: 'asc' } })
  ]);
  await writeAudit({
    actorId: req.user.id,
    action: 'EVENT_ATTENDANCE_EXPORTED',
    targetType: 'Event',
    targetId: event.id,
    metadata: { name: event.name, rowCount: attendance.length },
    req
  });

  res.json({
    ok: true,
    event: publicEvent(event),
    days: days.map((d) => ({ id: d.id, position: d.position, startAt: d.startAt, endAt: d.endAt })),
    rows: attendance.map(attendanceRow)
  });
}));

// Only the event's own admin can seal, the same ownership rule as every
// other write on an event. Sealing is optional: an unsealed sheet prints
// and exports exactly as before.
adminRouter.post('/events/:id/days/:dayId/seal', ah(async (req, res) => {
  const event = await findOwnEvent(req);
  if (!event) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });

  const day = await prisma.eventDay.findFirst({ where: { id: req.params.dayId, eventId: event.id } });
  if (!day) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });

  const snapshot = await buildDaySnapshot(event, day);
  const digest = digestOf(snapshot);
  const code = newSealCode();
  const seal = await prisma.sheetSeal.create({
    data: { id: code, eventId: event.id, dayId: day.id, digest, snapshot, sealedById: req.user.id }
  });
  await writeAudit({
    actorId: req.user.id,
    action: 'SHEET_SEALED',
    targetType: 'SheetSeal',
    targetId: code,
    metadata: { digest, eventId: event.id, dayId: day.id, rowCount: snapshot.rows.length },
    req
  });

  res.json({
    ok: true,
    code,
    digest,
    sealedAt: seal.createdAt,
    verifyUrl: `${process.env.PUBLIC_APP_URL}/verify.html?code=${code}`
  });
}));

// Seals every day of the event as one sheet with one code, the way the printed
// multi-day sheet reads. The per-day route above stays for older callers.
// Lets the organiser reopen a day whose signing window has closed, for a
// limited time, e.g. when the network was down at the venue. Always audited.
adminRouter.post('/events/:id/days/:dayId/reopen', ah(async (req, res) => {
  const event = await findOwnEvent(req);
  if (!event) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });
  const day = await prisma.eventDay.findFirst({ where: { id: req.params.dayId, eventId: event.id } });
  if (!day) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });

  const hours = Math.min(REOPEN_MAX_HOURS, Math.max(1, Math.round(Number(req.body.hours)) || REOPEN_DEFAULT_HOURS));
  const reopenedUntil = new Date(Date.now() + hours * 60 * 60 * 1000);
  const updated = await prisma.eventDay.update({ where: { id: day.id }, data: { reopenedUntil } });
  await writeAudit({
    actorId: req.user.id, action: 'DAY_REOPENED', targetType: 'EventDay', targetId: day.id,
    metadata: { eventId: event.id, position: day.position, hours, reopenedUntil }, req
  });
  res.json({ ok: true, reopenedUntil, closesAt: dayClosesAt(updated) });
}));

// Seals every day of the event as one record and writes it to the audit chain.
// Shared by the plain "Seal & print" route and by claim-pack approval.
async function sealWholeEvent(event, req) {
  const days = await prisma.eventDay.findMany({ where: { eventId: event.id }, orderBy: { position: 'asc' } });
  if (!days.length) return null;
  const snapshot = await buildEventSnapshot(event, days);
  const digest = digestOf(snapshot);
  const code = newSealCode();
  const seal = await prisma.sheetSeal.create({
    data: { id: code, eventId: event.id, dayId: null, digest, snapshot, sealedById: req.user.id }
  });
  await writeAudit({
    actorId: req.user.id,
    action: 'SHEET_SEALED',
    targetType: 'SheetSeal',
    targetId: code,
    metadata: { digest, eventId: event.id, scope: 'EVENT', dayCount: days.length, rowCount: snapshot.days[0].rows.length },
    req
  });
  return {
    code,
    digest,
    dayCount: days.length,
    sealedAt: seal.createdAt,
    verifyUrl: `${process.env.PUBLIC_APP_URL}/verify.html?code=${code}`
  };
}

adminRouter.post('/events/:id/seal', ah(async (req, res) => {
  const event = await findOwnEvent(req);
  if (!event) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });
  const sealed = await sealWholeEvent(event, req);
  if (!sealed) return res.status(400).json({ ok: false, error: 'NO_DAYS', message: 'This event has no day to seal.' });
  res.json({ ok: true, ...sealed });
}));

// --- Claim pack: the attendance record in a form a finance office or auditor
// can check, with an integrity report and a recorded approval. ---
// Names and phone numbers leave the system here, exactly as they do in an
// export, so generating one is audited the same way.
adminRouter.get('/events/:id/claim-pack', ah(async (req, res) => {
  const event = await findOwnEvent(req);
  if (!event) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });

  const data = await loadClaimPackData(event);
  const [seal, approval] = await Promise.all([
    prisma.sheetSeal.findFirst({ where: { eventId: event.id, dayId: null }, orderBy: { createdAt: 'desc' } }),
    prisma.auditLog.findFirst({ where: { action: 'CLAIM_PACK_APPROVED', targetType: 'Event', targetId: event.id }, orderBy: { createdAt: 'desc' } })
  ]);
  await writeAudit({
    actorId: req.user.id,
    action: 'CLAIM_PACK_GENERATED',
    targetType: 'Event',
    targetId: event.id,
    metadata: { name: event.name, rowCount: data.people.length },
    req
  });

  res.json({
    ok: true,
    event: { ...publicEvent(event), county: event.county },
    days: data.days.map((d) => ({ id: d.id, position: d.position, startAt: d.startAt, endAt: d.endAt })),
    matrix: data.matrix,
    findings: data.findings,
    retiredCount: data.retiredCount,
    seal: seal ? { code: seal.id, sealedAt: seal.createdAt, verifyUrl: `${process.env.PUBLIC_APP_URL}/verify.html?code=${seal.id}` } : null,
    approval: approval
      ? { by: approval.actorEmail, at: approval.createdAt, note: approval.metadata?.note || '', sealCode: approval.metadata?.sealCode || null }
      : null
  });
}));

// Approving seals the record and writes who approved it, when, and what the
// integrity report said at that moment. Review items must be acknowledged: the
// approver is saying they looked, so the log can show it.
adminRouter.post('/events/:id/claim-pack/approve', ah(async (req, res) => {
  const event = await findOwnEvent(req);
  if (!event) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });

  const data = await loadClaimPackData(event);
  const review = data.findings.filter((f) => f.severity === 'review').length;
  const notes = data.findings.length - review;
  if (!data.people.length) return res.status(400).json({ ok: false, error: 'EMPTY', message: 'There is nobody on this event yet, so there is nothing to approve.' });
  if (review > 0 && req.body.acknowledge !== true) {
    return res.status(400).json({ ok: false, error: 'REVIEW_REQUIRED', message: `Tick the box to confirm you have reviewed the ${review} item${review === 1 ? '' : 's'} flagged for review.` });
  }

  const sealed = await sealWholeEvent(event, req);
  if (!sealed) return res.status(400).json({ ok: false, error: 'NO_DAYS', message: 'This event has no day to seal.' });
  const note = String(req.body.note || '').trim().slice(0, 500);
  await writeAudit({
    actorId: req.user.id,
    action: 'CLAIM_PACK_APPROVED',
    targetType: 'Event',
    targetId: event.id,
    metadata: { sealCode: sealed.code, note, review, notes, people: data.people.length, acknowledged: review > 0 },
    req
  });
  res.json({ ok: true, code: sealed.code, sealedAt: sealed.sealedAt, verifyUrl: sealed.verifyUrl });
}));

// Counts only: how many signed each day, by how, and how many are missing.
// Feeds the dashboard's day-by-day chart.
adminRouter.get('/events/:id/days-summary', ah(async (req, res) => {
  const event = await findOwnEvent(req);
  if (!event) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });
  const [days, groups, registered] = await Promise.all([
    prisma.eventDay.findMany({ where: { eventId: event.id }, orderBy: { position: 'asc' } }),
    prisma.sessionSignature.groupBy({
      by: ['dayId', 'method'],
      where: { day: { eventId: event.id }, attendance: { status: { not: 'RETIRED' } } },
      _count: { _all: true }
    }),
    prisma.attendance.count({ where: { eventId: event.id, status: { not: 'RETIRED' } } })
  ]);
  res.json({ ok: true, registered, days: summarizeDays(days, groups, registered) });
}));

// Door check-in: the organiser scans an attendee's personal pass and the day is
// recorded as method DOOR with a "scanned" stamp in place of a drawn signature.
// Only the event's own admin can do this, and every one is audited. Idempotent
// per person per day. The scan time is the moment of the scan, which for a
// phone that was offline is earlier than the moment it reached the server.
async function doorCheckInOne({ event, day, attendee, scannedAt, req }) {
  const who = { name: attendee.name, organization: attendee.organization };
  if (attendee.status === 'RETIRED') return { ok: false, error: 'RETIRED', message: `${attendee.name} has been retired from this event.` };

  const existing = await prisma.sessionSignature.findUnique({ where: { attendanceId_dayId: { attendanceId: attendee.id, dayId: day.id } } });
  if (existing) return { ok: true, duplicate: true, ...who };

  let sig;
  try {
    sig = await prisma.sessionSignature.create({
      data: {
        attendanceId: attendee.id,
        dayId: day.id,
        method: 'DOOR',
        signedAt: scannedAt,
        signature: doorStampDataUri(clockInZone(scannedAt, event.timezone))
      }
    });
  } catch (err) {
    if (err?.code === 'P2002') return { ok: true, duplicate: true, ...who };
    throw err;
  }
  await writeAudit({
    actorId: req.user.id,
    action: 'DAY_CHECKIN_DOOR',
    targetType: 'Attendance',
    targetId: attendee.id,
    metadata: { eventId: event.id, dayId: day.id, position: day.position, scannedAt, offline: Date.now() - scannedAt.getTime() > 60 * 1000 },
    req
  });
  notifyDaySigned(attendee, event, day, sig);
  return { ok: true, ...who };
}

adminRouter.post(
  '/events/:id/days/:dayId/door-checkin',
  ah(async (req, res) => {
    const event = await findOwnEvent(req);
    if (!event) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });
    const day = await prisma.eventDay.findFirst({ where: { id: req.params.dayId, eventId: event.id } });
    if (!day) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });

    const when = sanitizeScanTime(req.body.scannedAt);
    if (!when.ok) return res.json({ ok: false, error: when.error, message: 'That scan is more than a week old and was not recorded.' });

    const index = indexByIdHash(await prisma.attendance.findMany({ where: { eventId: event.id } }));
    const attendee = resolveAttendee(index, { clientId: req.body.clientId, idHash: req.body.idHash });
    if (!attendee) return res.json({ ok: false, error: 'NOT_FOUND', message: 'That pass does not belong to this event.' });

    res.json(await doorCheckInOne({ event, day, attendee, scannedAt: when.at, req }));
  })
);

// Syncs a queue of scans made while offline. Each scan is judged on its own and
// answered in the same order, so one bad scan never blocks the rest.
const MAX_BATCH_SCANS = 200;
adminRouter.post(
  '/events/:id/door-checkins',
  ah(async (req, res) => {
    const event = await findOwnEvent(req);
    if (!event) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });
    const scans = Array.isArray(req.body.scans) ? req.body.scans.slice(0, MAX_BATCH_SCANS) : [];

    const [days, attendance] = await Promise.all([
      prisma.eventDay.findMany({ where: { eventId: event.id } }),
      prisma.attendance.findMany({ where: { eventId: event.id } })
    ]);
    const dayById = new Map(days.map((d) => [d.id, d]));
    const index = indexByIdHash(attendance);

    const results = [];
    for (const scan of scans) {
      const day = dayById.get(String(scan.dayId || ''));
      const when = sanitizeScanTime(scan.scannedAt);
      const attendee = resolveAttendee(index, { idHash: scan.idHash });
      if (!day) results.push({ ok: false, error: 'UNKNOWN_DAY', message: 'That day is no longer part of this event.' });
      else if (!when.ok) results.push({ ok: false, error: when.error, message: 'More than a week old, so it was not recorded.' });
      else if (!attendee) results.push({ ok: false, error: 'NOT_FOUND', message: 'That pass does not belong to this event.' });
      else results.push(await doorCheckInOne({ event, day, attendee, scannedAt: when.at, req }));
    }
    res.json({ ok: true, results });
  })
);

// The guest list for scanning without signal: each person by the fingerprint of
// their pass (never the pass itself), with the days they are already in for.
// Admin only and audited, since names leave the server.
adminRouter.get(
  '/events/:id/door-roster',
  ah(async (req, res) => {
    const event = await findOwnEvent(req);
    if (!event) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });
    const [days, attendance] = await Promise.all([
      prisma.eventDay.findMany({ where: { eventId: event.id }, orderBy: { position: 'asc' } }),
      prisma.attendance.findMany({
        where: { eventId: event.id, status: { not: 'RETIRED' } },
        include: { daySignatures: { select: { dayId: true } } }
      })
    ]);
    await writeAudit({
      actorId: req.user.id,
      action: 'DOOR_ROSTER_DOWNLOADED',
      targetType: 'Event',
      targetId: event.id,
      metadata: { name: event.name, rowCount: attendance.length },
      req
    });
    res.json({
      ok: true,
      savedAt: new Date().toISOString(),
      days: days.map((d) => ({ id: d.id, position: d.position, startAt: d.startAt, endAt: d.endAt })),
      people: attendance.map((a) => ({
        h: sha256Hex(a.clientId),
        name: a.name,
        organization: a.organization || '',
        signedDayIds: a.daySignatures.map((s) => s.dayId)
      }))
    });
  })
);

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
