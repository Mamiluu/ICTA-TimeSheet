// Copyright (c) 2026 Asya Hafidh <msanifuasiya@gmail.com>. All Rights Reserved.
// Proprietary and confidential. See LICENSE in the repository root.

import { normalizePhone } from './normalize.js';
import { dayOpensAt, dayClosesAt } from './days.js';

// ---- Who may see which kind of event --------------------------------------

// A department super admin runs their whole department, so they see both kinds.
// A county admin sees what the super admin granted. Anyone else sees nothing.
export function accessOf(user) {
  if (!user) return null;
  if (user.role === 'SUPER_ADMIN') return 'BOTH';
  if (user.role === 'COUNTY_ADMIN') return user.access || 'ATTENDANCE';
  return null;
}

export function kindsFor(user) {
  const a = accessOf(user);
  if (a === 'BOTH') return ['ATTENDANCE', 'DUTY_ROLL'];
  if (a === 'PAYMENT') return ['DUTY_ROLL'];
  if (a === 'ATTENDANCE') return ['ATTENDANCE'];
  return [];
}

export function canAccessKind(user, kind) {
  return kindsFor(user).includes(kind || 'ATTENDANCE');
}

export const ACCESS_LEVELS = ['ATTENDANCE', 'PAYMENT', 'BOTH'];

// ---- Days: what each cell of the sheet means ------------------------------

// SIGNED: the person signed. OPEN: signing is open now. UPCOMING: not yet.
// ABSENT: the day has closed with no signature -- the digital version of the
// line drawn through an unused cell on paper.
export function dayStatus(day, signed, now = Date.now()) {
  if (signed) return 'SIGNED';
  if (now < dayOpensAt(day).getTime()) return 'UPCOMING';
  if (now <= dayClosesAt(day).getTime()) return 'OPEN';
  return 'ABSENT';
}

export function payFor(ratePerDay, daysSigned) {
  return Math.max(0, Math.trunc(ratePerDay)) * Math.max(0, Math.trunc(daysSigned));
}

// payees: [{ id, name, ..., ratePerDay }], days: [{ id, startAt, endAt, reopenedUntil }],
// signedByPayee: Map(payeeId -> Set(dayId)). Returns one row per payee with a status
// for every day, the number of days signed and the amount due.
export function buildPayRows(payees, days, signedByPayee, now = Date.now()) {
  return payees.map((p) => {
    const signed = signedByPayee.get(p.id) || new Set();
    const cells = days.map((d) => ({ dayId: d.id, status: dayStatus(d, signed.has(d.id), now) }));
    const daysSigned = cells.filter((c) => c.status === 'SIGNED').length;
    return { ...p, cells, daysSigned, amount: payFor(p.ratePerDay, daysSigned) };
  });
}

export function totalsOf(rows) {
  return { people: rows.length, daysSigned: rows.reduce((n, r) => n + r.daysSigned, 0), amount: rows.reduce((n, r) => n + r.amount, 0) };
}

// The paper form had room for nine day columns on a page; more days continue on
// the next page with the same people listed again.
export function chunk(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

// ---- Adding a person to the roster ----------------------------------------

export const MAX_RATE_PER_DAY = 1000000;
export const PAYEE_TYPES = ['STAFF', 'EXTERNAL'];

function text(v, max) {
  return String(v ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

// Returns { value } or { error } with a message fit to show.
export function cleanPayee(body) {
  const name = text(body.name, 120);
  if (name.length < 2) return { error: 'Enter the person\'s full name.' };

  const payeeType = PAYEE_TYPES.includes(body.payeeType) ? body.payeeType : null;
  if (!payeeType) return { error: 'Choose whether this is ICTA staff or an external invitee.' };

  const idNumber = text(body.idNumber, 30).toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9/._-]{2,29}$/.test(idNumber)) {
    return { error: payeeType === 'STAFF' ? 'Enter the staff number.' : 'Enter the national ID number.' };
  }

  const phone = text(body.phone, 30);
  const phoneNormalized = normalizePhone(phone);
  if (!phoneNormalized) return { error: 'Enter a valid Kenyan phone number. The person uses it to sign each day.' };

  const rate = Number(body.ratePerDay);
  if (!Number.isInteger(rate) || rate < 0 || rate > MAX_RATE_PER_DAY) {
    return { error: `The daily rate must be a whole number of shillings between 0 and ${MAX_RATE_PER_DAY.toLocaleString('en-KE')}.` };
  }

  const organisation = text(body.organisation, 120) || (payeeType === 'STAFF' ? 'ICTA' : '');
  if (!organisation) return { error: 'Enter the organisation the external invitee comes from.' };

  return { value: { name, payeeType, idNumber, phone, phoneNormalized, ratePerDay: rate, organisation, jobRole: text(body.jobRole, 60) || null } };
}

// ---- Event-level fields ----------------------------------------------------

export function cleanAuthority(body) {
  const authorisedBy = text(body.authorisedBy, 120);
  const authorityRef = text(body.authorityRef, 120);
  if (!authorisedBy) return { error: 'Enter the officer who authorised this engagement.' };
  if (!authorityRef) return { error: 'Enter the memo or invitation reference for this engagement.' };
  return { value: { authorisedBy, authorityRef } };
}

export function cleanPlace(v) {
  return text(v, 80) || null;
}

// ---- Spreadsheet export ----------------------------------------------------

// A cell starting with = + - or @ can run as a formula when the file is opened in
// a spreadsheet, so those are defused with a leading apostrophe.
export function csvCell(v) {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

export function buildPayCsv(rows, days) {
  const head = ['No', 'Name', 'Type', 'ID / Staff no', 'Organisation', 'Role', 'Phone', 'Rate per day (KES)', ...days.map((d) => `Day ${d.position}`), 'Days signed', 'Amount (KES)'];
  const lines = [head.map(csvCell).join(',')];
  rows.forEach((r, i) => {
    const cells = r.cells.map((c) => (c.status === 'SIGNED' ? 'Signed' : c.status === 'ABSENT' ? 'Absent' : c.status === 'OPEN' ? 'Open' : ''));
    lines.push(
      [i + 1, r.name, r.payeeType === 'STAFF' ? 'Staff' : 'External', r.idNumber, r.organisation, r.jobRole || '', r.phone, r.ratePerDay, ...cells, r.daysSigned, r.amount]
        .map(csvCell)
        .join(',')
    );
  });
  const t = totalsOf(rows);
  lines.push(['', 'Total', '', '', '', '', '', '', ...days.map(() => ''), t.daysSigned, t.amount].map(csvCell).join(','));
  return lines.join('\r\n') + '\r\n';
}
