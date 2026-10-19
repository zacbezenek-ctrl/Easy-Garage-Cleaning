import { fieldChecklist, fieldCompletionMissing, fieldId, fieldPhotos, fieldRequestId, fieldStage } from './field-execution.js';
import { createJobAssignmentAccess, assignmentKey } from './job-assignment.js';
import { fieldJobLead } from './field-permissions.js';
import { getHubUserProfile, hasBusinessAccess } from './hub-session.js';
import { getEmployeeSessionProfile } from './employee-accounts.js';
import { PURPOSES, purposeSign } from './purpose-keys.js';
import { confirmationPayloadHash } from './confirm-token.js';
import { highLevelConfig } from './highlevel-tags.js';
import { customerMoneyTotals, paymentLedger } from './money-core.js';
import { estimateFingerprint } from './quote-model.js';
import { moneyCents } from './operations-financials.js';
import { readW19CustomerEmail, readW19Opportunity, readW19Submission, W19_FORM_ID } from './w19-form-submissions.js';
import { W19_FORM_URL, W19_NATIVE_FIELDS } from './w19-native-form.js';
import { normalizeEmail } from './customer-identity.js';

export const W19_HANDOFFS = 'w19CompletionHandoffs';
export const W19_SUBMISSIONS = 'w19CompletionSubmissions';
export const W19_COMPLETIONS = 'w19CompletionClaims';
export const w19Enabled = env => env?.EGC_W19_COMPLETION_HANDOFF === 'true';
export const w19Reference = value => typeof value === 'string' && /^w19_[A-Za-z0-9_-]{43}$/.test(value);
const TTL_MS = 7 * 86400000;
const ID = /^[A-Za-z0-9_-]{1,180}$/;
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const instant = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value) && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : '';
const fail = (code, message, status = 409) => Object.assign(new Error(message), { code, status });
const eventCollection = jobId => `jobs/${jobId}/fieldEvents`;
const denverDate = value => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Denver', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value));

function mapping(value, keys) {
  try {
    const data = JSON.parse(value);
    return plain(data) && Object.keys(data).length === keys.length && keys.every(key => typeof data[key] === 'string' && ID.test(data[key]) && !['__proto__', 'constructor', 'prototype'].includes(data[key])) && new Set(Object.values(data)).size === keys.length ? data : null;
  } catch { return null; }
}

/** All provider names below must come from the actual form's verified setup.
 * No query key, field ID, launch URL or workflow activation is inferred here.
 */
export function w19Configuration(env = {}) {
  const config = highLevelConfig(env), missing = [];
  const nativeQueries = { jobId: W19_NATIVE_FIELDS.jobId.key, reference: W19_NATIVE_FIELDS.reference.key };
  const queryKeys = mapping(env.EGC_W19_COMPLETION_QUERY_KEYS_JSON ?? JSON.stringify(nativeQueries), ['jobId', 'reference']);
  const associationMode = env.EGC_W19_COMPLETION_ASSOCIATION_MODE === 'manual_email' ? 'manual_email' : '';
  const fieldIds = mapping(env.EGC_W19_COMPLETION_RECEIPT_FIELDS_JSON ?? JSON.stringify({ jobId: W19_NATIVE_FIELDS.jobId.id, reference: W19_NATIVE_FIELDS.reference.id }), ['jobId', 'reference']);
  let formUrl = '';
  try {
    const url = new URL(env.EGC_W19_COMPLETION_FORM_URL ?? W19_FORM_URL);
    if (['https://api.leadconnectorhq.com', 'https://links.easygaragecleaning.com'].includes(url.origin) && !url.username && !url.password && (!url.search || url.search === '?notrack=true') && !url.hash && url.pathname === `/widget/form/${W19_FORM_ID}`) formUrl = url.href;
  } catch { /* Setup remains visibly incomplete. */ }
  if (!formUrl) missing.push('Verified native completion form launch URL');
  if (!queryKeys || Object.keys(nativeQueries).some(key => queryKeys[key] !== nativeQueries[key])) missing.push('Verified native job and reference query keys only');
  if (!associationMode) missing.push('Verified required standard customer email association with Sticky Contact off');
  if (!fieldIds) missing.push('Verified submission field IDs for job and completion reference');
  if (!config.token || !ID.test(config.locationId)) missing.push('Existing HighLevel read connection and exact location');
  if (env.EGC_W19_COMPLETION_WORKFLOW_READY !== 'true') missing.push('W19 completion-only response gate verified before activation; task actions remain disabled');
  return { ...config, formUrl, queryKeys, fieldIds, associationMode, missing };
}

