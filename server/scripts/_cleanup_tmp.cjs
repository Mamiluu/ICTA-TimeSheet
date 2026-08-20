const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
(async () => {
  const event = await prisma.event.findFirst({ where: { name: 'ICT Authority Workshop Talk' } });
  if (event) {
    await prisma.attendance.deleteMany({ where: { eventId: event.id } });
    await prisma.event.delete({ where: { id: event.id } });
    console.log('Removed test event + attendance rows.');
  }
  await prisma.auditLog.deleteMany({ where: { action: 'EVENT_ATTENDANCE_IMPORTED' } });
  await prisma.user.deleteMany({ where: { email: 'belinda.nasimiyu@icta.go.ke' } });
  console.log('Removed test admin + audit entries.');
  await prisma.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
