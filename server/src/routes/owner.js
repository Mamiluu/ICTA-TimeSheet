// Copyright (c) 2026 Asya Hafidh <msanifuasiya@gmail.com>. All Rights Reserved.
// Proprietary and confidential. See LICENSE in the repository root.

import { Router } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { requireRole } from '../middleware/auth.js';
import { issueToken } from '../lib/tokens.js';
import { sendActivationEmail } from '../lib/mailer.js';
import { writeAudit } from '../lib/audit.js';
import { isValidEmailShape } from '../lib/normalize.js';
import { ah } from '../lib/asyncHandler.js';
import { logger } from '../lib/logger.js';
import { cleanOrgName, cleanShortName, isValidOrgSlug, orgSlug } from '../lib/organisations.js';

// The platform owner's console. It answers "who is using the platform and is it
// healthy": organisations, counts, activity. Deliberately nothing here returns an
// attendee's name, phone, signature, or any event content -- the owner runs the
// platform, they do not read their customers' records.
export const ownerRouter = Router();
ownerRouter.use(requireRole('OWNER'));

function activationUrl(raw) {
  return `${process.env.PUBLIC_APP_URL}/activate.html?token=${encodeURIComponent(raw)}`;
}

function isUnique(err) {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

ownerRouter.get('/organisations', ah(async (req, res) => {
  const [orgs, departments, users, events, attendance, activity, logins] = await Promise.all([
    prisma.organisation.findMany({ orderBy: { createdAt: 'asc' } }),
    prisma.department.groupBy({ by: ['organisationId'], _count: { _all: true } }),
    prisma.user.groupBy({ by: ['organisationId', 'role', 'status'], where: { organisationId: { not: null } }, _count: { _all: true } }),
    prisma.event.groupBy({ by: ['organisationId'], where: { deletedAt: null }, _count: { _all: true } }),
    prisma.$queryRaw`SELECT e."organisationId" AS "organisationId", COUNT(a.*)::int AS n FROM "Attendance" a JOIN "Event" e ON e."id" = a."eventId" GROUP BY e."organisationId"`,
    prisma.auditLog.groupBy({ by: ['organisationId'], where: { organisationId: { not: null } }, _max: { createdAt: true } }),
    prisma.user.groupBy({ by: ['organisationId'], where: { organisationId: { not: null } }, _max: { lastLoginAt: true } })
  ]);

  const by = (rows, id, pick) => (rows.find((r) => r.organisationId === id) ? pick(rows.find((r) => r.organisationId === id)) : null);
  res.json({
    ok: true,
    organisations: orgs.map((o) => {
      const mine = users.filter((u) => u.organisationId === o.id);
      const count = (role, status) => mine.filter((u) => u.role === role && (!status || u.status === status)).reduce((n, u) => n + u._count._all, 0);
      return {
        id: o.id,
        name: o.name,
        shortName: o.shortName,
        slug: o.slug,
        status: o.status,
        plan: o.plan,
        createdAt: o.createdAt,
        departments: by(departments, o.id, (r) => r._count._all) || 0,
        orgAdmins: count('PLATFORM_ADMIN'),
        orgAdminsActive: count('PLATFORM_ADMIN', 'ACTIVE'),
        superAdmins: count('SUPER_ADMIN'),
        countyAdmins: count('COUNTY_ADMIN'),
        events: by(events, o.id, (r) => r._count._all) || 0,
        attendance: by(attendance, o.id, (r) => Number(r.n)) || 0,
        lastActivityAt: by(activity, o.id, (r) => r._max.createdAt),
        lastLoginAt: by(logins, o.id, (r) => r._max.lastLoginAt)
      };
    })
  });
}));

// Creates the organisation and invites its first administrator. That person then
// sets up the organisation's own departments and people.
ownerRouter.post('/organisations', ah(async (req, res) => {
  const name = cleanOrgName(req.body.name);
  if (!name) return res.status(400).json({ ok: false, error: 'INVALID_NAME', message: 'Use a name between 3 and 100 characters.' });
  const slug = String(req.body.slug || '').trim().toLowerCase() || orgSlug(name);
  if (!isValidOrgSlug(slug)) {
    return res.status(400).json({ ok: false, error: 'INVALID_SLUG', message: 'The short address must be 3 to 40 letters, numbers or single dashes, and not a reserved word.' });
  }
  const adminEmail = String(req.body.adminEmail || '').trim().toLowerCase();
  if (!isValidEmailShape(adminEmail)) return res.status(400).json({ ok: false, error: 'INVALID_EMAIL', message: 'Enter the first administrator\'s email address.' });

  let org;
  let admin;
  try {
    [org, admin] = await prisma.$transaction(async (tx) => {
      const o = await tx.organisation.create({ data: { name, slug, shortName: cleanShortName(req.body.shortName) } });
      const a = await tx.user.create({ data: { email: adminEmail, role: 'PLATFORM_ADMIN', status: 'PENDING', organisationId: o.id, createdById: req.user.id } });
      return [o, a];
    });
  } catch (err) {
    if (isUnique(err)) {
      const target = Array.isArray(err.meta?.target) ? err.meta.target.join(',') : String(err.meta?.target || '');
      if (target.includes('email')) return res.status(409).json({ ok: false, error: 'EMAIL_IN_USE', message: 'That email address is already registered.' });
      return res.status(409).json({ ok: false, error: 'ORG_EXISTS', message: 'An organisation with that name or short address already exists.' });
    }
    throw err;
  }

  const raw = await issueToken(admin.id, 'ACTIVATION');
  const url = activationUrl(raw);
  sendActivationEmail(admin.email, url, null, null, org.name).catch((err) => logger.error('sendActivationEmail failed', { toEmail: admin.email, stack: err.stack }));
  await writeAudit({ actorId: req.user.id, action: 'ORG_CREATE', targetType: 'Organisation', targetId: org.id, metadata: { name: org.name, slug: org.slug }, req });
  res.json({ ok: true, organisation: { id: org.id, name: org.name, slug: org.slug }, activationUrl: url });
}));

async function findOrg(req) {
  return prisma.organisation.findUnique({ where: { id: req.params.id } });
}

ownerRouter.post('/organisations/:id/suspend', ah(async (req, res) => {
  const org = await findOrg(req);
  if (!org) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });
  if (org.status === 'SUSPENDED') return res.status(409).json({ ok: false, error: 'ALREADY_SUSPENDED' });
  const reason = String(req.body.reason || '').replace(/\s+/g, ' ').trim().slice(0, 300);
  if (reason.length < 5) return res.status(400).json({ ok: false, error: 'REASON_REQUIRED', message: 'Say why the organisation is being suspended.' });
  await prisma.organisation.update({ where: { id: org.id }, data: { status: 'SUSPENDED' } });
  await writeAudit({ actorId: req.user.id, action: 'ORG_SUSPEND', targetType: 'Organisation', targetId: org.id, metadata: { name: org.name, reason }, req });
  res.json({ ok: true });
}));

