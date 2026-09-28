/** One-tap Action Center send end to end against the real guards, with a fake provider and a fixed clock. */
import test,{beforeEach,after,mock} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {eq,sql} from 'drizzle-orm';
import {getDb,schema} from '@egc/database';
import {OperationsService,normalizedCommunicationPayload,reconcileCommunication} from '@egc/operations';
import {createActionSender,taskSendRequestId} from '../dist/action-send.js';
const url=new URL(process.env.DATABASE_URL||'http://invalid');
if(process.env.EGC_OPERATIONS_TEST!=='isolated'||!['localhost','127.0.0.1'].includes(url.hostname)||url.pathname!=='/egc_operations_test')throw new Error('Only isolated loopback egc_operations_test is allowed');
globalThis.fetch=async()=>{throw new Error('External HTTP forbidden');};
const db=getDb(),NOW='2026-10-01T15:00:00.000Z';
const owner={id:'synthetic-owner',role:'owner',kind:'human',workspace:'egc'},manager={...owner,id:'synthetic-manager',role:'manager'},sales={...owner,id:'synthetic-sales',role:'sales'};
const integration={id:'synthetic-grant',role:'integration',kind:'integration',workspace:'egc'};
const links=[{kind:'portal_quote',url:'https://easygaragecleaning.com/portal/quote/synthetic-1',label:'Your quote',refId:null},{kind:'payment_link',url:'https://pay.example.com/synthetic-deposit',label:'Pay the deposit',refId:'job-synthetic-1'}];
let now,service,provider,contact,lead,saved,live;
const at=hours=>new Date(now.valueOf()+hours*3600000).toISOString();
const draft=(extra={})=>({channel:'sms',recipient:'+15555550100',subject:'',body:'Synthetic approved quote message',sendWindowStart:at(-1),sendWindowEnd:at(12),attachments:links,...extra});
const call=(body,actor=owner,id=randomUUID())=>service.execute(actor,body,id);
const create=async(extra={},actor=owner)=>(await call({command:'task.create',task:{title:'Send synthetic quote',kind:'send_quote',assignedUserId:actor.id,dueAt:at(1),contactId:contact.id,completionCondition:'Verified delivery of the exact quote message',draft:draft(),...extra}},actor)).task;
const get=id=>call({command:'task.get',taskId:id});
const sendCommand=async(task,extra={})=>({command:'task.send',taskId:task.id,revision:task.revision,previewHash:(await get(task.id)).previewHash,confirm:true,...extra});
const rejects=(p,code,status)=>assert.rejects(p,e=>e.code===code&&(status===undefined||e.status===status),code);
const executions=()=>db.select().from(schema.communicationExecutions);
const history=async id=>(await get(id)).history;
const sends=()=>provider.sendMessage.mock.callCount();
const approvals=id=>db.select().from(schema.operationApprovals).where(eq(schema.operationApprovals.taskId,id));
const managerApproves=async task=>call({command:'tasks.approve',items:[{taskId:task.id,revision:task.revision,previewHash:(await get(task.id)).previewHash}],expiresAt:at(6)},manager);
beforeEach(async()=>{
 await db.execute(sql`set client_min_messages to warning`);
 await db.execute(sql`truncate operation_events,operation_approvals,operation_requests,operation_briefs,tasks,communication_executions,audit_logs,messages,conversations,leads,contacts cascade`);
 now=new Date(NOW);saved=new Map();live={id:'synthetic-provider',locationId:'synthetic-location',phone:'+1 555-555-0100',email:'synthetic@example.invalid'};
 [contact]=await db.insert(schema.contacts).values({provider:'ghl',providerId:'synthetic-provider',phone:'+15555550100',email:'synthetic@example.invalid'}).returning();
 [lead]=await db.insert(schema.leads).values({contactId:contact.id}).returning();
 provider={locationId:'synthetic-location',
  getContact:mock.fn(async()=>({contact:{...live}})),
  sendMessage:mock.fn(async payload=>{const id='synthetic-message-'+(saved.size+1);saved.set(id,{id,contactId:payload.contactId,body:payload.message,direction:'outbound',status:'delivered',messageType:payload.type==='SMS'?'TYPE_SMS':'TYPE_EMAIL',conversationId:'synthetic-conversation',to:payload.toNumber,emailTo:payload.emailTo,subject:payload.subject,dateAdded:now.toISOString()});return{messageId:id,conversationId:'synthetic-conversation'};}),
  getMessage:mock.fn(async id=>{const message=saved.get(id);if(!message)throw new Error('not found');return{message};})};
 const sender=createActionSender({service:()=>service,provider:()=>provider,now:()=>now,db:()=>db});
 service=new OperationsService(db,{workspace:'egc',now:()=>now,resolveOwner:async()=>true,sendTaskMessage:(...args)=>sender(...args)});
});
// Leave no rows behind: later suites clean up with plain deletes and must not trip over these.
after(async()=>{await db.execute(sql`truncate operation_events,operation_approvals,operation_requests,operation_briefs,tasks,communication_executions,audit_logs,messages,conversations,leads,contacts cascade`);await db.$client.end({timeout:5});});
test('an approved send carries the exact attachment URLs, sends once and completes from verified delivery through the database guard',async()=>{
 const t=await create(),command=await sendCommand(t),r=await call(command);
 assert.equal(sends(),1);const payload=provider.sendMessage.mock.calls[0].arguments[0];
 assert.deepEqual(payload,{type:'SMS',contactId:'synthetic-provider',message:t.draftPayload.body,toNumber:'+15555550100',attachments:links.map(l=>l.url)});
 assert.equal(r.ok,true);assert.equal(r.sent,true);assert.equal(r.delivered,true);assert.equal(r.mirrored,true);assert.deepEqual(r.completion,{ok:true,status:'completed'});
 const [execution]=await executions();assert.equal(execution.requestId,taskSendRequestId(t.id,1));assert.equal(execution.actorId,owner.id);assert.deepEqual(execution.payload.attachments,links.map(l=>l.url));
 assert.equal(execution.payloadHash,normalizedCommunicationPayload(payload).hash);const {attachments:_,...bare}=payload;assert.notEqual(execution.payloadHash,normalizedCommunicationPayload(bare).hash);
 assert.equal(execution.createdAt.toISOString(),NOW);assert.equal(execution.verifiedAt.toISOString(),NOW);
 const detail=await get(t.id);assert.equal(detail.task.status,'completed');const proof=detail.task.completionEvidence[0];assert.equal(proof.kind,'verified_communication');assert.equal(proof.executionId,execution.id);assert.equal(proof.approvedRevision,1);
 const types=detail.history.map(e=>e.type);for(const type of ['draft.approved','message.execution_started','task.complete_from_message'])assert.ok(types.includes(type),type);
 assert.equal(detail.history.find(e=>e.type==='message.execution_started').evidence.executionId,execution.id);
 const [mirror]=await db.select().from(schema.messages);assert.equal(mirror.providerId,'synthetic-message-1');assert.equal(mirror.direction,'outbound');
 assert.ok((await db.select().from(schema.auditLogs)).some(a=>a.action==='communication.authorized'&&a.source==='operations'&&a.actor===owner.id));
});
test('a duplicate tap with the same request ID sends once, including concurrent taps',async()=>{
 const t=await create(),command=await sendCommand(t),requestId=randomUUID();
 const results=await Promise.allSettled(Array.from({length:5},()=>call(command,owner,requestId)));
 // A tap racing the first one may see an unconfirmed claim or a changed task (the readiness
 // re-check now runs after the live preflight, so it can also see the completed revision); none may send.
 for(const r of results)if(r.status==='rejected')assert.ok(['message_outcome_unknown','send_approval_not_current','approval_preview_changed','task_is_closed','task_revision_conflict'].includes(r.reason.code),r.reason.code);
 const again=await call(command,owner,requestId);assert.equal(again.ok,true);assert.equal(again.delivered,true);assert.equal(again.duplicatePrevented,true);assert.equal(again.completion.ok,true);
 assert.equal(sends(),1);assert.equal((await executions()).length,1);assert.equal((await get(t.id)).task.completionEvidence.length,1);
 assert.equal((await history(t.id)).filter(e=>e.type==='message.execution_started').length,1);
});
test('a new tap or another manager on the same approved revision reconciles and never sends again',async()=>{
 const t=await create();provider.sendMessage.mock.mockImplementation(async payload=>{const id='synthetic-message-1';saved.set(id,{id,contactId:payload.contactId,body:payload.message,direction:'outbound',status:'sent',messageType:'TYPE_SMS',conversationId:'synthetic-conversation',to:payload.toNumber,dateAdded:now.toISOString()});return{messageId:id};});
 const command=await sendCommand(t),first=await call(command);assert.equal(first.delivered,false);assert.equal(first.completion,null);assert.equal((await get(t.id)).task.status,'open');
 // The sent message changed the conversation, so the old preview is stale: nothing reaches the provider.
 const contactsBefore=provider.getContact.mock.callCount();await rejects(call(command),'approval_preview_changed',409);assert.equal(provider.getContact.mock.callCount(),contactsBefore);
 const fresh=await sendCommand((await get(t.id)).task),second=await call(fresh,manager);
 assert.equal(second.ok,true);assert.equal(second.duplicatePrevented,true);assert.equal(second.executionId,first.executionId);assert.equal(sends(),1);assert.equal((await executions()).length,1);
 // The second confirmer records no approval of their own: the owner's covered the send.
 assert.equal(second.approvalId,first.approvalId);assert.equal((await approvals(t.id)).length,1);
 saved.get('synthetic-message-1').status='delivered';const third=await call(fresh,manager);assert.equal(third.delivered,true);assert.equal(third.completion.ok,true);assert.equal(sends(),1);assert.equal((await get(t.id)).task.status,'completed');
});
test('a provider timeout is message_outcome_unknown, retries never resend, and provider-ID reconciliation completes it',async()=>{
 const t=await create(),command=await sendCommand(t),requestId=randomUUID();
 provider.sendMessage.mock.mockImplementation(async payload=>{saved.set('synthetic-late',{id:'synthetic-late',contactId:payload.contactId,body:payload.message,direction:'outbound',status:'delivered',messageType:'TYPE_SMS',conversationId:'synthetic-conversation',to:payload.toNumber,dateAdded:now.toISOString()});throw new Error('The operation was aborted due to timeout token=synthetic-secret');});
 await assert.rejects(call(command,owner,requestId),e=>e.code==='message_outcome_unknown'&&e.status===503&&e.details.retryMode==='reconcile_only'&&!JSON.stringify(e.details).includes('synthetic-secret'));
 const [unknown]=await executions();assert.equal(unknown.status,'unknown');assert.equal(unknown.providerMessageId,null);
 await rejects(call(command,owner,requestId),'message_outcome_unknown',503);
 await rejects(call(command,owner,randomUUID()),'message_outcome_unknown',503);
 await rejects(call(command,manager,randomUUID()),'message_outcome_unknown',503);
 assert.equal(sends(),1);assert.equal((await executions()).length,1);assert.equal((await get(t.id)).task.status,'open');
 assert.equal((await reconcileCommunication(unknown.id,'synthetic-late','synthetic-reviewer',provider,db,{now:()=>now,source:'operations'})).ok,true);
 const done=await call(command,owner,requestId);assert.equal(done.delivered,true);assert.equal(done.completion.ok,true);assert.equal(sends(),1);assert.equal((await get(t.id)).task.status,'completed');
});
test('a do-not-contact customer is refused with no send',async()=>{
 const t=await create();await db.update(schema.leads).set({doNotContact:true}).where(eq(schema.leads.id,lead.id));
 await assert.rejects(call(await sendCommand(t)),e=>e.code==='contact_do_not_contact'&&e.status===409&&e.details.sent===false);
 await db.update(schema.leads).set({doNotContact:false}).where(eq(schema.leads.id,lead.id));live.dndSettings={SMS:{status:'active'}};
 await rejects(call(await sendCommand((await get(t.id)).task)),'contact_do_not_contact',409);
 live={...live,dndSettings:{},phone:'+15555550199'};await rejects(call(await sendCommand((await get(t.id)).task)),'verified_contact_phone_required',409);
 live={...live,phone:'+15555550100',id:'another-provider-contact'};await rejects(call(await sendCommand((await get(t.id)).task)),'message_contact_identity_mismatch',409);
 assert.equal(sends(),0);assert.equal((await executions()).length,0);assert.equal((await get(t.id)).task.status,'open');
});
test('stale revision or preview is a 409 with no provider call; so is a closed window',async()=>{
 const t=await create(),command=await sendCommand(t);
 await rejects(call({...command,revision:2}),'task_revision_conflict',409);
 await rejects(call({...command,previewHash:'0'.repeat(64)}),'approval_preview_changed',409);
 const late=await create({draft:draft({sendWindowStart:at(-4),sendWindowEnd:at(-1)}),title:'Expired window'});await rejects(call(await sendCommand(late)),'draft_window_expired',409);
 const early=await create({draft:draft({sendWindowStart:at(3),sendWindowEnd:at(8),body:'Early synthetic message'}),title:'Future window'});await rejects(call(await sendCommand(early)),'draft_window_not_open',409);
 assert.equal(provider.getContact.mock.callCount(),0);assert.equal(sends(),0);assert.equal((await executions()).length,0);
});
// Sales used to approve their own send here; they now send only an owner's or manager's
// current approval, and never after a rejection.
test('integrations get 403, sales cannot send someone else’s task, and sales send their own only on a manager approval',async()=>{
 const t=await create();await rejects(call(await sendCommand(t),integration),'human_send_confirmation_required',403);
 await rejects(call(await sendCommand(t),sales),'task_not_owned',403);
 assert.equal(provider.getContact.mock.callCount(),0);assert.equal(sends(),0);
 await call({command:'task.cancel',taskId:t.id,revision:1,reason:'Synthetic cleanup'});
 const mine=await create({title:'Sales-owned send'},sales);await rejects(call(await sendCommand(mine),sales),'human_manager_approval_required',403);
 assert.equal(provider.getContact.mock.callCount(),0);assert.equal(sends(),0);assert.equal((await approvals(mine.id)).length,0);
 await managerApproves(mine);const r=await call(await sendCommand(mine),sales);assert.equal(r.delivered,true);assert.equal(r.completion.ok,true);assert.equal(sends(),1);
 const [approval]=await approvals(mine.id);assert.equal(approval.actorId,manager.id);assert.equal(r.approvalId,approval.id);
 assert.equal((await executions())[0].actorId,sales.id);
});
test('a manager’s rejection stops a salesperson’s send with nothing sent',async()=>{
 const mine=await create({},sales);await managerApproves(mine);await call({command:'task.reject',taskId:mine.id,revision:1,reason:'Synthetic manager rejection'},manager);
 await rejects(call(await sendCommand(mine),sales),'draft_rejected_requires_review',409);
 await rejects(call(await sendCommand(mine,{draft:draft({body:'Synthetic sales rewrite'})}),sales),'draft_rejected_requires_review',409);
 assert.equal(provider.getContact.mock.callCount(),0);assert.equal(sends(),0);assert.equal((await executions()).length,0);
 const current=(await get(mine.id)).task;assert.equal(current.approvalStatus,'rejected');assert.equal(current.revision,1);assert.equal(current.status,'open');
});
test('a second person confirming a send that is pending verification only reconciles, and delivery completes the task',async()=>{
 const t=await create(),command=await sendCommand(t);provider.getMessage.mock.mockImplementation(async()=>{throw new Error('read timeout');});
 const pending=await call(command);assert.equal(pending.verification,'pending');assert.equal((await get(t.id)).task.approvalStatus,'approved');
 // A minute later read-back works again and a manager taps Send now on the unchanged approved task.
 now=new Date(now.valueOf()+60000);provider.getMessage.mock.mockImplementation(async id=>({message:saved.get(id)}));
 const again=await call(await sendCommand((await get(t.id)).task),manager);
 assert.equal(again.delivered,true);assert.deepEqual(again.completion,{ok:true,status:'completed'});assert.equal(again.approvalId,pending.approvalId);assert.equal(again.executionId,pending.executionId);
 assert.equal(sends(),1);assert.equal((await executions()).length,1);
 const all=await approvals(t.id);assert.equal(all.length,1);assert.equal(all[0].actorId,owner.id);
 const detail=await get(t.id);assert.equal(detail.task.status,'completed');assert.equal(detail.task.completionEvidence[0].approvalId,all[0].id);
 assert.equal(detail.history.filter(e=>e.type==='draft.approved').length,1);assert.equal(detail.history.filter(e=>e.type==='message.execution_started').length,1);
 await rejects(call(command),'task_revision_conflict',409);await rejects(call(await sendCommand(detail.task)),'task_is_closed',409);assert.equal(sends(),1);
});
test('a customer reply that lands during the live recipient check stops the send before the provider',async()=>{
 const t=await create();
 provider.getContact.mock.mockImplementation(async()=>{await db.insert(schema.messages).values({providerId:'synthetic-reply',contactId:contact.id,type:'SMS',direction:'inbound',actorType:'customer',body:'Synthetic: please wait',occurredAt:now});return{contact:{...live}};});
 await assert.rejects(call(await sendCommand(t)),e=>['task_revision_conflict','blocked_task_requires_review','send_approval_not_current'].includes(e.code)&&e.status===409);
 assert.equal(provider.getContact.mock.callCount(),1);assert.equal(sends(),0);assert.equal((await executions()).length,0);
 const current=(await get(t.id)).task;assert.equal(current.status,'blocked');assert.equal(current.approvalStatus,'invalidated');
 assert.equal((await history(t.id)).filter(e=>e.type==='message.execution_started').length,0);
});
test('a rejection that lands during the live recipient check stops the send before the provider',async()=>{
 const t=await create();
 provider.getContact.mock.mockImplementation(async()=>{await call({command:'task.reject',taskId:t.id,revision:1,reason:'Synthetic rejection during the check'},manager);return{contact:{...live}};});
 await rejects(call(await sendCommand(t)),'send_approval_not_current',409);
 assert.equal(sends(),0);assert.equal((await executions()).length,0);assert.equal((await get(t.id)).task.approvalStatus,'rejected');
});
test('an edited draft is sent as the new revision the approval covers, and completes',async()=>{
 const t=await create(),edited=draft({body:'Synthetic edited quote message',attachments:[links[1]]}),r=await call(await sendCommand(t,{draft:edited}));
 assert.equal(r.edited,true);assert.equal(r.approvedRevision,2);assert.equal(r.completion.ok,true);
 assert.deepEqual(provider.sendMessage.mock.calls[0].arguments[0],{type:'SMS',contactId:'synthetic-provider',message:'Synthetic edited quote message',toNumber:'+15555550100',attachments:[links[1].url]});
 const [execution]=await executions();assert.equal(execution.requestId,taskSendRequestId(t.id,2));
 const [approval]=await db.select().from(schema.operationApprovals).where(eq(schema.operationApprovals.taskId,t.id));assert.equal(approval.taskRevision,2);assert.equal(approval.snapshot.task.draftPayload.body,'Synthetic edited quote message');
 const done=(await get(t.id)).task;assert.equal(done.status,'completed');assert.equal(done.completionEvidence[0].approvedRevision,2);assert.equal(done.draftPayload.body,'Synthetic edited quote message');
});
test('an email with no links sends the approved subject and recipient and completes',async()=>{
 const t=await create({draft:draft({channel:'email',recipient:'synthetic@example.invalid',subject:'Your synthetic quote',attachments:[]})}),r=await call(await sendCommand(t));
 assert.deepEqual(provider.sendMessage.mock.calls[0].arguments[0],{type:'Email',contactId:'synthetic-provider',message:t.draftPayload.body,subject:'Your synthetic quote',emailTo:'synthetic@example.invalid'});
 assert.equal(r.delivered,true);assert.equal(r.completion.ok,true);assert.equal('attachments' in (await executions())[0].payload,false);
});
test('a read-back outage reports a pending verification, then a retry verifies without sending',async()=>{
 const t=await create(),command=await sendCommand(t),requestId=randomUUID();provider.getMessage.mock.mockImplementation(async()=>{throw new Error('read timeout');});
 const pending=await call(command,owner,requestId);assert.equal(pending.ok,true);assert.equal(pending.verification,'pending');assert.equal(pending.completion,null);assert.equal((await get(t.id)).task.status,'open');
 provider.getMessage.mock.mockImplementation(async id=>({message:saved.get(id)}));
 const verified=await call(command,owner,requestId);assert.equal(verified.delivered,true);assert.equal(verified.completion.ok,true);assert.equal(sends(),1);
});
