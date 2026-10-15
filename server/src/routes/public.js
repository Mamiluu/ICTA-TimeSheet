// Copyright (c) 2026 Asya Hafidh <msanifuasiya@gmail.com>. All Rights Reserved.
// Proprietary and confidential. See LICENSE in the repository root.

import { Router } from 'express';
import { Prisma } from '@prisma/client';
import QRCode from 'qrcode';
import { prisma } from '../lib/prisma.js';
import { normalizePhone, normalizeEmail, isValidEmailShape } from '../lib/normalize.js';
import { attendanceLimiter, checkInLimiter } from '../middleware/rateLimit.js';
import { ah } from '../lib/asyncHandler.js';
import { MAX_ATTENDANCE_PER_EVENT, SIGNATURE_REQUEST_TTL_MS, EVENT_LINK_VISIBILITY_MS } from '../lib/constants.js';
import { randomToken, hashToken } from '../lib/tokens.js';
import { writeAudit, verifyChain } from '../lib/audit.js';
import { sendAttendanceConfirmationEmail } from '../lib/mailer.js';
import { logger } from '../lib/logger.js';
import { BRANDING } from '../lib/branding.js';
import { dayIsOpen, dayOpensAt, dayClosesAt, ensureFirstDay, pickSigningDay, anchorDayFor } from '../lib/days.js';
import { maskName } from '../lib/mask.js';
import { walletEntry } from '../lib/wallet.js';
import { certificateEligible, loadCertificateSnapshot, certificateStillHolds, publicCertificateView } from '../lib/certificate.js';
import { canAccessKind, dayStatus, STAGE_LABEL } from '../lib/duty.js';
import { newSealCode, SEAL_CODE_PATTERN, buildDaySnapshot, buildEventSnapshot, summarizeSnapshot, digestOf } from '../lib/seal.js';

// Fire-and-forget, same discipline as writeAudit's own .catch(() => {})
// below: a Brevo outage or a malformed address must never fail the
// attendee's actual sign-in, which already succeeded by the time this
// runs. Every county's events flow through this one route, so this is the
// only place this needs wiring up, not per-admin config.
// day (an EventDay plus the event's total day count) is passed for a
// multi-day event so the receipt says which day was recorded.
function sendConfirmationIfEmailed(row, event, day, dayCount, recordedAt) {
  if (!row.email || !isValidEmailShape(row.email)) return;
  sendAttendanceConfirmationEmail(row.email, {
    name: row.name,
    eventName: event.name,
    eventDescription: event.description,
    startAt: day ? day.startAt : event.startAt,
    endAt: day ? day.endAt : event.endAt,
    dayPosition: day ? day.position : undefined,
    dayCount,
    passUrl: dayCount > 1 ? `${process.env.PUBLIC_APP_URL}/index.html?event=${encodeURIComponent(event.slug)}&pass=${encodeURIComponent(row.clientId)}` : undefined,
    timezone: event.timezone,
    locationType: event.locationType,
    address: event.address,
    meetingLink: event.meetingLink,
    county: event.county,
    recordId: row.id,
    recordedAt: recordedAt || row.createdAt
  }).catch((err) => logger.error('attendance confirmation email failed', { stack: err.stack }));
}

export const publicRouter = Router();

// The client already refuses to let a visitor save a blank canvas (see the
// hasInk latch in index.html's signature modal), but that is a UX guard
// running in a browser we don't control -- a stale cached copy of the page,
// a direct API call, or any future client that skips it would otherwise
// still get a row written with signature: ''. This is the actual
// enforcement boundary: reject anything that isn't a real drawn signature,
// regardless of what submitted it.
export function isBlankSignature(signature) {
  const s = String(signature || '').trim();
  return !s || s.length < 100 || !s.startsWith('data:image/');
}

// Same enforcement-boundary reasoning as isBlankSignature above: the
// client already disables Submit until the attendee has picked "Yes" or
// "No" (see the consent radio pair in index.html), but that's a UX guard
// running in a browser we don't control. This is what actually stops a
// row from ever being created or edited with consent left unanswered --
// true/false is a real answer either way, anything else (missing,
// omitted, a stray string) is rejected outright. null only ever exists on
// rows that predate this column (see the schema.prisma comment); no live
// submission can produce one.
export function isValidConsentAnswer(value) {
  return typeof value === 'boolean';
}

// Name, organization and a well-formed email are required on every entry,
// same as the sign-in form enforces client-side. Returns the first missing
// field's label, or null when all are present.
export function missingAttendeeField(body) {
  if (!String(body.name || '').trim()) return 'name';
  if (!String(body.org || '').trim()) return 'organization';
  if (!isValidEmailShape(String(body.email || '').trim())) return 'email address';
  return null;
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
    signedDayIds: (r.daySignatures || []).map((s) => s.dayId),
    daySignatures: (r.daySignatures || []).map((s) => ({ dayId: s.dayId, signature: s.signature, method: s.method })),
    status: r.status,
    statusReason: r.statusReason,
    statusAt: r.statusAt,
    photoVideoConsent: r.photoVideoConsent
  };
}

// Same shape as publicRow, but for the one endpoint (my-attendance below)
// where echoing clientId back is safe: the caller had to already know it to
// ask the question in the first place, so this never teaches anyone
// anything they didn't already know about their own row.
function ownRow(r) {
  return { ...publicRow(r), clientId: r.clientId };
}

