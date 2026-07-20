// Copyright (c) 2026 Asya Hafidh <msanifuasiya@gmail.com>. All Rights Reserved.
// Proprietary and confidential. See LICENSE in the repository root.

// Mirrors the attendee page's normalizeKenyanPhone() and the previous
// google-apps-script.gs normalizePhone_() so "0712345678" and
// "+254712345678" are recognized as the same attendee regardless of which
// form was sent -- kept identical to the prior backend's behavior.
export function normalizePhone(raw) {
  const v = String(raw || '').trim().replace(/[\s-]/g, '');
  if (/^0\d{9}$/.test(v)) return '+254' + v.slice(1);
  if (/^\+254\d{9}$/.test(v)) return v;
  if (/^254\d{9}$/.test(v)) return '+' + v;
  return null;
}

export function normalizeEmail(raw) {
  const v = String(raw || '').trim().toLowerCase();
  return v || null;
}

export function slugify(s) {
  const base = String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 40);
  return base || 'event';
}

export function eventSlugId(name) {
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14); // yyyyMMddHHmmss (14 digits, no trailing '.' from milliseconds)
  return `${slugify(name)}-${stamp}`;
}
