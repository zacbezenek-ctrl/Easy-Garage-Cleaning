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
  not silently rewritten as a confirmed zero. Reinstating a cancelled sale does
  not clear the review hold or automatically earn the commission again.
- Rep payments remain administrative records in `knock_payouts`; the report
  exposes `commissionPaymentEvidence=admin_recorded_unreconciled` and a null
  `commissionSettled`. Request IDs are stable for a form's retries. Reusing an ID
  for a different amount, rep, period or note is rejected.
- CSVs name customer receipts and rep payments separately. Unknown commission
  amounts are empty, never zero. Customer contacts are absent from payroll CSVs.

## Compensation is intentionally unconfigured

The current concepts are confirmed: commission is earned when the eligible job
is collected, and payouts follow a two-week cadence. Partial collections,
gross/net basis and exclusions, attribution/stacking, accelerator/override
eligibility, refunds/clawbacks and the payroll-cycle anchor still need review.
Existing signed `knock-v1` and `knock-garage-v2` snapshots retain their original
rates, service eligibility and earning-time conditions.

Report calculations require a complete valid settings record and a separately
reviewed `compensationApproval` on `knock_settings/current`. It must identify
`contract: knock-collected-v3`, `reference`, `reviewedBy`, `reviewedAt`, and exact copies of
the approved `commission` and `payroll` objects. The D2D base rate must be 25%.
The approval must also include an explicit `scope`: `service: garage_only`,
`channel: door_to_door`, `estimatorStacking: false`, and nonoverlapping arrays
`garageOnlyPackages` and `junkRemovalPackages` using actual package identifiers.
At least one garage package must be classified. Only the owner writes it, from the
owner-only "Approve commission terms" card in Admin > Settings (admin action
`compensation.approve`). The request repeats the saved `commission` and `payroll`
objects the owner reviewed and is refused if they changed; it also writes a
`knock_receipts/compensation_<requestId>` audit record naming any prior approval.
Retries and identical re-approvals write nothing and keep `reviewedAt`. Correcting
only the reference of terms that already verify also keeps `reviewedBy` and
`reviewedAt` (the receipt records who changed it and when), because `reviewedAt`
dates the terms: a sale made offline under them still carries them when it syncs.
Any other change (a new package classification, or re-approving after the terms
changed) takes effect at the new `reviewedAt`; an earlier sale synced later never
inherits it, and the confirm sheet says so. Nothing is approved by default. An ordinary settings save patches only `settings`,
`updatedAt` and `updatedBy`, so the approval (and `planApproval`) survives
unrelated edits; changing the approved commission or payroll objects stops it
verifying until the owner approves again. The synthetic test approval is only a
fixture and must never be copied into production.

The approval must explicitly bind `collectionPolicy` with
`earnedOn: customer_collection`, `payoutCadence: biweekly`,
`calculationBase: eligible_collected_amount`, `attribution: recorded_rep`,
`partialCollections: review_required` and `refunds: review_required`. This names
the supported calculation contract, not a decision that the unknown basis or
attribution is correct. Finance must confirm it or implement the actual rule.
The saved payroll period must be `biweekly`, include an explicit anchor date and
have `payrollAnchorConfirmed: true` on its approval. The default date never
confirms an anchor. Until then, date groupings are labeled previews, commission
remains unconfigured and payroll exports are refused.

Under a complete new contract, an evidenced full collection earns at its
collection timestamp without adding a completion or cancellation-deadline
delay. A sale-day deposit or a running receipt is pending, not partial, including
on a completed job whose receipts all predate completion (it is awaiting its
balance). A short final collection (a receipt recorded at or after completion
that is still below the ticket, a short `paid` record, or a finished job with no
usable completion time), an excess collection and refund/cancellation evidence
remain held for review. A held sale holds only the pay periods it touches (sold,
a receipt, completion, refund, cancellation or a status change), plus the rest of
a receipt's calendar month when a monthly accelerator applies; other periods stay
payable. A refund or cancellation under review with no usable date holds every
period, since its adjustment could land in any of them. No pro-rata rule,
clawback or payment execution is introduced.

