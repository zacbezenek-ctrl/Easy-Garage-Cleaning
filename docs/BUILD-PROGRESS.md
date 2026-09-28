# EGC build progress (resume point)

This file is the single resume point for the "EGC runs on its own software, run from Claude" build.
A new session must read this first, then continue from **Next**.

Branch policy: all work lands on `claude/amazing-shannon-n614n7` (the only branch this build session may push).
Each unit of work is one commit (or small commit series) prefixed with its unit ID, e.g. `P0-1:`; the branch has one
draft PR. The owner merges in phase order. See **Decisions** D-001.

## Status summary

| Phase | Status |
| --- | --- |
| 0 Baseline | in progress |
| 1 Multi-crew scheduling / crew hub / time / money | not started |
| 2 Garage catalog + walkthrough quoting | not started |
| 3 Transcript → phone-person follow-ups | not started |
| 4 Account-level customer portal | not started |
| 5 B2B client hub | not started |
| 6 MCP full read/write | not started |

## Done

- **P0-1** `tests/crew-availability.test.mjs:118` posted a hardcoded date (2026-09-23) that is now in the past.
  `crewAvailabilityHandlers` now accepts an injected `now` (same convention as `dispatchOpeningsHandlers`) and the
  test injects the fixture clock. No production behavior change (default `now` is the real clock).
- **P0-2** `tests/gallery-device-preview.test.mjs:27` asserted `gallery-preview-assets/gallery.js` was a byte copy of the
  internal gallery script. That file intentionally diverged in `2d4f5d5` (public showcase). Replaced with behavioral
  tests that execute the script against a fake DOM: no-grid pages untouched; search filter/count; manifest fetched
  only from `/gallery-showcase.json` with `credentials:'omit'`; invalid/hotlinked/duplicate items rejected; cap of 24;
  malformed/offline manifest keeps the existing gallery; no analytics/backend/storage. Mutation-checked (5 deliberate
  regressions each fail at least one test).
- Root suite after P0-1/P0-2: 934 tests, 933 pass, 0 fail, 1 skipped (emulator-only suite, run separately in CI).
- **P4-15** Staff (owner/manager) can revoke every homeowner portal link and session for a customer account:
  `GET/POST /api/customer-portal-revoke` bumps `customerPortalLinkVersion` on the verified account root and, by default,
  clears saved authorized people in the same atomic commit (receipts in server-only `customerPortalOperations`). Owner
  tokens now require an explicit signed `lv` and carry the account root `lr`. Gap: no Hub button yet (API only).
- **P4-01** Portal correctness: field statuses map to progress steps, top-level `arrivalWindow` first, no internal notes
  as scope, revision-checked job-day rules/authorized people (409), server-issued collaborator ids, injected clock.
  P4-13: `GOOGLE_REVIEW_URL` review card only when completed and paid, idempotent throttled click tracking, Hub state.
  With P4-15: collaborator invites carry the account `lv`/`lr`, so revocation ends them even when people are kept.
- **P1-01** Scheduling reliability: `/api/crew-jobs` scans every jobs page with a field mask (no 500-row cap; 503, never
  truncated), shift pickups write full day-lock entries, operations visits write `endDate/startAt/endAt/timeZone`, sync
  honors `endDate`, `dispatchHandlers` injects `now`, dry-run `scripts/repair-stale-schedule-instants.mjs`. Legacy
  `blocked_days` read-only behind `EGC_DISPATCH_LEGACY_BLOCKED_DAYS` (default off). Gaps: PTO approval is P1-06; `blocked_slots` ignored.
- **B2B-SEAMS** Business hub extension seams: registered actions/`?export=` exporters/snapshot decorators (built-ins win,
  modules register in `functions/_lib/business-hub-modules.js`), per-collection store id rules, requestId-idempotent
  `create_account`/`save_property`, no member/author ids or staff usernames in client snapshots, re-invite blocked only
  for signed-in members; `window.EGCBusinessHub` plugin API and mobile card layout (44px, 16px inputs, safe areas).
- **LI-CORE** Pure libraries (no I/O, injected `now`), not yet wired into production: `quote-model.js` (one line-item
  model in integer cents reading both legacy shapes, totals/selection/packages/deposit, estimate fingerprint),
  `money-core.js` (customer money totals incl. approved change orders, tips excluded, payment ledger, invoice from
  estimate; `MAX_TOTAL_CENTS` 1e8) and `quote-duration.js` (selected-line duration suggestion). Adoption is later units.
- **SEC-B** Security foundations (not yet adopted by production writers): `purpose-keys.js` (HKDF per-purpose HMAC keys
  from `HUB_PURPOSE_KEY_SECRET`, else `HUB_SESSION_SECRET`; fail closed), server-only append-only `hub_audit` via
  `auditWrite()` joined to the caller's commit (redacted, owner-only visibility) with owner/manager `GET /api/hub-audit`,
  and single-use 5-minute confirmation tokens (`confirm_tokens`, env-first `issueConfirmation`/`consumeConfirmation`).
- **SITE-0** Deterministic site generator: fixed build date (`EGC_SITE_BUILD_DATE`/`SOURCE_DATE_EPOCH`, recorded in
  `tools/site-build.json`), one private-scope walker (worktrees, venvs, caches never read), per-run leaks fixed,
  `npm run site:build` also re-renders `before-after.html`; drift test rebuilds in a temp copy. Nav drawer `inert`/focus
  and 44px footer taps (inline `footer-tap` stopgap until SITE-4 moves it into styles.css).
- **MSG-CORE** Approved-send core (nothing wired yet; `EGC_MESSAGING_ENABLED` off, dry run unless
  `EGC_MESSAGING_DRY_RUN=false`): GHL messenger resolving recipients from saved data only, versioned owner-approved
  templates (`/message-templates`), per-kind policies with Denver quiet hours, preview confirm tokens, CAS `message_sends`
  ledger (uncertain never resent), billing messages kept out of the crew-readable thread. Gaps: no reconcile action, no Hub link.
- **SEC-A** Firestore rules: business SDK sessions cannot write `secure_`/`_egc_` job ids (except day locks) or any doc
  whose stored/proposed recordType is server-owned; `audit_log` is append-only, bounded, attributed to the signed-in
  manager and server-timed (`serverAt == request.time`). Edge middleware 404s private source trees/configs (encoded and
  dot-segment bypasses included). Client audit guard follows P1-02's server-profile model (rules enforce).
- **M2** Crew card payments share the portal's Stripe recorder (`recordCrewStripePayment`), the webhook records
  `egc_job_payment` checkouts durably, and Stripe-confirmed charges the job cannot accept go to server-only
  `payment_reviews` (manager `GET /api/stripe-reviews`). Garage Guard memberships record once per event and link by exact
  phone/email behind `GARAGE_GUARD_MEMBERSHIP_SYNC_ENABLED` (off). Gaps: no review/resolve UI; no subscription.updated.
- **MCP-01** MCP tool registry (`defineTool` by class read/write/destructive/send/money: scope, required uuid
  requestId, preview-first two-step with no confirm verifier yet, sanitized results, filter-bound cursors) with
  `egc.safety_policy`. Safety: one-step MCP customer sends refused in operations mode unless
  `EGC_MCP_DIRECT_SENDS_ENABLED`; static bearer read-only unless `MCP_BEARER_WRITE_ENABLED`; audit actor = principal.
- **P3-01** Action kinds v2: `action-kinds.ts` is the one kind list (7 message kinds need a draft and provider-verified
  completion; `schedule_job`/`callback` internal), drafts carry up to 10 canonical https attachments, and migration 0013
  replaces the task guard so delivery proof must carry exactly the approved attachment URLs. The Hub shows every link
  before approval. Gaps: senders never attach yet, so tasks with attachments cannot complete; verify 0013 in CI first.
