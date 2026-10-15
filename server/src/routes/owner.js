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
import { cleanOrgName, cleanShortName, isValidOrgSlug, orgSlug, billingState, extendPaidUntil } from '../lib/organisations.js';
import { brandFromOrg, emailBrand } from '../lib/brand.js';
import { lastAnchorAt } from '../lib/anchor.js';
import { supportState, isOpenState, cleanSupportRequest, supportAllowed } from '../lib/support.js';
import { platformRouter } from './platform.js';

// The platform owner's console. It answers "who is using the platform and is it
// healthy": organisations, counts, activity. Deliberately nothing here returns an
// attendee's name, phone, signature, or any event content -- the owner runs the
// platform, they do not read their customers' records.
export const ownerRouter = Router();
ownerRouter.use(requireRole('OWNER'));

// The page opens in the organisation's own look because the link names it.
function activationUrl(raw, slug) {
  return `${process.env.PUBLIC_APP_URL}/activate.html?token=${encodeURIComponent(raw)}&org=${encodeURIComponent(slug)}`;
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
        paidUntil: o.paidUntil,
        billing: billingState(o.paidUntil),
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
  const url = activationUrl(raw, org.slug);
  sendActivationEmail(admin.email, url, null, null, org.name, emailBrand(brandFromOrg(org))).catch((err) => logger.error('sendActivationEmail failed', { toEmail: admin.email, stack: err.stack }));
  await writeAudit({ actorId: req.user.id, action: 'ORG_CREATE', targetType: 'Organisation', targetId: org.id, metadata: { name: org.name, slug: org.slug }, req });
  res.json({ ok: true, organisation: { id: org.id, name: org.name, slug: org.slug }, activationUrl: url });
}));

// Records that an organisation has paid, for a number of whole months. Money itself is
// not handled here; this only moves the date the organisation is covered until.
ownerRouter.post('/organisations/:id/payment', ah(async (req, res) => {
  const org = await prisma.organisation.findUnique({ where: { id: req.params.id } });
  if (!org) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });
  const months = Number(req.body.months === undefined ? 1 : req.body.months);
  if (!Number.isInteger(months) || months < 1 || months > 24) return res.status(400).json({ ok: false, error: 'INVALID_MONTHS', message: 'Enter a whole number of months, from 1 to 24.' });
  const note = String(req.body.note || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  const paidUntil = extendPaidUntil(org.paidUntil, months);
  await prisma.organisation.update({ where: { id: org.id }, data: { paidUntil } });
  await writeAudit({ actorId: req.user.id, action: 'ORG_PAYMENT_RECORDED', targetType: 'Organisation', targetId: org.id, metadata: { name: org.name, months, paidUntil: paidUntil.toISOString().slice(0, 10), ...(note ? { note } : {}) }, req });
  res.json({ ok: true, paidUntil, billing: billingState(paidUntil) });
}));

// Stops billing for an organisation (for example a pilot or a free arrangement).
ownerRouter.post('/organisations/:id/billing-off', ah(async (req, res) => {
  const org = await prisma.organisation.findUnique({ where: { id: req.params.id } });
  if (!org) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });
  await prisma.organisation.update({ where: { id: org.id }, data: { paidUntil: null } });
  await writeAudit({ actorId: req.user.id, action: 'ORG_BILLING_OFF', targetType: 'Organisation', targetId: org.id, metadata: { name: org.name }, req });
  res.json({ ok: true });
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
  res.json({ ok: true, url: activationUrl(raw, org.slug), email: admin.email });
}));

// ---- Health and usage: counts only ------------------------------------------

