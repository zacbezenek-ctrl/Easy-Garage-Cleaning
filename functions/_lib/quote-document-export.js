import { sha256 } from '@noble/hashes/sha2.js';
import { applySelection, CUSTOMER_LINE_FIELDS, depositCents, estimateFingerprint, estimateTotals, exactCents, included, MAX_TOTAL_CENTS, normalizeLineItems, validateSelection } from './quote-model.js';
import { FINAL_25_75, PAYMENT_TIME_ZONE, SIGNED_25_75, quotePaymentDates, quotePaymentSchedule, snapshotQuotePaymentPolicy } from './quote-payment-policy.js';
import { validDate } from './dispatch-time.js';

/** Pure server-side adapter. No storage, clock, environment, provider or send APIs.
 * The caller must obtain every input (including review evidence) by authorized
 * server reads. This module validates that evidence; it does not issue it.
 */
export const QUOTE_DOCUMENT_SCHEMA = 'egc_quote_document_v1';
export const DOCUMENT_KINDS = Object.freeze(['estimate', 'proposal', 'service_agreement']);
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.trim().length > 0;
const id = value => text(value) && value.length <= 200 && !/[\u0000-\u001f/\\]/.test(value);
const revision = value => id(value) || Number.isSafeInteger(value) && value > 0;
const cents = value => Number.isSafeInteger(value) && value >= 0 && value <= MAX_TOTAL_CENTS;
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const pick = (value, keys) => Object.fromEntries(keys.map(key => [key, value?.[key] ?? null]));
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : plain(value) ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value ?? null);
const hash = value => Array.from(sha256(new TextEncoder().encode(canonical(value))), byte => byte.toString(16).padStart(2, '0')).join('');
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
const copy = value => value == null ? null : structuredClone(value);

// Date.parse normalizes impossible dates. Validate the calendar date first,
// require an explicit offset, then check the complete timestamp grammar.
const timestamp = value => typeof value === 'string' && validDate(value.slice(0, 10)) && /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:0\d|1[0-4]):[0-5]\d)$/.test(value) && Number.isFinite(Date.parse(value));
const email = value => text(value) && value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
const evidence = value => plain(value) && id(value.evidenceId) && id(value.approvedBy) && timestamp(value.approvedAt);
const same = (left, right) => canonical(left) === canonical(right);
const escaped = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const usd = value => `$${Math.floor(value / 100).toLocaleString('en-US')}.${String(value % 100).padStart(2, '0')}`;

/** Review binding includes material fields that estimateFingerprint omits.
 * Computing this binding is NOT approval. Only the authorized review workflow
 * may persist it with approvedBy/approvedAt/evidenceId and status:approved.
 */
export function quoteDocumentReviewBinding(snapshot = {}) {
  const job = snapshot?.job || {}, estimate = job.estimate || {};
  const binding = {
    jobId: job.id ?? null, jobRevision: job.revision ?? null,
    quoteNumber: estimate.number ?? null, estimateRevision: estimate.revision ?? null,
    estimateFingerprint: estimateFingerprint(estimate),
  };
  const context = {
    binding,
    job: pick(job, ['customerId', 'propertyId', 'projectId', 'sourceWalkthroughId', 'customer', 'phone', 'email', 'highlevelContactId', 'address', 'title', 'date']),
    // amountCents and termsVersion are not covered by the existing fingerprint.
    estimate: pick(estimate, ['amountCents', 'depositRequiredCents', 'termsVersion', 'currency']),
    lineage: snapshot.lineage ?? null, scopeExclusions: snapshot.scopeExclusions ?? null,
    tax: snapshot.tax ?? null, legal: snapshot.legal ?? null, signerRoles: snapshot.signerRoles ?? null,
    policyException: snapshot.policyException ?? null, walkthrough: snapshot.walkthrough ?? null,
    intake: snapshot.intake ?? null,
  };
  return freeze({ ...binding, contextDigest: hash(context) });
}

