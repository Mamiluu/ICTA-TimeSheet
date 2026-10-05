# Spec: Multi-day sessions and verifiable sign-off sheets

Status: draft
Written for: engineers working on this codebase.

## Problem

1. An `Attendance` row holds one `signature` for one `startAt`/`endAt` range. A multi-day workshop can't record a separate signature per day, which the Konza platform supports and this project does not.
2. A printed or exported sheet carries no proof that it matches the recorded data. Anyone with a printout can't tell whether rows were added, removed, or altered afterwards.

## Goals

- Record one person's signature per day of a multi-day event.
- Keep the existing identity rules: one phone, email, or client per event.
- Let any printed sheet be checked against the system with a QR code.
- Reuse the existing `AuditLog` hash chain. Don't build a second integrity mechanism.

## Non-goals

- Blockchain or external notarization (see Known limitations).
- Changes to the public sign-in UI for single-day events. They keep working as they do now.
- Geofencing and offline sync. Both are separate specs.

## Part A: Multi-day sessions

### Data model

```prisma
model EventDay {
  id        String   @id @default(uuid())
  eventId   String
  event     Event    @relation(fields: [eventId], references: [id], onDelete: Restrict)
  position  Int
  startAt   DateTime
  endAt     DateTime
  signatures SessionSignature[]

  @@unique([eventId, position])
  @@index([eventId])
}

model SessionSignature {
  id           String    @id @default(uuid())
  attendanceId String
  attendance   Attendance @relation(fields: [attendanceId], references: [id], onDelete: Restrict)
  dayId        String
  day          EventDay  @relation(fields: [dayId], references: [id], onDelete: Restrict)
  signature    String
  isImportedSignature Boolean @default(false)
  signedAt     DateTime  @default(now())

  @@unique([attendanceId, dayId])
  @@index([dayId])
}
```

`Attendance` keeps identity, consent, and lifecycle fields. Its `signature` column is deprecated once backfill is verified.

Retire, flag, and reopen stay on `Attendance`, so they apply to the person across all days. Per-day retirement is an open question below.

### Migration

1. Create `EventDay` and `SessionSignature`.
2. For each existing `Event`, insert one `EventDay` (position 1) using its `startAt`/`endAt`.
3. For each `Attendance` with a non-empty `signature`, insert one `SessionSignature` on that day, copying `isImportedSignature`.
4. Check row counts: signatures migrated must equal the non-empty signatures on `Attendance`.
5. Stop writing `Attendance.signature` in application code. Drop the column in a later migration.

Single-day events get one day automatically, so the admin and public UI show no change for them.

### Routes

- `POST /events/:slug/attendance`: creates the identity row. It also signs the first day that is currently open. If none is open, it returns `NOT_OPEN` with the next opening time.
- `POST /events/:slug/days/:dayId/signatures`: signs a later day. Requires `clientId` as proof of ownership, the same pattern as the existing `PATCH /events/:slug/attendance/:clientId`. Idempotent on `(attendanceId, dayId)`.
- `GET /events/:slug`: now includes `days` with each day's window and whether it is open.

### Signing window

A day is open from `startAt - 30 min` to `endAt + 2 h`. The window is a constant in one place, not per event. An admin can reopen a closed day from the dashboard, and that action is audited.

### Admin view

The attendance sheet shows one column per day, with status per cell (signed, missing, or imported). The existing "signature request" link works per day.

### Edge cases

- Removing a day that already has signatures is blocked. Show the count and ask the admin to archive instead.
- The `MAX_ATTENDANCE_PER_EVENT` cap still counts people (`Attendance` rows), not signatures.
- Imported legacy rows already show a generated initials image. Keep that marking per day.

## Part B: Verifiable sign-off sheets

### Data model

```prisma
model SheetSeal {
  id        String   @id
  eventId   String
  dayId     String?
  digest    String
  snapshot  Json
  sealedById String?
  createdAt DateTime @default(now())

  @@index([eventId])
}
```

`id` is a short random code (about 10 Crockford base32 characters), printed on the sheet.

### Sealing

`POST /admin/events/:id/days/:dayId/seal` (admin only):

1. Build a snapshot: event name, day date and window, and rows sorted by `attendanceId`. Each row contains name, organization, `status`, `signedAt`, and `sha256(signature)`. The snapshot does not store raw signature images.
2. `digest = sha256(canonicalJson(snapshot))`, using `canonicalJson` from `lib/audit.js`.
3. Insert `SheetSeal`.
4. Call `writeAudit({ action: 'SHEET_SEALED', targetType: 'SheetSeal', targetId: seal.id, metadata: { digest, eventId, dayId } })`. The seal is now part of the hash chain.
5. Return the printable sheet, with the seal code and digest in the footer and a QR to `/verify/<code>`.

### Verification page

`GET /verify/:code` (public, rate-limited) returns and renders:

- Event name, day, sealed time, and row count.
- Result of recomputing the digest from the stored snapshot. A mismatch means the seal row itself was altered.
- Result of `verifyChain` on the `SHEET_SEALED` audit entry. A failure means the audit trail was altered.
- Whether live data has changed since sealing: current signed count compared with the snapshot. This is shown as a neutral "changed since sealed" note, not as a failure. Edits after sealing are normal, and the note tells the reader they happened.

The public page shows no names, phone numbers, emails, or signatures. Those appear only in the authenticated admin view.

## Known limitations

- The chain shows tampering. It does not prevent it. A database administrator who rewrites both data and the chain would not be detected by this alone, and `writeAudit`'s race-tolerant design means forks are visible but not prevented.
- Phase 2: publish the chain head daily to a store the application cannot write to. This closes the gap above.
- Snapshots store personal data. Retention and erasure must follow the Kenya Data Protection Act 2019 rules, so an erasure request has to cover `SheetSeal.snapshot` too. Decide this before launch.

## Acceptance criteria

- A three-day event records one identity row per person and up to three `SessionSignature` rows.
- A person who signs day 1 can sign day 3 with their `clientId`. A request without the right `clientId` is rejected.
- Migrated single-day events show identical behavior in the public and admin UI.
- Sealing a day and then altering one signature changes the recomputed digest and the verification result.
- The verification page reveals no personal data to unauthenticated visitors.
- `node --test` covers: day windowing, idempotent day signing, digest determinism across key order, and verification after tampering.

## Open questions

1. Should retiring a person hide them on all days, or can an admin retire one day only?
2. Is the signing window (-30 min / +2 h) right for field events where check-in opens late?
3. Who may seal? Only the event owner, or any county admin who can see the event?
4. Should sealing be required before printing, or optional?
