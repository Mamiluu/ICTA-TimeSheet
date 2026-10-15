// Copyright (c) 2026 Asya Hafidh <msanifuasiya@gmail.com>. All Rights Reserved.
// Proprietary and confidential. See LICENSE in the repository root.

import { Router } from 'express';
import { prisma } from '../lib/prisma.js';
import { writeAudit } from '../lib/audit.js';
import { ah } from '../lib/asyncHandler.js';
import { loadRoll } from '../lib/dutyRoll.js';
import { approvalCheck, canAccessKind, STAGE_LABEL } from '../lib/duty.js';
import { sealWholeEvent } from './admin.js';

// Where authorising officers and finance review the sheets sent up from their
// department. A department super admin can do both jobs; a county admin only the
// one their payment role says. Everything is scoped to the reviewer's department.
export const dutyReviewRouter = Router();

dutyReviewRouter.use((req, res, next) => {
  const u = req.user;
  if (!u) return res.status(401).json({ ok: false, error: 'NOT_AUTHENTICATED' });
  const reviewer = u.role === 'SUPER_ADMIN' || (u.role === 'COUNTY_ADMIN' && canAccessKind(u, 'DUTY_ROLL') && ['AUTHORISER', 'FINANCE'].includes(u.paymentRole));
  if (!reviewer || !u.departmentId) return res.status(403).json({ ok: false, error: 'FORBIDDEN' });
  next();
});

const NEXT_STEP = { SUBMITTED: 'CERTIFY', CERTIFIED: 'VERIFY' };

async function findSheet(req) {
  return prisma.event.findFirst({
    where: { id: req.params.id, kind: 'DUTY_ROLL', departmentId: req.user.departmentId, deletedAt: null, dutyStage: { not: 'OPEN' } },
    include: { owner: { select: { email: true } } }
  });
}

function flags(user, event, approvals) {
  const can = (step) => approvalCheck({ user, event, step, approvals }).ok;
  return { canCertify: can('CERTIFY'), canVerify: can('VERIFY'), canReturn: can('RETURN') };
}

dutyReviewRouter.get('/queue', ah(async (req, res) => {
  const events = await prisma.event.findMany({
    where: { kind: 'DUTY_ROLL', departmentId: req.user.departmentId, deletedAt: null, dutyStage: { not: 'OPEN' } },
    orderBy: { updatedAt: 'desc' },
    include: { owner: { select: { email: true } }, dutyApprovals: { orderBy: { createdAt: 'asc' } } }
  });
  const sheets = [];
  for (const ev of events) {
    const roll = await loadRoll(ev);
    const step = NEXT_STEP[ev.dutyStage];
    const submitted = ev.dutyApprovals.filter((a) => a.step === 'SUBMITTED').pop();
    sheets.push({
      id: ev.id,
      name: ev.name,
      county: ev.county,
      preparedBy: ev.owner ? ev.owner.email : null,
      authorisedBy: ev.authorisedBy,
      authorityRef: ev.authorityRef,
      stage: ev.dutyStage,
      stageLabel: STAGE_LABEL[ev.dutyStage],
      submittedAt: submitted ? submitted.createdAt : null,
      people: roll.totals.people,
      amount: roll.totals.amount,
      waitingForMe: !!step && approvalCheck({ user: req.user, event: ev, step, approvals: ev.dutyApprovals }).ok
    });
  }
  res.json({ ok: true, sheets });
}));

