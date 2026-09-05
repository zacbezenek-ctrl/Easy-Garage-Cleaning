/**
 * Retired compatibility endpoint.
 * HighLevel owns communication history; legacy Firestore SMS writes are disabled.
 */

const headers = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers });
}

export async function onRequestPost() {
  return new Response(JSON.stringify({
    ok: false,
    code: 'LEGACY_FIREBASE_SMS_RETIRED',
    error: 'Legacy Firebase SMS tracking is retired. HighLevel owns CRM communication history.',
  }), { status: 410, headers });
}
