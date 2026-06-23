/**
 * EGC "Generate the After" — Cloudflare Pages Function
 * POST /api/garage-render
 *
 * Takes a BEFORE photo of a cluttered garage and returns a photorealistic
 * AI "after" (same garage, cleaned out) for the in-garage sales visualization.
 *
 * Reuses the existing OpenAI key (env.openaiapi — same one copilot.js uses),
 * so no new credential is needed. Calls OpenAI Images edits with gpt-image-2.
 *
 * Request  (JSON): { image: "data:image/...;base64,...", hint?: "string",
 *                    sketch?: "data:image/png;base64,..." }
 *   sketch is the crew's top-down floor-plan diagram (labeled zones, garage door
 *   at the bottom = camera position). When present it's sent as a SECOND reference
 *   image so the "after" render's zone positions match what the crew drew.
 * Response (JSON): { ok:true, image:"data:image/png;base64,..." } | { ok:false, error }
 *
 * Cost/latency: gpt-image-2 high quality runs a bit richer than v1 (~$0.15–0.40 and
 * several seconds per image, more when a sketch reference is attached). Keep it a deliberate
 * tap, not automatic. The UI labels the result "AI preview — actual results vary"
 * so it never becomes an implied guarantee against the locked-rate brand.
 */

const ALLOWED_HOST_RE = /(^|\.)easygaragecleaning\.com$|(\.pages\.dev)$|^localhost(:\d+)?$|^127\.0\.0\.1(:\d+)?$/;
const MAX_BODY = 12 * 1024 * 1024; // 12 MB — a downscaled garage photo is well under this

// Prompt follows OpenAI's image-edit guidance: positive Scene first, then the
// invariants to PRESERVE, then (assembled later) the zone layout + sketch note, and
// finally a short CONSTRAINTS block. Guardrails are deliberately LAST and few — image
// models weight an early "no X" as a composition cue (naming a thing can summon it),
// so exclusions belong at the end and capped at a handful.
const PROMPT =
  "Photorealistic real-estate listing 'after' photo of THIS exact residential garage, fully cleaned " +
  "out and organized. Shoot it straight-on from the driveway at eye level in bright natural daylight, " +
  "like a real estate agent's phone photo. Preserve the existing walls and wall color, the window and " +
  "its exact panes, the door, the ceiling, the concrete floor and the room's proportions exactly as in " +
  "the original photo. Clear all clutter and junk and sweep the floor to open, usable space; tidy the " +
  "belongings worth keeping onto the freestanding shelving and labeled storage bins described below, " +
  "arranged in the zones described below.";

// Hard guardrails — appended at the very END of the assembled prompt (after layout +
// sketch note). Three only, so they don't scatter the model's focus. The pole rule is
// explicit because gpt-image-2 likes to invent a structural post in an open garage floor.
const CONSTRAINTS =
  " Constraints: keep the floor open and unobstructed — do NOT add any support pole, column, post, " +
  "pillar, or beam standing in the floor. Show only the zones and items described above — no other " +
  "furniture, equipment, or rooms. Render it as a real photograph, not a CGI render, illustration, or showroom.";

// Appended only when the crew's top-down sketch is supplied as a 2nd image.
// gpt-image-1 sees both references; this tells it which is which and how to map
// the floor-plan's positions onto the front-on photo so the result lines up
// with what the crew actually drew (the #1 complaint was zones in the wrong spot).
const SKETCH_NOTE =
  " A SECOND image is attached: a top-down FLOOR PLAN of THIS SAME garage, with color-coded zones " +
  "labeled directly on the plan. The garage door is at the BOTTOM edge of that plan — that bottom " +
  "edge is exactly where the camera stands for this 'after' photo. Place every zone in the SAME left-to-" +
  "right and near-to-far position as the plan: a zone drawn on the LEFT of the plan stays on the LEFT of " +
  "the photo, a zone on the RIGHT stays on the RIGHT, and a zone near the TOP of the plan belongs along the " +
  "FAR/back wall. Use the FIRST image only for the real walls, window, door, ceiling and proportions — do " +
  "not copy any clutter from it. Use the floor plan ONLY to decide where each zone goes, not how it looks.";

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
  const sketch = body.sketch ? dataUrlToBytes(body.sketch) : null;

  let prompt = body.hint ? `${PROMPT} ${String(body.hint).slice(0, 800)}` : PROMPT;
  if (sketch) prompt += SKETCH_NOTE;
  prompt += CONSTRAINTS;   // guardrails last, per image-prompting best practice

  const form = new FormData();
  form.append('model', 'gpt-image-2');    // OpenAI's newest image model (Apr 2026): it reasons
                                          // about image STRUCTURE before rendering, so the zone
                                          // layout from the sketch lands far more reliably.
  form.append('prompt', prompt);
  form.append('size', '1536x1024');       // 1024x1024 | 1024x1536 | 1536x1024
  form.append('quality', 'high');         // low | medium | high
  // No input_fidelity: gpt-image-2 ALWAYS processes reference images at high fidelity (the
  // param is non-configurable on this model), so the garage's real window/walls/proportions
  // are preserved automatically — and passing the old param would risk a 400.
  form.append('n', '1');
  const ext = pic.mime === 'image/jpeg' ? 'jpg' : 'png';
  if (sketch) {
    // Two references under image[] (OpenAI takes up to 16, in order):
    //   [0] the real garage — walls/window/door/proportions
    //   [1] the top-down floor plan — zone POSITIONS to reproduce
    const sext = sketch.mime === 'image/jpeg' ? 'jpg' : 'png';
    form.append('image[]', new Blob([pic.bytes], { type: pic.mime }), `before.${ext}`);
    form.append('image[]', new Blob([sketch.bytes], { type: sketch.mime }), `layout.${sext}`);
  } else {
    form.append('image', new Blob([pic.bytes], { type: pic.mime }), `before.${ext}`);
  }

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
