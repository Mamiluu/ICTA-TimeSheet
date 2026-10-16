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
export function canonicalJson(value) {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(value[k])).join(',') + '}';
  }
  return JSON.stringify(value === undefined ? null : value);
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;

// What the old code effectively hashed for a date inside metadata: nothing, an empty object.
// Only used to recognise entries written before that was fixed.
function blindDates(value) {
  if (Array.isArray(value)) return value.map(blindDates);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, blindDates(v)]));
  return typeof value === 'string' && ISO_DATE.test(value) ? {} : value;
}

// Metadata as the database will hand it back: dates become text, undefined disappears.
// Hashing this, not the raw object, is what lets an entry be verified after it is stored.
export function normaliseMetadata(metadata) {
  return metadata === undefined || metadata === null ? metadata : JSON.parse(JSON.stringify(metadata));
}

// Whether an entry's stored hash matches its own fields. Entries from before hashVersion 2 are
// also accepted if they match with dates left out, which is how they were hashed.
export function hashMatches(entry) {
  if (entry.hash == null) return false;
  if (hashToken(entryHashInput(entry)) === entry.hash) return true;
  if (entry.hashVersion !== 1) return false;
  return hashToken(entryHashInput({ ...entry, metadata: blindDates(entry.metadata) })) === entry.hash;
}

export function entryHashInput(entry) {
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
// Each organisation has its own chain (and the platform owner has one of their own), so an
// organisation can verify its trail without anyone else's entries in it, and its anchor
// copies say nothing about another organisation.
async function nextHash(entry, organisationId) {
  const latest = await prisma.auditLog.findFirst({ where: { organisationId }, orderBy: { createdAt: 'desc' }, select: { hash: true } });
  const prevHash = latest ? latest.hash : null;
  return { prevHash, hash: hashToken(entryHashInput({ ...entry, prevHash })) };
}

// organisationId says whose record this is. It is taken from the person who acted;
// pass it explicitly for something nobody signed in did (an attendee signing a day).
export async function writeAudit({ actorId, action, targetType, targetId, metadata, req, organisationId }) {
  const actor = actorId
    ? await prisma.user.findUnique({ where: { id: actorId }, select: { email: true, role: true, county: true, organisationId: true } })
    : null;
  const createdAt = new Date();
  const orgId = organisationId !== undefined ? organisationId : actor ? actor.organisationId : null;
  const stored = normaliseMetadata(metadata);
  const { prevHash, hash } = await nextHash({ actorId, action, targetType, targetId, metadata: stored, createdAt }, orgId);
  return prisma.auditLog.create({
    data: {
      actorId,
      actorEmail: actor ? actor.email : null,
      actorRole: actor ? actor.role : null,
      actorCounty: actor ? actor.county : null,
      organisationId: orgId,
      action,
      targetType: targetType || null,
      targetId: targetId || null,
      metadata: stored ?? undefined,
      hashVersion: 2,
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
  return entries.map((e) => hashMatches(e));
}
