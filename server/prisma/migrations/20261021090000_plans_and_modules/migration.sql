-- What each organisation has switched on (modules) and its limits. Everything already there keeps everything on, with no limits.
ALTER TABLE "Organisation" ADD COLUMN "modules" TEXT[] NOT NULL DEFAULT ARRAY['ATTENDANCE', 'PAYMENT', 'DOOR_SCAN', 'CERTIFICATES'];
ALTER TABLE "Organisation" ADD COLUMN "maxAdmins" INTEGER;
ALTER TABLE "Organisation" ADD COLUMN "maxEventsPerMonth" INTEGER;
