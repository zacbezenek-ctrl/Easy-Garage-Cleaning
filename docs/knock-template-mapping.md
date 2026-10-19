# Proposed GHL proposal and service-agreement mapping

**Contract name: `egc_quote_document_v1` (proposed; no exporter or document sender is enabled).** This is the interface for the separate template worker. It defines the values and authority the templates need; it does not create GHL custom-field IDs, templates, sends, signatures, jobs or workflows.

The native form receives only the opaque handoff reference. Its submitted values are customer requests/corrections until reviewed into a canonical Hub quote. A form field, hidden rep ID, checkbox, typed price or uploaded signature must never replace the authoritative quote, identify the legal signer, accept terms, prove collection, or award commission.

## Two separate identities

Keep both identities in the template input:

1. `intake`: `handoffReference`, `channel`, `houseId`, and the exact `{kind,id,revision}` from `knock_form_handoffs`. The current `kind:"quote"` means a Knock Look/quote event, **not** an itemized Hub estimate. `kind:"sale"` means a Knock sale. Neither is automatically a Hub job/estimate ID.
2. `canonicalQuote`: `jobId`, `jobRevision`, `quoteNumber`, `estimateRevision`, `estimateFingerprint`, `customerId`, `projectId`, and `sourceWalkthroughId`, resolved by an authorized server read of the linked Hub job and customer. Preserve `estimate.revision` and the storage `job.revision` separately. Compute the fingerprint with `estimateFingerprint()` in `quote-model.js`, not a template-specific hash.

A reviewed, durable intake-to-Hub quote link is still required. Do not infer it from matching phone/name/address, a GHL contact custom field, or a form field. Until that link exists, `canonicalQuote` is null and the document is blocked. The receipt's `contactId` proves which provider contact submitted that reference; it does not by itself prove Hub customer/job ownership.

## Logical field map for the template worker

These are logical input keys, **not actual GHL field IDs or verified merge syntax**. Keep exact cents and source identity in the server-owned document snapshot. The worker should supply escaped, formatted display values separately, never round-trip formatted strings into pricing.

