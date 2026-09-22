import { assignmentKey } from './job-assignment.js';
import { projectDispatchJob } from './dispatch-service.js';
import { validDate, addDays, denverToday, scheduleInterval, availabilityInterval, occupiedDays, overlaps } from './dispatch-time.js';

const TZ = 'America/Denver';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const terminal = new Set(['cancelled','canceled','completed','invoiced','paid','review_requested','closed','noshow','no_show','no-show']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = (code, message, status = 400, details) => Object.assign(new Error(message), { code: 'crew_availability_'+code, status, ...(details ? { details } : {}) });
const keys = (value, allowed) => { if (!object(value) || Object.keys(value).some(key => !allowed.includes(key))) throw fail('invalid_request','The availability request contains unsupported fields. Refresh and try again.'); };
const safeId = value => typeof value === 'string' && /^[A-Za-z0-9_.-]{1,180}$/.test(value) && !/^(secure_|_egc_)/.test(value);
const canonical = value => Array.isArray(value) ? '['+value.map(canonical).join(',')+']' : object(value) ? '{'+Object.entries(value).sort(([a],[b]) => a.localeCompare(b)).map(([key,item]) => JSON.stringify(key)+':'+canonical(item)).join(',')+'}' : JSON.stringify(value);
const digest = async value => [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(canonical(value))))].map(byte=>byte.toString(16).padStart(2,'0')).join('');
const nativeAvailability = row => Boolean(row && safeId(row.id) && (row.type === 'availability' || row.recordType === 'crew_availability'));
const resourceAvailability = row => row?.recordType === 'availability';
const active = row => !terminal.has(row.pipelineStatus || row.status || 'active');

function identity(session, roster) {
  if (!session?.user) throw fail('sign_in_required','Sign in to manage your availability.',401);
  const id = assignmentKey(session.user), matches = roster.filter(person=>person.id === id);
  if (!id || matches.length !== 1) throw fail('employee_inactive','Your active employee account could not be verified. Sign in again before changing availability.',403);
  return id;
}
function owner(row, roster) {
  const key = assignmentKey(row.employeeId || row.employee);
  const exact = roster.filter(person=>person.id === key);
  if (exact.length === 1) return exact[0].id;
  if (exact.length) return null;
  const names = roster.filter(person=>assignmentKey(person.name) === key);
  return names.length === 1 ? names[0].id : null;
}
function requireSession(session) { if (!session?.user) throw fail('sign_in_required','Sign in to manage your availability.',401); }

export function projectCrewAvailability(row, sourceCollection = 'jobs') {
  const fields = ['id','revision','type','recordType','employee','employeeId','date','endDate','time','endTime','allDay','reason','status','createdAt','updatedAt','createdBy','updatedBy','cancelledAt','cancelledBy'];
  const result = Object.fromEntries(fields.filter(key=>row[key] !== undefined).map(key=>[key,row[key]]));
  const interval = availabilityInterval(row);
  return {...result,endDate:row.endDate || row.date || '',timeZone:TZ,startAt:interval?.startAt || null,endAt:interval?.endAt || null,
    sourceCollection,canCancel:sourceCollection === 'jobs' && active(row),timeNeedsReview:!interval};
}

export async function crewAvailabilityOverview(store, session, query = {}, now = new Date()) {
  requireSession(session);
  const startDate = query.startDate || denverToday(now), endDate = query.endDate || addDays(startDate,93);
  if (!validDate(startDate) || !validDate(endDate) || startDate >= endDate || Date.parse(endDate)-Date.parse(startDate)>93*86400000) throw fail('invalid_range','Choose a valid availability range of up to 93 days. The end date is exclusive.');
  const roster = await store.roster(), employee = identity(session,roster);
  const [jobs,resources] = await Promise.all([store.jobs(),store.resources()]);
  const all = [...jobs.filter(nativeAvailability).map(row=>({row,source:'jobs'})),...resources.filter(resourceAvailability).map(row=>({row,source:'dispatchResources'}))].filter(({row})=>owner(row,roster) === employee);
  const exceptions = all.filter(({row})=>!validDate(row.date) || !validDate(row.endDate || row.date)).map(({row,source})=>({id:row.id,sourceCollection:source,code:'invalid_availability_date',message:'This saved availability has invalid dates and needs manager review.'}));
  const rows = all.filter(({row})=>validDate(row.date) && validDate(row.endDate || row.date) && row.date < endDate && (row.endDate || row.date) >= startDate)
    .map(({row,source})=>projectCrewAvailability(row,source)).sort((a,b)=>a.date.localeCompare(b.date) || String(a.time || '').localeCompare(String(b.time || '')) || a.id.localeCompare(b.id));
  return {ok:true,timeZone:TZ,employee,startDate,endDate,availability:rows,exceptions,coverage:{complete:true,asOf:now.toISOString()}};
}

