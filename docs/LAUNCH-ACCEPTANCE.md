# EGC Hub launch acceptance

This is the finite operational launch gate. [GO-LIVE.md](GO-LIVE.md) remains the
detailed runbook; its optional features and historical steps are not all launch
requirements. A green build is not live acceptance. Record the exact release,
time, test identity, observed result and evidence for each gate below.

## Ownership

- **Hub:** authoritative jobs, visits, crew assignment, approved pricing, work
  status, costs, signed scope and completion evidence
- **HighLevel:** contacts, conversations, customer confirmations, reminders and
  follow-up. The Hub mirrors approved operational facts; a booked customer must
  leave every pre-booking sequence
- **Release coordinator:** code, synthetic checks, deployment identity and
  evidence. The owner approves pricing, paid changes, access grants and release
- **Operations owner:** booking accuracy, job readiness and physical-device
  acceptance; finance owner verifies approved rates and job/money totals

## Required gates, in order

| Gate | Pass evidence | Current state / next action |
| --- | --- | --- |
| 1. Data and release health | Authenticated Integrations read probe is readable; existing roster, Walkthroughs, crew schedule and portal documents load; exact production commit recorded separately for Pages, API, MCP, worker and portal | Open. On September 30, Firebase Spark usage reported that its daily 50K read limit had been exceeded in the previous seven days. Console data reads succeeded, so that alone does not establish the current cause of the earlier Hub HTTP 429. Inspect once after the owner's billing/setup work; do not treat a plan change as proof of recovery |
| 2. Booking → HighLevel → stop old follow-up | One synthetic service booking appears once in Hub and the correct HighLevel calendar; GHL receives booked status/tags; every pre-booking workflow exits; exactly the intended confirmation/reminder remains; reschedule/cancel preserves history without duplicate messages | Open. A real historical booking still received a pre-booking text. Audit all published, paused and draft workflow triggers before changing tags or activating the outbox. Reconcile unknown appointment/message outcomes before any retry |
| 3. Customer / applicant separation | An explicitly applicant-tagged contact is excluded from sales counts, sales repair queues and Meta eligibility; recruiting records remain accessible; an ordinary customer is unchanged | Code correction proposed here. `applicant`, `applicant-active` and delimiter-separated applicant lifecycle tags produce `job_applicant`. It does not guess from names, ad copy or conversation words. Reconcile the exact tagged contact after release and verify the stored projection; existing snapshots do not change merely because code was deployed |
| 4. Approved pricing | Owner approves labor, markup, minimum and packaging rates; reviewed settings save under a new version; one synthetic catalog quote saves and reopens with the exact server-priced totals and terms | Open. PR #98 implemented the composer and guarded save. Unapproved rates and unverified/stale/hidden products remain blocked. Do not publish researched prices merely because they have a source |
| 5. Complete field job | Assigned crew can open the synthetic job, upload before/after photos, record costs, obtain sign-off and complete/reopen the job without losing evidence | Open. Existing company Drive OAuth and Production bindings must be restored first. `/api/drive-auth` uses `drive.file`; the owner handles credential entry and any new access grant. Verify the ordinary job-photo path, which is separate from field-payment receipt storage |
| 6. Office handoff | A saved transcript yields one reviewed internal task, survives reload, completes once and retains history | Manual path already accepted in PR #92. Automatic AI extraction remains open until existing-account credits work; use a fresh synthetic transcript. Do not retry the already manually approved original source |
| 7. Money and closeout | Current release prerequisites, rules/indexes, ledger review and unified-total checks pass; a synthetic job has consistent authorized totals; no unverified money is presented as paid | Open for field collection. Keep `EGC_FIELD_PAY_ENABLED` off until its existing rollout gates pass. Refunds and milestone tags remain separately gated; no real charge is needed for this test |
| 8. Role and physical-device acceptance | Owner, manager, sales/phone and crew see only permitted actions; physical iPhone double-tap, deliberate pinch, signature, portrait and landscape checks pass | Browser regressions are available; physical-device acceptance is still open. Follow the current mobile checklist and do not label emulation as a physical-device pass |

## Safe test rules

1. Use clearly internal test records with a designated owner-controlled destination
   only when a message test is explicitly approved. Otherwise verify drafts and
   tracking with notifications off. Never send to a real customer as a test
2. Read provider history before retrying any unknown operation. An unknown result
   can already have succeeded; a retry may duplicate a booking or message
3. Do not enable `EGC_SCHEDULE_SYNC_WORKER` before the reviewed GHL tag outbox and
   its drain worker are active. See [HIGHLEVEL-BOUNDARY.md](HIGHLEVEL-BOUNDARY.md)
4. PR #78 has separate lead-intake fixes that change which workflow-trigger tags
   actually arrive. Review/port those changes onto current main with the workflow
   audit; do not overwrite the current durable lead-receipt implementation
5. Merge/deploy, paid changes, new permissions, credentials and real customer
   communications require the appropriate explicit authorization. This checklist
   and its draft PR do not authorize them

## Read-budget recovery

The general employee record endpoint currently queries the whole encrypted staff
vault before applying role filtering. A visible normal Hub tab refreshes at most
once a minute; crew chat refreshes every 15 seconds. A hidden tab does not poll.
At 100 vault records, one eight-hour normal tab would read roughly 48,000 vault
documents, before other screens, accounts and workers. That is an illustration,
not a measured production count.

This change backs off repeated failed reads to 2, 4, 8 and then 15 minutes.
Successful reads reset the cadence. Manual refresh, returning to the foreground
and read-after-write remain immediate so timecards and saves are not left stale.
This reduces repeated failures; it does **not** solve successful whole-vault scans.

The bounded next improvement is a scoped/incremental employee feed:

1. Measure aggregate document reads by endpoint and active tab, without logging
   decrypted records, names or credential values; establish the real daily budget
2. Design a server-authenticated feed that can request only visible collections
   and changes since an opaque cursor, including deletions/revocations. Filtering
   a full response in the browser does not reduce billed database reads
3. Prove no cross-role disclosure, no missed payroll/clock-out changes, no offline
   replay regression, correct logout/cursor invalidation and bounded recovery from
   expired cursors. Avoid shared plaintext caches of payroll or employee records
4. Compare an eight-hour synthetic normal/chat workload to the old read count;
   release only with an explicit freshness contract and measured improvement

This is a follow-on design, not an implemented or enabled feed.

## Snapshot evidence

- Source baseline: `c3dc926263b8bc011838b9e756376c3d98821de9` (PR #98)
- Baseline local root regression: 4,358 passed, 11 emulator-only skipped, zero
  failures. Synthetic tests do not establish production credentials or quota
- September 30, 18:57 UTC: direct API and MCP health endpoints returned
  `665beb1ee0b8e57dbf1c5e8359bde3bd00f7b8b8`, database ready. Verify deployment
  identity per service; frontend and backend may deploy independently. The
  `egc-platform` subtree is identical between that commit and PR #98's main
  commit, so the older platform hash is not evidence of a missed platform fix
- Existing manual-office acceptance and historical release evidence remain in
  [HANDOFF.md](HANDOFF.md) and [handoff/follow-ups.json](handoff/follow-ups.json)

Launch is complete when all eight gates have explicit acceptance, or when the
owner approves a documented narrower launch with its unavailable features kept
disabled. A missing check is an open gate, not a pass.
