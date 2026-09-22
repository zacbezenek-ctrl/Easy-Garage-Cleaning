import { jobCrewNames } from './job-assignment.js';
import { advanceFieldTime, fieldJobTime } from './field-execution-time.js';

export const fieldFailure = (message, status = 400, code = 'FIELD_REQUEST_INVALID', details = {}) => Object.assign(new Error(message), { status, code, ...details });
export const fieldId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,180}$/.test(value) && !/^(_egc_|secure_)/.test(value);
export const fieldRequestId = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
export const fieldText = (value, max = 4000) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const list = value => Array.isArray(value) ? value : [];
const textList = value => (Array.isArray(value) ? value : typeof value === 'string' ? [value] : []).map(item => fieldText(item, 500)).filter(Boolean).slice(0, 100);
const description = value => Array.isArray(value) ? textList(value).join('\n').slice(0, 4000) : fieldText(value);
const checklistId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(value) && !['__proto__', 'constructor', 'prototype'].includes(value);
export const fieldStage = job => fieldText(job.pipelineStatus || job.status || 'scheduled', 40).toLowerCase();
const closed = job => ['completed', 'invoiced', 'paid', 'review_requested', 'cancelled'].includes(fieldStage(job));
export function fieldActivity(job) {
  const stage = fieldStage(job), activity = job.fieldExecution?.activity;
  if (activity === stage) return stage;
  if (activity === 'paused' && stage === 'in_progress' || activity === 'waiting' && ['arrived', 'in_progress'].includes(stage) || activity === 'delayed' && ['dispatched', 'in_progress'].includes(stage)) return activity;
  return stage;
}
export const FIELD_CHECKLIST_DEFAULTS = [
  { id: 'departure-address', stage: 'departure', label: 'Confirm the address, crew, truck and arrival time', required: true },
  { id: 'departure-equipment', stage: 'departure', label: 'Confirm tools, supplies and dump capacity are ready', required: true },
  { id: 'arrival-scope', stage: 'arrival', label: 'Walk the job with the customer and confirm scope', required: true },
  { id: 'arrival-protection', stage: 'arrival', label: 'Identify existing damage, hazards and items to keep', required: true },
  { id: 'work-scope', stage: 'work', label: 'Complete the agreed services and record any changes', required: true },
  { id: 'finish-cleanup', stage: 'finish', label: 'Remove debris and leave the work area clean', required: true },
  { id: 'finish-walkthrough', stage: 'finish', label: 'Complete the customer walkthrough or document remote approval', required: true },
  { id: 'finish-equipment', stage: 'finish', label: 'Check tools, equipment and customer belongings before leaving', required: true },
];

export function fieldChecklist(job) {
  const configured = job.fieldExecution?.checklistTemplate;
  // Older imported instructions are not guaranteed to have been written through
  // the current validator. Preserve meaningful tasks without letting one bad
  // entry break the entire crew workday or collapse two tasks into one check.
  const normalize = (item, index) => ({ id: checklistId(item?.id) && !item.id.startsWith('client-') ? item.id : `task-${index}`, stage: ['departure', 'arrival', 'work', 'finish'].includes(item?.stage) ? item.stage : 'work', label: fieldText(typeof item === 'string' ? item : item?.label || item?.title, 500), detail: fieldText(item?.detail, 1000), required: item?.required !== false });
  const custom = list(configured).slice(0, 80).map(normalize).filter(item => item.label);
  const entries = custom.length ? custom : FIELD_CHECKLIST_DEFAULTS.map(normalize);
  for (const [key, stage] of [['preJob', 'arrival'], ['postJob', 'finish']]) {
    list(job.clientChecklists?.[key]).slice(0, 80).forEach((item, index) => {
      const label = fieldText(typeof item === 'string' ? item : item?.label || item?.title, 500);
      if (label) entries.push({ id: `client-${key}-${checklistId(item?.id) ? item.id : index}`, stage, label, detail: fieldText(item?.detail, 1000), required: item?.required !== false });
    });
  }
  const used = new Set();
  return entries.map(item => {
    const baseId = item.id; let suffix = 1;
    while (used.has(item.id)) item = { ...item, id: `${baseId}-duplicate-${suffix++}` };
    used.add(item.id);
    const check = job.fieldExecution?.checks?.[item.id];
    return { ...item, completed: check?.completed === true, completedAt: check?.at || null, completedBy: check?.actorName || check?.actorId || null };
  });
}

