// Copyright (c) 2026 Asya Hafidh <msanifuasiya@gmail.com>. All Rights Reserved.
// Proprietary and confidential. See LICENSE in the repository root.
//
// One-off bootstrap: creates the single SUPER_ADMIN account directly with a
// password you choose, bypassing the activation-link flow -- there is no
// admin above the super admin to send them an invite. Run once per
// environment: node scripts/seed-superadmin.js <email> <password>

import 'dotenv/config';
import { prisma } from '../src/lib/prisma.js';
import { hashPassword, isPasswordAcceptable } from '../src/lib/password.js';

async function main() {
  const [, , email, password] = process.argv;
  if (!email || !password) {
    console.error('Usage: node scripts/seed-superadmin.js <email> <password>');
    process.exit(1);
  }
  if (!isPasswordAcceptable(password)) {
    console.error('Password must be 10-200 characters.');
    process.exit(1);
  }

  const passwordHash = await hashPassword(password);
  const user = await prisma.user.upsert({
    where: { email: email.trim().toLowerCase() },
    update: { passwordHash, role: 'SUPER_ADMIN', status: 'ACTIVE' },
    create: { email: email.trim().toLowerCase(), passwordHash, role: 'SUPER_ADMIN', status: 'ACTIVE' }
  });

  console.log(`Super admin ready: ${user.email} (id ${user.id})`);
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