// Whether the platform itself is well: the database answers, emails are getting out, the
// audit anchor ran, and which database migration is the latest.
ownerRouter.get('/health', ah(async (req, res) => {
  const started = Date.now();
  await prisma.$queryRaw`SELECT 1`;
  const dbMs = Date.now() - started;
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const [mail, failures, anchor, migration] = await Promise.all([
    prisma.emailDelivery.groupBy({ by: ['ok'], where: { createdAt: { gte: since } }, _count: { _all: true } }),
    prisma.emailDelivery.findMany({ where: { ok: false, createdAt: { gte: since } }, orderBy: { createdAt: 'desc' }, take: 5, select: { kind: true, organisationSlug: true, error: true, createdAt: true } }),
    lastAnchorAt(),
    prisma.$queryRaw`SELECT "migration_name" AS name, "finished_at" AS at FROM "_prisma_migrations" WHERE "finished_at" IS NOT NULL ORDER BY "finished_at" DESC LIMIT 1`
  ]);
  const sent = (mail.find((m) => m.ok) || { _count: { _all: 0 } })._count._all;
  const failed = (mail.find((m) => !m.ok) || { _count: { _all: 0 } })._count._all;
  res.json({
    ok: true,
    database: { ok: true, ms: dbMs },
    uptimeSeconds: Math.round(process.uptime()),
    node: process.version,
    emails24h: { sent, failed, recentFailures: failures },
    lastAnchorAt: anchor,
    lastMigration: migration[0] ? { name: migration[0].name, at: migration[0].at } : null
  });
}));

const WEEKS = 12;
// Twelve weekly buckets ending this week, with zeros where nothing happened.
function weekly(rows) {
  const monday = new Date();
  monday.setUTCHours(0, 0, 0, 0);
  monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
  const out = [];
  for (let i = WEEKS - 1; i >= 0; i--) {
    const d = new Date(monday.getTime() - i * 7 * 24 * 60 * 60 * 1000);
    const key = d.toISOString().slice(0, 10);
    const hit = rows.find((r) => new Date(r.w).toISOString().slice(0, 10) === key);
    out.push({ weekStart: key, count: hit ? Number(hit.n) : 0 });
  }
  return out;
}

ownerRouter.get('/organisations/:id/usage', ah(async (req, res) => {
  const org = await findOrg(req);
  if (!org) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });
  const id = org.id;
  const [events, signatures, logins, active, storage, people] = await Promise.all([
    prisma.$queryRaw`SELECT date_trunc('week', "createdAt") AS w, COUNT(*)::int AS n FROM "Event" WHERE "organisationId" = ${id} AND "createdAt" >= now() - interval '12 weeks' GROUP BY 1`,
    prisma.$queryRaw`SELECT date_trunc('week', s."signedAt") AS w, COUNT(*)::int AS n FROM "SessionSignature" s JOIN "EventDay" d ON d."id" = s."dayId" JOIN "Event" e ON e."id" = d."eventId" WHERE e."organisationId" = ${id} AND s."signedAt" >= now() - interval '12 weeks' GROUP BY 1`,
    prisma.$queryRaw`SELECT date_trunc('week', "createdAt") AS w, COUNT(*)::int AS n FROM "AuditLog" WHERE "organisationId" = ${id} AND "action" = 'LOGIN' AND "createdAt" >= now() - interval '12 weeks' GROUP BY 1`,
    prisma.$queryRaw`SELECT COUNT(DISTINCT "actorId")::int AS n FROM "AuditLog" WHERE "organisationId" = ${id} AND "action" = 'LOGIN' AND "createdAt" >= now() - interval '30 days'`,
    prisma.$queryRaw`SELECT COALESCE(SUM(length(s."signature")), 0)::float8 AS bytes FROM "SessionSignature" s JOIN "EventDay" d ON d."id" = s."dayId" JOIN "Event" e ON e."id" = d."eventId" WHERE e."organisationId" = ${id}`,
    prisma.user.count({ where: { organisationId: id, status: { not: 'DISABLED' } } })
  ]);
  res.json({
    ok: true,
    organisation: { id: org.id, name: org.name, slug: org.slug, status: org.status, plan: org.plan, createdAt: org.createdAt, paidUntil: org.paidUntil, billing: billingState(org.paidUntil) },
    weeks: { events: weekly(events), signatures: weekly(signatures), logins: weekly(logins) },
    activeUsers30d: active[0] ? Number(active[0].n) : 0,
    accounts: people,
    signatureDataMb: Math.round((Number(storage[0].bytes) / (1024 * 1024)) * 10) / 10
  });
}));

// ---- Support access: only ever with the organisation's permission -------------

