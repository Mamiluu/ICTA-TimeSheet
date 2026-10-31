-- A county can have as many administrators as the organisation needs. The old rule (one active admin
-- per county, three for Nairobi) came from the pilot, where each county had a single point of contact.
-- Organisations now run many event admins in the same county, so the rule goes. How many admins an
-- organisation may have is the plan's limit (maxAdmins), not a per-county number.
DROP TRIGGER IF EXISTS trg_enforce_active_admin_per_county ON "User";
DROP FUNCTION IF EXISTS enforce_active_admin_per_county();
