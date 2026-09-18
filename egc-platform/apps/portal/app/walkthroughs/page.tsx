import { getWalkthroughs } from "../../lib/data";

export const dynamic = "force-dynamic";

export default async function WalkthroughsPage() {
  const rows = await getWalkthroughs();
  return (
    <>
      <h1>Walkthroughs</h1>
      <p className="muted">Voice walkthrough recordings, transcripts, and reviewed structured scope.</p>
      <div className="tablewrap">
        <table>
          <thead><tr><th>Customer</th><th>Status</th><th>Created</th><th>Approved</th><th>Action</th></tr></thead>
          <tbody>
            {rows.map(({ walkthrough, contact }) => (
              <tr key={walkthrough.id}>
                <td><a className="tablelink" href={"/customers/" + contact.id}>{contact.name ?? contact.phone ?? "Unknown"}</a></td>
                <td><span className="pill">{walkthrough.status}</span></td>
                <td>{walkthrough.createdAt.toLocaleString()}</td>
                <td>{walkthrough.approvedAt?.toLocaleString() ?? "—"}</td>
                <td><a className="tablelink" href={"/walkthroughs/" + contact.id}>Start another</a></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