// Anchored to the event's own `endAt`, not createdAt -- an admin routinely
// creates an event days or weeks ahead of when it actually happens, and
// anchoring to creation time would let the window lapse before the event
// even took place. The link is still open for sign-ins from the moment
// the event is created (no lower bound), it just keeps counting the
// close-by point from the event's actual end time, not from whenever the
// admin happened to set it up.
function linkClosesAt(event) {
  return new Date(event.endAt.getTime() + EVENT_LINK_VISIBILITY_MS);
}

function isLinkExpired(event) {
  return Date.now() > linkClosesAt(event).getTime();
}

// Shared by both the expired and the normal branch of GET /events/:slug
// below, so the two never drift into showing a different field set for
// the same event depending on whether its link happens to still be open.
function publicEventMeta(event) {
  return {
    id: event.slug,
    name: event.name,
    description: event.description,
    startAt: event.startAt,
    endAt: event.endAt,
    timezone: event.timezone,
    locationType: event.locationType,
    address: event.address,
    latitude: event.latitude,
    longitude: event.longitude,
    meetingLink: event.meetingLink,
    certificatesEnabled: event.certificatesEnabled,
    kind: event.kind
  };
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
  // A department super admin manages their own department's events only.
  if (user.role === 'SUPER_ADMIN') return !!user.departmentId && user.departmentId === event.departmentId;
  // County alone isn't enough now that a county can have multiple active
  // admins (see the per-county cap migration, which lets Nairobi run up to
  // 3) -- without also checking ownerId here, any of that county's admins
  // could manage every other one's events, not just their own.
  return user.role === 'COUNTY_ADMIN' && user.county === event.county && event.ownerId === user.id && canAccessKind(user, event.kind);
}

