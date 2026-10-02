import {describe,it,expect} from 'vitest';
import {buildCanonicalEvents,buildReport,projectCustomer,type SourceRecord,type EvidenceEvent} from './core.js';
import {applyOccurrenceProjection} from './occurrence-report.js';
import {resolveCustomerOccurrences,type OccurrenceIdentity} from './occurrences.js';
const created='2026-09-01T12:00:00.000Z',soldAt='2026-09-24T12:00:00.000Z',cancelledAt='2026-10-01T22:00:00.000Z';
const identity=(id:string):OccurrenceIdentity=>({kind:'job',authoritativePortalId:id,aliases:[{kind:'job',namespace:'portal_job',recordId:id}]});
const source=(id:string,type:EvidenceEvent['eventType'],at:string,extra:Partial<SourceRecord>={},details:EvidenceEvent['details']={}):SourceRecord=>({sourceType:'message',sourceRecordId:id,contactId:'customer-1',leadId:'lead-1',occurredAt:at,text:id,events:[{eventType:type,confidence:1,humanReviewNeeded:false,supportingText:id,nextAction:null,details}],...extra});
const project=(events:ReturnType<typeof buildCanonicalEvents>)=>projectCustomer({contactId:'customer-1',leadCreatedAt:created,events});
const scoped=(records:SourceRecord[])=>buildCanonicalEvents(resolveCustomerOccurrences({contactId:'customer-1',leadId:'lead-1',records}).records);

