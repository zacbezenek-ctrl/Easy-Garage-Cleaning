/**
 * EGC Website Lead relay — Cloudflare Pages Function
 * POST /api/web-lead
 *
 * The quote forms POST natively to Web3Forms (the email leg). fb-capture.js
 * mirrors the same submission here, and this function:
 *   1. Forwards to the Zapier Catch Hook for "EGC Website Lead → Instant Text"
 *      (team SMS alert + Meta CAPI Lead).
 *   2. Optionally texts the lead back in Tyler's voice, time-of-day aware, via
 *      OpenPhone — mirroring the Facebook-lead flow so replies thread to Tyler.
 *
 * Config (Cloudflare Pages → Settings → Variables and Secrets, PRODUCTION):
 *   WEBSITE_LEAD_HOOK_URL   — Zapier Catch Hook URL (team alert + Meta Lead).
 *   openaiapi               — OpenAI key (writes the SMS opener). Already set.
 *   OPENPHONE_API_KEY       — OpenPhone API key (sends the text to the lead).
 *                             Get it in OpenPhone → Settings → API. Without it,
 *                             the text-back simply no-ops (alert still fires).
 *   WEBSITE_AUTOTEXT        — set to "on" to actually send the lead text. Until
 *                             then the opener is never sent — a deliberate
 *                             go-live switch so customers aren't texted untested.
 *   OPENPHONE_FROM_NUMBER   — optional; the OpenPhone/Quo line to send from.
 *                             Defaults to +19709991818 (Customer Intake).
 *
 * Field names (name/phone/items/source/subject) match the trigger's stored
 * sample. They're sent BOTH as query params (so querystring.* references
 * resolve) and as a flat JSON body (so root-level references resolve).
 */

const ALLOWED_HOST_RE = /(^|\.)easygaragecleaning\.com$|(\.pages\.dev)$|^localhost(:\d+)?$|^127\.0\.0\.1(:\d+)?$/;
const MAX_BODY = 32 * 1024;
const FIELDS = ['name', 'phone', 'items', 'source', 'subject', 'fbc', 'fbp', 'fbclid', 'landing_url', 'referrer', 'page_url'];
const DEFAULT_FROM = '+19709991818'; // Customer Intake (Quo/OpenPhone)

// Lifted verbatim from the Facebook-lead Zap's AI step so the website opener
// reads identically — Tyler's casual lowercase voice, service-aware, and it
// switches the call-timing line on whether it's in-hours or out-of-hours.
const TYLER_SMS_INSTRUCTIONS = `You fill in an SMS opener for Easy Garage Cleaning and output ONLY the finished text — no preamble, no quotes, no explanation.
Inputs you'll get: the lead's first name, the service(s) they selected (garage cleaning, junk removal, or both/multiple), and whether it's in-hours or out-of-hours.

In-hours template:
hey [Name], it's tyler with easy garage cleaning.  I work the phone for zac (the guy from the ad). — just saw your request come in for [SERVICE]. gonna give you a quick call in the next couple mins to get you a price. you free?

Out-of-hours template:
hey [Name], it's tyler with easy garage cleaning.  I work the phone for zac (the guy from the ad). — just saw your request come in for [SERVICE]. gonna give you a call first thing in the morning to get you a price. what time works?

Rules:
Keep it lowercase and casual, like tyler typed it on his phone. No emojis, no signature, no capitalized sentence starts.
Use the in-hours template when timing is in-hours, the out-of-hours template when out-of-hours.
Fill [Name] with the first name only. If no name is given, remove it and start with "hey, tyler here with easy garage cleaning...".
Fill [SERVICE] with natural phrasing:
– garage cleaning only → getting your garage cleaned out
– junk removal only → some junk removal
– both or multiple selected → getting your garage cleared out
– missing/unclear → getting some stuff cleared out
Do not invent services, add details, or change the core ask. Output the message and nothing else.`;

function hostOf(value) {
  try { return new URL(value).host; } catch { return ''; }
}

// Resolve the hook URL tolerant of stray whitespace in the variable NAME — a
// dashboard env var saved as "WEBSITE_LEAD_HOOK_URL " (trailing space) is a
// silent footgun: it's present but env.WEBSITE_LEAD_HOOK_URL reads undefined.
// Prefer the exact key; otherwise match any key that trims to the same name.
function resolveHook(env) {
  if (env && env.WEBSITE_LEAD_HOOK_URL) return env.WEBSITE_LEAD_HOOK_URL;
  for (const k of Object.keys(env || {})) {
    if (k.trim() === 'WEBSITE_LEAD_HOOK_URL' && env[k]) return env[k];
  }
  return '';
}

