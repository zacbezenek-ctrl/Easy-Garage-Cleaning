import {describe,it,expect} from 'vitest';
import {resolveCustomerOccurrences,type OccurrenceIdentity} from './occurrences.js';
import type {CanonicalEvent,SourceRecord} from './types.js';
import {buildCanonicalEvents,buildReport,projectCustomer} from './core.js';
import {recordsFromSnapshot} from './sources.js';
import {validateExtractedEvent} from './extractor.js';
import {applyOccurrenceProjection} from './occurrence-report.js';
const at='2026-09-21T12:00:00.000Z';
const identity=(id:string,extra:OccurrenceIdentity['aliases']=[],kind:OccurrenceIdentity['kind']='job'):OccurrenceIdentity=>({kind,authoritativePortalId:id,aliases:[{kind,namespace:`portal_${kind}`,recordId:id},...extra]});
const record=(id:string,link?:OccurrenceIdentity,type='job_sold'):SourceRecord=>({sourceType:'portal_job',sourceRecordId:id,contactId:'contact',leadId:'lead',occurredAt:at,text:id,events:[{eventType:type as 'job_sold',confidence:1,supportingText:id,humanReviewNeeded:false,nextAction:null,details:link?{occurrenceIdentity:link}:{}}]});
const resolve=(records:SourceRecord[],extra={})=>resolveCustomerOccurrences({contactId:'contact',leadId:'lead',records,now:at,...extra});
describe('durable customer work occurrences',()=>{
  it('keeps two paid jobs separate despite the same customer and opportunity',()=>{
    const one=identity('job-1'),two=identity('job-2');one.parents=two.parents=[{relationship:'deal_contains_job',alias:{kind:'job',namespace:'opportunity',recordId:'same-deal'}}];
    const result=resolve([record('job-1',one),record('job-2',two)]);
    expect(new Set(result.records.map(r=>r.events![0]!.details!.occurrenceId)).size).toBe(2);
    expect(result.issues).toEqual([]);
  });
  it('uses exact appointment bindings to join Portal, provider and local mirrors independent of order',()=>{
    const provider={kind:'job' as const,namespace:'provider_appointment',recordId:'appt'};
    const rows=[record('portal',identity('portal',[provider])),record('provider',{kind:'job',aliases:[provider]}),record('local',{kind:'job',aliases:[provider,{kind:'job',namespace:'local_job',recordId:'local'}]})];
    const first=resolve(rows),again=resolve([...rows].reverse());
    const ids=(r:ReturnType<typeof resolve>)=>r.records.map(row=>row.events![0]!.details!.occurrenceId).sort();
    expect(new Set(ids(first)).size).toBe(1);expect(ids(first)).toEqual(ids(again));
  });
  it('does not join a walkthrough predecessor and the paid job',()=>{
    const job=identity('paid');job.parents=[{relationship:'job_from_walkthrough',alias:{kind:'walkthrough',namespace:'portal_walkthrough',recordId:'visit'}}];
    const result=resolve([record('visit',identity('visit',[],'walkthrough'),'walkthrough_completed'),record('paid',job)]);
    expect(result.occurrences.filter(o=>o.status==='resolved')).toHaveLength(2);
    expect(result.links).toHaveLength(1);expect(result.links[0]!.relationship).toBe('job_from_walkthrough');
  });
  it('blocks a broken mirror binding that joins two authoritative Portal jobs',()=>{
    const same={kind:'job' as const,namespace:'provider_appointment',recordId:'broken-shared'};
    const result=resolve([record('one',identity('one',[same])),record('two',identity('two',[same]))]);
    expect(result.occurrences.filter(o=>o.status==='resolved')).toHaveLength(2);
    expect(result.issues[0]!.code).toBe('occurrence_identity_conflict');
    expect(result.records.find(r=>r.sourceRecordId==='two')!.events![0]!.humanReviewNeeded).toBe(true);
  });
  it('persists identities across late exact aliases instead of choosing a new hash',()=>{
    const first=resolve([record('local',{kind:'job',aliases:[{kind:'job',namespace:'local_job',recordId:'local'}]})]);
    const late=resolve([record('portal',identity('portal',[{kind:'job',namespace:'local_job',recordId:'local'}]))],{existingOccurrences:first.occurrences,existingAliases:first.aliases});
    expect(late.records[0]!.events![0]!.details!.occurrenceId).toBe(first.occurrences[0]!.id);
    expect(late.occurrences[0]!.authoritativePortalIds).toEqual(['portal']);
  });
  it('retains repeated unresolved acceptance as a bucket, not extra real jobs',()=>{
    const result=resolve([record('first-message'),record('second-message'),record('known-one',identity('known-one')),record('known-two',identity('known-two'))]);
    const unresolved=result.records.filter(r=>r.sourceRecordId.endsWith('message')).map(r=>r.events![0]!.details!);
    expect(unresolved[0]!.occurrenceId).toBe(unresolved[1]!.occurrenceId);
    expect(unresolved[0]!.knownOccurrencesOfKind).toBe(2);expect(unresolved[0]!.occurrenceIdentityStatus).toBe('unassigned');
    expect(result.occurrences.filter(o=>o.status==='resolved')).toHaveLength(2);
  });
  it('preserves two independently evidenced commitments from one source',()=>{
    const call=record('call');call.sourceType='call_transcript';call.events=[0,1].map(i=>({...call.events![0]!,supportingText:i?'Full cleanout Saturday accepted':'Small pickup Tuesday accepted',details:{commitmentSpanKey:`exact-span-${i}`}}));
    const result=resolve([call]);expect(new Set(result.records[0]!.events!.map(e=>e.details!.occurrenceId)).size).toBe(2);
  });
  it('validates exact independent commitment anchors and retains both jobs from one call',()=>{
    const call=record('call');call.sourceType='call_transcript';call.text='Customer: I accept the small pickup Tuesday. Customer: I accept the full cleanout Saturday.';
    const events=['small pickup Tuesday','full cleanout Saturday'].map(anchor=>validateExtractedEvent({eventType:'job_sold',supportingText:`I accept the ${anchor}.`,confidence:.98,humanReviewNeeded:false,customerCommitmentVerified:true,independentCommitment:true,commitmentAnchor:anchor},call));
    expect(events.every(Boolean)).toBe(true);call.events=events.filter((e):e is NonNullable<typeof e>=>Boolean(e));
    const canonical=buildCanonicalEvents(resolve([call]).records);expect(canonical.filter(e=>e.eventType==='job_sold')).toHaveLength(2);
    expect(validateExtractedEvent({eventType:'job_sold',supportingText:'I accept the small pickup Tuesday.',confidence:.98,customerCommitmentVerified:true,independentCommitment:true,commitmentAnchor:'made-up job'},call)).toBeNull();
  });
  it('reserves an existing collapsed milestone ID for only one exact occurrence',()=>{
    const existing={eventId:'egcev_legacy',eventType:'job_sold',occurredAt:at,syncState:'accepted',evidence:[{sourceType:'portal_job',sourceRecordId:'one'},{sourceType:'portal_job',sourceRecordId:'two'}]} as CanonicalEvent;
    const result=resolve([record('one',identity('one')),record('two',identity('two'))],{existingEvents:[existing]});
    expect(result.records.map(r=>r.events![0]!.details!.canonicalEventId).filter(Boolean)).toEqual(['egcev_legacy']);
  });
  it('refuses a cross-customer persisted alias',()=>{
    const result=resolve([record('one',identity('one'))],{existingAliases:[{kind:'job',namespace:'portal_job',recordId:'one',contactId:'someone-else',occurrenceId:'foreign'}]});
    expect(result.records[0]!.events![0]!.details!.occurrenceId).not.toBe('foreign');expect(result.issues[0]!.code).toBe('occurrence_cross_customer_alias');
  });
  it('reports work counts and verified revenue per job while cohort conversion stays one lead',()=>{
    const bundle={contact:{id:'contact',providerId:'provider'},lead:{id:'lead',createdAt:at},portalRecords:[13900,72500].map((amountCents,i)=>({id:`job-${i}`,highlevelContactId:'provider',kind:'job' as const,status:'completed',createdAt:at,completedAt:at,financials:{quote:{at,amountCents,source:'customer_approval'},payments:[{key:`receipt-${i}`,at,amountCents}]}}))};
    const resolved=resolve(recordsFromSnapshot(bundle)),events=buildCanonicalEvents(resolved.records),customer=projectCustomer({contactId:'contact',leadId:'lead',leadCreatedAt:at,events});
    const report=buildReport({events,customers:[customer],since:'2026-09-21T00:00:00Z',until:'2026-09-22T00:00:00Z'});
    expect(report.periodActivity.jobsSold!.count).toBe(2);expect(report.periodActivity.jobsCompleted!.count).toBe(2);expect(report.cohort.metrics.jobsSold!.numerator).toBe(1);expect(report.cohort.denominator).toBe(1);
    expect(report.soldRevenue.valueCents).toBe(86400);expect(report.collectedRevenue.valueCents).toBe(86400);expect(report.periodActivity.cashCollected!.count).toBe(2);
  });
  it('exact Portal service type takes precedence over a mislabeled provider visit and joins mirrors',()=>{
    const bundle={contact:{id:'contact',providerId:'provider'},lead:{id:'lead',createdAt:at},walkthroughCalendarIds:['walk-calendar'],appointments:[{id:'local-appt',providerId:'provider-appt',calendarId:'walk-calendar',title:'Free Walkthrough',status:'confirmed',appointmentCreatedAt:at,appointmentStartAt:at}],jobs:[{id:'local-job',appointmentId:'local-appt',status:'scheduled',serviceType:'Garage work',scheduledAt:at,createdAt:at}],portalRecords:[{id:'paid-work',normalizedLocalJobId:'local-job',highlevelAppointmentId:'provider-appt',highlevelContactId:'provider',kind:'job' as const,status:'scheduled',createdAt:at,startAt:at,financials:{quote:{at,amountCents:13900,source:'customer_approval'}}}]};
    const records=recordsFromSnapshot(bundle);expect(records.flatMap(r=>r.events??[]).some(e=>e.eventType==='walkthrough_booked'||e.eventType==='walkthrough_verbally_booked')).toBe(false);
    const events=buildCanonicalEvents(resolve(records).records);expect(events.filter(e=>e.eventType==='job_sold')).toHaveLength(1);expect(events.filter(e=>e.eventType==='job_scheduled')).toHaveLength(1);expect(events.find(e=>e.eventType==='job_sold')!.valueCents).toBe(13900);
  });
  it('does not add an unresolved accepted amount on top of a known job amount',()=>{
    const known=record('known',identity('known'));known.events![0]!.valueCents=30000;known.events![0]!.valueVerified=true;known.events![0]!.currency='USD';
    const claim=record('message');claim.events![0]!.valueCents=30000;claim.events![0]!.valueVerified=true;claim.events![0]!.currency='USD';
    const events=buildCanonicalEvents(resolve([known,claim]).records),customer=projectCustomer({contactId:'contact',leadCreatedAt:at,events});
    const report=buildReport({events,customers:[customer],since:'2026-09-21T00:00:00Z',until:'2026-09-22T00:00:00Z'});
    expect(report.periodActivity.jobsSold!.count).toBe(1);expect(report.soldRevenue.knownSubtotalCents).toBe(30000);expect(report.soldRevenue.valueCents).toBeNull();expect(report.soldRevenue.unallocatedVerifiedEvents).toHaveLength(1);
  });
  it('owner-confirmed collected and complete closes a stale original walkthrough and open quote',()=>{
    const visit=record('visit',identity('visit',[],'walkthrough'),'walkthrough_booked'),quote=record('quote',undefined,'quote_delivered');
    const paid=record('owner',undefined,'revenue_collected');paid.sourceType='user_confirmed';paid.occurredAt='2026-09-22T04:00:00.000Z';paid.events![0]!.details={occurredAtVerified:false,assertedAt:paid.occurredAt};
    const events=buildCanonicalEvents(resolve([visit,quote,paid]).records),base=projectCustomer({contactId:'contact',leadCreatedAt:at,events}),customer=applyOccurrenceProjection(base,events);
    expect(customer.state).toBe('CASH_COLLECTED');expect(customer.pipelineDisposition).toBe('converted');expect(customer.activeWork).toEqual([]);
  });
  it('an exact new job after owner-confirmed paid work stays active without reviving the prior estimate',()=>{
    const visit=record('old-visit',identity('old-visit',[],'walkthrough'),'walkthrough_booked'),paid=record('owner',undefined,'revenue_collected');paid.sourceType='user_confirmed';paid.events![0]!.details={occurredAtVerified:false,assertedAt:at};
    const newer=record('new-job',identity('new-job'));newer.occurredAt='2026-09-22T04:00:00.000Z';
    const events=buildCanonicalEvents(resolve([visit,paid,newer]).records),customer=applyOccurrenceProjection(projectCustomer({contactId:'contact',leadCreatedAt:at,events}),events);
    expect(customer.state).toBe('JOB_SOLD');expect(customer.activeWork).toHaveLength(1);expect(customer.activeWork![0]!.kind).toBe('job');
  });
});
