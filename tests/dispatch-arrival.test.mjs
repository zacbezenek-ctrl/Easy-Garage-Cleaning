import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { arrivalClock, formatArrivalWindow, defaultArrivalWindow, arrivalWindowProblem, arrivalWindowFields, arrivalWindowMinutes, arrivalSettings, arrivalWindowPatch, arrivalDefaults } from '../functions/_lib/dispatch-arrival.js';
import { dispatchOverview, mutateDispatch } from '../functions/_lib/dispatch-service.js';
import { dispatchHandlers } from '../functions/api/dispatch.js';
import { dispatchStorage } from '../functions/_lib/dispatch-storage.js';
import { mutateScheduledVisit, schedulingStorage } from '../functions/_lib/operations-scheduling.js';
import { fieldJobProjection } from '../functions/_lib/field-execution.js';
import { crewJobProjection } from '../functions/_lib/crew-job-projection.js';
import { createCustomerPortalSessionCookie } from '../functions/_lib/customer-portal.js';
import { encodeFirestoreFields } from '../functions/_lib/firestore-job.js';
import * as portal from '../functions/api/customer-portal.js';

const manager = {user:'zacb',displayName:'Owner',role:'owner',businessAccess:true};
const NOW = '2026-09-22T12:00:00.000Z';
const ENABLED = {defaultArrivalWindowEnabled:true,defaultArrivalWindowMinutes:60};

function fixture(settings) {
  const rows = new Map([['customers/c1',{id:'c1',name:'Synthetic Customer',phone:'+1 (970) 555-0100',address:'100 Synthetic Street',revision:'c1r'}],['customers/c2',{id:'c2',name:'Synthetic Other',address:'200 Synthetic Street',revision:'c2r'}]]);
  let revision = 0;
  const clone = value => structuredClone(value), commits = [];
  const all = collection => [...rows.entries()].filter(([key]) => key.startsWith(collection + '/')).map(([,value]) => clone(value));
  const roster = [{id:'zacb',name:'Owner',role:'owner'},{id:'crew1',name:'Crew One',role:'crew'},{id:'crew2',name:'Crew Two',role:'crew'}];
  const store = {
    jobs: async () => all('jobs'), resources: async () => all('dispatchResources'), customers: async () => all('customers'), roster: async () => clone(roster),
    read: async (collection,id) => clone(rows.get(`${collection}/${id}`) || null),
    commit: async writes => {
      const seen = new Set();
      for (const write of writes) {
        const key = `${write.collection}/${write.id}`, old = rows.get(key);
        assert.ok(!seen.has(key),'No duplicate writes per document'); seen.add(key);
        if (write.revision ? old?.revision !== write.revision : Boolean(old)) throw Object.assign(new Error('Conflict'),{code:'dispatch_revision_conflict',status:409});
      }
      commits.push(clone(writes));
      for (const write of writes) rows.set(`${write.collection}/${write.id}`,{...rows.get(`${write.collection}/${write.id}`),...clone(write.patch),id:write.id,revision:`r${++revision}`});
    },
    ...(settings ? {settings: async () => clone(settings)} : {}),
  };
  const create = (changes = {}, extra = {}) => ({action:'schedule.create',requestId:randomUUID(),customerId:'c1',kind:'job',changes:{date:'2026-09-23',time:'08:00',endTime:'10:00',assignedCrew:['crew1'],jobInstructions:'Synthetic garage scope',...changes},...extra});
  const edit = (job,changes = {},action = 'schedule.update') => ({action,requestId:randomUUID(),jobId:job.id,expectedRevision:job.revision,changes});
  const mutate = input => mutateDispatch(store,manager,input,NOW);
  const raw = id => rows.get('jobs/'+id);
  return {rows,store,commits,create,edit,mutate,raw};
}

test('labels are Denver wall-clock ranges with a real 12-hour clock',() => {
  assert.equal(formatArrivalWindow('09:00','10:00'),'9:00 AM – 10:00 AM');
  assert.equal(formatArrivalWindow('00:05','12:30'),'12:05 AM – 12:30 PM');
  assert.equal(formatArrivalWindow('13:15','23:59'),'1:15 PM – 11:59 PM');
  assert.equal(arrivalClock('24:00'),'');assert.equal(arrivalClock('9:00'),'');assert.equal(formatArrivalWindow('09:00',null),'');
});

