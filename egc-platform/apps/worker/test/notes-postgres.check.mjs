import test,{beforeEach,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {getDb,schema} from '@egc/database';
import {eq,sql} from 'drizzle-orm';
import {processNoteOutbox} from '../dist/note-outbox.js';
const url=new URL(process.env.DATABASE_URL||'http://invalid');
if(process.env.EGC_OPERATIONS_TEST!=='isolated'||!['127.0.0.1','localhost'].includes(url.hostname)||url.pathname!=='/egc_operations_test')throw new Error('Only isolated loopback egc_operations_test is allowed');
globalThis.fetch=async()=>{throw new Error('External HTTP forbidden');};
const db=getDb();let writes,notes,provider,event;
beforeEach(async()=>{
  await db.execute(sql`truncate outbox_events,audit_logs`);writes=0;notes=[];
  [event]=await db.insert(schema.outboxEvents).values({type:'ghl.contact_note.sync',entityId:randomUUID(),payload:{ghlContactId:'fixture',noteBody:'Synthetic internal note'}}).returning();
  provider={getContactNotes:async()=>({notes}),createContactNote:async(id,body)=>{writes++;notes.push({id:'note-1',body});return {note:{id:'note-1'}};}};
});
after(async()=>db.$client.end({timeout:5}));
const row=async()=>(await db.select().from(schema.outboxEvents))[0];
test('concurrent workers claim only once and require provider read-back',async()=>{
  await Promise.all(Array.from({length:10},()=>processNoteOutbox(provider,db)));assert.equal(writes,1);assert.equal((await row()).processingStatus,'processed');
});
test('provider error after commit reconciles marker without another create',async()=>{
  provider.createContactNote=async(id,body)=>{writes++;notes.push({id:'note-1',body});throw new Error('token=secret');};
  await processNoteOutbox(provider,db);assert.equal((await row()).processingStatus,'processed');assert.equal(writes,1);
});
test('unknown write remains read-only across retry and worker restart',async()=>{
  provider.createContactNote=async()=>{writes++;throw new Error('token=secret');};await processNoteOutbox(provider,db);
  assert.equal((await row()).processingStatus,'reconciling');await processNoteOutbox(provider,db,new Date(Date.now()+3600000));assert.equal(writes,1);
  assert.ok(!JSON.stringify(await row()).includes('token=secret'));
  notes=[{id:'late-note',body:`Synthetic internal note\n\n[EGC operation ${event.id}]`}];
  await processNoteOutbox(provider,db,new Date(Date.now()+3600000));assert.equal((await row()).processingStatus,'processed');assert.equal(writes,1);
});
test('preflight read failure is safe to retry because no write started',async()=>{
  provider.getContactNotes=async()=>{throw new Error('offline');};await processNoteOutbox(provider,db);assert.equal(writes,0);assert.equal((await row()).processingStatus,'pending');
  provider.getContactNotes=async()=>({notes});await processNoteOutbox(provider,db,new Date(Date.now()+3600000));assert.equal(writes,1);assert.equal((await row()).processingStatus,'processed');
});
test('old uncertain unmarked writes are quarantined without resend',async()=>{
  await db.update(schema.outboxEvents).set({retryCount:1}).where(eq(schema.outboxEvents.id,event.id));await processNoteOutbox(provider,db);
  assert.equal(writes,0);assert.equal((await row()).lastError,'legacy_write_requires_manual_reconciliation');
});
test('marker collision or malformed provider response never claims success',async()=>{
  notes=[{id:'wrong',body:`Different text [EGC operation ${event.id}]`}];await processNoteOutbox(provider,db);assert.equal(writes,0);assert.equal((await row()).lastError,'provider_note_evidence_conflict');
});

test('a reclaimed claim fences the original slow worker before external creation',async()=>{
  let resumeFirst,notifyStarted;const started=new Promise(r=>{notifyStarted=r;});const gate=new Promise(r=>{resumeFirst=r;});let reads=0;
  provider.getContactNotes=async()=>{if(++reads===1){notifyStarted();await gate;return {notes:[]};}return {notes};};
  const original=processNoteOutbox(provider,db);await started;
  await db.update(schema.outboxEvents).set({updatedAt:new Date(Date.now()-360000)}).where(eq(schema.outboxEvents.id,event.id));
  const recovered=await processNoteOutbox(provider,db);assert.equal(recovered.processed,1);resumeFirst();
  const stale=await original;assert.equal(stale.leaseLost,1);assert.equal(writes,1);assert.equal((await row()).processingStatus,'processed');
  assert.equal((await db.select().from(schema.auditLogs)).filter(a=>a.action==='ghl.contact_note.verified').length,1);
});
test('reclaim after durable intent never sends again and stale completion cannot overwrite recovery',async()=>{
  let resumeWrite,notifyWrite;const started=new Promise(r=>{notifyWrite=r;});const gate=new Promise(r=>{resumeWrite=r;});
  provider.createContactNote=async(id,body)=>{writes++;notes.push({id:'slow-note',body});notifyWrite();await gate;throw new Error('Provider timed out after commit');};
  const original=processNoteOutbox(provider,db);await started;
  await db.update(schema.outboxEvents).set({updatedAt:new Date(Date.now()-360000)}).where(eq(schema.outboxEvents.id,event.id));
  const recovered=await processNoteOutbox(provider,db);assert.equal(recovered.processed,1);resumeWrite();
  const stale=await original;assert.equal(stale.leaseLost,1);assert.equal(writes,1);assert.equal((await row()).processingStatus,'processed');
  assert.equal((await db.select().from(schema.auditLogs)).filter(a=>a.action==='ghl.contact_note.verified').length,1);
});
