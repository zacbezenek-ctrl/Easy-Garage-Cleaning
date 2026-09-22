import test,{after,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
const url=new URL(process.env.DATABASE_URL??'http://invalid');
if(process.env.EGC_CUSTOMER_STATE_TEST!=='isolated'||!['localhost','127.0.0.1'].includes(url.hostname)||!['/egc_operations_test','/egc_customer_state_test'].includes(url.pathname)||!['postgres:','postgresql:'].includes(url.protocol))throw new Error('Semantic queue integration requires an explicitly named isolated loopback database');
const {getDb,schema}=await import('@egc/database');
const {eq}=await import('drizzle-orm');
const {reconcileCustomerState,getCustomerTimeline,semanticQueueCandidates,claimSemanticWork,finishSemanticWork}=await import('../dist/index.js');
const db=getDb(),created=[],originalFetch=globalThis.fetch,originalKey=process.env.OPENAI_API_KEY;
globalThis.fetch=async()=>{throw new Error('External HTTP disabled in isolated semantic queue test');};
let contact,lead;
const since=new Date(Date.now()-7*86400000),at=new Date(Date.now()-3600000);
beforeEach(async()=>{
  [contact]=await db.insert(schema.contacts).values({providerId:`synthetic-queue-${randomUUID()}`,name:'Synthetic queue customer'}).returning();created.push(contact.id);
  [lead]=await db.insert(schema.leads).values({contactId:contact.id,createdAt:at}).returning();
});
after(async()=>{for(const id of created){await db.delete(schema.syncCursors).where(eq(schema.syncCursors.key,`customer_state:semantic:${id}`));await db.delete(schema.contacts).where(eq(schema.contacts.id,id));}globalThis.fetch=originalFetch;if(originalKey===undefined)delete process.env.OPENAI_API_KEY;else process.env.OPENAI_API_KEY=originalKey;await db.$client.end({timeout:2});});
const candidate=async()=>{const result=await semanticQueueCandidates(since);return result.candidates.find(c=>c.contactId===contact.id);};
const refresh=()=>reconcileCustomerState({contactIds:[contact.id],useAI:false});
test('concurrent claims acquire exactly one durable customer lease; stale completion cannot overwrite a replacement',async()=>{
  const item=await candidate(),now=new Date();assert.ok(item);
  const claims=await Promise.all([claimSemanticWork(item,now),claimSemanticWork(item,now)]),winner=claims.find(Boolean);assert.equal(claims.filter(Boolean).length,1);
  assert.equal(await claimSemanticWork({...item,workKey:'changed'},new Date(now.valueOf()+1)),null);
  const replacement=await claimSemanticWork(item,new Date(now.valueOf()+240001));assert.ok(replacement);assert.notEqual(replacement.leaseToken,winner.leaseToken);
  assert.equal(await finishSemanticWork(item,winner,{complete:true,errors:[],missingTranscripts:false,failed:false},new Date()),false);
  assert.equal(await finishSemanticWork(item,replacement,{complete:false,errors:['semantic_provider_http_429'],missingTranscripts:false,failed:true},new Date()),true);
  const [row]=await db.select().from(schema.syncCursors).where(eq(schema.syncCursors.key,`customer_state:semantic:${contact.id}`)),state=JSON.parse(row.cursor);assert.equal(state.attemptCount,2);assert.equal(state.status,'failed');assert.deepEqual(state.errors,['semantic_provider_http_429']);
});
test('fast report refresh does not spend extraction attempts, reset semantic backoff, or erase complete cached quotes',async()=>{
  const providerId=`quote-${randomUUID()}`;
  await db.insert(schema.messages).values({providerId,contactId:contact.id,type:'SMS',direction:'outbound',actorType:'human',body:'We have a truck in the area on September 27th. If you wanted to book on that day I can come down to 139',occurredAt:at});
  assert.equal((await refresh()).failed,0);
  await db.update(schema.customerEvidence).set({status:'complete',error:null,extractedEvents:[],attemptCount:7}).where(eq(schema.customerEvidence.sourceRecordId,providerId));
  const item=await candidate(),claim=await claimSemanticWork(item,new Date());await finishSemanticWork(item,claim,{complete:true,errors:[],missingTranscripts:false,failed:false},new Date());
  const before=await candidate();await refresh();await refresh();const after=await candidate();assert.deepEqual(after.cursor,before.cursor);assert.equal(after.workKey,before.workKey);
  const [source]=await db.select().from(schema.customerEvidence).where(eq(schema.customerEvidence.sourceRecordId,providerId));assert.equal(source.attemptCount,7);assert.equal(source.status,'complete');
  const quote=(await getCustomerTimeline({contactId:contact.id})).events.find(e=>e.eventType==='quote_delivered');assert.equal(quote.valueCents,13900);assert.equal(quote.valueVerified,true);
});
test('new customer activity makes cached completion stale and excluded internal records never enter the queue',async()=>{
  await refresh();const before=await candidate();assert.equal(before.complete,true);
  await db.insert(schema.messages).values({providerId:`new-${randomUUID()}`,contactId:contact.id,type:'SMS',direction:'inbound',actorType:'customer',body:'Please call me',occurredAt:new Date(Date.now()+1000)});
  const after=await candidate();assert.equal(after.complete,false);assert.notEqual(after.workKey,before.workKey);
  await db.update(schema.contacts).set({tags:['egc-internal']}).where(eq(schema.contacts.id,contact.id));assert.equal(await candidate(),undefined);
});
test('a fast read overlapping semantic extraction preserves the completed AI result and actual attempt count',async()=>{
  const providerId=`race-${randomUUID()}`,body='Thursday at 3 PM works for the walkthrough.';
  await db.insert(schema.messages).values({providerId,contactId:contact.id,type:'SMS',direction:'inbound',actorType:'customer',body,occurredAt:at});await refresh();
  let release,entered;const requested=new Promise(resolve=>{entered=resolve;});const blocked=new Promise(resolve=>{release=resolve;});
  process.env.OPENAI_API_KEY='synthetic-isolated-no-network';
  globalThis.fetch=async()=>{entered();await blocked;return new Response(JSON.stringify({id:'resp_isolated',object:'response',created_at:Date.now()/1000,status:'completed',error:null,incomplete_details:null,output:[{id:'msg_isolated',type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:JSON.stringify({reviewedSourceIds:[providerId],events:[{sourceRecordId:providerId,eventType:'walkthrough_verbally_booked',supportingText:body,confidence:.99,customerCommitmentVerified:true,humanReviewNeeded:false,nextAction:'Confirm in Portal'}]}),annotations:[]}]}]}),{status:200,headers:{'content-type':'application/json'}});};
  try{const running=reconcileCustomerState({contactIds:[contact.id],useAI:true,semanticMaxBatches:1});await requested;await refresh();release();const result=await running;assert.equal(result.failed,0);
    const [source]=await db.select().from(schema.customerEvidence).where(eq(schema.customerEvidence.sourceRecordId,providerId));assert.equal(source.status,'complete');assert.equal(source.attemptCount,1);assert.equal((await getCustomerTimeline({contactId:contact.id})).coverage.extraction.complete,true);
  }finally{release();globalThis.fetch=async()=>{throw new Error('External HTTP disabled in isolated semantic queue test');};if(originalKey===undefined)delete process.env.OPENAI_API_KEY;else process.env.OPENAI_API_KEY=originalKey;}
});
