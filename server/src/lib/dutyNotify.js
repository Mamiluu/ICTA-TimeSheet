// Copyright (c) 2026 Asya Hafidh <msanifuasiya@gmail.com>. All Rights Reserved.
// Proprietary and confidential. See LICENSE in the repository root.

import { prisma } from './prisma.js';
import { logger } from './logger.js';
import { brandForOrgId, emailBrand } from './brand.js';
import { baseUrlFor } from './tenantHost.js';
import { sendDutyStepEmail } from './mailer.js';

// Who is told when a payment sheet moves. People are found from their payment role, so nobody has
// to be added to a list: whoever the super admin made the authorising officer or finance is told.
//   SUBMITTED  the authorising officers
//   CERTIFIED  finance (people with the finance role, and the department's finance mailbox)
//   RETURNED   the preparer
//   VERIFIED   the preparer, and finance, so the payment is not forgotten
//   PAID       the preparer
// If a department has nobody in the role that needs to act, its super admins are told instead, so a
// sheet never waits for someone who does not exist. The person who just acted is never emailed.

const clean = (e) => String(e || '').trim().toLowerCase();

// users: active people of the department, each { email, role, paymentRole, access }.
export function pickRecipients({ kind, users, preparerEmail, financeEmail, actorEmail }) {
  const canDoPayments = (u) => u.role === 'SUPER_ADMIN' || ['PAYMENT', 'BOTH'].includes(u.access);
  const withRole = (r) => users.filter((u) => u.role === 'COUNTY_ADMIN' && u.paymentRole === r && canDoPayments(u)).map((u) => u.email);
  const supers = () => users.filter((u) => u.role === 'SUPER_ADMIN').map((u) => u.email);

  let list = [];
  if (kind === 'SUBMITTED') {
    list = withRole('AUTHORISER');
    if (!list.length) list = supers();
  } else if (kind === 'CERTIFIED' || kind === 'VERIFIED') {
    list = withRole('FINANCE');
    if (financeEmail) list.push(financeEmail);
    if (!list.length) list = supers();
    if (kind === 'VERIFIED' && preparerEmail) list.push(preparerEmail);
  } else if (kind === 'RETURNED' || kind === 'PAID') {
    if (preparerEmail) list.push(preparerEmail);
  }
  const actor = clean(actorEmail);
  return [...new Set(list.map(clean).filter(Boolean))].filter((e) => e !== actor);
}

// Where the person is sent from the email. The preparer works on the sheet page; everyone else
// reviews it from the approvals page.
function linkFor(kind, base, event) {
  if (kind === 'RETURNED' || kind === 'PAID') return `${base}/duty-roll?event=${encodeURIComponent(event.id)}`;
  return `${base}/duty-review`;
}

// Sends without ever failing the step that triggered it: an email problem must not leave a sheet
// half approved. Failures are logged and show up in the owner's email health view.
export function notifyDuty(event, kind, { actorEmail = null, note = null, reference = null, people = null, amount = null } = {}) {
  (async () => {
    const [dept, users, owner, org] = await Promise.all([
      event.departmentId ? prisma.department.findUnique({ where: { id: event.departmentId }, select: { name: true, financeEmail: true } }) : null,
      prisma.user.findMany({ where: { departmentId: event.departmentId, status: 'ACTIVE' }, select: { email: true, role: true, paymentRole: true, access: true } }),
      event.ownerId ? prisma.user.findUnique({ where: { id: event.ownerId }, select: { email: true } }) : null,
      prisma.organisation.findUnique({ where: { id: event.organisationId }, select: { customDomain: true, domainVerifiedAt: true } })
    ]);
    const to = pickRecipients({ kind, users, preparerEmail: owner && owner.email, financeEmail: dept && dept.financeEmail, actorEmail });
    if (!to.length) return;
    const brand = emailBrand(await brandForOrgId(event.organisationId));
    const url = linkFor(kind, baseUrlFor(org), event);
    for (const addr of to) {
      try {
        await sendDutyStepEmail(addr, { kind, eventName: event.name, department: dept && dept.name, authorityRef: event.authorityRef, note, reference, people, amount, url }, brand);
      } catch (err) {
        logger.error('payment sheet email failed', { kind, message: String(err.message || err).replace(/[\w.+-]+@[\w.-]+/g, '[address]') });
      }
    }
  })().catch((err) => logger.error('payment sheet notification failed', { kind, message: String(err.message || err) }));
}