function createPatch(changes, employee, now) {
  keys(changes,['date','endDate','time','endTime','allDay','reason']);
  if (typeof changes.allDay !== 'boolean' || !validDate(changes.date) || !validDate(changes.endDate || changes.date)) throw fail('invalid_time','Choose valid dates and all-day or timed availability.');
  if (changes.date < denverToday(new Date(now))) throw fail('past_date','Choose today or a future date for unavailable time.');
  if (changes.reason !== undefined && (typeof changes.reason !== 'string' || changes.reason.length > 500)) throw fail('invalid_reason','The availability note must be text of at most 500 characters.');
  const patch = {type:'availability',recordType:'crew_availability',employee,date:changes.date,endDate:changes.endDate || changes.date,
    time:changes.allDay ? '00:00' : changes.time,endTime:changes.allDay ? '23:59' : changes.endTime,allDay:changes.allDay,reason:changes.reason?.trim() || 'Unavailable',status:'active'};
  const interval = availabilityInterval(patch);
  if (!interval) throw fail('invalid_time','Choose valid Mountain start and end times within 31 days. Missing and repeated daylight-saving hours need another time.');
  return {...patch,startAt:interval.startAt,endAt:interval.endAt,timeZone:TZ,createdAt:now,createdBy:employee,updatedAt:now,updatedBy:employee};
}
function availabilityDays(row) {
  const interval = availabilityInterval(row);
  if (interval) return occupiedDays({date:interval.date,time:interval.time,endDate:interval.endDate,endTime:interval.endTime});
  // Cancellation must remain possible for an old malformed block without
  // pretending its invalid times establish valid scheduling capacity.
  if (!validDate(row?.date)) return [];
  const end = validDate(row.endDate) && row.endDate >= row.date && Date.parse(row.endDate)-Date.parse(row.date)<31*86400000 ? row.endDate : row.date;
  const days = []; for (let date=row.date;date<=end;date=addDays(date,1)) days.push(date); return days;
}
function checkConflicts(next, jobs, resources, roster, employee) {
  const interval = availabilityInterval(next), conflicts = [];
  for (const job of jobs) {
    if ((job.type !== 'blocked' && (job.recordType || !['job','walkthrough','cleanout','reorg'].includes(job.type))) || !active(job)) continue;
    if (job.type !== 'blocked' && !projectDispatchJob(job,roster).assignedCrew.includes(employee)) continue;
    const scheduled = scheduleInterval(job);
    const unverifiable = !scheduled && job.date && (!validDate(job.date) || job.date <= interval.endDate && (!validDate(job.endDate || job.date) || (job.endDate || job.date) >= interval.date));
    if (overlaps(interval,scheduled) || unverifiable) conflicts.push({code:unverifiable?'invalid_assignment_time':'assigned_job',jobId:job.id,message:unverifiable?'An assignment has invalid times. Ask dispatch to review it first.':'You are already assigned during this time. Ask dispatch to reassign that work before blocking availability.'});
  }
  if (conflicts.length) throw fail('assignment_conflict','You already have assigned work during this time. Ask an operations manager to handle the schedule change.',409,{conflicts});
  for (const row of [...jobs.filter(nativeAvailability),...resources.filter(resourceAvailability)]) {
    if (!active(row) || owner(row,roster) !== employee) continue;
    const existing = availabilityInterval(row);
    const invalid = !existing && (!validDate(row.date) || row.date <= interval.endDate && (!validDate(row.endDate || row.date) || (row.endDate || row.date)>=interval.date));
    if (overlaps(interval,existing) || invalid) throw fail('already_unavailable',invalid?'Existing unavailable time needs review before adding another block.':'You already have unavailable time during this interval. Review the existing block instead of adding a duplicate.',409,{availabilityId:row.id});
  }
}

/** Canonical native availability; touches the same revision and day locks as
 * manager dispatch and self-assignment. Nothing is sent to a provider. */
