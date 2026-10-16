// Copyright (c) 2026 Asya Hafidh <msanifuasiya@gmail.com>. All Rights Reserved.
// Proprietary and confidential. See LICENSE in the repository root.

import { normalizePhone } from './normalize.js';
import { hasModule } from './plans.js';
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
  let kinds = [];
  if (a === 'BOTH') kinds = ['ATTENDANCE', 'DUTY_ROLL'];
  else if (a === 'PAYMENT') kinds = ['DUTY_ROLL'];
  else if (a === 'ATTENDANCE') kinds = ['ATTENDANCE'];
  // What the organisation has switched on caps what any one person can reach.
  const org = user && user.organisation;
  if (org) kinds = kinds.filter((k) => hasModule(org, k === 'DUTY_ROLL' ? 'PAYMENT' : 'ATTENDANCE'));
  return kinds;
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

// ---- Approval chain --------------------------------------------------------

export const PAYMENT_ROLES = ['PREPARER', 'AUTHORISER', 'FINANCE'];

export const STAGE_LABEL = {
  OPEN: 'Collecting signatures',
  SUBMITTED: 'With the authorising officer',
  CERTIFIED: 'Certified, with finance',
  VERIFIED: 'Verified by finance'
};

function lastBy(approvals, step) {
  const found = [...(approvals || [])].reverse().find((a) => a.step === step);
  return found ? found.byId : null;
}

const isAuthoriser = (u) => u.role === 'SUPER_ADMIN' || (u.role === 'COUNTY_ADMIN' && u.paymentRole === 'AUTHORISER');
const isFinance = (u) => u.role === 'SUPER_ADMIN' || (u.role === 'COUNTY_ADMIN' && u.paymentRole === 'FINANCE');

const no = (error, message) => ({ ok: false, error, message });

// Decides whether this person may take this step on this sheet right now.
// step is SUBMIT, CERTIFY, VERIFY or RETURN. approvals are the sheet's earlier
// steps, oldest first. The rules keep three different people involved: whoever
// prepared the sheet cannot certify or verify it, and whoever certified it
// cannot verify it.
export function approvalCheck({ user, event, step, approvals = [] }) {
  if (!user || !canAccessKind(user, 'DUTY_ROLL')) return no('NO_ACCESS', 'Your account does not have access to payment sheets.');
  if (!user.departmentId || user.departmentId !== event.departmentId) return no('NO_ACCESS', 'This sheet belongs to another department.');
  const stage = event.dutyStage || 'OPEN';

  if (step === 'SUBMIT') {
    if (stage !== 'OPEN') return no('WRONG_STAGE', 'This sheet has already been submitted.');
    if (user.id !== event.ownerId) return no('NOT_PREPARER', 'Only the person who prepared this sheet can submit it.');
    return { ok: true };
  }

  const preparer = event.ownerId;
  const submitter = lastBy(approvals, 'SUBMITTED') || preparer;
  const notPrepared = (u) => u.id !== preparer && u.id !== submitter;

  if (step === 'CERTIFY' || (step === 'RETURN' && stage === 'SUBMITTED')) {
    if (stage !== 'SUBMITTED') return no('WRONG_STAGE', 'This sheet is not waiting for certification.');
    if (!isAuthoriser(user)) return no('NOT_AUTHORISER', 'Only an authorising officer can do this.');
    if (!notPrepared(user)) return no('CONFLICT', 'You prepared this sheet, so someone else has to certify it.');
    return { ok: true };
  }

  if (step === 'VERIFY' || (step === 'RETURN' && stage === 'CERTIFIED')) {
    if (stage !== 'CERTIFIED') return no('WRONG_STAGE', 'This sheet is not waiting for verification.');
    if (!isFinance(user)) return no('NOT_FINANCE', 'Only finance can do this.');
    if (!notPrepared(user)) return no('CONFLICT', 'You prepared this sheet, so someone else has to verify it.');
    if (step === 'VERIFY' && user.id === lastBy(approvals, 'CERTIFIED')) return no('CONFLICT', 'You certified this sheet, so someone else has to verify it.');
    return { ok: true };
  }

  return no('WRONG_STAGE', 'This sheet cannot be changed at this stage.');
}

// Anything that edits the roll itself is only allowed while signatures are still
// being collected.
export function sheetIsOpen(event) {
  return (event.dutyStage || 'OPEN') === 'OPEN';
}
