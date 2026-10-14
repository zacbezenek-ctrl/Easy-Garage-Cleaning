# Canvassing earnings readiness

This change is a review candidate, not production acceptance. It makes the
existing Knock money screens distinguish booked revenue, projected commission,
earned commission, recorded customer receipts, payable commission and recorded
rep payments. A recorded payment is not proof of bank or payroll settlement.

## Calculation and evidence contract

- Missing receipt amounts never fall back to the sale ticket. A verified deposit
  is a customer receipt; a final cumulative receipt includes that deposit.
- `sale.collection` records the cumulative amount received, never charges a
  customer, and never completes a job. Equal totals are idempotent; reductions
  and cancelled-sale edits require finance review. History records the previous
  total so new partial receipts fall into their own pay periods once.
- Completion is a separate action. The legacy `sale.status=paid` action requires
  explicit full collection and existing completion. Reopening and cancelling
  preserve recorded customer money.
- Incomplete paid records, partial/excess paid snapshots, refunds and cancelled
  collections produce a review state. No automatic clawback or reversal is
  inferred. Historical earnings are unknown during an unresolved adjustment,
  not silently rewritten as a confirmed zero.
- Rep payments remain administrative records in `knock_payouts`; the report
  exposes `commissionPaymentEvidence=admin_recorded_unreconciled` and a null
  `commissionSettled`. Request IDs are stable for a form's retries. Reusing an ID
  for a different amount, rep, period or note is rejected.
- CSVs name customer receipts and rep payments separately. Unknown commission
  amounts are empty, never zero. Customer contacts are absent from payroll CSVs.

## Compensation is intentionally unconfigured

Percentages alone do not establish gross/net basis, tax or discount exclusions,
lead/estimator attribution and stacking, earning trigger, accelerator/override
eligibility, clawbacks or payout timing. The existing calculator is retained as
the **knock-v1 calculation contract**, not endorsed as an agreement.

Report calculations require a complete valid settings record and a separately
reviewed `compensationApproval` on `knock_settings/current`. It must identify
`contract: knock-v1`, `reference`, `reviewedBy`, `reviewedAt`, and exact copies of
the approved `commission` and `payroll` objects. This is an evidence binding, not
a new approval action. No UI/API added by this change writes that approval. The
ordinary settings save invalidates it. The synthetic test approval is only a
fixture and must never be copied into production.

Before supplying an approval, finance must verify that the actual agreement
matches the entire existing contract. If it does not, implement and review the
correct version first. Rate changes and historical accruals need versioned terms
per sale/accrual; this candidate does not migrate or reconcile old records.
Training hours remain visible while unconfigured; training pay is not promised.

## Sync and access

The existing Hub session and server-side active-rep/territory checks remain.
Reps see only their own sales and money; leads receive permitted team aggregates;
only existing business access can write receipts, settings or rep payment
records. Titles and headcount do not grant access.

Money and admin sales views read the durable HighLevel send receipt. A claimed
`sending` receipt appears as `uncertain`, even when the sale still says pending.
Only a known rejection is retryable. A sent SMS is not a verified appointment;
job references remain manual and `appointment=not_verified` is explicit. This
does not add a Hub/HighLevel job, payment or commission synchronization bridge.

## Onboarding smoke checklist

Use designated synthetic records and leave customer messaging/payment adapters
disabled. Record release identity, test identity, timestamp and result per step.

- [ ] Confirm each actual crew, rep, estimator and office account against the
  owner-approved roster. Verify each role individually; do not infer attendance.
- [ ] Sign in as a pending rep: no territory, shifts, sales or money writes.
  Approve only the intended account, verify permit status and assign territory.
- [ ] As an active rep, read only assigned streets and own sales. Try another
  rep's ID in report parameters and direct write requests; access stays scoped.
- [ ] Deactivate the rep and verify the next request refuses work; reauthenticate
  without losing the private offline queue. Sign out and use another account to
  check cached data isolation.
- [ ] On physical iPhone and Android, test home-screen launch, 320–390px portrait,
  landscape, keyboard, safe areas, touch targets, consent and sale validation.
- [ ] Log several doors offline, reload offline, reconnect and verify one copy of
  each event. Inspect the visible rejected-event and expired-session paths.
- [ ] Book a synthetic sale, verify ownership and cancellation fields, then record
  a partial receipt. The job is not complete and no commission is claimed earned.
- [ ] Complete work separately, record the final cumulative receipt, retry it and
  verify the deposit is counted once across pay periods.
- [ ] Check all five money categories and both CSVs with unconfigured terms. Then
  test a separately approved synthetic contract; never use fixture approval live.
- [ ] Record a synthetic rep payment, retry the same request and change its
  payload. Only the original record remains; settlement stays unverified.
- [ ] Exercise missing payment timestamps, refund and cancellation evidence.
  Payable/earned amounts require review and existing receipts/payouts remain.
- [ ] Exercise missing, rejected and uncertain HighLevel receipts. Verify visible
  state, reconcile provider history, and prove no uncertain operation is resent.
- [ ] Verify canonical Hub job/payment links and a HighLevel appointment separately.
  A manual reference or sent text does not pass this gate.

## Local verification

`node --test tests/knock-*.test.mjs` covers calculations, role isolation, territory,
sale lifecycle, deduplication and fake-provider handoffs. Emulator-only tests need
the documented Firebase harness; skipped tests are not acceptance.

`node --test tests/crew-service-worker.test.mjs` checks shell caching and privacy.
`node tests/knock.browser.mjs` checks real local HTTP login, five offline doors,
reconnect, admin visibility, money labels/unconfigured state and overflow at
320, 390 and 768 pixels using synthetic Firestore data. Browser emulation does
not establish physical-device or live-provider readiness.

No production migration, messages, charges, payouts, credential changes or
deployment are part of this change. Live roster, policy approval, historical
reconciliation, provider synchronization and physical-device acceptance remain
release blockers.
