import { hasBusinessAccess } from './hub-session.js';
import { jobCrewNames, assignmentKey } from './job-assignment.js';
import { DISPATCH_ACTIONS, DISPATCH_TIME_ZONE } from './dispatch-contract.js';
import { validDate, addDays, denverToday, scheduleInterval, availabilityInterval, occupiedDays, overlaps } from './dispatch-time.js';

const TERMINAL = new Set(['cancelled','canceled','completed','invoiced','paid','review_requested','closed','noshow','no_show','no-show']);
const JOB_TYPES = new Set(['job','walkthrough','cleanout','reorg']);
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const safeId = id => typeof id === 'string' && /^[A-Za-z0-9_-]{1,180}$/.test(id) && !/^(secure_|_egc_)/.test(id);
const fail = (code, message, status = 400, details) => Object.assign(new Error(message), { code, status, ...(details ? { details } : {}) });
const state = job => job.pipelineStatus || job.status || 'unscheduled';
const visibleJob = job => Boolean(job && safeId(job.id) && !job.recordType && JOB_TYPES.has(job.type));
const activeJob = job => (visibleJob(job) || job.type === 'blocked') && !TERMINAL.has(state(job));
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : isObject(value) ? `{${Object.entries(value).sort(([a],[b]) => a.localeCompare(b)).map(([key,item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}` : JSON.stringify(value);
const digest = async value => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical(value))))].map(byte => byte.toString(16).padStart(2,'0')).join('');

export function requireDispatcher(session) {
  if (!session) throw fail('dispatch_sign_in_required', 'Sign in to the Employee Hub to use dispatch.', 401);
  if (!hasBusinessAccess(session) || !['owner','manager'].includes(session.role)) throw fail('dispatch_forbidden', 'Only an operations manager or owner can change dispatch.', 403);
}

function text(value, label, max = 4000) {
  if (typeof value !== 'string' || value.length > max) throw fail('dispatch_invalid_field', `${label} must be text of at most ${max} characters.`);
  return value.trim();
}
function integer(value, label, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) throw fail('dispatch_invalid_field', `${label} must be a whole number from ${min} to ${max}.`);
  return value;
}
function onlyKeys(value, keys) {
  if (!isObject(value) || Object.keys(value).some(key => !keys.includes(key))) throw fail('dispatch_patch_not_allowed', 'This request contains unsupported fields. Refresh the dispatch form and try again.');
}

function resolveMember(value, roster, legacy = false) {
  const key = assignmentKey(value);
  const direct = roster.find(person => person.id === key);
  if (direct) return direct.id;
  if (legacy) {
    const aliases = roster.filter(person => assignmentKey(person.name) === key);
    if (aliases.length === 1) return aliases[0].id;
  }
  return null;
}
function members(values, roster) {
  if (!Array.isArray(values) || values.length > 20 || values.some(value => typeof value !== 'string')) throw fail('dispatch_crew_invalid', 'Choose up to 20 active employees.');
  const resolved = values.map(value => resolveMember(value, roster));
  if (resolved.some(value => !value)) throw fail('dispatch_employee_inactive', 'An assigned employee is no longer active or could not be verified. Refresh the employee list.');
  if (new Set(resolved).size !== resolved.length) throw fail('dispatch_crew_duplicate', 'Each employee can only be assigned once.');
  return resolved;
}
function legacyMembers(job, roster) {
  const assigned = Array.isArray(job?.assignedCrew) && job.assignedCrew.length ? job.assignedCrew : jobCrewNames(job);
  const ids = assigned.map(value => {
    const explicit = isObject(value) ? value.username || value.user || value.id : null;
    const name = typeof value === 'string' ? value : explicit || value?.name || '';
    return resolveMember(name,roster,!explicit) || assignmentKey(name);
  }).filter(Boolean);
  return [...new Set(ids)];
}

const DTO_FIELDS = ['id','revision','type','customerId','customer','phone','address','title','date','time','endDate','endTime','assignedTo','crewLead','crewId','vehicleId','crewNeeded','travelBufferMinutes','jobInstructions','accessInstructions','customerInstructions','opsNotes','requiredEquipment','materials','serviceType','syncStatus','highlevelAppointmentId','sourceWalkthroughId','createdAt','updatedAt','completedAt'];
export function projectDispatchJob(job, roster = []) {
  const output = Object.fromEntries(DTO_FIELDS.filter(key => job[key] !== undefined).map(key => [key, job[key]]));
  const interval = scheduleInterval(job);
  return { ...output, assignedCrew: roster.length ? legacyMembers(job,roster) : jobCrewNames(job), crewLead: job.crewLead ? resolveMember(job.crewLead,roster,true) || job.crewLead : null, status: state(job), endDate: job.endDate || job.date || '',
    crewNeeded: job.crewNeeded || job.requiredCrewSize || 1, startAt: interval?.startAt || null, endAt: interval?.endAt || null,
    timeZone: DISPATCH_TIME_ZONE, timeNeedsReview: Boolean(job.date) && !interval };
}

