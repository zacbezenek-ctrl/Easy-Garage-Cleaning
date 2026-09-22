import { getLeads } from "../../lib/data";
import {portalTime} from "../../lib/format";
import {label} from "../../lib/intelligence";

export const dynamic = "force-dynamic";

export default async function LeadsPage() {
  const rows = await getLeads();
  return (
    <>
      <div className="pagehead">
        <div>
          <h1>Leads</h1>
          <p className="muted">Lead directory with the latest reconciled customer evidence. Open a customer to inspect calls, messages and operational outcomes.</p>
        </div>
        <a className="button secondary compact" href="/followups">Needs follow-up</a>
      </div>
      <div className="tablewrap">
        <table>
          <thead>
            <tr><th>Customer</th><th>Operational state</th><th>Original source</th><th>Created</th><th>Next action</th><th>Reconciled</th></tr>
          </thead>
          <tbody>
            {rows.map(({ lead, contact,customerState,originalAttribution }) => (
              <tr key={lead.id}>
                <td>
                  <a className="tablelink" href={"/leads/" + lead.id}>{contact.name ?? contact.phone ?? contact.email ?? "Unknown"}</a>
                  <div className="subtle">{contact.phone ?? contact.email}</div>
                </td>
                <td><span className="pill">{customerState?label(customerState.state):'Evidence reconciliation pending'}</span>{customerState&&<div className="subtle">{label(customerState.intentStage)} · {label(customerState.reconciliationStatus)}</div>}</td>
                <td>{typeof originalAttribution?.source==='string'?originalAttribution.source:'Not captured'}</td>
                <td>{portalTime(lead.createdAt)}</td>
                <td>{typeof customerState?.snapshot.nextRequiredAction==='string'?customerState.snapshot.nextRequiredAction:'Reconcile customer evidence'}</td>
                <td>{portalTime(customerState?.lastReconciledAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
