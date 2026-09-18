export const runtime = "nodejs";

export async function POST(request: Request) {
  const apiUrl = process.env.API_URL;
  const token = process.env.API_BEARER_TOKEN;
  if (!apiUrl || !token) {
    return Response.json({ error: "portal_api_not_configured" }, { status: 500 });
  }

  const body = await request.json() as {
    walkthroughId?: string;
    extraction?: unknown;
  };

  if (!body.walkthroughId) {
    return Response.json({ error: "walkthroughId_required" }, { status: 400 });
  }

  const response = await fetch(
    `${apiUrl}/walkthroughs/${encodeURIComponent(body.walkthroughId)}/approve`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({ extraction: body.extraction, approvedBy: "portal" }),
      cache: "no-store"
    }
  );

  return new Response(await response.text(), {
    status: response.status,
    headers: { "content-type": response.headers.get("content-type") ?? "application/json" }
  });
}
