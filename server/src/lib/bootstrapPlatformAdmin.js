// Copyright (c) 2026 Asya Hafidh <msanifuasiya@gmail.com>. All Rights Reserved.
// Proprietary and confidential. See LICENSE in the repository root.

import { prisma } from './prisma.js';
import { hashPassword, isPasswordAcceptable } from './password.js';
import { isValidEmailShape } from './normalize.js';
import { logger } from './logger.js';

// For hosts with no terminal. When PLATFORM_ADMIN_EMAIL and
// PLATFORM_ADMIN_PASSWORD are set and that account does not exist yet, it is
// created as an active platform admin on start-up. It never changes an account
// that already exists, so leaving the variables in place is harmless, but the
// password variable should be deleted once the first login has worked.
export async function bootstrapPlatformAdmin() {
  const email = String(process.env.PLATFORM_ADMIN_EMAIL || '').trim().toLowerCase();
  const password = process.env.PLATFORM_ADMIN_PASSWORD;
  if (!email || !password) return;
  if (!isValidEmailShape(email) || !isPasswordAcceptable(password)) {
    logger.error('platform admin bootstrap skipped: invalid email, or password not 10-200 characters');
    return;
  }
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    if (existing.role !== 'PLATFORM_ADMIN') logger.error('platform admin bootstrap skipped: that email already belongs to another role');
    return;
  }
  await prisma.user.create({ data: { email, passwordHash: await hashPassword(password), role: 'PLATFORM_ADMIN', status: 'ACTIVE' } });
  logger.info('platform admin created from environment', { email });
}
