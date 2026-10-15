// Copyright (c) 2026 Asya Hafidh <msanifuasiya@gmail.com>. All Rights Reserved.
// Proprietary and confidential. See LICENSE in the repository root.

import { prisma } from './prisma.js';
import { hashToken } from './tokens.js';
import { entryHashInput, writeAudit } from './audit.js';
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
  const mismatchAt = [];
  const breakAt = [];
  let prev = null;
  let checked = 0;
  entries.forEach((e, i) => {
    if (e.hash == null) return; // written before chaining existed
    checked += 1;
    if (hashToken(entryHashInput(e)) !== e.hash) { hashMismatches.push(e.id); mismatchAt.push(i); }
    if (prev !== null && e.prevHash !== prev) { linkBreaks.push(e.id); breakAt.push(i); }
    prev = e.hash;
  });
  return { checked, hashMismatches, linkBreaks, mismatchAt, breakAt };
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
  // One pass over the chain; the part up to the anchor is read off the same result.
  const whole = walkChain(entries);
  const beforeOrAt = (i) => i <= idx;
  return {
    found: true,
    position: idx + 1,
    entriesSince: entries.length - idx - 1,
    // An entry removed from before the anchor shows as a link break, so both
    // kinds of damage count against the part of the trail the anchor covers.
    intactUpToAnchor: !whole.mismatchAt.some(beforeOrAt) && !whole.breakAt.some(beforeOrAt),
    hashMismatches: whole.hashMismatches.length,
    linkBreaks: whole.linkBreaks.length
  };
}

// Records the anchor in the chain itself, then emails the head to the active
// platform admin(s). Returns what was sent.
export async function sendAnchor({ actorId = null, req } = {}) {
  const head = await chainHead();
  if (!head) return { sent: 0, head: null };
  // The platform admin holds the copy. Until one exists, department super admins do, so a fresh install still gets anchors.
  let admins = await prisma.user.findMany({ where: { role: 'PLATFORM_ADMIN', status: 'ACTIVE' }, select: { email: true } });
  if (!admins.length) admins = await prisma.user.findMany({ where: { role: 'SUPER_ADMIN', status: 'ACTIVE' }, select: { email: true } });
  let sent = 0;
  for (const a of admins) {
    try { await sendChainAnchorEmail(a.email, head); sent += 1; }
    catch (err) { logger.error('chain anchor email failed', { stack: err.stack }); }
  }
  // Recorded only once a copy has actually left the system; otherwise the
  // trail would claim an anchor that nobody holds and the daily job would
  // wait a full day before trying again.
  if (sent > 0) {
    await writeAudit({ actorId, action: 'CHAIN_ANCHORED', targetType: 'AuditLog', targetId: head.id, metadata: { headHash: head.hash, entries: head.count, sent }, req });
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
// 23 hours, not 24: the check runs hourly, so this keeps the anchor close to
// once a day instead of drifting later each day.
const ANCHOR_EVERY_MS = 23 * 60 * 60 * 1000;
export function startAnchorJob() {
  let running = false;
  async function tick() {
    if (running) return; // a slow send must not start a second run
    running = true;
    try {
      const last = await lastAnchorAt();
      if (!last || Date.now() - last.getTime() >= ANCHOR_EVERY_MS) await sendAnchor();
    } catch (err) {
      logger.error('anchor job failed', { stack: err.stack });
    } finally {
      running = false;
    }
  }
  setTimeout(tick, 30 * 1000).unref();
  setInterval(tick, 60 * 60 * 1000).unref();
}
