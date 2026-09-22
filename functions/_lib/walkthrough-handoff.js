import { mutateDispatch, requireDispatcher } from './dispatch-service.js';
import { assignmentKey, jobCrewNames } from './job-assignment.js';
import { localInstant } from './operations-portal-records.js';

const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const safeId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,180}$/.test(value) && !/^(secure_|_egc_)/.test(value);
const requestId = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const fail = (code, message, status = 409) => Object.assign(new Error(message), { code: `handoff_${code}`, status });
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : plain(value) ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value);
const hash = async value => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical(value))))].map(byte => byte.toString(16).padStart(2, '0')).join('');
const phone = value => String(value || '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
const email = value => String(value || '').trim().toLowerCase();
const state = job => String(job?.pipelineStatus || job?.status || '').toLowerCase();
const operational = job => job && !job.recordType && ['job', 'cleanout', 'reorg'].includes(job.type);
const customerProjection = row => row ? Object.fromEntries(['id', 'name', 'phone', 'email', 'address', 'highlevelContactId'].map(key => [key, row[key] || ''])) : null;

function text(value, label, max = 4000, required = false) {
  if (typeof value !== 'string' || value.length > max || required && !value.trim()) throw fail('invalid_plan', `${label} is missing or too long.`, 400);
  return value.trim();
}
function cents(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1000000 || Math.abs(value * 100 - Math.round(value * 100)) > 0.00001) throw fail('invalid_amount', `${label} must be an agreed amount in dollars and cents.`, 400);
  return Math.round(value * 100);
}
function descriptiveData(value, depth = 0) {
  if (depth > 6) throw fail('invalid_plan', 'The scope is too deeply nested.', 400);
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') return text(value, 'Scope text', 10000);
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value) && value.length <= 100) return value.map(item => descriptiveData(item, depth + 1));
  if (plain(value) && Object.keys(value).length <= 80 && !Object.keys(value).some(key => ['__proto__', 'constructor', 'prototype'].includes(key))) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, descriptiveData(item, depth + 1)]));
  throw fail('invalid_plan', 'The scope contains an unsupported value.', 400);
}
function checks(value) {
  if (!plain(value)) throw fail('invalid_checklist', 'The customer-specific crew checklist is required.', 400);
  const output = { version: '2026-09-client-v1' };
  for (const key of ['preJob', 'postJob']) {
    if (!Array.isArray(value[key]) || value[key].length > 80) throw fail('invalid_checklist', 'The crew checklist could not be verified.', 400);
    const ids = new Set();
    output[key] = value[key].map(item => {
      if (!plain(item) || typeof item.id !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(item.id) || ['__proto__', 'constructor', 'prototype'].includes(item.id) || ids.has(item.id)) throw fail('invalid_checklist', 'Every crew check needs its own valid identity.', 400);
      ids.add(item.id);
      return { id: item.id, label: text(item.label, 'Checklist label', 500, true), detail: text(item.detail || '', 'Checklist detail', 1000), critical: item.critical === true, required: true };
    });
  }
  return output;
}
export function normalizeHandoffPlan(input, now = new Date().toISOString()) {
  if (!plain(input) || !plain(input.client) || !plain(input.quote) || !plain(input.acceptance)) throw fail('invalid_plan', 'Review the complete walkthrough before saving.', 400);
  const quote = input.quote, acceptance = input.acceptance;
  const totalCents = cents(quote.total, 'Locked total'), depositCents = cents(quote.deposit, 'Deposit');
  if (totalCents <= 0 || depositCents !== Math.round(totalCents / 2)) throw fail('invalid_amount', 'The signed walkthrough must include the locked total and its 50% deposit.', 400);
  const signature = text(input.signature, 'Homeowner signature', 250000, true);
  if (input.terms_accepted !== true || acceptance.signature_captured !== true || acceptance.method !== 'in_person_signature' || !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(signature)) throw fail('acceptance_required', 'The homeowner must approve the scope and sign before an accepted job can be saved.', 400);
  const acceptedAt = text(acceptance.accepted_at, 'Original acceptance time', 40, true);
  if (!/(?:Z|[+-]\d{2}:\d{2})$/.test(acceptedAt) || !Number.isFinite(Date.parse(acceptedAt)) || Date.parse(acceptedAt) > Date.parse(now) + 300000) throw fail('acceptance_required', 'The original signature time could not be verified. Review and sign the scope again.', 400);
  const terms = text(input.terms_version, 'Terms version', 100, true);
  if (acceptance.terms_version !== terms) throw fail('acceptance_required', 'The accepted terms do not match this walkthrough.', 400);
  const date = text(quote.job_date, 'Job date', 10, true), start = text(quote.start_time, 'Start time', 5, true), end = text(quote.end_time, 'End time', 5, true);
  const startAt = localInstant(date, start), endAt = localInstant(date, end);
  if (!startAt || !endAt || endAt <= startAt) throw fail('invalid_schedule', 'Choose valid Denver start and end times. Missing or repeated daylight-saving hours require another time.', 400);
  const client = { name: text(input.client.name, 'Customer name', 200, true), phone: text(input.client.phone || '', 'Phone', 40), email: text(input.client.email || '', 'Email', 254), address: text(input.client.address, 'Service address', 500, true), highlevel_contact_id: text(input.client.highlevel_contact_id || '', 'Contact link', 180) };
  if (!phone(client.phone) && !email(client.email)) throw fail('customer_required', 'A customer phone or email is required.', 400);
  const logistics = descriptiveData(input.logistics || {}), scope = descriptiveData(input.scope || {}), discovery = descriptiveData(input.discovery || {});
  if (!plain(logistics) || !plain(scope) || !plain(discovery) || !Number.isInteger(logistics.crew_size) || logistics.crew_size < 1 || logistics.crew_size > 20) throw fail('invalid_plan', 'Choose the required crew size.', 400);
  const minutes = quote.estimated_duration_min;
  if (!Number.isInteger(minutes) || minutes < 15 || minutes > 1440) throw fail('invalid_plan', 'The estimated job duration is invalid.', 400);
  const before = input.photos?.before;
  if (!Number.isInteger(before) || before < 0 || before > 1000) throw fail('invalid_plan', 'The walkthrough photo count is invalid.', 400);
  return { client, quote: { title: text(quote.title || 'EGC Garage Service', 'Job title', 500, true), total: totalCents / 100, deposit: depositCents / 100, job_date: date, start_time: start, end_time: end, start_at: startAt, end_at: endAt, estimated_duration_min: minutes, expected_shift_hours: (minutes + 90) / 60, line_items: [{ name: 'Garage cleanout and reset', qty: 1, total: totalCents / 100 }], line_items_count: 1 }, discovery, scope, logistics, internal_notes: text(input.internal_notes, 'Job brief', 4900, true), client_checklists: checks(input.client_checklists), signature, acceptance: { accepted_at: new Date(acceptedAt).toISOString(), accepted_by: text(acceptance.accepted_by, 'Signer name', 200, true), method: 'in_person_signature', terms_version: terms, signature_captured: true }, terms_version: terms, terms_accepted: true, photos: { before }, notes: text(input.notes || '', 'Customer notes', 8000) };
}
function identityMatches(left, right) {
  const a = phone(left.phone), b = phone(right.phone), c = email(left.email), d = email(right.email);
  const p = left.highlevelContactId || left.highlevel_contact_id, q = right.highlevelContactId || right.highlevel_contact_id;
  if (a && b && a !== b || c && d && c !== d || p && q && p !== q) return false;
  return Boolean(p && p === q || a && a === b || c && c === d);
}
function requireRevision(row) {
  if (!safeId(row?.id) || typeof row.revision !== 'string' || !row.revision) throw fail('source_unavailable', 'A required customer or source record has no verifiable revision. Keep the form and retry.', 503);
}
export function handoffInstructions(plan, sourceId = '') {
  const s = plan.scope, l = plan.logistics, f = s.finish_details || {};
  return { customerGoal: String(plan.discovery.success || ''), whyNow: String(plan.discovery.why_now || ''), sortMethod: String(s.sort_method || ''), keepItems: String(s.keep_items || ''), removeItems: String(s.remove_items || ''), exclusions: String(s.exclusions || ''), hazards: Array.isArray(s.hazards) ? s.hazards : [], access: Array.isArray(s.access) ? s.access : [], accessNotes: String(l.notes || ''), truckPlacement: String(l.truck_placement || s.truck_placement || ''), specialItems: Array.isArray(s.special_items) ? s.special_items : [], finish: Array.isArray(s.finish) ? s.finish : [], shelving: { type: String(f.shelf_type || ''), qty: Number(f.shelf_qty || 0) }, totes: { qty: Number(f.tote_qty || 0) }, customerNotes: plan.notes, crewSize: l.crew_size, arrivalWindow: `${plan.quote.start_time}–${plan.quote.end_time}`, estimatedJobMinutes: plan.quote.estimated_duration_min, estimatedJobHours: plan.quote.estimated_duration_min / 60, expectedShiftHours: plan.quote.expected_shift_hours, photoCount: plan.photos.before, sourceWalkthroughId: sourceId };
}
function financePatch(plan, previous, jobId, actor, now) {
  const total = plan.quote.total, amount = plan.quote.deposit, prior = plain(previous?.deposit) ? previous.deposit : {};
  const paid = typeof prior.paidAmount === 'number' && Number.isFinite(prior.paidAmount) ? Math.max(0, prior.paidAmount) : 0;
  const patch = { total, priceQuoted: total, quoteStatus: 'approved', termsVersion: plan.terms_version,
    acceptance: { acceptedAt: plan.acceptance.accepted_at, acceptedBy: plan.acceptance.accepted_by, method: 'in_person_signature', termsVersion: plan.terms_version, signatureCaptured: true, signatureData: plan.signature, recordedBy: actor.user, recordedAt: now },
    customerApproval: { status: 'approved', approvedAt: plan.acceptance.accepted_at, approvedBy: plan.acceptance.accepted_by, amount: total, source: 'in_person_signature' },
    estimate: { number: previous?.estimate?.number || `EST-${jobId.slice(-6).toUpperCase()}`, revision: Number.isInteger(previous?.estimate?.revision) ? previous.estimate.revision + 1 : 1, status: 'accepted', amount: total, depositRequired: amount, acceptedAt: plan.acceptance.accepted_at, acceptedBy: plan.acceptance.accepted_by, acceptanceMethod: 'in_person_signature', termsVersion: plan.terms_version, createdAt: previous?.estimate?.createdAt || now, source: 'walkthrough' },
    deposit: { ...prior, amount, paidAmount: paid, status: paid >= amount ? 'paid' : paid > 0 ? 'partial' : 'due' } };
  const changed = previous && (previous.estimate?.amount !== total || previous.estimate?.depositRequired !== amount || canonical(previous.scope || {}) !== canonical(plan.scope));
  if (changed && previous.invoice?.amount && !['void', 'superseded'].includes(previous.invoice.status)) patch.invoice = { ...previous.invoice, status: 'superseded', supersededAt: now, supersededReason: 'walkthrough_revised' };
  return patch;
}

