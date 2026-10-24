import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { customerAccountHandlers } from '../functions/api/customer-account.js';
import { customerVisitRequestsHandlers } from '../functions/api/customer-visit-requests.js';
import { createCustomerAccountSession } from '../functions/_lib/customer-account-session.js';
import { customerVisitCalendar } from '../functions/_lib/customer-visit-calendar.js';
import { VISIT_REQUESTS } from '../functions/_lib/customer-visit-requests.js';
import { customerVisitRequestStorage } from '../functions/_lib/customer-visit-requests.js';
import { crewDayFirestore } from './helpers/crew-day-firestore.mjs';
import { verifyCustomerPortalSessionToken } from '../functions/_lib/customer-portal.js';
import { NOW, ORIGIN, env, memory, seed, owner, crew } from './helpers/customer-login-fixture.mjs';

async function setup(extra={}){
  const store=memory({...seed(),...extra});
  store.visitRequests=async(field,value)=>[...store.rows].filter(([key,row])=>key.startsWith(VISIT_REQUESTS+'/')&&row[field]===value).map(([key])=>store.read(VISIT_REQUESTS,key.slice(VISIT_REQUESTS.length+1))).reduce(async(acc,row)=>[...await acc,await row],Promise.resolve([]));
  const session=await createCustomerAccountSession(store,env,{customerId:'customer-a',sessionVersion:0,via:'magic_link'},NOW);
  const handlers=customerAccountHandlers({storage:()=>store,now:()=>new Date(NOW)});
  async function call(body,query='',cookie=session.cookie){const request=new Request(ORIGIN+'/api/customer-account'+query,{method:body?'POST':'GET',headers:{Cookie:cookie,Origin:ORIGIN,'Content-Type':'application/json','X-EGC-Portal':'1'},...(body?{body:JSON.stringify(body)}:{})});const response=await handlers[body?'post':'get']({request,env});const text=await response.text();return {status:response.status,headers:response.headers,text,data:response.headers.get('Content-Type')?.includes('json')?JSON.parse(text):null};}
  const change=(overrides={})=>({action:'request_change',requestId:randomUUID(),jobId:'job-a1',kind:'reschedule',preferredDate:'2026-10-05',preferredTime:'10:00',note:'Please review another day.',...overrides});
  return {store,session,handlers,call,change};
}

test('history uses account authorization, filters and no-store responses without exposing internal fields',async()=>{
  const f=await setup();let result=await f.call();assert.equal(result.status,200);assert.deepEqual(result.data.jobs.map(row=>row.jobId),['job-a1','job-a2']);assert.doesNotMatch(result.text,/CANARY|contact-a|stripeSession|paymentIntent|password/);assert.match(result.headers.get('cache-control'),/no-store/);
  result=await f.call(null,'?filter=upcoming&q=garage');assert.deepEqual(result.data.jobs.map(row=>row.jobId),['job-a1']);
  result=await f.call(null,'?filter=past');assert.deepEqual(result.data.jobs.map(row=>row.jobId),['job-a2']);
  assert.equal((await f.call(null,'?from=2026-02-31')).status,400);assert.equal((await f.call(null,'','')).status,401);
  f.store.edit('jobs/job-a1',{businessAccountId:'business-1'});assert.deepEqual((await f.call()).data.jobs,[],'a business root also excludes its linked visits');
});

test('opening and calendar exports verify the selected job and account root again',async()=>{
  const f=await setup();const open=await f.call({action:'open_project',jobId:'job-a2'});assert.equal(open.status,200);assert.equal(open.data.url,'/customer-portal');const value=open.headers.get('set-cookie').split(';')[0].split('=')[1];const claims=await verifyCustomerPortalSessionToken(env,value,Date.parse(NOW));assert.deepEqual([claims.jobId,claims.linkRoot],['job-a2','job-a1']);
  assert.equal((await f.call({action:'open_project',jobId:'job-b1'})).status,404);assert.equal((await f.call(null,'?format=ics&jobId=job-b1')).status,404);
  f.store.edit('jobs/job-a1',{customerId:'customer-b'});assert.equal((await f.call({action:'open_project',jobId:'job-a2'})).status,404);
});

