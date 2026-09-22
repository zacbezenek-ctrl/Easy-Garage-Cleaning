import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
const url=new URL(process.env.DATABASE_URL??'http://invalid');
if(process.env.EGC_OPERATIONS_TEST!=='isolated'||!['127.0.0.1','localhost'].includes(url.hostname)||url.pathname!=='/egc_operations_test'||!['postgres:','postgresql:'].includes(url.protocol))throw new Error('Only isolated loopback egc_operations_test is allowed');
const {getDb,schema}=await import('@egc/database');
const {eq,inArray}=await import('drizzle-orm');
const {transcriptRecoveryStore,recoverCallTranscripts,persistProviderTranscript}=await import('../dist/call-transcript-worker.js');
const db=getDb(),contacts=[],calls=[],now=new Date(),originalFetch=globalThis.fetch;
globalThis.fetch=async()=>{throw new Error('All external HTTP disabled in transcript integration test');};
async function seed(ageDays,{active=false,text=null}={}){
 const [contact]=await db.insert(schema.contacts).values({providerId:`synthetic-transcript-${randomUUID()}`,name:'Synthetic Transcript Recovery',tags:['egc-test']}).returning();contacts.push(contact.id);
 const [lead]=await db.insert(schema.leads).values({contactId:contact.id,createdAt:new Date(now.valueOf()-80*86400000)}).returning();
 if(active)await db.insert(schema.customerStateSnapshots).values({contactId:contact.id,leadId:lead.id,state:'VIDEO_QUOTE_PENDING_CUSTOMER',intentStage:'engaged',pipeline:'video_quote',reconciliationStatus:'fully_reconciled',snapshot:{pipelineDisposition:'active'},coverage:{},lastReconciledAt:now});
 const [call]=await db.insert(schema.calls).values({providerMessageId:`synthetic-call-${randomUUID()}`,contactId:contact.id,direction:'outbound',actorType:'human',startedAt:new Date(now.valueOf()-ageDays*86400000),status:'completed'}).returning();calls.push(call.id);
 if(text!==null)await db.insert(schema.callTranscripts).values({callId:call.id,text});return call;
}
after(async()=>{
 if(calls.length)await db.delete(schema.syncCursors).where(inArray(schema.syncCursors.key,calls.map(id=>`customer_state:call_transcript:${id}`)));
 if(contacts.length)await db.delete(schema.contacts).where(inArray(schema.contacts.id,contacts));
 globalThis.fetch=originalFetch;await db.$client.end({timeout:2});
});
test('real candidate query includes recent missing/placeholder calls and older active customers only',async()=>{
 const recent=await seed(2),placeholder=await seed(3,{text:'No transcription found for this message.'}),active=await seed(60,{active:true}),inactive=await seed(60),valid=await seed(1,{text:'Actual customer dialogue.'});
 const rows=await transcriptRecoveryStore().listCandidates(new Date(now.valueOf()-30*86400000),500),ids=new Set(rows.map(r=>r.callId));
 assert.ok(ids.has(recent.id));assert.ok(ids.has(placeholder.id));assert.ok(ids.has(active.id));assert.ok(!ids.has(inactive.id));assert.ok(!ids.has(valid.id));
});
test('delayed provider transcript recovers with persisted retry cursor and no contact status inference',async()=>{
 const call=await seed(1,{text:'No transcript found'}),base=transcriptRecoveryStore();let ready=false,requests=0;
 const store={...base,listCandidates:async(since,limit)=>(await base.listCandidates(since,limit)).filter(r=>r.callId===call.id),saveRun:async()=>{}};
 const provider={downloadCallTranscript:async()=>{requests++;return ready?'Customer: I will send photos this afternoon.':'No transcript found';},getCallTranscript:async()=>({message:'not available'})};
 let result=await recoverCallTranscripts({provider,store,now});assert.equal(result.unavailable,1);
 const [row]=await db.select().from(schema.syncCursors).where(eq(schema.syncCursors.key,`customer_state:call_transcript:${call.id}`));assert.equal(JSON.parse(row.cursor).status,'pending');
 result=await recoverCallTranscripts({provider,store,now:new Date(now.valueOf()+60000)});assert.equal(result.deferred,1);assert.equal(requests,1);
 ready=true;result=await recoverCallTranscripts({provider,store,now:new Date(now.valueOf()+5*60000)});assert.equal(result.recovered,1);
 const [transcript]=await db.select().from(schema.callTranscripts).where(eq(schema.callTranscripts.callId,call.id));assert.equal(transcript.text,'Customer: I will send photos this afternoon.');assert.match(transcript.providerPayload.contentHash,/^[a-f0-9]{64}$/);
 const [unchangedCall]=await db.select().from(schema.calls).where(eq(schema.calls.id,call.id));assert.equal(unchangedCall.answered,null);assert.equal(unchangedCall.status,'completed');
 result=await recoverCallTranscripts({provider,store,now:new Date(now.valueOf()+10*60000)});assert.equal(result.attempted,0);assert.equal(requests,2);
});
test('shared persistence rejects error payloads, preserves segments and does not rewrite identical text',async()=>{
 const call=await seed(1),payload=[{text:'Tuesday works.',speaker:'customer',start:12},{text:'I have you booked.',speaker:'staff',start:14}];
 assert.equal(await persistProviderTranscript(call.id,{error:'forbidden',text:'private failure'}),false);
 assert.equal(await persistProviderTranscript(call.id,payload),true);
 const [first]=await db.select().from(schema.callTranscripts).where(eq(schema.callTranscripts.callId,call.id));assert.equal(first.segments.length,2);assert.equal(first.segments[0].speaker,'customer');
 assert.equal(await persistProviderTranscript(call.id,payload),false);
 const [second]=await db.select().from(schema.callTranscripts).where(eq(schema.callTranscripts.callId,call.id));assert.equal(second.id,first.id);assert.equal(second.updatedAt.toISOString(),first.updatedAt.toISOString());
});
test('legacy JSON transcript storage is canonicalized once and leaves the recovery candidate queue',async()=>{
 const call=await seed(1,{text:'{"transcript":"Actual recorded customer speech."}'}),base=transcriptRecoveryStore();
 const store={...base,listCandidates:async(since,limit)=>(await base.listCandidates(since,limit)).filter(r=>r.callId===call.id),saveRun:async()=>{}};
 const provider={downloadCallTranscript:async()=>{throw new Error('No provider fetch expected');},getCallTranscript:async()=>{throw new Error('No provider fetch expected');}};
 const result=await recoverCallTranscripts({provider,store,now});assert.equal(result.recovered,1);assert.equal(result.attempted,0);
 const [row]=await db.select().from(schema.callTranscripts).where(eq(schema.callTranscripts.callId,call.id));assert.equal(row.text,'Actual recorded customer speech.');
 assert.ok(!(await base.listCandidates(new Date(now.valueOf()-30*86400000),500)).some(r=>r.callId===call.id));
});
