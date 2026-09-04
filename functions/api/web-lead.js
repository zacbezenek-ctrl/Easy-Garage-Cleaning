/**
 * EGC Website Lead relay — Cloudflare Pages Function
 * POST /api/web-lead
 *
 * The quote forms POST natively to Web3Forms (the email leg). fb-capture.js
 * mirrors the same submission here. This function writes the lead directly to
 * HighLevel, then forwards it to the existing Zapier instant-text/CAPI hook.
 *
 * The Zap then fires the team SMS alert + Meta CAPI Lead, and — once you add an
 * "AI by Zapier" step + an OpenPhone "Send Message" step — texts the lead back
 * in Tyler's voice, exactly like the Facebook flow (which uses Zapier's free
 * built-in AI and your existing OpenPhone connection — no API keys anywhere).
 *
 * To make that Zap setup trivial, the relay hands it three ready-to-use fields:
 *   lead_first_name  — first name only (for the greeting)
 *   lead_timing      — "in-hours" or "out-of-hours" (Mon–Sat 07:00–19:00 MT),
 *                      computed server-side so the AI step needs no Formatter
 *   lead_phone_e164  — the lead's number in +1XXXXXXXXXX form (OpenPhone "To")
 * plus the usual name/phone/items/source/subject and Meta fbc/fbp/fbclid.
 *
 * Config (Cloudflare Pages → Variables and Secrets, PRODUCTION):
 *   WEBSITE_LEAD_HOOK_URL — Zapier Catch Hook URL. That's the only var needed.
 */

const ALLOWED_HOST_RE = /(^|\.)easygaragecleaning\.com$|(\.pages\.dev)$|^localhost(:\d+)?$|^127\.0\.0\.1(:\d+)?$/;
const MAX_BODY = 32 * 1024;
const FIELDS = ['name', 'phone', 'email', 'items', 'source', 'subject', 'city', 'serviceZip', 'preferred_date', 'preferred_timing', 'booking_slot', 'estimated_range', 'flow_type', 'sms_consent', 'fbc', 'fbp', 'fbclid', 'landing_url', 'referrer', 'page_url'];
const HIGHLEVEL_API = 'https://services.leadconnectorhq.com';

function hostOf(value) {
  try { return new URL(value).host; } catch { return ''; }
}

// Read an env var tolerant of stray whitespace in the NAME — a dashboard var
// saved as "WEBSITE_LEAD_HOOK_URL " (trailing space) is a silent footgun: it's
// present but env.WEBSITE_LEAD_HOOK_URL reads undefined. Prefer the exact key;
// otherwise match any key that trims to the requested name.
function envVar(env, name) {
  if (env && env[name]) return env[name];
  for (const k of Object.keys(env || {})) {
    if (k.trim() === name && env[k]) return env[k];
  }
  return '';
}

function resolveHook(env) {
  return envVar(env, 'WEBSITE_LEAD_HOOK_URL');
}

function highLevelConfig(env) {
  return {
    token: envVar(env, 'HIGHLEVEL_API_KEY') || envVar(env, 'GHL_API_KEY'),
    locationId: envVar(env, 'HIGHLEVEL_LOCATION_ID') || envVar(env, 'GHL_LOCATION_ID'),
    pipelineId: envVar(env, 'HIGHLEVEL_PIPELINE_ID') || envVar(env, 'GHL_PIPELINE_ID'),
    stageId: envVar(env, 'HIGHLEVEL_NEW_LEAD_STAGE_ID') || envVar(env, 'GHL_NEW_LEAD_STAGE_ID'),
    assignedTo: envVar(env, 'HIGHLEVEL_USER_ID') || envVar(env, 'GHL_USER_ID'),
  };
}

