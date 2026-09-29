# Customer messaging: owner setup and HighLevel checklist

This is the owner's checklist for turning on customer messaging safely. It lists every path that can text or email a customer today, what each one needs in HighLevel (GHL), Quo and Cloudflare, and a dry-run acceptance pass to run before any real customer receives a message from the new approved-send service.

Nothing in this checklist sends anything by itself. The approved-send service stays off (`EGC_MESSAGING_ENABLED` unset) and in dry run (`EGC_MESSAGING_DRY_RUN` unset) until you change those variables.

## 1. What can reach a customer today

| Path | Who starts it | Provider | Safety gates |
| --- | --- | --- | --- |
| Approved-send service (`POST /api/messages`) | Owner/manager preview + confirm, or assigned crew for **On my way** | HighLevel SMS/email | Off unless `EGC_MESSAGING_ENABLED` is exactly `true`. Dry run unless `EGC_MESSAGING_DRY_RUN` is exactly `false`. Only owner-approved template versions send. Denver quiet hours for reminders. One `message_sends` ledger entry per logical message. |
| Hub/crew customer thread (**Send to customer** in a job) | A signed-in manager or assigned crew member typing a message | HighLevel SMS | Recipient is the saved job's HighLevel contact only. Before sending, the contact is re-read and must match the saved job phone and the location, with no DND and no `egc-no-sms-consent` tag. Every send carries an `Idempotency-Key` derived from the message's request id and a 15 second timeout. |
| Client portal replies | The customer | HighLevel internal comment (not a text) | Mirrors the customer's portal message into the HighLevel conversation for staff. Nothing is sent to the customer. |
| Accepted-quote portal invitation | Automatic on a new quote approval | HighLevel SMS or email | See [portal invitations](portal-invitations.md): one per job, DND and `notify: false` respected. |
| Crew pre-job texts (`/api/quo-send`) | Assigned crew or a manager tapping a script in `crew/prejob.html` | Quo (OpenPhone) | Saved job phone only. Crew can send only the two scripts; the server fills the name, address, flat rate, start time (`[TIME]`) and crew size (`[N]`) from the saved job and refuses the text when any of them is missing. The confirmation says "tomorrow", so it is refused unless the job is saved for tomorrow (Denver date). After a refusal the page shows the reason and does not open the phone composer. If Quo itself fails, the page (crew and managers alike) opens the phone's own composer for review only when `[TIME]` and `[N]` could be filled from the loaded job and no placeholder is left; otherwise it shows a note. One server receipt per send key. |
| Crew hook (`/api/crew-hook`) | Business users only | Zapier (`CREW_WEBHOOK_URL`), which may text through Quo | The Zap owns delivery. Crew accounts are refused. |
| Lifecycle tags (`egc-<event>`, e.g. `egc-estimate-ready`) | Hub finance and schedule actions via `/api/highlevel` | HighLevel workflows you built | A job with **Notify customer** off adds no tag. Whatever the tagged workflow sends is outside the Hub's ledger. |
| Sales follow-up exits (`egc-garage-sales-exit`, `egc-junk-sales-exit`) | Accepted/booked/completed jobs | HighLevel tag (no message) | Stops the matching nurture workflow. Other active jobs for the same customer hold the exit for review. |

### Delivery states in the customer thread

| State | Meaning | What to do |
| --- | --- | --- |
| `sent` | HighLevel accepted the text and returned a message id. | Nothing. Carrier delivery is shown in HighLevel. |
| `failed` | HighLevel refused it (a 4xx other than 408), or the contact check could not reach HighLevel. Nothing was sent. | Fix the cause, then send a new message. |
| `uncertain` | Timeout, server error, lost connection or a reply without a message id. HighLevel may have sent it. | Check the HighLevel conversation first. The Hub never resends it automatically; retrying the same request replays the saved state. |
| `suppressed` | The contact has DND on, SMS DND, or the `egc-no-sms-consent` tag. | Do not text. Call, or ask the customer to opt back in. |
| `needs_contact` | No linked contact, no saved phone, or the contact's phone/location does not match the saved job. | Fix the job's phone or its HighLevel link. |
| `not_configured` | `HIGHLEVEL_API_KEY` or `HIGHLEVEL_LOCATION_ID` is missing. | Set both in Cloudflare. |