// Static, non-secret config -- letterhead text/contact details, not the
// logo image itself (see the comment on lib/branding.js for why that part
// isn't included). No auth guard: this is the same information already
// printed on the sign-in page for anyone at the venue to read.
publicRouter.get('/branding', (req, res) => {
  res.json({ ok: true, ...BRANDING });
});

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
      event: publicEventMeta(event),
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
  // A retired row (duplicate, fraudulent entry, etc.) no longer occupies a
  // seat -- it stays in the roster for the owning admin (manage=true, see
  // below) but doesn't count toward the capacity a plain visitor sees.
  const [submittedCount, attendance, days] = await Promise.all([
    prisma.attendance.count({ where: { eventId: event.id, status: { not: 'RETIRED' } } }),
    manage
      ? prisma.attendance.findMany({
          where: { eventId: event.id },
          orderBy: { createdAt: 'asc' },
          include: { daySignatures: { select: { dayId: true, signature: true, method: true } } }
        })
      : Promise.resolve([]),
    prisma.eventDay.findMany({ where: { eventId: event.id }, orderBy: { position: 'asc' } })
  ]);

  res.json({
    ok: true,
    event: publicEventMeta(event),
    days: days.map((d) => ({
      id: d.id,
      position: d.position,
      startAt: d.startAt,
      endAt: d.endAt,
      place: d.place,
      opensAt: dayOpensAt(d),
      closesAt: dayClosesAt(d),
      open: dayIsOpen(d)
    })),
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

// What a person on a payment sheet needs to sign: the engagement name and each
// day with its date, place and whether signing is open. No names, no counts.
publicRouter.get('/duty/:slug', ah(async (req, res) => {
  const event = await prisma.event.findUnique({ where: { slug: req.params.slug } });
  if (!event || event.deletedAt || event.kind !== 'DUTY_ROLL') return res.status(404).json({ ok: false, error: 'NOT_FOUND' });
  const days = await prisma.eventDay.findMany({ where: { eventId: event.id }, orderBy: { position: 'asc' } });
  res.json({
    ok: true,
    event: { name: event.name, description: event.description, timezone: event.timezone },
    days: days.map((d) => ({ id: d.id, position: d.position, startAt: d.startAt, endAt: d.endAt, place: d.place, open: dayIsOpen(d), status: dayStatus(d, false) }))
  });
}));

// A person on a payment sheet looking at their own days, and raising a question about
// one. Same proof as signing: the phone number they were registered with. The answer
// is days and status only, never a rate or an amount.
async function findDutyPayee(req) {
  const event = await prisma.event.findUnique({ where: { slug: req.params.slug } });
  if (!event || event.deletedAt || event.kind !== 'DUTY_ROLL') return { status: 404, body: { ok: false, error: 'NOT_FOUND' } };
  const phoneNormalized = normalizePhone(String(req.body.phone || ''));
  if (!phoneNormalized) return { status: 200, body: { ok: false, error: 'INVALID_PHONE', message: 'Enter a valid Kenyan phone number.' } };
  const attendee = await prisma.attendance.findUnique({
    where: { eventId_phoneNormalized: { eventId: event.id, phoneNormalized } },
    include: { dutyPayee: true, daySignatures: { select: { dayId: true } } }
  });
  if (!attendee || attendee.status === 'RETIRED' || !attendee.dutyPayee) {
    return { status: 200, body: { ok: false, error: 'NOT_REGISTERED', message: 'We could not find that number on this sheet.' } };
  }
  return { event, attendee };
}

publicRouter.post('/duty/:slug/mine', checkInLimiter, ah(async (req, res) => {
  const found = await findDutyPayee(req);
  if (found.body) return res.status(found.status).json(found.body);
  const { event, attendee } = found;
  const [days, queries] = await Promise.all([
    prisma.eventDay.findMany({ where: { eventId: event.id }, orderBy: { position: 'asc' } }),
    prisma.dutyQuery.findMany({ where: { payeeId: attendee.dutyPayee.id }, orderBy: { createdAt: 'desc' } })
  ]);
  const signed = new Set(attendee.daySignatures.map((s) => s.dayId));
  res.json({
    ok: true,
    maskedName: maskName(attendee.name),
    stage: event.dutyStage,
    stageLabel: STAGE_LABEL[event.dutyStage],
    days: days.map((d) => ({ id: d.id, position: d.position, startAt: d.startAt, place: d.place, status: dayStatus(d, signed.has(d.id)) })),
    queries: queries.map((q) => ({ dayId: q.dayId, message: q.message, status: q.status, response: q.response }))
  });
}));

publicRouter.post('/duty/:slug/query', checkInLimiter, ah(async (req, res) => {
  const found = await findDutyPayee(req);
  if (found.body) return res.status(found.status).json(found.body);
  const { event, attendee } = found;
  if (event.dutyStage !== 'OPEN' && event.dutyStage !== 'SUBMITTED') {
    return res.json({ ok: false, error: 'TOO_LATE', message: 'This sheet has already been certified. Speak to the organiser.' });
  }
  const day = await prisma.eventDay.findFirst({ where: { id: String(req.body.dayId || ''), eventId: event.id } });
  if (!day) return res.json({ ok: false, error: 'UNKNOWN_DAY', message: 'That day is not part of this sheet.' });
  const signed = attendee.daySignatures.some((s) => s.dayId === day.id);
  if (dayStatus(day, signed) !== 'ABSENT') return res.json({ ok: false, error: 'NOT_DISPUTABLE', message: 'Only a day that closed without your signature can be queried.' });
  const message = String(req.body.message || '').replace(/\s+/g, ' ').trim().slice(0, 300);
  if (message.length < 5) return res.json({ ok: false, error: 'MESSAGE_REQUIRED', message: 'Say in a few words what happened on that day.' });
  const already = await prisma.dutyQuery.count({ where: { payeeId: attendee.dutyPayee.id, dayId: day.id, status: 'OPEN' } });
  if (already) return res.json({ ok: false, error: 'ALREADY_RAISED', message: 'You already have a question open for that day.' });

  const q = await prisma.dutyQuery.create({ data: { eventId: event.id, payeeId: attendee.dutyPayee.id, dayId: day.id, message } });
  await writeAudit({ actorId: null, action: 'DUTY_QUERY_RAISED', targetType: 'Attendance', targetId: attendee.id, metadata: { eventId: event.id, position: day.position, queryId: q.id }, req }).catch(() => {});
  res.json({ ok: true });
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

// Public check of a printed sheet's seal. Returns only counts and times, never
// names, phones, emails or signatures: the printout is in circulation, and
// the full record stays behind the admin's own session. Three separate
// checks, because each can fail independently: the stored snapshot still
// matches its digest, the audit entry for the seal is still intact, and the
// live data has or hasn't changed since sealing (a change is normal, not a
// failure, so it is reported as a note).
publicRouter.get('/seals/:code', attendanceLimiter, ah(async (req, res) => {
  const code = String(req.params.code || '').toUpperCase();
  if (!SEAL_CODE_PATTERN.test(code)) return res.json({ ok: false, error: 'NOT_FOUND' });

  const seal = await prisma.sheetSeal.findUnique({
    where: { id: code },
    include: { event: true, day: true }
  });
  if (!seal) return res.json({ ok: false, error: 'NOT_FOUND' });

  const auditEntry = await prisma.auditLog.findFirst({
    where: { action: 'SHEET_SEALED', targetType: 'SheetSeal', targetId: seal.id }
  });
  // A whole-event seal has no single day; compare against every day as it is
  // now, so a change on any day shows as "changed since sealed".
  const live = seal.day
    ? await buildDaySnapshot(seal.event, seal.day)
    : await buildEventSnapshot(seal.event, await prisma.eventDay.findMany({ where: { eventId: seal.eventId } }));
  const summary = summarizeSnapshot(seal.snapshot);

  res.json({
    ok: true,
    sealedAt: seal.createdAt,
    eventName: seal.event.name,
    scope: summary.scope,
    days: summary.days,
    dayCount: summary.days.length,
    dayPosition: seal.day ? seal.day.position : null,
    rowCount: summary.days[0].rowCount,
    signedCount: summary.days.reduce((n, d) => n + d.signedCount, 0),
    recordMatchesSeal: digestOf(seal.snapshot) === seal.digest,
    auditTrailIntact: !!auditEntry && verifyChain([auditEntry])[0],
    changedSinceSealed: digestOf(live) !== seal.digest
  });
}));

publicRouter.get('/seals/:code/qr', attendanceLimiter, ah(async (req, res) => {
  const code = String(req.params.code || '').toUpperCase();
  if (!SEAL_CODE_PATTERN.test(code)) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });
  const seal = await prisma.sheetSeal.findUnique({ where: { id: code }, select: { id: true } });
  if (!seal) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });

  const png = await QRCode.toBuffer(`${process.env.PUBLIC_APP_URL}/verify.html?code=${code}`, { width: 120, margin: 1 });
  res.set('Content-Type', 'image/png');
  res.set('Cache-Control', 'public, max-age=86400');
  res.send(png);
}));

// --- "My events on this device" ---
// The attendee page keeps each pass id in the browser that signed in. This
// route takes the ones a browser holds and answers for each: how far along the
// event is, how many days were signed, and the certificate if there is one.
// Presenting a pass id is the proof of being on that event (the same proof as
// everywhere else), so an unknown or stale pair is simply left out, and the
// answer never contains phone, email or signatures.
const MAX_WALLET_PASSES = 50;
publicRouter.post(
  '/wallet',
  attendanceLimiter,
  ah(async (req, res) => {
    const passes = Array.isArray(req.body.passes) ? req.body.passes.slice(0, MAX_WALLET_PASSES) : [];
    const events = [];
    for (const pass of passes) {
      const slug = String(pass?.slug || '');
      const clientId = String(pass?.clientId || '');
      if (!slug || !clientId) continue;
      const event = await prisma.event.findUnique({ where: { slug } });
      if (!event || event.deletedAt) continue;
      const attendee = await prisma.attendance.findUnique({ where: { eventId_clientId: { eventId: event.id, clientId } } });
      if (!attendee) continue;
      const [days, signedCount, certificate] = await Promise.all([
        prisma.eventDay.findMany({ where: { eventId: event.id }, orderBy: { position: 'asc' } }),
        prisma.sessionSignature.count({ where: { attendanceId: attendee.id } }),
        prisma.attendanceCertificate.findFirst({ where: { attendanceId: attendee.id }, orderBy: { issuedAt: 'desc' }, select: { id: true } })
      ]);
      const certificateReady = attendee.status !== 'RETIRED' && signedCount > 0 && certificateEligible(event, days);
      events.push(walletEntry({ event, attendee, days, signedCount, certificate, certificateReady }));
    }
    events.sort((a, b) => new Date(b.startAt).getTime() - new Date(a.startAt).getTime());
    res.json({ ok: true, events });
  })
);
// --- Certificates of attendance ---
// An attendee issues their own once the event's last day is over. clientId is
// the same proof of ownership as everywhere else. Issuing again with nothing
// changed returns the same code; signing another day afterwards produces a
// new one, and the earlier one stays valid for what it said.
publicRouter.post('/events/:slug/certificate', attendanceLimiter, ah(async (req, res) => {
  const event = await prisma.event.findUnique({ where: { slug: req.params.slug } });
  if (!event || event.deletedAt) return res.json({ ok: false, error: 'Unknown event' });

  const clientId = String(req.body.clientId || '');
  const attendee = clientId
    ? await prisma.attendance.findUnique({ where: { eventId_clientId: { eventId: event.id, clientId } } })
    : null;
  if (!attendee) return res.json({ ok: false, error: 'NOT_FOUND', message: 'Open this page on the device you signed in on, or use your personal pass link.' });
  if (attendee.status === 'RETIRED') return res.json({ ok: false, error: 'RETIRED', message: 'This entry has been retired, so no certificate can be issued.' });
  if (!event.certificatesEnabled) return res.json({ ok: false, error: 'DISABLED', message: 'The organiser has not enabled certificates for this event.' });

  const { days, snapshot } = await loadCertificateSnapshot(event, attendee);
  if (!certificateEligible(event, days)) {
    return res.json({ ok: false, error: 'NOT_YET', message: 'Certificates open once the last day of the event has ended.' });
  }
  if (!snapshot.days.length) return res.json({ ok: false, error: 'NO_DAYS', message: 'There is no signed day on this entry to certify.' });

  const digest = digestOf(snapshot);
  let cert = await prisma.attendanceCertificate.findUnique({ where: { attendanceId_digest: { attendanceId: attendee.id, digest } } });
  if (!cert) {
    cert = await prisma.attendanceCertificate.create({
      data: { id: newSealCode(), attendanceId: attendee.id, eventId: event.id, digest, snapshot }
    });
    await writeAudit({
      actorId: null, action: 'CERTIFICATE_ISSUED', targetType: 'AttendanceCertificate', targetId: cert.id,
      metadata: { digest, eventId: event.id, attendanceId: attendee.id, days: snapshot.days.length }, req
    }).catch(() => {});
  }
  res.json({ ok: true, code: cert.id });
}));

// Public check of a certificate. Shows what the certificate itself says (name,
// organisation, event, days) because the holder shares it on purpose, and
// never phone, email, signatures or ids. Status is judged against the live
// record: VALID, CHANGED (a listed day is no longer signed), WITHDRAWN (the
// entry was retired) or TAMPERED (the stored certificate no longer matches
// its own digest).
publicRouter.get('/certificates/:code', attendanceLimiter, ah(async (req, res) => {
  const code = String(req.params.code || '').toUpperCase();
  if (!SEAL_CODE_PATTERN.test(code)) return res.json({ ok: false, error: 'NOT_FOUND' });
  const cert = await prisma.attendanceCertificate.findUnique({ where: { id: code }, include: { event: true, attendance: true } });
  if (!cert) return res.json({ ok: false, error: 'NOT_FOUND' });

  const auditEntry = await prisma.auditLog.findFirst({ where: { action: 'CERTIFICATE_ISSUED', targetType: 'AttendanceCertificate', targetId: cert.id } });
  const recordMatches = digestOf(cert.snapshot) === cert.digest;
  const { snapshot: live } = await loadCertificateSnapshot(cert.event, cert.attendance);

  let status = 'VALID';
  if (!recordMatches) status = 'TAMPERED';
  else if (cert.attendance.status === 'RETIRED') status = 'WITHDRAWN';
  else if (!certificateStillHolds(cert.snapshot, live)) status = 'CHANGED';

  res.json({
    ok: true,
    code: cert.id,
    status,
    issuedAt: cert.issuedAt,
    auditTrailIntact: !!auditEntry && verifyChain([auditEntry])[0],
    certificate: publicCertificateView(cert.snapshot)
  });
}));

publicRouter.get('/certificates/:code/qr', attendanceLimiter, ah(async (req, res) => {
  const code = String(req.params.code || '').toUpperCase();
  if (!SEAL_CODE_PATTERN.test(code)) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });
  const cert = await prisma.attendanceCertificate.findUnique({ where: { id: code }, select: { id: true } });
  if (!cert) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });
  const png = await QRCode.toBuffer(`${process.env.PUBLIC_APP_URL}/certificate.html?code=${code}`, { width: 240, margin: 1 });
  res.set('Content-Type', 'image/png');
  res.set('Cache-Control', 'public, max-age=86400');
  res.send(png);
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
    where: { eventId: event.id, clientId: { in: clientIds } },
    include: { daySignatures: { select: { dayId: true, signature: true, method: true } } }
  });
  res.json({ ok: true, rows: rows.map(ownRow) });
}));

