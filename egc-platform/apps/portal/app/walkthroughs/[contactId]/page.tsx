import Recorder from "./recorder";

export const dynamic = "force-dynamic";

export default async function WalkthroughPage({
  params
}: {
  params: Promise<{ contactId: string }>;
}) {
  const { contactId } = await params;
  if (process.env.EGC_OPERATIONS_ENABLED !== "true") {
    return <section className="recorder"><div><h1>Voice walkthrough</h1><p className="muted">Customer {contactId}</p></div><Recorder contactId={contactId} /></section>;
  }
  return (
    <section className="recorder">
      <div>
        <h1>Visit recordings</h1>
        <p className="muted">Record and review walkthroughs in the Employee Hub Action Center. Open the exact visit under Portal schedule, then choose Recordings.</p>
        <p>Existing transcripts remain available in the recording history. New scope reviews require your individual Hub account and update the authoritative visit.</p>
      </div>
      <a className="button" href={"/customers/" + contactId}>Back to customer</a>
    </section>
  );
}
