// Copyright (c) 2026 Asya Hafidh <msanifuasiya@gmail.com>. All Rights Reserved.
// Proprietary and confidential. See LICENSE in the repository root.
//
// Back-fills people who attended an event but never used the sign-in sheet
// (a registration list, a paper sheet typed up, a Google Forms export) into
// that event as ordinary attendance rows. Nothing is created that the system
// would not create itself, with two honest differences:
//   - there is no drawn signature, so each row gets a generated initials image
//     and isImportedSignature = true, which the sheet, exports and integrity
//     checks already treat as "back-filled, not signed by hand";
//   - photo/video consent is left null ("never asked"), not guessed.
// No confirmation emails go out: this writes straight to the database.
//
// It only ever adds rows to an event that already exists. It is safe to re-run:
// anyone whose phone or email is already on the event is skipped and reported.
// It does nothing until you pass --apply.
//
// Usage:
//   node scripts/import-attendance.js <file.xlsx|file.csv> --event="<name or slug>" [options]
//
// Options:
//   --event="..."    event name (case-insensitive; a unique partial match is fine) or its slug
//   --admin=<email>  only look at events owned by this admin (use when two events share a name)
//   --day=<n>        which day the people signed, by position, for multi-day events
//                    (a single-day event needs nothing)
//   --apply          write to the database. Without it this is a dry run
//
// The sheet's first row must be headers. Columns are found by name, so order does not matter:
//   name:         "Full name" | "Name"
//   phone:        "Phone number" | "Phone" | "Mobile"            (required)
//   email:        "Email address" | "Email"
//   organisation: "Organisation" | "Organization" | "Company" | "Institution"

import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { prisma } from '../src/lib/prisma.js';
import { normalizePhone, normalizeEmail, isValidEmailShape } from '../src/lib/normalize.js';
import { writeAudit } from '../src/lib/audit.js';
import { readSheet } from './lib/readSheet.js';

const COLUMNS = {
  name: ['full name', 'fullname', 'name', 'names', 'participant', 'attendee'],
  phone: ['phone number', 'phone no', 'phone', 'mobile', 'mobile number', 'telephone', 'tel', 'cell'],
  email: ['email address', 'email', 'e-mail', 'e-mail address'],
  organisation: ['organisation', 'organization', 'company', 'institution', 'employer']
};

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (const a of argv) {
    if (a.startsWith('--')) {
      const [k, ...rest] = a.slice(2).split('=');
      flags[k] = rest.length ? rest.join('=') : true;
    } else positional.push(a);
  }
  return { positional, flags };
}

function findColumn(headers, aliases) {
  const clean = (s) => s.toLowerCase().replace(/[^a-z0-9 -]/g, '').replace(/\s+/g, ' ').trim();
  const wanted = aliases.map(clean);
  return headers.find((h) => wanted.includes(clean(h))) || null;
}

const str = (v) => (v instanceof Date ? '' : String(v ?? '')).replace(/\s+/g, ' ').trim();

