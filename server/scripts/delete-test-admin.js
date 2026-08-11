// Copyright (c) 2026 Asya Hafidh <msanifuasiya@gmail.com>. All Rights Reserved.
// Proprietary and confidential. See LICENSE in the repository root.
//
// One-off: hard-deletes a single named test admin account and its audit
// trail, so the "Delete" button's usual audit-trail protection can be
// deliberately overridden for exactly one row instead of weakened for
// everyone. Scoped tightly to one email with a role/status sanity check so
// it can never accidentally touch a real admin. Not a general-purpose
// tool -- delete this file after use.

import 'dotenv/config';
import { prisma } from '../src/lib/prisma.js';

const EMAIL = 'asiyamsanifu@gmail.com';

async function main() {
  const user = await prisma.user.findUnique({ where: { email: EMAIL } });
  if (!user) {
    console.log(`No user found with email ${EMAIL} -- nothing to do.`);
    return;
  }
  if (user.role !== 'COUNTY_ADMIN' || user.status === 'ACTIVE') {
    console.error(`Refusing to delete: role=${user.role} status=${user.status} (expected COUNTY_ADMIN, not ACTIVE).`);
    process.exitCode = 1;
    return;
  }

  const auditEntries = await prisma.auditLog.findMany({ where: { actorId: user.id } });
  console.log(`Found ${auditEntries.length} audit log entr${auditEntries.length === 1 ? 'y' : 'ies'} for ${user.email} (county ${user.county}, status ${user.status}):`);
  auditEntries.forEach((e) => console.log(`  - ${e.action} at ${e.createdAt.toISOString()}`));

  await prisma.$transaction([
    prisma.auditLog.deleteMany({ where: { actorId: user.id } }),
    prisma.user.delete({ where: { id: user.id } })
  ]);

  console.log(`Deleted user ${user.email} (id ${user.id}) and its ${auditEntries.length} audit log entr${auditEntries.length === 1 ? 'y' : 'ies'}.`);
}

main()
  .catch((err) => { console.error(err); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
