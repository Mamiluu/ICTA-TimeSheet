// Copyright (c) 2026 Asya Hafidh <msanifuasiya@gmail.com>. All Rights Reserved.
// Proprietary and confidential. See LICENSE in the repository root.

import { cleanOrgName } from './organisations.js';
import { isValidEmailShape } from './normalize.js';

export const REQUEST_VERIFY_HOURS = 48;

function text(v, max) {
  return String(v ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

// What someone asking to add their organisation sends. Returns { value }, { error } or, when a
// hidden field that real people never fill in has been filled in, { bot: true }.
export function cleanSignup(body) {
  if (text(body.website, 100)) return { bot: true };

  const organisationName = cleanOrgName(body.organisationName);
  if (!organisationName) return { error: 'Enter the name of your organisation (3 to 100 characters).' };

  const contactName = text(body.contactName, 80);
  if (contactName.length < 2) return { error: 'Enter your name.' };

  const contactEmail = text(body.contactEmail, 120).toLowerCase();
  if (!isValidEmailShape(contactEmail)) return { error: 'Enter a valid email address. We send a confirmation link to it.' };

  const phone = text(body.phone, 30);
  if (phone && !/^[0-9+()\-./ ]+$/.test(phone)) return { error: 'The phone number can only have digits, spaces and + ( ) - . /.' };

  const message = text(body.message, 500);
  return { value: { organisationName, contactName, contactEmail, phone: phone || null, message: message || null } };
}

// What the owner is told about a confirmation email: sent, failed (with the reason) or not known. An
// address inside an error message is taken out, so the reason can be shown without exposing it.
export function safeEmailError(message) {
  return String(message || 'failed').replace(/[\w.+-]+@[\w.-]+/g, '[address]').slice(0, 200);
}

export function emailStateOf(request) {
  if (request.verifyEmailError) return { state: 'FAILED', error: request.verifyEmailError };
  if (request.verifyEmailSentAt) return { state: 'SENT', error: null };
  return { state: 'UNKNOWN', error: null };
}

// A confirmation link works for two days from when it was sent.
export function verifyLinkExpired(createdAt, now = Date.now()) {
  return now - new Date(createdAt).getTime() > REQUEST_VERIFY_HOURS * 60 * 60 * 1000;
}