// Fix names typed in ALL CAPS or all lower case, leave a mixed-case word (McDonald, O'Neil) alone.
function tidyName(raw) {
  return str(raw)
    .split(' ')
    .map((w) => (w === w.toUpperCase() || w === w.toLowerCase() ? w.replace(/(^|['-])(\p{L})/gu, (_, a, b) => a + b.toUpperCase()).replace(/(?<=\p{L})(\p{L}+)/gu, (m) => m.toLowerCase()) : w))
    .join(' ');
}

function initialsFor(name) {
  const parts = name.split(' ').filter(Boolean);
  if (!parts.length) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  // Every name's initial, capped at three so a long name still fits the signature box.
  const letters = parts.map((p) => p[0]);
  return (letters.length > 3 ? [letters[0], letters[1], letters[letters.length - 1]] : letters).join('').toUpperCase();
}

// Same cursive initials mark the earlier backfill used, so imported rows look alike in the roster and print view.
function initialsSignature(initials) {
  const safe = initials.replace(/[<>&"']/g, '');
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="220" height="90"><text x="50%" y="62%" text-anchor="middle" ` +
    `font-family="'Segoe Script','Brush Script MT',cursive" font-size="42" font-style="italic" fill="#16213e">${safe}</text></svg>`;
  return 'data:image/svg+xml;base64,' + Buffer.from(svg, 'utf8').toString('base64');
}

async function findEvent(query, adminEmail) {
  const base = { deletedAt: null, ...(adminEmail ? { owner: { email: adminEmail.trim().toLowerCase() } } : {}) };
  const select = { id: true, slug: true, name: true, startAt: true, endAt: true, timezone: true, ownerId: true, owner: { select: { email: true } } };
  let hits = await prisma.event.findMany({ where: { ...base, OR: [{ slug: query }, { name: { equals: query, mode: 'insensitive' } }] }, select });
  if (!hits.length) hits = await prisma.event.findMany({ where: { ...base, name: { contains: query, mode: 'insensitive' } }, select });
  return hits;
}

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const [filePath] = positional;
  const eventQuery = typeof flags.event === 'string' ? flags.event.trim() : '';
  if (!filePath || !eventQuery) {
    console.error('Usage: node scripts/import-attendance.js <file.xlsx|file.csv> --event="<name or slug>" [--admin=<email>] [--day=<n>] [--apply]');
    process.exitCode = 1;
    return;
  }
  const apply = flags.apply === true;

  // --- event ---
  const hits = await findEvent(eventQuery, typeof flags.admin === 'string' ? flags.admin : null);
  if (hits.length !== 1) {
    console.error(hits.length ? `"${eventQuery}" matches ${hits.length} events -- be more specific, or add --admin=<email>:` : `No event matches "${eventQuery}".`);
    for (const e of hits) console.error(`  ${e.name}  [slug ${e.slug}]  owner ${e.owner?.email || '(none)'}`);
    process.exitCode = 1;
    return;
  }
  const event = hits[0];
  // Only the columns this needs are selected, so the script also works against a database that is a
  // migration or two behind the code (it never depends on newer columns).
  const days = await prisma.eventDay.findMany({ where: { eventId: event.id }, orderBy: { position: 'asc' }, select: { id: true, position: true } });
  let day = null;
  if (days.length === 1) day = days[0];
  else if (days.length > 1) {
    day = days.find((d) => String(d.position) === String(flags.day));
    if (!day) {
      console.error(`"${event.name}" runs over ${days.length} days; say which one these people signed with --day=<position>. Positions: ${days.map((d) => d.position).join(', ')}.`);
      process.exitCode = 1;
      return;
    }
  }

  // --- sheet ---
  const { headers, rows } = readSheet(filePath);
  const col = Object.fromEntries(Object.entries(COLUMNS).map(([k, aliases]) => [k, findColumn(headers, aliases)]));
  if (!col.name || !col.phone) {
    console.error(`Could not find the ${!col.name ? 'name' : 'phone'} column. Headers seen: ${headers.filter(Boolean).join(' | ')}`);
    process.exitCode = 1;
    return;
  }
  if (!rows.length) {
    console.error('The sheet has no data rows.');
    process.exitCode = 1;
    return;
  }

  // Who is already on the event, so a re-run (or someone who did sign in on the day) is never doubled.
  const existing = await prisma.attendance.findMany({ where: { eventId: event.id }, select: { name: true, phoneNormalized: true, emailNormalized: true } });
  const havePhone = new Map(existing.map((a) => [a.phoneNormalized, a.name]));
  const haveEmail = new Map(existing.filter((a) => a.emailNormalized).map((a) => [a.emailNormalized, a.name]));

  console.log(`${apply ? '' : '[DRY RUN] '}Event: ${event.name}  (owner ${event.owner?.email || 'none'}, ${existing.length} already signed in)`);
  console.log(`File:  ${filePath}  (${rows.length} rows; columns: name="${col.name}", phone="${col.phone}", email="${col.email || '-'}", organisation="${col.organisation || '-'}")\n`);

  const toAdd = [];
  const skipped = [];
  const notes = [];
  const seenPhone = new Map();
  const seenEmail = new Map();
  for (const { rowNum, values } of rows) {
    const name = tidyName(values[col.name]);
    const rawPhone = str(values[col.phone]);
    const rawEmail = col.email ? str(values[col.email]) : '';
    const organisation = col.organisation ? str(values[col.organisation]) : '';
    if (!name) {
      skipped.push({ rowNum, why: 'no name' });
      continue;
    }
    const phoneNormalized = normalizePhone(rawPhone);
    if (!phoneNormalized) {
      skipped.push({ rowNum, name, why: `phone "${rawPhone}" is not a valid Kenyan number` });
      continue;
    }
    let email = rawEmail;
    if (email && !isValidEmailShape(email)) {
      notes.push({ rowNum, name, note: `email "${email}" is not an email address -- imported without one` });
      email = '';
    }
    const emailNormalized = normalizeEmail(email);
    if (havePhone.has(phoneNormalized)) {
      skipped.push({ rowNum, name, why: `phone already on this event (${havePhone.get(phoneNormalized)})` });
      continue;
    }
    if (seenPhone.has(phoneNormalized)) {
      skipped.push({ rowNum, name, why: `same phone as row ${seenPhone.get(phoneNormalized)} in this file` });
      continue;
    }
    if (emailNormalized && (haveEmail.has(emailNormalized) || seenEmail.has(emailNormalized))) {
      skipped.push({ rowNum, name, why: haveEmail.has(emailNormalized) ? `email already on this event (${haveEmail.get(emailNormalized)})` : `same email as row ${seenEmail.get(emailNormalized)} in this file` });
      continue;
    }
    seenPhone.set(phoneNormalized, rowNum);
    if (emailNormalized) seenEmail.set(emailNormalized, rowNum);
    toAdd.push({ rowNum, name, organisation: organisation || null, email: email || null, emailNormalized, phone: rawPhone, phoneNormalized });
  }

  for (const r of toAdd) console.log(`  + row ${String(r.rowNum).padStart(2)}  ${r.name.padEnd(24)} ${r.phoneNormalized}  ${r.organisation || ''}`);
  for (const n of notes) console.log(`  ! row ${n.rowNum} (${n.name}): ${n.note}`);
  for (const s of skipped) console.log(`  - row ${s.rowNum}${s.name ? ` (${s.name})` : ''}: skipped, ${s.why}`);
  console.log(`\n${toAdd.length} to add, ${skipped.length} skipped.`);

  if (!apply) {
    console.log('Nothing written. Add --apply to write these to the database.');
    return;
  }

  let added = 0;
  const failed = [];
  for (const r of toAdd) {
    const signature = initialsSignature(initialsFor(r.name));
    try {
      await prisma.attendance.create({
        select: { id: true },
        data: {
          eventId: event.id,
          clientId: 'import-' + randomUUID(),
          name: r.name,
          organization: r.organisation,
          email: r.email,
          emailNormalized: r.emailNormalized,
          phone: r.phone,
          phoneNormalized: r.phoneNormalized,
          signature,
          isImportedSignature: true,
          ...(day ? { daySignatures: { create: { dayId: day.id, signature, isImportedSignature: true } } } : {})
        }
      });
      added++;
    } catch (err) {
      failed.push({ rowNum: r.rowNum, name: r.name, why: err.code === 'P2002' ? 'already on the event (added by someone else a moment ago)' : err.message });
    }
  }
  for (const f of failed) console.log(`  x row ${f.rowNum} (${f.name}): ${f.why}`);
  console.log(`Added ${added} of ${toAdd.length}.`);

  if (added) {
    await writeAudit({
      actorId: event.ownerId || null,
      action: 'EVENT_ATTENDANCE_IMPORTED',
      targetType: 'Event',
      targetId: event.id,
      metadata: { source: filePath.split(/[\\/]/).pop(), added, skipped: skipped.length, failed: failed.length, viaScript: true }
    });
    console.log('Audit entry written.');
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