export function fieldMaterials(job) {
  return list(job.materials || job.requiredMaterials).slice(0, 100).map((item, index) => {
    const id = fieldText(item?.id, 100) || `material-${index}`;
    const state = job.fieldExecution?.materialStates?.[id];
    return { id, name: fieldText(typeof item === 'string' ? item : item?.name, 200), quantity: typeof item?.quantity === 'number' && Number.isFinite(item.quantity) ? item.quantity : null, state: ['required', 'loaded', 'used', 'missing'].includes(state?.state) ? state.state : 'required', updatedAt: state?.at || null, updatedBy: state?.actorName || state?.actorId || null };
  }).filter(item => item.name);
}

export function fieldPhotos(job) {
  return list(job.fieldExecution?.photos).filter(photo => photo?.verified === true && fieldRequestId(photo.id) && /^[A-Za-z0-9_-]{1,200}$/.test(photo.fileId || ''));
}

export function fieldCompletionMissing(job, input = {}) {
  const photos = fieldPhotos(job), missing = [];
  if (fieldStage(job) !== 'in_progress') missing.push('Start the job before completing it.');
  fieldChecklist(job).filter(item => item.required && !item.completed).forEach(item => missing.push(`Checklist: ${item.label}`));
  if (!photos.some(photo => photo.category === 'before')) missing.push('Upload at least one before photo.');
  if (!photos.some(photo => photo.category === 'after')) missing.push('Upload at least one after photo.');
  if (fieldText(input.notes ?? job.fieldExecution?.completion?.notes).length < 10) missing.push('Add completion notes describing the work performed (at least 10 characters).');
  if (input.hasIssues === true && fieldText(input.issueNotes).length < 10) missing.push('Describe the issue or damage and the follow-up needed (at least 10 characters).');
  const missingMaterials = fieldMaterials(job).filter(item => item.state === 'missing');
  if (missingMaterials.length && input.hasIssues !== true) missing.push(`Document the missing materials as an issue: ${missingMaterials.map(item => item.name).join(', ')}.`);
  return missing;
}

export function fieldEventProjection(event, manager = false) {
  if (!event || event.state !== 'applied' || (event.visibility === 'management' && !manager)) return null;
  return { id: event.id, action: event.action, createdAt: event.createdAt, actorId: event.actorId, actorName: event.actorName, body: fieldText(event.body, 4000), summary: fieldText(event.summary, 1000), visibility: event.visibility === 'management' ? 'management' : 'crew', ...(event.photoId ? { photoId: event.photoId } : {}) };
}

export function fieldAttention(job, manager = false) {
  const issue = job.fieldExecution?.attention;
  if (!issue || !manager && issue.visibility !== 'crew') return null;
  return { id: issue.requestId || `${issue.at || ''}:${issue.actorId || ''}`, status: issue.status === 'resolved' ? 'resolved' : 'open', reason: fieldText(issue.reason), reportedAt: issue.at || null, reportedBy: fieldText(issue.actorName || issue.actorId, 200), visibility: issue.visibility === 'crew' ? 'crew' : 'management', resolvedAt: issue.resolvedAt || null, resolvedBy: fieldText(issue.resolvedByName || issue.resolvedBy, 200), resolution: fieldText(issue.resolution), canResolve: manager && issue.status !== 'resolved' };
}

