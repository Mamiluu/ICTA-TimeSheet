// Copyright (c) 2026 Asya Hafidh <msanifuasiya@gmail.com>. All Rights Reserved.
// Proprietary and confidential. See LICENSE in the repository root.

import { Router } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { requireRole } from '../middleware/auth.js';
import { issueToken, randomToken, hashToken } from '../lib/tokens.js';
import { sendActivationEmail, sendSignupDeclinedEmail } from '../lib/mailer.js';
import { writeAudit } from '../lib/audit.js';
import { isValidEmailShape } from '../lib/normalize.js';
import { ah } from '../lib/asyncHandler.js';
import { logger } from '../lib/logger.js';
import { cleanOrgName, cleanShortName, isValidOrgSlug, orgSlug, billingState, extendPaidUntil } from '../lib/organisations.js';
import { brandFromOrg, emailBrand, DEFAULT_ORG_SLUG } from '../lib/brand.js';
import { lastAnchorAt } from '../lib/anchor.js';
import { supportState, isOpenState, cleanSupportRequest, supportAllowed } from '../lib/support.js';
import { platformRouter } from './platform.js';
import { deliverVerifyEmail } from './signup.js';
import { emailStateOf, verifyLinkExpired } from '../lib/signup.js';
import { PLANS, MODULES, cleanPlanInput } from '../lib/plans.js';
import { ORDERED, cleanPrice, cleanBlurb } from '../lib/billing.js';
import { invalidatePlanCache } from '../lib/orgPlan.js';
import { baseUrlFor, platformHost, invalidateHostCache } from '../lib/tenantHost.js';
import { cleanDomain, isPlatformHost, checkPointsAt } from '../lib/domains.js';

// The platform owner's console. It answers "who is using the platform and is it
// healthy": organisations, counts, activity. Deliberately nothing here returns an
// attendee's name, phone, signature, or any event content -- the owner runs the
// platform, they do not read their customers' records.
export const ownerRouter = Router();
ownerRouter.use(requireRole('OWNER'));

