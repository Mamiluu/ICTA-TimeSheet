-- AlterTable
ALTER TABLE "Event" ADD COLUMN "geoCheck" BOOLEAN NOT NULL DEFAULT false,
 ADD COLUMN "geoRadiusM" INTEGER;

-- AlterTable
ALTER TABLE "SessionSignature" ADD COLUMN "geoStatus" TEXT,
 ADD COLUMN "geoDistanceM" INTEGER;
