/** Complete reviewed tasks from durable delivery evidence, never by sending. */
import test,{beforeEach,after} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {getDb,schema} from '@egc/database';
import {eq,sql} from 'drizzle-orm';
import {OperationsService} from '../dist/index.js';
import {communicationBodyEvidence} from '../dist/communication-body-evidence.js';
const url=new URL(process.env.DATABASE_URL||'http://invalid');
if(process.env.EGC_OPERATIONS_TEST!=='isolated'||!['localhost','127.0.0.1'].includes(url.hostname)||url.pathname!=='/egc_operations_test'||!['postgres:','postgresql:'].includes(url.protocol))throw new Error('Only isolated loopback egc_operations_test is allowed');
globalThis.fetch=async()=>{throw new Error('No external HTTP in message completion tests');};
const db=getDb(),owner={id:'owner-fixture',role:'owner',kind:'human',workspace:'egc'},integration={id:'verified-grant',role:'integration',kind:'integration',workspace:'egc'};
const NOW='2026-10-01T15:00:00.000Z';
let service,now,contact,task,execution,body;
const call=(c,actor=owner,id=randomUUID())=>service.execute(actor,c,id);
const complete=(extra={},requestId=randomUUID())=>call({command:'task.complete_from_message',taskId:task.id,revision:task.revision,executionId:execution.id,...extra},integration,requestId);
// Creates, approves and records verified delivery for one message task. A legacy
// draft is stored without the attachments key, as rows written before action kinds v2.
async function setup({kind='followup_message',attachments,providerId='synthetic-provider',providerMessageId='synthetic-message',legacyDraft=false,approvedBody='Synthetic exact approved message'}={}){
 [contact]=await db.insert(schema.contacts).values({provider:'ghl',providerId,phone:'+12025550100'}).returning();
 body=approvedBody;const draft={channel:'sms',fromNumber:'+15555551644',recipient:'+12025550100',subject:'',body,sendWindowStart:new Date(now-60000).toISOString(),sendWindowEnd:new Date(+now+3600000).toISOString(),...(attachments?{attachments}:{})};
 task=(await call({command:'task.create',task:{title:'Send reviewed followup',kind,assignedUserId:owner.id,dueAt:new Date(+now+3600000).toISOString(),contactId:contact.id,completionCondition:'Verify exact message delivered',draft}})).task;
 if(legacyDraft){await db.transaction(async tx=>{await tx.execute(sql`select set_config('egc.operations_actor','legacy-row-fixture',true)`);const {attachments:_,...legacy}=task.draftPayload;await tx.update(schema.tasks).set({draftPayload:legacy}).where(eq(schema.tasks.id,task.id));});task=(await call({command:'task.get',taskId:task.id})).task;}
 const preview=await call({command:'task.get',taskId:task.id});await call({command:'tasks.approve',items:[{taskId:task.id,revision:task.revision,previewHash:preview.previewHash}],expiresAt:new Date(+now+3600000).toISOString()});
 const occurred=new Date(+now+1000);now=new Date(+now+2000);const payload={type:'SMS',contactId:contact.providerId,message:body,fromNumber:draft.fromNumber,toNumber:draft.recipient,...(attachments?.length?{attachments:attachments.map(a=>a.url)}:{})};
 [execution]=await db.insert(schema.communicationExecutions).values({requestId:randomUUID(),actorId:integration.id,contactId:contact.id,channel:'SMS',payloadHash:'proofhash',payload,status:'accepted',providerMessageId,createdAt:occurred,verifiedAt:now,response:{messageId:providerMessageId,status:'delivered',delivered:true,matchEvidence:{version:1,channel:'sms',fromNumber:'+15555551644',recipient:draft.recipient,subject:'',bodyHash:createHash('sha256').update(body).digest('hex'),payloadHash:'proofhash',occurredAt:occurred.toISOString()}}}).returning();
}
beforeEach(async()=>{
 await db.execute(sql`truncate operation_events,operation_approvals,operation_requests,operation_briefs,tasks,communication_executions,contacts cascade`);
 now=new Date(NOW);service=new OperationsService(db,{workspace:'egc',smsFromNumbers:['+15555551644','+15555551818'],now:()=>now,resolveOwner:async()=>true});
 await setup();
});
after(async()=>{await db.$client.end({timeout:5});});
test('verified delivered message completes exact task atomically and retries do not add evidence',async()=>{const id=randomUUID(),r=await complete({},id);assert.equal(r.task.status,'completed');assert.equal(r.task.completionEvidence[0].kind,'verified_communication');assert.equal(r.task.completionEvidence[0].approvedRevision,1);assert.equal((await complete({},id)).replayed,true);const [stored]=await db.select().from(schema.tasks).where(eq(schema.tasks.id,task.id));assert.equal(stored.completionEvidence.length,1);});
test('matching outgoing mirror may invalidate approval without blocking evidence completion',async()=>{await db.insert(schema.messages).values({providerId:'synthetic-message',contactId:contact.id,type:'SMS',direction:'outbound',actorType:'human',body,occurredAt:new Date(+now-1000)});assert.equal((await call({command:'task.get',taskId:task.id})).task.approvalStatus,'invalidated');assert.equal((await complete()).task.status,'completed');});
test('bounded SMS proof completes against the unchanged raw approval and payload',async()=>{
 await setup({providerId:'synthetic-apostrophe',providerMessageId:'synthetic-apostrophe-message',approvedBody:'We\u2019ll send the exact approved plan.'});
 const observed=body.replaceAll('\u2019',"'"),proof=communicationBodyEvidence(body,observed,'SMS');
 assert.equal(proof.version,2);assert.notEqual(proof.approvedBodyHash,proof.providerBodyHash);
 await db.update(schema.communicationExecutions).set({response:{...execution.response,matchEvidence:{...execution.response.matchEvidence,...proof}}}).where(eq(schema.communicationExecutions.id,execution.id));
 await db.insert(schema.messages).values({providerId:execution.providerMessageId,contactId:contact.id,type:'SMS',direction:'outbound',actorType:'human',body:observed,occurredAt:new Date(+now-1000)});
 const r=await complete();assert.equal(r.task.status,'completed');assert.equal(r.task.draftPayload.body,body);
 const [stored]=await db.select().from(schema.communicationExecutions).where(eq(schema.communicationExecutions.id,execution.id));assert.equal(stored.payload.message,body);assert.equal(stored.payloadHash,'proofhash');assert.equal(stored.response.matchEvidence.providerBody,observed);
});
test('undelivered 30003 with matching SMS proof never completes an approved task',async()=>{
 await setup({providerId:'synthetic-failed-apostrophe',providerMessageId:'synthetic-failed-apostrophe-message',approvedBody:'We\u2019ll send the exact approved plan.'});
 const proof=communicationBodyEvidence(body,body.replaceAll('\u2019',"'"),'SMS');
 await db.update(schema.communicationExecutions).set({status:'failed',response:{...execution.response,status:'undelivered',errorCode:30003,delivered:false,matchEvidence:{...execution.response.matchEvidence,...proof}}}).where(eq(schema.communicationExecutions.id,execution.id));
 await assert.rejects(complete(),e=>e.code==='message_delivery_not_freshly_verified');assert.equal((await call({command:'task.get',taskId:task.id})).task.status,'open');
});
test('a tampered transformed body proof cannot borrow the raw approval',async()=>{
 await setup({providerId:'synthetic-tampered-apostrophe',providerMessageId:'synthetic-tampered-message',approvedBody:'We\u2019ll send the exact approved plan.'});
 const proof=communicationBodyEvidence(body,body.replaceAll('\u2019',"'"),'SMS');
 for(const changes of [{providerBody:"We'll send a different plan."},{approvedBodyHash:'wrong'},{providerBodyHash:'wrong'},{bodyTransform:'generic_unicode'}]){
  await db.update(schema.communicationExecutions).set({response:{...execution.response,matchEvidence:{...execution.response.matchEvidence,...proof,...changes}}}).where(eq(schema.communicationExecutions.id,execution.id));
  await assert.rejects(complete(),e=>e.code==='message_draft_delivery_mismatch');
 }
});
test('sent/queued, stale receipt and wrong recipient never complete',async()=>{for(const changes of [{response:{...execution.response,delivered:false}},{verifiedAt:new Date(+now-600001)},{response:{...execution.response,matchEvidence:{...execution.response.matchEvidence,recipient:'+12025550199'}}}]){await db.update(schema.communicationExecutions).set({...execution,...changes}).where(eq(schema.communicationExecutions.id,execution.id));await assert.rejects(complete());}assert.equal((await call({command:'task.get',taskId:task.id})).task.status,'open');});
test('an approval recorded after the send never displaces the approval that covered it',async()=>{
 // A re-approval of the same content after the send (here a late rejection and a new review) is newer than the execution.
 await call({command:'task.reject',taskId:task.id,revision:task.revision,reason:'Synthetic late rejection'});
 await call({command:'tasks.approve',items:[{taskId:task.id,revision:task.revision,previewHash:(await call({command:'task.get',taskId:task.id})).previewHash}],expiresAt:new Date(+now+3600000).toISOString()});
 const approvals=await db.select().from(schema.operationApprovals).where(eq(schema.operationApprovals.taskId,task.id));assert.equal(approvals.length,2);
 const covering=approvals.find(a=>a.createdAt<=execution.createdAt),later=approvals.find(a=>a.createdAt>execution.createdAt);assert.ok(covering&&later);assert.equal(covering.fingerprint,later.fingerprint);
 const r=await complete();assert.equal(r.task.status,'completed');assert.equal(r.task.completionEvidence[0].approvalId,covering.id);
});
test('unrelated outgoing context changes cannot borrow the original approval',async()=>{await db.insert(schema.messages).values({providerId:'other-message',contactId:contact.id,type:'SMS',direction:'outbound',actorType:'human',body:'Different current context',occurredAt:now});await assert.rejects(complete(),e=>e.code==='message_approval_context_changed_or_expired');});
test('inbound response blocks completion and preserves customer response work',async()=>{await db.insert(schema.messages).values({providerId:'inbound-message',contactId:contact.id,type:'SMS',direction:'inbound',actorType:'customer',body:'Please stop',occurredAt:now});await assert.rejects(complete());assert.equal((await call({command:'task.get',taskId:task.id})).task.status,'blocked');});
test('different contact, expired approval, body mismatch and outside window are rejected',async()=>{const [other]=await db.insert(schema.contacts).values({provider:'ghl',providerId:'other'}).returning();await db.update(schema.communicationExecutions).set({contactId:other.id}).where(eq(schema.communicationExecutions.id,execution.id));await assert.rejects(complete());await db.update(schema.communicationExecutions).set({contactId:contact.id,response:{...execution.response,matchEvidence:{...execution.response.matchEvidence,bodyHash:'wrong'}}}).where(eq(schema.communicationExecutions.id,execution.id));await assert.rejects(complete());await db.update(schema.communicationExecutions).set({response:{...execution.response,matchEvidence:{...execution.response.matchEvidence,occurredAt:new Date(+now-86400000).toISOString()}}}).where(eq(schema.communicationExecutions.id,execution.id));await assert.rejects(complete());await db.update(schema.communicationExecutions).set({response:execution.response}).where(eq(schema.communicationExecutions.id,execution.id));now=new Date(+now+7200000);await db.update(schema.communicationExecutions).set({verifiedAt:now}).where(eq(schema.communicationExecutions.id,execution.id));await assert.rejects(complete(),e=>e.code==='message_approval_context_changed_or_expired');});
test('two competing completion requests append only one provider evidence record',async()=>{const results=await Promise.allSettled([complete(),complete()]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal((await call({command:'task.get',taskId:task.id})).task.completionEvidence.length,1);});
test('database guard independently rejects wrong approval ID or recipient even with completion session set',async()=>{
 const [approval]=await db.select().from(schema.operationApprovals).where(eq(schema.operationApprovals.taskId,task.id));
 const direct=async approvalId=>db.transaction(async tx=>{await tx.execute(sql`select set_config('egc.operations_actor','isolated-guard-test',true),set_config('egc.operations_actor_kind','integration',true),set_config('egc.communication_completion',${task.id},true)`);return tx.update(schema.tasks).set({status:'completed',completedAt:now,completionEvidence:[{kind:'verified_communication',executionId:execution.id,taskId:task.id,approvedRevision:task.revision,approvalId,providerMessageId:execution.providerMessageId}]}).where(eq(schema.tasks.id,task.id));});
 await assert.rejects(direct(randomUUID()),e=>String(e.cause?.message||e.message).includes('provider_evidence_completion_not_activated'));
 await db.update(schema.communicationExecutions).set({payload:{...execution.payload,toNumber:'+12025550199'}}).where(eq(schema.communicationExecutions.id,execution.id));
 await assert.rejects(direct(approval.id),e=>String(e.cause?.message||e.message).includes('provider_evidence_completion_not_activated'));
 assert.equal((await call({command:'task.get',taskId:task.id})).task.status,'open');
});
const depositAttachments=[{kind:'payment_link',url:'https://easygaragecleaning.com/pay/synthetic-deposit',label:'Pay your deposit',refId:'job-synthetic-1'},{kind:'portal_quote',url:'https://easygaragecleaning.com/portal/quote/synthetic-1',label:'Your quote',refId:null}];
const directComplete=approvalId=>db.transaction(async tx=>{await tx.execute(sql`select set_config('egc.operations_actor','isolated-guard-test',true),set_config('egc.operations_actor_kind','integration',true),set_config('egc.communication_completion',${task.id},true)`);return tx.update(schema.tasks).set({status:'completed',completedAt:now,completionEvidence:[{kind:'verified_communication',executionId:execution.id,taskId:task.id,approvedRevision:task.revision,approvalId,providerMessageId:execution.providerMessageId}]}).where(eq(schema.tasks.id,task.id)).returning();});
const withPayload=payload=>db.update(schema.communicationExecutions).set({payload}).where(eq(schema.communicationExecutions.id,execution.id));
test('deposit_reminder completes from verified delivery that carries exactly the approved attachment URLs',async()=>{
 await setup({kind:'deposit_reminder',attachments:depositAttachments,providerId:'synthetic-deposit',providerMessageId:'synthetic-deposit-message'});
 assert.equal(task.kind,'deposit_reminder');assert.deepEqual(task.draftPayload.attachments,depositAttachments);assert.deepEqual(execution.payload.attachments,depositAttachments.map(a=>a.url));
 const r=await complete();assert.equal(r.task.status,'completed');assert.equal(r.task.kind,'deposit_reminder');assert.equal(r.task.completedAt,now.toISOString());const proof=r.task.completionEvidence[0];assert.equal(proof.kind,'verified_communication');assert.equal(proof.executionId,execution.id);assert.equal(proof.providerMessageId,'synthetic-deposit-message');assert.equal(proof.approvedRevision,1);
});
test('a delivery whose attachment URLs differ from the approval never completes the message task',async()=>{
 await setup({kind:'deposit_reminder',attachments:depositAttachments,providerId:'synthetic-deposit',providerMessageId:'synthetic-deposit-message'});
 const urls=depositAttachments.map(a=>a.url),{attachments:_,...bare}=execution.payload;
 for(const attachments of [undefined,null,[],[urls[0]],[...urls].reverse(),[...urls,'https://easygaragecleaning.com/extra'],[urls[0],'https://easygaragecleaning.com/pay/other'],urls.join(',')]){await withPayload(attachments===undefined?bare:{...bare,attachments});await assert.rejects(complete(),e=>e.code==='message_draft_delivery_mismatch',JSON.stringify(attachments));}
 assert.equal((await call({command:'task.get',taskId:task.id})).task.status,'open');
});
test('database guard independently requires the exact approved attachment URLs for message kinds',async()=>{
 await setup({kind:'deposit_reminder',attachments:depositAttachments,providerId:'synthetic-deposit',providerMessageId:'synthetic-deposit-message'});
 const [approval]=await db.select().from(schema.operationApprovals).where(eq(schema.operationApprovals.taskId,task.id)),urls=depositAttachments.map(a=>a.url),{attachments:_,...bare}=execution.payload;
 for(const payload of [bare,{...bare,attachments:[...urls].reverse()},{...bare,attachments:[urls[0]]}]){await withPayload(payload);await assert.rejects(directComplete(approval.id),e=>String(e.cause?.message||e.message).includes('provider_evidence_completion_not_activated'));}
 await withPayload({...bare,attachments:urls});const [done]=await directComplete(approval.id);assert.equal(done.status,'completed');assert.equal(done.kind,'deposit_reminder');
});
test('a legacy draft stored without attachments still completes only from a payload without attachments',async()=>{
 await db.execute(sql`truncate operation_events,operation_approvals,operation_requests,tasks,communication_executions,contacts cascade`);
 await setup({legacyDraft:true});assert.equal('attachments' in task.draftPayload,false);assert.equal(task.revision,2);
 const {attachments:_,...bare}=execution.payload;await withPayload({...bare,attachments:['https://easygaragecleaning.com/unapproved']});await assert.rejects(complete(),e=>e.code==='message_draft_delivery_mismatch');
 await withPayload(bare);const r=await complete();assert.equal(r.task.status,'completed');assert.equal(r.task.completionEvidence[0].approvedRevision,2);
});
test('attachments submitted in a non-canonical spelling complete only from the canonical URL',async()=>{
 await db.execute(sql`truncate operation_events,operation_approvals,operation_requests,tasks,communication_executions,contacts cascade`);
 await setup({kind:'send_quote',attachments:[{kind:'portal_quote',url:'HTTPS://EasyGarageCleaning.com\\portal\\quote\\synthetic-7',label:'Your quote'}],providerId:'synthetic-canonical',providerMessageId:'synthetic-canonical-message'});
 const canonical='https://easygaragecleaning.com/portal/quote/synthetic-7';assert.equal(task.draftPayload.attachments[0].url,canonical);
 const {attachments:_,...bare}=execution.payload;await withPayload({...bare,attachments:['HTTPS://EasyGarageCleaning.com\\portal\\quote\\synthetic-7']});await assert.rejects(complete(),e=>e.code==='message_draft_delivery_mismatch');
 await withPayload({...bare,attachments:[canonical]});const r=await complete();assert.equal(r.task.status,'completed');assert.equal(r.task.kind,'send_quote');
});

test('wrong-line and missing-sender receipts never complete a reviewed SMS',async()=>{
 for(const patch of [{payload:{...execution.payload,fromNumber:'+15555551818'}},{response:{...execution.response,matchEvidence:{...execution.response.matchEvidence,fromNumber:'+15555551818'}}},{response:{...execution.response,matchEvidence:{...execution.response.matchEvidence,fromNumber:null}}}]){
  await db.update(schema.communicationExecutions).set({...execution,...patch}).where(eq(schema.communicationExecutions.id,execution.id));await assert.rejects(complete(),e=>e.code==='message_draft_delivery_mismatch');
 }
 assert.equal((await call({command:'task.get',taskId:task.id})).task.status,'open');
});
test('the database completion guard independently rejects sender evidence from another line',async()=>{
 const approval=(await db.select().from(schema.operationApprovals).where(eq(schema.operationApprovals.taskId,task.id)))[0];
 await db.update(schema.communicationExecutions).set({response:{...execution.response,matchEvidence:{...execution.response.matchEvidence,fromNumber:'+15555551818'}}}).where(eq(schema.communicationExecutions.id,execution.id));
 await assert.rejects(db.transaction(async tx=>{await tx.execute(sql`select set_config('egc.operations_actor',${owner.id},true),set_config('egc.communication_completion',${task.id},true)`);await tx.update(schema.tasks).set({status:'completed',completedAt:now,completionEvidence:[{kind:'verified_communication',executionId:execution.id,taskId:task.id,approvedRevision:task.revision,approvalId:approval.id,providerMessageId:execution.providerMessageId}]}).where(eq(schema.tasks.id,task.id));}),e=>String(e.cause?.message||e.message).includes('provider_evidence_completion_not_activated'));
});
