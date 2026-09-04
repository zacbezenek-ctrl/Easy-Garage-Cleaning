/**
 * EGC SMS Event — Cloudflare Pages Function
 * POST /api/sms-event
 *
 * Receives inbound/outbound SMS events from Zapier and updates the correct
 * lead document by looking up the phone number (instead of using it as doc ID).
 *
 * Env vars: FIREBASE_API_KEY
 *
 * Expected JSON body:
 *   {
 *     "phone":     "+19705551234",
 *     "direction": "inbound" | "outbound",
 *     "stop":      false              // true if STOP/opt-out message
 *   }
 */

const PROJECT_ID = 'egcw-1ec83';

function normalizePhone(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (digits.length === 10) return '+1' + digits;
  if (digits.length === 11 && digits[0] === '1') return '+' + digits;
  if (digits.length > 10) return '+' + digits;
  return raw || '';
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function firestoreValue(val) {
  if (val === null || val === undefined) return { nullValue: null };
  if (typeof val === 'boolean') return { booleanValue: val };
  if (typeof val === 'number' && Number.isInteger(val)) return { integerValue: String(val) };
  return { stringValue: String(val) };
}

async function findLeadByPhone(apiKey, phone) {
  const digits = phone.replace(/\D/g, '');
  const last10 = digits.slice(-10);
  const variants = [
    phone,
    '+1' + last10,
    '1' + last10,
    last10,
  ];

  const url = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/leads?key=${apiKey}&pageSize=300`;
  const resp = await fetch(url);
  if (!resp.ok) return null;

  const data = await resp.json();
  const docs = data.documents || [];

  for (const doc of docs) {
    const docPhone = doc.fields?.phone?.stringValue || '';
    const docDigits = docPhone.replace(/\D/g, '');
    const docLast10 = docDigits.slice(-10);
    if (docLast10 === last10 && last10.length === 10) {
      const id = doc.name.split('/').pop();
      return { id, doc };
    }
  }
  return null;
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: corsHeaders() });
}

export async function onRequestPost({ request, env }) {
  const cors = corsHeaders();
  const json = (status, body) => new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors },
  });

  return json(410, {
    ok: false,
    code: 'LEGACY_FIREBASE_SMS_RETIRED',
    error: 'Legacy Firebase SMS tracking is retired. HighLevel owns CRM communication history.',
  });

  const apiKey = env.FIREBASE_API_KEY;
  if (!apiKey) return json(500, { error: 'Server misconfigured' });

  let body;
  try {
    body = await request.json();
  } catch {
    return json(400, { error: 'Invalid JSON' });
  }

  const phone = normalizePhone(body.phone);
  if (!phone) return json(400, { error: 'phone required' });

  const direction = String(body.direction || 'inbound').toLowerCase();
  const isStop = body.stop === true || body.stop === 'true';
  const now = new Date().toISOString();

  const lead = await findLeadByPhone(apiKey, phone);
  if (!lead) {
    return json(404, { error: 'No lead found for phone ' + phone });
  }

  const patch = { updatedAt: now };

  if (isStop) {
    patch.optedOutAt = now;
  } else if (direction === 'inbound') {
    patch.conversationActive = true;
    patch.lastInboundAt = now;
    patch.lastTouchAt = now;
  } else {
    patch.conversationActive = true;
    patch.lastOutboundAt = now;
    patch.lastTouchAt = now;
  }

  const fields = {};
  for (const [k, v] of Object.entries(patch)) {
    fields[k] = firestoreValue(v);
  }

  const docUrl = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/leads/${lead.id}?key=${apiKey}&${Object.keys(patch).map(k => 'updateMask.fieldPaths=' + k).join('&')}`;

  try {
    const resp = await fetch(docUrl, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields }),
    });

    if (!resp.ok) {
      const err = await resp.text();
      console.error('Firestore error:', resp.status, err);
      return json(502, { error: 'Firestore update failed' });
    }

    return json(200, { ok: true, docId: lead.id, direction, isStop });
  } catch (e) {
    console.error('Network error:', e);
    return json(500, { error: 'Network error' });
  }
}
