import { notFound } from "next/navigation";
import { getJobDetail } from "../../../lib/data";

export const dynamic = "force-dynamic";

function List({ title, values }: { title: string; values: string[] }) {
  return (
    <section className="card">
      <h2>{title}</h2>
      {values.length ? <ul>{values.map((value, index) => <li key={index}>{value}</li>)}</ul> : <p className="muted">None recorded.</p>}
    </section>
  );
}

export default async function JobDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const data = await getJobDetail(id);
  if (!data) notFound();
  const { job, contact } = data;

  return (
    <>
      <div className="pagehead">
        <div>
          <h1>{contact?.name ?? "Job"}</h1>
          <p className="muted">{job.serviceAddress ?? "No service address"} · {job.status}</p>
        </div>
        {contact && <a className="button compact" href={"/walkthroughs/" + contact.id}>New walkthrough</a>}
      </div>
      <div className="stats">
        <div className="stat"><span>Scheduled</span><strong>{job.scheduledAt?.toLocaleString() ?? "—"}</strong></div>
        <div className="stat"><span>Garage</span><strong>{job.garageSize ?? "—"}</strong></div>
        <div className="stat"><span>Junk</span><strong>{job.junkVolumeYards ? String(job.junkVolumeYards) + " yd³" : "—"}</strong></div>
        <div className="stat"><span>Labor</span><strong>{job.estimatedLaborHours ? String(job.estimatedLaborHours) + " h" : "—"}</strong></div>
        <div className="stat"><span>Price</span><strong>{job.priceCents !== null ? "$" + (job.priceCents / 100).toLocaleString() : "—"}</strong></div>
      </div>
      <div className="grid">
        <List title="Remove" values={job.itemsRemove} />
        <List title="Keep" values={job.itemsKeep} />
        <List title="Relocate" values={job.itemsRelocate} />
        <List title="Organization" values={job.organizationRequirements} />
        <List title="Add-ons" values={job.addOns} />
        <section className="card">
          <h2>Access</h2>
          <p>{job.accessNotes ?? "No access notes."}</p>
        </section>
      </div>
      <section className="card sectiongap">
        <h2>Job notes</h2>
        {data.notes.map((note) => <div className="timelineitem" key={note.id}><strong>{note.type}</strong><div>{note.body}</div><div className="subtle">{note.createdAt.toLocaleString()} · {note.source}</div></div>)}
      </section>
      <section className="card sectiongap">
        <h2>Walkthrough transcript</h2>
        {data.walkthroughs[0]?.transcript ? <pre>{data.walkthroughs[0].transcript}</pre> : <p className="muted">No linked walkthrough transcript.</p>}
      </section>
    </>
  );
}
