/** task.send transaction 1 against the real guards: exact approval by the confirming person, optional edit, windows and authorization. Never sends. */
import test,{beforeEach,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {getDb,schema} from '@egc/database';
import {eq,sql} from 'drizzle-orm';
import {OperationsService,taskSendRequestId} from '../dist/index.js';
const url=new URL(process.env.DATABASE_URL||'http://invalid');
if(process.env.EGC_OPERATIONS_TEST!=='isolated'||!['localhost','127.0.0.1'].includes(url.hostname)||url.pathname!=='/egc_operations_test'||!['postgres:','postgresql:'].includes(url.protocol))throw new Error('Only isolated loopback egc_operations_test is allowed');
const originalFetch=globalThis.fetch;globalThis.fetch=async()=>{throw new Error('No provider HTTP in task.send approval tests');};
const db=getDb();
const owner={id:'synthetic-owner',role:'owner',kind:'human',workspace:'egc'},manager={...owner,id:'synthetic-manager',role:'manager'},sales={...owner,id:'synthetic-sales',role:'sales'};
const integration={id:'synthetic-grant',role:'integration',kind:'integration',workspace:'egc'};
const NOW='2026-10-01T15:00:00.000Z';
let now,service,contact,sent;
const at=hours=>new Date(now.valueOf()+hours*3600000).toISOString();
const links=[{kind:'portal_quote',url:'https://easygaragecleaning.com/portal/quote/synthetic-1',label:'Your quote',refId:null},{kind:'payment_link',url:'https://pay.example.com/synthetic-deposit',label:'Pay the deposit',refId:'job-synthetic-1'}];
const draft=(extra={})=>({channel:'sms',fromNumber:'+15555551644',recipient:'+15555550100',subject:'',body:'Synthetic approved message',sendWindowStart:at(-1),sendWindowEnd:at(12),attachments:links,...extra});
const call=(body,actor=owner,id=randomUUID())=>service.execute(actor,body,id);
const create=async(extra={},actor=owner)=>(await call({command:'task.create',task:{title:'Send synthetic quote',kind:'send_quote',assignedUserId:actor.id,dueAt:at(1),contactId:contact.id,completionCondition:'Verified delivery of the exact quote message',draft:draft(),...extra}},actor)).task;
const get=id=>call({command:'task.get',taskId:id});
const sendCommand=async(task,extra={})=>({command:'task.send',taskId:task.id,revision:task.revision,previewHash:(await get(task.id)).previewHash,confirm:true,...extra});
const approve=(command,actor=owner,id=randomUUID())=>service.approveForSend(actor,command,id);
const rejects=(p,code)=>assert.rejects(p,e=>e.code===code,code);
const approvals=async id=>db.select().from(schema.operationApprovals).where(eq(schema.operationApprovals.taskId,id));
beforeEach(async()=>{
 await db.execute(sql`set client_min_messages to warning`);
 await db.execute(sql`truncate operation_events,operation_approvals,operation_requests,operation_briefs,tasks,communication_executions,messages,contacts cascade`);
 now=new Date(NOW);sent=[];
 service=new OperationsService(db,{workspace:'egc',smsFromNumbers:['+15555551644','+15555551818'],now:()=>now,resolveOwner:async id=>[owner.id,manager.id,sales.id].includes(id),sendTaskMessage:async(actor,command,requestId)=>{sent.push({actor,command,requestId});return service.approveForSend(actor,command,requestId);}});
 [contact]=await db.insert(schema.contacts).values({provider:'ghl',providerId:'synthetic-provider',phone:'+15555550100'}).returning();
});
// Leave no rows behind: later suites clean up with plain deletes and must not trip over these.
after(async()=>{globalThis.fetch=originalFetch;await db.execute(sql`truncate operation_events,operation_approvals,operation_requests,operation_briefs,tasks,communication_executions,messages,contacts cascade`);await db.$client.end({timeout:5});});
test('the confirming person approves the exact current preview once per request, bounded by the send window',async()=>{
 const t=await create({draft:draft({sendWindowEnd:at(6)})}),command=await sendCommand(t),requestId=randomUUID();
 const r=await approve(command,owner,requestId);
 assert.equal(r.approvedRevision,1);assert.equal(r.edited,false);assert.equal(r.task.approvalStatus,'approved');assert.equal(r.previewHash,command.previewHash);
 const [approval]=await approvals(t.id);assert.equal(approval.actorId,owner.id);assert.equal(approval.taskRevision,1);assert.equal(approval.fingerprint,command.previewHash);assert.equal(approval.expiresAt.toISOString(),at(6));assert.deepEqual(approval.snapshot.task.draftPayload.attachments,links);
 const replay=await approve(command,owner,requestId);assert.equal(replay.replayed,true);assert.equal(replay.approval.id,approval.id);assert.equal((await approvals(t.id)).length,1);
 await rejects(approve({...command,draft:draft({body:'Different synthetic text'})},owner,requestId),'idempotency_key_payload_conflict');
 const detail=await get(t.id);assert.equal(detail.effectiveApproval,'approved');assert.equal(detail.task.revision,1);assert.ok(detail.history.some(e=>e.type==='draft.approved'&&e.evidence.via==='task.send'&&e.actorId===owner.id));
 const long=await create({draft:draft({sendWindowEnd:at(48)}),title:'Long window'});await approve(await sendCommand(long));const [bounded]=await approvals(long.id);assert.equal(bounded.expiresAt.toISOString(),at(24));
});
test('an edited draft becomes the next revision and the approval covers exactly the edited content',async()=>{
 const t=await create(),edited=draft({body:'Synthetic edited message',attachments:[links[1]]}),command=await sendCommand(t,{draft:edited});
 const r=await approve(command);assert.equal(r.edited,true);assert.equal(r.approvedRevision,2);assert.equal(r.task.revision,2);assert.equal(r.task.draftPayload.body,'Synthetic edited message');
 const [approval]=await approvals(t.id);assert.equal(approval.taskRevision,2);assert.equal(approval.snapshot.task.draftPayload.body,'Synthetic edited message');assert.deepEqual(approval.snapshot.task.draftPayload.attachments,[links[1]]);
 const detail=await get(t.id);assert.equal(detail.task.revision,2);assert.equal(detail.effectiveApproval,'approved');assert.equal(approval.fingerprint,detail.previewHash);
 assert.ok(detail.history.some(e=>e.type==='task.edit'&&e.evidence.via==='task.send'));
 // The original revision can no longer be sent: its revision is stale.
 await rejects(approve(command),'task_revision_conflict');
 // An unchanged draft (a missing and an empty attachment list mean the same) is not an edit.
 const same=await create({title:'Unchanged',draft:draft({attachments:[]})});const r2=await approve(await sendCommand(same,{draft:draft({attachments:[]})}));assert.equal(r2.edited,false);assert.equal(r2.approvedRevision,1);
});
test('stale revision or preview and closed, blocked or non-message tasks are refused before anything is approved',async()=>{
 const t=await create(),command=await sendCommand(t);
 await rejects(approve({...command,revision:2}),'task_revision_conflict');
 await rejects(approve({...command,previewHash:'0'.repeat(64)}),'approval_preview_changed');
 await db.insert(schema.messages).values({providerId:'synthetic-other-outbound',contactId:contact.id,type:'SMS',direction:'outbound',actorType:'human',body:'Different current context',occurredAt:now});
 await rejects(approve(command),'approval_preview_changed');
 assert.equal((await approvals(t.id)).length,0);
 await db.insert(schema.messages).values({providerId:'synthetic-inbound',contactId:contact.id,type:'SMS',direction:'inbound',actorType:'customer',body:'Synthetic reply',occurredAt:now});
 const blocked=(await get(t.id)).task;assert.equal(blocked.status,'blocked');await rejects(approve(await sendCommand(blocked)),'blocked_task_requires_review');
 const internal=await create({kind:'callback',draft:null,title:'Internal'});await rejects(approve({command:'task.send',taskId:internal.id,revision:1,previewHash:(await get(internal.id)).previewHash,confirm:true}),'task_has_no_message_draft');
 const orphan=await create({contactId:null,title:'No contact'});await rejects(approve(await sendCommand(orphan)),'message_task_contact_required');
 const done=await create({title:'Cancelled'});const cancelled=(await call({command:'task.cancel',taskId:done.id,revision:1,reason:'Synthetic cancel'})).task;await rejects(approve(await sendCommand(cancelled)),'task_is_closed');
 assert.equal((await db.select().from(schema.operationApprovals)).length,0);
});
test('outside the send window nothing is approved and an edit rolls back',async()=>{
 const late=await create({draft:draft({sendWindowStart:at(-3),sendWindowEnd:at(-1)}),title:'Expired'});await rejects(approve(await sendCommand(late)),'draft_window_expired');
 const early=await create({draft:draft({sendWindowStart:at(2),sendWindowEnd:at(6)}),title:'Early'});await rejects(approve(await sendCommand(early)),'draft_window_not_open');
 const t=await create({title:'Edit to expired'});await rejects(approve(await sendCommand(t,{draft:draft({sendWindowStart:at(-3),sendWindowEnd:at(-2)})})),'draft_window_expired');
 assert.equal((await get(t.id)).task.revision,1);assert.equal((await get(t.id)).task.draftPayload.sendWindowEnd,at(12));
 const ok=await create({title:'Expires later'});const command=await sendCommand(ok);now=new Date(Date.parse(at(13)));await rejects(approve(command),'draft_window_expired');
 assert.equal((await db.select().from(schema.operationApprovals)).length,0);
});
// Sales used to record their own approval here; they now send only an owner's or manager's
// current approval of the exact revision (a salesperson must never approve a customer send).
test('humans only; sales send only their own task, and only on an owner or manager approval',async()=>{
 const mine=await create({},sales),theirs=await create({title:'Owner task'});
 await rejects(approve(await sendCommand(theirs),sales),'task_not_owned');
 await assert.rejects(approve(await sendCommand(theirs),integration),e=>e.code==='human_send_confirmation_required'&&e.status===403);
 await assert.rejects(call(await sendCommand(theirs),integration),e=>e.code==='human_send_confirmation_required'&&e.status===403);
 assert.equal(sent.length,0);
 await assert.rejects(approve(await sendCommand(mine),sales),e=>e.code==='human_manager_approval_required'&&e.status===403);assert.equal((await approvals(mine.id)).length,0);
 await approve(await sendCommand(theirs),manager);const [approval]=await approvals(theirs.id);assert.equal(approval.actorId,manager.id);
 await call({command:'tasks.approve',items:[{taskId:mine.id,revision:1,previewHash:(await get(mine.id)).previewHash}],expiresAt:at(6)},manager);
 const r=await approve(await sendCommand(mine),sales);assert.equal(r.approval.actorId,manager.id);assert.equal(r.approvedRevision,1);assert.equal(r.task.approvalStatus,'approved');assert.equal((await approvals(mine.id)).length,1);
 // An edit would need a new review, so a salesperson's edited send changes nothing.
 await assert.rejects(approve(await sendCommand(mine,{draft:draft({body:'Synthetic sales edit'})}),sales),e=>e.code==='human_manager_approval_required');assert.equal((await get(mine.id)).task.revision,1);
 // An approval recorded by the salesperson themselves (a row from before this rule) never counts.
 const other=await create({title:'Self approved'},sales);await call({command:'tasks.approve',items:[{taskId:other.id,revision:1,previewHash:(await get(other.id)).previewHash}],expiresAt:at(6)},manager);
 await db.update(schema.operationApprovals).set({actorId:sales.id}).where(eq(schema.operationApprovals.taskId,other.id));
 await assert.rejects(approve(await sendCommand(other),sales),e=>e.code==='human_manager_approval_required');
});
test('a rejection stops a salesperson’s send; an owner or manager send is their own explicit approval',async()=>{
 const mine=await create({},sales);
 await call({command:'tasks.approve',items:[{taskId:mine.id,revision:1,previewHash:(await get(mine.id)).previewHash}],expiresAt:at(6)},manager);
 await call({command:'task.reject',taskId:mine.id,revision:1,reason:'Synthetic manager rejection'},manager);
 await assert.rejects(approve(await sendCommand(mine),sales),e=>e.code==='draft_rejected_requires_review'&&e.status===409);
 assert.equal((await get(mine.id)).task.approvalStatus,'rejected');assert.equal((await approvals(mine.id)).length,1);assert.equal(sent.length,0);
 const r=await approve(await sendCommand(mine),manager);assert.equal(r.approval.actorId,manager.id);assert.equal(r.task.approvalStatus,'approved');assert.equal((await approvals(mine.id)).length,2);
});
test('once the approved revision’s send started, a second confirmer only gets the approval that covered it',async()=>{
 const t=await create(),first=await approve(await sendCommand(t));
 const [execution]=await db.insert(schema.communicationExecutions).values({requestId:taskSendRequestId(t.id,1),actorId:owner.id,contactId:contact.id,channel:'SMS',payloadHash:'synthetic',payload:{},createdAt:now}).returning();
 now=new Date(now.valueOf()+60000);
 const second=await approve(await sendCommand(t),manager);
 assert.equal(second.sendStarted,true);assert.equal(second.approval.id,first.approval.id);assert.equal(second.approvedRevision,1);assert.equal(second.edited,false);
 assert.equal((await approvals(t.id)).length,1);assert.equal((await get(t.id)).history.filter(e=>e.type==='draft.approved').length,1);
 // A different draft cannot ride on a send that already happened.
 await assert.rejects(approve(await sendCommand(t,{draft:draft({body:'Different synthetic text'})}),manager),e=>e.code==='message_send_already_started'&&e.details.executionId===execution.id);assert.equal((await get(t.id)).task.revision,1);
 // Reading the send back needs no open window, and records nothing new.
 now=new Date(Date.parse(NOW)+13*3600000);const late=await approve(await sendCommand(t),owner);assert.equal(late.approval.id,first.approval.id);assert.equal((await approvals(t.id)).length,1);
 // A send started for another revision is not this revision's.
 const u=await create({title:'Other revision',draft:draft({body:'Other synthetic text',sendWindowEnd:at(12)})});await db.insert(schema.communicationExecutions).values({requestId:taskSendRequestId(u.id,2),actorId:owner.id,contactId:contact.id,channel:'SMS',payloadHash:'synthetic-2',payload:{},createdAt:now});
 const fresh=await approve(await sendCommand(u),manager);assert.equal(fresh.sendStarted,undefined);assert.equal(fresh.approval.actorId,manager.id);
});
test('execute delegates task.send to the send adapter with the parsed command, and task.get reports availability',async()=>{
 const t=await create(),command=await sendCommand(t),requestId=randomUUID();
 const r=await call(command,owner,requestId);assert.equal(sent.length,1);assert.deepEqual(sent[0],{actor:owner,command,requestId});assert.equal(r.approvedRevision,1);
 assert.deepEqual((await get(t.id)).actionSend,{available:true,smsFromNumbers:['+15555551644','+15555551818']});
 const off=new OperationsService(db,{workspace:'egc',now:()=>now});assert.deepEqual((await off.execute(owner,{command:'task.get',taskId:t.id},randomUUID())).actionSend,{available:false,smsFromNumbers:[]});
 await assert.rejects(off.execute(owner,command,randomUUID()),e=>e.code==='action_send_disabled'&&e.status===503);
});
test('send readiness re-checks the approval, context, owner and window right before a send',async()=>{
 const t=await create(),r=await approve(await sendCommand(t)),approvalId=r.approval.id;
 const ready=await service.sendReadiness(owner,t.id,1,approvalId);assert.equal(ready.approval.id,approvalId);
 await rejects(service.sendReadiness(owner,t.id,2,approvalId),'task_revision_conflict');
 await rejects(service.sendReadiness(owner,t.id,1,randomUUID()),'send_approval_not_current');
 await rejects(service.sendReadiness(sales,t.id,1,approvalId),'task_not_owned');
 await call({command:'task.reject',taskId:t.id,revision:1,reason:'Synthetic rejection'});await rejects(service.sendReadiness(owner,t.id,1,approvalId),'send_approval_not_current');
 const u=await create({title:'Context moves'}),a=await approve(await sendCommand(u));await db.insert(schema.messages).values({providerId:'synthetic-new-outbound',contactId:contact.id,type:'SMS',direction:'outbound',actorType:'human',body:'Something else went out',occurredAt:now});
 await rejects(service.sendReadiness(owner,u.id,1,a.approval.id),'send_approval_not_current');
 const v=await create({title:'Window closes',draft:draft({body:'Other synthetic message'})}),b=await approve(await sendCommand(v));now=new Date(Date.parse(at(12)));await rejects(service.sendReadiness(owner,v.id,1,b.approval.id),'draft_window_expired');
});
test('execution start is recorded once per execution at the approved revision',async()=>{
 const t=await create(),r=await approve(await sendCommand(t));const [execution]=await db.insert(schema.communicationExecutions).values({requestId:randomUUID(),actorId:owner.id,contactId:contact.id,channel:'SMS',payloadHash:'synthetic',payload:{}}).returning();
 await Promise.all([1,2,3].map(()=>service.recordExecutionStarted(owner,t.id,r.approvedRevision,{executionId:execution.id})));
 const events=(await get(t.id)).history.filter(e=>e.type==='message.execution_started');assert.equal(events.length,1);assert.equal(events[0].evidence.executionId,execution.id);assert.equal(events[0].revision,1);
});

test('a sender change requires the new revision and fingerprint, never reuses the old approval',async()=>{
 const t=await create(),first=await approve(await sendCommand(t));
 assert.equal(first.approval.snapshot.task.draftPayload.fromNumber,'+15555551644');
 const changed=(await call({command:'task.edit',taskId:t.id,revision:1,changes:{draft:draft({fromNumber:'+15555551818'})}})).task;
 const detail=await get(t.id);assert.equal(changed.revision,2);assert.equal(changed.approvalStatus,'invalidated');assert.notEqual(detail.previewHash,first.approval.fingerprint);
 await rejects(service.sendReadiness(owner,t.id,1,first.approval.id),'task_revision_conflict');
 await rejects(service.sendReadiness(owner,t.id,2,first.approval.id),'send_approval_not_current');
 const second=await approve(await sendCommand(changed));assert.equal(second.approval.snapshot.task.draftPayload.fromNumber,'+15555551818');assert.notEqual(second.approval.id,first.approval.id);
});
test('legacy unsent SMS stays readable but cannot acquire a sender approval without an explicit edit',async()=>{
 const {fromNumber:_,...legacyDraft}=draft();const t=await create({draft:legacyDraft});const detail=await get(t.id);
 assert.equal(detail.task.draftPayload.fromNumber,undefined);assert.equal(detail.effectiveApproval,'pending');
 await rejects(approve(await sendCommand(t)),'sms_sender_required');
 await rejects(call({command:'tasks.approve',items:[{taskId:t.id,revision:1,previewHash:detail.previewHash}],expiresAt:at(6)}),'sms_sender_required');
 assert.equal((await approvals(t.id)).length,0);assert.equal((await get(t.id)).task.revision,1);
 const bad=await create({draft:draft({fromNumber:'+15555559999'}),title:'Unknown line'});await rejects(approve(await sendCommand(bad)),'sms_sender_not_configured');
 const updated=(await call({command:'task.edit',taskId:t.id,revision:1,changes:{draft:draft({fromNumber:'+15555551818'})}})).task;const reviewed=await approve(await sendCommand(updated));assert.equal(reviewed.approvedRevision,2);assert.equal(reviewed.task.draftPayload.fromNumber,'+15555551818');
});