function jobWarnings(job, jobs, resources, roster) {
  if (!activeJob(job)) return [];
  const warnings = [], add = (code, message, extra = {}) => warnings.push({ code, jobId: job.id, message, ...extra });
  const interval = scheduleInterval(job), crew = legacyMembers(job, roster);
  if (!String(job.address || '').trim()) add('missing_address', 'Add the job address before dispatching the crew.');
  if (!job.customerId) add('missing_customer_link', 'This legacy job needs its canonical customer link reviewed.');
  if (!String(job.jobInstructions || job.scope || '').trim()) add('missing_scope', 'Add the work scope so the crew knows what was sold.');
  if (!interval) add(job.date ? 'invalid_schedule' : 'unscheduled', job.date ? 'The saved date or time needs review.' : 'This job has no scheduled time.');
  if (!crew.length) add('unassigned', 'No employees are assigned.');
  if (crew.length < (job.crewNeeded || job.requiredCrewSize || 1)) add('crew_size_short', `Requires ${job.crewNeeded || job.requiredCrewSize || 1} crew members; ${crew.length} assigned.`);
  if (crew.some(id => !roster.some(person => person.id === id))) add('inactive_assignment', 'An assigned employee is no longer in the active roster.');
  if (crew.length > 1 && !job.crewLead) add('missing_crew_lead', 'Choose a crew lead for this assignment.');
  if (job.vehicleId && resources.find(resource => resource.id === job.vehicleId)?.status !== 'available') add('vehicle_unavailable', 'The assigned vehicle is unavailable or missing.');
  if (job.syncStatus === 'pending' || job.syncStatus === 'error') add('provider_sync_pending', 'The Hub schedule is saved; the HighLevel mirror still needs confirmation.');
  if (!interval) return warnings;
  for (const other of jobs) {
    if (other.id === job.id || !activeJob(other)) continue;
    const otherInterval = scheduleInterval(other);
    const shared = crew.filter(id => legacyMembers(other, roster).includes(id));
    const vehicle = job.vehicleId && job.vehicleId === other.vehicleId;
    if (!shared.length && !vehicle && other.type !== 'blocked') continue;
    if (!otherInterval) {
      // An existing dated assignment with malformed times cannot be treated as
      // free capacity. Undated work is intentionally a schedulable backlog.
      if (other.date && (!validDate(other.date) || other.date <= interval.endDate && (!validDate(other.endDate || other.date) || (other.endDate || other.date) >= interval.date))) add('unverifiable_assignment','Another assignment for this employee or vehicle has invalid times. Repair that schedule before assigning overlapping dates.',{otherJobId:other.id,employeeIds:shared,vehicleId:vehicle ? job.vehicleId : null});
      continue;
    }
    if (overlaps(interval, otherInterval)) add('schedule_overlap', 'This job overlaps another assignment.', { otherJobId: other.id, employeeIds: shared, vehicleId: vehicle ? job.vehicleId : null });
    else {
      const earlier = interval.end <= otherInterval.start ? job : other;
      const later = earlier === job ? other : job;
      const gap = interval.end <= otherInterval.start ? (otherInterval.start - interval.end) / 60000 : (interval.start - otherInterval.end) / 60000;
      const buffer = Math.max(Number(earlier.travelBufferMinutes) || 0, Number(later.travelBufferMinutes) || 0);
      if (buffer && gap < buffer && assignmentKey(earlier.address) !== assignmentKey(later.address)) add('travel_buffer_short', `Only ${gap} minutes between jobs; ${buffer} minutes were requested for travel.`, { otherJobId: other.id, gapMinutes: gap, requiredMinutes: buffer });
    }
  }
  const blocks = [...resources.filter(resource => resource.recordType === 'availability'), ...jobs.filter(row => row.type === 'availability' || row.recordType === 'crew_availability')];
  for (const block of blocks) {
    if (block.status === 'cancelled') continue;
    const person = resolveMember(block.employeeId || block.employee, roster, true);
    if (person && crew.includes(person) && overlaps(interval, availabilityInterval(block))) add('employee_unavailable', 'An assigned employee has unavailable time during this job.', { employeeId: person, availabilityId: block.id });
  }
  return warnings;
}

