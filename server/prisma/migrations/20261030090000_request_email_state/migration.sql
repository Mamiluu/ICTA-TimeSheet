-- AlterTable
ALTER TABLE "OrganisationRequest" ADD COLUMN "verifyEmailSentAt" TIMESTAMP(3),
 ADD COLUMN "verifyEmailError" TEXT;