| Logical field | Authoritative source | Mapping rule / gap |
| --- | --- | --- |
| `canonicalQuote.jobId`, `jobRevision` | canonical `jobs/<id>` and its storage revision | Required. This PR does not link Knock intake to Hub jobs. |
| `canonicalQuote.quoteNumber`, `estimateRevision`, `estimateFingerprint` | `job.estimate.number`, `.revision`, `estimateFingerprint(job.estimate)` | Required together. A quote number or revision alone does not identify the exact content. |
| `canonicalQuote.customerId`, `projectId`, `sourceWalkthroughId` | saved job lineage, rechecked against customer/project/walkthrough records | Required customer; optional lineage fields remain null when absent. No inferred assignment. |
| `customer.name`, `phone`, `email` | verified saved quote/job customer snapshot (`job.customer`, `.phone`, `.email`) and matching `customers/<customerId>` identity | Keep quoted values for the document; explicitly reconcile a newer customer correction. A GHL contact read alone is insufficient. |
| `jobsite.propertyId`, `address` | `job.propertyId`, `job.address`, verified through existing customer/property lineage | Use the service location, which may differ from the customer's account/mailing address. Never substitute the Knock address without reviewed linkage. |
| `scope.title`, `description` | `job.title`, `job.estimate.scope` | Preserve multiline text, render escaped. Current Knock package/note is only intake context and may not contain agreed scope. |
| `scope.exclusions` | explicit reviewed contractual exclusions in the quote snapshot | No canonical dedicated exclusions field is guaranteed. `jobInstructions.exclusions` is operational capture and must not silently become legal scope; unresolved stays null/blocker. |
| `serviceItems[]` | `normalizeLineItems(job.estimate.lineItems, {strict:true})`, then `applySelection(lines, estimate.selectedIds)` when that field is present, before `included()`/totals | Validate the canonical selectedIds override, matching `estimateFingerprint()`. Preserve stable line ID, kind, name, description, quantity, unitCents, totalCents, optional, selected, taxable. Group/tier are retained for grouping and selection; quote proposals label unselected options clearly. Agreements include only the accepted selection. |
| `totals.currency` | current canonical quote currency contract | USD only for this proposed adapter; block unsupported currency. Do not infer currency from a typed symbol. |
| `totals.subtotalCents`, `discountCents`, `totalCents` | `estimateTotals()` over canonical lines, cross-checked with `estimate.amountCents` | Require `complete:true`, valid selection and exact total match. Discount total is positive; discount line amounts are negative. Exclude tips; optional unselected lines are not charged. Unknown is null, never zero. |
| `totals.taxCents`, `taxSummary` | explicit canonical tax policy/amount if the quote supports one | Not established by current Knock intake or by a line's taxable flag. Do not invent zero tax or calculate a new tax in GHL; flag absent tax treatment for review. |
| `paymentPolicy.version`, `depositPct`, `remainderPct`, `depositDueRule`, `remainderDueRule` | the saved `estimate.commercialPolicy` | Copy the saved snapshot, not current defaults. Legacy quotes without it need explicit review; do not upgrade their terms automatically. |
| `paymentSchedule.depositCents`, `remainderCents`, `depositDueDate`, `remainderDueDate`, `timeZone`, `policyVersion` | saved `estimate.paymentSchedule`, validated against its saved commercial policy and canonical quote total | Preserve an issued schedule. If absent, use existing `quotePaymentSchedule()`/`quotePaymentDates()` only with verified canonical walkthrough/job dates in a reviewed future adapter. Missing dates block an agreement; no fake due date. |
| `legal.termsVersion`, `legal.templateVersion`, `legal.textDigest` | `estimate.termsVersion` plus separately approved template/legal text snapshot | `termsVersion` alone is not the approved legal text or signature evidence. Actual GHL template IDs/versions and approved legal text belong to the separate template task and are still unknown here. |
| `legal.cancellationDeadline`, `refundTerms` | reviewed terms snapshot for that exact sale/quote | Knock's `cancelDeadlineDate`, `cancelEndsAt`, `earliestJobDate`, `refundCutoffHours` are preserved as intake-sale context; do not silently apply them to a different Hub quote/agreement. Exact legal wording and applicability need review. |
| `acceptance.status`, `acceptedAt`, `acceptedBy`, `method`, `estimateRevision`, `estimateFingerprint` | canonical `estimate` acceptance and `customerApproval` evidence checked against this revision/fingerprint | Missing, mismatched or superseded evidence means unaccepted. No GHL form checkbox/load/submission becomes acceptance. This PR adds no send/sign action. |

Do not put internal cost splits, markup, catalog internals, staff notes, crew instructions, commission rates, attribution IDs or receipt diagnostics into customer-facing rows. `quote-model.js` exposes `CUSTOMER_LINE_FIELDS` for the customer subset; grouping metadata can drive layout without exposing internal pricing provenance.

The exporter must resolve selection before formatting or totaling. Use the same saved estimate for identity/fingerprint and line selection; reject malformed overrides rather than falling back to line flags:

```js
let { lineItems } = normalizeLineItems(estimate.lineItems, { strict: true });
if (estimate.selectedIds !== undefined) lineItems = applySelection(lineItems, estimate.selectedIds);
if (!validateSelection(lineItems).ok) throw new Error('Canonical selection needs review');
const totals = estimateTotals(lineItems);
const chosenRows = lineItems.filter(included);
const fingerprint = estimateFingerprint(estimate);
```

Equal-priced alternatives must still render the exact chosen service IDs. Matching totals alone does not prove the selection is correct. Include this case in template acceptance tests.

## Envelope and release checks

The proposed exporter returns this logical structure; nulls are intentional blockers, not defaults:

```json
{
  "schemaVersion": "egc_quote_document_v1",
  "documentKind": "proposal",
  "renderState": "blocked",
  "blockers": ["canonical_quote_link_missing"],
  "intake": {
    "handoffReference": null,
    "channel": null,
    "houseId": null,
    "source": {"kind": null, "id": null, "revision": null}
  },
  "canonicalQuote": null,
  "customer": null,
  "jobsite": null,
  "scope": null,
  "serviceItems": [],
  "totals": null,
  "paymentPolicy": null,
  "paymentSchedule": null,
  "legal": null,
  "acceptance": {"status": "unverified"},
  "display": null
}
```

