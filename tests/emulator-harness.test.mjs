import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {authenticateHubCredential} from '../functions/_lib/hub-session.js';
import {addDays,denverToday} from '../functions/_lib/dispatch-time.js';
import {createFieldPhotoClient,decodeFieldPhoto} from '../functions/_lib/field-execution-photos.js';
import {DEFAULT_USERS,HARNESS_HOST,HARNESS_NOW,SYNTHETIC_PASSWORD,createHubServer,emulatorFetch,harnessHosts,hubUsers,loopbackEmulator,startEmulatorHarness,testClock} from './helpers/emulator-harness.mjs';
import {createPagesRouter} from './helpers/pages-router.mjs';
import {firestoreMemory} from './helpers/firestore-memory.mjs';

const enabled=process.env.EGC_FIREBASE_EMULATOR_TEST==='1';
// A 1x1 PNG: the smallest real image the Drive photo client accepts.
const PNG='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

test('only a loopback emulator host is accepted',()=>{
 for(const host of['127.0.0.1:8089','localhost:41234','[::1]:9000'])assert.equal(loopbackEmulator(host),host);
 for(const host of['','firestore.googleapis.com:443','10.0.0.5:8080','127.0.0.1','127.0.0.1.example.invalid:8089','localhost:8089/extra'])assert.throws(()=>loopbackEmulator(host),/loopback Firestore emulator/);
});

test('production Firestore traffic is rewritten to the demo project and every other host is refused',async()=>{
 const calls=[],upstream=async(input,options={})=>{calls.push({url:String(input),options});return new Response('{}');};
 const drive=async()=>new Response('synthetic drive');
 assert.throws(()=>emulatorFetch({emulator:'127.0.0.1:8089',projectId:'egcw-1ec83',fetch:upstream}),/demo-\* id/);
 const fetcher=emulatorFetch({emulator:'127.0.0.1:8089',projectId:'demo-egc-harness',fetch:upstream,hosts:{'www.googleapis.com':drive}});
 const body=JSON.stringify({writes:[{update:{name:'projects/egcw-1ec83/databases/(default)/documents/jobs/a'}},{delete:'projects/egcw-1ec83/databases/(default)/documents/jobs/b'}]});
 await fetcher(new URL('https://firestore.googleapis.com/v1/projects/egcw-1ec83/databases/(default)/documents:commit?key=firebase-test-x'),{method:'POST',headers:new Headers({'Content-Type':'application/json',Authorization:'Bearer real-token'}),body});
 assert.equal(calls.length,1);const [call]=calls;
 assert.equal(call.url,'http://127.0.0.1:8089/v1/projects/demo-egc-harness/databases/(default)/documents:commit?key=firebase-test-x');
 assert.equal(call.options.method,'POST');assert.equal(call.options.headers.get('Authorization'),'Bearer owner');assert.equal(call.options.headers.get('Content-Type'),'application/json');
 assert.ok(!call.options.body.includes('egcw-1ec83'));assert.equal(JSON.parse(call.options.body).writes[1].delete,'projects/demo-egc-harness/databases/(default)/documents/jobs/b');
 await fetcher('https://firestore.googleapis.com/v1/projects/egcw-1ec83/databases/(default)/documents/jobs/a');
 assert.equal(calls[1].url,'http://127.0.0.1:8089/v1/projects/demo-egc-harness/databases/(default)/documents/jobs/a');assert.equal('body' in calls[1].options,false);
 assert.equal(await (await fetcher('https://www.googleapis.com/drive/v3/files/x')).text(),'synthetic drive');
 await fetcher('http://localhost:3000/api/hub-auth');await fetcher('http://127.0.0.1:3000/x');assert.equal(calls.length,4);
 for(const url of['https://services.leadconnectorhq.com/contacts/','https://api.stripe.com/v1/checkout/sessions','https://oauth2.googleapis.com/token','https://firestore.googleapis.com.example.invalid/v1'])await assert.rejects(fetcher(url),/External network refused/);
 assert.equal(calls.length,4);
});

