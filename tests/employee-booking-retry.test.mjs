import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

function fixture(){
  const rows=new Map(),calls=[],writes=[],status={textContent:''},button={disabled:false,textContent:''},storage={getItem:()=>null};
  const env={rows,calls,writes,status,button,ambiguous:false,readUnavailable:false,readFailure:false,providerFailure:false};
  const snapshot=id=>({exists:rows.has(id),data:()=>rows.get(id)});
  const context={crypto,structuredClone,console:{log(){},error(){}},URLSearchParams,Date,Intl,Promise,Set,Map,Error,JSON,sessionStorage:storage,localStorage:storage,navigator:{},location:{pathname:'/employee',search:''},setInterval:()=>1,clearInterval(){},setTimeout:()=>1,clearTimeout(){},addEventListener(){},jobsCache:[],document:{readyState:'loading',hidden:false,querySelector:s=>s==='#ops-booking-status'?status:null,querySelectorAll:()=>[],addEventListener(){}},FormData:class{constructor(form){this.fields=form.fields}forEach(cb){for(const[k,v]of Object.entries(this.fields))cb(v,k)}has(k){return k in this.fields}}};
  context.window=context;
  context.db={collection:name=>({doc:id=>({key:`${name}/${id}`,set:async value=>{rows.set(`${name}/${id}`,{...rows.get(`${name}/${id}`),...value})},get:async()=>{calls.push('server-read:'+id);if(env.readUnavailable)throw new Error('offline');return snapshot(`${name}/${id}`)}})}),runTransaction:async action=>{
    const pending=[];const result=await action({get:async ref=>{calls.push('transaction-read:'+ref.key);if(env.readFailure)throw new Error('hub_read_unavailable');return snapshot(ref.key)},set(ref,value){pending.push([ref.key,value])}});
    for(const[key,value]of pending){rows.set(key,{...rows.get(key),...value});writes.push({key,value});}
    if(env.ambiguous){env.ambiguous=false;throw new Error('response_lost_after_commit')}
    return result;
  }};
  context.hubFetch=async url=>{calls.push(url);return{ok:!env.providerFailure,json:async()=>env.providerFailure?{error:'unavailable'}:{events:env.events||[]}}};
  const source=readFileSync(new URL('../employee-suite.js',import.meta.url),'utf8').replace(/\}\)\(\);\s*$/,'globalThis.ui={S,hubLocalInstant,remoteCollision,saveScheduledJob,syncPayload};})();');
  vm.runInNewContext(source,context);env.context=context;env.ui=context.ui;
  env.submit=fields=>context.opsSaveBooking({preventDefault(){},currentTarget:{fields,querySelector:()=>button}});
  return env;
}
const job=(extra={})=>({id:'hub-synthetic',type:'walkthrough',date:'2026-09-22',time:'14:15',endTime:'15:00',status:'scheduled',customer:'Synthetic',syncIdempotencyKey:'schedule:synthetic:stable',...extra});

test('Hub wall times use Mountain offset and never the browser time zone',()=>{const e=fixture();assert.equal(e.ui.hubLocalInstant('2026-09-22','14:15'),'2026-09-22T20:15:00.000Z');assert.equal(e.ui.hubLocalInstant('2026-12-22','14:15'),'2026-12-22T21:15:00.000Z');const payload=e.ui.syncPayload(job());assert.equal(payload.start_time,'2026-09-22T20:15:00.000Z');});
test('ambiguous or nonexistent daylight-saving times are blocked before sync',()=>{const e=fixture();assert.equal(e.ui.hubLocalInstant('2026-11-01','01:30'),null);assert.equal(e.ui.hubLocalInstant('2026-03-08','02:30'),null);assert.throws(()=>e.ui.syncPayload(job({date:'2026-11-01',time:'01:30'})),/unambiguous Mountain/);});
test('remote collision compares actual instants across UTC dates and ignores cancelled duplicates',async()=>{const e=fixture();e.events=[{id:'cancelled',status:'cancelled',startTime:'2026-09-23T04:30:00Z',endTime:'2026-09-23T05:00:00Z'},{id:'active',status:'confirmed',startTime:'2026-09-23T04:30:00Z',endTime:'2026-09-23T05:00:00Z'}];const hit=await e.ui.remoteCollision(job({time:'22:15',endTime:'23:15'}));assert.equal(hit.id,'active');assert.ok(e.calls[0].includes('start=2026-09-22T06%3A00%3A00.000Z'));});
test('unavailable provider schedule stays explicitly pending instead of a false empty calendar',async()=>{const e=fixture();e.providerFailure=true;const result=await e.ui.remoteCollision(job());assert.equal(result.providerPending,true);assert.equal(result.reason,'provider_schedule_unavailable');});
test('legacy form saves through the canonical adapter and uses its returned ID',async()=>{
  const e=fixture(),calls=[];e.context.EGCBooking={save:async(job,previous,options)=>{calls.push({job,previous,options});return {...job,id:'canonical-server-id',revision:'r1',status:'scheduled',syncStatus:'pending'}},pending:()=>null};
  e.ui.S.booking={type:'walkthrough',customer:'Synthetic',phone:'9705550100',date:'2026-09-22',time:'14:15',endTime:'15:00'};await e.submit({});
  assert.equal(calls.length,1);assert.equal(e.writes.length,0);assert.equal(e.context.jobsCache[0].id,'canonical-server-id');assert.equal(e.ui.S.booking,null);
});
test('legacy form keeps original fields and operation key after an uncertain response',async()=>{
  const e=fixture(),calls=[];let pending=true;e.context.EGCBooking={save:async(job)=>{calls.push({...job});if(pending)throw Object.assign(new Error('Retry original save'),{status:503});return {...job,id:'saved-block',revision:'r1',syncStatus:'not_needed'}},pending:()=>pending?{request:{}}:null};
  e.ui.S.booking={type:'blocked',customer:'Time blocked',date:'2026-09-22',time:'14:15',endTime:'15:00'};await e.submit({});assert.equal(e.ui.S.booking.uncertain,true);const id=e.ui.S.booking.pendingId;assert.ok(id);
  e.context.opsCloseBooking();assert.equal(e.ui.S.booking.pendingId,id);pending=false;await e.submit({});assert.equal(e.ui.S.booking,null);assert.deepEqual(calls[0],calls[1]);assert.equal(e.context.jobsCache[0].id,'saved-block');
});
test('legacy edit retains its observed record rather than refreshing the base from a newer cache',async()=>{
  const e=fixture(),old=job({updatedAt:'old'});e.context.jobsCache=[job({updatedAt:'new'})];let observed;e.context.EGCBooking={save:async(_,previous)=>{observed=previous;throw new Error('This job changed');},pending:()=>null};
  e.ui.S.booking={...old,original:old};await e.submit({});assert.equal(observed.updatedAt,'old');assert.equal(e.ui.S.booking.original.updatedAt,'old');assert.match(e.status.textContent,/changed/);assert.equal(e.writes.length,0);
});
