# Canonical quote document export (offline, unsent)

`functions/_lib/quote-document-export.js` implements the proposed
`egc_quote_document_v1` contract from PR129's `docs/knock-template-mapping.md`.
It converts a **server-read, estimator-approved canonical snapshot** into an
immutable mapping draft for `estimate`, `proposal` or `service_agreement`.
It has no route, storage, credentials, provider client, clock or environment
flags. It does not change quote authoring, legal clauses or payment settings.

The concrete gap closed is repeatable validation and projection between the
canonical Hub quote and a document-specific field payload. Native intake and
completion/scheduling remain owned by PR129 and PR130; their files are unchanged.

## Input authority and required preparation

The caller must run on the server and obtain records and evidence through
authorized reads. **Do not accept this snapshot, approval, linkage, exception,
tax treatment or signer authority from a browser/form body.** The shape checks
are not cryptographic authentication and do not create approval evidence.

`snapshot` contains:

| Field | Required source / meaning |
| --- | --- |
| `job` | Canonical Hub job and full `estimate`, including the saved job revision, estimate number/revision, exact cents/dollar mirrors, line items/selection, currency, scope, terms version and payment policy. The quoted customer name, phone, email and jobsite address come from this record. |
| `lineage` | Reviewed `{customerId, propertyId, contactId, locationId, evidenceId, verifiedAt}`. Customer/property must match the job; a saved job contact must match too. This represents verified canonical customer/property/provider linkage, not a contact lookup by name/phone. |
| `scopeExclusions` | Explicit reviewed array of contractual exclusions. An empty array means the reviewer confirmed none. Missing is a blocker. Operational `jobInstructions` are not used. |
| `tax` | Reviewed `{status:'verified', amountCents, treatment, summary, evidenceId}`. Supported treatments: `not_applicable`, `exempt`, `included_in_lines`. Unknown tax is never zero. |
| `legal` | `{termsVersion, templateVersion, textDigest, evidenceId, cancellationDeadline?, refundTerms?}` from the separately approved legal/template snapshot. Terms version must match the estimate; digest is a SHA-256 hex reference, not a verification of text this adapter never receives. Existing wording is copied, not generated or changed. |
| `signerRoles` | Exactly one `customer` and one `company` entry, each with `{role, partyId, name, email, authorityEvidenceId}`. Customer party must match canonical customer. These are planned roles, not signatures or a send request. |
| `policyException` | Explicit `null` for the reviewed standard policy, or the reviewed exception described below. Missing is a blocker. |
| `walkthrough` | `{id, revision, customerId, date}` needed only when deriving an absent standard payment schedule. Date is a verified Denver calendar date, `YYYY-MM-DD`; job date has the same format. |
| `provenance` | `{source:'canonical_hub', recordRef:'jobs/<id>', readAt:<timestamp with offset>}` from the server read. |
| `canonicalApproval` | Trusted estimator review evidence, bound as shown below. A saved estimate status or form checkbox is insufficient. |
| `intake` | Optional reviewed link with handoff reference, channel, house, `{kind,id,revision}` source, link evidence ID, canonical job ID, estimate revision and estimate fingerprint. No intake-to-job matching is performed. Raw submitted fields are not exported. |
| `customerAcceptance` | Optional independent verified acceptance evidence with `status:'accepted'`, `method` and the same revision/context binding. Otherwise output is `unverified`, even for estimator-approved drafts. |
| `paymentCollected` | Optional independently verified per-job ledger projection; see below. Absent means `unknown`, never unpaid/paid. |

The canonical quote model currently totals selected lines without adding a
separate tax. Consequently nonzero reviewed tax can only be
`included_in_lines` and does not increase the canonical amount. Additive tax
requires upstream canonical-model support and a subsequent adapter change.

### Review and export boundary

```js
import {
  exportQuoteDocument,
  quoteDocumentReviewBinding,
} from '../functions/_lib/quote-document-export.js';

// Upstream authenticated reviewer saves this binding with their review evidence.
const binding = quoteDocumentReviewBinding(serverReadSnapshot);
// Computing binding alone does not authorize or approve anything.

// Later, serverReadSnapshot.canonicalApproval must have been read from that
// trusted review record: {status:'approved', approvedBy, approvedAt,
//                       evidenceId, binding}.
const draft = exportQuoteDocument(serverReadSnapshot, {
  documentKind: 'service_agreement',
  existingSnapshots: priorDocumentMetadata,
});
if (draft.renderState === 'blocked') {
  // Surface draft.blockers for internal resolution. draft.payload is null.
}
```

`quoteDocumentReviewBinding()` uses canonical `estimateFingerprint()` and
separately binds job/storage revision, estimate revision/number, customer,
contact/property linkage, job date, exclusions, tax, legal/template reference,
roles, exception and walkthrough/intake context. These additional fields are
not all included in the existing estimate fingerprint. Changing one requires
fresh review; matching a total alone cannot validate an equal-priced selection.
Neither review evidence nor the missing review workflow is created here.