// The page opens in the organisation's own look because the link names it.
function activationUrl(raw, org) {
  return `${baseUrlFor(org)}/activate?token=${encodeURIComponent(raw)}&org=${encodeURIComponent(org.slug)}`;
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
    platformHost: platformHost(),
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
        customDomain: o.customDomain,
        domainVerified: !!o.domainVerifiedAt,
        paidUntil: o.paidUntil,
        billing: billingState(o.paidUntil),
        modules: o.modules,
        maxAdmins: o.maxAdmins,
        maxEventsPerMonth: o.maxEventsPerMonth,
        adminSeats: mine.filter((u) => (u.role === 'SUPER_ADMIN' || u.role === 'COUNTY_ADMIN') && u.status !== 'DISABLED').reduce((n, u) => n + u._count._all, 0),
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
// Makes the organisation and its first administrator together, or says why it cannot be done.
// The administrator is invited by email and sets their own password. Used both when the owner adds
// an organisation and when they approve a request to join.
async function createOrganisationWithAdmin({ name, slug, shortName, adminEmail, ownerId, planData }) {
  try {
    const [org, admin] = await prisma.$transaction(async (tx) => {
      const o = await tx.organisation.create({ data: { name, slug, shortName, ...(planData || {}) } });
      const a = await tx.user.create({ data: { email: adminEmail, role: 'PLATFORM_ADMIN', status: 'PENDING', organisationId: o.id, createdById: ownerId } });
      return [o, a];
    });
    return { org, admin };
  } catch (err) {
    if (isUnique(err)) {
      const target = Array.isArray(err.meta?.target) ? err.meta.target.join(',') : String(err.meta?.target || '');
      if (target.includes('email')) return { conflict: { error: 'EMAIL_IN_USE', message: 'That email address is already registered.' } };
      return { conflict: { error: 'ORG_EXISTS', message: 'An organisation with that name or short address already exists.' } };
    }
    throw err;
  }
}

async function inviteFirstAdmin(org, admin, req) {
  const raw = await issueToken(admin.id, 'ACTIVATION');
  const url = activationUrl(raw, org);
  sendActivationEmail(admin.email, url, null, null, org.name, emailBrand(brandFromOrg(org))).catch((err) => logger.error('sendActivationEmail failed', { toEmail: admin.email, stack: err.stack }));
  await writeAudit({ actorId: req.user.id, action: 'ORG_CREATE', targetType: 'Organisation', targetId: org.id, metadata: { name: org.name, slug: org.slug }, req });
  return url;
}

function readNameAndSlug(body, fallbackName) {
  const name = cleanOrgName(body.name || fallbackName);
  if (!name) return { error: { error: 'INVALID_NAME', message: 'Use a name between 3 and 100 characters.' } };
  const slug = String(body.slug || '').trim().toLowerCase() || orgSlug(name);
  if (!isValidOrgSlug(slug)) return { error: { error: 'INVALID_SLUG', message: 'The short address must be 3 to 40 letters, numbers or single dashes, and not a reserved word.' } };
  return { name, slug };
}

ownerRouter.post('/organisations', ah(async (req, res) => {
  const ns = readNameAndSlug(req.body);
  if (ns.error) return res.status(400).json({ ok: false, ...ns.error });
  const adminEmail = String(req.body.adminEmail || '').trim().toLowerCase();
  if (!isValidEmailShape(adminEmail)) return res.status(400).json({ ok: false, error: 'INVALID_EMAIL', message: 'Enter the first administrator\'s email address.' });

  const made = await createOrganisationWithAdmin({ name: ns.name, slug: ns.slug, shortName: cleanShortName(req.body.shortName), adminEmail, ownerId: req.user.id });
  if (made.conflict) return res.status(409).json({ ok: false, ...made.conflict });
  const url = await inviteFirstAdmin(made.org, made.admin, req);
  res.json({ ok: true, organisation: { id: made.org.id, name: made.org.name, slug: made.org.slug }, activationUrl: url });
}));

// ---- Organisations asking to join ------------------------------------------------

ownerRouter.get('/requests', ah(async (req, res) => {
  const [waiting, unconfirmed, recent] = await Promise.all([
    prisma.organisationRequest.findMany({ where: { status: 'PENDING' }, orderBy: { createdAt: 'asc' } }),
    prisma.organisationRequest.findMany({ where: { status: 'UNVERIFIED' }, orderBy: { createdAt: 'desc' }, take: 50 }),
    prisma.organisationRequest.findMany({ where: { status: { in: ['APPROVED', 'DECLINED'] } }, orderBy: { decidedAt: 'desc' }, take: 10 })
  ]);
  const view = (r) => ({ id: r.id, organisationName: r.organisationName, contactName: r.contactName, contactEmail: r.contactEmail, phone: r.phone, message: r.message, status: r.status, requestedAt: r.createdAt, confirmedAt: r.emailVerifiedAt, decidedAt: r.decidedAt, declineReason: r.declineReason, email: emailStateOf(r), linkExpired: r.status === 'UNVERIFIED' && verifyLinkExpired(r.createdAt) });
  res.json({ ok: true, waiting: waiting.map(view), unconfirmed: unconfirmed.map(view), recent: recent.map(view) });
}));

// A request whose confirmation email never arrived: send a fresh link and say plainly whether it went.
ownerRouter.post('/requests/:id/resend', ah(async (req, res) => {
  const request = await prisma.organisationRequest.findUnique({ where: { id: req.params.id } });
  if (!request) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });
  if (request.status !== 'UNVERIFIED') return res.status(409).json({ ok: false, error: 'NOT_WAITING', message: 'This request is already confirmed or dealt with.' });
  const raw = randomToken();
  const fresh = await prisma.organisationRequest.update({ where: { id: request.id }, data: { tokenHash: hashToken(raw), createdAt: new Date() } });
  const r = await deliverVerifyEmail(fresh, raw);
  if (!r.sent) return res.json({ ok: false, error: 'EMAIL_FAILED', message: `The email could not be sent: ${r.error}` });
  res.json({ ok: true, message: 'A new confirmation link was sent.' });
}));

