/** Registry CRM reads against isolated loopback PostgreSQL with synthetic fixtures only; never point this at production. */
import test,{after,before,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {getDb,schema} from '@egc/database';
import {eq,sql} from 'drizzle-orm';
import {crmReadTools} from '../dist/tools/domains/crm-reads.js';
import {registerTools} from '../dist/tools/define.js';
import {operationsPrincipal} from '../dist/operations.js';
const url=new URL(process.env.DATABASE_URL||'http://invalid');
if(process.env.EGC_OPERATIONS_TEST!=='isolated'||!['127.0.0.1','localhost'].includes(url.hostname)||url.pathname!=='/egc_operations_test'||!['postgres:','postgresql:'].includes(url.protocol))throw new Error('Only isolated loopback egc_operations_test is allowed');
const db=getDb(),NOW=new Date('2026-09-22T12:00:00.000Z'),HOUR=3_600_000,DAY=24*HOUR,at=ms=>new Date(NOW.valueOf()+ms);
const actor={id:'mcp-service-grant',role:'integration',kind:'integration',workspace:'egc'};
const tools=new Map();
// The injected clock; a test moves it between page calls as real time moves between them.
let clock=NOW;
registerTools({registerTool:(name,config,handler)=>tools.set(name,{config,handler})},crmReadTools(),{now:()=>clock});
async function call(name,args={}){const t=tools.get(name);const r=await operationsPrincipal.run(actor,()=>t.handler(t.config.inputSchema.parse(args)));return {isError:r.isError===true,value:r.structuredContent.result};}
async function walk(name,args,pick=r=>r,step=0){
  const seen=[],sizes=[];let cursor;
  do{const r=await call(name,{...args,...(cursor?{cursor}:{})});assert.equal(r.isError,false,JSON.stringify(r.value));const page=pick(r.value);assert.equal(page.coverage.complete,true);assert.equal(page.asOf,NOW.toISOString());seen.push(...page.items);sizes.push(page.items.length);cursor=page.page.nextCursor;clock=new Date(clock.valueOf()+step);}while(cursor&&sizes.length<20);
  return {seen,sizes};
}
let fetchBefore,contact,other;
before(()=>{fetchBefore=globalThis.fetch;globalThis.fetch=async()=>{throw new Error('network disabled in isolated check');};});
after(async()=>{globalThis.fetch=fetchBefore;await db.$client.end({timeout:5});});
beforeEach(async()=>{
  clock=NOW;
  await db.execute(sql`set client_min_messages to warning`);
  await db.execute(sql`truncate customer_state_snapshots,messages,conversations,call_transcripts,calls,appointments,tasks,walkthroughs,jobs,opportunities,leads,contacts cascade`);
  [contact,other]=await db.insert(schema.contacts).values([{provider:'ghl',providerId:'synthetic-crm-contact',name:'Isolated fixture',phone:'+15555550101',updatedAt:at(-400*DAY)},{provider:'ghl',providerId:'synthetic-crm-other',name:'Other fixture',updatedAt:at(-DAY)}]).returning();
});

test('tasks.search walks 505 rows tied on updated_at exactly once, in updated_at desc then id desc order',async()=>{
  const rows=await db.insert(schema.tasks).values(Array.from({length:505},(_,i)=>({title:`Tied ${i}`,updatedAt:at(-HOUR)}))).returning({id:schema.tasks.id});
  const {seen,sizes}=await walk('tasks.search',{limit:200});
  assert.deepEqual(sizes,[200,200,105]);
  assert.deepEqual(seen.map(t=>t.id),rows.map(r=>r.id).sort().reverse());
});

test('every paged read applies its filters in SQL before the limit',async()=>{
  const old=at(-300*DAY),recent=i=>at(-i*HOUR);
  // Three newer non-matching rows sit ahead of each older match; limit 1 must still return the match and nothing else.
  const [job]=await db.insert(schema.jobs).values({contactId:contact.id,status:'on_hold',updatedAt:old}).returning();
  await db.insert(schema.jobs).values([1,2,3].map(i=>({contactId:other.id,status:'scheduled',updatedAt:recent(i)})));
  const [opportunity]=await db.insert(schema.opportunities).values({providerId:'opp-old',contactId:contact.id,status:'lost',updatedAt:old}).returning();
  await db.insert(schema.opportunities).values([1,2,3].map(i=>({providerId:`opp-${i}`,contactId:other.id,status:'open',updatedAt:recent(i)})));
  const [walkthrough]=await db.insert(schema.walkthroughs).values({contactId:contact.id,status:'approved',createdAt:old}).returning();
  await db.insert(schema.walkthroughs).values([1,2,3].map(i=>({contactId:other.id,status:'draft',createdAt:recent(i)})));
  const [conversation]=await db.insert(schema.conversations).values({providerId:'conv-old',contactId:contact.id,updatedAt:old}).returning();
  await db.insert(schema.conversations).values([1,2,3].map(i=>({providerId:`conv-${i}`,contactId:other.id,updatedAt:recent(i)})));
  const [call_]=await db.insert(schema.calls).values({providerMessageId:'call-old',contactId:contact.id,direction:'inbound',actorType:'customer',startedAt:at(-20*DAY)}).returning();
  await db.insert(schema.calls).values([1,2,3].map(i=>({providerMessageId:`call-${i}`,contactId:other.id,direction:'inbound',actorType:'customer',startedAt:recent(i)})));
  const [appointment]=await db.insert(schema.appointments).values({providerId:'appt-late',contactId:contact.id,appointmentStartAt:at(80*DAY)}).returning();
  await db.insert(schema.appointments).values([1,2,3].map(i=>({providerId:`appt-${i}`,contactId:other.id,appointmentStartAt:recent(-i)})));
  const [lead]=await db.insert(schema.leads).values({contactId:contact.id,currentState:'LOST',createdAt:at(-20*DAY)}).returning();
  await db.insert(schema.leads).values({contactId:other.id,currentState:'NEVER_CONTACTED',createdAt:recent(1)});
  const cases=[
    ['jobs.search',{status:'on_hold',limit:1},r=>r.id,job.id],['jobs.search',{contactId:contact.id,limit:1},r=>r.id,job.id],
    ['opportunities.search',{status:'lost',limit:1},r=>r.id,opportunity.id],['opportunities.search',{contactId:contact.id,limit:1},r=>r.id,opportunity.id],
    ['walkthroughs.search',{status:'approved',limit:1},r=>r.id,walkthrough.id],['walkthroughs.search',{contactId:contact.id,limit:1},r=>r.id,walkthrough.id],
    ['conversations.search',{contactId:contact.id,limit:1},r=>r.id,conversation.id],
    ['calls.search',{contactId:contact.id,limit:1},r=>r.call.id,call_.id],
    ['appointments.search',{contactId:contact.id,limit:1},r=>r.id,appointment.id],
    ['contacts.search',{query:'5550101',limit:1},r=>r.id,contact.id],['contacts.search',{query:'isolated',limit:1},r=>r.id,contact.id],
    ['leads.search',{state:'LOST',limit:1},r=>r.lead.id,lead.id]
  ];
  for(const [name,args,key,expected] of cases){
    const r=await call(name,args);
    assert.equal(r.isError,false,`${name} ${JSON.stringify(r.value)}`);assert.deepEqual(r.value.items.map(key),[expected],`${name} ${JSON.stringify(args)}`);assert.equal(r.value.page.nextCursor,null,name);
  }
  // The unfiltered newest row proves the order: the match really was behind the limit.
  assert.notEqual((await call('jobs.search',{limit:1})).value.items[0].id,job.id);
});

test('relative windows come from the injected clock, not the server clock',async()=>{
  await db.insert(schema.calls).values([{providerMessageId:'in-window',contactId:contact.id,direction:'inbound',actorType:'customer',startedAt:at(-2*HOUR)},{providerMessageId:'too-old',contactId:contact.id,direction:'inbound',actorType:'customer',startedAt:at(-2*DAY)}]);
  assert.deepEqual((await call('calls.search',{days:1})).value.items.map(r=>r.call.providerMessageId),['in-window']);
  await db.insert(schema.appointments).values([['past-in',-12*HOUR],['future-in',12*HOUR],['past-out',-2*DAY],['future-out',2*DAY],['boundary-out',DAY]].map(([providerId,ms])=>({providerId,contactId:contact.id,appointmentStartAt:at(ms)})));
  assert.deepEqual((await call('appointments.search',{daysPast:1,daysFuture:1})).value.items.map(r=>r.providerId),['past-in','future-in']);
  await db.insert(schema.leads).values([{contactId:contact.id,createdAt:at(-HOUR)},{contactId:other.id,createdAt:at(-3*DAY)}]);
  assert.deepEqual((await call('leads.search',{days:1})).value.items.map(r=>r.contact.id),[contact.id]);
});

test('conversations.get pages messages newest first through ties without duplicates',async()=>{
  const [conversation]=await db.insert(schema.conversations).values({providerId:'conv-messages',contactId:contact.id}).returning();
  const tied=await db.insert(schema.messages).values(Array.from({length:5},(_,i)=>({providerId:`tied-${i}`,conversationId:conversation.id,contactId:contact.id,type:'TYPE_SMS',direction:'inbound',actorType:'customer',body:`Synthetic ${i}`,occurredAt:at(-HOUR),updatedAt:at(-HOUR)}))).returning({id:schema.messages.id});
  const [newest]=await db.insert(schema.messages).values({providerId:'newest',conversationId:conversation.id,contactId:contact.id,type:'TYPE_SMS',direction:'outbound',actorType:'human',occurredAt:at(-60_000),updatedAt:at(-60_000)}).returning();
  const {seen,sizes}=await walk('conversations.get',{conversationId:conversation.id,messageLimit:2},v=>{assert.equal(v.conversation.id,conversation.id);return v.messages;});
  assert.deepEqual(sizes,[2,2,2]);
  assert.deepEqual(seen.map(m=>m.id),[newest.id,...tied.map(m=>m.id).sort().reverse()]);
  assert.equal((await call('conversations.get',{conversationId:other.id})).value.error,'conversation_not_found');
});

test('appointments.search keeps its window at the first page while appointments start between page calls',async()=>{
  // The reviewer's case: five in the window, the earliest just inside the one-day lookback, two per page, 30 seconds between calls.
  const edge=await db.insert(schema.appointments).values([-DAY+10_000,-DAY+20_000,-HOUR,HOUR,2*HOUR].map((ms,i)=>({providerId:`edge-${i}`,contactId:contact.id,appointmentStartAt:at(ms),updatedAt:at(-2*DAY)}))).returning({id:schema.appointments.id});
  const past=await walk('appointments.search',{daysPast:1,daysFuture:1,limit:2},r=>r,30_000);
  assert.deepEqual(past.sizes,[2,2,1]);assert.deepEqual(past.seen.map(a=>a.id),edge.map(a=>a.id));
  // Upcoming only: the first two start during the walk.
  await db.execute(sql`truncate appointments cascade`);clock=NOW;
  const upcoming=await db.insert(schema.appointments).values([10_000,20_000,HOUR,2*HOUR,3*HOUR].map((ms,i)=>({providerId:`soon-${i}`,contactId:contact.id,appointmentStartAt:at(ms),updatedAt:at(-2*DAY)}))).returning({id:schema.appointments.id});
  const soon=await walk('appointments.search',{daysPast:0,daysFuture:1,limit:2},r=>r,30_000);
  assert.deepEqual(soon.sizes,[2,2,1]);assert.deepEqual(soon.seen.map(a=>a.id),upcoming.map(a=>a.id));
  // A fresh walk at the later time measures from that time, so the started appointments are gone from it.
  assert.deepEqual((await call('appointments.search',{daysPast:0,daysFuture:1,limit:2})).value.items.map(a=>a.id),upcoming.slice(2,4).map(a=>a.id));
});

test('a later page reports a matching row written after asOf, which an offset walk would otherwise miss silently',async()=>{
  const tasks=await db.insert(schema.tasks).values(Array.from({length:5},(_,i)=>({title:`Walk ${i}`,updatedAt:at(-(i+1)*HOUR)}))).returning({id:schema.tasks.id});
  const first=await call('tasks.search',{limit:2});
  assert.deepEqual(first.value.items.map(t=>t.id),tasks.slice(0,2).map(t=>t.id));assert.deepEqual(first.value.coverage,{complete:true});
  // Task 4 has not been reached; an update moves it to the head, ahead of the offset.
  await db.update(schema.tasks).set({priority:'high',updatedAt:at(10_000)}).where(eq(schema.tasks.id,tasks[4].id));clock=at(30_000);
  const second=await call('tasks.search',{limit:2,cursor:first.value.page.nextCursor});
  assert.equal(second.value.asOf,NOW.toISOString());assert.equal(second.value.coverage.complete,false);assert.equal(second.value.coverage.reason,'rows_changed_after_asOf');
  assert.deepEqual(second.value.items.map(t=>t.id),[tasks[1].id,tasks[2].id]);
  // A canonical snapshot written after asOf can move a lead into a state filter without touching the lead row (JOB_SOLD counts as BOOKED); the probe sees that too.
  clock=NOW;
  const [third]=await db.insert(schema.contacts).values({provider:'ghl',providerId:'synthetic-crm-third',name:'Third fixture',updatedAt:at(-DAY)}).returning();
  const leads=await db.insert(schema.leads).values([[contact,'BOOKED',-HOUR],[other,'BOOKED',-2*HOUR],[third,'NEVER_CONTACTED',-30*60_000]].map(([c,currentState,ms])=>({contactId:c.id,currentState,createdAt:at(ms),updatedAt:at(-DAY)}))).returning({id:schema.leads.id});
  const booked=await call('leads.search',{state:'BOOKED',limit:1});
  assert.deepEqual(booked.value.items.map(r=>r.lead.id),[leads[0].id]);
  await db.insert(schema.customerStateSnapshots).values({contactId:third.id,leadId:leads[2].id,state:'JOB_SOLD',intentStage:'sold',pipeline:'direct_job',reconciliationStatus:'reconciled',snapshot:{state:'JOB_SOLD'},coverage:{complete:true},lastReconciledAt:at(5_000),createdAt:at(5_000),updatedAt:at(5_000)});
  clock=at(60_000);
  // The newer lead now heads the set, so offset 1 repeats the first page's lead; the page says so instead of passing it off as complete.
  const next=await call('leads.search',{state:'BOOKED',limit:1,cursor:booked.value.page.nextCursor});
  assert.deepEqual(next.value.items.map(r=>r.lead.id),[leads[0].id]);assert.equal(next.value.coverage.complete,false);assert.equal(next.value.coverage.reason,'rows_changed_after_asOf');
});

test('a cursor older than a day is refused before any read',async()=>{
  await db.insert(schema.tasks).values(Array.from({length:3},(_,i)=>({title:`Old walk ${i}`,updatedAt:at(-HOUR)})));
  const first=await call('tasks.search',{limit:1});
  clock=at(DAY+1);
  const late=await call('tasks.search',{limit:1,cursor:first.value.page.nextCursor});
  assert.equal(late.isError,true);assert.equal(late.value.error,'invalid_cursor');
  clock=at(DAY-1);
  assert.equal((await call('tasks.search',{limit:1,cursor:first.value.page.nextCursor})).value.page.offset,1);
});