publicRouter.post('/events/:slug/attendance', attendanceLimiter, ah(async (req, res) => {
  const event = await prisma.event.findUnique({ where: { slug: req.params.slug } });
  if (!event || event.deletedAt) return res.json({ ok: false, error: 'Unknown event' });
  // A duty roll is a closed list: only people the organiser added can sign, so
  // nobody can register themselves onto a payment sheet.
  if (event.kind === 'DUTY_ROLL') {
    return res.json({ ok: false, error: 'CLOSED_ROSTER', message: 'This is a payment sheet for a named list of people. Ask the organiser to add you.' });
  }
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
  const missing = missingAttendeeField(req.body);
  if (missing) return res.json({ ok: false, error: 'MISSING_FIELD', message: `Please provide your ${missing}.` });
  if (isBlankSignature(req.body.signature)) {
    return res.json({ ok: false, error: 'MISSING_SIGNATURE', message: 'A signature is required — please draw it before submitting.' });
  }
  if (!isValidConsentAnswer(req.body.photoVideoConsent)) {
    return res.json({ ok: false, error: 'MISSING_CONSENT', message: 'Please indicate whether you consent to being photographed/recorded before submitting.' });
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
  // handful of rows past 500, not a broken guarantee. Retired rows are
  // excluded so retiring a duplicate/fraudulent entry frees its seat.
  const attendeeCount = await prisma.attendance.count({ where: { eventId: event.id, status: { not: 'RETIRED' } } });
  if (attendeeCount >= MAX_ATTENDANCE_PER_EVENT) {
    return res.json({ ok: false, error: 'EVENT_FULL', message: 'This event has reached its maximum of ' + MAX_ATTENDANCE_PER_EVENT + ' attendees.' });
  }

  // A new person signs the day they actually arrived on, not always day 1.
  await ensureFirstDay(event);
  const signingDay = pickSigningDay(await prisma.eventDay.findMany({ where: { eventId: event.id }, orderBy: { position: 'asc' } }));
  const signature = String(req.body.signature || '');

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
        signature,
        photoVideoConsent: req.body.photoVideoConsent,
        daySignatures: { create: { dayId: signingDay.id, signature } }
      }
    });
    const dayCount = await prisma.eventDay.count({ where: { eventId: event.id } });
    sendConfirmationIfEmailed(row, event, signingDay, dayCount);
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

// Signs a later day of a multi-day event. Same clientId proof as the
// self-edit route below: only the device that made the first sign-in can add
// signatures to that person's row. Only this route is windowed; the first
// sign-in above stays open for as long as the event link is.
publicRouter.post('/events/:slug/days/:dayId/signatures', attendanceLimiter, ah(async (req, res) => {
  const event = await prisma.event.findUnique({ where: { slug: req.params.slug } });
  if (!event || event.deletedAt) return res.json({ ok: false, error: 'Unknown event' });
  if (isLinkExpired(event)) {
    return res.json({ ok: false, error: 'LINK_EXPIRED', message: 'Sign-in for this event has closed.' });
  }

  const day = await prisma.eventDay.findFirst({ where: { id: req.params.dayId, eventId: event.id } });
  if (!day) return res.json({ ok: false, error: 'UNKNOWN_DAY', message: 'That day is not part of this event.' });

  const clientId = String(req.body.clientId || '');
  const attendee = clientId
    ? await prisma.attendance.findUnique({ where: { eventId_clientId: { eventId: event.id, clientId } } })
    : null;
  if (!attendee) {
    return res.json({ ok: false, error: 'NOT_FOUND', message: 'Sign in from the device you used on the first day to sign other days.' });
  }
  if (attendee.status === 'RETIRED') {
    return res.json({ ok: false, error: 'RETIRED', message: 'This entry has been retired and can no longer sign.' });
  }

  if (isBlankSignature(req.body.signature)) {
    return res.json({ ok: false, error: 'MISSING_SIGNATURE', message: 'A signature is required — please draw it before submitting.' });
  }
  if (!dayIsOpen(day)) {
    return res.json({
      ok: false,
      error: 'DAY_NOT_OPEN',
      message: 'Signing for this day is not open right now.',
      opensAt: dayOpensAt(day),
      closesAt: dayClosesAt(day)
    });
  }

  const existing = await prisma.sessionSignature.findUnique({
    where: { attendanceId_dayId: { attendanceId: attendee.id, dayId: day.id } }
  });
  if (existing) return res.json({ ok: true, id: existing.id, duplicate: true });

  try {
    const sig = await prisma.sessionSignature.create({
      data: { attendanceId: attendee.id, dayId: day.id, signature: String(req.body.signature) }
    });
    notifyDaySigned(attendee, event, day, sig);
    return res.json({ ok: true, id: sig.id });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      return res.json({ ok: true, duplicate: true });
    }
    throw err;
  }
}));

