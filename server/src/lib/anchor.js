// Copyright (c) 2026 Asya Hafidh <msanifuasiya@gmail.com>. All Rights Reserved.
// Proprietary and confidential. See LICENSE in the repository root.

import { prisma } from './prisma.js';
import { hashToken } from './tokens.js';
import { entryHashInput } from './audit.js';
import { writeAudit } from './audit.js';
import { sendChainAnchorEmail } from './mailer.js';
import { logger } from './logger.js';

// The audit chain proves tampering only if someone holds a copy of its latest
// hash that the application, and whoever controls its database, cannot edit.
// An email in the super admin's own inbox is exactly that: once sent, it can't
// be changed from here. Each anchor records the chain head; checking one later
// shows whether that exact entry is still in the chain and whether everything
// up to it still hashes correctly.

// `entries` oldest first. A hash mismatch means that entry's own fields were
// changed after it was written. A link break means an entry's prevHash is not
// the hash of the one before it, which is either a deletion/insertion or one
// of the accepted write races (see nextHash in audit.js), so it is reported
// separately and not called tampering on its own.
export function walkChain(entries) {
  const hashMismatches = [];
  const linkBreaks = [];
  let prev = null;
  let checked = 0;
  for (const e of entries) {
    if (e.hash == null) continue; // written before chaining existed
    checked += 1;
    if (hashToken(entryHashInput(e)) !== e.hash) hashMismatches.push(e.id);
    if (prev !== null && e.prevHash !== prev) linkBreaks.push(e.id);
    prev = e.hash;
  }
  return { checked, hashMismatches, linkBreaks };
}

async function allChained() {
  return prisma.auditLog.findMany({ where: { hash: { not: null } }, orderBy: { createdAt: 'asc' } });
}

export async function chainHead() {
  const latest = await prisma.auditLog.findFirst({ where: { hash: { not: null } }, orderBy: { createdAt: 'desc' }, select: { id: true, hash: true, createdAt: true } });
  const count = await prisma.auditLog.count({ where: { hash: { not: null } } });
  return latest ? { id: latest.id, hash: latest.hash, at: latest.createdAt, count } : null;
}

// Checks a hash someone kept from an earlier anchor email.
export async function checkAnchor(hash) {
  const entries = await allChained();
  const idx = entries.findIndex((e) => e.hash === hash);
  if (idx === -1) {
    return { found: false, message: 'No entry with that hash exists in the chain. Entries were removed or rewritten after that anchor was sent.' };
  }
  const upTo = walkChain(entries.slice(0, idx + 1));
  const whole = walkChain(entries);
  return {
    found: true,
    position: idx + 1,
    entriesSince: entries.length - idx - 1,
    intactUpToAnchor: upTo.hashMismatches.length === 0,
    hashMismatches: whole.hashMismatches.length,
    linkBreaks: whole.linkBreaks.length
  };
}

// Records the anchor in the chain itself, then emails the head to every active
// super admin. Returns what was sent.
export async function sendAnchor({ actorId = null, req } = {}) {
  const head = await chainHead();
  if (!head) return { sent: 0, head: null };
  await writeAudit({ actorId, action: 'CHAIN_ANCHORED', targetType: 'AuditLog', targetId: head.id, metadata: { headHash: head.hash, entries: head.count }, req });
  const admins = await prisma.user.findMany({ where: { role: 'SUPER_ADMIN', status: 'ACTIVE' }, select: { email: true } });
  let sent = 0;
  for (const a of admins) {
    try { await sendChainAnchorEmail(a.email, head); sent += 1; }
    catch (err) { logger.error('chain anchor email failed', { stack: err.stack }); }
  }
  return { sent, head };
}

export async function lastAnchorAt() {
  const last = await prisma.auditLog.findFirst({ where: { action: 'CHAIN_ANCHORED' }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } });
  return last ? last.createdAt : null;
}

// Sends one anchor a day while the server is running. Checked hourly and on
// start, based on the last recorded anchor, so a restart or a sleeping free
// instance never doubles up or loses a day.
const DAY_MS = 24 * 60 * 60 * 1000;
export function startAnchorJob() {
  async function tick() {
    try {
      const last = await lastAnchorAt();
      if (!last || Date.now() - last.getTime() >= DAY_MS) await sendAnchor();
    } catch (err) {
      logger.error('anchor job failed', { stack: err.stack });
    }
  }
  setTimeout(tick, 30 * 1000).unref();
  setInterval(tick, 60 * 60 * 1000).unref();
}