test('default windows use elapsed minutes across DST and never cross into the next day',() => {
  assert.deepEqual(defaultArrivalWindow('2026-09-23','08:00'),{start:'08:00',end:'09:00'});
  assert.deepEqual(defaultArrivalWindow('2026-09-23','08:00',90),{start:'08:00',end:'09:30'});
  assert.deepEqual(defaultArrivalWindow('2026-03-08','01:30',60),{start:'01:30',end:'03:30'},'spring forward skips 02:00-02:59');
  assert.deepEqual(defaultArrivalWindow('2026-11-01','00:30',120),{start:'00:30',end:'01:30'},'fall back repeats 01:00-01:59');
  assert.deepEqual(defaultArrivalWindow('2026-09-23','23:30',60),{start:'23:30',end:'23:59'});
  assert.equal(defaultArrivalWindow('2026-03-08','02:30'),null);assert.equal(defaultArrivalWindow('','08:00'),null);
  assert.equal(arrivalWindowMinutes({}),60);assert.equal(arrivalWindowMinutes({defaultArrivalWindowMinutes:240}),240);
  for (const value of [0,14,481,90.5,'ninety',null]) assert.equal(arrivalWindowMinutes({defaultArrivalWindowMinutes:value}),60);
});

test('explicit windows must be complete, contain the start time and exist once in Denver',() => {
  const job = window => ({date:'2026-09-23',time:'08:00',...window});
  assert.equal(arrivalWindowProblem(job({})),'');
  assert.equal(arrivalWindowProblem(job({arrivalWindowStart:'07:30',arrivalWindowEnd:'09:00'})),'');
  assert.equal(arrivalWindowProblem(job({arrivalWindowStart:'08:00',arrivalWindowEnd:'08:30'})),'');
  assert.equal(arrivalWindowProblem(job({arrivalWindowStart:'07:00',arrivalWindowEnd:'08:00'})),'');
  for (const window of [{arrivalWindowStart:'08:30',arrivalWindowEnd:'09:30'},{arrivalWindowStart:'06:00',arrivalWindowEnd:'07:59'},{arrivalWindowStart:'08:00',arrivalWindowEnd:'08:00'},{arrivalWindowStart:'09:00',arrivalWindowEnd:'07:00'},{arrivalWindowStart:'07:00',arrivalWindowEnd:null},{arrivalWindowEnd:'09:00'},{arrivalWindowStart:'7:00',arrivalWindowEnd:'09:00'},{arrivalWindowStart:'07:00',arrivalWindowEnd:'24:00'},{arrivalWindowStart:7,arrivalWindowEnd:9}]) assert.notEqual(arrivalWindowProblem(job(window)),'',JSON.stringify(window));
  assert.match(arrivalWindowProblem({date:'',time:'',arrivalWindowStart:'07:00',arrivalWindowEnd:'09:00'}),/valid start time/);
  assert.match(arrivalWindowProblem({date:'2026-03-08',time:'03:00',arrivalWindowStart:'02:30',arrivalWindowEnd:'04:00'}),/exactly once/);
  assert.match(arrivalWindowProblem({date:'2026-11-01',time:'00:30',arrivalWindowStart:'00:15',arrivalWindowEnd:'01:30'}),/exactly once/);
});

test('stored fields: explicit window wins, default only when enabled, unscheduled clears',() => {
  const scheduled = {date:'2026-09-23',time:'08:00'};
  assert.deepEqual(arrivalWindowFields({...scheduled,arrivalWindowStart:'07:30',arrivalWindowEnd:'09:00'},{}),{arrivalWindowStart:'07:30',arrivalWindowEnd:'09:00',arrivalWindow:'7:30 AM – 9:00 AM'});
  assert.deepEqual(arrivalWindowFields(scheduled,{}),{arrivalWindowStart:null,arrivalWindowEnd:null,arrivalWindow:null});
  assert.deepEqual(arrivalWindowFields(scheduled,undefined),{arrivalWindowStart:null,arrivalWindowEnd:null,arrivalWindow:null});
  assert.deepEqual(arrivalWindowFields(scheduled,ENABLED),{arrivalWindowStart:null,arrivalWindowEnd:null,arrivalWindow:'8:00 AM – 9:00 AM'});
  assert.deepEqual(arrivalWindowFields(scheduled,{defaultArrivalWindowEnabled:true,defaultArrivalWindowMinutes:120}).arrivalWindow,'8:00 AM – 10:00 AM');
  assert.deepEqual(arrivalWindowFields({date:'',time:'',arrivalWindowStart:'07:30',arrivalWindowEnd:'09:00'},ENABLED),{arrivalWindowStart:null,arrivalWindowEnd:null,arrivalWindow:null});
  const unchanged = arrivalWindowPatch({...scheduled,arrivalWindowStart:'07:30',arrivalWindowEnd:'09:00',arrivalWindow:'7:30 AM – 9:00 AM'},{...scheduled,arrivalWindowStart:'07:30',arrivalWindowEnd:'09:00'},{},{});
  assert.deepEqual(unchanged,{patch:{},reset:false});
});

