-- Rows 154/168 (and any others) got submitted with an empty signature
-- because that was only ever checked client-side (see isBlankSignature in
-- public.js, added alongside this migration). These two columns back the
-- recovery path: an admin can now request a real signature from the
-- attendee via a one-time link, without needing the device they originally
-- submitted from. Hash-only, same pattern as "AuthToken" -- the raw token
-- only ever exists in the link handed to the admin.
ALTER TABLE "Attendance" ADD COLUMN "signatureRequestTokenHash" TEXT;
ALTER TABLE "Attendance" ADD COLUMN "signatureRequestExpiresAt" TIMESTAMP(3);

CREATE UNIQUE INDEX "Attendance_signatureRequestTokenHash_key" ON "Attendance"("signatureRequestTokenHash");
