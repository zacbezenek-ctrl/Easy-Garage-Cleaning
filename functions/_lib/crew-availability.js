import { assignmentKey } from './job-assignment.js';
import { projectDispatchJob, requireDispatcher } from './dispatch-service.js';
import { validDate, addDays, denverToday, scheduleInterval, availabilityInterval, occupiedDays, overlaps } from './dispatch-time.js';
import { jobSegments } from './dispatch-segments.js';

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
const sourceId = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,180}$/.test(value);
// Approved time off is owned by its request: new blocks carry sourceRequestId
// and a pto_block_ id; browser-era approvals used '<employee>-<date>-pto' ids.
const requestLinked = row => typeof row?.sourceRequestId === 'string' && Boolean(row.sourceRequestId) || /^pto_block_|-pto$/.test(typeof row?.id === 'string' ? row.id : '');

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
    sourceCollection,canCancel:sourceCollection === 'jobs' && active(row) && !requestLinked(row),timeNeedsReview:!interval};
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

function createPatch(changes, employee, now, actor = employee, allowPast = false) {
  keys(changes,['date','endDate','time','endTime','allDay','reason']);
  if (typeof changes.allDay !== 'boolean' || !validDate(changes.date) || !validDate(changes.endDate || changes.date)) throw fail('invalid_time','Choose valid dates and all-day or timed availability.');
  if (!allowPast && changes.date < denverToday(new Date(now))) throw fail('past_date','Choose today or a future date for unavailable time.');
  if (changes.reason !== undefined && (typeof changes.reason !== 'string' || changes.reason.length > 500)) throw fail('invalid_reason','The availability note must be text of at most 500 characters.');
  const patch = {type:'availability',recordType:'crew_availability',employee,date:changes.date,endDate:changes.endDate || changes.date,
    time:changes.allDay ? '00:00' : changes.time,endTime:changes.allDay ? '23:59' : changes.endTime,allDay:changes.allDay,reason:changes.reason?.trim() || 'Unavailable',status:'active'};
  const interval = availabilityInterval(patch);
  if (!interval) throw fail('invalid_time','Choose valid Mountain start and end times within 31 days. Missing and repeated daylight-saving hours need another time.');
  return {...patch,startAt:interval.startAt,endAt:interval.endAt,timeZone:TZ,createdAt:now,createdBy:actor,updatedAt:now,updatedBy:actor};
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
// Active work that overlaps the interval, or whose saved times cannot prove it
// does not. Company-wide blocks count only for self-service availability.
function assignedWork(interval, jobs, roster, employee, companyBlocks = true) {
  const conflicts = [];
  for (const record of jobs) {
    if ((record.type !== 'blocked' && (record.recordType || !['job','walkthrough','cleanout','reorg'].includes(record.type))) || !active(record)) continue;
    if (record.type === 'blocked' && !companyBlocks) continue;
    // Only the segments this employee works can collide with their time off.
    for (const job of jobSegments(record)) {
    if (job.type !== 'blocked' && !projectDispatchJob(job,roster).assignedCrew.includes(employee)) continue;
    const scheduled = scheduleInterval(job);
    const unverifiable = !scheduled && job.date && (!validDate(job.date) || job.date <= interval.endDate && (!validDate(job.endDate || job.date) || (job.endDate || job.date) >= interval.date));
    if (overlaps(interval,scheduled) || unverifiable) conflicts.push({job,code:unverifiable?'invalid_assignment_time':'assigned_job'});
    }
  }
  return conflicts;
}
function overlappingBlocks(interval, jobs, resources, roster, employee) {
  const rows = [];
  for (const row of [...jobs.filter(nativeAvailability),...resources.filter(resourceAvailability)]) {
    if (!active(row) || owner(row,roster) !== employee) continue;
    const existing = availabilityInterval(row);
    const invalid = !existing && (!validDate(row.date) || row.date <= interval.endDate && (!validDate(row.endDate || row.date) || (row.endDate || row.date)>=interval.date));
    if (overlaps(interval,existing) || invalid) rows.push({row,invalid});
  }
  return rows;
}
function checkConflicts(next, jobs, resources, roster, employee) {
  const interval = availabilityInterval(next);
  const conflicts = assignedWork(interval,jobs,roster,employee).map(({job,code})=>({code,jobId:job.id,...(job.segmentId?{segmentId:job.segmentId}:{}),message:code === 'invalid_assignment_time'?'An assignment has invalid times. Ask dispatch to review it first.':'You are already assigned during this time. Ask dispatch to reassign that work before blocking availability.'}));
  if (conflicts.length) throw fail('assignment_conflict','You already have assigned work during this time. Ask an operations manager to handle the schedule change.',409,{conflicts});
  const [existing] = overlappingBlocks(interval,jobs,resources,roster,employee);
  if (existing) throw fail('already_unavailable',existing.invalid?'Existing unavailable time needs review before adding another block.':'You already have unavailable time during this interval. Review the existing block instead of adding a duplicate.',409,{availabilityId:existing.row.id});
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
    if (!create && requestLinked(current)) throw fail('request_linked','This time off belongs to an approved request. Cancel the request from Requests so the time-off record stays accurate.',409);
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

const MANAGED = 'crew_availability_managed', RELEASE = 'crew_availability_managed_release';
const dispatcher = session => { try { requireDispatcher(session); return true; } catch { return false; } };
function rosterEmployee(value, roster) {
  const key = assignmentKey(value), matches = roster.filter(person=>person.id === key);
  if (!key || matches.length !== 1) throw fail('employee_inactive','This employee is not in the active roster. Review the employee record before changing their availability.',409);
  return key;
}
async function readLocks(store, days) {
  const locks = await Promise.all(days.map(date=>store.read('jobs','_egc_schedule_lock_'+date)));
  if (locks.some(lock=>lock && (lock.recordType !== 'schedule_lock' || !Array.isArray(lock.entries)))) throw fail('lock_unavailable','A scheduling guard needs review. Ask dispatch to check this date before changing availability.',503);
  return locks;
}
function lockWrites(days, locks, removed, row, now) {
  const occupied = row ? availabilityDays(row) : [];
  return days.map((date,index)=>{
    const lock = locks[index], entries = (Array.isArray(lock?.entries) ? lock.entries : []).filter(entry=>!removed.includes(entry.id) && !terminal.has(entry.status));
    if (occupied.includes(date)) entries.push({id:row.id,type:'availability',start:date === row.date && !row.allDay ? row.time : '00:00',end:date === row.endDate && !row.allDay ? row.endTime : '24:00',label:'Employee unavailable',status:'active',assignedCrew:[row.employee],vehicleId:null,updatedAt:now});
    return {collection:'jobs',id:'_egc_schedule_lock_'+date,revision:lock?.revision,patch:{recordType:'schedule_lock',date,entries,updatedAt:now}};
  });
}
async function recover(replay, error) {
  const recovered = await replay().catch(replayError=>{if (['crew_availability_changed_since_operation','crew_availability_idempotency_conflict'].includes(replayError.code)) throw replayError; return null;});
  if (recovered) return recovered;
  throw error;
}

/** Manager-created unavailable time (approved time off) for one roster
 * employee. It follows the self-service contract: dispatchState revision
 * before business reads, every occupied day lock, a conflict scan after the
 * locks, and one commit with the dispatchOperations receipt. Assigned work is
 * refused until the manager sends acknowledgeConflicts:true, then returned as
 * warnings. Nothing is sent to a provider. */
export async function createManagedAvailability(store, session, employeeId, input, now = new Date().toISOString()) {
  requireDispatcher(session);
  keys(input,['requestId','id','sourceRequestId','sourceFingerprint','date','endDate','time','endTime','allDay','reason','acknowledgeConflicts']);
  // sourceFingerprint binds the caller's whole change (such as a PTO approval's pay terms) to this request ID.
  if (!UUID.test(input.requestId || '') || input.id !== undefined && !safeId(input.id) || input.sourceRequestId !== undefined && !sourceId(input.sourceRequestId) || input.sourceFingerprint !== undefined && !/^[a-f0-9]{64}$/.test(input.sourceFingerprint) || input.acknowledgeConflicts !== undefined && typeof input.acknowledgeConflicts !== 'boolean') throw fail('invalid_request','Choose valid unavailable time with a unique request ID.');
  const actor = assignmentKey(session.user), roster = await store.roster(), employee = rosterEmployee(employeeId,roster);
  const fingerprint = await digest({scope:MANAGED,actor,employee,input}), receiptId = input.requestId.toLowerCase(), id = input.id || 'availability_'+receiptId.replaceAll('-','');
  async function replay() {
    const receipt = await store.read('dispatchOperations',receiptId);
    if (!receipt) return null;
    if (receipt.fingerprint !== fingerprint || receipt.scope !== MANAGED) throw fail('idempotency_conflict','This request ID was already used for different changes. Keep the original request or refresh.',409);
    const row = await store.read('jobs',receipt.targetId);
    if (!nativeAvailability(row) || row.dispatchRequestId !== input.requestId) throw fail('changed_since_operation','That unavailable time saved, but it has changed since. Refresh the schedule.',409);
    return {ok:true,record:projectCrewAvailability(row),requestId:input.requestId,warnings:Array.isArray(receipt.warnings) ? receipt.warnings : [],replayed:true};
  }
  const previous = await replay(); if (previous) return previous;
  try {
    const guard = await store.read('dispatchState','revision');
    if (await store.read('jobs',id)) throw fail('record_exists','Unavailable time already exists for this request. Refresh before approving it again.',409,{availabilityId:id});
    const changes = Object.fromEntries(Object.entries(input).filter(([key])=>['date','endDate','time','endTime','allDay','reason'].includes(key)));
    const patch = {...createPatch(changes,employee,now,actor,true),id,managedBy:actor,dispatchRequestId:input.requestId,...(input.sourceRequestId ? {sourceRequestId:input.sourceRequestId} : {})};
    const days = availabilityDays(patch), locks = await readLocks(store,days);
    const [jobs,resources,currentRoster] = await Promise.all([store.jobs(),store.resources(),store.roster()]);
    rosterEmployee(employee,currentRoster);
    const interval = availabilityInterval(patch);
    const conflicts = assignedWork(interval,jobs,currentRoster,employee,false).map(({job,code})=>({code,jobId:job.id,...(job.segmentId?{segmentId:job.segmentId}:{}),date:job.date || '',time:job.time || '',endDate:job.endDate || job.date || '',endTime:job.endTime || '',label:String(job.customer || job.title || '').slice(0,120),
      message:code === 'invalid_assignment_time' ? 'This employee has an assignment with invalid times. Review it before approving time off.' : 'This employee is assigned to this work during the time off.'}));
    if (conflicts.length && input.acknowledgeConflicts !== true) throw fail('assignment_conflict','This employee is assigned to work during this time off. Review the jobs, then confirm to approve anyway and reassign them.',409,{conflicts,acknowledgeable:true});
    const overlapping = overlappingBlocks(interval,jobs,resources,currentRoster,employee).map(({row})=>row.id);
    const warnings = [...(conflicts.length ? [{code:'availability_conflicts',message:'Time off was approved over assigned work. Reassign these jobs before dispatch.',conflicts}] : []),
      ...(overlapping.length ? [{code:'existing_unavailable',message:'The employee already had unavailable time on some of these dates.',availabilityIds:overlapping}] : [])];
    const writes = [{collection:'jobs',id,patch},...lockWrites(days,locks,[id],patch,now)];
    writes.push({collection:'dispatchState',id:'revision',revision:guard?.revision,patch:{updatedAt:now,lastRequestId:input.requestId}});
    writes.push({collection:'dispatchOperations',id:receiptId,patch:{scope:MANAGED,fingerprint,actorId:actor,employeeId:employee,action:'availability.managed.create',collection:'jobs',targetId:id,requestId:input.requestId,...(input.sourceFingerprint ? {sourceFingerprint:input.sourceFingerprint} : {}),createdAt:now,before:null,after:projectCrewAvailability(patch),warnings}});
    await store.commit(writes);
    const saved = await store.read('jobs',id);
    if (!saved || saved.dispatchRequestId !== input.requestId) throw fail('outcome_unknown','The save could not be verified. Retry the same request.',503);
    return {ok:true,record:projectCrewAvailability(saved),requestId:input.requestId,warnings};
  } catch(error) { return recover(replay,error); }
}

/** Releases unavailable time linked to one source request (its approval
 * block and any browser-era per-day blocks) under the same lock and receipt
 * contract. Managers may release any employee's linked time; an employee only
 * their own. Missing or already cancelled rows are left as they are. With
 * `from` (a Denver date) only time on or after that date is released: earlier
 * rows stay, and a row spanning it is shortened to end there. */
export async function cancelManagedAvailability(store, session, employeeId, input, now = new Date().toISOString()) {
  requireSession(session); keys(input,['requestId','ids','sourceRequestId','from']);
  if (!UUID.test(input.requestId || '') || !Array.isArray(input.ids) || !input.ids.length || input.ids.length > 62 || input.ids.some(id=>!safeId(id)) || new Set(input.ids).size !== input.ids.length || !sourceId(input.sourceRequestId) || !assignmentKey(employeeId) || input.from !== undefined && !validDate(input.from)) throw fail('invalid_request','Choose the linked unavailable time to release with a unique request ID.');
  const roster = await store.roster(), employee = assignmentKey(employeeId), manager = dispatcher(session), actor = manager ? assignmentKey(session.user) : identity(session,roster);
  if (!manager && actor !== employee) throw fail('forbidden','Only your own time off can be released here.',403);
  const linked = row => nativeAvailability(row) && (row.sourceRequestId === input.sourceRequestId || row.requestId === input.sourceRequestId) && (assignmentKey(row.employeeId || row.employee) === employee || owner(row,roster) === employee);
  const fingerprint = await digest({scope:RELEASE,actor,employee,input}), receiptId = input.requestId.toLowerCase();
  async function replay() {
    const receipt = await store.read('dispatchOperations',receiptId);
    if (!receipt) return null;
    if (receipt.fingerprint !== fingerprint || receipt.scope !== RELEASE) throw fail('idempotency_conflict','This request ID was already used for different changes. Keep the original request or refresh.',409);
    const rows = await Promise.all((Array.isArray(receipt.targetIds) ? receipt.targetIds : []).map(id=>store.read('jobs',id)));
    if (!rows.length || rows.some(row=>!nativeAvailability(row) || row.dispatchRequestId !== input.requestId)) throw fail('changed_since_operation','That time off was released, but the schedule has changed since. Refresh the calendar.',409);
    return {ok:true,records:rows.map(row=>projectCrewAvailability(row)),requestId:input.requestId,replayed:true};
  }
  const previous = await replay(); if (previous) return previous;
  try {
    const guard = await store.read('dispatchState','revision');
    const rows = (await Promise.all(input.ids.map(id=>store.read('jobs',id)))).filter(Boolean);
    if (rows.some(row=>!linked(row))) throw fail('forbidden','This unavailable time is not linked to that request. Ask dispatch to review it.',403);
    const stamp = {updatedAt:now,updatedBy:actor,dispatchRequestId:input.requestId}, cancel = {status:'cancelled',cancelledAt:now,cancelledBy:actor,...stamp};
    const release = row => {
      if (!input.from) return cancel;
      const days = availabilityDays(row);
      if (days.length && days.every(date=>date < input.from)) return null;
      if (!(row.date < input.from)) return cancel;
      // Days before `from` stay unavailable; a row whose times cannot be shortened is released whole.
      const cut = row.allDay === true ? {endDate:addDays(input.from,-1)} : {endDate:input.from,endTime:'00:00'}, interval = availabilityInterval({...row,...cut});
      return interval ? {...cut,startAt:interval.startAt,endAt:interval.endAt,...stamp} : cancel;
    };
    const changing = rows.filter(active).map(row=>({row,patch:release(row)})).filter(({patch})=>patch);
    if (!changing.length) return {ok:true,records:rows.map(row=>projectCrewAvailability(row)),requestId:input.requestId,unchanged:true};
    const ids = changing.map(({row})=>row.id), days = [...new Set(changing.flatMap(({row})=>availabilityDays(row)))].filter(date=>!input.from || date >= input.from).sort(), locks = await readLocks(store,days);
    const writes = [...changing.map(({row,patch})=>({collection:'jobs',id:row.id,revision:row.revision,patch})),...lockWrites(days,locks,ids,null,now)];
    writes.push({collection:'dispatchState',id:'revision',revision:guard?.revision,patch:{updatedAt:now,lastRequestId:input.requestId}});
    writes.push({collection:'dispatchOperations',id:receiptId,patch:{scope:RELEASE,fingerprint,actorId:actor,employeeId:employee,action:input.from ? 'availability.managed.end' : 'availability.managed.cancel',collection:'jobs',targetId:ids[0],targetIds:ids,requestId:input.requestId,createdAt:now,
      before:changing.map(({row})=>projectCrewAvailability(row)),after:changing.map(({row,patch})=>projectCrewAvailability({...row,...patch}))}});
    await store.commit(writes);
    const saved = await Promise.all(ids.map(id=>store.read('jobs',id)));
    if (saved.some(row=>!row || row.dispatchRequestId !== input.requestId)) throw fail('outcome_unknown','The release could not be verified. Retry the same request.',503);
    return {ok:true,records:saved.map(row=>projectCrewAvailability(row)),requestId:input.requestId};
  } catch(error) { return recover(replay,error); }
}
