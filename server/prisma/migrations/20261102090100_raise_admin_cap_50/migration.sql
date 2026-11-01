-- At most 50 active county admins in a department (was 24). Keep the literal 50 here in sync with
-- MAX_ACTIVE_COUNTY_ADMINS in server/src/lib/constants.js.
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

    IF active_count >= 50 THEN
      RAISE EXCEPTION 'ACTIVE_COUNTY_ADMIN_CAP_REACHED: at most 50 active county admins are allowed at once in a department';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