// Renders the QR for an attendee's own pass link. POST so the secret id never
// lands in a URL, an access log or a referrer. Whoever holds the clientId
// already holds the pass, so this reveals nothing new.
publicRouter.post('/events/:slug/pass-qr', attendanceLimiter, ah(async (req, res) => {
  const event = await prisma.event.findUnique({ where: { slug: req.params.slug } });
  if (!event || event.deletedAt) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });
  const clientId = String(req.body.clientId || '');
  const row = clientId ? await prisma.attendance.findUnique({ where: { eventId_clientId: { eventId: event.id, clientId } }, select: { id: true } }) : null;
  if (!row) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });
  const url = `${process.env.PUBLIC_APP_URL}/index.html?event=${encodeURIComponent(event.slug)}&pass=${encodeURIComponent(clientId)}`;
  const png = await QRCode.toBuffer(url, { width: 220, margin: 1 });
  res.set('Content-Type', 'image/png');
  res.set('Cache-Control', 'no-store');
  res.send(png);
}));
// Emails the attendee a receipt naming the day just recorded. Fire-and-forget
// like the first sign-in's receipt: the signature is already saved.
export async function notifyDaySigned(attendee, event, day, sig) {
  const dayCount = await prisma.eventDay.count({ where: { eventId: event.id } });
  sendConfirmationIfEmailed(attendee, event, day, dayCount, sig.signedAt);
}