export function fieldJobProjection(job, events = [], options = {}) {
  const instructions = job.jobInstructions && typeof job.jobInstructions === 'object' ? job.jobInstructions : job.instructions && typeof job.instructions === 'object' ? job.instructions : {}, scope = job.scope || {}, logistics = job.logistics || {};
  const instructionText = typeof job.jobInstructions === 'string' ? job.jobInstructions : typeof job.instructions === 'string' ? job.instructions : '';
  const state = job.fieldExecution || {}, stage = fieldStage(job), frozen = closed(job);
  const crewNames = options.crewNames || {};
  return {
    id: job.id, expectedRevision: job.__updateTime || job.revision || '', type: 'job',
    customer: fieldText(job.customer, 200), phone: fieldText(job.phone, 100), address: fieldText(job.address, 1000),
    date: fieldText(job.date, 10), time: fieldText(job.time, 8), endDate: fieldText(job.endDate || job.date, 10), endTime: fieldText(job.endTime, 8),
    startAt: fieldText(job.startAt, 40), endAt: fieldText(job.endAt, 40), arrivalWindow: fieldText(job.arrivalWindow || instructions.arrivalWindow, 200),
    status: stage, fieldStatus: fieldActivity(job), statusReason: fieldActivity(job) !== stage ? fieldText(state.activityReason, 1000) : '', serviceType: fieldText(job.serviceType, 300),
    assignedCrew: jobCrewNames(job), crewMembers: jobCrewNames(job).map(id => ({ id, name: crewNames[id.toLowerCase()] || id })),
    crewLead: fieldText(job.crewLead, 120), crewId: fieldText(job.crewId, 180), crewName: fieldText(options.crewName || job.crewName, 150),
    vehicleId: fieldText(job.vehicleId, 180), vehicleName: fieldText(options.vehicleName || job.vehicleName, 150),
    crewNeeded: Number(job.crewNeeded || job.requiredCrewSize || job.crewSize || 1),
    scope: fieldText(typeof job.operationalScope?.text === 'string' ? job.operationalScope.text : instructionText || instructions.operationalScope || (typeof job.scope === 'string' ? job.scope : '') || job.scopeOfWork, 20000),
    customerGoal: fieldText(instructions.customerGoal || job.discovery?.success, 4000),
    keepItems: description(instructions.keepItems || scope.keep_items), removeItems: description(instructions.removeItems || scope.remove_items || scope.keep_remove),
    exclusions: description(instructions.exclusions || scope.exclusions), hazards: textList(instructions.hazards || scope.hazards),
    accessInstructions: fieldText(job.accessInstructions || instructions.accessNotes || logistics.notes), access: textList(instructions.access || scope.access || logistics.access),
    truckPlacement: fieldText(instructions.truckPlacement || logistics.truck_placement),
    customerInstructions: fieldText(job.customerInstructions || instructions.customerNotes || job.customerNotesSummary),
    requiredEquipment: textList(job.requiredEquipment || logistics.requiredEquipment), materials: fieldMaterials(job),
    checklist: fieldChecklist(job),
    photos: fieldPhotos(job).map(photo => ({ id: photo.id, category: photo.category, caption: fieldText(photo.caption, 500), createdAt: photo.createdAt, actorName: photo.actorName, bytes: photo.bytes, url: `/api/field-jobs?jobId=${encodeURIComponent(job.id)}&photoId=${encodeURIComponent(photo.id)}` })),
    history: events.map(event => fieldEventProjection(event, options.manager)).filter(Boolean),
    attention: fieldAttention(job, options.manager === true), canAddManagementNote: options.manager === true,
    jobTime: fieldJobTime(job, options.now),
    completion: state.completion ? { completedAt: state.completion.completedAt, completedBy: state.completion.actorName || state.completion.actorId, notes: fieldText(state.completion.notes), hasIssues: state.completion.hasIssues === true, issueNotes: fieldText(state.completion.issueNotes) } : null,
    completionSync: job.fieldCompletionSync ? { status: job.fieldCompletionSync.status, message: fieldText(job.fieldCompletionSync.message, 600), attemptedAt: job.fieldCompletionSync.attemptedAt || null, syncedAt: job.fieldCompletionSync.syncedAt || null, canRetry: options.manager === true && job.fieldCompletionSync.status !== 'synced' } : null,
    startedAt: job.startedAt || null, completedAt: job.completedAt || null,
    completionMissing: frozen ? [] : fieldCompletionMissing(job),
    canEdit: !frozen, canManageChecklist: options.manager === true && !frozen,
    allowedStatuses: frozen ? [] : ({ scheduled: ['dispatched'], confirmed: ['dispatched'], crew_assigned: ['dispatched'], dispatched: ['arrived', 'delayed'], arrived: ['in_progress', 'waiting'], in_progress: ['paused', 'waiting', 'delayed', 'in_progress'] }[stage] || []),
  };
}

