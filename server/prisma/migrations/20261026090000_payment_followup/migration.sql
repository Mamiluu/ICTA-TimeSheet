-- AlterTable
ALTER TABLE "Event" ADD COLUMN "paidAt" TIMESTAMP(3),
 ADD COLUMN "paidReference" TEXT,
 ADD COLUMN "paidByEmail" TEXT;

-- AlterTable
ALTER TABLE "Department" ADD COLUMN "financeEmail" TEXT;
