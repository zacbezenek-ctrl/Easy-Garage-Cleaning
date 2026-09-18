import { getPipeline } from "../../lib/data";

export const dynamic = "force-dynamic";

export default async function PipelinePage() {
  const rows = await getPipeline();
  return (
    <>
      <h1>Pipeline</h1>
      <p className="muted">GoHighLevel opportunities normalized into EGC Postgres.</p>
      <div className="tablewrap">
        <table>
          <thead><tr><th>Customer</th><th>Status</th><th>Stage</th><th>Value</th><th>Assigned</th><th>Updated</th></tr></thead>
          <tbody>
            {rows.map(({ opportunity, contact, pipelineName, pipelineStageName, assignedUserName }) => (
              <tr key={opportunity.id}>
                <td><a className="tablelink" href={"/customers/" + contact.id}>{contact.name ?? contact.phone ?? "Unknown"}</a></td>
                <td><span className="pill">{opportunity.status ?? "unknown"}</span></td>
                <td><strong>{pipelineStageName ?? "—"}</strong><div className="subtle">{pipelineName ?? "—"}</div></td>
                <td>{opportunity.monetaryValueCents !== null ? "$" + (opportunity.monetaryValueCents / 100).toLocaleString() : "—"}</td>
                <td>{assignedUserName ?? "—"}</td>
                <td>{opportunity.updatedAt.toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
