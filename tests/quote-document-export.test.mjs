import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { exportQuoteDocument, quoteDocumentReviewBinding, requiredQuoteDocumentBindings } from '../functions/_lib/quote-document-export.js';
import { FINAL_25_75 } from '../functions/_lib/quote-payment-policy.js';
import { depositCents, normalizeLineItems } from '../functions/_lib/quote-model.js';

const AT = '2026-10-15T20:00:00.000Z';
const clone = value => structuredClone(value);
function approve(snapshot) {
  snapshot.canonicalApproval = { status: 'approved', approvedBy: 'estimator1', approvedAt: AT, evidenceId: 'review1', binding: quoteDocumentReviewBinding(snapshot) };
  return snapshot;
}
function fixture(total = 100001) {
  return approve({
    job: {
      id: 'job1', revision: 'job-revision-1', customerId: 'customer1', propertyId: 'property1', projectId: 'project1', sourceWalkthroughId: 'walk1',
      customer: 'Synthetic Customer', phone: '9705550100', email: 'customer@example.invalid', highlevelContactId: 'contact1',
      address: '100 Fixture Lane\nFort Collins, CO', title: 'Garage reset', date: '2026-10-24',
      internalNotes: 'PRIVATE_NOTE', signature: 'PRIVATE_SIGNATURE', payment: { card: 'PRIVATE_CARD' },
      estimate: {
        number: 'EST-001', revision: 1, status: 'draft', currency: 'USD', amount: total / 100, amountCents: total,
        depositRequired: depositCents(total, 25) / 100, depositRequiredCents: depositCents(total, 25), depositPct: 25,
        scope: 'Clean and organize garage.\nKeep the blue bicycle.', termsVersion: 'terms-fixture-v1', commercialPolicy: { ...FINAL_25_75 },
        lineItems: normalizeLineItems([{ id: 'clean', kind: 'service', name: 'Garage service', quantity: 1, unitCents: total, totalCents: total, taxable: false }], { strict: true }).lineItems,
      },
    },
    lineage: { customerId: 'customer1', propertyId: 'property1', contactId: 'contact1', locationId: 'location1', evidenceId: 'lineage1', verifiedAt: AT },
    scopeExclusions: ['Hazardous material removal'],
    tax: { status: 'verified', amountCents: 0, treatment: 'not_applicable', summary: 'Synthetic reviewed tax treatment', evidenceId: 'tax1' },
    legal: { termsVersion: 'terms-fixture-v1', templateVersion: 'template-fixture-v1', textDigest: 'a'.repeat(64), evidenceId: 'legal1', cancellationDeadline: null, refundTerms: 'Synthetic approved terms reference' },
    signerRoles: [
      { role: 'customer', partyId: 'customer1', name: 'Synthetic Customer', email: 'customer@example.invalid', authorityEvidenceId: 'signer1' },
      { role: 'company', partyId: 'company1', name: 'Synthetic Representative', email: 'company@example.invalid', authorityEvidenceId: 'signer2' },
    ],
    walkthrough: { id: 'walk1', revision: 'walk-revision-1', customerId: 'customer1', date: '2026-10-10' },
    policyException: null,
    provenance: { source: 'canonical_hub', recordRef: 'jobs/job1', readAt: AT },
  });
}
const run = (snapshot, options) => exportQuoteDocument(snapshot, { documentKind: 'service_agreement', ...options });
function blocked(snapshot, code, options) {
  const result = run(snapshot, options);
  assert.equal(result.renderState, 'blocked', JSON.stringify(result.blockers));
  assert.equal(result.payload, null);
  assert.equal(result.display, null);
  assert.equal(result.deliveryStatus, 'unsent_draft_only');
  assert.ok(result.blockers.includes(code), `${code} in ${JSON.stringify(result.blockers)}`);
  return result;
}
const savedSchedule = (s, overrides = {}) => {
  s.job.estimate.paymentSchedule = { depositCents: s.job.estimate.depositRequiredCents, remainderCents: s.job.estimate.amountCents - s.job.estimate.depositRequiredCents, depositDueDate: '2026-10-17', remainderDueDate: '2026-10-24', timeZone: 'America/Denver', policyVersion: s.job.estimate.commercialPolicy.version, sourceWalkthroughId: 'walk1', sourceRevision: 'walk-revision-1', ...overrides };
  return approve(s);
};
const receipt = result => ({ idempotencyKey: result.idempotencyKey, contentDigest: result.contentDigest, jobId: result.payload.canonicalQuote.jobId, estimateRevision: result.payload.canonicalQuote.estimateRevision, documentKind: result.documentKind });