## Payment policy, historical terms and collection

With `policyException:null`, the saved policy must exactly match `FINAL_25_75`:
25% deposit; remaining cents **by subtraction**; deposit due later of walkthrough
day and job day minus seven calendar days; remainder due job day; Denver time.
The adapter uses the existing canonical helpers, validates the saved dollar and
cent mirrors, and never selects a policy from the lead channel.

If a valid `estimate.paymentSchedule` exists, its amounts, policy version, time
zone, date validity and order are checked and its dates are retained. A later
reschedule does not silently change an issued agreement's due dates. Historical
saved dates are covered by the trusted review binding; the adapter cannot
independently reconstruct an old issuance event from today's job date.

Without a saved schedule, only the standard policy can derive dates, from the
verified job/walkthrough dates. No dates or payment policy are persisted.

An exception is `{kind:'customer_exception'|'legacy_terms', status:'approved',
reason, evidenceId, approvedBy, approvedAt, paymentPolicy?}`. The policy comes
from `estimate.commercialPolicy`, or explicit reviewed `paymentPolicy` for a
legacy quote without one. If both exist they must agree. It carries its original
version, deposit/remainder percentages and due rules; percentages must total
100. A valid saved `estimate.paymentSchedule` is mandatory for exceptions.
Legacy terms are never upgraded to 25/75 and custom due rules are not recalculated.

`paymentCollected` is separate from contractual amounts and dates. Known ledger
states require `{status, appliedCents, evidenceId, recordedAt, jobId, customerId}`.
Supported states are `unknown`, `unpaid`, `partial`, `paid`, `overpaid`; arithmetic
and identity are checked. The adapter does not infer collection from a form,
deposit requirement, completed job, acceptance or existing `job.deposit.status`.
Remainder in the payment schedule is the contractual second installment, not a
fresh unpaid-balance calculation. No charge, refund, invoice or reminder is made.

## Output and native binding manifest

Every result says `deliveryStatus:'unsent_draft_only'`. A valid result says
`renderState:'ready_for_mapping'`; it never says ready to send or sign. Missing or
inconsistent required evidence yields named blockers and **null payload/display**.

`payload` includes canonical quote identity/fingerprint, customer/contact/jobsite,
scope/exclusions, customer-safe service rows, exact totals/tax, saved policy and
schedule, reviewed exception, legal reference, signer roles, independent acceptance
and collection, and provenance. Proposals/estimates retain unselected alternatives
with `selected:false, included:false`; agreements include selected/required rows
only. Tips, cost splits, catalog internals, crew details and signature images are
excluded. `display` contains escaped display strings with multiline scope/address
preserved. Preserve plain strings as literal values; never re-evaluate them as
template/merge expressions. Customer-facing renderers must label alternatives and
must not expose fields marked as snapshot metadata in the manifest.

`requiredNativeBindings` lists concrete logical paths, array cardinality/type,
document versus metadata destination, and explicit **null** native bindings.
The native template ID/version are null. These are not GHL field IDs or guessed
merge tokens. Actual picker bindings, repeating rows, formatting, safe rendering,
and template capacity must be supplied and tested separately. Envelope
`idempotencyKey`/`contentDigest` bind to snapshot storage, not visible document text.

The key is `egc-quote-document:v1:<jobId>:<documentKind>:r<estimateRevision>`.
`contentDigest` covers the projected content (including collection/acceptance
evidence); a later retrieval timestamp alone does not change it. Exact prior
metadata returns `disposition:'replay'`; different content at the same key or a
newer recorded revision blocks. Different jobs for one contact have different
keys. Already exported snapshots are not updated in place, even when payment
state later changes; a separate ledger read remains the live payment authority.

The adapter checks only supplied prior metadata. **Atomic create-only snapshot
storage, concurrent-claim handling and authorization remain a caller obligation.**
Do not store these values on shared mutable contact fields. The in-memory frozen
object and deterministic key are not a durable idempotency implementation.

## Remaining production integration gaps

1. Trusted server reads, a durable reviewed intake-to-Hub link and an authenticated
   estimator review/evidence store need to populate the required snapshot.
2. Verified tax treatment, contractual exclusions, legal/template references and
   signer authority must exist for each quote; current intake does not supply them.
3. Actual native GHL template/picker IDs, literal field bindings, repeating-row
   capacity and polished template rendering need native acceptance testing.
4. Durable atomic per-document storage and the existing explicit human
   revision-bound release/signature gates must be integrated before any send.
5. A controlled end-to-end test must verify template population and downstream
   behavior. This adapter neither executes that test nor activates workflows.

No PR129/130 modules, live forms, GHL documents, customer records, financial
settings, legal clauses, schedules or workflows were changed. No merge/deploy is
authorized by this work; independent review is required first.

Validation: `node --test --test-isolation=none tests/quote-document-export.test.mjs
tests/quote-payment-policy.test.mjs tests/quote-draft.test.mjs`.
