-- Replaces the flat "exactly one active admin per county" rule with a
-- per-county cap: Nairobi may have up to 3 active admins at once (its
-- volume of activity justifies more than one point of contact); every
-- other county still allows at most 1, same as before.
--
-- A plain unique index can only ever express "at most 1" -- it has no way
-- to say "at most 3 for this particular value, 1 for everything else" --
-- so a cap greater than 1 for any county requires a trigger-based check
-- instead of the index this replaces. This is the same tradeoff already
-- accepted for the global 24-admin cap in trg_enforce_active_admin_cap: a
-- SELECT-COUNT-then-compare isn't fully race-proof under true concurrency
-- the way a unique index is, but admin activation is low-frequency and
-- human-driven, so that's an acceptable tradeoff here too.
DROP INDEX "uniq_active_admin_per_county";

CREATE OR REPLACE FUNCTION enforce_active_admin_per_county() RETURNS TRIGGER AS $$
DECLARE
  county_active_count INTEGER;
  county_cap INTEGER;
BEGIN
  -- Only re-check when a row is newly transitioning into ACTIVE county-admin
  -- status -- an update to an already-active admin (e.g. lastLoginAt) must
  -- not be blocked by counting its own pre-existing row as "one too many."
  IF NEW."role" = 'COUNTY_ADMIN' AND NEW."status" = 'ACTIVE'
     AND (TG_OP = 'INSERT' OR OLD."status" IS DISTINCT FROM 'ACTIVE') THEN

    county_cap := CASE WHEN NEW."county" = 'Nairobi' THEN 3 ELSE 1 END;

    SELECT COUNT(*) INTO county_active_count
    FROM "User"
    WHERE "role" = 'COUNTY_ADMIN' AND "status" = 'ACTIVE'
      AND "county" = NEW."county" AND "id" <> NEW."id";

    IF county_active_count >= county_cap THEN
      RAISE EXCEPTION 'COUNTY_ADMIN_SLOTS_FULL: county "%" already has the maximum of % active admin(s)', NEW."county", county_cap;
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_enforce_active_admin_per_county
BEFORE INSERT OR UPDATE ON "User"
FOR EACH ROW
EXECUTE FUNCTION enforce_active_admin_per_county();
