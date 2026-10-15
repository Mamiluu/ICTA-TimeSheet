-- Organisations: the customers of the platform. ICT Authority becomes the first;
-- everything that exists today is moved under it.

CREATE TYPE "OrgStatus" AS ENUM ('ACTIVE', 'SUSPENDED');

CREATE TABLE "Organisation" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "shortName" TEXT,
  "slug" TEXT NOT NULL,
  "status" "OrgStatus" NOT NULL DEFAULT 'ACTIVE',
  "plan" TEXT NOT NULL DEFAULT 'PILOT',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Organisation_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Organisation_name_key" ON "Organisation"("name");
CREATE UNIQUE INDEX "Organisation_slug_key" ON "Organisation"("slug");

INSERT INTO "Organisation" ("id", "name", "shortName", "slug")
VALUES (gen_random_uuid()::text, 'ICT Authority', 'ICTA', 'icta');

-- Departments
ALTER TABLE "Department" ADD COLUMN "organisationId" TEXT;
UPDATE "Department" SET "organisationId" = (SELECT "id" FROM "Organisation" WHERE "slug" = 'icta');
ALTER TABLE "Department" ALTER COLUMN "organisationId" SET NOT NULL;
DROP INDEX "Department_name_key";
DROP INDEX "Department_slug_key";
CREATE UNIQUE INDEX "Department_organisationId_name_key" ON "Department"("organisationId", "name");
CREATE UNIQUE INDEX "Department_organisationId_slug_key" ON "Department"("organisationId", "slug");
CREATE INDEX "Department_organisationId_idx" ON "Department"("organisationId");
ALTER TABLE "Department" ADD CONSTRAINT "Department_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Accounts (the owner, when there is one, stays without an organisation)
ALTER TABLE "User" ADD COLUMN "organisationId" TEXT;
UPDATE "User" SET "organisationId" = (SELECT "id" FROM "Organisation" WHERE "slug" = 'icta');
CREATE INDEX "User_organisationId_idx" ON "User"("organisationId");
ALTER TABLE "User" ADD CONSTRAINT "User_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Events
ALTER TABLE "Event" ADD COLUMN "organisationId" TEXT;
UPDATE "Event" e SET "organisationId" = COALESCE(
  (SELECT d."organisationId" FROM "Department" d WHERE d."id" = e."departmentId"),
  (SELECT "id" FROM "Organisation" WHERE "slug" = 'icta')
);
ALTER TABLE "Event" ALTER COLUMN "organisationId" SET NOT NULL;
CREATE INDEX "Event_organisationId_idx" ON "Event"("organisationId");
ALTER TABLE "Event" ADD CONSTRAINT "Event_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Audit trail
ALTER TABLE "AuditLog" ADD COLUMN "organisationId" TEXT;
UPDATE "AuditLog" SET "organisationId" = (SELECT "id" FROM "Organisation" WHERE "slug" = 'icta');
CREATE INDEX "AuditLog_organisationId_createdAt_idx" ON "AuditLog"("organisationId", "createdAt");
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;