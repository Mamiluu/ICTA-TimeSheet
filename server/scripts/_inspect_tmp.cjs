const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
(async () => {
  const user = await prisma.user.findUnique({ where: { email: 'belinda.nasimiyu@icta.go.ke' } });
  console.log('User:', user);
  if (user) {
    const events = await prisma.event.findMany({ where: { ownerId: user.id } });
    console.log('Existing events for this admin:', events.map(e => ({ id: e.id, slug: e.slug, name: e.name, date: e.date })));
  }
  await prisma.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
