// Copyright (c) 2026 Asya Hafidh <msanifuasiya@gmail.com>. All Rights Reserved.
// Proprietary and confidential. See LICENSE in the repository root.

import { checkAccent } from './color.js';

function trimmed(v) {
  return String(v ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Validates what an organisation admin types into the branding form. An empty field
// means "use the default", stored as null. Returns { value } or { error }.
export function cleanBranding(body) {
  const out = {};

  const displayName = trimmed(body.displayName);
  if (displayName && (displayName.length < 3 || displayName.length > 100)) return { error: 'The name on printouts must be between 3 and 100 characters.' };
  out.displayName = displayName || null;

  // The address keeps its line breaks: each line is a line of the letterhead.
  const addressLines = String(body.address ?? '')
    .split(/\r?\n/)
    .map(trimmed)
    .filter(Boolean);
  if (addressLines.length > 4) return { error: 'The address can have at most four lines.' };
  if (addressLines.some((l) => l.length > 80)) return { error: 'Each address line can be at most 80 characters.' };
  out.address = addressLines.length ? addressLines.join('\n') : null;

  const phone = trimmed(body.phone);
  if (phone && (phone.length > 30 || !/^[0-9+()\-./ ]+$/.test(phone))) return { error: 'The phone number can only have digits, spaces and + ( ) - . /, up to 30 characters.' };
  out.phone = phone || null;

  const website = trimmed(body.website);
  if (website && (website.length > 120 || !/^https?:\/\/[^\s<>"']+$/i.test(website))) return { error: 'The website must start with http:// or https://.' };
  out.website = website || null;

  const accent = trimmed(body.accentColor);
  if (accent) {
    const checked = checkAccent(accent);
    if (checked.error) return { error: checked.error };
    out.accentColor = checked.hex;
  } else {
    out.accentColor = null;
  }
  return { value: out };
}