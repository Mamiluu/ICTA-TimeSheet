-- Support access (the owner looks inside an organisation only with its permission) and a
-- record of email delivery for the owner's health view.

CREATE TABLE "SupportAccess" (
  "id" TEXT NOT NULL,
  "organisationId" TEXT NOT NULL,
  "requestedById" TEXT NOT NULL,
  "requestedByEmail" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "hours" INTEGER NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'REQUESTED',
  "decidedById" TEXT,
  "decidedByEmail" TEXT,
  "decidedAt" TIMESTAMP(3),
  "expiresAt" TIMESTAMP(3),
  "endedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SupportAccess_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "SupportAccess_organisationId_createdAt_idx" ON "SupportAccess"("organisationId", "createdAt");
ALTER TABLE "SupportAccess" ADD CONSTRAINT "SupportAccess_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "EmailDelivery" (
  "id" TEXT NOT NULL,
  "organisationSlug" TEXT,
  "kind" TEXT NOT NULL,
  "ok" BOOLEAN NOT NULL,
  "error" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "EmailDelivery_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "EmailDelivery_createdAt_idx" ON "EmailDelivery"("createdAt");