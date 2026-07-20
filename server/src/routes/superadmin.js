// Copyright (c) 2026 Asya Hafidh <msanifuasiya@gmail.com>. All Rights Reserved.
// Proprietary and confidential. See LICENSE in the repository root.

import { Router } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { requireRole } from '../middleware/auth.js';
import { issueToken } from '../lib/tokens.js';
import { destroyAllSessionsForUser } from '../lib/session.js';
import { sendActivationEmail } from '../lib/mailer.js';
import { writeAudit } from '../lib/audit.js';
import { KENYA_COUNTIES, MAX_ACTIVE_COUNTY_ADMINS } from '../lib/constants.js';
import { isValidEmailShape } from '../lib/normalize.js';
import { ah } from '../lib/asyncHandler.js';

export const superadminRouter = Router();
superadminRouter.use(requireRole('SUPER_ADMIN'));

function publicAdmin(u) {
  return {
    id: u.id,
    email: u.email,
    county: u.county,
    status: u.status,
    createdAt: u.createdAt,
    disabledAt: u.disabledAt,
    lastLoginAt: u.lastLoginAt
  };
}

// Sends the activation email without blocking the API response on SMTP --
// account creation/reactivation still succeeds even if mail delivery is
// slow or briefly down; failures are logged rather than surfaced as a
// crash (see lib/asyncHandler.js for why that distinction matters here).
function sendActivationEmailBestEffort(toEmail, activateUrl, county) {
  sendActivationEmail(toEmail, activateUrl, county).catch((err) => {
    console.error(`sendActivationEmail failed for ${toEmail}`, err);
  });
}

superadminRouter.get('/admins', ah(async (req, res) => {
  const admins = await prisma.user.findMany({
    where: { role: 'COUNTY_ADMIN' },
    orderBy: { createdAt: 'desc' }
  });
  const activeCount = admins.filter((a) => a.status === 'ACTIVE').length;
  res.json({
    ok: true,
    admins: admins.map(publicAdmin),
    activeCount,
    cap: MAX_ACTIVE_COUNTY_ADMINS,
    counties: KENYA_COUNTIES
  });
}));

superadminRouter.post('/admins', ah(async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const county = String(req.body.county || '').trim();
  if (!isValidEmailShape(email)) return res.status(400).json({ ok: false, error: 'INVALID_EMAIL' });
  if (!county || !KENYA_COUNTIES.includes(county)) {
    return res.status(400).json({ ok: false, error: 'INVALID_COUNTY' });
  }

  // Friendly pre-check for a nicer error message before hitting the DB.
  // The actual guarantee against a concurrent-request race for the 14th
  // slot is the Postgres trigger installed in the migration (see
  // prisma/migrations/*_admin_constraints/migration.sql) -- this count can
  // be stale the instant after it's read, the trigger cannot.
  const activeCount = await prisma.user.count({ where: { role: 'COUNTY_ADMIN', status: 'ACTIVE' } });
  if (activeCount >= MAX_ACTIVE_COUNTY_ADMINS) {
    return res.status(409).json({ ok: false, error: 'COUNTY_CAP_REACHED', activeCount, cap: MAX_ACTIVE_COUNTY_ADMINS });
  }

  let admin;
  try {
    admin = await prisma.user.create({
      data: { email, county, role: 'COUNTY_ADMIN', status: 'PENDING', createdById: req.user.id }
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      return res.status(409).json({ ok: false, error: 'EMAIL_IN_USE' });
    }
    // Raised by the DB trigger (partial unique index on active-admin-per-county,
    // or the 14-cap trigger) when this request lost a concurrency race against
    // another create happening at the same instant.
    if (err instanceof Prisma.PrismaClientUnknownRequestError || err instanceof Prisma.PrismaClientKnownRequestError) {
      return res.status(409).json({ ok: false, error: 'CONFLICT', message: String(err.message || err) });
    }
    throw err;
  }

  const raw = await issueToken(admin.id, 'ACTIVATION');
  const activateUrl = `${process.env.PUBLIC_APP_URL}/activate.html?token=${encodeURIComponent(raw)}`;
  sendActivationEmailBestEffort(admin.email, activateUrl, admin.county);
  await writeAudit({ actorId: req.user.id, action: 'ADMIN_CREATE', targetType: 'User', targetId: admin.id, metadata: { county }, req });

  res.json({ ok: true, admin: publicAdmin(admin) });
}));

superadminRouter.post('/admins/:id/disable', ah(async (req, res) => {
  const admin = await prisma.user.findUnique({ where: { id: req.params.id } });
  if (!admin || admin.role !== 'COUNTY_ADMIN') return res.status(404).json({ ok: false, error: 'NOT_FOUND' });

  await prisma.user.update({ where: { id: admin.id }, data: { status: 'DISABLED', disabledAt: new Date() } });
  await destroyAllSessionsForUser(admin.id);
  await writeAudit({ actorId: req.user.id, action: 'ADMIN_DISABLE', targetType: 'User', targetId: admin.id, req });

  res.json({ ok: true });
}));

// Re-enabling always goes through a fresh activation link rather than
// silently restoring the old password hash -- a disable often means "this
// person left" or "this credential may be compromised," and we have no way
// to tell those apart from a re-enable click alone.
superadminRouter.post('/admins/:id/reactivate', ah(async (req, res) => {
  const admin = await prisma.user.findUnique({ where: { id: req.params.id } });
  if (!admin || admin.role !== 'COUNTY_ADMIN') return res.status(404).json({ ok: false, error: 'NOT_FOUND' });
  if (admin.status === 'ACTIVE') return res.status(409).json({ ok: false, error: 'ALREADY_ACTIVE' });

  const activeCount = await prisma.user.count({ where: { role: 'COUNTY_ADMIN', status: 'ACTIVE' } });
  if (activeCount >= MAX_ACTIVE_COUNTY_ADMINS) {
    return res.status(409).json({ ok: false, error: 'COUNTY_CAP_REACHED', activeCount, cap: MAX_ACTIVE_COUNTY_ADMINS });
  }

  let updated;
  try {
    updated = await prisma.user.update({
      where: { id: admin.id },
      data: { status: 'PENDING', passwordHash: null, disabledAt: null }
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError || err instanceof Prisma.PrismaClientUnknownRequestError) {
      return res.status(409).json({ ok: false, error: 'CONFLICT', message: String(err.message || err) });
    }
    throw err;
  }

  const raw = await issueToken(updated.id, 'ACTIVATION');
  const activateUrl = `${process.env.PUBLIC_APP_URL}/activate.html?token=${encodeURIComponent(raw)}`;
  sendActivationEmailBestEffort(updated.email, activateUrl, updated.county);
  await writeAudit({ actorId: req.user.id, action: 'ADMIN_REACTIVATE', targetType: 'User', targetId: updated.id, req });

  res.json({ ok: true, admin: publicAdmin(updated) });
}));

async function pagedAudit(where, req, res) {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize, 10) || 25));

  const [total, entries] = await Promise.all([
    prisma.auditLog.count({ where }),
    prisma.auditLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: { actor: { select: { email: true, role: true, county: true } } }
    })
  ]);

  res.json({ ok: true, entries, total, page, pageSize });
}

superadminRouter.get('/admins/:id/audit', ah((req, res) => pagedAudit({ actorId: req.params.id }, req, res)));

superadminRouter.get('/audit', ah((req, res) => {
  const where = {};
  if (req.query.county) {
    where.actor = { county: String(req.query.county) };
  }
  return pagedAudit(where, req, res);
}));
