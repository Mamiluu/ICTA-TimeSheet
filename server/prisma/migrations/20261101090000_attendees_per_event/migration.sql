-- AlterTable
-- Existing organisations keep the 500 people per event they have always had.
ALTER TABLE "Organisation" ADD COLUMN "maxAttendeesPerEvent" INTEGER DEFAULT 500;
