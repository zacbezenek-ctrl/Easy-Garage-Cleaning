import { fieldFailure } from './field-execution.js';

const FILES = 'https://www.googleapis.com/drive/v3/files';
export const FIELD_PHOTO_MAX_BYTES = 6 * 1024 * 1024;
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

export async function createFieldPhotoClient(env) {
  if (!fieldPhotosConfigured(env)) throw fieldFailure('Photo storage is not connected. Your photo has not been uploaded; contact operations.', 503, 'FIELD_PHOTO_STORAGE_UNAVAILABLE');
  const tokenResponse = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: env.GOOGLE_REFRESH_TOKEN, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET }), signal: AbortSignal.timeout(15000) });
  const tokenData = await tokenResponse.json().catch(() => ({}));
  if (!tokenResponse.ok || !tokenData.access_token) throw fieldFailure('Photo storage could not connect. Your photo is still available to retry.', 503, 'FIELD_PHOTO_STORAGE_UNAVAILABLE');
  const headers = { Authorization: `Bearer ${tokenData.access_token}` };
  const call = (url, init = {}) => fetch(url, { ...init, headers: { ...headers, ...(init.headers || {}) }, redirect: 'error', signal: AbortSignal.timeout(45000) });
  return {
    async allocate() {
      const response = await call(`${FILES}/generateIds?count=1&space=drive&type=files`), result = await response.json().catch(() => ({}));
      const id = result.ids?.[0];
      if (!response.ok || !/^[A-Za-z0-9_-]{1,200}$/.test(id || '')) throw fieldFailure('Photo storage could not prepare the upload. Retry this photo.', 503, 'FIELD_PHOTO_UPLOAD_FAILED');
      return id;
    },
    async metadata(fileId) {
      const response = await call(`${FILES}/${encodeURIComponent(fileId)}?fields=id,size,mimeType,appProperties,trashed`);
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
  };
}

export function verifyFieldPhotoMetadata(metadata, { jobId, requestId, picture }) {
  if (!metadata || metadata.trashed || metadata.appProperties?.egcJobId !== jobId || metadata.appProperties?.egcFieldRequestId !== requestId || Number(metadata.size) !== picture.bytes.length || metadata.mimeType !== picture.mime) throw fieldFailure('Photo storage has not verified the complete image. Retry this photo; it is not counted as uploaded yet.', 503, 'FIELD_PHOTO_VERIFY_FAILED');
}
