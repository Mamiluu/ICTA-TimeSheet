-- CreateEnum
CREATE TYPE "EventLocationType" AS ENUM ('PHYSICAL', 'VIRTUAL');

-- Add new columns nullable first so existing rows can be backfilled before
-- the NOT NULL constraints go on (see the UPDATE below) -- date/location
-- are dropped only once every row already has a startAt/endAt/timezone.
ALTER TABLE "Event"
  ADD COLUMN "description" TEXT,
  ADD COLUMN "startAt" TIMESTAMP(3),
  ADD COLUMN "endAt" TIMESTAMP(3),
  ADD COLUMN "timezone" TEXT,
  ADD COLUMN "locationType" "EventLocationType" NOT NULL DEFAULT 'PHYSICAL',
  ADD COLUMN "address" TEXT,
  ADD COLUMN "meetingLink" TEXT;

-- Every existing event was created under the old single-date model, which
-- had no notion of a specific time or timezone -- backfilled as a normal
-- 09:00-17:00 workday in Africa/Nairobi (this app's one prior hardcoded
-- timezone assumption, see the old formatRecordedAt in mailer.js) on
-- whatever date was already recorded, with the old `location` string
-- carried over as the new physical `address`. Nothing here is inferred;
-- these are just the closest honest defaults for data that predates the
-- concept of start/end time.
-- Chained AT TIME ZONE both ways (naive -> timestamptz -> naive-as-UTC)
-- rather than letting an implicit timestamptz-to-timestamp cast happen on
-- assignment -- that implicit cast would go through whatever the DB
-- session's own TimeZone setting happens to be at migration time, which
-- isn't guaranteed to be UTC on every host this runs on. Chaining through
-- 'UTC' explicitly makes the stored value deterministic regardless of the
-- session's timezone setting.
UPDATE "Event" SET
  "startAt" = ((("date"::date + TIME '09:00') AT TIME ZONE 'Africa/Nairobi') AT TIME ZONE 'UTC'),
  "endAt"   = ((("date"::date + TIME '17:00') AT TIME ZONE 'Africa/Nairobi') AT TIME ZONE 'UTC'),
  "timezone" = 'Africa/Nairobi',
  "address" = "location";

-- AlterTable: now safe to require these on every row
ALTER TABLE "Event"
  ALTER COLUMN "startAt" SET NOT NULL,
  ALTER COLUMN "endAt" SET NOT NULL,
  ALTER COLUMN "timezone" SET NOT NULL;

-- DropColumn: superseded by startAt/endAt/timezone and address/meetingLink
ALTER TABLE "Event" DROP COLUMN "date";
ALTER TABLE "Event" DROP COLUMN "location";
