// Copyright (c) 2026 Asya Hafidh <msanifuasiya@gmail.com>. All Rights Reserved.
// Proprietary and confidential. See LICENSE in the repository root.

import { formatEventWhen } from './timezone.js';

// Sent over Brevo's HTTPS API rather than SMTP. Render's free web services
// block all outbound traffic on the SMTP ports (25/465/587) as an
// anti-abuse measure -- see
// https://render.com/changelog/free-web-services-will-no-longer-allow-outbound-traffic-to-smtp-ports
// -- so nodemailer-over-SMTP can never connect from this deployment no
// matter how it's configured. HTTPS on 443 isn't affected, which is what
// every transactional-email API rides on.
const BREVO_ENDPOINT = 'https://api.brevo.com/v3/smtp/email';

async function sendViaBrevo({ to, subject, html }) {
  const apiKey = process.env.BREVO_API_KEY;
  if (!apiKey) throw new Error('BREVO_API_KEY is not configured');

  const res = await fetch(BREVO_ENDPOINT, {
    method: 'POST',
    headers: {
      'api-key': apiKey,
      'Content-Type': 'application/json',
      Accept: 'application/json'
    },
    body: JSON.stringify({
      sender: { name: 'ICT Authority — Event Attendance', email: process.env.GMAIL_SENDER_ADDRESS },
      to: [{ email: to }],
      subject,
      htmlContent: html
    })
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Brevo send failed (${res.status}): ${body}`);
  }
}

const BRAND = {
  accent: '#c8102e'
};

function wrapHtml(bodyHtml) {
  return `<!doctype html>
<html><body style="margin:0;padding:24px;background:#e9e9e9;font-family:'Trebuchet MS',Tahoma,Verdana,Arial,sans-serif;">
  <div style="max-width:520px;margin:0 auto;background:#fff;border-radius:4px;padding:28px 32px;box-shadow:0 4px 24px rgba(0,0,0,.15);">
    <h1 style="font-size:16px;margin:0 0 16px;color:#1a1a1a;">ICT Authority — Event Attendance</h1>
    ${bodyHtml}
    <p style="font-size:11px;color:#888;margin-top:28px;">© 2026 Asya Hafidh. All rights reserved.</p>
  </div>
</body></html>`;
}

// Local/dev convenience: when BREVO_API_KEY isn't configured for real
// delivery (e.g. running against a scratch DB with no mail account set up
// yet), print the link instead of only logging a send failure -- lets the
// activation/reset flow be exercised end-to-end without email.
function devLogLink(label, url) {
  if (process.env.NODE_ENV !== 'production') {
    console.log(`[dev] ${label}: ${url}`);
  }
}

export async function sendActivationEmail(toEmail, activateUrl, county) {
  devLogLink(`activation link for ${toEmail}`, activateUrl);
  const html = wrapHtml(`
    <p style="font-size:13.5px;color:#333;">An account has been created for you as the <strong>${county}</strong> county admin.</p>
    <p style="font-size:13.5px;color:#333;">Click the button below to set your own password and activate your account. This link can only be used once and expires in 48 hours.</p>
    <p style="margin:22px 0;"><a href="${activateUrl}" style="background:${BRAND.accent};color:#fff;padding:11px 20px;border-radius:6px;text-decoration:none;font-weight:600;font-size:13px;">Activate your account</a></p>
    <p style="font-size:11.5px;color:#888;">If the button doesn't work, copy this link: ${activateUrl}</p>
  `);
  await sendViaBrevo({ to: toEmail, subject: 'Activate your ICT Authority admin account', html });
}

export async function sendPasswordResetEmail(toEmail, resetUrl) {
  devLogLink(`password reset link for ${toEmail}`, resetUrl);
  const html = wrapHtml(`
    <p style="font-size:13.5px;color:#333;">A password reset was requested for this account. Click below to set a new password. This link can only be used once and expires in 1 hour.</p>
    <p style="margin:22px 0;"><a href="${resetUrl}" style="background:${BRAND.accent};color:#fff;padding:11px 20px;border-radius:6px;text-decoration:none;font-weight:600;font-size:13px;">Reset your password</a></p>
    <p style="font-size:11.5px;color:#888;">If you didn't request this, you can safely ignore this email — your password will not change.</p>
    <p style="font-size:11.5px;color:#888;">If the button doesn't work, copy this link: ${resetUrl}</p>
  `);
  await sendViaBrevo({ to: toEmail, subject: 'Reset your ICT Authority admin password', html });
}

// Attendee-facing, so unlike the two admin emails above this carries no
// link or CTA at all -- there is nothing to click, only a record to keep.
// Anything interpolated below came from a public, unauthenticated form
// (name/org/event fields), so it's escaped before it ever touches the
// template -- otherwise a name like `<img src=x onerror=...>` would render
// live in the recipient's own inbox.
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// Pinned to Africa/Nairobi rather than the server's own timezone -- Render
// runs this process in UTC, and an attendee reading "recorded at" for an
// event that happened in Kenya should see Kenyan time, not the host's.
function formatRecordedAt(date) {
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
    timeZone: 'Africa/Nairobi'
  }).format(date) + ' EAT';
}

// The confirmation is modelled as a torn ticket stub rather than another
// "card with a button" -- there's no action left for the attendee to take,
// so the design's job is to read as a kept receipt, not a prompt. The
// perforation is built from a full-bleed 3-cell table (circle / dashed line
// / circle) whose circles match the page background -- that reads as a
// notch cut into the card edge without relying on negative margins or
// absolute positioning, which don't survive Outlook's rendering engine.
export async function sendAttendanceConfirmationEmail(toEmail, details) {
  const {
    name, eventName, eventDescription, startAt, endAt, timezone,
    locationType, address, meetingLink, county, recordId, recordedAt
  } = details;

  const refCode = `ICTA-${String(recordId || '').replace(/-/g, '').slice(0, 8).toUpperCase()}`;
  devLogLink(`attendance confirmation for ${toEmail}`, `${refCode} — ${eventName}`);
  const pageBg = '#e9e9e9';
  const divider = '#d8d8d8';

  const metaRow = (label, value) => `
    <tr>
      <td style="padding:7px 0;font:700 10px/1.4 'Trebuchet MS',Tahoma,Verdana,Arial,sans-serif;letter-spacing:.08em;color:#9a9a9a;text-transform:uppercase;white-space:nowrap;vertical-align:top;width:92px;">${label}</td>
      <td style="padding:7px 0;font:600 13.5px/1.4 'Trebuchet MS',Tahoma,Verdana,Arial,sans-serif;color:#1a1a1a;">${escapeHtml(value)}</td>
    </tr>`;

  // The one row that needs an actual link rather than plain escaped text
  // (a virtual event's meeting link) -- kept separate from metaRow above
  // so every other row stays on the "always escapeHtml the value" path by
  // default, and only this one deliberately opts into raw HTML, built
  // entirely from an already-escaped, already-validated (isValidMeetingLink
  // in normalize.js restricts this to http(s) URLs before it's ever
  // stored) href.
  const metaRowHtml = (label, html) => `
    <tr>
      <td style="padding:7px 0;font:700 10px/1.4 'Trebuchet MS',Tahoma,Verdana,Arial,sans-serif;letter-spacing:.08em;color:#9a9a9a;text-transform:uppercase;white-space:nowrap;vertical-align:top;width:92px;">${label}</td>
      <td style="padding:7px 0;font:600 13.5px/1.4 'Trebuchet MS',Tahoma,Verdana,Arial,sans-serif;color:#1a1a1a;">${html}</td>
    </tr>`;

  const whereHtml = locationType === 'VIRTUAL'
    ? `<a href="${escapeHtml(meetingLink)}" style="color:${BRAND.accent};">${escapeHtml(meetingLink)}</a>`
    : escapeHtml(address || '');

  const perforation = `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:22px 0;">
      <tr>
        <td width="16" style="padding:0;line-height:0;"><div style="width:16px;height:16px;border-radius:50%;background:${pageBg};"></div></td>
        <td style="padding:0;border-top:2px dashed ${divider};font-size:0;line-height:0;">&nbsp;</td>
        <td width="16" style="padding:0;line-height:0;"><div style="width:16px;height:16px;border-radius:50%;background:${pageBg};"></div></td>
      </tr>
    </table>`;

  const html = `<!doctype html>
<html><body style="margin:0;padding:24px;background:${pageBg};font-family:'Trebuchet MS',Tahoma,Verdana,Arial,sans-serif;">
  <div style="max-width:440px;margin:0 auto;">
    <div style="max-width:440px;margin:0 auto;background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.15);">
      <div style="height:6px;background:${BRAND.accent};"></div>
      <div style="padding:26px 30px 0;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
          <tr>
            <td style="font:700 10px/1 'Trebuchet MS',Tahoma,Verdana,Arial,sans-serif;letter-spacing:.1em;color:#9a9a9a;text-transform:uppercase;">ICT Authority · Attendance</td>
            <td style="text-align:right;font:700 10px/1 'Courier New',monospace;letter-spacing:.05em;color:#9a9a9a;">REF ${refCode}</td>
          </tr>
        </table>
        <p style="margin:20px 0 4px;font:700 11px/1 'Trebuchet MS',Tahoma,Verdana,Arial,sans-serif;letter-spacing:.1em;color:${BRAND.accent};text-transform:uppercase;">&#10003; Attendance recorded</p>
        <h1 style="margin:6px 0 10px;font-size:21px;color:#1a1a1a;">Hi ${escapeHtml(name) || 'there'},</h1>
        <p style="margin:0;font-size:13.5px;line-height:1.55;color:#555;">Your sign-in has been received and stored on the official attendance sheet for the event below.</p>
      </div>

      <div style="padding:0 30px;">
        ${perforation}
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
          ${metaRow('Event', eventName)}
          ${metaRow('When', formatEventWhen(startAt, endAt, timezone))}
          ${metaRowHtml('Where', whereHtml)}
          ${eventDescription ? metaRow('About', eventDescription) : ''}
          ${metaRow('County', county)}
        </table>
        ${perforation}
      </div>

      <div style="padding:0 30px 26px;text-align:center;">
        <div style="height:26px;border-radius:2px;background-image:repeating-linear-gradient(90deg,#1a1a1a,#1a1a1a 2px,transparent 2px,transparent 5px);opacity:.82;"></div>
        <p style="margin:10px 0 0;font:700 12.5px/1 'Courier New',monospace;letter-spacing:.2em;color:#1a1a1a;">${refCode}</p>
        <p style="margin:6px 0 0;font-size:10.5px;color:#aaa;">Recorded ${formatRecordedAt(recordedAt)}</p>
      </div>
    </div>

    <p style="margin:18px 8px 0;font-size:11px;line-height:1.6;color:#888;">Didn't check in for this event? No action is needed — you can ignore this email. Spotted a typo in your entry? Return to the device and browser you signed in on and tap Edit next to your row; this record can't be edited from email.</p>
    <p style="margin:14px 8px 0;font-size:11px;color:#999;">© 2026 Asya Hafidh. All rights reserved.</p>
  </div>
</body></html>`;

  await sendViaBrevo({ to: toEmail, subject: `You're on record — ${eventName}`, html });
}
