import { getFollowups } from "../../lib/data";

export const dynamic = "force-dynamic";

export default async function FollowupsPage() {
  const rows = await getFollowups();
  return (
    <>
      <h1>Follow-ups</h1>
      <p className="muted">Leads that have never received human outreach or have not replied after the latest human outreach.</p>
      <div className="grid">
        {rows.map(({ lead, contact }) => (
          <a className="card cardlink" href={"/leads/" + lead.id} key={lead.id}>
            <div className="rowbetween">
              <strong>{contact.name ?? "Unknown lead"}</strong>
              <span className="pill">{lead.currentState}</span>
            </div>
            <p>{contact.phone ?? contact.email ?? "No contact detail"}</p>
            <div className="subtle">Created {lead.createdAt.toLocaleString()}</div>
            <div className="subtle">Human outreach: {lead.lastHumanOutreachAt?.toLocaleString() ?? "Never"}</div>
          </a>
        ))}
      </div>
    </>
  );
}
