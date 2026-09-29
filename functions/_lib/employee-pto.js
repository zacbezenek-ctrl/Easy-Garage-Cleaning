import { assignmentKey } from './job-assignment.js';
import { hasBusinessAccess } from './hub-session.js';
import { requireDispatcher } from './dispatch-service.js';
import { cancelManagedAvailability, createManagedAvailability } from './crew-availability.js';
import { addDays, availabilityInterval, denverToday, validDate } from './dispatch-time.js';
import { readAll, readCollection, readOne, writeOne } from './employee-vault.js';
import { employeeVaultReadOnly, employeeVaultSecret } from './employee-vault-key.js';
import { firebaseServiceAccountConfigured } from './firebase-service-account.js';
import { PTO_MAX_DAYS as MAX_DAYS, ptoDays as dates, ptoPay, ptoWeekday, validPtoHours as validHours } from './pto-pay.js';

// Time-off and shift-change requests stay in the encrypted 'requests' family.
// Approved time off becomes native unavailable time through the availability
// lock contract; the request is marked approved only after that block exists.
// What a request pays comes only from pto-pay.js, the model payroll reads too.
const TZ = 'America/Denver';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const TYPES = ['time_off','shift_change'];
const INPUT = {request:['action','requestId','type','startDate','endDate','reason','paid','hoursPerDay'],approve:['action','requestId','id','acknowledgeConflicts','paid','hoursPerDay','paidDates','note'],deny:['action','requestId','id','note'],cancel:['action','requestId','id','note'],end:['action','requestId','id','endedEarlyFrom','note'],amend:['action','requestId','id','paid','hoursPerDay','paidDates','note']};
// Sick time can be recorded shortly after it happens. One request is one
// availability block, which the scheduling time model caps at 31 days.
// cancelManagedAvailability releases at most 62 linked blocks at once.
const PAST_DAYS = 14, FUTURE_DAYS = 366, RELEASE_LIMIT = 62;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = (code, message, status = 400, details) => Object.assign(new Error(message), { code: 'pto_'+code, status, ...(details ? { details } : {}) });
const keys = (value, allowed) => { if (!object(value) || Object.keys(value).some(key => !allowed.includes(key))) throw fail('invalid_request','The request contains unsupported fields. Refresh and try again.'); };
const recordId = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,180}$/.test(value);
const canonical = value => Array.isArray(value) ? '['+value.map(canonical).join(',')+']' : object(value) ? '{'+Object.entries(value).sort(([a],[b]) => a.localeCompare(b)).map(([key,item]) => JSON.stringify(key)+':'+canonical(item)).join(',')+'}' : JSON.stringify(value);
const hex = async text => [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text)))].map(byte=>byte.toString(16).padStart(2,'0')).join('');
const digest = value => hex(canonical(value));
const statusOf = record => record?.status === undefined || record.status === '' ? 'pending' : record.status === 'canceled' ? 'cancelled' : String(record.status);
const decisions = record => Array.isArray(record?.decisions) ? record.decisions.filter(object) : [];
const blockId = async id => 'pto_block_'+(await hex('pto:'+id)).slice(0,40);
const dispatcher = session => { try { requireDispatcher(session); return true; } catch { return false; } };
// The all-day block must fit the 31 x 24 hour cap; the November clock change adds an hour.
const blockable = (date, endDate) => Boolean(availabilityInterval({allDay:true,date,endDate}));
const endedFrom = record => validDate(record?.endedEarlyFrom) ? record.endedEarlyFrom : '';
// Blocks the request lists, and any an earlier decision on it released.
const recordedBlocks = record => [...(Array.isArray(record.availabilityIds) ? record.availabilityIds : []),...decisions(record).flatMap(entry => Array.isArray(entry.releaseIds) ? entry.releaseIds : [])].filter(id => typeof id === 'string' && /^[A-Za-z0-9_-]{1,180}$/.test(id));
// The last day an approval still covers: an early end releases its date onward.
const lastDay = record => endedFrom(record) ? addDays(record.endedEarlyFrom,-1) : validDate(record?.endDate) ? record.endDate : record?.startDate;
function text(value, label, max) {
  if (value === undefined) return '';
  if (typeof value !== 'string' || value.length > max) throw fail('invalid_text',`${label} must be text of at most ${max} characters.`);
  return value.trim();
}
// Pay terms for an approval or a pay change. The manager chooses the paid days among `days`,
// weekends included; the default is every one of them except Saturday and Sunday (Denver), or
// every one for an older request whose manager-set paidWeekends paid weekends too.
function payTerms(input, days, fallback, unpaid) {
  const paid = input.paid ?? fallback.paid === true, hoursPerDay = paid ? input.hoursPerDay ?? fallback.hoursPerDay : null;
  if (paid ? !validHours(hoursPerDay) : input.hoursPerDay !== undefined && input.hoursPerDay !== null) throw fail('invalid_hours','Paid time off needs paid hours per day from 0.25 to 12, in quarter hours.');
  if (input.paidDates !== undefined && (!paid || !Array.isArray(input.paidDates) || !input.paidDates.length || input.paidDates.some((date,index)=>!days.includes(date) || index && date <= input.paidDates[index-1]))) throw fail('invalid_paid_dates','Choose paid days in order, within the requested dates, for paid time off only.');
  const paidDates = paid ? input.paidDates ?? (fallback.weekends ? days : days.filter(ptoWeekday)) : [];
  if (paid && !paidDates.length) throw fail('invalid_paid_dates',`Weekend days are not paid unless you choose them. Choose the paid days, or ${unpaid}.`);
  return {paid,hoursPerDay,paidDates};
}
function rosterIdentity(session, roster) {
  const id = assignmentKey(session.user), matches = roster.filter(person => person.id === id);
  return id && matches.length === 1 ? id : null;
}
async function derivedUuid(seed) {
  const h = await hex(seed);
  return `${h.slice(0,8)}-${h.slice(8,12)}-8${h.slice(13,16)}-${'89ab'[parseInt(h[16],16) % 4]}${h.slice(17,20)}-${h.slice(20,32)}`;
}