export async function dispatchOverview(store, session, query = {}, now = new Date()) {
  requireDispatcher(session);
  if (query.view === 'customers') {
    const needle = text(query.q || '', 'Search', 200).toLowerCase(), digits = needle.replace(/\D/g, '');
    const all = await store.customers();
    const matches = all.filter(customer => !needle || [customer.name, customer.firstName, customer.lastName, customer.phone, customer.email, customer.address].some(value => String(value || '').toLowerCase().includes(needle)) || digits.length >= 3 && String(customer.phone || '').replace(/\D/g,'').includes(digits));
    return { ok: true, customers: matches.slice(0,50).map(customer => ({ id: customer.id, name: customer.name || [customer.firstName,customer.lastName].filter(Boolean).join(' '), phone: customer.phone || '', email: customer.email || '', address: customer.address || '' })), total: matches.length };
  }
  const startDate = query.startDate || denverToday(now), endDate = query.endDate || addDays(startDate,7);
  if (!validDate(startDate) || !validDate(endDate) || startDate >= endDate || Date.parse(endDate) - Date.parse(startDate) > 93 * 86400000) throw fail('dispatch_range_invalid', 'Choose a valid date range of up to 93 days. The end date is exclusive.');
  const [jobs, resources, roster] = await Promise.all([store.jobs(), store.resources(), store.roster()]);
  const includeUnscheduled = query.includeUnscheduled === true || query.includeUnscheduled === 'true';
  const selected = jobs.filter(visibleJob).filter(job => !validDate(job.date) ? includeUnscheduled : job.date < endDate && (job.endDate || job.date) >= startDate);
  selected.sort((a,b) => String(a.date || '9999').localeCompare(String(b.date || '9999')) || String(a.time || '').localeCompare(String(b.time || '')) || a.id.localeCompare(b.id));
  return { ok: true, timeZone: DISPATCH_TIME_ZONE, startDate, endDate, jobs: selected.map(job=>projectDispatchJob(job,roster)), roster,
    crews: resources.filter(row => row.recordType === 'crew'), vehicles: resources.filter(row => row.recordType === 'vehicle'),
    availability: resources.filter(row => row.recordType === 'availability').concat(jobs.filter(row => row.type === 'availability' || row.recordType === 'crew_availability').map(row => ({ ...row, employeeId: resolveMember(row.employee,roster,true) || row.employee }))).filter(row => row.date < endDate && (row.endDate || row.date) >= startDate),
    warnings: selected.flatMap(job => jobWarnings(job, jobs, resources, roster)), coverage: { complete: true, asOf: now.toISOString() } };
}

const SCHEDULE_KEYS = ['date','time','endDate','endTime','assignedCrew','crewLead','crewId','vehicleId','crewNeeded','travelBufferMinutes','title','address','serviceType','jobInstructions','accessInstructions','customerInstructions','opsNotes','requiredEquipment','materials'];
function schedulePatch(changes, current, resources, roster) {
  onlyKeys(changes, SCHEDULE_KEYS);
  const patch = {};
  for (const key of ['date','time','endDate','endTime']) if (key in changes) patch[key] = text(changes[key], key, 10);
  if ('date' in changes && !('endDate' in changes)) {
    const span = validDate(current?.date) && validDate(current?.endDate) ? Math.round((Date.parse(current.endDate) - Date.parse(current.date)) / 86400000) : 0;
    patch.endDate = changes.date ? addDays(changes.date,span) : '';
  }
  for (const key of ['title','address','serviceType','jobInstructions','accessInstructions','customerInstructions','opsNotes']) if (key in changes) patch[key] = text(changes[key], key, ['title','address','serviceType'].includes(key) ? 500 : 8000);
  for (const key of ['crewId','vehicleId']) if (key in changes) {
    if (changes[key] !== null && changes[key] !== '' && !safeId(changes[key])) throw fail('dispatch_resource_invalid', `Choose a valid ${key}.`);
    patch[key] = changes[key] || null;
  }
  if ('crewLead' in changes) {
    patch.crewLead = changes.crewLead ? resolveMember(changes.crewLead,roster) : null;
    if (changes.crewLead && !patch.crewLead) throw fail('dispatch_employee_inactive','Choose an active employee as crew lead.');
  }
  if ('crewNeeded' in changes) patch.crewNeeded = integer(changes.crewNeeded,'Crew size',1,20);
  if ('travelBufferMinutes' in changes) patch.travelBufferMinutes = integer(changes.travelBufferMinutes,'Travel time',0,180);
  if ('requiredEquipment' in changes) {
    if (!Array.isArray(changes.requiredEquipment) || changes.requiredEquipment.length > 100) throw fail('dispatch_equipment_invalid','Enter at most 100 pieces of required equipment.');
    patch.requiredEquipment = [...new Set(changes.requiredEquipment.map(value => text(value,'Equipment',200)).filter(Boolean))];
  }
  if ('materials' in changes) {
    if (!Array.isArray(changes.materials) || changes.materials.length > 100) throw fail('dispatch_materials_invalid','Enter at most 100 required materials.');
    patch.materials = changes.materials.map(material => {
      onlyKeys(material,['id','name','quantity']);
      if (!safeId(material.id) || typeof material.quantity !== 'number' || !Number.isFinite(material.quantity) || material.quantity <= 0 || material.quantity > 100000) throw fail('dispatch_materials_invalid','Each material needs a stable ID and a positive quantity.');
      const name = text(material.name,'Material name',200);
      if (!name) throw fail('dispatch_materials_invalid','Each material needs a name.');
      return { id: material.id, name, quantity: material.quantity };
    });
    if (new Set(patch.materials.map(item => item.id)).size !== patch.materials.length) throw fail('dispatch_materials_invalid','Material IDs must be unique.');
  }
  if ('crewId' in changes && patch.crewId) {
    const crew = resources.find(row => row.recordType === 'crew' && row.id === patch.crewId && row.status === 'active');
    if (!crew) throw fail('dispatch_crew_inactive','Choose an active crew.');
    if (!('assignedCrew' in changes)) patch.assignedCrew = members(crew.memberIds,roster);
    if (!('crewLead' in changes)) patch.crewLead = crew.leadId || null;
  }
  if ('assignedCrew' in changes) patch.assignedCrew = members(changes.assignedCrew,roster);
  if (patch.assignedCrew) patch.assignedTo = patch.assignedCrew.join(', ');
  const next = { ...current, ...patch }, crew = legacyMembers(next,roster);
  if (next.crewLead && !crew.includes(assignmentKey(next.crewLead))) throw fail('dispatch_lead_not_assigned','The crew lead must be one of the assigned employees.');
  if (next.vehicleId && !resources.some(row => row.recordType === 'vehicle' && row.id === next.vehicleId && row.status === 'available')) throw fail('dispatch_vehicle_unavailable','This vehicle is unavailable. Choose an available vehicle or remove its assignment.');
  if (('assignedCrew' in changes || 'crewId' in changes) && crew.some(id => !roster.some(person => person.id === id))) throw fail('dispatch_employee_inactive','Choose employees from the active roster.');
  return patch;
}

