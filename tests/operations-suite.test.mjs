import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const read=(p)=>fs.readFileSync(new URL('../'+p,import.meta.url),'utf8');
const employee=read('employee.html');
const suite=read('employee-suite.js');
const crew=read('crew/gameplan.html');
const prejob=read('crew/prejob.html');
const postjob=read('crew/postjob.html');
const copilot=read('copilot.html');
const relay=read('functions/api/operations-event.js');
const highlevel=read('functions/api/highlevel.js');
const webLead=read('functions/api/web-lead.js');
const statusApi=read('functions/api/integration-status.js');
const commercial=read('commercial-junk-removal-fort-collins-co.html');

test('employee hub loads the EGC operations suite without the duplicate CRM overlay',()=>{
  assert.doesNotMatch(employee,/employee-crm\.(?:js|css)/);
  assert.match(employee,/employee-suite\.js/);
  assert.match(employee,/employee-suite\.css/);
});

test('operations suite follows the EGC operating model instead of duplicating the CRM',()=>{
  for(const area of ['today','schedule','pipeline','walkthroughs','delivery','scorecard','proof','playbook','settings']){
    assert.match(suite,new RegExp("'"+area+"'"),area+' is missing');
  }
  for(const marker of ['HighLevel is CRM','Walkthrough-first','Contribution / lead','The EGC playbook'])assert.match(suite,new RegExp(marker));
  for(const duplicate of ['collection:\'invoices\'','collection:\'payments\'','crew_members','time_entries'])assert.doesNotMatch(suite,new RegExp(duplicate));
  assert.doesNotMatch(statusApi,/jobber:/);
});

