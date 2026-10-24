// Copyright (c) 2026 Asya Hafidh <msanifuasiya@gmail.com>. All Rights Reserved.
// Proprietary and confidential. See LICENSE in the repository root.

import express, { Router } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { requireRole } from '../middleware/auth.js';
import { issueToken } from '../lib/tokens.js';
import { destroyAllSessionsForUser } from '../lib/session.js';
import { sendActivationEmail } from '../lib/mailer.js';
import { writeAudit } from '../lib/audit.js';
import { isValidEmailShape } from '../lib/normalize.js';
import { ah } from '../lib/asyncHandler.js';
import { logger } from '../lib/logger.js';
import { pagedAudit } from '../lib/auditPage.js';
import { bucketByDay } from '../lib/analytics.js';
import { cleanBranding } from '../lib/brandInput.js';
import { brandFromOrg, brandForOrgId, emailBrand, invalidateBrandCache } from '../lib/brand.js';
import { detectImage, MAX_LOGO_BYTES } from '../lib/imageSniff.js';
import { supportState } from '../lib/support.js';
import { baseUrlFor } from '../lib/tenantHost.js';
import { adminSeatRefusal, adminSeatsUsed, eventsThisMonth, orgPlanFor } from '../lib/orgPlan.js';
import { MODULES } from '../lib/plans.js';
import { chainHead, lastAnchorAt, sendAnchor, checkAnchor } from '../lib/anchor.js';
import { DEFAULT_DEPARTMENTS, MAX_SUPER_ADMINS_PER_DEPARTMENT, cleanDepartmentName, departmentSlug } from '../lib/departments.js';

// The platform admin runs the organisation-wide account: departments and the
// super admin of each. It deliberately has no route that returns attendee
// names, phones or signatures -- only counts and account details.
export const platformRouter = Router();
platformRouter.use(requireRole('PLATFORM_ADMIN'));

function publicSuperAdmin(u) {
  return {
    id: u.id,
    email: u.email,
    status: u.status,
    departmentId: u.departmentId,
    department: u.department ? { id: u.department.id, name: u.department.name } : null,
    createdAt: u.createdAt,
    disabledAt: u.disabledAt,
    lastLoginAt: u.lastLoginAt
  };
}

function activationUrl(raw, org) {
  return `${baseUrlFor(org)}/activate.html?token=${encodeURIComponent(raw)}&org=${encodeURIComponent(org.slug)}`;
}

function sendActivationBestEffort(user, url, departmentName) {
  brandForOrgId(user.organisationId)
    .then((brand) => sendActivationEmail(user.email, url, null, departmentName, null, emailBrand(brand))).catch((err) => {
    logger.error('sendActivationEmail failed', { toEmail: user.email, stack: err.stack });
  });
}

