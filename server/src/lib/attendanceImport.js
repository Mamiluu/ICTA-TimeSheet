// Copyright (c) 2026 Asya Hafidh <msanifuasiya@gmail.com>. All Rights Reserved.
// Proprietary and confidential. See LICENSE in the repository root.
//
// Adds people from a list (a registration export, a typed-up paper sheet) to an
// event as ordinary attendance rows. Shared by the admin "Import attendees"
// button (routes/admin.js) and scripts/import-attendance.js, so both behave the
// same. Planning is pure and writes nothing; inserting is a separate step.
//
// Two honest differences from someone signing themselves:
//   - there is no drawn signature, so each row gets a generated initials image
//     and isImportedSignature = true, which the sheet, exports and integrity
//     checks already treat as "back-filled, not signed by hand";
//   - photo/video consent is recorded as "yes" only because the organiser confirms it
//     (the import screen's tick box, or the script's default); otherwise it stays null.
// No confirmation emails go out.

import { randomUUID } from 'node:crypto';
import { prisma } from './prisma.js';
import { normalizePhone, normalizeEmail, isValidEmailShape } from './normalize.js';

export const MAX_IMPORT_ROWS = 1000;

const COLUMNS = {
  name: ['full name', 'fullname', 'name', 'names', 'participant', 'attendee'],
  phone: ['phone number', 'phone no', 'phone', 'mobile', 'mobile number', 'telephone', 'tel', 'cell'],
  email: ['email address', 'email', 'e-mail', 'e-mail address'],
  organisation: ['organisation', 'organization', 'company', 'institution', 'employer']
};

const clean = (s) => String(s).toLowerCase().replace(/[^a-z0-9 -]/g, '').replace(/\s+/g, ' ').trim();
const str = (v) => (v instanceof Date ? '' : String(v ?? '')).replace(/\s+/g, ' ').trim();

export function findColumns(headers) {
  const out = {};
  for (const [key, aliases] of Object.entries(COLUMNS)) {
    const wanted = aliases.map(clean);
    out[key] = headers.find((h) => wanted.includes(clean(h))) || null;
  }
  return out;
}

