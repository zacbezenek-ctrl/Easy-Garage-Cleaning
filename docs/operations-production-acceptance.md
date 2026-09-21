# EGC production acceptance

This is the release acceptance record, not a claim that the cases below already passed. Record the deployed commit, UTC observation time, exact source IDs, result, and evidence for every case. Use `passed`, `failed`, or `blocked`; local regression results alone do not certify a live case. Keep customer text, phone/email, audio, and credentials out of the release report.

## Read-only authenticated probe

Run `node scripts/operations-acceptance.mjs --manifest <local-fixture.json> --output <new-report.json>` with `EGC_ACCEPTANCE_MCP_URL` and `MCP_BEARER_TOKEN` already supplied through the existing secret-management environment. Never put the token in command arguments, source, a manifest, or shell output. The runner only initializes MCP, discovers tools, and calls a hardcoded read-only allowlist. It does not send messages, create records, trigger AI, or charge a card. Its aggregate report deliberately remains `productionAcceptance: incomplete_until_manual_matrix_evidence_is_recorded`.

The optional local manifest contains only already-created fixture IDs:

```json
{
  "portalJobId": "exact-hub-fixture-job",
  "portalVisitId": "exact-hub-fixture-visit",
  "taskId": "exact-existing-task-uuid",
  "recordingId": "exact-existing-recording-uuid",
  "expectedRecordingPhrase": "synthetic acceptance walkthrough"
}
```

First verify API, MCP, worker, portal and Hub revisions, applied migrations, health endpoints, and authenticated MCP discovery. Confirm queues are processing and capture `egc.operations_status.health`. Do not use readiness HTTP 200 alone as evidence of functional contracts.

## Live evidence matrix

Use a clearly labeled internal fixture customer and existing controlled test destinations, exact IDs, and disabled customer automations unless the routing case explicitly tests a controlled workflow. Preserve request IDs on retries. Historical repairs are separate from fresh acceptance activity. Never manufacture a real payment or customer signature for a test.

