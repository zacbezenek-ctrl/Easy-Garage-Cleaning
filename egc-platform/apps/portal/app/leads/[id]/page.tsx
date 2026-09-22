import { notFound } from "next/navigation";
import { getLeadDetail } from "../../../lib/data";
import {portalTime} from "../../../lib/format";
import {getCustomerTimeline} from "../../../lib/intelligence";
import {CustomerEvidence} from "../../components/customer-evidence";
import type {CustomerProjection} from "@egc/customer-state";

export const dynamic = "force-dynamic";

export default async function LeadDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const data = await getLeadDetail(id);
  if (!data) notFound();
  const canonical=await getCustomerTimeline({contactId:data.contact.id,refresh:true});
  const projection=canonical.customer as unknown as CustomerProjection|null;

  return (
    <>
      <div className="pagehead">
        <div>
          <h1>{data.contact.name ?? "Lead"}</h1>
          <p className="muted">{data.contact.phone ?? "No phone"} · {data.contact.email ?? "No email"}</p>
        </div>
        <div className="actions">
          <a className="button secondary compact" href={"/customers/" + data.contact.id}>Customer</a>
          <a className="button compact" href={"/walkthroughs/" + data.contact.id}>Open EGC Hub walkthrough</a>
        </div>
      </div>
      <div className="stats">
        <div className="stat"><span>State</span><strong>{projection?.state??"Reconciliation pending"}</strong></div>
        <div className="stat"><span>Source</span><strong>{data.lead.source ?? "—"}</strong></div>
        <div className="stat"><span>Human outreach</span><strong>{portalTime(data.lead.lastHumanOutreachAt)}</strong></div>
        <div className="stat"><span>Customer response</span><strong>{portalTime(data.lead.lastCustomerResponseAt)}</strong></div>
      </div>
      {projection&&<CustomerEvidence customer={projection}/>}
      <div className="grid detailgrid">
        <section className="card">
          <h2>Recent messages</h2>
          <div className="timeline">
            {data.messages.map((message) => (
              <div className="timelineitem" key={message.id}>
                <div className="rowbetween"><strong>{message.direction} · {message.actorType}</strong><span className="subtle">{portalTime(message.occurredAt)}</span></div>
                <div>{message.body ?? "[" + message.type + "]"}</div>
              </div>
            ))}
          </div>
        </section>
        <section className="card">
          <h2>Calls and transcript evidence</h2>
          <p className="muted">Recent 100 calls. Call status alone does not prove a conversation.</p>
          {data.calls.map((call) => (
            <details className="timelineitem" key={call.id}>
              <summary>{call.direction} · {portalTime(call.startedAt)} · {call.transcript?"Transcript available":"Transcript missing"}</summary>
              {call.transcript?<pre>{call.transcript}</pre>:<p className="muted">No persisted transcript; review the source recording.</p>}
            </details>
          ))}
        </section>
        <section className="card">
          <h2>Appointments</h2>
          {data.appointments.map((appointment) => (
            <div className="timelineitem" key={appointment.id}>
              <div className="rowbetween"><strong>{appointment.title ?? "Appointment"}</strong><span className="pill">{appointment.status}</span></div>
              <div>{portalTime(appointment.appointmentStartAt)}</div>
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
