// Copyright (c) 2026 Asya Hafidh <msanifuasiya@gmail.com>. All Rights Reserved.
// Proprietary and confidential. See LICENSE in the repository root.

import { prisma } from './prisma.js';
import { hashToken } from './tokens.js';

// Plain JSON.stringify's key order follows insertion order, which isn't
// stable across a Postgres jsonb round-trip (metadata is written from a
// JS object literal, then read back as whatever key order jsonb storage
// happens to produce) -- hashing either form directly would make
// verifyChain's recomputation depend on where the object came from rather
// than what it contains. Sorting keys recursively before stringifying
// makes the hash depend only on the actual data, so it's identical
// whether it's computed pre-insert (writeAudit) or post-read (verifyChain).
function canonicalJson(value) {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(value[k])).join(',') + '}';
  }
  return JSON.stringify(value === undefined ? null : value);
}

function entryHashInput(entry) {
  return canonicalJson({
    prevHash: entry.prevHash ?? null,
    actorId: entry.actorId || null,
    action: entry.action,
    targetType: entry.targetType || null,
    targetId: entry.targetId || null,
    metadata: entry.metadata ?? null,
    createdAt: entry.createdAt instanceof Date ? entry.createdAt.toISOString() : entry.createdAt
  });
}

// Every entry chains onto whatever was most recently written, so altering
// or deleting an old entry breaks recomputation for everything after it --
// see the matching comment on AuditLog.hash in schema.prisma. Two
// writeAudit() calls racing on the same "latest" row can both chain onto
// it and fork the chain; that's an accepted tradeoff, same as the
// count-then-insert races already tolerated elsewhere in this codebase
// (e.g. the MAX_ATTENDANCE_PER_EVENT check in public.js) -- the goal is
// tamper *evidence*, not strict linearizability. A fork is still visible
// to a verifier, just not prevented.
async function nextHash(entry) {
  const latest = await prisma.auditLog.findFirst({ orderBy: { createdAt: 'desc' }, select: { hash: true } });
  const prevHash = latest ? latest.hash : null;
  return { prevHash, hash: hashToken(entryHashInput({ ...entry, prevHash })) };
}

export async function writeAudit({ actorId, action, targetType, targetId, metadata, req }) {
  const actor = actorId
    ? await prisma.user.findUnique({ where: { id: actorId }, select: { email: true, role: true, county: true } })
    : null;
  const createdAt = new Date();
  const { prevHash, hash } = await nextHash({ actorId, action, targetType, targetId, metadata, createdAt });
  return prisma.auditLog.create({
    data: {
      actorId,
      actorEmail: actor ? actor.email : null,
      actorRole: actor ? actor.role : null,
      actorCounty: actor ? actor.county : null,
      action,
      targetType: targetType || null,
      targetId: targetId || null,
      metadata: metadata ?? undefined,
      ip: req ? req.ip : null,
      userAgent: req ? req.get('user-agent') || null : null,
      createdAt,
      prevHash,
      hash
    }
  });
}

// Recomputes each entry's hash from its own stored fields and compares it
// to what's on the row -- if either the entry itself or an earlier one in
// the chain (which its prevHash points back to) was altered after the
// fact, the hashes stop lining up starting from that point onward. Used
// by the /attendance/:rowId/history endpoint (public.js) to attach a
// verified flag per entry rather than shipping this logic to the client.
export function verifyChain(entries) {
  return entries.map((e) => e.hash != null && hashToken(entryHashInput(e)) === e.hash);
}