/** Logical paths only. Native IDs/tokens are deliberately absent/unbound. */
export function requiredQuoteDocumentBindings(documentKind) {
  const fields = [];
  const add = (prefix, names, type = 'text', destination = 'document') => names.forEach(name => fields.push({ logicalPath: `${prefix}.${name}`, type, destination, required: true, nullable: ['projectId', 'sourceWalkthroughId', 'group', 'tier'].includes(name), nativeBinding: null }));
  add('canonicalQuote', ['jobId', 'jobRevision', 'quoteNumber', 'estimateRevision', 'estimateFingerprint', 'customerId', 'projectId', 'sourceWalkthroughId'], 'identity', 'snapshot_metadata');
  add('customer', ['id', 'name', 'phone', 'email']);
  add('contact', ['contactId', 'locationId'], 'identity', 'snapshot_metadata');
  add('jobsite', ['propertyId', 'address']);
  add('scope', ['title', 'description', 'exclusions'], 'multiline_text');
  add('serviceItems[]', [...CUSTOMER_LINE_FIELDS, 'included', 'group', 'tier'], 'repeating_customer_row');
  add('totals', ['currency', 'subtotalCents', 'discountCents', 'taxCents', 'taxTreatment', 'taxSummary', 'totalCents'], 'money_and_tax');
  add('paymentPolicy', ['version', 'depositPct', 'remainderPct', 'depositDueRule', 'remainderDueRule'], 'saved_policy');
  add('paymentSchedule', ['depositCents', 'remainderCents', 'depositDueDate', 'remainderDueDate', 'timeZone', 'policyVersion', 'source'], 'date_and_cents');
  add('legal', ['termsVersion', 'templateVersion', 'textDigest', 'evidenceId', 'cancellationDeadline', 'refundTerms'], 'approved_terms_reference');
  add('signerRoles[]', ['role', 'partyId', 'name', 'email', 'authorityEvidenceId'], 'reviewed_signer_role');
  for (const logicalPath of ['policyException', 'provenance', 'acceptance', 'paymentCollected', 'idempotencyKey', 'contentDigest']) fields.push({ logicalPath, type: 'metadata', destination: 'snapshot_metadata', required: true, nullable: logicalPath === 'policyException', nativeBinding: null });
  return freeze({
    status: 'unbound', documentKind, nativeTemplateId: null, nativeTemplateVersion: null,
    valueMode: 'literal_text_no_merge_evaluation', storageScope: 'per_document_snapshot',
    fields,
    releaseRequirements: ['verified_native_picker_bindings', 'approved_template_version', 'atomic_snapshot_claim', 'independent_review', 'explicit_revision_bound_send_authorization'],
  });
}