export async function w19AssignedLead(env, actor, job) {
  if (!actor?.user) return false;
  const access = createJobAssignmentAccess(env, actor);
  return await access.assigned(job) && await fieldJobLead({ session: actor, job, access });
}

export async function w19CurrentLead(env, record) {
  return record.leadSource === 'employee-account'
    ? getEmployeeSessionProfile(env, record.confirmingLeadId, record.leadSessionVersion)
    : getHubUserProfile(env, record.confirmingLeadId);
}

/** Immutable, verified closeout facts only. CRM sync attempts, job revision,
 * payment state and later additional photos do not change this digest.
 */
export async function w19CompletionProof(job, event) {
  const completion = job?.fieldExecution?.completion, evidence = job?.completionEvidence;
  const forbidden = ['cancelled', 'canceled', 'no_show', 'no-show', 'noshow', 'superseded', 'lost'];
  if (!job || !fieldId(job.id) || !['job', 'cleanout', 'reorg'].includes(job.type) || job.recordType ||
      [job.status, job.pipelineStatus].some(value => forbidden.includes(String(value || '').toLowerCase())) ||
      !['completed', 'invoiced', 'paid', 'review_requested'].includes(fieldStage(job)) ||
      !plain(completion) || !plain(evidence) || evidence.kind !== 'verified_field_execution' || !fieldRequestId(evidence.requestId) ||
      !instant(completion.completedAt) || instant(job.completedAt) !== instant(completion.completedAt) || instant(evidence.recordedAt) !== instant(completion.completedAt) ||
      typeof completion.actorId !== 'string' || !completion.actorId || evidence.actorId !== completion.actorId ||
      typeof completion.notes !== 'string' || completion.notes.length > 4000 || typeof completion.hasIssues !== 'boolean' ||
      typeof completion.issueNotes !== 'string' || completion.issueNotes.length > 4000 ||
      event?.id !== evidence.requestId || event.action !== 'complete' || event.state !== 'applied' || event.actorId !== completion.actorId ||
      instant(event.createdAt) !== instant(completion.completedAt) || event.toStatus !== 'completed' || event.body !== completion.notes ||
      !/^[a-f0-9]{64}$/.test(event.fingerprint || '') || !event.revision) {
    throw fail('W19_COMPLETION_UNVERIFIED', 'Save a verified field completion with its checklist, photos and work notes first.');
  }
  const ids = completion.evidencePhotoIds;
  if (!Array.isArray(ids) || !ids.length || ids.length > 100 || ids.some(id => !fieldRequestId(id)) || new Set(ids).size !== ids.length ||
      !Array.isArray(evidence.photoIds) || JSON.stringify([...ids].sort()) !== JSON.stringify([...evidence.photoIds].sort())) {
    throw fail('W19_COMPLETION_UNVERIFIED', 'The saved completion photo evidence needs operations review.');
  }
  const photos = fieldPhotos(job).filter(photo => ids.includes(photo.id));
  const verifiedJob = { ...job, status: 'in_progress', pipelineStatus: 'in_progress', fieldExecution: { ...job.fieldExecution, photos } };
  if (photos.length !== ids.length || fieldCompletionMissing(verifiedJob, completion).length) throw fail('W19_COMPLETION_UNVERIFIED', 'The saved closeout checklist or evidence needs operations review.');
  const facts = { jobId: job.id, requestId: evidence.requestId, completedAt: instant(completion.completedAt), completionActorId: completion.actorId,
    notes: completion.notes, hasIssues: completion.hasIssues, issueNotes: completion.issueNotes, eventFingerprint: event.fingerprint,
    photos: photos.map(({ id, fileId, category }) => ({ id, fileId, category })).sort((a, b) => a.id.localeCompare(b.id)),
    checklist: fieldChecklist(job).filter(item => item.required).map(({ id, stage, label, completed }) => ({ id, stage, label, completed })).sort((a, b) => a.id.localeCompare(b.id)) };
  return { ...facts, completedDate: denverDate(facts.completedAt), digest: await confirmationPayloadHash(facts) };
}