test('approved canonical snapshot produces immutable mapping drafts for all three document kinds', () => {
  for (const documentKind of ['estimate', 'proposal', 'service_agreement']) {
    const source = fixture(), before = clone(source), result = run(source, { documentKind });
    assert.equal(result.renderState, 'ready_for_mapping', JSON.stringify(result.blockers));
    assert.equal(result.disposition, 'new');
    assert.equal(result.deliveryStatus, 'unsent_draft_only');
    assert.equal(result.requiredNativeBindings.status, 'unbound');
    assert.equal(result.payload.canonicalQuote.estimateRevision, 1);
    assert.equal(result.payload.paymentSchedule.source, 'derived_from_reviewed_dates');
    assert.equal(result.payload.acceptance.status, 'unverified', 'estimator approval is not a signature');
    assert.deepEqual(result.payload.paymentCollected, { status: 'unknown', appliedCents: null, evidenceId: null, recordedAt: null });
    assert.deepEqual(source, before);
    assert.throws(() => { result.payload.customer.name = 'changed'; }, TypeError);
    source.scopeExclusions.push('Unreviewed change');
    assert.deepEqual(result.payload.scope.exclusions, ['Hazardous material removal']);
  }
});

test('cent allocation is exact, with remainder by subtraction and no independently rounded 75%', () => {
  for (const [total, deposit, remainder] of [[1, 0, 1], [3, 1, 2], [99, 25, 74], [100001, 25000, 75001], [160000, 40000, 120000], [100000000, 25000000, 75000000]]) {
    const result = run(fixture(total));
    assert.equal(result.renderState, 'ready_for_mapping', JSON.stringify(result.blockers));
    assert.equal(result.payload.paymentSchedule.depositCents, deposit);
    assert.equal(result.payload.paymentSchedule.remainderCents, remainder);
    assert.equal(deposit + remainder, result.payload.totals.totalCents);
  }
  for (const invalid of [null, 100000000.1, -1, NaN, '100001']) {
    const s = fixture(); s.job.estimate.amountCents = invalid;
    blocked(approve(s), 'canonical_totals_invalid');
  }
});

test('unapproved form values and accepted-looking status cannot authorize export', () => {
  blocked({}, 'canonical_quote_missing');
  const s = fixture();
  delete s.canonicalApproval;
  s.job.estimate.status = 'accepted'; s.job.customerApproval = { status: 'approved' };
  s.submittedForm = { price: 1, termsAccepted: true, depositPct: 0 };
  blocked(s, 'canonical_approval_missing_or_stale');
  for (const field of ['approvedBy', 'approvedAt', 'evidenceId', 'binding']) {
    const missing = fixture(); delete missing.canonicalApproval[field];
    blocked(missing, 'canonical_approval_missing_or_stale');
  }
  const wrongSource = fixture(); wrongSource.provenance.source = 'form_submission';
  blocked(wrongSource, 'canonical_provenance_missing');
});

test('review binding covers quote contents, identity, amounts, scope, tax, legal, roles and exceptions', () => {
  const changes = [
    s => { s.job.revision = 'revision2'; }, s => { s.job.estimate.revision += 1; },
    s => { s.job.estimate.lineItems[0].name = 'Different agreed service'; },
    s => { s.job.customer = 'Different Customer'; }, s => { s.job.address = 'Different Site'; },
    s => { s.job.estimate.amountCents += 1; }, s => { s.scopeExclusions = []; },
    s => { s.tax.summary = 'Different reviewed treatment'; }, s => { s.legal.textDigest = 'b'.repeat(64); },
    s => { s.signerRoles[0].name = 'Different signer'; }, s => { s.policyException = { reason: 'Changed' }; },
  ];
  for (const change of changes) { const s = fixture(); change(s); blocked(s, 'canonical_approval_missing_or_stale'); }
});

