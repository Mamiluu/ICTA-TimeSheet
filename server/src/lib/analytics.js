// Copyright (c) 2026 Asya Hafidh <msanifuasiya@gmail.com>. All Rights Reserved.
// Proprietary and confidential. See LICENSE in the repository root.

// Kenya runs on a single timezone nationwide, so "today" for a cross-county
// (or cross-event) daily trend is unambiguous here in a way it isn't for
// any one event's own display (see formatEventWhen, which deliberately
// uses each event's own timezone instead) -- this is a different, simpler
// case: one aggregate, one country, one clock.
const KENYA_TZ = 'Africa/Nairobi';

// en-CA is used here purely as a trick to get Intl to format as
// YYYY-MM-DD -- this key is an internal grouping/sort key, never shown to
// a user, so the locale choice carries no locale meaning of its own.
function isoDayKey(date, timezone) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

// Buckets a list of UTC instants into per-day counts over the trailing
// `days` days (inclusive of `now`'s own day), zero-filled -- a chart built
// on this never has to guess whether a missing day means "nothing
// happened" or "wasn't fetched," and every window is always exactly
// `days` entries long regardless of how sparse the data is.
export function bucketByDay(instants, days, timezone = KENYA_TZ, now = new Date()) {
  const counts = new Map();
  for (const instant of instants) {
    const key = isoDayKey(instant, timezone);
    counts.set(key, (counts.get(key) || 0) + 1);
  }

  const buckets = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 86400000);
    const key = isoDayKey(d, timezone);
    buckets.push({ date: key, count: counts.get(key) || 0 });
  }
  return buckets;
}

// Turns a Prisma groupBy([{ status: 'ACTIVE', _count: { _all: 7 } }, ...])
// result into a plain { ACTIVE: 7, ... } map with every expected key
// present at 0 -- a status/consent value nobody has yet shouldn't just be
// missing from the response, which would force every caller to repeat the
// same `?? 0` fallback.
export function countsByKey(groups, keys, keyField) {
  const result = {};
  for (const k of keys) result[k === null ? 'null' : String(k)] = 0;
  for (const g of groups) {
    const k = g[keyField];
    result[k === null ? 'null' : String(k)] = g._count._all;
  }
  return result;
}

// The window a "this month / quarter / year" figure covers, in Kenya's calendar.
// Kenya has no daylight saving (UTC+3 all year), so a calendar boundary is a fixed offset.
export const PERIODS = ['month', 'quarter', 'year', 'all'];
export function periodBounds(period, now = new Date()) {
  if (!PERIODS.includes(period) || period === 'all') return null;
  const local = new Date(now.getTime() + 3 * 3600 * 1000);
  const y = local.getUTCFullYear();
  const m = local.getUTCMonth();
  const startMonth = period === 'month' ? m : period === 'quarter' ? m - (m % 3) : 0;
  const months = period === 'month' ? 1 : period === 'quarter' ? 3 : 12;
  const toUtc = (yy, mm) => new Date(Date.UTC(yy, mm, 1) - 3 * 3600 * 1000);
  return { from: toUtc(y, startMonth), to: toUtc(y, startMonth + months) };
}

// How many meetings, and how many of them were in person or online. Counts events only (a
// multi-day event is one meeting) and leaves out payment sheets, which are engagements to be
// paid rather than meetings. `period` limits it by the day the meeting starts.
export function meetingMix(events, period = 'all', now = new Date()) {
  const bounds = periodBounds(period, now);
  let physical = 0;
  let virtual = 0;
  for (const ev of events) {
    if (ev.kind === 'DUTY_ROLL') continue;
    if (bounds && (ev.startAt < bounds.from || ev.startAt >= bounds.to)) continue;
    if (ev.locationType === 'VIRTUAL') virtual += 1;
    else physical += 1;
  }
  return { period: PERIODS.includes(period) ? period : 'all', total: physical + virtual, physical, virtual };
}

// Per-day attendance for one event. `groups` is a Prisma groupBy of
// SessionSignature by [dayId, method]; `registered` is how many people are on
// the event. Counts only, never names. `missing` is people registered who have
// not signed that day, which for a later day includes those who simply did not
// come back.
export function summarizeDays(days, groups, registered) {
  return days.map((d) => {
    const mine = groups.filter((g) => g.dayId === d.id);
    const by = (m) => mine.filter((g) => g.method === m).reduce((n, g) => n + g._count._all, 0);
    const signed = mine.reduce((n, g) => n + g._count._all, 0);
    return {
      id: d.id,
      position: d.position,
      startAt: d.startAt,
      endAt: d.endAt,
      signed,
      byPhone: by('PHONE'),
      byDoor: by('DOOR'),
      missing: Math.max(0, registered - signed)
    };
  });
}