ownerRouter.post('/organisations/:id/resume', ah(async (req, res) => {
  const org = await findOrg(req);
  if (!org) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });
  if (org.status === 'ACTIVE') return res.status(409).json({ ok: false, error: 'ALREADY_ACTIVE' });
  await prisma.organisation.update({ where: { id: org.id }, data: { status: 'ACTIVE' } });
  await writeAudit({ actorId: req.user.id, action: 'ORG_RESUME', targetType: 'Organisation', targetId: org.id, metadata: { name: org.name }, req });
  res.json({ ok: true });
}));

// For when the invitation email does not arrive: a fresh link for the organisation's
// first administrator, while they have not yet activated.
ownerRouter.post('/organisations/:id/activation-link', ah(async (req, res) => {
  const org = await findOrg(req);
  if (!org) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });
  const admin = await prisma.user.findFirst({ where: { organisationId: org.id, role: 'PLATFORM_ADMIN', status: 'PENDING' }, orderBy: { createdAt: 'asc' } });
  if (!admin) return res.status(409).json({ ok: false, error: 'NOT_PENDING', message: 'This organisation has no administrator waiting to activate.' });
  const raw = await issueToken(admin.id, 'ACTIVATION');
  await writeAudit({ actorId: req.user.id, action: 'ORG_ACTIVATION_LINK_VIEWED', targetType: 'Organisation', targetId: org.id, req });
  res.json({ ok: true, url: activationUrl(raw), email: admin.email });
}));