async function proofFor(store, job) {
  const id = job?.completionEvidence?.requestId;
  const event = fieldRequestId(id) ? await store.read(eventCollection(job.id), id) : null;
  return { proof: await w19CompletionProof(job, event), event };
}
const referenceFor = (env, proof) => purposeSign(env, PURPOSES.w19CompletionRef, JSON.stringify(['completion', proof.jobId, proof.requestId, W19_FORM_ID])).then(signature => `w19_${signature}`);
const businessKeyFor = proof => confirmationPayloadHash(['completion', proof.jobId, proof.requestId, W19_FORM_ID]);

async function businessBinding(store, proof, record = null) {
  const key = await businessKeyFor(proof), binding = await store.read(W19_COMPLETIONS, key);
  if (binding && (binding.id !== key || !binding.revision || !w19Reference(binding.reference) || binding.jobId !== proof.jobId || binding.completionRequestId !== proof.requestId || binding.formId !== W19_FORM_ID ||
      record && (binding.reference !== record.reference || record.businessKey !== key || binding.state !== record.state ||
        record.state === 'completion_verified' && (binding.submissionId !== record.submissionId || binding.claimedAt !== record.claimedAt)))) throw fail('W19_HANDOFF_STALE', 'The completion confirmation claim needs operations review.');
  if (record && !binding) throw fail('W19_HANDOFF_STALE', 'The completion confirmation claim is missing. Ask operations to review it.');
  return { key, binding };
}

function requireRecord(record, config, job, proof) {
  if (!record || record.formId !== W19_FORM_ID || record.jobId !== job.id || record.contactId !== job.highlevelContactId || record.locationId !== config.locationId ||
      record.completionRequestId !== proof.requestId || record.completionDigest !== proof.digest || record.completedAt !== proof.completedAt ||
      !w19Reference(record.reference) || record.id !== record.reference || !record.revision || !instant(record.issuedAt) || !instant(record.expiresAt) ||
      Date.parse(record.expiresAt) - Date.parse(record.issuedAt) !== TTL_MS || !['prepared', 'completion_verified', 'released_unconfirmed'].includes(record.state)) {
    throw fail('W19_HANDOFF_STALE', 'This confirmation no longer matches the saved job, contact or completion. Ask operations to review it.');
  }
  if (record.state === 'completion_verified') {
    if (!ID.test(record.submissionId || '') || !instant(record.submissionCreatedAt) || !instant(record.claimedAt) ||
        Date.parse(record.submissionCreatedAt) < Date.parse(record.issuedAt) || Date.parse(record.submissionCreatedAt) >= Date.parse(record.expiresAt) ||
        Date.parse(record.claimedAt) < Date.parse(record.submissionCreatedAt) || job.w19CompletionHandoff?.reference !== record.reference ||
        job.w19CompletionHandoff?.status !== record.state || job.w19CompletionHandoff?.submissionId !== record.submissionId || job.w19CompletionHandoff?.claimedAt !== record.claimedAt) {
      throw fail('W19_HANDOFF_STALE', 'The saved completion receipt metadata needs operations review. Do not resubmit the form.');
    }
    completionResult(record, { job, proof });
  }
}

export function w19HandoffView({ job, actor, config, proof = null, record = null, customerEmail = null, now }) {
  const expired = record && Date.parse(record.expiresAt) <= Date.parse(now);
  const released = record?.state === 'released_unconfirmed';
  const verified = record?.state === 'completion_verified';
  const status = !proof ? 'not_completed' : released ? 'released_unconfirmed' : verified ? 'completion_verified' : expired ? 'expired' : config.missing.length ? 'setup_required' : !customerEmail ? 'identity_required' : record ? 'prepared' : 'ready';
  const message = verified ? 'HighLevel completion submission is verified. The balance task is not enabled. Do not submit the form again.'
    : released ? 'HighLevel completion was verified. Cesar\'s task has not been confirmed; operations must reconcile it before any retry.'
    : expired ? 'This completion confirmation expired. Ask operations to reconcile any submission before preparing another.'
      : config.missing.length ? 'Operations is finishing the completion form connection. Your verified work is saved.'
        : record?.lastCheckMessage || (!customerEmail ? 'Operations must verify access and the customer email before this form can open. Your verified work is saved.'
          : 'Open the completion form for this saved job. Submitting the form does not record a payment.');
  return { ok: true, jobId: job.id, viewer: actor.user, expectedRevision: job.revision, eligible: Boolean(proof), status,
    completedAt: proof?.completedAt || null, completedDate: proof?.completedDate || null, missing: config.missing,
    associationMode: 'manual_email', customerEmail, message, canLaunch: Boolean(proof) && !expired && !released && !verified && !config.missing.length && Boolean(customerEmail) };
}

