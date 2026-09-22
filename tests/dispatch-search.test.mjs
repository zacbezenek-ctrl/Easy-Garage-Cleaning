import test from 'node:test';
import assert from 'node:assert/strict';
import {dispatchSearch} from '../functions/_lib/dispatch-search.js';
import {dispatchSearchHandlers} from '../functions/api/dispatch-search.js';

const manager={user:'ZacB',role:'owner',businessAccess:true};
function fixture(){
 const data={jobs:[{id:'old-job',revision:'r1',type:'job',customerId:'c1',customer:'Former display name',phone:'9705550100',address:'123 Oak Street, Fort Collins',date:'2025-01-02',time:'08:00',endTime:'10:00',status:'paid',assignedCrew:['crew.one'],payment:{secret:'financial-canary'},giftWallet:{balance:99999}},
  {id:'new-job',revision:'r2',type:'job',customerId:'c1',customer:'Johnson Garage',address:'25 Pine Street, Loveland',date:'2026-10-21',time:'11:00',endTime:'13:00',status:'scheduled',assignedCrew:['crew.two']},
  {id:'cancelled-job',revision:'r3',type:'walkthrough',customerId:'c2',customer:'Johnson Garage',date:'2024-04-03',time:'09:00',endTime:'10:00',status:'cancelled',assignedTo:'crew.one'},
  {id:'backlog',revision:'r4',type:'job',customerId:'c1',customer:'Johnson Garage',date:'',time:'',endTime:'',status:'unscheduled',assignedCrew:[],assignedTo:'Crew One'}],
  customers:[{id:'c1',name:'José Johnson',phone:'(970) 555-0199',email:'jose@example.invalid'},{id:'c2',name:'Johnson Garage',phone:'9705550111'}],roster:[{id:'crew.one',name:'Crew One',role:'crew'},{id:'crew.two',name:'Crew Two',role:'crew'}]};
 const store={jobs:async()=>data.jobs,customers:async()=>data.customers,roster:async()=>data.roster};
 return {data,store,search:(q,status='all')=>dispatchSearch(store,manager,{q,status},new Date('2026-09-22T14:00:00Z'))};
}
test('history search spans years and uses exact canonical customer linkage after a renamed display name',async()=>{
 const f=fixture(),result=await f.search('jose');assert.deepEqual(new Set(result.results.map(row=>row.job.id)),new Set(['old-job','new-job','backlog']));assert.equal(result.coverage.complete,true);assert.equal(result.results.find(row=>row.job.id==='old-job').canonicalCustomerName,'José Johnson');
 assert.equal((await f.search('jose@example.invalid')).total,3);assert.equal((await f.search('Johnson')).total,4);
});
test('phone punctuation, job ID and exact property address locate relevant jobs',async()=>{
 const f=fixture();assert.equal((await f.search('+1 (970) 555-0100')).results[0].job.id,'old-job'); // formatting normalization is search-only, never an identity merge
 assert.equal((await f.search('970-555-0100')).results[0].job.id,'old-job');assert.equal((await f.search('(970) 555-0199')).total,3);
 assert.equal((await f.search('123 oak')).results[0].job.id,'old-job');assert.equal((await f.search('old-job')).results[0].job.id,'old-job');
});
test('employee display names resolve canonical and legacy assignments but never stale empty assignment copies',async()=>{
 const f=fixture(),result=await f.search('Crew One');assert.deepEqual(new Set(result.results.map(row=>row.job.id)),new Set(['old-job','cancelled-job']));assert.equal((await f.search('crew.two')).total,1);
});
test('Mountain calendar dates support ISO and US notation without browser timezone parsing',async()=>{
 const f=fixture();assert.equal((await f.search('1/2/2025')).results[0].job.id,'old-job');assert.equal((await f.search('2025-01-02')).total,1);assert.equal((await f.search('2/30/2025')).total,0);
});
test('status filters include actual historical lifecycle aliases and unscheduled backlog',async()=>{
 const f=fixture();assert.equal((await f.search('Johnson','completed')).results[0].job.id,'old-job');assert.equal((await f.search('Johnson','cancelled')).total,1);assert.equal((await f.search('Johnson','active')).total,2);assert.equal((await f.search('Johnson','unscheduled')).results[0].job.id,'backlog');
});
test('result limit is explicit and includes an exact total instead of silently omitting matches',async()=>{
 const f=fixture();f.data.jobs=Array.from({length:70},(_,i)=>({...f.data.jobs[0],id:'match-'+i,customer:'Common Customer',customerId:null}));const result=await f.search('Common');assert.equal(result.total,70);assert.equal(result.truncated,true);assert.equal(result.results.length,50);
});
test('private pseudo-records and financial payloads never enter search results',async()=>{
 const f=fixture();f.data.jobs.push({...f.data.jobs[0],id:'secure_private'},{...f.data.jobs[0],id:'_egc_guard'},{...f.data.jobs[0],id:'timeoff',recordType:'crew_availability'});const result=await f.search('jose');assert.equal(result.total,3);assert.ok(!JSON.stringify(result).includes('financial-canary'));assert.ok(!JSON.stringify(result).includes('99999'));
});
test('unauthorized users never read search storage and malformed filters fail explicitly',async()=>{
 const store=new Proxy({},{get(){throw new Error('Storage must not be touched');}});
 for(const actor of [null,{user:'Crew.One',role:'crew'},{user:'Someone',role:'manager',businessAccess:false}])await assert.rejects(dispatchSearch(store,actor,{q:'anything'}),e=>[401,403].includes(e.status));
 const f=fixture();for(const query of [{q:'x'},{q:'x'.repeat(201)},{q:'job',status:'invented'},{q:'job',extra:'field'}])await assert.rejects(dispatchSearch(f.store,manager,query),e=>e.code==='dispatch_search_invalid');
});
test('API protects search and never turns an incomplete upstream result into a successful empty search',async()=>{
 const f=fixture(),request=query=>new Request('https://easygaragecleaning.com/api/dispatch-search?'+query);
 let touched=0;const denied=dispatchSearchHandlers({session:async()=>({user:'Crew.One',role:'crew'}),storage:()=>{touched++;return f.store;}});assert.equal((await denied.get({request:request('q=job'),env:{}})).status,403);assert.equal(touched,0);
 const handlers=dispatchSearchHandlers({session:async()=>manager,storage:()=>f.store});assert.equal((await handlers.get({request:request('q=job&q=other'),env:{}})).status,400);
 f.store.jobs=async()=>{throw new Error('secret-canary upstream');};const failed=await handlers.get({request:request('q=job'),env:{}});assert.equal(failed.status,503);assert.ok(!(await failed.text()).includes('secret-canary'));assert.equal(failed.headers.get('Cache-Control'),'no-store');
});
