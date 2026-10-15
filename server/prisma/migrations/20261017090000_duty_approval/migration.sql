-- Approval chain, payment roles and payee queries for payment sheets.

CREATE TYPE "PaymentRole" AS ENUM ('PREPARER', 'AUTHORISER', 'FINANCE');
CREATE TYPE "DutyStage" AS ENUM ('OPEN', 'SUBMITTED', 'CERTIFIED', 'VERIFIED');

ALTER TABLE "User" ADD COLUMN "paymentRole" "PaymentRole" NOT NULL DEFAULT 'PREPARER';
ALTER TABLE "Event" ADD COLUMN "dutyStage" "DutyStage" NOT NULL DEFAULT 'OPEN';

CREATE TABLE "DutyApproval" (
  "id" TEXT NOT NULL,
  "eventId" TEXT NOT NULL,
  "step" TEXT NOT NULL,
  "byId" TEXT,
  "byEmail" TEXT NOT NULL,
  "note" TEXT,
  "sealCode" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DutyApproval_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "DutyApproval_eventId_idx" ON "DutyApproval"("eventId");
ALTER TABLE "DutyApproval" ADD CONSTRAINT "DutyApproval_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "DutyQuery" (
  "id" TEXT NOT NULL,
  "eventId" TEXT NOT NULL,
  "payeeId" TEXT NOT NULL,
  "dayId" TEXT NOT NULL,
  "message" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'OPEN',
  "response" TEXT,
  "resolvedById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resolvedAt" TIMESTAMP(3),
  CONSTRAINT "DutyQuery_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "DutyQuery_eventId_status_idx" ON "DutyQuery"("eventId", "status");
ALTER TABLE "DutyQuery" ADD CONSTRAINT "DutyQuery_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DutyQuery" ADD CONSTRAINT "DutyQuery_payeeId_fkey" FOREIGN KEY ("payeeId") REFERENCES "DutyPayee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;