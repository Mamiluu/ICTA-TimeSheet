-- AlterTable: nullable, no backfill -- null is the correct, honest value
-- for every row that predates this column (see the schema.prisma comment
-- on Attendance.photoVideoConsent).
ALTER TABLE "Attendance" ADD COLUMN "photoVideoConsent" BOOLEAN;
