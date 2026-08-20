// Copyright (c) 2026 Asya Hafidh <msanifuasiya@gmail.com>. All Rights Reserved.
// Proprietary and confidential. See LICENSE in the repository root.
//
// One-off backfill: imports a legacy Excel/Google-Forms sign-in sheet into a
// county admin's event as Attendance rows. There is no drawn signature in
// the source data, so each row gets a generated initials image instead
// (isImportedSignature: true marks it as such, distinct from a real drawn
// signature -- see the matching comment on the schema field).
//
// Usage:
//   node scripts/import-attendance.js <path-to-xlsx> <admin-email> [options]
//
// Options:
//   --event-name="..."   defaults to "ICT Authority Workshop Talk"
//   --date=YYYY-MM-DD    defaults to the earliest row's submission date
//   --location="..."     defaults to "Nairobi" -- pass the real venue
//   --dry-run            parse and validate only, no database writes

import 'dotenv/config';
import XLSX from 'xlsx';
import { randomUUID } from 'node:crypto';
import { prisma } from '../src/lib/prisma.js';
import { normalizePhone, normalizeEmail, eventSlugId } from '../src/lib/normalize.js';
import { writeAudit } from '../src/lib/audit.js';

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (const a of argv) {
    if (a.startsWith('--')) {
      const [k, ...rest] = a.slice(2).split('=');
      flags[k] = rest.length ? rest.join('=') : true;
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

function initialsFor(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

// A compact cursive-styled SVG standing in for a drawn signature -- sized and
// colored to sit naturally next to real canvas signatures in the roster
// table and print view (see index.html's td.sign-cell img{max-height:24px}).
function initialsSignatureDataUri(initials) {
  const safe = String(initials).replace(/[<>&]/g, '');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="220" height="90">` +
    `<text x="50%" y="62%" text-anchor="middle" ` +
    `font-family="'Segoe Script','Brush Script MT',cursive" ` +
    `font-size="42" font-style="italic" fill="#16213e">${safe}</text>` +
    `</svg>`;
  return 'data:image/svg+xml;base64,' + Buffer.from(svg, 'utf8').toString('base64');
}

function toIsoDateOnly(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function findConsentKey(row) {
  return Object.keys(row).find((k) => /consent/i.test(k));
}

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const [filePath, adminEmail] = positional;
  if (!filePath || !adminEmail) {
    console.error('Usage: node scripts/import-attendance.js <path-to-xlsx> <admin-email> [--event-name="..."] [--date=YYYY-MM-DD] [--location="..."] [--dry-run]');
    process.exitCode = 1;
    return;
  }
  const dryRun = !!flags['dry-run'];

  const admin = await prisma.user.findUnique({ where: { email: adminEmail.trim().toLowerCase() } });
  if (!admin || admin.role !== 'COUNTY_ADMIN') {
    console.error(`No COUNTY_ADMIN account found for ${adminEmail}.`);
    process.exitCode = 1;
    return;
  }

  const wb = XLSX.readFile(filePath, { cellDates: true });
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '' });
  if (!rows.length) {
    console.error('No rows found in the sheet.');
    process.exitCode = 1;
    return;
  }

  // Chronological order so "first submission wins" when the same person
  // appears twice in the sheet.
  rows.sort((a, b) => {
    const ta = a['Timestamp'] instanceof Date ? a['Timestamp'].getTime() : 0;
    const tb = b['Timestamp'] instanceof Date ? b['Timestamp'].getTime() : 0;
    return ta - tb;
  });

  const eventName = flags['event-name'] || 'ICT Authority Workshop Talk';
  const firstTimestamp = rows.find((r) => r['Timestamp'] instanceof Date)?.['Timestamp'];
  const eventDate = flags['date'] || (firstTimestamp ? toIsoDateOnly(firstTimestamp) : toIsoDateOnly(new Date()));
  const location = flags['location'] || 'Nairobi';

  let event = await prisma.event.findFirst({ where: { ownerId: admin.id, name: eventName, deletedAt: null } });
  if (!event) {
    console.log(`Creating event "${eventName}" for ${admin.email} (date=${eventDate}, location="${location}", county=${admin.county}).`);
    if (!dryRun) {
      event = await prisma.event.create({
        data: { slug: eventSlugId(eventName), name: eventName, date: eventDate, location, county: admin.county, ownerId: admin.id }
      });
    }
  } else {
    console.log(`Using existing event "${event.name}" (${event.id}).`);
  }

  const seenPhones = new Map();
  const seenEmails = new Map();
  const results = { imported: 0, skipped: [], consentFlagged: [] };

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const rowNum = i + 2; // account for the header row
    const name = String(r['FULL NAME'] || '').trim().replace(/\s+/g, ' ');
    const rawEmail = String(r['Email address'] || '').trim();
    const rawPhone = String(r['Phone Number'] || '').trim();
    const consentKey = findConsentKey(r);
    const consent = consentKey ? String(r[consentKey] || '').trim() : '';

    if (!name) {
      results.skipped.push({ rowNum, reason: 'missing name' });
      continue;
    }

    const phoneNormalized = normalizePhone(rawPhone);
    if (!phoneNormalized) {
      results.skipped.push({ rowNum, name, reason: `unparseable phone "${rawPhone}"` });
      continue;
    }
    const emailNormalized = normalizeEmail(rawEmail);

    if (seenPhones.has(phoneNormalized)) {
      results.skipped.push({ rowNum, name, reason: `duplicate phone -- already imported from row ${seenPhones.get(phoneNormalized)}` });
      continue;
    }
    if (emailNormalized && seenEmails.has(emailNormalized)) {
      results.skipped.push({ rowNum, name, reason: `duplicate email -- already imported from row ${seenEmails.get(emailNormalized)}` });
      continue;
    }

    const createdAt = r['Timestamp'] instanceof Date ? r['Timestamp'] : new Date();
    const signature = initialsSignatureDataUri(initialsFor(name));

    if (!dryRun) {
      try {
        await prisma.attendance.create({
          data: {
            eventId: event.id,
            clientId: 'import-' + randomUUID(),
            name,
            organization: null,
            email: rawEmail || null,
            emailNormalized,
            phone: rawPhone,
            phoneNormalized,
            signature,
            isImportedSignature: true,
            createdAt
          }
        });
      } catch (err) {
        results.skipped.push({ rowNum, name, reason: `database error: ${err.message}` });
        continue;
      }
    }

    seenPhones.set(phoneNormalized, rowNum);
    if (emailNormalized) seenEmails.set(emailNormalized, rowNum);
    results.imported++;
    if (/do not agree/i.test(consent) || !consent) {
      results.consentFlagged.push({ rowNum, name, consent: consent || '(blank)' });
    }
  }

  console.log(`\n${dryRun ? '[DRY RUN] ' : ''}Imported: ${results.imported} / ${rows.length}`);
  if (results.skipped.length) {
    console.log(`Skipped: ${results.skipped.length}`);
    for (const s of results.skipped) console.log(`  row ${s.rowNum}${s.name ? ' (' + s.name + ')' : ''}: ${s.reason}`);
  }
  if (results.consentFlagged.length) {
    console.log(`Imported despite non-affirmative consent answer: ${results.consentFlagged.length}`);
    for (const c of results.consentFlagged) console.log(`  row ${c.rowNum} (${c.name}): consent="${c.consent}"`);
  }

  if (!dryRun && results.imported) {
    await writeAudit({
      actorId: admin.id,
      action: 'EVENT_ATTENDANCE_IMPORTED',
      targetType: 'Event',
      targetId: event.id,
      metadata: {
        source: 'excel',
        fileName: filePath.split(/[\\/]/).pop(),
        rowCount: results.imported,
        skippedCount: results.skipped.length,
        nonConsentingRowsImported: results.consentFlagged.length
      }
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