// The owner can vouch for a request whose confirmation email cannot be delivered (for instance a person
// the owner has spoken to). Nothing is created by this: approving still invites that address, and the
// invitation has to be opened to take the account, so the address is proven then.
ownerRouter.post('/requests/:id/confirm', ah(async (req, res) => {
  const request = await prisma.organisationRequest.findUnique({ where: { id: req.params.id } });
  if (!request) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });
  if (request.status !== 'UNVERIFIED') return res.status(409).json({ ok: false, error: 'NOT_WAITING', message: 'This request is already confirmed or dealt with.' });
  await prisma.organisationRequest.update({ where: { id: request.id }, data: { status: 'PENDING', tokenHash: null } });
  await writeAudit({ actorId: req.user.id, action: 'ORG_REQUEST_CONFIRMED_BY_OWNER', targetType: 'OrganisationRequest', targetId: request.id, metadata: { name: request.organisationName }, req });
  res.json({ ok: true });
}));
// Clears a request from the list, for test sign ups and spam. It never touches an organisation that was
// already made from it.
ownerRouter.delete('/requests/:id', ah(async (req, res) => {
  const request = await prisma.organisationRequest.findUnique({ where: { id: req.params.id } });
  if (!request) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });
  await prisma.organisationRequest.delete({ where: { id: request.id } });
  await writeAudit({ actorId: req.user.id, action: 'ORG_REQUEST_DELETED', targetType: 'OrganisationRequest', targetId: request.id, metadata: { name: request.organisationName, status: request.status }, req });
  res.json({ ok: true });
}));
// Approving makes the organisation on the Starter plan (change it afterwards if they should have
// more) and invites the person who asked as its first administrator.
ownerRouter.post('/requests/:id/approve', ah(async (req, res) => {
  const request = await prisma.organisationRequest.findUnique({ where: { id: req.params.id } });
  if (!request) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });
  if (request.status !== 'PENDING') return res.status(409).json({ ok: false, error: 'NOT_WAITING', message: 'This request has already been dealt with, or its email is not confirmed yet.' });
  const ns = readNameAndSlug(req.body, request.organisationName);
  if (ns.error) return res.status(400).json({ ok: false, ...ns.error });
  const plan = cleanPlanInput({ plan: req.body.plan || 'STARTER' });
  if (plan.error) return res.status(400).json({ ok: false, error: 'INVALID_PLAN', message: plan.error });

  const made = await createOrganisationWithAdmin({ name: ns.name, slug: ns.slug, shortName: null, adminEmail: request.contactEmail, ownerId: req.user.id, planData: plan.value });
  if (made.conflict) return res.status(409).json({ ok: false, ...made.conflict });
  await prisma.organisationRequest.update({ where: { id: request.id }, data: { status: 'APPROVED', decidedById: req.user.id, decidedAt: new Date(), organisationId: made.org.id } });
  const url = await inviteFirstAdmin(made.org, made.admin, req);
  await writeAudit({ actorId: req.user.id, action: 'ORG_REQUEST_APPROVED', targetType: 'Organisation', targetId: made.org.id, metadata: { name: made.org.name, plan: plan.value.plan }, req });
  res.json({ ok: true, organisation: { id: made.org.id, name: made.org.name, slug: made.org.slug }, activationUrl: url });
}));