function conflictCheck(next, jobs, resources, roster) {
  if (!activeJob(next) || !scheduleInterval(next)) return;
  const conflicts = jobWarnings(next,jobs,resources,roster).filter(warning => ['schedule_overlap','employee_unavailable','unverifiable_assignment'].includes(warning.code));
  if (conflicts.length) throw fail('dispatch_conflict','This change conflicts with scheduled work or employee availability. Choose a different time, crew, or vehicle.',409,{ conflicts });
}

function auditState(job) {
  return Object.fromEntries(['date','time','endDate','endTime','status','pipelineStatus','assignedCrew','assignedTo','crewId','crewLead','vehicleId','jobInstructions','accessInstructions','customerInstructions','opsNotes','requiredEquipment','materials','crewNeeded','travelBufferMinutes','title','address','serviceType','name','memberIds','leadId','notes','employeeId','allDay','reason'].filter(key => job?.[key] !== undefined).map(key => [key,job[key]]));
}

export async function mutateDispatch(store, session, input, now = new Date().toISOString()) {
  requireDispatcher(session);
  try { return await executeDispatch(store,session,input,now); }
  catch (error) {
    // Another copy of the same request may commit between our initial receipt
    // read and any later validation read, not merely during the final commit.
    if (!['dispatch_changed_since_operation','dispatch_idempotency_conflict'].includes(error.code) && /^[a-f0-9-]{36}$/i.test(input?.requestId || '')) {
      const receipt = await store.read('dispatchOperations',input.requestId.toLowerCase()).catch(() => null);
      if (receipt?.fingerprint === await digest({actor:session.user,input})) return executeDispatch(store,session,input,now);
    }
    throw error;
  }
}

