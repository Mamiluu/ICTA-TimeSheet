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
4. `npm run seed:platform -- <email>` — creates the `PLATFORM_ADMIN` account for ICT Authority
   (set `ORG_SLUG` for another organisation)
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
- Organisations: the platform serves several organisations (ICT Authority is the first). Every
  department, account, event and audit entry belongs to exactly one, and an organisation never
  sees another's data. The platform owner (`OWNER`, created with `npm run seed:owner -- <email>`
  or `OWNER_EMAIL` and `OWNER_PASSWORD`) has no organisation of their own; at `owner.html` they
  add and suspend organisations and see counts and activity, never attendee records. Each new
  organisation's first administrator is invited by email and then sets up their own departments.
  `node scripts/tenant-fence-check.js` proves the separation: it builds two organisations through
  the API, has every account of one try to reach the other's data, and fails on anything that
  is not refused. Run it against a test database after any change that touches who can see what
  (start the server with `LOGIN_RATE_LIMIT=100`).
- Page addresses: pages are reached without the file extension (`/login`, `/admin`, `/verify?code=...`).
  The attendee sign in page, `index.html`, is `/attend`. The old `.html` addresses still answer, with a
  redirect that keeps the query string, because they are in emails and printed QR codes. The list of
  redirected pages is `CLEAN_PAGES` in `src/index.js`; a new page needs adding there.
- Branding: each organisation sets its own name, address, phone, website, the line in the band at the
  foot of printed payment sheets (`footerLine`; ICT Authority's default is its State Corporation
  statement, other organisations print none until they set one; migration
  `20261024090000_brand_footer_line`), how its printed sheets are laid out (logo and address position
  left, centre or right; logo size; one of eight fonts; text size; migration
  `20261025090000_sheet_layout`; the choices are keys the pages turn into CSS, never free text), accent colour (checked for
  readable contrast with white text) and logo (PNG, JPEG or WebP up to 300 KB, judged by its bytes;
  SVG is refused because it can carry script) at `platform.html`, Branding. Without a logo an
  organisation gets a round badge with its initials. `GET /api/branding` returns the look for the
  page asking (`?org=`, `?event=`, `?code=`, or the person signed in), and `assets/brand.js` applies
  it to every page, so the pages stay written once. Emails, printed sheets and the verify page use it
  too. Anything an organisation has not filled in falls back to the platform default, but another
  organisation never inherits ICT Authority's address or contact details.
- Billing: the owner records payments by hand (`paidUntil` on the organisation) at `owner.html`; the
  console shows paid, due soon or overdue, and the owner decides whether to suspend. Nothing is
  suspended automatically.
- Owner console (`owner.html`, `owner-org.html`): platform health (database, emails sent and failed in the
  last 24 hours, the audit anchor, the latest migration) and, per organisation, weekly events,
  signatures and logins. Counts only. Email delivery is logged by kind and result, never by
  address. Support access: the owner asks an organisation's administrator for a limited, read-only
  look (1 to 24 hours, with a reason); nothing opens until they approve on their Support access page,
  they can end it at any time, and the view covers only their departments, administrators, overview
  and activity log, never attendee records and never a change. The request, the approval and every
  page opened are written to the organisation's own audit trail.
- Audit chains: each organisation has its own hash chain (the owner has one of their own), so an
  organisation verifies and anchors its own trail and nothing of anyone else's is in it. Entries
  hash their metadata as the database stores it (`hashVersion` 2). Entries from before that
  (version 1) hashed a date inside metadata as an empty object, so they are also accepted with dates
  left out; any other change to them is still caught. A link from an organisation's first entries
  back to an entry now held by another chain (from when there was one chain for everyone) is
  recognised as that old join, not a break.
- Plans and modules: the owner sets each organisation's plan (Pilot, Starter, Standard, Full or
  Custom) at `owner.html`, which switches modules on or off (attendance sheets, payment sheets, door
  scanning, certificates) and sets limits (administrators, events per month). A module that is off is
  refused on the server and left out of the pages; limits stop the next thing, and nothing already
  created is removed. The organisation sees its plan on its overview page.
- Joining: `signup.html` lets an organisation ask to be added. The request needs its email address
  confirmed (a link that works for two days) and then the owner's approval at `owner.html`; nothing is
  created before that. A hidden field catches bots, the form is limited to six requests an hour from
  one place, and it gives the same answer whatever happens, so it cannot reveal which addresses are
  already registered. Approving creates the organisation on the Starter plan and invites the person
  who asked as its first administrator; declining sends them the reason.
- Own web addresses: the owner saves an address for an organisation (for example
  `attend.theirname.go.ke`) and presses Check, which looks up its CNAME record and only then switches
  it on, so nobody can claim an address they do not control. The organisation is then recognised by
  the address a request arrives on: pages and emails use its look, links in its emails and its QR
  codes use its address, and only its own people can sign in there (the owner can anywhere). Setting
  `PLATFORM_DOMAIN` (a domain with a wildcard record) also makes every organisation reachable at
  `<short address>.<that domain>`. The address must also be added on the hosting service, which
  issues its security certificate; that is a manual step there.
- Roles: `OWNER` (the platform operator), `PLATFORM_ADMIN` (shown as "Organisation admin"; an
  organisation's own top account) (departments and their super admins, organisation-wide
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
- Approving a payment sheet: the preparer submits it (which locks it), an authorising officer
  certifies it (the record is sealed and given a code anyone can check on the verify page),
  and finance verifies it. A county admin's `paymentRole` (PREPARER, AUTHORISER, FINANCE) says
  which step they can take; a department super admin can take either. Whoever prepared a
  sheet cannot certify or verify it, and whoever certified it cannot verify it. A reviewer can
  send it back with a note, which reopens it. Reviewers work at `duty-review.html`; people on
  a sheet can see their own days and question a day they were marked absent for at
  `duty-sign.html`.
- Automatic checks (`lib/dutyChecks.js`) run on every payment sheet for the preparer and for the
  approvers: the same person signing the same date on another sheet in the department, one phone
  number registered to different IDs, identical signature images, weekend and public-holiday days
  (fixed holidays and Easter only; moon-dependent ones are not guessed), rates well above the
  group, people added after the start, and many people signing within two minutes. Items that
  need review must be acknowledged to certify or verify; what the approver was shown is recorded
  in the audit trail. Other departments' sheets are never compared.
- The 24-admin cap and one-admin-per-county rule (both per department) are
  enforced by Postgres
  itself (a trigger and a partial unique index), not just application
  code, so they hold even under concurrent requests.
