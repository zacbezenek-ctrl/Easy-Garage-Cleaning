import {firestoreFetch} from './firebase-service-account.js';
import {financialFacts} from './operations-financials.js';
const PROJECT='egcw-1ec83';
const BASE=`https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents/jobs`;
const SAFE_ID=/^[A-Za-z0-9_-]{1,180}$/;
const forbidden=id=>!SAFE_ID.test(id)||/^(secure_|_egc_)/.test(id);
export function decodeFirestore(value) {
  if(!value||typeof value!=='object')return null;
  if('stringValue'in value)return value.stringValue;
  if('booleanValue'in value)return value.booleanValue;
  if('integerValue'in value)return Number(value.integerValue);
  if('doubleValue'in value)return value.doubleValue;
  if('timestampValue'in value)return value.timestampValue;
  if('nullValue'in value)return null;
  if('arrayValue'in value)return(value.arrayValue.values||[]).map(decodeFirestore);
  if('mapValue'in value)return Object.fromEntries(Object.entries(value.mapValue.fields||{}).map(([k,v])=>[k,decodeFirestore(v)]));
  return null;
}
const decodeDoc=d=>({...Object.fromEntries(Object.entries(d.fields||{}).map(([k,v])=>[k,decodeFirestore(v)])),id:String(d.name||'').split('/').pop(),sourceRevision:d.updateTime||null});
const excluded=r=>forbidden(r.id)||['employee_hub_v2','schedule_lock','crew_availability'].includes(r.recordType)||['blocked','availability'].includes(r.type);
function error(code,status=503){const e=new Error(code);e.status=status;return e;}
export function localInstant(date,time,timeZone='America/Denver') {
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date||'')||!/^\d{2}:\d{2}$/.test(time||''))return null;
  const [y,m,d]=date.split('-').map(Number),[h,min]=time.split(':').map(Number);
  const wall=Date.UTC(y,m-1,d,h,min);
  if(new Date(wall).toISOString().slice(0,16)!==`${date}T${time}`)return null;
  const fmt=new Intl.DateTimeFormat('en-CA',{timeZone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
  const match=ts=>{const p=Object.fromEntries(fmt.formatToParts(new Date(ts)).map(x=>[x.type,x.value]));return`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`===`${date}T${time}`;};
  // Denver offset candidates immediately around this local day cover DST transitions.
  const offsets=new Set([-86400000,0,86400000].map(delta=>{
    const ts=wall+delta,p=Object.fromEntries(fmt.formatToParts(new Date(ts)).map(x=>[x.type,x.value]));
    return Date.UTC(Number(p.year),Number(p.month)-1,Number(p.day),Number(p.hour),Number(p.minute))-ts;
  }));
  const candidates=[...offsets].map(offset=>wall-offset).filter(match);
  return candidates.length===1?new Date(candidates[0]).toISOString():null;
}
export function calendarItem(r,timeZone) {
  const date=String(r.date||'').slice(0,10);
  const start=localInstant(date,String(r.time||''),timeZone);
  const localEndDate=String(r.endDate||date);
  const end=localInstant(localEndDate,String(r.endTime||''),timeZone);
  return {id:r.id,source:'employee_hub',sourceRevision:r.sourceRevision,kind:r.type==='walkthrough'?'walkthrough':'job',
    status:r.pipelineStatus||r.status||'unknown',localDate:date,localEndDate,localStart:r.time||null,localEnd:r.endTime||null,timeZone,
    startAt:start,endAt:end,timeNeedsReview:!start||!end||end<=start,customer:r.customer||null,address:r.address||null,
    jobId:r.type==='walkthrough'?null:r.id,sourceWalkthroughId:r.sourceWalkthroughId||null,highlevelContactId:r.highlevelContactId||null,
    portalCustomerId:r.customerId||null,portalProjectId:r.projectId||null,highlevelAppointmentId:r.highlevelAppointmentId||null,
    highlevelCalendarId:r.highlevelCalendarId||null,providerAppointmentStatus:r.providerAppointmentStatus||null,
    syncStatus:r.syncStatus||'unknown',syncedAt:r.syncedAt||null,createdAt:r.createdAt||null,updatedAt:r.updatedAt||null,completedAt:r.completedAt||null};
}
export async function portalCalendar(env,command,fetcher=firestoreFetch) {
  const {startDate,endDate,timeZone='America/Denver',offset=0,limit=50}=command;
  const validDate=s=>{try{return /^\d{4}-\d{2}-\d{2}$/.test(s||'')&&new Date(s+'T00:00:00Z').toISOString().slice(0,10)===s;}catch{return false;}};
  if(!validDate(startDate)||!validDate(endDate)||startDate>=endDate||!Number.isInteger(offset)||offset<0||!Number.isInteger(limit)||limit<1||limit>200)throw error('invalid_calendar_range',400);
  if(timeZone!=='America/Denver')throw error('portal_timezone_is_America_Denver',400);
  if(Date.parse(endDate)-Date.parse(startDate)>366*86400000)throw error('calendar_range_too_large',400);
  const docs=[],exceptions=[],ids=new Set();let token='',pages=0;const tokens=new Set();
  const fields=['recordType','type','date','endDate','time','endTime','customer','address','status','pipelineStatus','sourceWalkthroughId','highlevelContactId',
    'customerId','projectId','highlevelAppointmentId','highlevelCalendarId','providerAppointmentStatus','syncStatus','syncedAt','createdAt','updatedAt','completedAt'];
  do {
    if(++pages>200)throw error('portal_calendar_scan_incomplete');
    const url=new URL(BASE);url.searchParams.set('pageSize','500');if(token)url.searchParams.set('pageToken',token);
    for(const field of fields)url.searchParams.append('mask.fieldPaths',field);
    const response=await fetcher(env,url.toString());
    if(!response.ok)throw error('portal_calendar_unavailable');
    const page=await response.json();
    if(page.documents!==undefined&&!Array.isArray(page.documents))throw error('portal_calendar_invalid_response');
    for(const raw of page.documents||[]){const r=decodeDoc(raw);if(excluded(r))continue;if(ids.has(r.id))throw error('portal_calendar_changed_during_scan');ids.add(r.id);if(['job','walkthrough','cleanout','reorg'].includes(r.type)&&(!validDate(r.date)||r.endDate&&(!validDate(r.endDate)||r.endDate<r.date))){exceptions.push({recordId:r.id,code:'schedule_date_missing_or_invalid'});continue;}if((r.endDate||r.date)>=startDate&&r.date<endDate)docs.push(r);}
    token=page.nextPageToken||'';if(token&&tokens.has(token))throw error('portal_calendar_pagination_stalled');tokens.add(token);
  }while(token);
  const items=docs.map(r=>calendarItem(r,timeZone)).sort((a,b)=>String(a.localDate).localeCompare(String(b.localDate))||String(a.localStart).localeCompare(String(b.localStart))||a.id.localeCompare(b.id));
  return {ok:true,authority:'employee_hub',items:items.slice(offset,offset+limit),total:items.length,nextOffset:offset+limit<items.length?offset+limit:null,
    exceptions,coverage:{complete:exceptions.length===0,asOf:new Date().toISOString(),scan:'source_paginated_scan_not_cross_store_snapshot'},timeZone,startDate,endDate};
}
export async function portalJob(env,id,fetcher=firestoreFetch) {
  if(forbidden(id))throw error('portal_job_not_found',404);
  const response=await fetcher(env,BASE+'/'+encodeURIComponent(id));
  if(response.status===404)throw error('portal_job_not_found',404);
  if(!response.ok)throw error('portal_job_unavailable');
  const r=decodeDoc(await response.json());
  if(excluded(r)||r.id!==id)throw error('portal_job_not_found',404);
  const financials=financialFacts(r);
  return {ok:true,authority:'employee_hub',job:{id:r.id,revision:r.sourceRevision,type:['cleanout','reorg'].includes(r.type)?'job':r.type||'job',sourceType:r.type||'job',status:r.pipelineStatus||r.status||'unknown',
    customerId:r.customerId||null,projectId:r.projectId||null,sourceWalkthroughId:r.sourceWalkthroughId||null,highlevelContactId:r.highlevelContactId||null,customer:r.customer||null,address:r.address||null,
    date:r.date||null,endDate:r.endDate||r.date||null,time:r.time||null,endTime:r.endTime||null,scope:r.jobInstructions||r.scope||null,
    scopeApproval:r.acceptance?.acceptedAt?'customer_acceptance_recorded':'not_explicit_in_source',notes:r.notes||null,operationNotes:r.operationNotes||[],operationalScope:r.operationalScope||null,completedAt:r.completedAt||financials.completion?.at||null,soldAt:financials.quote?.at||null,
    highlevelAppointmentId:r.highlevelAppointmentId||null,highlevelCalendarId:r.highlevelCalendarId||null,providerAppointmentStatus:r.providerAppointmentStatus||null,
    syncStatus:r.syncStatus||'unknown',syncedAt:r.syncedAt||null,createdAt:r.createdAt||null,updatedAt:r.updatedAt||null},
    financials,reviewedWalkthroughScope:r.reviewedWalkthroughScope||null,
    coverage:{complete:true,asOf:new Date().toISOString()}};
}

/** Evidence reads follow exact provider identities, including unscheduled work.
 * Calendar absence must never hide an accepted estimate or a customer receipt. */
export async function portalEvidence(env,command,fetcher=firestoreFetch){
  const requested=command.contactProviderIds;
  if(!Array.isArray(requested)||!requested.length||requested.length>500||requested.some(id=>typeof id!=='string'||!SAFE_ID.test(id)))throw error('invalid_portal_evidence_contacts',400);
  const contactIds=new Set(requested),records=[],seen=new Set(),tokens=new Set();let token='',pages=0;
  const fields=['recordType','type','highlevelContactId','customerId','projectId','sourceWalkthroughId','date','time','endTime','status','pipelineStatus','createdAt','updatedAt','completedAt','soldAt','highlevelAppointmentId','address','isTest','test','estimate','customerApproval','payment','invoice','postJobChecklist','refunds'];
  do{
    if(++pages>200)throw error('portal_evidence_scan_incomplete');
    const url=new URL(BASE);url.searchParams.set('pageSize','500');if(token)url.searchParams.set('pageToken',token);for(const field of fields)url.searchParams.append('mask.fieldPaths',field);
    const response=await fetcher(env,url.toString());if(!response.ok)throw error('portal_evidence_unavailable');const page=await response.json();
    if(page.documents!==undefined&&!Array.isArray(page.documents))throw error('portal_evidence_invalid_response');
    for(const raw of page.documents||[]){
      const r=decodeDoc(raw);if(excluded(r)||r.isTest===true||r.test===true||!contactIds.has(r.highlevelContactId))continue;
      if(seen.has(r.id))throw error('portal_evidence_changed_during_scan');seen.add(r.id);
      if(!['job','walkthrough','cleanout','reorg'].includes(r.type))continue;
      const financials=financialFacts(r);records.push({id:r.id,highlevelContactId:r.highlevelContactId,kind:r.type==='walkthrough'?'walkthrough':'job',status:r.pipelineStatus||r.status||'unknown',
        createdAt:r.createdAt||null,updatedAt:r.updatedAt||null,completedAt:r.completedAt||financials.completion?.at||null,soldAt:financials.quote?.at||null,
        startAt:localInstant(String(r.date||''),String(r.time||'')),sourceRevision:r.sourceRevision,highlevelAppointmentId:r.highlevelAppointmentId||null,jobId:r.type==='walkthrough'?null:r.id,sourceWalkthroughId:r.sourceWalkthroughId||null,address:r.address||null,financials});
    }
    token=page.nextPageToken||'';if(token&&tokens.has(token))throw error('portal_evidence_pagination_stalled');tokens.add(token);
  }while(token);
  return{ok:true,authority:'employee_hub',records:records.sort((a,b)=>a.id.localeCompare(b.id)),contactProviderIds:[...contactIds],coverage:{complete:true,asOf:new Date().toISOString(),scan:'exact_contacts_paginated_source_not_cross_store_snapshot'}};
}