function grantView(g) {
  return { id: g.id, reason: g.reason, hours: g.hours, state: supportState(g), requestedBy: g.requestedByEmail, requestedAt: g.createdAt, decidedBy: g.decidedByEmail, decidedAt: g.decidedAt, expiresAt: g.expiresAt };
}

ownerRouter.get('/organisations/:id/support', ah(async (req, res) => {
  const org = await findOrg(req);
  if (!org) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });
  const grants = await prisma.supportAccess.findMany({ where: { organisationId: org.id }, orderBy: { createdAt: 'desc' }, take: 20 });
  const views = grants.map(grantView);
  res.json({ ok: true, grants: views, open: views.find((g) => isOpenState(g.state)) || null });
}));

// Asks the organisation's administrator for a limited look. Nothing opens until they agree.
ownerRouter.post('/organisations/:id/support', ah(async (req, res) => {
  const org = await findOrg(req);
  if (!org) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });
  const parsed = cleanSupportRequest(req.body);
  if (parsed.error) return res.status(400).json({ ok: false, error: 'INVALID_REQUEST', message: parsed.error });
  const recent = await prisma.supportAccess.findMany({ where: { organisationId: org.id }, orderBy: { createdAt: 'desc' }, take: 10 });
  if (recent.some((g) => isOpenState(supportState(g)))) {
    return res.status(409).json({ ok: false, error: 'ALREADY_OPEN', message: 'There is already a request waiting or running for this organisation.' });
  }
  const grant = await prisma.supportAccess.create({ data: { organisationId: org.id, requestedById: req.user.id, requestedByEmail: req.user.email, reason: parsed.value.reason, hours: parsed.value.hours } });
  // Written into the organisation's own trail, so they can see it was asked for.
  await writeAudit({ actorId: req.user.id, action: 'SUPPORT_REQUESTED', targetType: 'Organisation', targetId: org.id, metadata: { reason: parsed.value.reason, hours: parsed.value.hours }, req, organisationId: org.id });
  res.json({ ok: true, grant: grantView(grant) });
}));

// The owner withdraws a request, or ends a session early.
ownerRouter.post('/organisations/:id/support/:gid/end', ah(async (req, res) => {
  const grant = await prisma.supportAccess.findFirst({ where: { id: req.params.gid, organisationId: req.params.id } });
  if (!grant || !isOpenState(supportState(grant))) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });
  await prisma.supportAccess.update({ where: { id: grant.id }, data: { status: 'REVOKED', endedAt: new Date() } });
  await writeAudit({ actorId: req.user.id, action: 'SUPPORT_ENDED', targetType: 'Organisation', targetId: grant.organisationId, metadata: { by: 'owner' }, req, organisationId: grant.organisationId });
  res.json({ ok: true });
}));

// The support view: the organisation administrator's own read-only pages for one organisation,
// and only while that organisation has an approved, unexpired grant. Every page opened is
// written to the organisation's audit trail.
async function supportGate(req, res, next) {
  const org = await prisma.organisation.findUnique({ where: { id: req.params.orgId } });
  if (!org) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });
  if (!supportAllowed(req.method, req.path)) return res.status(403).json({ ok: false, error: 'READ_ONLY', message: 'The support view is read-only and only covers the overview pages.' });
  const grant = await prisma.supportAccess.findFirst({ where: { organisationId: org.id, status: 'APPROVED', expiresAt: { gt: new Date() } }, orderBy: { decidedAt: 'desc' } });
  if (!grant) return res.status(403).json({ ok: false, error: 'NO_SUPPORT_ACCESS', message: 'This organisation has not approved support access, or the approval has run out.' });
  await writeAudit({ actorId: req.user.id, action: 'SUPPORT_VIEWED', targetType: 'Organisation', targetId: org.id, metadata: { page: req.path }, req, organisationId: org.id });
  // From here the request is answered exactly as it would be for that organisation's administrator.
  req.user = { id: req.user.id, email: req.user.email, role: 'PLATFORM_ADMIN', status: 'ACTIVE', organisationId: org.id, organisation: org, departmentId: null };
  next();
}
ownerRouter.use('/support/:orgId', supportGate, (req, res, next) => platformRouter(req, res, next));
