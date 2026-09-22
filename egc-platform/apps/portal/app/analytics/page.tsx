import {getPortalIntelligence} from "../../lib/intelligence";
import {SalesReport} from "../components/sales-report";
export const dynamic="force-dynamic";
export default async function AnalyticsPage(){return <><h1>Analytics</h1><p className="muted">Last 30 days. Period events and lead cohort outcomes use separate calculations.</p><SalesReport report={await getPortalIntelligence(30)}/></>;}
