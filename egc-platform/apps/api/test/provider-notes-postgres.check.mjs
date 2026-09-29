import test,{beforeEach,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {eq,sql} from 'drizzle-orm';
import {getDb,schema} from '@egc/database';
import {processNoteOutbox,OperationsService} from '@egc/operations';
import {ensureProviderNote,sixMonthCheckin} from '../dist/provider-notes.js';
const url=new URL(process.env.DATABASE_URL||'http://invalid');
if(process.env.EGC_OPERATIONS_TEST!=='isolated'||!['localhost','127.0.0.1'].includes(url.hostname)||url.pathname!=='/egc_operations_test')throw new Error('Only isolated loopback egc_operations_test is allowed');
globalThis.fetch=async()=>{throw new Error('External HTTP forbidden');};
const db=getDb(),actor={id:'hub-note:fixture-staff',role:'integration',kind:'integration',workspace:'egc'};
const input={command:'provider.note.ensure',requestId:'fixture-logical-note',portalJobId:'fixture-job',providerContactId:'fixture-contact',scope:'game_plan',title:'Synthetic brief',body:'Keep synthetic bicycle'};
// GHL-ALIGN: the platform check-in task is opt-in; these checks pass the owner's flag explicitly.
const CHECKIN_ON={EGC_OPERATIONS_CHECKIN_TASKS_ENABLED:'true'};
let portal,provider,source,notes,writes,linked,service,owner,rules;
beforeEach(async()=>{
 await db.execute(sql`truncate outbox_events,audit_logs,operation_requests,operation_events,operation_approvals,tasks cascade`);notes=[];writes=0;linked=0;rules=0;owner='verified-hub-owner';
 source={id:input.portalJobId,type:'job',revision:'source-v1',highlevelContactId:input.providerContactId,customerId:'fixture-customer'};
 portal=async(actor,command)=>{if(command.command==='portal.job')return{authority:'employee_hub',job:source};if(command.command==='portal.rules'){rules++;return{authority:'employee_hub',inboundResponse:{ownerId:owner}};}if(command.command==='schedule.link_customer'){linked++;assert.equal(actor.kind,'integration');assert.equal(command.expectedRevision,'source-v1');return{authority:'employee_hub',visit:{portalVisitId:input.portalJobId,portalCustomerId:'fixture-customer',highlevelContactId:input.providerContactId}};}throw new Error('Unexpected portal command');};
 service=new OperationsService(db,{workspace:'egc',resolveOwner:async id=>id===owner,resolvePortalJob:async()=>({...source,customer:null,status:'completed',sourceWalkthroughId:null})});
 provider={locationId:'fixture-location',getContact:async()=>({contact:{id:input.providerContactId,locationId:'fixture-location'}}),getContactNotes:async()=>({notes}),createContactNote:async(id,body)=>{writes++;assert.equal(id,input.providerContactId);notes.push({id:'note-fixture',body});return{note:{id:'note-fixture'}};}};
});
after(async()=>db.$client.end({timeout:5}));
const call=(extra={},env={})=>ensureProviderNote(actor,{...input,...extra},portal,{db,provider,service,env});
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
test('with the check-in flag on, post-job retry creates one canonical owned check-in anchored to actual completion, never CRM task',async()=>{
 source.completedAt='2026-08-31T16:00:00.000Z';const result=await call({scope:'post_job'},CHECKIN_ON);assert.equal(result.ok,true);assert.ok(result.followupTaskId);
 const replay=await call({scope:'post_job'},CHECKIN_ON);assert.equal(replay.followupTaskId,result.followupTaskId);assert.equal(writes,1);
 const revised=await call({scope:'post_job',requestId:'separate-closeout-note'},CHECKIN_ON);assert.equal(revised.followupTaskId,result.followupTaskId);
 const tasks=await db.select().from(schema.tasks);assert.equal(tasks.length,1);assert.equal(tasks[0].assignedUserId,owner);assert.equal(tasks[0].dueAt.toISOString(),'2027-02-28T16:00:00.000Z');assert.equal(tasks[0].portalJobId,input.portalJobId);assert.equal(tasks[0].source,'operations');assert.equal(tasks[0].draftPayload,null);
});
test('with the check-in flag on, unknown completion or owner blocks follow-up visibly and retry does not duplicate verified note',async()=>{
 const missingTime=await call({scope:'post_job'},CHECKIN_ON);assert.equal(missingTime.error,'post_job_completion_time_required');assert.equal(writes,1);
 source.completedAt='2026-08-31T16:00:00Z';owner=null;const missingOwner=await call({scope:'post_job'},CHECKIN_ON);assert.equal(missingOwner.error,'post_job_followup_owner_unresolved');assert.equal(writes,1);
 assert.equal((await db.select().from(schema.outboxEvents))[0].payload._egcFollowupStatus,'blocked');
 owner='verified-hub-owner';assert.equal((await call({scope:'post_job'},CHECKIN_ON)).ok,true);assert.equal(writes,1);assert.equal((await db.select().from(schema.outboxEvents))[0].payload._egcFollowupStatus,'complete');assert.equal((await db.select().from(schema.tasks)).length,1);
});
test('GHL-ALIGN: without the exact check-in flag a verified post-job note opens no platform task, so the Hub creates the HighLevel one',async()=>{
 const prior=process.env.EGC_OPERATIONS_CHECKIN_TASKS_ENABLED;delete process.env.EGC_OPERATIONS_CHECKIN_TASKS_ENABLED;
 try{
  source.completedAt='2026-08-31T16:00:00.000Z';let n=0;
  for(const env of [undefined,{},{EGC_OPERATIONS_CHECKIN_TASKS_ENABLED:''},{EGC_OPERATIONS_CHECKIN_TASKS_ENABLED:'false'},{EGC_OPERATIONS_CHECKIN_TASKS_ENABLED:'TRUE'},{EGC_OPERATIONS_CHECKIN_TASKS_ENABLED:'1'},{EGC_OPERATIONS_CHECKIN_TASKS_ENABLED:' true'}]){
   const result=await ensureProviderNote(actor,{...input,scope:'post_job',requestId:'closeout-'+(n++)},portal,{db,provider,service,...(env?{env}:{})});
   assert.equal(result.ok,true,JSON.stringify(env));assert.equal(result.noteId,'note-fixture');assert.equal('followupTaskId' in result,false);
  }
  assert.equal((await db.select().from(schema.tasks)).length,0);assert.equal(rules,0,'no owner lookup for a task that is not created');
  // Review fix: the event is labelled as HighLevel's (not left unlabelled, which health counted as a pending platform follow-up).
  assert.ok((await db.select().from(schema.outboxEvents)).every(row=>row.payload._egcFollowupStatus==='highlevel'&&!('_egcFollowupTaskId' in row.payload)));
  source.completedAt=undefined;const unknownTime=await call({scope:'post_job',requestId:'closeout-without-time'});assert.equal(unknownTime.ok,true,'the note never waits for a follow-up the platform does not own');
  assert.equal((await db.select().from(schema.tasks)).length,0);
 }finally{if(prior===undefined)delete process.env.EGC_OPERATIONS_CHECKIN_TASKS_ENABLED;else process.env.EGC_OPERATIONS_CHECKIN_TASKS_ENABLED=prior;}
});
const followupHealth=async()=>(await service.execute(actor,{command:'status'},randomUUID())).health.queues.filter(row=>row.source==='post_job_followups').map(row=>[row.status,row.count]).sort();
test('GHL-ALIGN: a platform check-in opened while the flag was on is still reported after it is turned off, so the Hub never adds a HighLevel one',async()=>{
 source.completedAt='2026-08-31T16:00:00.000Z';const opened=await call({scope:'post_job'},CHECKIN_ON);assert.ok(opened.followupTaskId);
 // The Hub failed to record the result and retries after the owner turned the flag off.
 const retried=await call({scope:'post_job'});assert.equal(retried.ok,true);assert.equal(retried.followupTaskId,opened.followupTaskId);
 // The stamp is reported even after the Hub's completion time is corrected (a different dedupe key).
 source.completedAt='2026-08-31T17:00:00.000Z';assert.equal((await call({scope:'post_job'})).followupTaskId,opened.followupTaskId);source.completedAt='2026-08-31T16:00:00.000Z';
 const [event]=await db.select().from(schema.outboxEvents);assert.equal(event.payload._egcFollowupStatus,'complete');assert.equal((await db.select().from(schema.tasks)).length,1);assert.equal(writes,1);
 // Task created but its stamp lost: the exact dedupe key still finds it, and the stamp is repaired.
 await db.update(schema.outboxEvents).set({payload:sql`${schema.outboxEvents.payload}-'_egcFollowupStatus'-'_egcFollowupTaskId'`}).where(eq(schema.outboxEvents.id,event.id));
 const recovered=await call({scope:'post_job'});assert.equal(recovered.followupTaskId,opened.followupTaskId);
 const [repaired]=await db.select().from(schema.outboxEvents);assert.deepEqual([repaired.payload._egcFollowupStatus,repaired.payload._egcFollowupTaskId],['complete',opened.followupTaskId]);
 assert.equal((await db.select().from(schema.tasks)).length,1);assert.deepEqual(await followupHealth(),[['complete',1]]);
});
test('GHL-ALIGN: with the flag off, operations health reports check-ins as HighLevel\'s, and an old blocked one clears on retry',async()=>{
 source.completedAt='2026-08-31T16:00:00.000Z';owner=null;const blocked=await call({scope:'post_job'},CHECKIN_ON);assert.equal(blocked.error,'post_job_followup_owner_unresolved');
 assert.deepEqual(await followupHealth(),[['blocked',1]]);
 const retried=await call({scope:'post_job'});assert.equal(retried.ok,true);assert.equal('followupTaskId' in retried,false);
 await call({scope:'post_job',requestId:'second-closeout'});
 assert.deepEqual(await followupHealth(),[['highlevel',2]],'nothing reads as a pending or blocked platform follow-up');assert.equal((await db.select().from(schema.tasks)).length,0);
});
test('six-month check-in clamps month ends and never uses retry time',()=>{assert.equal(sixMonthCheckin('2023-08-31T10:30:00Z'),'2024-02-29T10:30:00.000Z');assert.equal(sixMonthCheckin('2026-01-31T10:30:00Z'),'2026-07-31T10:30:00.000Z');assert.throws(()=>sixMonthCheckin('invalid'),e=>e.code==='post_job_completion_time_required');});
