// Copyright (c) 2026 Asya Hafidh <msanifuasiya@gmail.com>. All Rights Reserved.
// Proprietary and confidential. See LICENSE in the repository root.

import { prisma } from './prisma.js';
import { logger } from './logger.js';
import { notifyDuty } from './dutyNotify.js';

// A payment sheet that sits too long with the person who has to act gets a reminder email. The wait
// is counted from the last step on the sheet, or from the last reminder, so nobody is nagged daily.
// PAYMENT_REMINDER_DAYS sets the wait (default 3); 0 turns reminders off. After MAX_REMINDERS the job
// stops, because by then a person needs to pick up the phone, not another email.
export const DEFAULT_REMINDER_DAYS = 3;
export const MAX_REMINDERS = 4;
const DAY_MS = 24 * 60 * 60 * 1000;

export function reminderDays(env = process.env.PAYMENT_REMINDER_DAYS) {
  if (env === undefined || env === '') return DEFAULT_REMINDER_DAYS;
  const n = Number(env);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_REMINDER_DAYS;
}

// The sheet's own facts in, a yes or a no out. lastStepAt is when it last moved; remindedAt when it
// was last nudged. A paid sheet and an open one are never nudged.
export function reminderDue({ stage, paidAt, lastStepAt, remindedAt, count, now = Date.now(), days }) {
  if (!days || days <= 0) return false;
  if (!['SUBMITTED', 'CERTIFIED', 'VERIFIED'].includes(stage)) return false;
  if (paidAt) return false;
  if ((count || 0) >= MAX_REMINDERS) return false;
  const since = Math.max(lastStepAt ? new Date(lastStepAt).getTime() : 0, remindedAt ? new Date(remindedAt).getTime() : 0);
  if (!since) return false;
  return now - since >= days * DAY_MS;
}

export async function sendDueReminders(now = Date.now()) {
  const days = reminderDays();
  if (!days) return 0;
  const events = await prisma.event.findMany({
    where: { kind: 'DUTY_ROLL', deletedAt: null, paidAt: null, dutyStage: { in: ['SUBMITTED', 'CERTIFIED', 'VERIFIED'] }, organisation: { status: 'ACTIVE' }, department: { active: true } },
    include: { dutyApprovals: { orderBy: { createdAt: 'desc' }, take: 1 } }
  });
  let sent = 0;
  for (const ev of events) {
    const last = ev.dutyApprovals[0];
    if (!reminderDue({ stage: ev.dutyStage, paidAt: ev.paidAt, lastStepAt: last ? last.createdAt : null, remindedAt: ev.remindedAt, count: ev.reminderCount, now, days })) continue;
    // Claim it first so two runs cannot both send.
    const claimed = await prisma.event.updateMany({ where: { id: ev.id, reminderCount: ev.reminderCount }, data: { remindedAt: new Date(now), reminderCount: { increment: 1 } } });
    if (claimed.count === 0) continue;
    const since = Math.max(last ? last.createdAt.getTime() : 0, ev.remindedAt ? ev.remindedAt.getTime() : 0);
    notifyDuty(ev, ev.dutyStage, { reminder: true, waitingDays: String(Math.max(1, Math.round((now - since) / DAY_MS))) });
    sent += 1;
  }
  return sent;
}

// Checked every few hours and on start. It reads the sheets' own dates, so a restart, or a sleeping
// free instance waking up late, never doubles up reminders.
export function startReminderJob() {
  if (!reminderDays()) return;
  let running = false;
  async function tick() {
    if (running) return;
    running = true;
    try {
      const n = await sendDueReminders();
      if (n) logger.info('payment sheet reminders sent', { sheets: n });
    } catch (err) {
      logger.error('reminder job failed', { stack: err.stack });
    } finally {
      running = false;
    }
  }
  setTimeout(tick, 60 * 1000).unref();
  setInterval(tick, 3 * 60 * 60 * 1000).unref();
}