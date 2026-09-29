import { jobCrewNames, assignmentKey } from './job-assignment.js';
import { fieldActivity } from './field-execution.js';
import { advanceFieldTime, fieldJobTime } from './field-execution-time.js';
import { resolveDispatchLineage, sameOperationalProperty } from './dispatch-lineage.js';
import { jobsForWindow, rowsWindow, saveJobReads, searchCustomers } from './dispatch-window-reads.js';
import { sharedScheduleResources, scheduleRowsConflict, scheduleDayEntry } from './dispatch-conflicts.js';
import { DISPATCH_ACTIONS, DISPATCH_TIME_ZONE } from './dispatch-contract.js';
import { validDate, addDays, denverToday, scheduleInterval, availabilityInterval, occupiedDays, overlaps } from './dispatch-time.js';
import { arrivalWindowPatch, arrivalDefaults } from './dispatch-arrival.js';
import { legacyBlockedDays, legacyBlockWarning } from './dispatch-legacy-blocks.js';
import { SEGMENT_HULL_KEYS, SEGMENT_LIMIT, segmented, segmentsInvalid, jobSegments, segmentDays, segmentLockEntries, ownsLockEntry, projectSegments, validateSegments } from './dispatch-segments.js';
import { canDispatch } from './dispatch-permissions.js';
import { dispatchRuleSettings, dispatchRulesView, effectiveArrivalSettings, DISPATCH_SETTINGS_DEFAULTS } from './dispatch-settings.js';
import { capacityIndex, crewSizeShort, enforced, offeredForPickup, requiredSkillsOf, ruleWarnings, validateRequiredSkills } from './dispatch-rules.js';
import { crewNotificationWrites } from './crew-notifications.js';
import { bookingInput, bookingPatch, reasonInput, cancelPatch, noShowProblem, visitFunnelWrites, requestKey, eventActor } from './dispatch-funnel.js';
import { dispatchDurationFields, dispatchDurationOverride, dispatchCrewSize, withQuoteLines, ESTIMATED_DURATION_MIN } from './dispatch-duration.js';
import { bookingDimensions, firstPlacementDimensions } from './funnel-dimensions.js';
import { scheduleTagWrites, withGhlTagStatus } from './ghl-tag-outbox.js';
import { notifyPatch, withDispatchReadiness } from './dispatch-readiness.js';
import { walkthroughStatusFields } from './walkthrough-state.js';
import { dispatchReviewCleared, withQueueFacts } from './dispatch-queue.js';

const TERMINAL = new Set(['cancelled','canceled','completed','invoiced','paid','review_requested','closed','noshow','no_show','no-show']);
const JOB_TYPES = new Set(['job','walkthrough','cleanout','reorg','blocked']);
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const safeId = id => typeof id === 'string' && /^[A-Za-z0-9_-]{1,180}$/.test(id) && !/^(secure_|_egc_)/.test(id);
const fail = (code, message, status = 400, details) => Object.assign(new Error(message), { code, status, ...(details ? { details } : {}) });
const funnelFail = (reason, message, status) => fail(`dispatch_${reason}`, message, status);
const REASON_LISTS = { 'schedule.update':'reschedule', 'schedule.cancel':'cancel', 'schedule.no_show':'noShow' };
const state = job => job.pipelineStatus || job.status || 'unscheduled';
const visibleJob = job => Boolean(job && safeId(job.id) && !job.recordType && JOB_TYPES.has(job.type));
const activeJob = job => (visibleJob(job) || job.type === 'blocked') && !TERMINAL.has(state(job));
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : isObject(value) ? `{${Object.entries(value).sort(([a],[b]) => a.localeCompare(b)).map(([key,item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}` : JSON.stringify(value);
const digest = async value => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical(value))))].map(byte => byte.toString(16).padStart(2,'0')).join('');

