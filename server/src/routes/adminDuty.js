// Copyright (c) 2026 Asya Hafidh <msanifuasiya@gmail.com>. All Rights Reserved.
// Proprietary and confidential. See LICENSE in the repository root.

import crypto from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { writeAudit } from '../lib/audit.js';
import { ah } from '../lib/asyncHandler.js';
import { MAX_ATTENDANCE_PER_EVENT } from '../lib/constants.js';
import { cleanPayee, buildPayRows, totalsOf, buildPayCsv, MAX_RATE_PER_DAY } from '../lib/duty.js';

// A one-pixel transparent PNG. A person added to a duty roll has not signed
// anything yet; their real signatures are the per-day ones.
const NO_SIGNATURE_YET =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

// Payment-sheet routes on the county admin's router. Every one goes through
// findOwnEvent, which already refuses an event the account has no access to, and
// each insists on the event actually being a duty roll.
export function registerDutyRoutes(router, findOwnEvent) {
  async function dutyEvent(req, res) {
    const event = await findOwnEvent(req);
    if (!event || event.kind !== 'DUTY_ROLL') {
      res.status(404).json({ ok: false, error: 'NOT_FOUND' });
      return null;
    }
    return event;
  }

  // The roster, the days, who signed which, and what each person is owed.
  async function loadRoll(event, { withSignatures } = {}) {
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

  router.get('/events/:id/duty', ah(async (req, res) => {
    const event = await dutyEvent(req, res);
    if (!event) return;
    const print = req.query.print === '1';
    const roll = await loadRoll(event, { withSignatures: print });
    if (print) {
      await writeAudit({ actorId: req.user.id, action: 'DUTY_ROLL_PRINTED', targetType: 'Event', targetId: event.id, metadata: { name: event.name, rowCount: roll.rows.length }, req });
    }
    res.json({
      ok: true,
      event: {
        id: event.id,
        slug: event.slug,
        name: event.name,
        description: event.description,
        county: event.county,
        timezone: event.timezone,
        authorisedBy: event.authorisedBy,
        authorityRef: event.authorityRef,
        startAt: event.startAt,
        endAt: event.endAt
      },
      days: roll.days.map((d) => ({ id: d.id, position: d.position, startAt: d.startAt, endAt: d.endAt, place: d.place })),
      rows: roll.rows,
      totals: roll.totals,
      maxRate: MAX_RATE_PER_DAY
    });
  }));

  router.post('/events/:id/duty/payees', ah(async (req, res) => {
    const event = await dutyEvent(req, res);
    if (!event) return;

    const parsed = cleanPayee(req.body);
    if (parsed.error) return res.status(400).json({ ok: false, error: 'INVALID_PAYEE', message: parsed.error });
    const p = parsed.value;

    // Once the engagement has started the list is meant to be final, so a late
    // addition has to say why. The reason goes into the audit trail.
    const started = event.startAt.getTime() <= Date.now();
    const reason = String(req.body.reason || '').replace(/\s+/g, ' ').trim().slice(0, 300);
    if (started && reason.length < 5) {
      return res.status(400).json({ ok: false, error: 'REASON_REQUIRED', message: 'The engagement has already started. Say why this person is being added now.' });
    }

    const count = await prisma.dutyPayee.count({ where: { eventId: event.id, attendance: { status: { not: 'RETIRED' } } } });
    if (count >= MAX_ATTENDANCE_PER_EVENT) return res.status(409).json({ ok: false, error: 'ROSTER_FULL', message: 'This roster is full.' });

    let created;
    try {
      created = await prisma.attendance.create({
        data: {
          eventId: event.id,
          clientId: crypto.randomUUID(),
          name: p.name,
          organization: p.organisation,
          phone: p.phone,
          phoneNormalized: p.phoneNormalized,
          signature: NO_SIGNATURE_YET,
          isImportedSignature: true,
          dutyPayee: {
            create: { eventId: event.id, payeeType: p.payeeType, idNumber: p.idNumber, jobRole: p.jobRole, ratePerDay: p.ratePerDay, addedById: req.user.id }
          }
        }
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const target = Array.isArray(err.meta?.target) ? err.meta.target.join(',') : String(err.meta?.target || '');
        if (target.includes('idNumber')) {
          return res.status(409).json({ ok: false, error: 'ID_IN_USE', message: 'Someone with that ID or staff number is already on this roster.' });
        }
        return res.status(409).json({ ok: false, error: 'PHONE_IN_USE', message: 'That phone number is already on this roster.' });
      }
      throw err;
    }

    await writeAudit({
      actorId: req.user.id,
      action: 'DUTY_PAYEE_ADDED',
      targetType: 'Attendance',
      targetId: created.id,
      metadata: { eventId: event.id, name: p.name, payeeType: p.payeeType, ratePerDay: p.ratePerDay, ...(started ? { late: true, reason } : {}) },
      req
    });
    res.json({ ok: true });
  }));

  // Rate and role are the only things that can change. Changing a rate after
  // someone has signed needs a reason, and both values are kept in the trail.
  router.patch('/events/:id/duty/payees/:payeeId', ah(async (req, res) => {
    const event = await dutyEvent(req, res);
    if (!event) return;
    const payee = await prisma.dutyPayee.findFirst({
      where: { id: req.params.payeeId, eventId: event.id },
      include: { attendance: { include: { _count: { select: { daySignatures: true } } } } }
    });
    if (!payee || payee.attendance.status === 'RETIRED') return res.status(404).json({ ok: false, error: 'NOT_FOUND' });

    const rate = req.body.ratePerDay === undefined ? payee.ratePerDay : Number(req.body.ratePerDay);
    if (!Number.isInteger(rate) || rate < 0 || rate > MAX_RATE_PER_DAY) {
      return res.status(400).json({ ok: false, error: 'INVALID_RATE', message: 'The daily rate must be a whole number of shillings.' });
    }
    const jobRole = req.body.jobRole === undefined ? payee.jobRole : String(req.body.jobRole).replace(/\s+/g, ' ').trim().slice(0, 60) || null;
    const reason = String(req.body.reason || '').replace(/\s+/g, ' ').trim().slice(0, 300);
    if (rate !== payee.ratePerDay && payee.attendance._count.daySignatures > 0 && reason.length < 5) {
      return res.status(400).json({ ok: false, error: 'REASON_REQUIRED', message: 'This person has already signed. Say why the rate is changing.' });
    }

    await prisma.dutyPayee.update({ where: { id: payee.id }, data: { ratePerDay: rate, jobRole } });
    await writeAudit({
      actorId: req.user.id,
      action: 'DUTY_PAYEE_UPDATED',
      targetType: 'Attendance',
      targetId: payee.attendanceId,
      metadata: { eventId: event.id, name: payee.attendance.name, before: { ratePerDay: payee.ratePerDay, jobRole: payee.jobRole }, after: { ratePerDay: rate, jobRole }, ...(reason ? { reason } : {}) },
      req
    });
    res.json({ ok: true });
  }));

  // Someone added by mistake can be taken off, but only if they have not signed
  // anything. They are retired, never deleted, like every other row.
  router.delete('/events/:id/duty/payees/:payeeId', ah(async (req, res) => {
    const event = await dutyEvent(req, res);
    if (!event) return;
    const payee = await prisma.dutyPayee.findFirst({
      where: { id: req.params.payeeId, eventId: event.id },
      include: { attendance: { include: { _count: { select: { daySignatures: true } } } } }
    });
    if (!payee || payee.attendance.status === 'RETIRED') return res.status(404).json({ ok: false, error: 'NOT_FOUND' });
    if (payee.attendance._count.daySignatures > 0) {
      return res.status(409).json({ ok: false, error: 'HAS_SIGNATURES', message: 'This person has already signed, so they cannot be removed from the roll.' });
    }
    const reason = String(req.body?.reason || '').replace(/\s+/g, ' ').trim().slice(0, 300) || 'Removed from the roster before signing';
    await prisma.attendance.update({ where: { id: payee.attendanceId }, data: { status: 'RETIRED', statusReason: reason, statusAt: new Date() } });
    await writeAudit({ actorId: req.user.id, action: 'DUTY_PAYEE_REMOVED', targetType: 'Attendance', targetId: payee.attendanceId, metadata: { eventId: event.id, name: payee.attendance.name, reason }, req });
    res.json({ ok: true });
  }));

  router.get('/events/:id/duty/export.csv', ah(async (req, res) => {
    const event = await dutyEvent(req, res);
    if (!event) return;
    const roll = await loadRoll(event);
    await writeAudit({ actorId: req.user.id, action: 'DUTY_ROLL_EXPORTED', targetType: 'Event', targetId: event.id, metadata: { name: event.name, rowCount: roll.rows.length, amount: roll.totals.amount }, req });
    const file = event.slug.replace(/[^a-z0-9-]/gi, '') || 'duty-roll';
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="${file}-payment-schedule.csv"`);
    res.set('Cache-Control', 'no-store');
    res.send('﻿' + buildPayCsv(roll.rows, roll.days));
  }));
}