## 2. HighLevel private integration and scopes

Create one **Private integration** in the EGC sub-account (Settings, Private Integrations) and store its token as the Cloudflare secret `HIGHLEVEL_API_KEY`. Give it only the scopes the Hub calls:

| Scope | Used for |
| --- | --- |
| `contacts.readonly` | Reading the saved contact before every text (identity, DND, consent tag), sales-exit checks. |
| `contacts.write` | Contact upsert from saved job data, lifecycle and sales-exit tags, notes, tasks. |
| `conversations.readonly`, `conversations.write` | Conversation lookups for messages. |
| `conversations/message.readonly`, `conversations/message.write` | `POST /conversations/messages` (SMS, email, internal comments). |
| `opportunities.readonly`, `opportunities.write` | Sales pipeline stage moves, web-lead opportunities, sales-exit verification. |
| `calendars.readonly`, `calendars/events.readonly`, `calendars/events.write` | Walkthrough and job appointments, booked-job verification. |
| `locations.readonly` | Location and pipeline lookups. |

Check the scope names against the Private Integration screen when you create it (HighLevel occasionally renames them). Do not grant payments, workflows, users or SaaS scopes. The Railway platform uses its own token, `GHL_PRIVATE_INTEGRATION_TOKEN`, documented in `egc-platform/.env.example`.

## 3. A2P 10DLC

US carriers block or filter application texts from unregistered numbers.

1. In HighLevel (Settings, Phone Numbers, Trust Center) register the brand (legal name, EIN, address, website `https://easygaragecleaning.com`).
2. Register one campaign for customer care (appointment reminders, arrival updates, estimates and invoices). Use sample messages copied from the approved templates at `/message-templates` and from the two crew scripts, and include the opt-out wording (`Reply STOP to opt out`).
3. Wait for the campaign to show **Approved** before setting `EGC_MESSAGING_DRY_RUN=false`. Until then keep dry run on.
4. The Quo number `QUO_FROM` (default `+19709991818`) needs its own registration in Quo.

## 4. Default SMS number and verified email domain

- **SMS:** HighLevel sends from the location's default number. Set it under Settings, Phone Numbers, and attach it to the approved A2P campaign. The Hub never chooses a from-number for HighLevel texts.
- **Email:** Verify a sending domain (for example `mail.easygaragecleaning.com`) under Settings, Email Services, and add the SPF, DKIM and DMARC records HighLevel lists. Set it as the location default so approved email templates (portal links, invoices) are not sent from a shared domain.
- **Quo:** `QUO_FROM` is the only Quo sender. `QUO_API_BASE` changes only if Quo moves its API host.

## 5. Workflows to disable or modify per message kind

Before you turn on automation for a kind at `/message-templates`, make sure no HighLevel workflow also sends the same message. Otherwise the customer gets two texts.

| Approved-send kind | Legacy trigger that may also send it | Before turning the kind on |
| --- | --- | --- |
| `on_my_way` | Crew pre-job **Send arrival text** (Quo) | Tell crews to use one or the other per job. The arrival text is recorded as `crew-on-the-way` with automation suppressed, so no workflow fires from it. |
| `day_before_reminder` | Workflows on `egc-appointment-reminder`, and the scheduling reminder tags `egc-reminder-<N>d` | Remove the SMS/email steps from those workflows, or stop adding the tags. |
| `invoice_send` | Workflow on `egc-invoice-issued` | Remove its customer message steps. |
| `payment_reminder` | Workflow on `egc-invoice-overdue` | Remove its customer message steps. |
| `deposit_reminder` | None known | Check that no workflow texts deposit reminders. |
| `estimate_expiring` | Workflow on `egc-estimate-expiring` | Remove its customer message steps. |
| `review_request` | Workflow on `egc-review-requested`; the Zap behind `REVIEW_WEBHOOK_URL`; the crew hook `review_request` Zap | Keep exactly one of these sending. |
| `followup_draft` | Garage Quote Follow-Up Sequence (`gc-quote-open`) | Leave the sequence on. Follow-ups are human-approved drafts and are not automated. |
| `crew_assignment`, `crew_unassignment`, `crew_schedule_change` | None (staff messages) | See staff contacts below. |
| `portal_magic_link`, `b2b_invite` | None | Nothing to change. |
| `portal_invitation_adapter` | The existing accepted-quote invitation | Nothing to change. It keeps running as today. |

