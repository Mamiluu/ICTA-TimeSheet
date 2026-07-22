// Copyright (c) 2026 Asya Hafidh <msanifuasiya@gmail.com>. All Rights Reserved.
// Proprietary and confidential. See LICENSE in the repository root.

// All 47 Kenyan counties, selectable when a super admin assigns a county
// admin. The MAX_ACTIVE_COUNTY_ADMINS cap (14, the pilot phase size) limits
// how many of these can have an active admin at once -- it does not
// restrict which specific counties may be chosen.
export const KENYA_COUNTIES = [
  'Mombasa', 'Kwale', 'Kilifi', 'Tana River', 'Lamu', 'Taita-Taveta',
  'Garissa', 'Wajir', 'Mandera', 'Marsabit', 'Isiolo', 'Meru',
  'Tharaka-Nithi', 'Embu', 'Kitui', 'Machakos', 'Makueni', 'Nyandarua',
  'Nyeri', 'Kirinyaga', 'Murang\'a', 'Kiambu', 'Turkana', 'West Pokot',
  'Samburu', 'Trans Nzoia', 'Uasin Gishu', 'Elgeyo-Marakwet', 'Nandi',
  'Baringo', 'Laikipia', 'Nakuru', 'Narok', 'Kajiado', 'Kericho',
  'Bomet', 'Kakamega', 'Vihiga', 'Bungoma', 'Busia', 'Siaya', 'Kisumu',
  'Homa Bay', 'Migori', 'Kisii', 'Nyamira', 'Nairobi'
];

export const MAX_ACTIVE_COUNTY_ADMINS = 14;

// Pilot-phase ceiling on how many people can sign in to a single event's
// attendance sheet. Raise (or remove) once the pilot graduates to general
// availability.
export const MAX_ATTENDANCE_PER_EVENT = 500;

export const ACTIVATION_TOKEN_TTL_MS = 48 * 60 * 60 * 1000; // 48h to activate
export const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1h to reset password
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12h sliding session

export const SESSION_COOKIE_NAME = 'icta_session';
