-- Organisations asking to join (reviewed by the platform owner) and each organisation's own web address.

CREATE TABLE "OrganisationRequest" (
  "id" TEXT NOT NULL,
  "organisationName" TEXT NOT NULL,
  "contactName" TEXT NOT NULL,
  "contactEmail" TEXT NOT NULL,
  "phone" TEXT,
  "message" TEXT,
  "status" TEXT NOT NULL DEFAULT 'UNVERIFIED',
  "tokenHash" TEXT,
  "emailVerifiedAt" TIMESTAMP(3),
  "decidedById" TEXT,
  "decidedAt" TIMESTAMP(3),
  "declineReason" TEXT,
  "organisationId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "OrganisationRequest_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "OrganisationRequest_tokenHash_key" ON "OrganisationRequest"("tokenHash");
CREATE INDEX "OrganisationRequest_status_createdAt_idx" ON "OrganisationRequest"("status", "createdAt");
CREATE INDEX "OrganisationRequest_contactEmail_idx" ON "OrganisationRequest"("contactEmail");

ALTER TABLE "Organisation" ADD COLUMN "customDomain" TEXT;
ALTER TABLE "Organisation" ADD COLUMN "domainVerifiedAt" TIMESTAMP(3);
CREATE UNIQUE INDEX "Organisation_customDomain_key" ON "Organisation"("customDomain");