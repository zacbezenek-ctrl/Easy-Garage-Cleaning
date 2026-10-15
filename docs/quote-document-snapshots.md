# Authenticated internal quote document snapshots

Stacked on PR131's pure `egc_quote_document_v1` adapter. This integration adds
`GET/POST /api/quote-document` and durable job-scoped snapshot storage. It adds no
customer send, GHL document call, signature, charge or workflow activation.

The endpoint is **off by default**. Its server-only handler/service factory must
explicitly opt in with `enabled:true` after code and context provisioning are
reviewed. The exported production handlers retain `enabled:false`; no request
parameter can override it. Enabling those handlers needs a separate reviewed
wiring change. No new environment variable or persisted setting is introduced,
and no PR129/130 file is edited.

## Authorization and source authority

All reads and writes require the existing verified Hub session and
`requireQuoteAuthor` permissions. Owners/managers with dispatch access may work
across jobs. Other quote authors need an exact canonical username on the job's
`quoteDraft.createdBy`, its assigned crew IDs/usernames, or the same customer's
linked walkthrough assignment. Display-name-only objects grant no access.
Authorization is checked again on an idempotent replay.
The shared access boundary verifies the linked record is a canonical walkthrough
for the same customer before its assignment can grant access. Historical reads
use that same boundary; a job, template, missing or foreign-customer record can
never grant walkthrough-derived access.

The API accepts only job/document IDs, a request UUID and expected versions. It
does not accept prices, tax, clauses, signers, approval objects, contacts, payment
status, native field IDs, or caller-selected financial settings.

The server reads:

- Full canonical `jobs/<jobId>` and its versioned estimate.
- Exact `customers/<customerId>` and `properties/<propertyId>`; property customer
  and address and the canonical provider contact must agree. A matching name or
  phone number is never a fallback.
- The linked walkthrough and optional project, checked against customer lineage.
- `quoteDocumentContexts/<jobId>`, a **previously reviewed server-only context**.

The context contract is `{status:'reviewed', jobId, customerId, propertyId,
estimateRevision, estimateFingerprint, locationId, evidenceId, reviewedBy,
reviewedAt, scopeExclusions, tax, legal, signerRoles, policyException, intake?}`.
Its fields follow [the pure adapter contract](quote-document-export.md). It must
match the exact current quote fingerprint/revision. The context can contain the
reviewed legacy/customer exception; this endpoint never manufactures standard
terms to fill a missing one. Context size is capped at 128 KB.

This endpoint intentionally has **no context-write action**. A separate authorized
legal/tax/template-review workflow must provision those facts. Until it does,
the API blocks with `quote_document_context_missing` or
`quote_document_context_stale`; a raw form cannot supply them. Provisioning this
context, the review UI and actual native template bindings remain integration
requirements, not completed production setup.

## Endpoint contract

1. `GET /api/quote-document?jobId=JOB&documentKind=proposal` reads canonical
   source records and returns `reviewState`, blockers, the expected `binding`,
   `contextRevision`, a quote summary and unbound native manifest. When valid,
   `review` includes the customer-safe selected/options rows, scope, exact totals,
   tax, schedule, exception and previously reviewed legal/signer references. It
   is explicitly `unapproved_internal_review`, with no approval or release
   authority. Render these JSON strings as literal text, never HTML/merge input.
   GET
   also returns `currentSnapshot` when that revision was saved, and reports
   `already_snapshotted` or a conflict with the current reviewed context. GET
   does not approve or persist anything. Other supported kinds are `estimate`
   and `service_agreement`.
2. A human reviews the canonical quote and previously reviewed context. Submit
   same-origin JSON:

   ```json
   {
     "action": "approve_and_snapshot",
     "jobId": "JOB",
     "documentKind": "proposal",
     "requestId": "a fresh UUID",
     "expectedJobRevision": "GET binding.jobRevision",
     "expectedEstimateRevision": 1,
     "expectedEstimateFingerprint": "GET binding.estimateFingerprint",
     "expectedContextRevision": "GET contextRevision",
     "expectedContextDigest": "GET binding.contextDigest"
   }
   ```

   POST records this authenticated **internal estimator approval**, then calls
   the adapter with those server-derived facts. It does not record customer
   acceptance, change `estimate.status`/`customerApproval`, or release the quote.
   Missing required data or invalid money blocks before any commit. Successful
   responses include the immutable draft and `replayed` status.