export async function mutateCrewAvailability(store, session, input, now = new Date().toISOString()) {
  requireSession(session); keys(input,['action','requestId','id','expectedRevision','changes']);
  if (!['create','cancel'].includes(input.action) || !UUID.test(input.requestId || '')) throw fail('invalid_request','Choose a valid availability action with a unique request ID.');
  const roster = await store.roster(), employee = identity(session,roster);
  const fingerprint = await digest({scope:'crew_availability',actor:employee,input}), receiptId = input.requestId.toLowerCase();
  async function replay() {
    const receipt = await store.read('dispatchOperations',receiptId);
    if (!receipt) return null;
    if (receipt.fingerprint !== fingerprint || receipt.scope !== 'crew_availability' || receipt.actorId !== employee) throw fail('idempotency_conflict','This request ID was already used for different changes. Keep the original request or refresh.',409);
    const row = await store.read('jobs',receipt.targetId);
    if (!nativeAvailability(row) || owner(row,roster) !== employee || row.dispatchRequestId !== input.requestId) throw fail('changed_since_operation','That change saved successfully, but availability has changed again. Refresh your calendar.',409);
    return {ok:true,record:projectCrewAvailability(row),requestId:input.requestId,replayed:true};
  }
  const previous = await replay(); if (previous) return previous;
  try {
    // Acquire every capacity version before the conflict snapshot, so neither
    // newer dispatch nor older calendar writers can slip between scan/save.
    const guard = await store.read('dispatchState','revision');
    const create = input.action === 'create';
    if (create && (input.id !== undefined || input.expectedRevision !== undefined)) throw fail('invalid_request','New availability gets its identity from the original request.');
    if (!create && (!safeId(input.id) || typeof input.expectedRevision !== 'string' || !input.expectedRevision)) throw fail('revision_required','Refresh your availability before cancelling a block.',409);
    if (!create && input.changes !== undefined) keys(input.changes,[]);
    const id = create ? 'availability_'+receiptId.replaceAll('-','') : input.id;
    const current = await store.read('jobs',id);
    if (create && current) throw fail('record_exists','Availability already exists for this request. Refresh before changing it.',409);
    if (!create && (!nativeAvailability(current) || owner(current,roster) !== employee)) throw fail('forbidden','Only your own availability can be cancelled here. Manager-created time off requires dispatch review.',403);
    if (!create && current.revision !== input.expectedRevision) throw fail('revision_conflict','This availability changed since you opened it. Refresh before cancelling.',409);
    if (!create && !active(current)) throw fail('already_cancelled','This availability is already cancelled. Refresh your calendar.',409);
    const patch = create ? {...createPatch(input.changes || {},employee,now),id} : {status:'cancelled',cancelledAt:now,cancelledBy:employee,updatedAt:now,updatedBy:employee};
    patch.dispatchRequestId = input.requestId;
    const next = {...current,...patch}, days = availabilityDays(next);
    const locks = await Promise.all(days.map(date=>store.read('jobs','_egc_schedule_lock_'+date)));
    if (locks.some(lock=>lock && (lock.recordType !== 'schedule_lock' || !Array.isArray(lock.entries)))) throw fail('lock_unavailable','A scheduling guard needs review. Ask dispatch to check this date before changing availability.',503);
    if (create) {
      const [jobs,resources,currentRoster] = await Promise.all([store.jobs(),store.resources(),store.roster()]);
      identity(session,currentRoster); checkConflicts(next,jobs,resources,currentRoster,employee);
    }
    const writes = [{collection:'jobs',id,revision:current?.revision,patch}];
    for (const [index,date] of days.entries()) {
      const lock = locks[index], entries = (Array.isArray(lock?.entries) ? lock.entries : []).filter(entry=>entry.id !== id && !terminal.has(entry.status));
      if (create) entries.push({id,type:'availability',start:date === next.date && !next.allDay ? next.time : '00:00',end:date === next.endDate && !next.allDay ? next.endTime : '24:00',label:'Employee unavailable',status:'active',assignedCrew:[employee],vehicleId:null,updatedAt:now});
      writes.push({collection:'jobs',id:'_egc_schedule_lock_'+date,revision:lock?.revision,patch:{recordType:'schedule_lock',date,entries,updatedAt:now}});
    }
    writes.push({collection:'dispatchState',id:'revision',revision:guard?.revision,patch:{updatedAt:now,lastRequestId:input.requestId}});
    writes.push({collection:'dispatchOperations',id:receiptId,patch:{scope:'crew_availability',fingerprint,actorId:employee,action:'availability.self.'+input.action,collection:'jobs',targetId:id,requestId:input.requestId,createdAt:now,before:current ? projectCrewAvailability(current) : null,after:projectCrewAvailability(next)}});
    await store.commit(writes);
    const saved = await store.read('jobs',id);
    if (!saved || saved.dispatchRequestId !== input.requestId) throw fail('outcome_unknown','The save could not be verified. Retry the same request.',503);
    return {ok:true,record:projectCrewAvailability(saved),requestId:input.requestId};
  } catch(error) {
    const recovered = await replay().catch(replayError=>{if (['crew_availability_changed_since_operation','crew_availability_idempotency_conflict'].includes(replayError.code)) throw replayError; return null;});
    if (recovered) return recovered;
    throw error;
  }
}
