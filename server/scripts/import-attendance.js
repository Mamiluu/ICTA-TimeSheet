// Copyright (c) 2026 Asya Hafidh <msanifuasiya@gmail.com>. All Rights Reserved.
// Proprietary and confidential. See LICENSE in the repository root.
//
// Command-line twin of the admin page's "Import attendees" button, for the
// platform owner (bulk or support work). Event admins do not need it: they use
// the button in the event's More menu. Same rules, same code
// (src/lib/attendanceImport.js). It does nothing until you pass --apply.
//
// Usage:
//   node scripts/import-attendance.js <file.xlsx|file.csv> --event="<name or slug>" [options]
//
// Options:
//   --event="..."    event name (case-insensitive; a unique partial match is fine) or its slug
//   --admin=<email>  only look at events owned by this admin (when two events share a name)
//   --day=<n>        which day these people signed, by position, for multi-day events
//   --no-consent     leave photo/video consent as "not recorded" (default is yes)
//   --set-consent    no file needed: set Yes on already-imported people with no consent answer
//   --apply          write to the database. Without it this is a dry run

import 'dotenv/config';
import { prisma } from '../src/lib/prisma.js';
import { normalizeEmail, isValidEmailShape } from '../src/lib/normalize.js';
import { writeAudit } from '../src/lib/audit.js';
import { readSheet } from '../src/lib/readSheet.js';
import { planImport, insertImport } from '../src/lib/attendanceImport.js';

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

async function findEvent(query, adminEmail) {
  const base = { deletedAt: null, ...(adminEmail ? { owner: { email: adminEmail.trim().toLowerCase() } } : {}) };
  const select = { id: true, slug: true, name: true, ownerId: true, owner: { select: { email: true } } };
  let hits = await prisma.event.findMany({ where: { ...base, OR: [{ slug: query }, { name: { equals: query, mode: 'insensitive' } }] }, select });
  if (!hits.length) hits = await prisma.event.findMany({ where: { ...base, name: { contains: query, mode: 'insensitive' } }, select });
  return hits;
}

// Sets photo/video consent to Yes on people who were imported (not signed by hand) and have no answer
// recorded, for an event imported before consent was defaulted to Yes. Anyone who answered the question
// themselves, or any row that was not imported, is left exactly as it is.
async function setConsent(eventQuery, flags) {
  if (!eventQuery) {
    console.error('Usage: node scripts/import-attendance.js --set-consent --event="<name or slug>" [--admin=<email>] [--apply]');
    process.exitCode = 1;
    return;
  }
  const hits = await findEvent(eventQuery, typeof flags.admin === 'string' ? flags.admin : null);
  if (hits.length !== 1) {
    console.error(hits.length ? `"${eventQuery}" matches ${hits.length} events -- be more specific.` : `No event matches "${eventQuery}".`);
    process.exitCode = 1;
    return;
  }
  const where = { eventId: hits[0].id, isImportedSignature: true, photoVideoConsent: null };
  const n = await prisma.attendance.count({ where });
  console.log(`${flags.apply === true ? '' : '[DRY RUN] '}${hits[0].name}: ${n} imported ${n === 1 ? 'person has' : 'people have'} no photo/video answer.`);
  if (flags.apply !== true) {
    await setEmails(hits[0].id, flags['set-email'], false);
    console.log('Nothing written. Add --apply to set them to Yes.');
    return;
  }
  const r = await prisma.attendance.updateMany({ where, data: { photoVideoConsent: true } });
  console.log(`Set photo/video consent to Yes on ${r.count}.`);
  await setEmails(hits[0].id, flags['set-email'], true);
}

