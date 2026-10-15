// Copyright (c) 2026 Asya Hafidh <msanifuasiya@gmail.com>. All Rights Reserved.
// Proprietary and confidential. See LICENSE in the repository root.

// Automatic checks on a payment sheet, run for the preparer before they submit it
// and for the approvers before they certify or verify it. A finding is a prompt to
// look, never an accusation: "review" items must be acknowledged by the approver,
// "note" items are for information.

const CLUSTER_WINDOW_MS = 2 * 60 * 1000;
const CLUSTER_MIN_PEOPLE = 4;
const RATE_OUTLIER_FACTOR = 1.5;
const RATE_GROUP_MIN = 3;

// ---- Calendar helpers ------------------------------------------------------

// YYYY-MM-DD for an instant as seen in a time zone.
export function localDate(iso, timeZone) {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
}

function weekday(dateStr) {
  return new Date(dateStr + 'T12:00:00Z').getUTCDay(); // 0 = Sunday
}

function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// Western Easter Sunday (the Meeus/Jones/Butcher method).
function easter(year) {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

// The fixed public holidays and Easter. Holidays that follow the moon (Idd-ul-Fitr
// and the like) are not included: they are announced each year, so they are not
// guessed at here. A holiday that falls on a Sunday moves to the Monday.
export function kenyaHoliday(dateStr) {
  const year = Number(dateStr.slice(0, 4));
  const fixed = [
    [`${year}-01-01`, "New Year's Day"],
    [`${year}-05-01`, 'Labour Day'],
    [`${year}-06-01`, 'Madaraka Day'],
    [`${year}-10-20`, 'Mashujaa Day'],
    [`${year}-12-12`, 'Jamhuri Day'],
    [`${year}-12-25`, 'Christmas Day'],
    [`${year}-12-26`, 'Boxing Day'],
    [addDays(easter(year), -2), 'Good Friday'],
    [addDays(easter(year), 1), 'Easter Monday']
  ];
  for (const [date, name] of fixed) {
    if (date === dateStr) return name;
    if (weekday(date) === 0 && addDays(date, 1) === dateStr) return `${name} (observed)`;
  }
  return null;
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export function dayWord(dateStr) {
  return DAY_NAMES[weekday(dateStr)];
}

function median(nums) {
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

const finding = (severity, code, title, detail, payeeIds = []) => ({ severity, code, title, detail, payeeIds });

// ---- The checks -------------------------------------------------------------

// rows: [{ id, name, idNumber, phoneNormalized, payeeType, jobRole, ratePerDay, addedAt,
//          cells: [{ dayId, status, signedAt?, sigHash? }] }]
// days: [{ id, position, startAt, place }]
// others: signatures the same people made on OTHER payment sheets in the department:
//   [{ eventName, idNumber, phoneNormalized, signed: [{ date: 'YYYY-MM-DD', place }] }]
export function analyzeDuty({ rows, days, timeZone, others = [] }) {
  const out = [];
  const dateOfDay = new Map(days.map((d) => [d.id, localDate(d.startAt, timeZone)]));
  const positionOfDay = new Map(days.map((d) => [d.id, d.position]));

  // 1. The same person claiming for the same date on another sheet.
  for (const r of rows) {
    const mine = new Map();
    for (const c of r.cells) if (c.status === 'SIGNED') mine.set(dateOfDay.get(c.dayId), days.find((d) => d.id === c.dayId));
    const clashes = new Map(); // other sheet name -> dates
    const phoneOnly = new Set();
    for (const o of others) {
      const sameId = o.idNumber && o.idNumber === r.idNumber;
      const samePhone = o.phoneNormalized && o.phoneNormalized === r.phoneNormalized;
      if (!sameId && !samePhone) continue;
      if (!sameId && samePhone) phoneOnly.add(o.eventName);
      const dates = o.signed.map((s) => s.date).filter((dt) => mine.has(dt));
      if (dates.length) clashes.set(o.eventName, [...(clashes.get(o.eventName) || []), ...dates]);
    }
    for (const [sheet, dates] of clashes) {
      const uniq = [...new Set(dates)].sort();
      out.push(
        finding(
          'review',
          'DOUBLE_CLAIM',
          `${r.name} also signed on another sheet for the same ${uniq.length === 1 ? 'day' : 'days'}`,
          `On ${uniq.join(', ')} they signed here and on “${sheet}”. Check they were not paid twice for the same day.`,
          [r.id]
        )
      );
    }
    for (const sheet of phoneOnly) {
      if (clashes.has(sheet)) continue;
      out.push(finding('review', 'PHONE_SHARED', `${r.name}'s phone number is on “${sheet}” under a different ID`, 'The same number is registered to someone else on another sheet. Check it is not being shared.', [r.id]));
    }
  }

  // 2. Signatures that are byte-for-byte the same: a drawn signature is never exactly
  // the same twice, so this means a copy was reused.
  const byHash = new Map();
  for (const r of rows) {
    for (const c of r.cells) {
      if (c.status !== 'SIGNED' || !c.sigHash) continue;
      byHash.set(c.sigHash, [...(byHash.get(c.sigHash) || []), { r, c }]);
    }
  }
  for (const group of byHash.values()) {
    if (group.length < 2) continue;
    const people = [...new Set(group.map((g) => g.r.id))];
    if (people.length > 1) {
      const names = [...new Set(group.map((g) => g.r.name))];
      out.push(finding('review', 'SAME_SIGNATURE_PEOPLE', 'The same signature appears for different people', `${names.join(' and ')} have an identical signature image. A signature is never drawn exactly the same twice.`, people));
    } else {
      const p = group.map((g) => `day ${positionOfDay.get(g.c.dayId)}`).join(' and ');
      out.push(finding('review', 'SAME_SIGNATURE_DAYS', `${group[0].r.name} has an identical signature on ${p}`, 'A signature is never drawn exactly the same twice, so one may have been copied.', [group[0].r.id]));
    }
  }

  // 3. Weekends and public holidays that carry signatures.
  for (const d of days) {
    const date = dateOfDay.get(d.id);
    const signed = rows.filter((r) => r.cells.some((c) => c.dayId === d.id && c.status === 'SIGNED'));
    if (!signed.length) continue;
    const dow = weekday(date);
    const holiday = kenyaHoliday(date);
    if (holiday) out.push(finding('note', 'HOLIDAY', `Day ${d.position} is a public holiday`, `${dayWord(date)} ${date} is ${holiday}. ${signed.length} ${signed.length === 1 ? 'person signed' : 'people signed'}. Confirm the work was needed.`));
    else if (dow === 0 || dow === 6) out.push(finding('note', 'WEEKEND', `Day ${d.position} is a ${dayWord(date)}`, `${signed.length} ${signed.length === 1 ? 'person signed' : 'people signed'} on ${date}. Confirm weekend work was authorised.`));
  }

  // 4. A daily rate well above what others in the same group are paid.
  const groups = new Map();
  for (const r of rows) {
    const key = `${r.payeeType}|${(r.jobRole || '').toLowerCase()}`;
    groups.set(key, [...(groups.get(key) || []), r]);
  }
  for (const group of groups.values()) {
    if (group.length < RATE_GROUP_MIN) continue;
    const mid = median(group.map((g) => g.ratePerDay));
    if (mid <= 0) continue;
    for (const r of group) {
      if (r.ratePerDay > mid * RATE_OUTLIER_FACTOR) {
        out.push(finding('note', 'RATE_HIGH', `${r.name}'s rate is higher than the rest of the group`, `KES ${r.ratePerDay.toLocaleString('en-KE')} a day, where the usual rate for ${r.payeeType === 'STAFF' ? 'staff' : 'external invitees'}${r.jobRole ? ' (' + r.jobRole + ')' : ''} on this sheet is about KES ${Math.round(mid).toLocaleString('en-KE')}.`, [r.id]));
      }
    }
  }

  // 5. People added after the engagement had already started.
  const firstStart = days.length ? new Date(days[0].startAt).getTime() : null;
  if (firstStart) {
    const late = rows.filter((r) => r.addedAt && new Date(r.addedAt).getTime() > firstStart);
    if (late.length) out.push(finding('note', 'LATE_ADDED', `${late.length} ${late.length === 1 ? 'person was' : 'people were'} added after the engagement started`, `${late.map((l) => l.name).join(', ')}. The reason for each is in the audit trail.`, late.map((l) => l.id)));
  }

  // 6. Many different people signing within a couple of minutes.
  const stamps = [];
  for (const r of rows) for (const c of r.cells) if (c.status === 'SIGNED' && c.signedAt) stamps.push({ t: new Date(c.signedAt).getTime(), id: r.id, dayId: c.dayId });
  const reportedDays = new Set();
  for (const d of days) {
    const list = stamps.filter((s) => s.dayId === d.id).sort((a, b) => a.t - b.t);
    for (let i = 0; i < list.length && !reportedDays.has(d.id); i++) {
      const window = list.filter((s) => s.t >= list[i].t && s.t < list[i].t + CLUSTER_WINDOW_MS);
      const people = new Set(window.map((w) => w.id));
      if (people.size >= CLUSTER_MIN_PEOPLE) {
        reportedDays.add(d.id);
        out.push(finding('note', 'CLUSTERED_SIGNING', `${people.size} people signed within two minutes on day ${d.position}`, 'That is normal if they were together at the start of the day. If they were at different places, ask who signed for whom.', [...people]));
      }
    }
  }

  const order = { review: 0, note: 1 };
  return out.sort((a, b) => order[a.severity] - order[b.severity]);
}

export function countFindings(findings) {
  const review = findings.filter((f) => f.severity === 'review').length;
  return { review, notes: findings.length - review };
}