describe('current customer lifecycle preserves historical milestones',()=>{
  it('a later cancellation closes sold work without deleting the accepted sale or inventing payment',()=>{
    const events=buildCanonicalEvents([source('accepted','job_sold',soldAt),source('cancelled','appointment_cancelled',cancelledAt,{sourceType:'user_confirmed'})]);
    const customer=project(events);
    expect(customer.state).toBe('FOLLOW_UP_PENDING');expect(customer.pipelineDisposition).toBe('cancelled');expect(customer.intentStage).toBe('inactive');expect(customer.nextRequiredAction).toMatch(/cancelled/);
    expect(customer.eventIds).toHaveLength(2);expect(events.some(e=>e.eventType==='revenue_collected')).toBe(false);
    const report=buildReport({events,customers:[customer],since:created,until:'2026-10-02T12:00:00Z',asOf:'2026-10-02T12:00:00Z'});
    expect(report.cohort.metrics.jobsSold!.numerator).toBe(1);expect(report.pipelines.directJob).toEqual([]);
  });
  it('fresh polling of an undated won row cannot undo cancellation',()=>{
    const events=buildCanonicalEvents([source('accepted','job_sold',soldAt),source('cancelled','appointment_cancelled',cancelledAt),source('stale-won-mirror','job_sold','2026-10-02T10:00:00.000Z',{sourceType:'opportunity'},{occurredAtVerified:false}),source('old-job','job_scheduled',soldAt,{sourceType:'job'},{occurredAtVerified:false,scheduledAt:'2026-10-07T15:30:00Z'})]);
    expect(project(events).pipelineDisposition).toBe('cancelled');
  });
  it('explicit later recommitment can reopen cancelled work',()=>{
    const events=buildCanonicalEvents([source('accepted','job_sold',soldAt),source('cancelled','appointment_cancelled',cancelledAt),source('reaccepted','job_sold','2026-10-02T10:00:00.000Z')]);
    expect(project(events).state).toBe('JOB_SOLD');expect(project(events).pipelineDisposition).toBe('converted');
  });
  it('legacy projection resets to a lower new pipeline after cancellation without changing sales history',()=>{
    const rows=[source('accepted','job_sold',soldAt),source('old-booking','walkthrough_booked',soldAt),source('cancel','appointment_cancelled',cancelledAt),source('new-video','video_quote_customer_agreed','2026-10-02T10:00:00.000Z')];
    const events=buildCanonicalEvents(rows),customer=project(events);
    expect(customer.state).toBe('VIDEO_QUOTE_PENDING_CUSTOMER');expect(customer.pipeline).toBe('video_quote');expect(customer.pipelineDisposition).toBe('active');expect(customer.videoQuoteStage).toBe('customer_agreed');expect(customer.intentStage).not.toBe('converted');
    expect(customer.supportingEvidence.map(ref=>ref.sourceRecordId)).toEqual(['new-video']);expect(customer.nextRequiredAction).toMatch(/promised customer/);
    const report=buildReport({events,customers:[customer],since:created,until:'2026-10-02T12:00:00Z',asOf:'2026-10-02T12:00:00Z'});
    expect(report.cohort.metrics.jobsSold!.numerator).toBe(1);expect(report.pipelines.videoQuote).toHaveLength(1);
  });
  it('legacy completed-and-paid history cannot hide a new walkthrough commitment or its missing provider record',()=>{
    const rows=[source('old-visit','walkthrough_booked',soldAt),source('completed','job_completed','2026-09-25T18:00:00.000Z',{sourceType:'user_confirmed'}),source('paid','revenue_collected','2026-09-25T18:00:00.000Z',{sourceType:'user_confirmed'}),source('new-visit','walkthrough_verbally_booked','2026-10-02T10:00:00.000Z')];
    const customer=project(buildCanonicalEvents(rows));
    expect(customer.state).toBe('WALKTHROUGH_VERBALLY_BOOKED');expect(customer.pipelineDisposition).toBe('active');expect(customer.intentStage).toBe('high_intent');expect(customer.supportingEvidence.map(ref=>ref.sourceRecordId)).toEqual(['new-visit']);expect(customer.discrepancies.some(d=>d.code==='verbally_booked_provider_missing')).toBe(true);
  });
  it('merged milestone evidence uses only the new commitment for current state, retaining all ledger sources',()=>{
    const events=buildCanonicalEvents([source('old-sale','job_sold',soldAt),source('completed','job_completed','2026-09-25T18:00:00.000Z'),source('new-sale','job_sold','2026-10-02T10:00:00.000Z'),source('stale-completion','job_completed','2026-10-02T11:00:00.000Z',{sourceType:'job'},{occurredAtVerified:false})]);
    const customer=project(events);
    expect(customer.state).toBe('JOB_SOLD');expect(customer.supportingEvidence.map(ref=>ref.sourceRecordId)).toEqual(['new-sale']);expect(events.find(e=>e.eventType==='job_sold')!.evidence).toHaveLength(2);expect(events.find(e=>e.eventType==='job_sold')!.occurredAt).toBe(soldAt);
  });
  it('mere outreach and undated mirrors after completion do not open another work cycle, and DNC is sticky',()=>{
    const rows=[source('completed','job_completed','2026-09-25T18:00:00.000Z'),source('outreach','human_outreach','2026-10-02T10:00:00.000Z'),source('stale-booking','walkthrough_booked','2026-10-02T11:00:00.000Z',{sourceType:'appointment'},{occurredAtVerified:false})];
    expect(project(buildCanonicalEvents(rows)).state).toBe('JOB_COMPLETED');
    expect(project(buildCanonicalEvents([...rows,source('stop','do_not_contact',cancelledAt),source('new-visit','walkthrough_verbally_booked','2026-10-02T10:00:00.000Z')])).state).toBe('DO_NOT_CONTACT');
  });
  it('newer loss overrides an earlier sale while a completed job does not regress to an old sold mirror',()=>{
    expect(project(buildCanonicalEvents([source('accepted','job_sold',soldAt),source('lost','lost',cancelledAt)])).state).toBe('LOST');
    const completed=source('completed','job_completed','2026-09-25T18:00:00.000Z',{sourceType:'user_confirmed'});
    expect(project(buildCanonicalEvents([completed,source('old-won','job_sold','2026-10-01T12:00:00.000Z',{sourceType:'opportunity'},{occurredAtVerified:false})])).state).toBe('JOB_COMPLETED');
  });
  it('exact occurrence cancellation removes only that job from active work and supports the remaining job evidence',()=>{
    const records=[source('first','job_sold',soldAt,{}, {occurrenceIdentity:identity('first')}),source('second','job_sold',soldAt,{}, {occurrenceIdentity:identity('second')}),source('cancel','appointment_cancelled',cancelledAt,{}, {occurrenceIdentity:identity('first')})];
    const events=scoped(records),customer=applyOccurrenceProjection(project(events),events);
    expect(customer.activeWork).toHaveLength(1);expect(customer.activeWork![0]!.eventIds).toContain(events.find(e=>e.evidence.some(ref=>ref.sourceRecordId==='second'))!.eventId);
    expect(customer.state).toBe('JOB_SOLD');expect(customer.pipelineDisposition).toBe('active');expect(customer.intentStage).toBe('converted');expect(customer.supportingEvidence[0]!.sourceRecordId).toBe('second');
  });
  it('unallocated owner cancellation closes stale exact job; only a later exact accepted job reopens work',()=>{
    const rows=[source('stale-job','job_sold',soldAt,{}, {occurrenceIdentity:identity('stale-job')}),source('owner-cancel','appointment_cancelled',cancelledAt,{sourceType:'user_confirmed'})];
    const events=scoped(rows),customer=applyOccurrenceProjection(project(events),events);
    expect(customer.activeWork).toEqual([]);expect(customer.pipelineDisposition).toBe('cancelled');
    const next=scoped([...rows,source('new-job','job_sold','2026-10-02T10:00:00.000Z',{}, {occurrenceIdentity:identity('new-job')})]);
    expect(applyOccurrenceProjection(project(next),next).activeWork).toHaveLength(1);
  });
  it('a verified deposit does not complete or hide a scheduled service job',()=>{
    const rows=[source('sale','job_sold',soldAt,{}, {occurrenceIdentity:identity('deposit-job')}),source('schedule','job_scheduled',soldAt,{}, {occurrenceIdentity:identity('deposit-job')}),source('deposit','revenue_collected','2026-09-25T12:00:00.000Z',{sourceType:'portal_payment'}, {occurrenceIdentity:identity('deposit-job'),paymentReceiptKey:'verified-deposit'})];
    const events=scoped(rows),customer=applyOccurrenceProjection(project(events),events);
    expect(project(events).state).toBe('JOB_SCHEDULED');expect(project(events).pipelineDisposition).toBe('active');expect(customer.state).toBe('JOB_SCHEDULED');expect(customer.pipelineDisposition).toBe('active');expect(customer.activeWork).toHaveLength(1);expect(events.some(e=>e.eventType==='revenue_collected')).toBe(true);
    const cancelled=scoped([...rows,source('cancel','appointment_cancelled',cancelledAt,{}, {occurrenceIdentity:identity('deposit-job')})]);
    expect(applyOccurrenceProjection(project(cancelled),cancelled).activeWork).toEqual([]);expect(project(cancelled).pipelineDisposition).toBe('cancelled');
  });
  it('same-name or similar-name customers never share lifecycle evidence',()=>{
    const own=source('own','job_sold',soldAt),foreign=source('foreign','job_completed',cancelledAt,{contactId:'different-customer',leadId:'different-lead'});
    const events=buildCanonicalEvents([own,foreign]),customer=project(events);
    expect(customer.state).toBe('JOB_SOLD');expect(customer.eventIds).toEqual(events.filter(e=>e.contactId==='customer-1').map(e=>e.eventId));expect(customer.supportingEvidence.some(ref=>ref.sourceRecordId==='foreign')).toBe(false);
  });
});

