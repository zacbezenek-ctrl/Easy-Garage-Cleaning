import { sha256 } from '@noble/hashes/sha2.js';
import { requireQuoteAuthor } from './quote-permissions.js';
import { exportQuoteDocument, quoteDocumentReviewBinding, DOCUMENT_KINDS } from './quote-document-export.js';
import { applySelection, CUSTOMER_LINE_FIELDS, estimateFingerprint, estimateTotals, included, normalizeLineItems } from './quote-model.js';
import { businessPaymentDate, PAYMENT_TIME_ZONE, quotePaymentDates, quotePaymentSchedule } from './quote-payment-policy.js';
import { validDate } from './dispatch-time.js';
import { auditWrite } from './hub-audit.js';

export const QUOTE_DOCUMENT_COLLECTIONS = Object.freeze({ contexts: 'quoteDocumentContexts', snapshots: 'quoteDocumentSnapshots', approvals: 'quoteDocumentApprovals', heads: 'quoteDocumentHeads', receipts: 'quoteDocumentRequests', issues: 'quoteDocumentIssues' });
const C = QUOTE_DOCUMENT_COLLECTIONS;
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,180}$/.test(value) && !/^(secure_|_egc_)/.test(value);
const userId = value => typeof value === 'string' && /^[A-Za-z0-9_.@:+-]{1,120}$/.test(value);
const revision = value => typeof value === 'string' && value.length > 0 && value.length <= 200;
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : plain(value) ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value ?? null);
const hash = value => [...sha256(new TextEncoder().encode(canonical(value)))].map(byte => byte.toString(16).padStart(2, '0')).join('');
const same = (a, b) => canonical(a) === canonical(b);
const pick = (value, fields) => Object.fromEntries(fields.map(key => [key, value?.[key] ?? null]));
const fail = (code, message, status = 409, details) => Object.assign(new Error(message), { code: `quote_document_${code}`, status, details });
const keys = (value, allowed) => { if (!plain(value) || Object.keys(value).some(key => !allowed.includes(key))) throw fail('invalid_request', 'Use only document identity and reviewed version fields.', 400); };
const stamp = value => typeof value === 'string' && validDate(value.slice(0, 10)) && /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:0\d|1[0-4]):[0-5]\d)$/.test(value) && Number.isFinite(Date.parse(value));
const actorKey = value => String(value || '').trim().toLowerCase();
const assigned = (job, actor) => (Array.isArray(job.assignedCrew) ? job.assignedCrew : []).some(value => actorKey(typeof value === 'string' ? value : value?.username || value?.user || value?.id) === actorKey(actor.user));
export const quoteDocumentSnapshotId = (jobId, documentKind, estimateRevision) => hash(['quote_document_v1', jobId, documentKind, estimateRevision]);
const headId = (jobId, kind) => hash(['quote_document_head_v1', jobId, kind]);
const checkRecord = row => { if (!id(row?.id) || !revision(row.revision)) throw fail('source_unavailable', 'A required source record has no verified identity or revision.', 503); return row; };
const verify = (collection, row) => ({ collection, id: row.id, revision: row.revision, verify: true });