function isUniqueViolation(err) {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

// Only an account in the caller's own organisation can be found at all.
async function findSuperAdmin(req) {
  return prisma.user.findFirst({ where: { id: req.params.id, role: 'SUPER_ADMIN', organisationId: req.user.organisationId }, include: { department: true } });
}

// Organisation-wide rollup. Aggregate counts only, per department and overall --
// never a name, phone, email or signature of an attendee.
platformRouter.get('/overview', ah(async (req, res) => {
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const [departments, events, accounts] = await Promise.all([
    prisma.department.findMany({ where: { organisationId: req.user.organisationId }, orderBy: { name: 'asc' } }),
    prisma.event.findMany({ where: { organisationId: req.user.organisationId, deletedAt: null }, select: { id: true, departmentId: true } }),
    prisma.user.groupBy({ by: ['role', 'status'], where: { organisationId: req.user.organisationId, role: { in: ['SUPER_ADMIN', 'COUNTY_ADMIN'] } }, _count: { _all: true } })
  ]);
  const ids = events.map((e) => e.id);
  const [perEvent, recent] = await Promise.all([
    prisma.attendance.groupBy({ by: ['eventId'], where: { eventId: { in: ids } }, _count: { _all: true } }),
    prisma.attendance.findMany({ where: { eventId: { in: ids }, createdAt: { gte: since } }, select: { createdAt: true } })
  ]);

  const attendanceOf = new Map(perEvent.map((g) => [g.eventId, g._count._all]));
  const rows = new Map(departments.map((d) => [d.id, { id: d.id, name: d.name, active: d.active, events: 0, attendance: 0 }]));
  for (const ev of events) {
    const row = rows.get(ev.departmentId);
    if (!row) continue;
    row.events += 1;
    row.attendance += attendanceOf.get(ev.id) || 0;
  }
  const n = (role, status) => accounts.filter((g) => g.role === role && (!status || g.status === status)).reduce((s, g) => s + g._count._all, 0);

  res.json({
    ok: true,
    totals: {
      departments: departments.length,
      activeDepartments: departments.filter((d) => d.active).length,
      events: events.length,
      attendance: [...attendanceOf.values()].reduce((a, b) => a + b, 0),
      superAdmins: n('SUPER_ADMIN'),
      activeSuperAdmins: n('SUPER_ADMIN', 'ACTIVE'),
      pendingSuperAdmins: n('SUPER_ADMIN', 'PENDING'),
      countyAdmins: n('COUNTY_ADMIN'),
      activeCountyAdmins: n('COUNTY_ADMIN', 'ACTIVE')
    },
    byDepartment: [...rows.values()].sort((a, b) => b.attendance - a.attendance || a.name.localeCompare(b.name)),
    trend: bucketByDay(recent.map((r) => r.createdAt), 30)
  });
}));

// ---- Departments -----------------------------------------------------------

platformRouter.get('/departments', ah(async (req, res) => {
  const org = req.user.organisationId;
  const [departments, admins, events] = await Promise.all([
    prisma.department.findMany({ where: { organisationId: org }, orderBy: { name: 'asc' } }),
    prisma.user.groupBy({ by: ['departmentId', 'role', 'status'], where: { organisationId: org, departmentId: { not: null } }, _count: { _all: true } }),
    prisma.event.groupBy({ by: ['departmentId'], where: { organisationId: org, departmentId: { not: null }, deletedAt: null }, _count: { _all: true } })
  ]);

  const eventsBy = new Map(events.map((g) => [g.departmentId, g._count._all]));
  const rows = departments.map((d) => {
    const mine = admins.filter((g) => g.departmentId === d.id);
    const count = (role, status) => mine.filter((g) => g.role === role && (!status || g.status === status)).reduce((n, g) => n + g._count._all, 0);
    return {
      id: d.id,
      name: d.name,
      slug: d.slug,
      active: d.active,
      createdAt: d.createdAt,
      superAdmins: count('SUPER_ADMIN'),
      activeSuperAdmins: count('SUPER_ADMIN', 'ACTIVE'),
      countyAdmins: count('COUNTY_ADMIN'),
      events: eventsBy.get(d.id) || 0
    };
  });

  res.json({ ok: true, departments: rows, maxSuperAdmins: MAX_SUPER_ADMINS_PER_DEPARTMENT });
}));

platformRouter.post('/departments', ah(async (req, res) => {
  const name = cleanDepartmentName(req.body.name);
  if (!name) return res.status(400).json({ ok: false, error: 'INVALID_NAME' });

  let dept;
  try {
    dept = await prisma.department.create({ data: { organisationId: req.user.organisationId, name, slug: departmentSlug(name) } });
  } catch (err) {
    if (isUniqueViolation(err)) return res.status(409).json({ ok: false, error: 'DEPARTMENT_EXISTS' });
    throw err;
  }
  await writeAudit({ actorId: req.user.id, action: 'DEPARTMENT_CREATE', targetType: 'Department', targetId: dept.id, metadata: { name }, req });
  res.json({ ok: true, department: dept });
}));

// Adds whichever of the standard departments are missing. Safe to repeat.
platformRouter.post('/departments/seed-defaults', ah(async (req, res) => {
  const existing = await prisma.department.findMany({ where: { organisationId: req.user.organisationId }, select: { name: true, slug: true } });
  const taken = new Set(existing.flatMap((d) => [d.name.toLowerCase(), d.slug]));
  const created = [];
  for (const name of DEFAULT_DEPARTMENTS) {
    if (taken.has(name.toLowerCase()) || taken.has(departmentSlug(name))) continue;
    const dept = await prisma.department.create({ data: { organisationId: req.user.organisationId, name, slug: departmentSlug(name) } });
    created.push(dept.name);
  }
  if (created.length) {
    await writeAudit({ actorId: req.user.id, action: 'DEPARTMENT_SEED', targetType: 'Department', metadata: { created }, req });
  }
  res.json({ ok: true, created });
}));

// Rename and/or pause/resume. Pausing needs no session sweep: loadSessionUser
// refuses sessions of a paused department, so everyone in it is signed out on
// their next request, and the platform admin can resume at any time.
platformRouter.patch('/departments/:id', ah(async (req, res) => {
  const dept = await prisma.department.findFirst({ where: { id: req.params.id, organisationId: req.user.organisationId } });
  if (!dept) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });

  const data = {};
  if (req.body.name !== undefined) {
    const name = cleanDepartmentName(req.body.name);
    if (!name) return res.status(400).json({ ok: false, error: 'INVALID_NAME' });
    data.name = name;
    data.slug = departmentSlug(name);
  }
  if (req.body.active !== undefined) {
    if (typeof req.body.active !== 'boolean') return res.status(400).json({ ok: false, error: 'INVALID_ACTIVE' });
    data.active = req.body.active;
  }
  if (!Object.keys(data).length) return res.status(400).json({ ok: false, error: 'NOTHING_TO_UPDATE' });

  let updated;
  try {
    updated = await prisma.department.update({ where: { id: dept.id }, data });
  } catch (err) {
    if (isUniqueViolation(err)) return res.status(409).json({ ok: false, error: 'DEPARTMENT_EXISTS' });
    throw err;
  }

  if (data.name && data.name !== dept.name) {
    await writeAudit({ actorId: req.user.id, action: 'DEPARTMENT_RENAME', targetType: 'Department', targetId: dept.id, metadata: { from: dept.name, to: data.name }, req });
  }
  if (data.active !== undefined && data.active !== dept.active) {
    await writeAudit({ actorId: req.user.id, action: data.active ? 'DEPARTMENT_RESUME' : 'DEPARTMENT_PAUSE', targetType: 'Department', targetId: dept.id, metadata: { name: updated.name }, req });
  }
  res.json({ ok: true, department: updated });
}));

