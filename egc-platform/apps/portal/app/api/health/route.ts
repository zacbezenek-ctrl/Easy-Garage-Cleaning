import { getDb, schema } from "@egc/database";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await getDb().select({ id: schema.contacts.id }).from(schema.contacts).limit(1);
    return Response.json({ ok: true, service: "egc-portal", database: "ready",release:process.env.RAILWAY_GIT_COMMIT_SHA??process.env.EGC_RELEASE_SHA??null });
  } catch {
    return Response.json(
      { ok: false, service: "egc-portal", database: "not_ready" },
      { status: 503 }
    );
  }
}