test('env settings keep derived windows off unless explicitly enabled',() => {
  assert.deepEqual(arrivalSettings({}),{defaultArrivalWindowEnabled:false,defaultArrivalWindowMinutes:60});
  assert.deepEqual(arrivalSettings({EGC_DISPATCH_DEFAULT_ARRIVAL_WINDOW_ENABLED:' TRUE ',EGC_DISPATCH_DEFAULT_ARRIVAL_WINDOW_MINUTES:'90'}),{defaultArrivalWindowEnabled:true,defaultArrivalWindowMinutes:90});
  for (const minutes of ['abc','5','1000','90.5','-60','']) assert.equal(arrivalSettings({EGC_DISPATCH_DEFAULT_ARRIVAL_WINDOW_MINUTES:minutes}).defaultArrivalWindowMinutes,60,minutes);
  for (const enabled of ['1','yes','false','']) assert.equal(arrivalSettings({EGC_DISPATCH_DEFAULT_ARRIVAL_WINDOW_ENABLED:enabled}).defaultArrivalWindowEnabled,false,enabled);
});

test('dispatch saves an explicit window, labels it, projects it and audits it',async () => {
  const f = fixture(), input = f.create({arrivalWindowStart:'07:30',arrivalWindowEnd:'09:00'}), result = await f.mutate(input);
  assert.equal(result.job.arrivalWindowStart,'07:30');assert.equal(result.job.arrivalWindowEnd,'09:00');assert.equal(result.job.arrivalWindow,'7:30 AM – 9:00 AM');
  const saved = f.raw(result.job.id);
  assert.equal(saved.arrivalWindow,'7:30 AM – 9:00 AM');assert.equal(saved.startAt,'2026-09-23T14:00:00.000Z');
  const receipt = f.rows.get('dispatchOperations/'+input.requestId);
  assert.equal(receipt.after.arrivalWindow,'7:30 AM – 9:00 AM');assert.equal(receipt.after.arrivalWindowStart,'07:30');
  assert.equal((await f.mutate(input)).job.arrivalWindow,'7:30 AM – 9:00 AM','replay returns the saved label');
  const lock = f.rows.get('jobs/_egc_schedule_lock_2026-09-23').entries[0];
  assert.equal(lock.start,'08:00','conflict locks still use the reserved job time, not the arrival range');
});

test('dispatch derives the default window only when settings enable it',async () => {
  const off = fixture(), plain = await off.mutate(off.create());
  assert.equal(plain.job.arrivalWindow,'');assert.equal(plain.job.arrivalWindowStart,null);assert.equal(plain.job.arrivalWindowEnd,null);
  assert.ok(!('arrivalWindow' in off.raw(plain.job.id)),'no customer-visible label is written while defaults are off');
  const on = fixture({defaultArrivalWindowEnabled:true,defaultArrivalWindowMinutes:90}), derived = await on.mutate(on.create());
  assert.equal(derived.job.arrivalWindow,'8:00 AM – 9:30 AM');assert.equal(on.raw(derived.job.id).arrivalWindow,'8:00 AM – 9:30 AM');
  assert.equal(on.raw(derived.job.id).arrivalWindowStart,undefined,'derived windows stay implicit so they follow later reschedules');
  const moved = await on.mutate(on.edit(derived.job,{time:'13:00',endTime:'15:00'}));
  assert.equal(moved.job.arrivalWindow,'1:00 PM – 2:30 PM');assert.ok(!moved.warnings.some(warning => warning.code === 'arrival_window_reset'));
});

test('invalid submitted windows fail with a validation code before anything is written',async () => {
  const f = fixture(ENABLED);
  for (const window of [{arrivalWindowStart:'08:30',arrivalWindowEnd:'09:30'},{arrivalWindowStart:'06:00',arrivalWindowEnd:'07:00'},{arrivalWindowStart:'08:00',arrivalWindowEnd:'08:00'},{arrivalWindowStart:'07:00',arrivalWindowEnd:null},{arrivalWindowStart:'07:00'},{arrivalWindowStart:'7:00',arrivalWindowEnd:'09:00'},{arrivalWindowStart:'07:00',arrivalWindowEnd:'24:00'},{arrivalWindowStart:700,arrivalWindowEnd:900},{arrivalWindowStart:['07:00'],arrivalWindowEnd:'09:00'}]) {
    await assert.rejects(f.mutate(f.create(window)),error => error.code === 'dispatch_arrival_window_invalid' && error.status === 400,JSON.stringify(window));
  }
  await assert.rejects(f.mutate(f.create({date:'',time:'',endDate:'',endTime:'',arrivalWindowStart:'07:00',arrivalWindowEnd:'09:00'})),error => error.code === 'dispatch_arrival_window_invalid');
  await assert.rejects(f.mutate(f.create({date:'2026-03-08',time:'03:00',endTime:'05:00',arrivalWindowStart:'02:30',arrivalWindowEnd:'04:00'})),error => error.code === 'dispatch_arrival_window_invalid' && /daylight/.test(error.message));
  assert.equal(f.commits.length,0);
  const blank = await f.mutate(f.create({arrivalWindowStart:'',arrivalWindowEnd:''}));
  assert.equal(blank.job.arrivalWindowStart,null);assert.equal(blank.job.arrivalWindow,'8:00 AM – 9:00 AM');
});

