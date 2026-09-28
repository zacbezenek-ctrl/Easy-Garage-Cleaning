/** Actual service/database tests. Never execute against any non-loopback database. */
import test,{beforeEach,after} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {getDb,schema} from '@egc/database';
import {eq,sql} from 'drizzle-orm';
import {commandSchema,MESSAGE_TASK_KINDS,OperationsService,TASK_KINDS} from '../dist/index.js';
import {canonicalJson} from '@egc/lead-audit/operations-core';
const url=new URL(process.env.DATABASE_URL||'http://invalid');
if(process.env.EGC_OPERATIONS_TEST!=='isolated'||!['localhost','127.0.0.1'].includes(url.hostname)||url.pathname!=='/egc_operations_test'||!['postgres:','postgresql:'].includes(url.protocol))throw new Error('Only isolated loopback egc_operations_test is allowed');
const originalFetch=globalThis.fetch;globalThis.fetch=async()=>{throw new Error('Provider HTTP is disabled for this suite');};
const db=getDb();
const owner={id:'test-owner',role:'owner',kind:'human',workspace:'egc'};
const manager={...owner,id:'manager-2',role:'manager'};
const sales={...owner,id:'test-sales',role:'sales'};
const integration={id:'verified-grant',role:'integration',kind:'integration',workspace:'egc'};
const NOW='2026-10-01T15:00:00.000Z';
let now,service;
const at=(hours=1)=>new Date(now.valueOf()+hours*3600000).toISOString();
const base=(extra={})=>({title:'Synthetic internal callback',kind:'callback',assignedUserId:owner.id,dueAt:at(),completionCondition:'Record the attempted call and outcome',...extra});
const draft=(extra={})=>({channel:'sms',recipient:'+15555550100',subject:'',body:'Synthetic test only',sendWindowStart:at(),sendWindowEnd:at(12),...extra});
const call=(body,actor=owner,id=randomUUID())=>service.execute(actor,body,id);
const create=async(extra={},actor=owner,id=randomUUID())=>(await call({command:'task.create',task:base(extra)},actor,id)).task;
const queue=(extra={})=>call({command:'queue',view:'all',dueBefore:at(24),offset:0,limit:200,...extra});
const get=id=>call({command:'task.get',taskId:id});
const approve=async task=>{const detail=await get(task.id);return call({command:'tasks.approve',items:[{taskId:task.id,revision:detail.task.revision,previewHash:detail.previewHash}],expiresAt:at(10)});};
const rejects=async(p,code)=>assert.rejects(p,e=>e.code===code);
beforeEach(async()=>{
 await db.execute(sql`truncate operation_events,operation_approvals,operation_requests,operation_briefs,tasks,contacts cascade`);
 now=new Date(NOW);
 service=new OperationsService(db,{workspace:'egc',now:()=>now,resolveOwner:async id=>[owner.id,manager.id,sales.id].includes(id),resolvePortalJob:async id=>({id,revision:'portal-v1',type:'job',highlevelContactId:null,sourceWalkthroughId:'portal-visit-a',customer:'Synthetic',status:'scheduled'})});
});
after(async()=>{globalThis.fetch=originalFetch;await db.$client.end({timeout:5});});

