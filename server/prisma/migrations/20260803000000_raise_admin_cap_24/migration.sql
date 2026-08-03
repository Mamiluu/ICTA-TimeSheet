-- Raises the active-county-admin cap from 14 (pilot phase) to 24.
-- Keep the literal 24 here in sync with MAX_ACTIVE_COUNTY_ADMINS in
-- server/src/lib/constants.js if the cap size ever changes again.
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

    IF active_count >= 24 THEN
      RAISE EXCEPTION 'ACTIVE_COUNTY_ADMIN_CAP_REACHED: at most 24 active county admins are allowed at once';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
