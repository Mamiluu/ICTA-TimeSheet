// Copyright (c) 2026 Asya Hafidh <msanifuasiya@gmail.com>. All Rights Reserved.
// Proprietary and confidential. See LICENSE in the repository root.

import dns from 'node:dns/promises';

// An organisation can use its own web address, such as attend.theirname.go.ke. It only counts
// once the owner has checked that the address really points at this platform: otherwise anyone
// could claim an address and have the platform answer as their organisation on it.

// Returns the address in its normal form, or null if it cannot be one.
export function cleanDomain(raw) {
  const d = String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
    .replace(/\.$/, '');
  if (d.length < 4 || d.length > 120) return null;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(d)) return null; // an IP address is not a name
  const labels = d.split('.');
  if (labels.length < 3) return null; // a name under the organisation's own domain, not the bare domain
  if (!labels.every((l) => /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(l))) return null;
  if (!/^[a-z]{2,}$/.test(labels[labels.length - 1])) return null;
  return d;
}

// The platform's own host names can never be claimed by an organisation.
export function isPlatformHost(domain, platformHost) {
  if (!platformHost) return false;
  const d = domain.toLowerCase();
  const p = platformHost.toLowerCase();
  return d === p || d.endsWith('.' + p);
}

// Does the address point at the platform? Looks for a CNAME to the platform's own host name.
// The lookup is passed in so it can be tested without a network.
export async function checkPointsAt(domain, platformHost, resolveCname = dns.resolveCname) {
  let records = [];
  try {
    records = await resolveCname(domain);
  } catch (err) {
    if (err && (err.code === 'ENODATA' || err.code === 'ENOTFOUND')) return { ok: false, found: [], reason: 'NO_RECORD' };
    return { ok: false, found: [], reason: 'LOOKUP_FAILED' };
  }
  const found = records.map((r) => String(r).toLowerCase().replace(/\.$/, ''));
  const target = platformHost.toLowerCase();
  const ok = found.some((r) => r === target);
  return { ok, found, reason: ok ? null : 'WRONG_TARGET' };
}

// The organisation for a request's host name: a verified own address, or a name under the
// platform's own wildcard domain (acme.platform.example). Returns { kind, value } or null.
export function hostKey(host, platformHost, platformDomain) {
  const h = String(host || '')
    .toLowerCase()
    .replace(/:\d+$/, '');
  if (!h || h === platformHost) return null;
  if (platformDomain && h.endsWith('.' + platformDomain)) {
    const label = h.slice(0, -(platformDomain.length + 1));
    if (label && !label.includes('.')) return { kind: 'slug', value: label };
  }
  return { kind: 'domain', value: h };
}