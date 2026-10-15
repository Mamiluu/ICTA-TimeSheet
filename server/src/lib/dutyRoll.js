// Copyright (c) 2026 Asya Hafidh <msanifuasiya@gmail.com>. All Rights Reserved.
// Proprietary and confidential. See LICENSE in the repository root.

import crypto from 'node:crypto';
import { prisma } from './prisma.js';
import { buildPayRows, totalsOf } from './duty.js';
import { analyzeDuty, localDate } from './dutyChecks.js';

// The roster, the days, who signed which, and what each person is owed. Shared by
// the preparer's page and the approvers' review page, so both always agree.
export async function loadRoll(event, { withSignatures, withHashes } = {}) {
  const wantImage = withSignatures || withHashes;
  const [days, payees] = await Promise.all([
    prisma.eventDay.findMany({ where: { eventId: event.id }, orderBy: { position: 'asc' } }),
    prisma.dutyPayee.findMany({
      where: { eventId: event.id, attendance: { status: { not: 'RETIRED' } } },
      orderBy: { createdAt: 'asc' },
      include: { attendance: { include: { daySignatures: { select: { dayId: true, signedAt: true, method: true, ...(wantImage ? { signature: true } : {}) } } } } }
    })
  ]);

  const people = payees.map((p) => ({
    id: p.id,
    name: p.attendance.name,
    organisation: p.attendance.organization || '',
    phone: p.attendance.phone,
    phoneNormalized: p.attendance.phoneNormalized,
    addedAt: p.createdAt,
    payeeType: p.payeeType,
    idNumber: p.idNumber,
    jobRole: p.jobRole,
    ratePerDay: p.ratePerDay,
    attendanceStatus: p.attendance.status
  }));
  const signedByPayee = new Map(payees.map((p) => [p.id, new Set(p.attendance.daySignatures.map((s) => s.dayId))]));
  const rows = buildPayRows(people, days, signedByPayee).map((r, i) => {
    const sigs = payees[i].attendance.daySignatures;
    return {
      ...r,
      cells: r.cells.map((c) => {
        const s = sigs.find((x) => x.dayId === c.dayId);
        return s
          ? {
              ...c,
              method: s.method,
              signedAt: s.signedAt,
              ...(withHashes ? { sigHash: crypto.createHash('sha256').update(s.signature).digest('hex') } : {}),
              ...(withSignatures ? { signature: s.signature } : {})
            }
          : c;
      })
    };
  });
  return { days, rows, totals: totalsOf(rows) };
}

// Rows as they go to the browser: the hash of each signature is only for the checks.
export function withoutHashes(rows) {
  return rows.map((r) => ({
    ...r,
    cells: r.cells.map((c) => {
      const copy = { ...c };
      delete copy.sigHash;
      return copy;
    })
  }));
}

// The automatic checks for one sheet: the sheet's own signatures and rates, plus what
// the same people signed on other payment sheets in the same department. Other
// departments' sheets are never looked at.
export async function loadFindings(event, roll) {
  if (!roll.rows.length) return [];
  const ids = roll.rows.map((r) => r.idNumber);
  const phones = roll.rows.map((r) => r.phoneNormalized);
  const others = await prisma.dutyPayee.findMany({
    where: {
      eventId: { not: event.id },
      event: { departmentId: event.departmentId, kind: 'DUTY_ROLL', deletedAt: null },
      attendance: { status: { not: 'RETIRED' }, daySignatures: { some: {} } },
      OR: [{ idNumber: { in: ids } }, { attendance: { phoneNormalized: { in: phones } } }]
    },
    include: {
      event: { select: { name: true, timezone: true } },
      attendance: { select: { phoneNormalized: true, daySignatures: { select: { day: { select: { startAt: true, place: true } } } } } }
    }
  });
  return analyzeDuty({
    rows: roll.rows,
    days: roll.days,
    timeZone: event.timezone,
    others: others.map((o) => ({
      eventName: o.event.name,
      idNumber: o.idNumber,
      phoneNormalized: o.attendance.phoneNormalized,
      signed: o.attendance.daySignatures.map((s) => ({ date: localDate(s.day.startAt, o.event.timezone), place: s.day.place }))
    }))
  });
}
