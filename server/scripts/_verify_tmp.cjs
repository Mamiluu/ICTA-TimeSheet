const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
(async () => {
  const event = await prisma.event.findFirst({ where: { name: 'ICT Authority Workshop Talk' } });
  console.log('Event:', event);
  const rows = await prisma.attendance.findMany({ where: { eventId: event.id }, orderBy: { createdAt: 'asc' }, take: 3 });
  console.log('Sample rows:', JSON.stringify(rows.map(r => ({ name: r.name, phone: r.phone, email: r.email, createdAt: r.createdAt, isImportedSignature: r.isImportedSignature, sigPreview: r.signature.slice(0, 60) + '...', sigLen: r.signature.length })), null, 2));
  const total = await prisma.attendance.count({ where: { eventId: event.id } });
  console.log('Total attendance rows:', total);
  const audit = await prisma.auditLog.findFirst({ where: { action: 'EVENT_ATTENDANCE_IMPORTED' }, orderBy: { createdAt: 'desc' } });
  console.log('Audit entry:', audit);
  await prisma.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
