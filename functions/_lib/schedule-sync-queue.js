import {firestoreFetch} from './firebase-service-account.js';
import {decodeFirestoreFields} from './firestore-job.js';
import {schedulingStorage} from './operations-scheduling.js';
import {scheduleInterval} from './dispatch-time.js';

/** Server-driven HighLevel calendar mirror queue (P1-DS-02). The Hub selects the
 * operations-owned visits whose mirror is due and records failures with backoff;
 * the platform schedule-sync loop runs the existing schedule.sync_provider for
 * each one. Both bridge commands answer only the schedule-sync worker principal
 * and are off unless EGC_SCHEDULE_SYNC_WORKER=true. Each sync_due call is the
 * worker's check-in: page loads stop auto-retrying these visits only while the
 * flag is on and the worker checked in within SCHEDULE_SYNC_HEARTBEAT_MINUTES. */
const ROOT='projects/egcw-1ec83/databases/(default)/documents';
const BASE=`https://firestore.googleapis.com/v1/${ROOT}`;
export const SCHEDULE_SYNC_BATCH_LIMIT=25;
/** Must equal SCHEDULE_SYNC_WORKER_ACTOR_ID in egc-platform/apps/api/src/schedule-sync-worker.ts. */
export const SCHEDULE_SYNC_WORKER_ID='schedule-sync-worker';
// A page attempt still 'syncing' this long after it started was interrupted (tab closed mid-request).
export const SCHEDULE_SYNC_STALE_MINUTES=10;
// The worker ticks every 2 minutes; without a check-in this recent page loads retry as before.
export const SCHEDULE_SYNC_HEARTBEAT_MINUTES=10;
const HEARTBEAT_COLLECTION='scheduleSyncState',HEARTBEAT_ID='worker';
// The mirror's own provider key: the page (syncJobRecord) and the walkthrough handoff send the
// visit's syncIdempotencyKey with customer automations on, MCP syncs under its own requestId (a
// bridge mutate stores schedule-mutate:<requestId>, never the requestId itself), and one ledger
// key never takes two payloads.
const MIRROR_SUFFIX=':mirror';
const SCAN_LIMIT=1000;
/** After this many of the worker's own failures on one sync key it stops retrying the visit (it is
 * parked, cumulatively about 42 hours of backoff) and it waits for a manager's Retry in the Hub,
 * which clears syncFailureKey and syncReviewRequired (a fresh budget); a new schedule change (a
 * new key) queues it again. The worker counts in syncWorkerAttempts; syncAttempts stays the
 * page's own count for its backoff. */
export const SCHEDULE_SYNC_REVIEW_ATTEMPTS=8;
/** Ledger refusals that no retry under the same key can clear: the visit is parked at once. */
export const SCHEDULE_SYNC_PARK_CODES=Object.freeze(['appointment_idempotency_payload_conflict','appointment_changed_since_acceptance']);
const QUEUED_STATUSES=['pending','error','syncing'];
const VISIT_TYPES=new Set(['walkthrough','job','cleanout','reorg']);
// syncPortalSchedule answers not_needed (and never binds) for these without a provider appointment.
const NOTHING_TO_MIRROR=new Set(['cancelled','canceled','noshow','no_show','no-show']);
const QUEUE_FIELDS=['type','recordType','syncStatus','providerSyncOwner','syncNextRetryAt','syncIdempotencyKey','syncWorkerAttempts','syncReviewRequired','syncFailureKey','syncLastAttemptAt','syncFirstFailedAt','dispatchUpdatedAt','updatedAt','createdAt','date','endDate','time','endTime','status','pipelineStatus','title','serviceType','address','customerId','highlevelContactId','highlevelAppointmentId','handoffVersion','handoffSyncStatus'];
const COMMAND_KEYS={'schedule.sync_due':['command','limit'],'schedule.sync_failed':['command','requestId','portalVisitId','expectedRevision','syncRequestId','code']};
const safeId=id=>typeof id==='string'&&/^[A-Za-z0-9_-]{1,180}$/.test(id)&&!/^(_egc_|secure_)/.test(id);
const uuid=id=>typeof id==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);
const syncKey=value=>typeof value==='string'&&/^[A-Za-z0-9:._-]{1,250}$/.test(value);
const failure=(code,status=409)=>Object.assign(new Error(code),{code,status});
const canonical=v=>Array.isArray(v)?`[${v.map(canonical).join(',')}]`:v&&typeof v==='object'?`{${Object.entries(v).sort(([a],[b])=>a.localeCompare(b)).map(([k,x])=>`${JSON.stringify(k)}:${canonical(x)}`).join(',')}}`:JSON.stringify(v??null);
const digest=async v=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(canonical(v))))].map(x=>x.toString(16).padStart(2,'0')).join('');
const text=value=>typeof value==='string'?value:'';

