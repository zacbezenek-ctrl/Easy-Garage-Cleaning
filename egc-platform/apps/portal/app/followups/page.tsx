import {getPortalIntelligence} from "../../lib/intelligence";
import {CustomerEvidence} from "../components/customer-evidence";
export const dynamic="force-dynamic";
export default async function FollowupsPage(){
 const report=await getPortalIntelligence(30),customers=report.customers.filter(c=>!c.excluded&&c.pipelineDisposition==='active');
 return <><h1>Customer next actions</h1><p className="muted">Includes booked customers awaiting reconciliation, received videos awaiting a quote, and accepted work awaiting scheduling.</p><div className="grid detailgrid">{customers.map(customer=><CustomerEvidence key={customer.contactId} customer={customer}/>)}</div></>;
}