test('required canonical fields fail closed even when review evidence is refreshed', () => {
  for (const [change, code] of [
    [s => { delete s.job.email; }, 'customer_required_fields_missing'],
    [s => { s.job.propertyId = ''; }, 'jobsite_required_fields_missing'],
    [s => { delete s.scopeExclusions; }, 'reviewed_scope_missing'],
    [s => { delete s.job.estimate.scope; }, 'reviewed_scope_missing'],
    [s => { delete s.job.estimate.currency; }, 'canonical_currency_unverified'],
    [s => { s.job.estimate.currency = 'CAD'; }, 'canonical_currency_unverified'],
    [s => { delete s.legal; }, 'approved_legal_template_missing'],
    [s => { s.legal.termsVersion = 'other-version'; }, 'approved_legal_template_missing'],
    [s => { s.signerRoles[0].partyId = 'wrong-customer'; }, 'signer_roles_unverified'],
    [s => { s.signerRoles[1].role = 'customer'; }, 'signer_roles_unverified'],
    [s => { s.lineage.contactId = 'wrong-contact'; }, 'customer_contact_jobsite_link_unverified'],
    [s => { s.lineage.propertyId = 'wrong-property'; }, 'customer_contact_jobsite_link_unverified'],
    [s => { delete s.policyException; }, 'policy_exception_review_missing'],
    [s => { s.job.estimate.status = 'superseded'; }, 'canonical_quote_inactive'],
    [s => { s.legal.refundTerms = { internal: 'not text' }; }, 'legal_terms_invalid'],
  ]) { const s = fixture(); change(s); blocked(approve(s), code); }
});

test('tax treatment must be explicit; canonical total never silently gains tax', () => {
  for (const tax of [null, { status: 'verified', amountCents: 0 }, { ...fixture().tax, amountCents: 1 }, { ...fixture().tax, treatment: 'add_to_total', amountCents: 500 }]) {
    const s = fixture(); s.tax = tax; blocked(approve(s), 'canonical_tax_unverified');
  }
  const s = fixture(); s.tax = { ...s.tax, treatment: 'included_in_lines', amountCents: 1200 };
  const result = run(approve(s));
  assert.equal(result.payload.totals.taxCents, 1200);
  assert.equal(result.payload.totals.totalCents, 100001);
});

test('selectedIds resolve before totals and rendering, including equal-priced alternatives', () => {
  const s = fixture();
  s.job.estimate.lineItems = normalizeLineItems([
    { id: 'option-a', kind: 'service', name: 'Option A', quantity: 1, unitCents: 100001, optional: true, selected: true, group: { id: 'options', label: 'Choice', selection: 'single', required: true } },
    { id: 'option-b', kind: 'service', name: 'Option B', quantity: 1, unitCents: 100001, optional: true, selected: false, group: { id: 'options', label: 'Choice', selection: 'single', required: true } },
    { id: 'tip', kind: 'tip', name: 'Tip', quantity: 1, unitCents: 1000 },
  ], { strict: true }).lineItems;
  s.job.estimate.selectedIds = ['option-b']; approve(s);
  const result = run(s);
  assert.deepEqual(result.payload.serviceItems.map(line => line.id), ['option-b']);
  const proposal = run(s, { documentKind: 'proposal' });
  assert.deepEqual(proposal.payload.serviceItems.map(line => [line.id, line.selected, line.included]), [['option-a', false, false], ['option-b', true, true]]);
  s.job.estimate.selectedIds = ['option-a']; blocked(s, 'canonical_approval_missing_or_stale');
  for (const selectedIds of [null, 'option-b', ['unknown'], ['option-a', 'option-b'], ['option-b', 'option-b']]) {
    s.job.estimate.selectedIds = selectedIds; blocked(approve(s), 'canonical_lines_invalid');
  }
});

