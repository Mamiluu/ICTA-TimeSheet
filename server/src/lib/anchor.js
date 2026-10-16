// Copyright (c) 2026 Asya Hafidh <msanifuasiya@gmail.com>. All Rights Reserved.
// Proprietary and confidential. See LICENSE in the repository root.

import { prisma } from './prisma.js';
import { hashMatches, writeAudit } from './audit.js';
import { sendChainAnchorEmail } from './mailer.js';
import { logger } from './logger.js';
import { brandFromOrg, brandForOrgId, emailBrand } from './brand.js';

// The audit chain proves tampering only if someone holds a copy of its latest
// hash that the application, and whoever controls its database, cannot edit.
// An email in the administrator's own inbox is exactly that: once sent, it can't
// be changed from here. Each anchor records the chain head; checking one later
// shows whether that exact entry is still in the chain and whether everything
// up to it still hashes correctly.

// `entries` oldest first. A hash mismatch means that entry's own fields were
// changed after it was written. A link break means an entry's prevHash is not
// the hash of the one before it, which is either a deletion/insertion or one
// of the accepted write races (see nextHash in audit.js), so it is reported
// separately and not called tampering on its own.
//
// Before each organisation had its own chain there was one chain for everyone, so an entry
// can legitimately point back at an entry that now belongs to another chain. `foreign` is the
// set of hashes known to belong to other chains: a link to one of those is that old join, not a
// break. A link to a hash that exists nowhere is still a break.
export function walkChain(entries, foreign = new Set()) {
  const hashMismatches = [];
  const linkBreaks = [];
  const mismatchAt = [];
  const breakAt = [];
  let prev = null;
  let checked = 0;
  entries.forEach((e, i) => {
    if (e.hash == null) return; // written before chaining existed
    checked += 1;
    if (!hashMatches(e)) { hashMismatches.push(e.id); mismatchAt.push(i); }
    if (prev !== null && e.prevHash !== prev && !foreign.has(e.prevHash)) { linkBreaks.push(e.id); breakAt.push(i); }
    prev = e.hash;
  });
  return { checked, hashMismatches, linkBreaks, mismatchAt, breakAt };
}

// An organisation's own chain. organisationId null is the platform owner's chain.
// Hashes, held by other chains, that this chain's entries still point back at.
async function foreignLinks(entries) {
  const own = new Set(entries.map((e) => e.hash));
  const wanted = [...new Set(entries.map((e) => e.prevHash).filter((h) => h && !own.has(h)))];
  if (!wanted.length) return new Set();
  const found = await prisma.auditLog.findMany({ where: { hash: { in: wanted } }, select: { hash: true } });
  return new Set(found.map((f) => f.hash));
}

async function allChained(organisationId) {
  return prisma.auditLog.findMany({ where: { hash: { not: null }, organisationId }, orderBy: { createdAt: 'asc' } });
}

export async function chainHead(organisationId) {
  const where = { hash: { not: null }, organisationId };
  const latest = await prisma.auditLog.findFirst({ where, orderBy: { createdAt: 'desc' }, select: { id: true, hash: true, createdAt: true } });
  const count = await prisma.auditLog.count({ where });
  return latest ? { id: latest.id, hash: latest.hash, at: latest.createdAt, count } : null;
}

// Checks a hash someone kept from an earlier anchor email, against that organisation's chain only.
export async function checkAnchor(hash, organisationId) {
  const entries = await allChained(organisationId);
  const idx = entries.findIndex((e) => e.hash === hash);
  if (idx === -1) {
    return { found: false, message: 'No entry with that hash exists in the chain. Entries were removed or rewritten after that anchor was sent.' };
  }
  // One pass over the chain; the part up to the anchor is read off the same result.
  const whole = walkChain(entries, await foreignLinks(entries));
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

// Who holds the copy for a chain: the organisation's administrator (its department super
// admins until it has one), or the platform owner for the owner's own chain.
async function holders(organisationId) {
  if (organisationId === null) return prisma.user.findMany({ where: { role: 'OWNER', status: 'ACTIVE' }, select: { email: true } });
  const admins = await prisma.user.findMany({ where: { organisationId, role: 'PLATFORM_ADMIN', status: 'ACTIVE' }, select: { email: true } });
  if (admins.length) return admins;
  return prisma.user.findMany({ where: { organisationId, role: 'SUPER_ADMIN', status: 'ACTIVE' }, select: { email: true } });
}

// Records the anchor in the chain itself, then emails the head to whoever holds the copy.
// Returns what was sent.
export async function sendAnchor({ actorId = null, req, organisationId = null } = {}) {
  const head = await chainHead(organisationId);
  if (!head) return { sent: 0, head: null };
  const brand = emailBrand(organisationId ? await brandForOrgId(organisationId) : brandFromOrg(null));
  let sent = 0;
  for (const a of await holders(organisationId)) {
    try {
      await sendChainAnchorEmail(a.email, head, brand);
      sent += 1;
    } catch (err) {
      logger.error('chain anchor email failed', { stack: err.stack });
    }
  }
  // Recorded only once a copy has actually left the system; otherwise the
  // trail would claim an anchor that nobody holds and the daily job would
  // wait a full day before trying again.
  if (sent > 0) {
    await writeAudit({ actorId, action: 'CHAIN_ANCHORED', targetType: 'AuditLog', targetId: head.id, metadata: { headHash: head.hash, entries: head.count, sent }, req, organisationId });
  }
  return { sent, head };
}

// When this chain was last anchored. With no argument, the latest anchor anywhere, for the owner's health view.
export async function lastAnchorAt(organisationId) {
  const where = { action: 'CHAIN_ANCHORED', ...(organisationId !== undefined ? { organisationId } : {}) };
  const last = await prisma.auditLog.findFirst({ where, orderBy: { createdAt: 'desc' }, select: { createdAt: true } });
  return last ? last.createdAt : null;
}

// Sends one anchor a day per chain while the server is running, when ANCHOR_DAILY=on. Checked
// hourly and on start, based on the last recorded anchor, so a restart or a sleeping free
// instance never doubles up or loses a day.
// 23 hours, not 24: the check runs hourly, so this keeps the anchor close to
// once a day instead of drifting later each day.
const ANCHOR_EVERY_MS = 23 * 60 * 60 * 1000;
export function startAnchorJob() {
  // Off by default: each organisation's administrator sends an anchor by hand from the Integrity page.
  // Set ANCHOR_DAILY=on to bring the automatic daily send back.
  if (String(process.env.ANCHOR_DAILY || '').toLowerCase() !== 'on') return;
  let running = false;
  async function tick() {
    if (running) return; // a slow send must not start a second run
    running = true;
    try {
      const orgs = await prisma.organisation.findMany({ where: { status: 'ACTIVE' }, select: { id: true } });
      for (const id of [...orgs.map((o) => o.id), null]) {
        const last = await lastAnchorAt(id);
        if (!last || Date.now() - last.getTime() >= ANCHOR_EVERY_MS) await sendAnchor({ organisationId: id });
      }
    } catch (err) {
      logger.error('anchor job failed', { stack: err.stack });
    } finally {
      running = false;
    }
  }
  setTimeout(tick, 30 * 1000).unref();
  setInterval(tick, 60 * 60 * 1000).unref();
}
