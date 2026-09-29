import { fieldFailure } from './field-execution.js';

const FILES = 'https://www.googleapis.com/drive/v3/files';
export const FIELD_PHOTO_MAX_BYTES = 6 * 1024 * 1024;
export const FIELD_PHOTO_THUMBNAIL_MAX_BYTES = 1024 * 1024;
// Drive's thumbnailLink is a short-lived googleusercontent.com URL ending in a size such as
// =s220. Only that host is ever fetched, and the size is raised for a sharp 2-column phone grid.
const THUMBNAIL_HOST = /^[a-z0-9-]+\.googleusercontent\.com$/;

export function driveThumbnailUrl(link, size = 640) {
  let url;
  try { url = new URL(link); } catch { return null; }
  if (url.protocol !== 'https:' || !THUMBNAIL_HOST.test(url.hostname) || url.port || url.username || url.password) return null;
  return url.search || url.hash ? url.href : url.href.replace(/=s\d{1,4}$/, `=s${size}`);
}
export const fieldPhotosConfigured = env => Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.GOOGLE_REFRESH_TOKEN);

export function decodeFieldPhoto(dataUrl) {
  const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(typeof dataUrl === 'string' ? dataUrl : '');
  if (!match) throw fieldFailure('Choose a JPG, PNG or WebP photo. iPhone photos are converted before upload.');
  let binary;
  try { binary = atob(match[2]); } catch { throw fieldFailure('This photo could not be decoded. Choose it again.'); }
  if (binary.length < 12 || binary.length > FIELD_PHOTO_MAX_BYTES) throw fieldFailure('Each photo must be no larger than 6 MB.');
  const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
  const valid = match[1] === 'image/jpeg' ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
    : match[1] === 'image/png' ? [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value)
      : String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP';
  if (!valid) throw fieldFailure('The photo contents do not match its file type. Choose the original image again.');
  return { bytes, mime: match[1], extension: match[1] === 'image/jpeg' ? 'jpg' : match[1].slice(6) };
}

// One Drive access token per isolate, keyed by a digest of the OAuth
// credential, so each photo request does not repeat the refresh-token
// exchange. Only the token string is shared between requests (never an
// in-flight promise), and a token without a stated lifetime is not kept.
const driveTokens = { current: null };

