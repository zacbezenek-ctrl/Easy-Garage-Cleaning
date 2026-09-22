/* Compatibility entry point for the Hub's older booking forms.
 * Scheduling authority, crew checks and immutable receipts remain server-side. */
(function(){
'use strict';
const prefix='egc-booking-request-v1:', memory=new Map(), busy=new Set();let generation=0;
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const canonical=value=>Array.isArray(value)?'['+value.map(canonical).join(',')+']':plain(value)?'{'+Object.entries(value).filter(([,value])=>value!==undefined).sort(([a],[b])=>a.localeCompare(b)).map(([key,value])=>JSON.stringify(key)+':'+canonical(value)).join(',')+'}':JSON.stringify(value);
const error=(message,code='booking_invalid',status=400)=>Object.assign(new Error(message),{code,status});
const user=()=>String(sessionStorage.getItem('egc_u')||'').trim().toLowerCase();
const cacheKey=key=>prefix+user()+':'+key;
function pending(key){if(memory.has(cacheKey(key)))return memory.get(cacheKey(key));try{const row=JSON.parse(sessionStorage.getItem(cacheKey(key))||'null');if(row&&typeof row.fingerprint==='string'&&plain(row.request)){memory.set(cacheKey(key),row);return row;}}catch{}return null;}
function rememberStored(k,value){if(value){memory.set(k,value);try{sessionStorage.setItem(k,JSON.stringify(value));}catch{}}else{memory.delete(k);try{sessionStorage.removeItem(k);}catch{}}}
function recoveries(){const start=prefix+user()+':';try{for(const key of Object.keys(sessionStorage))if(key.startsWith(start))pending(key.slice(start.length));}catch{}return [...memory].filter(([key])=>key.startsWith(start)).map(([key,row])=>({key:key.slice(start.length),...row}));}
function recoveryPanel(){
  if(typeof document==='undefined'||!document.body)return;
  let panel=document.getElementById('egc-booking-recovery');const rows=recoveries().filter(row=>!busy.has(cacheKey(row.key)));
  if(!rows.length){panel?.remove();return;}
  if(!panel){panel=document.createElement('section');panel.id='egc-booking-recovery';panel.setAttribute('aria-label','Unverified booking saves');panel.setAttribute('aria-live','polite');document.body.append(panel);}
  panel.replaceChildren();const heading=document.createElement('strong');heading.textContent='A booking save needs verification';panel.append(heading);
  for(const row of rows){const box=document.createElement('div'),text=document.createElement('p'),button=document.createElement('button');text.textContent=row.field==='customer'?'Customer save: retry to verify it, then return to booking.':(row.request.action==='schedule.cancel'?'Cancellation':row.request.action==='schedule.update'?'Schedule change':'New booking')+' · '+(row.request.changes?.date||row.request.jobId||'saved request');button.type='button';button.textContent='Retry saved request';button.onclick=async()=>{button.disabled=true;try{const saved=await retryPending(row.key);if(typeof jobsCache!=='undefined'&&row.field!=='customer')jobsCache=[...jobsCache.filter(job=>job.id!==saved.id),saved];window.dispatchEvent(new CustomEvent('egc:booking-recovered',{detail:{job:row.field==='customer'?null:saved}}));if(typeof showToast==='function')showToast(row.field==='customer'?'Customer verified. Return to booking to finish the schedule.':'Saved booking verified.');}catch(problem){if(panel.isConnected){text.textContent=message(problem);button.disabled=false;}}};box.append(text,button);panel.append(box);}
}
async function api(query='',body=null,endpoint='/api/dispatch'){
  let response;try{response=await fetch(endpoint+query,{method:body?'POST':'GET',credentials:'same-origin',cache:'no-store',headers:body?{'Content-Type':'application/json'}:undefined,body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(25000)});}catch{throw error('The save could not be verified. Retry the unchanged request.','booking_outcome_unknown',503);}
  const data=await response.json().catch(()=>({}));
  if(!response.ok||data.ok!==true)throw Object.assign(error(data.error||'Dispatch could not verify this request.',data.code||'booking_unavailable',response.ok?503:response.status),{details:data.details});
  return data;
}
function message(problem){
  if(problem.status===401)return'Sign in again, then retry your saved booking.';
  if(problem.status===403)return'An operations manager account is required to save this schedule.';
  if(problem.details?.conflicts?.length)return problem.details.conflicts.map(row=>row.message||'Scheduling conflict with '+(row.jobId||row.employeeId||'another assignment')).join(' ');
  if(/revision/.test(problem.code||''))return'This job changed after it was opened. Reopen the latest job before editing its schedule.';
  return problem.message||'This change could not be verified. Keep the form and retry.';
}
async function snapshot(jobId){const data=await api('?'+new URLSearchParams({view:'job',jobId}));if(!data.job?.revision||!Array.isArray(data.roster))throw error('The current job could not be verified. Refresh and try again.','booking_snapshot_incomplete',503);return data;}
function ids(job,roster){
  const values=Array.isArray(job.assignedCrew)?job.assignedCrew:String(job.assignedTo||'').split(/[,+/&]/).map(value=>value.trim()).filter(Boolean);
  const result=values.map(value=>{
    const explicit=plain(value)?value.username||value.user||value.id:null,name=String(explicit||value?.name||value||'').trim().toLowerCase();
    const exact=roster.filter(person=>person.id===name),matches=exact.length?exact:explicit?[]:roster.filter(person=>String(person.name||'').trim().toLowerCase()===name);
    if(matches.length!==1)throw error('Choose active employees from the current roster. The crew entry “'+name+'” could not be verified.','booking_employee_unverified');
    return matches[0].id;
  });
  return [...new Set(result)];
}
function payloadFields(job){
  const names=['date','time','endDate','endTime','title','address','serviceType','accessInstructions','customerInstructions','opsNotes','requiredEquipment','materials','crewLead','crewId','vehicleId','travelBufferMinutes','recurrence','reminderDays','notify','shiftPickupEnabled','notes'];
  const changes=Object.fromEntries(names.filter(name=>job[name]!==undefined).map(name=>[name,job[name]]));
  changes.endDate=job.endDate||job.date||'';
  for(const name of ['crewNeeded','reminderDays','travelBufferMinutes'])if(job[name]!==undefined)changes[name]=Number(job[name]);
  if(job.crewNeeded===undefined&&job.crewSize)changes.crewNeeded=Number(job.crewSize);
  // Legacy structured walkthrough instructions must remain intact on updates.
  if(typeof job.jobInstructions==='string')changes.jobInstructions=job.jobInstructions;
  return changes;
}
function intent(job,previous){return{kind:job.type==='walkthrough'?'walkthrough':job.type==='blocked'?'blocked':'job',jobId:previous?.id||null,customerId:job.customerId||previous?.customerId||null,
  customer:{name:job.customer||'',phone:job.phone||'',email:job.email||'',address:job.address||'',highlevelContactId:job.highlevelContactId||''},
  sourceTemplateJobId:job.sourceTemplateJobId||null,sourceWalkthroughId:job.sourceWalkthroughId||null,assignedCrew:job.assignedCrew,assignedTo:job.assignedTo||'',changes:payloadFields(job)};}
async function request(key,fingerprint,build,{endpoint='/api/dispatch',field='job'}={}){
  const storageKey=cacheKey(key),started=generation,identity=user();
  const current=()=>{if(started!==generation||identity!==user())throw error('The signed-in account changed. Sign in again before continuing.','booking_session_changed',401);};
  if(busy.has(storageKey))throw error('This booking is already saving. Wait for the result.','booking_in_progress',409);
  let record=pending(key);
  if(record&&record.fingerprint!==fingerprint)throw error('The previous save has an unknown outcome. Retry its unchanged fields before editing this booking.','booking_pending_operation',409);
  busy.add(storageKey);
  try{
    if(!record){const body=await build();current();record={fingerprint,request:body,endpoint,field};rememberStored(storageKey,record);}
    current();
    const result=await api('',record.request,endpoint);
    current();
    if(!result[field]?.id||!result[field].revision)throw error('The server returned an incomplete save. Retry this same booking to verify it.','booking_outcome_unknown',503);
    rememberStored(storageKey,null);return result[field];
  }catch(problem){
    if(started===generation&&problem.status&&problem.status<500&&![401,403,408,429].includes(problem.status)&&problem.code!=='booking_pending_operation')rememberStored(storageKey,null);
    problem.message=message(problem);throw problem;
  }finally{busy.delete(storageKey);recoveryPanel();}
}
async function retryPending(key){const record=pending(key);if(!record)throw error('There is no saved request to retry.');return request(key,record.fingerprint,async()=>record.request,{endpoint:record.endpoint||(key.startsWith('customer:')?'/api/customer-resolve':'/api/dispatch'),field:record.field||(key.startsWith('customer:')?'customer':'job')});}
async function save(job,previous={},options={}){
  const key=options.operationKey||job.id||'booking',draft=intent(job,previous),fingerprint=canonical(draft);
  return request(key,fingerprint,async()=>{
    let data,customerId=draft.customerId;
    if(previous?.id){
      data=await snapshot(previous.id);
      if(previous.revision&&previous.revision!==data.job.revision||previous.updatedAt&&previous.updatedAt!==data.job.updatedAt)throw error('This job changed after the form was opened. Reopen it before saving.','dispatch_revision_conflict',409);
    }else{
      const date=job.date||new Intl.DateTimeFormat('en-CA',{timeZone:'America/Denver',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date()),endDate=new Date(Date.parse(date+'T12:00:00Z')+86400000).toISOString().slice(0,10);
      data=await api('?'+new URLSearchParams({startDate:date,endDate,includeUnscheduled:'true'}));
      if(!Array.isArray(data.roster))throw error('The active crew roster could not be verified.','booking_roster_unavailable',503);
      if(draft.kind!=='blocked'&&!customerId){
        const customer=await (options.resolveCustomer?options.resolveCustomer(draft.customer):resolveCustomer(draft.customer,key));customerId=customer?.id;
        if(!customerId)throw error('The customer link could not be verified.','booking_customer_required',409);
      }
    }
    const changes={...draft.changes};
    if(draft.kind==='blocked'){
      for(const name of Object.keys(changes))if(!['date','time','endDate','endTime','title','notes','opsNotes'].includes(name))delete changes[name];
      changes.title=job.title||job.customer||'Blocked time';
    }else{
      changes.assignedCrew=ids(job,data.roster);
      if(changes.crewLead){const lead=ids({assignedCrew:[changes.crewLead]},data.roster)[0];changes.crewLead=lead;}
    }
    return{action:previous?.id?'schedule.update':'schedule.create',requestId:crypto.randomUUID(),...(previous?.id?{jobId:previous.id,expectedRevision:data.job.revision}:{kind:draft.kind,...(customerId?{customerId}:{}),...(draft.sourceTemplateJobId?{sourceTemplateJobId:draft.sourceTemplateJobId}:{}),...(!draft.sourceTemplateJobId&&draft.sourceWalkthroughId?{sourceWalkthroughId:draft.sourceWalkthroughId}:{})}),changes};
  });
}
async function cancel(job,reason,options={}){
  const key=options.operationKey||'cancel:'+job.id,fingerprint=canonical({id:job.id,reason});
  return request(key,fingerprint,async()=>{const current=await snapshot(job.id);if(job.revision&&job.revision!==current.job.revision||job.updatedAt&&job.updatedAt!==current.job.updatedAt)throw error('This job changed after it was opened. Refresh before cancelling.','dispatch_revision_conflict',409);return{action:'schedule.cancel',requestId:crypto.randomUUID(),jobId:job.id,expectedRevision:current.job.revision,cancellationReason:String(reason||'').trim(),changes:{}};});
}
async function resolveCustomer(customer,key='customer'){
  return request('customer:'+key,canonical(customer),async()=>({requestId:crypto.randomUUID(),customer}),{endpoint:'/api/customer-resolve',field:'customer'});
}
async function roster(){const result=await api();if(!Array.isArray(result.roster))throw error('The active crew roster could not be loaded.','booking_roster_unavailable',503);return result.roster;}
function clear(){generation++;memory.clear();busy.clear();try{for(const key of Object.keys(sessionStorage))if(key.startsWith(prefix))sessionStorage.removeItem(key);}catch{}recoveryPanel();}
window.addEventListener('egc:signout',clear);
window.addEventListener('beforeunload',event=>{if(recoveries().length||busy.size){event.preventDefault();event.returnValue='';}});
window.addEventListener('DOMContentLoaded',recoveryPanel);
window.EGCBooking={save,cancel,snapshot,resolveCustomer,roster,pending,message,recoveries,retryPending,canLeave:()=>recoveries().length===0&&busy.size===0};
recoveryPanel();
})();
