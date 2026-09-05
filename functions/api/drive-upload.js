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
import { getCustomerPortalSession } from '../_lib/customer-portal.js';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const FILES_URL = 'https://www.googleapis.com/drive/v3/files';
const UPLOAD_URL = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id';
const ROOT_NAME = 'EGC Job Photos';
const MAX_BODY = 24 * 1024 * 1024;
const MAX_PHOTOS = 8;
const MAX_CUSTOMER_PHOTOS = 3;
const MAX_PHOTO_BYTES = 6 * 1024 * 1024;
const IMAGE_TYPES = new Map([
  ['image/jpeg', { extension: 'jpg', valid: bytes => bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff }],
  ['image/png', { extension: 'png', valid: bytes => bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 }],
  ['image/webp', { extension: 'webp', valid: bytes => bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50 }],
]);

const ALLOWED_HOST_RE = /^(?:easygaragecleaning\.com|www\.easygaragecleaning\.com|easy-garage-cleaning\.pages\.dev|localhost(?::\d+)?|127\.0\.0\.1(?::\d+)?)$/;
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
  const mime = String(m[1] || '').toLowerCase();
  const type = IMAGE_TYPES.get(mime);
  if (!type) return null;
  let bin;
  try { bin = atob(m[2]); } catch { return null; }
  if (!bin.length || bin.length > MAX_PHOTO_BYTES) return null;
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  if (!type.valid(bytes)) return null;
  return { bytes, mime, extension: type.extension };
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
  const hubSession = await getHubSession(request, env);
  const customerSession = hubSession ? null : await getCustomerPortalSession(request, env);
  if (!hubSession && !customerSession) return json(401, { ok: false, error: 'Sign in to the EGC Hub or open a private customer link' });
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !env.GOOGLE_REFRESH_TOKEN) {
    return json(501, { ok: false, error: 'Drive upload not configured — run /api/drive-auth setup' });
  }

  const raw = await request.text();
  if (raw.length > MAX_BODY) return json(413, { ok: false, error: 'Batch too large' });
  let body;
  try { body = JSON.parse(raw); } catch { return json(400, { ok: false, error: 'Invalid JSON' }); }

  const jobId = customerSession ? customerSession.jobId : String(body.jobId || '').trim().slice(0, 60);
  const label = customerSession ? 'Customer uploads' : (String(body.label || 'EGC job').trim().slice(0, 120) || 'EGC job');
  const photos = Array.isArray(body.photos) ? body.photos.slice(0, customerSession ? MAX_CUSTOMER_PHOTOS : MAX_PHOTOS) : [];
  if (!jobId) return json(400, { ok: false, error: 'jobId required' });
  if (!photos.length) return json(400, { ok: false, error: 'No photos in batch' });
  const preparedPhotos = photos.map(photo => ({ photo, pic: dataUrlToBytes(photo.dataUrl) }));
  if (preparedPhotos.some(item => !item.pic)) {
    return json(400, { ok: false, error: 'Photos must be valid JPG, PNG, or WebP files no larger than 6 MB' });
  }

  try {
    const token = await accessToken(env);
    const rootId = await findOrCreateFolder(token, { name: ROOT_NAME, propKey: 'egcRoot', propVal: '1' });
    const folderId = await findOrCreateFolder(token, { name: label, parent: rootId, propKey: 'egcJobId', propVal: jobId });

    const uploaded = [];
    for (const { photo: p, pic } of preparedPhotos) {
      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const tag = customerSession ? 'customer' : String(p.tag || 'photo').replace(/[^a-z0-9_-]/gi, '').slice(0, 20);
      await uploadOne(token, folderId, `${tag || 'photo'}-${ts}-${String(p.id || '').replace(/[^a-z0-9_-]/gi, '').slice(0, 12)}.${pic.extension}`, pic);
      uploaded.push(p.id);
    }
    return customerSession
      ? json(200, { ok: true, uploaded })
      : json(200, { ok: true, folderId, folderUrl: `https://drive.google.com/drive/folders/${folderId}`, uploaded });
  } catch {
    return json(502, { ok: false, error: 'Drive upload failed' });
  }
}