Only packages independently verified as wholly eligible garage work belong in
`garageOnlyPackages`. Names alone do not establish this. Junk-removal packages
earn zero commission and do not advance accelerator revenue or lead overrides;
customer receipts still appear. Mixed or unclassified packages need review and
have no projected, earned or payable commission. A rep cannot supply their own
terms or eligibility. A changed package invalidates its saved eligibility.

Estimator compensation applies separately to eligible garage jobs and is not
added to D2D compensation by this app. Direct-estimator ticket and margin
assumptions do not establish D2D performance, and estimator commission is a
separate cost. D2D performance is unknown. Scoreboard comparisons and
Go/Fix/Stop verdicts require separate
`planApproval` evidence bound to the exact `plan` and `gate`, with
`channel: door_to_door`, reference, reviewer and review time; otherwise only
measured results appear and benchmarks remain unconfigured.

Before supplying an approval, finance must verify that the actual agreement
matches the entire existing contract. If it does not, implement and review the
correct version first. New sales snapshot the approved server-side terms and
scope, package and approval time in `commissionTerms`; client-supplied terms are ignored. Current
rate, accelerator and override changes never replace that snapshot. Legacy sales
without verified snapshots require review and are not backfilled from current
settings. An offline sale dated before the current policy approval also remains
held; it never silently inherits the later rate. This candidate does not migrate
or reconcile historical accruals.
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
- [ ] Verify new collection-based terms earn at the full collection time, while
  older signed terms keep their original timing. Partial receipts stay held.
- [ ] Confirm the actual first date of the two-week cycle. Before approval,
  payroll dates must be labeled previews and payroll exports must be refused.
- [ ] Check all five money categories and both CSVs with unconfigured terms. Then
  test a separately approved synthetic contract; never use fixture approval live.
- [ ] Verify the approved garage-only package classification. Junk receipts must
  produce no commission or accelerator progress; mixed and unknown work stays
  held. Verify historical snapshots do not change and estimator pay never stacks
  automatically. D2D benchmarks remain absent without their own approval.
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

## Walkthrough setters are a separate channel

Direct door closes retain the 25% eligible-garage channel. A rep who instead
sets a walkthrough has a separate 13% setter channel, requiring a converted,
closed and collected eligible garage job. Booking, a no-show, an unclosed quote
or a missing conversion link never earns setter commission. The setter route
allocates 13% to the setter plus 7% to the estimator, 20% total (owner decision
2026-10-17; previously 12% + 7%), as separately
identified recipients. Direct-estimator-only work remains 7%; a direct D2D close
remains 25%. The direct 25% route is never added to the setter route.

The rep money screen links to the existing permission-checked Hub walkthrough
booking flow. An admin records the setter against its canonical walkthrough ID
in the Setters section. `knock_setters` stores this attribution separately from
`knock_sales`; it does not create an appointment, contact, message or payout.
The setter is an active canvassing account. Estimator attribution has its own
optional staff key and review reference, labeled admin-recorded/unreconciled;
the quote recorder is kept separately and is never assumed to be the estimator.
An unknown estimator stays unverified.

One create-only record per walkthrough and a request receipt prevent duplicate
credit. Equal requests replay safely; reusing a request or walkthrough with a
different setter/classification is a conflict needing review. Rescheduling the
same walkthrough cannot create another attribution. Reports re-read canonical
walkthrough/job revisions and payment evidence. A conversion must link in both
directions, and a linked direct-sale claim is flagged instead of combined.

Setter rows remain outside direct-sale commission and receipt totals to avoid
double counting. Close and full collection evidence may establish a qualifying
time, but setter earned/payable amounts remain unknown until recipient evidence,
calculation base and payroll anchor are resolved. The pure allocation helper
requires an explicitly verified base, assigns stable job/channel/recipient IDs,
and treats arithmetic as distinct from payroll approval. Missing recipients,
overlapping roles/channels or an unresolved fractional-cent rounding choice
remain holds. Partial receipts, refunds,
cancellations, missing source data and unclassified services remain review
states; verified junk classification is excluded. No compensation approval or
historical signed snapshot is written by this tracking flow.

