import Recorder from "./recorder";

export default async function WalkthroughPage({
  params
}: {
  params: Promise<{ contactId: string }>;
}) {
  const { contactId } = await params;
  return (
    <section className="recorder">
      <div>
        <h1>Voice walkthrough</h1>
        <p className="muted">Customer {contactId}</p>
      </div>
      <Recorder contactId={contactId} />
    </section>
  );
}