// ---- Department super admins ----------------------------------------------

platformRouter.get('/super-admins', ah(async (req, res) => {
  const where = { role: 'SUPER_ADMIN', organisationId: req.user.organisationId };
  if (req.query.departmentId) where.departmentId = String(req.query.departmentId);
  const admins = await prisma.user.findMany({ where, include: { department: true }, orderBy: { createdAt: 'desc' } });
  res.json({ ok: true, admins: admins.map(publicSuperAdmin) });
}));

platformRouter.post('/super-admins', ah(async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  if (!isValidEmailShape(email)) return res.status(400).json({ ok: false, error: 'INVALID_EMAIL' });

  const dept = await prisma.department.findFirst({ where: { id: String(req.body.departmentId || ''), organisationId: req.user.organisationId } });
  if (!dept) return res.status(400).json({ ok: false, error: 'INVALID_DEPARTMENT' });

  const seats = await adminSeatRefusal(req.user.organisationId);
  if (seats) return res.status(409).json({ ok: false, error: 'PLAN_LIMIT', message: seats });
  const live = await prisma.user.count({ where: { role: 'SUPER_ADMIN', departmentId: dept.id, status: { not: 'DISABLED' } } });
  if (live >= MAX_SUPER_ADMINS_PER_DEPARTMENT) {
    return res.status(409).json({ ok: false, error: 'SUPER_ADMIN_CAP_REACHED', cap: MAX_SUPER_ADMINS_PER_DEPARTMENT });
  }

  let admin;
  try {
    admin = await prisma.user.create({
      data: { email, role: 'SUPER_ADMIN', status: 'PENDING', departmentId: dept.id, organisationId: req.user.organisationId, createdById: req.user.id },
      include: { department: true }
    });
  } catch (err) {
    if (isUniqueViolation(err)) return res.status(409).json({ ok: false, error: 'EMAIL_IN_USE' });
    throw err;
  }

  const raw = await issueToken(admin.id, 'ACTIVATION');
  const url = activationUrl(raw, req.user.organisation);
  sendActivationBestEffort(admin, url, dept.name);
  await writeAudit({ actorId: req.user.id, action: 'SUPER_ADMIN_CREATE', targetType: 'User', targetId: admin.id, metadata: { department: dept.name }, req });

  res.json({ ok: true, admin: publicSuperAdmin(admin) });
}));

// Same fallback as county admins: hand the link over directly when email is slow.
platformRouter.post('/super-admins/:id/activation-link', ah(async (req, res) => {
  const admin = await findSuperAdmin(req);
  if (!admin) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });
  if (admin.status !== 'PENDING') return res.status(409).json({ ok: false, error: 'NOT_PENDING' });

  const raw = await issueToken(admin.id, 'ACTIVATION');
  await writeAudit({ actorId: req.user.id, action: 'SUPER_ADMIN_ACTIVATION_LINK_VIEWED', targetType: 'User', targetId: admin.id, req });
  res.json({ ok: true, url: activationUrl(raw, req.user.organisation) });
}));

