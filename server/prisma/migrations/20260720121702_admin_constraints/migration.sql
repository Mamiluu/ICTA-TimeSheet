-- One active county admin per county. Only rows with status = 'ACTIVE' are
-- constrained -- a PENDING invite doesn't reserve the county slot, only a
-- completed activation does. Prisma's schema DSL can't express a partial
-- unique index, so this is hand-written SQL rather than generated from
-- schema.prisma.
CREATE UNIQUE INDEX "uniq_active_admin_per_county"
  ON "User" ("county")
  WHERE "role" = 'COUNTY_ADMIN' AND "status" = 'ACTIVE';

-- Enforces "at most 14 active county admins" as the real guarantee against
-- concurrent create/reactivate requests racing for the last slot. The app
-- layer (server/src/routes/superadmin.js) does a SELECT COUNT(*) pre-check
-- for a friendly error message, but that count can go stale the instant
-- after it's read -- this trigger is the actual serialization point,
-- evaluated inside the same transaction as the INSERT/UPDATE itself.
--
-- Keep the literal 14 here in sync with MAX_ACTIVE_COUNTY_ADMINS in
-- server/src/lib/constants.js if the pilot cap size ever changes.
CREATE OR REPLACE FUNCTION enforce_active_admin_cap() RETURNS TRIGGER AS $$
DECLARE
  active_count INTEGER;
BEGIN
  -- Only re-check when a row is newly transitioning into ACTIVE county-admin
  -- status -- an update to an already-active admin (e.g. lastLoginAt) must
  -- not be blocked by counting its own pre-existing row as "one too many."
  IF NEW."role" = 'COUNTY_ADMIN' AND NEW."status" = 'ACTIVE'
     AND (TG_OP = 'INSERT' OR OLD."status" IS DISTINCT FROM 'ACTIVE') THEN

    SELECT COUNT(*) INTO active_count
    FROM "User"
    WHERE "role" = 'COUNTY_ADMIN' AND "status" = 'ACTIVE' AND "id" <> NEW."id";

    IF active_count >= 14 THEN
      RAISE EXCEPTION 'ACTIVE_COUNTY_ADMIN_CAP_REACHED: at most 14 active county admins are allowed at once';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_enforce_active_admin_cap
BEFORE INSERT OR UPDATE ON "User"
FOR EACH ROW
EXECUTE FUNCTION enforce_active_admin_cap();
