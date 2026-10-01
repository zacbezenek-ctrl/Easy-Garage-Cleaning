import {describe,it,expect} from 'vitest';
import {buildCanonicalEvents,buildReport,EXTRACTOR_VERSION,projectCustomer,type SourceRecord} from './core.js';
import {extractionCoverageComplete,qualifyExtractionCoverage} from './extraction-coverage.js';
import {formatOperationalBriefing} from './briefing.js';

const at='2026-09-21T18:00:00.000Z';
const complete={extraction:{version:EXTRACTOR_VERSION,complete:true,errors:[],partialSourceIds:[]},calls:{missingTranscriptIds:[]}};
const records:SourceRecord[]=[{sourceType:'portal_job',sourceRecordId:'synthetic-job',contactId:'customer',leadId:'lead',occurredAt:at,text:'Verified sale and payment',events:[
  {eventType:'job_sold',confidence:1,humanReviewNeeded:false,nextAction:null,supportingText:'Verified sale',valueCents:13900,valueVerified:true,currency:'USD'},
  {eventType:'revenue_collected',confidence:1,humanReviewNeeded:false,nextAction:null,supportingText:'Verified payment',valueCents:13900,valueVerified:true,currency:'USD'},
]}];
const events=buildCanonicalEvents(records),customer=projectCustomer({contactId:'customer',leadId:'lead',leadCreatedAt:at,events});
const report=(customers=[customer])=>buildReport({events,customers,since:'2026-09-20T00:00:00.000Z',until:'2026-09-22T00:00:00.000Z'});

describe('extraction coverage qualifies confidence, never business facts',()=>{
  it.each([
    ['failed provider extraction',{...complete,extraction:{...complete.extraction,complete:false,errors:['semantic_provider_http_429'],partialSourceIds:['cached-call']}}],
    ['incomplete extraction',{...complete,extraction:{...complete.extraction,complete:false}}],
    ['cached errors despite a complete flag',{...complete,extraction:{...complete.extraction,errors:['semantic_provider_http_429']}}],
    ['cached partial source despite a complete flag',{...complete,extraction:{...complete.extraction,partialSourceIds:['cached-call']}}],
    ['missing transcript despite a complete flag',{...complete,calls:{missingTranscriptIds:['untranscribed-call']}}],
    ['stale extractor version',{...complete,extraction:{...complete.extraction,version:'older-extractor'}}],
    ['missing extractor version',{extraction:{complete:true}}],
    ['missing persisted coverage',undefined],
  ])('%s cannot claim full reconciliation',(_name,coverage)=>{
    const before=structuredClone(customer),qualified=qualifyExtractionCoverage(customer,coverage);
    expect(extractionCoverageComplete(coverage)).toBe(false);
    expect(qualified).toMatchObject({state:'CASH_COLLECTED',intentStage:'converted',reconciliationStatus:'reconciliation_needed',humanReviewNeeded:true});
    expect(qualified.discrepancies.find(d=>d.code==='extraction_incomplete')).toBeDefined();
    expect(customer).toEqual(before);
    const {reconciliationStatus:_status,humanReviewNeeded:_review,discrepancies:_issues,...facts}=qualified;
    const {reconciliationStatus:_oldStatus,humanReviewNeeded:_oldReview,discrepancies:_oldIssues,...originalFacts}=before;
    expect(facts).toEqual(originalFacts);
    const full=report(),result=report([qualified]);
    for(const key of ['periodActivity','cohort','soldRevenue','collectedRevenue','countedEvents'] as const)expect(result[key]).toEqual(full[key]);
  });
  it('preserves current complete snapshots exactly, including other reconciliation issues',()=>{
    expect(extractionCoverageComplete(complete)).toBe(true);
    expect(qualifyExtractionCoverage(customer,complete)).toBe(customer);
    const pending={...customer,reconciliationStatus:'duplicate_suspected' as const,humanReviewNeeded:true,discrepancies:[{code:'duplicate_appointment_suspected',detail:'Review duplicate booking',sourceIds:['booking']}]};
    expect(qualifyExtractionCoverage(pending,complete)).toBe(pending);
  });
  it('retains booking state and existing issues while adding one idempotent extraction warning',()=>{
    const booking=projectCustomer({contactId:'customer',leadCreatedAt:at,events:buildCanonicalEvents([{sourceType:'message',sourceRecordId:'agreement',contactId:'customer',occurredAt:at,text:'Agreed visit',events:[{eventType:'walkthrough_verbally_booked',confidence:1,humanReviewNeeded:false,nextAction:null,supportingText:'Agreed visit'}]}])});
    const coverage={...complete,extraction:{...complete.extraction,complete:false,errors:['semantic_provider_http_429'],partialSourceIds:['cached-call','cached-call']},calls:{missingTranscriptIds:['untranscribed-call']}};
    const qualified=qualifyExtractionCoverage(booking,coverage);
    expect(qualified.state).toBe('WALKTHROUGH_VERBALLY_BOOKED');expect(qualified.nextRequiredAction).toBe(booking.nextRequiredAction);
    expect(qualified.discrepancies.map(d=>d.code)).toEqual(['verbally_booked_provider_missing','extraction_incomplete']);
    expect(qualified.discrepancies.at(-1)).toMatchObject({sourceIds:['cached-call','untranscribed-call']});
    expect(qualified.discrepancies.at(-1)?.detail).toContain('semantic_provider_http_429');
    expect(qualifyExtractionCoverage(qualified,coverage)).toEqual(qualified);
  });
  it('compact briefs retain extraction warnings in customer and pipeline rows without changing totals',()=>{
    const active={...customer,state:'JOB_SOLD' as const,pipeline:'direct_job' as const,pipelineDisposition:'active' as const};
    const coverage={...complete,extraction:{...complete.extraction,complete:false,errors:['semantic_provider_http_429']}};
    const full={...report([qualifyExtractionCoverage(active,coverage)]),coverage:{complete:false,customers:[{contactId:'customer',coverage}]}};
    const brief=formatOperationalBriefing(full);
    expect(brief.customers[0]).toMatchObject({reconciliationStatus:'reconciliation_needed',humanReviewNeeded:true});
    expect(brief.pipelines.directJob[0]).toMatchObject({reconciliationStatus:'reconciliation_needed',humanReviewNeeded:true});
    expect(brief.pipelines.directJob[0]?.discrepancies.some(d=>d.code==='extraction_incomplete')).toBe(true);
    expect(brief.coverage?.customers[0]).toMatchObject({semanticComplete:false,extractionErrors:['semantic_provider_http_429']});
    expect(brief.soldRevenue).toEqual(full.soldRevenue);expect(brief.collectedRevenue).toEqual(full.collectedRevenue);
    expect(brief.periodActivity.jobsSold?.count).toBe(full.periodActivity.jobsSold?.count);
  });
  it('compact source coverage rejects stale cached completion',()=>{
    const brief=formatOperationalBriefing({...report(),coverage:{complete:false,customers:[{contactId:'customer',coverage:{extraction:{complete:true,version:'older-extractor'}}}]}});
    expect(brief.coverage?.customers[0]?.semanticComplete).toBe(false);
  });
});