platformRouter.post('/super-admins/:id/disable', ah(async (req, res) => {
  const admin = await findSuperAdmin(req);
  if (!admin) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });

  await prisma.user.update({ where: { id: admin.id }, data: { status: 'DISABLED', disabledAt: new Date() } });
  await destroyAllSessionsForUser(admin.id);
  await writeAudit({ actorId: req.user.id, action: 'SUPER_ADMIN_DISABLE', targetType: 'User', targetId: admin.id, metadata: { department: admin.department?.name }, req });
  res.json({ ok: true });
}));

// Always via a fresh activation link, never by restoring the old password.
platformRouter.post('/super-admins/:id/reactivate', ah(async (req, res) => {
  const admin = await findSuperAdmin(req);
  if (!admin) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });
  if (admin.status === 'ACTIVE') return res.status(409).json({ ok: false, error: 'ALREADY_ACTIVE' });

  const live = await prisma.user.count({
    where: { role: 'SUPER_ADMIN', departmentId: admin.departmentId, status: { not: 'DISABLED' }, id: { not: admin.id } }
  });
  if (live >= MAX_SUPER_ADMINS_PER_DEPARTMENT) {
    return res.status(409).json({ ok: false, error: 'SUPER_ADMIN_CAP_REACHED', cap: MAX_SUPER_ADMINS_PER_DEPARTMENT });
  }

  const seatsBack = await adminSeatRefusal(req.user.organisationId);
  if (seatsBack) return res.status(409).json({ ok: false, error: 'PLAN_LIMIT', message: seatsBack });
  const updated = await prisma.user.update({
    where: { id: admin.id },
    data: { status: 'PENDING', passwordHash: null, disabledAt: null },
    include: { department: true }
  });
  const raw = await issueToken(updated.id, 'ACTIVATION');
  sendActivationBestEffort(updated, activationUrl(raw, req.user.organisation), updated.department?.name);
  await writeAudit({ actorId: req.user.id, action: 'SUPER_ADMIN_REACTIVATE', targetType: 'User', targetId: updated.id, req });
  res.json({ ok: true, admin: publicSuperAdmin(updated) });
}));

// Only a disabled or never-activated account can be removed, mirroring county admins.
platformRouter.delete('/super-admins/:id', ah(async (req, res) => {
  const admin = await findSuperAdmin(req);
  if (!admin) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });
  if (admin.status === 'ACTIVE') return res.status(409).json({ ok: false, error: 'MUST_DISABLE_FIRST' });

  try {
    await prisma.user.delete({ where: { id: admin.id } });
  } catch (err) {
    const fk =
      (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2003') ||
      (err instanceof Prisma.PrismaClientUnknownRequestError && /foreign key constraint/i.test(err.message));
    if (fk) return res.status(409).json({ ok: false, error: 'HAS_ACTIVITY' });
    throw err;
  }
  writeAudit({ actorId: req.user.id, action: 'SUPER_ADMIN_DELETE', targetType: 'User', targetId: admin.id, metadata: { email: admin.email, department: admin.department?.name }, req }).catch((err) =>
    logger.error('writeAudit failed', { stack: err.stack })
  );
  res.json({ ok: true });
}));

// ---- Organisation-wide audit trail and integrity ---------------------------

platformRouter.get('/audit', ah((req, res) => {
  const where = { organisationId: req.user.organisationId };
  if (req.query.departmentId) where.actor = { departmentId: String(req.query.departmentId) };
  return pagedAudit(where, req, res);
}));

// See lib/anchor.js: the chain head is emailed to the platform admin daily,
// and any kept hash can be checked against the live chain here.
platformRouter.get('/anchor', ah(async (req, res) => {
  const [head, last] = await Promise.all([chainHead(req.user.organisationId), lastAnchorAt(req.user.organisationId)]);
  res.json({ ok: true, head, lastAnchorAt: last });
}));