function validatePolicy(snapshot, total, issue) {
  const estimate = snapshot.job.estimate, exception = snapshot.policyException;
  if (exception === undefined) issue('policy_exception_review_missing');
  let policy, exceptionCopy = null;
  if (exception != null) {
    if (!evidence(exception) || exception.status !== 'approved' || !['customer_exception', 'legacy_terms'].includes(exception.kind) || !text(exception.reason)) issue('policy_exception_unverified');
    policy = estimate.commercialPolicy ?? exception.paymentPolicy;
    if (estimate.commercialPolicy !== undefined && exception.paymentPolicy !== undefined && !same(policy, exception.paymentPolicy)) issue('policy_exception_conflict');
    exceptionCopy = pick(exception, ['kind', 'status', 'reason', 'evidenceId', 'approvedBy', 'approvedAt']);
    if (!plain(policy) || !id(policy.version) || typeof policy.depositPct !== 'number' || typeof policy.remainderPct !== 'number' || !text(policy.depositDueRule) || !text(policy.remainderDueRule) || policy.depositPct + policy.remainderPct !== 100) {
      issue('legacy_payment_policy_unverified'); return {};
    }
    try { depositCents(total, policy.depositPct); depositCents(total, policy.remainderPct); } catch { issue('legacy_payment_policy_invalid'); return {}; }
    policy = pick(policy, ['version', 'depositPct', 'remainderPct', 'depositDueRule', 'remainderDueRule']);
  } else {
    try {
      policy = snapshotQuotePaymentPolicy(estimate.commercialPolicy);
      // The owner's two dated 25/75 policies: a sent quote's of 2026-10-14 and an in-person signature's (deposit due the day
      // it was signed). A quote sent on SENT_25_75 has no deposit date until it is approved, which this document's dated
      // bindings cannot state, so it is blocked here (payment_policy_requires_exception) rather than given a date.
      if (!same(policy, FINAL_25_75) && !same(policy, SIGNED_25_75)) issue('payment_policy_requires_exception');
    } catch { issue('canonical_payment_policy_missing'); return {}; }
  }
  const expectedDeposit = depositCents(total, policy.depositPct);
  if (estimate.depositRequiredCents !== expectedDeposit || exactCents(estimate.depositRequired) !== expectedDeposit) issue('canonical_deposit_mismatch');
  if (estimate.depositPct != null && estimate.depositPct !== policy.depositPct) issue('canonical_deposit_percent_mismatch');
  const saved = estimate.paymentSchedule;
  let schedule;
  if (saved != null) {
    if (!plain(saved) || !validDate(saved.depositDueDate) || !validDate(saved.remainderDueDate) || saved.depositDueDate > saved.remainderDueDate || saved.timeZone !== PAYMENT_TIME_ZONE || saved.policyVersion !== policy.version || saved.depositCents !== expectedDeposit || saved.remainderCents !== total - expectedDeposit) issue('saved_payment_schedule_invalid');
    schedule = { ...pick(saved, ['depositCents', 'remainderCents', 'depositDueDate', 'remainderDueDate', 'timeZone', 'policyVersion', 'sourceWalkthroughId', 'sourceRevision']), source: 'saved' };
  } else if (exception != null) {
    issue('legacy_payment_schedule_missing');
  } else {
    const walk = snapshot.walkthrough;
    if (!plain(walk) || !id(walk.id) || walk.id !== snapshot.job.sourceWalkthroughId || walk.customerId !== snapshot.job.customerId || !id(walk.revision) || !validDate(walk.date) || !validDate(snapshot.job.date)) issue('verified_payment_dates_missing');
    else {
      try {
        const amounts = quotePaymentSchedule(total, policy);
        schedule = { depositCents: amounts.depositCents, remainderCents: amounts.remainderCents, ...quotePaymentDates(policy, { walkthroughDate: walk.date, jobDate: snapshot.job.date }), timeZone: PAYMENT_TIME_ZONE, policyVersion: policy.version, sourceWalkthroughId: walk.id, sourceRevision: walk.revision, source: 'derived_from_reviewed_dates' };
      } catch { issue('payment_dates_invalid'); }
    }
  }
  return { policy, schedule, exception: exceptionCopy };
}

function collectionState(snapshot, issue) {
  const state = snapshot.paymentCollected;
  if (state == null) return { status: 'unknown', appliedCents: null, evidenceId: null, recordedAt: null };
  if (!plain(state) || !['unknown', 'unpaid', 'partial', 'paid', 'overpaid'].includes(state.status)) { issue('payment_collection_invalid'); return null; }
  if (state.status === 'unknown') {
    if (state.appliedCents != null) issue('payment_collection_invalid');
    return { status: 'unknown', appliedCents: null, evidenceId: null, recordedAt: null };
  }
  if (!cents(state.appliedCents) || !id(state.evidenceId) || !timestamp(state.recordedAt) || state.jobId !== snapshot.job.id || state.customerId !== snapshot.job.customerId) issue('payment_collection_unverified');
  const total = snapshot.job.estimate.amountCents, paid = state.appliedCents;
  const expected = paid === 0 ? 'unpaid' : paid < total ? 'partial' : paid === total ? 'paid' : 'overpaid';
  if (state.status !== expected) issue('payment_collection_mismatch');
  return pick(state, ['status', 'appliedCents', 'evidenceId', 'recordedAt']);
}