- **P3-13** Railway portal recorder retired: lead/customer/job/walkthrough links deep-link to the Hub
  (`/employee?view=action_center` or `?view=walkthroughs`), `/walkthroughs/[contactId]` is a handoff page, the 409
  `/api/walkthrough*` stubs are gone (now 404) and portal vitest render tests guard it. `scripts/verify-crew.mjs` (hard-coded
  ZacB hash) deleted with its .gitignore entry; audit #85 and #122 done. Gap: the deep link opens Action Center, not the visit tab.
- **CI-WF** Pending CI notes wired into existing workflows: Action Center CI runs the nav-drawer and message-template
  browser tests and the MCP safety Postgres check, with site sources in its path filters; business-hub acceptance gets a
  Playwright job; Firestore CI runs the hub-audit emulator file sequentially; the gallery workflows use
  `scripts/render-before-after.mjs` (+ nav-a11y). Workflow-only change.
- **CI-A** Always-on `egc-root-ci.yml` (root suite, `node --check` of every browser script/Function, before-after identity,
  and the suite again with `tests/helpers/shift-clock.mjs` moving the clock +400 days); Action Center no longer gates the
  platform on the root suite; frozen lockfiles, clean-tree checks, per-SHA push concurrency, business-hub PR runs, and
  field-execution acceptance in Firestore CI. Scans skip worktrees/QA output; vm realms inherit the shift (`vm-realm.mjs`).
- **BRIDGE** Signed Hub command registry: `hub.*` commands (strict zod, one shared dependency-free
  `hub-command-policy.ts` used by the API's `authorize()` and the Hub runner, fail-closed) reach Hub domains through
  `/api/operations`; actors are rebuilt from the current Hub profile, integrations only read via an owner-mapped delegate
  (`EGC_OPERATIONS_HUB_DELEGATES_JSON`). Proof reads: `hub.dispatch.overview`, `hub.staff.roster` (no pay). Writes get
  audited, idempotent `hub_command_operations` receipts (server-only rule). Gaps: no real write command or MCP tools yet.
- **SEC-C** `scripts/env-inventory.mjs` + `tests/env-inventory.test.mjs`: every env var the code reads must have a one-line
  `.env.example` entry (purpose, Unset behaviour, [secret|plain; where]) and nothing documented may be unused;
  `docs/env-inventory.md` is generated; a secret scan fails on committed live keys. Merged by the main session on the
  owner's approval; the 12 vars added by units merged since (messaging, dispatch windows, vault query, review URL, purpose
  keys, Garage Guard sync, MCP safety) were documented in the merge, and SEC-B's fake `sk_live_` fixture is built at runtime.