/** The sealed-vault adapter. Tests inject an in-memory equivalent. */
export function ptoVault(env) {
  if (!employeeVaultSecret(env) || !firebaseServiceAccountConfigured(env)) throw fail('not_configured','Employee Hub storage is not configured.',503);
  return {
    readOnly: employeeVaultReadOnly(env),
    async read(id) { const found = await readOne(env,'requests',id); return found.data ? found : null; },
    list: () => readCollection(env,'requests'),
    // IDs are key-derived: a create must never trust a 404 before the vault opens.
    prove: () => readAll(env),
    write: (id, data, expected, now) => writeOne(env,'requests',id,data,expected || {data:null},now),
    // Requests share the jobs collection with the schedule, so a schedule commit can verify one unchanged.
    guard: found => ({collection:'jobs',id:found.documentId,revision:found.updateTime,verify:true}),
  };
}

/** Legacy requests have no paid/hoursPerDay/decisions: browser-era ones read as
 * unpaid, and older approvals with a manager-set paidHoursPerDay keep paying by
 * their original weekday rule (payModel 'legacy'), as does an approval whose pay
 * fields no workflow approve or amend decision set. */
export function projectPtoRequest(record) {
  const type = TYPES.includes(record?.type) ? record.type : 'request', days = dates(record?.startDate, record?.endDate || record?.startDate), pay = ptoPay(record);
  return {id:String(record?.id || ''),type,employee:String(record?.employee || ''),employeeName:String(record?.employeeName || record?.employee || ''),startDate:String(record?.startDate || ''),endDate:String(record?.endDate || record?.startDate || ''),endedEarlyFrom:endedFrom(record),
    reason:String(record?.reason || ''),status:statusOf(record),...pay,
    reviewedBy:String(record?.reviewedBy || ''),reviewedAt:String(record?.reviewedAt || ''),cancelledBy:String(record?.cancelledBy || ''),cancelledAt:String(record?.cancelledAt || ''),
    availabilityIds:Array.isArray(record?.availabilityIds) ? record.availabilityIds.filter(recordId) : [],createdAt:String(record?.createdAt || ''),updatedAt:String(record?.updatedAt || ''),
    decisions:decisions(record).map(({fingerprint,...entry})=>entry),legacy:!Array.isArray(record?.decisions),datesNeedReview:!days.length};
}

