-- AlterTable
ALTER TABLE "Event" ADD COLUMN "liveCode" BOOLEAN NOT NULL DEFAULT false,
 ADD COLUMN "liveSecret" TEXT;
