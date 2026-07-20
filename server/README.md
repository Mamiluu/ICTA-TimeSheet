# ICT Authority Attendance — Backend

Node.js + Express + Prisma/Postgres backend for the multi-tenant admin
system: one super admin, up to 14 active county admins, event/attendance
management, and per-admin audit trails. Also serves the static frontend
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
   unique index and the 14-active-admin-cap trigger
   (`prisma/migrations/*_admin_constraints/migration.sql`).
4. `npm run seed:superadmin -- <email> <password>` — creates the one
   `SUPER_ADMIN` account directly (bypasses the activation-link flow,
   since there's no admin above the super admin to send them an invite).
5. `npm run dev`

## Deploying

- **Database**: [Neon](https://neon.tech) free tier works well — set
  `DATABASE_URL` with `?sslmode=require`.
- **App**: [Render](https://render.com) as a Node web service, auto-deploy
  from GitHub. Set all the `.env` variables above as environment
  variables in the Render dashboard (never commit `.env`).
- Render's free tier spins down after 15 minutes idle and cold-starts in
  30-50s on the next request — fine for a pilot, but worth the paid
  Starter tier before real go-live so attendees never hit a cold start at
  a live event.
- Run `npm run prisma:deploy` (not `prisma:migrate`) against the
  production database the first time, then re-run it on every deploy
  that adds a migration.

## Notes

- Sessions are server-side (`Session` table + httpOnly cookie), not JWT
  — disabling an admin or resetting a password deletes their session rows
  immediately, so access dies right away rather than riding out a token's
  expiry.
- The 14-admin cap and one-admin-per-county rule are enforced by Postgres
  itself (a trigger and a partial unique index), not just application
  code, so they hold even under concurrent requests.