// dispatch.write (dispatch-permissions.js). Handlers pass their env so stored
// staff roles apply when EGC_STAFF_ROLE_PERMISSIONS is on.
export function requireDispatcher(session, env) {
  if (!session) throw fail('dispatch_sign_in_required', 'Sign in to the Employee Hub to use dispatch.', 401);
  if (!canDispatch(session, env)) throw fail('dispatch_forbidden', 'Only an operations manager or owner can change dispatch.', 403);
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

const DTO_FIELDS = ['id','revision','type','customerId','customer','phone','address','title','date','time','endDate','endTime','assignedTo','crewLead','crewId','vehicleId','crewNeeded','travelBufferMinutes','jobInstructions','accessInstructions','customerInstructions','opsNotes','requiredEquipment','materials','serviceType','syncStatus','highlevelAppointmentId','sourceWalkthroughId','sourceTemplateJobId','recurrence','recurrenceParentId','reminderDays','notify','shiftPickupEnabled','openShift','notes','durationMin','estimatedDurationMin','createdAt','updatedAt','completedAt','arrivalWindowStart','arrivalWindowEnd','arrivalWindow','requiredSkills','ghlTagEntry','noShowReasonCode','noShowAt','needsDispatchReview','dispatchReviewReason'];
const scopeText = job => typeof job.operationalScope?.text === 'string' ? job.operationalScope.text : typeof job.jobInstructions === 'string' ? job.jobInstructions : job.jobInstructions?.operationalScope || (typeof job.scope === 'string' ? job.scope : '') || job.scopeOfWork || '';
function recurringTemplateFields(source,actor,now) {
  const output={};
  for (const key of ['accessInstructions','customerInstructions','serviceType','recurrence','reminderDays','notify','notes','opsNotes','crewNeeded','travelBufferMinutes','title','durationMin','estimatedDurationMin']) {
    if (['string','number','boolean'].includes(typeof source[key])) output[key]=source[key];
  }
  const instructions=source.jobInstructions;
  if (isObject(instructions)) output.jobInstructions=Object.fromEntries(['customerGoal','keepItems','removeItems','exclusions','hazards','accessNotes','access','truckPlacement','customerNotes'].filter(key=>typeof instructions[key] === 'string' || Array.isArray(instructions[key]) && instructions[key].every(value=>typeof value==='string')).map(key=>[key,instructions[key]]));
  output.operationalScope={text:String(scopeText(source)),updatedBy:actor,updatedAt:now,reason:'Copied from recurring template',approvalKind:'staff_operational_instructions'};
  if (Array.isArray(source.requiredEquipment)) output.requiredEquipment=source.requiredEquipment.filter(value=>typeof value==='string');
  if (Array.isArray(source.requiredSkills)) output.requiredSkills=source.requiredSkills.filter(value=>typeof value==='string');
  if (Array.isArray(source.materials)) output.materials=source.materials.filter(item=>item&&typeof item.id==='string'&&typeof item.name==='string'&&Number.isFinite(item.quantity)).map(({id,name,quantity})=>({id,name,quantity}));
  return output;
}
export function projectDispatchJob(job, roster = [], now = new Date().toISOString()) {
  const output = Object.fromEntries(DTO_FIELDS.filter(key => job[key] !== undefined).map(key => [key, job[key]]));
  const interval = scheduleInterval(job);
  return { ...output, assignedCrew: roster.length ? legacyMembers(job,roster) : jobCrewNames(job), crewLead: job.crewLead ? resolveMember(job.crewLead,roster,true) || job.crewLead : null, status: state(job), endDate: job.endDate || job.date || '',
    jobInstructions:scopeText(job),
    crewNeeded: job.crewNeeded || job.requiredCrewSize || 1, startAt: interval?.startAt || null, endAt: interval?.endAt || null,
    ...dispatchDurationFields(job,interval),
    activity:fieldActivity(job),activityReason:job.fieldExecution?.activityReason || '',activityAt:job.fieldExecution?.activityAt || null,
    attention:job.fieldExecution?.attention?.status === 'open' ? {status:'open',reason:job.fieldExecution.attention.reason || '',at:job.fieldExecution.attention.at || null,actorName:job.fieldExecution.attention.actorName || ''} : null,
    completionSync:job.fieldCompletionSync ? {status:job.fieldCompletionSync.status,message:String(job.fieldCompletionSync.message || '').slice(0,600),attemptedAt:job.fieldCompletionSync.attemptedAt || null,syncedAt:job.fieldCompletionSync.syncedAt || null} : null,
    jobTime:fieldJobTime(job,now),
    arrivalWindowStart:job.arrivalWindowStart || null,arrivalWindowEnd:job.arrivalWindowEnd || null,arrivalWindow:job.arrivalWindow || '',
    ...(segmented(job) ? {assignmentSegments:projectSegments(job),...(segmentsInvalid(job) ? {segmentsInvalid:true} : {})} : {}),
    // WT-OUTCOME: a walkthrough's outcome, converted job and badge, and what a rebook prefills (walkthrough-state.js).
    ...walkthroughStatusFields(job),
    timeZone: DISPATCH_TIME_ZONE, timeNeedsReview: Boolean(job.date) && !interval };
}

function scheduleInspection(jobs,resources,roster,settings=DISPATCH_SETTINGS_DEFAULTS) {
  // Segmented jobs are indexed per segment; a legacy job is its own row.
  const intervals=new WeakMap(),memberships=new WeakMap(),byEmployee=new Map(),byVehicle=new Map(),global=[],active=jobs.filter(activeJob).flatMap(jobSegments),order=new Map(active.map((job,index)=>[job,index]));
  const crew=job=>{if(!memberships.has(job))memberships.set(job,legacyMembers(job,roster));return memberships.get(job);};
  const interval=job=>{if(!intervals.has(job))intervals.set(job,scheduleInterval(job));return intervals.get(job);};
  const append=(map,id,row)=>{if(!map.has(id))map.set(id,[]);map.get(id).push(row);};
  for(const job of active) {
    const ids=crew(job);
    if(job.type==='blocked'||job.assignmentKnown===false||!ids.length&&!Array.isArray(job.assignedCrew))global.push(job);
    for(const id of ids)append(byEmployee,id,job);
    if(job.vehicleId)append(byVehicle,job.vehicleId,job);
  }
  const availability=new Map();
  for(const block of [...resources.filter(row=>row.recordType==='availability'),...jobs.filter(row=>row.type==='availability'||row.recordType==='crew_availability')]) {
    if(TERMINAL.has(state(block)))continue;
    const person=resolveMember(block.employeeId||block.employee,roster,true);
    if(person)append(availability,person,{block,person,interval:availabilityInterval(block)});
  }
  // rules: owner settings (dispatch-rules.js); enforce limits blocking to changes that matter.
  return {crew,interval,travel:()=>null,travelWindow:0,blockTravelShort:false,rows:active,rules:{settings,enforce:()=>true,index:null},
    neighbors(job) {
      const ids=crew(job);
      if(job.type==='blocked'||job.assignmentKnown===false||!ids.length&&!Array.isArray(job.assignedCrew))return active;
      const found=new Set(global);
      for(const id of ids)for(const other of byEmployee.get(id)||[])found.add(other);
      for(const other of byVehicle.get(job.vehicleId)||[])found.add(other);
      return [...found].sort((a,b)=>order.get(a)-order.get(b));
    },
    availability(job){return crew(job).flatMap(id=>availability.get(id)||[]);},
  };
}

// Estimates are resolved before the synchronous checks. A missing estimate
// keeps the manual buffer; an estimate can only lengthen the required gap.
// Only the nearest earlier and later stop per shared employee or vehicle is
// estimated, so the lookup budget goes to consecutive legs.
async function withTravel(inspection,targets,roster,travel) {
  if(!travel?.enabled)return inspection;
  const pairs=[];
  for(const job of targets.flatMap(jobSegments)) {
    const interval=inspection.interval(job),nearest=new Map();
    if(!activeJob(job)||!interval||job.type==='blocked')continue;
    for(const other of inspection.neighbors(job)) {
      const otherInterval=other.id!==job.id&&other.type!=='blocked'&&inspection.interval(other);
      if(!otherInterval||overlaps(interval,otherInterval)||!sharedScheduleResources(job,other,roster))continue;
      const forward=interval.end<=otherInterval.start,gap=forward?otherInterval.start-interval.end:interval.start-otherInterval.end;
      if(gap/60000>=travel.windowMinutes)continue;
      const keys=inspection.crew(job).filter(id=>inspection.crew(other).includes(id)).map(id=>['employee',id]);
      if(job.vehicleId&&job.vehicleId===other.vehicleId)keys.push(['vehicle',job.vehicleId]);
      for(const key of keys.length?keys:[['shared']]) {
        const slot=JSON.stringify([forward,...key]);
        if(!nearest.has(slot)||gap<nearest.get(slot).gap)nearest.set(slot,{gap,pair:forward?[job,other]:[other,job]});
      }
    }
    for(const {pair} of nearest.values())pairs.push(pair);
  }
  return Object.assign(inspection,{travel:await travel.prefetch(pairs),travelWindow:travel.windowMinutes,blockTravelShort:travel.blockShort===true});
}

function potentiallyNear(left,right,window=0) {
  const leftEnd=left.endDate||left.date,rightEnd=right.endDate||right.date;
  if(!validDate(left.date)||!validDate(leftEnd)||!validDate(right.date)||!validDate(rightEnd)||leftEnd<left.date||rightEnd<right.date)return true;
  const buffer=Math.max(Number(left.travelBufferMinutes)||0,Number(right.travelBufferMinutes)||0,window);
  const days=Math.ceil(buffer/1440);
  return rightEnd>=addDays(left.date,-days)&&right.date<=addDays(leftEnd,days);
}

function jobWarnings(job, jobs, resources, roster, inspection=scheduleInspection(jobs,resources,roster)) {
  const warnings = [], add = (code, message, extra = {}) => warnings.push({ code, jobId: job.id, message, ...extra });
  if (job.fieldExecution?.attention?.status === 'open') add('needs_follow_up',job.fieldExecution.attention.reason || 'The crew flagged this job for management follow-up.');
  if (['pending','error','blocked'].includes(job.fieldCompletionSync?.status)) add(`completion_sync_${job.fieldCompletionSync.status}`,String(job.fieldCompletionSync.message || 'Work completion is saved; the CRM completion handoff needs confirmation.').slice(0,600));
  if (!activeJob(job)) return warnings;
  if (['paused','waiting','delayed'].includes(fieldActivity(job))) add(`job_${fieldActivity(job)}`,job.fieldExecution.activityReason || `The crew reported this job as ${fieldActivity(job)}.`);
  const interval = inspection.interval(job), crew = inspection.crew(job), rows = jobSegments(job);
  if (!interval) add(job.date ? 'invalid_schedule' : 'unscheduled', job.date ? 'The saved date or time needs review.' : 'This job has no scheduled time.');
  if (segmentsInvalid(job)) add('segments_invalid', 'The saved crew segments could not be read, so the whole job time and crew stay reserved. Open the job and save one job-level time and crew.');
  if (job.type !== 'blocked') {
  if (!String(job.address || '').trim()) add('missing_address', 'Add the job address before dispatching the crew.');
  if (!job.customerId) add('missing_customer_link', 'This legacy job needs its canonical customer link reviewed.');
  if (!String(scopeText(job)).trim()) add('missing_scope', 'Add the work scope so the crew knows what was sold.');
  if (!crew.length) add('unassigned', 'No employees are assigned.');
  // AUTH-ROLES: a sale saved by someone who cannot assign crew waits in To schedule for a manager.
  if (!crew.length && isObject(job.soldNeedsCrew)) add('sold_needs_crew', 'Sold: needs crew. A manager assigns the crew in Dispatch.');
  const short = enforced(crewSizeShort(job,crew.length,inspection.rules.settings),inspection.rules.enforce);
  if (short) warnings.push(short);
  if (crew.some(id => !roster.some(person => person.id === id))) add('inactive_assignment', 'An assigned employee is no longer in the active roster.');
  for (const row of rows) {
    const where = row.segmentId ? { segmentId: row.segmentId } : {}, rowCrew = inspection.crew(row);
    if (row.segmentId && !rowCrew.length) add('segment_unassigned', 'No employees are assigned to this segment.', where);
    if (rowCrew.length > 1 && !row.crewLead) add('missing_crew_lead', row.segmentId ? 'Choose a crew lead for this segment.' : 'Choose a crew lead for this assignment.', where);
    if (row.vehicleId && resources.find(resource => resource.id === row.vehicleId)?.status !== 'available') add('vehicle_unavailable', 'The assigned vehicle is unavailable or missing.', where);
  }
  if (job.syncStatus === 'pending' || job.syncStatus === 'error') add('provider_sync_pending', 'The Hub schedule is saved; the HighLevel mirror still needs confirmation.');
  const rules = inspection.rules;
  if (!rules.index && (rules.settings.maxJobsPerEmployeePerDay || rules.settings.maxHoursPerEmployeePerDay)) rules.index = capacityIndex(inspection.rows,inspection.crew,inspection.interval);
  warnings.push(...ruleWarnings(job,rows,{crew:inspection.crew,interval:inspection.interval,roster,settings:rules.settings,index:rules.index,enforce:rules.enforce}));
  }
  if (!interval) return warnings;
  // Each segment is checked against every other job's segments; segments of
  // this job were validated against each other when they were saved.
  for (const row of rows) {
  const rowInterval = inspection.interval(row), rowCrew = inspection.crew(row), where = row.segmentId ? { segmentId: row.segmentId } : {};
  if (!rowInterval) { add('invalid_schedule', 'An assignment segment needs its date or time reviewed.', where); continue; }
  for (const other of inspection.neighbors(row)) {
    if (other.id === job.id || !potentiallyNear(row,other,inspection.travelWindow)) continue;
    const shared = rowCrew.filter(id => inspection.crew(other).includes(id));
    const vehicle = row.vehicleId && row.vehicleId === other.vehicleId, pair = { ...where, ...(other.segmentId ? { otherSegmentId: other.segmentId } : {}) };
    if (!sharedScheduleResources(row,other,roster)) continue;
    const otherInterval = inspection.interval(other);
    if (!otherInterval) {
      // An existing dated assignment with malformed times cannot be treated as
      // free capacity. Undated work is intentionally a schedulable backlog.
      if (scheduleRowsConflict(row,other,roster)) add('unverifiable_assignment','Another assignment for this employee or vehicle has invalid times. Repair that schedule before assigning overlapping dates.',{otherJobId:other.id,employeeIds:shared,vehicleId:vehicle ? row.vehicleId : null,...pair});
      continue;
    }
    if (overlaps(rowInterval, otherInterval)) add('schedule_overlap', 'This job overlaps another assignment.', { otherJobId: other.id, employeeIds: shared, vehicleId: vehicle ? row.vehicleId : null, ...pair });
    else {
      const earlier = rowInterval.end <= otherInterval.start ? row : other;
      const later = earlier === row ? other : row;
      const gap = rowInterval.end <= otherInterval.start ? (otherInterval.start - rowInterval.end) / 60000 : (rowInterval.start - otherInterval.end) / 60000;
      const buffer = Math.max(Number(earlier.travelBufferMinutes) || 0, Number(later.travelBufferMinutes) || 0);
      const estimate = inspection.travel(earlier,later), required = Math.max(buffer, estimate?.minutes || 0);
      if (required && gap < required && estimate?.source !== 'same_property' && assignmentKey(earlier.address) !== assignmentKey(later.address)) add('travel_buffer_short', estimate?.minutes > buffer ? `Only ${gap} minutes between jobs; about ${estimate.minutes} minutes of driving is estimated.` : `Only ${gap} minutes between jobs; ${buffer} minutes were requested for travel.`, { otherJobId: other.id, gapMinutes: gap, requiredMinutes: required,
        ...(estimate ? { bufferMinutes: buffer, estimatedMinutes: estimate.minutes, estimateSource: estimate.source, ...(inspection.blockTravelShort && gap < estimate.minutes ? { blocking: true } : {}) } : {}), ...pair });
    }
  }
  for (const {block,person,interval:blockInterval} of inspection.availability(row)) {
    if (blockInterval ? overlaps(rowInterval,blockInterval) : scheduleRowsConflict(row,block,roster)) add('employee_unavailable', 'An assigned employee has unavailable time or time off with invalid dates during this job.', { employeeId: person, availabilityId: block.id, ...where });
  }
  }
  return warnings;
}

// FIX-DISPATCH-READY: what only the Hub's GET /api/dispatch (options.readiness) tells its page. notifyImportedOn
// (EGC_DISPATCH_NOTIFY_IMPORTED_ON) preselects an imported Jobber job's reminders in the Edit dialog; ghlTagRetry says
// whether this viewer may press the HighLevel chip's Retry (POST /api/ghl-tag-drain needs dispatch.write).
const readinessFlags = (store, ready) => ({ ...(store.notifyImportedOn === true ? { notifyImportedOn: true } : {}), ghlTagRetry: ready.ghlTagRetry === true });

// options.authorize (dispatch-booking.js) lets a schedule.book holder read the board.
export async function dispatchOverview(store, session, query = {}, now = new Date(), options = {}) {
  (options.authorize || requireDispatcher)(session);
  if (query.view === 'job') {
    if (!safeId(query.jobId)) throw fail('dispatch_job_not_found','Choose a valid job.',404);
    const found = store.read('jobs',query.jobId);
    const [job,jobs,resources,roster,settings,rules] = await Promise.all([found,jobsForWindow(store,async () => rowsWindow([await found],now),'job'),store.resources(),store.roster(),store.settings ? store.settings() : {},dispatchRuleSettings(store)]);
    if (!visibleJob(job)) throw fail('dispatch_job_not_found','This operational job could not be found.',404);
    const inspection=await withTravel(scheduleInspection(jobs,resources,roster,rules),[job],roster,options.travel);
    if(rules.blockTravelShort&&options.travel?.enabled)inspection.blockTravelShort=true;
    // FIX-DISPATCH-READY: reminder readiness, and price and deposit readiness for a dispatcher, only when the Hub's own
    // GET /api/dispatch asks (options.readiness; it adds ghlTags too, from the same outbox read); the signed bridge and
    // other callers read the board as before, without readiness, notifyImportedOn or ghlTagRetry.
    const projected=[projectDispatchJob(job,roster,new Date(now).toISOString())];
    const ready=options.readiness===true?await withDispatchReadiness(store,session,[job],projected,now):{jobs:await withGhlTagStatus(store,projected,now),warnings:[]};
    return {ok:true,job:ready.jobs[0],...(store.ghlTagOutbox===true?{ghlTagOutbox:true}:{}),...(options.readiness===true?readinessFlags(store,ready):{}),roster,crews:resources.filter(row=>row.recordType==='crew'),vehicles:resources.filter(row=>row.recordType==='vehicle'),warnings:[...jobWarnings(job,jobs,resources,roster,inspection),...ready.warnings],arrivalDefaults:arrivalDefaults(effectiveArrivalSettings(settings,rules)),segments:{enabled:store.segmentsEnabled===true,max:SEGMENT_LIMIT},dispatchRules:dispatchRulesView(rules)};
  }
  if (query.view === 'customers') {
    const needle = text(query.q || '', 'Search', 200).toLowerCase(), digits = needle.replace(/\D/g, '');
    const matches = await searchCustomers(store, query.q || '', customer => !needle || [customer.name, customer.firstName, customer.lastName, customer.phone, customer.email, customer.address].some(value => String(value || '').toLowerCase().includes(needle)) || digits.length >= 3 && String(customer.phone || '').replace(/\D/g,'').includes(digits));
    return { ok: true, customers: matches.slice(0,50).map(customer => ({ id: customer.id, name: customer.name || [customer.firstName,customer.lastName].filter(Boolean).join(' '), phone: customer.phone || '', email: customer.email || '', address: customer.address || '', crmLinked: Boolean(customer.highlevelContactId) })), total: matches.length };
  }
  const startDate = query.startDate || denverToday(now), endDate = query.endDate || addDays(startDate,7);
  if (!validDate(startDate) || !validDate(endDate) || startDate >= endDate || Date.parse(endDate) - Date.parse(startDate) > 93 * 86400000) throw fail('dispatch_range_invalid', 'Choose a valid date range of up to 93 days. The end date is exclusive.');
  const [jobs, resources, roster, settings, rules] = await Promise.all([jobsForWindow(store, { startDate, endDate }, 'board'), store.resources(), store.roster(), store.settings ? store.settings() : {}, dispatchRuleSettings(store)]);
  const includeUnscheduled = query.includeUnscheduled === true || query.includeUnscheduled === 'true';
  const selected = jobs.filter(visibleJob).filter(job => !job.date ? includeUnscheduled : !validDate(job.date) || job.endDate && (!validDate(job.endDate) || job.endDate < job.date) || job.date < endDate && (job.endDate || job.date) >= startDate);
  selected.sort((a,b) => String(a.date || '9999').localeCompare(String(b.date || '9999')) || String(a.time || '').localeCompare(String(b.time || '')) || a.id.localeCompare(b.id));
  const [inspection,withLines]=await Promise.all([withTravel(scheduleInspection(jobs,resources,roster,rules),selected,roster,options.travel),withQuoteLines(store,selected)]);
  if(rules.blockTravelShort&&options.travel?.enabled)inspection.blockTravelShort=true;
  const projected = withLines.map(job=>projectDispatchJob(job,roster,new Date(now).toISOString()));
  const ready = options.readiness === true ? await withDispatchReadiness(store,session,selected,projected,now) : { jobs: await withGhlTagStatus(store,projected,now), warnings: [] };
  // FIX-DISPATCH-QUEUE: the Hub's To schedule rows (dispatch-queue.js) come with readiness, with queueFacts:true saying the queued
  // jobs are exactly those that carry queue facts; the signed bridge never gets them.
  return { ok: true, timeZone: DISPATCH_TIME_ZONE, startDate, endDate, jobs: options.readiness === true ? withQueueFacts(selected, ready.jobs, now) : ready.jobs, ...(options.readiness === true ? { queueFacts: true } : {}), ...(store.ghlTagOutbox===true?{ghlTagOutbox:true}:{}), ...(options.readiness === true ? readinessFlags(store,ready) : {}), roster,
    crews: resources.filter(row => row.recordType === 'crew'), vehicles: resources.filter(row => row.recordType === 'vehicle'),
    availability: resources.filter(row => row.recordType === 'availability').concat(jobs.filter(row => row.type === 'availability' || row.recordType === 'crew_availability').map(row => ({ ...row, employeeId: resolveMember(row.employee,roster,true) || row.employee }))).filter(row => row.date < endDate && (row.endDate || row.date) >= startDate),
    warnings: [...selected.flatMap(job => jobWarnings(job, jobs, resources, roster,inspection)),...ready.warnings], coverage: { complete: true, asOf: now.toISOString() }, arrivalDefaults: arrivalDefaults(effectiveArrivalSettings(settings,rules)), segments: { enabled: store.segmentsEnabled === true, max: SEGMENT_LIMIT }, dispatchRules: dispatchRulesView(rules) };
}

const SCHEDULE_KEYS = ['date','time','endDate','endTime','assignedCrew','crewLead','crewId','vehicleId','crewNeeded','travelBufferMinutes','title','address','serviceType','jobInstructions','accessInstructions','customerInstructions','opsNotes','requiredEquipment','materials','recurrence','reminderDays','notify','shiftPickupEnabled','notes','arrivalWindowStart','arrivalWindowEnd','assignmentSegments','estimatedDurationMin','requiredSkills'];
function schedulePatch(changes, current, resources, roster, now, actor, segmentsOn = false) {
  onlyKeys(changes, SCHEDULE_KEYS);
  const patch = {};
  let plan;
  if ('assignmentSegments' in changes) {
    // Clearing a saved split stays possible with the flag off, so turning the
    // flag off never strands a segmented job.
    if (!segmentsOn && !(Array.isArray(changes.assignmentSegments) && !changes.assignmentSegments.length && segmented(current))) throw fail('dispatch_segments_disabled','Assignment segments are turned off for this Hub. Save one job-level time and crew instead.');
    plan = validateSegments(changes.assignmentSegments,{roster,resources});
    if (plan && SEGMENT_HULL_KEYS.some(key => key in changes)) throw fail('dispatch_segments_hull_derived','The job schedule and crew come from its segments. Send either segments or job-level times and crew, not both.');
  } else if (segmented(current) && SEGMENT_HULL_KEYS.some(key => key in changes)) throw fail('dispatch_segments_hull_derived','This job is split into assignment segments. Edit its segments, or clear them to set one job-level time and crew.');
  for (const key of ['date','time','endDate','endTime']) if (key in changes) patch[key] = text(changes[key], key, 10);
  if ('date' in changes && !('endDate' in changes)) {
    const span = validDate(current?.date) && validDate(current?.endDate) ? Math.round((Date.parse(current.endDate) - Date.parse(current.date)) / 86400000) : 0;
    patch.endDate = changes.date ? addDays(changes.date,span) : '';
  }
  for (const key of ['title','address','serviceType','accessInstructions','customerInstructions','opsNotes','notes']) if (key in changes) patch[key] = text(changes[key], key, ['title','address','serviceType'].includes(key) ? 500 : 8000);
  if ('address' in patch && current?.propertyId && !sameOperationalProperty({address:current.address},{address:patch.address})) patch.propertyId=null;
  if ('recurrence' in changes) {
    if (!['none','weekly','biweekly','monthly','quarterly'].includes(changes.recurrence)) throw fail('dispatch_recurrence_invalid','Choose a supported repeat interval.');
    patch.recurrence=changes.recurrence;
  }
  if ('reminderDays' in changes) patch.reminderDays=integer(changes.reminderDays,'Reminder days',1,30);
  for (const key of ['notify','shiftPickupEnabled']) if (key in changes) {
    if (typeof changes[key] !== 'boolean') throw fail('dispatch_invalid_field',`${key} must be true or false.`);
    patch[key]=changes[key];
  }
  if ('jobInstructions' in changes) patch.operationalScope={text:text(changes.jobInstructions,'Work scope',20000),updatedBy:actor,updatedAt:now,reason:'Updated in dispatch',approvalKind:'staff_operational_instructions'};
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
  if ('requiredSkills' in changes) {
    patch.requiredSkills = validateRequiredSkills(changes.requiredSkills,current?.requiredSkills);
    if (!patch.requiredSkills) throw fail('dispatch_skills_invalid','Choose required skills from the staff skill catalog.');
  }
  if ('estimatedDurationMin' in changes) {
    // A saved length outranks the quote lines for the crew it was set for; null clears it.
    const minutes = changes.estimatedDurationMin === null ? null : integer(changes.estimatedDurationMin,'Expected duration (minutes)',ESTIMATED_DURATION_MIN.min,ESTIMATED_DURATION_MIN.max);
    Object.assign(patch,{estimatedDurationMin:minutes,durationOverride:minutes === null ? null : dispatchDurationOverride(minutes,dispatchCrewSize({...current,...patch}),actor,now)});
  }
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
  if (plan) Object.assign(patch,plan.hull,{assignmentSegments:plan.segments});
  else if (plan === null && segmented(current)) patch.assignmentSegments = null;
  const next = { ...current, ...patch }, crew = legacyMembers(next,roster);
  if (next.crewLead && !crew.includes(assignmentKey(next.crewLead))) throw fail('dispatch_lead_not_assigned','The crew lead must be one of the assigned employees.');
  if (next.vehicleId && !resources.some(row => row.recordType === 'vehicle' && row.id === next.vehicleId && row.status === 'available')) throw fail('dispatch_vehicle_unavailable','This vehicle is unavailable. Choose an available vehicle or remove its assignment.');
  if (('assignedCrew' in changes || 'crewId' in changes) && crew.some(id => !roster.some(person => person.id === id))) throw fail('dispatch_employee_inactive','Choose employees from the active roster.');
  return patch;
}

// Each schedule row's effective start, end and crew (plus `extra`), in a stable order.
function placement(job,roster,extra=()=>null) {
  return jobSegments(job).map(row=>{const at=scheduleInterval(row);return canonical([at?.startAt||null,at?.endAt||null,legacyMembers(row,roster).sort(),extra(row)]);}).sort();
}

function conflictCheck(next, jobs, resources, roster,inspection,applies = () => true,message = 'This change conflicts with scheduled work or employee availability. Choose a different time, crew, or vehicle.') {
  if (!activeJob(next) || !scheduleInterval(next)) return;
  const conflicts = jobWarnings(next,jobs,resources,roster,inspection).filter(warning => ['schedule_overlap','employee_unavailable','unverifiable_assignment'].includes(warning.code) || warning.blocking === true && applies(warning));
  if (conflicts.length) throw fail('dispatch_conflict',message,409,{ conflicts });
}

function auditState(job) {
  return Object.fromEntries(['date','time','endDate','endTime','status','pipelineStatus','assignedCrew','assignedTo','crewId','crewLead','vehicleId','jobInstructions','operationalScope','accessInstructions','customerInstructions','opsNotes','requiredEquipment','materials','crewNeeded','travelBufferMinutes','title','address','serviceType','name','memberIds','leadId','notes','employeeId','allDay','reason','recurrence','reminderDays','notify','shiftPickupEnabled','openShift','sourceTemplateJobId','recurrenceParentId','cancellationReason','arrivalWindowStart','arrivalWindowEnd','arrivalWindow','assignmentSegments','visitPurpose','reworkOfJobId','membershipId','bookingChannel','channelSelfReported','crmLinkReason','scheduleOccurrence','cancellationReasonCode','cancellationInitiatedBy','lateCancel','noShowReasonCode','estimatedDurationMin','durationOverride','requiredSkills'].filter(key => job?.[key] !== undefined).map(key => [key,job[key]]));
}

// options.authorize replaces requireDispatcher only for server-built inputs
// (walkthrough handoffs and quote drafts run by a verified quote author) and for
// a booker's input that mutateBooking (dispatch-booking.js) has checked, and
// options.enforce(warning) lets such a caller keep an owner rule a warning.
export async function mutateDispatch(store, session, input, now = new Date().toISOString(), options = {}) {
  (options.authorize || requireDispatcher)(session);
  try { return await executeDispatch(store,session,input,now,options); }
  catch (error) {
    // Another copy of the same request may commit between our initial receipt
    // read and any later validation read, not merely during the final commit.
    if (!['dispatch_changed_since_operation','dispatch_idempotency_conflict'].includes(error.code) && /^[a-f0-9-]{36}$/i.test(input?.requestId || '')) {
      const receipt = await store.read('dispatchOperations',input.requestId.toLowerCase()).catch(() => null);
      if (receipt?.fingerprint === await digest({actor:session.user,input})) return executeDispatch(store,session,input,now,options);
    }
    throw error;
  }
}

async function executeDispatch(store, session, input, now, options = {}) {
  (options.authorize || requireDispatcher)(session);
  if (!isObject(input) || !DISPATCH_ACTIONS.includes(input.action) || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(input.requestId || '')) throw fail('dispatch_request_invalid','Use a supported dispatch action with a unique request ID.');
  onlyKeys(input,['action','requestId','customerId','kind','sourceWalkthroughId','sourceTemplateJobId','sourceJobId','jobId','id','expectedRevision','changes','cancellationReason','booking','reasonCode','initiatedBy']);
  if ('cancellationReason' in input && input.action !== 'schedule.cancel') throw fail('dispatch_cancel_patch_invalid','A cancellation reason can only be saved when cancelling a job.');
  // FUN-02: booking facts on a customer visit create; a reason on a move, cancel or no-show.
  if ('booking' in input && (input.action !== 'schedule.create' || input.kind === 'blocked')) throw fail('dispatch_booking_invalid','Booking details can only be saved when creating a customer visit.');
  if (('reasonCode' in input || 'initiatedBy' in input) && !REASON_LISTS[input.action]) throw fail('dispatch_reason_code_invalid','A reason can only be saved when moving, cancelling or marking a no-show.');
  const reason = REASON_LISTS[input.action] ? reasonInput(input,REASON_LISTS[input.action],funnelFail) : {reasonCode:null,initiatedBy:null};
  if (input.action === 'schedule.no_show' && !reason.reasonCode) throw fail('dispatch_reason_code_required','Choose why the visit did not happen.');
  if ((input.sourceWalkthroughId || input.sourceTemplateJobId || input.sourceJobId) && input.action !== 'schedule.create') throw fail('dispatch_handoff_invalid','A source record can only be selected when creating a job.');
  if(input.sourceJobId&&input.sourceTemplateJobId&&input.sourceJobId!==input.sourceTemplateJobId)throw fail('dispatch_lineage_invalid','Choose one explicit source job for customer account ownership.');
  if(input.sourceJobId&&input.kind!=='job')throw fail('dispatch_lineage_invalid','Customer account lineage can only be chosen for an operational job.');
  if (input.sourceWalkthroughId && input.sourceTemplateJobId) throw fail('dispatch_handoff_invalid','Choose either a walkthrough or a recurring job template.');
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
  const reads = saveJobReads(store);
  const [resources,roster,,rules] = await Promise.all([store.resources(),store.roster(),reads.all,dispatchRuleSettings(store)]);
  let collection, id, current, patch, warnings = [], writes = [], providerSync = 'not_needed', fieldTimeSegment = null, lineage = null;
  if (input.action.startsWith('schedule.')) {
    collection = 'jobs';
    // A no-show closes the visit like a cancellation, without a provider appointment change.
    const create = input.action === 'schedule.create', noShow = input.action === 'schedule.no_show', cancel = input.action === 'schedule.cancel' || noShow, restore = input.action === 'schedule.restore';
    let booking = null, rework = null, dimensionContext = null;
    if (create) {
      if (input.kind === 'blocked') {
        if (input.customerId || input.sourceWalkthroughId || input.sourceTemplateJobId || input.sourceJobId) throw fail('dispatch_block_invalid','A company-wide scheduling block cannot have a customer or source job.');
        id=`block_${receiptId.replaceAll('-','')}`;
        current=null;
        patch={id,type:'blocked',title:'Unavailable',date:'',time:'',endDate:'',endTime:'',assignedCrew:[],assignedTo:'',status:'scheduled',pipelineStatus:'scheduled',createdAt:now,createdBy:session.user,scheduleSource:'egc_hub'};
      } else {
      if (!safeId(input.customerId) || !['job','walkthrough'].includes(input.kind)) throw fail('dispatch_customer_required','Select an existing customer and job type before creating work.');
      const customer = await store.read('customers',input.customerId);
      if (!customer) throw fail('dispatch_customer_not_found','This customer no longer exists. Search again.',404);
      booking = bookingInput(input.booking,input.kind,funnelFail);
      if (booking.reworkOfJobId) {
        if (input.sourceWalkthroughId || input.sourceTemplateJobId) throw fail('dispatch_booking_rework_invalid','A rework visit is booked from the original job, not from a walkthrough or a repeat template.');
        rework = await store.read('jobs',booking.reworkOfJobId);
        if (!rework || !['job','cleanout','reorg'].includes(rework.type) || rework.recordType || rework.customerId !== customer.id) throw fail('dispatch_booking_rework_invalid','The reworked job must be an operational job for this customer.',409);
      }
      const changes = input.changes || {};
      // A split job is keyed by its first segment's start (the hull), like one visit.
      const start = store.segmentsEnabled === true && Array.isArray(changes.assignmentSegments) && changes.assignmentSegments.length ? validateSegments(changes.assignmentSegments,{roster,resources}).hull : changes;
      const bookingKey = start.date && start.time ? await digest({ customerId: customer.id, kind: input.kind, date: start.date, time: start.time, timeZone: DISPATCH_TIME_ZONE }) : null;
      id = bookingKey ? `visit_${bookingKey.slice(0,40)}` : `dispatch_${receiptId.replaceAll('-','')}`;
      if (await store.read('jobs',id) || start.date && (await reads.where('customerId',customer.id)).some(job => visibleJob(job) && job.customerId === customer.id && (job.type === 'walkthrough' ? 'walkthrough' : 'job') === input.kind && job.date === start.date && job.time === start.time)) throw fail('dispatch_job_already_exists','This customer already has that visit at the selected time. Open the existing job.',409);
      let source = null, template = null;
      if (input.sourceTemplateJobId) {
        if (!safeId(input.sourceTemplateJobId) || input.kind !== 'job') throw fail('dispatch_template_invalid','Choose an existing job to repeat.');
        template=await store.read('jobs',input.sourceTemplateJobId);
        if (!template || !['job','cleanout','reorg'].includes(template.type) || template.recordType || template.customerId !== customer.id) throw fail('dispatch_template_invalid','The recurring template must be an operational job for this customer.',409);
        if (template.highlevelContactId && customer.highlevelContactId && template.highlevelContactId !== customer.highlevelContactId) throw fail('dispatch_contact_link_conflict','The template and customer point to different CRM contacts. Correct that link before repeating work.',409);
      }
      if (input.sourceWalkthroughId) {
        if (!safeId(input.sourceWalkthroughId) || input.kind !== 'job') throw fail('dispatch_handoff_invalid','Select a valid source walkthrough for this job.');
        source = await store.read('jobs',input.sourceWalkthroughId);
        if (!source || source.type !== 'walkthrough' || source.customerId !== customer.id) throw fail('dispatch_handoff_invalid','The source walkthrough must belong to this customer.',409);
        if (source.highlevelContactId && customer.highlevelContactId && source.highlevelContactId !== customer.highlevelContactId) throw fail('dispatch_contact_link_conflict','The source walkthrough and customer point to different CRM contacts. Correct that link before creating an operational job.',409);
        if ((await reads.where('sourceWalkthroughId',source.id)).some(job => visibleJob(job) && job.sourceWalkthroughId === source.id)) throw fail('dispatch_handoff_exists','This walkthrough already has an operational job. Open that job instead.',409);
      }
      const sourceFields = ['jobInstructions','operationalScope','accessInstructions','customerInstructions','requiredEquipment','materials','serviceType','reviewedWalkthroughScope','salesNotes','customerNotes','estimate'];
      current = null;
      patch = { ...(source ? Object.fromEntries(sourceFields.filter(key => source[key] !== undefined).map(key => [key,source[key]])) : {}),
        id, type: input.kind, customerId: customer.id, customer: customer.name || [customer.firstName,customer.lastName].filter(Boolean).join(' '),
        phone: customer.phone || '', email: customer.email || '', address: source?.address || customer.address || '', highlevelContactId: source?.highlevelContactId || customer.highlevelContactId || '',
        date: '', time: '', endDate: '', endTime: '', assignedCrew: [], assignedTo: '', crewLead: null, crewId: null, vehicleId: null, crewNeeded: 1, travelBufferMinutes: rules.defaultTravelBufferMinutes,
        status: 'unscheduled', pipelineStatus: 'unscheduled', createdAt: now, createdBy: session.user, scheduleSource: 'egc_hub',
        ...(bookingKey ? { bookingKey } : {}), ...(source ? { sourceWalkthroughId: source.id } : {}),
        ...(template ? {...recurringTemplateFields(template,session.user,now),sourceTemplateJobId:template.id,sourceTemplateRevision:template.revision,recurrenceParentId:template.recurrenceParentId || template.id,address:template.address || customer.address || ''} : {}),
        ...(source?.propertyId || template?.propertyId ? {propertyId:source?.propertyId || template.propertyId} : {}),
      };
      // A rework visit joins the project of the job it reworks (a stored link is used only when it is a valid Hub id).
      if (rework?.projectId && !safeId(rework.projectId)) throw fail('dispatch_booking_rework_invalid','The reworked job has a project link that needs review before a rework visit can join it.',409);
      const origin = source || rework, projectId = origin?.projectId || `project_${safeId(rework?.sourceWalkthroughId) ? rework.sourceWalkthroughId : origin?.id || id}`;
      const project = await store.read('projects',projectId);
      if (project && project.customerId !== customer.id) throw fail('dispatch_project_conflict','The source project belongs to another customer. Review the link before creating a job.',409);
      patch.projectId = projectId;
      Object.assign(patch,bookingPatch(booking,{bookedBy:session.user,highlevelContactId:patch.highlevelContactId}));
      if (!project) writes.push({ collection:'projects', id:projectId, patch:{ id:projectId, customerId:customer.id, sourceRecordId:origin?.id || id, sourceWalkthroughId:source?.id || (input.kind === 'walkthrough' ? id : null), authority:'employee_hub',createdAt:now,updatedAt:now,createdBy:session.user,highlevelContactId:patch.highlevelContactId,crmLinkReason:patch.crmLinkReason,...(template?.projectId ? {previousProjectId:template.projectId} : {}) } });
      if (origin && !origin.projectId) writes.push({ collection:'jobs',id:origin.id,revision:origin.revision,patch:{ projectId, updatedAt:now } });
      dimensionContext = { project, projectWrite: project ? null : writes.find(write => write.collection === 'projects' && write.id === projectId), template };
      }
    } else {
      id = input.jobId;
      if (!safeId(id)) throw fail('dispatch_job_not_found','Choose a valid job.',404);
      current = await store.read('jobs',id);
      if (!current || !visibleJob(current)) throw fail('dispatch_job_not_found','This operational job could not be found.',404);
      if (!input.expectedRevision || current.revision !== input.expectedRevision) throw fail('dispatch_revision_conflict','This job changed while you were editing. Refresh and review its latest details.',409);
      if (restore ? !['cancelled','canceled'].includes(state(current)) : TERMINAL.has(state(current))) throw fail('dispatch_terminal_job','This job cannot be changed in its current state. Cancelled jobs can be explicitly restored; completed work keeps its history.',409);
      if (input.customerId && input.customerId !== current.customerId) throw fail('dispatch_customer_immutable','Customer identity cannot be changed in dispatch.',409);
      const missed = noShow ? noShowProblem(current,now) : null;
      if (missed) throw fail(`dispatch_${missed}`,{no_show_too_early:'A no-show can be recorded from one hour before the scheduled start.',no_show_walkthrough:'Record a walkthrough no-show from the walkthrough visit itself.'}[missed] || 'Only a scheduled customer job can be marked as a no-show.',409);
      patch = {};
    }
    if (cancel && Object.keys(input.changes || {}).length) throw fail('dispatch_cancel_patch_invalid','Cancellation cannot also edit job details.');
    if ((current || patch).type === 'blocked') onlyKeys(input.changes || {},['date','time','endDate','endTime','title','opsNotes','notes']);
    if (!cancel) Object.assign(patch,schedulePatch(input.changes || {},current || patch,resources,roster,now,session.user,store.segmentsEnabled === true));
    if (current && 'assignedCrew' in patch) {
      const retained=value=>patch.assignedCrew.includes(resolveMember(value?.employee || value,roster,true));
      if (Array.isArray(current.shiftClaims)) patch.shiftClaims=current.shiftClaims.filter(retained);
      if (current.lastShiftClaim && !retained(current.lastShiftClaim)) patch.lastShiftClaim=null;
    }
    let next = { ...current, ...patch };
    if(create&&next.type==='job') {
      lineage=await resolveDispatchLineage(store,{customerId:next.customerId,jobs:await reads.where('customerId',next.customerId),address:next.address,propertyId:next.propertyId,sourceJobId:input.sourceTemplateJobId||input.sourceJobId});
      Object.assign(patch,lineage.patch);next={...next,...lineage.patch};
    }
    const hasSchedule = Boolean(next.date || next.time || next.endDate || next.endTime), interval = scheduleInterval(next);
    if (!cancel && hasSchedule && !interval) throw fail('dispatch_time_invalid','Choose valid Denver start and end times within 31 days. Missing or repeated DST hours cannot be scheduled.');
    if (!cancel && next.type === 'blocked' && !interval) throw fail('dispatch_block_invalid','A company-wide scheduling block needs valid start and end times.');
    // FIX-DISPATCH-READY: when Notify customer was last set; an imported Jobber job's first booking turns it on (EGC_DISPATCH_NOTIFY_IMPORTED_ON).
    if (!create && !cancel && next.type !== 'blocked') { const notify = notifyPatch(current,input.changes || {},next,now,{importedOn:store.notifyImportedOn === true}); Object.assign(patch,notify); next = {...next,...notify}; }
    // FIX-DISPATCH-QUEUE: the first save that books work waiting in To schedule clears its review flag (dispatch-queue.js).
    if (!cancel) Object.assign(patch,dispatchReviewCleared(current,interval,session.user,now));
    if (!cancel && !hasSchedule && current?.highlevelAppointmentId) throw fail('dispatch_linked_unschedule_unsupported','A provider-linked appointment must be rescheduled or cancelled, not cleared.');
    const arrival = cancel || next.type === 'blocked' ? null : arrivalWindowPatch(current,next,input.changes || {},effectiveArrivalSettings(store.settings ? await store.settings() : {},rules));
    if (arrival) Object.assign(patch,arrival.patch);
    if (create || restore) Object.assign(patch,{ status:interval ? 'scheduled' : 'unscheduled',pipelineStatus:interval ? 'scheduled' : 'unscheduled' });
    if (!create && !restore && !cancel && state(current) === 'unscheduled' && interval) Object.assign(patch,{status:'scheduled',pipelineStatus:'scheduled'});
    if (!cancel && !interval && !create && state(current) === 'scheduled') Object.assign(patch,{status:'unscheduled',pipelineStatus:'unscheduled'});
    if (noShow) Object.assign(patch,{status:'no_show',pipelineStatus:'no_show',noShowAt:now,noShowBy:session.user,noShowReasonCode:reason.reasonCode});
    else if (cancel) Object.assign(patch,{status:'cancelled',pipelineStatus:'cancelled',cancelledAt:now,cancelledBy:session.user,cancellationReason:text(input.cancellationReason || '','Cancellation reason',240),...cancelPatch(reason,current,now)});
    if (restore) Object.assign(patch,{cancelledAt:null,cancelledBy:null,restoredAt:now,restoredBy:session.user});
    if ((cancel || restore) && current?.fieldExecution?.jobTime) {
      const safeInstant=value=>typeof value==='string'&&/^\d{4}-\d\d-\d\dT/.test(value)&&Number.isFinite(Date.parse(value));
      const hasCancellationTime=safeInstant(current.cancelledAt);
      // Old cancelled records may predate the timer hook. Never count their
      // cancelled gap as work just because a manager restores them today.
      const stoppedAt=restore ? hasCancellationTime ? current.cancelledAt : safeInstant(current.fieldExecution.jobTime.current?.startedAt) ? current.fieldExecution.jobTime.current.startedAt : now : now;
      const stopped=advanceFieldTime(current,null,session,input.requestId,stoppedAt);
      if(restore&&!hasCancellationTime&&stopped.clock)stopped.clock={...stopped.clock,needsReview:true};
      if(stopped.clock)patch.fieldExecution={...current.fieldExecution,jobTime:stopped.clock};
      fieldTimeSegment=stopped.segment;
    }
    Object.assign(patch,{updatedAt:now,updatedBy:session.user,dispatchUpdatedAt:now,dispatchRequestId:input.requestId,...(!cancel ? { startAt:interval?.startAt || null,endAt:interval?.endAt || null,timeZone:DISPATCH_TIME_ZONE } : {})});
    next = { ...current, ...patch };
    if (next.type !== 'blocked' && (create || cancel || restore || ['assignedCrew','crewNeeded','crewId','shiftPickupEnabled','date','time','endDate','endTime','assignmentSegments'].some(key=>key in patch))) {
      // Self-service pickup edits the job-level crew, so a segmented job is never an open shift.
      // The same predicate exempts the job from the crew-size and skill blocks (dispatch-rules.js).
      patch.openShift=offeredForPickup(next,legacyMembers(next,roster).length,interval);
      next={...next,...patch};
    }
    const scheduleChanged = create || (cancel && !noShow) || restore || ['date','time','endDate','endTime','title','address'].some(key => key in patch && patch[key] !== current?.[key]);
    if (scheduleChanged && current && (current.highlevelContactId || current.highlevelAppointmentId)) {
      const customer = current.customerId ? await store.read('customers',current.customerId) : null;
      if (!customer) throw fail('dispatch_customer_link_required','This provider-linked job needs its canonical customer linked before its appointment can be changed.',409);
      if (current.highlevelContactId && customer.highlevelContactId && current.highlevelContactId !== customer.highlevelContactId) throw fail('dispatch_contact_link_conflict','This job and customer point to different CRM contacts. Correct the link before changing its appointment.',409);
    }
    if (scheduleChanged && (next.highlevelContactId || next.highlevelAppointmentId) && (interval || next.highlevelAppointmentId)) {
      Object.assign(patch,{syncStatus:'pending',syncIdempotencyKey:input.requestId,providerSyncOwner:'operations'}); providerSync = 'pending';
    } else if (create) patch.syncStatus = 'not_needed';
    next = { ...current, ...patch };
    // Segments lock only their own days, one entry each (`${jobId}~${segmentId}`).
    const days = [...new Set([...segmentDays(current),...segmentDays(next)])].sort();
    for (const date of days) {
      const lockId = `_egc_schedule_lock_${date}`, lock = await store.read('jobs',lockId);
      if (lock && (lock.recordType !== 'schedule_lock' || !Array.isArray(lock.entries))) throw fail('dispatch_lock_unavailable','A scheduling guard needs review before this date can be changed.',503);
      const entries = (Array.isArray(lock?.entries) ? lock.entries : []).filter(entry => !ownsLockEntry(entry,id) && !TERMINAL.has(entry.status));
      if (activeJob(next) && segmentDays(next).includes(date)) entries.push(...segmentLockEntries(next,date,roster,now));
      writes.push({collection:'jobs',id:lockId,revision:lock?.revision,patch:{recordType:'schedule_lock',date,entries,updatedAt:now}});
    }
    // The older operations scheduler shares day locks but not dispatchState.
    // Read final conflict evidence AFTER acquiring each affected day revision;
    // either we see an older sender's job or its commit invalidates our lock.
    const finalJobs = days.length ? await jobsForWindow(store,{startDate:days[0],endDate:addDays(days.at(-1),1)},'save') : await reads.near(() => rowsWindow([current,next],new Date(now)));
    const inspection=await withTravel(scheduleInspection(finalJobs,resources,roster,rules),[next],roster,options.travel);
    if(rules.blockTravelShort&&options.travel?.enabled)inspection.blockTravelShort=true;
    // Effective values, so a full form re-sending a legacy row's defaults (an
    // endDate, assignedCrew for an assignedTo name, crewNeeded 1) is no change.
    const changed=read=>create||restore||canonical(read(current))!==canonical(read(next));
    // An existing drive shortfall blocks only a change that moves this stop.
    if(!changed(job=>[placement(job,roster,row=>row.vehicleId||null),String(job.address||'').trim(),job.propertyId||null]))inspection.blockTravelShort=false;
    // Likewise a blocking rule only stops a change to what that rule reads.
    if(!changed(job=>[placement(job,roster),job.crewNeeded||job.requiredCrewSize||1,requiredSkillsOf(job).sort(),job.shiftPickupEnabled===true]))inspection.rules.enforce=()=>false;
    // options.enforce (server-built saves and checked bookings only, e.g. a signed
    // handoff that leaves staffing to Dispatch) can keep a rule a warning; it never adds a block.
    else if(typeof options.enforce==='function')inspection.rules.enforce=warning=>options.enforce(warning)===true;
    conflictCheck(next,finalJobs,resources,roster,inspection);
    warnings = jobWarnings(next,finalJobs,resources,roster,inspection);
    const placed = create || restore || ['date','time','endDate','endTime'].some(key => key in patch && patch[key] !== current?.[key]) || 'assignmentSegments' in patch && canonical(patch.assignmentSegments) !== canonical(current?.assignmentSegments ?? null);
    const legacy = placed && activeJob(next) && next.type !== 'blocked' ? await legacyBlockedDays(store,segmentDays(next)) : null;
    if (legacy?.rows.length) {
      const blocked = legacy.rows.map(row => legacyBlockWarning(id,row));
      if (legacy.mode === 'enforce') throw fail('dispatch_conflict','This date is blocked on the Hub calendar. Unblock the day or choose another date.',409,{conflicts:blocked});
      warnings.push(...blocked);
    }
    if(lineage?.metadata&&!lineage.metadata.memoryAddressMatches)warnings.push({code:'customer_memory_not_inherited',jobId:id,message:'The verified customer account is linked, but this property does not match the selected account history. Property instructions remain specific to this job; review access and scope before dispatch.'});
    if(arrival?.reset)warnings.push({code:'arrival_window_reset',jobId:id,message:'The saved arrival window did not include the new start time and was cleared. Review the arrival window the customer sees.'});
    // FUN-02: the funnel events for this change commit with the visit and its receipt.
    const crewBefore = current ? legacyMembers(current,roster).sort() : [], crewAfter = legacyMembers(next,roster).sort();
    // FUN-29: the project's service line and funnel path, set at booking and refined only by better evidence.
    const dimensions = dimensionContext ? await bookingDimensions(store,{picks:booking,visit:next,...dimensionContext,facts:store.dimensionFacts,actor:session.user,now,writes}) : await firstPlacementDimensions(store,current,next);
    const funnel = await visitFunnelWrites({action:create ? 'create' : noShow ? 'no_show' : cancel ? 'cancel' : restore ? 'restore' : 'update',before:current,after:next,actor:eventActor({id:session.user,kind:'human',role:session.role}),via:'hub',key:requestKey(input.requestId),source:{collection:'dispatchOperations',id:receiptId},reason:{...reason,lateCancel:patch.lateCancel},crewChanged:!cancel && crewAfter.length > 0 && canonical(crewAfter) !== canonical(crewBefore),dimensions,now});
    Object.assign(patch,funnel.patch); writes.push(...funnel.writes);
    // EGC_GHL_TAG_OUTBOX (GHL-TRACK-1): the HighLevel tags this change needs commit with it, or not at all.
    const tags = store.ghlTagOutbox === true ? await scheduleTagWrites({jobId:id,before:current,after:{...current,...patch},action:input.action,requestId:input.requestId,now}) : null;
    if (tags) { patch.ghlTagEntry = tags.pointer; writes.push(tags.write); }
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
      // Only the segments this employee works can collide with their time off.
      const conflicts = (await reads.near(() => rowsWindow([next],new Date(now)),'availability')).filter(activeJob).flatMap(jobSegments).filter(row => legacyMembers(row,roster).includes(next.employeeId) && overlaps(scheduleInterval(row),availabilityInterval(next))).map(row => ({jobId:row.id,employeeId:next.employeeId,...(row.segmentId ? {segmentId:row.segmentId} : {})}));
      if (conflicts.length) warnings.push({code:'availability_conflicts',message:'Time off was saved. Reassign the affected jobs before dispatch.',conflicts});
    }
    if (recordType === 'vehicle' && next.status !== 'available') {
      // A split job has no job-level vehicle when its segments use different trucks.
      const today = denverToday(new Date(now)), affected = (await reads.near({startDate:today,endDate:addDays(today,1)},'vehicle')).filter(activeJob).flatMap(jobSegments).filter(row => row.vehicleId === id && (!scheduleInterval(row) || scheduleInterval(row).end > Date.parse(now))), split = affected.filter(row => row.segmentId);
      if (affected.length) warnings.push({code:'vehicle_assignments_need_review',message:'Vehicle availability was updated. Existing assignments need reassignment.',jobIds:[...new Set(affected.map(row => row.id))],...(split.length ? {segments:split.map(row => ({jobId:row.id,segmentId:row.segmentId}))} : {})});
    }
  }
  writes.push({collection,id,revision:current?.revision,patch});
  writes.push({collection:'dispatchState',id:'revision',revision:guard?.revision,patch:{updatedAt:now,lastRequestId:input.requestId}});
  writes.push({collection:'dispatchOperations',id:receiptId,patch:{fingerprint,actorId:session.user,action:input.action,collection,targetId:id,requestId:input.requestId,createdAt:now,before:current ? auditState(current) : null,after:auditState({...current,...patch}),warnings,...(fieldTimeSegment || lineage?.metadata ? {metadata:{...(fieldTimeSegment?{fieldTimeSegment}:{}),...(lineage?.metadata?{customerLineage:lineage.metadata}:{})}} : {})}});
  // EGC_CREW_NOTIFICATIONS_ENABLED: crew notices commit with the change and its receipt, or not at all.
  // A recurring-plan run names itself (store.crewNoticeBatch) so its new visits are one text per employee.
  if (collection === 'jobs' && store.crewNotificationsEnabled === true) writes.push(...await crewNotificationWrites({jobId:id,requestId:input.requestId,action:input.action,actorId:session.user,type:(current || patch).type,before:current ? auditState(current) : null,after:auditState({...current,...patch}),roster,now,batch:typeof store.crewNoticeBatch === 'string' ? store.crewNoticeBatch : '',baseRevision:current?.revision}));
  for(const check of lineage?.checks || []) {
    const write=writes.find(item=>item.collection===check.collection&&item.id===check.id);
    if(write&&write.revision!==check.revision)throw fail('dispatch_revision_conflict','The source job changed while its account ownership was verified. Refresh and retry.',409);
    if(!write)writes.push(check);
  }
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
export async function mutateDispatchSelfAssignment(store,session,input,now = new Date().toISOString(),options = {}) {
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
    const guard = await store.read('dispatchState','revision'), found = store.read('jobs',input.jobId), reads = saveJobReads(store);
    const [job,resources,roster,,rules] = await Promise.all([found,store.resources(),store.roster(),reads.all,dispatchRuleSettings(store)]);
    const identity = resolveMember(session.user,roster);
    if (!identity) throw fail('dispatch_employee_inactive','Your active employee account could not be verified. Sign in again before choosing a shift.',403);
    if (!job || !visibleJob(job)) throw fail('dispatch_job_not_found','This shift no longer exists.',404);
    if (input.expectedRevision && input.expectedRevision !== job.revision) throw fail('dispatch_revision_conflict','This shift changed. Refresh before choosing it.',409);
    if (job.type !== 'job' || job.shiftPickupEnabled !== true || TERMINAL.has(state(job)) || ['dispatched','arrived','in_progress','paused','waiting'].includes(state(job)) || segmented(job)) throw fail('dispatch_shift_closed','This shift is no longer available for pickup or release.',409);
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
    const writes = [{collection:'jobs',id:job.id,revision:job.revision,patch}];
    for (const date of occupiedDays(job)) {
      const id = `_egc_schedule_lock_${date}`,lock = await store.read('jobs',id);
      if (lock && (lock.recordType !== 'schedule_lock' || !Array.isArray(lock.entries))) throw fail('dispatch_lock_unavailable','A scheduling guard needs review before this shift can be changed.',503);
      const entries = (Array.isArray(lock?.entries) ? lock.entries : []).filter(entry=>entry.id!==job.id && !TERMINAL.has(entry.status));
      entries.push(scheduleDayEntry(next,date,roster,now));
      writes.push({collection:'jobs',id,revision:lock?.revision,patch:{recordType:'schedule_lock',date,entries,updatedAt:now}});
    }
    const finalJobs = input.action === 'claim' ? await jobsForWindow(store,() => rowsWindow([job],new Date(now)),'shift') : await reads.near(() => rowsWindow([job],new Date(now)),'shift');
    const inspection = await withTravel(scheduleInspection(finalJobs,resources,roster,rules),[next],roster,input.action === 'claim' ? options.travel : null);
    if (rules.blockTravelShort && options.travel?.enabled) inspection.blockTravelShort = true;
    // A claim answers for the claimer: their own limits and hours, their own
    // drive between stops, and a crew it completes without a required skill.
    inspection.rules.enforce = warning => warning.employeeId === identity || warning.code === 'skill_missing' && !patch.openShift;
    const claimerStop = warning => warning.code !== 'travel_buffer_short' || legacyMembers(finalJobs.find(row => row.id === warning.otherJobId) || {},roster).includes(identity);
    // A crew member cannot change the time, crew or vehicle; each conflict's own message (details.conflicts) says why.
    if (input.action === 'claim') conflictCheck(next,finalJobs,resources,roster,inspection,claimerStop,'This shift cannot be added to your schedule.');
    const legacy = input.action === 'claim' ? await legacyBlockedDays(store,occupiedDays(job)) : {rows:[]}, blocked = legacy.rows.map(row => legacyBlockWarning(job.id,row));
    if (legacy.mode === 'enforce' && blocked.length) throw fail('dispatch_conflict','This shift is on a day blocked on the Hub calendar. Ask dispatch before picking it up.',409,{conflicts:blocked});
    writes.push({collection:'dispatchState',id:'revision',revision:guard?.revision,patch:{updatedAt:now,lastRequestId:input.requestId}});
    writes.push({collection:'dispatchOperations',id:receiptId,patch:{fingerprint,actorId:identity,action:`shift.${input.action}`,collection:'jobs',targetId:job.id,requestId:input.requestId,createdAt:now,before:auditState(job),after:auditState(next)}});
    if (assignedCrew.length) writes.push(...(await visitFunnelWrites({action:'update',before:job,after:next,actor:eventActor({id:identity,kind:'human',role:session.role}),via:'hub',key:requestKey(input.requestId),source:{collection:'dispatchOperations',id:receiptId},crewChanged:true,now})).writes);
    await store.commit(writes);
    const saved = await store.read('jobs',job.id);
    if (!saved || saved.dispatchRequestId !== input.requestId) throw fail('dispatch_changed_since_operation','Your assignment saved, but dispatch has changed it again. Refresh your schedule.',409);
    const notices = jobWarnings(saved,finalJobs,resources,roster,inspection).filter(warning=>warning.code==='travel_buffer_short' || warning.employeeId === identity && ['employee_daily_capacity','outside_working_hours'].includes(warning.code));
    return {ok:true,action:input.action,requestId:input.requestId,job:saved,warnings:[...notices,...blocked]};
  } catch(error) {
    const recovered = await replay().catch(replayError => { if (['dispatch_changed_since_operation','dispatch_idempotency_conflict'].includes(replayError.code)) throw replayError; return null; });
    if (recovered) return recovered;
    throw error;
  }
}