describe('report denominator and observation boundaries',()=>{
  it('caps observed-through and maturity at generation time and excludes future evidence',()=>{
    const asOf='2026-10-02T12:00:00.000Z',events=buildCanonicalEvents([source('now','two_way_contact','2026-10-02T10:00:00.000Z'),source('future','job_sold','2026-10-02T18:00:00.000Z')]);
    const report=buildReport({events,customers:[project(events)],since:'2026-10-02T00:00:00Z',until:'2026-10-03T00:00:00Z',cohortSince:created,asOf});
    expect(report.period.observedThrough).toBe(asOf);expect(report.cohort.observedThrough).toBe(asOf);expect(report.cohort.metrics.jobsSold!.observedThrough).toBe(asOf);expect(report.periodActivity.jobsSold!.count).toBe(0);expect(report.cohort.maturity.oldestLeadAgeDays).toBe(31);
  });
  it('fresh applicant exclusion keeps stale snapshots out of activity and conversion numerator without dropping real DNC leads',()=>{
    const events=buildCanonicalEvents([source('recruiting','two_way_contact',soldAt)]),customer=project(events);
    const roster=[{contactId:'customer-1',leadCreatedAt:created,excluded:true},{contactId:'real-dnc',leadCreatedAt:created,excluded:false}];
    const report=buildReport({events,customers:[customer],leadRoster:roster,since:created,until:'2026-10-02T12:00:00Z',asOf:'2026-10-02T12:00:00Z'});
    expect(report.cohort.denominator).toBe(1);expect(report.cohort.metrics.leads!.contactIds).toEqual(['real-dnc']);expect(report.periodActivity.twoWayContacts!.count).toBe(0);expect(report.customers).toEqual([]);expect(report.excludedCustomers[0]!.contactId).toBe('customer-1');
  });
  it('recent events from an older acquisition stay in period activity without entering the current cohort',()=>{
    const events=buildCanonicalEvents([source('recent-completion','job_completed','2026-10-02T10:00:00.000Z')]);
    const report=buildReport({events,customers:[project(events)],leadRoster:[{contactId:'customer-1',leadCreatedAt:created,excluded:false}],since:'2026-10-02T00:00:00Z',until:'2026-10-03T00:00:00Z',asOf:'2026-10-02T12:00:00Z'});
    expect(report.periodActivity.jobsCompleted!.count).toBe(1);expect(report.cohort.denominator).toBe(0);expect(report.cohort.metrics.jobsCompleted!.numerator).toBe(0);
  });
});