test('reschedules keep a window that still fits and clear a stale one with a warning',async () => {
  const f = fixture(), created = await f.mutate(f.create({arrivalWindowStart:'07:30',arrivalWindowEnd:'09:00'}));
  const inside = await f.mutate(f.edit(created.job,{time:'08:30',endTime:'10:30'}));
  assert.equal(inside.job.arrivalWindow,'7:30 AM – 9:00 AM');assert.ok(!inside.warnings.some(warning => warning.code === 'arrival_window_reset'));
  const nextDay = await f.mutate(f.edit(inside.job,{date:'2026-09-24'}));
  assert.equal(nextDay.job.arrivalWindow,'7:30 AM – 9:00 AM','the same local window moves with the date');
  const outside = await f.mutate(f.edit(nextDay.job,{time:'13:00',endTime:'15:00'}));
  assert.equal(outside.job.arrivalWindowStart,null);assert.equal(outside.job.arrivalWindow,'');assert.equal(f.raw(created.job.id).arrivalWindow,null);
  assert.ok(outside.warnings.some(warning => warning.code === 'arrival_window_reset' && warning.jobId === created.job.id));
  await assert.rejects(f.mutate(f.edit(outside.job,{time:'16:00',endTime:'17:00',arrivalWindowStart:'13:00',arrivalWindowEnd:'14:00'})),error => error.code === 'dispatch_arrival_window_invalid');
  const g = fixture(ENABLED), gCreated = await g.mutate(g.create({arrivalWindowStart:'07:30',arrivalWindowEnd:'09:00'}));
  const reset = await g.mutate(g.edit(gCreated.job,{time:'11:00',endTime:'13:00'}));
  assert.equal(reset.job.arrivalWindow,'11:00 AM – 12:00 PM');assert.ok(reset.warnings.some(warning => warning.code === 'arrival_window_reset'));
});

test('clearing, unscheduling, cancelling and restoring handle windows explicitly; blocks reject them',async () => {
  const f = fixture(), created = await f.mutate(f.create({arrivalWindowStart:'07:30',arrivalWindowEnd:'09:00'}));
  const cleared = await f.mutate(f.edit(created.job,{arrivalWindowStart:null,arrivalWindowEnd:null}));
  assert.equal(cleared.job.arrivalWindowStart,null);assert.equal(cleared.job.arrivalWindow,'');
  const again = await f.mutate(f.edit(cleared.job,{arrivalWindowStart:'08:00',arrivalWindowEnd:'09:30'}));
  const cancelled = await f.mutate(f.edit(again.job,{},'schedule.cancel'));
  assert.equal(f.raw(created.job.id).arrivalWindow,'8:00 AM – 9:30 AM');assert.equal(cancelled.job.arrivalWindow,'8:00 AM – 9:30 AM');
  const restored = await f.mutate(f.edit(cancelled.job,{},'schedule.restore'));
  assert.equal(restored.job.arrivalWindow,'8:00 AM – 9:30 AM');
  const unscheduled = await f.mutate(f.edit(restored.job,{date:'',time:'',endDate:'',endTime:''}));
  assert.equal(unscheduled.job.status,'unscheduled');assert.equal(unscheduled.job.arrivalWindowStart,null);assert.equal(f.raw(created.job.id).arrivalWindow,null);
  assert.ok(!unscheduled.warnings.some(warning => warning.code === 'arrival_window_reset'),'unscheduling is not a surprise reset');
  await assert.rejects(f.mutate({action:'schedule.create',requestId:randomUUID(),kind:'blocked',changes:{date:'2026-09-25',time:'08:00',endTime:'09:00',arrivalWindowStart:'08:00',arrivalWindowEnd:'09:00'}}),error => error.code === 'dispatch_patch_not_allowed');
  const block = await f.mutate({action:'schedule.create',requestId:randomUUID(),kind:'blocked',changes:{date:'2026-09-25',time:'08:00',endTime:'09:00'}});
  assert.ok(!('arrivalWindow' in f.raw(block.job.id)));
});

