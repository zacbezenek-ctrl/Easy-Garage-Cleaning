import { getLeads } from "../../lib/data";

export const dynamic = "force-dynamic";

export default async function LeadsPage() {
  const rows = await getLeads();
  return (
    <>
      <div className="pagehead">
        <div>
          <h1>Leads</h1>
          <p className="muted">Latest normalized leads and current follow-up state.</p>
        </div>
        <a className="button secondary compact" href="/followups">Needs follow-up</a>
      </div>
      <div className="tablewrap">
        <table>
          <thead>
            <tr><th>Customer</th><th>State</th><th>Source</th><th>Created</th><th>Last human outreach</th></tr>
          </thead>
          <tbody>
            {rows.map(({ lead, contact }) => (
              <tr key={lead.id}>
                <td>
                  <a className="tablelink" href={"/leads/" + lead.id}>{contact.name ?? contact.phone ?? contact.email ?? "Unknown"}</a>
                  <div className="subtle">{contact.phone ?? contact.email}</div>
                </td>
                <td><span className="pill">{lead.currentState}</span></td>
                <td>{lead.source ?? "—"}</td>
                <td>{lead.createdAt.toLocaleString()}</td>
                <td>{lead.lastHumanOutreachAt?.toLocaleString() ?? "Never"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
