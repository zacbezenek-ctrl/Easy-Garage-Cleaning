import { notFound } from "next/navigation";
import { getCustomerDetail } from "../../../lib/data";
import {portalTime} from "../../../lib/format";
import {getCustomerTimeline,label,money} from "../../../lib/intelligence";
import {CustomerEvidence} from "../../components/customer-evidence";
import type {CustomerProjection} from "@egc/customer-state";

export const dynamic = "force-dynamic";

export default async function CustomerDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const data = await getCustomerDetail(id);
  if (!data) notFound();
  const canonical=await getCustomerTimeline({contactId:id,refresh:true});
  const projection=canonical.customer as unknown as CustomerProjection|null;

  return (
    <>
      <div className="pagehead">
        <div>
          <h1>{data.contact.name ?? "Customer"}</h1>
          <p className="muted">{data.contact.phone ?? "No phone"} · {data.contact.email ?? "No email"}</p>
        </div>
        <a className="button compact" href={"/walkthroughs/" + data.contact.id}>Open EGC Hub walkthrough</a>
      </div>
      <div className="stats">
        <div className="stat"><span>Operational state</span><strong>{projection?.state??"Reconciliation pending"}</strong></div>
        <div className="stat"><span>Source</span><strong>{data.contact.source ?? "—"}</strong></div>
        <div className="stat"><span>Jobs</span><strong>{data.jobs.length}</strong></div>
        <div className="stat"><span>Walkthroughs</span><strong>{data.walkthroughs.length}</strong></div>
      </div>
      {projection&&<CustomerEvidence customer={projection}/>}
      <section className="card sectiongap"><h2>Canonical customer events</h2>{canonical.events.map(event=><details className="timelineitem" key={event.eventId}><summary>{label(event.eventType)} · {portalTime(event.occurredAt)}{event.valueVerified&&event.valueCents!==null?' · '+money(event.valueCents):''}{event.humanReviewNeeded?' · Needs review':''}</summary>{event.evidence.map((e,i)=><blockquote className="source-evidence" key={e.sourceRecordId+':'+i}><p>{e.excerpt}</p><cite>{e.sourceType} · {e.sourceRecordId} · {portalTime(e.occurredAt)}</cite></blockquote>)}</details>)}{!canonical.events.length&&<p className="muted">No canonical events persisted yet.</p>}</section>
      {canonical.assertions.length>0&&<section className="card sectiongap"><h2>User-confirmed outcomes</h2>{canonical.assertions.map(a=><article className="timelineitem" key={a.id}><strong>{label(a.field)} · {label(a.status)}</strong><p>{a.exactText}</p><small>{portalTime(a.occurredAt)} · {a.sourceReference}</small></article>)}</section>}
      <div className="grid detailgrid">
        <section className="card">
          <h2>Jobs</h2>
          {data.jobs.map((job) => (
            <a className="timelineitem cardlink" href={"/jobs/" + job.id} key={job.id}>
              <div className="rowbetween"><strong>{job.serviceType ?? "Garage job"}</strong><span className="pill">{job.status}</span></div>
              <div>{portalTime(job.scheduledAt)}</div>
              <div className="subtle">{job.itemsRemove.length} remove · {job.addOns.length} add-ons</div>
            </a>
          ))}
        </section>
        <section className="card">
          <h2>Appointments</h2>
          {data.appointments.map((appointment) => (
            <div className="timelineitem" key={appointment.id}>
              <div className="rowbetween"><strong>{appointment.title ?? "Appointment"}</strong><span className="pill">{appointment.status}</span></div>
              <div>{portalTime(appointment.appointmentStartAt)}</div>
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
          <h2>Calls and transcript evidence</h2>
          <p className="muted">Recent 100 calls. Call status alone does not prove a conversation.</p>
          {data.calls.map(call=><details className="timelineitem" key={call.id}><summary>{call.direction} · {portalTime(call.startedAt)} · {call.transcript?"Transcript available":"Transcript missing"}</summary>{call.transcript?<pre>{call.transcript}</pre>:<p className="muted">No persisted transcript; review the source recording.</p>}</details>)}
          {!data.calls.length&&<p className="muted">No calls recorded.</p>}
        </section>
        <section className="card">
          <h2>Recent conversation</h2>
          <div className="timeline">
            {data.messages.slice(0, 20).map((message) => (
              <div className="timelineitem" key={message.id}>
                <div className="rowbetween"><strong>{message.direction} · {message.actorType}</strong><span className="subtle">{portalTime(message.occurredAt)}</span></div>
                <div>{message.body ?? "[" + message.type + "]"}</div>
              </div>
            ))}
          </div>
        </section>
      </div>
    </>
  );
}
