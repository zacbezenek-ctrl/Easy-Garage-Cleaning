import {classifyAttribution,type ConversionLead} from './core.js';
import type {CanonicalCustomerGate} from './canonical.js';
const object=(v:unknown):Record<string,unknown>=>v&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:{};
const tag=(v:unknown)=>typeof v==='string'?v.trim().toLowerCase().replace(/[-_:]+/g,' ').replace(/\s+/g,' '):'';
const nonCustomerReasons=new Set(['test_internal_or_vendor','job_applicant']);
/** Acquisition is historical. A later opt-out/loss must not improve conversion
 * rates by removing the lead; this clone is never used for sender eligibility. */
export function acquisitionAttribution(lead:ConversionLead){
 const raw=object(lead.raw);
 return classifyAttribution({...lead,raw:{...raw,dnd:false,doNotContact:false,tags:(Array.isArray(raw.tags)?raw.tags:[]).filter(t=>!['dnc','do not contact'].includes(tag(t)))}});
}
export function salesAcquisitionCohort(leads:readonly ConversionLead[],snapshots:ReadonlyMap<string,CanonicalCustomerGate>,range:{from:Date;to:Date}){
 const inventory=leads.filter(lead=>{const at=new Date(lead.providerCreatedAt??lead.createdAt??0);return at>=range.from&&at<=range.to;});
 const customers:ConversionLead[]=[],excluded:Array<{contactId:string;leadId:string;reasons:string[]}>=[],held:Array<{contactId:string;leadId:string;reason:string}>=[];
 for(const lead of inventory){
  const raw=object(lead.raw),tags=(Array.isArray(raw.tags)?raw.tags:[]).map(tag),canonical=snapshots.get(lead.contactId),reasons:string[]=[];
  if(tags.some(t=>/^applicant(?:$| )/.test(t)))reasons.push('job_applicant');
  if(tags.some(t=>['egc test','test','test lead','routing canary','internal','egc internal','vendor','egc vendor','supplier'].includes(t))||['isTest','is_test','isTestLead','is_test_lead','isInternal','isVendor'].some(k=>raw[k]===true)||[lead.source,lead.contactSource,raw.source].some(s=>tag(s)==='egc synthetic routing validation'))reasons.push('test_internal_or_vendor');
  if(canonical?.exclusionReasons)reasons.push(...canonical.exclusionReasons.filter(r=>nonCustomerReasons.has(r)));
  const origin=acquisitionAttribution(lead);if(origin.reasons.some(r=>['explicit_test_record','internal_or_vendor_record'].includes(r)))reasons.push('test_internal_or_vendor');
  if(reasons.length){excluded.push({contactId:lead.contactId,leadId:lead.leadId,reasons:[...new Set(reasons)]});continue;}
  if(!canonical||canonical.excluded===true){held.push({contactId:lead.contactId,leadId:lead.leadId,reason:!canonical?'missing_canonical_identity':'canonical_identity_exclusion_unclassified'});continue;}
  customers.push(lead);
 }
 const meta=customers.filter(lead=>['eligible_meta_paid','meta_insufficient_matching'].includes(acquisitionAttribution(lead).classification));
 return {customers,meta,coverage:{inventoryLeads:inventory.length,salesLeads:customers.length,excludedCount:excluded.length,heldIdentityCount:held.length,complete:held.length===0,excluded,heldIdentity:held,scope:'lead_created_in_requested_window',qualification:'Explicit non-customer identities are excluded. Missing canonical identities are held, not assumed sales or excluded. Later DNC, lost, inactive, or missing delivery matching does not remove a legitimate acquisition; original attribution is preserved.'}};
}