/** Resolve an already-saved handoff without changing history, customer identity,
 * money, or visit completion. Managers can safely resume after a lost response. */
export async function prepareHandoff(store, actor, query = {}) {
  requireDispatcher(actor);
  if (Object.keys(query).some(key => !['sourceWalkthroughId', 'jobId'].includes(key))) throw fail('invalid_request', 'The walkthrough lookup is invalid.', 400);
  for (const id of [query.sourceWalkthroughId, query.jobId].filter(Boolean)) if (!safeId(id)) throw fail('invalid_request', 'Choose a valid saved walkthrough or job.', 400);
  const source = query.sourceWalkthroughId ? await store.read('jobs', query.sourceWalkthroughId) : null;
  if (query.sourceWalkthroughId && (!source || source.type !== 'walkthrough' || source.recordType)) throw fail('source_missing', 'The source walkthrough could not be found.', 404);
  let job = query.jobId ? await store.read('jobs', query.jobId) : null;
  if (query.jobId && !job) throw fail('job_missing', 'The selected job no longer exists. Review its history rather than creating a replacement.', 404);
  if (job && !operational(job)) throw fail('job_mismatch', 'The selected record is not an operational job.');
  if (source) {
    const matches = (await store.jobs()).filter(row => operational(row) && row.sourceWalkthroughId === source.id);
    const ids = [...new Set([...matches.map(row => row.id), source.convertedJobId, job?.id].filter(Boolean))];
    if (ids.length > 1) throw fail('existing_jobs_ambiguous', 'More than one job is linked to this walkthrough. Review the existing jobs in Dispatch.');
    if (!job && ids.length) job = await store.read('jobs', ids[0]);
    if (ids.length && !job) throw fail('job_missing', 'The linked job cannot be verified. Review its history before creating more work.');
    if (job && (!operational(job) || job.sourceWalkthroughId !== source.id || source.customerId && job.customerId !== source.customerId)) throw fail('job_mismatch', 'The existing job and walkthrough do not share the same customer and source.');
  }
  const customerId = job?.customerId || source?.customerId || '';
  const customer = customerId ? await store.read('customers', customerId) : null;
  if (customerId && !customer) throw fail('customer_missing', 'The linked customer is unavailable. Repair the customer link before saving.');
  return { ok: true, authority: 'employee_hub', sourceWalkthroughId: source?.id || '', sourceRevision: source?.revision || '', jobId: job?.id || '', expectedRevision: job?.revision || '', customerId: customer?.id || '', customer: customerProjection(customer), roster: await store.roster() };
}

