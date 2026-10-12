// Copyright (c) 2026 Asya Hafidh <msanifuasiya@gmail.com>. All Rights Reserved.
// Proprietary and confidential. See LICENSE in the repository root.

import { prisma } from './prisma.js';
import { DAY_SIGN_OPENS_BEFORE_MS, DAY_SIGN_CLOSES_AFTER_MS } from './constants.js';

export function dayOpensAt(day) {
  return new Date(day.startAt.getTime() - DAY_SIGN_OPENS_BEFORE_MS);
}

// An admin can reopen a closed day for a limited time (reopenedUntil). That
// only ever extends the window, never shortens it.
export function dayClosesAt(day) {
  const normal = day.endAt.getTime() + DAY_SIGN_CLOSES_AFTER_MS;
  const extended = day.reopenedUntil ? new Date(day.reopenedUntil).getTime() : 0;
  return new Date(Math.max(normal, extended));
}

export function dayIsOpen(day, now = Date.now()) {
  const extended = day.reopenedUntil && now <= new Date(day.reopenedUntil).getTime();
  return (now >= dayOpensAt(day).getTime() && now <= dayClosesAt(day).getTime()) || !!extended;
}

export const REOPEN_DEFAULT_HOURS = 24;
export const REOPEN_MAX_HOURS = 72;

export const MAX_EVENT_DAYS = 31;

// Checks a day schedule sent by the admin form: 1..MAX_EVENT_DAYS sessions,
// each starting before it ends, in order, with no overlap. Returns
// { days } with Date objects, or { error } with a message fit to show.
export function parseDaySchedule(input) {
  if (!Array.isArray(input) || input.length < 1) return { error: 'Add at least one day.' };
  if (input.length > MAX_EVENT_DAYS) return { error: `An event can run for at most ${MAX_EVENT_DAYS} days.` };
  const days = [];
  for (const [i, d] of input.entries()) {
    const startAt = new Date(d && d.startAt);
    const endAt = new Date(d && d.endAt);
    if (isNaN(startAt.getTime()) || isNaN(endAt.getTime())) return { error: `Day ${i + 1} has an invalid date or time.` };
    if (startAt.getTime() >= endAt.getTime()) return { error: `Day ${i + 1} must end after it starts.` };
    if (i > 0 && startAt.getTime() < days[i - 1].endAt.getTime()) return { error: `Day ${i + 1} overlaps the day before it.` };
    days.push({ startAt, endAt });
  }
  return { days };
}

// A body without `days` is the classic single-day event. With `days`, the
// event's own startAt/endAt become the first day's start and the last day's
// end, so every existing reader of those two columns keeps working.
export function resolveSchedule(body, f) {
  if (body.days === undefined) return { days: [{ startAt: f.startAt, endAt: f.endAt }], startAt: f.startAt, endAt: f.endAt };
  const parsed = parseDaySchedule(body.days);
  if (parsed.error) return parsed;
  return { days: parsed.days, startAt: parsed.days[0].startAt, endAt: parsed.days[parsed.days.length - 1].endAt };
}

// Which day a brand-new sign-in belongs to. The day whose window is open wins
// (the later one if two windows overlap); before the event starts it is the
// first day; between or after days it is the day that most recently started,
// so a late sign-in lands on the day it was meant for rather than on day 1.
export function pickSigningDay(days, now = Date.now()) {
  if (!days.length) return null;
  const open = days.filter((d) => dayIsOpen(d, now));
  if (open.length) return open[open.length - 1];
  const started = days.filter((d) => d.startAt.getTime() <= now);
  return started.length ? started[started.length - 1] : days[0];
}

// The day an attendee's identity-level signature belongs to: the earliest day
// they signed. Self-edits and signature-recovery links replace that one,
// rather than quietly adding a signature for a day they never attended.
export async function anchorDayFor(attendanceId, event) {
  const first = await prisma.sessionSignature.findFirst({
    where: { attendanceId },
    orderBy: { day: { position: 'asc' } },
    select: { dayId: true }
  });
  if (first) return { id: first.dayId };
  return ensureFirstDay(event);
}

// Every event has a day 1 once the multi-day migration has run; events
// created afterwards get it from the admin create route. The upsert covers
// any event that somehow reaches a sign-in without one, without ever
// creating a duplicate.
export function ensureFirstDay(event) {
  return prisma.eventDay.upsert({
    where: { eventId_position: { eventId: event.id, position: 1 } },
    update: {},
    create: { eventId: event.id, position: 1, startAt: event.startAt, endAt: event.endAt }
  });
}
