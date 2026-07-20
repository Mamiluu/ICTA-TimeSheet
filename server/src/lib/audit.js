// Copyright (c) 2026 Asya Hafidh <msanifuasiya@gmail.com>. All Rights Reserved.
// Proprietary and confidential. See LICENSE in the repository root.

import { prisma } from './prisma.js';

export function writeAudit({ actorId, action, targetType, targetId, metadata, req }) {
  return prisma.auditLog.create({
    data: {
      actorId,
      action,
      targetType: targetType || null,
      targetId: targetId || null,
      metadata: metadata ?? undefined,
      ip: req ? req.ip : null,
      userAgent: req ? req.get('user-agent') || null : null
    }
  });
}
