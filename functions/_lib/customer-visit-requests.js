// Request-only workflow. A customer asks the office to review a change; nothing
// here changes a booking, cancellation entitlement, price, payment or message.
import { firestoreFetch } from './firebase-service-account.js';
import { decodeFirestoreFields } from './firestore-job.js';
import { customerAccountStorage, readCustomerAccountJob } from './customer-account-access.js';
import { CUSTOMER_SESSIONS, portalSessionVersion } from './customer-account-session.js';
import { canDispatch } from './dispatch-permissions.js';
import { auditWrite } from './hub-audit.js';
import { validDate, denverToday } from './dispatch-time.js';
import { localInstant } from './operations-portal-records.js';

export const VISIT_REQUESTS = 'customerVisitRequests';
const ROOT = 'projects/egcw-1ec83/databases/(default)/documents';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FIELDS = ['customerId','jobId','kind','preferredDate','preferredTime','note','status','createdAt','reviewedAt','resolutionNote','scheduled','service','address'];
const fail = (code, message, status = 400) => Object.assign(new Error(message), { code: 'CUSTOMER_VISIT_' + code, status });
const clean = (value, limit) => typeof value === 'string' ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, limit) : '';
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const digest = async value => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value))))].map(n => n.toString(16).padStart(2,'0')).join('');
export const visitRequestView = row => ({ id: row.id, jobId: row.jobId, kind: row.kind, preferredDate: row.preferredDate || '', preferredTime: row.preferredTime || '', note: clean(row.note, 1200), status: row.status, createdAt: row.createdAt, reviewedAt: row.reviewedAt || '', resolutionNote: clean(row.resolutionNote, 1200), scheduled: Object.fromEntries(['date','time','endDate','endTime'].map(key=>[key,clean(row.scheduled?.[key],20)])), service: clean(row.service,120), address: clean(row.address,240) });

export function customerVisitRequestStorage(env) {
  const base = customerAccountStorage(env);
  return { ...base, async visitRequests(field, value) {
    if (!['customerId','status'].includes(field)) throw fail('QUERY_INVALID', 'Invalid request lookup.');
    const response = await firestoreFetch(env, `https://firestore.googleapis.com/v1/${ROOT}:runQuery`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({structuredQuery:{from:[{collectionId:VISIT_REQUESTS}],select:{fields:FIELDS.map(fieldPath=>({fieldPath}))},where:{fieldFilter:{field:{fieldPath:field},op:'EQUAL',value:{stringValue:value}}},limit:201}}) });
    if (!response.ok) throw fail('UNAVAILABLE','Visit requests could not be loaded. Try again shortly.',503);
    const answer = await response.json().catch(()=>null);
    if (!Array.isArray(answer) || answer.length>201 || answer.some(row=>!row?.document&&!row?.readTime)) throw fail('UNAVAILABLE','Visit requests could not be loaded completely.',503);
    return answer.filter(row=>row.document).map(({document})=>{
      const prefix=`${ROOT}/${VISIT_REQUESTS}/`;
      if (!document.name?.startsWith(prefix) || document.name.slice(prefix.length).includes('/') || !document.updateTime) throw fail('UNAVAILABLE','Visit requests could not be verified.',503);
      return {...decodeFirestoreFields(document.fields || {}),id:document.name.slice(prefix.length),revision:document.updateTime};
    });
  }};
}

export async function accountVisitRequests(store, session, {jobIds} = {}) {
  const rows = await store.visitRequests('customerId',session.customerId);
  if (rows.some(row=>row.customerId!==session.customerId)) throw fail('UNAVAILABLE','Visit requests could not be verified.',503);
  // Recheck project ownership each time; a reassigned or business-linked job's
  // old request must not expose its address or context to a former customer.
  const visible=[];
  for (const row of rows.slice(0,200)) {
    if(jobIds instanceof Set){if(jobIds.has(row.jobId))visible.push(visitRequestView(row));continue;}
    try { await readCustomerAccountJob(store,session,row.jobId); visible.push(visitRequestView(row)); }
    catch(error) { if (![404,409].includes(error.status)) throw error; }
  }
  return {requests:visible.sort((a,b)=>b.createdAt.localeCompare(a.createdAt)),complete:rows.length<=200};
}