function originAllowed(request) {
  const origin = request.headers.get('Origin');
  const referer = request.headers.get('Referer');
  // Same-origin native fetch sometimes omits both — payload validation below
  // is the real filter, this just rejects obvious off-origin abuse.
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

// Business hours: Mon–Sat 07:00–19:00 Mountain. new Date() is fine in the
// Functions runtime; on any failure we fail OPEN to in-hours (better to say
// "calling in a couple minutes" than to wrongly promise tomorrow).
function isInHours() {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Denver', weekday: 'short', hour: 'numeric', hour12: false,
    }).formatToParts(new Date());
    const wd = parts.find((p) => p.type === 'weekday').value;
    let hr = parseInt(parts.find((p) => p.type === 'hour').value, 10);
    if (hr === 24) hr = 0;
    return wd !== 'Sun' && hr >= 7 && hr < 19;
  } catch { return true; }
}

async function writeOpener(env, firstName, service, inHours) {
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + env.openaiapi, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      temperature: 0.7,
      max_tokens: 200,
      messages: [
        { role: 'system', content: TYLER_SMS_INSTRUCTIONS },
        { role: 'user', content: `First name: ${firstName || '(none)'}\nService(s) selected: ${service || '(unclear)'}\nTiming: ${inHours ? 'in-hours' : 'out-of-hours'}` },
      ],
    }),
  });
  if (!r.ok) throw new Error('openai ' + r.status);
  const j = await r.json();
  return ((j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '').trim();
}

async function sendOpenPhone(env, toE164, content) {
  const from = String(env.OPENPHONE_FROM_NUMBER || DEFAULT_FROM).trim();
  const r = await fetch('https://api.openphone.com/v1/messages', {
    method: 'POST',
    headers: { Authorization: env.OPENPHONE_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to: [toE164], content }),
  });
  if (!r.ok) throw new Error('openphone ' + r.status + ' ' + (await r.text().catch(() => '')).slice(0, 160));
  return true;
}

// Text the lead back like the Facebook flow does. No-ops unless the OpenPhone
// key is present AND WEBSITE_AUTOTEXT === "on" (the go-live switch), and unless
// OpenAI is configured. Runs in the background via waitUntil; never throws into
// the request path.
async function maybeTextLead(env, lead) {
  if (!env || !env.OPENPHONE_API_KEY) return;
  if (String(env.WEBSITE_AUTOTEXT || '').trim().toLowerCase() !== 'on') return;
  if (!env.openaiapi) return;
  const to = normalizePhone(lead.phone);
  if (!to) return;
  const firstName = String(lead.name || '').trim().split(/\s+/)[0] || '';
  let opener;
  try { opener = await writeOpener(env, firstName, lead.items, isInHours()); }
  catch { return; }
  if (!opener) return;
  try { await sendOpenPhone(env, to, opener); } catch { /* alert leg already fired; swallow */ }
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

export async function onRequestPost(context) {
  const { request, env } = context;
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

  // Text the lead back in the background, independent of the alert forward.
  const textBack = maybeTextLead(env, { name, phone, items: String(body.items || '').trim() }).catch(() => {});
  if (context.waitUntil) context.waitUntil(textBack);

  const hook = resolveHook(env);
  if (!hook) return json(503, { ok: false, error: 'Relay not configured' });

  const params = new URLSearchParams();
  const flat = {};
  for (const k of FIELDS) {
    const v = String(body[k] || '').trim();
    flat[k] = v;
    if (v) params.set(k, v);
  }

  try {
    const resp = await fetch(hook + (hook.includes('?') ? '&' : '?') + params.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(flat),
    });
    if (!resp.ok) {
      const detail = (await resp.text().catch(() => '')).slice(0, 300);
      return json(502, { ok: false, error: 'Upstream rejected', status: resp.status, detail });
    }
    return json(200, { ok: true });
  } catch {
    return json(502, { ok: false, error: 'Upstream unreachable' });
  }
}

// Health/config probe — reports whether the hook is wired and whether the
// lead text-back is armed (booleans only, never the URL or keys).
export async function onRequestGet({ env }) {
  const autotextArmed = !!(env && env.OPENPHONE_API_KEY) &&
    String((env && env.WEBSITE_AUTOTEXT) || '').trim().toLowerCase() === 'on' &&
    !!(env && env.openaiapi);
  return new Response(JSON.stringify({ ok: true, configured: !!resolveHook(env), autotextArmed }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}
