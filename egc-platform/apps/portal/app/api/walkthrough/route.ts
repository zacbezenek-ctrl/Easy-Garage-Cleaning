export const runtime = "nodejs";

export async function POST(request: Request) {
  const apiUrl = process.env.API_URL;
  const token = process.env.API_BEARER_TOKEN;
  if (!apiUrl || !token) {
    return Response.json({ error: "portal_api_not_configured" }, { status: 500 });
  }

  const incoming = await request.formData();
  const contactId = incoming.get("contactId");
  const audio = incoming.get("audio");
  if (typeof contactId !== "string" || !(audio instanceof File)) {
    return Response.json({ error: "contactId_and_audio_required" }, { status: 400 });
  }

  const outbound = new FormData();
  outbound.set("audio", audio, audio.name || "walkthrough.webm");

  const response = await fetch(`${apiUrl}/walkthroughs/${encodeURIComponent(contactId)}/audio`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: outbound,
    cache: "no-store"
  });

  return new Response(await response.text(), {
    status: response.status,
    headers: { "content-type": response.headers.get("content-type") ?? "application/json" }
  });
}
