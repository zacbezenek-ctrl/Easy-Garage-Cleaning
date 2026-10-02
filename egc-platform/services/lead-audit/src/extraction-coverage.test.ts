import {beforeEach,expect,it,vi} from 'vitest';
import {EXTRACTOR_VERSION} from '@egc/customer-state';
import {leadsNeedingContact,leadsNotResponding,recentBookings} from './index.js';

const fixture=vi.hoisted(()=>({tables:{} as Record<string,unknown[]>}));
vi.mock('@egc/database',async importOriginal=>{
  const actual=await importOriginal<typeof import('@egc/database')>(),{getTableName}=await import('drizzle-orm');
  return {...actual,getDb:()=>({select:()=>{
    let table='';const query={from:(value:Parameters<typeof getTableName>[0])=>{table=getTableName(value);return query;},innerJoin:()=>query,where:()=>query,orderBy:()=>query,then:(resolve:(rows:unknown[])=>unknown,reject:(reason:unknown)=>unknown)=>Promise.resolve(fixture.tables[table]??[]).then(resolve,reject)};return query;
  }})};
});
const complete={extraction:{complete:true,version:EXTRACTOR_VERSION}};
const snapshot=(state:string)=>({state,intentStage:'engaged',pipeline:'direct_job',pipelineDisposition:state==='JOB_SOLD'?'converted':'active',nextRequiredAction:'Recorded next action',reconciliationStatus:'fully_reconciled',humanReviewNeeded:false,discrepancies:[],supportingEvidence:[],eventIds:['verified-event']});
beforeEach(()=>{
  const at=new Date('2026-09-21T12:00:00Z');
  fixture.tables={
    leads:['new','outreach','sold'].map((contactId,i)=>({leadId:`lead-${contactId}`,contactId,name:'Synthetic',phone:null,email:null,source:'Facebook',state:i===0?'NEVER_CONTACTED':i===1?'OUTREACH_ATTEMPTED_NO_REPLY':'BOOKED',createdAt:at,lastHumanOutreachAt:i?at:null,lastCustomerResponseAt:null,twoWayContactAt:null})),
    appointments:[{appointmentId:'visit',contactId:'sold',appointmentStartAt:at,bookingCreatedAt:at,appointmentStatus:'confirmed'}],
    customer_state_snapshots:['NEW_LEAD','OUTREACH_ATTEMPTED','JOB_SOLD'].map((state,i)=>({contactId:['new','outreach','sold'][i],snapshot:snapshot(state),coverage:complete})),
  };
});
it.each([
  {extraction:{complete:false,version:EXTRACTOR_VERSION,errors:['semantic_provider_http_429']}},
  {extraction:{complete:true,version:'older-extractor'}},
  {},
])('qualifies legacy audit presentation while preserving follow-up membership and booked facts: %j',async coverage=>{
  const beforeContact=await leadsNeedingContact(),beforeReply=await leadsNotResponding(),beforeBookings=await recentBookings();
  for(const value of fixture.tables.customer_state_snapshots!)Object.assign(value as object,{coverage});
  const contact=await leadsNeedingContact(),reply=await leadsNotResponding(),bookings=await recentBookings();
  const facts=({reconciliationStatus:_status,humanReviewNeeded:_review,discrepancies:_issues,...rest}:Record<string,unknown>)=>rest;
  expect(contact.map(facts)).toEqual(beforeContact.map(facts));expect(reply.map(facts)).toEqual(beforeReply.map(facts));
  expect(contact.map(r=>r.contactId)).not.toContain('sold');expect(reply.map(r=>r.contactId)).not.toContain('sold');
  for(const row of [...contact,...reply]){expect(row).toMatchObject({reconciliationStatus:'reconciliation_needed',humanReviewNeeded:true});expect(row.discrepancies?.some(d=>d.code==='extraction_incomplete')).toBe(true);}
  expect(bookings).toHaveLength(beforeBookings.length);expect(bookings[0]?.canonicalCustomer).toMatchObject({state:'JOB_SOLD',eventIds:['verified-event'],reconciliationStatus:'reconciliation_needed',humanReviewNeeded:true});
  expect(facts(bookings[0]!.canonicalCustomer! as unknown as Record<string,unknown>)).toEqual(facts(beforeBookings[0]!.canonicalCustomer! as unknown as Record<string,unknown>));
  expect((fixture.tables.customer_state_snapshots![0] as {snapshot:unknown}).snapshot).toMatchObject({reconciliationStatus:'fully_reconciled',humanReviewNeeded:false,discrepancies:[]});
});
it('keeps current complete audit reads clean',async()=>{
  for(const row of [...await leadsNeedingContact(),...await leadsNotResponding()])expect(row).toMatchObject({reconciliationStatus:'fully_reconciled',humanReviewNeeded:false,discrepancies:[]});
  expect((await recentBookings())[0]?.canonicalCustomer).toMatchObject({reconciliationStatus:'fully_reconciled',humanReviewNeeded:false,discrepancies:[]});
});
