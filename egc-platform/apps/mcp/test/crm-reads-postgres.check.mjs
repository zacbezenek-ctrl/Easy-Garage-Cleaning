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
const tools=new Map(),keysetTools=new Map();
// The injected clock; a test moves it between page calls as real time moves between them.
let clock=NOW;
// tools reads EGC_MCP_KEYSET_CURSORS (unset here, so offsets); keysetTools has keyset cursors on.
registerTools({registerTool:(name,config,handler)=>tools.set(name,{config,handler})},crmReadTools(),{now:()=>clock});
registerTools({registerTool:(name,config,handler)=>keysetTools.set(name,{config,handler})},crmReadTools({keyset:()=>true}),{now:()=>clock});
async function call(name,args={},registry=tools){const t=registry.get(name);const r=await operationsPrincipal.run(actor,()=>t.handler(t.config.inputSchema.parse(args)));return {isError:r.isError===true,value:r.structuredContent.result};}
async function walk(name,args,pick=r=>r,step=0,registry=tools){
  const seen=[],sizes=[],cursors=[];let cursor;
  do{const r=await call(name,{...args,...(cursor?{cursor}:{})},registry);assert.equal(r.isError,false,JSON.stringify(r.value));const page=pick(r.value);assert.equal(page.coverage.complete,true);assert.equal(page.asOf,NOW.toISOString());seen.push(...page.items);sizes.push(page.items.length);cursor=page.page.nextCursor;if(cursor)cursors.push(cursor);clock=new Date(clock.valueOf()+step);}while(cursor&&sizes.length<20);
  return {seen,sizes,cursors};
}
const version=cursor=>JSON.parse(Buffer.from(cursor,'base64url').toString()).v;
// Microsecond n past a base instant, as PostgreSQL stores it; a JS Date would round these to one millisecond.
const micro=(base,n)=>sql`(${base}::timestamptz + ${n}::int * interval '1 microsecond')`;
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

test('keyset: rows that differ only in microseconds or tie exactly are walked once each, in exact order, for every order shape',async()=>{
  // 505 tasks over seven microseconds inside one millisecond (updated_at desc).
  const tasks=await db.insert(schema.tasks).values(Array.from({length:505},(_,i)=>({title:`Micro ${i}`,createdAt:at(-DAY),updatedAt:micro('2026-09-22T11:00:00.123Z',i%7)}))).returning({id:schema.tasks.id});
  const expected=(await db.execute(sql`select id from tasks order by updated_at desc, id desc`)).map(r=>r.id);
  assert.equal(expected.length,tasks.length);
  const t=await walk('tasks.search',{limit:200},r=>r,90_000,keysetTools);
  assert.deepEqual(t.sizes,[200,200,105]);assert.deepEqual(t.seen.map(r=>r.id),expected);assert.deepEqual(t.cursors.map(version),[2,2]);
  assert.ok(t.seen.every(r=>!('egcPageKey' in r)&&!('egcPageId' in r)));
  // Ascending (appointments), a joined select (calls, leads) and conversation messages, each with microsecond ties.
  // Appointments and messages report any row written after asOf, so their fixtures are written before it (the column default would be the database's real clock).
  clock=NOW;
  await db.insert(schema.appointments).values([0,0,1,1,2,5,5].map((n,i)=>({providerId:`micro-${i}`,contactId:contact.id,appointmentStartAt:micro('2026-09-23T15:00:00.456Z',n),createdAt:at(-DAY),updatedAt:at(-DAY)})));
  const appointments=await walk('appointments.search',{limit:2},r=>r,0,keysetTools);
  assert.deepEqual(appointments.seen.map(r=>r.id),(await db.execute(sql`select id from appointments order by appointment_start_at asc, id asc`)).map(r=>r.id));assert.deepEqual(appointments.sizes,[2,2,2,1]);
  clock=NOW;
  await db.insert(schema.calls).values([3,3,2,2,1].map((n,i)=>({providerMessageId:`micro-call-${i}`,contactId:i%2?contact.id:other.id,direction:'inbound',actorType:'customer',startedAt:micro('2026-09-22T10:00:00.789Z',n)})));
  const calls=await walk('calls.search',{limit:2},r=>r,0,keysetTools);
  assert.deepEqual(calls.seen.map(r=>r.call.id),(await db.execute(sql`select id from calls order by started_at desc, id desc`)).map(r=>r.id));assert.ok(calls.seen.every(r=>typeof r.customerName==='string'&&!('egcPageKey' in r)));
  clock=NOW;
  const [third]=await db.insert(schema.contacts).values({provider:'ghl',providerId:'synthetic-crm-micro',name:'Micro fixture',updatedAt:at(-DAY)}).returning();
  await db.insert(schema.leads).values([contact,other,third].map(c=>({contactId:c.id,createdAt:micro('2026-09-22T09:00:00.001Z',1)})));
  const leads=await walk('leads.search',{limit:1},r=>r,0,keysetTools);
  assert.deepEqual(leads.seen.map(r=>r.lead.id),(await db.execute(sql`select id from leads order by created_at desc, id desc`)).map(r=>r.id));assert.deepEqual(leads.sizes,[1,1,1]);
  clock=NOW;
  const [conversation]=await db.insert(schema.conversations).values({providerId:'conv-micro',contactId:contact.id}).returning();
  await db.insert(schema.messages).values([4,4,4,0,9].map((n,i)=>({providerId:`micro-message-${i}`,conversationId:conversation.id,contactId:contact.id,type:'TYPE_SMS',direction:'inbound',actorType:'customer',occurredAt:micro('2026-09-22T08:00:00.002Z',n),createdAt:at(-DAY),updatedAt:at(-DAY)})));
  const messages=await walk('conversations.get',{conversationId:conversation.id,messageLimit:2},v=>v.messages,0,keysetTools);
  assert.deepEqual(messages.seen.map(r=>r.id),(await db.execute(sql`select id from messages order by occurred_at desc, id desc`)).map(r=>r.id));
});

