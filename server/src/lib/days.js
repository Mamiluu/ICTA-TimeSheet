// Copyright (c) 2026 Asya Hafidh <msanifuasiya@gmail.com>. All Rights Reserved.
// Proprietary and confidential. See LICENSE in the repository root.

import { prisma } from './prisma.js';
import { DAY_SIGN_OPENS_BEFORE_MS, DAY_SIGN_CLOSES_AFTER_MS } from './constants.js';

export function dayOpensAt(day) {
  return new Date(day.startAt.getTime() - DAY_SIGN_OPENS_BEFORE_MS);
}

export function dayClosesAt(day) {
  return new Date(day.endAt.getTime() + DAY_SIGN_CLOSES_AFTER_MS);
}

export function dayIsOpen(day, now = Date.now()) {
  return now >= dayOpensAt(day).getTime() && now <= dayClosesAt(day).getTime();
}

// Every event has a day 1 once the multi-day migration has run; events
// created afterwards get it from the admin create route. The upsert covers
// any event that somehow reaches a sign-in without one, without ever
// creating a duplicate.
export function ensureFirstDay(event) {
  return prisma.eventDay.upsert({
    where: { eventId_position: { eventId: event.id, position: 1 } },
    update: {},
    create: { eventId: event.id, position: 1, startAt: event.startAt, endAt: event.endAt }
  });
}
