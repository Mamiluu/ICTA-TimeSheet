// Copyright (c) 2026 Asya Hafidh <msanifuasiya@gmail.com>. All Rights Reserved.
// Proprietary and confidential. See LICENSE in the repository root.

import crypto from 'node:crypto';
import { prisma } from './prisma.js';
import { canonicalJson } from './audit.js';

// Crockford base32: no I, L, O or U, so a code read off a printed sheet
// can't be confused with 1, 0 or V.
const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const SEAL_CODE_PATTERN = /^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{10}$/;

export function newSealCode() {
  return Array.from(crypto.randomBytes(10), (b) => CODE_ALPHABET[b % 32]).join('');
}

function sha256Hex(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function digestOf(snapshot) {
  return sha256Hex(canonicalJson(snapshot));
}

// Stores a hash of each signature, not the image itself: the seal can prove
// a signature is unchanged without copying every drawn signature into a
// second table.
export async function buildDaySnapshot(event, day) {
  const rows = await prisma.attendance.findMany({
    where: { eventId: event.id },
    orderBy: { id: 'asc' },
    select: {
      id: true,
      name: true,
      organization: true,
      status: true,
      daySignatures: { where: { dayId: day.id }, select: { signature: true, signedAt: true } }
    }
  });

  return {
    eventId: event.id,
    eventName: event.name,
    dayPosition: day.position,
    dayStartAt: day.startAt.toISOString(),
    dayEndAt: day.endAt.toISOString(),
    rows: rows.map((r) => {
      const sig = r.daySignatures[0];
      return {
        attendanceId: r.id,
        name: r.name,
        organization: r.organization,
        status: r.status,
        signed: !!sig,
        signedAt: sig ? sig.signedAt.toISOString() : null,
        signatureSha256: sig ? sha256Hex(sig.signature) : null
      };
    })
  };
}
