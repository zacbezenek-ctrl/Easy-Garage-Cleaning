# Go-live runbook: switching the EGC Hub on

**For:** the owner. **Checked against:** the code on the integration branch at `33aff4d` (unit GO-LIVE).

Everything built so far is merged, but every new feature ships **switched off**. Nothing changes for the business until you turn a switch on. This page says what to switch on, in what order, how to check it from your phone, and how to switch it back off.

The one-page tick list is [OWNER-GO-LIVE-CHECKLIST.md](OWNER-GO-LIVE-CHECKLIST.md).

## Contents

- [The HighLevel rule](#the-highlevel-rule)
- [How to use this page](#how-to-use-this-page)
- [Before anything](#before-anything)
- [Stage 1: Safe security switches](#stage-1-safe-security-switches)
- [Stage 2: Leads into HighLevel](#stage-2-leads-into-highlevel)
- [Stage 3: Walkthroughs](#stage-3-walkthroughs)
- [Stage 4: Crew scheduling and the field day](#stage-4-crew-scheduling-and-the-field-day)
- [Stage 5: Money](#stage-5-money)
- [Stage 6: Customer portal and business client hub](#stage-6-customer-portal-and-business-client-hub)
- [Stage 7: Claude and ChatGPT (MCP)](#stage-7-claude-and-chatgpt-mcp)
- [Optional: only if you want the Hub to send through HighLevel](#optional-only-if-you-want-the-hub-to-send-through-highlevel)
- [Leave these off for now](#leave-these-off-for-now)
- [Owner decisions](#owner-decisions)
- [If something goes wrong](#if-something-goes-wrong)
- [Coming in the next batch](#coming-in-the-next-batch)

## The HighLevel rule

Your rule: **HighLevel sends every customer message and owns every follow-up. The Hub only tracks.**

What that means for this runbook:

- Stages 1 to 7 turn on tracking, scheduling, field work, money records, the portal and AI read access. None of them makes the Hub write texts or emails to customers.
- Customers keep hearing from your HighLevel workflows. The Hub starts them the way it does today, with tags and appointments such as `egc-walkthrough-scheduled`, `egc-job-scheduled`, `egc-reminder-2d`, `egc-job-complete` and `egc-review-ready`.
- The switches that would let the Hub write customer messages itself are listed under [Optional](#optional-only-if-you-want-the-hub-to-send-through-highlevel). Leave them off unless you decide otherwise.
- HighLevel keeps the 6-month garage check-in and the unanswered-text follow-ups. The platform's own copies are opt-in on Railway (`EGC_OPERATIONS_CHECKIN_TASKS_ENABLED`, `EGC_OPERATIONS_INBOUND_TASKS_ENABLED`) and stay off, and a messaging dry run never writes to HighLevel. [HIGHLEVEL-BOUNDARY.md](HIGHLEVEL-BOUNDARY.md) lists every path that writes to HighLevel or messages a customer.
- A few customer messages skip HighLevel today (Quo, EmailJS, Zapier, Stripe). They are in [Owner decisions](#owner-decisions), with the recommended move into HighLevel.

## How to use this page

### Where the switches live

| Place | How to get there | Notes |
| --- | --- | --- |
| Cloudflare Pages | Cloudflare → Workers & Pages → the site project → Settings → Variables and Secrets | Two lists: **Preview** and **Production**. "Plain" is a variable; "secret" is encrypted. |
| Railway | Railway → EGC project → service (egc-api, egc-mcp, egc-worker) → Variables | Apply the change; the service redeploys. |
| Firebase | Firebase console, project `egcw-1ec83` | Rules and indexes are published with the Firebase CLI ([B4](#b4-publish-firestore-rules-and-indexes)). |

### After every Cloudflare change

A Cloudflare variable only reaches deployments built after you save it. After each change: **Deployments → latest deployment → ⋯ → Retry deployment**. Wait for "Success", then check.

### Preview first, then Production

1. Set the variable under **Preview** and retry the latest preview deployment.
2. Check it on the preview link (the `…pages.dev` address on that deployment).
3. Set the same value under **Production** and retry the production deployment.
4. Check it again on easygaragecleaning.com.

Preview uses the same live database as Production. Test with test customers only.

### Off means unset

A switch is off unless it holds exactly the value shown (almost always `true`). To switch one off, delete the variable and retry the deployment. The few exceptions say so on their card.

## Before anything

Do B1 to B6 once, in order, before Stage 1.

### B1. Merge and deploy one commit everywhere

1. **Before you merge, in Zapier:** open the Zap behind `WEBSITE_LEAD_HOOK_URL` and map the new `inquiry_id` field to the Meta Conversions API Lead **event_id** (dataset `970332989051988`). Without it, book-page leads who agreed to texts are counted twice in Meta from the day this deploys.
2. Merge the integration pull request into `main`. Cloudflare Pages deploys the Hub by itself.
3. Deploy the **same commit** to Railway: egc-api, egc-mcp, egc-worker and egc-portal. The steps are in `egc-platform/docs/railway-deployment.md` (set `EGC_RELEASE_SHA` to the merged commit, then confirm each deployment shows that commit). The Hub and Railway must run the same commit, because each side refuses the other's older signed messages. The database updates (migrations 0013 and 0014) run by themselves before the new API and MCP start.
4. Hard-refresh the Hub on office computers, and every crew iPad or phone that had a crew page open.

**Check it worked (phone):**

1. Open easygaragecleaning.com/employee and sign in.
2. Open `https://egc-api-production-faeb.up.railway.app/health`. It shows `"ok":true` and a `"release"` equal to the merged commit.
3. Ask a crew member and a manager to open their schedules, and the crew member to clock in and out. All work. (If clock-in fails with an index error, see [If something goes wrong](#if-something-goes-wrong).)
4. On the public site, the menu button opens and closes on your phone.

**Developer checks (before and just after merging):**

- CI is green on the integration branch, including migration 0013 in the operations-integration and Action Center workflows.
- If the first version of migration 0014 (MCP-OAUTH) was ever applied to a database, add its missing columns or re-create its empty tables before deploying.
- After deploy: `/api/pricing-config` answers 200 for the owner and 403 for crew; `/business-hub`, `/dispatch` and `/hub-login-setup` load no `analytics-loader.js`; `/crew/sw.js` is served with `Service-Worker-Allowed: /crew/`.
- Make the "EGC Root CI" checks required on `main` (GitHub branch protection).

**Roll back:** see [If something goes wrong](#if-something-goes-wrong). Rolling code back is a last resort.

### B2. Move Cloudflare to Workers Paid ($5 a month)

- **Where:** Cloudflare → Workers & Pages → Plans → **Workers Paid** (Standard usage model).
- **Why:** the free plan gives each request 10 ms of computer time. A cold start alone uses about 18 ms and the catalog up to 32 ms, so on Free the Hub fails at random with **Error 1102**.
- **Check it worked:** the plan page says Workers Paid, and no one sees Error 1102 for a day.
- **Roll back:** not recommended.

### B3. Secrets to set first

Make each random value with your password manager (40 or more random characters) and keep a copy there: Cloudflare never shows a secret again. Set Cloudflare secrets under **both Production and Preview**.

| Secret | Where | What to do |
| --- | --- | --- |
| `HUB_SESSION_SECRET` | Cloudflare secret | Confirm it is set and 32+ characters. Never change it (warning below). |
| `HUB_PURPOSE_KEY_SECRET` | Cloudflare secret | Add a new random value (32+). Set it once, then leave it. |
| `EMPLOYEE_HUB_DATA_SECRET` | Cloudflare secret | Confirm it is set. It unlocks timecards and staff records. Never change it. |
| `API_BEARER_TOKEN` | Railway egc-api | Random, 32+. The Railway root of the signed bridge. |
| `EGC_OPERATIONS_MCP_SIGNING_SECRET` | Railway egc-api and egc-mcp | The same random value on both, 32+. |
| `EGC_OPERATIONS_PORTAL_SIGNING_SECRET` | Cloudflare secret and Railway egc-api | Only the older (legacy) signing mode uses it. With v2 (B5) you need not add it; if it is already set, keep the two values matched. |

Also confirm these existing ones are set in Production. **Hub → Integrations** shows each as ready: `FIREBASE_SERVICE_ACCOUNT_JSON`, `HIGHLEVEL_API_KEY`, `HIGHLEVEL_LOCATION_ID`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`.

> **Never change `HUB_SESSION_SECRET` on your own.** It signs every staff sign-in, customer portal links (unless `CUSTOMER_PORTAL_SECRET` is set) and AI connections, and it is the timecard key if `EMPLOYEE_HUB_DATA_SECRET` was never set. Changing it signs everyone out, breaks every portal link and AI connection, and can make staff records unreadable. If it ever must change, do it with a developer and `docs/employee-hub-recovery.md`.

**Check it worked (phone):**

1. Open `https://easygaragecleaning.com/api/operations-service-keys`. It starts `{"protocol":"egc-service-auth-v2"`, which means `HUB_SESSION_SECRET` is long enough. `service_signing_not_configured` means it is too short (or the bridge is switched off on Cloudflare).
2. Sign out of the Hub and back in.

**Roll back:** before Stage 2 you can delete `HUB_PURPOSE_KEY_SECRET` with no harm. After Stage 2, never change or delete it while a website lead is waiting to sync: that lead becomes unreadable.

### B4. Publish Firestore rules and indexes

A Cloudflare deploy does not publish database rules. Right after B1 goes live, have your developer (or Claude Code) run this from the repository at the merged commit:

```sh
firebase login
firebase deploy --only firestore:rules,firestore:indexes --project egcw-1ec83
```

Without the Firebase CLI installed, use `npx firebase-tools@15.30.2` in place of `firebase`.

The rules keep every new server-only record (audit log, money receipts, website-lead receipts, message ledgers, review queues and more) closed to browsers, and make imported Jobber history read-only. After publishing, ask everyone to reload open Hub pages: a page opened before the publish cannot save its audit notes until it reloads.

**Which indexes each feature needs:**

| Feature | Index | How |
| --- | --- | --- |
| Funnel tracking events and the AI funnel reads | Six `funnelEvents` indexes: (type, denverDate), (projectId, occurredAt), (jobId, occurredAt), (type, recordedAt), (walkthroughId, occurredAt), (highlevelContactId, occurredAt) | The command above (`firestore.indexes.json`) |
| Field-cost totals by date ([4.5](#45-field-costs)) | Single-field exemption: collection group `fieldExpenses`, field `incurredOn`, collection-group scope, Ascending | Firebase console → Firestore → Indexes → Single field → Add exemption |
| Audit log with filters (`/api/hub-audit?entity=…`) | The one Firestore asks for | Create it if a filtered read answers `hub_audit_unavailable` |
| Business hub sign-in clean-up | Keep the automatic index on `business_sessions.expiresAt` | Do **not** add an exemption |

Everything else (timecards, website-lead retries) uses Firestore's automatic indexes.

Optional tidy-ups later (they save storage; nothing breaks without them): time-to-live policies on `dispatchTravelCache.expiresAt` and `business_sessions.expiresAt`, and single-field exemptions for `hub_audit.before`, `hub_audit.after` and `hub_audit.reason`.

**Check it worked:**

1. Firebase console → Firestore → Rules shows today as the last publish.
2. Firestore → Indexes: the six `funnelEvents` indexes say **Enabled** (building can take a few minutes).
3. As a manager, save a schedule change in the Hub. It saves.

**Roll back:** re-publish the previous rules version (the Rules tab keeps a history). Leave the indexes in place.

### B5. Railway platform and the signed bridge

The Hub and the Railway platform talk over a signed "bridge". Voice recordings, AI assistant access, the overdue widget and website-lead retries all use it. The Hub side turns itself on when `HUB_SESSION_SECRET` is 32+ characters, so on Cloudflare leave `EGC_OPERATIONS_ENABLED`, `EGC_OPERATIONS_SERVICE_AUTH` and `EGC_OPERATIONS_API_ORIGIN` unset.

**Set on Railway:**

| Service | Variable | Value |
| --- | --- | --- |
| egc-api | `EGC_OPERATIONS_ENABLED` | `true` |
| egc-api | `EGC_OPERATIONS_SERVICE_AUTH` | `v2` |
| egc-api | `EGC_PORTAL_ORIGIN` | `https://easygaragecleaning.com` |
| egc-api | `GHL_WALKTHROUGH_CALENDAR_ID`, `GHL_JOBS_CALENDAR_ID` | Your two HighLevel calendar ids |
| egc-mcp | `EGC_OPERATIONS_ENABLED` | `true` |
| egc-mcp | `EGC_OPERATIONS_API_ORIGIN` | `https://egc-api-production-faeb.up.railway.app` |

Plus, on egc-api: the B3 secrets, `OPENAI_API_KEY`, `STORAGE_DRIVER=filesystem` and `STORAGE_PATH=/data/egc`. `EGC_OPERATIONS_WORKSPACE` stays `egc` everywhere.

**HighLevel rule, on Cloudflare (Production and Preview):**

| Variable | Value | Why |
| --- | --- | --- |
| `EGC_OPERATIONS_INBOUND_REPLY_MINUTES` | `off` | With the bridge on, the platform otherwise opens a Hub task for every unanswered customer text. HighLevel owns follow-ups, so switch that rule off. Any value that is not a whole number from 5 to 10080 switches it off. |

**The 6-month check-in stays in HighLevel.** Once the bridge is on, each verified field completion creates the HighLevel task "6-month garage check-in" (read back first, so never twice). Check that no HighLevel workflow triggered by **Task Added** reacts to it in a way you do not want. Leave `EGC_OPERATIONS_CHECKIN_TASKS_ENABLED` unset on egc-api, so the platform adds no second check-in. Every path that writes to HighLevel is listed in [HIGHLEVEL-BOUNDARY.md](HIGHLEVEL-BOUNDARY.md).

**Check it worked (phone):**

1. `https://egc-api-production-faeb.up.railway.app/health` shows `"operationsEnabled":true`.
2. `https://egc-api-production-faeb.up.railway.app/operations/service-keys` starts `{"protocol":"egc-service-auth-v2"`.
3. Book a test visit in the Hub for a test contact that is you (your own phone and email), so anything HighLevel sends reaches only you. Keep the Hub open as a manager; within a minute or two the visit appears on the HighLevel calendar.

**Roll back:** set `EGC_OPERATIONS_ENABLED=false` on egc-api, egc-mcp **and** Cloudflare Pages (then retry the deployment). The Hub then writes schedules and notes straight to HighLevel, as before. A job completed in the crew app then gets no 6-month check-in in any system (its internal handoff shows blocked until the bridge is back and it is retried); only a retried older closeout still adds the HighLevel task. Recordings, AI assistant Hub access and lead retries stop. Delete `EGC_OPERATIONS_INBOUND_REPLY_MINUTES` to bring back the 60-minute reply rule.

### B6. Stripe: webhook events and the live key

Card payments already work; this build records them more carefully, so Stripe must be set up fully.

1. Stripe → Developers → Webhooks → the endpoint `https://easygaragecleaning.com/api/stripe-webhook`. It must send `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `invoice.paid`, `invoice.payment_failed` and `customer.subscription.deleted`.
2. `STRIPE_SECRET_KEY` in Cloudflare Production must be your **live** secret key (or a restricted live key that can read Checkout Sessions and Charges). The webhook now reads every card payment back from Stripe; without the key it answers 503 and Stripe keeps retrying.

**Check it worked:**

1. Stripe → the webhook endpoint → recent deliveries show 200.
2. A job paid by card after the deploy shows a receipt link on its payment.

**Roll back:** nothing to roll back.

### What changes on deploy (no switch)

Tell the team:

- **Dispatch** has Month and Lanes views. Moving a visit asks why and who asked. New visits ask how they were booked. Jobs get a **No-show** button from one hour before the start; it does not message the customer or change the HighLevel appointment.
- **Crew app** (`/crew/`) can be added to the home screen and works offline. Photos upload by themselves and survive weak signal. Signing out deletes photos that have not uploaded yet, so reconnect first.
- **Crew confirmation texts** (Quo) go only the day before the job, and only with a saved start time and crew size.
- **Walkthrough prices** now load from the Hub. Reps must open the walkthrough online once after each price change.
- **Managers** no longer see other employees' pay on the Team roster and timecards. Hours and approvals stay.
- **Review queues** (owners and managers) list held card charges, Garage Guard member matches and customer messages whose delivery is unknown. The Command Center shows a "Needs your review" alert.
- **Saving over someone else's change** now says "someone changed this, reload" instead of retrying forever.
- The Hub page can record walkthrough audio (the microphone is allowed on `/employee`).
- **Location is taken once, at clock-in** (owner decision, CREW-TIME). The Hub and the crew app read the phone's position only as a shift starts; nothing tracks it during the shift once every open Hub tab has been reloaded after the deploy. The clock card says "Location shared once at clock-in". See [4.9](#49-clock-in-location-once-no-switch).
- **Time labels are honest.** The Hub clock card, My pay, timesheet rows and the payroll CSV name each job's work and travel; "General company time" means only time on no job. A shift whose job segments need a manager's review (a manager moved its clock-in later than its first segment, say) reads "Job time needs manager review" in the Hub and in the payroll CSV's Job time column; it is not a review flag and changes no hours or pay.
- **Timesheet files changed (re-map imports before the first payroll).** The payroll CSV has a new last column, Job time. Every hour and pay column is unchanged. The Hub's own timesheet **Download CSV** and **Download for Gusto** (Smart Import) buttons are gone with TIME-CORRECT (they added hours up on the device). GUSTO-EXPORT replaces the Gusto file: **Download Gusto hours** on the payroll week card (owner only) gives one row per employee, keyed by the Gusto employee ID you set in the staff directory, with regular, overtime, double-time and paid time off hours. Download Gusto's hours-import template once and confirm its headers match before the first import. See [4.7](#47-timesheets-and-payroll).
- **Invoice and overdue messages stay with HighLevel (M5-SEND).** An earlier messaging checklist told you to remove the customer message steps from the `egc-invoice-issued` and `egc-invoice-overdue` workflows when turning on the Hub's `invoice_send` and `payment_reminder` kinds. Those kinds are removed in this build. If you removed those steps, **restore them before you deploy**, or customers get no invoice message and no overdue reminder. Saved `invoice_send` and `payment_reminder` wording and automation switches at `/message-templates` no longer do anything.

## Stage 1: Safe security switches

These harden the Hub without changing anyone's workflow. Do each in **Preview first, then Production**.

| # | Set | Where |
| --- | --- | --- |
| 1.1 | `EGC_STAFF_PAGE_GATE=on` | Cloudflare, plain |
| 1.2 | `EGC_STAFF_PAY_OWNER_ONLY` stays unset | Cloudflare, plain |
| 1.3 | Security steps with no switch | Cloudflare, Google Cloud, Zapier |

### 1.1 Lock the staff pages

- **Set:** `EGC_STAFF_PAGE_GATE=on`. `true` works the same, in any case and with spaces around it ignored (`TRUE`, for example). Any other value leaves the staff pages public, and Hub → Integrations names that value so you can correct it.
- **Where:** Cloudflare Pages, plain variable. Preview first, then Production.
- **Turns on:** staff pages and scripts (the Hub, Dispatch, the crew job tools, message templates) need a Hub sign-in; signed-out visitors go to `/staff-login` (or `/crew/` for crew tools).
- **Needs first:**
  1. `HUB_SESSION_SECRET` set in Preview and Production ([B3](#b3-secrets-to-set-first)). The gate checks every staff page against a Hub sign-in, so without it nobody gets past the sign-in page.
  2. Preview deployments behind Cloudflare Access, and older deployments deleted ([1.3](#13-security-steps-with-no-switch)). They keep serving the old, unlocked files.
- **Check it worked (phone):**
  1. In a private browser tab, open `/employee`. You land on the staff sign-in page.
  2. In the same private tab, open `/employee-suite.js`. You get the sign-in page, not code.
  3. A crew member signs in at `/crew/`, opens a job, turns on airplane mode and reloads: Today's work still loads.
- **In Preview:** also sign in as a crew account and a manager, open the Hub, Dispatch, a game plan and a crew job, and watch the Preview logs for 401 errors. Note any before switching Production on.
- **Roll back:** set `EGC_STAFF_PAGE_GATE=off` and retry the deployment. No code change.

### 1.2 Keep pay owner-only

- **Set:** nothing. `EGC_STAFF_PAY_OWNER_ONLY` unset already means only you see and change other employees' pay in the Hub roster and timecards.
- **Where:** Cloudflare Pages, plain variable (only if you ever need the exception below).
- **Turns on:** already on at deploy. Managers keep hours and approvals; everyone sees their own pay.
- **Exception:** `EGC_STAFF_PAY_OWNER_ONLY=false` gives every business user pay access again. Use it only if managers must set pay.
- **Known gap:** the weekly timesheet API and payroll CSV still show pay to managers until PAY-TIMESHEETS lands ([next batch](#coming-in-the-next-batch)).
- **Check it worked (phone):**
  1. Sign in as a manager and open the Team roster. Other people show hours, not pay rates.
  2. Sign in as yourself. You see everyone's pay.
- **Roll back:** set `EGC_STAFF_PAY_OWNER_ONLY=false` and retry the deployment.

### 1.3 Security steps with no switch

1. **Cloudflare Access on previews.** Pages project → Settings → turn on the access policy for preview deployments. Why: every preview link otherwise serves staff files without a sign-in.
2. **Delete old deployments** made before 1.1 went live (Deployments list). They still serve staff files with no check.
3. **Firebase sign-out on staff changes.** Google Cloud → IAM → give the Firebase service account the **Firebase Authentication Admin** role. Check: Hub → Integrations → "Firebase sign-out" no longer says Needs setup. After removing someone from the staff list, open the Hub on easygaragecleaning.com as a manager so their sign-out runs.
4. **Your own Hub password.** Change it if you have not since the old login page; an old unsalted hash of it is still in the code history.
5. **Crew Zapier hook.** Rotate the hook behind `CREW_WEBHOOK_URL` in Zapier (the original URL once shipped in page source), save the new one as the secret, retry the deployment.
6. **Private files hidden.** On your phone these must show "not found": `/functions/_middleware.js`, `/egc-platform/package.json`, `/firebase.emulator.json`, `/functions/_data/garage-catalog.json`, `/functions/_lib/pricing-config.js`. `/crew/hub-auth.js` must still load.
7. **AI safety defaults.** On Railway egc-mcp, `MCP_BEARER_WRITE_ENABLED` and `EGC_MCP_DIRECT_SENDS_ENABLED` must not be set.

## Stage 2: Leads into HighLevel

Every website lead already goes to HighLevel. Stage 2 makes that durable (nothing lost when HighLevel hiccups), adds lead tracking, and lets the ads landing page feed HighLevel too.

| # | Set | Where |
| --- | --- | --- |
| 2.1 | `WEB_LEAD_RECEIPTS_ENABLED=true` | Cloudflare, plain |
| 2.2 | `WEB_LEAD_ADS_RELAY_ENABLED=true` | Cloudflare, plain |
| 2.3 | `WEB_LEAD_DELAYED_SYNC_TAG=true` (optional) | Cloudflare, plain |

### Before Stage 2

- `HUB_PURPOSE_KEY_SECRET` is set ([B3](#b3-secrets-to-set-first)) and the rules are published ([B4](#b4-publish-firestore-rules-and-indexes)).
- **The opportunity-search check** (a read; nothing changes). Give a test contact one open and one closed (won or lost) opportunity in your lead pipeline. Then ask your developer, or Claude with the HighLevel connector, to call HighLevel `GET /opportunities/search` with `locationId`, `contactId` (the test contact), `pipelineId`, `status=all`, `limit=100`, `page=1`. The answer must list only that contact's opportunities, **including the closed one**. If the closed one is missing, keep 2.1 off and report it: a late sync could reopen a closed deal at New Lead.
- The full owner checklist for this unit is in [FUNNEL-METRICS.md](FUNNEL-METRICS.md#111-unit-scopes) under FUN-13.

### 2.1 Durable website leads

- **Set:** `WEB_LEAD_RECEIPTS_ENABLED=true`
- **Where:** Cloudflare Pages, plain. Preview first, then Production.
- **Turns on:** every website lead is saved in a private ledger (with a lead-tracking event) before it goes to HighLevel, so a HighLevel failure is kept for retry instead of living only in the Web3Forms email.
- **Needs first:** the checks above.
- **HighLevel impact:** none to set up. A lead that syncs late (after a HighLevel outage, up to about 45 hours) starts your HighLevel workflows late, as if it just arrived. Its note says it came late. A late sync never sends the Zapier text again and never reopens or moves an existing deal.
- **Automatic retries** of failed syncs need the Railway messaging worker in "lead retries only" mode, which sends no customer messages. It is listed under [Optional O3](#o3-messaging-worker-for-lead-retries-only) because it is the messaging worker. Without it, failed leads wait in the ledger and in the Web3Forms email for you to recover by hand.
- **Check it worked (phone):**
  1. Submit the form on `/book` with a test name and your own phone.
  2. In HighLevel the contact appears with the `egc-website-lead` tag and a note with an "Inquiry ID:" line.
  3. Firebase console → Firestore → `web_lead_receipts`: the newest record shows `ghlSyncStatus` `synced`.
- **Roll back:** delete the variable and retry the deployment. Leads go straight to HighLevel as before. Recover any failed ones from the Web3Forms email.

### 2.2 Ads landing page leads

- **Set:** `WEB_LEAD_ADS_RELAY_ENABLED=true`
- **Where:** Cloudflare Pages, plain.
- **Turns on:** leads from the ads landing page (`/ads`) sync to HighLevel and the Zapier text relay like every other website form. Today they are held and arrive only as a Web3Forms email.
- **Needs first:** decide that ads leads should start the same HighLevel workflows (the `egc-website-lead` and `egc-sms-consent` tags) and the Zapier text-back. Settle the [Meta pixel choice](#d2-meta-pixel). Best: move the Zapier text-back into HighLevel first ([D1](#d1-customer-messages-that-skip-highlevel-today)).
- **Check it worked (phone):**
  1. Submit the `/ads` form with test details.
  2. In HighLevel the contact appears with the `egc-website-lead` tag and an opportunity at New Lead.
- **Roll back:** delete the variable and retry. Ads leads are held again (email only).

### 2.3 Late-lead tag (optional)

- **Set:** `WEB_LEAD_DELAYED_SYNC_TAG=true`, only if you want late leads to **skip** an instant reply.
- **Where:** Cloudflare Pages, plain. Needs 2.1 on.
- **Turns on:** a late sync first adds the tag `egc-delayed-sync`; an on-time lead removes it.
- **Needs first:** add an "unless tagged `egc-delayed-sync`" filter only to instant-reply workflows started by `egc-website-lead`, `egc-client-hub-help`, `egc-sms-consent`, `egc-no-sms-consent` or Contact Created (with about a 1-minute wait before the check). Never on Facebook lead ads, native HighLevel forms, calls, texts or opportunity triggers.
- **Check it worked:** follow the test in [FUNNEL-METRICS.md](FUNNEL-METRICS.md#111-unit-scopes) (FUN-13, optional part).
- **Roll back:** remove the HighLevel filters **first**, then delete the variable. Nothing removes the tag once the flag is off.

## Stage 3: Walkthroughs

| # | Set | Where |
| --- | --- | --- |
| 3.1 | `EGC_STAFF_DIRECTORY_ENABLED=true` | Cloudflare, plain |
| 3.2 | Booking in Dispatch | No switch |
| 3.3 | Recording in the Hub | Railway bridge (B5) |
| 3.4 | `EGC_WALKTHROUGH_VISIT_ENABLED=true` (after FUN-06) | Cloudflare, plain |
| 3.5 | `EGC_STAFF_ROLE_ACCESS=true` (owner decision: on) | Cloudflare, plain |

### 3.1 Team roles (staff directory)

- **Set:** `EGC_STAFF_DIRECTORY_ENABLED=true`
- **Where:** Cloudflare Pages, plain.
- **Turns on:** Hub → Staff directory: roles (including **Sales** for the walkthrough rep and **Phone** for the phone person), skills, pay history with future-dated raises, and weekly availability. While `EGC_STAFF_ROLE_PERMISSIONS` stays off (recommended for now), saved roles are recorded but do not change what anyone can open.
- **Needs first:**
  1. Run the two staff migrations, dry run then apply: `staff-profile-pay-roles-v1` and `employee-account-staff-roles-v1`. They run from a laptop browser signed in as you; the steps are in `docs/employee-vault-migrations.md` (or ask your developer).
  2. Tell managers: once this is on, pay changes go through you in the directory, not the old profile form.
- **Check it worked (phone):**
  1. Open Hub → Staff directory as the owner. Everyone is listed; no card says "unrecognized id" or "pay needs review".
  2. Give the phone person the "Phone · calls and follow-ups" role and save. Saving a role change signs that person out once.
- **Roll back:** delete the variable. The screen says "turned off"; saved roles stay.

### 3.2 Booking a walkthrough (no switch)

- In **Dispatch**, create the visit as a walkthrough, answer "How was this booked?", and assign the walkthrough rep.
- With **Notify customer** on, the Hub books the HighLevel appointment with HighLevel's own notifications on, and adds the tags `egc-hub-scheduled`, `egc-walkthrough-scheduled` and `egc-reminder-2d`. **HighLevel** sends the confirmation and reminders, from your calendar settings and workflows.
- With it off, the appointment is booked with HighLevel's notifications off and no reminder tag, but `egc-hub-scheduled` and `egc-walkthrough-scheduled` are still added. Keep customer messages off those two tags, or accept that they fire either way.
- A visit saved in Dispatch shows "calendar sync pending" until the Hub finishes the HighLevel sync, which happens while a manager has the Hub open (a background sync worker is in the next batch).
- **Check it worked:** book a test walkthrough for a test contact. It appears on the HighLevel walkthrough calendar and the contact gets `egc-walkthrough-scheduled`.

### 3.3 Recording the walkthrough

- **Set:** nothing new. Needs the bridge ([B5](#b5-railway-platform-and-the-signed-bridge)) and `OPENAI_API_KEY` on egc-api.
- **Turns on:** the rep records in the Hub on the iPad; the platform transcribes it and drafts the job notes.
- **Check it worked:**
  1. In the Hub, record or upload a short test recording on a test walkthrough. The browser asks for the microphone on `/employee` only.
  2. It reaches **draft** with a transcript.
  3. Any older recording stuck as "processing failed": tap **Retry** (no re-upload).
- **Leave off:** `EGC_EXTRACTION_V2` (see [Leave these off](#leave-these-off-for-now)).

### 3.4 Start and Finish (after FUN-06)

- **Set:** `EGC_WALKTHROUGH_VISIT_ENABLED=true`, **once the FUN-06 iPad recorder is deployed**. On this build nothing in the Hub calls it yet, so there is no button to press.
- **Where:** Cloudflare Pages, plain.
- **Turns on:** the rep taps **Start** at the door and **Finish** (with an outcome) or **No-show**. Each tap is recorded with its tracking event and moves the rep's timecard (below).
- **Needs first:** the rep signs in with the sales account from their named staff invitation (managers and the owner can also record walkthroughs), and is assigned to the walkthrough in Dispatch. Otherwise Start answers "not assigned to you".
- **Check it worked (phone), after FUN-06:**
  1. The rep clocks in, opens an assigned test walkthrough and taps Start, then Finish with an outcome.
  2. As the owner, open the rep's timecard: it shows a segment for that walkthrough.
- **Roll back:** delete the variable. Start and Finish are refused (`walkthrough_visit_disabled`); nothing else changes.

**How the rep's time lands on the timecard:**

- **Start** opens a work segment on the rep's current shift, labelled as that walkthrough. The rep must be clocked in; otherwise Start asks them to clock in (or start without a timecard, which leaves that visit's labor unknown).
- **Finish** or **No-show** closes it. A finish sent late from a phone that was offline closes the segment when it arrives and keeps the real finish time on the outcome.
- If the timecard cannot be written, the segment stays open for a manager to close. A manager can also clear a rep's stuck Start by recording the outcome; the rep's timecard is then corrected by hand.
- Walkthrough time is reported separately as the cost of winning the job, not as job labor.
- To rebook a no-show, move the same visit to its new date in Dispatch; do not create a new one.

### 3.5 Staff roles grant access (owner decision: on)

- **Set:** `EGC_STAFF_ROLE_ACCESS=true`
- **Where:** Cloudflare Pages, plain. Preview first, then Production.
- **Turns on:** the roles you set in the staff directory ([3.1](#31-team-roles-staff-directory)) decide what each person can do. It also turns on `EGC_STAFF_ROLE_PERMISSIONS`.
  - **Manager** role: the Hub treats that person as a manager, with business access to Hub screens, Firebase data and Action Center Hub commands.
  - **Sales** and **Phone**: book, move, cancel and mark no-shows for walkthroughs **and** jobs in Dispatch. They never assign crew and never see pay, cost or money. The crew-size rule stays a warning for them.
  - **Sales** also runs walkthroughs: the game plan, the signed hand-off and the visit recorder. A sale they hand off is saved with no crew and shows "Sold: needs crew" in Dispatch until a manager assigns the crew.
  - **Contact details:** Sales and Phone see every customer's name, phone, email, address and full job history in Dispatch, its customer list and its search. Only the caller lookup stays masked.
  - You always keep owner access. A saved role never makes anyone the owner.
- **Needs first:**
  1. The staff directory is on and its two migrations have run ([3.1](#31-team-roles-staff-directory)).
  2. **Set every staff member's role before you turn this on.** Give each manager the Manager role, including the managers who sign in with the configured Hub accounts. Because this also turns on `EGC_STAFF_ROLE_PERMISSIONS`, a business account whose saved roles lack Manager loses the business screens.
  3. Only Sales and Phone people should have those roles, since they will see all customer contacts.
  4. The Firebase service account has the **Firebase Authentication Admin** role ([1.3](#13-security-steps-with-no-switch), step 3). Otherwise the Firebase sign-outs below stay pending.
  5. No Hub sign-in username (`HUB_AUTH_USERS_JSON`, `HUB_AUTH_ADDITIONAL_USERS_JSON`) contains `'` `"` `\` `` ` `` `<` `>` `&`, a tab or a line break. Such accounts can no longer clock in from the crew app ([4.12](#412-correct-timecards-and-close-forgotten-shifts-optional)).
- **Role changes while it is on:** the person is signed out of the Hub and of Firebase data straight away. If the staff directory says "Their Firebase data sign-out is pending" or "could not be confirmed", open Hub → Integrations until the pending sign-out clears.
- **Check it worked (Preview, phone):**
  1. Give a test account the Sales role and sign in as it. Dispatch opens: book a test walkthrough and move it. There is no crew assignment and no money, pay or cost anywhere.
  2. Hand off a test sale as that account. The job shows "Sold: needs crew" in Dispatch.
  3. Give another test account the Manager role and sign in as it. The business Hub screens open.
  4. Take the Manager role away again. The staff directory confirms the sign-out, and Hub → Integrations shows no pending Firebase sign-out.
  5. Sign in as yourself. You still have owner access.
- **Roll back:** delete the variable and retry the deployment. Business access goes back to the configured business users, and Sales and Phone can no longer book. Saved roles stay. A stored manager's Firebase data session ends the next time a business user loads the Hub on easygaragecleaning.com. A session issued in the half minute before that load ends on a later load. Hub → Integrations shows any sign-out still pending.

## Stage 4: Crew scheduling and the field day

| # | Set | Where |
| --- | --- | --- |
| 4.1 | `EGC_DISPATCH_TRAVEL_ESTIMATES=offline` | Cloudflare, plain |
| 4.2 | `EGC_DISPATCH_LEGACY_BLOCKED_DAYS=warn` (optional) | Cloudflare, plain |
| 4.3 | `EGC_DISPATCH_SEGMENTS=true` (optional) | Cloudflare, plain |
| 4.4 | `EGC_DISPATCH_DEFAULT_ARRIVAL_WINDOW_ENABLED=true` (optional) | Cloudflare, plain |
| 4.5 | `FIELD_EXPENSES_ENABLED=true` | Cloudflare, plain |
| 4.6 | Offline crew app | No switch |
| 4.7 | Timesheets and payroll | `EGC_OVERTIME_POLICY` unset |
| 4.8 | Job costing | No switch |
| 4.9 | Clock-in location once | No switch |
| 4.10 | `EGC_CLOCK_IN_WITHOUT_FIX=true` (owner decision: on) | Cloudflare, plain |
| 4.11 | `EGC_JOB_STATUS_MOVES_TIME=true` (optional) | Cloudflare, plain |
| 4.12 | `EGC_TIMECARD_CORRECTIONS=true` (optional) | Cloudflare, plain |
| 4.13 | `EGC_GHL_TAG_OUTBOX=true`, then `EGC_GHL_TAG_DRAIN_ENABLED=true` | Cloudflare, plain; Railway egc-worker |

### 4.1 Drive times

- **Set:** `EGC_DISPATCH_TRAVEL_ESTIMATES=offline`
- **Where:** Cloudflare Pages, plain.
- **Turns on:** Dispatch warns when the gap between jobs is shorter than the estimated drive, using a built-in Northern Colorado ZIP table (no key, no cost, nothing sent to Google).
- **Needs first:** full addresses with ZIP codes on customers and jobs (no ZIP means the manual buffer only).
- **Check it worked (phone):** Dispatch → Drive times. Fort Collins 80525 to Loveland 80537 shows about 30 minutes.
- **Later:** `EGC_DISPATCH_BLOCK_TRAVEL_SHORT=true` turns the warning into a block. Fix tight days in Drive times first. The `google` mode needs `GOOGLE_MAPS_SERVER_API_KEY` and a Google project that can still enable the Distance Matrix API; `offline` is the recommendation.
- **Roll back:** delete the variable (manual buffers only).

### 4.2 Old "blocked day" toggles (optional)

- **Set:** `EGC_DISPATCH_LEGACY_BLOCKED_DAYS=warn` (or `enforce` to refuse placements on those days).
- **Where:** Cloudflare Pages, plain.
- **Turns on:** Dispatch respects days blocked in the old Hub calendar.
- **Needs first:** delete stale blocks with the old calendar toggle.
- **Check it worked:** a blocked day is skipped in openings, and placing work there shows a warning.
- **Roll back:** delete the variable (`off`).

### 4.3 Split and multi-crew jobs (optional)

- **Set:** `EGC_DISPATCH_SEGMENTS=true`
- **Where:** Cloudflare Pages, plain.
- **Turns on:** a job can have several crews, split crews or different windows per day.
- **Needs first:** every saved crew under Crews & vehicles has the right members and a lead (dropping a job on a crew row assigns exactly those people).
- **Check it worked:** split a test job across two days; each crew sees only its own part.
- **Roll back:** delete the variable. Saved splits still work and can be removed; split jobs cannot be repeated.

### 4.4 Default arrival windows (optional)

- **Set:** `EGC_DISPATCH_DEFAULT_ARRIVAL_WINDOW_ENABLED=true` (length: `EGC_DISPATCH_DEFAULT_ARRIVAL_WINDOW_MINUTES`, default 60).
- **Where:** Cloudflare Pages, plain.
- **Turns on:** jobs saved without an arrival window get one from the start time, shown to crews and in the portal. Existing future jobs are filled by `node scripts/backfill-arrival-windows.mjs`, then `--apply` (developer).
- **Check it worked:** a new job with a 9:00 start shows a 9:00-10:00 arrival window in the portal.
- **Roll back:** delete the variable. Saved windows stay.

### 4.5 Field costs

- **Set:** `FIELD_EXPENSES_ENABLED=true`
- **Where:** Cloudflare Pages, plain.
- **Turns on:** the **Job costs** card on each crew job: materials, dump fees, helpers, fuel, damage claims, other costs and scrap income, with who paid, receipt photos and a closeout "None" tap.
- **Needs first:** the `fieldExpenses.incurredOn` exemption ([B4](#b4-publish-firestore-rules-and-indexes)); the Google Drive credentials (for receipt photos). Tell crew about the card and the closeout taps. As owner, enter stocked-item costs in Hub → System → Stocked item costs.
- **Check it worked (phone):**
  1. A crew member opens a test job: the Job costs card is there.
  2. Record only a fuel cost. The closeout lists what is still to confirm, with a "None of the rest" button.
  3. As a manager, the entry shows on the job; crew see only their own.
- **Later:** `FIELD_EXPENSE_CLOSEOUT_REQUIRED=true` blocks completing a job until materials and dump fees are recorded or marked None. Turn it on once crews are used to the card.
- **Roll back:** delete the variable. The card hides; entries are kept.

### 4.6 Offline crew app (no switch)

- **Turns on at deploy:** `/crew/` installs to the home screen, keeps working offline and replays taps and photos in order when the signal returns.
- **Check it worked (phone):**
  1. Open `/crew/`, sign in, add it to the home screen.
  2. Airplane mode on: open a job, tick a checklist item, take a photo. The thumbnail says "Saved on this phone".
  3. Airplane mode off: the tick and photo save once.
- **Keep off:** `EGC_OFFLINE_CLOCK_ENABLED` ([Leave these off](#leave-these-off-for-now)). Until then, a clock-in saved offline more than 2 minutes before reconnecting is refused; the crew member discards it and clocks again, or a manager corrects it.
- **Emergency off switch:** the file `/crew/sw-config.json` set to `{"enabled": false}` removes the offline app within about 5 minutes of the next crew-page visit. It is a code change: ask your developer.

### 4.7 Timesheets and payroll

- **Set:** leave `EGC_OVERTIME_POLICY` unset (Colorado rules: time and a half over 40 a week, over 12 a day or over 12 hours in a row, whichever pays more). `federal` means over 40 a week only. Any other value stops payroll with an error, on purpose.
- **Needs first:** your accountant confirms the Colorado rules and the EGC readings of them (Monday-Sunday Denver week; a shift across midnight counts to the day it started; bonuses count toward overtime, tips do not). They also confirm that the payroll week card's regular, overtime and gross figures are what payroll should use. Pending and open time is listed separately and never counted. Managers approve timecards weekly.
- **Gusto pay rates:** Gusto works out pay from its own rates, so check that each employee's rate in Gusto matches their Hub rate.
- **Payroll export:** after the week ends and every timecard is approved, rejected or fixed, choose **Download payroll CSV** on the payroll week card (Time approvals, owner only), or open `/api/timesheets?view=week&start=YYYY-MM-DD&format=csv` (the Monday) while signed in.
- **Gusto hours file (GUSTO-EXPORT):** **Download Gusto hours** on the same card (owner only; managers get 403) is the week in Gusto's hours-import shape: one row per employee with regular, overtime, double-time and paid time off hours, to two decimals, from the same overtime rules and approved time off as the payroll CSV. It is keyed by each employee's **Gusto employee ID**, which only you set, in the staff directory (**Set Gusto ID**; needs `EGC_STAFF_DIRECTORY_ENABLED=true`). It refuses a week that is not settled, like the payroll CSV, and names every employee who has no Gusto ID yet. Mark anyone not paid through Gusto (your own field time, a 1099 worker) **Not paid through Gusto** in the same editor: their hours are left out of the file and named after the download, and the payroll CSV keeps them. Someone let go with hours still to pay is under **Former staff** at the end of the directory, where you can set only their Gusto fields. The column headers (Gusto employee ID, Employee name, Regular hours, Overtime hours, Double overtime hours, Paid time off hours) are EGC's reading of Gusto's template: download Gusto's hours-import template once and confirm them; if they differ, only the `GUSTO_HOURS_COLUMNS` constant in `functions/_lib/payroll-export.js` changes. Bonuses and tips are not in the file; enter them from the payroll CSV. Connect Gusto (the API sync) stays hidden unless `GUSTO_PRODUCTION_APPROVED=true`.
- **Check it worked:** open that link for last week. You get a CSV, or a message listing the timecards still to approve.
- **Paid time off:** only through the raw employee API today; the PTO screen (P1-06) is in the next batch.
- **Columns changed with CREW-TIME:** the payroll CSV ends with a Job time column (each job's work and travel, general company time, "Job time needs manager review" for a shift whose segments need review, and "No job segments" for older shifts); the Review flags column is as before. If a spreadsheet reads the payroll CSV's columns by name, re-map it before the first payroll after the deploy. Hours and pay are unchanged. The Hub's timesheet Download CSV and Download for Gusto (Smart Import) buttons were removed with TIME-CORRECT; the payroll week card's Download payroll CSV and Download Gusto hours (GUSTO-EXPORT) replace them.

### 4.8 Job costing (no switch)

- **Where:** `/api/job-costing?start=YYYY-MM-DD&end=YYYY-MM-DD` (end date not included, 92 days at most), owners and managers. No Hub screen yet.
- **What it shows:** labor per job from the time crews log against each job, at the pay rate saved at clock-in, plus the overtime premium spread across the week's jobs. "Approved" uses approved timecards and is final only when `coverage.complete` is true; "projected" adds pending ones. Walkthrough time is listed separately. Field costs stay on each job's Job costs card. Payroll taxes and burden are not added yet ([D4](#d4-payroll-burden-rate)).
- **Check it worked:** open it for last week; it lists jobs with labor hours and cost.

### 4.9 Clock-in location once (no switch)

- **Turns on at deploy:** the Hub and `/crew/job.html` read the phone's position once, when the crew member taps Clock in. Nothing in this build reads or sends a position after that, with `HUB_OFFLINE_ENABLED` on or off (a tab still running the old build does until it is reloaded, see After deploy). The server stores that one position, adds no trail, and refuses any later location update to the shift (409 `EMPLOYEE_TIMECARD_LOCATION_CLOCK_IN_ONLY`). Old timecards keep their trails and stay readable.
- **Weak signal:** the button says "Getting your location…". A timeout or no position is tried once more at lower accuracy, taking a position up to 5 minutes old. A denied location permission is not retried: "Clock-in needs location access."
- **A clock-out not saved** (offline saving) now shows "Clock-out not saved" with **Keep working** instead of "Resume location".
- **Needs first:** tell crews the clock-in reads their location once and never during the shift.
- **After deploy (required):** reload every open Hub tab on every phone (or sign out and in). A tab opened before the deploy runs the old build: it ignores the server's refusal and keeps reading the phone's location for the rest of the shift (for a shift clocked in before the deploy, or one it clocks in itself). The server stores none of it, but the phone keeps reading location until that tab is reloaded or the shift is clocked out, so "nothing tracks you during the shift" holds only after the reload. Shifts left open across the deploy show "last tracked location" instead of "shared once at clock-in" until they are clocked out.
- **Check it worked (phone):** clock in from My day. The card says "Location shared once at clock-in". Leave the Hub open for a few minutes: the phone's location indicator does not come back.
- **Roll back:** a code rollback only. The earlier build tracked location during the shift.

### 4.10 Clock in with no GPS position (owner decision: on)

- **Set:** `EGC_CLOCK_IN_WITHOUT_FIX=true`
- **Where:** Cloudflare Pages, plain.
- **Turns on:** when the phone finds no position after the retry (indoors, weak GPS), the shift starts anyway without one. The Hub card and the crew job page say "No location at clock-in", the manager's team board shows it, and the week's timesheet row carries the `no_clock_in_location` flag (also in the payroll CSV's Review flags). A denied location permission still blocks clock-in.
- **Unset:** the crew member is told to move near a window or outside and try again; no shift starts.
- **Check it worked (phone):** allow location for the site, turn off Wi-Fi and go somewhere with no GPS (or use a phone with location services off but the site allowed), then clock in: "Clocked in without a location · a manager will review it".
- **Roll back:** delete the variable. Shifts already flagged stay flagged.

### 4.11 Job status moves crew time (optional)

- **Set:** `EGC_JOB_STATUS_MOVES_TIME=true`
- **Where:** Cloudflare Pages, plain.
- **Turns on:** on `/crew/job.html` the job status moves the crew member's own time: **Mark en route** starts travel on the job, **Mark arrived** and **Start work** start work on it, pause, waiting and delay keep it, and **Complete** asks "End my job time?" (OK moves to general shift time). A line under the status buttons says "Your time: working on <job>". Only someone on the job's crew has their own time moved by its status; a manager who sets the status of a job they are not on keeps their own time (and a move the server refuses as not theirs is dropped with a notice, never left blocking their clock). When the job's crew lead marks arrived or starts work, they are asked once "Move my crew-mates to work too?"; the server moves only crew assigned to that job who clocked in today, are not on approved time off today, not on break, and are on general time or travelling there (with `FIELD_MULTIDAY_VISITS`, only those on today's crew), and tells the lead who was not moved and why (a shift still open from an earlier day is "still clocked in from an earlier day"). Online, the page reads the crew member's shift before a status moves their time, so a lead's move is never undone; a move that is already where the shift is changes nothing. Offline, the status and its time move sync in order. A crew move retried after a lost reply is answered as it stands, naming who it already moved; a partly applied one finishes the rest when retried within 2 minutes. A crew move the server refuses (saved offline for more than 2 minutes with crew-mates still to move, or the job closed) names who was already moved, waits at the top of the job for Retry or Discard, and never holds the lead's own clock buttons.
- **Needs first:** every job has the right crew and lead. Tell crews that status taps now move their time.
- **Check it worked (phone):** clock in, open a test job, tap Mark en route: the line says "Your time: travelling to …". Tap Mark arrived: "working on …". The Hub clock card shows the job's work.
- **Roll back:** delete the variable. Statuses stop moving time; crews use "Start my work time here" as before.

### 4.12 Correct timecards and close forgotten shifts (optional)

- **Set:** `EGC_TIMECARD_CORRECTIONS=true`
- **Where:** Cloudflare Pages, plain. Preview first.
- **Turns on:** owners and managers (`time.approve`) get **Correct time** on every Time approvals timecard (clock-in, clock-out, breaks and job; the rate only for someone who may set pay, the owner under `EGC_STAFF_PAY_OWNER_ONLY`) and **Close shift** on a shift someone forgot to clock out of. Each save needs a reason, is kept in the timecard's history with who made it, recomputes the hours, and sends the card back to pending for approval. Shifts open more than 14 hours are listed under **Needs attention** on the Command center and Time approvals. Crew never get the buttons; with `EGC_STAFF_ROLE_PERMISSIONS` off, every Hub user with business access counts as `time.approve`.
- **Unset:** no correction buttons and no 14-hour list, and the server refuses a correction (403 `EMPLOYEE_TIMECARD_CORRECTIONS_OFF`). Weekly totals come from the server's payroll week card either way.
- **Needs first:** with `EGC_STAFF_ROLE_PERMISSIONS` on, check that each manager's staff role is manager. Confirm no Hub sign-in username (`HUB_AUTH_USERS_JSON`, `HUB_AUTH_ADDITIONAL_USERS_JSON`) contains `'` `"` `\` `` ` `` `<` `>` `&`, a tab or a line break: such accounts can no longer clock in from the crew app. Developer: before turning this on in Production, look for existing timecards whose IDs contain quotes or markup. New ones are refused; older ones still show on the board and stay savable.
- **Check it worked:** on Preview, clock a test account in and leave it running. As a manager, open Time approvals, tap **Close shift** on that row, enter the real end time and a reason, and save. The card reads pending, its history shows the reason and your name, and the payroll week card's hours change once it is approved. **Correct time** on another test card works the same way. Close every shift under Needs attention before the payroll export.
- **Roll back:** delete the variable. Corrections already saved stay in the timecards and their history.

### 4.13 HighLevel hears about every booking change (tag outbox)

- **Set:** `EGC_GHL_TAG_OUTBOX=true` on Cloudflare Pages, then `EGC_GHL_TAG_DRAIN_ENABLED=true` on the Railway egc-worker.
- **Where:** Cloudflare Pages, plain (Preview first, then Production); Railway → egc-worker → Variables.
- **Turns on:** a booking, move, restore, cancel or no-show in Dispatch or through the bridge, and a walkthrough outcome, saves the HighLevel tags it needs in the same save as the change. The Hub tries them once right after the save. After that, egc-worker retries every 2 minutes (waiting 1, 5, 15, then 60 minutes between tries) until they are added, and parks a change after 8 tries.
  - **What it writes:** tags only, plus two things. A cancelled or no-show visit's appointment is set to Cancelled or No Show with no calendar notice (`toNotify: false`). A lost walkthrough gets an internal note with the reason code. It sends no message and never moves a stage or creates an opportunity.
  - **Your existing workflows:** booking and reminder workflows get the same tags as today, after the appointment is written, so they keep working unchanged.
  - **New tags:** `egc-visit-rescheduled`, `egc-visit-cancelled`, `egc-visit-no-show`, `egc-walkthrough-no-show`, `egc-walkthrough-lost` and `egc-quote-to-follow`. Each starts nothing until you build a workflow on it.
  - **What you see:** Dispatch cards show **HighLevel told**, **HighLevel waiting** or **HighLevel stuck** with **Retry**. The Command center shows **HighLevel tags stuck for N visits** with **Retry**, and **The HighLevel tag worker has not run** when egc-worker has not checked in for 10 minutes.
- **Needs first:**
  1. Decide whether you want HighLevel workflows on the new tags and on the appointment status Cancelled or No Show. None is needed; without a workflow the tags are tracking only.
  2. Check that no existing **Appointment Status** workflow would message a customer you did not intend to.
  3. egc-worker's `API_BEARER_TOKEN` matches the Hub's, the Hub uses v2 service auth, and `HIGHLEVEL_API_KEY` and `HIGHLEVEL_LOCATION_ID` are set on Cloudflare Pages ([B5](#b5-railway-platform-and-the-signed-bridge)).
  4. The rules from this build are published ([B4](#b4-publish-firestore-rules-and-indexes)). The outbox records are server-only.
- **Order of the switches:** never set `EGC_SCHEDULE_SYNC_WORKER` (the server calendar sync, on Cloudflare Pages and egc-api) before both switches here are on. With that sync on and the outbox off, confirmations and reminders stop.
- **Messaging dry run:** while `EGC_MESSAGING_DRY_RUN` is not exactly `false`, a change for a visit whose customer has no linked HighLevel contact is retried for about 4 hours and then shows as stuck. Link the customer's contact and press **Retry**. The outbox creates a contact only outside a dry run.
- **Check it worked (Preview, phone):**
  1. Book a test visit for a test contact in Dispatch. Once its calendar sync has run, the card says **HighLevel told** with a time, and the contact has `egc-hub-scheduled`.
  2. Move it to another day. The contact gets `egc-visit-rescheduled`.
  3. Cancel it. The contact gets `egc-visit-cancelled`, and the appointment shows Cancelled with no calendar notice.
  4. Open the Command center. There is no "tag worker has not run" line.
- **Roll back:** if `EGC_SCHEDULE_SYNC_WORKER` is on, delete it first (Cloudflare Pages and egc-api). Then delete `EGC_GHL_TAG_OUTBOX` and retry the deployment, and delete `EGC_GHL_TAG_DRAIN_ENABLED` on egc-worker. The browser tag sync works as before. Tags already added stay.

### Keep off for now

`EGC_RECURRING_PLANS_ENABLED`: only after the recurring-plan background job (RECUR-CRON) lands. Before that, someone would have to press "Add upcoming visits" on every plan or visits stop being added.

### One-time data clean-ups (developer, in a quiet window)

Each is a dry run first; review, then run again with `--apply`. All need `FIREBASE_SERVICE_ACCOUNT_JSON`.

1. `node scripts/repair-stale-schedule-instants.mjs`: fixes jobs whose saved times were left stale by an old reschedule path.
2. `node scripts/backfill-customer-identity.mjs --report <private file>`: links jobs to one customer by phone and email. Treat the report as confidential.
3. `node scripts/backfill-job-contact-keys.mjs`, then `--apply --report keys.json`: lets the sales follow-up exit find a customer's other jobs. Re-run after any big import (such as Jobber).

## Stage 5: Money

**Refunds are two steps and owner-only.** The Hub never moves money out on its own:

1. Refund the charge in the **Stripe dashboard**.
2. Hub → **Review queues** → **Record refund**. Only you (the owner) see this button. The Hub checks Stripe and refuses until Stripe shows the refund, and asks you to confirm the amount kept.

**Charging a card on file:** there is no Hub or AI tool that charges a stored card in this build. The AI assistant has no payment or refund tools at all.

| # | Set | Where |
| --- | --- | --- |
| 5.1 | Card payments and Review queues | No switch |
| 5.2 | `MONEY_API_ENABLED=true` | Cloudflare, plain |
| 5.3 | `MONEY_DOCUMENT_ENABLED=true` | Cloudflare, plain |
| 5.4 | `PAYMENT_REVIEW_CHECKOUT_BLOCK_ENABLED=true` (optional) | Cloudflare, plain |
| 5.5 | `GARAGE_GUARD_MEMBERSHIP_SYNC_ENABLED=true` (optional) | Cloudflare, plain |
| 5.6 | `MONEY_UNIFIED_TOTALS=shadow`, then `true` | Cloudflare, plain |

### 5.1 Card payments and Review queues (no switch)

- **On at deploy:** crew card links and portal checkouts are recorded by the Stripe webhook, even if the crew page never comes back. A charge the job cannot take goes to Hub → **Review queues** instead of being counted.
- **Needs first:** [B6](#b6-stripe-webhook-events-and-the-live-key).
- **How to settle a held charge:** the card says what to do. If Stripe shows a refund, use Record refund (above). If the card also says the charge is already on the job, reduce that job's payment under Estimates & payments by the amount refunded; the Hub does not change it for you. A second refund on the same charge appears as a new item that names the earlier one. A charge you settle is final: nobody charges it again.
- **Messages with unknown delivery** (Review queues): check the HighLevel conversation, then mark each delivered or not delivered. Nothing is resent by itself.
- **Check it worked:** open Review queues as owner and as a manager. Managers see the queues but no Record refund button.

### 5.2 Server money records

- **Set:** `MONEY_API_ENABLED=true`
- **Where:** Cloudflare Pages, plain.
- **Turns on:** the Hub's estimate, approval, deposit, payment and invoice buttons save on the server with a payment ledger, invoice numbers and an audit entry, instead of from the browser.
- **Needs first:**
  1. Developer runs `node scripts/backfill-payment-ledger.mjs` (dry run). Review `jobs.needsReview`, `jobs.needsVerification` and `invoiceNumbers.duplicates`, then run it with `--apply`.
  2. For every job in `jobs.needsVerification`: check the money against the check, bank or Stripe record, then set `payment.verified` to true on that job in the Firebase console (and `deposit.verified` if the deposit is the evidence). Keep your own note; this edit has no audit entry. Run the backfill again.
- **HighLevel impact (important):** with this on, saving an estimate, approval, deposit, invoice or payment adds the same `egc-<event>` tag as the standard finance tools (MONEY-GHL-PARITY), and so does each invoice the Invoicing screen issues (`egc-invoice-issued`), so your HighLevel workflows still send; none when **Notify customer** is off. Use **Trigger in HighLevel** only for a job or Invoicing row flagged **needs attention** or **not triggered**, and only if the customer should still hear: after a normal save it adds the tag a second time. If the Hub cannot confirm a save to start its tag, the job shows **needs attention** in Customer messages. Two cases leave nothing on the job, only a toast (and the Invoicing row) saying **not triggered** until you refresh, so check that job's Customer messages then: a finance dialog save that another money save on the job overtook before the Hub could confirm it, and a retried Invoicing batch that finds the job changed since with no tag for that invoice in the job's log. A new invoice the Invoicing screen issues in that situation is still flagged **needs attention** on the job. Saves do not switch on automatic reminders; use "Enable auto" on a job if you want them.
- **Invoicing screen (M5-SEND):** with this on, managers issue one invoice or a batch from Hub **Invoicing** (CLIENT WORK). Each issued invoice adds `egc-invoice-issued` exactly as the standard invoice save does, and your HighLevel workflow sends the invoice; the Hub sends nothing itself. Issuing does not switch on automatic reminders either: rows without them say **Automatic overdue reminder off (Enable auto on the job)**. Whether issuing should switch them on is an open owner decision ([messaging owner setup](messaging-owner-setup.md), Invoicing).
- **Check it worked (phone):**
  1. On a test job, create an estimate and record a $1 cash payment. Both save.
  2. The finance board shows the payment in the job's ledger.
- **Roll back:** delete the variable. Open pages switch back on their next save. Do **not** re-save an itemized estimate in the old editor afterwards: it flattens it to one line. Turn the flag back on to edit those.

### 5.3 Branded estimates, invoices and receipts

- **Set:** `MONEY_DOCUMENT_ENABLED=true`
- **Where:** Cloudflare Pages, plain.
- **Turns on:** server-made estimate, invoice and receipt pages; "View estimate / invoice / receipt" links in the customer portal; "Print receipt" in the Hub.
- **Needs first:** stop Cloudflare's email obfuscation from breaking the page: either a Configuration Rule (URI path equals `/api/money-document`, Email Obfuscation off), or open a live document afterwards and check emails show as plain text, not "[email protected]".
- **Check it worked (phone):**
  1. Open the invoice for a plain job. Its Pay button amount equals what the portal checkout charges.
  2. A job with a change order or tip shows no Pay button and asks the customer to call or text.
  3. A job with a recorded payment shows "Print receipt" on the finance board.
- **Roll back:** delete the variable. The portal lists no documents; the Hub prints its old copy.

### 5.4 Block checkouts while a charge is held (optional)

- **Set:** `PAYMENT_REVIEW_CHECKOUT_BLOCK_ENABLED=true`
- **Where:** Cloudflare Pages, plain.
- **Turns on:** a job with an open held charge refuses a new crew card link or portal Pay until you settle it in Review queues.
- **Check it worked:** on a job with an open held charge, the crew card link and the portal Pay button say it is being reviewed.
- **Roll back:** delete the variable. Checkouts open as today.

### 5.5 Garage Guard memberships (optional)

- **Set:** `GARAGE_GUARD_MEMBERSHIP_SYNC_ENABLED=true`
- **Where:** Cloudflare Pages, plain.
- **Turns on:** Garage Guard sign-ups and renewals are recorded once each and linked to the Hub customer with the exact same phone or email; anything unsure goes to Review queues → member matches (link or dismiss).
- **Needs first:** the Stripe webhook events in [B6](#b6-stripe-webhook-events-and-the-live-key).
- **Check it worked:** a new test membership shows on the customer, or waits in member matches.
- **Roll back:** delete the variable. The Zapier team alert keeps working either way.

### 5.6 One money total everywhere

- **Set:** `MONEY_UNIFIED_TOTALS=shadow` for a week, then `MONEY_UNIFIED_TOTALS=true`.
- **Where:** Cloudflare Pages, plain. Preview first.
- **Turns on:** one amount owed per job. The customer portal (each approved change listed under the estimate), its Pay amount, crew card limits and the closeout balance, invoices, the invoice list and the estimate, invoice and receipt pages all use the quote plus billed approved changes, less the money paid toward the service. Tips never count. The Hub finance board follows while `MONEY_API_ENABLED` is on.
  - An approval saved without a billed change line is not counted. Its finance row says **Approved change not billed**.
  - Amounts the Hub cannot read are never charged online: the portal asks the customer to call, and the finance row says **Amounts need review**.
  - An invoice issued before the switch lists the new total, flagged `invoice_amount_stale`, until you reissue it.
- **`shadow`:** every page keeps today's figures. Wherever the one total would differ, the Cloudflare Functions log gets a `money_totals_mismatch` line with the job id and both sets of figures (no customer details).
- **Needs first:**
  1. `MONEY_API_ENABLED=true` ([5.2](#52-server-money-records)) and `MONEY_DOCUMENT_ENABLED=true` ([5.3](#53-branded-estimates-invoices-and-receipts)), before `true`.
  2. A week on `shadow`. In Cloudflare Functions logs, search `money_totals_mismatch` and check each job it names. Look hardest at jobs already marked paid: an older tip recorded inside the paid amount (legacy tip) no longer counts toward what is owed, so the job can show a balance again. Settle those first.
  3. Developer runs `node scripts/backfill-change-orders.mjs` (dry run). Review it, then apply it (`--apply --billing-enabled`) for the jobs whose finance row says **Approved change not billed**.
- **HighLevel impact:** none. No new tags or messages. HighLevel notes and triggers (overdue reminders, the Customer messages buttons, the crew closeout payment note) keep today's figures. Payment reminders, the account list and the business hub also keep today's figures until a follow-up unit, so on the jobs the shadow log names they can differ from what checkout charges.
- **Check it worked (phone):** on a test job with a $1,000 quote, a $500 deposit paid and a $150 approved change, the portal shows $1,150 total, $650 due and a Pay button; the Hub finance row shows $1,150 with a $650 balance; the invoice page says Balance due $650.
- **Roll back:** delete the variable. Every page goes back to today's figures. Payments recorded meanwhile stay recorded.

## Stage 6: Customer portal and business client hub

| # | Set | Where |
| --- | --- | --- |
| 6.1 | Portal documents and review link | No switch; `GOOGLE_REVIEW_URL` optional |
| 6.2 | `FIELD_CUSTOMER_PHOTOS_SINCE`, then `FIELD_CUSTOMER_PHOTOS_ENABLED=true` | Cloudflare, plain |
| 6.3 | Business client hub | No switch |

### 6.1 Portal basics (no switch)

- **Insurance certificate:** Hub → Integrations → Portal documents → upload the current certificate with its expiry date. The Hub warns 30 days before it expires; customers stop getting it on that date.
- **Guarantee and terms:** read the copy the portal shows (copied from the site) and tell us if it should change.
- **Google review link:** the portal's review card shows only on completed, paid jobs and sends nothing. `GOOGLE_REVIEW_URL` (Cloudflare, plain, https only) changes the link; unset uses your current Google listing.
- **Cutting off a portal link:** possible through `/api/customer-portal-revoke` only (no Hub button yet). Ask your developer if a link reached the wrong person.
- **Check it worked:** open a test customer's portal on your phone and download the insurance certificate.

### 6.2 Before and after photos in the portal

- **Set:** first `FIELD_CUSTOMER_PHOTOS_SINCE=YYYY-MM-DD` (your launch date, Denver), then `FIELD_CUSTOMER_PHOTOS_ENABLED=true`.
- **Where:** Cloudflare Pages, plain. Preview first, then Production.
- **Turns on:** customers see verified before and after photos on completed jobs; owners and managers can share or hide single photos from the crew job page. The date stops old jobs from suddenly showing photos; older photos show only if a manager shares them.
- **Needs first:** Google Drive credentials; a Cloudflare rate-limit rule on `/api/customer-portal-photo` (about 120 requests a minute per visitor, then challenge).
- **Check it worked (phone):**
  1. Open a completed test job's portal: Before and After groups show with "Added" dates.
  2. On `/crew/job.html` as a manager, the share and hide toggles work.
- **Roll back:** delete `FIELD_CUSTOMER_PHOTOS_ENABLED`. Photos disappear from the portal.

### 6.3 Business client hub (no switch)

- **On at deploy:** staff create company accounts at `/business-hub` and share private sign-in links. A company member can be limited to some properties.
- **Invitations by email** use the Hub's own sender, so they are under [Optional O5](#o5-business-hub-invitation-emails). Private links work without it.
- **Check it worked:** sign in as a test company admin, limit a test manager to one property, and in another browser confirm that manager sees only that property.
- **Before any code rollback past this build:** export business members limited to properties; older code would give them every property.

## Stage 7: Claude and ChatGPT (MCP)

| # | Set | Where |
| --- | --- | --- |
| 7.1 | `EGC_MCP_PUBLIC_ORIGIN=https://<mcp-host>` | Cloudflare, plain |
| 7.2 | `MCP_OAUTH_HUB_IDENTITY_ENABLED=true` | Railway egc-mcp |
| 7.3 | Connect Claude and ChatGPT | Claude / ChatGPT settings |
| 7.4 | `MCP_OAUTH_SHARED_LOGIN_ENABLED=false` | Railway egc-mcp |

`<mcp-host>` is the egc-mcp public address (Railway → egc-mcp → Settings → Networking).

### 7.1 and 7.2 Hub-approved connections

- **Set:** `EGC_MCP_PUBLIC_ORIGIN=https://<mcp-host>` on Cloudflare (bare address, no path), then `MCP_OAUTH_HUB_IDENTITY_ENABLED=true` on Railway egc-mcp.
- **Turns on:** "Continue with Employee Hub" on the AI consent page. A signed-in owner or manager approves each connection in the Hub, and the assistant acts as that person. Connections expire 30 days after approval.
- **Needs first:** the bridge ([B5](#b5-railway-platform-and-the-signed-bridge)); Hub and MCP on the same commit (B1). No business user who will approve AI connections has a crew or crew lead role (the bridge refuses crew roles).
- **Check it worked (phone):**
  1. Open `https://easygaragecleaning.com/api/mcp-grant?grant=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`. You see the approval page, not "Connections are off".
  2. Open `https://<mcp-host>/mcp-info`. It describes the live access policy.
- **Roll back:** delete `MCP_OAUTH_HUB_IDENTITY_ENABLED` (no new Hub approvals) or `EGC_MCP_PUBLIC_ORIGIN` ("Connections are off").

### 7.3 Connect, and which access to grant

- **Claude:** Settings → Connectors → Add custom connector. URL `https://<mcp-host>/mcp/oauth`; leave the client ID and secret empty. Connect → **Continue with Employee Hub** → Approve. Finish in the same browser you started in.
- **ChatGPT:** add a custom MCP server at `https://<mcp-host>/mcp` and approve the same way.
- **Which access (scopes):**

| Access | What it allows | Recommendation |
| --- | --- | --- |
| `egc:read` | Reads: leads, customers, jobs, schedules, transcripts, reports, "what's overdue" | Grant this. |
| `egc:write` | Changes: HighLevel contacts, tags, opportunities and appointments; internal Action Center tasks | Only on **your own** connection, and only if you want the assistant to change HighLevel records. |

- The consent page's "Scope:" line and the Hub approval page show which is being asked for ("…and make the changes listed" means write). If it asks for write and you do not want that, close the page without approving.
- Only owners and managers can approve, and only their approvals carry write. Recommended: only you approve AI connections.
- Either way the assistant cannot text or email customers in one step (keep `EGC_MCP_DIRECT_SENDS_ENABLED` unset), take payments or refund. Appointments it books use HighLevel automations only when asked.
- Hub-approved connections cannot yet change Hub notes or visit schedules through the bridge; that comes in a later unit.
- **Check it worked:** ask Claude "how many leads came in over the last 3 days?" and "what's overdue?". Both answer, and nothing is sent.
- **Update saved prompts:** any saved prompt or script that reads search results must now read `result.items` and follow `page.nextCursor`.

### 7.4 Retire the shared password

- **Set:** `MCP_OAUTH_SHARED_LOGIN_ENABLED=false`, **after** Claude and ChatGPT both connect through the Hub.
- **Where:** Railway egc-mcp.
- **Turns on:** the shared connector password form disappears and every connection made with it stops.
- **Check it worked:** the consent page shows only "Continue with Employee Hub".
- **Roll back:** delete the variable; the shared login works again.
- **Later:** delete `MCP_OAUTH_USER` and `MCP_OAUTH_PASSWORD` from egc-mcp.
- **Cutting off one person now** (for example someone who left): a developer revokes their connections in the MCP database (`egc-platform/docs/claude-connection.md`, "Disconnecting and revoking").

## Optional: only if you want the Hub to send through HighLevel

None of these is part of the core go-live. Each makes the **Hub** write or trigger customer messages (delivered through HighLevel's API) instead of your HighLevel workflows. Under your rule, leave them off. If you ever want them, start with `docs/messaging-owner-setup.md`.

### O1. Hub-written messages (approved templates)

- `EGC_MESSAGING_ENABLED=true` turns on the Hub's approved-send service (owner-approved templates at `/message-templates`).
- `EGC_MESSAGING_DRY_RUN` stays unset (dry run: no message is sent) until templates and your A2P texting registration are approved; only `false` sends for real. A dry run writes nothing to HighLevel, not even a contact.
- `EGC_MESSAGING_SUBREQUEST_BUDGET` about `900` on Workers Paid.
- Roll back: delete `EGC_MESSAGING_ENABLED`.

### O2. Server reminders

- `EGC_SERVER_MESSAGING_ENABLED=true` (Cloudflare) lets the Railway messaging worker send day-before, deposit and estimate-expiring reminders from the Hub (payment reminders stay with your HighLevel workflow on `egc-invoice-overdue`). It duplicates HighLevel reminders unless you remove those workflow steps. Needs O1 and O3.

### O3. Messaging worker for lead retries only

- `EGC_MESSAGING_CRON_ENABLED=true` on Railway egc-worker, plus `API_BEARER_TOKEN` (same value as egc-api) on egc-worker. Leave `EGC_MESSAGING_CRON_DRY_RUN` unset.
- With `EGC_SERVER_MESSAGING_ENABLED` **unset** on Cloudflare, every 15 minutes the Hub answers "Server messaging is turned off. Nothing was sent." and only retries website leads that failed to reach HighLevel ([2.1](#21-durable-website-leads)). No customer message is written by the Hub.
- Trade-off: the worker then holds the API's root signing secret. A narrower key is planned.
- Check: Railway egc-worker logs show `messaging_cron` lines with status `disabled` and `webLeads…` counts.
- Roll back: delete `EGC_MESSAGING_CRON_ENABLED`.

### O4. One-tap send in the Action Center

- `EGC_OPERATIONS_ACTION_SEND_ENABLED=true` on Railway egc-api lets a person approve and send a drafted follow-up in one tap. It is a parallel follow-up path to HighLevel. Leave off.

### O5. Business hub invitation emails

- `BUSINESS_HUB_INVITE_DELIVERY=true` (Cloudflare) emails company invitations through O1, after you approve the "Business hub invitation" wording (it must contain `{{inviteLink}}`). Needs O1 live with dry run off.

### O6. AI one-step customer sends

- `EGC_MCP_DIRECT_SENDS_ENABLED=true` on Railway egc-mcp lets Claude or ChatGPT text or email a customer in one step, skipping Hub approval. Not recommended.

Invoice sending and customer portal sign-in links by text or email are in the [next batch](#coming-in-the-next-batch) and will also be optional.

## Leave these off for now

| Variable | Why it stays off |
| --- | --- |
| `EGC_OFFLINE_CLOCK_ENABLED` | The Hub timesheet has no "phone time" review badge yet; on, crew could backdate a clock action by up to 12 hours. |
| `EGC_RECURRING_PLANS_ENABLED` | Waits for the recurring-plan background job (RECUR-CRON). |
| `EGC_STAFF_ROLE_PERMISSIONS` | Can hide business screens from a manager whose saved roles lack them; check every business user's roles first. `EGC_STAFF_ROLE_ACCESS` ([3.5](#35-staff-roles-grant-access-owner-decision-on)) turns it on for you, after the role checks there. |
| `EGC_EXTRACTION_V2` (Railway egc-api) | Waits for the recording review screen (P3-09); also adds OpenAI cost per recording. |
| `CATALOG_QUOTES_ENABLED` | No Hub screen yet (CATALOG-ADMIN), and the pricing settings are placeholders. |
| `CUSTOMER_PORTAL_REJECT_DRAFT_ESTIMATES` | The Hub still saves estimates as draft, so customers could not approve. |
| `EGC_OPERATIONS_BRIDGE_CONFIRM_REQUIRED` | Would block AI and bridge visit cancellations; nothing can issue the confirmation yet. |
| `EGC_OPERATIONS_FOLLOWUP_POLICY_ENABLED`, `EGC_OPERATIONS_STAFF_MEMBERS`, `EGC_OPERATIONS_FOLLOWUP_ROLE`, `EGC_OPERATIONS_FOLLOWUP_OWNER_ID` | Hub-side follow-up ownership. HighLevel owns follow-ups. |
| `EGC_OPERATIONS_HUB_DELEGATES_JSON` | Nothing needs it yet. |
| `EGC_BOOKING_AUTO_RECONCILE`, `EGC_BOOKING_ADOPT_EXISTING` (Railway egc-api) | Stay as dry-run plans until you decide on adopting HighLevel self-bookings. |
| `MCP_BEARER_WRITE_ENABLED`, `MCP_OAUTH_DCR_ENABLED` (Railway egc-mcp) | Only for developer checks and other AI clients. |
| Everything in [Optional](#optional-only-if-you-want-the-hub-to-send-through-highlevel) | Under your HighLevel rule. |

## Owner decisions

### D1. Customer messages that skip HighLevel today

These reach customers today without going through HighLevel. Recommended: rebuild each as a HighLevel workflow, then switch the old path off.

| Message | Goes through today | Recommended move |
| --- | --- | --- |
| Crew pre-job confirmation and arrival texts | Quo (OpenPhone) directly, `QUO_API_KEY` | Day-before confirmation: a HighLevel workflow on `egc-reminder-2d` / `egc-job-scheduled`. Arrival texts: crew use the job's Customer thread, which sends through HighLevel. Then retire the Quo buttons (developer) and remove `QUO_API_KEY`. |
| Booking confirmation email | EmailJS, `EMAILJS_SERVICE_ID` / `EMAILJS_TEMPLATE_ID` / `EMAILJS_PUBLIC_KEY` | Email step in the HighLevel workflow on `egc-job-scheduled` / `egc-walkthrough-scheduled`. Then remove the three EmailJS variables. |
| Website-lead AI text-back | Zapier → OpenPhone, `WEBSITE_LEAD_HOOK_URL` | A fixed, owner-approved instant reply in the HighLevel workflow on `egc-website-lead` + `egc-sms-consent`. Then remove `WEBSITE_LEAD_HOOK_URL` (leads still reach HighLevel). |
| Review request | Crew post-job page → Zapier → Quo (`CREW_WEBHOOK_URL`); also `REVIEW_WEBHOOK_URL` | A HighLevel workflow on `egc-review-ready` (added at closeout) or `egc-review-requested` (the Hub's Review request button). Keep exactly one sender. |
| "Zap 5" quote follow-up | Hub "Quoted" → Zapier, `QUOTE_FOLLOWUP_WEBHOOK_URL` | HighLevel's quote follow-up sequence on the open-quote tags (`egc-quote-ready`, `gc-quote-open`). Then turn off the Zap or remove the variable. |
| Card payment receipts | Stripe emails a receipt; the Hub gives Stripe the job's email on every portal and crew card checkout | Keep Stripe's receipt (it is a payment record, not a follow-up), or ask for the code change and send receipts from HighLevel. Stripe's own email setting alone may not stop it. |

Before moving any of these, check which HighLevel workflows and calendar notifications fire when the Hub books an appointment or adds these tags, so customers never get two of the same message.

### D2. Meta pixel

- `ads.html` and `thank-you.html` report to pixel `861741726934219`; every other page (including `/book`) uses `970332989051988`. Ads-page browser leads and Conversions API leads on the other dataset do not de-duplicate.
- **Decide:** in Meta Events Manager and Ads Manager, check that no active ad set, custom conversion or thank-you URL rule optimizes on `861741726934219`. If none does, ask for the unification change (both pages move to `970332989051988`). If one does, re-point it first.
- Also B1 step 1 (the Zap `inquiry_id` mapping).

### D3. Jobber cutover date

- Pick the freeze day (Day 0) and a 1-2 week parallel run. The full plan is [JOBBER-CUTOVER.md](JOBBER-CUTOVER.md).
- On Day 0: turn off Jobber's automatic client messages (reminders, follow-ups, review requests) so customers do not hear from both; pause Dispatch changes, AI scheduling and customer scheduling links while the import runs.
- Switch Jobber off only when every item in its section 6 is ticked. Keep Jobber read-only for 30 days after.
- After the cutover, set the tracking cutover date (FUN) so earlier periods are labelled partial.

### D4. Payroll burden rate

- Get your payroll burden rate (employer taxes and insurance on top of wages) from your accountant or Gusto.
- This build has nowhere to enter it yet. Until it does, job labor shows **before burden** and is marked provisional, never guessed.
- Also for the accountant: the Colorado overtime readings in [4.7](#47-timesheets-and-payroll), and whether timecard bonuses count toward overtime (tips do not).

### D5. Other decisions with defaults

- **Pricing:** review every value in `functions/_data/pricing-settings.defaults.json` (placeholder $75/h labor, 20% markup, $450 minimum, 50% deposit) and the 113 unverified catalog prices before customers see catalog pricing. Then re-check prices every 90 days (first round due 2026-12-27).
- **Test contacts:** HighLevel contacts tagged `test`, `egc-test`, `internal`, `vendor`, `dnc` (and similar) are left out of the numbers. Mark your own and case-study jobs internal.
- **HighLevel self-booking:** later, whether the Hub should adopt walkthroughs customers book themselves in HighLevel (`EGC_BOOKING_AUTO_RECONCILE`), after a dry-run check.

## If something goes wrong

**Any Cloudflare switch:** delete it (or set the value the card says) and **Retry deployment**. Railway switches: delete and apply.

| Stage | Switch off | Then check |
| --- | --- | --- |
| Before anything | Bridge: `EGC_OPERATIONS_ENABLED=false` on egc-api, egc-mcp and Cloudflare | Hub schedules sync to HighLevel directly again |
| 1 | `EGC_STAFF_PAGE_GATE=off` | Staff pages open without the gate |
| 2 | Delete `WEB_LEAD_ADS_RELAY_ENABLED`, then `WEB_LEAD_RECEIPTS_ENABLED` | Web3Forms emails for any lead in doubt |
| 3 | Delete `EGC_WALKTHROUGH_VISIT_ENABLED`, `EGC_STAFF_ROLE_ACCESS` or `EGC_STAFF_DIRECTORY_ENABLED` | Timecards of reps with open walkthroughs; Hub → Integrations for pending Firebase sign-outs |
| 4 | Delete the `EGC_DISPATCH_…` or `FIELD_EXPENSES_ENABLED` switch; crew app: `/crew/sw-config.json` (developer); delete `EGC_GHL_TAG_OUTBOX` only after `EGC_SCHEDULE_SYNC_WORKER` is off | Dispatch saves; crew phones reload; HighLevel booking tags |
| 5 | Delete `MONEY_API_ENABLED`, `MONEY_DOCUMENT_ENABLED` or `PAYMENT_REVIEW_CHECKOUT_BLOCK_ENABLED` | Do not re-save itemized estimates in the old editor |
| 6 | Delete `FIELD_CUSTOMER_PHOTOS_ENABLED` | Portal shows no photos |
| 7 | Delete `MCP_OAUTH_SHARED_LOGIN_ENABLED`, `MCP_OAUTH_HUB_IDENTITY_ENABLED` or `EGC_MCP_PUBLIC_ORIGIN` | Consent page |

**Where to look:**

- **Hub → Review queues** and the Command Center alert: held charges, member matches, messages with unknown delivery.
- **Hub → Integrations:** which keys are ready.
- **Cloudflare → the project → Functions logs** (real-time): Hub errors, including `web_lead_receipt_unavailable`.
- **Railway → service → Logs:** `messaging_cron` lines (worker), start-up checks (MCP).
- `https://egc-api-production-faeb.up.railway.app/health` and `https://easygaragecleaning.com/api/operations-service-keys`: is the bridge up.
- **Firebase console → Firestore:** `web_lead_receipts`, `payment_reviews`, `message_sends`.
- **Stripe → Webhooks:** failed deliveries. **HighLevel → contact:** tags, notes and the conversation.

**Messages you might see:**

| Message or code | Meaning | Fix |
| --- | --- | --- |
| Error 1102 | Cloudflare free-plan time limit | [B2](#b2-move-cloudflare-to-workers-paid-5-a-month) |
| `purpose_key_unavailable` | `HUB_SESSION_SECRET` or `HUB_PURPOSE_KEY_SECRET` too short | [B3](#b3-secrets-to-set-first) |
| `service_signing_not_configured` | Bridge off or secret too short | [B3](#b3-secrets-to-set-first), [B5](#b5-railway-platform-and-the-signed-bridge) |
| "Connections are off" | `EGC_MCP_PUBLIC_ORIGIN` not set | [7.1](#71-and-72-hub-approved-connections) |
| `delegate_invalid` (AI) | `HUB_SESSION_SECRET` changed | Reconnect; developer revokes old AI connections |
| `FIELD_EXPENSE_INDEX_REQUIRED` | Missing `fieldExpenses.incurredOn` exemption | [B4](#b4-publish-firestore-rules-and-indexes) |
| `hub_funnel_storage_unavailable` | Funnel indexes not deployed | [B4](#b4-publish-firestore-rules-and-indexes) |
| `timesheet_policy_invalid` | Typo in `EGC_OVERTIME_POLICY` | Delete it (Colorado) |
| `money_payment_needs_review` | An old payment on the job is not verified | [5.2](#52-server-money-records) step 2 |
| `messaging_cron_disabled` | Expected in lead-retries-only mode | Nothing |
| "Prices could not be loaded from the Hub" (walkthrough) | `/api/pricing-config` is failing | Open it signed in as owner; if it says `pricing_config_unavailable`, tell your developer |
| Clock-in fails with an index error | Timecard read needs an index | Set `EGC_EMPLOYEE_VAULT_QUERY=legacy`, retry the deployment, tell your developer |

## Coming in the next batch

Not in this build. No steps yet; each will come with its own switch, off by default.

- **FUN-06:** the iPad walkthrough recorder with Start and Finish ([3.4](#34-start-and-finish-after-fun-06)).
- **SYNC-QUEUE:** server-driven HighLevel calendar sync, so it no longer waits for a manager's Hub to be open.
- **RECUR-CRON:** the hourly recurring-plan worker and a price on each recurring visit ([Stage 4](#keep-off-for-now)).
- **P1-06:** time-off requests and approvals on the server (needs you to say "merge P1-06").
- **PAY-TIMESHEETS** and **JOB-COST-PRIVACY:** pay and labor cost owner-only in the timesheet API, payroll CSV and job costing.
- **HUB-PWA:** the Hub as an installable app, with an offline queue for clock-ins and chat.
- **CATALOG-ADMIN:** the Hub screen for the catalog and pricing settings.
- **CHANGE-ORDERS** and **TIPS:** billing approved change orders; optional crew tips on card payments.
- **QUOTE-DRAFT:** unsigned quote drafts that reach the customer only after a confirmed human send.
- **FIELD-MULTIDAY**, **DISPATCH-DURATION**, **CREW-PROFILE:** per-day visits for multi-day jobs, suggested job length from the quote, crew profiles and photos in the portal.
- **FUN-30:** a register of every customer-facing automation.
- **M5-SEND:** the Hub **Invoicing** screen (issue one invoice or a batch; HighLevel's `egc-invoice-issued` workflow sends it, the Hub sends nothing), under [5.2](#52-server-money-records).
- Optional messaging (will sit under [Optional](#optional-only-if-you-want-the-hub-to-send-through-highlevel)): **CLIENT-LOGIN** (customer portal sign-in links), **CREW-NOTIFY** (crew schedule texts).
