# EGC CRM and automation ownership

HighLevel is the only CRM source of record for Easy Garage Cleaning. The EGC Hub owns scheduling, field execution, crew assignments, job instructions, checklist progress, proof photos, and closeout records. Customer/contact history and customer-facing CRM workflows synchronize to HighLevel.

## Active lead path

- Website quote forms submit to `/api/web-lead`.
- `/api/web-lead` upserts the HighLevel contact and creates or reuses the lead opportunity.
- Optional automation relays may run after the HighLevel write, but they are not the CRM record.
- The Hub lead feed reads only HighLevel opportunities created after the configured reset cutoff.

## Retired Firebase CRM paths

`/api/lead-intake` and `/api/sms-event` return HTTP 410 and do not write records. Any old Zapier jobs aimed at those URLs should be turned off or rebuilt directly in HighLevel.

Do not restore a Firestore `leads` collection as a second CRM. Firestore remains the operational store for Hub jobs, schedules, walkthrough handoffs, checklists, crew availability, and field completion data.

## Communication safety

- HighLevel owns lead follow-up, booking confirmations, and reminder workflows.
- Quo may send deliberate field messages such as an arrival text from the Hub.
- A customer-facing send should be retry-safe and should write a silent HighLevel note so the CRM timeline stays complete.
- Opt-out and consent state must be respected in HighLevel before any automated text or email is sent.

## Current external configuration

- `HIGHLEVEL_API_KEY` or `GHL_API_KEY`
- `HIGHLEVEL_LOCATION_ID` or `GHL_LOCATION_ID`
- HighLevel pipeline/stage IDs where exact workflow placement is required
- Quo credentials for direct field texting
- Optional workflow webhook URLs for confirmations, reminders, reviews, and reporting