/** Approved paid time off per Denver date in [startDate, endDate), the shape a
 * weekly timesheet adds beside worked hours. */
export function paidTimeOffHours(records, startDate, endDate) {
  const days = [], totals = new Map();
  for (const request of records.map(projectPtoRequest)) {
    if (request.type !== 'time_off' || request.status !== 'approved' || !request.paid) continue;
    const employee = assignmentKey(request.employee);
    for (const day of request.paidDays) if (day.date >= startDate && day.date < endDate) {
      days.push({employee,requestId:request.id,date:day.date,hours:day.hours});
      totals.set(employee,(totals.get(employee) || 0)+day.hours);
    }
  }
  days.sort((a,b)=>a.date.localeCompare(b.date) || a.employee.localeCompare(b.employee) || a.requestId.localeCompare(b.requestId));
  return {startDate,endDate,days,totals:[...totals].map(([employee,hours])=>({employee,hours})).sort((a,b)=>a.employee.localeCompare(b.employee))};
}

export async function ptoOverview(store, vault, session, query = {}, now = new Date()) {
  if (!session?.user) throw fail('sign_in_required','Sign in to view requests.',401);
  keys(query,['startDate','endDate']);
  const range = query.startDate !== undefined || query.endDate !== undefined;
  if (range && (!validDate(query.startDate) || !validDate(query.endDate) || query.startDate >= query.endDate || Date.parse(query.endDate)-Date.parse(query.startDate) > 93*86400000)) throw fail('invalid_range','Choose a valid date range of up to 93 days. The end date is exclusive.');
  const manager = hasBusinessAccess(session), employee = manager ? null : rosterIdentity(session,await store.roster());
  if (!manager && !employee) throw fail('employee_inactive','Your active employee account could not be verified. Sign in again.',403);
  const records = (await vault.list()).filter(record => object(record) && recordId(record.id) && TYPES.includes(record.type) && (manager || assignmentKey(record.employee) === employee));
  return {ok:true,timeZone:TZ,employee,requests:records.map(projectPtoRequest).sort((a,b)=>b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id)),
    ...(range ? {paidTimeOff:paidTimeOffHours(records,query.startDate,query.endDate)} : {}),coverage:{complete:true,asOf:now.toISOString()}};
}

function decisionFor(record, requestId, fingerprint) {
  const found = decisions(record).find(entry => entry.requestId === requestId);
  if (found && found.fingerprint !== fingerprint) throw fail('idempotency_conflict','This request ID was already used for a different change. Refresh before trying again.',409);
  return found || null;
}

// Compare-and-set write of one request. A lost or failed write is resolved
// only by reading back this request ID's decision; it is never guessed.
async function save(vault, target, build, requestId, now) {
  let current = target;
  for (let attempt = 0; attempt < 3; attempt++) {
    const next = build(current.data);
    try { await vault.write(next.id,next,current.data ? current : null,now); return next; }
    catch (error) {
      const latest = await vault.read(next.id).catch(() => null);
      if (latest?.data && decisions(latest.data).some(entry => entry.requestId === requestId)) return latest.data;
      if (error?.code !== 'EMPLOYEE_HUB_WRITE_CONFLICT' || !latest?.data) throw fail('outcome_unknown','The request could not be verified. Retry the same request; do not create another.',503);
      current = latest;
    }
  }
  throw fail('revision_conflict','This request changed while saving. Refresh and review it.',409);
}

