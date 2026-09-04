/**
 * EGC job-photo upload → Google Drive — Cloudflare Pages Function
 * POST /api/drive-upload
 *
 * Uploads crew photos into a UNIQUE Google Drive folder per job:
 *   EGC Job Photos / <label e.g. "2026-06-12 — Dana Tester — 746 Star Grass Ln">
 * The job folder is found (by jobId stamped in appProperties) or created, so
 * repeat uploads from any tool land in the same folder. Returns the folder link.
 *
 * Env vars: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN
 * (minted once via /api/drive-auth — drive.file scope: this app only ever
 * sees the folders/files it created).
 *
 * Request:  { jobId, label, photos:[{ id, tag, dataUrl }] }   (≤ 8 photos/call)
 * Response: { ok:true, folderId, folderUrl, uploaded:[ids] } | { ok:false, error }
 */

import { getHubSession } from '../_lib/hub-session.js';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const FILES_URL = 'https://www.googleapis.com/drive/v3/files';
const UPLOAD_URL = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id';
const ROOT_NAME = 'EGC Job Photos';
const MAX_BODY = 24 * 1024 * 1024;
const MAX_PHOTOS = 8;

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

async function findOrCreateFolder(token, { name, parent, propKey, propVal }) {
  const qParts = [
    `mimeType='application/vnd.google-apps.folder'`,
    'trashed=false',
    propKey ? `appProperties has { key='${propKey}' and value='${propVal.replace(/'/g, '')}' }` : `name='${name.replace(/'/g, '')}'`,
  ];
  if (parent) qParts.push(`'${parent}' in parents`);
  const found = await gjson(`${FILES_URL}?q=${encodeURIComponent(qParts.join(' and '))}&fields=files(id,name)&pageSize=1`, token);
  if (found.files && found.files.length) return found.files[0].id;
  const meta = { name, mimeType: 'application/vnd.google-apps.folder' };
  if (parent) meta.parents = [parent];
  if (propKey) meta.appProperties = { [propKey]: propVal };
  const created = await gjson(`${FILES_URL}?fields=id`, token, { method: 'POST', body: JSON.stringify(meta) });
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

async function uploadOne(token, folderId, name, pic) {
  const boundary = 'egc' + Math.random().toString(36).slice(2);
  const meta = JSON.stringify({ name, parents: [folderId] });
  const enc = new TextEncoder();
  const head = enc.encode(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: ${pic.mime}\r\n\r\n`);
  const tail = enc.encode(`\r\n--${boundary}--`);
  const body = new Uint8Array(head.length + pic.bytes.length + tail.length);
  body.set(head, 0); body.set(pic.bytes, head.length); body.set(tail, head.length + pic.bytes.length);
  const r = await fetch(UPLOAD_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': `multipart/related; boundary=${boundary}` },
    body,
  });
  if (!r.ok) throw new Error('upload ' + r.status);
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
  if (!await getHubSession(request, env)) return json(401, { ok: false, error: 'Sign in to the EGC Hub' });
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !env.GOOGLE_REFRESH_TOKEN) {
    return json(501, { ok: false, error: 'Drive upload not configured — run /api/drive-auth setup' });
  }

  const raw = await request.text();
  if (raw.length > MAX_BODY) return json(413, { ok: false, error: 'Batch too large' });
  let body;
  try { body = JSON.parse(raw); } catch { return json(400, { ok: false, error: 'Invalid JSON' }); }

  const jobId = String(body.jobId || '').trim().slice(0, 60);
  const label = String(body.label || 'EGC job').trim().slice(0, 120) || 'EGC job';
  const photos = Array.isArray(body.photos) ? body.photos.slice(0, MAX_PHOTOS) : [];
  if (!jobId) return json(400, { ok: false, error: 'jobId required' });
  if (!photos.length) return json(400, { ok: false, error: 'No photos in batch' });

  try {
    const token = await accessToken(env);
    const rootId = await findOrCreateFolder(token, { name: ROOT_NAME, propKey: 'egcRoot', propVal: '1' });
    const folderId = await findOrCreateFolder(token, { name: label, parent: rootId, propKey: 'egcJobId', propVal: jobId });

    const uploaded = [];
    for (const p of photos) {
      const pic = dataUrlToBytes(p.dataUrl);
      if (!pic) continue;
      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      await uploadOne(token, folderId, `${p.tag || 'photo'}-${ts}-${String(p.id || '').slice(0, 12)}.jpg`, pic);
      uploaded.push(p.id);
    }
    return json(200, { ok: true, folderId, folderUrl: `https://drive.google.com/drive/folders/${folderId}`, uploaded });
  } catch (e) {
    return json(502, { ok: false, error: 'Drive upload failed', detail: String(e && e.message || e).slice(0, 200) });
  }
}
