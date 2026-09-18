import { getDashboardData } from "../lib/data";

export const dynamic = "force-dynamic";

export default async function Dashboard() {
  const data = await getDashboardData();
  return (
    <>
      <div className="pagehead">
        <div>
          <h1>Easy Garage Cleaning Ops</h1>
          <p className="muted">Canonical operating layer for leads, jobs, walkthroughs, and ChatGPT MCP data.</p>
        </div>
        <a className="button compact" href="/followups">Open follow-ups</a>
      </div>

      <div className="stats">
        <a className="stat cardlink" href="/leads"><span>30d leads</span><strong>{data.totalLeads}</strong></a>
        <a className="stat cardlink" href="/followups"><span>Need follow-up</span><strong>{data.followups}</strong></a>
        <a className="stat cardlink" href="/leads"><span>Booked leads</span><strong>{data.booked}</strong></a>
        <a className="stat cardlink" href="/pipeline"><span>Next 7d appointments</span><strong>{data.upcomingAppointments}</strong></a>
        <a className="stat cardlink" href="/jobs"><span>Jobs</span><strong>{data.jobs}</strong></a>
        <a className="stat cardlink" href="/walkthroughs"><span>Walkthroughs</span><strong>{data.walkthroughs}</strong></a>
      </div>

      <div className="grid">
        <section className="card">
          <h2>Lead state</h2>
          {data.leadStates.map((row) => (
            <div className="metricrow" key={row.state}>
              <span>{row.state}</span><strong>{row.count}</strong>
            </div>
          ))}
        </section>
        <section className="card">
          <h2>Voice walkthrough</h2>
          <p>Open a customer record, start a mobile recording, review the extracted scope, and approve it before it becomes an EGC job record.</p>
          <a className="tablelink" href="/customers">Choose customer →</a>
        </section>
        <section className="card">
          <h2>ChatGPT MCP</h2>
          <p>The read-only MCP can audit leads, bookings, transcripts, jobs, pipeline, unanswered calls, stale opportunities, and operating metrics from this same database.</p>
          <a className="tablelink" href="/analytics">View analytics →</a>
        </section>
      </div>
    </>
  );
}