async function verifiedEmail(env, job, actor, customerEmail) {
  // Current field-job projections omit email and SDK job reads are business-only.
  // Reuse that existing entitlement; do not grant crew a new CRM field here.
  const email = normalizeEmail(job.email);
  if (!hasBusinessAccess(actor) || !email || !ID.test(job.highlevelContactId || '')) return null;
  const contact = await customerEmail(env, { contactId: job.highlevelContactId, locationId: w19Configuration(env).locationId });
  return contact.contactId === job.highlevelContactId && contact.locationId === w19Configuration(env).locationId && contact.email === email ? email : null;
}

export async function readW19Handoff(env, store, job, actor, now, { customerEmail = readW19CustomerEmail } = {}) {
  let proof;
  try { ({ proof } = await proofFor(store, job)); }
  catch (error) { if (error.code !== 'W19_COMPLETION_UNVERIFIED') throw error; return w19HandoffView({ job, actor, config: w19Configuration(env), now }); }
  const config = w19Configuration(env), { binding } = await businessBinding(store, proof);
  const record = binding ? await store.read(W19_HANDOFFS, binding.reference) : null;
  if (binding && !record) throw fail('W19_HANDOFF_STALE', 'The completion confirmation receipt needs operations review.');
  if (record) {
    requireRecord(record, config, job, proof);
    await businessBinding(store, proof, record);
    if (assignmentKey(record.confirmingLeadId) !== assignmentKey(actor.user)) throw fail('W19_LEAD_CHANGED', 'The original confirming lead must reconcile this completion with operations.', 403);
  }
  let email = null;
  if (!config.missing.length && (!record || Date.parse(record.expiresAt) > Date.parse(now)) && !['completion_verified', 'released_unconfirmed'].includes(record?.state)) {
    email = await verifiedEmail(env, job, actor, customerEmail).catch(() => null);
    const current = await store.read('jobs', job.id);
    if (!current || current.revision !== job.revision || !await w19AssignedLead(env, actor, current)) throw fail('W19_HANDOFF_STALE', 'The job changed. Refresh its completion confirmation.');
  }
  return w19HandoffView({ job, actor, config, proof, record, customerEmail: email, now });
}

