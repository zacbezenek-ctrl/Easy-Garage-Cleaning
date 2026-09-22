import {getCanonicalReport,getCustomerStateDiagnostics,getCustomerTimeline} from "@egc/customer-state";
export {getCustomerStateDiagnostics,getCustomerTimeline};
export async function getPortalIntelligence(days=7) {
  const until=new Date(),since=new Date(until.valueOf()-days*86_400_000);
  return getCanonicalReport({since,until,cohortSince:since,cohortUntil:until,refresh:true});
}
export const label=(value:string)=>value.replaceAll("_"," ").replace(/([a-z])([A-Z])/g,"$1 $2");
export const money=(cents:number|null)=>cents===null?"Amount unverified":new Intl.NumberFormat("en-US",{style:"currency",currency:"USD"}).format(cents/100);