async function submit({vault,session,input,now,actor,self,fingerprint}) {
  if (!self) throw fail('employee_inactive','Your active employee account could not be verified. Sign in again before sending a request.',403);
  const id = 'pto_'+input.requestId.toLowerCase().replaceAll('-','');
  const existing = await vault.read(id);
  if (existing?.data) {
    const prior = decisionFor(existing.data,input.requestId,fingerprint);
    if (!prior) throw fail('idempotency_conflict','This request ID was already used. Refresh before trying again.',409);
    return {ok:true,request:projectPtoRequest(existing.data),requestId:input.requestId,warnings:[],replayed:true};
  }
  if (!TYPES.includes(input.type)) throw fail('invalid_type','Choose time off or a shift change.');
  const today = denverToday(new Date(now)), days = dates(input.startDate,input.endDate);
  if (!days.length || !blockable(input.startDate,input.endDate)) throw fail('invalid_dates',`Choose a valid start and end date. One request covers at most ${MAX_DAYS} days, or ${MAX_DAYS-1} when it includes the November clock change.`);
  if (input.startDate < addDays(today,-PAST_DAYS) || input.startDate > addDays(today,FUTURE_DAYS)) throw fail('invalid_dates',`Requests can start up to ${PAST_DAYS} days ago and at most one year ahead.`);
  const reason = text(input.reason,'The request details',500), timeOff = input.type === 'time_off';
  if (!timeOff && (input.paid !== undefined || input.hoursPerDay !== undefined)) throw fail('invalid_request','Only time off can be paid.');
  if (input.paid !== undefined && typeof input.paid !== 'boolean') throw fail('invalid_paid','Choose whether this is paid time off.');
  const paid = input.paid === true;
  if (paid ? !validHours(input.hoursPerDay) : input.hoursPerDay !== undefined && input.hoursPerDay !== null) throw fail('invalid_hours','Paid time off needs paid hours per day from 0.25 to 12, in quarter hours.');
  const all = await vault.list();
  if (!all.length) await vault.prove?.();
  const overlap = timeOff && all.find(record => object(record) && record.type === 'time_off' && ['pending','approved'].includes(statusOf(record)) && assignmentKey(record.employee) === self &&
    validDate(record.startDate) && record.startDate <= input.endDate && lastDay(record) >= input.startDate);
  if (overlap) throw fail('overlap','You already have a pending or approved time-off request on these dates.',409,{requestId:overlap.id});
  // The requested pay is what an approval would pay by default: every requested weekday.
  const terms = {type:input.type,startDate:input.startDate,endDate:input.endDate,paid,hoursPerDay:paid ? input.hoursPerDay : null};
  const record = {id,type:input.type,employee:self,employeeName:String(session.displayName || session.user).slice(0,120),startDate:input.startDate,endDate:input.endDate,reason,
    ...(timeOff ? {paid,hoursPerDay:terms.hoursPerDay,paidHours:ptoPay(terms).paidHours} : {}),status:'pending',reviewedBy:'',reviewedAt:'',availabilityIds:[],
    requestId:input.requestId,createdAt:now,createdBy:actor,updatedAt:now,decisions:[{action:'request',status:'pending',by:actor,at:now,requestId:input.requestId,fingerprint}]};
  const saved = await save(vault,{data:null},current => { if (current) throw fail('idempotency_conflict','This request ID was already used. Refresh before trying again.',409); return record; },input.requestId,now);
  return {ok:true,request:projectPtoRequest(saved),requestId:input.requestId,warnings:[]};
}

// A deny or cancel recorded after this approval's block commit releases the
// block itself. The approver releases it too, so the block stays active for a
// closed request only if both releases fail and neither is retried.
async function releaseAfterClosed({store,session,input,now}, record, block) {
  try { await cancelManagedAvailability(store,session,record.employee,{requestId:await derivedUuid('pto-release:'+input.requestId),ids:[block],sourceRequestId:record.id},now); }
  catch { throw fail('release_incomplete','This request was closed while it was being approved and its unavailable time is not released yet. Retry the same request to finish.',503); }
}

