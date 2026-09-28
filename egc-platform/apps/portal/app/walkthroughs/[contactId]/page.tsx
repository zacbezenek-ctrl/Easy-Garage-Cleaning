import {employeeHubRecordingsUrl,employeeHubUrl} from "../../../lib/format";

export const dynamic = "force-dynamic";

/** The shared reporting login never captures audio; recordings live on the exact Hub visit. */
export default async function WalkthroughPage({
  params
}: {
  params: Promise<{ contactId: string }>;
}) {
  const { contactId } = await params;
  return (
    <section className="handoff">
      <div>
        <h1>Walkthroughs are recorded in the EGC Hub</h1>
        <p className="muted">Record, review, and approve walkthrough audio on the customer's Hub visit so its scope, schedule, and job stay linked. This reporting portal does not record audio.</p>
        <p>In the Hub, open Action Center, choose Portal schedule, then open Recordings on the customer's visit. Existing transcripts remain available in the recording history.</p>
      </div>
      <a className="button" href={employeeHubRecordingsUrl()}>Open visit recordings in EGC Hub</a>
      <a className="button secondary" href={employeeHubUrl("walkthroughs")}>Open Hub walkthroughs</a>
      <a className="tablelink" href={"/customers/" + encodeURIComponent(contactId)}>Back to customer evidence</a>
    </section>
  );
}
