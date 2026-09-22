import test,{after,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';

const url=new URL(process.env.DATABASE_URL??'http://invalid');
if(process.env.EGC_CUSTOMER_STATE_TEST!=='isolated'||!['localhost','127.0.0.1'].includes(url.hostname)||!['/egc_operations_test','/egc_customer_state_test'].includes(url.pathname)||!['postgres:','postgresql:'].includes(url.protocol))throw new Error('Customer-state integration requires EGC_CUSTOMER_STATE_TEST=isolated and explicitly named loopback test database');
const {getDb,schema}=await import('@egc/database');
const {eq,sql}=await import('drizzle-orm');
const {reconcileCustomerState,recordUserConfirmedOutcome,getCustomerTimeline,getCanonicalReport}=await import('../dist/index.js');
const db=getDb(),created=[];
const originalFetch=globalThis.fetch;
globalThis.fetch=async()=>{throw new Error('All external HTTP disabled in isolated customer-state integration test');};
const at=new Date(Date.now()-3600_000),prior=new Date(Date.now()-2*86_400_000);
let contact,lead;
beforeEach(async()=>{
  [contact]=await db.insert(schema.contacts).values({providerId:`synthetic-canonical-${randomUUID()}`,name:'Synthetic Canonical Customer',source:'Facebook',raw:{attributionSource:{source:'facebook',adId:'1200000012345',campaignId:'1200000054321',utmContent:'original-hook'}}}).returning();created.push(contact.id);
  [lead]=await db.insert(schema.leads).values({contactId:contact.id,source:'Facebook',createdAt:prior}).returning();
});
after(async()=>{
  for(const id of created)await db.delete(schema.contacts).where(eq(schema.contacts.id,id));
  globalThis.fetch=originalFetch;
  await db.$client.end({timeout:2});
});
const refresh=()=>reconcileCustomerState({contactIds:[contact.id],useAI:false});

test('worker bulk window includes recent leads and older leads with recent call activity',async()=>{
  await db.update(schema.leads).set({createdAt:new Date(Date.now()-60*86_400_000)}).where(eq(schema.leads.id,lead.id));
  await db.insert(schema.calls).values({providerMessageId:`bulk-call-${randomUUID()}`,contactId:contact.id,direction:'outbound',actorType:'human',startedAt:at,status:'no-answer',raw:{status:'no-answer'}});
  const result=await reconcileCustomerState({since:new Date(Date.now()-7*86_400_000),until:new Date(),useAI:false});
  assert.equal(result.failed,0);assert.ok(result.results.some(r=>r.contactId===contact.id));
});

test('provider notes are read by exact normalized contact identity with visible source coverage',async()=>{
  await db.insert(schema.providerMappings).values({provider:'ghl',resourceType:'contact_note',providerId:`synthetic-note-${randomUUID()}`,raw:{egcContactId:contact.id,body:'Customer asked for a video quote.',dateAdded:at.toISOString(),egcNotesReadAt:at.toISOString()}});
  await db.insert(schema.syncCursors).values({key:`customer_state:provider_notes:${contact.id}`,cursor:JSON.stringify({complete:true,count:1,asOf:at.toISOString()})});
  const result=await refresh();assert.equal(result.failed,0);
  const timeline=await getCustomerTimeline({contactId:contact.id});assert.equal(timeline.coverage.providerNotes.inspected,1);assert.equal(timeline.coverage.providerNotes.complete,true);assert.ok(timeline.extraction.some(e=>e.sourceType==='provider_note'));
});

test('evidence and milestones persist once; customer assertion remains authoritative until provider catch-up',async()=>{
  const input={contactId:contact.id,field:'job_sold',value:true,exactText:'This exact customer accepted the quote.',sourceReference:'isolated:user-confirmation',actorId:'synthetic-zac',occurredAt:at,valueCents:45000};
  const first=await recordUserConfirmedOutcome(input);assert.equal(first.reconciliation.failed,0);
  await recordUserConfirmedOutcome(input);await refresh();
  let timeline=await getCustomerTimeline({contactId:contact.id});
  assert.equal(timeline.customer.state,'JOB_SOLD');assert.equal(timeline.assertions.length,1);assert.equal(timeline.assertions[0].status,'pending_reconciliation');
  assert.equal(timeline.events.filter(e=>e.eventType==='job_sold').length,1);const id=timeline.events.find(e=>e.eventType==='job_sold').eventId;
  await db.insert(schema.opportunities).values({providerId:`synthetic-won-${randomUUID()}`,contactId:contact.id,status:'won',wonAt:at,monetaryValueCents:45000});
  await refresh();timeline=await getCustomerTimeline({contactId:contact.id});
  assert.equal(timeline.events.filter(e=>e.eventType==='job_sold').length,1);assert.equal(timeline.events.find(e=>e.eventType==='job_sold').eventId,id);
  assert.equal(timeline.assertions[0].status,'reconciled');assert.ok(!timeline.customer.discrepancies.some(d=>d.code==='user_confirmed_awaiting_backend'));
});

test('first-touch attribution survives contact refresh and is attached to downstream evidence',async()=>{
  assert.equal((await refresh()).failed,0);
  await db.update(schema.contacts).set({source:'Google',raw:{attributionSource:{source:'google',campaignId:'replacement'},lastAttributionSource:{source:'google'}}}).where(eq(schema.contacts.id,contact.id));
  await recordUserConfirmedOutcome({contactId:contact.id,field:'walkthrough_verbally_booked',value:true,exactText:'Tuesday at 2:15 is agreed.',sourceReference:'isolated:booking',actorId:'synthetic-zac',occurredAt:at});
  const timeline=await getCustomerTimeline({contactId:contact.id}),booking=timeline.events.find(e=>e.eventType==='walkthrough_verbally_booked');
  assert.equal(booking.attribution.adId,'1200000012345');assert.equal(booking.attribution.utmContent,'original-hook');assert.equal(booking.attribution.source,'facebook');
  const rows=await db.select().from(schema.leadOriginalAttribution).where(eq(schema.leadOriginalAttribution.leadId,lead.id));assert.equal(rows.length,1);
});

test('portal evidence survives a worker without a portal fetch and full cancellation snapshot retires it',async()=>{
  const portalRecords=[{id:'synthetic-portal-visit',highlevelContactId:contact.providerId,kind:'walkthrough',status:'scheduled',createdAt:at.toISOString(),startAt:new Date(Date.now()+3600_000).toISOString()}];
  assert.equal((await reconcileCustomerState({contactIds:[contact.id],useAI:false,portalRecords,portalCoverage:{complete:true,asOf:at.toISOString()}})).failed,0);
  await refresh();let timeline=await getCustomerTimeline({contactId:contact.id});assert.equal(timeline.events.filter(e=>e.eventType==='walkthrough_booked').length,1);
  await reconcileCustomerState({contactIds:[contact.id],useAI:false,portalRecords:[{...portalRecords[0],status:'cancelled'}],portalCoverage:{complete:true,asOf:new Date().toISOString()}});
  timeline=await getCustomerTimeline({contactId:contact.id});assert.equal(timeline.events.filter(e=>e.eventType==='walkthrough_booked').length,0);
  await refresh();timeline=await getCustomerTimeline({contactId:contact.id});assert.equal(timeline.events.filter(e=>e.eventType==='walkthrough_booked').length,0);
});

test('unknown historic user outcome is durable but is not dated today or assigned a made-up value',async()=>{
  await recordUserConfirmedOutcome({contactId:contact.id,field:'revenue_collected',value:true,exactText:'Revenue already collected.',sourceReference:'isolated:unknown-date',actorId:'synthetic-zac'});
  const timeline=await getCustomerTimeline({contactId:contact.id});assert.equal(timeline.customer.state,'CASH_COLLECTED');
  const event=timeline.events.find(e=>e.eventType==='revenue_collected');assert.equal(event.details.occurredAtVerified,false);assert.equal(event.valueCents,null);
  const report=await getCanonicalReport({since:prior,until:new Date()});assert.ok(report.confirmedOutcomesWithUnknownTime.some(e=>e.eventId===event.eventId));assert.ok(!report.periodActivity.cashCollected.contactIds.includes(contact.id));
});

test('bounded calendar refresh preserves prior receipts outside its covered window',async()=>{
  const old=new Date(Date.now()-90*86_400_000).toISOString();
  await reconcileCustomerState({contactIds:[contact.id],useAI:false,portalRecords:[{id:'historic-service',highlevelContactId:contact.providerId,kind:'job',status:'paid',createdAt:old,startAt:old,financials:{payments:[{key:'historic-receipt',at:old,amountCents:45000}]}}],portalCoverage:{complete:true,asOf:at.toISOString()}});
  const result=await reconcileCustomerState({contactIds:[contact.id],useAI:false,portalRecords:[],portalCoverage:{complete:true,asOf:new Date().toISOString(),window:{start:prior.toISOString(),end:new Date(Date.now()+86_400_000).toISOString()}}});
  assert.equal(result.failed,0);const timeline=await getCustomerTimeline({contactId:contact.id});assert.ok(timeline.events.some(e=>e.eventType==='revenue_collected'&&e.valueCents===45000));
});

test('unreconciled customers remain in the cohort denominator and period lead count',async()=>{
  const report=await getCanonicalReport({since:prior,until:new Date()});
  assert.ok(report.coverage.missingCustomers.some(c=>c.contactId===contact.id));assert.ok(report.periodActivity.leads.contactIds.includes(contact.id));
  assert.ok(report.cohort.metrics.leads.contactIds.includes(contact.id));assert.equal(report.cohort.metrics.leads.numerator,report.cohort.denominator);
});

test('an explicit empty contact scope never expands to a global Portal retirement',async()=>{
  const result=await reconcileCustomerState({contactIds:[],useAI:false,portalRecords:[],portalCoverage:{complete:true,asOf:new Date().toISOString()}});
  assert.equal(result.inspected,0);assert.deepEqual(result.results,[]);
});

test('completed call with no customer transcript is not two-way contact and incomplete coverage stays visible',async()=>{
  await db.insert(schema.calls).values({providerMessageId:`synthetic-call-${randomUUID()}`,contactId:contact.id,direction:'outbound',actorType:'human',startedAt:at,status:'completed',answered:true,raw:{status:'completed',meta:{call:{status:'completed',duration:240}}}});
  assert.equal((await refresh()).failed,0);const timeline=await getCustomerTimeline({contactId:contact.id});assert.ok(!timeline.events.some(e=>e.eventType==='two_way_contact'));assert.equal(timeline.coverage.extraction.complete,false);assert.equal(timeline.coverage.calls.missingTranscriptIds.length,1);
});