// Fix names typed in ALL CAPS or all lower case; leave a mixed-case word (McDonald, O'Neil) alone.
export function tidyName(raw) {
  return str(raw)
    .split(' ')
    .map((w) => {
      if (w !== w.toUpperCase() && w !== w.toLowerCase()) return w;
      return w.toLowerCase().replace(/(^|['-])(\p{L})/gu, (_, a, b) => a + b.toUpperCase());
    })
    .join(' ');
}

// Every name's initial, capped at three so a long name still fits the signature box.
export function initialsFor(name) {
  const parts = name.split(' ').filter(Boolean);
  if (!parts.length) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  const letters = parts.map((p) => p[0]);
  return (letters.length > 3 ? [letters[0], letters[1], letters[letters.length - 1]] : letters).join('').toUpperCase();
}

// A cursive initials mark, sized to sit next to real canvas signatures in the roster and print view.
export function initialsSignature(initials) {
  const safe = initials.replace(/[<>&"']/g, '');
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="220" height="90"><text x="50%" y="62%" text-anchor="middle" ` +
    `font-family="'Segoe Script','Brush Script MT',cursive" font-size="42" font-style="italic" fill="#16213e">${safe}</text></svg>`;
  return 'data:image/svg+xml;base64,' + Buffer.from(svg, 'utf8').toString('base64');
}

// Works out, without writing anything, who would be added and who would be left out and why.
// `sheet` is { headers, rows } from readSheet. Returns
//   { columns, toAdd: [{rowNum,name,organisation,email,emailNormalized,phone,phoneNormalized}],
//     skipped: [{rowNum,name?,why}], notes: [{rowNum,name,note}] }
// or { error } when the sheet cannot be used at all.
export async function planImport(eventId, sheet) {
  const columns = findColumns(sheet.headers);
  if (!columns.name || !columns.phone) {
    return { error: `Could not find a "${!columns.name ? 'Name' : 'Phone'}" column. The first row of the file must be headings such as Full name, Phone number, Email address and Organisation.` };
  }
  if (!sheet.rows.length) return { error: 'The file has no rows under the headings.' };
  if (sheet.rows.length > MAX_IMPORT_ROWS) return { error: `That file has ${sheet.rows.length} rows; import at most ${MAX_IMPORT_ROWS} at a time.` };

  // Who is already on the event, so a second upload (or someone who did sign in on the day) is never doubled.
  const existing = await prisma.attendance.findMany({ where: { eventId }, select: { name: true, phoneNormalized: true, emailNormalized: true } });
  const havePhone = new Map(existing.map((a) => [a.phoneNormalized, a.name]));
  const haveEmail = new Map(existing.filter((a) => a.emailNormalized).map((a) => [a.emailNormalized, a.name]));

  const toAdd = [];
  const skipped = [];
  const notes = [];
  const seenPhone = new Map();
  const seenEmail = new Map();
  for (const { rowNum, values } of sheet.rows) {
    const name = tidyName(values[columns.name]);
    const rawPhone = str(values[columns.phone]);
    const organisation = columns.organisation ? str(values[columns.organisation]) : '';
    let email = columns.email ? str(values[columns.email]) : '';
    if (!name) {
      skipped.push({ rowNum, why: 'no name' });
      continue;
    }
    if (name.length > 120) {
      skipped.push({ rowNum, name: name.slice(0, 40) + '…', why: 'name is too long' });
      continue;
    }
    const phoneNormalized = normalizePhone(rawPhone);
    if (!phoneNormalized) {
      skipped.push({ rowNum, name, why: rawPhone ? `"${rawPhone}" is not a valid Kenyan phone number` : 'no phone number' });
      continue;
    }
    if (email && !isValidEmailShape(email)) {
      notes.push({ rowNum, name, note: `"${email.slice(0, 60)}" is not an email address, so ${name} is added without one` });
      email = '';
    }
    const emailNormalized = normalizeEmail(email);
    if (havePhone.has(phoneNormalized)) {
      skipped.push({ rowNum, name, why: `already on this event (same phone as ${havePhone.get(phoneNormalized)})` });
      continue;
    }
    if (seenPhone.has(phoneNormalized)) {
      skipped.push({ rowNum, name, why: `same phone as row ${seenPhone.get(phoneNormalized)} in this file` });
      continue;
    }
    if (emailNormalized && (haveEmail.has(emailNormalized) || seenEmail.has(emailNormalized))) {
      skipped.push({ rowNum, name, why: haveEmail.has(emailNormalized) ? `already on this event (same email as ${haveEmail.get(emailNormalized)})` : `same email as row ${seenEmail.get(emailNormalized)} in this file` });
      continue;
    }
    seenPhone.set(phoneNormalized, rowNum);
    if (emailNormalized) seenEmail.set(emailNormalized, rowNum);
    toAdd.push({ rowNum, name, organisation: organisation.slice(0, 160) || null, email: email || null, emailNormalized, phone: rawPhone, phoneNormalized });
  }
  return { columns, toAdd, skipped, notes };
}

// Writes the planned rows. `day` is the EventDay they are marked as having signed (null when the event
// has none). Returns { added, failed: [{rowNum,name,why}] }. Selects only the columns it needs, so it
// keeps working on a database that is a migration behind the code.
// `consent` is true when the organiser confirms these people agreed to photos/video (the default for an
// import, and what the admin screen's tick box sets); false leaves it "not recorded".
export async function insertImport(eventId, day, toAdd, { consent = true } = {}) {
  let added = 0;
  const failed = [];
  for (const r of toAdd) {
    const signature = initialsSignature(initialsFor(r.name));
    try {
      await prisma.attendance.create({
        select: { id: true },
        data: {
          eventId,
          clientId: 'import-' + randomUUID(),
          name: r.name,
          organization: r.organisation,
          email: r.email,
          emailNormalized: r.emailNormalized,
          phone: r.phone,
          phoneNormalized: r.phoneNormalized,
          signature,
          isImportedSignature: true,
          photoVideoConsent: consent ? true : null,
          ...(day ? { daySignatures: { create: { dayId: day.id, signature, isImportedSignature: true } } } : {})
        }
      });
      added++;
    } catch (err) {
      failed.push({ rowNum: r.rowNum, name: r.name, why: err.code === 'P2002' ? 'already on the event (added a moment ago by someone else)' : 'could not be saved' });
    }
  }
  return { added, failed };
}