test('discounts stay negative customer rows while totals carry positive discount cents; internals and tips are omitted', () => {
  const s = fixture(90000);
  s.job.estimate.lineItems = normalizeLineItems([
    { id: 'clean', kind: 'service', name: 'Service', quantity: 1, unitCents: 100000, split: { laborCents: 100000 }, catalog: { itemId: 'PRIVATE_CATALOG', version: 1 }, durationMinutes: 300 },
    { id: 'discount', kind: 'discount', name: 'Customer discount', quantity: 1, unitCents: -10000 },
    { id: 'tip', kind: 'tip', name: 'Tip', quantity: 1, unitCents: 500 },
  ], { strict: true }).lineItems;
  const result = run(approve(s));
  assert.equal(result.payload.totals.subtotalCents, 100000);
  assert.equal(result.payload.totals.discountCents, 10000);
  assert.equal(result.payload.serviceItems[1].totalCents, -10000);
  assert.equal(result.display.serviceItems[1].total, '-$100.00');
  for (const value of ['PRIVATE_NOTE', 'PRIVATE_SIGNATURE', 'PRIVATE_CARD', 'PRIVATE_CATALOG', 'durationMinutes', 'split', 'catalog', 'Tip']) assert.equal(JSON.stringify(result).includes(value), false, value);
});

test('invalid calendar dates, timezone-less timestamps and absent dates never become due dates', () => {
  for (const date of ['2026-02-30', '2026-13-01', '2026-10-24T09:30:00', '2026-10-24T15:30:00Z', '', null]) {
    const s = fixture(); s.job.date = date; blocked(approve(s), 'verified_payment_dates_missing');
  }
  const after = fixture(); after.walkthrough.date = '2026-10-25'; blocked(approve(after), 'payment_dates_invalid');
  const noWalk = fixture(); delete noWalk.walkthrough; blocked(approve(noWalk), 'verified_payment_dates_missing');
  const invalidApproval = fixture(); invalidApproval.canonicalApproval.approvedAt = '2026-02-30T12:00:00Z'; blocked(invalidApproval, 'canonical_approval_missing_or_stale');
  const invalidLegalDate = fixture(); invalidLegalDate.legal.cancellationDeadline = '2026-02-30'; blocked(approve(invalidLegalDate), 'legal_date_invalid');
  for (const date of ['2026-02-30', null, 'not-a-date']) blocked(savedSchedule(fixture(), { depositDueDate: date }), 'saved_payment_schedule_invalid');
});

test('standard due date is later of walkthrough day and seven calendar days before job, including DST', () => {
  for (const [walk, job, expected] of [['2026-10-10', '2026-10-24', '2026-10-17'], ['2026-10-20', '2026-10-24', '2026-10-20'], ['2026-03-01', '2026-03-15', '2026-03-08'], ['2026-10-20', '2026-11-08', '2026-11-01']]) {
    const s = fixture(); s.walkthrough.date = walk; s.job.date = job;
    const result = run(approve(s));
    assert.equal(result.payload.paymentSchedule.depositDueDate, expected);
    assert.equal(result.payload.paymentSchedule.remainderDueDate, job);
    assert.equal(result.payload.paymentSchedule.timeZone, 'America/Denver');
  }
});

test('issued schedule is preserved after rescheduling; mismatched amounts or policy fail closed', () => {
  const s = savedSchedule(fixture()); s.job.date = '2026-11-10'; delete s.walkthrough; approve(s);
  const result = run(s);
  assert.equal(result.payload.paymentSchedule.depositDueDate, '2026-10-17');
  assert.equal(result.payload.paymentSchedule.remainderDueDate, '2026-10-24');
  assert.equal(result.payload.paymentSchedule.source, 'saved');
  for (const change of [{ depositCents: 25001 }, { remainderCents: 75000 }, { policyVersion: 'other' }, { timeZone: 'UTC' }, { depositDueDate: '2026-10-25' }]) blocked(savedSchedule(fixture(), change), 'saved_payment_schedule_invalid');
  const mismatch = fixture(); mismatch.job.estimate.depositRequired = 500; blocked(approve(mismatch), 'canonical_deposit_mismatch');
});

