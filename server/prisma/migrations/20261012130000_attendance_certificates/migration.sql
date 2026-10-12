ALTER TABLE "Event" ADD COLUMN "certificatesEnabled" BOOLEAN NOT NULL DEFAULT true;

CREATE TABLE "AttendanceCertificate" (
    "id" TEXT NOT NULL,
    "attendanceId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "digest" TEXT NOT NULL,
    "snapshot" JSONB NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AttendanceCertificate_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AttendanceCertificate_attendanceId_digest_key" ON "AttendanceCertificate"("attendanceId", "digest");
CREATE INDEX "AttendanceCertificate_eventId_idx" ON "AttendanceCertificate"("eventId");

ALTER TABLE "AttendanceCertificate" ADD CONSTRAINT "AttendanceCertificate_attendanceId_fkey" FOREIGN KEY ("attendanceId") REFERENCES "Attendance"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AttendanceCertificate" ADD CONSTRAINT "AttendanceCertificate_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