function requireEnabled(actor, env, enabled) {
  const rights = requireQuoteAuthor(actor, env);
  if (enabled !== true) throw fail('disabled', 'Internal quote document snapshots are not enabled.', 404);
  return rights;
}
function identity(input) {
  if (!id(input.jobId) || !DOCUMENT_KINDS.includes(input.documentKind)) throw fail('invalid_request', 'Choose a canonical job and supported document type.', 400);
}
async function access(store, actor, input, env, enabled) {
  const rights = requireEnabled(actor, env, enabled); identity(input);
  const job = await store.read('jobs', input.jobId);
  if (!job || job.recordType || !['job', 'cleanout', 'reorg'].includes(job.type)) throw fail('not_found', 'The canonical quote job was not found.', 404);
  checkRecord(job);
  const sources = [verify('jobs', job)];
  let walk = null;
  if (id(job.sourceWalkthroughId)) {
    walk = await store.read('jobs', job.sourceWalkthroughId);
    if (walk) checkRecord(walk);
  }
  const owns = actorKey(job.quoteDraft?.createdBy) === actorKey(actor.user) || assigned(job, actor) || walk?.customerId === job.customerId && assigned(walk, actor);
  if (!rights.dispatcher && !owns) throw fail('forbidden', 'Only this quote’s author, assigned rep or a manager can access its document drafts.', 403);
  if (walk) sources.push(verify('jobs', walk));
  return { job, walk, sources };
}
function walkDate(walk) {
  const value = walk?.walkthroughCompletedAt || walk?.completedAt || walk?.date;
  return validDate(value) ? value : stamp(value) ? businessPaymentDate(value) : null;
}
async function loadSource(store, accessResult, now) {
  const { job, walk } = accessResult;
  const [customer, property, context] = await Promise.all([
    id(job.customerId) ? store.read('customers', job.customerId) : null,
    id(job.propertyId) ? store.read('properties', job.propertyId) : null,
    store.read(C.contexts, job.id),
  ]);
  if (!customer || !property || !context) throw fail('context_missing', 'Canonical customer, property and reviewed document context are required. No form values may fill the gaps.');
  [customer, property, context].forEach(checkRecord);
  if (customer.id !== job.customerId || property.id !== job.propertyId || property.customerId !== customer.id || property.address !== job.address || customer.highlevelContactId !== job.highlevelContactId || !id(customer.highlevelContactId)) throw fail('lineage_mismatch', 'Review the canonical customer, provider contact and service property linkage.');
  if (walk && (walk.type !== 'walkthrough' || walk.customerId !== job.customerId)) throw fail('lineage_mismatch', 'The walkthrough does not belong to this canonical quote.');
  if (context.status !== 'reviewed' || !id(context.evidenceId) || !userId(context.reviewedBy) || !stamp(context.reviewedAt) || context.jobId !== job.id || context.customerId !== job.customerId || context.propertyId !== job.propertyId || context.estimateRevision !== job.estimate?.revision || context.estimateFingerprint !== estimateFingerprint(job.estimate) || !id(context.locationId)) throw fail('context_stale', 'The reviewed terms context does not match the current canonical quote.');
  if (new TextEncoder().encode(JSON.stringify(context)).byteLength > 128000) throw fail('context_too_large', 'The reviewed context exceeds the snapshot limit.');
  const sources = [...accessResult.sources, verify('customers', customer), verify('properties', property), verify(C.contexts, context)];
  if (job.projectId) {
    const project = await store.read('projects', job.projectId);
    if (!project || project.customerId !== customer.id) throw fail('lineage_mismatch', 'The canonical project does not belong to this customer.');
    checkRecord(project); sources.push(verify('projects', project));
  }
  const snapshot = {
    job, lineage: { customerId: customer.id, propertyId: property.id, contactId: customer.highlevelContactId, locationId: context.locationId, evidenceId: context.evidenceId, verifiedAt: context.reviewedAt },
    scopeExclusions: context.scopeExclusions, tax: context.tax, legal: context.legal, signerRoles: context.signerRoles, policyException: context.policyException,
    walkthrough: walk ? { id: walk.id, revision: walk.revision, customerId: walk.customerId, date: walkDate(walk) } : null,
    provenance: { source: 'canonical_hub', recordRef: `jobs/${job.id}`, readAt: now },
    // Optional intake linkage is server-reviewed; raw native submission values are never loaded.
    ...(context.intake == null ? {} : { intake: context.intake }),
  };
  return { snapshot, context, sources, binding: quoteDocumentReviewBinding(snapshot) };
}
function savedRecord(row, job, kind, estimateRevision) {
  if (!row || row.schemaVersion !== 1 || row.jobId !== job.id || row.customerId !== job.customerId || row.documentKind !== kind || row.estimateRevision !== estimateRevision || row.id !== quoteDocumentSnapshotId(job.id, kind, estimateRevision) || row.draft?.renderState !== 'ready_for_mapping' || row.draft.deliveryStatus !== 'unsent_draft_only' || !hex(row.contentDigest) || row.contentDigest !== row.draft.contentDigest || row.draftDigest !== hash(row.draft) || !same(row.approval?.binding, row.binding)) throw fail('snapshot_invalid', 'The saved document snapshot needs reconciliation.');
  checkRecord(row); return row;
}
async function savedView(store, row, job) {
  const issued = await store.read(C.issues, row.id);
  if (issued && (issued.snapshotId !== row.id || issued.jobId !== job.id || issued.contentDigest !== row.contentDigest || !stamp(issued.issuedAt))) throw fail('issuance_unverified', 'The historical issue record needs reconciliation.');
  return {
    snapshotId: row.id, documentKind: row.documentKind, estimateRevision: row.estimateRevision,
    state: issued ? 'issued' : 'unsent_draft_only', createdAt: row.createdAt, approvedBy: row.approval.approvedBy,
    matchesCurrentQuote: row.binding.jobRevision === job.revision && row.estimateRevision === job.estimate?.revision && row.binding.estimateFingerprint === estimateFingerprint(job.estimate),
    draft: row.draft,
  };
}

