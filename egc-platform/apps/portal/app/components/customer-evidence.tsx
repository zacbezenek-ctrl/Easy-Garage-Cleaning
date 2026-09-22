import type {CustomerProjection} from "@egc/customer-state";
import {portalTime} from "../../lib/format";
import {label} from "../../lib/intelligence";
export function CustomerEvidence({customer}:{customer:CustomerProjection}) {
  return <article className="card"><div className="rowbetween"><a className="tablelink" href={"/customers/"+customer.contactId}>{customer.customerName??"Customer"}</a><span className="pill">{label(customer.state)}</span></div>
    <p><strong>Next:</strong> {customer.nextRequiredAction}</p>
    <p className="subtle">Intent: {label(customer.intentStage)} · {label(customer.reconciliationStatus)}</p>
    {customer.videoQuoteStage&&<p>Video quote: {label(customer.videoQuoteStage)}</p>}
    {customer.supportingEvidence.slice(0,4).map((e,i)=><blockquote className="source-evidence" key={e.sourceRecordId+":"+i}><p>{e.excerpt}</p><cite>{label(e.sourceType)} · {portalTime(e.occurredAt)} · {e.sourceRecordId}</cite></blockquote>)}
    {customer.discrepancies.length>0&&<details><summary>{customer.discrepancies.length} reconciliation issue(s)</summary>{customer.discrepancies.map(d=><p key={d.code}>{d.detail}</p>)}</details>}
  </article>;
}