The two sales-exit helpers (see [HighLevel sales handoff](highlevel-sales-handoff.md)) send nothing and stay on. The sales exit now looks up the customer's other jobs with bounded, exact lookups (CRM contact, Hub customer, normalized phone/email keys, saved phone spellings and email) instead of scanning the whole `jobs` collection. It no longer stops working once there are more than 500 jobs, so importing a large Jobber history does not keep accepted customers in nurture sequences.

A job saved with an unusual phone spelling (`970/555/0123`, a trailing space, a number instead of text) or a differently cased email, and without a shared CRM contact or Hub customer, is found only through the normalized keys `phoneE164`/`emailLower` on the job. Write them with the job contact-key backfill, in a quiet window (each written job gets a new revision, so an editor open on it is asked to refresh):

```sh
node scripts/backfill-job-contact-keys.mjs                      # dry run: counts only, writes nothing
node scripts/backfill-job-contact-keys.mjs --apply --report keys.json
```

It needs `FIREBASE_SERVICE_ACCOUNT_JSON`, writes only those two keys (plus `contactKeysNormalizedAt`) on operational jobs, and a rerun with nothing changed writes nothing. Hub pages and imports do not keep the keys current, so rerun it after a large import. Until then the HighLevel open-opportunity check still holds an exit when another opportunity is open for the contact.

## 6. Marketplace webhook subscription (inbound replies)

Customer replies appear in the Hub thread only when HighLevel posts them to the Hub.

1. In the HighLevel Marketplace app that belongs to EGC, subscribe the **InboundMessage** event.
2. Set the webhook URL to `https://easygaragecleaning.com/api/highlevel-message-event`.
3. The endpoint rejects any request without a valid Ed25519 `X-GHL-Signature`, and any event whose location is not `HIGHLEVEL_LOCATION_ID`. It records SMS and email replies once per HighLevel message id on the newest active job for that contact.

## 7. Staff contacts

`crew_assignment`, `crew_unassignment` and `crew_schedule_change` messages go to crew, not customers.

**Dispatch schedule texts (`EGC_CREW_NOTIFICATIONS_ENABLED`).** With the flag exactly `true`, every dispatch save (and every reschedule or cancellation through the operations bridge) that adds someone to a job, removes them from it or from some of its days or hours, moves their work slot (per assignment segment), cancels it or restores it queues one notice per affected employee in the same commit as the schedule change. The signed messaging cron then sends each employee one text per job for everything that changed since the last text they got about it, however many saves that was (evening edits drained after quiet hours included), through the approved-send core with the owner's automation switch, Denver quiet hours and one `message_sends` entry per notice. What each employee last heard about each job is kept in the server-only `crewNoticeHeard` collection, written in the same commit that closes a notice, so a change that was never texted (no staff contact yet, texts off, HighLevel refusing it) is still in the next text for that job. For a job and employee with no record yet whose notices started before the record existed, the first text reads that job's notice history once to find what they were last told. The wording follows what changed:

- `crew_assignment` for new or changed work only, naming the first new or changed slot (a multi-day slot as a range, such as "Wednesday, September 23 through Friday, September 25") and any other new slots.
- `crew_unassignment` when work was only taken away, naming every day they lost, for example "Thursday, September 24 and Friday, September 25" or "Thursday, September 24, Friday, September 25 and Saturday, September 26" for a shortened job; four or more days in a row read as a range. Losing a segment on a day they still work names the hours, such as "Wednesday, September 23 from 1:00 PM to 5:00 PM".
- `crew_schedule_change` when the same change both moved or added work and took days or hours away (a reschedule to another day, or a new time on one day plus a lost day), so a move never hides a loss: "Now: Wednesday, September 23 (arrival window 10:00 AM). No longer: Thursday, September 24." Its `{{removedDates}}` variable holds the lost days.

