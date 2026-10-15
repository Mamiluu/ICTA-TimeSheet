// Copyright (c) 2026 Asya Hafidh <msanifuasiya@gmail.com>. All Rights Reserved.
// Proprietary and confidential. See LICENSE in the repository root.

// Rules for the platform owner's support access to an organisation. The owner can only look
// inside when the organisation's own administrator has said yes, for a limited time, and
// only at the administrator's own read-only view: never attendee records, never a change.

export const REQUEST_VALID_HOURS = 72;
export const MAX_SUPPORT_HOURS = 24;
export const DEFAULT_SUPPORT_HOURS = 4;

// What a grant amounts to right now.
//   PENDING   asked for, waiting for the organisation's administrator
//   LAPSED    asked for, never answered, and too old to act on
//   ACTIVE    approved and still running
//   ENDED     approved, and its time has run out
//   DENIED / REVOKED  refused, or ended early by the administrator or the owner
export function supportState(grant, now = Date.now()) {
  if (grant.status === 'DENIED') return 'DENIED';
  if (grant.status === 'REVOKED') return 'REVOKED';
  if (grant.status === 'APPROVED') return grant.expiresAt && new Date(grant.expiresAt).getTime() > now ? 'ACTIVE' : 'ENDED';
  const age = now - new Date(grant.createdAt).getTime();
  return age > REQUEST_VALID_HOURS * 60 * 60 * 1000 ? 'LAPSED' : 'PENDING';
}

export const isOpenState = (state) => state === 'PENDING' || state === 'ACTIVE';

// Returns { value } or { error } with a message fit to show.
export function cleanSupportRequest(body) {
  const reason = String(body.reason ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (reason.length < 10) return { error: 'Say what you need to look into, in at least ten characters, so the organisation can decide.' };
  if (reason.length > 300) return { error: 'Keep the reason to 300 characters.' };
  const hours = body.hours === undefined || body.hours === '' ? DEFAULT_SUPPORT_HOURS : Number(body.hours);
  if (!Number.isInteger(hours) || hours < 1 || hours > MAX_SUPPORT_HOURS) return { error: `Choose between 1 and ${MAX_SUPPORT_HOURS} hours.` };
  return { value: { reason, hours } };
}

// The organisation administrator's own pages the owner may read during a support session.
// Nothing else is reachable, and nothing can be changed.
const SUPPORT_READ_PATHS = new Set(['/departments', '/super-admins', '/overview', '/audit', '/branding']);

export function supportAllowed(method, path) {
  return method === 'GET' && SUPPORT_READ_PATHS.has(path);
}