test('seeded hub users authenticate with the synthetic password through the real credential check',async()=>{
 const users=await hubUsers([...DEFAULT_USERS,{user:'Sales.One',displayName:'Synthetic Sales',role:'sales'}]);
 const env={HUB_SESSION_SECRET:'synthetic-harness-users',HUB_AUTH_USERS_JSON:JSON.stringify(users)};
 const owner=await authenticateHubCredential(env,'zacb',SYNTHETIC_PASSWORD);
 assert.deepEqual([owner.user,owner.role,owner.businessAccess,owner.displayName],['ZacB','owner',true,'Synthetic Owner']);
 assert.equal((await authenticateHubCredential(env,'Sales.One',SYNTHETIC_PASSWORD)).role,'sales');
 assert.equal((await authenticateHubCredential(env,'Crew.One',SYNTHETIC_PASSWORD)).businessAccess,false);
 assert.equal(await authenticateHubCredential(env,'Crew.One','wrong synthetic password'),null);
 assert.ok(Object.values(users).every(user=>/^[a-f0-9]{64}$/.test(user.passwordHash)&&!JSON.stringify(user).includes(SYNTHETIC_PASSWORD)));
});

test('the test clock is fixed, copied per read and moved only by set or advance',()=>{
 const clock=testClock(),first=clock();first.setUTCFullYear(1999);
 assert.equal(HARNESS_NOW,'2026-09-22T12:00:00.000Z');assert.equal(clock().toISOString(),HARNESS_NOW);assert.equal(clock.iso(),HARNESS_NOW);assert.equal(clock.now().toISOString(),HARNESS_NOW);
 assert.equal(clock.advance(90*60000).toISOString(),'2026-09-22T13:30:00.000Z');assert.equal(clock.iso(),'2026-09-22T13:30:00.000Z');
 assert.equal(clock.set('2026-12-31T23:59:59.000Z').toISOString(),'2026-12-31T23:59:59.000Z');assert.equal(testClock(new Date(0)).iso(),'1970-01-01T00:00:00.000Z');
 assert.throws(()=>clock.set('not a time'),/Invalid test clock time/);assert.throws(()=>clock.advance('1 day'),/milliseconds/);assert.throws(()=>testClock('nope'),/Invalid test clock time/);
});