The dates are sized to fit one text (320 characters) with the approved wording, the employee's first name, the arrival window and the Hub link: when they would not fit, they read as short dates ("Mon Sep 28, plus Tue Sep 29 and Fri Oct 2"), then name the first few and count the rest ("Wed Sep 23 and 2 more dates"), and a list of days taken away can read as a count alone ("3 dates"). The first new or changed day is always named, since the arrival window is its time. A day is never left out or cut short: the choice that names the most days wins, then the one naming more of the days taken away. When even the counts do not fit (the approved wording is too long), nothing is sent and the notice is closed as `failed` (`messaging_sms_too_long`) on the dispatcher's **Not texted** list; shorten the wording at `/message-templates`, then use **Send again**.

Work that is already over (by its end time in Denver, not just its date) is never texted about. New visits that one recurring-plan run creates are one text per employee: it names the earliest visit, how many more there are and the last one's date ("Thursday, September 24, plus 2 more visits through Thursday, October 8"); visits a dispatcher repeats by hand are texted one by one. The other visits stay queued until that text's outcome is final, stamped with the text before it goes out. The text's `message_sends` entry records which visits it named, and only those close with it, in the same save as it; if that save is lost, the next run closes them from that entry instead of texting them again, and while the text is still being sent they wait (a visit expires meanwhile only once none of its work is still ahead, so a visit with a later day keeps waiting for the text's outcome). A queued visit stamped with the text that a run's plan leaves out (that run saw the text being sent) holds the text back one run so it is grouped again, and a visit a text that went out did not name is texted on its own later instead of being counted into it. A text that is retried, held back by the tick limit or changed first (the earliest visit moved or taken away) names them again, or they are grouped anew on the next run. A text HighLevel did not confirm, or one whose send was still unanswered five minutes after its own notice closed, shows its visits as not confirmed too (listed for dispatchers until their work has passed), and none of them is sent again. Within those five minutes the send can still come back refused (another run may have closed its notice because a newer change for that visit was saved), so its visits keep waiting, and after a refusal they are grouped again and texted; the same wait applies to an older notice whose own text is still being sent. When that text cannot go out (for example no staff contact), its visits are held with it; **Send again** on it queues them too, also when it is closed instead because its own visit changed meanwhile, and once its own day has passed they are listed on their own. Jobs whose crew is still stored by display name (older jobs) are matched to the roster the same way dispatch matches them, so their crew are texted too; while the roster cannot be read such a notice waits for the next run instead of closing. Nothing is sent from a Hub page load. Each employee sees their own notices, clears them and turns schedule texts on or off under **MY EGC → Schedule alerts** (`/api/crew-notifications`).

A text goes only to an employee who turned schedule texts on, only to the mobile number on their approved Employee Hub account (never a job or customer number), and only through the HighLevel **staff contact** a dispatcher linked for that employee. The Hub never creates or updates a HighLevel contact for a crew message, and it refuses a linked contact whose number or location does not match the employee account or that is not tagged `egc-staff`. Configured Hub users (`HUB_AUTH_USERS_JSON`) have no number on file, so their notices end as `needs_contact`.

1. In HighLevel, create one contact per crew member with their own mobile number and the tag `egc-staff`. Keep those contacts out of every customer marketing workflow (filter on the tag), including workflows that start when a contact is created, and never put a staff member's number on a customer job. The platform lead sync still sees every HighLevel contact, so a staff contact can show up in lead reports until that sync learns to skip `egc-staff`.
2. Open **MY EGC → Schedule alerts → Crew texts** as a dispatcher (owner or manager) and use **Link contact** to paste each crew member's HighLevel contact ID. Until it is linked, their notices end as `needs_contact` (`staff_contact_not_linked`).
3. Approve the `crew_assignment`, `crew_unassignment` and `crew_schedule_change` wording at `/message-templates` and switch **Automation** on for all three. A change whose wording is not approved stays queued; for example, reschedules to another day wait until `crew_schedule_change` is approved.
4. Set `EGC_CREW_NOTIFICATIONS_ENABLED=true` in Cloudflare Pages. Delivery also needs `EGC_MESSAGING_ENABLED=true`, `EGC_MESSAGING_DRY_RUN=false` and `EGC_SERVER_MESSAGING_ENABLED=true`. While delivery is a dry run, notices are closed as `dry_run` and never texted later; once delivery is live, the next text for a job covers those changes too, since nothing about them reached the employee.
5. Ask each crew member to open **Schedule alerts** and turn on **Text me when my schedule changes**.

