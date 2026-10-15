-- Departments. The platform admin creates a department and its super admin;
-- the super admin creates county admins inside it; everything below sees only
-- its own department.

CREATE TABLE "Department" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Department_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Department_name_key" ON "Department"("name");
CREATE UNIQUE INDEX "Department_slug_key" ON "Department"("slug");

ALTER TABLE "User" ADD COLUMN "departmentId" TEXT;
ALTER TABLE "Event" ADD COLUMN "departmentId" TEXT;

-- Everything that exists today was built for one department. It becomes the
-- first one, and nothing is lost or re-owned.
INSERT INTO "Department" ("id", "name", "slug")
VALUES ('innovation-incubation', 'Innovation & Incubation', 'innovation-incubation');

UPDATE "User" SET "departmentId" = 'innovation-incubation'
WHERE "role" IN ('SUPER_ADMIN', 'COUNTY_ADMIN');

UPDATE "Event" SET "departmentId" = 'innovation-incubation';

CREATE INDEX "User_departmentId_idx" ON "User"("departmentId");
CREATE INDEX "Event_departmentId_idx" ON "Event"("departmentId");

ALTER TABLE "User" ADD CONSTRAINT "User_departmentId_fkey"
  FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Event" ADD CONSTRAINT "Event_departmentId_fkey"
  FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The two account limits now apply inside a department, not across the whole
-- system. Ten departments each get their own 24 active county admins, and the
-- same county may have an admin in each department. Everything else about the
-- triggers is unchanged: they only re-check when a row newly becomes ACTIVE.
-- Keep the literal 24 in sync with MAX_ACTIVE_COUNTY_ADMINS in
-- server/src/lib/constants.js.
CREATE OR REPLACE FUNCTION enforce_active_admin_cap() RETURNS TRIGGER AS $$
DECLARE
  active_count INTEGER;
BEGIN
  IF NEW."role" = 'COUNTY_ADMIN' AND NEW."status" = 'ACTIVE'
     AND (TG_OP = 'INSERT' OR OLD."status" IS DISTINCT FROM 'ACTIVE') THEN

    SELECT COUNT(*) INTO active_count
    FROM "User"
    WHERE "role" = 'COUNTY_ADMIN' AND "status" = 'ACTIVE'
      AND "departmentId" IS NOT DISTINCT FROM NEW."departmentId"
      AND "id" <> NEW."id";

    IF active_count >= 24 THEN
      RAISE EXCEPTION 'ACTIVE_COUNTY_ADMIN_CAP_REACHED: at most 24 active county admins are allowed at once in a department';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION enforce_active_admin_per_county() RETURNS TRIGGER AS $$
DECLARE
  county_active_count INTEGER;
  county_cap INTEGER;
BEGIN
  IF NEW."role" = 'COUNTY_ADMIN' AND NEW."status" = 'ACTIVE'
     AND (TG_OP = 'INSERT' OR OLD."status" IS DISTINCT FROM 'ACTIVE') THEN

    county_cap := CASE WHEN NEW."county" = 'Nairobi' THEN 3 ELSE 1 END;

    SELECT COUNT(*) INTO county_active_count
    FROM "User"
    WHERE "role" = 'COUNTY_ADMIN' AND "status" = 'ACTIVE'
      AND "county" = NEW."county"
      AND "departmentId" IS NOT DISTINCT FROM NEW."departmentId"
      AND "id" <> NEW."id";

    IF county_active_count >= county_cap THEN
      RAISE EXCEPTION 'COUNTY_ADMIN_SLOTS_FULL: county "%" already has the maximum of % active admin(s) in this department', NEW."county", county_cap;
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
