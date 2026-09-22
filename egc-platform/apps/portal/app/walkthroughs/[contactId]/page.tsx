import {employeeHubUrl} from "../../../lib/format";

export const dynamic = "force-dynamic";

export default async function WalkthroughPage({
  params
}: {
  params: Promise<{ contactId: string }>;
}) {
  const { contactId } = await params;
  return (
    <section className="recorder">
      <div>
        <h1>Open the EGC Hub walkthrough</h1>
        <p className="muted">Schedule, record, review, and complete every walkthrough in the EGC Hub. Open the customer's saved visit to keep its scope, schedule, and job linked.</p>
        <p>Existing transcripts remain available in the recording history.</p>
      </div>
      <a className="button" href={employeeHubUrl()}>Open EGC Hub</a>
      <a className="tablelink" href={"/customers/" + contactId}>Back to customer evidence</a>
    </section>
  );
}