3. `GET ...&estimateRevision=N` reads a saved historical snapshot. It returns
   `matchesCurrentQuote` and `state`, without rebuilding old prices or terms.
   `matchesCurrentQuote` compares the current job revision, estimate revision
   and fingerprint; it is not a new terms review or permission to send.

POST requires an explicit same Origin/Referer, JSON, and at most 4 KB. Duplicate
query keys and unsupported body keys/actions are rejected. Replies are
`Cache-Control: no-store`. An expired/stale expectation requires another GET
and explicit review. Unknown commit outcomes require the same UUID and body.

## Storage and atomicity

All new collections inherit the existing Firestore catch-all `allow read, write:
if false`; no browser SDK rule or client credentials are added.

| Collection | Key and purpose |
| --- | --- |
| `quoteDocumentContexts` | Canonical job ID; reviewed source facts, read only here. |
| `quoteDocumentSnapshots` | SHA-256 of `['quote_document_v1', jobId, documentKind, estimateRevision]`; immutable adapter output, content digest, whole-draft integrity digest, review binding and creation time. Capped at 512 KB. |
| `quoteDocumentApprovals` | Same snapshot key; exact internal approval actor/time/evidence and binding. Create only. |
| `quoteDocumentHeads` | SHA-256 of `['quote_document_head_v1', jobId, documentKind]`; highest approved snapshot revision. Updated with its prior Firestore revision as CAS. |
| `quoteDocumentRequests` | Lowercase request UUID; actor-bound hash of the complete request and the resulting snapshot identity/digest. Create only. |
| `quoteDocumentIssues` | Same snapshot key; read-only future delivery/issuance evidence. This endpoint never writes it. |
| `hub_audit` | Existing append-only audit helper; metadata of a new internal approval, atomically with its snapshot. |

The existing `dispatchStorage.commit()` protects **all consumed source revisions**
in a Firestore transaction. The snapshot, approval, head, request receipt and
audit are in the same commit. Snapshot/approval/receipt writes use `exists:false`;
the head uses `updateTime` when already present. Jobs, customers, properties,
walkthroughs, contexts and issued contracts are never mutated.

Exact retries return the prior result. A different request for an identical
snapshot claims its own request receipt without rewriting the snapshot. A
concurrent create loser rereads once; an unchanged result can become an
idempotent receipt-only replay. A changed source, conflicting same revision,
newer recorded head or reused UUID with changed content fails closed.
Historical reads and receipt replays also require a present, consistent revision
head whose target snapshot exists and matches its digest. A missing or corrupt
head requires explicit reconciliation; replay never silently reconstructs it or
claims success from an orphaned snapshot.

Two jobs sharing one contact have different keys and heads. No quoted values are
stored in mutable shared contact fields.

## Current versus issued, exceptions and money

Snapshots remain immutable after creation. `quoteDocumentIssues` may later hold
`{snapshotId, jobId, contentDigest, issuedAt}` from a separately reviewed issuance
flow; a mismatched marker blocks the history read. The endpoint can show such a
snapshot as `issued`, but has no issue/send action. A reapproval can only add a
request receipt; it cannot rewrite either the historical snapshot or the issue
marker. New canonical estimate revisions receive different snapshot IDs.

Saved installment dates and reviewed legacy exceptions pass through the pure
adapter unchanged. Negative/fractional/inconsistent money is rejected, not
normalized. Payment collection and customer acceptance stay `unknown`/`unverified`
here: the canonical requirement or an internal approval is not a paid receipt or
a customer signature. A future ledger/acceptance adapter must supply independent
revision-bound evidence. No pricing-cost/margin recalculation is performed.

## Validation and remaining rollout work

`node --test --test-isolation=none tests/quote-document-store.test.mjs
tests/quote-document-export.test.mjs tests/quote-payment-policy.test.mjs
tests/quote-draft.test.mjs tests/dispatch-storage.test.mjs`

Tests cover concurrent/duplicate claims, request conflicts, source CAS races,
negative money, different jobs on one contact, unauthorized reps, current versus
issued history, exact replay after response loss and the disabled HTTP boundary.
They use an atomic in-memory storage fixture plus the existing storage adapter
tests. A live Firestore/native-template end-to-end acceptance test is still
required before enabling this new endpoint. Independent review, context
provisioning/UI, native GHL bindings and the separately authorized send flow are
not bypassed by this implementation.