test('legacy jobs project computed defaults without inventing a customer window',async () => {
  const f = fixture(ENABLED);
  f.rows.set('jobs/legacy',{id:'legacy',type:'job',customerId:'c1',customer:'Synthetic Legacy',address:'100 Synthetic Street',date:'2026-09-23',time:'13:00',endTime:'15:00',status:'scheduled',assignedCrew:['crew2'],jobInstructions:{arrivalWindow:'1:00–3:00',customerGoal:'Synthetic'},revision:'legacy-r1'});
  const overview = await dispatchOverview(f.store,manager,{startDate:'2026-09-23',endDate:'2026-09-24'},new Date(NOW));
  const legacy = overview.jobs.find(job => job.id === 'legacy');
  assert.equal(legacy.arrivalWindowStart,null);assert.equal(legacy.arrivalWindowEnd,null);assert.equal(legacy.arrivalWindow,'');
  const saved = await f.mutate(f.edit(legacy,{crewNeeded:1}));
  assert.equal(saved.job.arrivalWindow,'1:00 PM – 2:00 PM','the next Hub save materializes the enabled default');
});

test('HTTP dispatch maps invalid windows to 400 without saving',async () => {
  const f = fixture(), handlers = dispatchHandlers({session:async () => manager,storage:() => f.store});
  const response = await handlers.post({request:new Request('https://easygaragecleaning.com/api/dispatch',{method:'POST',headers:{Origin:'https://easygaragecleaning.com','Content-Type':'application/json'},body:JSON.stringify(f.create({arrivalWindowStart:'09:00',arrivalWindowEnd:'10:00'}))}),env:{}});
  assert.equal(response.status,400);const body = await response.json();
  assert.equal(body.code,'dispatch_arrival_window_invalid');assert.match(body.error,/include the scheduled start time/);assert.equal(f.commits.length,0);
});

test('production storage reads arrival fields in its mask and settings from env',async () => {
  const calls = [];
  const store = dispatchStorage({EGC_DISPATCH_DEFAULT_ARRIVAL_WINDOW_ENABLED:'true',EGC_DISPATCH_DEFAULT_ARRIVAL_WINDOW_MINUTES:'120'},async (env,url) => {
    calls.push(new URL(url));
    return new Response(JSON.stringify({documents:[{name:'projects/egcw-1ec83/databases/(default)/documents/jobs/one',updateTime:'2026-09-22T12:00:00.000001Z',fields:encodeFirestoreFields({type:'job',arrivalWindowStart:'07:30',arrivalWindowEnd:'09:00',arrivalWindow:'7:30 AM – 9:00 AM'})}]}),{status:200});
  });
  const [job] = await store.jobs(), mask = calls[0].searchParams.getAll('mask.fieldPaths');
  for (const field of ['arrivalWindowStart','arrivalWindowEnd','arrivalWindow']) assert.ok(mask.includes(field),field);
  assert.equal(job.arrivalWindow,'7:30 AM – 9:00 AM');
  assert.deepEqual(await store.settings(),{defaultArrivalWindowEnabled:true,defaultArrivalWindowMinutes:120});
  assert.deepEqual(await dispatchStorage({}).settings(),{defaultArrivalWindowEnabled:false,defaultArrivalWindowMinutes:60});
  assert.deepEqual(await schedulingStorage({EGC_DISPATCH_DEFAULT_ARRIVAL_WINDOW_ENABLED:'true'}).settings(),{defaultArrivalWindowEnabled:true,defaultArrivalWindowMinutes:60});
});

const actor = {id:'verified-grant',kind:'integration',role:'integration',workspace:'egc'};
function bridge(settings) {
  const rows = new Map([['customers/customer-a',{id:'customer-a',name:'Synthetic customer',highlevelContactId:'contact-a',revision:'customer-r1'}]]);let revision = 0;
  const store = {read:async (c,id) => structuredClone(rows.get(`${c}/${id}`) || null),day:async date => [...rows.entries()].filter(([k,v]) => k.startsWith('jobs/') && v.date === date).map(([,v]) => structuredClone(v)),commit:async writes => {
    for (const w of writes) {const prior = rows.get(`${w.collection}/${w.id}`);if (w.revision ? prior?.revision !== w.revision : Boolean(prior)) throw Object.assign(new Error('schedule_revision_conflict'),{status:409});}
    for (const w of writes) rows.set(`${w.collection}/${w.id}`,{...rows.get(`${w.collection}/${w.id}`),...structuredClone(w.patch),id:w.id,revision:`r${++revision}`});return {};
  },...(settings ? {settings:async () => structuredClone(settings)} : {})};
  const input = (extra = {}) => ({requestId:randomUUID(),mode:'create',portalCustomerId:'customer-a',kind:'walkthrough',changes:{date:'2026-09-23',time:'10:00',endTime:'11:00'},...extra});
  return {rows,store,input,mutate:value => mutateScheduledVisit(store,actor,value,NOW)};
}