export async function prepareW19Handoff(env, store, job, actor, input, now, { customerEmail = readW19CustomerEmail } = {}) {
  const config = w19Configuration(env);
  if (config.missing.length) throw fail('W19_SETUP_REQUIRED', 'The native completion form connection is awaiting verified setup.', 503);
  if (!ID.test(job.highlevelContactId || '')) throw fail('W19_CONTACT_REQUIRED', 'Operations must link this job to its exact HighLevel contact first.');
  if (!await w19AssignedLead(env, actor, job)) throw fail('W19_LEAD_REQUIRED', 'Only the currently assigned job lead can confirm completion.', 403);
  const { proof, event } = await proofFor(store, job), { key: businessKey, binding } = await businessBinding(store, proof);
  let reference = binding?.reference || await referenceFor(env, proof);
  let record = binding ? await store.read(W19_HANDOFFS, reference) : null, alreadyPrepared = Boolean(record);
  if (binding && !record) throw fail('W19_HANDOFF_STALE', 'The completion confirmation receipt needs operations review.');
  if (!record) {
    const email = await verifiedEmail(env, job, actor, customerEmail).catch(() => null);
    if (!email) throw fail('W19_CUSTOMER_EMAIL_REQUIRED', 'Operations must verify access and the exact customer email before opening this form.');
    if (job.revision !== input.expectedRevision) throw fail('W19_REVISION_CONFLICT', 'The job changed. Refresh its saved completion before opening the form.');
    record = { reference, businessKey, formId: W19_FORM_ID, jobId: job.id, completionRequestId: proof.requestId, completionDigest: proof.digest,
      completedAt: proof.completedAt, completedDate: proof.completedDate, completionActorId: proof.completionActorId, contactId: job.highlevelContactId, locationId: config.locationId, opportunityId: job.highlevelOpportunityId || '',
      confirmingLeadId: actor.user, leadSource: actor.source === 'employee-account' ? actor.source : 'configured', leadSessionVersion: actor.source === 'employee-account' ? String(actor.sessionVersion || '') : '',
      issuedAt: now, expiresAt: new Date(Date.parse(now) + TTL_MS).toISOString(), state: 'prepared', prepareRequestId: input.requestId };
    try {
      await store.commit([
        { collection: eventCollection(job.id), id: event.id, revision: event.revision, verify: true },
        { collection: 'jobs', id: job.id, revision: job.revision, patch: { w19CompletionHandoff: { reference, status: 'prepared', preparedAt: now } } },
        { collection: W19_HANDOFFS, id: reference, patch: record },
        { collection: W19_COMPLETIONS, id: businessKey, patch: { reference, jobId: job.id, completionRequestId: proof.requestId, formId: W19_FORM_ID, state: 'prepared', preparedAt: now } },
      ]);
    } catch (error) {
      // A committed intent is reused even when its response was lost. This is
      // a local record only: no native form submission is ever sent here.
      const savedBinding = await store.read(W19_COMPLETIONS, businessKey).catch(() => null);
      const saved = savedBinding && w19Reference(savedBinding.reference) ? await store.read(W19_HANDOFFS, savedBinding.reference).catch(() => null) : null;
      if (!saved) throw error;
      record = saved; reference = saved.reference; alreadyPrepared = true;
    }
    record = await store.read(W19_HANDOFFS, reference);
  }
  // Re-read everything after the commit, including assignment and contact.
  let current = await store.read('jobs', job.id), currentProof = (await proofFor(store, current)).proof;
  requireRecord(record, config, current, currentProof);
  await businessBinding(store, currentProof, record);
  if (!await w19AssignedLead(env, actor, current) || assignmentKey(record.confirmingLeadId) !== assignmentKey(actor.user)) throw fail('W19_LEAD_CHANGED', 'The assigned lead changed. Ask operations to reconcile this completion.', 403);
  const email = ['completion_verified', 'released_unconfirmed'].includes(record.state) ? null : await verifiedEmail(env, current, actor, customerEmail).catch(() => null);
  const checked = await store.read('jobs', job.id);
  if (!checked || checked.revision !== current.revision || !await w19AssignedLead(env, actor, checked)) throw fail('W19_HANDOFF_STALE', 'The job changed. Refresh its completion confirmation.');
  const view = w19HandoffView({ job: current, actor, config, proof: currentProof, record, customerEmail: email, now });
  if (!view.canLaunch) return { ...view, alreadyPrepared };
  const url = new URL(config.formUrl);
  for (const [key, value] of Object.entries({ jobId: current.id, reference })) url.searchParams.set(config.queryKeys[key], value);
  return { ...view, alreadyPrepared, launchUrl: url.href };
}

/** Only reconciled, job-scoped money is released to W19. This reads the
 * existing ledger; it never records payments or issues/sends an invoice.
 */
