// Copyright (c) 2026 Asya Hafidh <msanifuasiya@gmail.com>. All Rights Reserved.
// Proprietary and confidential. See LICENSE in the repository root.

import crypto from 'node:crypto';
import { prisma } from './prisma.js';
import { SESSION_TTL_MS, SESSION_COOKIE_NAME } from './constants.js';

function randomSessionId() {
  return crypto.randomBytes(32).toString('base64url');
}

const isProd = process.env.NODE_ENV === 'production';

const cookieOptions = {
  httpOnly: true,
  secure: isProd,
  sameSite: 'lax',
  maxAge: SESSION_TTL_MS,
  path: '/'
};

export async function createSession(res, userId, req) {
  const id = randomSessionId();
  await prisma.session.create({
    data: {
      id,
      userId,
      expiresAt: new Date(Date.now() + SESSION_TTL_MS),
      ip: req.ip,
      userAgent: req.get('user-agent') || null
    }
  });
  res.cookie(SESSION_COOKIE_NAME, id, cookieOptions);
  return id;
}

export async function destroySession(req, res) {
  const id = req.cookies && req.cookies[SESSION_COOKIE_NAME];
  if (id) {
    await prisma.session.deleteMany({ where: { id } });
  }
  res.clearCookie(SESSION_COOKIE_NAME, { path: '/' });
}

// Revokes every session belonging to a user -- used when disabling an admin
// account or completing a password reset, so a stolen/still-open session
// can't outlive either event.
export function destroyAllSessionsForUser(userId) {
  return prisma.session.deleteMany({ where: { userId } });
}

// Loads the session + its user in one round trip. Every admin-scoped route
// re-checks user.status === 'ACTIVE' here (not just "a session row exists"),
// so a disabled account can't ride out a session created before it was
// disabled and a stale in-memory assumption elsewhere in the code.
export async function loadSessionUser(req) {
  const id = req.cookies && req.cookies[SESSION_COOKIE_NAME];
  if (!id) return null;

  const session = await prisma.session.findUnique({ where: { id }, include: { user: true } });
  if (!session) return null;
  if (session.expiresAt < new Date()) {
    await prisma.session.delete({ where: { id } }).catch(() => {});
    return null;
  }
  if (session.user.status !== 'ACTIVE') return null;

  return session.user;
}
