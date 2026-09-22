# EGC operations release status — September 22, 2026

## Current release, not the earlier shadow-mode checkpoint

The consolidated native dispatch, signed walkthrough handoff and recoverable crew release is merged in [PR #60](https://github.com/zacbezenek-ctrl/Easy-Garage-Cleaning/pull/60), source revision `038c1186ba7c69aafca34d82854fa11677a88bf2`. The GitHub comparison from tested revision `064b8fbea8e89dbc3af5a49adc07f605a4a611a0` to this merged revision contains **zero changed files**. PR #58's field implementation and PR #59's customer/source/project concurrency fix are included; neither is an outstanding alternative release path.

**Meta CAPI is now in production mode and real eligible events have been accepted.** The previous statement that it remained in shadow mode is historical, not current. Exact deployment and runtime observations are maintained in the [PR #60 release discussion](https://github.com/zacbezenek-ctrl/Easy-Garage-Cleaning/pull/60#issuecomment-5779402403). Do not infer later live counts from a dated checkpoint.

The earlier canonical-intelligence rollout history remains available [at its original revision](https://github.com/zacbezenek-ctrl/Easy-Garage-Cleaning/blob/4badb946613d829610511ab5feabd4a87acb84a5/docs/operations-release-status.md). The v2 Hub/API signing bridge was already repaired before this field release; do not diagnose a new missing shared secret from older build notes.

## Authority and shipped behavior

The existing Cloudflare Employee Hub remains authoritative for customers, projects, walkthroughs, jobs, scheduling, operational scope and financial evidence. PostgreSQL retains normalized provider records, source extraction, canonical customer events, actions and durable reconciliation/conversion ledgers. This release does not move the operational schedule into a competing PostgreSQL job model.

- Native dispatch supports day/week/crew/job views, crews, vehicles, availability, capacity openings, job history, reassignment, rescheduling, cancellation and explicit restoration, with server-enforced conflicts and durable request recovery.
- The signed walkthrough now saves through an owner/manager-authorized server handler, not a direct browser Firestore writer. The customer, source walkthrough, project, accepted quote, original signature time, job schedule, locks and request receipts are committed atomically. A CRM outage does not discard the saved Hub job.
- Browser reload, double-click, lost response and CRM/photo retry reuse the original actor-scoped request. Changed unresolved signed content requires explicit recovery; an intentional quote revision requires renewed acceptance. Original payment/deposit receipts and prior signed evidence remain preserved.
- Crew work uses assigned-only Today/job access, scope, access instructions, navigation, checklist, materials, notes, private photos, issues and intentional completion. Legacy cleanout/reorganization jobs use the same authorized workflow.
- Walkthrough reference photos are private and visible to assigned crew, but never satisfy before/after completion evidence or mark work started. Job elapsed time remains distinct from employee timecards and payroll.
- CRM synchronization reads the actual saved handoff instead of trusting browser-supplied prices or provider identities. Accepted quote, booked work, visit completion, work completion and verified payment remain different facts.

## Executed release checks

The full combined Hub suite passed **867 tests, zero failures**, with one emulator-only suite skipped in that default run. The separate actual Firestore emulator run passed **8 tests with zero failures and no skips**.

All four CI workflows passed for the identical release source: Operations Integration `35747726077`; Firestore Rules and Dispatch `35747725746`; Action Center `35747725761`; Platform CI `35747725735` (successful rerun job `106815064223`). Checks include platform typechecking/unit tests/builds, migrations applied twice, durable action/appointment/recording/communication recovery, and migration-drift validation.

The actual browser/Firestore acceptance passed the full manager dispatch-to-crew-completion day. It also passed signed walkthrough save, reload and exact replay after a CRM outage, canonical customer/project/source preservation, private crew reference-photo access and preservation of original payment and source-visit status. Test customer/signature/photo/Drive storage are isolated fixtures, not production customer evidence.

Cloudflare Pages production check `106816404442` succeeded for source `038c118` with deployment `53b1785d-7897-4494-8e49-14f4938d59e6`; password-verifier build `65d58c6d-cef5-4ed1-a60b-9ceb4e1607b9` also succeeded. These are the Cloudflare source-deployment checks, not a Vercel preview. Per-service Railway deployment and authenticated runtime read-back observations belong in the linked release discussion; a requested deployment or configured `EGC_RELEASE_SHA` alone is not success.

## Verified CAPI delivery and replay

At `2026-09-22T14:56:48Z`, the production ledger showed **19 accepted real events**, each with one attempt: 9 qualified leads, 7 walkthrough bookings, 2 delivered quotes and 1 won job. Acceptance timestamps were `14:48:14.074–14:48:17.462 UTC`. A subsequent automatic scan reported 19 already-synced/locally-deduplicated events, zero newly sent, zero pending and zero failed. The detailed checkpoint is [PR #58 comment 5778841512](https://github.com/zacbezenek-ctrl/Easy-Garage-Cleaning/pull/58#issuecomment-5778841512).

The new worker deployment `58a079c7-9ef4-497a-a508-e6ddd827c5e1`, source `038c118`, independently logged at `15:39:46.478 UTC`: production mode, dryRun false, 19 alreadySynced, 19 locallyDeduplicated, newlySent 0, pending 0, failed 0 and productionBlockerCount 0. Its permanent log contains only bounded aggregate fields. No token, customer matching values or raw Meta payload is logged.

Destination/stage/test-proof, source extraction, original attribution, DNC/test/internal/vendor exclusions, event age, value and accepted-delivery/idempotency guards remain in force. Historical reconciliation starts September 16 at 00:00 America/Denver. The detailed `14:56` coverage checkpoint held 25 incomplete-source events; it had zero missing canonical customers and 6 excluded customers. These categories overlap other reasons and must not be summed as conversions. Later scans may differ as new evidence arrives.

Meta API acceptance is not proof of Ads Manager attribution or the ad set's purchase-optimization mapping. That mapping remains `not_verified_by_this_integration`.

## Still requiring separate production evidence

1. **Firestore security rules publishing.** The release's rules pass the actual emulator suite, but an authenticated Firebase administration path must publish and verify them for project `egcw-1ec83`. This repair has not claimed a production rules publish. Do not weaken rules, create an authentication bypass, expose secrets or equate a code deployment with a rules deployment.
2. **Live human/device checks.** Actual employee login, physical iPhone camera/Safari, real Drive upload, production recording/transcription/human review, and the remaining [production acceptance matrix](operations-production-acceptance.md) are not certified by browser fixtures or readiness HTTP responses.
3. **Historical/source completeness.** Incomplete call/message extraction and ambiguous historical bookings remain held for exact-source reconciliation and native adoption. Do not manufacture signatures, amounts, completion dates or bookings, bypass hold gates, or label unknown coverage zero.
4. **Other external verification.** Marketplace signed webhook receipts, full historical revenue/refund coverage and ad optimization mapping require their own observed evidence; this field release does not certify them.

All walkthrough operations continue through the Employee Hub. Preserve initial acquisition attribution and cohort dates even when an older lead has recent activity or a newer Meta visit. Current-period activity must include older acquisition leads with recent messages/calls. Existing scheduled-task ownership, cadence, overlap controls and enabled/disabled states remain unchanged by this release.