async function executeDispatch(store, session, input, now) {
  requireDispatcher(session);
  if (!isObject(input) || !DISPATCH_ACTIONS.includes(input.action) || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(input.requestId || '')) throw fail('dispatch_request_invalid','Use a supported dispatch action with a unique request ID.');
  onlyKeys(input,['action','requestId','customerId','kind','sourceWalkthroughId','jobId','id','expectedRevision','changes']);
  const fingerprint = await digest({ actor: session.user, input }), receiptId = input.requestId.toLowerCase();
  const prior = await store.read('dispatchOperations',receiptId);
  if (prior) {
    if (prior.fingerprint !== fingerprint) throw fail('dispatch_idempotency_conflict','This request ID was already used for different changes. Refresh before saving.',409);
    const saved = await store.read(prior.collection,prior.targetId);
    if (!saved) throw fail('dispatch_saved_record_missing','The previously saved record is no longer available. Refresh and review.',409);
    if (saved.dispatchRequestId !== input.requestId) throw fail('dispatch_changed_since_operation','That request saved successfully, but dispatch has since changed this record. Refresh to see its current state.',409);
    return { ok: true, requestId: input.requestId, replayed: true, ...(prior.collection === 'jobs' ? { job: projectDispatchJob(saved), providerSync: saved.syncStatus === 'pending' ? 'pending' : 'not_needed' } : { resource: saved }), warnings: prior.warnings || [] };
  }
  // Every native dispatch mutation touches this revision before any business
  // reads. It serializes assignment checks with resource/availability changes.
  const guard = await store.read('dispatchState','revision');
  const [jobs,resources,roster] = await Promise.all([store.jobs(),store.resources(),store.roster()]);
  let collection, id, current, patch, warnings = [], writes = [], providerSync = 'not_needed';
  if (input.action.startsWith('schedule.')) {
    collection = 'jobs';
    const create = input.action === 'schedule.create', cancel = input.action === 'schedule.cancel', restore = input.action === 'schedule.restore';
    if (create) {
      if (!safeId(input.customerId) || !['job','walkthrough'].includes(input.kind)) throw fail('dispatch_customer_required','Select an existing customer and job type before creating work.');
      const customer = await store.read('customers',input.customerId);
      if (!customer) throw fail('dispatch_customer_not_found','This customer no longer exists. Search again.',404);
      const changes = input.changes || {};
      const bookingKey = changes.date && changes.time ? await digest({ customerId: customer.id, kind: input.kind, date: changes.date, time: changes.time, timeZone: DISPATCH_TIME_ZONE }) : null;
      id = bookingKey ? `visit_${bookingKey.slice(0,40)}` : `dispatch_${receiptId.replaceAll('-','')}`;
      if (await store.read('jobs',id) || jobs.some(job => visibleJob(job) && job.customerId === customer.id && (job.type === 'walkthrough' ? 'walkthrough' : 'job') === input.kind && changes.date && job.date === changes.date && job.time === changes.time)) throw fail('dispatch_job_already_exists','This customer already has that visit at the selected time. Open the existing job.',409);
      let source = null;
      if (input.sourceWalkthroughId) {
        if (!safeId(input.sourceWalkthroughId) || input.kind !== 'job') throw fail('dispatch_handoff_invalid','Select a valid source walkthrough for this job.');
        source = await store.read('jobs',input.sourceWalkthroughId);
        if (!source || source.type !== 'walkthrough' || source.customerId !== customer.id) throw fail('dispatch_handoff_invalid','The source walkthrough must belong to this customer.',409);
        if (jobs.some(job => visibleJob(job) && job.sourceWalkthroughId === source.id)) throw fail('dispatch_handoff_exists','This walkthrough already has an operational job. Open that job instead.',409);
      }
      const sourceFields = ['jobInstructions','accessInstructions','customerInstructions','requiredEquipment','materials','serviceType','reviewedWalkthroughScope','salesNotes','customerNotes','estimate'];
      current = null;
      patch = { ...(source ? Object.fromEntries(sourceFields.filter(key => source[key] !== undefined).map(key => [key,source[key]])) : {}),
        id, type: input.kind, customerId: customer.id, customer: customer.name || [customer.firstName,customer.lastName].filter(Boolean).join(' '),
        phone: customer.phone || '', email: customer.email || '', address: source?.address || customer.address || '', highlevelContactId: source?.highlevelContactId || customer.highlevelContactId || '',
        date: '', time: '', endDate: '', endTime: '', assignedCrew: [], assignedTo: '', crewLead: null, crewId: null, vehicleId: null, crewNeeded: 1, travelBufferMinutes: 20,
        status: 'unscheduled', pipelineStatus: 'unscheduled', createdAt: now, createdBy: session.user, scheduleSource: 'egc_hub',
        ...(bookingKey ? { bookingKey } : {}), ...(source ? { sourceWalkthroughId: source.id } : {}),
      };
      const projectId = source?.projectId || `project_${source?.id || id}`;
      const project = await store.read('projects',projectId);
      if (project && project.customerId !== customer.id) throw fail('dispatch_project_conflict','The source project belongs to another customer. Review the link before creating a job.',409);
      patch.projectId = projectId;
      if (!project) writes.push({ collection:'projects', id:projectId, patch:{ id:projectId, customerId:customer.id, sourceRecordId:source?.id || id, sourceWalkthroughId:source?.id || (input.kind === 'walkthrough' ? id : null), authority:'employee_hub',createdAt:now,updatedAt:now,createdBy:session.user } });
      if (source && !source.projectId) writes.push({ collection:'jobs',id:source.id,revision:source.revision,patch:{ projectId, updatedAt:now } });
    } else {
      id = input.jobId;
      if (!safeId(id)) throw fail('dispatch_job_not_found','Choose a valid job.',404);
      current = await store.read('jobs',id);
      if (!current || !visibleJob(current)) throw fail('dispatch_job_not_found','This operational job could not be found.',404);
      if (!input.expectedRevision || current.revision !== input.expectedRevision) throw fail('dispatch_revision_conflict','This job changed while you were editing. Refresh and review its latest details.',409);
      if (restore ? !['cancelled','canceled'].includes(state(current)) : TERMINAL.has(state(current))) throw fail('dispatch_terminal_job','This job cannot be changed in its current state. Cancelled jobs can be explicitly restored; completed work keeps its history.',409);
      if (input.customerId && input.customerId !== current.customerId) throw fail('dispatch_customer_immutable','Customer identity cannot be changed in dispatch.',409);
      patch = {};
    }
    if (cancel && Object.keys(input.changes || {}).length) throw fail('dispatch_cancel_patch_invalid','Cancellation cannot also edit job details.');
    if (!cancel) Object.assign(patch,schedulePatch(input.changes || {},current || patch,resources,roster));
    let next = { ...current, ...patch };
    const hasSchedule = Boolean(next.date || next.time || next.endDate || next.endTime), interval = scheduleInterval(next);
    if (!cancel && hasSchedule && !interval) throw fail('dispatch_time_invalid','Choose valid Denver start and end times within 31 days. Missing or repeated DST hours cannot be scheduled.');
    if (!cancel && !hasSchedule && current?.highlevelAppointmentId) throw fail('dispatch_linked_unschedule_unsupported','A provider-linked appointment must be rescheduled or cancelled, not cleared.');
    if (create || restore) Object.assign(patch,{ status:interval ? 'scheduled' : 'unscheduled',pipelineStatus:interval ? 'scheduled' : 'unscheduled' });
    if (!create && !restore && !cancel && state(current) === 'unscheduled' && interval) Object.assign(patch,{status:'scheduled',pipelineStatus:'scheduled'});
    if (!cancel && !interval && !create && state(current) === 'scheduled') Object.assign(patch,{status:'unscheduled',pipelineStatus:'unscheduled'});
    if (cancel) Object.assign(patch,{status:'cancelled',pipelineStatus:'cancelled',cancelledAt:now,cancelledBy:session.user});
    if (restore) Object.assign(patch,{cancelledAt:null,cancelledBy:null,restoredAt:now,restoredBy:session.user});
    Object.assign(patch,{updatedAt:now,updatedBy:session.user,dispatchUpdatedAt:now,dispatchRequestId:input.requestId,...(!cancel ? { startAt:interval?.startAt || null,endAt:interval?.endAt || null,timeZone:DISPATCH_TIME_ZONE } : {})});
    next = { ...current, ...patch };
    const scheduleChanged = create || cancel || restore || ['date','time','endDate','endTime','title','address'].some(key => key in patch && patch[key] !== current?.[key]);
    if (scheduleChanged && (next.highlevelContactId || next.highlevelAppointmentId)) {
      Object.assign(patch,{syncStatus:'pending',syncIdempotencyKey:input.requestId,providerSyncOwner:'operations'}); providerSync = 'pending';
    } else if (create) patch.syncStatus = 'not_needed';
    next = { ...current, ...patch };
    conflictCheck(next,jobs,resources,roster);
    warnings = jobWarnings(next,jobs,resources,roster);
    const days = [...new Set([...occupiedDays(current),...occupiedDays(next)])].sort();
    for (const date of days) {
      const lockId = `_egc_schedule_lock_${date}`, lock = await store.read('jobs',lockId);
      const entries = (Array.isArray(lock?.entries) ? lock.entries : []).filter(entry => entry.id !== id && !TERMINAL.has(entry.status));
      if (activeJob(next) && occupiedDays(next).includes(date)) entries.push({id,start:date === next.date ? next.time : '00:00',end:date === (next.endDate || next.date) ? next.endTime : '24:00',label:next.customer || next.title || '',status:state(next),assignedCrew:legacyMembers(next,roster),vehicleId:next.vehicleId || null,updatedAt:now});
      writes.push({collection:'jobs',id:lockId,revision:lock?.revision,patch:{recordType:'schedule_lock',date,entries,updatedAt:now}});
    }
  } else {
    collection = 'dispatchResources';
    id = input.id || `${input.action.split('.')[0]}_${receiptId.replaceAll('-','')}`;
    if (!safeId(id)) throw fail('dispatch_resource_invalid','Choose a valid resource.');
    current = await store.read(collection,id);
    if (input.id && (!current || !input.expectedRevision || current.revision !== input.expectedRevision)) throw fail('dispatch_revision_conflict','This resource changed. Refresh before saving.',409);
    const recordType = input.action.split('.')[0];
    if (current && current.recordType !== recordType) throw fail('dispatch_resource_invalid','This is a different kind of dispatch resource.',409);
    patch = resourcePatch(recordType,input.changes || {},current,roster);
    Object.assign(patch,{id,recordType,updatedAt:now,updatedBy:session.user,dispatchRequestId:input.requestId,...(!current ? {createdAt:now,createdBy:session.user} : {})});
    const next = {...current,...patch};
    if (recordType === 'availability' && next.status !== 'cancelled') {
      const conflicts = jobs.filter(activeJob).filter(job => legacyMembers(job,roster).includes(next.employeeId) && overlaps(scheduleInterval(job),availabilityInterval(next))).map(job => ({jobId:job.id,employeeId:next.employeeId}));
      if (conflicts.length) warnings.push({code:'availability_conflicts',message:'Time off was saved. Reassign the affected jobs before dispatch.',conflicts});
    }
    if (recordType === 'vehicle' && next.status !== 'available') {
      const affected = jobs.filter(activeJob).filter(job => job.vehicleId === id && (!scheduleInterval(job) || scheduleInterval(job).end > Date.parse(now)));
      if (affected.length) warnings.push({code:'vehicle_assignments_need_review',message:'Vehicle availability was updated. Existing assignments need reassignment.',jobIds:affected.map(job => job.id)});
    }
  }
  writes.push({collection,id,revision:current?.revision,patch});
  writes.push({collection:'dispatchState',id:'revision',revision:guard?.revision,patch:{updatedAt:now,lastRequestId:input.requestId}});
  writes.push({collection:'dispatchOperations',id:receiptId,patch:{fingerprint,actorId:session.user,action:input.action,collection,targetId:id,requestId:input.requestId,createdAt:now,before:current ? auditState(current) : null,after:auditState({...current,...patch}),warnings}});
  try { await store.commit(writes); }
  catch (error) {
    const receipt = await store.read('dispatchOperations',receiptId).catch(() => null);
    if (!receipt || receipt.fingerprint !== fingerprint) throw error;
  }
  const saved = await store.read(collection,id);
  if (!saved) throw fail('dispatch_outcome_unknown','The saved record could not be verified. Retry the same request.',503);
  if (saved.dispatchRequestId !== input.requestId) throw fail('dispatch_changed_since_operation','The save succeeded, but dispatch has changed again. Refresh to review the latest schedule.',409);
  return {ok:true,requestId:input.requestId,warnings,...(collection === 'jobs' ? {job:projectDispatchJob(saved,roster),providerSync} : {resource:saved})};
}