ownerRouter.post('/requests/:id/decline', ah(async (req, res) => {
  const request = await prisma.organisationRequest.findUnique({ where: { id: req.params.id } });
  if (!request) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });
  if (request.status !== 'PENDING') return res.status(409).json({ ok: false, error: 'NOT_WAITING', message: 'This request has already been dealt with.' });
  const reason = String(req.body.reason || '').replace(/\s+/g, ' ').trim().slice(0, 300);
  if (reason.length < 5) return res.status(400).json({ ok: false, error: 'REASON_REQUIRED', message: 'Write a short reason. It is sent to the person who asked.' });
  await prisma.organisationRequest.update({ where: { id: request.id }, data: { status: 'DECLINED', decidedById: req.user.id, decidedAt: new Date(), declineReason: reason } });
  sendSignupDeclinedEmail(request.contactEmail, request.contactName, request.organisationName, reason).catch((err) => logger.error('sendSignupDeclinedEmail failed', { stack: err.stack }));
  await writeAudit({ actorId: req.user.id, action: 'ORG_REQUEST_DECLINED', targetType: 'OrganisationRequest', targetId: request.id, metadata: { name: request.organisationName, reason }, req });
  res.json({ ok: true });
}));

// ---- An organisation's own web address ---------------------------------------------

// Records the address an organisation wants to use. It is not used for anything until the check
// below has seen that it points at this platform.
ownerRouter.put('/organisations/:id/domain', ah(async (req, res) => {
  const org = await prisma.organisation.findUnique({ where: { id: req.params.id } });
  if (!org) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });
  const raw = String(req.body.domain ?? '').trim();
  let domain = null;
  if (raw) {
    domain = cleanDomain(raw);
    if (!domain) return res.status(400).json({ ok: false, error: 'INVALID_DOMAIN', message: 'Enter a web address such as attend.theirname.go.ke (a name under their own domain, without https://).' });
    if (isPlatformHost(domain, platformHost())) return res.status(400).json({ ok: false, error: 'INVALID_DOMAIN', message: 'That is one of the platform\'s own addresses.' });
  }
  try {
    await prisma.organisation.update({ where: { id: org.id }, data: { customDomain: domain, domainVerifiedAt: null } });
  } catch (err) {
    if (isUnique(err)) return res.status(409).json({ ok: false, error: 'DOMAIN_IN_USE', message: 'Another organisation already has that address.' });
    throw err;
  }
  invalidateHostCache();
  await writeAudit({ actorId: req.user.id, action: 'ORG_DOMAIN_SET', targetType: 'Organisation', targetId: org.id, metadata: { name: org.name, domain }, req });
  res.json({ ok: true, domain, platformHost: platformHost() });
}));

// Looks up the address in the public DNS and, if it points at the platform, switches it on.
ownerRouter.post('/organisations/:id/domain/check', ah(async (req, res) => {
  const org = await prisma.organisation.findUnique({ where: { id: req.params.id } });
  if (!org) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });
  if (!org.customDomain) return res.status(409).json({ ok: false, error: 'NO_DOMAIN', message: 'Save an address first.' });
  const result = await checkPointsAt(org.customDomain, platformHost());
  if (!result.ok) {
    const why = result.reason === 'NO_RECORD' ? 'There is no record for that address yet. DNS changes can take a while to appear.' : result.reason === 'LOOKUP_FAILED' ? 'The lookup did not work just now. Try again in a minute.' : `The address points at ${result.found.join(', ') || 'something else'}, not at ${platformHost()}.`;
    return res.json({ ok: false, error: result.reason, message: why });
  }
  await prisma.organisation.update({ where: { id: org.id }, data: { domainVerifiedAt: new Date() } });
  invalidateHostCache();
  await writeAudit({ actorId: req.user.id, action: 'ORG_DOMAIN_VERIFIED', targetType: 'Organisation', targetId: org.id, metadata: { name: org.name, domain: org.customDomain }, req });
  res.json({ ok: true });
}));

// The plans on offer and the modules they switch on, so the console never has its own copy.
ownerRouter.get('/plans', ah(async (req, res) => {
  const rows = await prisma.planPrice.findMany();
  const prices = {};
  for (const r of rows) prices[r.plan] = { monthlyKes: r.monthlyKes, yearlyKes: r.yearlyKes, blurb: r.blurb };
  res.json({ ok: true, plans: Object.entries(PLANS).map(([key, p]) => ({ key, ...p })), modules: Object.entries(MODULES).map(([key, label]) => ({ key, label })), prices, ladder: ORDERED });
}));