test('hub server serves the site and routes /api through real handlers with login, cookies and error capture',async t=>{
 const env={HUB_SESSION_SECRET:'synthetic-harness-server',HUB_AUTH_USERS_JSON:JSON.stringify(await hubUsers())};
 const hub=await createHubServer({env});t.after(()=>hub.close());
 // 127.0.0.1, not localhost: the Playwright guard in tests/e2e/helpers/test.mjs only lets that hostname through.
 assert.equal(HARNESS_HOST,'127.0.0.1');assert.match(hub.base,/^http:\/\/127\.0\.0\.1:\d+$/);
 const page=await fetch(hub.base+'/crew/job.html');assert.equal(page.status,200);assert.match(page.headers.get('Content-Type'),/text\/html/);assert.match(await page.text(),/Today's work/);
 assert.equal((await fetch(hub.base+'/dispatch')).status,200);
 for(const path of['/missing-page.html','/%2e%2e/%2e%2e/etc/passwd','/..%2fpackage.json','/%E0%A4%A'])assert.equal((await fetch(hub.base+path)).status,404,path);
 const anonymous=await hub.api('/api/hub-auth');assert.equal(anonymous.status,401);
 assert.deepEqual(hub.apiErrors.map(error=>[error.method,error.path,error.status]),[['GET','/api/hub-auth',401]]);
 await assert.rejects(hub.login('Crew.One','not the synthetic password'),error=>error.status===401);
 const cookie=await hub.login('Crew.One');assert.match(cookie,/^egc_hub_session=[^;]+$/);
 const session=await (await hub.api('/api/hub-auth',{user:'Crew.One'})).json();assert.deepEqual([session.user,session.role],['Crew.One','crew']);
 const denied=await hub.api('/api/dispatch?startDate=2026-09-23&endDate=2026-09-24',{user:'Crew.One'});
 assert.equal(denied.status,403);assert.equal((await denied.json()).code,'dispatch_forbidden');
 const crossSite=await hub.api('/api/dispatch',{user:'ZacB',body:{},headers:{Origin:'https://attacker.example.invalid'}});assert.equal(crossSite.status,403);
 assert.deepEqual(hub.serverErrors,[]);assert.deepEqual(hub.router.errors,[]);
});

test('real handlers behind the hub server read the harness clock, which tests move with set and advance',async t=>{
 const originalFetch=globalThis.fetch,firestore=firestoreMemory({fallback:(input,options)=>originalFetch(input,options)});
 t.mock.method(globalThis,'fetch',firestore.fetch);
 const env={HUB_SESSION_SECRET:'synthetic-harness-clock',FIREBASE_API_KEY:'firebase-test-harness-clock',HUB_AUTH_USERS_JSON:JSON.stringify(await hubUsers())};
 const hub=await createHubServer({env});t.after(()=>hub.close());
 assert.equal(hub.clock.iso(),HARNESS_NOW);assert.equal(hub.router.now().toISOString(),HARNESS_NOW);
 const tomorrow=addDays(denverToday(hub.clock()),1),create=date=>hub.api('/api/crew-availability',{user:'Crew.One',body:{action:'create',requestId:randomUUID(),changes:{date,allDay:true,reason:'Synthetic personal time'}}});
 const saved=await create(tomorrow),body=await saved.json();
 assert.equal(saved.status,200,JSON.stringify(body));assert.deepEqual([body.record.date,body.record.createdAt],['2026-09-23',HARNESS_NOW]);
 hub.clock.advance(2*24*60*60*1000);
 const late=await create(tomorrow);assert.equal(late.status,400);assert.equal((await late.json()).code,'crew_availability_past_date');
 const overview=await (await hub.api('/api/crew-availability',{user:'Crew.One'})).json();assert.deepEqual([overview.startDate,overview.coverage.asOf],['2026-09-24','2026-09-24T12:00:00.000Z']);
 hub.clock.set(HARNESS_NOW);assert.equal((await create(addDays(tomorrow,1))).status,200);
 assert.deepEqual(hub.serverErrors,[]);assert.deepEqual(hub.router.errors,[]);
 const own=await createHubServer({env,now:'2030-01-02T03:04:05.000Z'});t.after(()=>own.close());assert.equal(own.clock.iso(),'2030-01-02T03:04:05.000Z');
 const real=await createHubServer({env,now:null});t.after(()=>real.close());assert.equal(real.clock,null);assert.equal(real.router.now,null);
 const router=createPagesRouter({env,now:HARNESS_NOW}),passed=await createHubServer({env,router});t.after(()=>passed.close());assert.equal(passed.clock,router.now);
});

test('drive:true answers Google Drive and OAuth with the synthetic fake while every other host stays refused',async t=>{
 const before=globalThis.fetch,synthetic=await harnessHosts({drive:true});
 assert.equal(globalThis.fetch,before,'harnessHosts must not replace globalThis.fetch');
 assert.deepEqual(Object.keys(synthetic.routes).sort(),['oauth2.googleapis.com','www.googleapis.com']);
 assert.deepEqual(synthetic.env,{GOOGLE_CLIENT_ID:'synthetic-harness-client',GOOGLE_CLIENT_SECRET:'synthetic-harness-secret',GOOGLE_REFRESH_TOKEN:'synthetic-harness-refresh'});
 const upstream=async input=>{throw new Error('The real network was reached: '+input);};
 t.mock.method(globalThis,'fetch',emulatorFetch({emulator:'127.0.0.1:9099',projectId:'demo-egc-harness-drive',fetch:upstream,hosts:synthetic.routes}));
 const client=await createFieldPhotoClient(synthetic.env),picture=decodeFieldPhoto(PNG),id=await client.allocate();
 assert.equal(id,'file-1');
 await client.upload(id,'job-harness','synthetic-request-1',picture,'before');
 const metadata=await client.metadata(id);
 assert.deepEqual([metadata.name,metadata.mimeType,metadata.appProperties],['EGC-job-harness-before-synthetic-request-1.png','image/png',{egcJobId:'job-harness',egcFieldRequestId:'synthetic-request-1'}]);
 assert.deepEqual(Buffer.from(await (await client.image(id)).arrayBuffer()),Buffer.from(picture.bytes));
 assert.equal(await client.metadata('missing-file'),null);
 assert.equal(synthetic.drive.calls.uploads,1);assert.equal(synthetic.drive.files.get(id).size,picture.bytes.length);
 for(const url of['https://storage.googleapis.com/bucket/x','https://sheets.googleapis.com/v4/spreadsheets/x','https://api.stripe.com/v1/charges','https://www.googleapis.com.example.invalid/drive/v3/files'])await assert.rejects(fetch(url),/External network refused/,url);
 const custom=async()=>new Response('custom drive'),mixed=await harnessHosts({drive:true,hosts:{'www.googleapis.com':custom}});
 assert.equal(mixed.routes['www.googleapis.com'],custom);assert.equal(typeof mixed.routes['oauth2.googleapis.com'],'function');
 const none=await harnessHosts();assert.deepEqual([none.routes,none.env,none.drive],[{},{},null]);
});

test('emulator harness persists a real dispatch write on the harness clock and serves synthetic Drive',{skip:!enabled,timeout:90000},async t=>{
 const harness=await startEmulatorHarness({projectId:'demo-egc-harness-test',drive:true});t.after(()=>harness.close());
 const DAY=addDays(denverToday(harness.clock()),1),END=addDays(DAY,1);
 assert.deepEqual([harness.clock.iso(),DAY],[HARNESS_NOW,'2026-09-23']);
 await harness.seed(async db=>{
  await db.doc('customers/harness-customer').set({name:'Synthetic Harness Customer',phone:'9705550142',address:'142 Synthetic Way, Fort Collins, CO'});
  await db.doc('dispatchResources/harness-truck').set({recordType:'vehicle',name:'Synthetic Truck',status:'available'});
 });
 await assert.rejects(fetch('https://services.leadconnectorhq.com/contacts/'),/External network refused/);
 const photos=await createFieldPhotoClient(harness.env);assert.equal(await photos.allocate(),'file-1');assert.equal(harness.drive.calls.generated,1);
 const overview=await harness.api(`/api/dispatch?startDate=${DAY}&endDate=${END}`,{user:'ZacB'});
 assert.equal(overview.status,200);const listed=await overview.json();assert.equal(listed.ok,true);assert.equal(listed.vehicles[0].name,'Synthetic Truck');
 const requestId=randomUUID();
 const created=await harness.api('/api/dispatch',{user:'ZacB',body:{action:'schedule.create',requestId,kind:'job',customerId:'harness-customer',changes:{date:DAY,time:'09:00',endDate:DAY,endTime:'11:00',serviceType:'Synthetic harness service',assignedCrew:['crew.one'],vehicleId:'harness-truck'}}});
 const result=await created.json();assert.equal(created.status,200,JSON.stringify(result));
 const saved=await harness.readDoc('jobs/'+result.job.id);
 assert.equal(saved.customerId,'harness-customer');assert.equal(saved.dispatchRequestId,requestId);assert.deepEqual(saved.assignedCrew,['crew.one']);
 assert.deepEqual([saved.createdAt,saved.dispatchUpdatedAt],[HARNESS_NOW,HARNESS_NOW],'dispatch writes carry the harness clock, not the real one');
 assert.equal((await harness.readDoc('dispatchOperations/'+requestId)).actorId,'ZacB');
 const replay=await harness.api('/api/dispatch',{user:'ZacB',body:{action:'schedule.create',requestId,kind:'job',customerId:'harness-customer',changes:{date:DAY,time:'09:00',endDate:DAY,endTime:'11:00',serviceType:'Synthetic harness service',assignedCrew:['crew.one'],vehicleId:'harness-truck'}}});
 assert.equal((await replay.json()).job.id,result.job.id);
 assert.equal((await harness.api(`/api/dispatch?startDate=${DAY}&endDate=${END}`,{user:'Crew.One'})).status,403);
 await harness.router.settle();assert.deepEqual(harness.serverErrors,[]);assert.deepEqual(harness.router.errors,[]);
});