// This is an internal review projection, not an approved export. In particular
// it has no canonicalApproval, acceptance, collection or delivery authority.
function reviewProjection(snapshot) {
  const job = snapshot.job, estimate = job.estimate;
  let lines = normalizeLineItems(estimate.lineItems, { strict: true }).lineItems;
  if (estimate.selectedIds !== undefined) lines = applySelection(lines, estimate.selectedIds);
  const policy = estimate.commercialPolicy ?? snapshot.policyException.paymentPolicy;
  const amounts = estimate.paymentSchedule ? null : quotePaymentSchedule(estimate.amountCents, policy);
  const schedule = estimate.paymentSchedule ?? { depositCents: amounts.depositCents, remainderCents: amounts.remainderCents, ...quotePaymentDates(policy, { jobDate: job.date, walkthroughDate: snapshot.walkthrough.date }), timeZone: PAYMENT_TIME_ZONE, policyVersion: policy.version };
  return {
    state: 'unapproved_internal_review',
    customer: pick(job, ['customerId', 'customer', 'phone', 'email']), jobsite: pick(job, ['propertyId', 'address']),
    scope: { title: job.title, description: estimate.scope, exclusions: snapshot.scopeExclusions },
    serviceItems: lines.filter(line => line.kind !== 'tip').map(line => ({ ...pick(line, CUSTOMER_LINE_FIELDS), included: included(line), group: line.group, tier: line.tier })),
    totals: { ...pick(estimateTotals(lines), ['subtotalCents', 'discountCents', 'totalCents']), currency: estimate.currency, tax: pick(snapshot.tax, ['amountCents', 'treatment', 'summary', 'evidenceId']) },
    paymentPolicy: pick(policy, ['version', 'depositPct', 'remainderPct', 'depositDueRule', 'remainderDueRule']),
    paymentSchedule: pick(schedule, ['depositCents', 'remainderCents', 'depositDueDate', 'remainderDueDate', 'timeZone', 'policyVersion']),
    policyException: snapshot.policyException == null ? null : pick(snapshot.policyException, ['kind', 'reason', 'evidenceId', 'approvedBy', 'approvedAt']),
    legal: pick(snapshot.legal, ['termsVersion', 'templateVersion', 'textDigest', 'evidenceId', 'cancellationDeadline', 'refundTerms']),
    signerRoles: snapshot.signerRoles.map(signer => pick(signer, ['role', 'partyId', 'name', 'email', 'authorityEvidenceId'])),
  };
}

