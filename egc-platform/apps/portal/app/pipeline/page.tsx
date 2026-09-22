import {getPortalIntelligence} from "../../lib/intelligence";
import {CustomerEvidence} from "../components/customer-evidence";
export const dynamic="force-dynamic";
export default async function PipelinePage(){
 const report=await getPortalIntelligence(30);
 return <><h1>Customer pipeline</h1><p className="muted">Active walkthroughs, video quotes, and direct jobs reconstructed from customer evidence.</p>{!report.coverage.complete&&<p className="coverage-warning">Source coverage is incomplete. <a className="tablelink" href="/diagnostics">Review reconciliation issues.</a></p>}
 {Object.entries(report.pipelines).map(([kind,customers])=><section className="sectiongap" key={kind}><h2>{kind==='videoQuote'?'Video quotes':kind==='directJob'?'Direct jobs':'Walkthroughs'} · {customers.length}</h2><div className="grid detailgrid">{customers.map(customer=><CustomerEvidence key={customer.contactId} customer={customer}/>)}</div>{!customers.length&&<p className="muted">No active opportunities recorded.</p>}</section>)}</>;
}
