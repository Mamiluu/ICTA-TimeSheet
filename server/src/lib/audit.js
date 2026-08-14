// Copyright (c) 2026 Asya Hafidh <msanifuasiya@gmail.com>. All Rights Reserved.
// Proprietary and confidential. See LICENSE in the repository root.

import { prisma } from './prisma.js';

export async function writeAudit({ actorId, action, targetType, targetId, metadata, req }) {
  const actor = actorId
    ? await prisma.user.findUnique({ where: { id: actorId }, select: { email: true, role: true, county: true } })
    : null;
  return prisma.auditLog.create({
    data: {
      actorId,
      actorEmail: actor ? actor.email : null,
      actorRole: actor ? actor.role : null,
      actorCounty: actor ? actor.county : null,
      action,
      targetType: targetType || null,
      targetId: targetId || null,
      metadata: metadata ?? undefined,
      ip: req ? req.ip : null,
      userAgent: req ? req.get('user-agent') || null : null
    }
  });
}
