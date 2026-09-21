/** Real canonical actions, source time and concurrency; isolated loopback DB only. */
import test,{beforeEach,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {eq,sql} from 'drizzle-orm';
import {getDb,schema} from '@egc/database';
import {OperationsService} from '@egc/operations';
import {InboundActionReconciler} from '../dist/inbound-actions.js';
const url=new URL(process.env.DATABASE_URL||'http://invalid');
if(process.env.EGC_OPERATIONS_TEST!=='isolated'||!['localhost','127.0.0.1'].includes(url.hostname)||url.pathname!=='/egc_operations_test'||!['postgres:','postgresql:'].includes(url.protocol))throw new Error('Only isolated loopback egc_operations_test is allowed');
const originalFetch=globalThis.fetch;globalThis.fetch=async()=>{throw new Error('External HTTP forbidden in inbound tests');};
const db=getDb(),owner={id:'actual-hub-owner',role:'owner',kind:'human',workspace:'egc'};
const basePolicy=()=>({authority:'employee_hub',inboundResponse:{enabled:true,ownerId:owner.id,dueMinutes:60,ownerSource:'sole_authoritative_owner',dueSource:'default_60_minute_response_rule',blockedReason:null}});
let now,service,reconciler,policy,contact;
const rows=()=>db.select().from(schema.tasks);
const message=async(options={})=>(await db.insert(schema.messages).values({providerId:'synthetic-'+randomUUID(),contactId:contact.id,type:'SMS',direction:'inbound',actorType:'customer',body:'Synthetic private customer text',occurredAt:new Date(now.getTime()-60000),...options}).returning())[0];
beforeEach(async()=>{
  await db.execute(sql`truncate operation_events,operation_approvals,operation_requests,operation_briefs,tasks,contacts,sync_cursors cascade`);
  now=new Date();policy=basePolicy();
  [contact]=await db.insert(schema.contacts).values({providerId:'synthetic-'+randomUUID(),name:'Synthetic customer'}).returning();
  service=new OperationsService(db,{workspace:'egc',now:()=>now,resolveOwner:async id=>id===owner.id});
  reconciler=new InboundActionReconciler(db,service,async()=>policy,'egc',()=>now);
});
after(async()=>{globalThis.fetch=originalFetch;await db.$client.end({timeout:5});});

test('activation persists across restarts and excludes old history unless lookback is explicit',async()=>{
  const old=await message();assert.equal((await reconciler.run()).created,0);
  now=new Date(now.getTime()+120000);const fresh=await message();
  const restarted=new InboundActionReconciler(db,service,async()=>policy,'egc',()=>now);
  assert.equal((await restarted.run()).created,1);assert.equal((await rows())[0].dedupeKey,'inbound_reply:'+fresh.id);
  const backfill=await restarted.run({lookbackDays:1});assert.equal(backfill.created,1);assert.equal((await rows()).length,2);
  assert.ok((await rows()).some(t=>t.dedupeKey==='inbound_reply:'+old.id));
});
test('booked customers still receive an owned action with source-based deadline and exact evidence',async()=>{
  await db.insert(schema.leads).values({contactId:contact.id,currentState:'BOOKED',firstBookedAt:new Date(now.getTime()-86400000)});
  const m=await message();assert.equal((await reconciler.run({lookbackDays:1})).created,1);
  const [t]=await rows();assert.equal(t.assignedUserId,owner.id);assert.equal(t.contactId,contact.id);assert.equal(t.portalJobId,null);assert.equal(t.dueAt.getTime(),m.occurredAt.getTime()+3600000);assert.equal(t.sourceEvidence[0].id,m.id);assert.equal(t.draftPayload,null);
});
test('two schedulers and repeated explicit reconciliation create one task per source message',async()=>{
  await message();const results=await Promise.all([reconciler.run({lookbackDays:1}),reconciler.run({lookbackDays:1})]);
  assert.equal(results.reduce((n,r)=>n+(r.created||0),0),1);assert.equal((await reconciler.run({lookbackDays:1})).created,0);assert.equal((await rows()).length,1);
  await message({occurredAt:new Date(now.getTime()-30000)});assert.equal((await reconciler.run({lookbackDays:1})).created,1);assert.equal((await rows()).length,2);
});
test('automation, failed human sends and call envelopes do not close the response obligation',async()=>{
  await message();await reconciler.run({lookbackDays:1});
  for(const extra of [{actorType:'automation',raw:{status:'delivered'}},{actorType:'human',raw:{status:'failed'}},{actorType:'human',raw:{}},{actorType:'human',type:'CALL',raw:{status:'completed'}}])await message({direction:'outbound',occurredAt:now,...extra});
  await message({direction:'outbound',actorType:'human',occurredAt:new Date(now.getTime()+86400000),raw:{status:'delivered'}});
  assert.equal((await reconciler.run({lookbackDays:1})).completed,0);assert.equal((await rows())[0].status,'open');
  const sent=await message({direction:'outbound',actorType:'human',occurredAt:now,raw:{status:'delivered'}});
  assert.equal((await reconciler.run({lookbackDays:1})).completed,1);const [closed]=await rows();assert.equal(closed.status,'completed');assert.ok(JSON.stringify(closed.completionEvidence).includes(sent.id));
  assert.equal((await reconciler.run({lookbackDays:1})).completed,0);
});
test('already answered messages and inbound call envelopes do not create reply tasks',async()=>{
  await message();await message({type:'CALL'});await message({direction:'outbound',actorType:'human',occurredAt:now,raw:{messageStatus:'sent'}});
  assert.equal((await reconciler.run({lookbackDays:1})).created,0);assert.equal((await rows()).length,0);
});
test('failed inbound delivery is not an actual customer reply',async()=>{
  await message({raw:{status:'failed'}});assert.equal((await reconciler.run({lookbackDays:1})).created,0);assert.equal((await rows()).length,0);
});
test('unresolved Hub owner blocks visibly and retains the previous successful checkpoint',async()=>{
  const success=await reconciler.run();await message();now=new Date(now.getTime()+120000);policy={...policy,inboundResponse:{...policy.inboundResponse,enabled:false,ownerId:null,blockedReason:'inbound_owner_unresolved'}};
  const blocked=await reconciler.run({lookbackDays:1});assert.equal(blocked.ok,false);assert.equal(blocked.blocked,1);assert.equal(blocked.errorCode,'inbound_owner_unresolved');assert.equal(blocked.lastSuccessAt,success.lastSuccessAt);assert.equal((await rows()).length,0);
  await db.insert(schema.syncCursors).values({key:'ghl:contacts',cursor:'secret-not-public',updatedAt:now});
  const health=(await service.execute(owner,{command:'status'},randomUUID())).health;
  assert.equal(health.inboundActions.errorCode,'inbound_owner_unresolved');assert.equal(health.inboundActions.blocked,1);
  assert.ok(health.syncCheckpoints.some(c=>c.key==='ghl:contacts'));assert.ok(!JSON.stringify(health).includes('secret-not-public'));assert.ok(!JSON.stringify(health).includes('Synthetic private customer text'));
});
test('individual write failure is not success and retries keep the canonical source id',async()=>{
  await message();const original=service.execute.bind(service);let fail=true;service.execute=async(...args)=>{if(fail&&args[1].command==='task.create')throw new Error('private-token=do-not-log');return original(...args);};
  const failed=await reconciler.run({lookbackDays:1});assert.equal(failed.ok,false);assert.equal(failed.lastSuccessAt,null);assert.equal(failed.errorCode,'inbound_action_write_failed');assert.ok(!JSON.stringify(failed).includes('private-token'));
  fail=false;const retried=await reconciler.run({lookbackDays:1});assert.equal(retried.created,1);assert.equal(retried.ok,true);assert.equal((await rows()).length,1);
});