export function w19Balance(job) {
  const approval = job.customerApproval || {}, estimate = job.estimate || {};
  const approvalStatus = String(approval.status || estimate.status || job.quoteStatus || '').toLowerCase();
  if (!['approved', 'accepted'].includes(approvalStatus) || approval.supersededAt ||
      approval.estimateFingerprint && approval.estimateFingerprint !== estimateFingerprint(estimate) ||
      approval.estimateRevision !== undefined && approval.estimateRevision !== null && approval.estimateRevision !== estimate.revision) {
    throw fail('W19_MONEY_REVIEW_REQUIRED', 'Operations must verify the current approved quote before the balance task.');
  }
  const totals = customerMoneyTotals(job, { unified: true }), ledger = paymentLedger(job);
  // Current legacy approvals may lack a fingerprint, but must still carry
  // their own date and exact agreed base amount. A saved conflict is never
  // silently replaced with the latest estimate's value.
  const decision = approval.status ? approval : estimate;
  if (!instant(decision.approvedAt || decision.acceptedAt) || moneyCents(decision.amount) !== totals.quoteCents ||
      !totals.complete || !ledger.complete || ledger.entries.some(row => row.verified !== true) ||
      ![totals.totalCents, totals.appliedCents, totals.balanceCents].every(value => Number.isSafeInteger(value) && value >= 0)) {
    throw fail('W19_MONEY_REVIEW_REQUIRED', 'Operations must reconcile the job\'s confirmed payments before the balance task.');
  }
  return { approvedTotalCents: totals.totalCents, confirmedAppliedCents: totals.appliedCents, balanceDueCents: totals.balanceCents, currency: 'USD' };
}

function completionResult(record, { job, proof }, proceed = false, reason) {
  if (record.state === 'released_unconfirmed') return { ok: true, proceed: false, status: 'released_unconfirmed', taskStatus: 'unknown',
    completion: { verified: false, proceed: false, status: 'legacy_release_unconfirmed' }, ...(reason ? { reason } : {}) };
  const snapshot = record.completionSnapshot;
  const expected = { jobId: job.id, contactId: record.contactId, completedAt: proof.completedAt, completedDate: proof.completedDate,
    completionActorId: proof.completionActorId, confirmingLeadId: record.confirmingLeadId, verifiedWorkNotes: proof.notes, hasIssues: proof.hasIssues, verifiedIssueNotes: proof.issueNotes };
  if (!plain(snapshot) || Object.keys(snapshot).length !== Object.keys(expected).length + 1 ||
      Object.keys(expected).some(key => snapshot[key] !== expected[key]) || !(snapshot.opportunityId === null || typeof snapshot.opportunityId === 'string' && ID.test(snapshot.opportunityId))) {
    throw fail('W19_SNAPSHOT_REVIEW_REQUIRED', 'The saved completion snapshot needs operations review. Do not resubmit the form.');
  }
  const savedOpportunity = record.opportunitySnapshot;
  const opportunityVerified = savedOpportunity?.status === 'verified' && ID.test(savedOpportunity.id || '') && savedOpportunity.id === snapshot.opportunityId;
  const opportunity = { status: opportunityVerified ? 'verified' : ['missing', 'review_required', 'not_checked'].includes(savedOpportunity?.status) ? savedOpportunity.status : 'review_required', canUpdate: false, id: opportunityVerified ? savedOpportunity.id : null };
  const savedBalance = record.balanceSnapshot;
  const balanceValid = record.financialSnapshot?.status === 'ready' && plain(savedBalance) && savedBalance.currency === 'USD' &&
    ['approvedTotalCents', 'confirmedAppliedCents', 'balanceDueCents'].every(key => Number.isSafeInteger(savedBalance[key]) && savedBalance[key] >= 0) &&
    savedBalance.balanceDueCents === Math.max(0, savedBalance.approvedTotalCents - savedBalance.confirmedAppliedCents);
  const balance = balanceValid ? { approvedTotalCents: savedBalance.approvedTotalCents, confirmedAppliedCents: savedBalance.confirmedAppliedCents, balanceDueCents: savedBalance.balanceDueCents, currency: 'USD' } : null;
  const financial = { status: balanceValid ? 'ready' : record.financialSnapshot?.status === 'not_checked' ? 'not_checked' : 'review_required' };
  return { ...expected, opportunityId: opportunity.id, opportunity, financial, balance,
    ok: true, proceed: false, status: 'completion_verified', taskStatus: 'not_enabled',
    completion: { verified: true, proceed: proceed === true, status: 'verified' }, ...(reason ? { reason } : {}) };
}