platformRouter.post('/anchor', ah(async (req, res) => {
  // Each anchor adds an audit row and an email per recipient, so a manual
  // send is limited to once every 5 minutes.
  const last = await lastAnchorAt(req.user.organisationId);
  if (last && Date.now() - last.getTime() < 5 * 60 * 1000) {
    return res.json({ ok: false, error: 'TOO_SOON', message: 'An anchor was sent a moment ago. Wait a few minutes before sending another.' });
  }
  const result = await sendAnchor({ actorId: req.user.id, req, organisationId: req.user.organisationId });
  if (!result.head) return res.json({ ok: false, error: 'EMPTY_CHAIN', message: 'There are no chained entries to anchor yet.' });
  if (!result.sent) return res.json({ ok: false, error: 'NOT_DELIVERED', message: 'The email could not be sent, so no anchor was recorded. Check the email settings and try again.' });
  res.json({ ok: true, sent: result.sent, head: result.head });
}));

platformRouter.post('/anchor/check', ah(async (req, res) => {
  const hash = String(req.body.hash || '').trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hash)) return res.status(400).json({ ok: false, error: 'INVALID_HASH', message: 'Paste the full 64-character hash from the anchor email.' });
  res.json({ ok: true, ...(await checkAnchor(hash, req.user.organisationId)) });
}));

// ---- What the organisation's plan includes ----------------------------------------

platformRouter.get('/plan', ah(async (req, res) => {
  const orgId = req.user.organisationId;
  const [plan, admins, events] = await Promise.all([orgPlanFor(orgId), adminSeatsUsed(orgId), eventsThisMonth(orgId)]);
  res.json({
    ok: true,
    plan: plan.plan,
    modules: Object.entries(MODULES).map(([key, label]) => ({ key, label, on: !plan.modules || plan.modules.includes(key) })),
    admins: { used: admins, limit: plan.maxAdmins ?? null },
    eventsThisMonth: { used: events, limit: plan.maxEventsPerMonth ?? null }
  });
}));

// ---- How the organisation looks ---------------------------------------------

async function loadOwnOrg(req) {
  return prisma.organisation.findUnique({ where: { id: req.user.organisationId } });
}

platformRouter.get('/branding', ah(async (req, res) => {
  const org = await loadOwnOrg(req);
  res.json({
    ok: true,
    organisation: { name: org.name, slug: org.slug },
    branding: { displayName: org.displayName, address: org.address, phone: org.phone, website: org.website, footerLine: org.footerLine, logoAlign: org.logoAlign, addressAlign: org.addressAlign, logoSize: org.logoSize, sheetFont: org.sheetFont, sheetFontSize: org.sheetFontSize, accentColor: org.accentColor, hasLogo: !!org.logoMime },
    brand: brandFromOrg(org)
  });
}));

platformRouter.put('/branding', ah(async (req, res) => {
  const parsed = cleanBranding(req.body);
  if (parsed.error) return res.status(400).json({ ok: false, error: 'INVALID_BRANDING', message: parsed.error });
  const before = await loadOwnOrg(req);
  const updated = await prisma.organisation.update({ where: { id: before.id }, data: parsed.value });
  invalidateBrandCache();
  const changed = Object.keys(parsed.value).filter((k) => (before[k] ?? null) !== parsed.value[k]);
  if (changed.length) await writeAudit({ actorId: req.user.id, action: 'ORG_BRANDING_UPDATED', targetType: 'Organisation', targetId: before.id, metadata: { changed }, req });
  res.json({ ok: true, brand: brandFromOrg(updated) });
}));

// A logo is sent as the raw image (not wrapped in JSON), up to 300 KB. What it really is
// is decided from its bytes, and only PNG, JPEG and WebP are accepted: none of them can
// carry a script.
function refuseOversizedLogo(req, res, next) {
  if (Number(req.headers['content-length'] || 0) > MAX_LOGO_BYTES) {
    return res.status(413).json({ ok: false, error: 'TOO_LARGE', message: 'The logo must be 300 KB or smaller.' });
  }
  next();
}
const logoBody = express.raw({ type: ['image/png', 'image/jpeg', 'image/webp'], limit: MAX_LOGO_BYTES + 1024 });