function acceptanceState(snapshot, binding, issue) {
  const accepted = snapshot.customerAcceptance;
  if (accepted == null) return { status: 'unverified' };
  if (!evidence(accepted) || accepted.status !== 'accepted' || !text(accepted.method) || !same(accepted.binding, binding)) { issue('customer_acceptance_unverified'); return null; }
  return { ...pick(accepted, ['status', 'approvedBy', 'approvedAt', 'method', 'evidenceId']), estimateRevision: binding.estimateRevision, estimateFingerprint: binding.estimateFingerprint };
}

function displayFor(payload) {
  return {
    customerName: escaped(payload.customer.name), customerPhone: escaped(payload.customer.phone), customerEmail: escaped(payload.customer.email),
    jobsiteAddress: escaped(payload.jobsite.address), scopeTitle: escaped(payload.scope.title), scopeDescription: escaped(payload.scope.description),
    exclusions: payload.scope.exclusions.map(escaped),
    serviceItems: payload.serviceItems.map(item => ({ id: item.id, name: escaped(item.name), description: escaped(item.description || ''), total: item.totalCents < 0 ? `-${usd(-item.totalCents)}` : usd(item.totalCents), selected: item.selected })),
    subtotal: usd(payload.totals.subtotalCents), discount: usd(payload.totals.discountCents), tax: usd(payload.totals.taxCents), total: usd(payload.totals.totalCents),
    deposit: usd(payload.paymentSchedule.depositCents), remainder: usd(payload.paymentSchedule.remainderCents),
    depositDueDate: payload.paymentSchedule.depositDueDate, remainderDueDate: payload.paymentSchedule.remainderDueDate, timeZone: PAYMENT_TIME_ZONE,
  };
}

/** Build an immutable, unsent mapping draft. On any blocker payload is null.
 * existingSnapshots is caller-supplied metadata from authoritative snapshot
 * storage, not provider contact fields. The caller still needs an atomic claim.
 */