export const scheduleSyncWorkerEnabled=env=>env?.EGC_SCHEDULE_SYNC_WORKER==='true';
export const isScheduleSyncCommand=command=>Object.hasOwn(COMMAND_KEYS,String(command?.command));

/** The ONE ownership rule (employee-suite.js serverScheduleMirror mirrors it): an
 * operations visit whose calendar can be mirrored without the browser's contact
 * creation or walkthrough-handoff CRM steps. Everything else stays with the page. */
export function serverScheduleSyncOwned(job){
  if(!job||typeof job!=='object'||job.providerSyncOwner!=='operations'||!safeId(job.id)||job.recordType||!VISIT_TYPES.has(job.type))return false;
  if(typeof job.highlevelContactId!=='string'||!job.highlevelContactId)return false;
  if(job.handoffVersion===1&&job.handoffSyncStatus!=='synced')return false;
  return !(NOTHING_TO_MIRROR.has(String(job.pipelineStatus||job.status||'').toLowerCase())&&!job.highlevelAppointmentId);
}

/** requestId for schedule.sync_provider: the job's syncIdempotencyKey (fresh for each
 * dispatch/operations schedule change) plus ':mirror', else a key derived from the
 * mirrored state, so a rerun for the same state never becomes a second provider write. */
export async function scheduleSyncRequestId(job){
  if(syncKey(job.syncIdempotencyKey)&&job.syncIdempotencyKey.length<=250-MIRROR_SUFFIX.length)return `${job.syncIdempotencyKey}${MIRROR_SUFFIX}`;
  const state={type:job.type,date:job.date||null,endDate:job.endDate||job.date||null,time:job.time||null,endTime:job.endTime||null,status:job.pipelineStatus||job.status||null,title:job.title||job.serviceType||null,address:job.address||null,customerId:job.customerId||null,contact:job.highlevelContactId||null,appointment:job.highlevelAppointmentId||null};
  return `schedule-sync:${job.id}:${(await digest(state)).slice(0,32)}`;
}

/** Same curve as the page's retry (employee-suite.js syncJobRecord): 10, 20, 40 … 1280 minutes. */
export const scheduleSyncBackoffMinutes=attempts=>Math.min(24*60,Math.pow(2,Math.min(attempts,8))*5);

const queuedAt=job=>text(job.dispatchUpdatedAt)||text(job.updatedAt)||text(job.createdAt);
const workerAttemptsOf=job=>Number.isSafeInteger(job.syncWorkerAttempts)&&job.syncWorkerAttempts>=0?job.syncWorkerAttempts:0;
/** Parked: the worker's failures on this very key reached the review threshold, or one of them was
 * a refusal no retry clears (syncReviewRequired). Cleared by a manager's Retry or a new key. */
const parkedOn=(job,requestId)=>job.syncFailureKey===requestId&&(workerAttemptsOf(job)>=SCHEDULE_SYNC_REVIEW_ATTEMPTS||job.syncReviewRequired===true);

/** pending or error, or a page attempt left 'syncing' for SCHEDULE_SYNC_STALE_MINUTES. `at` is ms. */
function awaitingMirror(job,at){
  if(job.syncStatus==='pending'||job.syncStatus==='error')return true;
  if(job.syncStatus!=='syncing')return false;
  const started=Date.parse(job.syncLastAttemptAt);
  return !Number.isFinite(started)||at-started>=SCHEDULE_SYNC_STALE_MINUTES*60000;
}