platformRouter.put('/branding/logo', refuseOversizedLogo, logoBody, ah(async (req, res) => {
  const data = req.body;
  if (!Buffer.isBuffer(data) || !data.length) return res.status(400).json({ ok: false, error: 'NO_IMAGE', message: 'Choose a PNG, JPEG or WebP image.' });
  if (data.length > MAX_LOGO_BYTES) return res.status(413).json({ ok: false, error: 'TOO_LARGE', message: 'The logo must be 300 KB or smaller.' });
  const mime = detectImage(data);
  if (!mime) return res.status(400).json({ ok: false, error: 'UNSUPPORTED_IMAGE', message: 'That file is not a PNG, JPEG or WebP image.' });

  const orgId = req.user.organisationId;
  await prisma.$transaction([
    prisma.organisationLogo.upsert({ where: { organisationId: orgId }, create: { organisationId: orgId, data, mime }, update: { data, mime } }),
    prisma.organisation.update({ where: { id: orgId }, data: { logoMime: mime, logoVersion: { increment: 1 } } })
  ]);
  invalidateBrandCache();
  await writeAudit({ actorId: req.user.id, action: 'ORG_LOGO_UPDATED', targetType: 'Organisation', targetId: orgId, metadata: { mime, bytes: data.length }, req });
  res.json({ ok: true, brand: brandFromOrg(await loadOwnOrg(req)) });
}));

platformRouter.delete('/branding/logo', ah(async (req, res) => {
  const orgId = req.user.organisationId;
  await prisma.$transaction([
    prisma.organisationLogo.deleteMany({ where: { organisationId: orgId } }),
    prisma.organisation.update({ where: { id: orgId }, data: { logoMime: null, logoVersion: { increment: 1 } } })
  ]);
  invalidateBrandCache();
  await writeAudit({ actorId: req.user.id, action: 'ORG_LOGO_REMOVED', targetType: 'Organisation', targetId: orgId, req });
  res.json({ ok: true, brand: brandFromOrg(await loadOwnOrg(req)) });
}));

// ---- Support access: the platform owner asks, you decide --------------------

function supportView(g) {
  return { id: g.id, reason: g.reason, hours: g.hours, state: supportState(g), requestedBy: g.requestedByEmail, requestedAt: g.createdAt, decidedBy: g.decidedByEmail, decidedAt: g.decidedAt, expiresAt: g.expiresAt };
}

platformRouter.get('/support', ah(async (req, res) => {
  const grants = await prisma.supportAccess.findMany({ where: { organisationId: req.user.organisationId }, orderBy: { createdAt: 'desc' }, take: 20 });
  const views = grants.map(supportView);
  res.json({ ok: true, grants: views, pending: views.filter((g) => g.state === 'PENDING').length });
}));

async function ownGrant(req) {
  return prisma.supportAccess.findFirst({ where: { id: req.params.gid, organisationId: req.user.organisationId } });
}

// Approving opens a read-only view of this organisation's overview pages, for the hours that
// were asked for. It never includes attendee records, and nothing can be changed through it.
platformRouter.post('/support/:gid/approve', ah(async (req, res) => {
  const grant = await ownGrant(req);
  if (!grant || supportState(grant) !== 'PENDING') return res.status(404).json({ ok: false, error: 'NOT_FOUND' });
  const expiresAt = new Date(Date.now() + grant.hours * 60 * 60 * 1000);
  await prisma.supportAccess.update({ where: { id: grant.id }, data: { status: 'APPROVED', decidedById: req.user.id, decidedByEmail: req.user.email, decidedAt: new Date(), expiresAt } });
  await writeAudit({ actorId: req.user.id, action: 'SUPPORT_APPROVED', targetType: 'Organisation', targetId: req.user.organisationId, metadata: { hours: grant.hours, until: expiresAt.toISOString() }, req });
  res.json({ ok: true, expiresAt });
}));

platformRouter.post('/support/:gid/deny', ah(async (req, res) => {
  const grant = await ownGrant(req);
  if (!grant || supportState(grant) !== 'PENDING') return res.status(404).json({ ok: false, error: 'NOT_FOUND' });
  await prisma.supportAccess.update({ where: { id: grant.id }, data: { status: 'DENIED', decidedById: req.user.id, decidedByEmail: req.user.email, decidedAt: new Date(), endedAt: new Date() } });
  await writeAudit({ actorId: req.user.id, action: 'SUPPORT_DENIED', targetType: 'Organisation', targetId: req.user.organisationId, req });
  res.json({ ok: true });
}));

// Ends a running session straight away.
platformRouter.post('/support/:gid/revoke', ah(async (req, res) => {
  const grant = await ownGrant(req);
  if (!grant || supportState(grant) !== 'ACTIVE') return res.status(404).json({ ok: false, error: 'NOT_FOUND' });
  await prisma.supportAccess.update({ where: { id: grant.id }, data: { status: 'REVOKED', endedAt: new Date() } });
  await writeAudit({ actorId: req.user.id, action: 'SUPPORT_REVOKED', targetType: 'Organisation', targetId: req.user.organisationId, req });
  res.json({ ok: true });
}));