**Crew texts (dispatchers).** The same screen shows each crew member's opt-in and staff-contact link, and a **Not texted** list of notices for upcoming work that closed without a text (`needs_contact`, `not_opted_in`, `failed`, `suppressed` or `uncertain`) with the reason. A notice stays listed until the last day its change reaches, not just its first one, and while any of those days is ahead **Send again** texts what is left. Each card shows what its text says, including days taken away by earlier changes that were never texted, and a notice a later text already told them about says so (or, when they read a later notice for that job in the Hub instead of getting a text, that they read it there: **Read in the Hub**). Each notice keeps the label of the first text or Hub read that covered it, so a later text that never named it does not change **Read in the Hub**. **Send again** queues one again after the cause is fixed; the next messaging run re-checks it against the live schedule. The newest notice for a job and crew member carries the text: it says everything since their last text, so **Send again** on an older one queues the newest instead and closes the older one into it, and one with nothing left to tell (a later text covered it, or the change was undone) is closed as `superseded`, so nobody gets a text they already had. **Send again** on a grouped recurring-run text also queues the visits it stood for. An `uncertain` text is never sent again, and neither is one HighLevel refused three times.

**Accepted visible change while the flag is off.** Every crew and manager login already sees **Schedule alerts** under MY EGC; with the flag off it only says schedule alerts are not turned on, and `/message-templates` lists the `crew_unassignment` and `crew_schedule_change` wording. Nothing is queued, read or sent until the flag is `true`.

