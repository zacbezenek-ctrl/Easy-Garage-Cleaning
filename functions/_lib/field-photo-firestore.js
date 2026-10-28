import { fieldFailure } from './field-execution.js';
import { firebaseServiceAccountConfigured, firestoreFetch } from './firebase-service-account.js';
import { decodeFirestoreFields, encodeFirestoreFields } from './firestore-job.js';

// Field photos (job and storage-bin photos, receipts, crew headshots) kept in the site's own Firestore
// database, for when Google Drive is not connected (owner decision 2026-10-28). The client has the same
// shape as the Drive one in field-execution-photos.js, so every caller keeps its allocate → upload →
// metadata → verify flow and its access checks unchanged.
//
// fieldPhotoFiles/{fileId} holds the metadata the callers verify (size, type, job and request ids);
// fieldPhotoFiles/{fileId}/chunks/{n} hold the image as base64 text. One commit writes the chunks and the
// metadata together, so a metadata document always has every chunk. Both are server-only: firestore.rules
// ends with a deny-all, and only the service account (or the emulator in tests) reads them.
const ROOT = 'projects/egcw-1ec83/databases/(default)/documents';
const BASE = `https://firestore.googleapis.com/v1/${ROOT}`;
const COLLECTION = 'fieldPhotoFiles';
const MIME = /^image\/(jpeg|png|webp)$/;
// Ids carry this prefix so a store that also has Drive connected can tell the two apart. They still match
// the /^[A-Za-z0-9_-]{1,200}$/ file id check of fieldPhotos(); Drive ids never start with it in practice.
export const FIRESTORE_PHOTO_PREFIX = 'egcfs_';
// Raw bytes per chunk: 800,000 base64 characters, well under Firestore's 1 MiB value limit. A 6 MB photo
// (FIELD_PHOTO_MAX_BYTES) is ten chunks; a crew photo resized to 1,800 px on the phone is usually one or two.
export const FIRESTORE_PHOTO_CHUNK_BYTES = 600000;

export const firestorePhotoFileId = value => typeof value === 'string' && new RegExp(`^${FIRESTORE_PHOTO_PREFIX}[0-9a-f]{32}$`).test(value);
export const firestorePhotosEnabled = (env = {}) => env?.EGC_FIELD_PHOTOS_FIRESTORE === 'true' && firebaseServiceAccountConfigured(env);

function toBase64(bytes) {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary);
}

export function createFirestorePhotoClient(env, { fetcher = firestoreFetch, now = () => new Date() } = {}) {
  const send = async (url, init = {}) => {
    try { return await fetcher(env, url, { ...init, signal: AbortSignal.timeout(45000) }); }
    catch { return null; }
  };
  // The decoded fields of one document, or null when it does not exist; any other answer throws `failure`.
  const read = async (path, failure) => {
    const response = await send(`${BASE}/${path}`);
    if (response?.status === 404) return null;
    const document = response?.ok ? await response.json().catch(() => null) : null;
    if (!document || typeof document !== 'object' || Array.isArray(document)) throw failure();
    return decodeFirestoreFields(document.fields || {});
  };
  const unverified = () => fieldFailure('Photo storage could not confirm the saved image. Retry to verify it.', 503, 'FIELD_PHOTO_VERIFY_FAILED');
  const unreadable = () => fieldFailure('This saved photo is temporarily unavailable. Retry shortly.', 503, 'FIELD_PHOTO_READ_FAILED');
  // Drive-shaped metadata: size as a string, appProperties carrying the job and request ids.
  const metadata = async fileId => {
    if (!firestorePhotoFileId(fileId)) return null;
    const file = await read(`${COLLECTION}/${fileId}`, unverified);
    if (!file) return null;
    return { id: fileId, size: String(file.size), mimeType: file.mimeType, chunks: file.chunks, trashed: false, appProperties: { egcJobId: file.egcJobId, egcFieldRequestId: file.egcFieldRequestId } };
  };
  return {
    async allocate() {
      return `${FIRESTORE_PHOTO_PREFIX}${crypto.randomUUID().replace(/-/g, '')}`;
    },
    metadata,
    async upload(fileId, jobId, requestId, picture, category) {
      if (!firestorePhotoFileId(fileId)) throw fieldFailure('Photo storage could not prepare the upload. Retry this photo.', 503, 'FIELD_PHOTO_UPLOAD_FAILED');
      const writes = [];
      for (let start = 0, index = 0; start < picture.bytes.length; start += FIRESTORE_PHOTO_CHUNK_BYTES, index++) {
        writes.push({ update: { name: `${ROOT}/${COLLECTION}/${fileId}/chunks/${index}`, fields: { data: { stringValue: toBase64(picture.bytes.subarray(start, start + FIRESTORE_PHOTO_CHUNK_BYTES)) } } } });
      }
      // A retry with the same id rewrites the same bytes, so a lost response never leaves a second copy.
      writes.push({ update: { name: `${ROOT}/${COLLECTION}/${fileId}`, fields: encodeFirestoreFields({
        name: `EGC-${jobId}-${category}-${requestId}.${picture.extension}`, mimeType: picture.mime, size: picture.bytes.length, chunks: writes.length,
        egcJobId: jobId, egcFieldRequestId: requestId, category, createdAt: now().toISOString(),
      }) } });
      const response = await send(`${BASE}:commit`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ writes }) });
      if (!response?.ok) throw fieldFailure('The photo upload did not finish. Retry this photo to verify or complete it.', 503, 'FIELD_PHOTO_UPLOAD_FAILED');
    },
    async image(fileId) {
      const file = await metadata(fileId).catch(() => null), size = Number(file?.size), count = Number(file?.chunks);
      if (!file || !MIME.test(file.mimeType || '') || !Number.isInteger(size) || size < 1 || !Number.isInteger(count) || count < 1 || count !== Math.ceil(size / FIRESTORE_PHOTO_CHUNK_BYTES)) throw unreadable();
      const parts = await Promise.all(Array.from({ length: count }, (_, index) => read(`${COLLECTION}/${fileId}/chunks/${index}`, unreadable)));
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const part of parts) {
        let chunk;
        try { chunk = Uint8Array.from(atob(part?.data || ''), character => character.charCodeAt(0)); } catch { throw unreadable(); }
        if (!chunk.length || offset + chunk.length > size) throw unreadable();
        bytes.set(chunk, offset); offset += chunk.length;
      }
      if (offset !== size) throw unreadable();
      // The same private response the Drive client gives: access was checked by the caller on this request.
      return new Response(bytes, { headers: { 'Content-Type': file.mimeType, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'", 'Content-Disposition': 'inline' } });
    },
    // No small renditions are stored; metadata has no thumbnailLink, so callers serve the full image.
    async thumbnail() { return null; },
  };
}
