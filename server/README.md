# ICT Authority Attendance — Backend

Node.js + Express + Prisma/Postgres backend for the multi-tenant admin
system: one platform admin (the organisation's official account), a super
admin for each department, up to 24 active county admins per department,
event/attendance management, and per-admin audit trails. Also serves the static frontend
(`../index.html`, `../admin.html`, etc.) from the repo root, so one
deployed service is the whole app.

## Local setup

1. `npm install`
2. Copy `.env.example` to `.env` and fill in:
   - `DATABASE_URL` — a Postgres connection string.
   - `PUBLIC_APP_URL` — the origin this app is served from (used in CORS and in emailed activation/reset links).
   - `GMAIL_SENDER_ADDRESS` / `GMAIL_APP_PASSWORD` — a Gmail account + an
     [App Password](https://myaccount.google.com/apppasswords) (requires
     2-Step Verification on that account). Without these set correctly,
     activation/reset links still work locally — they're printed to the
     console instead of emailed (see `NODE_ENV !== 'production'` in
     `src/lib/mailer.js`) — but no real email is sent.
3. `npm run prisma:migrate` — applies the schema, including the
   hand-written migration for the one-active-admin-per-county partial
   unique index and the 24-active-admin-cap trigger
   (`prisma/migrations/*_admin_constraints/migration.sql`).
4. `npm run seed:platform -- <email>` — creates the `PLATFORM_ADMIN` account
   and prints a one-time activation link (open it to choose the password).
   Nobody sits above this account to invite it, so it is created here, once
   per environment. The platform admin then adds the departments and each
   department's super admin from `platform.html`.
5. `npm run dev`

## Deploying (Render + Neon)

A `render.yaml` blueprint at the repo root does most of this for you.

1. **Database** — sign up at [neon.tech](https://neon.tech) (can use
   "Continue with GitHub"), create a project, and copy its connection
   string (make sure it ends in `?sslmode=require`).
2. **App** — sign up at [render.com](https://render.com) using
   "Continue with GitHub" (same GitHub account this repo lives on), then
   **New > Blueprint** and point it at this repo. Render reads
   `render.yaml` and creates the web service automatically, prompting
   you to fill in the env vars marked `sync: false`:
   - `DATABASE_URL` — the Neon connection string from step 1.
   - `PUBLIC_APP_URL` — leave as `https://icta-attendance.onrender.com`
     to match the service name in `render.yaml`, or whatever URL Render
     actually assigns if that name was taken (check the Render dashboard
     after the first deploy and update this if it differs).
   - `GMAIL_SENDER_ADDRESS` / `GMAIL_APP_PASSWORD` — same as local setup.
3. The blueprint's `buildCommand` already runs
   `npx prisma migrate deploy` on every deploy, so schema migrations
   (including the 24-cap trigger and the per-county unique index) apply
   automatically — no separate manual step needed.
4. After the first successful deploy, create the platform admin once via
   Render's shell (Dashboard → the **icta-attendance** service → **Shell** tab):
   `npm run seed:platform -- <email>`, then open the link it prints. The
   migrations move the existing super admin, county admins and events into the
   Innovation & Incubation department.
5. Render's free tier spins down after 15 minutes idle and cold-starts in
   30-50s on the next request — fine for a pilot, but worth the paid
   Starter tier before real go-live so attendees never hit a cold start at
   a live event.

## Notes

- Sessions are server-side (`Session` table + httpOnly cookie), not JWT
  — disabling an admin or resetting a password deletes their session rows
  immediately, so access dies right away rather than riding out a token's
  expiry.
- Roles: `PLATFORM_ADMIN` (departments and their super admins, organisation-wide
  totals, audit trail and integrity checks; never attendee details) →
  `SUPER_ADMIN` (one department: its county admins, events and audit) →
  `COUNTY_ADMIN`. Pausing a department signs everyone in it out.
- Payment sheets ("duty rolls"): an event of kind `DUTY_ROLL` is a closed roster of named
  people (ICTA staff or external invitees), each signing every day they work. Only
  county admins whose `access` is `PAYMENT` or `BOTH` can see or create one; the super
  admin sets that when creating the admin or later from the admins list. An event the
  account has no access to answers 404. Pay is rate per day x days signed, entered per
  person. People sign at `duty-sign.html` with the phone number they were registered with;
  the organiser manages the roll, prints the form and exports the schedule at
  `duty-roll.html`. Printing and exporting are audited.
- The 24-admin cap and one-admin-per-county rule (both per department) are
  enforced by Postgres
  itself (a trigger and a partial unique index), not just application
  code, so they hold even under concurrent requests.
