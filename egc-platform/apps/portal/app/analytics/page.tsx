import { getAnalytics } from "../../lib/data";

export const dynamic = "force-dynamic";

export default async function AnalyticsPage() {
  const data = await getAnalytics();
  return (
    <>
      <h1>Analytics</h1>
      <p className="muted">Operational metrics from the normalized EGC database. Lead metrics below use the last 30 days.</p>
      <div className="stats">
        <div className="stat"><span>30d leads</span><strong>{data.totalLeads}</strong></div>
        <div className="stat"><span>Booked leads</span><strong>{data.bookedLeads}</strong></div>
        <div className="stat"><span>Booked rate</span><strong>{(data.bookedLeadRate * 100).toFixed(1)}%</strong></div>
        <div className="stat"><span>Bookings created</span><strong>{data.bookings}</strong></div>
      </div>
      <div className="grid">
        <section className="card">
          <h2>Lead states</h2>
          {data.leadStates.map((row) => (
            <div className="metricrow" key={row.state}><span>{row.state}</span><strong>{row.count}</strong></div>
          ))}
        </section>
        <section className="card">
          <h2>Opportunity states</h2>
          {data.opportunityStates.map((row) => (
            <div className="metricrow" key={row.status}>
              <span>{row.status}</span>
              <strong>{row.count} ·  {(row.valueCents / 100).toLocaleString()}</strong>
            </div>
          ))}
        </section>
        <section className="card">
          <h2>Job states</h2>
          {data.jobStates.map((row) => (
            <div className="metricrow" key={row.status}><span>{row.status}</span><strong>{row.count}</strong></div>
          ))}
        </section>
      </div>
    </>
  );
}
