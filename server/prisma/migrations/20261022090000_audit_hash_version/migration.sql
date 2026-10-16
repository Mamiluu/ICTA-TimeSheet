-- Entries written before metadata was normalised before hashing are version 1; new ones are version 2.
ALTER TABLE "AuditLog" ADD COLUMN "hashVersion" INTEGER NOT NULL DEFAULT 1;
