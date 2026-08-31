// Copyright (c) 2026 Asya Hafidh <msanifuasiya@gmail.com>. All Rights Reserved.
// Proprietary and confidential. See LICENSE in the repository root.

// Node ships full ICU by default (has since Node 13), so Intl with an
// arbitrary IANA zone name works with no extra dependency -- this just
// asks Intl to format with that zone and lets it throw on anything it
// doesn't recognize, rather than maintaining our own zone name list.
export function isValidTimeZone(tz) {
  if (typeof tz !== 'string' || !tz) return false;
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// Renders `date` (a UTC instant) as wall-clock time in `timezone` --
// that's the whole point: an event's start/end must always read the same
// way regardless of which timezone the viewer's own device happens to be
// in, the same reasoning the old formatRecordedAt (mailer.js) already
// documented for its one hardcoded Africa/Nairobi case, generalized here
// to any event's own zone.
export function formatInZone(date, timezone, opts) {
  return new Intl.DateTimeFormat('en-GB', { ...opts, timeZone: timezone }).format(date);
}

// Short zone-abbreviation suffix (e.g. "EAT", "GMT", "UTC") for the label
// at the end of a rendered time -- shortOffsetName falls back to a
// numeric offset ("GMT+3") on zones with no common abbreviation, which is
// still unambiguous, just less familiar than "EAT".
function zoneAbbreviation(date, timezone) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, timeZoneName: 'short' }).formatToParts(date);
  const tzPart = parts.find((p) => p.type === 'timeZoneName');
  return tzPart ? tzPart.value : timezone;
}

const DATE_OPTS = { weekday: 'short', day: 'numeric', month: 'short' };
const YEAR_OPTS = { year: 'numeric' };
const TIME_OPTS = { hour: 'numeric', minute: '2-digit' };

// The single "when" string used both on the attendee page and in the
// confirmation email: a compact single-day form ("Wed, 5 Mar 2026 · 2:00
// PM - 4:00 PM EAT") when start and end fall on the same calendar day *in
// the event's own timezone*, or a spans-days form naming both dates
// otherwise -- comparing calendar days has to happen in that zone too
// (comparing raw UTC dates would misjudge an event that, say, runs
// 11pm-1am local time as spanning two days when the audience never
// experiences it that way, or vice versa).
export function formatEventWhen(startAt, endAt, timezone) {
  const startDay = formatInZone(startAt, timezone, DATE_OPTS);
  const endDay = formatInZone(endAt, timezone, DATE_OPTS);
  const startTime = formatInZone(startAt, timezone, TIME_OPTS);
  const endTime = formatInZone(endAt, timezone, TIME_OPTS);
  const tz = zoneAbbreviation(startAt, timezone);
  const year = formatInZone(startAt, timezone, YEAR_OPTS);

  if (startDay === endDay) {
    return `${startDay} ${year} · ${startTime} – ${endTime} ${tz}`;
  }
  return `${startDay}, ${startTime} – ${endDay}, ${endTime} ${tz}`;
}