async function highLevelRequest(config, path, options = {}) {
  const response = await fetch(HIGHLEVEL_API + path, {
    ...options,
    headers: {
      Authorization: `Bearer ${config.token}`,
      Version: 'v3',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`HighLevel returned ${response.status}: ${JSON.stringify(data).slice(0, 240)}`);
  return data;
}

async function syncHighLevelLead(env, lead) {
  const config = highLevelConfig(env);
  if (!config.token || !config.locationId) return { configured: false, synced: false };

  const contactResult = await highLevelRequest(config, '/contacts/upsert', {
    method: 'POST',
    body: JSON.stringify({
      locationId: config.locationId,
      name: lead.name,
      phone: lead.phone,
      ...(lead.email ? { email: lead.email } : {}),
      source: lead.source || 'EGC Website',
    }),
  });
  const contactId = contactResult.contact && contactResult.contact.id || contactResult.id || '';
  if (!contactId) throw new Error('HighLevel did not return a contact ID');
  const detailLines = [
    'EGC WEBSITE LEAD DETAILS',
    `Service / items: ${lead.items || '—'}`,
    `Email: ${lead.email || '—'}`,
    `Location: ${[lead.city, lead.serviceZip].filter(Boolean).join(' ') || '—'}`,
    `Preferred date / timing: ${[lead.preferred_date, lead.preferred_timing].filter(Boolean).join(' · ') || '—'}`,
    `Requested slot: ${lead.booking_slot || '—'}`,
    `Estimated range shown: ${lead.estimated_range || '—'}`,
    `Form path: ${lead.flow_type || 'standard'}`,
    `SMS consent checked: ${lead.sms_consent === 'yes' ? 'yes' : 'no'}`,
    `Landing page: ${lead.page_url || lead.landing_url || '—'}`,
  ];
  try {
    await highLevelRequest(config, `/contacts/${encodeURIComponent(contactId)}/notes`, {
      method: 'POST', headers: { 'Idempotency-Key': `website-lead-details:${contactId}:${lead.booking_slot || lead.preferred_date || 'request'}` },
      body: JSON.stringify({ userId: config.assignedTo || undefined, title: 'EGC Website Lead Details', body: detailLines.join('\n').slice(0, 3000), color: '#F15A24', pinned: false }),
    });
  } catch {}
  if (!config.pipelineId) return { configured: true, synced: true, contactId, opportunityId: '' };

  let stageId = config.stageId;
  if (!stageId) {
    const data = await highLevelRequest(config, `/opportunities/pipelines?locationId=${encodeURIComponent(config.locationId)}`);
    const pipeline = (data.pipelines || []).find(item => item.id === config.pipelineId);
    stageId = pipeline && pipeline.stages && pipeline.stages[0] && pipeline.stages[0].id || '';
  }
  if (!stageId) throw new Error('HighLevel new-lead pipeline stage is unavailable');

  const body = {
    pipelineId: config.pipelineId,
    locationId: config.locationId,
    name: `${lead.name} — ${lead.items || 'Website lead'}`,
    pipelineStageId: stageId,
    status: 'open',
    contactId,
    monetaryValue: 0,
    followers: config.assignedTo ? [config.assignedTo] : [],
    isRemoveAllFollowers: false,
    followersActionType: 'add',
    ...(config.assignedTo ? { assignedTo: config.assignedTo } : {}),
  };
  const result = await highLevelRequest(config, '/opportunities/upsert', {
    method: 'POST',
    headers: { 'Idempotency-Key': `website-lead:${contactId}:${config.pipelineId}` },
    body: JSON.stringify(body),
  });
  return { configured: true, synced: true, contactId, opportunityId: result.opportunity && result.opportunity.id || result.id || '' };
}

function originAllowed(request) {
  const origin = request.headers.get('Origin');
  const referer = request.headers.get('Referer');
  if (!origin && !referer) return true;
  return ALLOWED_HOST_RE.test(hostOf(origin) || hostOf(referer));
}

function normalizePhone(raw) {
  const d = String(raw || '').replace(/\D/g, '');
  if (d.length === 10) return '+1' + d;
  if (d.length === 11 && d[0] === '1') return '+' + d;
  if (d.length > 11) return '+' + d;
  return '';
}

// Mon–Sat 07:00–19:00 Mountain. Fails to "in-hours" (better to promise a call
// "in a couple minutes" than to wrongly promise tomorrow).
function leadTiming() {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Denver', weekday: 'short', hour: 'numeric', hour12: false,
    }).formatToParts(new Date());
    const wd = parts.find((p) => p.type === 'weekday').value;
    let hr = parseInt(parts.find((p) => p.type === 'hour').value, 10);
    if (hr === 24) hr = 0;
    return (wd !== 'Sun' && hr >= 7 && hr < 19) ? 'in-hours' : 'out-of-hours';
  } catch { return 'in-hours'; }
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}

export async function onRequestPost({ request, env }) {
  const json = (status, body) =>
    new Response(JSON.stringify(body), {
      status,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store',
      },
    });

  if (!originAllowed(request)) return json(403, { ok: false, error: 'Forbidden origin' });

  const raw = await request.text();
  if (raw.length > MAX_BODY) return json(413, { ok: false, error: 'Payload too large' });

  let body;
  try { body = JSON.parse(raw); }
  catch { return json(400, { ok: false, error: 'Invalid JSON' }); }

  // Honeypot tripped — answer success so bots learn nothing, forward nothing.
  if (body.botcheck) return json(200, { ok: true });

  const name = String(body.name || '').trim();
  const phone = String(body.phone || '').trim();
  if (!name || phone.replace(/\D/g, '').length < 7) {
    return json(400, { ok: false, error: 'name and phone required' });
  }

  const hook = resolveHook(env);

  const params = new URLSearchParams();
  const flat = {};
  for (const k of FIELDS) {
    const v = String(body[k] || '').trim();
    flat[k] = v;
    if (v) params.set(k, v);
  }
  // Ready-to-map fields for the Zap's AI + OpenPhone steps.
  const extras = {
    lead_first_name: name.split(/\s+/)[0] || '',
    lead_timing: leadTiming(),
    lead_phone_e164: normalizePhone(phone),
  };
  for (const [k, v] of Object.entries(extras)) {
    flat[k] = v;
    if (v) params.set(k, v);
  }

  let highlevel;
  try { highlevel = await syncHighLevelLead(env, { ...flat, name, phone, source: flat.source || 'EGC Website' }); }
  catch (error) { return json(502, { ok: false, error: 'HighLevel lead sync failed', detail: String(error.message || error).slice(0, 300) }); }

  let relay = { configured: !!hook, sent: false };
  if (hook) {
    try {
      const resp = await fetch(hook + (hook.includes('?') ? '&' : '?') + params.toString(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(flat),
      });
      relay = { configured: true, sent: resp.ok };
    } catch { relay = { configured: true, sent: false }; }
  }
  if (!highlevel.configured && !relay.sent) return json(503, { ok: false, error: 'Lead destinations are not configured' });
  return json(200, { ok: true, highlevel: { configured: highlevel.configured, synced: highlevel.synced }, relay });
}

// Health/config probe — reports whether the hook is wired (boolean only).
export async function onRequestGet({ env }) {
  const highlevel = highLevelConfig(env);
  return new Response(JSON.stringify({ ok: true, configured: !!resolveHook(env) || Boolean(highlevel.token && highlevel.locationId), highlevel: Boolean(highlevel.token && highlevel.locationId), relay: !!resolveHook(env) }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}
