// Copyright (c) 2026 Asya Hafidh <msanifuasiya@gmail.com>. All Rights Reserved.
// Proprietary and confidential. See LICENSE in the repository root.

import { prisma } from './prisma.js';
import { hashToken } from './tokens.js';

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
  const canonical = JSON.stringify({
    prevHash,
    actorId: entry.actorId || null,
    action: entry.action,
    targetType: entry.targetType || null,
    targetId: entry.targetId || null,
    metadata: entry.metadata ?? null,
    createdAt: entry.createdAt
  });
  return { prevHash, hash: hashToken(canonical) };
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
  return entries.map((e) => {
    const canonical = JSON.stringify({
      prevHash: e.prevHash,
      actorId: e.actorId || null,
      action: e.action,
      targetType: e.targetType || null,
      targetId: e.targetId || null,
      metadata: e.metadata ?? null,
      createdAt: e.createdAt.toISOString ? e.createdAt.toISOString() : e.createdAt
    });
    return e.hash != null && hashToken(canonical) === e.hash;
  });
}
