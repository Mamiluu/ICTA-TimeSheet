// Copyright (c) 2026 Asya Hafidh <msanifuasiya@gmail.com>. All Rights Reserved.
// Proprietary and confidential. See LICENSE in the repository root.

import { prisma } from './prisma.js';
import { hostKey } from './domains.js';

// Which organisation a request is for, judged by the web address it arrived on, and the address
// an organisation's links should use. A platform-wide address (PUBLIC_APP_URL) is the default.

export function platformBase() {
  return String(process.env.PUBLIC_APP_URL || '').replace(/\/$/, '');
}

export function platformHost() {
  try {
    return new URL(platformBase()).hostname.toLowerCase();
  } catch {
    return '';
  }
}

// Set to a domain you control with a wildcard record (for example attend.example.org) and every
// organisation is also reachable at <its short address>.attend.example.org.
function platformDomain() {
  return String(process.env.PLATFORM_DOMAIN || '').trim().toLowerCase() || null;
}

// Own address only once it has been checked; otherwise the platform's.
export function baseUrlFor(org) {
  return org && org.customDomain && org.domainVerifiedAt ? `https://${org.customDomain}` : platformBase();
}

const TTL_MS = 60 * 1000;
const hostCache = new Map();
const baseCache = new Map();

export function invalidateHostCache() {
  hostCache.clear();
  baseCache.clear();
}

export async function orgForHost(host) {
  const key = hostKey(host, platformHost(), platformDomain());
  if (!key) return null;
  const id = `${key.kind}:${key.value}`;
  const hit = hostCache.get(id);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.org;
  const select = { id: true, slug: true, status: true, customDomain: true, domainVerifiedAt: true };
  const org =
    key.kind === 'slug'
      ? await prisma.organisation.findUnique({ where: { slug: key.value }, select })
      : await prisma.organisation.findFirst({ where: { customDomain: key.value, domainVerifiedAt: { not: null } }, select });
  hostCache.set(id, { at: Date.now(), org });
  return org;
}

// The base address for links about an organisation whose id is all that is to hand.
export async function orgBaseUrl(organisationId) {
  const hit = baseCache.get(organisationId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.url;
  const org = await prisma.organisation.findUnique({ where: { id: organisationId }, select: { customDomain: true, domainVerifiedAt: true } });
  const url = baseUrlFor(org);
  baseCache.set(organisationId, { at: Date.now(), url });
  return url;
}

// Puts the organisation for the address on the request, when there is one.
export async function attachHostOrg(req, res, next) {
  try {
    req.hostOrg = await orgForHost(req.hostname);
  } catch {
    req.hostOrg = null;
  }
  next();
}