- **CAT-DATA** Audited garage catalog `functions/_data/garage-catalog.json` (version 2026-09-27.1: 239 products + 11 legacy
  services at today's `recommend()` prices, 62 needs), placeholder `pricing-settings.defaults.json` (blocks customer use),
  and `functions/_lib/catalog.js` (strict validator, need/zone lookups, Denver stale flag, per-unit integer-cent pricing;
  `catalogLine()` feeds LI-CORE strict). Merge: `quote-model.js` accepts dated catalog versions. Gaps: 113 prices
  unverified, 12 needs lack a verified option, 8 two-person items have doubled minutes; no UI/API/Firestore yet.
- **SITE-5** Mobile Lighthouse CI: `egc-lighthouse.yml` (pinned @lhci/cli 0.15.1, 375x812 simulated, median of 3,
  performance/accessibility >= 0.9, private artifact + job summary; warn-only until repo variable `LIGHTHOUSE_ENFORCE=true`)
  over a local server (`tests/lighthouse/serve.mjs`) with synthetic fixtures for portal, business hub and crew Today, plus
  a render check (`test_lighthouse_pages_ui.py`). Gap: local baseline has 5 of 12 pages below 90 on performance.
- **P1-07** Drive-time estimates (`EGC_DISPATCH_TRAVEL_ESTIMATES` off by default; offline Northern Colorado ZIP table, or
  Google Distance Matrix with a hashed 30-day cache and 25-call budget): dispatch warnings and openings (optional address
  or zip) use max(buffer, estimate), manager-only `GET /api/dispatch-travel` + Drive times dialog, and
  `EGC_DISPATCH_BLOCK_TRAVEL_SHORT` blocks only saves that move a stop. Gaps: crew self-assignment ignores estimates; no Routes API.
- **P1-05** Server recurring plans behind `EGC_RECURRING_PLANS_ENABLED` (off): pure Denver-calendar generator (weekly to
  quarterly, nth/last weekday, skipDates, endsOn/count), `recurringPlans` + receipts, idempotent `extendHorizon`
  (deterministic requestIds through unchanged `schedule.create`; conflicts saved unscheduled), manager
  `/api/recurring-plans`, Dispatch > Recurring plans/Repeat UI, and `saveSeries` plans when on. Gaps: no horizon cron
  (P1-DS-11); plan edits never move existing visits; visits still carry no price (#27).
- **P1-03** Payroll engine (manager-only reads, no UI): `timesheet-week.js` Denver Monday-Sunday workweeks with Colorado
  daily/weekly/12-consecutive overtime (greater of, never added) or federal via `EGC_OVERTIME_POLICY`, weighted regular
  rate, bonus/tips, manager-set paid PTO; `GET /api/timesheets` (JSON or guarded payroll CSV, only for settled weeks) and
  `GET /api/job-costing` (segment cost + spread OT premium, exclusive end). Employee requests cannot set paid PTO fields.
  Gaps: COMPS reading needs accountant sign-off; no UI; PTO pay set by API only.
- **P4-02** Customer identity keys: `customer-identity.js` (E.164 phone, lowercased email, fail-closed
  `findCustomerCandidates` that returns an id only for one current match), written by `resolveCustomer`, native CRM link,
  adoption and the walkthrough handoff; dry-run-by-default `scripts/backfill-customer-identity.mjs` that links only
  confirmed single matches in revision-fenced lineage components and never creates a second account root. Gaps: live
  backfill not run; native CRM link path does not bump the identity/schedule guards (quiet-window run).
- **F-EXP** Field cost capture behind `FIELD_EXPENSES_ENABLED` (off): `/api/field-expenses` records material, dump-fee
  and other costs (integer cents <= $5,000, optional private Drive receipt) at `jobs/{jobId}/fieldExpenses/{requestId}`
  with idempotent replays, manager edit/void receipts and audit, per-person and per-job limits; Job costs card on
  `/crew/job.html` only when the job payload says `features.jobCosts`. `sumFieldExpenses(env, jobId, {store})` for job
  costing. Gap: the date-range read needs a `fieldExpenses.incurredOn` collection-group index.
- **F-LEG** Legacy crew send paths hardened: `/api/quo-send` needs an idempotency key and claims a create-only
  `messageReceipts/quo_<sha256(key)>` receipt before calling Quo (replays never re-send; uncertain outcomes never
  auto-resend), crew texts render from the saved job and rate; drive-upload/agreement-upload use exact job ids with
  Drive-sized `egcJobKey`; crew-hook is business-only; exact same-origin JSON on all four. Audit #29, #75-#77 done.
  Gap: prejob confirmation still sends literal [TIME]/[N].
- **F-PWA** Installable crew app: `/crew/` manifest, versioned network-first service worker (static Today's work shell
  only, never `/api/*` or POSTs, `sw-config.json` kill switch) and `crew/field-outbox.js`, a per-user IndexedDB outbox
  that replays field and time-clock actions in order with their request ids and fresh revisions, stopping visibly on
  conflicts. Sign-out retires offline copies. `EGC_OFFLINE_CLOCK_ENABLED` (off) keeps phone clock times; off, stale
  offline clock actions are refused. Gaps: no Hub deviceTime review badge (keep the flag off); photos not queued.
- **B2B-SAFE** (B2B-06) Business-linked jobs never get a homeowner owner-level portal link: the accepted-quote invite is
  recorded as suppressed before any HighLevel call (re-checked after the claim), Copy portal link is 409 and collaborator
  invites 403. Company approvals store the approving actor/account/member ids (never shown in the portal), and older
  writers strip them from new approvals. Audit #28 and #99 done. Gap: links issued before a project was linked stay valid.
- **HUB-REG** Hub screen registry (`employee-hub-screens.js`: capability-gated, lazily loaded screens from one MANIFEST
  line; empty today) and UI kit (`employee-ui-kit.js/css`: safe `h()`, `/api/`-only requests with pending-request replay,
  Denver dates, CSV guard, cents). Shell stability: background refreshes keep typed drafts and focus, one boot load,
  persistent My day node, `?view=` history and deep links; 375px mobile pass; `/employee` may use the microphone. Audit
  #10, #11, #41-#48, #78, #79 done. Gap: no screens registered yet; img-src blob still blocked.
- **M4** Server-rendered estimate, invoice and receipt documents behind `MONEY_DOCUMENT_ENABLED` (off): `GET
  /api/money-document` (staff with business access, or the job's own portal session re-checked each request), no
  scripts, stylesheet-hash CSP, no-store, phone-first and printable; every figure from money-core. Pay button only
  when the portal checkout would charge exactly the due-now amount. Portal lists links; Hub print hands off. Gap:
  documents with change orders or tips show the right balance but no Pay button until the portal moves to money-core.
- **P4-09** Portal documents: certificate of insurance stored privately in Drive (server-only `portal_settings/documents`
  pointer with expiry and history; customers download only through the session-checked `/api/customer-portal-document`;
  owners/managers upload, renew or withdraw in Hub > Settings with requestId/fingerprint/revision CAS), plus the site's
  guarantee and terms copied verbatim at version `2026-09-portal`; approvals record the terms version shown (409 if stale).
  Merge renamed M4's portal field to `moneyDocuments`. Gaps: no Command Center alert for an expired certificate.
- **PHOTO** Customer before/after photos behind `FIELD_CUSTOMER_PHOTOS_ENABLED` (off; optional
  `FIELD_CUSTOMER_PHOTOS_SINCE` cutoff): one visibility policy (verified before/after on completed jobs; other
  categories only when a manager shares that photo; hide always wins), owner/manager share toggles on `/crew/job.html`
  via `/api/field-photo-sharing` (receipted, revision-checked), and a session-checked `/api/customer-portal-photo`
  stream with a portal gallery and camera capture. Gap: thumbnails stream full images; add a WAF rate limit.

## In progress

Each unit runs in its own git worktree (implement, then adversarial review, then fix) and is squash-merged here as
one prefixed commit only after the full root suite (and the platform suite when egc-platform/ changes) passes.

| Unit | Scope | State |
| --- | --- | --- |
| P1-01 | Scheduling reliability: crew list pagination, self-assignment lock entries, bridge startAt/endAt, multi-day GHL sync, legacy blocked_days (flag, default off), repair script | merged (6fa0fa1) |
| P1-02 | Employee vault store extraction + centralized business/owner identity (behavior-preserving) | building |
| P1-03 | Weekly timesheet + Colorado/federal overtime engine, server payroll CSV, job labor costing | merged (f21994f) |
| P1-04 | Arrival windows in dispatch, field and portal | building |
| P1-05 | Recurring plans: server record, generator, idempotent extendHorizon, API, UI | merged (a8bc498) |
| P1-07 | Travel-time estimates (offline ZIP-centroid estimator; optional Google; default off) | merged (ae810dd) |
| LI-CORE | One canonical line-item model (quotes, invoices, portal, catalog, duration) + money core + duration engine | merged (08b5ec8) |
| M2 | Crew card payments recorded via Stripe webhook + Garage Guard membership linkage | merged (e948368) |
| M15 | Retire dead legacy quote UIs | building |
| CAT-DATA | Researched garage catalog data file, schema validation, pricing engine, docs/GARAGE-CATALOG.md | merged (6e546f5) |
| P3-00 | **Production blocker**: walkthrough extraction crash (strict structured output) | building |
| P3-01 | Action kinds v2 (8 new kinds, drafts, attachments) + migration 0013 | merged (106af38) |
| P3-13 | Retire the dead portal recorder (Hub deep links) and scripts/verify-crew.mjs (audit #85, #122) | merged (4152a18) |
| MCP-01 | MCP tool registry/policy framework + safety defaults (sends blocked in operations mode, read-only static bearer, real audit actor) | merged (dfccb8d) |
| BRIDGE | Operations bridge command registry (API + Hub) with delegated human actors | merged (d821773) |
| P4-01 | Customer portal correctness fixes + review request tracking | merged (5a617a8) |
| P4-02 | Customer identity normalization + dry-run backfill | merged (41d8d70) |
| P4-15 | Customer portal link revocation (link version) | merged (754b885) |
| F-PWA | Crew PWA shell + offline action outbox (field actions + time clock) | merged (5125f94) |
| F-EXP | Field cost capture (materials, dump fees) | merged (302ab11) |
| F-LEG | Legacy crew send-path hardening (quo-send idempotency etc.) | merged (adc23c7) |
| MSG-CORE | Approved-send core: GHL messenger, owner-approved templates, message_sends ledger, messages API | merged (b7da326) |
| HUB-REG | Hub screen registry, UI kit, shell stability, mobile shell pass, microphone policy fix | merged (a4c5977) |
| B2B-SEAMS | B2B hub extension seams + mobile compliance + idempotency/leak fixes | merged (4edcf75) |
| SITE-0 | Site generator determinism/scope, regenerate stale before-after.html, nav a11y | merged (69ccc6d) |
| SITE-5 | Lighthouse CI (mobile perf/a11y >= 90) harness + workflow | merged (9ad1915) |
| SEC-A | Firestore rules hardening (vault/receipts/audit_log) + block private source paths | merged (c8905cd) |
| SEC-B | Purpose-scoped keys + server-only hub_audit + single-use confirm tokens | merged (75b9e1b) |
| SEC-C | Env inventory script/test + complete both .env.example files | merged |
| CI-A | Always-on root CI, split platform gate, clock-shift guard, field-execution acceptance in CI | merged (a067d1f) |
| CI-B | Pages Functions test router, parallel-safe emulator harness, Playwright iPhone/Android/desktop projects | building |
| B2B-SAFE | Portal B2B safety: no homeowner owner links for business-linked jobs; attributed company approvals (B2B-06) | merged (4dd1be5) |
| M4 | Server-rendered branded estimate/invoice/receipt document with pay link (MONEY_DOCUMENT_ENABLED) | merged (fac0a2c) |
| P4-09 | Portal documents: certificate of insurance (private Drive PDF via session-checked proxy), guarantee and terms (versioned) | merged (835f29a) |
| PHOTO | Customer-visible before/after photos, manager share toggle, portal photo stream (FIELD_CUSTOMER_PHOTOS_ENABLED) | merged (77ebb4f) |
| CI-WF | Wire merged units' tests into the existing CI workflows (pending CI notes) | merged (31e1562) |

## Next

Planned unit IDs referenced by the audit below (launched when their dependencies merge):
P1-06 server PTO workflow; P1-08 staff directory (roles incl. phone, skills, effective-dated pay, weekly availability);
P1-09 dispatch roster/permissions/settings/rules (skills, capacity); P1-10 assignment segments (multi-crew, split,
per-day windows); P1-11 calendar month + lanes + drag/tap-assign; P1-12 crew notifications; P1-13 day-before reminders
+ on-my-way; P1-14 recurring horizon cron; P1-15 timesheet review UI + geolocation policy + clock reliability;
M3 server money API + ledger; M5 invoice send; M6 batch invoicing; M7 payment reminders cron;
M8 tipping; M9 job costing; M10 dashboard; M11 money CSV; P2-02..P2-12 catalog settings/admin/itemized handoff/picker/
drafts/portal options; P3-02..P3-13 extraction v2, transcript input, follow-up policy, call transcripts, one-tap send;
P4-03..P4-14 magic link, account portal, crew profiles, photos, documents, invoices, isolation; B2B-01..B2B-08;
MCP-02..MCP-12; SEC-04, SEC-06, SEC-07, SEC-12, SEC-13; CI-7..CI-14; SITE-1..SITE-4, SITE-6.

## Phase 0 audit: what is broken today

This audit comes from 14 read-only subsystem maps of the repository (Phase 0; no code was changed to produce it). Problems reported by more than one map are merged into one row that lists every location and takes the highest severity any map gave. Each row names the unit that fixes it: a launched unit (in flight now), a planned unit, or `NEW:` where no unit covers it yet.

Scope: all 188 findings the maps exported (160 bug reports plus 28 mission or infrastructure requirements rated broken). † marks a row that also covers a requirement a map rated broken.

### Critical (1)

> **Production blocker.** Walkthrough audio extraction crashes on every recording today. P3-00 fixes it and should merge first.

| # | Area | Problem (one sentence, plain English) | Where (file:line) | Fix unit |
| --- | --- | --- | --- | --- |
| 1 | AI recordings | **Every walkthrough recording fails at AI extraction:** the `evidence` record in the extraction schema makes `zodTextFormat` throw under the locked openai@7.20.0, so every managed recording ends as `recording_processing_failed` and legacy extraction returns 503 (no test runs the real extractor). † | `egc-platform/packages/ai/src/index.ts:52`; `egc-platform/packages/schemas/src/index.ts:48`; `egc-platform/apps/api/src/recordings.ts:89` | **P3-00** |

### High (16)

| # | Area | Problem (one sentence, plain English) | Where (file:line) | Fix unit |
| --- | --- | --- | --- | --- |
| 2 | Crew schedule | The crew schedule reads the shared `jobs` collection with one unordered 500-row query, and that collection also holds locks, receipts, availability and vault records, so past 500 documents crew silently lose assignments and open shifts. † | `functions/api/crew-jobs.js:118` (field map cites :297); read by `employee.html:1562` and `crew/index.html` | P1-01 |
| 3 | Time off | Approving a time-off request writes PTO blocks straight into Firestore from the manager's browser, skipping day locks, the dispatch revision, receipts and the check against jobs already assigned, and a mid-loop failure leaves partial blocks. † | `employee-suite.js:517` | P1-06 |
| 4 | Roles and access | Manager, dispatch and Action Center access is hard-coded to three usernames (zacb, tylerg, alexk), so a new manager cannot dispatch without a code change and the sales/phone person (Zoe) can neither be assigned follow-ups nor open the Action Center. † | `employee-suite.js:18`; `functions/_lib/hub-session.js:12`; `functions/api/operations-portal.js:24`; `functions/api/operations.js:8-14` | SEC-12 (data-driven roles), P1-08, P1-09, P3-04, P3-10 (P1-02 first centralizes the list, behavior-preserving) |
| 5 | Reminders | Estimate-expiring and invoice-overdue reminders fire from whichever manager's browser opens the Hub (at most 3 per load, nothing on days nobody opens it, and two managers can both trigger), instead of from a scheduled idempotent job. † | `employee-suite.js:230` (via retryDueSyncs :167 from loadAll :92) | M7 |
| 6 | Money | Card payments taken by crew are ignored by the Stripe webhook, so if the crew tab does not return to the post-job page the paid charge never reaches the job and the customer can be charged again. † | `functions/api/stripe-webhook.js:160`; `functions/api/job-payment.js:147` | M2 |
| 7 | Money | Every Hub finance change (estimate, invoice, deposit, payment, wallet credit, Garage Guard) is written from the browser with a blind merge and no revision check or server audit, so a concurrent webhook payment or second manager's edit can be overwritten. | `employee-suite.js:161` (actions at :251-279); `firestore.rules:239` | M3 |
| 8 | Quotes | If a customer approves in the portal while a manager has the estimate dialog open, saving the edit changes the amount but keeps the old approval, so a deposit checkout opens for a price the customer never approved. | `employee-suite.js:251` (write at :161) | P2-09 |
| 9 | Time clock | Clock-out stops location tracking before the request and has no error handling, so a network failure leaves the shift open on the server while the employee sees no error; clock-in, breaks and people actions also lack error toasts and double-tap guards. | `employee-suite.js:412` (also :411, :413-414, :516-523) | P1-15 |
| 10 | Hub shell | Background refreshes (60 s timer, visibility change, schedule and snapshot updates) re-render the Hub and wipe whatever someone is typing in chat, the customer thread, customer search or the scorecard. | `employee-suite.js:94` (render :101-116, refresh wrapper :561); `employee.html:1569` | HUB-REG (done) |
| 11 | Hub shell | The middleware sends `microphone=()` for every path except /copilot, so 'Start recording' in the Hub always fails and walkthrough audio can only be uploaded as a file. | `functions/_middleware.js:50`; `employee-recordings.js:15` | HUB-REG (done) |
| 12 | MCP | The OAuth consent text says sends are blocked in Action Center mode, but the send tools are not on the block list, so any write grant can text or email a customer in one call with no confirmation. † | `egc-platform/apps/mcp/src/oauth.ts:128`; `egc-platform/apps/mcp/src/operations.ts:15` | MCP-01 |
| 13 | MCP | The static `MCP_BEARER_TOKEN`, documented as diagnostic-only, passes every scope check including `egc:write` and never expires, so if it is set in production it is a full-write credential. † | `egc-platform/apps/mcp/src/oauth.ts:458-466` | MCP-01 |
| 14 | Public site | The next generator run would inject the marketing analytics loader (GA, Meta, Clarity) into the B2B client hub, the dispatch shell and the owner credential setup page, because they are missing from the private-page list. | `_generate_site.py:4120` | SITE-0 |
| 15 | Data security | The Firestore `jobs` rule lets any business browser session create, change or delete the encrypted employee vault records and the server's audit and idempotency receipts stored in the same collection, so a Hub session or leaked refresh token could erase timecards or forge receipts. † | `firestore.rules:236-240` | SEC-A |
| 16 | CI | The Action Center workflow runs the root `npm test` first, so any root failure skips the build, typecheck, platform tests, migrations, Postgres integration suites and drift check, which is why none of them ran on main for #73, #75 and #76. † | `.github/workflows/egc-action-center-ci.yml:49` | CI-A (done) |
| 17 | Public site | The static before-after.html fallback is older than the Function render (site-v4 vs site-v5), so the gallery identity check fails and main CI is red (Simple Page run 35942440846). † | `before-after.html:1`; `functions/before-after.js` | SITE-0 (done); CI-A (done) |

### Medium (46)

| # | Area | Problem (one sentence, plain English) | Where (file:line) | Fix unit |
| --- | --- | --- | --- | --- |
| 18 | Time clock | Clock-in is refused without location permission and then tracks location continuously, although the mission asks for an optional location stamp. † | `functions/_lib/employee-timecards.js:242` (also :102); `employee-suite.js:411` (watch :410) | P1-15 |
| 19 | Customer portal | When the crew marks a job 'arrived', the customer's progress bar falls back from 'On the way' to 'Scheduled', and there is no crew lead name, photo or ETA. † | `functions/api/customer-portal.js:43`; `functions/_lib/field-execution.js` | P4-01 (P4-07 adds crew lead name/photo) |
| 20 | Customer portal | When an estimate has no scope text, the portal shows the job's internal staff notes to the customer as the estimate scope, and signed walkthrough jobs never set a scope. | `functions/api/customer-portal.js:62`; `functions/_lib/walkthrough-handoff.js:184`; Hub estimate dialog prefill in `employee-suite.js` (opsFinanceAction) | P4-01 (Hub dialog prefill: P2-09) |
| 21 | Customer portal | Saving job-day rules in the portal has no revision check, so it can overwrite a concurrent staff or customer edit. | `functions/api/customer-portal.js:314` | P4-01 |
| 22 | Customer portal | Saving collaborators replaces the whole list with no revision check (a stale tab can restore a removed person and their old invite), and client-chosen ids starting with `biz_` collide with the business-actor path. | `functions/api/customer-portal.js:326` | P4-01 |
| 23 | Customer portal | Customer portal links (30 days) and sessions (7 days) cannot be revoked, so a link sent to the wrong person stays valid unless the global secret is rotated, which breaks every customer's link. | `functions/_lib/customer-portal.js:35` (data-security map: :38) | P4-15 |
| 24 | Quotes | Portal approval does not check which estimate revision or amount the customer saw and accepts draft estimates, so a staff revision made after the page loaded is approved unseen. † | `functions/api/customer-portal.js:245-266` | P2-08 |
| 25 | Quotes | Change orders the customer approves in the portal are saved as `approvedChangeTotal` but never added to the total, balance, invoice or Stripe checkout, so they are not billed. † | `functions/api/customer-portal.js:350-352`; `functions/_lib/customer-payments.js:17`; `employee-suite.js:232` | LI-CORE (totals math), then P2-11 |
| 26 | Quotes | Walkthrough handoff collapses the signed quote to a single 'Garage cleanout and reset' line, so add-ons (pressure wash, trapping, pest waste, shelving) never appear itemized on the estimate, portal, invoice or print. | `functions/_lib/walkthrough-handoff.js:70` and :91; `crew/gameplan-handoff.js` signedPlan() | LI-CORE (line-item shapes), then P2-05 |
| 27 | Money | Recurring visits copy scope and duration but not the price, so their invoices and deposits show $0. | `functions/_lib/dispatch-service.js:67` | NEW: carry per-visit price onto recurring visits (P1-05 plan occurrences inherit this gap) |
| 28 | B2B hub | Approving a quote on a B2B-linked job auto-sends an owner-level homeowner portal link (collaborators, wallet) to the job phone or email, which may be a tenant or on-site contact. † | `functions/_lib/portal-invitation.js:92`; `functions/_lib/walkthrough-handoff.js:184`; `functions/api/highlevel.js:570` | B2B-SAFE (done; was B2B-06) |
| 29 | Messaging | The crew arrival-text endpoint ignores the idempotency key the crew page sends, so a retry or double tap texts the customer twice; the body is free text with no DND/consent check and is not logged to the conversation. | `functions/api/quo-send.js:63-72`; `crew/prejob.html` (smsCustomer) | F-LEG (done; P1-13 moves on-my-way to the approved-send path) |
| 30 | Crew app | Pending offline field and shift actions live only in sessionStorage and only one can be queued, so a killed tab loses it and crew cannot record a second offline change. | `crew/job.js:15` | F-PWA (done) |
| 31 | Crew app | Marking a multi-day job 'complete' closes the whole job, with no per-day visit state for crews finishing day one. | `functions/_lib/field-execution.js:190` | P1-10 |
| 32 | Messaging | The sales-followup exit check scans the whole jobs collection and fails closed at 501 rows, so once jobs pass 500 documents GHL nurture sequences keep texting customers who already accepted. | `functions/_lib/sales-followup-exit.js:48` | NEW: legacy send-path hardening (bounded per-customer queries) |
| 33 | Staff and time | Dispatch and Hub rosters label every employee account 'crew', including the approved sales account, so roles disagree between the session and the roster. | `functions/_lib/dispatch-storage.js:21`; `functions/api/employee-hub.js:508` | P1-09 (roles from P1-08) |
| 34 | Staff and time | Every employee-hub poll (15-60 s per open client), every new record and every clock-in (twice) decrypts the entire employee vault, including all timecards and chat, with no pagination. | `functions/api/employee-hub.js:168` (also :263, :575) | P1-02 (adds per-collection reads); NEW: move the poll path onto them |
| 35 | Staff and time | Manager writes to employee records (pay-rate edits, request approve/deny) merge any client fields with no whitelist, audit history or revision check. | `functions/api/employee-hub.js:341` (writeOne :579) | P1-08 (profiles/pay), P1-06 (requests) |
| 36 | Dispatch | The legacy GHL calendar sync ignores `endDate`, so multi-day jobs are cut to one day or rejected when end time is earlier than start time. | `employee-suite.js:165` | P1-01 |
| 37 | AI recordings | Recording review turns proposed follow-up messages into 'manual' tasks without their draft, and `verify_deposit` proposals create tasks that can never be completed. | `employee-recordings.js:30` | P3-09 (after P3-01 kinds) |
| 38 | MCP | Audit rows for legacy MCP writes record the hard-coded actor 'chatgpt-mcp' instead of the verified principal, so the log cannot say who made a change. | `egc-platform/apps/mcp/src/server.ts:1889` (and 16 more call sites through :2914) | MCP-01 |
| 39 | MCP | `tasks.search` and `leads.search` take the 500 newest rows and then filter in memory, so filtered searches silently miss older matches. | `egc-platform/apps/mcp/src/server.ts:1375`; :1150 | MCP-01 |
| 40 | MCP | OAuth accepts only the hard-coded ChatGPT client and redirect and has no registration endpoint, so a Claude custom connector cannot authorize. | `egc-platform/apps/mcp/src/oauth.ts:84` | MCP-03 |
| 41 | Hub shell | Hub boot loads everything twice, doubling integration, HighLevel and walkthrough requests and running two concurrent retry passes for syncs and customer messages. | `employee-suite.js:562` (install :26) | HUB-REG (done) |
| 42 | Hub shell | Each 'My day' render replaces the field-today node, so the crew home unmounts, refetches and flashes 'Loading' two to three times a minute. | `employee-suite.js:117`; `employee-field-today.js:52` | HUB-REG (done) |
| 43 | Hub shell | In the booking modal, the CRM contact search box is re-created empty after results arrive, so the typed query disappears and the mobile keyboard closes. | `employee-suite.js:158` (input :144) | HUB-REG (done) |
| 44 | Hub shell | Hub navigation never updates the URL, so the phone back gesture leaves the Hub and views cannot be bookmarked. | `employee-suite.js:98` | HUB-REG (done) |
| 45 | Hub mobile | The mobile nav drawer has no scrim (the closing tap also clicks whatever is underneath) and its hidden links stay keyboard- and screen-reader-focusable, with no Escape or aria-expanded. | `employee-suite.js:26` | HUB-REG (done) |
| 46 | Hub mobile | Toasts never wrap, so 60-100 character messages are cut off on both sides of a 375 px screen. | `employee.html:538` | HUB-REG (done) |
| 47 | Hub mobile | On Weekly timesheets the button row does not wrap at 375 px, so the 'Download for Gusto' button is clipped and partly unreachable. | `employee-suite.css:35`; `employee-suite.js:321` | HUB-REG (done) |
| 48 | Hub mobile | Many Hub tap targets are under 44 px (rail nav, topbar Clock in/Refresh, drawer button, schedule Edit links, approve/reject buttons, dialog close, Action Center buttons and filters). | `employee-suite.css:10`, :15, :35, :36, :38, :63, :71; `employee-operations.css:4-5` | HUB-REG (done) |
| 49 | Hub shell | The Hub's meta CSP blocks blob image previews, external photos and blob audio playback (no media-src), and frame-src 'none' would block Stripe Elements. | `employee.html:9` | HUB-REG (partly done: media-src blob; img-src blob still missing); Stripe frame-src: NEW when a Hub payment screen needs it |
| 50 | Public site | Rerunning the site generator drops /before-after from the homepage nav and sitemap (the link only survives because publish-links.py is run by hand), which fails the gallery test. † | `_generate_site.py:642`; :4214 | SITE-0 |
| 51 | Public site | The generator stamps dates from the real clock (sitemap lastmod, privacy/terms, dateModified, llms/ai/humans files), so its output changes every day and cannot be tested. † | `_generate_site.py:14` | SITE-0 |
| 52 | Public site | The generator scans every `*.html` under the repo, including `.claude/worktrees`, so a run would list worktree URLs in ai.txt and rewrite other agents' pages. † | `_generate_site.py:3516`; ~:4123; :4140 | SITE-0 |
| 53 | Public site | The footer regex only matches a bare `<footer>` and never `<footer class="site-footer">`, so footer template changes never reach 12 frozen footer variants and a site-wide footer Client Login link cannot come from the template. | `_generate_site.py:3988` | SITE-2 |
| 54 | Public site | The closed mobile nav drawer is aria-hidden but still focusable, a likely accessibility failure on every public page (plausible, not measured). | `styles.css:162`; `_generate_site.py` ~:528 (NAV_JS_IIFE setOpen) | SITE-0 (part B) |
| 55 | Config and docs | Both `.env.example` files are incomplete: the root one omits the `EGC_OPERATIONS_*` bridge variables, several HighLevel stage/tag settings, `QUO_API_BASE` and the password-verifier settings, the platform one omits `EGC_OPERATIONS_SERVICE_AUTH`, `CUSTOMER_EVIDENCE_MODEL` and about ten more while listing unused ones, and the calendar variable is spelled differently in Hub and platform. | `.env.example:1`; `egc-platform/.env.example:1` | SEC-C |
| 56 | CI | The root regression suite only runs when egc-platform, functions, employee* or tests change, so edits to the customer portal, business hub, crew pages, dispatch, the site generator or public pages run no Node tests even though tests assert on those files. † | `.github/workflows/egc-action-center-ci.yml:11` | CI-A (done) |
| 57 | CI | The checked-in Firestore emulator port is fixed (8089, or 8090 for field day), so a second concurrent emulator run fails with 'port taken'. † | `firebase.emulator.json:4`; `firebase.field-day.json` | CI-B |
| 58 | Tests | The field-execution browser acceptance (clock-in, offline, lost-response coverage) runs in no workflow, binds fixed port 8793, writes artifacts outside the repo and ignores `PLAYWRIGHT_CHROMIUM_EXECUTABLE`, and the dispatch-field acceptance uses the real clock and device timezone. † | `tests/field-execution.browser.mjs:36`, :44, :49; `tests/dispatch-field.browser.mjs:28` | CI-A (done: field-execution in CI); NEW: injected clock for dispatch-field acceptance |
| 59 | Tests | Source-scan tests walked `.claude/worktrees` (5,172 of 6,035 scanned files), so results depended on other agents' in-progress files. † | `tests/source-files.mjs:7`; `tests/seo-walkthrough.test.mjs` (publicHtml) | P0-3 (done for `.claude`); CI-A (done: other ignores); SITE-0 (seo-walkthrough) |
| 60 | Data security | Any signed-in Firebase session, including crew, can create `audit_log` entries with any 'by' value, and business users can edit or delete them, so the collection is not a trustworthy audit trail (no emulator test covers the rule). † | `firestore.rules:258-259` | SEC-A |
| 61 | Data security | Bridge `schedule.mutate` (mutateScheduledVisit) checks no actor role, so any validly signed actor, including crew or crew lead, can create, change or cancel visits. | `functions/_lib/operations-scheduling.js:71` | SEC-04 |
| 62 | Data security | Middleware blocks only top-level private paths, so /egc-platform/**, /functions/**, /tools/**, /.github/**, firebase.emulator.json and pnpm-lock.yaml may be publicly served if Pages publishes the repo root (plausible; verify with a read-only production request). | `functions/_middleware.js:3` | SEC-A (part B) |
| 63 | Data security | Firebase custom-token claims (business access, role) live on in refresh tokens, so removing a Hub user or rejecting an employee does not revoke their direct Firestore access, and no revocation code exists. | `functions/api/firebase-session.js:18` | SEC-13 |

### Low / Info (62)

| # | Area | Problem (one sentence, plain English) | Where (file:line) | Fix unit |
| --- | --- | --- | --- | --- |
| 64 | Crew schedule | Dead helpers remain in crew-jobs.js (`scheduleConflict`, `pickupStageOpen`), and `scheduleConflict` repeats the same 500-row scan. | `functions/api/crew-jobs.js:81` | P1-01 |
| 65 | Dispatch | Bridge/MCP reschedules update date and times but not `startAt`, `endAt`, `timeZone` or `endDate`, so the field app can show stale times. | `functions/_lib/operations-scheduling.js:104` | P1-01 |
| 66 | Dispatch | Self-assignment builds day-lock entries without `type` and `assignmentKnown`, unlike every other writer. | `functions/_lib/dispatch-service.js:555` | P1-01 |
| 67 | Dispatch | Days and slots blocked in the legacy Hub screen are ignored by dispatch conflicts, openings and the bridge scheduler. | `employee.html:1616` (writers :1684-1699) | P1-01 (if safe read-only; else listed as a gap) |
| 68 | Dispatch | Dispatch customer search fires on every keystroke and each call scans up to 20,000 customer documents. | `employee-dispatch.js:363`; `functions/_lib/dispatch-service.js:185-190` | NEW: indexed, debounced dispatch customer search |
| 69 | Dispatch | Customer-facing arrival windows cannot be set or seen in dispatch, and the portal ignores the job's top-level arrival window that the crew sees. | `functions/_lib/dispatch-storage.js:15`; `functions/api/customer-portal.js:152`; `functions/_lib/field-execution.js:100` | P1-04 (P4-01 reads it in the portal) |
| 70 | Staff and time | Crew-created requests, incidents and equipment records store any client-sent fields, limited only by a 120 KB size cap. | `functions/api/employee-hub.js:394` (also :438) | P1-06 (requests); NEW: field whitelist for incidents/equipment |
| 71 | Staff and time | The Hub timesheet CSV exports every shift status with no approval, rate, break or overtime columns, so it is unsafe as a payroll export. | `employee-suite.js:325` | P1-03 (done: server CSV), P1-15 (review UI) |
| 72 | Time clock | Clock-in can attach the shift to a future job because the server checks assignment but not date. | `employee-suite.js:411` | P1-15 |
| 73 | Money | Job economics use a flat $20/hr labor cost instead of actual timecards and snapshotted pay rates. | `employee-suite.js:233` | P1-03 (done: labor cost API), M9 |
| 74 | Staff and time | All breaks are deducted from paid hours, with no paid rest vs unpaid meal distinction as Colorado COMPS requires. | `functions/_lib/employee-timecards.js:42`; `functions/_lib/gusto-timecards.js` (approvedTimecard) | P1-03 (done: calculation), P1-15 (recording break type) |
| 75 | Crew app | The crew home offline banner says checklist work will sync later, but that page has no queue or sync. | `crew/index.html:123` | F-LEG (done; also F-PWA, done) |
| 76 | Crew app | Photo upload truncates job ids to 60 characters (ids allow 180), so long ids are checked against the wrong job, and the Drive query does not escape backslashes. | `functions/api/drive-upload.js:276` (query :199) | F-LEG (done) |
| 77 | Crew app | The crew review-request/post-job branch in crew-hook.js is unreachable behind an unconditional 403 for non-business users, and it sets a wildcard CORS header. | `functions/api/crew-hook.js:73-94` | F-LEG (done) |
| 78 | Hub mobile | Hub forms show the wrong mobile keyboards (phone fields without type=tel, askAction cannot set inputmode) and use free text where a picker or select fits (assigned crew, announcement priority, Garage Guard plan/status). | `employee-suite.js:144` (also :127, :206, :208, :210, :421, :522) | HUB-REG (done) |
| 79 | Hub shell | Business users always land on the mode screen after login, so deep links like ?view=schedule need an extra tap. | `employee.html:2739` (enterEmployeeApp :1387) | HUB-REG (done) |
| 80 | Hub shell | Every Hub user, including crew on mobile data, loads the Google Maps JS API for an unreachable on-call flow, and the hidden legacy dashboard still re-renders on every refresh. | `employee.html:3190` (:2453, :798-821) | NEW: remove dead legacy code from employee.html |
| 81 | Hub shell | Hidden legacy markup calls 14 functions that are not defined anywhere and would throw if reached. | `employee.html:990` (and :2266) | M15 (quote modal handlers); NEW: remove dead legacy code from employee.html |
| 82 | Hub mobile | Copilot has 38 px voice/send buttons, smaller copy/logout buttons, and inputs under 16 px that make iOS zoom on focus. | `copilot.html:178` (:53) | NEW: copilot mobile fixes |
| 83 | Dispatch | Drag-to-reschedule uses HTML5 drag events that touch devices never fire and only changes the day, so mobile has no quick tap-to-assign. | `employee-dispatch.js:119` | P1-11 |
| 84 | AI recordings | Approving a recording adds a second recording-evidence entry to every task, and its excerpt is the commitment text rather than the quote. | `egc-platform/apps/api/src/recordings.ts:111` | P3-09 |
| 85 | AI recordings | The old portal recorder is still linked from the lead page but always gets 409, so staff can record audio that can never be saved. † | `egc-platform/apps/portal/app/walkthroughs/[contactId]/recorder.tsx:55`; `egc-platform/apps/portal/app/leads/[id]/page.tsx:26` | P3-13 (done) |
| 86 | AI recordings | RecordingService and the Hub approval path read the real clock instead of an injected one, so lease and expiry tests depend on wall time. | `egc-platform/apps/api/src/recordings.ts:77` | P3-03 |
| 87 | MCP | `/mcp-info` still says 'read-only MCP', and the connection doc claims there are no delete or messaging tools although they exist. † | `egc-platform/apps/mcp/src/oauth.ts:227`; `egc-platform/docs/chatgpt-connection.md:15` | MCP-01 |
| 88 | MCP | The OAuth login checks one shared password with no rate limit or lockout. | `egc-platform/apps/mcp/src/oauth.ts:276` | MCP-03 |
| 89 | MCP | The tools doc says `egc.revenue_summary` uses Hub quotes and verified cash in operations mode, but it always uses the Postgres customer-state report. | `egc-platform/docs/mcp-tools.md:126`; `egc-platform/apps/mcp/src/server.ts:1775-1782` | MCP-12 |
| 90 | MCP | GHL contact and opportunity writes have no requestId and are audited outside any transaction, so a retry repeats the provider write and an audit failure leaves no record. | `egc-platform/apps/mcp/src/server.ts:2404` | MCP-02 (audit); NEW: requestId on legacy GHL write tools |
| 91 | MCP | Version-1 MCP-to-API signed envelopes have no nonce store, so a leaked read envelope can be replayed within its 60-second window. | `egc-platform/services/operations/src/auth.ts:208` | NEW: retire v1 envelopes or add a nonce store |
| 92 | Messaging | Hub customer messages mark 5xx and timeouts (where GHL may have sent) as 'failed', inviting a duplicate resend, and send no idempotency key, timeout or DND pre-check. | `functions/_lib/customer-messaging.js:86` | NEW: legacy send-path hardening (on MSG-CORE) |
| 93 | Messaging | The HighLevel proxy has no request timeout, so a hung GHL call can use the whole function time during handoffs that also send portal invites. | `functions/api/highlevel.js:80` | NEW: legacy send-path hardening |
| 94 | Messaging | Portal invitations read the real clock, and failed invitations are retried only when a manager opens the Hub. | `functions/_lib/portal-invitation.js:82`; `employee-suite.js:246` | NEW: signed messaging cron (portal-invite retries) with injected clock |
| 95 | Crew app | Concurrent first photo uploads for a job can create duplicate Drive folders because folder creation is check-then-create. | `functions/api/drive-upload.js:79` | NEW: idempotent Drive folder creation |
| 96 | Customer portal | Estimate expiry compares against the UTC date (an estimate valid through today expires about 6 pm Denver), and portal handlers read the real clock so tests cannot inject time. | `functions/api/customer-portal.js:55` (also :254) | P4-01 |
| 97 | Customer portal | Inbound customer texts and emails attach to the contact's most recently updated job, so replies can land on the wrong job's thread. | `functions/api/highlevel-message-event.js:10` | P4-12 |
| 98 | Customer portal | Creating a portal link writes the job with no revision check and swallows errors, so link metadata can be overwritten or silently not saved. | `functions/api/customer-portal-link.js:50` | NEW: revision check in customer-portal-link.js |
| 99 | B2B hub | Estimate approvals by business members record only the typed name, not which company member approved. | `functions/api/customer-portal.js:249` | B2B-SAFE (done; was B2B-06) |
| 100 | B2B hub | Re-sending an invite to an active member resets them to 'invited' and logs them out of the hub and delegated projects. | `functions/_lib/business-hub-service.js:53` | B2B-SEAMS |
| 101 | B2B hub | Unlinking or relinking a project leaves requests showing a stale 'project_linked' status. | `functions/_lib/business-hub-service.js:163` | B2B-04 |
| 102 | B2B hub | Creating a company account or a new property has no idempotency key, so a retry or double submit creates duplicates. | `functions/_lib/business-hub-service.js:102` | B2B-SEAMS |
| 103 | B2B hub | The manager account list loads up to 50 full account documents (each up to 750 KB) just to show counts. | `functions/_lib/business-hub-store.js:28` | B2B-SEAMS |
| 104 | B2B hub | Account views send every member internal staff usernames and member ids. | `functions/_lib/business-hub-core.js:105` | B2B-SEAMS |
| 105 | B2B hub | Business hub tap targets are 34-40 px, inputs are 15 px (iOS zoom), and tables scroll sideways at 375 px. | `business-hub.css:1` | B2B-SEAMS |
| 106 | B2B hub | The business hub acceptance workflow runs only after merge to main and checks only anonymous endpoints. | `.github/workflows/egc-business-hub-acceptance.yml:2` | CI-A (done: PR trigger for node tests); B2B-08 / CI-11 (authenticated end-to-end) |
| 107 | Money | Crew card payments store no receipt URL, purpose or quote revision and leave the deposit 'due', and the Stripe key check rejects restricted `rk_` keys. | `functions/api/job-payment.js:44` | M2 |
| 108 | Money | The first Stripe payment creates an unnumbered 'partial' invoice, so the finance board shows an invoice before one was issued. | `functions/_lib/customer-payments.js:126` | M3 |
| 109 | Money | Recording an offline payment that clears the balance marks the job 'paid' even when the work is not completed. | `employee-suite.js:274` | M3 |
| 110 | Money | The Hub and the server compute the job total from different fields, so the Hub can show a different balance than the portal will charge. | `employee-suite.js:232`; `employee-suite.js:274`; `functions/_lib/customer-payments.js` (customerMoneyState) | M3 (on LI-CORE totals) |
| 111 | Money | Garage Guard Stripe alerts to Zapier are not deduplicated by event id, every `invoice.payment_failed` is assumed to be Garage Guard, and `.env.example` omits `checkout.session.async_payment_succeeded`. | `functions/api/stripe-webhook.js:163` | M2 |
| 112 | Quotes | The Hub's legacy quote modal calls three functions that do not exist (the Enter-key listener too), so it would throw if opened. † | `employee.html:1032-1041` (:1037); keydown :1545 | M15 |
| 113 | Quotes | The unused legacy contract modal uses a 25% deposit over $1,000 (policy is 50%), writes a second `quotes` collection and links to the retired /quote page. † | `employee.html:1789-1842` (:1800) | M15 |
| 114 | Quotes | The walkthrough gameplan labels its schedule inputs 'Arrival start/end' but handoff uses them as the job's full time block, so a short arrival window under-books the calendar. | `crew/gameplan.html:98`; `functions/_lib/walkthrough-handoff.js` | NEW: separate arrival window from job length in gameplan handoff |
| 115 | Quotes | Phone quotes, the walkthrough gameplan and the pricing page use three different price models, so phone ranges can contradict the walkthrough price. | `employee.html:2906`; `crew/gameplan.html` recommend(); `pricing.html` | P2-02 (M15 labels the phone range meanwhile) |
| 116 | Public site | The generator is not idempotent: each run adds a blank line after the nav on about 25 pages and a duplicate trust strip on loveland-garage-cleanout.html. † | `_generate_site.py:3082` | SITE-0 |
| 117 | Public site | Nav and footer logos are 195 KB and 135 KB PNGs (2400 px wide) shown at about 184x43 on every page. | `styles.css:4` | SITE-4 |
| 118 | Public site | Google Fonts is render-blocking on the gallery and several other pages (some service pages, garage-guard, thank-you, the customer portal, crew and Hub pages), and employee.html and crew/index.html load three Firebase SDKs synchronously. | `functions/before-after.js:11`; `garage-turnaround-fort-collins-co.html` and the other pages the site map lists; `employee.html`; `crew/index.html` | SITE-4 |
| 119 | Public site | The 'Customer Portal' link is added by JavaScript on only about 45 pages (not blog posts, FAQ or thank-you) and points to a page that needs a private token. | `site-enhancements.js:52` | SITE-2 |
| 120 | CI | Local CI-equivalent runs leave a dirty tree: `pnpm build` rewrites the tracked portal next-env.d.ts, and firestore-debug.log, .lighthouseci/ and field-qa/ are not gitignored. † | `egc-platform/apps/portal/next-env.d.ts:1`; `.gitignore:1` | CI-A (done) |
| 121 | CI | Turbo lists only dist/** as build output, so the portal's Next build is never cached. | `egc-platform/turbo.json:4` | CI-A (done) |
| 122 | Tests | scripts/verify-crew.mjs is a stale manual verifier that stubs retired Jobber endpoints and signs in with a session token derived from a hard-coded ZacB hash. | `scripts/verify-crew.mjs:25` | P3-13 (done; was CI-14) |
| 123 | Data security | About 120 lines of unused rule helpers (assignedUpdateIsSafe and three others) wrongly suggest that crew SDK writes are allowed. † | `firestore.rules:109-233` | SEC-A |
| 124 | B2B hub | The business audit log records only account, actor, action and time (no before/after or request id), and business session documents are never purged. | `functions/_lib/business-hub-service.js:42` | SEC-B (hub_audit writer usable by the B2B store); NEW: purge expired business sessions |
| 125 | B2B hub | Zoe's named sales invitation expired 2026-09-25 18:23 UTC; if unredeemed, staff setup returns 410 until the owner commits a new digest. *(info)* | `functions/_lib/staff-invitation-manifest.js:5` | NEW: owner re-issues the invitation if unredeemed (owner action) |

### Planned units referenced

Not yet launched.

- **Phase 1:** P1-06 server PTO workflow; P1-08 staff directory (roles, skills, pay, availability); P1-09 dispatch roster, permissions, settings and rules; P1-10 assignment segments; P1-11 calendar month view, lanes and tap-to-assign; P1-13 reminders and on-my-way; P1-15 timesheet review UI, geolocation policy and clock reliability.
- **Money:** M3 server money API and ledger; M7 payment reminders cron; M9 job costing.
- **Phase 2:** P2-02 catalog seed and pricing engine; P2-05 itemized signed handoff; P2-08 portal option toggling with revision-bound approval; P2-09 server estimate service (race fix); P2-11 bill approved change orders.
- **Phase 3:** P3-03 transcript input for recordings (injects the RecordingService clock); P3-04 follow-up assignment policy (phone/sales owner); P3-09 Action Center UI v2 and recording mapping; P3-10 "My follow-ups" workspace for sales/phone staff.
- **Phase 4:** P4-07 crew profiles and on-the-way projection; P4-12 account message record and deterministic inbound routing.
- **B2B:** B2B-04 client-visible request progress; B2B-08 B2B end-to-end acceptance.
- **MCP:** MCP-02 unified audit log; MCP-03 OAuth multi-client (Claude connector) with dynamic client registration; MCP-12 contract tests and production smoke.
- **Security:** SEC-04 bridge command authorization policy (including the schedule.mutate role check); SEC-12 data-driven staff roles and capabilities; SEC-13 Firebase session revocation.
- **CI:** CI-11 portal isolation and B2B end-to-end suites.
- **Site:** SITE-2 Client Login link site-wide; SITE-4 mobile performance pass.

**Count:** 188 input lines (160 bug reports + 28 broken requirements) deduplicated to 125 rows: 1 critical, 16 high, 46 medium, 61 low, 1 info; 31 rows cover broken requirements; 81 rows name a launched unit, 33 only planned units, 11 only `NEW:` work.

## Decisions

- **D-001 Branch/PR policy.** The mission asks for one PR per unit merged in phase order; this session may push only
  to `claude/amazing-shannon-n614n7`. Units are therefore separate, clearly prefixed commits on that branch with one
  draft PR. Merging to `main` deploys production (Cloudflare Pages git integration), so merge stays with the owner.

- **D-002 Parallel build.** Phase 0 fixes and later-phase foundations are built in parallel isolated worktrees because
  they touch disjoint files; merge order still follows phase order where units depend on each other, and every broken
  item from the Phase 0 audit is assigned to a unit before new features that depend on it ship.
- **D-003 One line-item model.** The money map and the quote-builder map each proposed a line-item model; there is one
  canonical model (`functions/_lib/quote-model.js`, LI-CORE) shared by quotes, invoices, portal toggling, catalog
  pricing, dispatch duration and MCP.
- **D-004 Behavior-changing fixes default off.** Where a bug fix changes live behavior (e.g. honoring legacy
  blocked_days in dispatch), it ships behind a flag defaulting to current behavior, and the owner checklist
  recommends the setting.
- **D-005 One confirmation system (planned).** MSG-CORE mints its own preview confirm token (HMAC keyed by
  'message-confirm' from HUB_SESSION_SECRET). SEC-B now provides purpose keys and `confirm-token.js`; follow-up M5 moves
  messaging onto SEC-B's `egc/confirm/v1` purpose key so there is one confirmation system. Not done in the MSG-CORE merge.

## Blockers

- Production verification of private-path exposure (`/egc-platform/**`, `/functions/**` served publicly?) could not be
  run from this container (egress policy blocks easygaragecleaning.com); SEC-A adds the 404 rule and the owner
  checklist gets a post-deploy check.
- Zoe's single-use sales staff invitation expired 2026-09-25T18:23:57Z; if it was not redeemed the owner must issue a
  new one (owner action, recorded for the checklist).