test('operations bridge rejects arrival inputs and derives the label like dispatch',async () => {
  const off = bridge(), created = await off.mutate(off.input());
  assert.ok(!('arrivalWindow' in off.rows.get('jobs/'+created.visit.portalVisitId)));
  const on = bridge(ENABLED), labeled = await on.mutate(on.input());
  assert.equal(on.rows.get('jobs/'+labeled.visit.portalVisitId).arrivalWindow,'10:00 AM – 11:00 AM');
  const moved = await on.mutate(on.input({mode:'update',portalVisitId:labeled.visit.portalVisitId,expectedRevision:labeled.visit.revision,changes:{time:'14:00',endTime:'15:00'}}));
  assert.equal(on.rows.get('jobs/'+moved.visit.portalVisitId).arrivalWindow,'2:00 PM – 3:00 PM');
  const before = on.rows.size;
  await assert.rejects(on.mutate(on.input({changes:{date:'2026-09-24',time:'10:00',endTime:'11:00',arrivalWindowStart:'09:30',arrivalWindowEnd:'10:30'}})),error => error.message === 'schedule_patch_not_allowed' && error.status === 400);
  await assert.rejects(on.mutate(on.input({mode:'update',portalVisitId:moved.visit.portalVisitId,expectedRevision:moved.visit.revision,changes:{arrivalWindow:'Any time'}})),/schedule_patch_not_allowed/);
  assert.equal(on.rows.size,before);
});

test('operations bridge preserves a saved window that still fits and refuses to move one that would not',async () => {
  const f = bridge();
  f.rows.set('jobs/windowed',{id:'windowed',type:'job',customerId:'customer-a',highlevelContactId:'contact-a',date:'2026-09-23',time:'09:00',endTime:'11:00',status:'scheduled',arrivalWindowStart:'08:30',arrivalWindowEnd:'10:00',arrivalWindow:'8:30 AM – 10:00 AM',revision:'w1'});
  const kept = await f.mutate(f.input({mode:'update',portalVisitId:'windowed',kind:'job',expectedRevision:'w1',changes:{time:'09:30',endTime:'11:30'}}));
  const saved = f.rows.get('jobs/windowed');
  assert.equal(saved.time,'09:30');assert.equal(saved.arrivalWindowStart,'08:30');assert.equal(saved.arrivalWindow,'8:30 AM – 10:00 AM');
  const snapshot = structuredClone([...f.rows.entries()]);
  await assert.rejects(f.mutate(f.input({mode:'update',portalVisitId:'windowed',kind:'job',expectedRevision:kept.visit.revision,changes:{time:'13:00',endTime:'15:00'}})),error => error.message === 'schedule_arrival_window_requires_dispatch' && error.status === 409);
  assert.deepEqual([...f.rows.entries()],snapshot,'a rejected bridge move writes nothing, including day locks');
  const cancelled = await f.mutate(f.input({mode:'cancel',portalVisitId:'windowed',kind:'job',expectedRevision:kept.visit.revision,changes:{}}));
  assert.equal(cancelled.visit.status,'cancelled');assert.equal(f.rows.get('jobs/windowed').arrivalWindow,'8:30 AM – 10:00 AM');
});

test('crew and customer surfaces show the dispatch label, with legacy brief text as fallback',async t => {
  const f = fixture(), created = await f.mutate(f.create({arrivalWindowStart:'07:30',arrivalWindowEnd:'09:00'}));
  const saved = {...f.raw(created.job.id),jobInstructions:{arrivalWindow:'08:00–10:00'}};
  assert.equal(fieldJobProjection(saved).arrivalWindow,'7:30 AM – 9:00 AM');assert.equal(crewJobProjection(saved).arrivalWindow,'7:30 AM – 9:00 AM');
  const env = {HUB_SESSION_SECRET:'synthetic-arrival-hub-secret',CUSTOMER_PORTAL_SECRET:'synthetic-arrival-customer-secret',FIREBASE_API_KEY:'firebase-test-arrival',HUB_AUTH_USERS_JSON:JSON.stringify({ZacB:{passwordHash:'synthetic-hash',role:'owner'}})};
  const jobs = new Map([['job-1',{...saved,id:undefined,revision:undefined,total:400}],['legacy-1',{customer:'Synthetic Legacy',customerId:'c1',address:'100 Synthetic Street',type:'job',date:'2026-09-23',time:'08:00',endTime:'10:00',jobInstructions:{arrivalWindow:'8:00–10:00 window'},total:400}]]);
  t.mock.method(globalThis,'fetch',async (input) => {
    const url = new URL(input);
    if (url.hostname !== 'firestore.googleapis.com') throw new Error(`Unexpected synthetic request: ${url.hostname}`);
    const id = decodeURIComponent(url.pathname.split('/').pop());
    if (!jobs.has(id)) return Response.json({},{status:404});
    const {id:_, revision:__, ...fields} = jobs.get(id);
    return Response.json({name:`projects/egcw-1ec83/databases/(default)/documents/jobs/${id}`,updateTime:'2026-09-22T12:00:00Z',fields:encodeFirestoreFields(fields)});
  });
  const view = async jobId => {
    const cookie = (await createCustomerPortalSessionCookie(env,jobId,{actorId:'',permissions:{view:true,decide:true,pay:true,rebook:true}})).split(';')[0];
    const response = await portal.onRequestGet({env,request:new Request('https://easygaragecleaning.com/api/customer-portal',{headers:{Origin:'https://easygaragecleaning.com',Cookie:cookie}})});
    assert.equal(response.status,200);return (await response.json()).appointment;
  };
  assert.equal((await view('job-1')).arrivalWindow,'7:30 AM – 9:00 AM');
  assert.equal((await view('legacy-1')).arrivalWindow,'8:00–10:00 window');
});

