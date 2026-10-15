// Copyright (c) 2026 Asya Hafidh <msanifuasiya@gmail.com>. All Rights Reserved.
// Proprietary and confidential. See LICENSE in the repository root.

// Colour maths for an organisation's accent colour. The accent is used as a button
// and link colour with white text on top, so it has to be dark enough to read.

export function parseHex(raw) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(raw ?? '').trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

export function toHex({ r, g, b }) {
  const h = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}

function channel(v) {
  const s = v / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

function luminance({ r, g, b }) {
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

// WCAG contrast ratio between two hex colours (1 to 21).
export function contrastRatio(a, b) {
  const x = parseHex(a);
  const y = parseHex(b);
  if (!x || !y) return null;
  const l1 = luminance(x);
  const l2 = luminance(y);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

export const MIN_ACCENT_CONTRAST = 4.5;

// Returns { hex } in the normal form, or { error } with a message fit to show.
export function checkAccent(raw) {
  const rgb = parseHex(raw);
  if (!rgb) return { error: 'Enter the colour as six hexadecimal digits, for example #c8102e.' };
  const hex = toHex(rgb);
  const ratio = contrastRatio(hex, '#ffffff');
  if (ratio < MIN_ACCENT_CONTRAST) {
    return { error: 'That colour is too light: white text on it would be hard to read. Choose a darker shade.' };
  }
  return { hex };
}

// Mixes a colour toward black (amount 0 to 1).
export function darken(hex, amount) {
  const c = parseHex(hex);
  return toHex({ r: c.r * (1 - amount), g: c.g * (1 - amount), b: c.b * (1 - amount) });
}

// Mixes a colour toward white, for soft backgrounds.
export function wash(hex, amount) {
  const c = parseHex(hex);
  return toHex({ r: c.r + (255 - c.r) * amount, g: c.g + (255 - c.g) * amount, b: c.b + (255 - c.b) * amount });
}