| # | Scenario | Required production evidence | Failure / safe recovery |
|---|---|---|---|
| 1 | Junk-removal lead | Controlled ingress has junk-removal classification and intended photo-quote workflow enrollment; GHL and EGC agree on exact contact ID. | Stop incorrect workflow for the test contact; inspect actual routing predicate, not report labels. |
| 2 | Transformation / organization lead | Controlled ingress reaches walkthrough route; absence from junk-removal/photo-quote enrollment is verified in provider workflow history. | Do not merely retag reports; inspect routing and retry controlled ingress. |
| 3 | Human no-answer outbound call | Exact provider call appears as outbound human attempt; outcome is unanswered and two-way remains false. | Generic completed state must not override no-answer/voicemail/screening evidence. |
| 4 | Two-way call | Actual controlled call has explicit human connection evidence and positive duration; contact timestamp matches source occurrence. | Unknown remains unknown; do not use a CRM stage as proof. |
| 5 | Customer inbound SMS | Exact inbound provider message appears once in customer history, with customer actor and original time. | Inspect signed webhook receipt, retry state and reconciliation checkpoint. |
| 6 | Authorized outbound SMS | Explicitly authorized controlled recipient, durable execution ID, exact provider read-back and separate accepted/delivered state; replay sends once. | Unknown execution is reconciled by exact observed provider ID; no new send request. |
| 7 | Reply creates next action | New unanswered fixture reply yields one canonical action with source message ID, verified Hub owner, due time and contact ID, including a booked customer. | Unresolved owner is visible in health; no invented assignee. Automation/failed sends do not close it. |
| 8 | Walkthrough created | Exact Hub visit/customer/project relationship and source revision, visible through `egc.visit_get` and Hub calendar. | Missing linkage or stale revision fails without a second visit. |
| 9 | GHL appointment sync | Hub visit links to one provider ID; read-back matches contact, calendar, time and status; durable operation accepted. | Hub remains saved with provider pending; retry same request. |
| 10 | Ambiguous appointment create | Isolated commit-then-error regression passes; live replay of accepted fixture request returns same visit/provider IDs and no duplicate. | Do not deliberately damage production networking; uncertain writes use reconciliation only. |
| 11 | Walkthrough completed | Exact Hub visit records actual completion timestamp and evidence; customer timeline includes the visit once. | Missing actual time/evidence rejected; update time is not completion time. |
| 12 | Recording processed | Real synthetic audio upload yields a durable recording before processing, then non-empty actual transcript and exact Hub links. | Failure preserves source object and safe error; explicit retry reuses same recording. |
| 13 | AI draft notes/actions | Stored extraction contains source-supported keep/scope/preferences/promises and draft actions; no authoritative job change before review. | Malformed output stays failed/reviewable; no price inferred from silence. |
| 14 | Human recording approval | Signed-in owner/manager reviews the exact revision; Hub receipt, approvedBy/approvedAt and selected canonical actions agree. | Stale source requires refreshed review; unknown commit replays identical fingerprint. |
| 15 | Quote | Read existing actual customer approval/accepted estimate with its original timestamp and value; draft/default CRM values excluded. | Missing amount remains null; historical repair does not become a sale today. |
| 16 | Dated follow-up | Canonical task has explicit owner, exact IANA-zone due time, completion condition and source evidence. | Ambiguous DST time, missing owner/deadline or mismatched visit rejected. |
| 17 | Hub / MCP same follow-up | Exact same task ID and revision visible in both Action Center and `actions.review`; edits read back identically. | No second local task list or cached success. |
| 18 | Completion and history | Internal task completion removes it from due queue; detail/history retains outcome and actor. Message actions require verified provider evidence. | Approval alone or staff assertion cannot certify delivery/payment. |
| 19 | Sold job from walkthrough | Exact sourceWalkthroughId, customer and project are preserved; actual customer acceptance/value evidence remains distinguishable from scheduling. | A scheduled job without approval is not a sale; never fabricate acceptance for canary. |
| 20 | Scope linkage | Exact Hub job shows staff operational instructions and reviewed notes in MCP, Action Center and crew pre/closeout brief; signed scope/value preserved. | Cross-customer linkage or stale revision fails; superseded notes remain in history. |
| 21 | Job completed | Hub job completion has actual occurrence time plus explicit evidence; timeline uses that time. | Closed-stage reversal and completion without evidence require review. |
| 22 | Payment/revenue | Read actual verified processor receipt IDs/amounts; sold, completed and gross cash are separate; duplicate session/intent counted once. | Unverified/offline/incomplete/refund coverage remains explicit; no live charge for acceptance. |
| 23 | Duplicate appointment repair | Before/after audit identifies exact authoritative Hub visit and provider IDs; one active real booking remains and history is retained. | Ambiguous candidates stay manual review; no name-only deletion. |
| 24 | Morning reporting | Saved brief has immutable task IDs/revisions/coverage; read-back flags later changes; financial totals use native verified semantics. | Unknown coverage is not zero overdue work or zero revenue. |
| 25 | MCP write/read | Repeat an authorized fixture task/note/scope mutation with same request ID; subsequent exact read proves persisted result and one audit/receipt. | Changed payload with same ID fails; stale revision never overwrites. |

## Recording / AI canary without a new public diagnostic route

Use the existing signed-in Hub recording workflow on the exact synthetic visit. Upload or record a short clip: “Synthetic acceptance walkthrough. Keep the blue bicycle. Remove the empty cardboard. I will call before work starts. No price has been agreed.” It contains no customer PII. The existing server alone calls transcription/extraction and accesses object storage.

1. Observe `uploaded` or `processing` in `recordings.get`; preserve the returned recording ID before refreshing.
2. Wait for `draft`. Verify the expected phrase in the actual transcript, the two item instructions, one supported proposed callback, and no invented price/owner/deadline.
3. Refresh/reopen the Hub and read through MCP to prove durability. Use the runner's optional recording probe for aggregate evidence.
4. As the authenticated human reviewer, inspect/edit the extraction, choose the verified owner and explicit due time, then approve. Do not impersonate a human reviewer with an MCP integration key.
5. Verify approved recording, exact Hub receipt/scope and one canonical callback. Replaying identical approval must not duplicate actions. Keep the synthetic audit history; cancel any test-only remaining action with a reason.

If production AI or storage configuration is unavailable, record cases 12–14 as blocked with the specific missing service/configuration. Synthetic local AI mocks prove failure handling, not production transcription.

## Error evidence and cleanup

The CI isolated PostgreSQL suites cover duplicate/out-of-order events, provider timeouts, commit-then-error, worker restart/lease reclaim, changed idempotency payloads, missing/cross-customer linkage, invalid extraction, and absent payment information. Preserve these results alongside the live matrix; do not inject destructive faults into production to recreate them.

For live uncertainty, keep the same IDs and inspect durable rows/receipts before retrying. Finish by checking failed/dead-letter/unknown states and source freshness, cancelling fixture visits/actions with audited reasons, and recording any controlled provider artifacts retained. Do not delete real customer history or label unresolved evidence passed.