export async function readQuoteDocument(store, actor, input, now, { env = {}, enabled = false } = {}) {
  keys(input, ['jobId', 'documentKind', 'estimateRevision']);
  const a = await access(store, actor, input, env, enabled);
  if (!stamp(now)) throw fail('server_time_invalid', 'A valid server timestamp is required.', 503);
  if (input.estimateRevision !== undefined) {
    if (!Number.isSafeInteger(input.estimateRevision) || input.estimateRevision < 1) throw fail('invalid_request', 'Choose a positive estimate revision.', 400);
    const row = await store.read(C.snapshots, quoteDocumentSnapshotId(a.job.id, input.documentKind, input.estimateRevision));
    if (!row) throw fail('snapshot_not_found', 'No saved snapshot exists for that job and revision.', 404);
    return { ok: true, snapshot: await savedView(store, savedRecord(row, a.job, input.documentKind, input.estimateRevision), a.job) };
  }
  const loaded = await loadSource(store, a, now), draft = exportQuoteDocument(loaded.snapshot, { documentKind: input.documentKind });
  const blockers = draft.blockers.filter(code => code !== 'canonical_approval_missing_or_stale');
  const existing = await store.read(C.snapshots, quoteDocumentSnapshotId(a.job.id, input.documentKind, loaded.binding.estimateRevision));
  let currentSnapshot = null;
  if (existing) {
    savedRecord(existing, a.job, input.documentKind, loaded.binding.estimateRevision);
    currentSnapshot = await savedView(store, existing, a.job);
    if (!same(existing.binding, loaded.binding)) blockers.push('document_revision_conflict');
  }
  return {
    ok: true, reviewState: blockers.length ? 'blocked' : existing ? 'already_snapshotted' : 'awaiting_internal_approval', blockers, currentSnapshot,
    binding: loaded.binding, contextRevision: loaded.context.revision,
    quote: { jobId: a.job.id, number: a.job.estimate.number, amountCents: a.job.estimate.amountCents, currency: a.job.estimate.currency, scope: a.job.estimate.scope },
    review: blockers.length ? null : reviewProjection(loaded.snapshot),
    requiredNativeBindings: draft.requiredNativeBindings, deliveryStatus: 'unsent_draft_only',
  };
}

/** Explicit internal estimator approval + immutable snapshot in one transaction.
 * Input contains only identifiers and expected versions returned by the read.
 * This never invokes customer approval, native delivery, invoice or payment APIs.
 */
