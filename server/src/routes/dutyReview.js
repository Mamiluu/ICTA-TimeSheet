// Copyright (c) 2026 Asya Hafidh <msanifuasiya@gmail.com>. All Rights Reserved.
// Proprietary and confidential. See LICENSE in the repository root.

import { Router } from 'express';
import { prisma } from '../lib/prisma.js';
import { writeAudit } from '../lib/audit.js';
import { ah } from '../lib/asyncHandler.js';
import { loadRoll, loadFindings, withoutHashes } from '../lib/dutyRoll.js';
import { countFindings } from '../lib/dutyChecks.js';
import { approvalCheck, canAccessKind, STAGE_LABEL } from '../lib/duty.js';
import { sealWholeEvent } from './admin.js';
import { hasModule } from '../lib/plans.js';
import { notifyDuty } from '../lib/dutyNotify.js';

// Where authorising officers and finance review the sheets sent up from their
// department. A department super admin can do both jobs; a county admin only the
// one their payment role says. Everything is scoped to the reviewer's department.
export const dutyReviewRouter = Router();

dutyReviewRouter.use((req, res, next) => {
  const u = req.user;
  if (!u) return res.status(401).json({ ok: false, error: 'NOT_AUTHENTICATED' });
  const reviewer = u.role === 'SUPER_ADMIN' || (u.role === 'COUNTY_ADMIN' && canAccessKind(u, 'DUTY_ROLL') && ['AUTHORISER', 'FINANCE'].includes(u.paymentRole));
  if (!reviewer || !u.departmentId) return res.status(403).json({ ok: false, error: 'FORBIDDEN' });
  if (!hasModule(u.organisation, 'PAYMENT')) return res.status(403).json({ ok: false, error: 'MODULE_OFF', message: 'Payment sheets are not part of your organisation\'s plan.' });
  next();
});

const NEXT_STEP = { SUBMITTED: 'CERTIFY', CERTIFIED: 'VERIFY', VERIFIED: 'PAY' };

async function findSheet(req) {
  return prisma.event.findFirst({
    where: { id: req.params.id, kind: 'DUTY_ROLL', departmentId: req.user.departmentId, deletedAt: null, dutyStage: { not: 'OPEN' } },
    include: { owner: { select: { email: true } } }
  });
}

function flags(user, event, approvals) {
  const can = (step) => approvalCheck({ user, event, step, approvals }).ok;
  return { canCertify: can('CERTIFY'), canVerify: can('VERIFY'), canReturn: can('RETURN'), canPay: can('PAY') };
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
      paid: Boolean(ev.paidAt),
      paidAt: ev.paidAt,
      paidReference: ev.paidReference,
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
    loadRoll(event, { withHashes: true }),
    prisma.dutyApproval.findMany({ where: { eventId: event.id }, orderBy: { createdAt: 'asc' } }),
    prisma.dutyQuery.count({ where: { eventId: event.id, status: 'OPEN' } })
  ]);
  // Names and phone numbers are on this page, so opening it is recorded like an export.
  const findings = await loadFindings(event, roll);
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
    paid: Boolean(event.paidAt),
    paidAt: event.paidAt,
    paidReference: event.paidReference,
    paidBy: event.paidByEmail,
    stage: event.dutyStage,
    stageLabel: STAGE_LABEL[event.dutyStage],
    days: roll.days.map((d) => ({ id: d.id, position: d.position, startAt: d.startAt, endAt: d.endAt, place: d.place })),
    rows: withoutHashes(roll.rows),
    totals: roll.totals,
    findings,
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

  // Whoever certifies or verifies has to say they have looked at anything the automatic
  // checks flagged for review. What they were shown goes into the audit trail.
  let seen = null;
  if (step === 'CERTIFY' || step === 'VERIFY') {
    const roll = await loadRoll(event, { withHashes: true });
    seen = countFindings(await loadFindings(event, roll));
    if (seen.review > 0 && req.body.acknowledge !== true) {
      return res.status(400).json({
        ok: false,
        error: 'REVIEW_REQUIRED',
        message: `Tick the box to confirm you have looked at the ${seen.review} item${seen.review === 1 ? '' : 's'} flagged for review.`
      });
    }
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
      metadata: { name: event.name, ...(sealCode ? { sealCode } : {}), ...(note ? { note } : {}), ...(seen ? { review: seen.review, notes: seen.notes, acknowledged: seen.review > 0 } : {}) },
      req
    });
    notifyDuty(event, step === 'CERTIFY' ? 'CERTIFIED' : step === 'VERIFY' ? 'VERIFIED' : 'RETURNED', { actorEmail: req.user.email, note: note || null });
    res.json({ ok: true, stage: to, sealCode });
  } catch (err) {
    // Put the sheet back where it was rather than leave it half-approved.
    await prisma.event.updateMany({ where: { id: event.id, dutyStage: to }, data: { dutyStage: from } });
    throw err;
  }
}

// Finance marks a verified sheet as paid, with the payment reference. The sheet stays verified; the
// payment is recorded beside it, in its history and in the audit trail.
dutyReviewRouter.post('/sheets/:id/paid', ah(async (req, res) => {
  const event = await findSheet(req);
  if (!event) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });
  const approvals = await prisma.dutyApproval.findMany({ where: { eventId: event.id }, orderBy: { createdAt: 'asc' } });
  const check = approvalCheck({ user: req.user, event, step: 'PAY', approvals });
  if (!check.ok) return res.status(check.error === 'WRONG_STAGE' || check.error === 'ALREADY_PAID' ? 409 : 403).json({ ok: false, error: check.error, message: check.message });

  const reference = String(req.body.reference || '').replace(/\s+/g, ' ').trim().slice(0, 60);
  if (reference.length < 3) return res.status(400).json({ ok: false, error: 'REFERENCE_REQUIRED', message: 'Enter the payment reference, for example the voucher or transfer number.' });

  const paidAt = new Date();
  // Claim it first so two people pressing the button together cannot both record a payment.
  const claimed = await prisma.event.updateMany({ where: { id: event.id, dutyStage: 'VERIFIED', paidAt: null }, data: { paidAt, paidReference: reference, paidByEmail: req.user.email } });
  if (claimed.count === 0) return res.status(409).json({ ok: false, error: 'ALREADY_PAID', message: 'Someone else has just recorded the payment. Reload to see it.' });
  await prisma.dutyApproval.create({ data: { eventId: event.id, step: 'PAID', byId: req.user.id, byEmail: req.user.email, note: reference } });
  await writeAudit({ actorId: req.user.id, action: 'DUTY_ROLL_PAID', targetType: 'Event', targetId: event.id, metadata: { name: event.name, reference }, req });
  notifyDuty(event, 'PAID', { actorEmail: req.user.email, reference });
  res.json({ ok: true, paidAt, reference });
}));

dutyReviewRouter.post('/sheets/:id/certify', ah((req, res) => act(req, res, 'CERTIFY')));
dutyReviewRouter.post('/sheets/:id/verify', ah((req, res) => act(req, res, 'VERIFY')));
dutyReviewRouter.post('/sheets/:id/return', ah((req, res) => act(req, res, 'RETURN')));
