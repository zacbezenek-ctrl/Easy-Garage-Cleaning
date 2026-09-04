import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createHubActionState, createHubSessionCookie, getHubUserProfile, hasBusinessAccess, hashHubCredential, verifyHubActionState, verifyHubSessionToken } from '../functions/_lib/hub-session.js';

const TEST_HUB_ENV={HIGHLEVEL_API_KEY:'test-key',HIGHLEVEL_LOCATION_ID:'location-1'};
const TEST_HUB_COOKIE=(await createHubSessionCookie(TEST_HUB_ENV,'ZacB')).split(';')[0];

const read=(p)=>fs.readFileSync(new URL('../'+p,import.meta.url),'utf8');
const employee=read('employee.html');
const suite=read('employee-suite.js');
const crew=read('crew/gameplan.html');
const crewHome=read('crew/index.html');
const prejob=read('crew/prejob.html');
const postjob=read('crew/postjob.html');
const copilot=read('copilot.html');
const relay=read('functions/api/operations-event.js');
const highlevel=read('functions/api/highlevel.js');
const webLead=read('functions/api/web-lead.js');
const statusApi=read('functions/api/integration-status.js');
const commercial=read('commercial-junk-removal-fort-collins-co.html');

test('Hub authentication issues, validates, expires, and clears an HttpOnly session',async()=>{
  const env={HUB_SESSION_SECRET:'session-test-secret',HUB_AUTH_USERS_JSON:JSON.stringify({Tester:await hashHubCredential('Tester','correct horse')})};
  const auth=await import('../functions/api/hub-auth.js');
  const login=await auth.onRequestPost({request:new Request('https://easygaragecleaning.com/api/hub-auth',{method:'POST',headers:{Origin:'https://easygaragecleaning.com','Content-Type':'application/json'},body:JSON.stringify({username:'Tester',password:'correct horse'})}),env});
  assert.equal(login.status,200);
  const cookie=login.headers.get('set-cookie');
  assert.match(cookie,/egc_hub_session=/);
  assert.match(cookie,/HttpOnly/i);
  assert.match(cookie,/SameSite=Strict/i);
  const cookieValue=cookie.split(';')[0];
  const check=await auth.onRequestGet({request:new Request('https://easygaragecleaning.com/api/hub-auth',{headers:{Cookie:cookieValue}}),env});
  assert.equal(check.status,200);
  assert.equal((await check.json()).user,'Tester');
  const token=cookieValue.split('=')[1];
  assert.equal(await verifyHubSessionToken(env,token,Date.now()+13*60*60*1000),null);
  const tampered=await auth.onRequestGet({request:new Request('https://easygaragecleaning.com/api/hub-auth',{headers:{Cookie:cookieValue+'x'}}),env});
  assert.equal(tampered.status,401);
  const logout=await auth.onRequestDelete({request:new Request('https://easygaragecleaning.com/api/hub-auth',{method:'DELETE',headers:{Origin:'https://easygaragecleaning.com'}})});
  assert.match(logout.headers.get('set-cookie'),/Max-Age=0/);
});

test('one-time integration setup state is signed, purpose-bound, and short-lived',async()=>{
  const env={HUB_SESSION_SECRET:'state-test-secret',HUB_AUTH_USERS_JSON:JSON.stringify({Tester:await hashHubCredential('Tester','correct horse')})};
  const now=Date.now(),state=await createHubActionState(env,'drive-oauth','Tester',now);
  assert.equal((await verifyHubActionState(env,state,'drive-oauth',now+9*60*1000)).user,'Tester');
  assert.equal(await verifyHubActionState(env,state,'jobber-oauth',now),null);
  assert.equal(await verifyHubActionState(env,state+'x','drive-oauth',now),null);
  assert.equal(await verifyHubActionState(env,state,'drive-oauth',now+11*60*1000),null);
});

test('OAuth setup routes reject callbacks that were not started by a Hub user',async()=>{
  for(const [file,prefix] of [['drive-auth.js','GOOGLE'],['jobber-auth.js','JOBBER']]){
    const api=await import(`../functions/api/${file}`),env={...TEST_HUB_ENV,[`${prefix}_CLIENT_ID`]:'client',[`${prefix}_CLIENT_SECRET`]:'secret'};
    const response=await api.onRequestGet({request:new Request(`https://easygaragecleaning.com/api/${file.replace('.js','')}?code=untrusted`),env});
    assert.equal(response.status,403);
  }
});

test('sensitive CRM access is rejected before any upstream request without a Hub session',async()=>{
  const {onRequestGet}=await import('../functions/api/highlevel.js');
  const originalFetch=globalThis.fetch;
  let called=false;
  globalThis.fetch=async()=>{called=true;throw new Error('must not call upstream')};
  try{
    const response=await onRequestGet({request:new Request('https://easygaragecleaning.com/api/highlevel?view=contacts&q=test'),env:TEST_HUB_ENV});
    assert.equal(response.status,401);
    assert.equal(called,false);
  }finally{globalThis.fetch=originalFetch}
});