`documentKind` may later be `proposal` or `service_agreement`; it never chooses a workflow. A reviewed adapter must populate an immutable per-document snapshot keyed by the canonical job, estimate revision and fingerprint. Do not render from mutable GHL contact fields shared by two quotes for the same customer: the second quote could overwrite the first agreement's values. A material revision requires a new snapshot and invalidates old acceptance/release; existing accepted documents remain unchanged.

A proposal may be formatted for internal review once canonical identity, customer/jobsite, scope, selected items and complete totals match. An agreement additionally needs the exact approved legal/template version and resolved payment-policy schedule. Neither readiness level authorizes delivery. Customer release must continue through the existing explicit human confirmation and revision-bound send/acceptance gates. This PR does not call them.

## Confirmed 25% / 75% mapping for both estimator paths

For new standard quotes, **D2D and Facebook-direct estimator paths use the same canonical sent-quote policy** (`SENT_25_75` from 2026-10-19: deposit due on approval; this mapping was written for `FINAL_25_75`, which quotes sent earlier keep, and the export blocks `SENT_25_75` until its undated deposit has a binding) from `functions/_lib/quote-payment-policy.js`; the lead channel does not select the percentage. The existing `/api/quote-draft` save route already supplies this policy for new Hub quote jobs. The native form must not accept editable percentage or due-rule values as authority.

The total used is the final estimator-approved **saved canonical quote total**, validated against the selected service lines. A newly submitted total is an intake proposal until the authorized estimator saves/reviews it; it is neither customer contract acceptance nor money collected.

| Template value | Required calculation / authority |
| --- | --- |
| Quote identity | `canonicalQuote.jobId`, `quoteNumber`, `estimateRevision`, `estimateFingerprint`; retain `jobRevision` too |
| Full total | Canonical `estimate.amountCents`, after complete selected-item total matches it |
| Deposit amount | `quotePaymentSchedule(totalCents, FINAL_25_75).depositCents`, equivalent to canonical whole-cent rounding of 25% |
| Remaining amount | The helper's `remainderCents` = **totalCents minus depositCents**; never round 75% independently |
| Deposit due date | Later of the verified walkthrough date and **job date minus seven calendar days** |
| Remaining due date | Verified job date |
| Due-date time zone | `America/Denver`, preserved in the document payload and labels |
| Policy identity | `FINAL_25_75.version` (`2026-10-14-deposit25-v1`) for a new standard quote; persist the actual saved policy/version |

Use `quotePaymentSchedule()` and `quotePaymentDates()` to prepare a new standard schedule from canonical dates. If the estimate already has an issued `paymentSchedule`, preserve it; a later schedule change requires explicit amendment review through the existing quote flow. The exception is a quote sent on `SENT_25_75` and not yet approved: it has no deposit date to protect, so a revision sent after the job is rescheduled takes the new job day (the stored schedule is replaced only by that send). Do not recalculate old agreements from current dates. A missing verified walkthrough date, job date, approved exception or inconsistent amount blocks complete agreement rendering.

Exact rounding examples under the standard policy:

| Final total | Deposit | Remaining |
| --- | --- | --- |
| $1,600.00 | $400.00 | $1,200.00 |
| $1,000.01 | $250.00 | $750.01 |
| $0.03 | $0.01 | $0.02 |

Example date resolution: walkthrough October 20, job October 24 → deposit October 20; walkthrough October 10, job October 24 → deposit October 17. Remaining payment is due October 24 in both examples. These examples create no actual invoice, charge, reminder or customer request.

**Preserve existing signed agreements and reviewed customer exceptions.** The above standard mapping does not migrate historical Knock deposits, unsigned legacy quote policies, signed dates or exception terms. A known exception needs its existing policy/evidence snapshot; an unknown or conflicting exception is a review blocker. Do not fill gaps by applying `FINAL_25_75` to an old record. Deposit, balance, dates and total are display/mapping facts only; this PR does not send invoices, charge customers, sign documents or activate workflows.

## 9:30 AM job-start requirement: separate scheduling fix

