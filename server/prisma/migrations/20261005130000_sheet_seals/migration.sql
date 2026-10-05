-- CreateTable
CREATE TABLE "SheetSeal" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "dayId" TEXT NOT NULL,
    "digest" TEXT NOT NULL,
    "snapshot" JSONB NOT NULL,
    "sealedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SheetSeal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SheetSeal_eventId_idx" ON "SheetSeal"("eventId");

-- CreateIndex
CREATE INDEX "SheetSeal_dayId_idx" ON "SheetSeal"("dayId");

-- AddForeignKey
ALTER TABLE "SheetSeal" ADD CONSTRAINT "SheetSeal_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SheetSeal" ADD CONSTRAINT "SheetSeal_dayId_fkey" FOREIGN KEY ("dayId") REFERENCES "EventDay"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
