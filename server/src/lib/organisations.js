// Copyright (c) 2026 Asya Hafidh <msanifuasiya@gmail.com>. All Rights Reserved.
// Proprietary and confidential. See LICENSE in the repository root.

// Addresses that must stay free for the platform itself.
const RESERVED_SLUGS = new Set(['www', 'api', 'app', 'admin', 'owner', 'platform', 'static', 'assets', 'mail', 'support', 'help', 'status', 'login', 'demo', 'test']);

export function orgSlug(name) {
  return String(name)
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 40)
    .replace(/-$/, '');
}

export function isValidOrgSlug(slug) {
  return /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/.test(slug) && !slug.includes('--') && !RESERVED_SLUGS.has(slug);
}

// Returns a trimmed single-spaced name, or null when it isn't usable.
export function cleanOrgName(raw) {
  const name = String(raw ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (name.length < 3 || name.length > 100) return null;
  return orgSlug(name) ? name : null;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const DUE_SOON_DAYS = 7;

// Where an organisation stands on its monthly payment, for the owner's console.
// NOT_SET: no billing. PAID: covered beyond the next week. DUE_SOON: runs out within a
// week. OVERDUE: the paid-until date has passed.
export function billingState(paidUntil, now = Date.now()) {
  if (!paidUntil) return { state: 'NOT_SET', days: null };
  const diff = new Date(paidUntil).getTime() - now;
  const days = Math.ceil(diff / DAY_MS);
  if (diff < 0) return { state: 'OVERDUE', days: Math.floor(Math.abs(diff) / DAY_MS) };
  if (days <= DUE_SOON_DAYS) return { state: 'DUE_SOON', days };
  return { state: 'PAID', days };
}

// A payment covers whole months, counted from whichever is later: today, or the date the
// last payment ran out (so paying early never loses days).
export function extendPaidUntil(paidUntil, months, now = Date.now()) {
  const start = Math.max(now, paidUntil ? new Date(paidUntil).getTime() : 0);
  const d = new Date(start);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const lastOfMonth = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, lastOfMonth));
  return d;
}

export function cleanShortName(raw) {
  const s = String(raw ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 20);
  return s || null;
}