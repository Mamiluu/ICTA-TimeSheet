-- CreateEnum
CREATE TYPE "AttendanceStatus" AS ENUM ('ACTIVE', 'FLAGGED_FOR_REMOVAL', 'RETIRED');

-- AlterTable
ALTER TABLE "Attendance" ADD COLUMN     "status" "AttendanceStatus" NOT NULL DEFAULT 'ACTIVE',
ADD COLUMN     "statusAt" TIMESTAMP(3),
ADD COLUMN     "statusReason" TEXT;

-- AlterTable
ALTER TABLE "AuditLog" ADD COLUMN     "hash" TEXT,
ADD COLUMN     "prevHash" TEXT;