The owner approves these terms separately, in Admin > Settings > "Approve
walkthrough-setting and estimator terms" (`setter.approve`, owner only, after the
door-to-door terms, whose two-week pay cycle pays them). It records
`knock_settings/current.setterApproval` with the fixed `SETTER_TERMS`
(crew/knock-money.js): 13% setter + 7% estimator on a walkthrough a rep set, 7%
on a walkthrough an estimator sold directly, of the job's whole price including
goods, rounded to the cent, earned when the job is closed and paid in full (or
at the approval, or when the office recorded or settled the setter record or
classification, if later, so no closed period changes). Under them a signed
walkthrough handoff counts as garage work when what was signed shows it (a
charged service, product or labor line that is not junk removal, or a finishing
option of a single signed total); a junk-only quote stays unverified. Its signer
is the estimator unless the office recorded one; an estimator the door booking
recorded who did not sign is held (`estimator_attribution_conflict`) until the
office settles it. Until the approval verifies every row stays held exactly as
described above. The office settles a setter record's classification once in
Admin > Setters (`setter.classify`: garage or junk removal, and optionally its
estimator, with a review reference; a settled classification is never changed
there, and a recorded estimator changes only to the handoff's signer or by the
owner; nobody but the owner names themselves), and a direct sale's
classification once in Admin > Estimators (`estimator.classify`). Earned
shares join the commission statement (Admin > Money, the commission CSV's
`setter_commission_included` and `estimator_commission_included` columns, the
rep's My money, which also counts the 7% of an employee who signs walkthroughs);
an estimator who has no canvassing account is paid with a recorded payout under
their Hub staff key. A payout records the shares it paid (`channelItems`): a
share that later changes, moves or is earned again, and payments above what a
period earned, hold the statement for finance (`channel_share_changed`,
`payout_exceeds_earned`); nothing is clawed back or paid twice automatically.
Admin > Estimators lists every estimator's 7% (walkthroughs signed in the last
365 days); each estimator sees their own in the Hub under My commission
(`GET /api/estimator-commission`). The statement reads setter records and
signed handoffs from the 365 days before its pay period; an older one is held
(`statement_lookback_exceeded`) wherever it shows. Short payments, refunds or
cancellations after money was collected, and a door sale linked to the job, hold
the shares and their recipients' statements for review; an unread record holds
the people it names (or every row when its estimator is unknown).

- [ ] Book a synthetic Hub walkthrough with the intended staff role, record its
  setter once, and verify another rep cannot claim or read it.
- [ ] Replay identical and conflicting attribution requests, including concurrent
  duplicates and a rebooked walkthrough; only one attribution may exist.
- [ ] Test booking, no-show, close without collection, partial/full collection,
  refunds, missing conversion data and an existing direct-sale claim.
- [ ] Confirm the setter and estimator get separate 13% and 7% allocations from
  an explicitly verified base, with no added 25% route and no duplicate IDs.
  Payable totals stay held while the base, recipients or payroll anchor are unverified.

## Customer photo access in Hub readiness

The same Hub rollout serves customers through the private project portal. When
access is revoked or a shared photo is withdrawn, the gallery and storage image
sources now clear synchronously before their dialogs close. Waiting for the
queued close event can retain private photo pixels after access has changed.
Existing close handlers still preserve focus and newly reopened viewers.

The access-error cleanup and regression-test route cleanup were independently
ported from snapshot `a88e0d7`, limited to `customer-portal.html` and
`tests/browser/test_customer_photos_ui.py`. The same immediate source cleanup
also covers withdrawn gallery/storage photos, with a regression check in the
same JavaScript task before queued close events. This has no dependency on the
snapshot's payment-schedule change or its separate public-gallery upload batch;
those changes and their payloads are excluded. Fixtures remain synthetic.
