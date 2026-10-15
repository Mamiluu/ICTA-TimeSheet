-- How an organisation looks to its own people: name, letterhead, accent colour and logo.

ALTER TABLE "Organisation" ADD COLUMN "displayName" TEXT;
ALTER TABLE "Organisation" ADD COLUMN "address" TEXT;
ALTER TABLE "Organisation" ADD COLUMN "phone" TEXT;
ALTER TABLE "Organisation" ADD COLUMN "website" TEXT;
ALTER TABLE "Organisation" ADD COLUMN "accentColor" TEXT;
ALTER TABLE "Organisation" ADD COLUMN "logoMime" TEXT;
ALTER TABLE "Organisation" ADD COLUMN "logoVersion" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "OrganisationLogo" (
  "organisationId" TEXT NOT NULL,
  "data" BYTEA NOT NULL,
  "mime" TEXT NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "OrganisationLogo_pkey" PRIMARY KEY ("organisationId")
);
ALTER TABLE "OrganisationLogo" ADD CONSTRAINT "OrganisationLogo_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;