import type {getCanonicalReport} from "@egc/customer-state";
import {portalTime} from "../../lib/format";
import {label,money} from "../../lib/intelligence";
import {revenueDisplay} from "../../lib/revenue-display";
type Report=Awaited<ReturnType<typeof getCanonicalReport>>;
export function SalesReport({report}:{report:Report}) {
 return <>
   {!report.coverage.complete&&<p className="coverage-warning" role="status">Some source evidence is incomplete. Review <a className="tablelink" href="/diagnostics">diagnostics</a> before treating these totals as complete.</p>}
   <h2>Period activity</h2><p className="muted">{portalTime(report.period.since)} – {portalTime(report.period.until)}. Each metric counts customers with verified events in this period.</p>
   <div className="stats">{Object.entries(report.periodActivity).map(([key,value])=><div className="stat" key={key}><span>{label(key)}</span><strong>{value.count}</strong></div>)}
   {[['Sold revenue',report.soldRevenue],['Collected revenue',report.collectedRevenue]].map(([name,value])=>{const amount=value as Report['soldRevenue'],display=revenueDisplay(amount);return <div className="stat" key={String(name)}><span>{String(name)}</span><strong>{display.total}</strong>{!display.complete&&<small>Verified dated subtotal: {display.subtotal}</small>}<small>Date unknown: {display.unknownDates} · Amount unverified: {display.unknownValues}</small><small>{display.qualification}</small>
    {amount.unknownOccurrenceEvents.length>0&&<details><summary>Review outcomes without dates</summary><ul>{amount.unknownOccurrenceEvents.map(event=><li key={event.eventId}><a className="tablelink" href={`/customers/${encodeURIComponent(event.contactId)}`}>{report.customers.find(customer=>customer.contactId===event.contactId)?.customerName||'Customer evidence'}</a> · {event.valueCents!==null&&event.currency==='USD'?money(event.valueCents):'Amount unverified'} · Not assigned to this period</li>)}</ul></details>}
   </div>;})}</div>
   <h2>Lead cohort conversion</h2><p className="muted">Leads created {portalTime(report.cohort.window.since)} – {portalTime(report.cohort.window.until)}, observed through {portalTime(report.cohort.observedThrough)}. {report.cohort.denominator} leads; youngest {report.cohort.maturity.youngestLeadAgeDays?.toFixed(1)??'—'} days, oldest {report.cohort.maturity.oldestLeadAgeDays?.toFixed(1)??'—'} days. These are outcomes observed so far.</p>
   <div className="tablewrap"><table><thead><tr><th>Outcome</th><th>Converted / leads</th><th>Observed rate</th></tr></thead><tbody>{Object.entries(report.cohort.metrics).map(([key,value])=><tr key={key}><td>{label(key)}</td><td>{value.numerator} / {value.denominator}</td><td>{value.rate===null?'—':(value.rate*100).toFixed(1)+'%'}</td></tr>)}</tbody></table></div>
 </>;
}
