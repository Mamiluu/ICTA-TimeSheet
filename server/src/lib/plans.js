// Copyright (c) 2026 Asya Hafidh <msanifuasiya@gmail.com>. All Rights Reserved.
// Proprietary and confidential. See LICENSE in the repository root.

// What an organisation can use, and how much. The platform owner picks a plan, which fills in
// the modules and limits, and can then adjust either by hand. Prices are the owner's own
// business and are not kept here.

export const MODULES = {
  ATTENDANCE: 'Attendance sheets',
  PAYMENT: 'Payment sheets',
  DOOR_SCAN: 'Door scanning',
  CERTIFICATES: 'Certificates'
};
export const MODULE_KEYS = Object.keys(MODULES);

export const PLANS = {
  PILOT: { label: 'Pilot', modules: MODULE_KEYS, maxAdmins: null, maxEventsPerMonth: null, maxAttendeesPerEvent: 500 },
  STARTER: { label: 'Starter', modules: ['ATTENDANCE', 'CERTIFICATES'], maxAdmins: 5, maxEventsPerMonth: 30, maxAttendeesPerEvent: 200 },
  STANDARD: { label: 'Standard', modules: ['ATTENDANCE', 'CERTIFICATES', 'DOOR_SCAN'], maxAdmins: 25, maxEventsPerMonth: 300, maxAttendeesPerEvent: 500 },
  FULL: { label: 'Full', modules: MODULE_KEYS, maxAdmins: 100, maxEventsPerMonth: null, maxAttendeesPerEvent: 2000 }
};

// However a plan is set, one event never takes more than this. Each signature is a picture, so an
// unlimited event would be limited by the database, not by anything the owner chose.
export const HARD_MAX_ATTENDEES = 5000;

// How many people can sign one event for an organisation's plan.
export function attendeeCap(plan) {
  const own = plan && Number.isInteger(plan.maxAttendeesPerEvent) ? plan.maxAttendeesPerEvent : null;
  return own === null ? HARD_MAX_ATTENDEES : Math.min(own, HARD_MAX_ATTENDEES);
}

// An organisation row with nothing recorded (an old row, a test) has everything on.
export function hasModule(org, key) {
  const mods = org && Array.isArray(org.modules) ? org.modules : MODULE_KEYS;
  return mods.includes(key);
}

// Returns { value } or { error }. The plan only sets the starting point; modules and limits
// that are sent explicitly win, and the plan is then called CUSTOM if they differ from it.
export function cleanPlanInput(body) {
  const planKey = String(body.plan ?? '').toUpperCase();
  const preset = PLANS[planKey];
  if (!preset && planKey !== 'CUSTOM') return { error: 'Choose one of the plans.' };

  const modules = body.modules === undefined ? (preset ? preset.modules : null) : body.modules;
  if (!Array.isArray(modules) || !modules.length || modules.some((m) => !MODULE_KEYS.includes(m))) return { error: 'Choose at least one module from the list.' };
  const picked = MODULE_KEYS.filter((m) => modules.includes(m));
  if (!picked.includes('ATTENDANCE') && !picked.includes('PAYMENT')) return { error: 'An organisation needs attendance sheets or payment sheets.' };

  const limit = (raw, fallback, name) => {
    const v = raw === undefined ? fallback : raw;
    if (v === null || v === '') return { value: null };
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1 || n > 100000) return { error: `${name} must be a whole number from 1 to 100,000, or left empty for no limit.` };
    return { value: n };
  };
  const admins = limit(body.maxAdmins, preset ? preset.maxAdmins : null, 'The administrator limit');
  if (admins.error) return { error: admins.error };
  const events = limit(body.maxEventsPerMonth, preset ? preset.maxEventsPerMonth : null, 'The events-per-month limit');
  if (events.error) return { error: events.error };
  const people = limit(body.maxAttendeesPerEvent, preset ? preset.maxAttendeesPerEvent : null, 'The people-per-event limit');
  if (people.error) return { error: people.error };
  if (people.value !== null && people.value > HARD_MAX_ATTENDEES) return { error: `The people-per-event limit cannot be more than ${HARD_MAX_ATTENDEES}.` };

  const same = preset && picked.join() === preset.modules.join() && admins.value === preset.maxAdmins && events.value === preset.maxEventsPerMonth && people.value === preset.maxAttendeesPerEvent;
  return { value: { plan: same ? planKey : 'CUSTOM', modules: picked, maxAdmins: admins.value, maxEventsPerMonth: events.value, maxAttendeesPerEvent: people.value } };
}

// Whether one more of something fits. limit null means no limit.
export function withinLimit(used, limit) {
  return limit === null || limit === undefined || used < limit;
}

// First day of the current month in UTC, for "events this month".
export function monthStart(now = new Date()) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}