test('a start too late for a non-empty default window derives none instead of a zero-length range',async () => {
  assert.equal(defaultArrivalWindow('2026-09-23','23:59'),null);
  assert.deepEqual(defaultArrivalWindow('2026-09-23','23:58'),{start:'23:58',end:'23:59'});
  assert.deepEqual(arrivalWindowFields({date:'2026-09-23',time:'23:59'},ENABLED),{arrivalWindowStart:null,arrivalWindowEnd:null,arrivalWindow:null});
  const f = fixture(ENABLED), late = await f.mutate(f.create({time:'23:59',endDate:'2026-09-24',endTime:'01:00'}));
  assert.equal(late.job.arrivalWindow,'');assert.ok(!('arrivalWindow' in f.raw(late.job.id)),'no 11:59 PM – 11:59 PM label is saved');
  const moved = await f.mutate(f.edit(late.job,{time:'22:00',endDate:'2026-09-23',endTime:'23:30'}));
  assert.equal(moved.job.arrivalWindow,'10:00 PM – 11:00 PM');
  const back = await f.mutate(f.edit(moved.job,{time:'23:59',endDate:'2026-09-24',endTime:'01:00'}));
  assert.equal(back.job.arrivalWindow,'');assert.equal(f.raw(late.job.id).arrivalWindow,null,'a stale derived label is cleared, not kept');
});

test('dispatch GET payloads say whether blank windows get a default, without exposing other settings',async () => {
  assert.deepEqual(arrivalDefaults(undefined),{enabled:false,minutes:60});
  assert.deepEqual(arrivalDefaults({defaultArrivalWindowEnabled:'true',defaultArrivalWindowMinutes:5}),{enabled:false,minutes:60});
  const range = {startDate:'2026-09-23',endDate:'2026-09-24'};
  const legacy = fixture(), legacyView = await dispatchOverview(legacy.store,manager,range,new Date(NOW));
  assert.deepEqual(legacyView.arrivalDefaults,{enabled:false,minutes:60},'stores without settings report the default as off');
  const on = fixture({defaultArrivalWindowEnabled:true,defaultArrivalWindowMinutes:90,secretToken:'synthetic-never-exposed'});
  const created = await on.mutate(on.create());
  const overview = await dispatchOverview(on.store,manager,range,new Date(NOW)), single = await dispatchOverview(on.store,manager,{view:'job',jobId:created.job.id},new Date(NOW));
  for (const view of [overview,single]) {assert.deepEqual(view.arrivalDefaults,{enabled:true,minutes:90});assert.doesNotMatch(JSON.stringify(view),/synthetic-never-exposed/);}
});

function bookingAdapter(f) {
  const storage = {}, sessionStorage = {getItem:key => storage[key] ?? null,setItem:(key,value) => {storage[key] = String(value);},removeItem:key => {delete storage[key];}};
  sessionStorage.setItem('egc_u','zacb');
  const reply = (body,status = 200) => new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});
  const fetch = async (path,options = {}) => {
    const url = new URL('https://easygaragecleaning.com'+path);
    try {
      if (options.method === 'POST') return reply(await mutateDispatch(f.store,manager,JSON.parse(options.body),NOW));
      return reply(await dispatchOverview(f.store,manager,Object.fromEntries(url.searchParams),new Date(NOW)));
    } catch (error) { return reply({ok:false,code:error.code,error:error.message},error.status || 503); }
  };
  const context = {URLSearchParams,Date,Intl,Promise,Set,Map,Error,JSON,crypto,AbortSignal,sessionStorage,fetch,addEventListener:() => {}};
  context.window = context;vm.runInNewContext(readFileSync(new URL('../employee-booking.js',import.meta.url),'utf8'),context);
  return context.EGCBooking;
}

