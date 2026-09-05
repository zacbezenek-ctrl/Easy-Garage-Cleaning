/**
 * Retired compatibility endpoint.
 * Website and advertising leads now enter HighLevel directly.
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
    code: 'LEGACY_FIREBASE_LEADS_RETIRED',
    error: 'Legacy Firebase lead intake is retired. HighLevel is the CRM source of record.',
  }), { status: 410, headers });
}
