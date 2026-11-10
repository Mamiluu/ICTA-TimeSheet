-- Screens paired to an event's live code, so one organiser can show the code on several laptops at a
-- venue without signing in on each. See the LiveScreen model in schema.prisma.
CREATE TABLE "LiveScreen" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "pairCode" TEXT,
    "pairExpiresAt" TIMESTAMP(3),
    "tokenHash" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "pairedAt" TIMESTAMP(3),
    "lastSeenAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "LiveScreen_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "LiveScreen_pairCode_key" ON "LiveScreen"("pairCode");
CREATE UNIQUE INDEX "LiveScreen_tokenHash_key" ON "LiveScreen"("tokenHash");
CREATE INDEX "LiveScreen_eventId_idx" ON "LiveScreen"("eventId");

ALTER TABLE "LiveScreen" ADD CONSTRAINT "LiveScreen_eventId_fkey"
  FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;