async function approve(context, target) {
  const {store,vault,session,input,now,actor,fingerprint} = context, record = target.data, status = statusOf(record), timeOff = record.type === 'time_off';
  const block = timeOff ? await blockId(record.id) : null, employee = assignmentKey(record.employee);
  if (status !== 'pending') {
    if (timeOff && ['denied','cancelled'].includes(status)) await releaseAfterClosed(context,record,block);
    throw fail('not_pending',`This request is already ${status}. Refresh the request list.`,409,{status});
  }
  if (!timeOff && (input.paid !== undefined || input.hoursPerDay !== undefined || input.paidDates !== undefined || input.acknowledgeConflicts !== undefined)) throw fail('invalid_request','Only time off can be paid or approved over assigned work.');
  if (input.paid !== undefined && typeof input.paid !== 'boolean' || input.acknowledgeConflicts !== undefined && typeof input.acknowledgeConflicts !== 'boolean') throw fail('invalid_request','Choose paid or unpaid time off and confirm any conflicts explicitly.');
  const note = text(input.note,'The note',500);
  let paid = false, hoursPerDay = null, paidDates = [], days = [], warnings = [], availabilityIds = [];
  if (timeOff) {
    days = dates(record.startDate,record.endDate || record.startDate);
    if (!days.length || !blockable(days[0],days.at(-1))) throw fail('invalid_dates','This request has invalid or too-long dates. Deny it and ask for a corrected request.',409);
    // The request's own terms are the defaults. An older request that carries a manager-set
    // paidHoursPerDay defaults to paying it, so an approval never silently drops that pay.
    const older = typeof record.paid !== 'boolean' && ![undefined,null,''].includes(record.paidHoursPerDay);
    ({paid,hoursPerDay,paidDates} = payTerms(input,days,older ? {paid:true,hoursPerDay:record.paidHoursPerDay,weekends:record.paidWeekends === true} : {paid:record.paid === true,hoursPerDay:record.hoursPerDay},'approve this time off unpaid'));
    const existing = await store.read('jobs',block);
    if (existing && existing.dispatchRequestId !== input.requestId) {
      // An earlier approval created this block but never recorded its decision.
      if (['cancelled','canceled'].includes(existing.status) || existing.sourceRequestId !== record.id || assignmentKey(existing.employee) !== employee || existing.date !== days[0] || (existing.endDate || existing.date) !== days.at(-1))
        throw fail('block_needs_review','This request already has unavailable time that needs review. Ask dispatch to check it before approving.',409,{availabilityId:block});
      // Its receipt keeps the warnings it was created with, such as assigned work it was approved over.
      const receipt = UUID.test(existing.dispatchRequestId || '') ? await store.read('dispatchOperations',existing.dispatchRequestId.toLowerCase()) : null;
      if (receipt?.scope === 'crew_availability_managed' && receipt.targetId === block && Array.isArray(receipt.warnings)) warnings = receipt.warnings.filter(object);
    } else {
      // The block commit verifies the request is unchanged since it was read, so a deny or cancel
      // recorded first is never followed by a new block. sourceFingerprint binds every approval
      // term, not only the block, to this request ID.
      const fence = vault.guard?.(target), guarded = fence ? {...store,commit:writes => store.commit([...writes,fence])} : store;
      try {
        warnings = (await createManagedAvailability(guarded,session,employee,{requestId:input.requestId,id:block,sourceRequestId:record.id,sourceFingerprint:fingerprint,date:days[0],endDate:days.at(-1),allDay:true,reason:'Approved time off',
          ...(input.acknowledgeConflicts === true ? {acknowledgeConflicts:true} : {})},now)).warnings;
      } catch (error) {
        if (error.code === 'crew_availability_idempotency_conflict') throw fail('idempotency_conflict','This request ID was already used for a different change. Refresh before trying again.',409);
        const latest = error.code === 'dispatch_revision_conflict' ? await vault.read(record.id).catch(() => null) : null;
        if (latest?.data && latest.updateTime !== target.updateTime) {
          const changed = statusOf(latest.data);
          throw changed === 'pending' ? fail('revision_conflict','This request changed while it was being approved. Refresh and review it.',409) : fail('not_pending',`This request was ${changed} while it was being approved. Refresh the request list.`,409,{status:changed});
        }
        throw error;
      }
    }
    availabilityIds = [block];
  }
  const brief = warnings.map(({code,message,conflicts,availabilityIds:ids})=>({code,message,...(conflicts ? {jobIds:conflicts.map(row=>row.jobId)} : {}),...(ids ? {availabilityIds:ids} : {})}));
  const decision = {action:'approve',status:'approved',by:actor,at:now,requestId:input.requestId,fingerprint,...(note ? {note} : {}),...(timeOff ? {paid,hoursPerDay,...(paid ? {paidDates} : {}),availabilityIds,warnings:brief} : {})};
  let saved;
  try {
    saved = await save(vault,target,current => {
      const latest = statusOf(current);
      if (latest !== 'pending') throw fail('not_pending',`This request was ${latest} while it was being approved. Refresh the request list.`,409,{status:latest});
      return {...current,status:'approved',reviewedBy:actor,reviewedAt:now,updatedAt:now,...(timeOff ? {paid,hoursPerDay,paidDates,paidHours:paid ? paidDates.length*hoursPerDay : 0,availabilityIds} : {}),decisions:[...decisions(current),decision]};
    },input.requestId,now);
  } catch(error) {
    if (timeOff && error.code === 'pto_not_pending' && ['denied','cancelled'].includes(error.details?.status)) await releaseAfterClosed(context,record,block);
    throw error;
  }
  return {ok:true,request:projectPtoRequest(saved),requestId:input.requestId,warnings};
}

