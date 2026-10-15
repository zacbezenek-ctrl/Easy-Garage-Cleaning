# Crew completion and Denver job starts

## Architecture and change

The canonical path is `/crew/job.html` → `/api/field-jobs` → `fieldCommand` (or its multi-day visit wrapper) → one Firestore commit. The existing commit requires a canonical job, current revision, assigned access, completed required checklist, verified before/after photos, and closeout notes. It records the server time, actor, evidence, immutable request receipt, and `job.completed` funnel event. `FIELD_LEAD_ONLY_COMPLETE=true` narrows assigned crew to the job's lead; business managers retain their existing access. This change does not alter that policy.

The existing `fieldCompletionSync` handoff sends an internal CRM completion note and check-in through the operations bridge. It does not add the job-complete tag. The older manager `post_job` flow also writes tags, a pipeline stage and review-ready state. Calling that older flow from crew completion would add unwanted side effects.

With **both** `EGC_GHL_TAG_OUTBOX=true` and **`EGC_GHL_FIELD_COMPLETION_TAG=true`**, a newly verified field completion now creates an entry in the existing `ghlTagOutbox` in the same transaction as the job and receipt. Its key comes from the canonical job ID and completion request ID. `fieldCompletionTagEntry` keeps this separate from the job's last scheduling entry. No second completion endpoint or worker is introduced.

The existing signed `/api/ghl-tag-drain` worker and its dispatch Command center retry/status view own delivery. The crew job page shows the completion tag's pending, verified, parked, or unknown state separately from the internal note handoff. Only `egc-job-complete` is added. No payment, invoice, commission, customer acceptance, opportunity, appointment, review-ready tag, SMS, or email is changed by this new delivery path. Existing independent note/check-in behavior is preserved.

## Delivery safety

- The linked contact must match the canonical job and configured HighLevel location. No contact is created or guessed.
- A revision-fenced claim prevents competing worker attempts. The sending intent and contact are persisted **before** the external POST.
- The same claim transaction verifies the canonical job revision. The worker rechecks the job's completion and contact after the HighLevel preflight, immediately before POST, and before recording verified delivery. A cancellation or contact change after a possible POST keeps the receipt parked and visible rather than treating it as safely superseded.
- A per-contact ownership record in the existing server-only `ghlTagDrainState` collection is acquired in that same transaction. Different jobs cannot compete for the same contact-level tag or treat another job's uncertain send as their own receipt. Ownership stays with an uncertain request; after a verified/rejected result, another job may acquire it only after checking that the old tag is absent.
- The worker reads HighLevel tags back after a successful POST. A lost response or failed final database save leaves a durable sending intent. The next attempt reads back only; it cannot blindly POST again.
- A confirmed 4xx refusal other than 408 can back off and retry. An uncertain result parks for review. A manager retry preserves the sending intent, so it still only reconciles.
- If an earlier job already left `egc-job-complete` on the contact, this completion parks as `ghl_tag_completion_preexisting`; it is not falsely marked delivered. Operations must review the existing workflow's reset/re-entry behavior. This change never removes tags.
- Cancellation, replacement of completion evidence, or a changed canonical contact cannot send a stale completion. An unknown/missing outbox record is visibly unknown.
- Each completion consumes three of the existing drain's five subrequest-budget units because canonical transactions and provider read-back cost more than a schedule tag. A backlog continues on subsequent two-minute ticks.

## Activation blockers — not changed by this PR

1. Independently review and merge the PR; deploy through the normal process. Nothing is enabled or deployed here.
2. Review the existing **tag-added `egc-job-complete` workflows** and their re-entry/reset behavior. A tag can trigger customer communications even though this code does not send a message. Owner approval of any such communications is required before enabling this flag. Do not activate workflows as part of this fix.
3. Set the two flags above only after that review. `HIGHLEVEL_API_KEY`/`HIGHLEVEL_LOCATION_ID` (or their existing GHL aliases) need contact read/tag-write access to the intended location. No credential or permission changes were made.
4. The existing Railway tag-drain worker must be running, with the signed v2 operations bridge configured (`EGC_OPERATIONS_ENABLED`, v2 service auth, workspace/actor binding). Its check-in and stuck count are visible in the Command center. Existing deployment instructions define the signing configuration; do not create a new principal.
5. Existing internal note/check-in delivery still has its own bridge/check-in prerequisites. Completion tag success does not imply that independent handoff succeeded.

There is no historical backfill. Jobs completed while the new flag is off receive no new tag entry. A parked unknown receipt must be reconciled in HighLevel before an operator decides any further action; clearing an outbox sending marker is not a supported retry procedure.

### Current configuration evidence (2026-10-15)

Read-only GETs to `https://easygaragecleaning.com/api/operations-service-keys` and `https://egc-api-production-faeb.up.railway.app/operations/service-keys` both returned HTTP 200, `egc-service-auth-v2`, workspace `egc`, the expected issuer, and one public key. No keys, credentials or customer records were collected. This proves public-key discovery is available; it does **not** prove a worker is enabled, a signed drain succeeds, or HighLevel delivery works.

This execution environment has no connected Cloudflare/Railway configuration reader, authenticated Hub session, or runtime flag values. Therefore the current production values of `EGC_GHL_TAG_OUTBOX`, `EGC_GHL_FIELD_COMPLETION_TAG`, `EGC_GHL_TAG_DRAIN_ENABLED` and `FIELD_LEAD_ONLY_COMPLETE` are **unverified**, not assumed off. The blank `.env.example` values are examples, not deployment evidence. No flags were changed.