test('integration readiness is private to signed-in Hub users',async()=>{
  const {onRequestGet}=await import('../functions/api/integration-status.js');
  const response=await onRequestGet({request:new Request('https://easygaragecleaning.com/api/integration-status'),env:TEST_HUB_ENV});
  assert.equal(response.status,401);
  const configured=await onRequestGet({request:new Request('https://easygaragecleaning.com/api/integration-status',{headers:{Cookie:TEST_HUB_COOKIE}}),env:{...TEST_HUB_ENV,Stripe_Secret:'sk_test_fake123'}});
  assert.equal((await configured.json()).status.stripe,true);
  assert.match(suite,/hubFetch\('\/api\/integration-status'/);
});

test('employee and crew pages no longer publish reusable password-derived session tokens',()=>{
  for(const page of [employee,crew,prejob,postjob,copilot,read('crew/index.html')]){
    assert.doesNotMatch(page,/GATE_USERS|egc-session|const USERS\s*=/);
    assert.match(page,/hub-auth/);
  }
});

test('the billable field copilot requires the signed Hub session',async()=>{
  const {onRequestPost}=await import('../functions/api/copilot.js');
  const originalFetch=globalThis.fetch;
  let called=false;
  globalThis.fetch=async()=>{called=true;throw new Error('must not call upstream')};
  try{
    const response=await onRequestPost({request:new Request('https://easygaragecleaning.com/api/copilot',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({query:'test'})}),env:TEST_HUB_ENV});
    assert.equal(response.status,401);
    assert.equal(called,false);
  }finally{globalThis.fetch=originalFetch}
  assert.match(copilot,/EGCHubAuth\.fetch\('\/api\/copilot'/);
});

test('the unused garage render prototype cannot spend image credits without a Hub session',async()=>{
  const {onRequestPost}=await import('../functions/api/garage-render.js');
  const originalFetch=globalThis.fetch;
  let called=false;
  globalThis.fetch=async()=>{called=true;throw new Error('must not call upstream')};
  try{
    const response=await onRequestPost({request:new Request('https://easygaragecleaning.com/api/garage-render',{method:'POST',headers:{Origin:'https://easygaragecleaning.com','Content-Type':'application/json'},body:'{}'}),env:TEST_HUB_ENV});
    assert.equal(response.status,401);
    assert.equal(called,false);
  }finally{globalThis.fetch=originalFetch}
});

test('employee hub loads the EGC operations suite without the duplicate CRM overlay',()=>{
  assert.doesNotMatch(employee,/employee-crm\.(?:js|css)/);
  assert.match(employee,/employee-suite\.js/);
  assert.match(employee,/employee-suite\.css/);
  assert.doesNotMatch(employee,/class="mobile-sticky-cta"/);
  assert.match(employee,/padding-bottom: 0 !important/);
  assert.match(suite,/if\(typeof me!=='undefined'&&me\)loadAll\(\)/);
});

test('operations suite follows the EGC operating model instead of duplicating the CRM',()=>{
  for(const area of ['today','schedule','pipeline','walkthroughs','delivery','scorecard','proof','playbook','settings']){
    assert.match(suite,new RegExp("'"+area+"'"),area+' is missing');
  }
  for(const marker of ['HighLevel is CRM','Walkthrough-first','Contribution / lead','The EGC playbook'])assert.match(suite,new RegExp(marker));
  for(const duplicate of ['collection:\'invoices\'','collection:\'payments\'','crew_members','collection:\'time_entries\''])assert.doesNotMatch(suite,new RegExp(duplicate));
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
  assert.match(crew,/j\.pipeline\?\.opportunityId\|\|S\.highlevelOpportunityId/);
  assert.doesNotMatch(crew,/S\.highLevelOpportunityId/);
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

test('crew checklist progress resumes across devices and is visible to the manager',()=>{
  for(const [page,phase] of [[prejob,'preJob'],[postjob,'postJob']]){
    for(const marker of ['function progressPayload','function restoreSharedProgress','function queueProgressSave',`${phase}Progress:snapshot`,`restoreSharedProgress(j.${phase}Progress)`,`${phase}Progress:{...progressPayload(),completedAt`]){
      assert.match(page,new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')),`${phase}: ${marker} is missing`);
    }
    assert.match(page,/queueProgressSave\(\)/);
  }
  assert.match(suite,/preProgress=j\.preJobProgress/);
  assert.match(suite,/postProgress=j\.postJobProgress/);
  assert.match(suite,/Pre-job \$\{preProgress\.completedCount\|\|0\}\/\$\{preProgress\.totalCount\}/);
  assert.match(suite,/Closeout \$\{postProgress\.completedCount\|\|0\}\/\$\{postProgress\.totalCount\}/);
  assert.match(prejob,/The Hub could not record job start/);
  assert.match(postjob,/The Hub could not record closeout/);
  assert.match(postjob,/Retry → Save closeout to Hub/);
});

test('dispatch and job start create explicit HighLevel lifecycle triggers',async()=>{
  for(const marker of ['async function syncLifecycle','job-dispatched','job-arrived','job-started','lifecycleSync','lifecycleSyncPayload','lifecycleSyncNextRetryAt','opsRetryLifecycle','Workflow trigger remains safely queued','Status saved and HighLevel workflow triggered','Add the walkthrough brief before dispatching this crew'])assert.match(suite,new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
  for(const marker of ['async function syncStartLifecycle',"event:'job-started'",'lifecycleSyncPayload:payload','lifecycleSyncNextRetryAt','HighLevel was notified'])assert.match(prejob,new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
  assert.match(suite,/dispatchable=ready&&stage==='scheduled'/);
  const {onRequestPost}=await import('../functions/api/highlevel.js'),calls=[],originalFetch=globalThis.fetch;
  globalThis.fetch=async(url,options={})=>{calls.push({url:String(url),options});return new Response('{}',{status:200})};
  try{
    const request=new Request('https://easygaragecleaning.com/api/highlevel',{method:'POST',headers:{Origin:'https://easygaragecleaning.com',Cookie:TEST_HUB_COOKIE,'Content-Type':'application/json'},body:JSON.stringify({tool:'lifecycle',event:'job-dispatched',highlevel_contact_id:'contact-1',client:{name:'Test Customer'}})});
    const response=await onRequestPost({request,env:{HIGHLEVEL_API_KEY:'test-key',HIGHLEVEL_LOCATION_ID:'location-1'}}),result=await response.json();
    assert.equal(response.status,200);
    assert.equal(result.automation.trigger,'egc-job-dispatched');
    const tagCall=calls.find(x=>x.url.endsWith('/contacts/contact-1/tags'));
    assert.ok(tagCall,'lifecycle tag was not sent');
    assert.deepEqual(JSON.parse(tagCall.options.body),{tags:['egc-job-dispatched']});
  }finally{globalThis.fetch=originalFetch}
});

test('arrival text sends through Quo and records a silent HighLevel note',async()=>{
  for(const marker of ['/api/quo-send','arrivalTextStatus','lastCustomerMessage','crew-on-the-way','suppress_automation:true','crmStatus','lifecycleSyncPayload:crmPayload','lifecycleSyncNextRetryAt','Open phone text instead'])assert.match(prejob,new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
  const {onRequestPost}=await import('../functions/api/highlevel.js'),calls=[],originalFetch=globalThis.fetch;
  globalThis.fetch=async(url,options={})=>{calls.push({url:String(url),options});return new Response('{}',{status:200})};
  try{
    const request=new Request('https://easygaragecleaning.com/api/highlevel',{method:'POST',headers:{Origin:'https://easygaragecleaning.com',Cookie:TEST_HUB_COOKIE,'Content-Type':'application/json'},body:JSON.stringify({tool:'lifecycle',event:'crew-on-the-way',suppress_automation:true,note:'Arrival text sent via Quo.',highlevel_contact_id:'contact-1',client:{name:'Customer'}})});
    const response=await onRequestPost({request,env:{HIGHLEVEL_API_KEY:'test-key',HIGHLEVEL_LOCATION_ID:'location-1'}}),result=await response.json();
    assert.equal(response.status,200);
    assert.equal(result.automation.trigger,'');
    assert.equal(result.automation.suppressed,true);
    assert.equal(calls.some(x=>x.url.endsWith('/contacts/contact-1/tags')),false);
    assert.ok(calls.find(x=>x.url.endsWith('/contacts/contact-1/notes')));
  }finally{globalThis.fetch=originalFetch}
});

test('cancelling keeps an audit record, releases the Hub slot, and cancels the HighLevel appointment',async()=>{
  for(const marker of ['opsCancelBooking','Cancellation reason','cancellation:{reason','cancelledBy:employeeIdentity','releaseScheduleLock(job)','walkthrough-cancelled','job-cancelled','HighLevel cancellation is queued','Event type locks after the first save'])assert.match(suite,new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')),marker+' is missing');
  const {onRequestPost}=await import('../functions/api/highlevel.js'),calls=[],originalFetch=globalThis.fetch;
  globalThis.fetch=async(url,options={})=>{
    calls.push({url:String(url),options});
    if(String(url).endsWith('/calendars/events/appointments/appt-cancel')&&(!options.method||options.method==='GET'))return new Response(JSON.stringify({id:'appt-cancel',calendarId:'cal-1',title:'Garage job',startTime:'2026-09-16T15:00:00.000Z',endTime:'2026-09-16T18:00:00.000Z'}),{status:200});
    return new Response('{}',{status:200});
  };
  try{
    const request=new Request('https://easygaragecleaning.com/api/highlevel',{method:'POST',headers:{Origin:'https://easygaragecleaning.com',Cookie:TEST_HUB_COOKIE,'Content-Type':'application/json','Idempotency-Key':'lifecycle:job-1:cancelled'},body:JSON.stringify({tool:'lifecycle',event:'job-cancelled',appointment_id:'appt-cancel',appointment_status:'cancelled',note:'Cancellation reason: customer moving dates',highlevel_contact_id:'contact-1',client:{name:'Customer'}})});
    const response=await onRequestPost({request,env:{HIGHLEVEL_API_KEY:'test-key',HIGHLEVEL_LOCATION_ID:'location-1'}}),result=await response.json();
    assert.equal(response.status,200);
    assert.equal(result.appointmentStatus,'cancelled');
    assert.equal(result.automation.trigger,'egc-job-cancelled');
    const update=calls.find(x=>x.url.endsWith('/calendars/events/appointments/appt-cancel')&&x.options.method==='PUT');
    assert.ok(update,'HighLevel appointment cancellation was not sent');
    assert.equal(JSON.parse(update.options.body).appointmentStatus,'cancelled');
    assert.equal(JSON.parse(update.options.body).toNotify,false);
    const note=calls.find(x=>x.url.endsWith('/contacts/contact-1/notes'));
    assert.ok(note,'cancellation reason was not added to contact history');
    assert.equal(JSON.parse(note.options.body).body,'Cancellation reason: customer moving dates');
    assert.equal(note.options.headers['Idempotency-Key']!==undefined,true);
  }finally{globalThis.fetch=originalFetch}
});

test('failed HighLevel closeouts remain durable and manager-retryable',()=>{
  for(const marker of ['closeoutSyncPayload:payload','closeoutSyncNextRetryAt','Nothing was cleared'])assert.match(postjob,new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
  for(const marker of ['async function syncCloseoutRecord','closeoutSyncPayload','closeoutSyncAttempts','closeoutSyncNextRetryAt','opsRetryCloseout','Retry closeout','closeout needs HighLevel retry','closeoutPending','Closeout remains safely queued in the Hub'])assert.match(suite,new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')),marker+' is missing');
  assert.match(suite,/Math\.min\(1440,Math\.pow\(2,Math\.min\(attempts,8\)\)\*5\)/);
});

test('closeout records job-costing actuals and explains walkthrough scope variance',()=>{
  for(const marker of ['Actual loads','Hours on site','Enter the actual truckloads','Enter the crew hours on site','The walkthrough planned','quoted_loads:quotedLoads','actual_loads:actualLoads','scopeVariance:{quotedLoads,actualLoads,difference:variance'])assert.match(postjob,new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')),marker+' is missing');
  for(const marker of ['Walkthrough load plan','Actual truckloads','Load variance'])assert.match(highlevel,new RegExp(marker));
});

test('closeout preserves deposits and records only the payment received now',()=>{
  for(const marker of ['j_payment_amount','paidToDate=Number(j.payment?.amount||0)','paymentRecord:j.payment||{}','amount_received:paymentAmount','previously_paid:paidToDate','paid_to_date:cumulativePaid','balance:remainingBalance','paymentRecord=paidNow?','status:paidInFull?\'paid\':\'completed\'','lastPaymentBalance:remainingBalance'])assert.match(postjob,new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')),marker+' is missing');
  assert.match(postjob,/paymentAmount>outstanding\+\.01/);
  assert.match(postjob,/invoice:\{status:paidInFull\?'paid':cumulativePaid>0\?'partial':'ready'/);
  for(const marker of ['Payment received now','Paid to date','Balance remaining','Payment method / reference'])assert.match(highlevel,new RegExp(marker));
});

test('signed-in crew can create and verify a Stripe-hosted job payment',async()=>{
  const api=await import('../functions/api/job-payment.js'),originalFetch=globalThis.fetch,calls=[];
  globalThis.fetch=async(url,options={})=>{calls.push({url:String(url),options});if(options.method==='POST')return new Response(JSON.stringify({id:'cs_test_job123',url:'https://checkout.stripe.com/c/pay/cs_test_job123'}),{status:200});return new Response(JSON.stringify({id:'cs_test_job123',status:'complete',payment_status:'paid',payment_intent:'pi_job123',amount_total:125000,currency:'usd',client_reference_id:'job-1',metadata:{job_id:'job-1'},customer_details:{email:'customer@example.com'}}),{status:200})};
  try{
    const env={...TEST_HUB_ENV,STRIPE_SECRET_KEY:'sk_test_fake123'};
    const create=await api.onRequestPost({request:new Request('https://easygaragecleaning.com/api/job-payment',{method:'POST',headers:{Origin:'https://easygaragecleaning.com',Cookie:TEST_HUB_COOKIE,'Content-Type':'application/json'},body:JSON.stringify({job_id:'job-1',request_id:'attempt-1',amount_cents:125000,customer:'Test Customer',email:'customer@example.com'})}),env}),created=await create.json();
    assert.equal(create.status,200);assert.equal(created.url,'https://checkout.stripe.com/c/pay/cs_test_job123');
    const form=new URLSearchParams(String(calls[0].options.body));
    assert.equal(form.get('mode'),'payment');assert.equal(form.get('line_items[0][price_data][unit_amount]'),'125000');assert.equal(form.get('metadata[job_id]'),'job-1');assert.match(calls[0].options.headers['Idempotency-Key'],/job-1:attempt-1/);
    const verify=await api.onRequestGet({request:new Request('https://easygaragecleaning.com/api/job-payment?session_id=cs_test_job123',{headers:{Origin:'https://easygaragecleaning.com',Cookie:TEST_HUB_COOKIE}}),env}),verified=await verify.json();
    assert.equal(verify.status,200);assert.equal(verified.paid,true);assert.equal(verified.paymentIntentId,'pi_job123');assert.equal(verified.jobId,'job-1');assert.equal(verified.amountTotal,125000);
  }finally{globalThis.fetch=originalFetch}
});

test('job payments stay authenticated and the Stripe secret never reaches the browser',async()=>{
  const api=await import('../functions/api/job-payment.js'),originalFetch=globalThis.fetch;let called=false;globalThis.fetch=async()=>{called=true;throw new Error('must not call Stripe')};
  try{const response=await api.onRequestPost({request:new Request('https://easygaragecleaning.com/api/job-payment',{method:'POST',headers:{Origin:'https://easygaragecleaning.com','Content-Type':'application/json'},body:'{}'}),env:{STRIPE_SECRET_KEY:'sk_test_fake123'}});assert.equal(response.status,401);assert.equal(called,false)}finally{globalThis.fetch=originalFetch}
  const paymentApi=read('functions/api/job-payment.js');
  for(const marker of ['getHubSession','STRIPE_SECRET_KEY','checkout/sessions','payment_status','client_reference_id','receipt_email'])assert.match(paymentApi,new RegExp(marker));
  assert.doesNotMatch(postjob,/sk_(?:test|live)_/);
  for(const marker of ['Take card payment','takeStripePayment','verifyStripeReturn','recordVerifiedStripePayment','stripeSessions','Payment verified in Stripe, Hub, and HighLevel','payment-received'])assert.match(postjob,new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
});

test('verified Stripe payment writes a HighLevel payment tag and audit note',async()=>{
  const {onRequestPost}=await import('../functions/api/highlevel.js'),calls=[],originalFetch=globalThis.fetch;
  globalThis.fetch=async(url,options={})=>{calls.push({url:String(url),options});if(String(url).includes('/contacts/contact-pay/tags'))return new Response('{}',{status:200});if(String(url).includes('/contacts/contact-pay/notes'))return new Response(JSON.stringify({note:{id:'note-pay'}}),{status:200});return new Response(JSON.stringify({contact:{id:'contact-pay'}}),{status:200})};
  try{const request=new Request('https://easygaragecleaning.com/api/highlevel',{method:'POST',headers:{Origin:'https://easygaragecleaning.com',Cookie:TEST_HUB_COOKIE,'Content-Type':'application/json'},body:JSON.stringify({tool:'lifecycle',event:'payment-received',highlevel_contact_id:'contact-pay',idempotency_key:'stripe-payment:cs_test_1',client:{name:'Test Customer',highlevel_contact_id:'contact-pay'},note:'Stripe payment verified: $1,250. Balance: $0.'})});const response=await onRequestPost({request,env:{HIGHLEVEL_API_KEY:'test-key',HIGHLEVEL_LOCATION_ID:'location-1'}}),result=await response.json();assert.equal(response.status,200);assert.equal(result.automation.trigger,'egc-payment-received');const tagCall=calls.find(call=>call.url.includes('/contacts/contact-pay/tags'));assert.ok(tagCall);assert.match(tagCall.options.body,/egc-payment-received/);const noteCall=calls.find(call=>call.url.includes('/contacts/contact-pay/notes'));assert.ok(noteCall);assert.match(noteCall.options.body,/Stripe payment verified/)}finally{globalThis.fetch=originalFetch}
});

test('durable job start pre-fills elapsed closeout time without preventing correction',()=>{
  assert.match(prejob,/const startedAt=ACTIVE\.startedAt\|\|localStorage\.getItem\(startKey\(\)\)\|\|new Date\(\)\.toISOString\(\)/);
  assert.match(prejob,/ACTIVE\.startedAt=startedAt/);
  for(const marker of ['hours_hint','Calculated from','adjust if needed','timeTracking:{startedAt','elapsedHours:hoursOnSite','started_at:ACTIVE.startedAt'])assert.match(postjob,new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
  assert.match(postjob,/Math\.round\(\(Date\.now\(\)-Date\.parse\(ACTIVE\.startedAt\)\)\/900000\)\/4/);
  assert.match(postjob,/if\(ACTIVE\.startedAt&&hours&&!hours\.value\)/);
});

test('crew tools provide a job-aware employee home and one connected workflow',()=>{
  for(const marker of ['Your workday','next-work','My upcoming work','Estimated pay','loadEmployeeData','loadAssignedJobs','workLink','Open job brief','Continue closeout','Time clock','Report issue','offline'])assert.match(crewHome,new RegExp(marker));
  for(const page of [crewHome,crew,prejob,postjob]){
    assert.match(page,/crew-brand\.css\?v=20260904c/);
    assert.match(page,/hub-auth\.js\?v=20260904c/);
  }
  const auth=read('crew/hub-auth.js');
  for(const marker of ['mountCrewNav','crew-utility','Crew home','Walkthrough','Pre-job','Closeout','My Hub'])assert.match(auth,new RegExp(marker));
  for(const page of [prejob,postjob]){
    assert.match(page,/aria-checked=/);
    assert.match(page,/copyScript\(\$\{si\},this\)/);
    assert.doesNotMatch(page,/event\.target\.textContent="Copied/);
  }
});

test('walkthrough access stays limited to Zac Tyler and Alex while employees get pre-job and closeout',()=>{
  const auth=read('crew/hub-auth.js');
  for(const marker of ["new Set(['zacb', 'tylerg', 'alexk'])",'function canRunBusiness','href !== \'/crew/gameplan\' || canRunBusiness()'])assert.match(auth,new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
  for(const marker of ['denyWalkthrough',"location.replace('/crew/?notice=walkthrough-restricted')",'!EGCHubAuth.canRunBusiness(user)'])assert.match(crew,new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
  assert.match(crewHome,/\(business\|\|job\.type!==\'walkthrough\'\)/);
  assert.match(crewHome,/document\.getElementById\('walkthrough-tool'\)\.hidden=!business/);
  assert.match(crewHome,/Pre-job → closeout/);
  for(const marker of ["view === 'walkthroughs' && !hasBusinessAccess(session)","payload.tool === 'game_plan' && !hasBusinessAccess(session)",'BUSINESS_ACCESS_REQUIRED'])assert.match(highlevel,new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
});

test('walkthrough APIs reject a signed-in regular employee',async()=>{
  const {onRequestGet,onRequestPost}=await import('../functions/api/highlevel.js');
  const env={...TEST_HUB_ENV,HIGHLEVEL_API_KEY:'test-key',HIGHLEVEL_LOCATION_ID:'location-1'},cookie=(await createHubSessionCookie(env,'FrankJara')).split(';')[0],headers={Origin:'https://easygaragecleaning.com',Cookie:cookie};
  const list=await onRequestGet({request:new Request('https://easygaragecleaning.com/api/highlevel?view=walkthroughs',{headers}),env});
  assert.equal(list.status,403);
  assert.equal((await list.json()).code,'BUSINESS_ACCESS_REQUIRED');
  const save=await onRequestPost({request:new Request('https://easygaragecleaning.com/api/highlevel',{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({tool:'game_plan'})}),env});
  assert.equal(save.status,403);
  assert.equal((await save.json()).code,'BUSINESS_ACCESS_REQUIRED');
});

test('pre-job and closeout share walkthrough styling and preserve important-item photos',()=>{
  const brand=read('crew/crew-brand.css');
  for(const page of [prejob,postjob])assert.match(page,/<body class="crew-playbook-modern">/);
  for(const marker of ['.crew-playbook-modern .important-record','.crew-playbook-modern #sections>section','.crew-playbook-modern .item.on','.crew-playbook-modern #donebar'])assert.match(brand,new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
  for(const marker of ['Important items &amp; heirlooms','important_notes','mountImportantItems','photoAdd(jobKey(),"important"','importantItemPhotoCount','importantItemsRecordedAt'])assert.match(prejob,new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
  for(const marker of ['Important items &amp; heirlooms','important_ref','photo.tag==="important"','important_item_notes','photos:{after:AFTER_COUNT,important:IMPORTANT_COUNT}','importantItemsVerifiedAt'])assert.match(postjob,new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
});

test('weekly timesheets use individual timecards with a legacy closeout fallback',()=>{
  for(const marker of ["'timesheets'",'Weekly timesheets','timesheetRows',"timeEntries:'timeEntries'",'clockInAt','clockOutAt','approvalStatus','opsApproveTime','opsDownloadTimesheets','Download CSV','Individual timecards','timeTracking?.elapsedHours'])assert.match(suite,new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
  assert.match(suite,/\(crew\.length\?crew:fallback\)\.forEach/);
  assert.match(suite,/a\.download=`egc-timesheets-/);
  assert.match(suite,/if\(\/\^\[=\+\\-@\]\//);
});

test('closeout requires a completed pre-job handoff or a documented exception',()=>{
  for(const marker of ['preJobCompletedAt','preJobCompletedBy','No completed pre-job handoff was found','manager-approved exception','closeoutPreJobException','pre_job_completed_at','pre_job_exception','No completed pre-job handoff is attached'])assert.match(postjob,new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')),marker+' is missing');
  assert.match(highlevel,/Pre-job handoff:/);
  assert.match(highlevel,/No completion record/);
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
    const request=new Request('https://easygaragecleaning.com/api/highlevel',{method:'POST',headers:{Origin:'https://easygaragecleaning.com',Cookie:TEST_HUB_COOKIE,'Content-Type':'application/json'},body:JSON.stringify(payload)});
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
    const request=new Request('https://easygaragecleaning.com/api/highlevel',{method:'POST',headers:{Origin:'https://easygaragecleaning.com',Cookie:TEST_HUB_COOKIE,'Content-Type':'application/json'},body:JSON.stringify(payload)});
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
  for(const marker of ['function customerRows','function customerHistory','function financeState','function jobEconomics','function financeSummary','function financeBoard','Known job contribution','crew-hrs','labor baseline','contribution before fuel / ads','Load variance','opsFinanceAction','Record approval','Record deposit','Issue invoice','Record payment','acceptanceMethod','termsVersion','verified:true','A payment reference is required for verification','Hub records only · keys needed']){
    assert.match(suite,new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')),marker+' is missing');
  }
  assert.match(suite,/jobs\(\)\.filter\(j=>j\.type!=='blocked'\)/);
  assert.match(suite,/const customerKey=j=>j\.highlevelContactId\|\|String\(j\.phone/);
  assert.match(suite,/function actionModal/);
  assert.match(suite,/function askAction/);
  assert.doesNotMatch(suite,/\b(?:prompt|confirm)\s*\(/);
  assert.doesNotMatch(suite,/Stripe payment (?:sent|completed)|QuickBooks invoice (?:sent|completed)/i);
  for(const marker of ['opsPrintDocument','Print estimate','Print invoice','Prepared for','Flat-rate service based on the approved walkthrough scope','Balance due','Print / Save PDF'])assert.ok(suite.includes(marker),marker+' is missing');
  assert.match(suite,/egc-logo-horizontal-primary\.png/);
  assert.match(suite,/if\(!win\)/);
  for(const marker of ['opsDownloadCustomers','Export customers','HighLevel contact ID','Recorded paid','egc-customers-'])assert.ok(suite.includes(marker),marker+' is missing');
  assert.match(suite,/data\.map\(row=>row\.map\(csvCell\)/);
  for(const marker of ['Find a customer','opsFilterCustomers','data-customer-search','customerSearch','shown`'])assert.ok(suite.includes(marker),marker+' is missing');
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
    const request=new Request('https://easygaragecleaning.com/api/highlevel',{method:'POST',headers:{Origin:'https://easygaragecleaning.com',Cookie:TEST_HUB_COOKIE,'Content-Type':'application/json'},body:JSON.stringify({tool:'schedule',event_type:'job',opportunity_id:'opp-1',start_time:'2026-09-10T15:00:00.000Z',end_time:'2026-09-10T18:00:00.000Z',client:{name:'Test Customer',highlevel_contact_id:'contact-1'}})});
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
    const request=new Request('https://easygaragecleaning.com/api/highlevel',{method:'POST',headers:{Origin:'https://easygaragecleaning.com',Cookie:TEST_HUB_COOKIE,'Content-Type':'application/json','Idempotency-Key':'schedule:job-new:1'},body:JSON.stringify({tool:'schedule',event_type:'job',opportunity_name:'New Customer — Garage transformation',monetary_value:1750,start_time:'2026-09-11T15:00:00.000Z',end_time:'2026-09-11T18:00:00.000Z',client:{name:'New Customer',phone:'9705550199'}})});
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
    const request=new Request('https://easygaragecleaning.com/api/highlevel',{method:'POST',headers:{Origin:'https://easygaragecleaning.com',Cookie:TEST_HUB_COOKIE,'Content-Type':'application/json'},body:JSON.stringify({tool:'schedule',event_type:'job',opportunity_id:'opp-1',start_time:start,end_time:end,client:{name:'Existing Customer',highlevel_contact_id:'contact-1'}})});
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
    const response=await onRequestGet({request:new Request('https://easygaragecleaning.com/api/highlevel?view=command',{headers:{Origin:'https://easygaragecleaning.com',Cookie:TEST_HUB_COOKIE}}),env:{HIGHLEVEL_API_KEY:'test-key',HIGHLEVEL_LOCATION_ID:'location-1',HIGHLEVEL_LEADS_RESET_AT:'2026-09-03T21:51:19.314Z'}});
    const result=await response.json();
    assert.equal(response.status,200);
    assert.equal(result.leadResetAt,'2026-09-03T21:51:19.314Z');
    assert.deepEqual(result.opportunities.map(row=>row.id),['new']);
  }finally{globalThis.fetch=originalFetch}
});

test('legacy Firebase CRM ingestion is retired in favor of HighLevel',async()=>{
  for(const file of ['lead-intake.js','sms-event.js']){
    const api=await import(`../functions/api/${file}`);
    const response=await api.onRequestPost({request:new Request(`https://easygaragecleaning.com/api/${file.replace('.js','')}`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'}),env:{FIREBASE_API_KEY:'unused'}});
    assert.equal(response.status,410);
    assert.match((await response.json()).error,/HighLevel/);
  }
  assert.doesNotMatch(copilot,/collection\('leads'\)|allLeads|leads:\s*allLeads/);
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
    const request=new Request('https://easygaragecleaning.com/api/web-lead',{method:'POST',headers:{Origin:'https://easygaragecleaning.com',Cookie:TEST_HUB_COOKIE,'Content-Type':'application/json'},body:JSON.stringify({name:'New Customer',phone:'9705550199',email:'new@example.com',items:'Garage cleanout',service_type:'Garage Cleanout',job_size:'Medium garage',what_to_remove:'Boxes and furniture',photo_description:'Full two-car garage',source:'Website',city:'Fort Collins',serviceZip:'80525',preferred_date:'2026-09-10',preferred_timing:'Morning',booking_slot:'Tomorrow AM',estimated_range:'$400–$650',flow_type:'booking',sms_consent:'yes',utm_source:'facebook',utm_medium:'paid-social',utm_campaign:'fall-garages',page_url:'https://easygaragecleaning.com/'})});
    const response=await onRequestPost({request,env:{HIGHLEVEL_API_KEY:'test-key',HIGHLEVEL_LOCATION_ID:'location-1',HIGHLEVEL_PIPELINE_ID:'pipe-1',HIGHLEVEL_USER_ID:'user-1',WEBSITE_LEAD_HOOK_URL:'https://hooks.example.test/lead'}});
    const result=await response.json();
    assert.equal(response.status,200);
    assert.equal(result.highlevel.synced,true);
    assert.equal(result.relay.sent,true);
    assert.equal(calls.filter(call=>call.url.endsWith('/contacts/upsert')).length,1);
    assert.equal(JSON.parse(calls.find(call=>call.url.endsWith('/contacts/upsert')).options.body).email,'new@example.com');
    const detailNote=calls.find(call=>call.url.endsWith('/contacts/contact-web/notes'));
    assert.ok(detailNote,'website lead details were not written to HighLevel');
    for(const value of ['Garage Cleanout','Medium garage','Boxes and furniture','Full two-car garage','Fort Collins 80525','Tomorrow AM','$400–$650','SMS consent checked: yes','facebook · paid-social · fall-garages'])assert.match(JSON.parse(detailNote.options.body).body,new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
    assert.equal(calls.filter(call=>call.url.endsWith('/opportunities/upsert')).length,1);
    const consentTags=calls.find(call=>call.url.endsWith('/contacts/contact-web/tags'));
    assert.deepEqual(JSON.parse(consentTags.options.body).tags,['egc-website-lead','egc-sms-consent']);
    assert.equal(calls.filter(call=>call.url.startsWith('https://hooks.example.test/lead')).length,1);
  }finally{globalThis.fetch=originalFetch}
});

test('website leads enter HighLevel but never trigger the text relay without explicit SMS consent',async()=>{
  const {onRequestPost}=await import('../functions/api/web-lead.js');
  const calls=[],originalFetch=globalThis.fetch;
  globalThis.fetch=async(url,options={})=>{calls.push({url:String(url),options});if(String(url).endsWith('/contacts/upsert'))return new Response(JSON.stringify({contact:{id:'contact-no-consent'}}),{status:200});return new Response('{}',{status:200})};
  try{
    const request=new Request('https://easygaragecleaning.com/api/web-lead',{method:'POST',headers:{Origin:'https://easygaragecleaning.com','Content-Type':'application/json'},body:JSON.stringify({name:'Call Only',phone:'9705550198',items:'Garage cleanout',source:'Website'})});
    const response=await onRequestPost({request,env:{HIGHLEVEL_API_KEY:'test-key',HIGHLEVEL_LOCATION_ID:'location-1',WEBSITE_LEAD_HOOK_URL:'https://hooks.example.test/lead'}}),result=await response.json();
    assert.equal(response.status,200);
    assert.equal(result.highlevel.synced,true);
    assert.equal(result.relay.sent,false);
    assert.equal(result.relay.skipped,'no-sms-consent');
    assert.equal(calls.some(call=>call.url.startsWith('https://hooks.example.test/lead')),false);
    const consentTags=calls.find(call=>call.url.endsWith('/contacts/contact-no-consent/tags'));
    assert.deepEqual(JSON.parse(consentTags.options.body).tags,['egc-website-lead','egc-no-sms-consent']);
  }finally{globalThis.fetch=originalFetch}
});

test('legacy Firebase leads are not loaded into the reset Hub',()=>{
  assert.doesNotMatch(employee,/db\.collection\('leads'\)\.onSnapshot/);
  assert.doesNotMatch(employee,/db\.collection\('leads'\)\.get/);
  assert.match(employee,/leadsCache = \[\];/);
  assert.match(suite,/New HighLevel leads/);
  assert.match(suite,/setInterval\(\(\)=>\{if\(!document\.hidden&&typeof me!=='undefined'&&me&&isLead\(\)\)loadGhl\(\)\},60000\)/);
  assert.match(highlevel,/DEFAULT_LEAD_RESET_AT/);
  assert.match(webLead,/syncHighLevelLead/);
});

test('employees can discover and safely pick up manager-opened crew shifts',()=>{
  for(const marker of ["'open_shifts'",'Open shifts','Crew needed','openShift','crewNeeded','assignedCrew','Crew full','Route','Pick up shift','expectedShiftHours','estimatedDurationMin','hrs expected','+ 1.5 hrs travel / dump']){
    assert.match(suite,new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')),marker+' is missing');
  }
  assert.match(suite,/db\.collection\('jobs'\)\.doc\(id\)/);
  assert.match(suite,/db\.runTransaction\(async tx=>/);
  assert.match(suite,/await tx\.get\(ref\)/);
  assert.match(suite,/tx\.set\(ref,patch,\{merge:true\}\)/);
  assert.match(suite,/assignedCrew=\[\.\.\.crew,identity\]/);
  assert.match(suite,/openShift=assignedCrew\.length<needed/);
  for(const marker of ['async function syncCrewAssignment','silent_update=true','crew-assignment:','latestJobInstructions:patch.jobInstructions','Shift added and crew brief synced','HighLevel update is queued'])assert.match(suite,new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
  for(const guard of ['SHIFT_MISSING','SHIFT_CLOSED','SHIFT_DUPLICATE','SHIFT_FULL','Sign in again before claiming a shift'])assert.match(suite,new RegExp(guard));
  assert.doesNotMatch(suite,/collection\(['"]open_shifts['"]\)/);
});

test('employees have a personal schedule for assigned and claimed work',()=>{
  for(const marker of ["'my_shifts'",'My shifts','PERSONAL FIELD SCHEDULE','myShiftJobs','myShiftBoard','Manager-assigned and self-claimed work','Open brief'])assert.match(suite,new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')),marker+' is missing');
  assert.match(suite,/crewNames\(j\)\.some\(n=>sameEmployee\(n,identity\)\)/);
  assert.match(suite,/String\(j\.date\|\|''\)>=day\(\)/);
  assert.match(suite,/\/crew\/prejob\.html\?jobId=/);
  assert.match(suite,/routeUrl\(j\.address\)/);
});

test('assigned shifts download as private calendar events',()=>{
  for(const marker of ['Add to calendar','opsDownloadShift','text/calendar','DTSTART;TZID=America/Denver','Open crew brief:'])assert.ok(suite.includes(marker),marker+' is missing');
  assert.match(suite,/URL\.createObjectURL\(blob\)/);
  assert.match(suite,/egc-shift-\$\{String\(j\.date/);
});

test('claimed shifts stay visible and can be safely released by the claimant',()=>{
  for(const marker of ['shiftPickupEnabled','shiftClaims','opsReleaseShift','Release shift','lastShiftRelease','crew-release:','Shift released and crew brief synced'])assert.match(suite,new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
  assert.match(suite,/const pickupEnabled=/);
  assert.match(suite,/claimed&&\(claims\.some/);
  assert.match(suite,/assignedCrew=crewNames\(job\)\.filter/);
  assert.match(suite,/shiftClaims=claims\.filter/);
  assert.match(suite,/const pickupStageOpen=/);
  assert.match(suite,/!pickupStageOpen\(job\)/);
  assert.match(suite,/locked because dispatch has started/);
});

test('employee availability prevents manager assignment and conflicting shift pickup',()=>{
  for(const marker of ["'availability'",'Time off','TIME-OFF CALENDAR','availabilityCalendar','opsSelectAvailabilityDay','opsAvailabilityMove','Block the full day','crew_availability','opsSaveAvailability','opsRemoveAvailability','crewAvailabilityConflict','marked this time unavailable','overlaps time you marked unavailable'])assert.match(suite,new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
  assert.match(suite,/const isAvailability=/);
  assert.match(suite,/jobsCache\.filter\(j=>!isScheduleLock\(j\)&&!isAvailability\(j\)&&!isPrivateHubRecord\(j\)\)/);
  assert.match(suite,/recordType:'crew_availability'/);
  assert.match(suite,/sameEmployee\(row\.employee,identity\)/);
  assert.match(suite,/status:'cancelled',cancelledAt/);
  assert.match(suite,/You are already assigned to \$\{assigned\.customer/);
  assert.match(suite,/ask a manager to reassign it first/);
});

test('walkthrough estimates job length and offers the next three collision-free openings',()=>{
  for(const marker of ['estimatedJobMinutes','findNearestSlots','SLOT_OPTIONS','Next 3 openings','Checking the Hub, crew time off, and HighLevel','estimatedDurationMin','estimatedDurationHours','expectedShiftHours','ESTIMATED JOB TIME','EXPECTED PAID SHIFT'])assert.match(crew,new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')),marker+' is missing');
  assert.match(crew,/jobMinutes\+90/);
  assert.match(crew,/options\.length<3/);
  assert.match(crew,/view=schedule&start=/);
  assert.match(crew,/recordType==='crew_availability'/);
  assert.match(crew,/date\.getDay\(\)===0/);
});

test('crew assignment updates the HighLevel appointment without retriggering customer automation',async()=>{
  const {onRequestPost}=await import('../functions/api/highlevel.js'),calls=[],originalFetch=globalThis.fetch;
  globalThis.fetch=async(url,options={})=>{calls.push({url:String(url),options});if(String(url).endsWith('/calendars/events/appointments/appt-1'))return new Response(JSON.stringify({id:'appt-1'}),{status:200});return new Response('{}',{status:200})};
  try{
    const request=new Request('https://easygaragecleaning.com/api/highlevel',{method:'POST',headers:{Origin:'https://easygaragecleaning.com',Cookie:TEST_HUB_COOKIE,'Content-Type':'application/json'},body:JSON.stringify({tool:'schedule',event_type:'job',silent_update:true,appointment_id:'appt-1',start_time:'2026-09-14T15:00:00.000Z',end_time:'2026-09-14T18:00:00.000Z',notes:'CREW / WINDOW: Alex + Sam',client:{name:'Customer',highlevel_contact_id:'contact-1'}})});
    const response=await onRequestPost({request,env:{HIGHLEVEL_API_KEY:'test-key',HIGHLEVEL_LOCATION_ID:'location-1',HIGHLEVEL_JOB_CALENDAR_ID:'calendar-1'}}),result=await response.json();
    assert.equal(response.status,200);
    assert.equal(result.automation.silent,true);
    assert.equal(result.automation.notificationsRequested,false);
    assert.equal(calls.filter(x=>x.url.includes('/tags')).length,0);
    assert.equal(calls.filter(x=>x.url.includes('/opportunities')).length,0);
    const update=calls.find(x=>x.url.endsWith('/calendars/events/appointments/appt-1'));
    assert.ok(update);
    assert.equal(JSON.parse(update.options.body).description,'CREW / WINDOW: Alex + Sam');
  }finally{globalThis.fetch=originalFetch}
});

test('open-shift scheduling fields persist on the canonical job record',()=>{
  for(const field of ['openShift','crewNeeded','assignedCrew'])assert.match(suite,new RegExp(field+','));
  assert.match(suite,/b\.openShift=fd\.has\('openShift'\)/);
  assert.match(suite,/job\.shiftPickupEnabled=b\.type==='job'/);
  assert.match(suite,/job\.openShift=job\.shiftPickupEnabled/);
  assert.match(suite,/assignedCrew\.length<crewNeeded/);
  assert.match(suite,/crewSize:b\.type==='job'\?crewNeeded/);
  assert.match(suite,/crewSize:needed,openShift/);
  assert.match(suite,/if\(k==='type'\)render\(\)/);
  assert.match(suite,/b\.type==='job'\?'':'ops-hidden'/);
  assert.match(suite,/b\.type==='blocked'\?'ops-hidden':''/);
  assert.match(employee,/employee-suite\.css\?v=20260904g/);
  assert.match(employee,/employee-suite\.js\?v=20260904g/);
});

test('recurring visits keep the client plan but reset prior completion and payment state',()=>{
  for(const marker of ['sourceTemplateJobId:j.id',"sourceWalkthroughId:''",'acceptance:null','preJobProgress:null','preJobChecklist:null','postJobProgress:null','postJobChecklist:null','actualLoads:null','hoursOnSite:null','scopeVariance:null','closeoutSyncPayload:null','reviewStatus:'])assert.match(suite,new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')),marker+' is missing from recurring reset');
  assert.match(suite,/derived=refreshWalkthroughHandoff\(j/);
  assert.match(suite,/shiftClaims:\[\]/);
  assert.match(suite,/lastShiftClaim:null/);
  assert.match(suite,/lastShiftRelease:null/);
  assert.match(suite,/openShift:shiftPickupEnabled&&assignedCrew\.length<crewNeeded/);
  assert.match(suite,/crewAvailabilityConflict\(date,next\.time,next\.endTime,assignedCrew\)/);
  assert.match(suite,/is unavailable during the next visit/);
  assert.match(suite,/const remote=await remoteCollision\(next\)/);
  assert.match(suite,/HighLevel already has \$\{remote\.title\|\|'an appointment'\} during that time/);
  assert.match(suite,/notes:job\.internalNotes\|\|job\.notes/);
  assert.match(suite,/customerUpdate=job\.customerId&&job\.internalNotes/);
  assert.match(suite,/function addCalendarMonths\(date,months\)/);
  assert.match(suite,/d\.setDate\(1\);d\.setMonth\(d\.getMonth\(\)\+months\)/);
  assert.match(suite,/Math\.min\(originalDay,lastDay\)/);
});

test('schedule stops safely when the Hub session expires during CRM collision checks',()=>{
  assert.match(suite,/if\(error\?\.code==='HUB_AUTH_REQUIRED'\)throw error/);
  assert.match(suite,/Sign in again to check HighLevel before saving\. Your form is still here\./);
  assert.match(suite,/button\.textContent='Retry schedule check'/);
  assert.match(crew,/if\(error\?\.code==='HUB_AUTH_REQUIRED'\)throw error/);
  assert.match(crew,/Your walkthrough is saved on this device\. Sign in again before scheduling it\./);
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
  assert.match(crew,/priceManuallySet:false/);
  assert.match(crew,/else if\(!S\.priceManuallySet\)S\.lockedPrice=''/);
});

test('walkthrough hazard choices cannot contradict the crew brief',()=>{
  assert.match(crew,/key==='hazards'/);
  assert.match(crew,/value==='No visible hazards'/);
  assert.match(crew,/filter\(x=>x!=='No visible hazards'\)/);
});

test('walkthrough photos have a durable cross-device handoff when Drive is connected',()=>{
  for(const marker of ['syncWalkthroughPhotos','/api/drive-upload','photoSyncStatus','photoDriveUrl','latestPhotoFolderUrl'])assert.match(crew,new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
  assert.match(prejob,/renderWalkthroughPhotoFolder/);
  assert.match(postjob,/restoreWalkthroughPhotoFolder/);
  assert.match(prejob,/Open the client photo folder/);
  assert.match(postjob,/Open the client photo folder/);
  assert.doesNotMatch(postjob,/AI preview/);
  assert.match(suite,/function photoState/);
  assert.match(suite,/photos are not in Drive/);
  assert.match(suite,/Drive setup needed/);
  assert.match(suite,/photoDriveUrl/);
  for(const marker of ['proofPhotoCount','afterPhotoCount','receiptPhotoCount','latestProofPhotoCount','photoUpdatedAt','photoSyncStatus:syncStatus'])assert.ok(postjob.includes(marker),marker+' is missing from final proof handoff');
  assert.match(suite,/j\.proofPhotoCount\|\|j\.photoCount/);
});

test('crew photo evidence is keyboard accessible',()=>{
  for(const page of [crew,prejob,postjob]){
    assert.match(page,/role="button" tabindex="0"/);
    assert.match(page,/event\.key==='Enter'/);
  }
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
  for(const [name,html] of [['employee.html',employee],['crew/index.html',crewHome],['crew/gameplan.html',crew],['crew/prejob.html',prejob],['crew/postjob.html',postjob]]){
    const scripts=[...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)].map(x=>x[1]).filter(Boolean);
    scripts.forEach((code,i)=>assert.doesNotThrow(()=>new vm.Script(code,{filename:name+'#'+i})));
  }
  assert.doesNotThrow(()=>new vm.Script(suite,{filename:'employee-suite.js'}));
});

test('employee hub v2 personalizes access, time, pay, communication, training, and safety',()=>{
  for(const marker of ["'my_day'","'earnings'","'requests'","'training'","'safety'","'people'",'employeeViews','currentRole','canView','Employee Hub','My pay','Clock in + share location','Clock in without location','watchPosition','clearWatch','locationConsentAt','locationTracking:false','Estimated gross paycheck','Made this year','All-time Hub earnings','opsApproveTime','opsSubmitRequest','opsNewAnnouncement','opsCompleteTraining','opsReportIncident','Last shift location']){
    assert.match(suite,new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')),marker+' is missing');
  }
  assert.match(read('functions/_lib/hub-session.js'),/DEFAULT_USER_META/);
  assert.match(read('functions/_lib/hub-session.js'),/hourlyRate/);
  assert.match(employee,/rememberHubProfile/);
  assert.match(read('crew/hub-auth.js'),/egc_hourly_rate/);
  const vault=read('functions/api/employee-hub.js');
  for(const marker of ['getHubSession','AES-GCM','sealedPayload','opaqueId','visibleTo','authorizeMutation','EMPLOYEE_HUB_DATA_SECRET'])assert.match(vault,new RegExp(marker));
  assert.match(suite,/fetch\('\/api\/employee-hub'/);
  assert.doesNotMatch(suite,/db\.collection\(peopleCollections/);
});

test('only Zac Tyler and Alex receive business access while new employees get onboarding',async()=>{
  assert.equal(hasBusinessAccess('ZacB'),true);
  assert.equal(hasBusinessAccess('TylerG'),true);
  assert.equal(hasBusinessAccess('AlexK'),true);
  assert.equal(hasBusinessAccess('FrankJara'),false);
  assert.equal(hasBusinessAccess('CrewTest'),false);
  assert.equal(getHubUserProfile({},'CrewTest').role,'crew');
  const passwordHash=await hashHubCredential('NewHire','welcome');
  const profile=getHubUserProfile({HUB_AUTH_USERS_JSON:JSON.stringify({NewHire:passwordHash})},'NewHire');
  assert.equal(profile.role,'crew');
  assert.equal(profile.businessAccess,false);
  for(const marker of ['BUSINESS_USERS','enterEmployeeApp','canRunBusiness','Run your business'])assert.match(employee,new RegExp(marker));
  for(const marker of ["new Set(['zacb','tylerg','alexk'])","'onboarding'",'Finish onboarding','opsSaveOnboarding','opsOnboardingDraft','Draft saved automatically.','onboardingDraftAcknowledgements','onboardingDraftVersion','draft,false','ops-quick-clock','opsQuickClock','employeeViews'])assert.match(suite,new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
  const vault=read('functions/api/employee-hub.js');
  assert.match(vault,/hasBusinessAccess\(session\)/);
  assert.match(vault,/onboardingCompletedAt/);
});

test('employee pay and location records are sealed behind the Hub session',async()=>{
  const api=await import('../functions/api/employee-hub.js');
  const env={...TEST_HUB_ENV,HUB_SESSION_SECRET:'employee-hub-test-secret',FIREBASE_API_KEY:'firebase-test-key'};
  const managerCookie=(await createHubSessionCookie(env,'ZacB')).split(';')[0];
  const stored=new Map(),originalFetch=globalThis.fetch;
  globalThis.fetch=async(url,options={})=>{
    const value=String(url),method=options.method||'GET';
    if(value.includes('documents:runQuery'))return new Response(JSON.stringify([...stored.entries()].map(([id,document])=>({document:{name:`projects/egcw-1ec83/databases/(default)/documents/jobs/${id}`,...document}}))),{status:200});
    const id=decodeURIComponent(value.match(/\/jobs\/([^?]+)/)?.[1]||'');
    if(method==='PATCH'){const document=JSON.parse(options.body);stored.set(id,document);return new Response(JSON.stringify({name:`projects/egcw-1ec83/databases/(default)/documents/jobs/${id}`,...document}),{status:200})}
    if(!stored.has(id))return new Response('{}',{status:404});
    return new Response(JSON.stringify({name:`projects/egcw-1ec83/databases/(default)/documents/jobs/${id}`,...stored.get(id)}),{status:200});
  };
  try{
    const managerRequest=data=>new Request('https://easygaragecleaning.com/api/employee-hub',{method:'POST',headers:{Origin:'https://easygaragecleaning.com',Cookie:managerCookie,'Content-Type':'application/json'},body:JSON.stringify(data)});
    for(const [id,employee,lat] of [['time-frank','FrankJara',40.5853],['time-tyler','TylerG',40.61]]){
      const response=await api.onRequestPost({request:managerRequest({collection:'timeEntries',id,data:{employee,hourlyRate:20,clockInAt:'2026-09-04T15:00:00.000Z',lastLocation:{lat,lng:-105.0844}}}),env});
      assert.equal(response.status,200);
    }
    const raw=JSON.stringify([...stored.values()]);
    assert.doesNotMatch(raw,/FrankJara|40\.5853|hourlyRate/);
    const frankCookie=(await createHubSessionCookie(env,'FrankJara')).split(';')[0];
    const response=await api.onRequestGet({request:new Request('https://easygaragecleaning.com/api/employee-hub',{headers:{Cookie:frankCookie}}),env});
    assert.equal(response.status,200);
    const result=await response.json();
    assert.equal(result.collections.timeEntries.length,1);
    assert.equal(result.collections.timeEntries[0].employee,'FrankJara');
    assert.equal(result.collections.timeEntries[0].lastLocation.lat,40.5853);
    const draft=await api.onRequestPost({request:new Request('https://easygaragecleaning.com/api/employee-hub',{method:'POST',headers:{Origin:'https://easygaragecleaning.com',Cookie:frankCookie,'Content-Type':'application/json'},body:JSON.stringify({collection:'profiles',id:'frankjara',data:{preferredName:'Frankie',phone:'970-555-0100',emergencyContactName:'Sam',emergencyContactPhone:'970-555-0199',onboardingDraftAcknowledgements:['timekeeping'],onboardingDraftAt:'2026-09-04T17:59:00.000Z'}})}),env});
    assert.equal(draft.status,200);
    const draftResult=await draft.json();
    assert.equal(draftResult.record.phone,'970-555-0100');
    assert.deepEqual(draftResult.record.onboardingDraftAcknowledgements,['timekeeping']);
    assert.equal(draftResult.record.onboardingCompletedAt,undefined);
    const onboard=await api.onRequestPost({request:new Request('https://easygaragecleaning.com/api/employee-hub',{method:'POST',headers:{Origin:'https://easygaragecleaning.com',Cookie:frankCookie,'Content-Type':'application/json'},body:JSON.stringify({collection:'profiles',id:'frankjara',data:{preferredName:'Frankie',phone:'970-555-0100',emergencyContactName:'Sam',emergencyContactPhone:'970-555-0199',onboardingCompletedAt:'2026-09-04T18:00:00.000Z',role:'owner',hourlyRate:999}})}),env});
    assert.equal(onboard.status,200);
    const onboardResult=await onboard.json();
    assert.equal(onboardResult.record.preferredName,'Frankie');
    assert.equal(onboardResult.record.role,'crew');
    assert.equal(onboardResult.record.hourlyRate,20);
    assert.deepEqual(onboardResult.record.onboardingAcknowledgements,['timekeeping','safety','customer_care']);
    const tylerCookie=(await createHubSessionCookie(env,'TylerG')).split(';')[0];
    const tylerView=await api.onRequestGet({request:new Request('https://easygaragecleaning.com/api/employee-hub',{headers:{Cookie:tylerCookie}}),env});
    assert.equal((await tylerView.json()).collections.timeEntries.length,2);
    const outsiderEnv={...env,HUB_AUTH_USERS_JSON:JSON.stringify({Eve:{passwordHash:await hashHubCredential('Eve','password'),role:'manager'}})};
    const outsiderCookie=(await createHubSessionCookie(outsiderEnv,'Eve')).split(';')[0];
    const outsiderView=await api.onRequestGet({request:new Request('https://easygaragecleaning.com/api/employee-hub',{headers:{Cookie:outsiderCookie}}),env:outsiderEnv});
    assert.equal((await outsiderView.json()).collections.timeEntries.length,0);
  }finally{globalThis.fetch=originalFetch}
});
