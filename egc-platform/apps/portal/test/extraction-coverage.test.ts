import {beforeEach,expect,it,vi} from 'vitest';
import {EXTRACTOR_VERSION} from '@egc/customer-state';
import {getLeads} from '../lib/data';

const fixture=vi.hoisted(()=>({rows:[] as unknown[],limit:vi.fn()}));
vi.mock('@egc/database',async importOriginal=>{
  const actual=await importOriginal<typeof import('@egc/database')>();
  const query={from:()=>query,innerJoin:()=>query,leftJoin:()=>query,orderBy:()=>query,limit:(limit:number)=>{fixture.limit(limit);return Promise.resolve(fixture.rows);}};
  return {...actual,getDb:()=>({select:()=>query})};
});
const snapshot={state:'JOB_SOLD',intentStage:'converted',reconciliationStatus:'fully_reconciled',humanReviewNeeded:false,discrepancies:[],eventIds:['verified-sale'],nextRequiredAction:'Schedule accepted work'};
const row=(extraction:unknown)=>({lead:{id:'lead'},contact:{id:'customer'},customerState:{state:'JOB_SOLD',intentStage:'converted',reconciliationStatus:'fully_reconciled',snapshot:structuredClone(snapshot),coverage:{extraction},lastReconciledAt:new Date('2026-09-20T00:00:00Z')},originalAttribution:{source:'Facebook'}});
beforeEach(()=>{fixture.rows=[];fixture.limit.mockClear();});
it.each([{complete:false,version:EXTRACTOR_VERSION,errors:['semantic_provider_http_429']},{complete:true,version:'older-extractor'},undefined])('qualifies cached status in the Leads directory without rewriting facts: %j',async extraction=>{
  const source=row(extraction);fixture.rows=[source];
  const rows=await getLeads(5),result=rows[0]!;
  expect(rows).toHaveLength(1);expect(fixture.limit).toHaveBeenCalledWith(5);
  expect(result.lead).toEqual(source.lead);expect(result.contact).toEqual(source.contact);expect(result.originalAttribution).toEqual(source.originalAttribution);
  expect(result.customerState).toMatchObject({state:'JOB_SOLD',intentStage:'converted',reconciliationStatus:'reconciliation_needed',lastReconciledAt:source.customerState.lastReconciledAt,snapshot:{state:'JOB_SOLD',eventIds:['verified-sale'],nextRequiredAction:'Schedule accepted work',humanReviewNeeded:true}});
  expect(result.customerState!.snapshot.discrepancies).toEqual(expect.arrayContaining([expect.objectContaining({code:'extraction_incomplete'})]));
  expect(source.customerState.snapshot).toEqual(snapshot);expect(source.customerState.reconciliationStatus).toBe('fully_reconciled');
});
it('preserves current complete and absent snapshots in the Leads directory',async()=>{
  const complete=row({complete:true,version:EXTRACTOR_VERSION,errors:[],partialSourceIds:[]}),missing={...complete,customerState:null};fixture.rows=[complete,missing];
  expect(await getLeads()).toEqual([complete,missing]);
});
