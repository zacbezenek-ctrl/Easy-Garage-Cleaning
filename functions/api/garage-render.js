/**
 * EGC "Generate the After" — Cloudflare Pages Function
 * POST /api/garage-render
 *
 * Takes a BEFORE photo of a cluttered garage and returns a photorealistic
 * AI "after" (same garage, cleaned out) for the in-garage sales visualization.
 *
 * Reuses the existing OpenAI key (env.openaiapi — same one copilot.js uses),
 * so no new credential is needed. Calls OpenAI Images edits with gpt-image-1.
 *
 * Request  (JSON): { image: "data:image/...;base64,...", hint?: "string" }
 * Response (JSON): { ok:true, image:"data:image/png;base64,..." } | { ok:false, error }
 *
 * Cost/latency: ~$0.04–0.17 and several seconds per image. Keep it a deliberate
 * tap, not automatic. The UI labels the result "AI preview — actual results vary"
 * so it never becomes an implied guarantee against the locked-rate brand.
 */

const ALLOWED_HOST_RE = /(^|\.)easygaragecleaning\.com$|(\.pages\.dev)$|^localhost(:\d+)?$|^127\.0\.0\.1(:\d+)?$/;
const MAX_BODY = 12 * 1024 * 1024; // 12 MB — a downscaled garage photo is well under this

const PROMPT =
  "This is a photo of a customer's cluttered residential garage. Produce a photorealistic " +
  "'after' image of the SAME garage, rendered as a FRONT-ON view looking straight in through the " +
  "open garage door from the driveway — eye level, centered, symmetrical. Keep the same walls, " +
  "garage door, window placement, ceiling and overall dimensions. Show it fully cleaned out and " +
  "organized: clutter and junk removed, concrete floor swept clean, remaining belongings neatly " +
  "stored on simple wall shelving, clear floor space for a car. Arrange the space to match the " +
  "described top-down layout (where the car, workbench, gym and storage zones go). Keep it " +
  "realistic and attainable for a one-day cleanout — a tidy real garage, not a luxury showroom " +
  "or renovation. Natural daylight.";

function hostOf(v) { try { return new URL(v).host; } catch { return ''; } }
// Read an env var tolerant of stray whitespace in the var NAME — a dashboard
// secret saved as "openaiapi " (trailing space) reads back undefined under
// env.openaiapi. Same guard web-lead.js uses. Prefer the exact key; otherwise
// match any key that trims to the requested name.
function envVar(env, name) {
  if (env && env[name]) return env[name];
  // tolerate stray whitespace AND case in the var name (e.g. "OpenAIAPI" vs "openaiapi")
  const want = name.trim().toLowerCase();
  for (const k of Object.keys(env || {})) {
    if (k.trim().toLowerCase() === want && env[k]) return env[k];
  }
  return '';
}
function originAllowed(request) {
  const o = request.headers.get('Origin'), r = request.headers.get('Referer');
  if (!o && !r) return true;
  return ALLOWED_HOST_RE.test(hostOf(o) || hostOf(r));
}

// "data:image/png;base64,AAAA" -> { bytes:Uint8Array, mime:"image/png" }
function dataUrlToBytes(dataUrl) {
  const m = /^data:([^;]+);base64,(.*)$/s.exec(String(dataUrl || ''));
  if (!m) return null;
  const mime = m[1];
  const bin = atob(m[2]);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return { bytes, mime };
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: {
    'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' } });
}

export async function onRequestGet() {
  return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'POST, OPTIONS' } });
}

export async function onRequestPost({ request, env }) {
  const json = (status, body) => new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' } });

  if (!originAllowed(request)) return json(403, { ok: false, error: 'Forbidden origin' });
  const apiKey = envVar(env, 'openaiapi');
  if (!apiKey) return json(500, { ok: false, error: 'Image generation not configured (openaiapi missing)' });

  const raw = await request.text();
  if (raw.length > MAX_BODY) return json(413, { ok: false, error: 'Image too large — retake at a smaller size' });

  let body;
  try { body = JSON.parse(raw); } catch { return json(400, { ok: false, error: 'Invalid JSON' }); }

  const pic = dataUrlToBytes(body.image);
  if (!pic) return json(400, { ok: false, error: 'No before photo supplied' });

  const form = new FormData();
  form.append('model', 'gpt-image-1');
  form.append('prompt', body.hint ? `${PROMPT} ${String(body.hint).slice(0, 400)}` : PROMPT);
  form.append('size', '1536x1024');
  form.append('n', '1');
  const ext = pic.mime === 'image/jpeg' ? 'jpg' : 'png';
  form.append('image', new Blob([pic.bytes], { type: pic.mime }), `before.${ext}`);

  try {
    const r = await fetch('https://api.openai.com/v1/images/edits', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
    });
    if (!r.ok) {
      const detail = (await r.text().catch(() => '')).slice(0, 300);
      return json(502, { ok: false, error: 'Image service error', status: r.status, detail });
    }
    const data = await r.json();
    const b64 = data && data.data && data.data[0] && data.data[0].b64_json;
    if (!b64) return json(502, { ok: false, error: 'No image returned' });
    return json(200, { ok: true, image: 'data:image/png;base64,' + b64 });
  } catch (e) {
    return json(502, { ok: false, error: 'Image service unreachable' });
  }
}
