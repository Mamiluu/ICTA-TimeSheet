// Copyright (c) 2026 Asya Hafidh <msanifuasiya@gmail.com>. All Rights Reserved.
// Proprietary and confidential. See LICENSE in the repository root.

import { prisma } from './prisma.js';
import { hasModule, withinLimit, monthStart } from './plans.js';

// An organisation's modules and limits, for the places that only have an organisation id
// (a public page about an event). Kept for half a minute so a busy page does not ask the
// database every time; a plan change clears it.
const TTL_MS = 30 * 1000;
const cache = new Map();

export function invalidatePlanCache() {
  cache.clear();
}

export async function orgPlanFor(organisationId) {
  const hit = cache.get(organisationId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.plan;
  const org = await prisma.organisation.findUnique({ where: { id: organisationId }, select: { plan: true, modules: true, maxAdmins: true, maxEventsPerMonth: true } });
  const plan = org || { plan: 'PILOT', modules: undefined, maxAdmins: null, maxEventsPerMonth: null };
  cache.set(organisationId, { at: Date.now(), plan });
  return plan;
}

export async function moduleOn(organisationId, key) {
  return hasModule(await orgPlanFor(organisationId), key);
}

// Accounts that take up one of the plan's administrator places: super admins and county
// admins who are waiting to activate or active. A disabled account gives its place back.
export function adminSeatsUsed(organisationId) {
  return prisma.user.count({ where: { organisationId, role: { in: ['SUPER_ADMIN', 'COUNTY_ADMIN'] }, status: { not: 'DISABLED' } } });
}

export function eventsThisMonth(organisationId) {
  return prisma.event.count({ where: { organisationId, createdAt: { gte: monthStart() } } });
}

// Returns null when one more administrator fits, or the message to show when it does not.
export async function adminSeatRefusal(organisationId) {
  const plan = await orgPlanFor(organisationId);
  if (plan.maxAdmins === null || plan.maxAdmins === undefined) return null;
  const used = await adminSeatsUsed(organisationId);
  if (withinLimit(used, plan.maxAdmins)) return null;
  return `Your plan allows ${plan.maxAdmins} administrators and all ${plan.maxAdmins} places are taken. Disable one you no longer need, or ask the platform operator to raise the limit.`;
}

export async function eventLimitRefusal(organisationId) {
  const plan = await orgPlanFor(organisationId);
  if (plan.maxEventsPerMonth === null || plan.maxEventsPerMonth === undefined) return null;
  const used = await eventsThisMonth(organisationId);
  if (withinLimit(used, plan.maxEventsPerMonth)) return null;
  return `Your plan allows ${plan.maxEventsPerMonth} events a month and this month's ${plan.maxEventsPerMonth} have been created. Ask the platform operator to raise the limit, or try again next month.`;
}