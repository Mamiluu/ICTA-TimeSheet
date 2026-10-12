// Copyright (c) 2026 Asya Hafidh <msanifuasiya@gmail.com>. All Rights Reserved.
// Proprietary and confidential. See LICENSE in the repository root.

// A door check-in is made by an organiser scanning the attendee's pass, so
// there is no drawn signature. The sheet still needs something in that cell,
// and it must not look like a real handwritten one: this is a plain
// "scanned" stamp with the time, and the row is stored with method DOOR.
// Only a time string built here goes into the image, never user input.
export function doorStampDataUri(time) {
  const safe = String(time).replace(/[^0-9:]/g, '').slice(0, 5);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="80" viewBox="0 0 240 80">` +
    `<rect x="2" y="2" width="236" height="76" rx="8" fill="none" stroke="#0a7a3a" stroke-width="3" stroke-dasharray="6 4"/>` +
    `<text x="120" y="34" text-anchor="middle" font-family="Arial,sans-serif" font-size="17" font-weight="700" fill="#0a7a3a">SCANNED AT DOOR</text>` +
    `<text x="120" y="58" text-anchor="middle" font-family="Arial,sans-serif" font-size="15" fill="#0a7a3a">${safe}</text></svg>`;
  return 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64');
}

// "HH:MM" for an instant, in the event's own time zone.
export function clockInZone(date, timezone) {
  return new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
}
