import { getJobs } from "../../lib/data";

export const dynamic = "force-dynamic";

export default async function JobsPage() {
  const rows = await getJobs();
  return (
    <>
      <h1>Jobs</h1>
      <p className="muted">Structured operational scopes created in the EGC system of record.</p>
      <div className="tablewrap">
        <table>
          <thead><tr><th>Customer</th><th>Status</th><th>Scheduled</th><th>Garage</th><th>Junk</th><th>Price</th></tr></thead>
          <tbody>
            {rows.map(({ job, contact }) => (
              <tr key={job.id}>
                <td><a className="tablelink" href={"/jobs/" + job.id}>{contact.name ?? contact.phone ?? "Unknown"}</a></td>
                <td><span className="pill">{job.status}</span></td>
                <td>{job.scheduledAt?.toLocaleString() ?? "—"}</td>
                <td>{job.garageSize ?? "—"}</td>
                <td>{job.junkVolumeYards ? String(job.junkVolumeYards) + " yd³" : "—"}</td>
                <td>{job.priceCents !== null ? "$" + (job.priceCents / 100).toLocaleString() : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