function decodeRow(document){
  const prefix=`${ROOT}/jobs/`,name=document?.name;
  const id=typeof name==='string'&&name.startsWith(prefix)?name.slice(prefix.length):'';
  if(!id||id.includes('/')||typeof document.updateTime!=='string'||!document.updateTime||document.fields!==undefined&&(!document.fields||typeof document.fields!=='object'||Array.isArray(document.fields)))throw failure('schedule_sync_queue_incomplete',503);
  return {...decodeFirestoreFields(document.fields||{}),id,revision:document.updateTime};
}

/** runQuery on operations-owned rows by sync status (firestore.indexes.json: jobs providerSyncOwner +
 * syncStatus), so page-owned error rows never count toward the scan cap; the rest of the ownership
 * rule and staleness are filtered here. An unreadable or malformed response is never an empty queue. */
export function scheduleSyncStorage(env,fetcher=firestoreFetch){
  const scheduling=schedulingStorage(env,fetcher);
  return {
    read:(collection,id)=>scheduling.read(collection,id),
    commit:writes=>scheduling.commit(writes),
    async due(){
      const query={structuredQuery:{from:[{collectionId:'jobs'}],select:{fields:QUEUE_FIELDS.map(fieldPath=>({fieldPath}))},where:{compositeFilter:{op:'AND',filters:[{fieldFilter:{field:{fieldPath:'providerSyncOwner'},op:'EQUAL',value:{stringValue:'operations'}}},{fieldFilter:{field:{fieldPath:'syncStatus'},op:'IN',value:{arrayValue:{values:QUEUED_STATUSES.map(stringValue=>({stringValue}))}}}}]}},limit:SCAN_LIMIT+1}};
      let response,rows;
      try{response=await fetcher(env,`${BASE}:runQuery`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(query),signal:AbortSignal.timeout(15000)});}catch{throw failure('schedule_sync_queue_unavailable',503);}
      if(!response.ok)throw failure('schedule_sync_queue_unavailable',503);
      try{rows=await response.json();}catch{throw failure('schedule_sync_queue_incomplete',503);}
      if(!Array.isArray(rows)||rows.some(row=>!row||typeof row!=='object'))throw failure('schedule_sync_queue_incomplete',503);
      const documents=rows.filter(row=>row.document).map(row=>decodeRow(row.document));
      return {rows:documents.slice(0,SCAN_LIMIT),truncated:documents.length>SCAN_LIMIT};
    }
  };
}

function checkedCommand(command,name){
  if(!command||typeof command!=='object'||Array.isArray(command)||command.command!==name||Object.keys(command).some(key=>!COMMAND_KEYS[name].includes(key)))throw failure('schedule_request_invalid',400);
  return command;
}

/** Read-only selector: owned pending/error (or stale 'syncing') visits whose retry time
 * has come, oldest dispatch change first, at most 25. A backoff recorded for an older
 * sync key does not delay a newer schedule change; a visit parked on its current key
 * (SCHEDULE_SYNC_REVIEW_ATTEMPTS worker failures, or a SCHEDULE_SYNC_PARK_CODES refusal) is
 * not selected. Items carry the worker's own attempts on the current key. The counts
 * and oldestFailureAt (the earliest first failure among owned visits in error) let the
 * worker report the backlog. `now` is a Date. */
