import { notFound } from "next/navigation";
import { getLeadDetail } from "../../../lib/data";

export const dynamic = "force-dynamic";

export default async function LeadDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const data = await getLeadDetail(id);
  if (!data) notFound();

  return (
    <>
      <div className="pagehead">
        <div>
          <h1>{data.contact.name ?? "Lead"}</h1>
          <p className="muted">{data.contact.phone ?? "No phone"} · {data.contact.email ?? "No email"}</p>
        </div>
        <div className="actions">
          <a className="button secondary compact" href={"/customers/" + data.contact.id}>Customer</a>
          <a className="button compact" href={"/walkthroughs/" + data.contact.id}>Start walkthrough</a>
        </div>
      </div>
      <div className="stats">
        <div className="stat"><span>State</span><strong>{data.lead.currentState}</strong></div>
        <div className="stat"><span>Source</span><strong>{data.lead.source ?? "—"}</strong></div>
        <div className="stat"><span>Human outreach</span><strong>{data.lead.lastHumanOutreachAt?.toLocaleString() ?? "Never"}</strong></div>
        <div className="stat"><span>Customer response</span><strong>{data.lead.lastCustomerResponseAt?.toLocaleString() ?? "None"}</strong></div>
      </div>
      <div className="grid detailgrid">
        <section className="card">
          <h2>Recent messages</h2>
          <div className="timeline">
            {data.messages.map((message) => (
              <div className="timelineitem" key={message.id}>
                <div className="rowbetween"><strong>{message.direction} · {message.actorType}</strong><span className="subtle">{message.occurredAt.toLocaleString()}</span></div>
                <div>{message.body ?? "[" + message.type + "]"}</div>
              </div>
            ))}
          </div>
        </section>
        <section className="card">
          <h2>Calls</h2>
          {data.calls.map((call) => (
            <div className="metricrow" key={call.id}>
              <span>{call.direction} · {call.status ?? "unknown"}</span>
              <strong>{call.startedAt.toLocaleString()}</strong>
            </div>
          ))}
        </section>
        <section className="card">
          <h2>Appointments</h2>
          {data.appointments.map((appointment) => (
            <div className="timelineitem" key={appointment.id}>
              <div className="rowbetween"><strong>{appointment.title ?? "Appointment"}</strong><span className="pill">{appointment.status}</span></div>
              <div>{appointment.appointmentStartAt.toLocaleString()}</div>
              {appointment.notes && <div className="subtle">{appointment.notes}</div>}
            </div>
          ))}
        </section>
        <section className="card">
          <h2>Opportunities</h2>
          {data.opportunities.map((opportunity) => (
            <div className="timelineitem" key={opportunity.id}>
              <div className="rowbetween"><span className="pill">{opportunity.status ?? "unknown"}</span><strong>{opportunity.monetaryValueCents !== null ? "$" + (opportunity.monetaryValueCents / 100).toLocaleString() : "—"}</strong></div>
              <div className="subtle">Stage {opportunity.pipelineStageId ?? "—"} · Assigned {opportunity.assignedUserId ?? "—"}</div>
            </div>
          ))}
        </section>
      </div>
    </>
  );
}