export async function saveWalkthroughHandoff(store, actor, input, now = new Date().toISOString()) {
  requireDispatcher(actor);
  if (!plain(input) || Object.keys(input).some(key => !['actorId', 'requestId', 'customerId', 'sourceWalkthroughId', 'sourceRevision', 'jobId', 'expectedRevision', 'plan'].includes(key)) || !requestId(input.requestId) || !safeId(input.customerId) || input.jobId && !safeId(input.jobId)) throw fail('invalid_request', 'The accepted walkthrough needs a stable request and customer identity.', 400);
  if (input.actorId && input.actorId !== actor.user) throw fail('actor_changed', 'The signed-in employee changed. Reopen the original account to recover this request.', 403);
  const plan = normalizeHandoffPlan(input.plan, now), fingerprint = await hash({ actor: actor.user, input }), receiptId = input.requestId.toLowerCase();
  async function replay() {
    const receipt = await store.read('walkthroughHandoffs', receiptId);
    if (!receipt) return null;
    if (receipt.fingerprint !== fingerprint || receipt.actorId !== actor.user) throw fail('idempotency_conflict', 'This save identity belongs to different walkthrough content. Recover the original request before changing it.');
    const saved = await store.read('jobs', receipt.jobId), customer = await store.read('customers', receipt.customerId);
    if (!saved || !customer || saved.customerId !== receipt.customerId || saved.sourceWalkthroughId !== receipt.sourceWalkthroughId || saved.handoffRequestId !== input.requestId || saved.handoffFingerprint !== fingerprint) throw fail('changed_since_save', 'The earlier save succeeded, but this job has since changed. Open its current record in Dispatch.');
    savedHandoffPayload(saved, input.requestId);
    return result(saved, true, receipt.warnings || []);
  }
  function result(saved, replayed, warnings) {
    return { ok: true, authority: 'employee_hub', requestId: input.requestId, replayed, job: { id: saved.id, revision: saved.revision, customerId: saved.customerId, projectId: saved.projectId, sourceWalkthroughId: saved.sourceWalkthroughId || '', date: saved.date, time: saved.time, endTime: saved.endTime, status: state(saved), assignedCrew: saved.assignedCrew || [], crewNeeded: saved.crewNeeded, highlevelContactId: saved.highlevelContactId || '', highlevelAppointmentId: saved.highlevelAppointmentId || '', highlevelOpportunityId: saved.highlevelOpportunityId || '', syncStatus: saved.syncStatus || 'pending' }, warnings, financialState: 'accepted_quote_not_payment', fieldJobUrl: `/crew/job.html?jobId=${encodeURIComponent(saved.id)}` };
  }
  const prior = await replay(); if (prior) return prior;
  const customer = await store.read('customers', input.customerId); requireRevision(customer);
  if (!identityMatches(plan.client, customer)) throw fail('customer_mismatch', 'The signed customer details do not match the selected customer. Review the phone, email and CRM link.');
  let source = null;
  if (input.sourceWalkthroughId) {
    if (!safeId(input.sourceWalkthroughId)) throw fail('invalid_source', 'Choose a valid walkthrough.');
    source = await store.read('jobs', input.sourceWalkthroughId); requireRevision(source);
    if (source.type !== 'walkthrough' || source.recordType || source.revision !== input.sourceRevision || ['cancelled', 'canceled', 'noshow', 'no_show'].includes(state(source))) throw fail('source_changed', 'The walkthrough changed or was cancelled. Refresh and review it before saving.');
    if (source.customerId ? source.customerId !== customer.id : !identityMatches(source, customer)) throw fail('source_mismatch', 'The source walkthrough must belong to the exact same customer.');
    if (source.highlevelContactId && customer.highlevelContactId && source.highlevelContactId !== customer.highlevelContactId) throw fail('source_mismatch', 'The source and customer point to different CRM contacts.');
  }
  const sourceProject = source?.projectId ? await store.read('projects', source.projectId) : null;
  if (sourceProject) { requireRevision(sourceProject); if (sourceProject.customerId !== customer.id) throw fail('source_mismatch', 'The source project belongs to a different customer.'); }
  else if (source?.projectId) throw fail('source_unavailable', 'The source project is missing. Review the walkthrough linkage.', 503);
  const previous = input.jobId ? await store.read('jobs', input.jobId) : null;
  if (input.jobId) {
    requireRevision(previous);
    if (!operational(previous) || previous.customerId !== customer.id || (previous.sourceWalkthroughId || '') !== (source?.id || '') || previous.revision !== input.expectedRevision) throw fail('job_changed', 'The existing job changed or belongs to a different walkthrough. Open its current record before revising it.');
    if (!['scheduled', 'unscheduled', 'draft'].includes(state(previous)) || previous.fieldLastActionAt || previous.fieldExecution && (Object.keys(previous.fieldExecution).some(key=>key!=='photos') || (previous.fieldExecution.photos || []).some(photo=>photo.category!=='walkthrough'))) throw fail('work_started', 'This job has already entered the field workflow. Use the explicit scope and finance revision tools rather than replacing its signed handoff.');
  }
  if (source?.convertedJobId && source.convertedJobId !== previous?.id) throw fail('existing_job', 'This walkthrough already has a saved job. Recover that job rather than creating another.');
  const roster = await store.roster(), assignedText = text(plan.logistics.assigned_to || '', 'Crew assignment', 500);
  let assignedCrew;
  if (!assignedText || /^crew of \d+$/i.test(assignedText)) assignedCrew = previous?.assignedCrew || [];
  else assignedCrew = jobCrewNames({ assignedTo: assignedText }).map(name => {
    const key = assignmentKey(name), exact = roster.filter(person => person.id === key), aliases = exact.length ? exact : roster.filter(person => assignmentKey(person.name) === key);
    if (aliases.length !== 1) throw fail('crew_unverified', 'A requested crew member is not a unique active employee. Use the exact employee name or leave assignment for Dispatch.');
    return aliases[0].id;
  });
  const instructions = handoffInstructions(plan, source?.id || '');
  const changes = { date: plan.quote.job_date, endDate: plan.quote.job_date, time: plan.quote.start_time, endTime: plan.quote.end_time, title: plan.quote.title, address: plan.client.address, serviceType: 'Garage transformation', crewNeeded: plan.logistics.crew_size, assignedCrew, jobInstructions: plan.internal_notes, accessInstructions: instructions.accessNotes, customerInstructions: plan.notes, notify: true };
  const dispatchInput = previous ? { action: 'schedule.update', requestId: input.requestId, jobId: previous.id, expectedRevision: previous.revision, changes } : { action: 'schedule.create', requestId: input.requestId, customerId: customer.id, kind: 'job', ...(source ? { sourceWalkthroughId: source.id } : {}), changes };
  const adapter = { ...store,
    read: async (collection, id) => {
      const row = await store.read(collection, id);
      // An orphan legacy walkthrough can acquire only the exact verified
      // customer link; the original revision is fenced in the atomic commit.
      return collection === 'jobs' && source?.id === id && row?.revision === source.revision && !row.customerId ? { ...row, customerId: customer.id } : row;
    },
    commit: async writes => {
      const target = writes.find(write => write.collection === 'jobs' && write.patch?.dispatchRequestId === input.requestId);
      if (!target) throw fail('commit_incomplete', 'The complete dispatch handoff could not be prepared.', 503);
      const providerPayload = { ...plan, signature: undefined, tool: 'game_plan', job_id: target.id, walkthrough_id: source?.id || '', idempotency_key: `walkthrough-handoff:${input.requestId}`, sent_at: now };
      delete providerPayload.signature;
      Object.assign(target.patch, financePatch(plan, previous, target.id, actor, now), { handoffVersion: 1, handoffRequestId: input.requestId, handoffFingerprint: fingerprint, acceptedHandoffPayload: providerPayload, sourceWalkthroughId: source?.id || '', customer: plan.client.name, phone: plan.client.phone, email: plan.client.email, scope: plan.scope, discovery: plan.discovery, logistics: plan.logistics, jobInstructions: instructions, internalNotes: plan.internal_notes, clientChecklists: plan.client_checklists, notes: plan.notes, customerNotesSummary: plan.notes || instructions.customerGoal, durationMin: (Date.parse(plan.quote.end_at) - Date.parse(plan.quote.start_at)) / 60000, estimatedDurationMin: plan.quote.estimated_duration_min, estimatedDurationHours: plan.quote.estimated_duration_min / 60, expectedShiftHours: plan.quote.expected_shift_hours, crewSize: plan.logistics.crew_size, photoCount: plan.photos.before, photoSyncStatus: previous?.photoSyncStatus || 'device_only', walkthroughSyncedAt: now, syncIdempotencyKey: providerPayload.idempotency_key, walkthroughAppointmentId: source?.highlevelAppointmentId || previous?.walkthroughAppointmentId || '', providerSyncOwner: 'operations', syncStatus: 'pending', customerPortalInvitationRequestedAt: previous?.customerPortalInvitationRequestedAt || now });
      function fence(collection, row, patch) {
        requireRevision(row);
        const found = writes.find(write => write.collection === collection && write.id === row.id);
        if (found) {
          if (found.revision !== row.revision) throw fail('source_changed', 'Customer or source evidence changed during save. Refresh and retry.');
          if (patch) { found.verify = false; found.patch = { ...found.patch, ...patch }; }
        } else writes.push({ collection, id: row.id, revision: row.revision, ...(patch ? { patch } : { verify: true }) });
      }
      fence('customers', customer);
      if (sourceProject) fence('projects', sourceProject);
      if (source) fence('jobs', source, { customerId: customer.id, convertedJobId: target.id, conversionStatus: 'job_scheduled', updatedAt: now });
      // Scheduling a sold job is not proof the source visit has completed.
      // Its original status, actual completion time, signature and money stay intact.
      const dispatchReceipt = writes.find(write => write.collection === 'dispatchOperations' && write.id === receiptId);
      writes.push({ collection: 'walkthroughHandoffs', id: receiptId, patch: { fingerprint, actorId: actor.user, customerId: customer.id, jobId: target.id, sourceWalkthroughId: source?.id || '', sourceRevision: source?.revision || '', originalJobRevision: previous?.revision || '', acceptedAt: plan.acceptance.accepted_at, amountCents: Math.round(plan.quote.total * 100), signature: plan.signature, plan: providerPayload, priorEstimate: previous?.estimate || null, priorAcceptance: previous?.acceptance || null, createdAt: now, warnings: dispatchReceipt?.patch?.warnings || [] } });
      await store.commit(writes);
    },
  };
  try { await mutateDispatch(adapter, actor, dispatchInput, now); }
  catch (error) { const recovered = await replay(); if (recovered) return recovered; throw error; }
  const saved = await replay();
  if (!saved) throw fail('outcome_unknown', 'The save could not be read back. Retry the identical request; do not create a second job.', 503);
  return { ...saved, replayed: false };
}

