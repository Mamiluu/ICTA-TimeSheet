// Copyright (c) 2026 Asya Hafidh <msanifuasiya@gmail.com>. All Rights Reserved.
// Proprietary and confidential. See LICENSE in the repository root.

import bcrypt from 'bcryptjs';

const SALT_ROUNDS = 12;

export function hashPassword(plain) {
  return bcrypt.hash(plain, SALT_ROUNDS);
}

export function verifyPassword(plain, hash) {
  if (!hash) return Promise.resolve(false);
  return bcrypt.compare(plain, hash);
}

// Minimum bar for a government admin account: length is the strongest
// practical signal (NIST 800-63B favors length over composition rules).
export function isPasswordAcceptable(plain) {
  return typeof plain === 'string' && plain.length >= 10 && plain.length <= 200;
}
