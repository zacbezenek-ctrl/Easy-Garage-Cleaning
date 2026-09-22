import {getPortalIntelligence} from "../lib/intelligence";
import {employeeHubUrl} from "../lib/format";
import {SalesReport} from "./components/sales-report";
export const dynamic="force-dynamic";
export default async function Dashboard(){
 const report=await getPortalIntelligence(7);
 return <><div className="pagehead"><div><h1>EGC operational intelligence</h1><p className="muted">Last 7 days of calls, texts, Hub visits, verified commitments, and customer outcomes.</p></div><a className="button compact" href={employeeHubUrl()}>Open EGC Hub</a></div>
 <div className="stats"><a className="stat cardlink" href="/pipeline"><span>Walkthrough pipeline</span><strong>{report.pipelines.walkthrough.length}</strong></a><a className="stat cardlink" href="/pipeline"><span>Video quote pipeline</span><strong>{report.pipelines.videoQuote.length}</strong></a><a className="stat cardlink" href="/pipeline"><span>Direct-job pipeline</span><strong>{report.pipelines.directJob.length}</strong></a><a className="stat cardlink" href="/diagnostics"><span>Customers needing reconciliation</span><strong>{report.customers.filter(c=>c.discrepancies.length).length}</strong></a></div>
 <SalesReport report={report}/><p className="sectiongap"><a className="tablelink" href="/pipeline">Inspect every opportunity and its evidence →</a></p></>;
}