export function exportQuoteDocument(snapshot = {}, { documentKind = 'proposal', existingSnapshots = [] } = {}) {
  const blockers = [], issue = code => { if (!blockers.includes(code)) blockers.push(code); };
  const result = { schemaVersion: QUOTE_DOCUMENT_SCHEMA, documentKind, renderState: 'blocked', deliveryStatus: 'unsent_draft_only', blockers, idempotencyKey: null, contentDigest: null, disposition: null, requiredNativeBindings: requiredQuoteDocumentBindings(documentKind), payload: null, display: null };
  if (!DOCUMENT_KINDS.includes(documentKind)) issue('document_kind_invalid');
  if (!plain(snapshot) || !plain(snapshot.job) || !plain(snapshot.job.estimate)) { issue('canonical_quote_missing'); return freeze(result); }
  const job = snapshot.job, estimate = job.estimate;
  if (!id(job.id) || !id(job.revision) || !id(estimate.number) || !Number.isSafeInteger(estimate.revision) || estimate.revision < 1) issue('canonical_quote_identity_invalid');
  if (['void', 'superseded', 'cancelled', 'canceled', 'declined', 'expired'].includes(estimate.status)) issue('canonical_quote_inactive');
  if ([job.projectId, job.sourceWalkthroughId].some(value => value != null && !id(value))) issue('canonical_lineage_identity_invalid');
  if (plain(snapshot.provenance) && snapshot.provenance.source === 'canonical_hub' && snapshot.provenance.recordRef === `jobs/${job.id}` && timestamp(snapshot.provenance.readAt)) { /* provenance is evidence, not an HTTP trust signal */ }
  else issue('canonical_provenance_missing');
  const binding = quoteDocumentReviewBinding(snapshot), approval = snapshot.canonicalApproval;
  if (!evidence(approval) || approval.status !== 'approved' || !same(approval.binding, binding)) issue('canonical_approval_missing_or_stale');
  if (!id(job.customerId) || !text(job.customer) || !text(job.phone) || !email(job.email)) issue('customer_required_fields_missing');
  if (!id(job.propertyId) || !text(job.address)) issue('jobsite_required_fields_missing');
  const lineage = snapshot.lineage;
  if (!plain(lineage) || lineage.customerId !== job.customerId || lineage.propertyId !== job.propertyId || !id(lineage.contactId) || !id(lineage.locationId) || !id(lineage.evidenceId) || !timestamp(lineage.verifiedAt) || (job.highlevelContactId != null && lineage.contactId !== job.highlevelContactId)) issue('customer_contact_jobsite_link_unverified');
  if (!text(job.title) || !text(estimate.scope) || !Array.isArray(snapshot.scopeExclusions) || !snapshot.scopeExclusions.every(text)) issue('reviewed_scope_missing');
  if (estimate.currency !== 'USD') issue('canonical_currency_unverified');
  if (!id(estimate.termsVersion) || !plain(snapshot.legal) || snapshot.legal.termsVersion !== estimate.termsVersion || !id(snapshot.legal.templateVersion) || !digest(snapshot.legal.textDigest) || !id(snapshot.legal.evidenceId)) issue('approved_legal_template_missing');
  if (snapshot.legal?.cancellationDeadline != null && !validDate(snapshot.legal.cancellationDeadline)) issue('legal_date_invalid');
  if (snapshot.legal?.refundTerms != null && !text(snapshot.legal.refundTerms)) issue('legal_terms_invalid');
  const signers = snapshot.signerRoles;
  if (!Array.isArray(signers) || signers.length !== 2 || !['customer', 'company'].every(role => signers.filter(signer => signer?.role === role).length === 1) || signers.some(signer => !id(signer?.partyId) || !text(signer.name) || !email(signer.email) || !id(signer.authorityEvidenceId)) || signers.find(signer => signer.role === 'customer')?.partyId !== job.customerId) issue('signer_roles_unverified');
  if (snapshot.intake != null) {
    const intake = snapshot.intake;
    if (!plain(intake) || !id(intake.handoffReference) || !['quote', 'sale'].includes(intake.source?.kind) || !id(intake.source?.id) || !revision(intake.source?.revision) || !id(intake.houseId) || !text(intake.channel) || !id(intake.linkEvidenceId) || intake.canonicalJobId !== job.id || intake.canonicalEstimateRevision !== estimate.revision || intake.canonicalEstimateFingerprint !== binding.estimateFingerprint) issue('intake_canonical_link_unverified');
  }
  let lines = [], totals;
  try {
    lines = normalizeLineItems(estimate.lineItems, { strict: true }).lineItems;
    if (estimate.selectedIds !== undefined) lines = applySelection(lines, estimate.selectedIds);
    totals = estimateTotals(lines);
    if (!lines.length || !validateSelection(lines).ok || !totals.complete || !cents(totals.totalCents) || totals.totalCents <= 0 || totals.totalCents !== estimate.amountCents || exactCents(estimate.amount) !== estimate.amountCents) issue('canonical_totals_invalid');
  } catch { issue('canonical_lines_invalid'); }
  const tax = snapshot.tax;
  if (!plain(tax) || tax.status !== 'verified' || !cents(tax.amountCents) || !text(tax.summary) || !id(tax.evidenceId) || !['not_applicable', 'exempt', 'included_in_lines'].includes(tax.treatment) || (tax.treatment !== 'included_in_lines' && tax.amountCents !== 0) || tax.amountCents > estimate.amountCents) issue('canonical_tax_unverified');
  const payment = cents(estimate.amountCents) ? validatePolicy(snapshot, estimate.amountCents, issue) : {};
  const collected = collectionState(snapshot, issue), acceptance = acceptanceState(snapshot, binding, issue);
  if (blockers.length) return freeze(result);
  result.idempotencyKey = `egc-quote-document:v1:${encodeURIComponent(job.id)}:${documentKind}:r${estimate.revision}`;
  const payload = {
    canonicalQuote: { jobId: job.id, jobRevision: job.revision, quoteNumber: estimate.number, estimateRevision: estimate.revision, estimateFingerprint: binding.estimateFingerprint, customerId: job.customerId, projectId: job.projectId ?? null, sourceWalkthroughId: job.sourceWalkthroughId ?? null },
    customer: { id: job.customerId, name: job.customer, phone: job.phone, email: job.email },
    contact: pick(lineage, ['contactId', 'locationId']),
    jobsite: { propertyId: job.propertyId, address: job.address },
    scope: { title: job.title, description: estimate.scope, exclusions: copy(snapshot.scopeExclusions) },
    serviceItems: lines.filter(line => line.kind !== 'tip' && (documentKind !== 'service_agreement' || included(line))).map(line => ({ ...pick(line, CUSTOMER_LINE_FIELDS), included: included(line), group: copy(line.group), tier: line.tier })),
    totals: { currency: 'USD', subtotalCents: totals.subtotalCents, discountCents: totals.discountCents, taxCents: tax.amountCents, taxTreatment: tax.treatment, taxSummary: tax.summary, totalCents: totals.totalCents },
    paymentPolicy: copy(payment.policy), paymentSchedule: copy(payment.schedule), policyException: payment.exception,
    legal: pick(snapshot.legal, ['termsVersion', 'templateVersion', 'textDigest', 'evidenceId', 'cancellationDeadline', 'refundTerms']),
    signerRoles: signers.map(signer => pick(signer, ['role', 'partyId', 'name', 'email', 'authorityEvidenceId'])),
    acceptance, paymentCollected: collected,
    provenance: { source: 'canonical_hub', recordRef: snapshot.provenance.recordRef, readAt: snapshot.provenance.readAt, review: { ...pick(approval, ['approvedBy', 'approvedAt', 'evidenceId']), ...binding }, lineageEvidenceId: lineage.evidenceId, taxEvidenceId: tax.evidenceId, intake: snapshot.intake == null ? null : { ...pick(snapshot.intake, ['handoffReference', 'channel', 'houseId', 'linkEvidenceId']), source: pick(snapshot.intake.source, ['kind', 'id', 'revision']) } },
  };
  // readAt is retrieval metadata; re-reading identical approved content is a replay.
  result.contentDigest = hash({ documentKind, ...payload, provenance: { ...payload.provenance, readAt: null } });
  if (!Array.isArray(existingSnapshots) || existingSnapshots.some(row => !plain(row) || !id(row.jobId) || !DOCUMENT_KINDS.includes(row.documentKind) || !Number.isSafeInteger(row.estimateRevision) || row.estimateRevision < 1 || !text(row.idempotencyKey) || !digest(row.contentDigest))) issue('snapshot_history_invalid');
  else {
    const sameDocument = existingSnapshots.filter(row => row.jobId === job.id && row.documentKind === documentKind);
    if (sameDocument.some(row => row.estimateRevision > estimate.revision)) issue('document_revision_stale');
    if (sameDocument.some(row => row.estimateRevision === estimate.revision && (row.idempotencyKey !== result.idempotencyKey || row.contentDigest !== result.contentDigest))) issue('document_revision_conflict');
    if (existingSnapshots.some(row => row.idempotencyKey === result.idempotencyKey && (row.jobId !== job.id || row.documentKind !== documentKind || row.estimateRevision !== estimate.revision || row.contentDigest !== result.contentDigest))) issue('document_idempotency_conflict');
    result.disposition = sameDocument.some(row => row.idempotencyKey === result.idempotencyKey) ? 'replay' : 'new';
  }
  if (blockers.length) return freeze(result);
  result.renderState = 'ready_for_mapping'; result.payload = payload; result.display = displayFor(payload);
  return freeze(result);
}
