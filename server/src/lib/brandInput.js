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

// The choices an organisation has for how its printed sheets look. The page maps each key to
// real CSS, so nothing the admin types ever reaches a stylesheet.
export const SHEET_OPTIONS = {
  align: ['LEFT', 'CENTER', 'RIGHT'],
  size: ['SMALL', 'MEDIUM', 'LARGE'],
  font: ['ARIAL', 'TIMES', 'GEORGIA', 'VERDANA', 'TAHOMA', 'TREBUCHET', 'CALIBRI', 'COURIER']
};
export const SHEET_DEFAULTS = { logoAlign: 'RIGHT', addressAlign: 'LEFT', logoSize: 'MEDIUM', sheetFont: 'ARIAL', sheetFontSize: 'MEDIUM' };

function pick(value, allowed) {
  const v = String(value ?? '').trim().toUpperCase();
  if (!v) return { value: null };
  return allowed.includes(v) ? { value: v } : { error: true };
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

  const footerLine = trimmed(body.footerLine);
  if (footerLine.length > 140) return { error: 'The line at the foot of printed sheets can be at most 140 characters.' };
  out.footerLine = footerLine || null;

  const checks = [
    ['logoAlign', SHEET_OPTIONS.align, 'The logo position'],
    ['addressAlign', SHEET_OPTIONS.align, 'The address position'],
    ['logoSize', SHEET_OPTIONS.size, 'The logo size'],
    ['sheetFont', SHEET_OPTIONS.font, 'The font'],
    ['sheetFontSize', SHEET_OPTIONS.size, 'The font size']
  ];
  for (const [key, allowed, label] of checks) {
    const r = pick(body[key], allowed);
    if (r.error) return { error: `${label} is not one of the choices on offer.` };
    out[key] = r.value;
  }

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