test('HighLevel bridge keeps credentials server-side and supports field continuity',()=>{
  for(const marker of ['HIGHLEVEL_API_KEY','HIGHLEVEL_LOCATION_ID','HIGHLEVEL_JOB_CALENDAR_ID','/opportunities/search','/calendars/events','/calendars/events/appointments','/contacts/upsert','egc-job-scheduled','egc-review-ready','6-month garage check-in'])assert.match(highlevel,new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
  assert.doesNotMatch(employee,/HIGHLEVEL_API_KEY\s*[:=]\s*['"][^'"]+/);
  assert.match(crew,/\/api\/highlevel/);
  assert.match(crew,/highlevel_contact_id/);
});

test('private webhook destinations are absent from browser and function source',()=>{
  assert.doesNotMatch(employee,/hooks\.zapier\.com\/hooks\/catch\/\d+\/[^.]+/);
  assert.doesNotMatch(suite,/hooks\.zapier\.com/);
  assert.doesNotMatch(read('employee-crm.js'),/hooks\.zapier\.com/);
  assert.doesNotMatch(read('functions/api/crew-hook.js'),/hooks\.zapier\.com\/hooks\/catch\/\d+/);
  for(const key of ['QUOTE_FOLLOWUP_WEBHOOK_URL','BOOKING_WEBHOOK_URL','REVIEW_WEBHOOK_URL','META_SIGNAL_WEBHOOK_URL'])assert.match(relay,new RegExp(key));
});

test('walkthrough is photo-led, builds price in the background, and saves Hub scheduling',()=>{
  for(const marker of ['Customer','Photos','Scope','Finish','Schedule','Review','whyNow','outcome','truckPlacement','PHOTO_COUNT','Homeowner signature','function recommend','saveHubJob','scheduleSource'])assert.match(crew,new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
  assert.doesNotMatch(crew,/14-point|Damage Zone|Comeback Zone|layout sketch|AI after/i);
  assert.match(crew,/discovery:\{/);
  assert.match(crew,/function validateStep/);
});

test('Hub owns scheduling while HighLevel owns CRM automation',()=>{
  for(const marker of ['HUB SCHEDULE','Schedule the work here','scheduleSource','Save + sync','New HighLevel leads'])assert.match(suite,new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
  assert.match(suite,/\.set\(job,\{merge:true\}\)/);
  assert.match(suite,/Choose an end time after the start time/);
  for(const field of ['phone','email','address','date','time','endTime','assignedTo','notes','notify'])assert.match(suite,new RegExp(`opsBookField\\('${field}'`));
});

test('schedule writes prevent collisions and retain retryable sync state',()=>{
  for(const marker of ['function collisionFor','function saveScheduledJob','scheduleLockRef','recordType:\'schedule_lock\'','db.runTransaction','SCHEDULE_CONFLICT','remoteCollision','syncAttempts','syncNextRetryAt','retryDueSyncs','opsRetrySync','opsRetryAll','Idempotency-Key']){
    assert.match(suite,new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')),marker+' is missing');
  }
  assert.match(suite,/Math\.min\(24\*60,Math\.pow\(2,Math\.min\(attempts,8\)\)\*5\)/);
  assert.match(suite,/tx\.set\(ref,job,\{merge:true\}\)/);
  assert.doesNotMatch(suite,/collection\(['"]scheduleLocks['"]\)/);
  assert.match(employee,/recordType !== 'schedule_lock'/);
  assert.match(copilot,/recordType !== 'schedule_lock'/);
  assert.doesNotMatch(crew,/collection\(['"]scheduleLocks['"]\)/);
});

test('Hub retries preserve the full walkthrough handoff instead of downgrading to a calendar-only sync',()=>{
  assert.match(suite,/if\(job\.sourceWalkthroughId&&job\.internalNotes&&job\.acceptance\)/);
  for(const marker of ["tool:'game_plan'",'walkthrough_id:job.sourceWalkthroughId','internal_notes:job.internalNotes','client_checklists:job.clientChecklists','discovery:job.discovery','scope:job.scope','logistics:job.logistics','accepted_at:job.acceptance.acceptedAt','photos:{before:Number(job.photoCount||0)}']){
    assert.match(suite,new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')),marker+' is missing from retry payload');
  }
});

test('Hub rescheduling preserves and refreshes the signed walkthrough handoff',()=>{
  for(const marker of ['function replaceBriefLine','function refreshChecklistNotes','function refreshWalkthroughHandoff','latestJobInstructions:job.jobInstructions','latestClientChecklists:job.clientChecklists','if(customerRef)tx.set(customerRef,customerUpdate','job={...previous,...derived','status:b.id?(previous.status','pipelineStatus:b.id?(previous.pipelineStatus']){
    assert.match(suite,new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')),marker+' is missing');
  }
  for(const field of ['CREW / WINDOW','INTERNAL CUSTOMER NOTES','customerNotes','assignedTo','crewSize','arrivalWindow'])assert.match(suite,new RegExp(field.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
  assert.match(suite,/terminalScheduleStages=.*'invoiced'.*'review_requested'.*'closed'/);
  assert.match(suite,/Closed work stays locked/);
});

test('walkthrough conversion keeps canonical IDs and durable acceptance metadata',()=>{
  for(const marker of ['walkthroughId','sourceWalkthroughId','convertedJobId','conversionStatus','acceptanceAt','acceptanceBy','termsVersion','signatureCaptured','in_person_signature','syncIdempotencyKey']){
    assert.match(crew,new RegExp(marker),marker+' is missing');
  }
  assert.match(crew,/hubDb\.collection\('jobs'\)\.doc\(S\.jobId\)/);
  assert.match(crew,/status:'completed',pipelineStatus:'completed'/);
  assert.match(crew,/tx\.set\(sourceRef,\{status:'completed'/);
  for(const page of [prejob,postjob]){
    assert.match(page,/new URLSearchParams\(location\.search\)\.get\("jobId"\)/);
    assert.match(page,/collection\('jobs'\)\.doc\(CENTRAL_JOB_ID\)\.get\(\)/);
  }
  assert.match(suite,/prejob\.html\?jobId=/);
  assert.match(suite,/postjob\.html\?jobId=/);
});

test('walkthrough promise syncs to the job, customer profile, crew brief, and HighLevel notes',()=>{
  for(const marker of ['buildJobInstructions','buildInternalNotes','buildClientChecklists','jobInstructions:instructions','internalNotes','clientChecklists:checklists','customerNotesSummary','latestJobInstructions','latestClientChecklists','customerGoal','keepItems','removeItems','operationalNotes','walkthroughSyncedAt']){
    assert.match(crew,new RegExp(marker),marker+' is missing from the walkthrough handoff');
  }
  assert.match(crew,/hubDb\.collection\('customers'\)\.doc\(customerId\)/);
  for(const page of [prejob,postjob]){
    assert.match(page,/function normalizedInstructions/);
    assert.match(page,/id="job-brief"/);
    assert.match(page,/Internal job brief|Promised outcome/);
    assert.match(page,/keepItems/);
    assert.match(page,/removeItems/);
    assert.match(page,/customerNotes/);
  }
  for(const marker of ['appointmentInstructions','CUSTOMER GOAL','KEEP:','REMOVE:','DO NOT MOVE / EXCLUSIONS','Original customer goal','Crew closeout notes'])assert.match(highlevel,new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
  assert.match(suite,/Latest internal job notes/);
  assert.match(suite,/hasCrewBrief/);
  assert.doesNotMatch(prejob,/status:j\.status==='scheduled'\?'arrived'/);
  assert.doesNotMatch(postjob,/collection\(['"]scheduleLocks['"]\)/);
  assert.match(postjob,/_egc_schedule_lock_/);
  for(const page of [prejob,postjob]){
    assert.match(page,/function renderClientChecklist/);
    assert.match(page,/function totalChecks/);
    assert.match(page,/clientState/);
    assert.match(page,/Generated from this client/);
  }
  assert.match(prejob,/preJobChecklist:\{/);
  assert.match(postjob,/postJobChecklist:\{/);
});

test('HighLevel receives the customer promise in both the contact note and job appointment',async()=>{
  const {onRequestPost}=await import('../functions/api/highlevel.js');
  const calls=[],originalFetch=globalThis.fetch;
  globalThis.fetch=async(url,options={})=>{
    calls.push({url:String(url),options});
    if(String(url).includes('/calendars/events?'))return new Response(JSON.stringify({events:[]}),{status:200});
    if(String(url).endsWith('/calendars/events/appointments'))return new Response(JSON.stringify({id:'appt-job'}),{status:200});
    if(String(url).includes('/opportunities/search?'))return new Response(JSON.stringify({opportunities:[{id:'opp-1',contactId:'contact-1',pipelineId:'anSgrMpYHtAX6YlUHnIR',name:'Customer job',status:'open'}]}),{status:200});
    if(String(url).endsWith('/contacts/contact-1/notes'))return new Response(JSON.stringify({note:{id:'note-1'}}),{status:200});
    return new Response('{}',{status:200});
  };
  try{
    const internalNotes='EGC INTERNAL JOB BRIEF\nCUSTOMER GOAL: Park two cars\nWHY NOW: Moving soon\nKEEP / PROTECT: Tools and bikes\nREMOVE / DONATE: Boxes and broken furniture\nDO NOT MOVE: Red cabinet\nACCESS: keypad — Code 1234\nINTERNAL CUSTOMER NOTES: Call before arrival';
    const payload={tool:'game_plan',job_id:'job-1',opportunity_id:'opp-1',sent_at:'2026-09-03T22:00:00.000Z',client:{name:'Test Customer',highlevel_contact_id:'contact-1',address:'123 Main'},quote:{title:'Test garage',total:1500,deposit:300,job_date:'2026-09-15',start_time:'09:00',end_time:'13:00',start_at:'2026-09-15T15:00:00.000Z',end_at:'2026-09-15T19:00:00.000Z'},discovery:{why_now:'Moving soon',success:'Park two cars'},scope:{loads:2,garages:2,fullness:'full',sort_method:'Customer decides',keep_items:'Tools and bikes',remove_items:'Boxes and broken furniture',exclusions:'Red cabinet',hazards:['paint'],access:['keypad'],finish:['deep clean']},logistics:{truck_placement:'left driveway',notes:'Code 1234',assigned_to:'Alex',crew_size:3},internal_notes:internalNotes,acceptance:{accepted_by:'Test Customer',accepted_at:'2026-09-03T22:00:00.000Z'},photos:{before:5},notes:'Call before arrival'};
    const request=new Request('https://easygaragecleaning.com/api/highlevel',{method:'POST',headers:{Origin:'https://easygaragecleaning.com','Content-Type':'application/json'},body:JSON.stringify(payload)});
    const response=await onRequestPost({request,env:{HIGHLEVEL_API_KEY:'test-key',HIGHLEVEL_LOCATION_ID:'location-1'}});
    assert.equal(response.status,200);
    const noteCall=calls.find(x=>x.url.endsWith('/contacts/contact-1/notes'));
    const appointmentCall=calls.find(x=>x.url.endsWith('/calendars/events/appointments')&&x.options.method==='POST');
    assert.ok(noteCall,'walkthrough contact note was not written');
    assert.ok(appointmentCall,'job appointment was not written');
    const note=JSON.parse(noteCall.options.body).body,appointment=JSON.parse(appointmentCall.options.body).description;
    for(const text of ['CUSTOMER GOAL: Park two cars','KEEP / PROTECT: Tools and bikes','REMOVE / DONATE: Boxes and broken furniture','DO NOT MOVE: Red cabinet','ACCESS: keypad — Code 1234','INTERNAL CUSTOMER NOTES: Call before arrival'])assert.match(note,new RegExp(text));
    assert.equal(appointment,internalNotes);
  }finally{globalThis.fetch=originalFetch}
});

test('resaving a walkthrough updates the existing HighLevel job appointment and keeps it scheduled',async()=>{
  const {onRequestPost}=await import('../functions/api/highlevel.js');
  const calls=[],originalFetch=globalThis.fetch,internalNotes='EGC INTERNAL JOB BRIEF\nCUSTOMER GOAL: Updated finished garage\nKEEP / PROTECT: Red toolbox';
  globalThis.fetch=async(url,options={})=>{
    calls.push({url:String(url),options});
    if(String(url).includes('/opportunities/search?'))return new Response(JSON.stringify({opportunities:[{id:'opp-1',contactId:'contact-1',pipelineId:'anSgrMpYHtAX6YlUHnIR',name:'Customer job',status:'open'}]}),{status:200});
    if(String(url).endsWith('/contacts/contact-1/notes'))return new Response(JSON.stringify({note:{id:'note-2'}}),{status:200});
    if(String(url).endsWith('/calendars/events/appointments/appt-existing')&&options.method==='PUT')return new Response(JSON.stringify({id:'appt-existing'}),{status:200});
    return new Response('{}',{status:200});
  };
  try{
    const payload={tool:'game_plan',job_id:'job-1',opportunity_id:'opp-1',client:{name:'Test Customer',address:'123 Main',highlevel_contact_id:'contact-1',highlevel_job_appointment_id:'appt-existing'},quote:{title:'Test garage',total:1500,job_date:'2026-09-15',start_time:'10:00',end_time:'14:00',start_at:'2026-09-15T16:00:00.000Z',end_at:'2026-09-15T20:00:00.000Z'},internal_notes:internalNotes};
    const request=new Request('https://easygaragecleaning.com/api/highlevel',{method:'POST',headers:{Origin:'https://easygaragecleaning.com','Content-Type':'application/json'},body:JSON.stringify(payload)});
    const response=await onRequestPost({request,env:{HIGHLEVEL_API_KEY:'test-key',HIGHLEVEL_LOCATION_ID:'location-1'}}),result=await response.json();
    assert.equal(response.status,200);
    assert.equal(result.appointmentId,'appt-existing');
    assert.equal(result.updated,true);
    const update=calls.find(x=>x.url.endsWith('/calendars/events/appointments/appt-existing')&&x.options.method==='PUT');
    assert.ok(update,'existing job appointment was not updated');
    assert.equal(JSON.parse(update.options.body).description,internalNotes);
    assert.equal(calls.filter(x=>x.url.endsWith('/calendars/events/appointments')&&x.options.method==='POST').length,0);
  }finally{globalThis.fetch=originalFetch}
});

test('Hub finance scaffolding and customer history work without claiming external settlement',()=>{
  for(const marker of ['function customerRows','function customerHistory','function financeState','function financeBoard','opsFinanceAction','Record approval','Record deposit','Issue invoice','Record payment','acceptanceMethod','termsVersion','verified:true','A payment reference is required for verification','Hub records only · keys needed']){
    assert.match(suite,new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')),marker+' is missing');
  }
  assert.match(suite,/jobs\(\)\.filter\(j=>j\.type!=='blocked'\)/);
  assert.match(suite,/const customerKey=j=>j\.highlevelContactId\|\|String\(j\.phone/);
  assert.doesNotMatch(suite,/Stripe payment (?:sent|completed)|QuickBooks invoice (?:sent|completed)/i);
});

test('HighLevel schedule handoff advances the configured pipeline stage',async()=>{
  const {onRequestPost}=await import('../functions/api/highlevel.js');
  const calls=[],originalFetch=globalThis.fetch;
  globalThis.fetch=async(url,options={})=>{
    calls.push({url:String(url),options});
    if(String(url).includes('/opportunities/search?'))return new Response(JSON.stringify({opportunities:[{id:'opp-1',contactId:'contact-1',pipelineId:'pipe-1',name:'Test garage',status:'open',monetaryValue:1400}]}),{status:200});
    if(String(url).endsWith('/calendars/events/appointments'))return new Response(JSON.stringify({id:'appt-1'}),{status:200});
    return new Response('{}',{status:200});
  };
  try{
    const request=new Request('https://easygaragecleaning.com/api/highlevel',{method:'POST',headers:{Origin:'https://easygaragecleaning.com','Content-Type':'application/json'},body:JSON.stringify({tool:'schedule',event_type:'job',opportunity_id:'opp-1',start_time:'2026-09-10T15:00:00.000Z',end_time:'2026-09-10T18:00:00.000Z',client:{name:'Test Customer',highlevel_contact_id:'contact-1'}})});
    const response=await onRequestPost({request,env:{HIGHLEVEL_API_KEY:'test-key',HIGHLEVEL_LOCATION_ID:'location-1',HIGHLEVEL_PIPELINE_ID:'pipe-1',HIGHLEVEL_SCHEDULED_STAGE_ID:'stage-scheduled',HIGHLEVEL_JOB_CALENDAR_ID:'calendar-1'}});
    const result=await response.json();
    assert.equal(response.status,200);
    assert.equal(result.pipeline.updated,true);
    const update=calls.find(x=>x.url.endsWith('/opportunities/opp-1')&&x.options.method==='PUT');
    assert.ok(update,'opportunity update was not sent');
    assert.equal(update.options.headers.Version,'v3');
    assert.deepEqual(JSON.parse(update.options.body),{pipelineId:'pipe-1',name:'Test garage',pipelineStageId:'stage-scheduled',status:'open',monetaryValue:1400});
  }finally{globalThis.fetch=originalFetch}
});

test('HighLevel creates one retry-safe pipeline opportunity for a brand-new customer',async()=>{
  const {onRequestPost}=await import('../functions/api/highlevel.js');
  const calls=[],originalFetch=globalThis.fetch;
  globalThis.fetch=async(url,options={})=>{
    calls.push({url:String(url),options});
    if(String(url).endsWith('/contacts/upsert'))return new Response(JSON.stringify({contact:{id:'contact-new'}}),{status:200});
    if(String(url).includes('/calendars/events?'))return new Response(JSON.stringify({events:[]}),{status:200});
    if(String(url).endsWith('/calendars/events/appointments'))return new Response(JSON.stringify({id:'appt-new'}),{status:200});
    if(String(url).includes('/opportunities/search?'))return new Response(JSON.stringify({opportunities:[]}),{status:200});
    if(String(url).endsWith('/opportunities/upsert'))return new Response(JSON.stringify({opportunity:{id:'opp-new'}}),{status:200});
    return new Response('{}',{status:200});
  };
  try{
    const request=new Request('https://easygaragecleaning.com/api/highlevel',{method:'POST',headers:{Origin:'https://easygaragecleaning.com','Content-Type':'application/json','Idempotency-Key':'schedule:job-new:1'},body:JSON.stringify({tool:'schedule',event_type:'job',opportunity_name:'New Customer — Garage transformation',monetary_value:1750,start_time:'2026-09-11T15:00:00.000Z',end_time:'2026-09-11T18:00:00.000Z',client:{name:'New Customer',phone:'9705550199'}})});
    const response=await onRequestPost({request,env:{HIGHLEVEL_API_KEY:'test-key',HIGHLEVEL_LOCATION_ID:'location-1',HIGHLEVEL_PIPELINE_ID:'pipe-1',HIGHLEVEL_SCHEDULED_STAGE_ID:'stage-scheduled',HIGHLEVEL_JOB_CALENDAR_ID:'calendar-1'}});
    const result=await response.json();
    assert.equal(response.status,200);
    assert.equal(result.pipeline.created,true);
    assert.equal(result.pipeline.opportunityId,'opp-new');
    const upserts=calls.filter(x=>x.url.endsWith('/opportunities/upsert'));
    assert.equal(upserts.length,1);
    assert.equal(upserts[0].options.headers.Version,'v3');
    assert.equal(upserts[0].options.headers['Idempotency-Key'],'schedule:job-new:1');
    assert.deepEqual(JSON.parse(upserts[0].options.body),{pipelineId:'pipe-1',locationId:'location-1',name:'New Customer — Garage transformation',pipelineStageId:'stage-scheduled',status:'open',contactId:'contact-new',monetaryValue:1750,assignedTo:'w92vfhwm3a8twTIowpQz',followers:['w92vfhwm3a8twTIowpQz'],isRemoveAllFollowers:false,followersActionType:'add'});
    assert.equal(calls.filter(x=>/\/opportunities\/[^/]+$/.test(new URL(x.url).pathname)&&x.options.method==='PUT').length,0);
  }finally{globalThis.fetch=originalFetch}
});

test('HighLevel reuses the same exact appointment after a response-lost retry',async()=>{
  const {onRequestPost}=await import('../functions/api/highlevel.js');
  const calls=[],originalFetch=globalThis.fetch,start='2026-09-12T15:00:00.000Z',end='2026-09-12T18:00:00.000Z';
  globalThis.fetch=async(url,options={})=>{
    calls.push({url:String(url),options});
    if(String(url).includes('/calendars/events?'))return new Response(JSON.stringify({events:[{id:'appt-existing',contactId:'contact-1',startTime:start,endTime:end,appointmentStatus:'confirmed'}]}),{status:200});
    if(String(url).includes('/opportunities/search?'))return new Response(JSON.stringify({opportunities:[{id:'opp-1',contactId:'contact-1',pipelineId:'pipe-1',name:'Existing job',status:'open',monetaryValue:900}]}),{status:200});
    return new Response('{}',{status:200});
  };
  try{
    const request=new Request('https://easygaragecleaning.com/api/highlevel',{method:'POST',headers:{Origin:'https://easygaragecleaning.com','Content-Type':'application/json'},body:JSON.stringify({tool:'schedule',event_type:'job',opportunity_id:'opp-1',start_time:start,end_time:end,client:{name:'Existing Customer',highlevel_contact_id:'contact-1'}})});
    const response=await onRequestPost({request,env:{HIGHLEVEL_API_KEY:'test-key',HIGHLEVEL_LOCATION_ID:'location-1',HIGHLEVEL_PIPELINE_ID:'pipe-1',HIGHLEVEL_SCHEDULED_STAGE_ID:'stage-scheduled',HIGHLEVEL_JOB_CALENDAR_ID:'calendar-1'}});
    const result=await response.json();
    assert.equal(response.status,200);
    assert.equal(result.appointmentId,'appt-existing');
    assert.equal(result.reused,true);
    assert.equal(calls.filter(x=>x.url.endsWith('/calendars/events/appointments')&&x.options.method==='POST').length,0);
  }finally{globalThis.fetch=originalFetch}
});

test('Hub lead feed resets at the cutoff and excludes historical HighLevel opportunities',async()=>{
  const {onRequestGet}=await import('../functions/api/highlevel.js');
  const originalFetch=globalThis.fetch;
  globalThis.fetch=async url=>{
    if(String(url).includes('/opportunities/pipelines?'))return new Response(JSON.stringify({pipelines:[]}),{status:200});
    if(String(url).includes('/opportunities/search?'))return new Response(JSON.stringify({opportunities:[
      {id:'old',createdAt:'2026-09-03T21:50:00.000Z'},
      {id:'new',createdAt:'2026-09-03T21:52:00.000Z'},
      {id:'undated'}
    ]}),{status:200});
    return new Response('{}',{status:200});
  };
  try{
    const response=await onRequestGet({request:new Request('https://easygaragecleaning.com/api/highlevel?view=command',{headers:{Origin:'https://easygaragecleaning.com'}}),env:{HIGHLEVEL_API_KEY:'test-key',HIGHLEVEL_LOCATION_ID:'location-1',HIGHLEVEL_LEADS_RESET_AT:'2026-09-03T21:51:19.314Z'}});
    const result=await response.json();
    assert.equal(response.status,200);
    assert.equal(result.leadResetAt,'2026-09-03T21:51:19.314Z');
    assert.deepEqual(result.opportunities.map(row=>row.id),['new']);
  }finally{globalThis.fetch=originalFetch}
});

test('website leads go directly to HighLevel before the existing automation relay',async()=>{
  const {onRequestPost}=await import('../functions/api/web-lead.js');
  const calls=[],originalFetch=globalThis.fetch;
  globalThis.fetch=async(url,options={})=>{
    calls.push({url:String(url),options});
    if(String(url).endsWith('/contacts/upsert'))return new Response(JSON.stringify({contact:{id:'contact-web'}}),{status:200});
    if(String(url).includes('/opportunities/pipelines?'))return new Response(JSON.stringify({pipelines:[{id:'pipe-1',stages:[{id:'stage-new'}]}]}),{status:200});
    if(String(url).endsWith('/opportunities/upsert'))return new Response(JSON.stringify({opportunity:{id:'opp-web'},new:true}),{status:200});
    return new Response('{}',{status:200});
  };
  try{
    const request=new Request('https://easygaragecleaning.com/api/web-lead',{method:'POST',headers:{Origin:'https://easygaragecleaning.com','Content-Type':'application/json'},body:JSON.stringify({name:'New Customer',phone:'9705550199',items:'Garage cleanout',source:'Website'})});
    const response=await onRequestPost({request,env:{HIGHLEVEL_API_KEY:'test-key',HIGHLEVEL_LOCATION_ID:'location-1',HIGHLEVEL_PIPELINE_ID:'pipe-1',HIGHLEVEL_USER_ID:'user-1',WEBSITE_LEAD_HOOK_URL:'https://hooks.example.test/lead'}});
    const result=await response.json();
    assert.equal(response.status,200);
    assert.equal(result.highlevel.synced,true);
    assert.equal(result.relay.sent,true);
    assert.equal(calls.filter(call=>call.url.endsWith('/contacts/upsert')).length,1);
    assert.equal(calls.filter(call=>call.url.endsWith('/opportunities/upsert')).length,1);
    assert.equal(calls.filter(call=>call.url.startsWith('https://hooks.example.test/lead')).length,1);
  }finally{globalThis.fetch=originalFetch}
});

test('legacy Firebase leads are not loaded into the reset Hub',()=>{
  assert.doesNotMatch(employee,/db\.collection\('leads'\)\.onSnapshot/);
  assert.doesNotMatch(employee,/db\.collection\('leads'\)\.get/);
  assert.match(employee,/leadsCache = \[\];/);
  assert.match(suite,/New HighLevel leads/);
  assert.match(suite,/setInterval\(\(\)=>\{if\(!document\.hidden\)loadGhl\(\)\},60000\)/);
  assert.match(highlevel,/DEFAULT_LEAD_RESET_AT/);
  assert.match(webLead,/syncHighLevelLead/);
});

test('employees can discover and safely pick up manager-opened crew shifts',()=>{
  for(const marker of ["'open_shifts'",'Open shifts','Crew needed','openShift','crewNeeded','assignedCrew','remaining</b>','Route','Pick up shift']){
    assert.match(suite,new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')),marker+' is missing');
  }
  assert.match(suite,/db\.collection\('jobs'\)\.doc\(id\)/);
  assert.match(suite,/db\.runTransaction\(async tx=>/);
  assert.match(suite,/await tx\.get\(ref\)/);
  assert.match(suite,/tx\.set\(ref,patch,\{merge:true\}\)/);
  assert.match(suite,/assignedCrew=\[\.\.\.crew,identity\]/);
  assert.match(suite,/openShift=assignedCrew\.length<needed/);
  for(const guard of ['SHIFT_MISSING','SHIFT_CLOSED','SHIFT_DUPLICATE','SHIFT_FULL','Sign in again before claiming a shift'])assert.match(suite,new RegExp(guard));
  assert.doesNotMatch(suite,/collection\(['"]open_shifts['"]\)/);
});

test('open-shift scheduling fields persist on the canonical job record',()=>{
  for(const field of ['openShift','crewNeeded','assignedCrew'])assert.match(suite,new RegExp(field+','));
  assert.match(suite,/b\.openShift=fd\.has\('openShift'\)/);
  assert.match(suite,/openShift:b\.type==='job'/);
  assert.match(suite,/assignedCrew\.length<crewNeeded/);
  assert.match(employee,/employee-suite\.css\?v=20260903h/);
  assert.match(employee,/employee-suite\.js\?v=20260903k/);
});

test('walkthrough preserves job creation time and hands off the scheduled job appointment',()=>{
  assert.match(crew,/if\(!existing\.exists\)job\.createdAt=now/);
  assert.match(crew,/highlevelAppointmentId:S\.highlevelJobAppointmentId/);
});

test('material walkthrough edits invalidate stale customer approval',()=>{
  for(const marker of ['function invalidateAcceptance','function updateField','The plan changed. Review the updated brief and collect approval again.'])assert.match(crew,new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
  assert.match(crew,/oninput="updateField\('\$\{key\}',this\.value\)"/);
  assert.match(crew,/oninput="updateField\('lockedPrice',this\.value\)"/);
  assert.match(crew,/function pick\([^)]*\)\{invalidateAcceptance\(\)/);
  assert.match(crew,/function qty\([^)]*\)\{invalidateAcceptance\(\)/);
  assert.match(crew,/async function addPhotos\(input\)\{invalidateAcceptance\(\)/);
  assert.match(crew,/async function removePhoto\(id\)\{invalidateAcceptance\(\)/);
});

test('public quote progress and production links stay configured',()=>{
  assert.match(commercial,/const shell=form\.closest\('\.quote-form'\)\|\|document/);
  assert.match(commercial,/const dots=shell\.querySelectorAll\('\.form-step-dot'\)/);
  assert.match(commercial,/const lbl=shell\.querySelector\('\.form-step-label'\)/);
  const publicSource=fs.readdirSync(new URL('..',import.meta.url),{recursive:true,withFileTypes:true})
    .filter(x=>x.isFile()&&/\.(?:html|py)$/.test(x.name))
    .map(x=>fs.readFileSync(`${x.parentPath}/${x.name}`,'utf8')).join('\n');
  assert.doesNotMatch(publicSource,/fcgov\.com\/chamber|"CLARITY_PROJECT_ID"|(?:facebook|instagram)\.com\/PLACEHOLDER|yelp\.com\/biz\/PLACEHOLDER/);
  assert.match(publicSource,/fortcollinschamber\.com/);
  assert.match(publicSource,/"wf7ba129jm"/);
});

test('all employee and field-tool inline scripts parse',()=>{
  for(const [name,html] of [['employee.html',employee],['crew/gameplan.html',crew],['crew/prejob.html',prejob],['crew/postjob.html',postjob]]){
    const scripts=[...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)].map(x=>x[1]).filter(Boolean);
    scripts.forEach((code,i)=>assert.doesNotThrow(()=>new vm.Script(code,{filename:name+'#'+i})));
  }
  assert.doesNotThrow(()=>new vm.Script(suite,{filename:'employee-suite.js'}));
});