// A manager changes what approved time off pays at any time, as payroll allowed before this
// workflow; the schedule does not change. The decision keeps the paid hours it replaced, and
// reviewedBy/reviewedAt move to it, which is how pto-pay.js knows the new terms are the workflow's.
async function amend(context, target) {
  const {vault,input,now,actor,fingerprint} = context, record = target.data, status = statusOf(record), cutoff = endedFrom(record);
  if (record.type !== 'time_off' || status !== 'approved') throw fail('not_approved','Only approved time off can have its pay changed. Refresh the request list.',409,{status});
  if (typeof input.paid !== 'boolean') throw fail('invalid_paid','Choose whether this is paid time off.');
  const note = text(input.note,'The note',500), days = dates(record.startDate,record.endDate || record.startDate).filter(date => !cutoff || date < cutoff);
  if (input.paid && !days.length) throw fail('invalid_dates','This time off has dates that need review, so it can only be made unpaid.',409);
  const pay = payTerms(input,days,{},'make this time off unpaid');
  const decision = {action:'amend',status:'approved',by:actor,at:now,requestId:input.requestId,fingerprint,...(note ? {note} : {}),paid:pay.paid,hoursPerDay:pay.hoursPerDay,...(pay.paid ? {paidDates:pay.paidDates} : {}),previousPaidHours:ptoPay(record).paidHours};
  const saved = await save(vault,target,current => {
    const latest = statusOf(current);
    // A cancel, an early end or another pay change saved meanwhile is reviewed first, never overwritten.
    if (latest !== 'approved' || endedFrom(current) !== cutoff || current.reviewedAt !== record.reviewedAt) throw fail('revision_conflict','This time off changed while saving. Refresh the request list and review it.',409,{status:latest});
    const next = {...current,...pay,reviewedBy:actor,reviewedAt:now,updatedAt:now,decisions:[...decisions(current),decision]};
    return {...next,paidHours:ptoPay(next).paidHours};
  },input.requestId,now);
  return finish(context,saved,decision,false);
}