The owner now requires new job starts at or after **09:30 America/Denver**. This intake foundation does not place or reschedule Hub jobs, so enforcement is a separate scheduling change, not an untested addition to this PR. Current code still includes an 08:00 Knock default and 08:00 openings default; changing a form label or openings default alone would not enforce the rule.

Proposed files and boundaries for that fix:

- `functions/_lib/dispatch-service.js` (`mutateDispatch`, complete schedule validation) and `functions/_lib/operations-scheduling.js` (`mutateScheduledVisit`): enforce at the authoritative create/reschedule boundary for customer job types, including direct API callers. Do not reject unrelated edits to an unchanged historical early schedule or silently reschedule it.
- `functions/_lib/dispatch-segments.js` (`validateSegments`): apply the job-type policy to each newly placed or time-changed work segment, not only the hull's first start. Preserve pure time parsing in `dispatch-time.js`; availability blocks and walkthroughs must not accidentally inherit a job-only rule.
- `functions/_lib/dispatch-openings.js` and `dispatch-settings.js`: make new-job suggestions begin at the effective 09:30 floor, including callers that request 08:00. Keep historical settings readable; a settings default alone is not the security boundary.
- `employee-dispatch.js` and its shared editor helpers: show the floor and reject early new placements before submit, using the same server-supplied policy.
- `crew/knock-settings.js`, `crew/knock-sale.js`, `functions/_lib/knock-sales.js`: update the new-sale default/UI and authoritative sale/job-date validation together, preserving saved existing sale times. Explicit stored defaults must not permit new earlier jobs.
- Add focused boundary tests for 09:29 rejection, 09:30 acceptance, Denver summer/winter offsets, multi-segment placement, attempted openings override, direct API/bridge bypass, and unchanged historical early jobs. Do not alter production schedules or saved settings as part of the patch.

This scheduling fix remains **unimplemented** here. The template must use verified canonical job dates/times, and flag an early proposed new job for scheduling review rather than silently changing it. Crew-completion → GHL notification is owned by the separate assigned task.

## Exact gaps before real template population

1. Dedicated GHL form IDs, reference field/query mappings, actual merge-field syntax, template IDs/versions and prefill/receipt acceptance are not supplied. This PR keeps all provider integration disabled.
2. A reviewed canonical link from the Knock handoff/source revision to `jobs/<id>` + estimate number/revision/fingerprint is not implemented. No contact matching fallback is allowed.
3. A Knock Look currently holds price/note/house context, often no customer; a Knock sale holds one package/ticket/customer/deposit snapshot. Neither supplies the canonical Hub itemized scope, stable service rows, tax treatment, quote number or payment-policy schedule. The future authoring/reconciliation step must supply those facts without fabricating line items from the package label.
4. Canonical customer/property lineage and the document's quoted customer/jobsite snapshot must be verified. The form may request corrections, but an authorized quote revision must accept them first.
5. Approved legal scope/exclusions/cancellation/refund wording, tax treatment and the template's field capacities are still needed. Missing commercial policy or scheduling facts block complete agreement terms; current launch defaults cannot repair historical records.
6. A server-owned snapshot/export adapter and GHL per-document merge mapping must be reviewed and tested before any real template population. Repeated/long service rows, multiline addresses/scope, cents/percent/date formatting, two concurrent quotes for one contact, revisions, malformed totals and missing terms need acceptance coverage.

The template worker can build the layout against these logical fields with synthetic data now. It must keep the preview unaccepted and unsent, clearly label missing values, and leave integration activation to a separate reviewed step.

## Repository sources

- `functions/_lib/quote-model.js`: canonical lines, selected totals, customer field subset, exact estimate fingerprint.
- `functions/_lib/quote-draft.js`: customer/job binding, quote revision, draft and send boundaries, payment schedule snapshot.
- `functions/_lib/quote-payment-policy.js`: saved policy validation, dates and America/Denver time zone.
- `functions/_lib/knock-sales.js`: existing Knock sale/customer/deposit/commission snapshots; not a Hub quote exporter.
- `functions/_lib/unsigned-walkthrough-capture.js`: operational capture is explicitly unsigned and not accepted sale terms.
