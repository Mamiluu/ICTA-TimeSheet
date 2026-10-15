-- The date an organisation has paid until, kept by the platform owner. Null: no billing set up.
ALTER TABLE "Organisation" ADD COLUMN "paidUntil" TIMESTAMP(3);