// Every block an approval of this request may own: recorded availabilityIds and
// earlier releaseIds, the pto_block_ id (an approval may have created it without
// recording it) or, for browser-era approvals, which never had one, the per-day
// '-pto' blocks. Only an approve decision marks an approval made here: a
// browser-era approval gains a decision history when it first ends early.
async function linkedBlocks(store, record) {
  const ids = new Set(recordedBlocks(record));
  if (statusOf(record) !== 'approved' || decisions(record).some(entry => entry.action === 'approve')) ids.add(await blockId(record.id));
  else {
    const key = String(record.employee || '').toLowerCase().replace(/[^a-z0-9]/g,''), days = dates(record.startDate,validDate(record.endDate) && record.endDate >= record.startDate ? record.endDate : record.startDate,62);
    if (!key || !days.length) throw fail('legacy_review','This older approved request has dates that need review. Ask dispatch to remove its unavailable time, then cancel it.',409);
    const rows = await Promise.all(days.map(date=>store.read('jobs',`availability-${key}-${date}-pto`)));
    for (const row of rows) if (row && row.requestId === record.id) ids.add(row.id);
  }
  // Checked before the decision is recorded, so a request is never closed with time it cannot release.
  if (ids.size > RELEASE_LIMIT) throw fail('legacy_review','This request links more unavailable time than one change can release. Ask dispatch to review it first.',409);
  return [...ids];
}

// Deny, cancel and end record the decision first, then release linked time. A
// replay of the same request ID re-runs the idempotent release. Only a
// transient failure asks for that replay; a refusal needs dispatch review.
async function finish({store,session,input,now}, record, decision, replayed) {
  if (Array.isArray(decision.releaseIds) && decision.releaseIds.length) {
    try { await cancelManagedAvailability(store,session,record.employee,{requestId:input.requestId,ids:decision.releaseIds,sourceRequestId:record.id,...(decision.endedEarlyFrom ? {from:decision.endedEarlyFrom} : {})},now); }
    catch (error) {
      // changed_since_operation: this request released it earlier and the schedule moved on since.
      if (error.code !== 'crew_availability_changed_since_operation') {
        if (!error.status || error.status >= 500 || /_revision_conflict$/.test(error.code || '')) throw fail('release_incomplete','The request was saved, but its unavailable time is not released yet. Retry the same request to finish.',503);
        throw fail('release_review','The request was saved, but its unavailable time could not be released. Ask dispatch to review it on the schedule.',409,{availabilityIds:decision.releaseIds});
      }
    }
  }
  return {ok:true,request:projectPtoRequest(record),requestId:input.requestId,warnings:Array.isArray(decision.warnings) ? decision.warnings : [],...(replayed ? {replayed:true} : {})};
}

