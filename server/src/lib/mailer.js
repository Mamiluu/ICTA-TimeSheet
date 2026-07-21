// Copyright (c) 2026 Asya Hafidh <msanifuasiya@gmail.com>. All Rights Reserved.
// Proprietary and confidential. See LICENSE in the repository root.

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