export async function selectScheduleSyncDue(store,command,now=new Date()){
  const {limit=SCHEDULE_SYNC_BATCH_LIMIT}=checkedCommand(command,'schedule.sync_due');
  if(!Number.isInteger(limit)||limit<1||limit>SCHEDULE_SYNC_BATCH_LIMIT)throw failure('schedule_request_invalid',400);
  const at=now.getTime();if(!Number.isFinite(at))throw failure('schedule_request_invalid',400);
  const {rows,truncated}=await store.due();
  const owned=rows.filter(job=>QUEUED_STATUSES.includes(job.syncStatus)&&serverScheduleSyncOwned(job));
  const due=[];
  let backingOff=0,parked=0,oldestFailure=Infinity;
  for(const job of owned){
    if(!awaitingMirror(job,at))continue;
    if(job.syncStatus==='error'){const since=Date.parse(job.syncFirstFailedAt||job.syncLastAttemptAt);if(Number.isFinite(since))oldestFailure=Math.min(oldestFailure,since);}
    const requestId=await scheduleSyncRequestId(job),retryAt=Date.parse(job.syncNextRetryAt);
    if(parkedOn(job,requestId)){parked++;continue;}
    const staleBackoff=typeof job.syncFailureKey==='string'&&job.syncFailureKey!==requestId;
    if(!job.syncNextRetryAt||!Number.isFinite(retryAt)||retryAt<=at||staleBackoff)due.push({job,requestId});
    else backingOff++;
  }
  due.sort((a,b)=>queuedAt(a.job).localeCompare(queuedAt(b.job))||a.job.id.localeCompare(b.job.id));
  const items=due.slice(0,limit).map(({job,requestId})=>{
    const interval=scheduleInterval(job);
    return {portalVisitId:job.id,requestId,expectedRevision:job.revision,type:job.type,syncStatus:job.syncStatus,syncAttempts:job.syncFailureKey===requestId?workerAttemptsOf(job):0,queuedAt:queuedAt(job)||null,startAt:interval?.startAt||null,endAt:interval?.endAt||null};
  });
  return {ok:true,authority:'employee_hub',asOf:now.toISOString(),limit,items,counts:{scanned:rows.length,owned:owned.length,due:due.length,returned:items.length,backingOff,parked},
    oldestFailureAt:Number.isFinite(oldestFailure)?new Date(oldestFailure).toISOString():null,coverage:{complete:!truncated,asOf:now.toISOString()}};
}

/** Failure writer: syncStatus 'error' plus a backoff counted per sync key in
 * syncWorkerAttempts (never the page's syncAttempts), written by CAS. It keeps the key's first
 * failure time, marks the visit for review (syncReviewRequired, which parks it) once the key
 * reaches SCHEDULE_SYNC_REVIEW_ATTEMPTS or at once on a SCHEDULE_SYNC_PARK_CODES refusal, and
 * stamps syncFailedAt equal to syncLastAttemptAt
 * so the page can tell this backoff from its own (any later page attempt moves
 * syncLastAttemptAt). A replay of the same requestId returns the saved failure. A change since
 * selection that leaves the same sync key awaiting its mirror (a first project link,
 * crew fields) keeps the failure against the fresh revision; anything else (the
 * mirror landed, a reschedule, a manual retry in progress) is a revision conflict the
 * next tick re-reads. */
export async function recordScheduleSyncFailure(store,actor,command,now=new Date().toISOString()){
  const input=checkedCommand(command,'schedule.sync_failed');
  if(!uuid(input.requestId)||!safeId(input.portalVisitId)||typeof input.expectedRevision!=='string'||!input.expectedRevision||input.expectedRevision.length>200||!syncKey(input.syncRequestId)||typeof input.code!=='string'||!/^[a-z][a-z0-9_]{0,63}$/.test(input.code))throw failure('schedule_request_invalid',400);
  const saved=job=>({ok:true,authority:'employee_hub',portalVisitId:job.id,requestId:input.requestId,syncStatus:job.syncStatus,syncAttempts:job.syncWorkerAttempts,syncNextRetryAt:job.syncNextRetryAt,reviewRequired:job.syncReviewRequired===true,revision:job.revision});
  const current=await store.read('jobs',input.portalVisitId);
  if(!current||current.id!==input.portalVisitId||current.recordType)throw failure('schedule_visit_not_found',404);
  if(current.syncFailureRequestId===input.requestId){
    if(current.syncFailureKey!==input.syncRequestId||current.syncError!==input.code)throw failure('schedule_idempotency_conflict');
    return {...saved(current),replayed:true};
  }
  const waiting=awaitingMirror(current,Date.parse(now))&&serverScheduleSyncOwned(current),sameKey=await scheduleSyncRequestId(current)===input.syncRequestId;
  if(current.revision!==input.expectedRevision&&!(waiting&&sameKey))throw failure('schedule_revision_conflict');
  if(!waiting)throw failure('schedule_sync_not_pending');
  if(!sameKey)throw failure('schedule_sync_changed_since_selection');
  const prior=current.syncFailureKey===input.syncRequestId?workerAttemptsOf(current):0;
  const attempts=prior+1,next=new Date(Date.parse(now)+scheduleSyncBackoffMinutes(attempts)*60000).toISOString();
  const firstFailedAt=prior>0&&typeof current.syncFirstFailedAt==='string'&&current.syncFirstFailedAt?current.syncFirstFailedAt:now;
  const review=attempts>=SCHEDULE_SYNC_REVIEW_ATTEMPTS||SCHEDULE_SYNC_PARK_CODES.includes(input.code);
  const patch={syncStatus:'error',syncError:input.code,syncNextRetryAt:next,syncWorkerAttempts:attempts,syncLastAttemptAt:now,syncFailureKey:input.syncRequestId,syncFailureRequestId:input.requestId,syncFailedBy:actor.id,syncFailedAt:now,syncFirstFailedAt:firstFailedAt,syncReviewRequired:review,updatedAt:now};
  try{await store.commit([{collection:'jobs',id:current.id,revision:current.revision,patch}]);}
  catch(error){const latest=await store.read('jobs',current.id).catch(()=>null);if(latest?.syncFailureRequestId!==input.requestId)throw error;return saved(latest);}
  const latest=await store.read('jobs',current.id);
  if(!latest||latest.syncFailureRequestId!==input.requestId)throw failure('schedule_revision_conflict');
  return saved(latest);
}