async function driveAccessToken(env, now, tokens) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${env.GOOGLE_CLIENT_ID}\n${env.GOOGLE_CLIENT_SECRET}\n${env.GOOGLE_REFRESH_TOKEN}`));
  const credential = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join(''), cached = tokens.current;
  const requestedAt = now();
  if (cached?.credential === credential && cached.expiresAt - 60000 > requestedAt) return cached.token;
  const tokenResponse = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: env.GOOGLE_REFRESH_TOKEN, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET }), signal: AbortSignal.timeout(15000) });
  const tokenData = await tokenResponse.json().catch(() => ({}));
  if (!tokenResponse.ok || typeof tokenData.access_token !== 'string' || !tokenData.access_token) throw fieldFailure('Photo storage could not connect. Your photo is still available to retry.', 503, 'FIELD_PHOTO_STORAGE_UNAVAILABLE');
  const lifetime = Number(tokenData.expires_in);
  tokens.current = Number.isFinite(lifetime) && lifetime > 120 ? { credential, token: tokenData.access_token, expiresAt: requestedAt + Math.min(lifetime, 3600) * 1000 } : null;
  return tokenData.access_token;
}

// The whole body, or null (with the rest cancelled) once it passes max bytes.
async function readCapped(body, max) {
  if (!body) return null;
  const reader = body.getReader(), chunks = [];
  let size = 0;
  for (let part = await reader.read(); !part.done; part = await reader.read()) {
    size += part.value.byteLength;
    if (size > max) { await reader.cancel().catch(() => {}); return null; }
    chunks.push(part.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

export async function createFieldPhotoClient(env, { now = () => Date.now(), tokens = driveTokens } = {}) {
  if (!fieldPhotosConfigured(env)) throw fieldFailure('Photo storage is not connected. Your photo has not been uploaded; contact operations.', 503, 'FIELD_PHOTO_STORAGE_UNAVAILABLE');
  const token = await driveAccessToken(env, now, tokens), headers = { Authorization: `Bearer ${token}` };
  const call = async (url, init = {}) => {
    const response = await fetch(url, { ...init, headers: { ...headers, ...(init.headers || {}) }, redirect: 'error', signal: AbortSignal.timeout(45000) });
    // A revoked or expired token is dropped so the next request exchanges again.
    if (response.status === 401 && tokens.current?.token === token) tokens.current = null;
    return response;
  };
  return {
    async allocate() {
      const response = await call(`${FILES}/generateIds?count=1&space=drive&type=files`), result = await response.json().catch(() => ({}));
      const id = result.ids?.[0];
      if (!response.ok || !/^[A-Za-z0-9_-]{1,200}$/.test(id || '')) throw fieldFailure('Photo storage could not prepare the upload. Retry this photo.', 503, 'FIELD_PHOTO_UPLOAD_FAILED');
      return id;
    },
    async metadata(fileId) {
      const response = await call(`${FILES}/${encodeURIComponent(fileId)}?fields=id,size,mimeType,appProperties,trashed,thumbnailLink`);
      if (response.status === 404) return null;
      if (!response.ok) throw fieldFailure('Photo storage could not confirm the saved image. Retry to verify it.', 503, 'FIELD_PHOTO_VERIFY_FAILED');
      return response.json();
    },
    async upload(fileId, jobId, requestId, picture, category) {
      // The allocated Drive ID is persisted before sending bytes. Every retry
      // reuses it, so a lost response cannot create duplicate evidence files.
      const boundary = `egc-field-${crypto.randomUUID()}`, encoder = new TextEncoder();
      const metadata = { id: fileId, name: `EGC-${jobId}-${category}-${requestId}.${picture.extension}`, mimeType: picture.mime, appProperties: { egcJobId: jobId, egcFieldRequestId: requestId } };
      const head = encoder.encode(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: ${picture.mime}\r\n\r\n`), tail = encoder.encode(`\r\n--${boundary}--\r\n`);
      const bytes = new Uint8Array(head.length + picture.bytes.length + tail.length); bytes.set(head); bytes.set(picture.bytes, head.length); bytes.set(tail, head.length + picture.bytes.length);
      const response = await call('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id', { method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body: bytes });
      if (!response.ok && response.status !== 409) throw fieldFailure('The photo upload did not finish. Retry this photo to verify or complete it.', 503, 'FIELD_PHOTO_UPLOAD_FAILED');
    },
    async image(fileId) {
      const response = await call(`${FILES}/${encodeURIComponent(fileId)}?alt=media`);
      if (!response.ok || !/^image\/(jpeg|png|webp)(;|$)/i.test(response.headers.get('Content-Type') || '') || Number(response.headers.get('Content-Length')) > FIELD_PHOTO_MAX_BYTES) throw fieldFailure('This saved photo is temporarily unavailable. Retry shortly.', 503, 'FIELD_PHOTO_READ_FAILED');
      // Drive's files remain private. Access is checked against the live job
      // assignment on every image request; no public sharing link is issued.
      return new Response(response.body, { headers: { 'Content-Type': response.headers.get('Content-Type'), 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'", 'Content-Disposition': 'inline' } });
    },
    // A small rendition of a private file from the thumbnailLink its metadata returned. Drive
    // requires the same credentials for a non-public file's thumbnail. It is fetched directly, not
    // through call(): a 401 from the thumbnail host must not drop the token every other tile uses.
    // The capped bytes are read in full inside the timeout, so the cap holds without a
    // Content-Length and a slow viewer is never sent a cut-off image. Any problem returns null so
    // the caller serves the full image instead; this never throws.
    async thumbnail(link, size = 640) {
      const url = driveThumbnailUrl(link, size);
      if (!url) return null;
      try {
        const response = await fetch(url, { headers, redirect: 'error', signal: AbortSignal.timeout(10000) }), type = response.headers.get('Content-Type') || '';
        if (!response.ok || !/^image\/(jpeg|png|webp)(;|$)/i.test(type) || Number(response.headers.get('Content-Length')) > FIELD_PHOTO_THUMBNAIL_MAX_BYTES) { await response.body?.cancel().catch(() => {}); return null; }
        const bytes = await readCapped(response.body, FIELD_PHOTO_THUMBNAIL_MAX_BYTES);
        return bytes?.length ? new Response(bytes, { headers: { 'Content-Type': type, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'", 'Content-Disposition': 'inline' } }) : null;
      } catch { return null; }
    },
  };
}

export function verifyFieldPhotoMetadata(metadata, { jobId, requestId, picture }) {
  if (!metadata || metadata.trashed || metadata.appProperties?.egcJobId !== jobId || metadata.appProperties?.egcFieldRequestId !== requestId || Number(metadata.size) !== picture.bytes.length || metadata.mimeType !== picture.mime) throw fieldFailure('Photo storage has not verified the complete image. Retry this photo; it is not counted as uploaded yet.', 503, 'FIELD_PHOTO_VERIFY_FAILED');
}