// What each plan costs, in whole shillings. Empty means "price on request" on the organisation's page.
ownerRouter.put('/plans/:key/price', ah(async (req, res) => {
  const key = String(req.params.key || '').toUpperCase();
  if (!ORDERED.includes(key)) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });
  const monthly = cleanPrice(req.body.monthlyKes, 'The monthly price');
  if (monthly.error) return res.status(400).json({ ok: false, error: 'INVALID_PRICE', message: monthly.error });
  const yearly = cleanPrice(req.body.yearlyKes, 'The yearly price');
  if (yearly.error) return res.status(400).json({ ok: false, error: 'INVALID_PRICE', message: yearly.error });
  const data = { monthlyKes: monthly.value, yearlyKes: yearly.value, blurb: cleanBlurb(req.body.blurb) };
  await prisma.planPrice.upsert({ where: { plan: key }, create: { plan: key, ...data }, update: data });
  await writeAudit({ actorId: req.user.id, action: 'PLAN_PRICE_SET', targetType: 'Plan', targetId: key, metadata: data, req });
  res.json({ ok: true });
}));

// Organisations asking to change plan. Applying one sets the plan's modules and limits, the same as
// choosing it by hand; a request for Custom has no preset, so it is only marked as dealt with and the
// owner sets the modules and limits under Manage, Plan and limits.
ownerRouter.get('/plan-requests', ah(async (req, res) => {
  const [waiting, recent] = await Promise.all([
    prisma.planChangeRequest.findMany({ where: { status: 'PENDING' }, orderBy: { createdAt: 'asc' } }),
    prisma.planChangeRequest.findMany({ where: { status: { in: ['APPLIED', 'DECLINED'] } }, orderBy: { decidedAt: 'desc' }, take: 10 })
  ]);
  const orgs = await prisma.organisation.findMany({ where: { id: { in: [...new Set([...waiting, ...recent].map((r) => r.organisationId))] } }, select: { id: true, name: true, slug: true } });
  const name = new Map(orgs.map((o) => [o.id, o]));
  const label = (k) => (k === 'CUSTOM' ? 'Custom' : PLANS[k] ? PLANS[k].label : k);
  const view = (r) => ({ id: r.id, organisation: (name.get(r.organisationId) || {}).name || 'Removed organisation', organisationId: r.organisationId, from: label(r.fromPlan), to: r.toPlan, toLabel: label(r.toPlan), note: r.note, by: r.requestedByEmail, status: r.status, declineReason: r.declineReason, at: r.createdAt, decidedAt: r.decidedAt });
  res.json({ ok: true, waiting: waiting.map(view), recent: recent.map(view) });
}));

ownerRouter.post('/plan-requests/:id/apply', ah(async (req, res) => {
  const request = await prisma.planChangeRequest.findUnique({ where: { id: req.params.id } });
  if (!request) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });
  if (request.status !== 'PENDING') return res.status(409).json({ ok: false, error: 'NOT_WAITING', message: 'This request has already been dealt with.' });
  const org = await prisma.organisation.findUnique({ where: { id: request.organisationId } });
  if (!org) return res.status(409).json({ ok: false, error: 'NO_ORG', message: 'That organisation no longer exists.' });
  let changed = false;
  if (request.toPlan !== 'CUSTOM') {
    const parsed = cleanPlanInput({ plan: request.toPlan });
    if (parsed.error) return res.status(400).json({ ok: false, error: 'INVALID_PLAN', message: parsed.error });
    await prisma.organisation.update({ where: { id: org.id }, data: parsed.value });
    invalidatePlanCache();
    changed = true;
    await writeAudit({ actorId: req.user.id, action: 'ORG_PLAN_CHANGED', targetType: 'Organisation', targetId: org.id, metadata: { name: org.name, from: { plan: org.plan }, to: parsed.value, viaRequest: request.id }, req, organisationId: org.id });
  }
  await prisma.planChangeRequest.update({ where: { id: request.id }, data: { status: 'APPLIED', decidedAt: new Date() } });
  res.json({ ok: true, changed });
}));