dutyReviewRouter.get('/sheets/:id', ah(async (req, res) => {
  const event = await findSheet(req);
  if (!event) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });
  const [roll, approvals, openQueries] = await Promise.all([
    loadRoll(event),
    prisma.dutyApproval.findMany({ where: { eventId: event.id }, orderBy: { createdAt: 'asc' } }),
    prisma.dutyQuery.count({ where: { eventId: event.id, status: 'OPEN' } })
  ]);
  // Names and phone numbers are on this page, so opening it is recorded like an export.
  await writeAudit({ actorId: req.user.id, action: 'DUTY_ROLL_REVIEWED', targetType: 'Event', targetId: event.id, metadata: { name: event.name, rowCount: roll.rows.length }, req });
  res.json({
    ok: true,
    event: {
      id: event.id,
      name: event.name,
      county: event.county,
      timezone: event.timezone,
      preparedBy: event.owner ? event.owner.email : null,
      authorisedBy: event.authorisedBy,
      authorityRef: event.authorityRef
    },
    stage: event.dutyStage,
    stageLabel: STAGE_LABEL[event.dutyStage],
    days: roll.days.map((d) => ({ id: d.id, position: d.position, startAt: d.startAt, endAt: d.endAt, place: d.place })),
    rows: roll.rows,
    totals: roll.totals,
    approvals: approvals.map((a) => ({ step: a.step, by: a.byEmail, note: a.note, sealCode: a.sealCode, at: a.createdAt })),
    openQueries,
    ...flags(req.user, event, approvals)
  });
}));

async function act(req, res, step) {
  const event = await findSheet(req);
  if (!event) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });
  const approvals = await prisma.dutyApproval.findMany({ where: { eventId: event.id }, orderBy: { createdAt: 'asc' } });
  const check = approvalCheck({ user: req.user, event, step, approvals });
  if (!check.ok) return res.status(check.error === 'WRONG_STAGE' ? 409 : 403).json({ ok: false, error: check.error, message: check.message });

  const note = String(req.body.note || '').replace(/\s+/g, ' ').trim().slice(0, 500);
  if (step === 'RETURN' && note.length < 5) {
    return res.status(400).json({ ok: false, error: 'NOTE_REQUIRED', message: 'Say what needs to be fixed, so the preparer knows.' });
  }

  // Claim the step first so two people pressing the button together cannot both win.
  const from = event.dutyStage;
  const to = step === 'CERTIFY' ? 'CERTIFIED' : step === 'VERIFY' ? 'VERIFIED' : 'OPEN';
  const claimed = await prisma.event.updateMany({ where: { id: event.id, dutyStage: from }, data: { dutyStage: to } });
  if (claimed.count === 0) return res.status(409).json({ ok: false, error: 'WRONG_STAGE', message: 'Someone else has just acted on this sheet. Reload to see where it is.' });

  try {
    let sealCode = null;
    if (step === 'CERTIFY') {
      const sealed = await sealWholeEvent(event, req);
      sealCode = sealed ? sealed.code : null;
    } else if (step === 'VERIFY') {
      const certified = [...approvals].reverse().find((a) => a.step === 'CERTIFIED');
      sealCode = certified ? certified.sealCode : null;
    }
    await prisma.dutyApproval.create({
      data: { eventId: event.id, step: step === 'RETURN' ? 'RETURNED' : to, byId: req.user.id, byEmail: req.user.email, note: note || null, sealCode }
    });
    await writeAudit({
      actorId: req.user.id,
      action: step === 'CERTIFY' ? 'DUTY_ROLL_CERTIFIED' : step === 'VERIFY' ? 'DUTY_ROLL_VERIFIED' : 'DUTY_ROLL_RETURNED',
      targetType: 'Event',
      targetId: event.id,
      metadata: { name: event.name, ...(sealCode ? { sealCode } : {}), ...(note ? { note } : {}) },
      req
    });
    res.json({ ok: true, stage: to, sealCode });
  } catch (err) {
    // Put the sheet back where it was rather than leave it half-approved.
    await prisma.event.updateMany({ where: { id: event.id, dutyStage: to }, data: { dutyStage: from } });
    throw err;
  }
}

dutyReviewRouter.post('/sheets/:id/certify', ah((req, res) => act(req, res, 'CERTIFY')));
dutyReviewRouter.post('/sheets/:id/verify', ah((req, res) => act(req, res, 'VERIFY')));
dutyReviewRouter.post('/sheets/:id/return', ah((req, res) => act(req, res, 'RETURN')));
