import { notFound } from "next/navigation";
import { getCustomerDetail } from "../../../lib/data";

export const dynamic = "force-dynamic";

export default async function CustomerDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const data = await getCustomerDetail(id);
  if (!data) notFound();

  return (
    <>
      <div className="pagehead">
        <div>
          <h1>{data.contact.name ?? "Customer"}</h1>
          <p className="muted">{data.contact.phone ?? "No phone"} · {data.contact.email ?? "No email"}</p>
        </div>
        <a className="button compact" href={"/walkthroughs/" + data.contact.id}>Start voice walkthrough</a>
      </div>
      <div className="stats">
        <div className="stat"><span>Lead state</span><strong>{data.lead?.currentState ?? "—"}</strong></div>
        <div className="stat"><span>Source</span><strong>{data.contact.source ?? "—"}</strong></div>
        <div className="stat"><span>Jobs</span><strong>{data.jobs.length}</strong></div>
        <div className="stat"><span>Walkthroughs</span><strong>{data.walkthroughs.length}</strong></div>
      </div>
      <div className="grid detailgrid">
        <section className="card">
          <h2>Jobs</h2>
          {data.jobs.map((job) => (
            <a className="timelineitem cardlink" href={"/jobs/" + job.id} key={job.id}>
              <div className="rowbetween"><strong>{job.serviceType ?? "Garage job"}</strong><span className="pill">{job.status}</span></div>
              <div>{job.scheduledAt?.toLocaleString() ?? "Not scheduled"}</div>
              <div className="subtle">{job.itemsRemove.length} remove · {job.addOns.length} add-ons</div>
            </a>
          ))}
        </section>
        <section className="card">
          <h2>Appointments</h2>
          {data.appointments.map((appointment) => (
            <div className="timelineitem" key={appointment.id}>
              <div className="rowbetween"><strong>{appointment.title ?? "Appointment"}</strong><span className="pill">{appointment.status}</span></div>
              <div>{appointment.appointmentStartAt.toLocaleString()}</div>
            </div>
          ))}
        </section>
        <section className="card">
          <h2>Opportunities</h2>
          {data.opportunities.map((opportunity) => (
            <div className="timelineitem" key={opportunity.id}>
              <div className="rowbetween"><span className="pill">{opportunity.status ?? "unknown"}</span><strong>{opportunity.monetaryValueCents !== null ? "$" + (opportunity.monetaryValueCents / 100).toLocaleString() : "—"}</strong></div>
              <div className="subtle">Stage {opportunity.pipelineStageId ?? "—"}</div>
            </div>
          ))}
        </section>
        <section className="card">
          <h2>Recent conversation</h2>
          <div className="timeline">
            {data.messages.slice(0, 20).map((message) => (
              <div className="timelineitem" key={message.id}>
                <div className="rowbetween"><strong>{message.direction} · {message.actorType}</strong><span className="subtle">{message.occurredAt.toLocaleString()}</span></div>
                <div>{message.body ?? "[" + message.type + "]"}</div>
              </div>
            ))}
          </div>
        </section>
      </div>
    </>
  );
}
