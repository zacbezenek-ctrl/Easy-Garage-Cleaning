export default function Dashboard() {
  return (
    <>
      <h1>Easy Garage Cleaning Ops</h1>
      <p className="muted">Internal operating layer for leads, jobs, walkthroughs, and MCP data.</p>
      <div className="grid">
        <section className="card">
          <h2>Voice walkthrough</h2>
          <p>Open a customer-specific walkthrough URL to record, transcribe, review, and approve job scope.</p>
          <p className="muted"><code>/walkthroughs/&lt;contact-id&gt;</code></p>
        </section>
        <section className="card">
          <h2>MCP</h2>
          <p>Read-only tools cover lead follow-up, no-response leads, recent bookings, customer history, transcripts, and job briefs.</p>
        </section>
        <section className="card">
          <h2>Sync</h2>
          <p>GHL contacts, conversations, calls, transcripts, opportunities, and appointments reconcile into Postgres.</p>
        </section>
      </div>
    </>
  );
}
