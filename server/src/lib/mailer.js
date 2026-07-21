// Copyright (c) 2026 Asya Hafidh <msanifuasiya@gmail.com>. All Rights Reserved.
// Proprietary and confidential. See LICENSE in the repository root.

import nodemailer from 'nodemailer';
import dns from 'node:dns';
import { promisify } from 'node:util';

const lookup4 = promisify(dns.lookup);

const SMTP_HOST = 'smtp.gmail.com';
const SMTP_PORT = 465;

// nodemailer >=7 resolves the SMTP hostname itself (lib/shared/index.js
// resolveHostname) and picks a *random* address out of the combined
// A+AAAA record set -- the transport's `family` option is never consulted
// there, it only reaches net.connect/tls.connect, which is a no-op once
// the host has already been replaced with a literal IP. So on a host with
// no outbound IPv6 route (Render's free tier included), roughly half of
// all connection attempts picked smtp.gmail.com's AAAA record and failed
// with ENETUNREACH -- intermittently, since it depends on which address
// nodemailer's RNG picked that time.
//
// Resolving to a literal IPv4 address ourselves sidesteps nodemailer's
// resolver entirely: it only resolves hostnames, and skips straight
// through when `host` is already an IP (see the net.isIP check at the top
// of resolveHostname). `tls.servername` keeps SNI and certificate
// hostname validation pointed at the real name. Resolved fresh per call
// (not cached) since Google rotates these addresses.
async function createTransporter() {
  const { address } = await lookup4(SMTP_HOST, { family: 4 });
  return nodemailer.createTransport({
    host: address,
    port: SMTP_PORT,
    secure: true,
    tls: { servername: SMTP_HOST },
    auth: {
      user: process.env.GMAIL_SENDER_ADDRESS,
      pass: process.env.GMAIL_APP_PASSWORD
    }
  });
}

const BRAND = {
  from: () => `"ICT Authority — Event Attendance" <${process.env.GMAIL_SENDER_ADDRESS}>`,
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

// Local/dev convenience: when GMAIL_APP_PASSWORD isn't configured for real
// SMTP delivery (e.g. running against a scratch DB with no mail account
// set up yet), print the link instead of only logging a send failure --
// lets the activation/reset flow be exercised end-to-end without email.
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
  const transporter = await createTransporter();
  await transporter.sendMail({
    from: BRAND.from(),
    to: toEmail,
    subject: 'Activate your ICT Authority admin account',
    html
  });
}

export async function sendPasswordResetEmail(toEmail, resetUrl) {
  devLogLink(`password reset link for ${toEmail}`, resetUrl);
  const html = wrapHtml(`
    <p style="font-size:13.5px;color:#333;">A password reset was requested for this account. Click below to set a new password. This link can only be used once and expires in 1 hour.</p>
    <p style="margin:22px 0;"><a href="${resetUrl}" style="background:${BRAND.accent};color:#fff;padding:11px 20px;border-radius:6px;text-decoration:none;font-weight:600;font-size:13px;">Reset your password</a></p>
    <p style="font-size:11.5px;color:#888;">If you didn't request this, you can safely ignore this email — your password will not change.</p>
    <p style="font-size:11.5px;color:#888;">If the button doesn't work, copy this link: ${resetUrl}</p>
  `);
  const transporter = await createTransporter();
  await transporter.sendMail({
    from: BRAND.from(),
    to: toEmail,
    subject: 'Reset your ICT Authority admin password',
    html
  });
}
