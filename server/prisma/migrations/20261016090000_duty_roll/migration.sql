-- Payment sheets ("duty rolls"): a closed roster where each day is a payable unit,
-- and a per-user access level that decides who can see them.

CREATE TYPE "AccessLevel" AS ENUM ('ATTENDANCE', 'PAYMENT', 'BOTH');
CREATE TYPE "EventKind" AS ENUM ('ATTENDANCE', 'DUTY_ROLL');
CREATE TYPE "PayeeType" AS ENUM ('STAFF', 'EXTERNAL');

ALTER TABLE "User" ADD COLUMN "access" "AccessLevel" NOT NULL DEFAULT 'ATTENDANCE';

ALTER TABLE "Event" ADD COLUMN "kind" "EventKind" NOT NULL DEFAULT 'ATTENDANCE';
ALTER TABLE "Event" ADD COLUMN "authorisedBy" TEXT;
ALTER TABLE "Event" ADD COLUMN "authorityRef" TEXT;

ALTER TABLE "EventDay" ADD COLUMN "place" TEXT;

CREATE TABLE "DutyPayee" (
  "id" TEXT NOT NULL,
  "eventId" TEXT NOT NULL,
  "attendanceId" TEXT NOT NULL,
  "payeeType" "PayeeType" NOT NULL,
  "idNumber" TEXT NOT NULL,
  "jobRole" TEXT,
  "ratePerDay" INTEGER NOT NULL,
  "addedById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DutyPayee_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DutyPayee_attendanceId_key" ON "DutyPayee"("attendanceId");
CREATE UNIQUE INDEX "DutyPayee_eventId_idNumber_key" ON "DutyPayee"("eventId", "idNumber");
CREATE INDEX "DutyPayee_eventId_idx" ON "DutyPayee"("eventId");

ALTER TABLE "DutyPayee" ADD CONSTRAINT "DutyPayee_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DutyPayee" ADD CONSTRAINT "DutyPayee_attendanceId_fkey" FOREIGN KEY ("attendanceId") REFERENCES "Attendance"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