test('keyset: a row deleted or created during the walk neither skips nor repeats one, and the walk stays complete',async()=>{
  const tasks=await db.insert(schema.tasks).values(Array.from({length:6},(_,i)=>({title:`Keyset ${i}`,createdAt:at(-DAY),updatedAt:at(-(i+1)*HOUR)}))).returning({id:schema.tasks.id});
  const first=await call('tasks.search',{limit:2},keysetTools);
  assert.deepEqual(first.value.items.map(t=>t.id),tasks.slice(0,2).map(t=>t.id));
  // An offset walk would now skip tasks[2] (one row fewer ahead of it) or repeat tasks[1] (one more).
  await db.delete(schema.tasks).where(eq(schema.tasks.id,tasks[0].id));
  await db.insert(schema.tasks).values({title:'Created after asOf',createdAt:at(10_000),updatedAt:at(10_000)});
  clock=at(30_000);
  const second=await call('tasks.search',{limit:2,cursor:first.value.page.nextCursor},keysetTools);
  assert.deepEqual(second.value.items.map(t=>t.id),tasks.slice(2,4).map(t=>t.id));assert.deepEqual(second.value.coverage,{complete:true});assert.equal(second.value.page.offset,2);
  const third=await call('tasks.search',{limit:2,cursor:second.value.page.nextCursor},keysetTools);
  assert.deepEqual(third.value.items.map(t=>t.id),tasks.slice(4).map(t=>t.id));assert.equal(third.value.page.nextCursor,null);assert.deepEqual(third.value.coverage,{complete:true});
});

test('keyset: an update that moves a row that existed at asOf across the cursor is reported, not silent',async()=>{
  // jobs, not tasks: the tasks revision guard stamps updated_at with clock_timestamp() on UPDATE, so an injected time there would never reach the probe.
  const jobs=await db.insert(schema.jobs).values(Array.from({length:5},(_,i)=>({contactId:contact.id,status:'scheduled',createdAt:at(-DAY),updatedAt:at(-(i+1)*HOUR)}))).returning({id:schema.jobs.id});
  const first=await call('jobs.search',{limit:2},keysetTools);
  assert.deepEqual(first.value.items.map(j=>j.id),jobs.slice(0,2).map(j=>j.id));
  // Job 4 has not been reached; the update moves it to the head, behind the cursor, so the walk misses it.
  await db.update(schema.jobs).set({accessNotes:'Synthetic gate note',updatedAt:at(10_000)}).where(eq(schema.jobs.id,jobs[4].id));clock=at(30_000);
  const [stored]=await db.select({updatedAt:schema.jobs.updatedAt}).from(schema.jobs).where(eq(schema.jobs.id,jobs[4].id));assert.equal(stored.updatedAt.toISOString(),at(10_000).toISOString());
  const second=await call('jobs.search',{limit:2,cursor:first.value.page.nextCursor},keysetTools);
  assert.deepEqual(second.value.items.map(j=>j.id),[jobs[2].id,jobs[3].id]);assert.equal(second.value.page.nextCursor,null);
  assert.equal(second.value.coverage.complete,false);assert.equal(second.value.coverage.reason,'rows_changed_after_asOf');assert.match(second.value.coverage.instruction,/existed at asOf/);
});