/** Provider synchronization reads the saved signed snapshot, never an incoming
 * browser price, provider appointment, or claim that work/payment completed. */
export function savedHandoffPayload(job, handoffRequestId) {
  const p = job?.acceptedHandoffPayload;
  if (job?.handoffVersion !== 1 || !p || job.handoffRequestId !== handoffRequestId || !['accepted', 'approved'].includes(job.estimate?.status) || job.estimate.amount !== p.quote.total || job.estimate.depositRequired !== p.quote.deposit || job.acceptance?.acceptedAt !== p.acceptance.accepted_at || canonical(job.scope || {}) !== canonical(p.scope || {}) || ['cancelled','canceled','completed','paid','invoiced','closed'].includes(state(job))) throw fail('sync_snapshot_changed', 'The signed handoff changed. Review the current saved job before synchronizing it.');
  const start = localInstant(job.date, job.time), end = localInstant(job.endDate || job.date, job.endTime);
  if (!start || !end || end <= start) throw fail('invalid_schedule', 'The current Hub schedule needs review before CRM synchronization.');
  return { ...p, job_id: job.id, idempotency_key: job.syncIdempotencyKey, opportunity_id: job.highlevelOpportunityId || '', client: { ...p.client, highlevel_contact_id: job.highlevelContactId || p.client.highlevel_contact_id || '', highlevel_job_appointment_id: job.highlevelAppointmentId || '', highlevel_appointment_id: job.walkthroughAppointmentId || '' }, quote: { ...p.quote, job_date: job.date, start_time: job.time, end_time: job.endTime, start_at: start, end_at: end }, walkthrough_id: job.sourceWalkthroughId || '' };
}
