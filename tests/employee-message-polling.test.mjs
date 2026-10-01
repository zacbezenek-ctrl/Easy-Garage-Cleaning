import test from 'node:test';
import assert from 'node:assert/strict';
import { vaultFirestore, staffEnv, cookieFor, ROOT } from './helpers/vault-fixture.mjs';
import { writeOne } from '../functions/_lib/employee-vault.js';
import { encodeFirestoreFields } from '../functions/_lib/firestore-job.js';
import { onRequestGet } from '../functions/api/employee-hub.js';

const NOW='2026-09-22T18:00:00.000Z';
const get=(env,cookie)=>onRequestGet({env,request:new Request('https://easygaragecleaning.com/api/employee-hub?view=messages',{headers:cookie?{Cookie:cookie}:{}})});
async function fixture(t){
 const store=vaultFirestore(t),env=staffEnv();
 for(const [collection,id,data]of [
  ['teamMessages','team',{sender:'ZacB',body:'Team message'}],
  ['jobMessages','own-job',{jobId:'assigned',sender:'ZacB',body:'Assigned job message'}],
  ['jobMessages','other-job',{jobId:'other',sender:'ZacB',body:'Private other job message'}],
  ['messageReads','own-read',{employee:'Crew.Static',channel:'team'}],
  ['messageReads','other-read',{employee:'ZacB',channel:'team'}],
  ['profiles','owner',{username:'ZacB',hourlyRate:200}],
  ['timeEntries','shift',{employee:'ZacB',status:'active'}],
 ])await writeOne(env,collection,id,data,null,NOW);
 for(const [id,crew]of [['assigned',['Crew.Static']],['other',['Other.Crew']]])store.documents.set('jobs/'+id,{name:ROOT+'/jobs/'+id,fields:encodeFirestoreFields({type:'job',assignedCrew:crew}),updateTime:NOW});
 store.requests.length=0;return{store,env};
}

test('messages-only reads exactly the three message families and preserves current job and read-marker authorization',async t=>{
 const {store,env}=await fixture(t),cookie=await cookieFor(env,'Crew.Static');store.requests.length=0;
 const response=await get(env,cookie);assert.equal(response.status,200);const body=await response.json();
 assert.deepEqual(Object.keys(body.collections).sort(),['jobMessages','messageReads','teamMessages']);
 assert.deepEqual(body.collections.teamMessages.map(row=>row.id),['team']);assert.deepEqual(body.collections.jobMessages.map(row=>row.id),['own-job']);assert.deepEqual(body.collections.messageReads.map(row=>row.id),['own-read']);
 assert.equal(body.accounts,undefined);assert.equal(body.payVisibility,undefined);
 const queries=store.requests.filter(request=>request.url.pathname.endsWith(':runQuery'));
 const families=queries.map(query=>query.body.structuredQuery.where?.compositeFilter?.filters.find(filter=>filter.fieldFilter?.field.fieldPath==='employeeHubType')?.fieldFilter.value.stringValue);
 assert.deepEqual(families.sort(),['jobMessages','messageReads','teamMessages']);assert.equal(store.writes().length,0);
 // Losing the current assignment immediately removes the room on the next message poll.
 store.documents.get('jobs/assigned').fields=encodeFirestoreFields({type:'job',assignedCrew:['Other.Crew']});
 assert.deepEqual((await (await get(env,cookie)).json()).collections.jobMessages,[]);
});

test('the owner keeps the full-view message visibility without rereading payroll or accounts',async t=>{
 const {store,env}=await fixture(t),cookie=await cookieFor(env,'ZacB');store.requests.length=0;
 const response=await get(env,cookie),body=await response.json();assert.equal(response.status,200);
 assert.equal(body.collections.jobMessages.length,2);assert.equal(body.collections.messageReads.length,2);assert.equal(body.collections.profiles,undefined);
 assert.equal(store.requests.filter(request=>request.url.pathname.endsWith(':runQuery')).length,3);
 assert.equal(store.writes().length,0);
});

test('messages-only reads require sign-in and fail closed when any requested vault family fails',async t=>{
 const {store,env}=await fixture(t);assert.equal((await get(env)).status,401);
 const cookie=await cookieFor(env,'Crew.Static'),fetch=globalThis.fetch;
 t.mock.method(globalThis,'fetch',async(input,options)=>String(input).includes(':runQuery')?Response.json({error:{status:'UNAVAILABLE'}},{status:503}):fetch(input,options));
 const response=await get(env,cookie),body=await response.json();assert.equal(response.status,502);assert.equal(body.ok,false);assert.equal(body.collections,undefined);assert.equal(store.writes().length,0);
});

for(const mode of ['legacy','missing-index'])test(`message family reads share one full-vault fallback in ${mode} mode`,async t=>{
 const {store,env}=await fixture(t),cookie=await cookieFor(env,'Crew.Static');
 if(mode==='legacy')env.EGC_EMPLOYEE_VAULT_QUERY='legacy';
 let familyAttempts=0;
 if(mode==='missing-index'){
   const fetch=globalThis.fetch;
   t.mock.method(globalThis,'fetch',async(input,options)=>{
     if(String(input).includes(':runQuery')&&JSON.parse(options.body).structuredQuery.where?.compositeFilter){familyAttempts++;return Response.json({error:{status:'FAILED_PRECONDITION'}},{status:400});}
     return fetch(input,options);
   });
 }
 store.requests.length=0;
 const response=await get(env,cookie),body=await response.json();assert.equal(response.status,200);
 assert.deepEqual(body.collections.jobMessages.map(row=>row.id),['own-job']);assert.equal(body.collections.profiles,undefined);
 assert.equal(store.requests.filter(request=>request.url.pathname.endsWith(':runQuery')).length,1,'all families reuse the same fallback result');
 assert.equal(familyAttempts,mode==='missing-index'?3:0);
});
