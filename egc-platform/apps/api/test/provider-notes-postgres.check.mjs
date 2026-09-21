import test,{beforeEach,after} from 'node:test';
import assert from 'node:assert/strict';
import {eq,sql} from 'drizzle-orm';
import {getDb,schema} from '@egc/database';
import {processNoteOutbox,OperationsService} from '@egc/operations';
import {ensureProviderNote,sixMonthCheckin} from '../dist/provider-notes.js';
const url=new URL(process.env.DATABASE_URL||'http://invalid');
if(process.env.EGC_OPERATIONS_TEST!=='isolated'||!['localhost','127.0.0.1'].includes(url.hostname)||url.pathname!=='/egc_operations_test')throw new Error('Only isolated loopback egc_operations_test is allowed');
globalThis.fetch=async()=>{throw new Error('External HTTP forbidden');};
const db=getDb(),actor={id:'hub-note:fixture-staff',role:'integration',kind:'integration',workspace:'egc'};
const input={command:'provider.note.ensure',requestId:'fixture-logical-note',portalJobId:'fixture-job',providerContactId:'fixture-contact',scope:'game_plan',title:'Synthetic brief',body:'Keep synthetic bicycle'};
let portal,provider,source,notes,writes,linked,service,owner;
beforeEach(async()=>{
 await db.execute(sql`truncate outbox_events,audit_logs,operation_requests,operation_events,operation_approvals,tasks cascade`);notes=[];writes=0;linked=0;owner='verified-hub-owner';
 source={id:input.portalJobId,type:'job',revision:'source-v1',highlevelContactId:input.providerContactId,customerId:'fixture-customer'};
 portal=async(actor,command)=>{if(command.command==='portal.job')return{authority:'employee_hub',job:source};if(command.command==='portal.rules')return{authority:'employee_hub',inboundResponse:{ownerId:owner}};if(command.command==='schedule.link_customer'){linked++;assert.equal(actor.kind,'integration');assert.equal(command.expectedRevision,'source-v1');return{authority:'employee_hub',visit:{portalVisitId:input.portalJobId,portalCustomerId:'fixture-customer',highlevelContactId:input.providerContactId}};}throw new Error('Unexpected portal command');};
 service=new OperationsService(db,{workspace:'egc',resolveOwner:async id=>id===owner,resolvePortalJob:async()=>({...source,customer:null,status:'completed',sourceWalkthroughId:null})});
 provider={locationId:'fixture-location',getContact:async()=>({contact:{id:input.providerContactId,locationId:'fixture-location'}}),getContactNotes:async()=>({notes}),createContactNote:async(id,body)=>{writes++;assert.equal(id,input.providerContactId);notes.push({id:'note-fixture',body});return{note:{id:'note-fixture'}};}};
});
after(async()=>db.$client.end({timeout:5}));
const call=(extra={})=>ensureProviderNote(actor,{...input,...extra},portal,{db,provider,service});
test('native duplicate requests and scheduled worker use one durable intent and verified note',async()=>{
 const results=await Promise.all(Array.from({length:8},()=>call()));assert.ok(results.some(r=>r.ok));assert.equal(writes,1);assert.equal((await db.select().from(schema.outboxEvents)).length,1);
 const replay=await call();assert.equal(replay.ok,true);assert.equal(replay.noteId,'note-fixture');await processNoteOutbox(provider,db);assert.equal(writes,1);
 assert.equal((await db.select().from(schema.auditLogs)).filter(r=>r.action==='provider.note.authorized').length,1);
});
test('same logical request with different content fails and separate note scopes remain distinct',async()=>{
 await call();await assert.rejects(call({body:'Changed synthetic text'}),e=>e.code==='provider_note_request_conflict');assert.equal(writes,1);
 await call({scope:'lifecycle_ready'});assert.equal(writes,2);assert.equal((await db.select().from(schema.outboxEvents)).length,2);
});
test('uncertain native request is recovered by worker without another provider POST',async()=>{
 let reads=0;provider.getContactNotes=async()=>{if(++reads===2)throw new Error('Provider timeout secret=private');return{notes};};
 const first=await call();assert.equal(first.ok,false);assert.equal(first.error,'provider_note_pending');assert.equal(writes,1);
 const [event]=await db.select().from(schema.outboxEvents);await db.update(schema.outboxEvents).set({availableAt:new Date(Date.now()-1000)}).where(eq(schema.outboxEvents.id,event.id));
 await processNoteOutbox(provider,db);const replay=await call();assert.equal(replay.ok,true);assert.equal(replay.noteId,'note-fixture');assert.equal(writes,1);assert.ok(!JSON.stringify(await db.select().from(schema.outboxEvents)).includes('secret=private'));
});
test('wrong source/contact fails before intent; incomplete exact links require verified provider bridge',async()=>{
 source.highlevelContactId='wrong-contact';await assert.rejects(call(),e=>e.code==='provider_note_contact_conflict');assert.equal((await db.select().from(schema.outboxEvents)).length,0);
 source.highlevelContactId=null;source.customerId=null;assert.equal((await call()).ok,true);assert.equal(linked,1);assert.equal(writes,1);
});
test('provider identity mismatch and unresolved linkage cannot send a note',async()=>{
 source.highlevelContactId=null;source.customerId=null;provider.getContact=async()=>({contact:{id:'wrong-contact'}});await assert.rejects(call(),e=>e.code==='provider_note_contact_conflict');assert.equal(writes,0);assert.equal(linked,0);
});
test('post-job retry creates one canonical owned check-in anchored to actual completion, never CRM task',async()=>{
 source.completedAt='2026-08-31T16:00:00.000Z';const result=await call({scope:'post_job'});assert.equal(result.ok,true);assert.ok(result.followupTaskId);
 const replay=await call({scope:'post_job'});assert.equal(replay.followupTaskId,result.followupTaskId);assert.equal(writes,1);
 const revised=await call({scope:'post_job',requestId:'separate-closeout-note'});assert.equal(revised.followupTaskId,result.followupTaskId);
 const tasks=await db.select().from(schema.tasks);assert.equal(tasks.length,1);assert.equal(tasks[0].assignedUserId,owner);assert.equal(tasks[0].dueAt.toISOString(),'2027-02-28T16:00:00.000Z');assert.equal(tasks[0].portalJobId,input.portalJobId);assert.equal(tasks[0].source,'operations');assert.equal(tasks[0].draftPayload,null);
});
test('unknown completion or owner blocks follow-up visibly and retry does not duplicate verified note',async()=>{
 const missingTime=await call({scope:'post_job'});assert.equal(missingTime.error,'post_job_completion_time_required');assert.equal(writes,1);
 source.completedAt='2026-08-31T16:00:00Z';owner=null;const missingOwner=await call({scope:'post_job'});assert.equal(missingOwner.error,'post_job_followup_owner_unresolved');assert.equal(writes,1);
 assert.equal((await db.select().from(schema.outboxEvents))[0].payload._egcFollowupStatus,'blocked');
 owner='verified-hub-owner';assert.equal((await call({scope:'post_job'})).ok,true);assert.equal(writes,1);assert.equal((await db.select().from(schema.outboxEvents))[0].payload._egcFollowupStatus,'complete');assert.equal((await db.select().from(schema.tasks)).length,1);
});
test('six-month check-in clamps month ends and never uses retry time',()=>{assert.equal(sixMonthCheckin('2023-08-31T10:30:00Z'),'2024-02-29T10:30:00.000Z');assert.equal(sixMonthCheckin('2026-01-31T10:30:00Z'),'2026-07-31T10:30:00.000Z');assert.throws(()=>sixMonthCheckin('invalid'),e=>e.code==='post_job_completion_time_required');});
