// Copyright (c) 2026 Asya Hafidh <msanifuasiya@gmail.com>. All Rights Reserved.
// Proprietary and confidential. See LICENSE in the repository root.

import { prisma } from './prisma.js';
import { BRANDING } from './branding.js';
import { darken, wash } from './color.js';
import { SEAL_CODE_PATTERN } from './seal.js';

// The organisation whose look is used when a page does not say whose it is. Anything an
// organisation has not filled in falls back to the platform defaults in lib/branding.js,
// which is how ICT Authority looks without having entered anything.
export const DEFAULT_ORG_SLUG = String(process.env.DEFAULT_ORG_SLUG || 'icta').toLowerCase();
export const DEFAULT_ACCENT = '#c8102e';
const DEFAULT_LOGO = '/assets/icta_logo_cropped.png';

function lines(text) {
  return String(text || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

// What the browser, the printouts and the emails are told about an organisation's look.
// Pure: takes an organisation row, returns plain values.
export function brandFromOrg(org) {
  const isDefault = !org || org.slug === DEFAULT_ORG_SLUG;
  const accent = (org && org.accentColor) || DEFAULT_ACCENT;
  const slug = org ? org.slug : DEFAULT_ORG_SLUG;
  let logoUrl;
  if (org && org.logoMime) logoUrl = `/api/org-logo/${slug}?v=${org.logoVersion}`;
  else if (isDefault) logoUrl = DEFAULT_LOGO;
  else logoUrl = `/api/org-logo/${slug}`; // a generated monogram

  const ownAddress = org && org.address ? lines(org.address) : [];
  return {
    slug,
    orgName: (org && org.displayName) || (isDefault ? BRANDING.orgName : org.name),
    shortName: (org && org.shortName) || null,
    productName: BRANDING.productName,
    addressLines: ownAddress.length ? ownAddress : isDefault ? BRANDING.addressLines : [],
    phone: (org && org.phone) || (isDefault ? BRANDING.phone : ''),
    website: (org && org.website) || (isDefault ? BRANDING.website : ''),
    accent,
    accentDark: darken(accent, 0.2),
    accentWash: wash(accent, 0.92),
    logoUrl
  };
}

const TTL_MS = 30 * 1000;
const cache = new Map();

export function invalidateBrandCache() {
  cache.clear();
}

async function cached(key, load) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.brand;
  const brand = brandFromOrg(await load());
  cache.set(key, { at: Date.now(), brand });
  return brand;
}

export const brandForOrgId = (id) => cached('id:' + id, () => prisma.organisation.findUnique({ where: { id } }));
export const brandForSlug = (slug) => cached('slug:' + slug, () => prisma.organisation.findUnique({ where: { slug } }));

async function orgIdOfCode(code) {
  const seal = await prisma.sheetSeal.findUnique({ where: { id: code }, select: { event: { select: { organisationId: true } } } });
  if (seal) return seal.event.organisationId;
  const cert = await prisma.attendanceCertificate.findUnique({ where: { id: code }, select: { event: { select: { organisationId: true } } } });
  return cert ? cert.event.organisationId : null;
}

// Whose look applies to this request: an explicit organisation, the event or record
// the page is about, the person signed in, or failing all that the platform default.
// Only ever returns public branding.
export async function resolveBrand(req) {
  const q = req.query || {};
  if (q.org) {
    const slug = String(q.org).toLowerCase().slice(0, 60);
    return brandForSlug(slug);
  }
  if (q.event) {
    const key = String(q.event).slice(0, 100);
    const ev = await prisma.event.findFirst({ where: { OR: [{ slug: key }, { id: key }], deletedAt: null }, select: { organisationId: true } });
    if (ev) return brandForOrgId(ev.organisationId);
  }
  if (q.code) {
    const code = String(q.code).toUpperCase();
    if (SEAL_CODE_PATTERN.test(code)) {
      const orgId = await orgIdOfCode(code);
      if (orgId) return brandForOrgId(orgId);
    }
  }
  if (req.user && req.user.organisationId) return brandForOrgId(req.user.organisationId);
  return brandForSlug(DEFAULT_ORG_SLUG);
}

// The same brand with the logo as a full web address, for emails, which are opened
// away from this site.
export function emailBrand(brand) {
  const base = String(process.env.PUBLIC_APP_URL || '').replace(/\/$/, '');
  return { ...brand, logoUrl: /^https?:/.test(brand.logoUrl) ? brand.logoUrl : base + brand.logoUrl };
}

// The first letters of an organisation's name, for the generated logo.
export function monogram(name) {
  const words = String(name || '')
    .replace(/[^A-Za-z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  const letters = words.length > 1 ? words[0][0] + words[1][0] : (words[0] || '?').slice(0, 2);
  return letters.toUpperCase();
}

export function monogramSvg(name, accent) {
  const hex = /^#[0-9a-f]{6}$/i.test(accent) ? accent : DEFAULT_ACCENT;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120" width="120" height="120" role="img"><circle cx="60" cy="60" r="56" fill="${hex}"/><text x="60" y="60" text-anchor="middle" dominant-baseline="central" font-family="Trebuchet MS, Tahoma, Arial, sans-serif" font-size="44" font-weight="700" fill="#ffffff">${monogram(name)}</text></svg>`;
}