function resourcePatch(kind,changes,current,roster) {
  const patch = {};
  if (kind === 'crew') {
    onlyKeys(changes,['name','memberIds','leadId','status']);
    if ('name' in changes) patch.name = text(changes.name,'Crew name',100);
    if ('memberIds' in changes) patch.memberIds = members(changes.memberIds,roster);
    if ('leadId' in changes) patch.leadId = changes.leadId ? resolveMember(changes.leadId,roster) : null;
    if (changes.leadId && !patch.leadId) throw fail('dispatch_employee_inactive','Choose an active employee as crew lead.');
    if ('status' in changes) { if (!['active','inactive'].includes(changes.status)) throw fail('dispatch_resource_invalid','Choose active or inactive.'); patch.status = changes.status; }
    const next = {status:'active',memberIds:[],leadId:null,...current,...patch};
    if (!next.name) throw fail('dispatch_name_required','Enter the crew name.');
    if (next.leadId && !next.memberIds.includes(next.leadId)) throw fail('dispatch_lead_not_assigned','The crew lead must belong to this crew.');
    return {name:next.name,memberIds:next.memberIds,leadId:next.leadId,status:next.status};
  }
  if (kind === 'vehicle') {
    onlyKeys(changes,['name','status','notes']);
    if ('name' in changes) patch.name = text(changes.name,'Vehicle name',100);
    if ('notes' in changes) patch.notes = text(changes.notes,'Vehicle notes',4000);
    if ('status' in changes) { if (!['available','out_of_service','inactive'].includes(changes.status)) throw fail('dispatch_resource_invalid','Choose an available, out-of-service, or inactive vehicle status.'); patch.status = changes.status; }
    const next = {status:'available',notes:'',...current,...patch};
    if (!next.name) throw fail('dispatch_name_required','Enter the vehicle name.');
    return {name:next.name,status:next.status,notes:next.notes};
  }
  onlyKeys(changes,['employeeId','date','endDate','time','endTime','allDay','reason','status']);
  if ('employeeId' in changes) { patch.employeeId = resolveMember(changes.employeeId,roster); if (!patch.employeeId) throw fail('dispatch_employee_inactive','Choose an active employee.'); }
  for (const key of ['date','endDate','time','endTime']) if (key in changes) patch[key] = text(changes[key],key,10);
  if ('allDay' in changes) { if (typeof changes.allDay !== 'boolean') throw fail('dispatch_availability_invalid','Choose all day or a time range.'); patch.allDay = changes.allDay; }
  if ('reason' in changes) patch.reason = text(changes.reason,'Time-off reason',500);
  if ('status' in changes) { if (!['active','cancelled'].includes(changes.status)) throw fail('dispatch_resource_invalid','Choose active or cancelled availability.'); patch.status = changes.status; }
  const next = {status:'active',allDay:true,time:'',endTime:'',reason:'',...current,...patch};
  if (!next.employeeId || !availabilityInterval(next)) throw fail('dispatch_availability_invalid','Choose valid unavailable dates and times within 31 days.');
  return {employeeId:next.employeeId,date:next.date,endDate:next.endDate || next.date,time:next.time,endTime:next.endTime,allDay:next.allDay,reason:next.reason,status:next.status};
}