| Required check before activation | Owner/operator evidence to retain |
| --- | --- |
| Cloudflare Pages `EGC_GHL_FIELD_COMPLETION_TAG` remains unset/false until approval | Read the actual production and preview variables; do not infer from source defaults |
| Pages `EGC_GHL_TAG_OUTBOX=true` for delivery | Preserve existing schedule integration; do not toggle this shared switch just to test completion |
| Railway **egc-worker** `EGC_GHL_TAG_DRAIN_ENABLED=true` | Recent `ghl_tag_drain` completed result and non-stale Hub Command center worker check-in (tick every 2 minutes; stale at 10 minutes) |
| Hub service auth resolves to v2 and operations is enabled | `EGC_OPERATIONS_SERVICE_AUTH=v2` or existing v2 default, valid existing `HUB_SESSION_SECRET`, operations not explicitly disabled, and matching workspace `egc` |
| Worker can sign as API service | Existing `API_BEARER_TOKEN` is valid for the API public key; identity is integration `ghl-tag-worker`, path `/api/ghl-tag-drain`, command `ghl_tags.drain`. Do not copy or rotate secrets for this test |
| Hub can store canonical receipts/outbox/claims | Existing Firebase service-account configuration can commit jobs, field events, `ghlTagOutbox`, `ghlTagDrainState`, and service nonces; browser access remains denied |
| HighLevel exact contact/location access | Existing `HIGHLEVEL_API_KEY` and `HIGHLEVEL_LOCATION_ID` (or GHL aliases) identify the intended location and can read contact tags and add the completion tag |
| Lead-only closeout, if required operationally | Verify actual `FIELD_LEAD_ONLY_COMPLETE=true`; named job crew lead and assignment must be correct. This PR preserves the existing flag-controlled policy |

### Safe acceptance and deployment order

1. Require independent review and all required CI green before merge. The scheduling policy has no activation flag; a deployment containing this PR changes new/rescheduled starts immediately. If scheduling must ship separately, extract only the policy/UI changes into a separately reviewed PR; do not turn on GHL delivery as part of that deployment.
2. Run the synthetic completion, retry, concurrency, scheduling and registry tests below. Their provider traffic is mocked. Use local/emulator fixtures or an isolated non-production environment; do not submit a test closeout against a live job. Turning the new tag flag off does not disable the pre-existing CRM note/check-in behavior.
3. Inventory **all** HighLevel workflows on `egc-job-complete`, including tag-added, opportunity, contact-change and re-entry paths. Record their customer messages, review-request actions, waits and tag-reset behavior. Existing tags from previous jobs park new entries. Approval to deploy code is not approval to send these messages; obtain the owner's explicit decision before enabling delivery. The automation registry keeps these listeners unverified.
4. After separate authorization for a provider write, use a dedicated test location/contact with customer communications disabled and synthetic jobs only. Verify one canonical receipt, one outbox entry and one contact claim; observe a verified read-back, and repeat the same request to prove no second tag addition. Simulate unknown responses in mocks, never by disrupting a live request.
5. Only then enable the new completion flag in the intended environment through the normal approved configuration process. Observe both the worker check-in and a real authorized job's outbox receipt before describing delivery as live. A successful deployment or public-key GET alone is insufficient.
6. If delivery is uncertain, keep the job completed, inspect its parked entry and contact claim, and reconcile the provider record. Do not clear `steps.completionTag`, delete a claim or blindly retry a POST. Disabling only `EGC_GHL_FIELD_COMPLETION_TAG` stops completion sends while preserving the shared scheduling outbox; queued entries remain available for review.

## Earliest job start

Effective for dates **2026-10-15 onward**, new or changed starts for `job`, `cleanout`, and `reorg` must be **09:30 or later in `America/Denver`**. Both authoritative writers (`mutateDispatch` and `mutateScheduledVisit`) enforce the same policy. Split jobs validate each newly placed segment, not merely the overall start. Normal Denver instant conversion still rejects nonexistent or ambiguous DST times.

Unchanged early starts remain intact when changing notes, crew or end time. Historical dates before the policy date are preserved; cancellations remain allowed; restoring an early future appointment requires a valid new start. The policy never silently moves appointments. Walkthroughs and company blocks are exempt. Booking/dispatch UI validates before saving and new service-job forms default to 09:30; walkthrough defaults remain independent. Capacity search may still show earlier generic openings because it also serves walkthroughs; selecting an early job opening is rejected by the booking boundary.

Before extending existing recurring plans that start before 09:30, operations must review and update the plan's start time. Newly generated post-policy occurrences cannot book the earlier time; existing saved appointments are not shifted. Recurrence tests use valid 09:30 starts so they continue testing recurrence independently of the new scheduling rule.

## Verification

New focused tests: `tests/crew-completion-ghl.test.mjs`, `tests/job-start-policy.test.mjs`. They cover assigned/lead access, required evidence, atomic duplicate receipts, financial separation, known refusal recovery, lost provider/final-store receipts, disabled configuration, changed contact/cancellation, 09:29 rejection/09:30 acceptance, winter/summer DST, historical preservation, split windows, UI parity and both server scheduling writers. All provider calls use synthetic fixtures; no live job or provider changes are used.

Run: `node --test tests/crew-completion-ghl.test.mjs tests/job-start-policy.test.mjs tests/field-execution.test.mjs tests/field-permissions.test.mjs tests/ghl-tag-outbox.test.mjs tests/dispatch-service.test.mjs`. In a process-restricted environment, use `--test-isolation=none`.