export async function approveQuoteDocument(store, actor, input, now, { env = {}, enabled = false, retry = false } = {}) {
  keys(input, ['jobId', 'documentKind', 'requestId', 'expectedJobRevision', 'expectedEstimateRevision', 'expectedEstimateFingerprint', 'expectedContextRevision', 'expectedContextDigest']);
  if (!uuid(input.requestId) || !revision(input.expectedJobRevision) || !Number.isSafeInteger(input.expectedEstimateRevision) || input.expectedEstimateRevision < 1 || !hex(input.expectedEstimateFingerprint) || !revision(input.expectedContextRevision) || !hex(input.expectedContextDigest)) throw fail('invalid_request', 'Reload the internal quote review before approving its exact versions.', 400);
  if (!stamp(now)) throw fail('server_time_invalid', 'A valid server timestamp is required.', 503);
  const a = await access(store, actor, input, env, enabled), requestId = input.requestId.toLowerCase(), requestDigest = hash([actorKey(actor.user), input]);
  async function replay() {
    const receipt = await store.read(C.receipts, requestId);
    if (!receipt) return null;
    if (receipt.requestDigest !== requestDigest || receipt.actorId !== actorKey(actor.user)) throw fail('request_conflict', 'This request ID belongs to a different internal approval.');
    const row = savedRecord(await store.read(C.snapshots, receipt.snapshotId), a.job, input.documentKind, input.expectedEstimateRevision);
    if (row.id !== receipt.snapshotId || row.contentDigest !== receipt.contentDigest) throw fail('snapshot_invalid', 'The approval receipt and saved snapshot disagree.');
    return { ok: true, replayed: true, snapshot: await savedView(store, row, a.job) };
  }
  const prior = await replay(); if (prior) return prior;
  const loaded = await loadSource(store, a, now), b = loaded.binding;
  if (input.expectedJobRevision !== b.jobRevision || input.expectedEstimateRevision !== b.estimateRevision || input.expectedEstimateFingerprint !== b.estimateFingerprint || input.expectedContextRevision !== loaded.context.revision || input.expectedContextDigest !== b.contextDigest) throw fail('revision_conflict', 'The quote or reviewed terms changed. Reload and review again.');
  const snapshotId = quoteDocumentSnapshotId(a.job.id, input.documentKind, b.estimateRevision), indexId = headId(a.job.id, input.documentKind);
  const [existing, head] = await Promise.all([store.read(C.snapshots, snapshotId), store.read(C.heads, indexId)]);
  if (head && (head.jobId !== a.job.id || head.documentKind !== input.documentKind || !Number.isSafeInteger(head.estimateRevision))) throw fail('snapshot_invalid', 'The document revision index needs reconciliation.');
  if (head && head.estimateRevision > b.estimateRevision) throw fail('revision_stale', 'A newer document revision is already saved.');
  if (head && !existing && head.estimateRevision === b.estimateRevision) throw fail('snapshot_invalid', 'The indexed snapshot is missing.');
  if (existing) {
    savedRecord(existing, a.job, input.documentKind, b.estimateRevision);
    if (!same(existing.binding, b)) throw fail('revision_conflict', 'Different content already owns this document revision. Preserve it and review a new canonical revision.');
  }
  const approval = existing?.approval || { status: 'approved', approvedBy: actorKey(actor.user), approvedAt: now, evidenceId: snapshotId, binding: b };
  const draft = exportQuoteDocument({ ...loaded.snapshot, canonicalApproval: approval }, { documentKind: input.documentKind, existingSnapshots: existing ? [{ jobId: existing.jobId, documentKind: existing.documentKind, estimateRevision: existing.estimateRevision, idempotencyKey: existing.draft.idempotencyKey, contentDigest: existing.contentDigest }] : [] });
  if (draft.renderState !== 'ready_for_mapping') throw fail('blocked', 'The canonical quote needs review before an internal document snapshot can be saved.', 409, { blockers: draft.blockers });
  // The exported payload is immutable; replay disposition is response metadata only.
  const savedDraft = { ...draft, disposition: 'new' };
  const row = existing || { schemaVersion: 1, jobId: a.job.id, customerId: a.job.customerId, documentKind: input.documentKind, estimateRevision: b.estimateRevision, binding: b, contextRevision: loaded.context.revision, contentDigest: draft.contentDigest, approval, draft: savedDraft, draftDigest: hash(savedDraft), createdAt: now };
  if (new TextEncoder().encode(JSON.stringify(row)).byteLength > 512000) throw fail('snapshot_too_large', 'The document snapshot exceeds its storage limit.');
  const writes = [...loaded.sources, { collection: C.receipts, id: requestId, patch: { schemaVersion: 1, actorId: actorKey(actor.user), requestDigest, snapshotId, contentDigest: row.contentDigest, jobId: a.job.id, createdAt: now } }];
  if (existing) {
    writes.push(verify(C.snapshots, existing));
    if (head) writes.push(verify(C.heads, checkRecord(head)));
  }
  else {
    writes.push({ collection: C.snapshots, id: snapshotId, patch: row }, { collection: C.approvals, id: snapshotId, patch: { ...approval, jobId: a.job.id, documentKind: input.documentKind, estimateRevision: b.estimateRevision } },
      { collection: C.heads, id: indexId, ...(head ? { revision: checkRecord(head).revision } : {}), patch: { jobId: a.job.id, documentKind: input.documentKind, estimateRevision: b.estimateRevision, snapshotId, contentDigest: row.contentDigest } },
      auditWrite({ actor: { id: actorKey(actor.user), kind: 'human', role: actor.role }, via: 'hub', action: 'quote.document.approve', entity: { collection: C.snapshots, id: snapshotId }, before: null, after: { jobId: a.job.id, documentKind: input.documentKind, estimateRevision: b.estimateRevision, contentDigest: row.contentDigest }, requestId, now }));
  }
  try { await store.commit(writes); }
  catch (error) {
    const recovered = await replay(); if (recovered) return recovered;
    if (error.code === 'dispatch_revision_conflict' && !retry) return approveQuoteDocument(store, actor, input, now, { env, enabled, retry: true });
    if (error.code === 'dispatch_revision_conflict') throw fail('revision_conflict', 'A source or document revision changed during approval. Reload before retrying.');
    throw fail('outcome_unknown', 'The approval outcome is unknown. Retry the identical request ID and versions.', 503);
  }
  const saved = await replay();
  if (!saved) throw fail('outcome_unknown', 'The saved approval could not be read. Retry the identical request.', 503);
  return { ...saved, replayed: Boolean(existing) };
}
