const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
(async () => {
  const user = await prisma.user.upsert({
    where: { email: 'belinda.nasimiyu@icta.go.ke' },
    update: { role: 'COUNTY_ADMIN', county: 'Nairobi', status: 'ACTIVE' },
    create: { email: 'belinda.nasimiyu@icta.go.ke', role: 'COUNTY_ADMIN', county: 'Nairobi', status: 'ACTIVE' }
  });
  console.log('Local test admin ready:', user.email, user.id);
  await prisma.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
