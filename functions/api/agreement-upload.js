/**
 * EGC signed-agreement PDF upload → Google Drive — Cloudflare Pages Function
 * POST /api/agreement-upload
 *
 * The Game Plan's "Save PDF" button builds the customer agreement client-side
 * and posts it here; we file it in the app-created "Customer Agreements"
 * Drive folder (found by appProperties, so renaming/moving it is safe).
 *
 * IMPORTANT — where the folder lives: the Drive token uses the drive.file
 * scope (see /api/drive-auth), which can only see folders THIS APP created.
 * It cannot write into a folder made by hand in the Drive UI. So the first
 * save creates "Customer Agreements" at the top of My Drive; drag it into
 * EGC → Admin & Legal once (and trash any hand-made duplicate). The app keeps
 * write access wherever it's moved, and every later PDF lands there.
 *
 * Env vars: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN
 * (same trio the photo uploader uses — no extra setup).
 *
 * Request:  { jobId, label, filename, dataUrl (application/pdf, ≤ 6 MB) }
 * Response: { ok:true, folderId, folderUrl } | { ok:false, error }
 *
 * The jobId is validated in full (fieldId, never truncated) and each PDF is
 * stamped with egcJobKey, plus egcJobId when it fits Drive's 124-byte limit.
 */

import { getHubSession, hasBusinessAccess } from '../_lib/hub-session.js';
import { fieldId } from '../_lib/field-execution.js';
import { driveJobProperties } from '../_lib/drive-job-key.js';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const FILES_URL = 'https://www.googleapis.com/drive/v3/files';
const UPLOAD_URL = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id';
const FOLDER_NAME = 'Customer Agreements';
const MAX_BODY = 8 * 1024 * 1024;

// Same pattern as functions/api/field-jobs.js: a present Origin/Referer must be
// this exact origin (absent headers rely on the SameSite=Strict cookies).
const mutationOriginAllowed = request => {
  if (request.headers.get('Sec-Fetch-Site') === 'cross-site') return false;
  const origin = request.headers.get('Origin') || request.headers.get('Referer');
  if (!origin) return true;
  try { return new URL(origin).origin === new URL(request.url).origin; } catch { return false; }
};
const jsonRequest = request => request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() === 'application/json';

let cached = { token: null, exp: 0 };
async function accessToken(env) {
  if (cached.token && Date.now() < cached.exp - 60_000) return cached.token;
  const resp = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: env.GOOGLE_REFRESH_TOKEN,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
    }),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || !data.access_token) throw new Error('google token refresh failed: ' + resp.status);
  cached = { token: data.access_token, exp: Date.now() + (Number(data.expires_in || 3600) * 1000) };
  return cached.token;
}

async function gjson(url, token, init = {}) {
  const r = await fetch(url, { ...init, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers || {}) } });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`drive ${r.status}: ${JSON.stringify(d).slice(0, 200)}`);
  return d;
}

async function findOrCreateFolder(token) {
  const q = [
    `mimeType='application/vnd.google-apps.folder'`,
    'trashed=false',
    `appProperties has { key='egcAgreements' and value='1' }`,
  ].join(' and ');
  const found = await gjson(`${FILES_URL}?q=${encodeURIComponent(q)}&fields=files(id,name)&pageSize=1`, token);
  if (found.files && found.files.length) return found.files[0].id;
  const created = await gjson(`${FILES_URL}?fields=id`, token, {
    method: 'POST',
    body: JSON.stringify({ name: FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder', appProperties: { egcAgreements: '1' } }),
  });
  return created.id;
}

function dataUrlToBytes(dataUrl) {
  const m = /^data:([^;]+);base64,(.*)$/s.exec(String(dataUrl || ''));
  if (!m) return null;
  let bin;
  try { bin = atob(m[2]); } catch { return null; }
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return { bytes, mime: m[1] };
}

// Same-origin Hub pages never need CORS; a foreign preflight gets no grant.
export async function onRequestOptions({ request }) {
  if (!mutationOriginAllowed(request)) return new Response(null, { status: 403 });
  return new Response(null, { status: 204, headers: {
    Allow: 'POST, OPTIONS', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' } });
}

export async function onRequestGet() {
  return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'POST, OPTIONS' } });
}

export async function onRequestPost({ request, env }) {
  const json = (status, body) => new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });

  if (!mutationOriginAllowed(request)) return json(403, { ok: false, code: 'AGREEMENT_UPLOAD_ORIGIN_FORBIDDEN', error: 'Forbidden origin' });
  if (!jsonRequest(request)) return json(415, { ok: false, code: 'AGREEMENT_UPLOAD_JSON_REQUIRED', error: 'Agreements must be sent as JSON.' });
  const session = await getHubSession(request, env);
  if (!session) return json(401, { ok: false, error: 'Sign in to the EGC Hub' });
  if (!hasBusinessAccess(session)) return json(403, { ok: false, error: 'Business access is required to save customer agreements' });
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !env.GOOGLE_REFRESH_TOKEN) {
    return json(501, { ok: false, error: 'Drive upload not configured — run /api/drive-auth setup' });
  }

  const raw = await request.text();
  if (raw.length > MAX_BODY) return json(413, { ok: false, error: 'PDF too large' });
  let body;
  try { body = JSON.parse(raw); } catch { return json(400, { ok: false, error: 'Invalid JSON' }); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return json(400, { ok: false, error: 'Invalid JSON' });

  // Job ids are never truncated: a shortened id could file under another job.
  const jobId = String(body.jobId || '').trim();
  const filename = (String(body.filename || '').trim().slice(0, 140) || 'EGC agreement.pdf')
    .replace(/[\\/:*?"<>|]/g, '-').replace(/\.pdf$/i, '') + '.pdf';
  const pdf = dataUrlToBytes(body.dataUrl);
  if (!jobId) return json(400, { ok: false, error: 'jobId required' });
  if (!fieldId(jobId)) return json(400, { ok: false, error: 'A valid jobId is required' });
  if (!pdf || pdf.mime !== 'application/pdf' || pdf.bytes.length < 500) {
    return json(400, { ok: false, error: 'dataUrl must be an application/pdf data URL' });
  }
  // Real PDFs start with %PDF- — cheap sanity check against garbage uploads.
  const head5 = String.fromCharCode(...pdf.bytes.slice(0, 5));
  if (head5 !== '%PDF-') return json(400, { ok: false, error: 'Not a PDF' });

  try {
    const token = await accessToken(env);
    const folderId = await findOrCreateFolder(token);
    const boundary = 'egc' + Math.random().toString(36).slice(2);
    const meta = JSON.stringify({ name: filename, parents: [folderId], appProperties: await driveJobProperties(jobId) });
    const enc = new TextEncoder();
    const head = enc.encode(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: application/pdf\r\n\r\n`);
    const tail = enc.encode(`\r\n--${boundary}--`);
    const full = new Uint8Array(head.length + pdf.bytes.length + tail.length);
    full.set(head, 0); full.set(pdf.bytes, head.length); full.set(tail, head.length + pdf.bytes.length);
    const r = await fetch(UPLOAD_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': `multipart/related; boundary=${boundary}` },
      body: full,
    });
    if (!r.ok) throw new Error('upload ' + r.status);
    return json(200, { ok: true, folderId, folderUrl: `https://drive.google.com/drive/folders/${folderId}` });
  } catch {
    // Drive error bodies stay server-side; the Hub only needs the outcome.
    return json(502, { ok: false, error: 'Drive upload failed' });
  }
}
