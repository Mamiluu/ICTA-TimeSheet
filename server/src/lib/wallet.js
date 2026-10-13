// Copyright (c) 2026 Asya Hafidh <msanifuasiya@gmail.com>. All Rights Reserved.
// Proprietary and confidential. See LICENSE in the repository root.

// Where a person stands on one event, for the "my events on this device" page.
//   WITHDRAWN    the organiser retired their entry
//   UPCOMING     the event has not started
//   IN_PROGRESS  it is running now (or between its days)
//   ATTENDED     it is over and they signed every day
//   PARTIAL      it is over and they signed some days
//   MISSED       it is over and they signed none
export function walletStatus({ attendeeStatus, days, signedCount, now = Date.now() }) {
  if (attendeeStatus === 'RETIRED') return 'WITHDRAWN';
  if (!days.length) return 'UPCOMING';
  const first = Math.min(...days.map((d) => new Date(d.startAt).getTime()));
  const last = Math.max(...days.map((d) => new Date(d.endAt).getTime()));
  if (now < first) return 'UPCOMING';
  if (now <= last) return 'IN_PROGRESS';
  if (signedCount <= 0) return 'MISSED';
  return signedCount >= days.length ? 'ATTENDED' : 'PARTIAL';
}

// What the wallet page is allowed to know about one event the caller proved
// they are on (by presenting its pass id). No phone, email or signatures.
export function walletEntry({ event, attendee, days, signedCount, certificate, certificateReady, now = Date.now() }) {
  return {
    slug: event.slug,
    name: event.name,
    county: event.county,
    startAt: event.startAt,
    endAt: event.endAt,
    timezone: event.timezone,
    totalDays: days.length,
    daysSigned: signedCount,
    status: walletStatus({ attendeeStatus: attendee.status, days, signedCount, now }),
    certificatesEnabled: !!event.certificatesEnabled,
    certificateReady: !!certificateReady,
    certificateCode: certificate ? certificate.id : null
  };
}