export async function fieldFingerprint(actor, input) {
  const normalize = value => Array.isArray(value) ? value.map(normalize) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).filter(key => !['expectedRevision', 'expectedUser'].includes(key)).sort().map(key => [key, normalize(value[key])])) : value;
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify({ actor, input: normalize(input) }))))].map(value => value.toString(16).padStart(2, '0')).join('');
}

export function fieldCommand(job, actor, input, now = new Date().toISOString()) {
  const state = job.fieldExecution || {}, actorId = actor.user, actorName = actor.displayName || actor.user;
  const stamp = { at: now, actorId, actorName };
  const event = { id: input.requestId, action: input.action, actorId, actorName, createdAt: now, state: 'applied', visibility: 'crew' };
  let patch = {};
  if (!['note', 'resolve_issue'].includes(input.action) && closed(job)) throw fieldFailure('This job is closed. Its execution record cannot be changed.', 409, 'FIELD_JOB_CLOSED');
  switch (input.action) {
    case 'note': {
      if (typeof input.body !== 'string' || !input.body.trim() || input.body.length > 4000) throw fieldFailure('Write a note of 1–4,000 characters.');
      if (input.visibility === 'management' && !actor.manager) throw fieldFailure('Only managers can add management-only notes.', 403);
      event.body = input.body.trim(); event.visibility = input.visibility === 'management' ? 'management' : 'crew'; event.summary = input.issue === true ? 'Issue reported' : 'Note added';
      if (input.issue === true) patch = { fieldExecution: { ...state, attention: { ...stamp, requestId: input.requestId, visibility: event.visibility, reason: input.body.trim(), status: 'open' } } };
      break;
    }
    case 'resolve_issue': {
      if (!actor.manager) throw fieldFailure('Only operations managers can resolve reported issues.', 403);
      const issue = fieldAttention(job, true);
      if (!issue || issue.status !== 'open' || input.issueId !== issue.id) throw fieldFailure('This issue changed or has already been resolved. Refresh the job to review the current follow-up.', 409, 'FIELD_ISSUE_CHANGED');
      if (typeof input.resolution !== 'string' || input.resolution.trim().length < 10 || input.resolution.length > 4000) throw fieldFailure('Describe the resolution and any customer follow-up in 10–4,000 characters.');
      patch = { fieldExecution: { ...state, attention: { ...state.attention, status: 'resolved', resolution: input.resolution.trim(), resolvedAt: now, resolvedBy: actorId, resolvedByName: actorName, resolutionRequestId: input.requestId } } };
      event.summary = 'Issue resolved'; event.body = input.resolution.trim(); event.visibility = issue.visibility; event.issueId = issue.id;
      break;
    }
    case 'checklist': {
      const item = fieldChecklist(job).find(item => item.id === input.itemId);
      if (!item || typeof input.completed !== 'boolean') throw fieldFailure('Choose a current checklist item and its completed state.');
      patch = { fieldExecution: { ...state, checks: { ...(state.checks || {}), [item.id]: { ...stamp, completed: input.completed } } } };
      event.summary = `${input.completed ? 'Checked' : 'Reopened'}: ${item.label}`;
      break;
    }
    case 'material': {
      const item = fieldMaterials(job).find(item => item.id === input.materialId);
      if (!item || !['required', 'loaded', 'used', 'missing'].includes(input.state)) throw fieldFailure('Choose a current material and a valid state.');
      patch = { fieldExecution: { ...state, materialStates: { ...(state.materialStates || {}), [item.id]: { ...stamp, state: input.state } } } };
      event.summary = `${item.name}: ${input.state}`;
      break;
    }
    case 'status': {
      const current = fieldStage(job), next = input.status;
      if (input.reason !== undefined && (typeof input.reason !== 'string' || input.reason.length > 1000)) throw fieldFailure('Status reasons must be no longer than 1,000 characters.');
      if (!fieldJobProjection(job).allowedStatuses.includes(next)) throw fieldFailure('This status is no longer available. Refresh the current job.', 409, 'FIELD_STATUS_CONFLICT');
      if (next === 'in_progress' && current !== 'in_progress') {
        const missing = fieldChecklist(job).filter(item => item.required && ['departure', 'arrival'].includes(item.stage) && !item.completed).map(item => `Checklist: ${item.label}`);
        if (!fieldPhotos(job).some(photo => photo.category === 'before')) missing.push('Upload a before photo.');
        if (missing.length) throw fieldFailure('Complete arrival preparation before starting work.', 409, 'FIELD_START_INCOMPLETE', { missing });
      }
      if (['paused', 'waiting', 'delayed'].includes(next) && fieldText(input.reason).length < 3) throw fieldFailure('Add a short reason so dispatch knows what is happening.');
      const canonical = ['paused', 'waiting', 'delayed'].includes(next) ? current : next;
      patch = { status: canonical, pipelineStatus: canonical, fieldExecution: { ...state, activity: next, activityAt: now, activityBy: actorId, activityReason: fieldText(input.reason, 1000) }, ...(next === 'in_progress' && !job.startedAt ? { startedAt: now, startedBy: actorId } : {}), ...(next === 'arrived' ? { arrivedAt: now, arrivedBy: actorId } : {}) };
      if (next === 'in_progress' && current !== 'in_progress') {
        const items = fieldChecklist(job).filter(item => ['departure', 'arrival'].includes(item.stage));
        const progress = { completedAt: now, completedBy: actorId, completedCount: items.filter(item => item.completed).length, totalCount: items.length, standardItems: items };
        patch.preJobProgress = progress; patch.preJobChecklist = progress;
      }
      event.summary = `${current.replaceAll('_', ' ')} → ${next.replaceAll('_', ' ')}`; event.body = fieldText(input.reason, 1000);
      break;
    }
    case 'complete': {
      if (typeof input.hasIssues !== 'boolean') throw fieldFailure('Indicate whether this job has an issue requiring follow-up.');
      if (typeof input.notes !== 'string' || input.notes.length > 4000 || input.issueNotes !== undefined && (typeof input.issueNotes !== 'string' || input.issueNotes.length > 4000)) throw fieldFailure('Completion notes and issue details must each be no longer than 4,000 characters.');
      const missing = fieldCompletionMissing(job, input);
      if (missing.length) throw fieldFailure('Finish the required closeout items.', 409, 'FIELD_COMPLETION_INCOMPLETE', { missing });
      const completion = { completedAt: now, actorId, actorName, notes: fieldText(input.notes), hasIssues: input.hasIssues, issueNotes: fieldText(input.issueNotes), evidencePhotoIds: fieldPhotos(job).map(photo => photo.id) };
      const checklist = fieldChecklist(job);
      const progress = stage => { const items = checklist.filter(item => stage === 'pre' ? ['departure', 'arrival'].includes(item.stage) : ['work', 'finish'].includes(item.stage)); return { completedAt: now, completedBy: actorId, completedCount: items.filter(item => item.completed).length, totalCount: items.length, standardItems: items }; };
      patch = { status: 'completed', pipelineStatus: 'completed', completedAt: now, completedBy: actorId, closeoutNotes: completion.notes, fieldExecution: { ...state, activity: 'completed', completion, ...(input.hasIssues ? { attention: { ...stamp, requestId: input.requestId, visibility: 'crew', reason: completion.issueNotes, status: 'open' } } : {}) }, postJobProgress: progress('post'), postJobChecklist: progress('post'), preJobProgress: job.preJobProgress || progress('pre'), preJobChecklist: { ...(job.preJobChecklist || progress('pre')) }, afterPhotoCount: fieldPhotos(job).filter(photo => photo.category === 'after').length, completionEvidence: { kind: 'verified_field_execution', actorId, recordedAt: now, requestId: input.requestId, photoIds: completion.evidencePhotoIds } };
      patch.fieldCompletionSync = { requestId: input.requestId, status: 'pending', message: 'Work is saved. The internal CRM completion note and follow-up are awaiting verification.', createdAt: now, attempts: 0, requestedBy: actorId, requestedByName: actorName, providerContactId: fieldText(job.highlevelContactId, 200), title: 'EGC field completion', body: [`EGC job: ${job.id}`, `Work completed: ${now}`, `Completed by: ${actorName} (${actorId})`, `Services: ${fieldText(job.serviceType, 500) || 'Garage service'}`, `Work performed: ${completion.notes}`, `Verified before photos: ${fieldPhotos(job).filter(photo => photo.category === 'before').length}`, `Verified after photos: ${fieldPhotos(job).filter(photo => photo.category === 'after').length}`, `Required checklist: ${checklist.filter(item => item.required).length} complete`, `Issues / follow-up: ${completion.hasIssues ? completion.issueNotes : 'None reported'}`, 'This is an operational work-completion record. Payment status has not been changed.'].join('\n') };
      event.summary = input.hasIssues ? 'Work completed — follow-up required' : 'Work completed'; event.body = completion.notes;
      break;
    }
    case 'configure_checklist': {
      if (!actor.manager) throw fieldFailure('Only managers can change job checklists.', 403);
      if (!Array.isArray(input.items) || !input.items.length || input.items.length > 80) throw fieldFailure('Provide 1–80 checklist items.');
      const seen = new Set();
      const template = input.items.map(item => {
        if (!item || typeof item.id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(item.id) || ['__proto__', 'constructor', 'prototype'].includes(item.id) || item.id.startsWith('client-') || seen.has(item.id) || !['departure', 'arrival', 'work', 'finish'].includes(item.stage) || typeof item.label !== 'string' || !item.label.trim() || item.label.length > 500 || typeof item.required !== 'boolean') throw fieldFailure('Checklist items need unique IDs, stage, label and required state.');
        seen.add(item.id); return { id: item.id, stage: item.stage, label: item.label.trim(), detail: fieldText(item.detail, 1000), required: item.required };
      });
      const previous = fieldChecklist(job), checks = {};
      for (const item of template) { const old = previous.find(old => old.id === item.id); if (old && old.label === item.label && old.stage === item.stage && old.required === item.required && old.detail === item.detail && state.checks?.[item.id]) checks[item.id] = state.checks[item.id]; }
      for (const [id, check] of Object.entries(state.checks || {})) if (id.startsWith('client-')) checks[id] = check;
      patch = { fieldExecution: { ...state, checklistTemplate: template, checks } }; event.summary = 'Job checklist updated';
      break;
    }
    default: throw fieldFailure('Choose a supported job action.');
  }
  if (['status', 'complete'].includes(input.action)) {
    const time = advanceFieldTime(job, input.action === 'complete' ? null : input.status, actor, input.requestId, now);
    if (time.clock) patch.fieldExecution = { ...(patch.fieldExecution || state), jobTime: time.clock };
    if (time.segment) event.timeSegment = time.segment;
  }
  return { patch: { ...patch, updatedAt: now, fieldLastActionAt: now }, event };
}
