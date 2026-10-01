import {describe,it,expect} from 'vitest';
import {salesAcquisitionCohort,acquisitionAttribution} from './acquisition.js';
import {classifyAttribution,type ConversionLead} from './core.js';
const range={from:new Date('2026-09-01'),to:new Date('2026-10-01')};
const lead=(id:string,raw:Record<string,unknown>={}):ConversionLead=>({leadId:id,contactId:id,createdAt:'2026-09-20T00:00:00Z',phone:'+19705551234',source:'Facebook',raw:{attributionSource:{source:'Facebook',adId:'120253868777650385',campaignId:'120253712240240385',sessionSource:'Paid Social'},...raw}});
describe('historical customer acquisition denominator',()=>{
 it('excludes explicit applicants, staff/internal, vendors and tests while retaining ordinary customers',()=>{
  const rows=[lead('customer'),lead('applicant',{tags:['Applicant-active']}),lead('employee',{isInternal:true}),lead('vendor',{tags:['egc-vendor']}),lead('test',{isTest:true})];
  const result=salesAcquisitionCohort(rows,new Map(rows.map(r=>[r.contactId,{excluded:false}])),range);
  expect(result.customers.map(r=>r.contactId)).toEqual(['customer']);expect(result.meta).toHaveLength(1);expect(result.coverage).toMatchObject({inventoryLeads:5,salesLeads:1,excludedCount:4,heldIdentityCount:0,complete:true});
 });
 it('does not remove later DNC/lost/inactive or insufficient matching from original paid acquisition',()=>{
  const normal=lead('customer'),optedOut=lead('customer',{dnd:true,doNotContact:true,tags:['do-not-contact']}),missingMatch={...lead('missing'),phone:null};
  const original=salesAcquisitionCohort([normal],new Map([['customer',{state:'NEW_LEAD',excluded:false}]]),range);
  for(const state of ['DO_NOT_CONTACT','LOST','inactive']){
   const result=salesAcquisitionCohort([optedOut],new Map([['customer',{state,excluded:false,exclusionReasons:['do_not_contact']}]]),range);expect(result.meta.length).toBe(original.meta.length);
  }
  expect(salesAcquisitionCohort([missingMatch],new Map([['missing',{excluded:false}]]),range).meta).toHaveLength(1);
  expect(classifyAttribution(optedOut).classification).toBe('ambiguous');expect(acquisitionAttribution(optedOut).classification).toBe('eligible_meta_paid');expect(optedOut.raw).toMatchObject({dnd:true,tags:['do-not-contact']});
 });
 it('holds missing/unclassified canonical identity visibly rather than guessing or silently counting it',()=>{
  const result=salesAcquisitionCohort([lead('missing'),lead('unclassified'),lead('applicant',{tags:['applicant-engaged']})],new Map([['unclassified',{excluded:true}]]),range);
  expect(result.customers).toEqual([]);expect(result.coverage).toMatchObject({complete:false,heldIdentityCount:2,excludedCount:1});expect(result.coverage.heldIdentity.map(r=>r.reason)).toEqual(['missing_canonical_identity','canonical_identity_exclusion_unclassified']);
 });
 it('uses canonical explicit exclusions and original attribution despite later organic source',()=>{
  const row=lead('customer',{source:'Google',lastAttributionSource:{source:'Google'}});row.source='Google';
  expect(acquisitionAttribution(row).classification).toBe('eligible_meta_paid');expect(salesAcquisitionCohort([row],new Map([['customer',{excluded:true,exclusionReasons:['job_applicant']}]]),range).coverage.excludedCount).toBe(1);
 });
});