// Looks a registered attendee up by phone for a later day, for someone whose
// device doesn't hold their first sign-in. Answers with a masked name only,
// never anything else about the row, so a stranger who types someone else's
// number learns nothing useful. A miss and a retired row look the same.
async function findForPhoneCheckIn(req) {
  const event = await prisma.event.findUnique({ where: { slug: req.params.slug } });
  if (!event || event.deletedAt) return { error: { ok: false, error: 'Unknown event' } };
  if (isLinkExpired(event)) return { error: { ok: false, error: 'LINK_EXPIRED', message: 'Sign-in for this event has closed.' } };

  // A submitted payment sheet no longer takes signatures.
  if (event.kind === 'DUTY_ROLL' && event.dutyStage !== 'OPEN') {
    return { error: { ok: false, error: 'SHEET_SUBMITTED', message: 'This payment sheet has been submitted, so signing is closed. Contact the organiser.' } };
  }
  const day = await prisma.eventDay.findFirst({ where: { id: req.params.dayId, eventId: event.id } });
  if (!day) return { error: { ok: false, error: 'UNKNOWN_DAY', message: 'That day is not part of this event.' } };
  if (!dayIsOpen(day)) {
    return { error: { ok: false, error: 'DAY_NOT_OPEN', message: 'Signing for this day is not open right now.', opensAt: dayOpensAt(day), closesAt: dayClosesAt(day) } };
  }

  const phoneNormalized = normalizePhone(String(req.body.phone || ''));
  if (!phoneNormalized) return { error: { ok: false, error: 'INVALID_PHONE', message: 'Enter a valid Kenyan phone number.' } };

  const attendee = await prisma.attendance.findUnique({ where: { eventId_phoneNormalized: { eventId: event.id, phoneNormalized } } });
  if (!attendee || attendee.status === 'RETIRED') {
    return { error: { ok: false, error: 'NOT_REGISTERED', message: 'We could not find that number on this event. Use the number you registered with on the first day.' } };
  }
  return { event, day, attendee };
}

publicRouter.post('/events/:slug/days/:dayId/lookup', checkInLimiter, ah(async (req, res) => {
  const found = await findForPhoneCheckIn(req);
  if (found.error) return res.json(found.error);
  const already = await prisma.sessionSignature.findUnique({
    where: { attendanceId_dayId: { attendanceId: found.attendee.id, dayId: found.day.id } }
  });
  res.json({ ok: true, maskedName: maskName(found.attendee.name), alreadySigned: !!already });
}));

