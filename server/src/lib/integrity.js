// Copyright (c) 2026 Asya Hafidh <msanifuasiya@gmail.com>. All Rights Reserved.
// Proprietary and confidential. See LICENSE in the repository root.

import crypto from 'node:crypto';
import { prisma } from './prisma.js';
import { dayOpensAt, dayClosesAt } from './days.js';

// Thresholds are deliberately conservative: each finding is a prompt for the
// organiser to look, not an accusation. See describeFindings for the wording.
export const BULK_SIGNATURES_PER_MINUTE = 10;
export const PHONE_SHARE_NOTE = 0.4;
export const PHONE_SHARE_MIN_PEOPLE = 5;
export const FREQUENT_OTHER_EVENTS = 5;
export const HISTORY_WINDOW_DAYS = 90;

function sha256Hex(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function nameList(ids, nameById, max = 6) {
  const names = ids.map((id) => nameById.get(id) || 'Unknown');
  return names.length > max ? names.slice(0, max).join(', ') + ` and ${names.length - max} more` : names.join(', ');
}

// Looks for patterns worth a second look before an attendance record is used to
// support a payment claim. Pure: everything it needs is passed in.
//   people:     [{ id, name }]
//   days:       EventDay-like rows (startAt, endAt, reopenedUntil)
//   signatures: [{ attendanceId, dayId, method, signedAt, signatureSha256, imported }]
//   history:    Map(attendanceId -> number of the organiser's OTHER events attended recently)
// Returns findings, most serious first. severity 'review' = look before sealing;
// 'note' = context only.
export function analyzeIntegrity({ people, days, signatures, history = new Map() }) {
  const nameById = new Map(people.map((p) => [p.id, p.name]));
  const dayById = new Map(days.map((d) => [d.id, d]));
  const findings = [];

  // 1. The same drawn signature on different people. A real hand never repeats
  // pixel for pixel, so this points to copying or one person signing for others.
  // Door stamps and imported initials images are generated, so they are excluded.
  const byHash = new Map();
  for (const s of signatures) {
    if (s.imported || s.method === 'DOOR' || !s.signatureSha256) continue;
    if (!byHash.has(s.signatureSha256)) byHash.set(s.signatureSha256, new Set());
    byHash.get(s.signatureSha256).add(s.attendanceId);
  }
  const copied = [...byHash.values()].filter((set) => set.size > 1);
  if (copied.length) {
    const ids = [...new Set(copied.flatMap((set) => [...set]))];
    findings.push({
      code: 'DUPLICATE_SIGNATURE',
      severity: 'review',
      title: `${copied.length === 1 ? 'One signature image appears' : copied.length + ' signature images appear'} on more than one person`,
      detail: `A hand-drawn signature is never identical twice. Check: ${nameList(ids, nameById)}.`,
      people: ids
    });
  }

  // 2. Many signatures in a single minute: usually one device signing for a group.
  const perMinute = new Map();
  for (const s of signatures) {
    if (s.method === 'DOOR' || s.imported) continue;
    const key = Math.floor(new Date(s.signedAt).getTime() / 60000);
    perMinute.set(key, (perMinute.get(key) || 0) + 1);
  }
  const busiest = Math.max(0, ...perMinute.values());
  if (busiest >= BULK_SIGNATURES_PER_MINUTE) {
    findings.push({
      code: 'BULK_SIGNING',
      severity: 'review',
      title: `${busiest} signatures were recorded within one minute`,
      detail: 'Several people signing at the same moment can happen at a queue, but it can also mean one device was used for many people.',
      people: []
    });
  }

  // 3. Signatures recorded outside their day's signing window.
  const outside = signatures.filter((s) => {
    const day = dayById.get(s.dayId);
    if (!day || s.imported) return false;
    const t = new Date(s.signedAt).getTime();
    return t < dayOpensAt(day).getTime() || t > dayClosesAt(day).getTime();
  });
  if (outside.length) {
    const ids = [...new Set(outside.map((s) => s.attendanceId))];
    findings.push({
      code: 'OUTSIDE_WINDOW',
      severity: 'review',
      title: `${outside.length} ${outside.length === 1 ? 'signature was' : 'signatures were'} recorded outside the signing window`,
      detail: `Signed before a day opened or after it closed. Check: ${nameList(ids, nameById)}.`,
      people: ids
    });
  }

  // 4. A day where many check-ins came by phone number rather than a drawn signature.
  for (const day of days) {
    const forDay = signatures.filter((s) => s.dayId === day.id);
    const byPhone = forDay.filter((s) => s.method === 'PHONE').length;
    if (forDay.length >= PHONE_SHARE_MIN_PEOPLE && byPhone / forDay.length >= PHONE_SHARE_NOTE) {
      findings.push({
        code: 'PHONE_HEAVY_DAY',
        severity: 'note',
        title: `${byPhone} of ${forDay.length} check-ins on day ${day.position} were by phone number`,
        detail: 'Phone check-ins are less strongly verified than a drawn signature on the attendee’s own device.',
        people: []
      });
    }
  }

  // 5. People who attended many of this organiser's other recent events.
  const frequent = people.filter((p) => (history.get(p.id) || 0) >= FREQUENT_OTHER_EVENTS).map((p) => p.id);
  if (frequent.length) {
    findings.push({
      code: 'FREQUENT_ATTENDEE',
      severity: 'note',
      title: `${frequent.length} ${frequent.length === 1 ? 'person has' : 'people have'} attended ${FREQUENT_OTHER_EVENTS}+ other events recently`,
      detail: `Often legitimate, for example regular trainers or committee members. ${nameList(frequent, nameById)}.`,
      people: frequent
    });
  }

  const rank = { review: 0, note: 1 };
  return findings.sort((a, b) => rank[a.severity] - rank[b.severity]);
}

// The people-by-day grid the claim pack prints.
export function buildMatrix(people, days, signatures) {
  const sigByKey = new Map(signatures.map((s) => [`${s.attendanceId}:${s.dayId}`, s]));
  const rows = people.map((p, i) => {
    const cells = days.map((d) => {
      const s = sigByKey.get(`${p.id}:${d.id}`);
      return s ? { signed: true, method: s.method, signedAt: new Date(s.signedAt).toISOString() } : { signed: false };
    });
    return { n: i + 1, id: p.id, name: p.name, organization: p.organization || '', phone: p.phone || '', days: cells, daysAttended: cells.filter((c) => c.signed).length };
  });
  const totals = days.map((_, i) => rows.filter((r) => r.days[i].signed).length);
  return { rows, totals };
}

export async function loadClaimPackData(event) {
  const [days, attendance] = await Promise.all([
    prisma.eventDay.findMany({ where: { eventId: event.id }, orderBy: { position: 'asc' } }),
    prisma.attendance.findMany({ where: { eventId: event.id }, orderBy: { createdAt: 'asc' } })
  ]);
  const active = attendance.filter((a) => a.status !== 'RETIRED');
  const rawSigs = await prisma.sessionSignature.findMany({
    where: { attendanceId: { in: active.map((a) => a.id) } },
    select: { attendanceId: true, dayId: true, method: true, signedAt: true, signature: true, isImportedSignature: true }
  });
  const signatures = rawSigs.map((s) => ({
    attendanceId: s.attendanceId,
    dayId: s.dayId,
    method: s.method,
    signedAt: s.signedAt,
    imported: s.isImportedSignature,
    signatureSha256: sha256Hex(s.signature)
  }));

  // How many of this organiser's other recent events each person attended,
  // matched by normalised phone number.
  const since = new Date(Date.now() - HISTORY_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const others = event.ownerId
    ? await prisma.attendance.findMany({
        where: {
          phoneNormalized: { in: active.map((a) => a.phoneNormalized) },
          eventId: { not: event.id },
          status: { not: 'RETIRED' },
          event: { ownerId: event.ownerId, deletedAt: null, startAt: { gte: since } }
        },
        select: { phoneNormalized: true, eventId: true }
      })
    : [];
  const eventsByPhone = new Map();
  for (const o of others) {
    if (!eventsByPhone.has(o.phoneNormalized)) eventsByPhone.set(o.phoneNormalized, new Set());
    eventsByPhone.get(o.phoneNormalized).add(o.eventId);
  }
  const history = new Map(active.map((a) => [a.id, (eventsByPhone.get(a.phoneNormalized) || new Set()).size]));

  const people = active.map((a) => ({ id: a.id, name: a.name, organization: a.organization, phone: a.phone }));
  const findings = analyzeIntegrity({ people, days, signatures, history });
  const matrix = buildMatrix(people, days, signatures);
  return { days, people, signatures, findings, matrix, retiredCount: attendance.length - active.length };
}