// --set-email="Full Name=address" fills in the email of one person on the event who has none.
async function setEmails(eventId, spec, apply) {
  if (typeof spec !== 'string') return;
  const cut = spec.lastIndexOf('=');
  const name = spec.slice(0, cut).trim();
  const email = spec.slice(cut + 1).trim();
  if (cut < 1 || !isValidEmailShape(email)) {
    console.log(`--set-email needs the form "Full Name=address@example.com"; got "${spec}".`);
    return;
  }
  const rows = await prisma.attendance.findMany({ where: { eventId, name: { equals: name, mode: 'insensitive' }, email: null }, select: { id: true, name: true } });
  if (rows.length !== 1) {
    console.log(`Email not set: ${rows.length} people named "${name}" with no email (needs exactly one).`);
    return;
  }
  if (!apply) {
    console.log(`Would set ${rows[0].name}'s email to ${email}.`);
    return;
  }
  try {
    await prisma.attendance.update({ where: { id: rows[0].id }, data: { email, emailNormalized: normalizeEmail(email) }, select: { id: true } });
    console.log(`Set ${rows[0].name}'s email to ${email}.`);
  } catch (err) {
    console.log(err.code === 'P2002' ? `Email not set: ${email} is already used by someone else on this event.` : `Email not set: ${err.message}`);
  }
}

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const [filePath] = positional;
  const eventQuery = typeof flags.event === 'string' ? flags.event.trim() : '';
  if (flags['set-consent'] === true) return setConsent(eventQuery, flags);
  if (!filePath || !eventQuery) {
    console.error('Usage: node scripts/import-attendance.js <file.xlsx|file.csv> --event="<name or slug>" [--admin=<email>] [--day=<n>] [--apply]');
    process.exitCode = 1;
    return;
  }
  const apply = flags.apply === true;

  const hits = await findEvent(eventQuery, typeof flags.admin === 'string' ? flags.admin : null);
  if (hits.length !== 1) {
    console.error(hits.length ? `"${eventQuery}" matches ${hits.length} events -- be more specific, or add --admin=<email>:` : `No event matches "${eventQuery}".`);
    for (const e of hits) console.error(`  ${e.name}  [slug ${e.slug}]  owner ${e.owner?.email || '(none)'}`);
    process.exitCode = 1;
    return;
  }
  const event = hits[0];
  const days = await prisma.eventDay.findMany({ where: { eventId: event.id }, orderBy: { position: 'asc' }, select: { id: true, position: true } });
  let day = days.length === 1 ? days[0] : null;
  if (days.length > 1) {
    day = days.find((d) => String(d.position) === String(flags.day)) || null;
    if (!day) {
      console.error(`"${event.name}" runs over ${days.length} days; say which one with --day=<position>. Positions: ${days.map((d) => d.position).join(', ')}.`);
      process.exitCode = 1;
      return;
    }
  }

  const plan = await planImport(event.id, readSheet(filePath));
  if (plan.error) {
    console.error(plan.error);
    process.exitCode = 1;
    return;
  }

  console.log(`${apply ? '' : '[DRY RUN] '}Event: ${event.name}  (owner ${event.owner?.email || 'none'})`);
  for (const r of plan.toAdd) console.log(`  + row ${String(r.rowNum).padStart(2)}  ${r.name.padEnd(24)} ${r.phoneNormalized}  ${r.organisation || ''}`);
  for (const n of plan.notes) console.log(`  ! row ${n.rowNum}: ${n.note}`);
  for (const s of plan.skipped) console.log(`  - row ${s.rowNum}${s.name ? ` (${s.name})` : ''}: skipped, ${s.why}`);
  console.log(`\n${plan.toAdd.length} to add, ${plan.skipped.length} skipped.`);
  if (!apply) {
    console.log('Nothing written. Add --apply to write these to the database.');
    return;
  }

  const { added, failed } = await insertImport(event.id, day, plan.toAdd, { consent: flags['no-consent'] !== true });
  for (const f of failed) console.log(`  x row ${f.rowNum} (${f.name}): ${f.why}`);
  console.log(`Added ${added} of ${plan.toAdd.length}.`);
  if (added) {
    try {
      await writeAudit({
        actorId: event.ownerId || null,
        action: 'EVENT_ATTENDANCE_IMPORTED',
        targetType: 'Event',
        targetId: event.id,
        metadata: { source: filePath.split(/[\\/]/).pop(), added, skipped: plan.skipped.length, failed: failed.length, viaScript: true }
      });
      console.log('Audit entry written.');
    } catch (err) {
      console.log(`Added, but the audit entry could not be written: ${err.message}`);
    }
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
