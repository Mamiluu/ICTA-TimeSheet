// Copyright (c) 2026 Asya Hafidh <msanifuasiya@gmail.com>. All Rights Reserved.
// Proprietary and confidential. See LICENSE in the repository root.
//
// One-off bootstrap for the organisation's official top account, the platform
// admin, who creates departments and the super admin of each one. Nobody sits
// above this account to invite it, so it is created here, once per environment.
//
//   node scripts/seed-platform-admin.js <email>
//       Creates the account (or re-issues its link while it is still pending)
//       and prints a one-time activation link. Open it to choose the password.
//       Preferred: no password is ever typed on a command line.
//
//   node scripts/seed-platform-admin.js <email> <password>
//       Sets the password directly and makes the account active.

import 'dotenv/config';
import { prisma } from '../src/lib/prisma.js';
import { hashPassword, isPasswordAcceptable } from '../src/lib/password.js';
import { issueToken } from '../src/lib/tokens.js';
import { isValidEmailShape } from '../src/lib/normalize.js';

async function main() {
  const [, , rawEmail, password] = process.argv;
  const email = String(rawEmail || '').trim().toLowerCase();
  if (!isValidEmailShape(email)) {
    console.error('Usage: node scripts/seed-platform-admin.js <email> [password]');
    process.exit(1);
  }
  if (password !== undefined && !isPasswordAcceptable(password)) {
    console.error('Password must be 10-200 characters.');
    process.exit(1);
  }

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing && existing.role !== 'PLATFORM_ADMIN') {
    console.error(`${email} is already a ${existing.role}. Use a different email for the platform admin.`);
    process.exit(1);
  }

  if (password !== undefined) {
    const passwordHash = await hashPassword(password);
    const user = await prisma.user.upsert({
      where: { email },
      update: { passwordHash, status: 'ACTIVE' },
      create: { email, passwordHash, role: 'PLATFORM_ADMIN', status: 'ACTIVE' }
    });
    console.log(`Platform admin ready: ${user.email} (id ${user.id})`);
    return;
  }

  if (existing && existing.status === 'ACTIVE') {
    console.log(`${email} is already an active platform admin. If the password is lost, use "Forgot password" on the login page.`);
    return;
  }

  const user = existing || (await prisma.user.create({ data: { email, role: 'PLATFORM_ADMIN', status: 'PENDING' } }));
  const raw = await issueToken(user.id, 'ACTIVATION');
  const base = process.env.PUBLIC_APP_URL || 'http://localhost:3000';
  console.log(`Platform admin created: ${user.email} (id ${user.id})`);
  console.log('Open this link once, within 48 hours, to choose the password:');
  console.log(`${base}/activate.html?token=${encodeURIComponent(raw)}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
