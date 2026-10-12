# Konza Sajili vs this project: gap analysis and roadmap

Written for: the product owner deciding what to build next.

## What I could verify about Sajili

Public sources are thin. The landing page lists Venues, Meetings, Activities (defined by start and end date) and phone signatures, plus a Play Store app. An [MMUST ICT report](https://ict.mmust.ac.ke/?p=10885) adds biometric thumb signatures, scheduling and reporting dashboards. Everything else below comes from your four screenshots: an Activities list with QR and Share buttons per row, an activity page whose sheet has one signature column per date (02/10, 03/10, 04/10), Created By / Updated By / Created At, and a Print button. I could not log in, so I can't say how Sajili handles identity on day 2, offline use, or tamper evidence. Treat those as unknown.

## Where this project already beats Sajili (as far as visible)

| Area | Sajili | This project |
|---|---|---|
| Tamper evidence | none visible | hash-chained audit log plus public sheet seals with a verify page |
| Duplicate control | none visible | one phone / email / device per event, enforced by the database |
| Consent | none visible | explicit photo/video consent, Kenya DPA aware |
| Lifecycle | delete button | flag, retire, reopen, all audited |
| Access | account needed to view | roster sealed from the public link, kiosk mode |
| Offline | none visible | service worker, queued submissions |

## Gaps found in this codebase

1. **Admins could not create a multi-day event.** Day signing, per-day columns and seals all existed, but the create and edit routes only ever wrote day 1. Fixed in this change.
2. **A person arriving on day 2 was signed in as day 1.** The first sign-in always used position 1. Fixed: it now uses the open day.
3. **Editing your details after day 2 added a forged day-1 signature.** Self-edit and signature-recovery upserted onto day 1. Fixed: they replace the earliest day you actually signed.
4. **Day 2 only works on the same device.** The `clientId` stays in one browser. A phone swap, cleared storage or a shared tablet locks the person out. Not fixed yet (see roadmap).
5. **Sealing asks which day with a `prompt()` box**, and one seal covers one day. Konza prints one sheet for the whole activity.
6. **No admin way to reopen a closed day**, which the spec promised.

## What changed

- `POST/PUT /api/admin/events` accept an optional `days` list (max 31, ordered, no overlap). Event start and end are derived from it.
- Editing a schedule can't drop a day that has signatures or a seal; it returns the count.
- The admin form shows a "Daily sessions" builder with a chip per day once the end date is after the start date.
- The event list shows a "N days" badge. Printed day cells carry a date caption.
- Service worker cache bumped to v5. 8 tests cover the schedule and day-picking rules.

## Roadmap, in order of value

1. **Returning-attendee check-in on any device.** Phone number plus a masked name confirmation ("Hello E*** C***, is this you?"), recorded on the signature as method PHONE with an audit entry. Stronger than a paper sheet, which verifies nothing. Add an emailed or on-screen personal pass QR for a one-tap path.
2. **Door mode.** Organiser scans attendee passes with the phone camera; each scan writes that day's check-in. Fast queues, no signing on a small screen.
3. **One seal per event, covering every day**, with a day picker instead of `prompt()`. Verify page shows each day's counts.
4. **Reopen a closed day** from the dashboard, audited.
5. **Live day board** on the event page: who is in today, who missed day 1 but came day 2, attendance per day as a small chart.
6. **Phase 2 integrity:** publish the audit chain head daily somewhere the app can't write to.

Decision for you: item 1 trades a little identity strength (a phone number can be guessed) for not locking people out. I'd accept it with the audit flag and a rate limit; say if you'd rather require an SMS code, which needs a paid provider.