test('legacy terms and customer exceptions are retained only with explicit review and saved schedule', () => {
  const missing = fixture(); delete missing.job.estimate.commercialPolicy; blocked(approve(missing), 'canonical_payment_policy_missing');
  for (const kind of ['legacy_terms', 'customer_exception']) {
    const s = fixture(100001);
    delete s.job.estimate.commercialPolicy;
    s.job.estimate.depositRequiredCents = 50001; s.job.estimate.depositRequired = 500.01; s.job.estimate.depositPct = 50;
    s.policyException = { kind, status: 'approved', approvedBy: 'owner1', approvedAt: AT, evidenceId: 'exception1', reason: 'Preserve the existing reviewed customer terms.', paymentPolicy: { version: 'historical-50', depositPct: 50, remainderPct: 50, depositDueRule: 'signed_due_date', remainderDueRule: 'signed_due_date' } };
    s.job.estimate.paymentSchedule = { depositCents: 50001, remainderCents: 50000, depositDueDate: '2026-10-15', remainderDueDate: '2026-10-26', timeZone: 'America/Denver', policyVersion: 'historical-50' };
    const before = clone(s), result = run(approve(s));
    assert.equal(result.renderState, 'ready_for_mapping', JSON.stringify(result.blockers));
    assert.equal(result.payload.paymentPolicy.depositPct, 50);
    assert.equal(result.payload.paymentSchedule.remainderDueDate, '2026-10-26');
    assert.equal(result.payload.policyException.kind, kind);
    assert.deepEqual(s.job, before.job);
    delete s.job.estimate.paymentSchedule; blocked(approve(s), 'legacy_payment_schedule_missing');
  }
  const unknownPolicy = fixture(); unknownPolicy.job.estimate.commercialPolicy.version = 'unreviewed-version'; blocked(approve(unknownPolicy), 'payment_policy_requires_exception');
});

test('canonical payment figures never prove collection; verified collection remains distinct', () => {
  const s = fixture();
  s.job.deposit = { status: 'paid', paidAmount: 1000.01 }; s.job.status = 'completed';
  assert.equal(run(s).payload.paymentCollected.status, 'unknown');
  for (const [status, appliedCents] of [['unpaid', 0], ['partial', 25000], ['paid', 100001], ['overpaid', 100002]]) {
    s.paymentCollected = { status, appliedCents, evidenceId: 'ledger1', recordedAt: AT, jobId: 'job1', customerId: 'customer1' };
    const result = run(s);
    assert.equal(result.payload.paymentCollected.status, status);
    assert.equal(result.payload.paymentSchedule.remainderCents, 75001, 'schedule is not unpaid balance');
  }
  s.paymentCollected.jobId = 'job2'; blocked(s, 'payment_collection_unverified');
  s.paymentCollected.jobId = 'job1'; s.paymentCollected.status = 'unpaid'; blocked(s, 'payment_collection_mismatch');
});

test('intake reference requires an explicit reviewed canonical link; raw form fields are never forwarded', () => {
  const s = fixture();
  s.intake = { handoffReference: 'opaque1', channel: 'd2d', houseId: 'house1', source: { kind: 'quote', id: 'look1', revision: 1, internal: 'PRIVATE_INTAKE' }, linkEvidenceId: 'link1', canonicalJobId: 'job1', canonicalEstimateRevision: 1, canonicalEstimateFingerprint: quoteDocumentReviewBinding(s).estimateFingerprint, submittedPrice: 1, termsAccepted: true };
  const result = run(approve(s));
  assert.equal(result.renderState, 'ready_for_mapping');
  assert.equal('submittedPrice' in result.payload.provenance.intake, false);
  assert.equal(JSON.stringify(result).includes('PRIVATE_INTAKE'), false);
  s.intake.canonicalJobId = 'job2'; blocked(approve(s), 'intake_canonical_link_unverified');
});

test('customer acceptance requires independent revision-bound evidence and does not enable delivery', () => {
  const s = fixture(); s.customerAcceptance = { status: 'accepted', approvedBy: 'customer1', approvedAt: AT, evidenceId: 'acceptance1', method: 'verified_signature', binding: quoteDocumentReviewBinding(s) };
  const result = run(s);
  assert.equal(result.payload.acceptance.status, 'accepted');
  assert.equal(result.deliveryStatus, 'unsent_draft_only');
  s.customerAcceptance.binding = { ...s.customerAcceptance.binding, estimateRevision: 0 };
  blocked(s, 'customer_acceptance_unverified');
});

