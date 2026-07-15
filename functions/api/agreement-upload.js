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
 */

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const FILES_URL = 'https://www.googleapis.com/drive/v3/files';
const UPLOAD_URL = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id';
const FOLDER_NAME = 'Customer Agreements';
const MAX_BODY = 8 * 1024 * 1024;

const ALLOWED_HOST_RE = /(^|\.)easygaragecleaning\.com$|(\.pages\.dev)$|^localhost(:\d+)?$|^127\.0\.0\.1(:\d+)?$/;
function hostOf(v) { try { return new URL(v).host; } catch { return ''; } }
function originAllowed(request) {
  const o = request.headers.get('Origin'), r = request.headers.get('Referer');
  if (!o && !r) return true;
  return ALLOWED_HOST_RE.test(hostOf(o) || hostOf(r));
}

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
  const bin = atob(m[2]);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return { bytes, mime: m[1] };
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
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !env.GOOGLE_REFRESH_TOKEN) {
    return json(501, { ok: false, error: 'Drive upload not configured — run /api/drive-auth setup' });
  }

  const raw = await request.text();
  if (raw.length > MAX_BODY) return json(413, { ok: false, error: 'PDF too large' });
  let body;
  try { body = JSON.parse(raw); } catch { return json(400, { ok: false, error: 'Invalid JSON' }); }

  const jobId = String(body.jobId || '').trim().slice(0, 60);
  const filename = (String(body.filename || '').trim().slice(0, 140) || 'EGC agreement.pdf')
    .replace(/[\\/:*?"<>|]/g, '-').replace(/\.pdf$/i, '') + '.pdf';
  const pdf = dataUrlToBytes(body.dataUrl);
  if (!jobId) return json(400, { ok: false, error: 'jobId required' });
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
    const meta = JSON.stringify({ name: filename, parents: [folderId], appProperties: { egcJobId: jobId } });
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
  } catch (e) {
    return json(502, { ok: false, error: 'Drive upload failed', detail: String(e && e.message || e).slice(0, 200) });
  }
}
