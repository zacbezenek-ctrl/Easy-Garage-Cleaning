/** Receipt claim fencing against isolated PostgreSQL. No provider network calls. */
import test,{beforeEach,afterEach,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {eq,sql} from 'drizzle-orm';
import {getDb,schema} from '@egc/database';
import {processWebhookQueue,UnsupportedWebhook} from '../dist/webhook-queue.js';
const url=new URL(process.env.DATABASE_URL||'http://invalid');
if(process.env.EGC_OPERATIONS_TEST!=='isolated'||!['localhost','127.0.0.1'].includes(url.hostname)||url.pathname!=='/egc_operations_test'||!['postgres:','postgresql:'].includes(url.protocol))throw new Error('Only isolated loopback egc_operations_test is allowed');
const originalFetch=globalThis.fetch;globalThis.fetch=async()=>{throw new Error('External HTTP forbidden');};
const db=getDb();let event;
const gates=new Set(),workers=new Set();
const testOptions={timeout:15000};
const row=async()=>(await db.select().from(schema.webhookEvents).where(eq(schema.webhookEvents.id,event.id)))[0];
const expire=()=>db.update(schema.webhookEvents).set({processingStartedAt:new Date(Date.now()-660000)}).where(eq(schema.webhookEvents.id,event.id));
function bounded(promise,label,milliseconds=5000){
  let timer;
  return Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(`${label} timed out`)),milliseconds);})]).finally(()=>clearTimeout(timer));
}
function deferred(){
  let resolve;const promise=new Promise(r=>{resolve=r;});gates.add(resolve);
  return{promise,resolve:()=>resolve()};
}
function run(ingest){
  const worker=processWebhookQueue(ingest,db);workers.add(worker);
  const result=bounded(worker,'Webhook worker',10000);
  // A deliberately paused worker may reject before its test reaches the await.
  void result.catch(()=>{});
  return result;
}
beforeEach(async()=>{
  await db.execute(sql`truncate webhook_events`);
  // PostgreSQL now() retains microseconds; JS Date uses milliseconds. Explicitly
  // make the receipt eligible rather than depending on two clock reads ordering.
  [event]=await db.insert(schema.webhookEvents).values({providerEventId:randomUUID(),eventType:'InboundMessage',payload:{id:'synthetic-event'},processingStatus:'pending',availableAt:new Date(Date.now()-1000)}).returning();
},{timeout:10000});
afterEach(async()=>{
  for(const release of gates)release();
  try{await bounded(Promise.allSettled([...workers]),'Webhook worker cleanup');}
  finally{gates.clear();workers.clear();}
},{timeout:7000});
after(async()=>{globalThis.fetch=originalFetch;await db.$client.end({timeout:5});},{timeout:7000});

test('concurrent workers claim one receipt and record one completion',testOptions,async()=>{
  let ingests=0;const results=await Promise.all(Array.from({length:10},()=>run(async()=>{ingests++;return'provider_reconciled';})));
  assert.equal(ingests,1);assert.equal(results.reduce((n,r)=>n+r.processed,0),1);assert.equal((await row()).processingStatus,'processed');assert.equal((await row()).retryCount,1);
});
test('expired successful worker cannot overwrite newer terminal failure',testOptions,async()=>{
  const started=deferred(),resume=deferred();const old=run(async()=>{started.resolve();await resume.promise;return'old_success';});await bounded(started.promise,'Original claim');await expire();
  const replacement=await run(async()=>{throw new UnsupportedWebhook('private unsupported data');});assert.equal(replacement.failed,1);resume.resolve();
  const stale=await old;assert.equal(stale.leaseLost,1);assert.equal(stale.processed,0);const current=await row();assert.equal(current.processingStatus,'failed');assert.equal(current.retryCount,2);assert.equal(current.resolution,'manual_review_required');assert.equal(current.processedAt,null);assert.ok(!JSON.stringify(current).includes('private unsupported data'));
});
test('expired failed worker cannot downgrade newer verified completion to pending',testOptions,async()=>{
  const started=deferred(),resume=deferred();const old=run(async()=>{started.resolve();await resume.promise;throw new Error('private-token-value');});await bounded(started.promise,'Original claim');await expire();
  assert.equal((await run(async()=>'new_verified_evidence')).processed,1);resume.resolve();const stale=await old;assert.equal(stale.leaseLost,1);assert.equal(stale.retrying,0);const current=await row();assert.equal(current.processingStatus,'processed');assert.equal(current.resolution,'new_verified_evidence');assert.equal(current.lastError,null);assert.equal(current.retryCount,2);assert.ok(current.processedAt);
});
test('claim generation fences stale completion while replacement is still processing',testOptions,async()=>{
  const firstStarted=deferred(),resumeFirst=deferred(),secondStarted=deferred(),resumeSecond=deferred();
  const first=run(async()=>{firstStarted.resolve();await resumeFirst.promise;return'old';});await bounded(firstStarted.promise,'Original claim');await expire();
  const second=run(async()=>{secondStarted.resolve();await resumeSecond.promise;return'new';});await bounded(secondStarted.promise,'Replacement claim');resumeFirst.resolve();assert.equal((await first).leaseLost,1);
  const pending=await row();assert.equal(pending.processingStatus,'processing');assert.equal(pending.retryCount,2);assert.equal(pending.resolution,null);assert.equal(pending.processedAt,null);
  resumeSecond.resolve();assert.equal((await second).processed,1);assert.equal((await row()).resolution,'new');
});
test('exhausted expired claim becomes visible terminal state without another ingestion',testOptions,async()=>{
  await db.update(schema.webhookEvents).set({processingStatus:'processing',retryCount:5,processingStartedAt:new Date(Date.now()-660000)}).where(eq(schema.webhookEvents.id,event.id));
  let ingests=0;const result=await run(async()=>{ingests++;return'impossible';});assert.equal(ingests,0);assert.equal(result.failed,1);assert.equal((await row()).processingStatus,'failed');assert.equal((await row()).lastError,'unsupported_or_exhausted_event');
});
