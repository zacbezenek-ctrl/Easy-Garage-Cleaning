import test,{after,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';

const url=new URL(process.env.DATABASE_URL??'http://invalid');
if(process.env.EGC_CUSTOMER_STATE_TEST!=='isolated'||!['localhost','127.0.0.1'].includes(url.hostname)||!['/egc_operations_test','/egc_customer_state_test'].includes(url.pathname)||!['postgres:','postgresql:'].includes(url.protocol))throw new Error('Customer-state integration requires EGC_CUSTOMER_STATE_TEST=isolated and explicitly named loopback test database');
const {getDb,schema}=await import('@egc/database');
const {eq,sql}=await import('drizzle-orm');
const {reconcileCustomerState,recordUserConfirmedOutcome,getCustomerTimeline,getCanonicalReport,getOperationalEventEvidence}=await import('../dist/index.js');
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

test('two exact paid jobs remain separate occurrences with one acquisition after legacy migration and replay',async()=>{
  const records=[13900,72500].map((amountCents,i)=>({id:`occurrence-${contact.id}-${i}`,highlevelContactId:contact.providerId,kind:'job',status:'completed',createdAt:prior.toISOString(),completedAt:at.toISOString(),financials:{quote:{at:prior.toISOString(),amountCents,source:'customer_approval'},payments:[{key:`receipt-${contact.id}-${i}`,at:at.toISOString(),amountCents}]}}));
  await reconcileCustomerState({contactIds:[contact.id],useAI:false,portalRecords:records,occurrenceMode:'off'});
  const legacy=(await getCustomerTimeline({contactId:contact.id})).events.find(e=>e.eventType==='job_sold').eventId;
  await db.update(schema.customerEvents).set({syncState:'accepted'}).where(eq(schema.customerEvents.eventId,legacy));
  const enabled=await reconcileCustomerState({contactIds:[contact.id],useAI:false,portalRecords:records,occurrenceMode:'enabled'});assert.equal(enabled.failed,0);
  let timeline=await getCustomerTimeline({contactId:contact.id}),sold=timeline.events.filter(e=>e.eventType==='job_sold');assert.equal(sold.length,2);assert.equal(new Set(sold.map(e=>e.occurrenceId)).size,2);assert.ok(sold.some(e=>e.eventId===legacy&&e.syncState==='accepted'));
  const originalIds=sold.map(e=>e.eventId).sort();
  await reconcileCustomerState({contactIds:[contact.id],useAI:false,occurrenceMode:'enabled'});timeline=await getCustomerTimeline({contactId:contact.id});assert.deepEqual(timeline.events.filter(e=>e.eventType==='job_sold').map(e=>e.eventId).sort(),originalIds);
  const report=await getCanonicalReport({since:new Date(Date.now()-7*86400000),until:new Date()});
  assert.equal(report.periodActivity.jobsSold.contactIds.filter(id=>id===contact.id).length,1);assert.ok(report.periodActivity.jobsSold.count>=2);assert.equal(report.periodActivity.jobsSold.unit,'distinct_job_occurrences');
  const ownSold=timeline.events.filter(e=>e.eventType==='job_sold');assert.equal(ownSold.reduce((n,e)=>n+e.valueCents,0),86400);assert.equal(timeline.events.filter(e=>e.eventType==='revenue_collected').reduce((n,e)=>n+e.valueCents,0),86400);
});

test('occurrence shadow mode persists exact identities while preserving the live legacy event set',async()=>{
  const records=[0,1].map(i=>({id:`shadow-${contact.id}-${i}`,highlevelContactId:contact.providerId,kind:'job',status:'quote_sent',createdAt:prior.toISOString(),financials:{quote:{at:prior.toISOString(),amountCents:10000,source:'customer_approval'}}}));
  const result=await reconcileCustomerState({contactIds:[contact.id],useAI:false,portalRecords:records,occurrenceMode:'shadow'});assert.equal(result.failed,0);
  const timeline=await getCustomerTimeline({contactId:contact.id});assert.equal(timeline.events.filter(e=>e.eventType==='job_sold').length,1);assert.equal(timeline.occurrences.filter(o=>o.status==='resolved').length,2);assert.equal(timeline.coverage.occurrences.preview.periodActivity.jobsSold.count,2);
});

test('separate receipts on one job survive occurrence migration and repeated reconciliation',async()=>{
  const receipts=[{key:`deposit-${contact.id}`,at:prior.toISOString(),amountCents:10000},{key:`balance-${contact.id}`,at:at.toISOString(),amountCents:20000}];
  const portalRecords=[{id:`installments-${contact.id}`,highlevelContactId:contact.providerId,kind:'job',status:'paid',createdAt:prior.toISOString(),financials:{payments:receipts}}];
  await reconcileCustomerState({contactIds:[contact.id],useAI:false,portalRecords,occurrenceMode:'off'});
  const original=(await getCustomerTimeline({contactId:contact.id})).events.filter(e=>e.eventType==='revenue_collected').map(e=>e.eventId).sort();assert.equal(original.length,2);
  for(let i=0;i<3;i++){
    const result=await reconcileCustomerState({contactIds:[contact.id],useAI:false,portalRecords,occurrenceMode:'enabled'});assert.equal(result.failed,0);
    const collected=(await getCustomerTimeline({contactId:contact.id})).events.filter(e=>e.eventType==='revenue_collected');assert.deepEqual(collected.map(e=>e.eventId).sort(),original);assert.equal(collected.reduce((n,e)=>n+e.valueCents,0),30000);assert.equal(new Set(collected.map(e=>e.occurredAt)).size,2);
  }
});

test('a completed paid job cannot hide a second accepted unscheduled job',async()=>{
  const records=[{id:`done-${contact.id}`,highlevelContactId:contact.providerId,kind:'job',status:'completed',createdAt:prior.toISOString(),completedAt:at.toISOString(),financials:{quote:{at:prior.toISOString(),amountCents:10000,source:'customer_approval'},payments:[{key:`done-payment-${contact.id}`,at:at.toISOString(),amountCents:10000}]}},{id:`next-${contact.id}`,highlevelContactId:contact.providerId,kind:'job',status:'quote_sent',createdAt:at.toISOString(),financials:{quote:{at:at.toISOString(),amountCents:30000,source:'customer_approval'}}}];
  const result=await reconcileCustomerState({contactIds:[contact.id],useAI:false,portalRecords:records,occurrenceMode:'enabled'});assert.equal(result.failed,0);
  const timeline=await getCustomerTimeline({contactId:contact.id});assert.equal(timeline.customer.state,'JOB_SOLD');assert.equal(timeline.customer.pipelineDisposition,'active');assert.equal(timeline.customer.activeWork.length,1);assert.match(timeline.customer.nextRequiredAction,/schedule|Portal/i);
});

test('read refresh preserves the worker semantic provider error on cached partial evidence',async()=>{
  const providerId=`cached-error-${randomUUID()}`;
  await db.insert(schema.messages).values({providerId,contactId:contact.id,type:'SMS',direction:'inbound',actorType:'customer',body:'Can you provide a quote?',occurredAt:at});
  await refresh();
  await db.update(schema.customerEvidence).set({status:'partial',error:'semantic_provider_http_429'}).where(eq(schema.customerEvidence.sourceRecordId,providerId));
  await refresh();
  const [source]=await db.select().from(schema.customerEvidence).where(eq(schema.customerEvidence.sourceRecordId,providerId));
  assert.equal(source.error,'semantic_provider_http_429');
  const timeline=await getCustomerTimeline({contactId:contact.id});assert.ok(timeline.coverage.extraction.errors.includes('semantic_provider_http_429'));
});

test('worker bulk window includes recent leads and older leads with recent call activity',async()=>{
  await db.update(schema.leads).set({createdAt:new Date(Date.now()-60*86_400_000)}).where(eq(schema.leads.id,lead.id));
  await db.insert(schema.calls).values({providerMessageId:`bulk-call-${randomUUID()}`,contactId:contact.id,direction:'outbound',actorType:'human',startedAt:at,status:'no-answer',raw:{status:'no-answer'}});
  const result=await reconcileCustomerState({since:new Date(Date.now()-7*86_400_000),until:new Date(),useAI:false});
  assert.equal(result.failed,0);assert.ok(result.results.some(r=>r.contactId===contact.id));
});

test('aged active video quotes and newly updated opportunities remain in the evidence window',async()=>{
  const old=new Date(Date.now()-90*86400000);
  await db.update(schema.leads).set({createdAt:old}).where(eq(schema.leads.id,lead.id));
  await db.insert(schema.customerStateSnapshots).values({contactId:contact.id,leadId:lead.id,state:'VIDEO_QUOTE_PENDING_CUSTOMER',intentStage:'engaged',pipeline:'video_quote',reconciliationStatus:'fully_reconciled',snapshot:{pipelineDisposition:'active'},coverage:{},lastReconciledAt:old});
  let result=await reconcileCustomerState({since:new Date(Date.now()-7*86400000),useAI:false});assert.ok(result.results.some(r=>r.contactId===contact.id));
  await db.delete(schema.customerStateSnapshots).where(eq(schema.customerStateSnapshots.contactId,contact.id));
  await db.insert(schema.opportunities).values({providerId:`active-opportunity-${randomUUID()}`,contactId:contact.id,status:'open',providerUpdatedAt:new Date()});
  result=await reconcileCustomerState({since:new Date(Date.now()-7*86400000),useAI:false});assert.ok(result.results.some(r=>r.contactId===contact.id));assert.equal(result.failed,0);
});

test('bounded refresh rotates through active customers rather than repeatedly selecting the newest one',async()=>{
  const [other]=await db.insert(schema.contacts).values({providerId:`synthetic-rotation-${randomUUID()}`}).returning();created.push(other.id);await db.insert(schema.leads).values({contactId:other.id});
  const input={contactIds:[contact.id,other.id],useAI:false,maxContacts:1};const first=await reconcileCustomerState(input),second=await reconcileCustomerState(input);
  assert.equal(first.truncated,true);assert.equal(second.truncated,true);assert.equal(first.failed,0);assert.equal(second.failed,0);assert.notEqual(first.results[0].contactId,second.results[0].contactId);
});

test('provider notes are read by exact normalized contact identity with visible source coverage',async()=>{
  await db.insert(schema.providerMappings).values({provider:'ghl',resourceType:'contact_note',providerId:`synthetic-note-${randomUUID()}`,raw:{egcContactId:contact.id,body:'Customer asked for a video quote.',dateAdded:at.toISOString(),egcNotesReadAt:at.toISOString()}});
  await db.insert(schema.syncCursors).values({key:`customer_state:provider_notes:${contact.id}`,cursor:JSON.stringify({complete:true,count:1,asOf:at.toISOString()})});
  const result=await refresh();assert.equal(result.failed,0);
  const timeline=await getCustomerTimeline({contactId:contact.id});assert.equal(timeline.coverage.providerNotes.inspected,1);assert.equal(timeline.coverage.providerNotes.complete,true);assert.ok(timeline.extraction.some(e=>e.sourceType==='provider_note'));
});

test('provider deletion tombstone removes cached note-derived conversions on replay',async()=>{
  const providerId=`synthetic-tombstone-${randomUUID()}`;
  await db.insert(schema.providerMappings).values({provider:'ghl',resourceType:'contact_note',providerId,raw:{egcContactId:contact.id,body:'Customer accepted the quote.',dateAdded:at.toISOString()}});
  await refresh();
  await db.update(schema.customerEvidence).set({status:'complete',extractedEvents:[{eventType:'job_sold',confidence:1,supportingText:'Customer accepted the quote.',humanReviewNeeded:false,nextAction:null}]}).where(eq(schema.customerEvidence.sourceRecordId,providerId));
  await refresh();assert.ok((await getCustomerTimeline({contactId:contact.id})).events.some(e=>e.eventType==='job_sold'));
  await db.update(schema.providerMappings).set({raw:{egcContactId:contact.id,body:'Customer accepted the quote.',dateAdded:at.toISOString(),egcDeleted:true}}).where(eq(schema.providerMappings.providerId,providerId));
  await refresh();await refresh();assert.ok(!(await getCustomerTimeline({contactId:contact.id})).events.some(e=>e.eventType==='job_sold'));
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
  assert.equal(timeline.assertions[0].status,'pending_reconciliation'); // CRM amount alone is not verified accepted revenue.
  await reconcileCustomerState({contactIds:[contact.id],useAI:false,portalRecords:[{id:'accepted-quote',highlevelContactId:contact.providerId,kind:'job',status:'quote_sent',createdAt:at.toISOString(),financials:{quote:{at:at.toISOString(),amountCents:45000,source:'customer_approval'}}}]});timeline=await getCustomerTimeline({contactId:contact.id});
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

test('report coverage excludes cold history while retaining older active work, period events, and explicit cohorts',async()=>{
  const old=new Date(Date.now()-90*86400000),ids=[];
  for(let i=0;i<3;i++){
    const [c]=await db.insert(schema.contacts).values({providerId:`scope-${randomUUID()}`,name:'Synthetic historical scope',source:'Facebook'}).returning();created.push(c.id);ids.push(c.id);
    await db.insert(schema.leads).values({contactId:c.id,source:'Facebook',createdAt:old});
    await reconcileCustomerState({contactIds:[c.id],useAI:false,portalRecords:i===2?[{id:`scope-quote-${c.id}`,highlevelContactId:c.providerId,kind:'job',status:'quote_sent',createdAt:old.toISOString(),financials:{quote:{at:at.toISOString(),amountCents:13900,source:'customer_approval'}}}]:[]});
  }
  const active=(await getCustomerTimeline({contactId:ids[1]})).customer;
  await db.update(schema.customerStateSnapshots).set({state:'VIDEO_QUOTE_PENDING_CUSTOMER',snapshot:{...active,state:'VIDEO_QUOTE_PENDING_CUSTOMER',pipeline:'video_quote',pipelineDisposition:'active'}}).where(eq(schema.customerStateSnapshots.contactId,ids[1]));
  const report=await getCanonicalReport({since:prior,until:new Date()});
  assert.ok(!report.customers.some(c=>c.contactId===ids[0]));assert.ok(!report.coverage.customers.some(c=>c.contactId===ids[0]));
  assert.ok(report.customers.some(c=>c.contactId===ids[1]));assert.ok(report.periodActivity.jobsSold.contactIds.includes(ids[2]));
  assert.equal(report.coverage.scope,'report_cohort_period_activity_and_active_opportunities');assert.ok(report.coverage.historicalInventory.outsideReportScope>=1);
  const cohort=await getCanonicalReport({since:prior,until:new Date(),cohortSince:new Date(old.valueOf()-1000),cohortUntil:new Date(old.valueOf()+1000)});
  assert.ok(cohort.coverage.customers.some(c=>c.contactId===ids[0]));assert.ok(cohort.cohort.metrics.leads.contactIds.includes(ids[0]));
});

test('report evidence pages preserve all counted event identities and original source references',async()=>{
  const sourceIds=[];for(let i=0;i<7;i++){const providerId=`pagination-outreach-${randomUUID()}`;sourceIds.push(providerId);await db.insert(schema.messages).values({providerId,contactId:contact.id,type:'SMS',direction:'outbound',actorType:'human',body:`Scheduling follow-up ${i}.`,occurredAt:at});}
  await refresh();const timeline=await getCustomerTimeline({contactId:contact.id}),eventIds=timeline.events.filter(e=>e.eventType==='human_outreach').map(e=>e.eventId),seen=[];
  for(let offset=0;offset<eventIds.length;offset+=2){const page=await getOperationalEventEvidence({since:prior,until:new Date(),eventIds,offset,limit:2});assert.equal(page.page.total,7);seen.push(...page.events);}
  assert.deepEqual(new Set(seen.map(e=>e.eventId)),new Set(eventIds));assert.deepEqual(new Set(seen.flatMap(e=>e.evidence.map(r=>r.sourceRecordId))),new Set(sourceIds));
  const report=await getCanonicalReport({since:prior,until:new Date(),evidenceLimit:2});assert.equal(report.countedEvents.length,2);assert.ok(eventIds.every(id=>report.periodActivity.humanOutreach.eventIds.includes(id)));assert.ok(report.countedEventsPage.nextOffset!==null);
});

test('completed call with no customer transcript is not two-way contact and incomplete coverage stays visible',async()=>{
  await db.insert(schema.calls).values({providerMessageId:`synthetic-call-${randomUUID()}`,contactId:contact.id,direction:'outbound',actorType:'human',startedAt:at,status:'completed',answered:true,raw:{status:'completed',meta:{call:{status:'completed',duration:240}}}});
  const result=await refresh();assert.equal(result.failed,0);assert.equal(result.partialCustomers,1);const timeline=await getCustomerTimeline({contactId:contact.id});assert.ok(!timeline.events.some(e=>e.eventType==='two_way_contact'));assert.equal(timeline.coverage.extraction.complete,false);assert.equal(timeline.coverage.calls.missingTranscriptIds.length,1);
});
