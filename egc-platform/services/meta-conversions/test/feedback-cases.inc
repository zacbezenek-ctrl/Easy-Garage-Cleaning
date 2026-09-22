

// Synthetic canonical evidence plus real durable ledger; all HTTP intercepted.
async function seedFeedbackSale({valueCents=140000,withIdentity=true}={}) {
  const f=await seedLead();
  const id=`egco_${randomUUID().replaceAll('-','')}`, eventId=`feedback-${randomUUID()}`;
  await db.insert(schema.customerStateSnapshots).values({contactId:f.contact.id,leadId:f.lead.id,state:'JOB_SOLD',intentStage:'sold',pipeline:'direct_job',reconciliationStatus:'reconciled',snapshot:{excluded:false},coverage:{complete:true},lastReconciledAt:new Date()});
  if(withIdentity)await db.insert(schema.customerOccurrences).values({id,contactId:f.contact.id,leadId:f.lead.id,kind:'job',originalSourceType:'portal_job',originalSourceRecordId:'synthetic-hub-job',status:'resolved'});
  await db.insert(schema.customerEvents).values({eventId,contactId:f.contact.id,leadId:f.lead.id,occurrenceId:withIdentity?id:null,eventType:'job_sold',occurredAt:minutesAgo(10),source:'portal_job',confidence:'1.000',humanReviewNeeded:false,evidence:[{sourceType:'portal_job',sourceRecordId:'synthetic-hub-job'}],details:{},valueCents,currency:'USD',valueVerified:true});
  return {...f,occurrenceId:id,eventId};
}
test('qualified feedback and full-value Purchase persist once and never mark another canonical channel accepted',async()=>{
 const f=await seedFeedbackSale();await enableProduction();
 process.env.META_CAPI_EVENT_STAGES='QualifiedLead,Purchase';process.env.META_CAPI_QUALIFIED_SALES_FEEDBACK='true';
 const first=await syncConversions({days:7,dryRun:false});assert.equal(first.accepted,2);
 const sent=productionRequests();assert.equal(sent.length,2);assert(sent.every(p=>!('test_event_code' in p)));
 const purchase=sent.find(p=>p.data[0].event_name==='Purchase').data[0];
 assert.equal(purchase.custom_data.value,1400);assert.equal(purchase.custom_data.currency,'USD');assert.equal(purchase.custom_data.order_id,f.occurrenceId);
 assert.equal((await db.select().from(schema.customerEvents).where(eq(schema.customerEvents.eventId,f.eventId)))[0].syncState,'pending');
 const second=await syncConversions({days:7,dryRun:false});assert.equal(second.newlySent,0);assert.equal(second.alreadySynced,2);assert.equal(productionRequests().length,2);assert.equal((await attemptRows()).length,2);
 const status=await conversionStatus({days:7});assert.equal(status.transmissions.purchases,1);assert.equal(status.transmissions.purchaseValueCents,140000);assert.equal(status.deliveryByEventName.find(x=>x.eventName==='Purchase').accepted,1);
});
test('feedback activation keeps the original accepted QualifiedLead id instead of duplicating it',async()=>{
 const f=await seedFeedbackSale();
 await db.update(schema.customerEvents).set({eventType:'qualified'}).where(eq(schema.customerEvents.eventId,f.eventId));
 process.env.META_CAPI_EVENT_STAGES='QualifiedLead,Purchase';await enableProduction();
 assert.equal((await syncConversions({days:7,dryRun:false})).accepted,1);
 const prior=(await eventRows()).find(r=>r.eventType==='QualifiedLead');
 process.env.META_CAPI_QUALIFIED_SALES_FEEDBACK='true';
 await db.update(schema.customerEvents).set({eventType:'walkthrough_booked'}).where(eq(schema.customerEvents.eventId,f.eventId));
 assert.equal((await syncConversions({days:7,dryRun:false})).newlySent,0);
 assert.equal((await eventRows()).filter(r=>r.eventType==='QualifiedLead').length,1);assert.equal(productionRequests().length,1);assert.equal((await eventRows())[0].id,prior.id);
});
test('zero sale value or unbound work stays explicitly held while independently proven qualification sends',async()=>{
 await seedFeedbackSale({valueCents:0,withIdentity:false});await enableProduction();
 process.env.META_CAPI_EVENT_STAGES='QualifiedLead,Purchase';process.env.META_CAPI_QUALIFIED_SALES_FEEDBACK='true';
 const preview=await previewCanonicalConversions({days:7});const sale=preview.events.find(e=>e.stage==='Purchase');
 assert.equal(sale.eligible,false);assert(sale.reasons.includes('purchase_verified_sale_value_required'));assert(sale.reasons.includes('purchase_work_identity_requires_review'));
 const synced=await syncConversions({days:7,dryRun:false});assert.equal(synced.accepted,1);assert.equal(productionRequests()[0].data[0].event_name,'QualifiedLead');
});
test('an interrupted Purchase with changed sale amount does not retry a stale financial snapshot',async()=>{
 const f=await seedFeedbackSale();await enableProduction();process.env.META_CAPI_EVENT_STAGES='Purchase';process.env.META_CAPI_QUALIFIED_SALES_FEEDBACK='true';
 respond=async()=>{throw new Error('synthetic timeout');};await syncConversions({days:7,dryRun:false});
 const prior=(await eventRows()).find(r=>r.eventType==='Purchase');assert.equal(prior.attemptCount,1);
 await db.update(schema.customerEvents).set({valueCents:180000}).where(eq(schema.customerEvents.eventId,f.eventId));await makeRetryDue(prior.id);respond=async()=>accepted();
 await syncConversions({days:7,dryRun:false});assert.equal(productionRequests().length,1);
 const held=(await eventRows()).find(r=>r.id===prior.id);assert.equal(held.status,'skipped');assert.equal(held.error,'purchase_sale_evidence_changed_manual_review');
});