/** The worker's check-in, a bookkeeping write outside jobs (server-only by the rules'
 * default deny). Best effort: a failed write only lets page loads resume retrying. */
async function recordScheduleSyncHeartbeat(store,actor,now){
  try{
    const beat=await store.read(HEARTBEAT_COLLECTION,HEARTBEAT_ID);
    await store.commit([{collection:HEARTBEAT_COLLECTION,id:HEARTBEAT_ID,revision:beat?.revision,patch:{lastDueAt:now,workerId:actor.id,updatedAt:now}}]);
    return true;
  }catch{return false;}
}

async function readScheduleSyncHeartbeat(env,fetcher=firestoreFetch){
  const response=await fetcher(env,`${BASE}/${HEARTBEAT_COLLECTION}/${HEARTBEAT_ID}`,{signal:AbortSignal.timeout(3000)});
  if(response.status===404)return null;
  if(!response.ok)throw failure('schedule_sync_heartbeat_unavailable',503);
  const document=await response.json();
  return decodeFirestoreFields(document?.fields||{});
}

/** What /api/integration-status reports as serverScheduleSync: the flag is on AND the
 * worker checked in within the window. Flag off: nothing is read. Unreadable, missing
 * or future-dated: false, so page loads keep retrying. `now` is a Date. */
export async function serverScheduleSyncActive(env,{read=()=>readScheduleSyncHeartbeat(env),now=new Date()}={}){
  if(!scheduleSyncWorkerEnabled(env))return false;
  let beat;
  try{beat=await read();}catch{return false;}
  const at=Date.parse(beat?.lastDueAt),current=now.getTime();
  return Number.isFinite(at)&&at<=current+60000&&current-at<SCHEDULE_SYNC_HEARTBEAT_MINUTES*60000;
}

/** Bridge entry (functions/api/operations-portal.js). Identity comes only from the
 * verified envelope; the flag is checked after the worker-only rule. */
export async function runScheduleSyncCommand(env,actor,command,{store=scheduleSyncStorage(env),now=new Date()}={}){
  if(actor?.kind!=='integration'||actor?.role!=='integration'||actor?.id!==SCHEDULE_SYNC_WORKER_ID)throw failure('schedule_sync_queue_integration_only',403);
  if(!scheduleSyncWorkerEnabled(env))throw failure('schedule_sync_queue_disabled',409);
  if(command.command!=='schedule.sync_due')return recordScheduleSyncFailure(store,actor,command,now.toISOString());
  const result=await selectScheduleSyncDue(store,command,now);
  return {...result,heartbeat:await recordScheduleSyncHeartbeat(store,actor,now.toISOString())};
}