test('request replay and a lost commit preserve one request and never modify the booking or send',async()=>{
  const f=await setup(),before=f.store.get('jobs/job-a1'),input=f.change();let lost=true;f.store.hooks.loseResponse=writes=>lost&&writes.some(w=>w.collection===VISIT_REQUESTS)?(lost=false,true):false;
  const first=await f.call(input);assert.equal(first.status,200);assert.equal(first.data.replayed,true);assert.equal((await f.call(input)).data.replayed,true);assert.equal((await f.call({...input,note:'Different request'})).status,409);assert.deepEqual(f.store.get('jobs/job-a1'),before);
  const rows=[...f.store.rows].filter(([key])=>key.startsWith(VISIT_REQUESTS+'/'));assert.equal(rows.length,1);assert.equal(rows[0][1].status,'submitted');assert.ok(f.store.commits.flat().filter(w=>!w.verify).every(w=>[VISIT_REQUESTS,'hub_audit'].includes(w.collection)||w.collection==='customer_sessions'));
  assert.equal((await f.call()).data.requests.length,1);
});

test('request authorization is fenced against tenant changes, company links and session revocation',async()=>{
  const f=await setup();assert.equal((await f.call(f.change({jobId:'job-b1'}))).status,404);
  f.store.edit('jobs/job-a1',{businessAccountId:'business-1'});assert.equal((await f.call(f.change())).status,409);f.store.edit('jobs/job-a1',{businessAccountId:''});
  let race=true;f.store.hooks.beforeCommit=writes=>{if(race&&writes.some(w=>w.collection===VISIT_REQUESTS)){race=false;f.store.edit('customers/customer-a',{portalSessionVersion:1});}};
  assert.equal((await f.call(f.change())).status,409);assert.equal([...f.store.rows.keys()].filter(key=>key.startsWith(VISIT_REQUESTS+'/')).length,0);assert.equal((await f.call()).status,401);
});

test('only existing dispatch staff review requests and a review never cancels the canonical visit',async()=>{
  const f=await setup(),created=await f.call(f.change({kind:'cancel',preferredDate:'',preferredTime:''})),before=f.store.get('jobs/job-a1');let actor=crew;const api=customerVisitRequestsHandlers({storage:()=>f.store,session:async()=>actor,now:()=>new Date(NOW)});
  const call=async body=>{const response=await api[body?'post':'get']({env,request:new Request(ORIGIN+'/api/customer-visit-requests',{method:body?'POST':'GET',headers:{Origin:ORIGIN,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})})});return {status:response.status,data:await response.json()};};
  assert.equal((await call()).status,403);actor=owner;const queue=await call();assert.equal(queue.data.requests.length,1);const input={action:'review',id:created.data.request.id,requestId:randomUUID(),expectedRevision:queue.data.requests[0].revision,status:'closed',resolutionNote:'Please call us to discuss the request.'};assert.equal((await call(input)).status,200);assert.equal((await call(input)).data.replayed,true);assert.deepEqual(f.store.get('jobs/job-a1'),before);assert.equal((await f.call()).data.requests[0].status,'closed');
});

test('calendar exports validate Denver DST, escape text and have stable visit UIDs',()=>{
  const job={jobId:'synthetic',service:'Garage, cleanup\nNo injected property',address:'Synthetic; address',date:'2026-03-08',time:'01:30',endTime:'03:30'};
  const ics=customerVisitCalendar(job,new Date(NOW));assert.match(ics,/DTSTART:20260308T083000Z/);assert.match(ics,/DTEND:20260308T093000Z/);assert.match(ics,/Garage\\, cleanup\\nNo injected property/);assert.equal((ics.match(/BEGIN:VEVENT/g)||[]).length,1);
  for(const invalid of [{date:'2026-03-08',time:'02:30',endTime:'04:00'},{date:'2026-11-01',time:'01:30',endTime:'03:00'},{date:'2026-02-31',time:'10:00',endTime:'11:00'}])assert.throws(()=>customerVisitCalendar({...job,...invalid},new Date(NOW)),{code:'CUSTOMER_VISIT_CALENDAR_UNAVAILABLE'});
});

