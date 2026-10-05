-- CreateTable
CREATE TABLE "EventDay" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "startAt" TIMESTAMP(3) NOT NULL,
    "endAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EventDay_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SessionSignature" (
    "id" TEXT NOT NULL,
    "attendanceId" TEXT NOT NULL,
    "dayId" TEXT NOT NULL,
    "signature" TEXT NOT NULL,
    "isImportedSignature" BOOLEAN NOT NULL DEFAULT false,
    "signedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SessionSignature_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EventDay_eventId_idx" ON "EventDay"("eventId");

-- CreateIndex
CREATE UNIQUE INDEX "EventDay_eventId_position_key" ON "EventDay"("eventId", "position");

-- CreateIndex
CREATE INDEX "SessionSignature_dayId_idx" ON "SessionSignature"("dayId");

-- CreateIndex
CREATE UNIQUE INDEX "SessionSignature_attendanceId_dayId_key" ON "SessionSignature"("attendanceId", "dayId");

-- AddForeignKey
ALTER TABLE "EventDay" ADD CONSTRAINT "EventDay_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SessionSignature" ADD CONSTRAINT "SessionSignature_attendanceId_fkey" FOREIGN KEY ("attendanceId") REFERENCES "Attendance"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SessionSignature" ADD CONSTRAINT "SessionSignature_dayId_fkey" FOREIGN KEY ("dayId") REFERENCES "EventDay"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Backfill: every existing event becomes a single day covering its own window.
INSERT INTO "EventDay" ("id", "eventId", "position", "startAt", "endAt")
SELECT gen_random_uuid()::text, e."id", 1, e."startAt", e."endAt"
FROM "Event" e;

-- Backfill: every existing non-empty signature moves onto that single day.
INSERT INTO "SessionSignature" ("id", "attendanceId", "dayId", "signature", "isImportedSignature", "signedAt")
SELECT gen_random_uuid()::text, a."id", d."id", a."signature", a."isImportedSignature", a."createdAt"
FROM "Attendance" a
JOIN "EventDay" d ON d."eventId" = a."eventId" AND d."position" = 1
WHERE a."signature" <> '';