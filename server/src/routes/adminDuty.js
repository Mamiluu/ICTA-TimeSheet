// Copyright (c) 2026 Asya Hafidh <msanifuasiya@gmail.com>. All Rights Reserved.
// Proprietary and confidential. See LICENSE in the repository root.

import crypto from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { writeAudit } from '../lib/audit.js';
import { ah } from '../lib/asyncHandler.js';
import { MAX_ATTENDANCE_PER_EVENT } from '../lib/constants.js';
import { cleanPayee, buildPayCsv, MAX_RATE_PER_DAY, sheetIsOpen, approvalCheck, STAGE_LABEL } from '../lib/duty.js';
import { notifyDuty } from '../lib/dutyNotify.js';
import { loadRoll, loadFindings, withoutHashes } from '../lib/dutyRoll.js';
import { dayClosesAt } from '../lib/days.js';

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

  // Once a sheet is submitted nothing on it may change, so the approvers see exactly
  // what the preparer sent. The authorising officer can return it if it needs fixing.
  function refuseIfLocked(event, res) {
    if (sheetIsOpen(event)) return false;
    res.status(409).json({ ok: false, error: 'SHEET_LOCKED', message: 'This sheet has been submitted and can no longer be changed. Ask the authorising officer to return it if something needs fixing.' });
    return true;
  }

  router.get('/events/:id/duty', ah(async (req, res) => {
    const event = await dutyEvent(req, res);
    if (!event) return;
    const print = req.query.print === '1';
    const [roll, approvals, openQueries] = await Promise.all([
      loadRoll(event, { withSignatures: print, withHashes: !print }),
      prisma.dutyApproval.findMany({ where: { eventId: event.id }, orderBy: { createdAt: 'asc' } }),
      prisma.dutyQuery.count({ where: { eventId: event.id, status: 'OPEN' } })
    ]);
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
      rows: withoutHashes(roll.rows),
      totals: roll.totals,
      stage: event.dutyStage,
      stageLabel: STAGE_LABEL[event.dutyStage],
      approvals: approvals.map((a) => ({ step: a.step, by: a.byEmail, note: a.note, sealCode: a.sealCode, at: a.createdAt })),
      openQueries,
      findings: print ? [] : await loadFindings(event, roll),
      maxRate: MAX_RATE_PER_DAY
    });
  }));

  router.post('/events/:id/duty/payees', ah(async (req, res) => {
    const event = await dutyEvent(req, res);
    if (!event) return;
    if (refuseIfLocked(event, res)) return;

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
    if (refuseIfLocked(event, res)) return;
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
    if (refuseIfLocked(event, res)) return;
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

  // The preparer sends the finished sheet for certification. It must have people on it
  // and every day must have closed; sending it early needs a reason, which is recorded.
  router.post('/events/:id/duty/submit', ah(async (req, res) => {
    const event = await dutyEvent(req, res);
    if (!event) return;
    const approvals = await prisma.dutyApproval.findMany({ where: { eventId: event.id }, orderBy: { createdAt: 'asc' } });
    const check = approvalCheck({ user: req.user, event, step: 'SUBMIT', approvals });
    if (!check.ok) return res.status(check.error === 'WRONG_STAGE' ? 409 : 403).json({ ok: false, error: check.error, message: check.message });

    const roll = await loadRoll(event);
    if (!roll.rows.length) return res.status(400).json({ ok: false, error: 'EMPTY', message: 'There is nobody on this sheet yet.' });
    const lastDay = roll.days[roll.days.length - 1];
    const unfinished = !lastDay || Date.now() <= dayClosesAt(lastDay).getTime();
    const note = String(req.body.note || '').replace(/\s+/g, ' ').trim().slice(0, 300);
    if (unfinished && note.length < 5) {
      return res.status(400).json({ ok: false, error: 'REASON_REQUIRED', message: 'Not every day has closed yet. Say why the sheet is being sent now.' });
    }
    const openQueries = await prisma.dutyQuery.count({ where: { eventId: event.id, status: 'OPEN' } });
    if (openQueries > 0) {
      return res.status(409).json({ ok: false, error: 'OPEN_QUERIES', message: `${openQueries} question${openQueries === 1 ? ' is' : 's are'} still open from people on this sheet. Answer them first.` });
    }

    await prisma.$transaction([
      prisma.event.update({ where: { id: event.id }, data: { dutyStage: 'SUBMITTED' } }),
      prisma.dutyApproval.create({ data: { eventId: event.id, step: 'SUBMITTED', byId: req.user.id, byEmail: req.user.email, note: note || null } })
    ]);
    await writeAudit({ actorId: req.user.id, action: 'DUTY_ROLL_SUBMITTED', targetType: 'Event', targetId: event.id, metadata: { name: event.name, people: roll.rows.length, amount: roll.totals.amount, ...(unfinished ? { early: true, reason: note } : {}) }, req });
    notifyDuty(event, 'SUBMITTED', { actorEmail: req.user.email, note: note || null, people: roll.rows.length, amount: roll.totals.amount });
    res.json({ ok: true });
  }));

  // Questions raised by the people on the sheet, and the organiser's answers.
  router.get('/events/:id/duty/queries', ah(async (req, res) => {
    const event = await dutyEvent(req, res);
    if (!event) return;
    const queries = await prisma.dutyQuery.findMany({
      where: { eventId: event.id },
      orderBy: { createdAt: 'desc' },
      include: { payee: { include: { attendance: { select: { name: true } } } } }
    });
    const days = await prisma.eventDay.findMany({ where: { eventId: event.id }, select: { id: true, position: true } });
    const pos = new Map(days.map((d) => [d.id, d.position]));
    res.json({
      ok: true,
      queries: queries.map((q) => ({ id: q.id, name: q.payee.attendance.name, day: pos.get(q.dayId) || null, message: q.message, status: q.status, response: q.response, at: q.createdAt }))
    });
  }));

  router.post('/events/:id/duty/queries/:qid/resolve', ah(async (req, res) => {
    const event = await dutyEvent(req, res);
    if (!event) return;
    const q = await prisma.dutyQuery.findFirst({ where: { id: req.params.qid, eventId: event.id, status: 'OPEN' } });
    if (!q) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });
    const response = String(req.body.response || '').replace(/\s+/g, ' ').trim().slice(0, 300);
    if (response.length < 3) return res.status(400).json({ ok: false, error: 'RESPONSE_REQUIRED', message: 'Write a short answer for the person.' });
    await prisma.dutyQuery.update({ where: { id: q.id }, data: { status: 'RESOLVED', response, resolvedById: req.user.id, resolvedAt: new Date() } });
    await writeAudit({ actorId: req.user.id, action: 'DUTY_QUERY_RESOLVED', targetType: 'Event', targetId: event.id, metadata: { name: event.name, response }, req });
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