export async function consumeW19Handoff(env, store, input, now, { submission = readW19Submission, opportunity = readW19Opportunity, lead = w19CurrentLead, clock = () => now } = {}) {
  const config = w19Configuration(env);
  if (config.missing.length) throw fail('W19_SETUP_REQUIRED', 'Completion verification is awaiting verified form and workflow setup.', 503);
  if (!w19Reference(input.reference) || typeof input.contactId !== 'string' || !ID.test(input.contactId) || input.submissionId !== undefined && (typeof input.submissionId !== 'string' || !ID.test(input.submissionId))) throw fail('W19_REQUEST_INVALID', 'Choose a valid completion reference and exact workflow contact.', 400);
  let record = await store.read(W19_HANDOFFS, input.reference);
  if (!record) throw fail('W19_REFERENCE_INVALID', 'The completion confirmation is unavailable.', 404);
  if (input.contactId !== record.contactId) throw fail('W19_CONTACT_MISMATCH', 'The workflow contact does not match the saved job confirmation.');
  const check = async () => {
    const job = await store.read('jobs', record.jobId), { proof, event } = await proofFor(store, job);
    requireRecord(record, config, job, proof);
    const { binding } = await businessBinding(store, proof, record);
    if (record.state === 'completion_verified') {
      const submissionKey = await confirmationPayloadHash([record.locationId, W19_FORM_ID, record.submissionId]);
      const claim = await store.read(W19_SUBMISSIONS, submissionKey);
      if (!claim?.revision || claim.reference !== record.reference || claim.jobId !== record.jobId || claim.submissionId !== record.submissionId ||
          claim.formId !== W19_FORM_ID || claim.locationId !== record.locationId || claim.claimedAt !== record.claimedAt) {
        throw fail('W19_HANDOFF_STALE', 'The saved native submission claim needs operations review. Do not resubmit the form.');
      }
    }
    const actor = await lead(env, record);
    if (!await w19AssignedLead(env, actor, job)) throw fail('W19_LEAD_CHANGED', 'The confirming lead is no longer authorized for this job.', 403);
    if (record.state === 'prepared' && Date.parse(record.expiresAt) <= Date.parse(clock())) throw fail('W19_REFERENCE_EXPIRED', 'This confirmation expired. Operations must reconcile it before any retry.');
    return { job, proof, event, binding };
  };
  // The handoff record and its completion binding are separate reads, so a concurrent claim can commit between them and
  // leave the binding ahead of the record read here. Only when the record itself has changed since is it read again and
  // checked once more; an unchanged record, or one still inconsistent after the re-read, stays a stale claim.
  const settled = async () => {
    try { return await check(); } catch (error) {
      if (error.code !== 'W19_HANDOFF_STALE') throw error;
      const fresh = await store.read(W19_HANDOFFS, input.reference);
      if (!fresh?.revision || fresh.revision === record.revision) throw error;
      record = fresh;
      return check();
    }
  };
  const initial = await settled();
  if (record.state !== 'prepared') return completionResult(record, initial, false, 'already_claimed');
  let receipt;
  try {
    receipt = await submission(env, { ...input, jobId: record.jobId, contactId: record.contactId, locationId: record.locationId, issuedAt: record.issuedAt, expiresAt: record.expiresAt, fieldIds: config.fieldIds });
  } catch (error) {
    if (['w19-provider-unavailable', 'w19-submission-pending'].includes(error.code)) {
      // Read failures stay visible and retryable, without consuming the gate.
      await store.commit([{ collection: W19_HANDOFFS, id: record.id, revision: record.revision, patch: { lastCheckedAt: now, lastCheckCode: error.code, lastCheckMessage: 'The native submission or routing has not been verified. Check confirmation status; do not submit the form again.' } }]).catch(() => null);
    }
    throw error;
  }
  // Financial/opportunity readiness is advisory and cannot prevent recording a
  // verified completion. It never authorizes a stage, task, invoice or payment.
  let balance = null, financial = { status: 'review_required' }, linkedOpportunity = null;
  let opportunityStatus = 'missing';
  const readinessJob = await store.read('jobs', record.jobId);
  try { balance = w19Balance(readinessJob); financial = { status: 'ready' }; } catch { /* No zero fallback for unresolved money. */ }
  if (readinessJob?.highlevelOpportunityId) {
    opportunityStatus = 'review_required';
    if (ID.test(readinessJob.highlevelOpportunityId)) {
      try {
        const found = await opportunity(env, { opportunityId: readinessJob.highlevelOpportunityId, contactId: record.contactId, locationId: record.locationId });
        if (found?.id === readinessJob.highlevelOpportunityId && found.contactId === record.contactId && found.locationId === record.locationId) {
          linkedOpportunity = found; opportunityStatus = 'verified';
        }
      } catch { /* Optional CRM readiness cannot consume or block completion. */ }
    }
  }
  // Provider reads can take time: canonical state/assignment must still match
  // at the atomic claim, and both the completion and receipt are fenced.
  record = await store.read(W19_HANDOFFS, input.reference);
  const { job, proof, event, binding: completionBinding } = await settled();
  if (record.state !== 'prepared') return completionResult(record, { job, proof }, false, 'already_claimed');
  if (!plain(receipt) || receipt.reference !== record.reference || receipt.jobId !== job.id || receipt.contactId !== record.contactId || receipt.locationId !== record.locationId || receipt.formId !== W19_FORM_ID ||
      !ID.test(receipt.submissionId || '') || !instant(receipt.createdAt) || Date.parse(receipt.createdAt) < Date.parse(record.issuedAt) || Date.parse(receipt.createdAt) >= Date.parse(record.expiresAt) ||
      Date.parse(receipt.createdAt) > Date.parse(now) || input.submissionId !== undefined && receipt.submissionId !== input.submissionId) throw fail('W19_RECEIPT_INVALID', 'The native completion receipt could not be verified.');
  // If readiness changed during provider reads, discard it rather than attach
  // stale financial/opportunity data to the current canonical completion.
  if (readinessJob?.revision !== job.revision) { balance = null; financial = { status: 'not_checked' }; linkedOpportunity = null; opportunityStatus = 'not_checked'; }
  const submissionKey = await confirmationPayloadHash([record.locationId, W19_FORM_ID, receipt.submissionId]);
  const opportunitySnapshot = { status: opportunityStatus, canUpdate: false, id: linkedOpportunity?.id || null };
  const completionSnapshot = { jobId: job.id, contactId: record.contactId, opportunityId: linkedOpportunity?.id || null,
    completedAt: proof.completedAt, completedDate: proof.completedDate, completionActorId: proof.completionActorId, confirmingLeadId: record.confirmingLeadId,
    verifiedWorkNotes: proof.notes, hasIssues: proof.hasIssues, verifiedIssueNotes: proof.issueNotes };
  try {
    await store.commit([
      { collection: eventCollection(job.id), id: event.id, revision: event.revision, verify: true },
      { collection: 'jobs', id: job.id, revision: job.revision, patch: { w19CompletionHandoff: { reference: record.reference, status: 'completion_verified', submissionId: receipt.submissionId, claimedAt: now } } },
      { collection: W19_HANDOFFS, id: record.id, revision: record.revision, patch: { state: 'completion_verified', submissionId: receipt.submissionId, submissionCreatedAt: receipt.createdAt, claimedAt: now, completionSnapshot, balanceSnapshot: balance, financialSnapshot: financial, opportunitySnapshot, taskStatus: 'not_enabled' } },
      { collection: W19_COMPLETIONS, id: completionBinding.id, revision: completionBinding.revision, patch: { state: 'completion_verified', submissionId: receipt.submissionId, claimedAt: now } },
      { collection: W19_SUBMISSIONS, id: submissionKey, patch: { reference: record.reference, jobId: job.id, submissionId: receipt.submissionId, formId: W19_FORM_ID, locationId: record.locationId, claimedAt: now } },
    ]);
  } catch (error) {
    // Even if the claim landed, a lost response never reissues permission to
    // create a task. A repeated native submission also cannot release it.
    const saved = await store.read(W19_HANDOFFS, record.id).catch(() => null);
    if (['completion_verified', 'released_unconfirmed'].includes(saved?.state)) {
      record = saved;
      const current = await settled();
      return completionResult(record, current, false, 'claim_response_unconfirmed');
    }
    throw error;
  }
  // The legacy top-level proceed remains false: it previously released a task.
  // Only the first confirmed canonical claim permits completion-only mapping.
  return completionResult({ ...record, state: 'completion_verified', completionSnapshot, balanceSnapshot: balance, financialSnapshot: financial, opportunitySnapshot }, { job, proof }, true);
}
