-- Hard-deleting a COUNTY_ADMIN with login history was impossible: AuditLog.actorId
-- was a required column with an implicit RESTRICT foreign key, so any admin who had
-- ever logged in (an AuditLog row referencing them) could only be disabled, never
-- deleted. That's still the right call for admins who *own events* (real attendance
-- sign-up sheets, only ever reachable by ownerId -- see admin.js) since deleting them
-- would orphan real attendee data. It was too strong for login/audit history alone,
-- which has no such exclusive-access dependency.
--
-- This makes actorId nullable with ON DELETE SET NULL, and adds a snapshot of the
-- actor's email/role/county at write time so an entry stays readable ("who did this")
-- even after the actor row is gone. Event.ownerId is untouched -- it keeps RESTRICTing
-- deletion of admins who own events.

ALTER TABLE "AuditLog" ADD COLUMN "actorEmail" TEXT;
ALTER TABLE "AuditLog" ADD COLUMN "actorRole" "Role";
ALTER TABLE "AuditLog" ADD COLUMN "actorCounty" TEXT;

-- Backfill existing rows from the current User table before the join is loosened.
UPDATE "AuditLog" a
SET "actorEmail" = u.email, "actorRole" = u.role, "actorCounty" = u.county
FROM "User" u
WHERE a."actorId" = u.id;

ALTER TABLE "AuditLog" ALTER COLUMN "actorId" DROP NOT NULL;

ALTER TABLE "AuditLog" DROP CONSTRAINT "AuditLog_actorId_fkey";
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