test('signout clears both cookies and revoked sessions cannot refresh or submit again',async()=>{
  const f=await setup(),result=await f.call({action:'sign_out'});assert.equal(result.status,200);assert.match(result.headers.get('set-cookie'),/__Host-egc_customer=;/);assert.match(result.headers.get('set-cookie'),/egc_customer_portal=;/);assert.equal((await f.call()).status,401);assert.equal((await f.call(f.change())).status,401);
});

test('signout reports an unconfirmed revocation and a lost successful revocation safely retries',async()=>{
 const f=await setup();let fail=true;f.store.hooks.beforeCommit=writes=>{if(fail&&writes.some(w=>w.collection==='customer_sessions'))throw Error('Synthetic storage outage');};
 const failed=await f.call({action:'sign_out'});assert.equal(failed.status,503);assert.equal(failed.headers.get('set-cookie'),null);
 fail=false;let lost=true;f.store.hooks.loseResponse=writes=>lost&&writes.some(w=>w.collection==='customer_sessions')?(lost=false,true):false;
 assert.equal((await f.call({action:'sign_out'})).status,200);assert.equal((await f.call()).status,401);
});

test('production storage wiring persists a request under transaction fences and queries only its customer',async t=>{
  const fire=crewDayFirestore(t),environment={...env,FIREBASE_API_KEY:'firebase-test-client-history'},store=customerVisitRequestStorage(environment);
  fire.put('customers/customer-a',{name:'Synthetic Customer',portalSessionVersion:0});fire.put('jobs/job-a',{type:'job',customerId:'customer-a',date:'2026-10-30',time:'09:30',endTime:'11:30',status:'scheduled'});
  const session=await createCustomerAccountSession(store,environment,{customerId:'customer-a',sessionVersion:0,via:'magic_link'},NOW);
  const handlers=customerAccountHandlers({now:()=>new Date(NOW)}),payload={action:'request_change',requestId:randomUUID(),jobId:'job-a',kind:'reschedule',preferredDate:'2026-11-03',preferredTime:'10:00',note:'Synthetic timing request'};
  const request=new Request(ORIGIN+'/api/customer-account',{method:'POST',headers:{Cookie:session.cookie,Origin:ORIGIN,'X-EGC-Portal':'1','Content-Type':'application/json'},body:JSON.stringify(payload)});
  assert.equal((await handlers.post({request,env:environment})).status,200);
  const response=await handlers.get({env:environment,request:new Request(ORIGIN+'/api/customer-account',{headers:{Cookie:session.cookie}})});assert.equal(response.status,200);assert.equal((await response.json()).requests.length,1);
  assert.equal(fire.get('jobs/job-a').date,'2026-10-30');assert.equal(fire.list(VISIT_REQUESTS).length,1);assert.deepEqual(fire.refused,[]);
});

test('invalid preferred times and cross-site writes cannot create a visit request',async()=>{
  const f=await setup();for(const values of [{preferredDate:'2026-11-01',preferredTime:'01:30'},{preferredDate:'2026-02-31',preferredTime:'10:00'},{kind:'cancel',preferredDate:'2026-10-05'}])assert.equal((await f.call(f.change(values))).status,400);
  const response=await f.handlers.post({env,request:new Request(ORIGIN+'/api/customer-account',{method:'POST',headers:{Cookie:f.session.cookie,Origin:'https://other.invalid','X-EGC-Portal':'1','Content-Type':'application/json'},body:JSON.stringify(f.change())})});assert.equal(response.status,403);assert.equal([...f.store.rows.keys()].filter(k=>k.startsWith(VISIT_REQUESTS+'/')).length,0);
});
