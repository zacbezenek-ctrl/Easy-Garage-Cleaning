/**
 * EGC Lead Intake — Cloudflare Pages Function
 * POST /api/lead-intake
 *
 * Receives Facebook (or any) lead data from Zapier and writes to Firestore.
 * Uses Firestore REST API so no Admin SDK is needed.
 *
 * Env vars (Cloudflare Pages dashboard → Settings → Environment Variables):
 *   FIREBASE_API_KEY — Firebase Web API key
 *
 * Zapier setup:
 *   Action: Webhooks by Zapier → POST
 *   URL: https://easygaragecleaning.com/api/lead-intake
 *   Payload Type: JSON
 *   Data: map Facebook Lead Ads fields to the JSON body below
 *
 * Expected JSON body:
 *   {
 *     "leadId":    "1002227635591668",   // Facebook lead ID (used as Firestore doc ID)
 *     "name":      "Jane Doe",
 *     "firstName": "Jane",               // optional
 *     "phone":     "+19705551234",
 *     "email":     "jane@example.com",
 *     "items":     "Garage Cleanout",     // service type / what they selected
 *     "source":    "Facebook Ads (fb)",
 *     "serviceZip":"80525",               // optional
 *     "message":   ""                     // optional free-text
 *   }
 */

const PROJECT_ID = 'egcw-1ec83';

function firestoreValue(val) {
  if (val === null || val === undefined) return { nullValue: null };
  if (typeof val === 'boolean') return { booleanValue: val };
  if (typeof val === 'number' && Number.isInteger(val)) return { integerValue: String(val) };
  if (typeof val === 'number') return { doubleValue: val };
  return { stringValue: String(val) };
}

function buildDoc(fields) {
  const mapped = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    mapped[k] = firestoreValue(v);
  }
  return { fields: mapped };
}

function normalizePhone(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (digits.length === 10) return '+1' + digits;
  if (digits.length === 11 && digits[0] === '1') return '+' + digits;
  if (digits.length > 10) return '+' + digits;
  return raw || '';
}

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

export async function onRequestOptions({ request }) {
  return new Response(null, { status: 204, headers: corsHeaders() });
}

export async function onRequestPost({ request, env }) {
  const cors = corsHeaders();
  const json = (status, body) => new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors },
  });

  const apiKey = env.FIREBASE_API_KEY;
  if (!apiKey) {
    console.error('FIREBASE_API_KEY not set');
    return json(500, { error: 'Server misconfigured' });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json(400, { error: 'Invalid JSON' });
  }

  const leadId = String(body.leadId || '').trim();
  const phone = normalizePhone(body.phone);
  const name = String(body.name || body.full_name || '').trim();

  if (!leadId && !phone) {
    return json(400, { error: 'leadId or phone required' });
  }

  const docId = leadId || phone;
  const now = new Date().toISOString();

  // Contact info — safe to (re)write on every delivery.
  const contactFields = {
    name: name,
    firstName: String(body.firstName || '').trim(),
    phone: phone,
    email: String(body.email || '').trim(),
    items: String(body.items || body.service || '').trim(),
    source: String(body.source || 'Facebook Ads (fb)').trim(),
    serviceZip: String(body.serviceZip || body.zip || '').trim(),
    message: String(body.message || '').trim(),
    updatedAt: now,
  };

  // Workflow state — only written when the lead doc doesn't exist yet.
  // Zapier retries/duplicate webhook deliveries must NOT reset a lead the
  // CRM has already worked (status, attempt count, follow-up timestamps).
  const initFields = {
    status: 'new',
    crmStatus: 'new',
    assignedTo: String(body.assignedTo || 'Tyler').trim(),
    contactAttempts: 0,
    conversationActive: false,
    prohibitedItemsFlag: false,
    createdAt: now,
    notifiedAt: now,
    consentCapturedAt: '',
    lastContactAt: '',
    lastInboundAt: '',
    lastOutboundAt: '',
    lastTouchAt: '',
    lossReason: '',
    nextFollowUpAt: '',
    optedOutAt: '',
    quoteSentAt: '',
    scheduledJobAt: '',
  };

  const docUrl = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/leads/${docId}`;

  let exists = false;
  try {
    const check = await fetch(`${docUrl}?key=${apiKey}&mask.fieldPaths=createdAt`);
    exists = check.ok; // 404 → new lead; treat lookup errors as new (worst case: reset, same as before)
  } catch (e) {
    console.warn('Lead existence check failed, treating as new:', e);
  }

  const fields = exists ? contactFields : { ...contactFields, ...initFields };
  const url = `${docUrl}?key=${apiKey}&updateMask.fieldPaths=${Object.keys(fields).join('&updateMask.fieldPaths=')}`;

  try {
    const resp = await fetch(url, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildDoc(fields)),
    });

    if (!resp.ok) {
      const err = await resp.text();
      console.error('Firestore error:', resp.status, err);
      return json(502, { error: 'Firestore write failed', detail: err });
    }

    return json(200, { ok: true, docId, name: name || phone, existing: exists });
  } catch (e) {
    console.error('Network error:', e);
    return json(500, { error: 'Network error' });
  }
}
