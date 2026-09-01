-- AlterTable: nullable, no backfill -- null is correct for every existing
-- physical event, since none of them were created through the new
-- geocoded-address picker.
ALTER TABLE "Event" ADD COLUMN "latitude" DOUBLE PRECISION,
ADD COLUMN "longitude" DOUBLE PRECISION;