Notice states: `pending` (queued, or waiting for a retry after 5, 10, 20 and 40 minutes), `sent`, `uncertain` (never resent), `needs_contact`, `not_opted_in`, `suppressed`, `failed`, `batched` (covered by one text for a recurring run), `superseded` (a newer notice's text covered it, a newer notice replaced it before **Send again**, or the changes cancelled out before anything was texted), `stale` (the job changed again without a notice), `skipped` (the employee already cleared it) and `expired` (the work is over).

## 8. Template approval walkthrough

1. Sign in to the Employee Hub as the owner (`zacb`) and open `/message-templates`.
2. Each kind starts from an unapproved default. A manager may edit a draft (**Save draft**); only the owner can approve wording.
3. Read the rendered preview, including the SMS length, then **Approve**. The approval is bound to the exact text (a hash). Editing it later creates a new draft that must be approved again.
4. For reminder kinds, **Automation** can be switched on only after a version is approved. Leave it off until section 5 is done for that kind.
5. **Retire** removes a version from use. Retiring the active version also turns automation off.
6. A send always uses the approved version at the moment of the confirmed preview. If the wording changed in between, the send is refused and must be previewed again.

## 9. Environment variables

Cloudflare Pages (Production and Preview), all documented in `.env.example` and `docs/env-inventory.md`:

| Variable | Kind | Used by |
| --- | --- | --- |
| `HIGHLEVEL_API_KEY` (alias `GHL_API_KEY`) | secret | Every HighLevel call: thread texts, approved sends, portal invitations, sales exits. |
| `HIGHLEVEL_LOCATION_ID` (alias `GHL_LOCATION_ID`) | plain | Contact verification. Thread texts now report `not_configured` without it. |
| `HIGHLEVEL_USER_ID` (alias `GHL_USER_ID`) | plain | Assigns thread messages and notes to a HighLevel user. |
| `HIGHLEVEL_PIPELINE_ID` (alias `GHL_PIPELINE_ID`) | plain | Pipeline the sales exit verifies. |
| `EGC_MESSAGING_ENABLED` | plain | Exactly `true` turns on `/api/messages` and template management. |
| `EGC_MESSAGING_DRY_RUN` | plain | Only exactly `false` sends; anything else records `dry_run` ledger entries. |
| `EGC_MESSAGING_SUBREQUEST_BUDGET` | plain | Worker subrequest budget per `/api/messages` call. |
| `HUB_SESSION_SECRET` | secret | Signs Hub sessions and the preview confirm tokens. |
| `QUO_API_KEY` (alias `QUO`) | secret | Crew pre-job texts. |
| `QUO_FROM` | plain | Quo sender number. |
| `QUO_API_BASE` | plain | Quo API host override. |
| `CREW_WEBHOOK_URL` | secret | Business-only crew hook to Zapier. |
| `EGC_JOBBER_GUARD_BOOKING` | plain | Exactly `true` (FUN-32): from the Jobber cutover day on, the crew hook refuses `game_plan`, whose Zap branch creates a Jobber job. A backstop for old cached crew pages only: disable that Zap branch and uninstall the Official Jobber Integration (Jobber cutover section 8). See [Jobber cutover section 10](JOBBER-CUTOVER.md). |
| `EGC_JOBBER_GUARD_BILLING` | plain | Exactly `true` (FUN-32): from the Jobber cutover day on, the messaging cron holds deposit and payment reminders (reason `jobber_guard_billing`) for a customer the saved Jobber guard check shows with an open Jobber bill. |
| `EGC_JOBBER_GUARD_MESSAGING` | plain | Exactly `true` (FUN-32): from the Jobber cutover day on, the messaging cron holds automatic reminders (reason `jobber_guard_messaging`) for a customer Jobber may still be messaging about open work or an open invoice. Turn it on only if Jobber's own messages cannot be fully turned off, or after the imported visits are removed from Jobber; otherwise it can hold every imported customer's reminders (Jobber cutover section 10.4). |

**Railway (messaging cron):** this build has no scheduled messaging job on Railway, so automated reminders (`owner_automation`) cannot run yet even when a kind's automation switch is on. When the signed messaging cron ships, its variables will be listed in `egc-platform/.env.example` and `docs/env-inventory.md`; it reaches the Hub through the existing operations bridge (`EGC_OPERATIONS_ENABLED`, `EGC_OPERATIONS_API_ORIGIN`, `EGC_OPERATIONS_SERVICE_AUTH`, `API_BEARER_TOKEN`). Keep `EGC_MESSAGING_DRY_RUN` unset while you first run it.

## 10. Dry-run acceptance script

Run these in order. Stop at the first surprise.

**A. Synthetic checks (no provider, no real clock).**

```sh
node --test tests/legacy-send-hardening.test.mjs tests/customer-messaging.test.mjs tests/ghl-messenger.test.mjs \
  tests/approved-send.test.mjs tests/quo-send-idempotency.test.mjs tests/sales-followup-exit.test.mjs tests/portal-invitation.test.mjs \
  tests/job-contact-keys-backfill.test.mjs
```

The Firestore rules that keep the messaging ledgers (`message_sends`, `message_templates`, `message_operations`) server-only can be checked on a private emulator with its own free ports: `EGC_FIREBASE_EMULATOR_TEST=1 node scripts/emulator-exec.mjs --project demo-egc-messaging 'node --test tests/firestore-emulator.test.mjs'`.

**B. Test contacts in HighLevel.** Create two contacts you control, labelled `EGC MESSAGING TEST`: one with your own mobile number and email, and one with DND on for all channels. Create one Hub test job for each (type `job`, dated tomorrow, a start time and crew size, saved phone equal to the contact's phone) and link each to its contact.

**C. Dry run in production.** Set `EGC_MESSAGING_ENABLED=true` and leave `EGC_MESSAGING_DRY_RUN` unset, then redeploy.

1. Approve one template (for example `on_my_way`) at `/message-templates`.
2. Preview and confirm it for the first test job. Expect a `dry_run` ledger result and no HighLevel conversation entry.
3. Repeat for the DND job. Expect `suppressed` before any send.
4. From the first test job's **Customer thread**, send yourself a message. Expect `sent` and a HighLevel message. Send one from the DND job's thread: expect **Not texted · customer opted out** and no HighLevel message.
5. On the crew pre-job page for the first test job, tap **Send confirmation text** twice. Expect one text with the real start time and crew size, and **Already sent** on the second tap. Remove the start time from the job, reload the page and tap again: the page shows "no saved start time or crew size", no Quo text is sent and the phone composer does not open, on a crew login and on a manager login. Put the start time back and move the job two days out: tapping again shows "not saved for tomorrow" and nothing is sent. Set the date back to tomorrow afterwards.
6. Accept a quote on the first test job and confirm the sales exit reports `signalled`, or `needs_review` if another test job for the same contact is still open.

**D. Go live.** After the A2P campaign is approved and the workflows in section 5 are adjusted, set `EGC_MESSAGING_DRY_RUN=false` and redeploy. Repeat step C.2 once for the first test job only and check the text on your phone. Delete nothing afterwards: the ledgers are the audit trail.
