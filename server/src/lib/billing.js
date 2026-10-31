// Copyright (c) 2026 Asya Hafidh <msanifuasiya@gmail.com>. All Rights Reserved.
// Proprietary and confidential. See LICENSE in the repository root.

import { PLANS, MODULES, MODULE_KEYS } from './plans.js';

// What an organisation sees on its Plan and billing page, and what the owner sets behind it. The plans
// themselves (modules and limits) live in plans.js; this adds the prices, how full each limit is, and
// the nudge towards a bigger plan.

// The plans an organisation can ask for. Pilot is a trial the owner gives, never something to pick.
export const ORDERED = ['STARTER', 'STANDARD', 'FULL'];
export const REQUESTABLE = [...ORDERED, 'CUSTOM'];

export const MAX_PRICE_KES = 100000000;
const WARN_AT = 0.8;

// A price in whole shillings, or null for "not set". Returns { value } or { error }.
export function cleanPrice(raw, name) {
  if (raw === undefined || raw === null || raw === '') return { value: null };
  const n = Number(String(raw).replace(/[,\s]/g, ''));
  if (!Number.isInteger(n) || n < 0 || n > MAX_PRICE_KES) return { error: `${name} must be a whole number of shillings, or left empty.` };
  return { value: n };
}

export function cleanBlurb(raw) {
  const s = String(raw ?? '').replace(/\s+/g, ' ').trim().slice(0, 140);
  return s || null;
}

// How much of a limit is used: ok, warn (80% or more) or full. No limit is always ok.
export function usageLevel(used, limit) {
  if (limit === null || limit === undefined) return 'ok';
  if (used >= limit) return 'full';
  return used / limit >= WARN_AT ? 'warn' : 'ok';
}

// What a yearly price saves against twelve months, as a whole percentage, or null when it saves nothing
// or either price is missing.
export function yearlySavingPct(monthlyKes, yearlyKes) {
  if (!monthlyKes || !yearlyKes) return null;
  const full = monthlyKes * 12;
  if (yearlyKes >= full) return null;
  return Math.round(((full - yearlyKes) / full) * 100);
}

// The plans with their prices, in the order they are offered. prices is the PlanPrice rows.
export function catalog(prices) {
  const byPlan = new Map((prices || []).map((p) => [p.plan, p]));
  return ORDERED.map((key) => {
    const preset = PLANS[key];
    const p = byPlan.get(key) || {};
    return {
      key,
      label: preset.label,
      monthlyKes: p.monthlyKes ?? null,
      yearlyKes: p.yearlyKes ?? null,
      savingPct: yearlySavingPct(p.monthlyKes, p.yearlyKes),
      blurb: p.blurb || null,
      modules: MODULE_KEYS.map((m) => ({ key: m, label: MODULES[m], on: preset.modules.includes(m) })),
      maxAdmins: preset.maxAdmins,
      maxEventsPerMonth: preset.maxEventsPerMonth,
      maxAttendeesPerEvent: preset.maxAttendeesPerEvent
    };
  });
}

// The smallest plan above the current one that has room for what is being used, with the reason, when
// the organisation is close to or at a limit. Otherwise null. A plan outside the ladder (Pilot, Custom)
// gets no nudge: those are arranged with the owner directly.
export function suggestion(currentPlan, admins, events) {
  const at = ORDERED.indexOf(currentPlan);
  if (at === -1) return null;
  const adminLevel = usageLevel(admins.used, admins.limit);
  const eventLevel = usageLevel(events.used, events.limit);
  if (adminLevel === 'ok' && eventLevel === 'ok') return null;

  const fits = (key) => {
    const p = PLANS[key];
    return (p.maxAdmins === null || admins.used < p.maxAdmins * WARN_AT) && (p.maxEventsPerMonth === null || events.used < p.maxEventsPerMonth * WARN_AT);
  };
  const next = ORDERED.slice(at + 1).find(fits) || ORDERED[ORDERED.length - 1];
  if (next === currentPlan) return null;

  const parts = [];
  if (adminLevel !== 'ok') parts.push(adminLevel === 'full' ? `all ${admins.limit} administrator places are taken` : `${admins.used} of ${admins.limit} administrator places are used`);
  if (eventLevel !== 'ok') parts.push(eventLevel === 'full' ? `this month's ${events.limit} events are used up` : `${events.used} of ${events.limit} events this month are used`);
  return { plan: next, reason: parts.join(' and ') };
}
