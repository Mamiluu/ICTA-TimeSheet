// Copyright (c) 2026 Asya Hafidh <msanifuasiya@gmail.com>. All Rights Reserved.
// Proprietary and confidential. See LICENSE in the repository root.

import crypto from 'node:crypto';
import { prisma } from './prisma.js';

function sha256Hex(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

// A certificate can be issued once the event's last day is over, and only if
// the organiser has not turned certificates off for the event.
export function certificateEligible(event, days, now = Date.now()) {
  if (!event.certificatesEnabled || !days.length) return false;
  const lastEnd = Math.max(...days.map((d) => new Date(d.endAt).getTime()));
  return now > lastEnd;
}

// What a certificate attests: this person signed these days of this event.
// Signatures are stored as hashes, never as images, and phone and email are
// left out entirely, so the snapshot holds only what the public check may show.
export function assembleCertificateSnapshot(event, attendee, days, signatures) {
  const byDay = new Map(signatures.map((s) => [s.dayId, s]));
  const signed = [...days]
    .sort((a, b) => a.position - b.position)
    .filter((d) => byDay.has(d.id))
    .map((d) => {
      const s = byDay.get(d.id);
      return {
        position: d.position,
        startAt: new Date(d.startAt).toISOString(),
        endAt: new Date(d.endAt).toISOString(),
        signedAt: new Date(s.signedAt).toISOString(),
        method: s.method,
        signatureSha256: sha256Hex(s.signature)
      };
    });
  return {
    kind: 'ATTENDANCE_CERTIFICATE',
    eventId: event.id,
    eventName: event.name,
    county: event.county,
    timezone: event.timezone,
    attendeeId: attendee.id,
    name: attendee.name,
    organization: attendee.organization || null,
    totalDays: days.length,
    days: signed
  };
}

// The certificate still holds if every day it lists is still signed, with the
// same signature, on the live record. Days signed after it was issued do not
// matter: a certificate says what was true when it was issued.
export function certificateStillHolds(snapshot, live) {
  const now = new Map(live.days.map((d) => [d.position, d.signatureSha256]));
  return snapshot.days.every((d) => now.get(d.position) === d.signatureSha256);
}

// What the public verification page may show: no signature hashes, no ids.
export function publicCertificateView(snapshot) {
  return {
    name: snapshot.name,
    organization: snapshot.organization,
    eventName: snapshot.eventName,
    county: snapshot.county,
    timezone: snapshot.timezone,
    totalDays: snapshot.totalDays,
    days: snapshot.days.map((d) => ({ position: d.position, startAt: d.startAt, endAt: d.endAt, signedAt: d.signedAt, method: d.method }))
  };
}

export async function loadCertificateSnapshot(event, attendee) {
  const [days, signatures] = await Promise.all([
    prisma.eventDay.findMany({ where: { eventId: event.id }, orderBy: { position: 'asc' } }),
    prisma.sessionSignature.findMany({ where: { attendanceId: attendee.id } })
  ]);
  return { days, snapshot: assembleCertificateSnapshot(event, attendee, days, signatures) };
}