test('keyset: an appointment booked after asOf, returned, then rescheduled past the cursor is reported on the pages it can repeat on',async()=>{
  // Four appointments at asOf, two per page. One is booked between them after page 1, and rescheduled past the cursor after page 2, so the walk really returns it twice.
  const existing=(await db.insert(schema.appointments).values([1,2,3,4].map(h=>({providerId:`asof-${h}`,contactId:contact.id,appointmentStartAt:at(h*HOUR),createdAt:at(-DAY),updatedAt:at(-DAY)}))).returning({id:schema.appointments.id})).map(a=>a.id);
  const first=await call('appointments.search',{limit:2},keysetTools);
  assert.deepEqual(first.value.items.map(a=>a.id),existing.slice(0,2));assert.deepEqual(first.value.coverage,{complete:true});
  const [booked]=await db.insert(schema.appointments).values({providerId:'booked-after-asof',contactId:contact.id,appointmentStartAt:at(2.5*HOUR),createdAt:at(10_000),updatedAt:at(10_000)}).returning({id:schema.appointments.id});
  clock=at(30_000);
  const second=await call('appointments.search',{limit:2,cursor:first.value.page.nextCursor},keysetTools);
  assert.deepEqual(second.value.items.map(a=>a.id),[booked.id,existing[2]]);
  await db.update(schema.appointments).set({appointmentStartAt:at(3.5*HOUR),updatedAt:at(40_000)}).where(eq(schema.appointments.id,booked.id));clock=at(60_000);
  const third=await call('appointments.search',{limit:2,cursor:second.value.page.nextCursor},keysetTools);
  assert.deepEqual(third.value.items.map(a=>a.id),[booked.id,existing[3]]);assert.equal(third.value.page.nextCursor,null);
  for(const page of [second,third]){
    assert.equal(page.value.asOf,NOW.toISOString());assert.equal(page.value.coverage.complete,false);assert.equal(page.value.coverage.reason,'rows_changed_after_asOf');
    assert.match(page.value.coverage.instruction,/created or updated after asOf.*either way across the cursor/);
  }
});

test('keyset: a canonical snapshot that moves a lead into a state filter cannot repeat a lead, because the lead order is a fixed key',async()=>{
  // The offset walk in the earlier test repeats the first lead here and has to report it; the keyset walk continues after it.
  const [third]=await db.insert(schema.contacts).values({provider:'ghl',providerId:'synthetic-crm-third',name:'Third fixture',updatedAt:at(-DAY)}).returning();
  const leads=await db.insert(schema.leads).values([[contact,'BOOKED',-HOUR],[other,'BOOKED',-2*HOUR],[third,'NEVER_CONTACTED',-30*60_000]].map(([c,currentState,ms])=>({contactId:c.id,currentState,createdAt:at(ms),updatedAt:at(-DAY)}))).returning({id:schema.leads.id});
  const booked=await call('leads.search',{state:'BOOKED',limit:1},keysetTools);
  assert.deepEqual(booked.value.items.map(r=>r.lead.id),[leads[0].id]);
  await db.insert(schema.customerStateSnapshots).values({contactId:third.id,leadId:leads[2].id,state:'JOB_SOLD',intentStage:'sold',pipeline:'direct_job',reconciliationStatus:'reconciled',snapshot:{state:'JOB_SOLD'},coverage:{complete:true},lastReconciledAt:at(5_000),createdAt:at(5_000),updatedAt:at(5_000)});
  await db.update(schema.leads).set({assignedUserId:'synthetic-rep',updatedAt:at(6_000)}).where(eq(schema.leads.id,leads[1].id));
  clock=at(60_000);
  const next=await call('leads.search',{state:'BOOKED',limit:1,cursor:booked.value.page.nextCursor},keysetTools);
  assert.deepEqual(next.value.items.map(r=>r.lead.id),[leads[1].id]);assert.deepEqual(next.value.coverage,{complete:true});assert.equal(next.value.page.nextCursor,null);
});

test('keyset cursors are refused once the flag is off, and an offset cursor issued before it was turned on continues by offset',async()=>{
  await db.insert(schema.tasks).values(Array.from({length:3},(_,i)=>({title:`Flag ${i}`,createdAt:at(-DAY),updatedAt:at(-(i+1)*HOUR)})));
  const keysetFirst=await call('tasks.search',{limit:1},keysetTools);assert.equal(version(keysetFirst.value.page.nextCursor),2);
  const refused=await call('tasks.search',{limit:1,cursor:keysetFirst.value.page.nextCursor});
  assert.equal(refused.isError,true);assert.equal(refused.value.error,'invalid_cursor');
  const offsetFirst=await call('tasks.search',{limit:1});assert.equal(version(offsetFirst.value.page.nextCursor),1);
  const continued=await call('tasks.search',{limit:1,cursor:offsetFirst.value.page.nextCursor},keysetTools);
  assert.equal(continued.value.page.offset,1);assert.equal(version(continued.value.page.nextCursor),1);
});
