import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
const source=readFileSync(new URL('../crew/gameplan-handoff.js',import.meta.url),'utf8');
const context=vm.createContext({window:{},URLSearchParams,AbortController,setTimeout,clearTimeout});vm.runInContext(source,context);
const factory=context.window.EGCWalkthroughHandoffClient;
const reply=(data,status=200)=>({ok:status>=200&&status<300,status,json:async()=>structuredClone(data)});
function fixture(){
 let actor='zacb',counter=0,lost=false,failedSync=false;
 const records=new Map(),calls=[],accepted=[];
 const storage={getItem:k=>records.get(k)||null,setItem:(k,v)=>records.set(k,v),removeItem:k=>records.delete(k)};
 const p={client:{name:'Synthetic',phone:'9705550100',email:'x@example.invalid',address:'Fixture',highlevel_contact_id:'contact-1'},quote:{total:1000,deposit:500,job_date:'2026-09-24',start_time:'09:00',end_time:'11:00',estimated_duration_min:120},acceptance:{accepted_at:'2026-09-22T12:00:00Z'},signature:'synthetic-isolated-only',terms_version:'v1',terms_accepted:true,photos:{before:3}};
 const deps={actor:async()=>actor,storage,uuid:()=>randomUUID(),plan:()=>structuredClone(p),source:()=> 'walk-1',savedJobId:()=>'',photoDraftId:()=> 'local-photos-1',accept:(r,pending)=>accepted.push({r,pending}),fetch:async(url,options={})=>{
  const body=options.body?JSON.parse(options.body):null;calls.push({url,body});
  if(url.startsWith('/api/walkthrough-handoff?'))return reply({ok:true,viewer:{id:actor},sourceRevision:'s1',customerId:'customer-1',jobId:'',roster:[]});
  if(url==='/api/walkthrough-handoff'){counter++;if(lost&&counter===1)throw new Error('Response lost after commit');return reply({ok:true,requestId:body.requestId,job:{id:'visit-canonical',customerId:'customer-1',revision:'r1'},warnings:[]});}
  if(url==='/api/highlevel'){if(failedSync)throw new Error('CRM outage');return reply({ok:true,handoffSync:{status:'synced'}});}
  throw new Error('Unexpected route '+url);
 }};
 return{deps,calls,p,records,accepted,client:factory(deps),lose:()=>lost=true,crmFail:v=>failedSync=v,actor:v=>actor=v};
}
test('canonical signed job save precedes CRM sync and never sends browser prices to CRM',async()=>{
 const f=fixture(),saved=await f.client.save();assert.deepEqual(f.calls.map(x=>x.url),['/api/walkthrough-handoff?sourceWalkthroughId=walk-1','/api/walkthrough-handoff']);
 await f.client.sync(saved);assert.deepEqual(f.calls.at(-1).body,{tool:'game_plan',job_id:'visit-canonical',handoff_request_id:saved.pending.requestId});assert.equal(f.accepted[0].pending.photoDraftJobId,'local-photos-1');assert.equal(f.calls[1].body.actorId,'zacb');
});
test('commit response loss survives reload with byte-equivalent original request and no second preparation',async()=>{
 const f=fixture();f.lose();await assert.rejects(f.client.save(),/Response lost/);const first=f.calls.at(-1).body;
 const reloaded=factory(f.deps),saved=await reloaded.save();assert.deepEqual(f.calls.at(-1).body,first);assert.equal(saved.result.job.id,'visit-canonical');assert.equal(f.calls.filter(x=>x.url.includes('?')).length,1);
});
test('CRM outage does not discard a saved job or generate another save identity',async()=>{
 const f=fixture(),saved=await f.client.save();f.crmFail(true);await assert.rejects(f.client.sync(saved),/CRM outage/);f.crmFail(false);
 const again=await f.client.save();await f.client.sync(again);assert.equal(saved.pending.requestId,again.pending.requestId);assert.equal(f.calls.filter(x=>x.url.includes('?')).length,1);
});
test('changed signed content cannot overwrite an unresolved request; original recovery is explicit',async()=>{
 const f=fixture();f.lose();await assert.rejects(f.client.save());f.p.quote.total=2000;await assert.rejects(f.client.save(),e=>e.code==='handoff_original_request_required');
 const r=await f.client.save(true);assert.equal(r.pending.body.plan.quote.total,1000);assert.equal(f.calls.at(-1).body.plan.quote.total,1000);
});
test('simultaneous clicks share one in-flight save and cannot race duplicate preparation',async()=>{
 const f=fixture(),a=f.client.save(),b=f.client.save();assert.equal(a,b);await a;assert.equal(f.calls.filter(x=>x.url==='/api/walkthrough-handoff').length,1);
});
test('account switch during preparation is stopped before the signed mutation',async()=>{
 const f=fixture(),fetch=f.deps.fetch;f.deps.fetch=async(...args)=>{const response=await fetch(...args);f.actor('other-owner');return response;};
 await assert.rejects(factory(f.deps).save(),/account changed/);assert.equal(f.calls.filter(x=>x.url==='/api/walkthrough-handoff').length,0);
});
test('blocked browser request storage prevents server mutation rather than risking duplicate writes',async()=>{
 const f=fixture();f.deps.storage.setItem=()=>{throw new Error('storage blocked');};await assert.rejects(factory(f.deps).save(),/storage blocked/);assert.equal(f.calls.length,0);
});
test('a saved success is reverified and customer/response mismatch fails closed',async()=>{
 const f=fixture();await f.client.save();const fetch=f.deps.fetch;f.deps.fetch=async(url,options)=>url==='/api/walkthrough-handoff'?reply({ok:true,requestId:JSON.parse(options.body).requestId,job:{id:'wrong',customerId:'other-customer'}}):fetch(url,options);
 await assert.rejects(factory(f.deps).save(),/identity did not match/);
});
test('explicit signed revision releases only the already verified request',async()=>{
 const f=fixture(),saved=await f.client.save();f.client.release(saved);assert.equal(f.records.size,0);
});
test('new handoff HTML contains no direct browser save fallback and preserves original photo queue keys',()=>{
 const html=readFileSync(new URL('../crew/gameplan.html',import.meta.url),'utf8');
 assert.match(html,/gameplan-handoff\.js/);assert.match(html,/async function saveHubJob\(\)\{return window\.EGCWalkthroughHandoff\.save\(\)\}/);assert.match(html,/photoDraftJobId\|\|S\.jobId/);
 const writer=html.slice(html.indexOf('async function saveHubJob('),html.indexOf('function writeActive('));assert.doesNotMatch(writer,/\.set\(|runTransaction|highLevelScheduleConflict/);
 assert.doesNotMatch(html,/startAt=new Date\(`\$\{S\.jobDate\}T\$\{S\.startTime\}`\)/);
});
