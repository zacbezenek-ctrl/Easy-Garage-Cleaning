import test,{after,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
const url=new URL(process.env.DATABASE_URL??'http://invalid');
if(process.env.EGC_OPERATIONS_TEST!=='isolated'||!['127.0.0.1','localhost'].includes(url.hostname)||url.pathname!=='/egc_operations_test'||!['postgres:','postgresql:'].includes(url.protocol))throw new Error('Only isolated loopback egc_operations_test is allowed');
const {getDb,schema}=await import('@egc/database');
const {eq,inArray}=await import('drizzle-orm');
const {reconcileProviderNotes}=await import('../dist/provider-notes-worker.js');
const db=getDb(),created=[],noteIds=[];let contact,noteId;
const originalFetch=globalThis.fetch;
globalThis.fetch=async()=>{throw new Error('External HTTP forbidden');};
beforeEach(async()=>{
 [contact]=await db.insert(schema.contacts).values({providerId:`synthetic-notes-${randomUUID()}`,name:'Synthetic note customer'}).returning();created.push(contact.id);
 await db.insert(schema.leads).values({contactId:contact.id});
 noteId=`synthetic-note-${randomUUID()}`;noteIds.push(noteId);
});
after(async()=>{
 await db.delete(schema.providerMappings).where(inArray(schema.providerMappings.providerId,noteIds));
 for(const id of created){await db.delete(schema.syncCursors).where(eq(schema.syncCursors.key,`customer_state:provider_notes:${id}`));await db.delete(schema.contacts).where(eq(schema.contacts.id,id));}
 globalThis.fetch=originalFetch;await db.$client.end({timeout:5});
});
const mirror=async()=>(await db.select().from(schema.providerMappings).where(eq(schema.providerMappings.providerId,noteId)))[0];
const coverage=async()=>JSON.parse((await db.select().from(schema.syncCursors).where(eq(schema.syncCursors.key,`customer_state:provider_notes:${contact.id}`)))[0].cursor);
const provider=notes=>({getContactNotes:async id=>({notes:id===contact.providerId?notes:[]})});
test('mirrors exact provider notes idempotently and retires only after a complete read',async()=>{
 const p=provider([{id:noteId,contactId:contact.providerId,body:'Customer accepted the range.',dateAdded:new Date().toISOString()}]);
 await reconcileProviderNotes(p);await reconcileProviderNotes(p);
 const rows=await db.select().from(schema.providerMappings).where(eq(schema.providerMappings.providerId,noteId));assert.equal(rows.length,1);assert.equal(rows[0].raw.egcContactId,contact.id);assert.equal(rows[0].raw.egcDeleted,false);assert.equal((await coverage()).complete,true);
 await reconcileProviderNotes(provider([]));assert.equal((await mirror()).raw.egcDeleted,true);assert.equal((await mirror()).raw.body,'Customer accepted the range.');assert.equal((await coverage()).count,0);
});
test('failed or truncated reads retain existing facts and expose incomplete coverage',async()=>{
 await reconcileProviderNotes(provider([{id:noteId,body:'Please call Friday.'}]));
 await reconcileProviderNotes({getContactNotes:async()=>{throw new Error('sensitive upstream failure');}});
 assert.equal((await mirror()).raw.egcDeleted,false);assert.equal((await coverage()).complete,false);assert.ok(!JSON.stringify(await coverage()).includes('sensitive'));
 await reconcileProviderNotes({getContactNotes:async()=>({notes:[],hasMore:true})});assert.equal((await mirror()).raw.egcDeleted,false);assert.equal((await coverage()).complete,false);
});
test('older acquisition with fresh call activity is included without mixing contact identity',async()=>{
 await db.update(schema.leads).set({createdAt:new Date(Date.now()-90*86400000)}).where(eq(schema.leads.contactId,contact.id));
 await db.insert(schema.calls).values({providerMessageId:`synthetic-notes-call-${randomUUID()}`,contactId:contact.id,direction:'inbound',actorType:'customer',startedAt:new Date(),status:'completed'});
 await reconcileProviderNotes(provider([{id:noteId,contactId:contact.providerId,body:'I can send the video.'}]));assert.equal((await mirror()).raw.egcContactId,contact.id);
 await reconcileProviderNotes(provider([{id:noteId,contactId:'different-customer',body:'Wrong customer'}]));assert.equal((await mirror()).raw.body,'I can send the video.');assert.equal((await coverage()).complete,false);
});

test('an older quiet lead with an upcoming appointment still gets provider notes',async()=>{
 await db.update(schema.leads).set({createdAt:new Date(Date.now()-90*86400000)}).where(eq(schema.leads.contactId,contact.id));
 await db.insert(schema.appointments).values({providerId:`synthetic-notes-appointment-${randomUUID()}`,contactId:contact.id,status:'confirmed',appointmentStartAt:new Date(Date.now()+86400000)});
 await reconcileProviderNotes(provider([{id:noteId,contactId:contact.providerId,body:'Walkthrough address confirmed.'}]));assert.equal((await mirror()).raw.egcContactId,contact.id);assert.equal((await coverage()).complete,true);
});