/** Server-only self-service shift assignment. The HTTP caller must project the
 * returned canonical job for the requesting employee before returning JSON. */
export async function mutateDispatchSelfAssignment(store,session,input,now = new Date().toISOString()) {
  if (!session?.user) throw fail('dispatch_sign_in_required','Sign in to pick up a shift.',401);
  onlyKeys(input,['action','jobId','requestId','expectedRevision']);
  if (!['claim','release'].includes(input.action) || !safeId(input.jobId) || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(input.requestId || '')) throw fail('dispatch_request_invalid','A valid shift and unique request ID are required.');
  const fingerprint = await digest({actor:session.user,input}), receiptId = input.requestId.toLowerCase();
  async function replay() {
    const receipt = await store.read('dispatchOperations',receiptId);
    if (!receipt) return null;
    if (receipt.fingerprint !== fingerprint) throw fail('dispatch_idempotency_conflict','This shift request ID was already used for different changes.',409);
    const saved = await store.read('jobs',input.jobId);
    if (!saved || saved.dispatchRequestId !== input.requestId) throw fail('dispatch_changed_since_operation','Your shift request saved, but the assignment has since changed. Refresh to see your current schedule.',409);
    return {ok:true,action:input.action,requestId:input.requestId,replayed:true,job:saved,warnings:[]};
  }
  const previous = await replay();
  if (previous) return previous;
  try {
    const guard = await store.read('dispatchState','revision');
    const [job,jobs,resources,roster] = await Promise.all([store.read('jobs',input.jobId),store.jobs(),store.resources(),store.roster()]);
    const identity = resolveMember(session.user,roster);
    if (!identity) throw fail('dispatch_employee_inactive','Your active employee account could not be verified. Sign in again before choosing a shift.',403);
    if (!job || !visibleJob(job)) throw fail('dispatch_job_not_found','This shift no longer exists.',404);
    if (input.expectedRevision && input.expectedRevision !== job.revision) throw fail('dispatch_revision_conflict','This shift changed. Refresh before choosing it.',409);
    if (job.type !== 'job' || job.shiftPickupEnabled !== true || TERMINAL.has(state(job)) || ['dispatched','arrived','in_progress','paused','waiting'].includes(state(job))) throw fail('dispatch_shift_closed','This shift is no longer available for pickup or release.',409);
    const interval = scheduleInterval(job);
    if (!interval || interval.end <= Date.parse(now)) throw fail('dispatch_shift_time_invalid','Only upcoming shifts with valid start and end times can be picked up or released.',409);
    const crew = legacyMembers(job,roster), claims = Array.isArray(job.shiftClaims) ? job.shiftClaims : [];
    const isOwnClaim = value => resolveMember(value?.employee || value,roster,true) === identity;
    const selfClaimed = claims.some(isOwnClaim) || isOwnClaim(job.lastShiftClaim);
    const neededValue = Number(job.crewNeeded ?? job.crewSize ?? 1), needed = Number.isFinite(neededValue) ? Math.max(1,Math.min(20,Math.ceil(neededValue))) : 1;
    if (input.action === 'claim') {
      if (job.openShift !== true || crew.length >= needed) throw fail('dispatch_shift_full','This shift is already full or no longer open.',409);
      if (crew.includes(identity)) throw fail('dispatch_shift_already_assigned','You are already assigned to this shift.',409);
    } else if (!crew.includes(identity) || !selfClaimed) throw fail('dispatch_shift_release_forbidden','You can only release a shift you picked up yourself. Contact dispatch to change a manager assignment.',403);
    const assignedCrew = input.action === 'claim' ? [...crew,identity] : crew.filter(id=>id!==identity);
    const patch = {assignedCrew,assignedTo:assignedCrew.join(', '),crewNeeded:needed,crewSize:needed,openShift:assignedCrew.length < needed,
      shiftClaims:input.action === 'claim' ? [...claims.filter(value=>!isOwnClaim(value)),{employee:identity,claimedAt:now}] : claims.filter(value=>!isOwnClaim(value)),
      ...(input.action === 'claim' ? {lastShiftClaim:{employee:identity,claimedAt:now}} : {lastShiftRelease:{employee:identity,releasedAt:now},...(resolveMember(job.crewLead,roster,true) === identity ? {crewLead:null} : {})}),
      dispatchRequestId:input.requestId,dispatchUpdatedAt:now,updatedAt:now,updatedBy:identity};
    const next = {...job,...patch};
    if (input.action === 'claim') conflictCheck(next,jobs,resources,roster);
    const writes = [{collection:'jobs',id:job.id,revision:job.revision,patch}];
    for (const date of occupiedDays(job)) {
      const id = `_egc_schedule_lock_${date}`,lock = await store.read('jobs',id);
      const entries = (Array.isArray(lock?.entries) ? lock.entries : []).filter(entry=>entry.id!==job.id && !TERMINAL.has(entry.status));
      entries.push({id:job.id,start:date===job.date ? job.time : '00:00',end:date===(job.endDate || job.date) ? job.endTime : '24:00',label:job.customer || job.title || '',status:state(job),assignedCrew,vehicleId:job.vehicleId || null,updatedAt:now});
      writes.push({collection:'jobs',id,revision:lock?.revision,patch:{recordType:'schedule_lock',date,entries,updatedAt:now}});
    }
    writes.push({collection:'dispatchState',id:'revision',revision:guard?.revision,patch:{updatedAt:now,lastRequestId:input.requestId}});
    writes.push({collection:'dispatchOperations',id:receiptId,patch:{fingerprint,actorId:identity,action:`shift.${input.action}`,collection:'jobs',targetId:job.id,requestId:input.requestId,createdAt:now,before:auditState(job),after:auditState(next)}});
    await store.commit(writes);
    const saved = await store.read('jobs',job.id);
    if (!saved || saved.dispatchRequestId !== input.requestId) throw fail('dispatch_changed_since_operation','Your assignment saved, but dispatch has changed it again. Refresh your schedule.',409);
    return {ok:true,action:input.action,requestId:input.requestId,job:saved,warnings:jobWarnings(saved,jobs,resources,roster).filter(warning=>warning.code==='travel_buffer_short')};
  } catch(error) {
    const recovered = await replay().catch(replayError => { if (['dispatch_changed_since_operation','dispatch_idempotency_conflict'].includes(replayError.code)) throw replayError; return null; });
    if (recovered) return recovered;
    throw error;
  }
}