ownerRouter.post('/plan-requests/:id/decline', ah(async (req, res) => {
  const request = await prisma.planChangeRequest.findUnique({ where: { id: req.params.id } });
  if (!request) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });
  if (request.status !== 'PENDING') return res.status(409).json({ ok: false, error: 'NOT_WAITING', message: 'This request has already been dealt with.' });
  const reason = String(req.body.reason || '').replace(/\s+/g, ' ').trim().slice(0, 300);
  if (reason.length < 5) return res.status(400).json({ ok: false, error: 'REASON_REQUIRED', message: 'Write a short reason. The organisation sees it.' });
  await prisma.planChangeRequest.update({ where: { id: request.id }, data: { status: 'DECLINED', decidedAt: new Date(), declineReason: reason } });
  await writeAudit({ actorId: req.user.id, action: 'PLAN_CHANGE_DECLINED', targetType: 'PlanChangeRequest', targetId: request.id, metadata: { reason }, req });
  res.json({ ok: true });
}));

// Sets what an organisation has switched on and its limits. The new rules apply on the next
// thing anyone there does; nothing already created is removed.
ownerRouter.put('/organisations/:id/plan', ah(async (req, res) => {
  const org = await prisma.organisation.findUnique({ where: { id: req.params.id } });
  if (!org) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });
  const parsed = cleanPlanInput(req.body);
  if (parsed.error) return res.status(400).json({ ok: false, error: 'INVALID_PLAN', message: parsed.error });
  await prisma.organisation.update({ where: { id: org.id }, data: parsed.value });
  invalidatePlanCache();
  const was = { plan: org.plan, modules: org.modules, maxAdmins: org.maxAdmins, maxEventsPerMonth: org.maxEventsPerMonth };
  await writeAudit({ actorId: req.user.id, action: 'ORG_PLAN_CHANGED', targetType: 'Organisation', targetId: org.id, metadata: { name: org.name, from: was, to: parsed.value }, req, organisationId: org.id });
  res.json({ ok: true, plan: parsed.value });
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

// Removes an organisation that was only ever a test: one with no events at all. Anything that holds
// records is refused, because those records belong to its people and are kept (suspend it instead).
// ICT Authority, the platform's first organisation, can never be removed. The owner has to type the
// organisation's name, and the removal is written to the owner's own audit trail.
ownerRouter.delete('/organisations/:id', ah(async (req, res) => {
  const org = await findOrg(req);
  if (!org) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });
  if (org.slug === DEFAULT_ORG_SLUG) return res.status(409).json({ ok: false, error: 'PROTECTED', message: 'The platform\'s first organisation cannot be removed.' });
  if (String(req.body.confirmName || '').trim() !== org.name) return res.status(400).json({ ok: false, error: 'CONFIRM_NAME', message: 'Type the organisation\'s name exactly to confirm.' });
  const events = await prisma.event.count({ where: { organisationId: org.id } });
  if (events > 0) return res.status(409).json({ ok: false, error: 'HAS_RECORDS', message: `${org.name} has ${events} event${events === 1 ? '' : 's'} with records, so it cannot be removed. Suspend it instead.` });

  const users = await prisma.user.count({ where: { organisationId: org.id } });
  await prisma.$transaction([
    prisma.user.deleteMany({ where: { organisationId: org.id } }),
    prisma.department.deleteMany({ where: { organisationId: org.id } }),
    prisma.supportAccess.deleteMany({ where: { organisationId: org.id } }),
    prisma.planChangeRequest.deleteMany({ where: { organisationId: org.id } }),
    prisma.auditLog.deleteMany({ where: { organisationId: org.id } }),
    prisma.organisation.delete({ where: { id: org.id } })
  ]);
  await writeAudit({ actorId: req.user.id, action: 'ORG_DELETE', targetType: 'Organisation', targetId: org.id, metadata: { name: org.name, slug: org.slug, accountsRemoved: users }, req });
  res.json({ ok: true });
}));
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
  res.json({ ok: true, url: activationUrl(raw, org), email: admin.email });
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
