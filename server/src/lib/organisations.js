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

export function cleanShortName(raw) {
  const s = String(raw ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 20);
  return s || null;
}