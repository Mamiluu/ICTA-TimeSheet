// Copyright (c) 2026 Asya Hafidh <msanifuasiya@gmail.com>. All Rights Reserved.
// Proprietary and confidential. See LICENSE in the repository root.

import { prisma } from './prisma.js';
import { buildPayRows, totalsOf } from './duty.js';

// The roster, the days, who signed which, and what each person is owed. Shared by
// the preparer's page and the approvers' review page, so both always agree.
export async function loadRoll(event, { withSignatures } = {}) {
  const [days, payees] = await Promise.all([
    prisma.eventDay.findMany({ where: { eventId: event.id }, orderBy: { position: 'asc' } }),
    prisma.dutyPayee.findMany({
      where: { eventId: event.id, attendance: { status: { not: 'RETIRED' } } },
      orderBy: { createdAt: 'asc' },
      include: { attendance: { include: { daySignatures: { select: { dayId: true, signedAt: true, method: true, ...(withSignatures ? { signature: true } : {}) } } } } }
    })
  ]);

  const people = payees.map((p) => ({
    id: p.id,
    name: p.attendance.name,
    organisation: p.attendance.organization || '',
    phone: p.attendance.phone,
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
        return s ? { ...c, method: s.method, signedAt: s.signedAt, ...(withSignatures ? { signature: s.signature } : {}) } : c;
      })
    };
  });
  return { days, rows, totals: totalsOf(rows) };
}