export async function submitVisitChange(store, session, input, now) {
  const keys=['action','requestId','jobId','kind','preferredDate','preferredTime','note'];
  if (!object(input) || Object.keys(input).some(key=>!keys.includes(key)) || !UUID.test(input.requestId || '') || !['reschedule','cancel'].includes(input.kind)) throw fail('INVALID','Choose a visit and a valid request.');
  const preferredDate=clean(input.preferredDate,10), preferredTime=clean(input.preferredTime,5), note=clean(input.note,1200);
  if (typeof input.note!=='string' || input.note.length>1200 || note.length<3) throw fail('NOTE_REQUIRED','Tell the office what you need (3–1200 characters).');
  if (input.kind==='reschedule' && (!validDate(preferredDate) || preferredDate<denverToday(new Date(now)) || preferredTime && !localInstant(preferredDate,preferredTime))) throw fail('DATE_INVALID','Choose a valid preferred date and an unambiguous Denver time.');
  if (input.kind==='cancel' && (preferredDate || preferredTime)) throw fail('INVALID','A cancellation request cannot set a new date.');
  const verified=await readCustomerAccountJob(store,session,input.jobId);
  const id='cvr_'+await digest([session.customerId,input.requestId.toLowerCase()]);
  const fingerprint=await digest([session.customerId,input.jobId,input.kind,preferredDate,preferredTime,note]);
  const replay=async()=>{const previous=await store.read(VISIT_REQUESTS,id);if(!previous)return null;if(previous.customerId!==session.customerId || previous.fingerprint!==fingerprint)throw fail('IDEMPOTENCY_CONFLICT','That request ID was already used for different details.',409);return {ok:true,replayed:true,request:visitRequestView(previous)};};
  const prior=await replay();if(prior)return prior;
  if (['completed','paid','invoiced','review_requested','closed','cancelled'].includes(verified.job.status)) throw fail('VISIT_CLOSED','This visit is no longer open for a schedule-change request. Contact the office.',409);
  const customer=await store.read('customers',session.customerId), currentSession=await store.read(CUSTOMER_SESSIONS,session.id);
  if (!customer || portalSessionVersion(customer)!==session.sessionVersion || !currentSession || currentSession.revokedAt || currentSession.revision!==session.revision || !(Date.parse(currentSession.expiresAt)>Date.parse(now))) throw fail('SESSION_REVOKED','Your sign-in has ended. Sign in again.',401);
  const row={id,customerId:session.customerId,jobId:input.jobId,kind:input.kind,preferredDate,preferredTime,note,status:'submitted',createdAt:now,reviewedAt:'',resolutionNote:'',fingerprint,scheduled:{date:verified.job.date,time:verified.job.time,endDate:verified.job.endDate,endTime:verified.job.endTime},service:verified.job.service,address:verified.job.address};
  const fences=[{collection:'customers',id:customer.id,revision:customer.revision,verify:true},{collection:CUSTOMER_SESSIONS,id:session.id,revision:session.revision,verify:true},{collection:'jobs',id:input.jobId,revision:verified.revision,verify:true}];
  if(verified.linkRoot!==input.jobId)fences.push({collection:'jobs',id:verified.linkRoot,revision:verified.rootRevision,verify:true});
  try {await store.commit([...fences,{collection:VISIT_REQUESTS,id,patch:row},auditWrite({actor:{id:session.customerId.toLowerCase(),kind:'customer'},via:'portal',action:'customer.visit_change_requested',entity:{collection:VISIT_REQUESTS,id},after:{jobId:input.jobId,kind:input.kind,status:'submitted'},requestId:input.requestId,now})]);}
  catch(error) {const saved=await replay();if(saved)return saved;throw fail(error.code==='dispatch_revision_conflict'?'CHANGED':'OUTCOME_UNKNOWN','The request could not be confirmed. Refresh, then retry the same request.',error.code==='dispatch_revision_conflict'?409:503);}
  return {ok:true,replayed:false,request:visitRequestView(row)};
}

export async function officeVisitRequests(store, actor, env) {
  if(!canDispatch(actor,env))throw fail('FORBIDDEN','Only authorized dispatch staff can review visit requests.',403);
  const groups=await Promise.all(['submitted','reviewing'].map(status=>store.visitRequests('status',status)));
  return {ok:true,requests:groups.flat().slice(0,200).sort((a,b)=>a.createdAt.localeCompare(b.createdAt)).map(row=>({...visitRequestView(row),revision:row.revision})),complete:groups.every(rows=>rows.length<=200)&&groups.flat().length<=200};
}

export async function reviewVisitRequest(store, actor, env, input, now) {
  if(!canDispatch(actor,env))throw fail('FORBIDDEN','Only authorized dispatch staff can review visit requests.',403);
  if(!object(input)||Object.keys(input).some(key=>!['action','id','requestId','expectedRevision','status','resolutionNote'].includes(key))||!/^cvr_[a-f0-9]{64}$/.test(input.id||'')||!UUID.test(input.requestId||'')||!['reviewing','closed'].includes(input.status)||typeof input.expectedRevision!=='string')throw fail('INVALID','Refresh and choose a valid request status.');
  const resolutionNote=clean(input.resolutionNote,1200);
  if(typeof input.resolutionNote!=='string'||input.resolutionNote.length>1200)throw fail('NOTE_REQUIRED','Use a review note of at most 1200 characters.');
  if(input.status==='closed'&&resolutionNote.length<3)throw fail('NOTE_REQUIRED','Add a customer-visible resolution note before closing.');
  const row=await store.read(VISIT_REQUESTS,input.id);if(!row)throw fail('NOT_FOUND','That request is no longer available.',404);
  const fingerprint=await digest([actor.user.toLowerCase(),input.id,input.status,resolutionNote]);
  if(row.reviewRequestId===input.requestId){if(row.reviewFingerprint!==fingerprint)throw fail('IDEMPOTENCY_CONFLICT','This request ID was reused for a different review.',409);return {ok:true,replayed:true,request:visitRequestView(row)};}
  if(row.revision!==input.expectedRevision||row.status==='closed')throw fail('CHANGED','This request changed. Refresh before reviewing it.',409);
  const patch={status:input.status,resolutionNote,reviewedAt:now,reviewedBy:actor.user,reviewRequestId:input.requestId,reviewFingerprint:fingerprint};
  try{await store.commit([{collection:VISIT_REQUESTS,id:row.id,revision:row.revision,patch},auditWrite({actor:{id:actor.user.toLowerCase(),kind:'human',role:actor.role},via:'hub',action:'customer.visit_request_reviewed',entity:{collection:VISIT_REQUESTS,id:row.id},before:{status:row.status},after:{status:input.status},requestId:input.requestId,now})]);}
  catch(error){const latest=await store.read(VISIT_REQUESTS,input.id);if(latest?.reviewRequestId===input.requestId&&latest.reviewFingerprint===fingerprint)return {ok:true,replayed:true,request:visitRequestView(latest)};throw fail('CHANGED','The review could not be confirmed. Retry the same request.',error.code==='dispatch_revision_conflict'?409:503);}
  return {ok:true,replayed:false,request:visitRequestView({...row,...patch})};
}