test('legacy booking saves carry the arrival reset warning for the Hub toast without caching it',async () => {
  const f = fixture(), created = await f.mutate(f.create({arrivalWindowStart:'07:30',arrivalWindowEnd:'09:00'})), booking = bookingAdapter(f);
  const kept = await booking.save({...created.job,time:'08:30',endTime:'10:30'},created.job);
  assert.equal(kept.arrivalNotice,'');assert.equal(f.raw(created.job.id).arrivalWindow,'7:30 AM – 9:00 AM','a legacy edit inside the window keeps it');
  const moved = await booking.save({...kept,time:'13:00',endTime:'15:00'},kept);
  assert.match(moved.arrivalNotice,/arrival window did not include the new start time and was cleared/);
  assert.equal(f.raw(created.job.id).arrivalWindow,null);
  assert.ok(!Object.keys(moved).includes('arrivalNotice'));assert.ok(!('arrivalNotice' in {...moved}));assert.doesNotMatch(JSON.stringify(moved),/arrivalNotice/);
  const again = await f.mutate(f.edit(moved,{arrivalWindowStart:'12:30',arrivalWindowEnd:'14:00'}));
  const series = await booking.saveSeries({...again.job,time:'16:00',endTime:'17:00',recurrence:'none'},again.job);
  assert.match(series.job.arrivalNotice,/was cleared/,'the older series booking form gets the same notice');
  const suite = readFileSync(new URL('../employee-suite.js',import.meta.url),'utf8'), hub = readFileSync(new URL('../employee.html',import.meta.url),'utf8');
  assert.match(suite,/'Saved in Hub dispatch\.'\)\+\(saved\.arrivalNotice\?' '\+saved\.arrivalNotice:''\)\)/,'opsSaveBooking appends the notice to its toast');
  assert.match(hub,/\+\(result\.job\?\.arrivalNotice\?' '\+result\.job\.arrivalNotice:''\);/,'confirmBooking appends the notice to its toast');
});

test('walkthrough handoff client surfaces the arrival reset warning in its save result',async () => {
  const source = readFileSync(new URL('../crew/gameplan-handoff.js',import.meta.url),'utf8'), context = vm.createContext({window:{},URLSearchParams,AbortController,setTimeout,clearTimeout});
  vm.runInContext(source,context);
  const message = 'The saved arrival window did not include the new start time and was cleared. Review the arrival window the customer sees.';
  const run = async warnings => {
    const records = new Map(), reply = data => ({ok:true,status:200,json:async () => structuredClone(data)});
    const client = context.window.EGCWalkthroughHandoffClient({actor:async () => 'zacb',storage:{getItem:k => records.get(k) || null,setItem:(k,v) => records.set(k,v),removeItem:k => records.delete(k)},uuid:() => randomUUID(),
      plan:() => ({client:{name:'Synthetic',phone:'9705550100',email:'x@example.invalid',address:'Fixture'},quote:{total:1000,deposit:500,job_date:'2026-09-24',start_time:'13:00',end_time:'15:00'},acceptance:{accepted_at:NOW}}),
      source:() => 'walk-1',savedJobId:() => 'job-1',photoDraftId:() => 'photos-1',accept:() => {},
      fetch:async (url,options = {}) => url.startsWith('/api/walkthrough-handoff?') ? reply({ok:true,viewer:{id:'zacb'},customerId:'customer-1',jobId:'job-1',expectedRevision:'r1',sourceRevision:'s1'}) : reply({ok:true,requestId:JSON.parse(options.body).requestId,job:{id:'job-1',customerId:'customer-1',revision:'r2'},warnings})});
    return client.save();
  };
  assert.equal((await run([{code:'arrival_window_reset',jobId:'job-1',message},{code:'crew_size_short',message:'Synthetic staffing warning'}])).arrivalNotice,message);
  assert.equal((await run([])).arrivalNotice,'');
  assert.match(source,/staffing\+arrival\+/,'the success status line includes the notice');
});

test('crew pre-job and post-job briefs prefer the dispatch arrival label like crew/job.js and the portal',() => {
  for (const page of ['../crew/prejob.html','../crew/postjob.html']) {
    const line = readFileSync(new URL(page,import.meta.url),'utf8').split(/\r?\n/).find(row => row.startsWith('function normalizedInstructions('));
    const context = vm.createContext({});vm.runInContext(line,context);
    const window = job => vm.runInContext('normalizedInstructions',context)(job).arrivalWindow;
    assert.equal(window({time:'08:00',endTime:'10:00',arrivalWindow:'7:30 AM – 9:00 AM',jobInstructions:{arrivalWindow:'08:00–10:00 brief'}}),'7:30 AM – 9:00 AM',page);
    assert.equal(window({time:'08:00',endTime:'10:00',arrivalWindow:null,jobInstructions:{arrivalWindow:'08:00–10:00 brief'}}),'08:00–10:00 brief',page);
    assert.equal(window({time:'08:00',endTime:'10:00'}),'08:00–10:00',page);
  }
});
