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
  // The organisation this account heads. ICT Authority unless told otherwise.
  const slug = String(process.env.PLATFORM_ADMIN_ORG || 'icta').trim().toLowerCase();
  const org = await prisma.organisation.findUnique({ where: { slug } });
  if (!org) {
    logger.error('platform admin bootstrap skipped: no organisation with that short address', { slug });
    return;
  }
  await prisma.user.create({ data: { email, passwordHash: await hashPassword(password), role: 'PLATFORM_ADMIN', status: 'ACTIVE', organisationId: org.id } });
  logger.info('platform admin created from environment', { email, organisation: org.slug });
}

// The platform owner: the operator above every organisation. Created the same way,
// from OWNER_EMAIL and OWNER_PASSWORD, and never changed once it exists.
export async function bootstrapOwner() {
  const email = String(process.env.OWNER_EMAIL || '').trim().toLowerCase();
  const password = process.env.OWNER_PASSWORD;
  if (!email || !password) return;
  if (!isValidEmailShape(email) || !isPasswordAcceptable(password)) {
    logger.error('owner bootstrap skipped: invalid email, or password not 10-200 characters');
    return;
  }
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    if (existing.role !== 'OWNER') logger.error('owner bootstrap skipped: that email already belongs to another role');
    return;
  }
  await prisma.user.create({ data: { email, passwordHash: await hashPassword(password), role: 'OWNER', status: 'ACTIVE' } });
  logger.info('owner created from environment', { email });
}