test('idempotent replay uses job, kind and revision; conflicts and stale revisions are blocked', () => {
  const s = fixture(), first = run(s), history = [receipt(first)];
  assert.equal(run(s, { existingSnapshots: history }).disposition, 'replay');
  s.provenance.readAt = '2026-10-15T21:00:00.000Z';
  assert.equal(run(s, { existingSnapshots: history }).disposition, 'replay', 'read metadata is not a new document');
  s.job.estimate.scope = 'Changed at the same revision'; approve(s);
  blocked(s, 'document_revision_conflict', { existingSnapshots: history });
  s.job.estimate.revision = 2; approve(s);
  const revised = run(s, { existingSnapshots: history });
  assert.equal(revised.disposition, 'new'); assert.notEqual(revised.idempotencyKey, first.idempotencyKey);
  blocked(fixture(), 'document_revision_stale', { existingSnapshots: [...history, receipt(revised)] });
  assert.notEqual(run(fixture(), { documentKind: 'proposal' }).idempotencyKey, first.idempotencyKey);
  blocked(fixture(), 'snapshot_history_invalid', { existingSnapshots: [{ jobId: 'job1' }] });
});

test('two jobs for one contact cannot share or overwrite a document key', () => {
  const first = run(fixture()), s = fixture();
  s.job.id = 'job2'; s.job.propertyId = 'property2'; s.lineage.propertyId = 'property2';
  s.job.estimate.number = 'EST-002'; s.job.address = '200 Fixture Lane'; s.provenance.recordRef = 'jobs/job2'; approve(s);
  const second = run(s, { existingSnapshots: [receipt(first)] });
  assert.equal(second.disposition, 'new');
  assert.equal(first.payload.contact.contactId, second.payload.contact.contactId);
  assert.notEqual(first.idempotencyKey, second.idempotencyKey);
  assert.equal(first.payload.jobsite.address, '100 Fixture Lane\nFort Collins, CO');
});

test('mapping display escapes markup and preserves multiline text; native binding manifest is explicitly unbound', () => {
  const s = fixture(); s.job.customer = '<img onerror="bad()"> & Customer'; s.job.estimate.scope = 'Line one\n<script>bad()</script>'; approve(s);
  const result = run(s);
  assert.equal(result.display.customerName, '&lt;img onerror=&quot;bad()&quot;&gt; &amp; Customer');
  assert.equal(result.display.scopeDescription, 'Line one\n&lt;script&gt;bad()&lt;/script&gt;');
  const manifest = requiredQuoteDocumentBindings('service_agreement');
  assert.equal(manifest.nativeTemplateId, null);
  assert.equal(manifest.storageScope, 'per_document_snapshot');
  assert.equal(manifest.valueMode, 'literal_text_no_merge_evaluation');
  assert.ok(manifest.fields.every(field => field.required && field.nativeBinding === null));
  for (const path of ['canonicalQuote.estimateFingerprint', 'serviceItems[].totalCents', 'paymentSchedule.depositDueDate', 'signerRoles[].authorityEvidenceId', 'paymentCollected']) assert.ok(manifest.fields.some(field => field.logicalPath === path), path);
});

test('pure adapter has no financial, network, storage or workflow side effects', () => {
  const source = fixture(), before = clone(source), originalFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('network must not be called'); };
  try {
    for (let i = 0; i < 3; i++) assert.equal(run(source).renderState, 'ready_for_mapping');
    assert.deepEqual(source, before);
  } finally { globalThis.fetch = originalFetch; }
  const module = readFileSync(new URL('../functions/_lib/quote-document-export.js', import.meta.url), 'utf8');
  assert.doesNotMatch(module, /from ['"].*(?:storage|stripe|highlevel|messeng|quote-draft|node:fs)/);
  assert.doesNotMatch(module, /\b(?:fetch|writeFile|process\.env|Date\.now|setTimeout)\s*\(/);
  blocked(fixture(), 'document_kind_invalid', { documentKind: 'invoice' });
});