// Signs a day from any device by registered phone number. Weaker proof than
// the device-bound route above, so the signature is stored with method PHONE,
// the admin sheet marks it, and the audit trail records it.
publicRouter.post('/events/:slug/days/:dayId/check-in', checkInLimiter, ah(async (req, res) => {
  const found = await findForPhoneCheckIn(req);
  if (found.error) return res.json(found.error);
  const { event, day, attendee } = found;
  if (isBlankSignature(req.body.signature)) {
    return res.json({ ok: false, error: 'MISSING_SIGNATURE', message: 'A signature is required — please draw it before submitting.' });
  }
  const existing = await prisma.sessionSignature.findUnique({
    where: { attendanceId_dayId: { attendanceId: attendee.id, dayId: day.id } }
  });
  if (existing) return res.json({ ok: true, id: existing.id, duplicate: true });

  try {
    const sig = await prisma.sessionSignature.create({
      data: { attendanceId: attendee.id, dayId: day.id, signature: String(req.body.signature), method: 'PHONE' }
    });
    await writeAudit({
      actorId: null, action: 'DAY_CHECKIN_BY_PHONE', targetType: 'Attendance', targetId: attendee.id,
      metadata: { eventId: event.id, dayId: day.id, position: day.position }, req
    }).catch(() => {});
    notifyDaySigned(attendee, event, day, sig);
    // Deliberately no clientId in the response: that id is the proof of
    // ownership for editing the row, and a phone number alone must not hand it out.
    return res.json({ ok: true, id: sig.id });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') return res.json({ ok: true, duplicate: true });
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
  const missing = missingAttendeeField(req.body);
  if (missing) return res.json({ ok: false, error: 'MISSING_FIELD', message: `Please provide your ${missing}.` });
  if (isBlankSignature(req.body.signature)) {
    return res.json({ ok: false, error: 'MISSING_SIGNATURE', message: 'A signature is required — please draw it before saving.' });
  }
  if (!isValidConsentAnswer(req.body.photoVideoConsent)) {
    return res.json({ ok: false, error: 'MISSING_CONSENT', message: 'Please indicate whether you consent to being photographed/recorded before saving.' });
  }
  const emailNormalized = normalizeEmail(req.body.email);
  const firstDay = await anchorDayFor(existing.id, event);
  const signature = String(req.body.signature || '');

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
        signature,
        photoVideoConsent: req.body.photoVideoConsent,
        daySignatures: {
          upsert: {
            where: { attendanceId_dayId: { attendanceId: existing.id, dayId: firstDay.id } },
            create: { dayId: firstDay.id, signature },
            update: { signature }
          }
        },
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
  if (!req.user || req.user.role !== 'SUPER_ADMIN' || !canManageEvent(req.user, event)) return res.status(403).json({ ok: false, error: 'FORBIDDEN' });

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

// Flags a row for removal without deleting it -- the first half of a
// two-step maker-checker: whoever manages this event (owning county admin
// or a super admin, see canManageEvent) can raise the flag with a reason,
// but only a super admin can actually retire it (see /retire below). This
// means a single county admin can never make attendance data disappear on
// their own, and every flag is itself an audited, reasoned act rather than
// a silent toggle.
publicRouter.post('/events/:slug/attendance/:rowId/flag', ah(async (req, res) => {
  const event = await prisma.event.findUnique({ where: { slug: req.params.slug } });
  if (!event || event.deletedAt) return res.json({ ok: false, error: 'Event not found' });
  if (!canManageEvent(req.user, event)) return res.status(403).json({ ok: false, error: 'FORBIDDEN' });

  const reason = String(req.body.reason || '').trim();
  if (reason.length < 3) {
    return res.json({ ok: false, error: 'REASON_REQUIRED', message: 'Please explain why this entry should be removed.' });
  }

  const row = await prisma.attendance.findFirst({ where: { id: req.params.rowId, eventId: event.id } });
  if (!row) return res.json({ ok: false, error: 'NOT_FOUND' });
  if (row.status !== 'ACTIVE') {
    return res.json({ ok: false, error: 'INVALID_STATE', message: 'This entry is not currently active.' });
  }

  const statusAt = new Date();
  const updated = await prisma.attendance.update({
    where: { id: row.id },
    data: { status: 'FLAGGED_FOR_REMOVAL', statusReason: reason, statusAt }
  });
  await writeAudit({
    actorId: req.user.id,
    action: 'ATTENDANCE_FLAGGED',
    targetType: 'Attendance',
    targetId: row.id,
    metadata: { eventId: event.id, name: row.name, reason, previousStatus: 'ACTIVE' },
    req
  }).catch(() => {});

  res.json({ ok: true, status: updated.status, statusReason: updated.statusReason, statusAt: updated.statusAt });
}));

// Confirms a flagged row's removal -- the "checker" half of the flag/retire
// pair above. Gated the same way flagging is (canManageEvent: a super
// admin, or the event's own owning county admin) rather than super-admin
// only -- an admin fully in charge of their own event (e.g. cleaning up a
// row they typed in themselves while testing the sign-in page before
// sharing the real link) shouldn't have to wait on a super admin just to
// finish removing it. Still always a distinct flag-then-confirm pair, so
// every retirement carries a documented reason and a two-step trail in
// AuditLog -- what's dropped is the requirement that a *different* person
// perform each step, not the two steps themselves. Soft-retired, never
// deleted -- see /reopen below to undo this.
publicRouter.post('/events/:slug/attendance/:rowId/retire', ah(async (req, res) => {
  const event = await prisma.event.findUnique({ where: { slug: req.params.slug } });
  if (!event || event.deletedAt) return res.json({ ok: false, error: 'Event not found' });
  if (!canManageEvent(req.user, event)) return res.status(403).json({ ok: false, error: 'FORBIDDEN' });

  const row = await prisma.attendance.findFirst({ where: { id: req.params.rowId, eventId: event.id } });
  if (!row) return res.json({ ok: false, error: 'NOT_FOUND' });
  if (row.status !== 'FLAGGED_FOR_REMOVAL') {
    return res.json({ ok: false, error: 'INVALID_STATE', message: 'This entry must be flagged for removal before it can be retired.' });
  }

  const reason = req.body.reason ? String(req.body.reason).trim() : row.statusReason;
  const statusAt = new Date();
  const updated = await prisma.attendance.update({
    where: { id: row.id },
    data: { status: 'RETIRED', statusReason: reason, statusAt }
  });
  await writeAudit({
    actorId: req.user.id,
    action: 'ATTENDANCE_RETIRED',
    targetType: 'Attendance',
    targetId: row.id,
    metadata: { eventId: event.id, name: row.name, reason, previousStatus: 'FLAGGED_FOR_REMOVAL' },
    req
  }).catch(() => {});

  res.json({ ok: true, status: updated.status, statusReason: updated.statusReason, statusAt: updated.statusAt });
}));

// Reverses either a pending flag (dismiss it, no removal happened) or an
// already-retired row (undo the retirement) back to ACTIVE. Gated the same
// way as retire above (canManageEvent) -- reopening is exactly as
// consequential as retiring, so it gets the same authority, not a
// narrower one.
publicRouter.post('/events/:slug/attendance/:rowId/reopen', ah(async (req, res) => {
  const event = await prisma.event.findUnique({ where: { slug: req.params.slug } });
  if (!event || event.deletedAt) return res.json({ ok: false, error: 'Event not found' });
  if (!canManageEvent(req.user, event)) return res.status(403).json({ ok: false, error: 'FORBIDDEN' });

  const row = await prisma.attendance.findFirst({ where: { id: req.params.rowId, eventId: event.id } });
  if (!row) return res.json({ ok: false, error: 'NOT_FOUND' });
  if (row.status === 'ACTIVE') {
    return res.json({ ok: false, error: 'INVALID_STATE', message: 'This entry is already active.' });
  }

  const previousStatus = row.status;
  const reason = req.body.reason ? String(req.body.reason).trim() : null;
  const updated = await prisma.attendance.update({
    where: { id: row.id },
    data: { status: 'ACTIVE', statusReason: reason, statusAt: new Date() }
  });
  await writeAudit({
    actorId: req.user.id,
    action: 'ATTENDANCE_REOPENED',
    targetType: 'Attendance',
    targetId: row.id,
    metadata: { eventId: event.id, name: row.name, reason, previousStatus },
    req
  }).catch(() => {});

  res.json({ ok: true, status: updated.status, statusReason: updated.statusReason, statusAt: updated.statusAt });
}));

// The record-level timeline behind the flag/retire/reopen buttons -- every
// lifecycle transition for this one row, oldest first, each carrying a
// verified flag computed by walking the tamper-evident hash chain (see
// verifyChain in lib/audit.js) so the UI can show "chain intact" without
// shipping any crypto to the browser. Gated the same as the roster view
// itself (canManageEvent): seeing who touched a row is part of managing
// the event, not a separate privilege.
publicRouter.get('/events/:slug/attendance/:rowId/history', ah(async (req, res) => {
  const event = await prisma.event.findUnique({ where: { slug: req.params.slug } });
  if (!event || event.deletedAt) return res.json({ ok: false, error: 'Event not found' });
  if (!canManageEvent(req.user, event)) return res.status(403).json({ ok: false, error: 'FORBIDDEN' });

  const row = await prisma.attendance.findFirst({ where: { id: req.params.rowId, eventId: event.id } });
  if (!row) return res.json({ ok: false, error: 'NOT_FOUND' });

  const entries = await prisma.auditLog.findMany({
    where: { targetType: 'Attendance', targetId: row.id },
    orderBy: { createdAt: 'asc' }
  });
  const verified = verifyChain(entries);

  res.json({
    ok: true,
    entries: entries.map((e, i) => ({
      action: e.action,
      actorEmail: e.actorEmail,
      actorRole: e.actorRole,
      reason: e.metadata && typeof e.metadata === 'object' ? e.metadata.reason : null,
      createdAt: e.createdAt,
      verified: verified[i]
    }))
  });
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
  const row = await prisma.attendance.findUnique({
    where: { signatureRequestTokenHash: tokenHash },
    include: { event: true }
  });
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
  const signature = String(req.body.signature);
  const result = await prisma.attendance.updateMany({
    where: { id: row.id, signatureRequestTokenHash: tokenHash },
    data: {
      signature,
      signatureRequestTokenHash: null,
      signatureRequestExpiresAt: null
    }
  });
  if (result.count === 0) {
    return res.json({ ok: false, error: 'INVALID_TOKEN', message: 'This link has already been used.' });
  }
  const firstDay = await anchorDayFor(row.id, row.event);
  await prisma.sessionSignature.upsert({
    where: { attendanceId_dayId: { attendanceId: row.id, dayId: firstDay.id } },
    create: { attendanceId: row.id, dayId: firstDay.id, signature },
    update: { signature }
  });
  res.json({ ok: true });
}));