test('create, edit and complete use one canonical task ID and append durable evidence',async()=>{
 const t=await create();assert.equal(t.revision,1);assert.equal(t.source,'operations');
 const edit=await call({command:'task.edit',taskId:t.id,revision:1,changes:{title:'Revised actual callback'}});assert.equal(edit.task.id,t.id);assert.equal(edit.task.revision,2);
 const done=await call({command:'task.complete',taskId:t.id,revision:2,outcome:'Called; customer requested a later quote'});assert.equal(done.task.id,t.id);assert.equal(done.task.revision,3);assert.equal(done.task.status,'completed');assert.equal(done.task.completionEvidence[0].kind,'staff_attestation');
 assert.equal((await queue()).total,0);const detail=await get(t.id);assert.ok(detail.history.some(e=>e.type==='task.complete'));assert.ok(detail.history.some(e=>e.type==='task.revision_recorded'));
});
test('ten concurrent retries create one row and one create event',async()=>{
 const requestId=randomUUID();const results=await Promise.all(Array.from({length:10},()=>create({},owner,requestId)));
 assert.equal(new Set(results.map(t=>t.id)).size,1);assert.equal((await queue()).total,1);
 const events=await db.select().from(schema.operationEvents);assert.equal(events.filter(e=>e.type==='task.created').length,1);
});
test('same idempotency key cannot be reused for a different payload',async()=>{
 const key=randomUUID();await create({},owner,key);await rejects(create({title:'Changed payload'},owner,key),'idempotency_key_payload_conflict');assert.equal((await queue()).total,1);
});
test('request results survive service reconstruction rather than memory-only dedupe',async()=>{
 const key=randomUUID(),t=await create({},owner,key);service=new OperationsService(db,{workspace:'egc',now:()=>now,resolveOwner:async()=>true});const replay=await create({},owner,key);assert.equal(replay.id,t.id);
});
test('competing editors only one expected revision can succeed',async()=>{
 const t=await create();const outcomes=await Promise.allSettled(['first','second'].map(title=>call({command:'task.edit',taskId:t.id,revision:t.revision,changes:{title}},owner)));
 assert.equal(outcomes.filter(x=>x.status==='fulfilled').length,1);assert.equal(outcomes.filter(x=>x.status==='rejected'&&x.reason.code==='task_revision_conflict').length,1);assert.equal((await get(t.id)).task.revision,2);
});
test('all new owners are verified, sales cannot assign or change other staff work',async()=>{
 await rejects(create({assignedUserId:'nonexistent'}),'owner_not_verified');await rejects(create({assignedUserId:owner.id},sales),'assignment_requires_manager');const t=await create();await rejects(call({command:'task.edit',taskId:t.id,revision:1,changes:{title:'Not mine'}},sales),'task_not_owned');
 const mine=await create({assignedUserId:sales.id},sales);assert.equal(mine.assignedUserId,sales.id);
});
test('crew and cross-workspace readers cannot access operational records',async()=>{
 const t=await create();for(const actor of [{...owner,role:'crew'},{...owner,role:'crew_lead'},{...owner,workspace:'other'}])await assert.rejects(call({command:'task.get',taskId:t.id},actor));
});
test('60-day-old booked customer commitments still appear without newest-lead filtering',async()=>{
 const [c]=await db.insert(schema.contacts).values({provider:'test',providerId:'old-booked',name:'Synthetic'}).returning();await db.insert(schema.leads).values({contactId:c.id,currentState:'BOOKED',createdAt:new Date(now-120*86400000)});
 for(let i=0;i<3;i++)await create({contactId:c.id,dueAt:at(-24),title:`Old callback ${i}`});const r=await queue({view:'due'});assert.equal(r.total,3);assert.ok(r.items.every(t=>t.contactId===c.id));
});
test('waiting customer uses explicit review time and preserves the same task on snooze',async()=>{
 const t=await create({waitingOn:'customer',reviewAt:at(48),dueAt:at(-20)});assert.equal((await queue({view:'due'})).total,0);const r=await call({command:'task.snooze',taskId:t.id,revision:1,until:at(72),reason:'Customer asked for Monday'});assert.equal(r.task.id,t.id);assert.equal(r.task.reviewAt,at(72));assert.equal(r.task.dueAt,at(-20));
});
test('deduplication key serializes distinct callers without silently merging different work',async()=>{
 const results=await Promise.allSettled([create({dedupeKey:'commitment-one'}),create({dedupeKey:'commitment-one'},manager)]);assert.equal(results.filter(x=>x.status==='fulfilled').length,1);assert.equal(results.filter(x=>x.status==='rejected'&&x.reason.code==='task_already_exists').length,1);
});
test('portal linkage is source-qualified and an ambiguous job association is refused',async()=>{
 const t=await create({portalJobId:'portal-job-a',portalVisitId:'portal-visit-a'});assert.equal(t.portalJobId,'portal-job-a');assert.equal(t.portalRevision,'portal-v1');assert.equal(t.jobId,null);
 await rejects(create({portalJobId:'portal-job-a',portalVisitId:'another-visit'}),'portal_visit_job_mismatch');
 const [c]=await db.insert(schema.contacts).values({provider:'test',providerId:'two-jobs'}).returning();const jobs=await db.insert(schema.jobs).values([{contactId:c.id},{contactId:c.id}]).returning();const a=await create({jobId:jobs[0].id}),b=await create({jobId:jobs[1].id});assert.notEqual(a.jobId,b.jobId);
 await rejects(create({jobId:jobs[0].id,portalJobId:'portal-job-a'}),'cross_store_job_mapping_not_verified');
});
test('portal outage propagates and does not create an unverified task',async()=>{
 service=new OperationsService(db,{workspace:'egc',resolveOwner:async()=>true});await rejects(create({portalJobId:'portal-job-a'}),'portal_identity_adapter_unavailable');assert.equal((await queue()).total,0);
});
test('dependencies require actual completion, not a cancelled or missing predecessor',async()=>{
 const first=await create(),next=await create({dependencies:[first.id]});await rejects(call({command:'task.complete',taskId:next.id,revision:1,outcome:'Tried to skip dependency'}),'dependencies_unresolved');await call({command:'task.complete',taskId:first.id,revision:1,outcome:'Predecessor actually done'});assert.equal((await call({command:'task.complete',taskId:next.id,revision:1,outcome:'Next step done'})).task.status,'completed');
});
test('exact approval is stored without sending, completing, or changing task content revision',async()=>{
 const t=await create({kind:'followup_message',draft:draft()});await approve(t);const d=await get(t.id);assert.equal(d.effectiveApproval,'approved');assert.equal(d.task.revision,1);assert.equal(d.task.status,'open');assert.equal(d.approvals[0].actorId,owner.id);assert.equal(d.approvals[0].snapshot.scope,'draft_review');assert.equal(d.externalExecution,false);assert.equal((await db.select().from(schema.messages)).length,0);assert.equal((await db.select().from(schema.outboxEvents)).length,0);
});
test('editing an approved payload increments revision and invalidates exact authorization',async()=>{
 const t=await create({kind:'followup_message',draft:draft()});const old=await get(t.id);await approve(t);const r=await call({command:'task.edit',taskId:t.id,revision:1,changes:{draft:draft({body:'A different quote'})}});assert.equal(r.task.revision,2);assert.equal(r.task.approvalStatus,'invalidated');assert.equal((await get(t.id)).effectiveApproval,'invalidated');await rejects(call({command:'tasks.approve',items:[{taskId:t.id,revision:1,previewHash:old.previewHash}],expiresAt:at(10)}),'task_revision_conflict');
});
test('inbound communication suspends obsolete draft and invalidates approval at database level',async()=>{
 const [c]=await db.insert(schema.contacts).values({provider:'test',providerId:'reply-case'}).returning();const t=await create({contactId:c.id,kind:'followup_message',draft:draft()});await approve(t);
 await db.insert(schema.messages).values({providerId:'reply-1',contactId:c.id,type:'SMS',direction:'inbound',actorType:'customer',body:'Please stop the planned followup',occurredAt:now});const d=await get(t.id);assert.equal(d.task.status,'blocked');assert.equal(d.task.approvalStatus,'invalidated');assert.equal(d.task.revision,2);await rejects(approve(d.task),'blocked_task_requires_review');
});
test('a communication arriving after preview prevents approval of unseen context',async()=>{
 const [c]=await db.insert(schema.contacts).values({provider:'test',providerId:'context-case'}).returning();const t=await create({contactId:c.id,kind:'followup_message',draft:draft()});const d=await get(t.id);await db.insert(schema.messages).values({providerId:'out-1',contactId:c.id,type:'SMS',direction:'outbound',actorType:'human',body:'A newer quote was discussed',occurredAt:now});await rejects(call({command:'tasks.approve',items:[{taskId:t.id,revision:1,previewHash:d.previewHash}],expiresAt:at(10)}),'approval_preview_changed');
});
test('batch approval is all-or-none and approves only listed revisions',async()=>{
 const a=await create({kind:'followup_message',draft:draft()}),b=await create({kind:'followup_message',draft:draft()});const da=await get(a.id),dbb=await get(b.id);await rejects(call({command:'tasks.approve',items:[{taskId:a.id,revision:1,previewHash:da.previewHash},{taskId:b.id,revision:1,previewHash:'0'.repeat(64)}],expiresAt:at(10)}),'approval_preview_changed');assert.equal((await get(a.id)).effectiveApproval,'pending');assert.equal((await db.select().from(schema.operationApprovals)).length,0);
 await call({command:'tasks.approve',items:[{taskId:b.id,revision:1,previewHash:dbb.previewHash}],expiresAt:at(10)});assert.equal((await get(a.id)).effectiveApproval,'pending');assert.equal((await get(b.id)).effectiveApproval,'approved');
});
test('integration grants may record internal outcomes but never human-manager approvals',async()=>{
 const t=await create({},integration);await call({command:'task.complete',taskId:t.id,revision:1,outcome:'Verified actual call attempt'},integration);const m=await create({kind:'followup_message',draft:draft()});const d=await get(m.id);await rejects(call({command:'tasks.approve',items:[{taskId:m.id,revision:1,previewHash:d.previewHash}],expiresAt:at(10)},integration),'human_manager_approval_required');
});
test('expired approvals reappear for review, can be renewed, and expired send windows cannot',async()=>{
 const t=await create({kind:'followup_message',draft:draft({sendWindowEnd:at(48)})});await approve(t);now=new Date(now.valueOf()+11*3600000);assert.equal((await get(t.id)).effectiveApproval,'invalidated_or_expired');assert.equal((await queue({view:'approvals'})).total,1);await approve((await get(t.id)).task);assert.equal((await get(t.id)).effectiveApproval,'approved');
 const m=await create({kind:'followup_message',draft:draft({sendWindowStart:at(-10),sendWindowEnd:at(-1)})});await rejects(approve(m),'draft_window_expired');
});
test('database guard blocks legacy writes to managed actions',async()=>{
 const t=await create();await assert.rejects(db.update(schema.tasks).set({title:'Unversioned legacy override'}).where(eq(schema.tasks.id,t.id)),e=>String(e.cause?.message||e.message).includes('managed_action_requires_operations_service'));assert.equal((await get(t.id)).task.title,t.title);
});
test('legacy task changes are revisioned and audited without inventing a human actor',async()=>{
 const [t]=await db.insert(schema.tasks).values({title:'Legacy operational task',dueAt:now,source:'mcp'}).returning();await db.update(schema.tasks).set({title:'Actual legacy update'}).where(eq(schema.tasks.id,t.id));const d=await get(t.id);assert.equal(d.task.revision,2);assert.ok(d.history.some(e=>e.actorId==='legacy-writer'&&e.actorKind==='integration'));
});
test('manual completion cannot assert message delivery or cash collection',async()=>{
 for(const kind of ['followup_message','verify_deposit']){const t=await create({kind,...(kind==='followup_message'?{draft:draft()}:{})});await assert.rejects(call({command:'task.complete',taskId:t.id,revision:1,outcome:'Just say it is done'}));assert.equal((await get(t.id)).task.status,'open');}
});
test('stored brief retains exact membership and separately shows later task changes',async()=>{
 const t=await create({dueAt:at(-1)});const saved=await call({command:'brief.create',dueBefore:at(24),timeZone:'America/Denver'});await call({command:'task.complete',taskId:t.id,revision:1,outcome:'Called customer and recorded result'});const r=await call({command:'brief.get',briefId:saved.briefId,offset:0,limit:50});assert.equal(r.brief.items[0].id,t.id);assert.equal(r.brief.items[0].revision,1);assert.equal(r.changes[0].current.status,'completed');assert.equal(r.brief.counts.totalDue,null);assert.equal(r.brief.counts.observedDue,1);assert.equal((await queue()).total,0);
});
test('brief tracks approval-only changes even if task content revision stays the same',async()=>{
 const t=await create({kind:'followup_message',draft:draft()});const saved=await call({command:'brief.create',dueBefore:at(24),timeZone:'America/Denver'});await approve(t);const r=await call({command:'brief.get',briefId:saved.briefId,offset:0,limit:50});assert.equal(r.changes[0].current.approvalStatus,'approved');assert.equal(r.changes[0].current.revision,1);
});
test('unregistered historical obligations remain explicitly unknown rather than zero',async()=>{
 const saved=await call({command:'brief.create',dueBefore:at(24),timeZone:'America/Denver'});const r=await call({command:'brief.get',briefId:saved.briefId,offset:0,limit:50});assert.equal(r.brief.counts.observedDue,0);assert.equal(r.brief.counts.totalDue,null);assert.ok(r.brief.coverage.some(c=>c.source==='communication_obligations'&&!c.complete));
});
test('brief snapshots paginate more than one page without changing saved counts',async()=>{
 await db.insert(schema.tasks).values(Array.from({length:501},(_,i)=>({title:`Legacy outstanding task ${i}`,source:'mcp',dueAt:now,assignedUserId:owner.id})));const saved=await call({command:'brief.create',dueBefore:at(24),timeZone:'America/Denver'});const r=await call({command:'brief.get',briefId:saved.briefId,offset:500,limit:50});assert.equal(r.brief.items.length,1);assert.equal(r.brief.counts.observedDue,501);assert.equal(r.brief.nextOffset,null);
});
const guardRejects=(p,code)=>assert.rejects(p,e=>String(e.cause?.message||e.message).includes(code));
const asOperations=write=>db.transaction(async tx=>{await tx.execute(sql`select set_config('egc.operations_actor','raw-guard-fixture',true)`);return write(tx);});
const attachments=[{kind:'portal_quote',url:'https://easygaragecleaning.com/portal/quote/synthetic-q1',label:'Your quote',refId:'quote-synthetic-q1'},{kind:'before_after_gallery',url:'https://easygaragecleaning.com/gallery/synthetic',label:'Before and after photos',refId:null}];
test('every v2 action kind persists through the service with its draft and approval requirement',async()=>{
 for(const kind of TASK_KINDS){const message=MESSAGE_TASK_KINDS.includes(kind);const t=await create({kind,title:`Synthetic ${kind}`,...(message?{draft:draft()}:{})});assert.equal(t.kind,kind);assert.equal(t.revision,1);assert.equal(t.source,'operations');assert.equal(t.approvalStatus,message?'pending':'not_required');assert.deepEqual(t.draftPayload,message?{...draft(),attachments:[]}:null);assert.equal(t.createdAt,NOW);}
 assert.equal((await queue()).total,TASK_KINDS.length);assert.equal((await queue({view:'approvals'})).total,MESSAGE_TASK_KINDS.length);
});
test('database guard rejects unknown kinds, drafts on internal kinds and draftless message kinds from raw writers',async()=>{
 const raw=values=>db.insert(schema.tasks).values({title:'Raw synthetic writer',assignedUserId:owner.id,dueAt:now,completionCondition:'Raw guard proof',source:'operations',...values}).returning();
 await guardRejects(raw({kind:'send_invoice'}),'managed_action_invariant_failed');
 for(const kind of ['schedule_job','callback'])await guardRejects(raw({kind,draftPayload:draft()}),'managed_action_draft_type_mismatch');
 for(const kind of MESSAGE_TASK_KINDS)await guardRejects(raw({kind}),'managed_action_draft_type_mismatch');
 await guardRejects(raw({kind:'deposit_reminder',draftPayload:draft(),status:'completed',completedAt:now}),'provider_evidence_completion_not_activated');
 const [job]=await raw({kind:'schedule_job'});assert.equal(job.revision,1);
 const q=await create({kind:'send_quote',draft:draft()});
 await guardRejects(asOperations(tx=>tx.update(schema.tasks).set({draftPayload:draft()}).where(eq(schema.tasks.id,job.id))),'managed_action_draft_type_mismatch');
 await guardRejects(asOperations(tx=>tx.update(schema.tasks).set({kind:'schedule_job'}).where(eq(schema.tasks.id,q.id))),'managed_action_draft_type_mismatch');
 await guardRejects(asOperations(tx=>tx.update(schema.tasks).set({kind:'send_invoice'}).where(eq(schema.tasks.id,q.id))),'managed_action_invariant_failed');
 assert.equal((await get(q.id)).task.kind,'send_quote');assert.equal((await get(job.id)).task.draftPayload,null);
});
test('a send_quote draft with attachments is approved exactly without sending and edits invalidate it',async()=>{
 const t=await create({kind:'send_quote',draft:draft({attachments})});assert.deepEqual(t.draftPayload.attachments,attachments);
 await approve(t);const d=await get(t.id);assert.equal(d.effectiveApproval,'approved');assert.equal(d.task.revision,1);assert.equal(d.task.status,'open');assert.deepEqual(d.approvals[0].snapshot.task.draftPayload.attachments,attachments);assert.equal(d.approvals[0].createdAt.toISOString(),NOW);
 assert.equal((await db.select().from(schema.messages)).length,0);assert.equal((await db.select().from(schema.communicationExecutions)).length,0);assert.equal((await db.select().from(schema.outboxEvents)).length,0);
 const r=await call({command:'task.edit',taskId:t.id,revision:1,changes:{draft:draft({attachments:[attachments[0]]})}});assert.equal(r.task.revision,2);assert.equal(r.task.approvalStatus,'invalidated');assert.equal((await get(t.id)).effectiveApproval,'invalidated');
});
test('internal v2 kinds complete by attestation while every message kind requires provider evidence',async()=>{
 const job=await create({kind:'schedule_job'});await rejects(call({command:'tasks.approve',items:[{taskId:job.id,revision:1,previewHash:(await get(job.id)).previewHash}],expiresAt:at(10)}),'task_has_no_message_draft');
 const done=await call({command:'task.complete',taskId:job.id,revision:1,outcome:'Booked the visit in the Hub schedule'});assert.equal(done.task.status,'completed');assert.equal(done.task.completionEvidence[0].kind,'staff_attestation');
 for(const kind of MESSAGE_TASK_KINDS){const t=await create({kind,draft:draft()});await rejects(call({command:'task.complete',taskId:t.id,revision:1,outcome:'Just say it was sent'}),'message_completion_requires_provider_evidence');assert.equal((await get(t.id)).task.status,'open');}
});
test('message drafts cannot be removed and internal kinds cannot gain a draft by edit',async()=>{
 const q=await create({kind:'answer_question',draft:draft()});await rejects(call({command:'task.edit',taskId:q.id,revision:1,changes:{draft:null}}),'message_draft_required');
 const j=await create({kind:'schedule_job'});await rejects(call({command:'task.edit',taskId:j.id,revision:1,changes:{draft:draft()}}),'unexpected_message_draft');
 assert.equal((await get(q.id)).task.revision,1);assert.equal((await get(j.id)).task.revision,1);
});
test('inbound communication blocks and invalidates every message kind but leaves internal work alone',async()=>{
 const [c]=await db.insert(schema.contacts).values({provider:'test',providerId:'v2-reply-case'}).returning();const messages=[];
 for(const kind of MESSAGE_TASK_KINDS){const t=await create({contactId:c.id,kind,draft:draft()});await approve(t);messages.push(t);}
 const internal=await create({contactId:c.id,kind:'schedule_job'});
 await db.insert(schema.messages).values({providerId:'v2-reply-1',contactId:c.id,type:'SMS',direction:'inbound',actorType:'customer',body:'Synthetic customer reply',occurredAt:now});
 for(const t of messages){const d=await get(t.id);assert.equal(d.task.status,'blocked',t.kind);assert.equal(d.task.approvalStatus,'invalidated',t.kind);await rejects(approve(d.task),'blocked_task_requires_review');}
 const i=await get(internal.id);assert.equal(i.task.status,'open');assert.equal(i.task.revision,1);
});
const sha=value=>createHash('sha256').update(canonicalJson(value)).digest('hex');
test('attachment URLs are stored, approved and fingerprinted only in canonical form',async()=>{
 const t=await create({kind:'send_before_afters',draft:draft({attachments:[{kind:'before_after_gallery',url:'HTTPS://EasyGarageCleaning.com\\gallery\\synthetic-1',label:'Before and after photos'}]})});
 const canonical='https://easygaragecleaning.com/gallery/synthetic-1';assert.deepEqual(t.draftPayload.attachments,[{kind:'before_after_gallery',url:canonical,label:'Before and after photos',refId:null}]);
 const [stored]=await db.select().from(schema.tasks).where(eq(schema.tasks.id,t.id));assert.equal(stored.draftPayload.attachments[0].url,canonical);
 await approve(t);const d=await get(t.id),[approval]=d.approvals;assert.equal(d.effectiveApproval,'approved');
 // The approval fingerprint is the hash of a snapshot that carries every approved link.
 assert.deepEqual(approval.snapshot.task.draftPayload.attachments,t.draftPayload.attachments);assert.equal(approval.fingerprint,d.previewHash);assert.equal(sha(approval.snapshot),approval.fingerprint);
 const swapped=structuredClone(approval.snapshot);swapped.task.draftPayload.attachments[0].url='https://easygaragecleaning.com/gallery/synthetic-2';assert.notEqual(sha(swapped),approval.fingerprint);
 await rejects(create({kind:'send_quote',draft:draft({attachments:[{kind:'url',url:'https://A.example.com/x',label:'One'},{kind:'url',url:'https://a.example.com/x',label:'Same link'}]})}),'invalid_command');
 await rejects(create({kind:'send_quote',draft:draft({attachments:[{kind:'url',url:'https://localhost/x',label:'Loopback'}]})}),'invalid_command');
 assert.equal((await queue()).total,1);
});
test('a draft request first sent before action kinds v2 still replays after the deploy',async()=>{
 const raw={command:'task.create',task:base({kind:'followup_message',title:'Synthetic pre-deploy followup',draft:draft()})};
 // The pre-v2 parser produced the same command without the attachments key, and the old
 // service stored sha256(canonical({actor,command})) of exactly that.
 const parsed=commandSchema.parse(raw),{attachments:_,...legacyDraft}=parsed.task.draft,legacyCommand={...parsed,task:{...parsed.task,draft:legacyDraft}};
 const actor={id:owner.id,kind:owner.kind,role:owner.role,workspace:owner.workspace},legacyDigest=sha({actor,command:legacyCommand});
 const requestId=randomUUID(),saved={ok:true,task:{id:'00000000-0000-4000-8000-00000000d0c5',title:'Saved before the deploy'}};
 await db.insert(schema.operationRequests).values({workspaceId:'egc',actorId:owner.id,requestId,digest:legacyDigest,response:saved});
 for(const body of [raw,{...raw,task:{...raw.task,draft:{...raw.task.draft,attachments:[]}}}]){const r=await call(body,owner,requestId);assert.equal(r.replayed,true);assert.deepEqual(r.task,saved.task);}
 await rejects(call({...raw,task:{...raw.task,draft:{...raw.task.draft,attachments:[{kind:'url',url:'https://easygaragecleaning.com/x',label:'New link'}]}}},owner,requestId),'idempotency_key_payload_conflict');
 assert.equal((await queue()).total,0);
 // New requests without attachments keep the pre-v2 digest, so a rollback also replays them.
 const fresh=randomUUID();await call(raw,owner,fresh);const [row]=await db.select().from(schema.operationRequests).where(eq(schema.operationRequests.requestId,fresh));assert.equal(row.digest,legacyDigest);
});
