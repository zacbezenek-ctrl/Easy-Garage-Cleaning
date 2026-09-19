/** Actual service/database tests. Never execute against any non-loopback database. */
import test,{beforeEach,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {getDb,schema} from '@egc/database';
import {eq,sql} from 'drizzle-orm';
import {OperationsService} from '../dist/index.js';
const url=new URL(process.env.DATABASE_URL||'http://invalid');
if(process.env.EGC_OPERATIONS_TEST!=='isolated'||!['localhost','127.0.0.1'].includes(url.hostname)||url.pathname!=='/egc_operations_test'||!['postgres:','postgresql:'].includes(url.protocol))throw new Error('Only isolated loopback egc_operations_test is allowed');
const originalFetch=globalThis.fetch;globalThis.fetch=async()=>{throw new Error('Provider HTTP is disabled for this suite');};
const db=getDb();
const owner={id:'test-owner',role:'owner',kind:'human',workspace:'egc'};
const manager={...owner,id:'manager-2',role:'manager'};
const sales={...owner,id:'test-sales',role:'sales'};
const integration={id:'verified-grant',role:'integration',kind:'integration',workspace:'egc'};
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
 now=new Date();
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