async function close(context, target) {
  const {store,vault,input,now,actor,manager,fingerprint} = context, record = target.data, status = statusOf(record), action = input.action, timeOff = record.type === 'time_off', today = denverToday(new Date(now));
  const note = text(input.note,'The note',500), next = {deny:'denied',cancel:'cancelled',end:'approved'}[action];
  if (action === 'end') {
    // An early end keeps the days already taken, and their paid hours, and releases the rest.
    if (!timeOff || status !== 'approved') throw fail('not_approved','Only approved time off can end early. Refresh the request list.',409,{status});
    if (!validDate(record.startDate) || !validDate(lastDay(record))) throw fail('legacy_review','This approved request has dates that need review. Ask dispatch to check it.',409);
    if (lastDay(record) < today) throw fail('ended','This time off has already ended. Its days stay on the record.',409);
    // Started time off, even on its first day, may end from today; before it starts it keeps at least its first day.
    const earliest = record.startDate > today ? addDays(record.startDate,1) : today;
    if (!validDate(input.endedEarlyFrom) || input.endedEarlyFrom < earliest || input.endedEarlyFrom > lastDay(record)) throw fail('invalid_dates','Choose a first day back from today through the approved dates. Time off that has not started keeps at least its first day.');
  } else if (action === 'deny' ? status !== 'pending' : !['pending','approved'].includes(status)) throw fail('not_pending',`This request is already ${status}. Refresh the request list.`,409,{status});
  // Time off has started on its first Denver day. From then on it is ended early, never cancelled.
  if (action === 'cancel' && status === 'approved') {
    if (!manager && !(timeOff && record.startDate > today)) throw fail('started','Approved time off that has started can only be ended early by a manager, and an approved shift change cancelled by one.',409);
    if (manager && timeOff && record.startDate <= today) throw fail('started','This time off has started. End it early instead: days before the first day back stay on the record.',409);
  }
  // Only a roster employee's request can ever have been approved into a block.
  const releaseIds = timeOff && assignmentKey(record.employee) ? await linkedBlocks(store,record) : [];
  const decision = {action,status:next,by:actor,at:now,requestId:input.requestId,fingerprint,...(note ? {note} : {}),...(action === 'end' ? {endedEarlyFrom:input.endedEarlyFrom} : {}),...(releaseIds.length ? {releaseIds} : {})};
  const saved = await save(vault,target,current => {
    const latest = statusOf(current);
    if (latest !== status || endedFrom(current) !== endedFrom(record)) throw fail('not_pending',`This request changed to ${latest} while saving. Refresh the request list.`,409,{status:latest});
    const change = action === 'deny' ? {reviewedBy:actor,reviewedAt:now} : action === 'cancel' ? {cancelledBy:actor,cancelledAt:now}
      : {endedEarlyFrom:input.endedEarlyFrom,endedEarlyBy:actor,endedEarlyAt:now,paidHours:projectPtoRequest({...current,endedEarlyFrom:input.endedEarlyFrom}).paidHours};
    return {...current,status:next,updatedAt:now,...change,decisions:[...decisions(current),decision]};
  },input.requestId,now);
  return finish(context,saved,decision,false);
}

/** request (crew for themselves), approve/deny/end/amend (operations managers;
 * amend changes what approved time off pays) and cancel (the employee before
 * approved time off starts, or a manager until it starts; after that a manager
 * ends it early). Every action carries a UUID requestId; a replay returns the
 * recorded decision. */
export async function mutatePto(store, vault, session, input, now = new Date().toISOString()) {
  if (!session?.user) throw fail('sign_in_required','Sign in to manage requests.',401);
  if (!object(input) || !Object.hasOwn(INPUT,input.action) || !UUID.test(input.requestId || '')) throw fail('invalid_request','Choose a valid request action with a unique request ID.');
  keys(input,INPUT[input.action]);
  const roster = await store.roster(), manager = dispatcher(session), self = rosterIdentity(session,roster);
  if (['approve','deny','end','amend'].includes(input.action) && !manager) throw fail('forbidden','Only an operations manager or owner can approve, deny, end early or change the pay of requests.',403);
  const actor = manager ? assignmentKey(session.user) : self;
  if (!actor) throw fail('employee_inactive','Your active employee account could not be verified. Sign in again before changing requests.',403);
  const context = {store,vault,session,input,now,manager,self,actor,fingerprint:await digest({scope:'employee_pto',actor,input})};
  if (input.action === 'request') return submit(context);
  if (!recordId(input.id)) throw fail('not_found','Choose an existing request.',404);
  const target = await vault.read(input.id);
  if (!target?.data) throw fail('not_found','This request no longer exists. Refresh the request list.',404);
  if (!TYPES.includes(target.data.type)) throw fail('unsupported_request','This record is not a time-off or shift-change request.',409);
  if (!manager && assignmentKey(target.data.employee) !== self) throw fail('forbidden','Only your own requests can be changed here.',403);
  const prior = decisionFor(target.data,input.requestId,context.fingerprint);
  if (prior) return finish(context,target.data,prior,true);
  return input.action === 'approve' ? approve(context,target) : input.action === 'amend' ? amend(context,target) : close(context,target);
}
