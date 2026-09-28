import { dispatchStorage } from './dispatch-storage.js';
import { addDays, denverToday, validDate } from './dispatch-time.js';
import { firestoreFetch } from './firebase-service-account.js';
import { hasBusinessAccess } from './hub-session.js';

/**
 * Portal documents (P4-09). The certificate of insurance lives in Google Drive
 * (private, app-created) and its pointer in the server-only settings record
 * portal_settings/documents:
 *   insuranceCertificate {driveFileId, expiresOn, uploadedAt, uploadedBy,
 *     filename, size, sha256, requestId, fingerprint}
 *   insuranceCertificateHistory [previous records, newest last, max 10]
 *   pendingInsuranceUpload {requestId, fingerprint, fileId, actorId, startedAt}
 *     (cleared by the final save, a newer upload claim or a withdrawal, so a
 *     stale retry falls back to the revision check)
 *   lastWithdrawal {requestId, fingerprint, at, by}
 * Customers only ever receive the file through an authorized proxy; the Drive
 * id never leaves the server. Missing, expired or malformed records read as
 * unavailable for customers and as an owner-facing flag in the Hub.
 */
export const PORTAL_SETTINGS_COLLECTION = 'portal_settings';
export const PORTAL_DOCUMENTS_ID = 'documents';
export const INSURANCE_MAX_BYTES = 5 * 1024 * 1024;
export const INSURANCE_EXPIRING_DAYS = 30;
const MAX_VALID_DAYS = 3 * 366;
const HISTORY = 10;
const FILES = 'https://www.googleapis.com/drive/v3/files';
const FOLDER_NAME = 'EGC Portal Documents';
const DRIVE_ID = /^[A-Za-z0-9_-]{10,200}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = (code, message, status = 400) => Object.assign(new Error(message), { code: 'PORTAL_DOCUMENTS_' + code, status });
const canonical = value => Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']' : plain(value) ? '{' + Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => JSON.stringify(key) + ':' + canonical(item)).join(',') + '}' : JSON.stringify(value);
const hex = bytes => [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
const sha256 = async bytes => hex(await crypto.subtle.digest('SHA-256', bytes));
const fingerprint = async value => sha256(new TextEncoder().encode(canonical(value)));
const text = (value, max) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : '';

export function requirePortalDocumentsManager(session) {
  if (!session) throw fail('SIGN_IN_REQUIRED', 'Sign in to the EGC Hub.', 401);
  if (!hasBusinessAccess(session) || !['owner', 'manager'].includes(session.role)) throw fail('FORBIDDEN', 'Only an owner or manager can manage customer portal documents.', 403);
}

/** Decodes a PDF data URL: %PDF- magic, an %%EOF trailer and the size cap. */
export function decodeInsurancePdf(dataUrl) {
  const match = /^data:application\/pdf;base64,([A-Za-z0-9+/]+={0,2})$/.exec(typeof dataUrl === 'string' ? dataUrl : '');
  if (!match) throw fail('PDF_REQUIRED', 'Choose the certificate as a PDF file.', 415);
  if (match[1].length > Math.ceil(INSURANCE_MAX_BYTES / 3) * 4) throw fail('PDF_TOO_LARGE', 'The certificate PDF must be 5 MB or smaller.', 413);
  let binary;
  try { binary = atob(match[1]); } catch { throw fail('PDF_INVALID', 'This PDF could not be read. Choose the file again.'); }
  if (binary.length > INSURANCE_MAX_BYTES) throw fail('PDF_TOO_LARGE', 'The certificate PDF must be 5 MB or smaller.', 413);
  if (binary.length < 64 || !binary.startsWith('%PDF-') || !binary.slice(-2048).includes('%%EOF')) throw fail('PDF_INVALID', 'This file is not a complete PDF. Export the certificate as a PDF and choose it again.', 415);
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}

function record(settings) {
  const value = plain(settings) && plain(settings.insuranceCertificate) ? settings.insuranceCertificate : null;
  return value && (value.driveFileId || value.expiresOn) ? value : null;
}

/**
 * Customer availability and the owner-facing flag. A certificate counts as
 * lapsed ON its expiration date (policies commonly end at 12:01 AM that day),
 * judged on the Denver calendar of the injected instant.
 */
export function insuranceCertificateStatus(settings, now) {
  const at = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(at.getTime())) throw fail('TIME_REQUIRED', 'A valid time is required.', 500);
  const saved = record(settings), today = denverToday(at);
  const base = { state: 'missing', available: false, flag: 'insurance_certificate_missing', expiresOn: '', daysRemaining: null, uploadedAt: '', uploadedBy: '', filename: '', size: 0 };
  if (!saved) return base;
  const view = { ...base, expiresOn: validDate(saved.expiresOn) ? saved.expiresOn : '', uploadedAt: text(saved.uploadedAt, 40), uploadedBy: text(saved.uploadedBy, 80), filename: text(saved.filename, 120), size: Number.isSafeInteger(saved.size) && saved.size > 0 ? saved.size : 0 };
  if (!DRIVE_ID.test(String(saved.driveFileId || '')) || !view.expiresOn) return { ...view, state: 'invalid', flag: 'insurance_certificate_invalid' };
  const days = Math.round((Date.parse(view.expiresOn + 'T12:00:00Z') - Date.parse(today + 'T12:00:00Z')) / 86400000);
  if (days <= 0) return { ...view, state: 'expired', flag: 'insurance_certificate_expired', daysRemaining: 0 };
  if (days <= INSURANCE_EXPIRING_DAYS) return { ...view, state: 'expiring_soon', available: true, flag: 'insurance_certificate_expiring', daysRemaining: days };
  return { ...view, state: 'current', available: true, flag: '', daysRemaining: days };
}

/** The Drive id behind an available certificate, or '' when customers must not get one. */
export function availableInsuranceFileId(settings, now) {
  return insuranceCertificateStatus(settings, now).available ? record(settings).driveFileId : '';
}

/** portal_settings/documents over the shared revisioned Firestore store. */
export function portalDocumentsStorage(env, fetcher = firestoreFetch) {
  const store = dispatchStorage(env, fetcher);
  const translate = problem => {
    if (problem?.code === 'dispatch_revision_conflict') return fail('REVISION_CONFLICT', 'Portal documents changed. Refresh and review the latest certificate before trying again.', 409);
    if (problem?.code === 'dispatch_outcome_unknown') return fail('OUTCOME_UNKNOWN', 'The save could not be verified. Retry the same upload to safely check it.', 503);
    return fail('STORAGE_UNAVAILABLE', 'Portal documents could not be loaded. Retry shortly.', 503);
  };
  return {
    async read() { try { return await store.read(PORTAL_SETTINGS_COLLECTION, PORTAL_DOCUMENTS_ID); } catch (problem) { throw translate(problem); } },
    async commit(patch, revision) { try { return await store.commit([{ collection: PORTAL_SETTINGS_COLLECTION, id: PORTAL_DOCUMENTS_ID, ...(revision ? { revision } : {}), patch }]); } catch (problem) { throw translate(problem); } },
  };
}

export const portalDocumentsDriveConfigured = env => Boolean(env?.GOOGLE_CLIENT_ID && env?.GOOGLE_CLIENT_SECRET && env?.GOOGLE_REFRESH_TOKEN);

/**
 * Drive access for portal documents (drive.file scope, like agreement-upload).
 * The access token is cached per factory instance; tests build their own.
 */
export function createPortalDocumentDrive({ fetcher = (...args) => fetch(...args), now = () => Date.now() } = {}) {
  let cached = { key: '', token: '', expires: 0 };
  return env => {
    if (!portalDocumentsDriveConfigured(env)) throw fail('DRIVE_UNCONFIGURED', 'Google Drive is not connected. Run the Drive setup in the Hub first.', 503);
    const unavailable = () => fail('DRIVE_UNAVAILABLE', 'Google Drive could not be reached. Retry shortly.', 503);
    async function token() {
      const key = `${env.GOOGLE_CLIENT_ID}:${env.GOOGLE_REFRESH_TOKEN}`;
      if (cached.key === key && cached.token && now() < cached.expires - 60000) return cached.token;
      let response, data;
      try {
        response = await fetcher('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: env.GOOGLE_REFRESH_TOKEN, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET }), signal: AbortSignal.timeout(15000) });
        data = await response.json().catch(() => ({}));
      } catch { throw unavailable(); }
      if (!response.ok || typeof data.access_token !== 'string' || !data.access_token) throw unavailable();
      cached = { key, token: data.access_token, expires: now() + Math.max(60, Number(data.expires_in) || 3600) * 1000 };
      return cached.token;
    }
    async function call(url, init = {}, timeout = 30000) {
      const access = await token();
      try { return await fetcher(url, { ...init, headers: { Authorization: `Bearer ${access}`, ...(init.headers || {}) }, redirect: 'error', signal: AbortSignal.timeout(timeout) }); }
      catch { throw unavailable(); }
    }
    async function json(url, init) {
      const response = await call(url, init);
      if (!response.ok) throw unavailable();
      return response.json().catch(() => { throw unavailable(); });
    }
    async function folder() {
      const query = ["mimeType='application/vnd.google-apps.folder'", 'trashed=false', "appProperties has { key='egcPortalDocuments' and value='1' }"].join(' and ');
      const found = await json(`${FILES}?q=${encodeURIComponent(query)}&fields=files(id)&pageSize=1`);
      if (DRIVE_ID.test(found.files?.[0]?.id || '')) return found.files[0].id;
      const created = await json(`${FILES}?fields=id`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder', appProperties: { egcPortalDocuments: '1' } }) });
      if (!DRIVE_ID.test(created.id || '')) throw unavailable();
      return created.id;
    }
    return {
      async allocate() {
        const result = await json(`${FILES}/generateIds?count=1&space=drive&type=files`);
        if (!DRIVE_ID.test(result.ids?.[0] || '')) throw unavailable();
        return result.ids[0];
      },
      async metadata(fileId) {
        const response = await call(`${FILES}/${encodeURIComponent(fileId)}?fields=id,size,mimeType,appProperties,trashed`);
        if (response.status === 404) return null;
        if (!response.ok) throw unavailable();
        return response.json().catch(() => { throw unavailable(); });
      },
      // The allocated id is saved before any bytes are sent; a retry reuses it,
      // so a lost response can never create a second certificate file.
      async upload(fileId, { requestId, expiresOn, filename }, bytes) {
        const boundary = `egc-portal-${crypto.randomUUID()}`, encoder = new TextEncoder();
        const metadata = { id: fileId, name: filename, mimeType: 'application/pdf', parents: [await folder()], appProperties: { egcPortalDocument: 'insurance_certificate', egcRequestId: requestId, egcExpiresOn: expiresOn } };
        const head = encoder.encode(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: application/pdf\r\n\r\n`), tail = encoder.encode(`\r\n--${boundary}--\r\n`);
        const body = new Uint8Array(head.length + bytes.length + tail.length); body.set(head); body.set(bytes, head.length); body.set(tail, head.length + bytes.length);
        const response = await call('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id', { method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body }, 60000);
        if (!response.ok && response.status !== 409) throw fail('UPLOAD_UNVERIFIED', 'The certificate upload did not finish. Retry the same upload to verify or complete it.', 503);
      },
      async download(fileId) {
        const response = await call(`${FILES}/${encodeURIComponent(fileId)}?alt=media`, {}, 45000);
        if (response.status === 404) return null;
        const length = response.headers.get('Content-Length');
        if (!response.ok || !/^application\/pdf(;|$)/i.test(response.headers.get('Content-Type') || '') || length !== null && !(Number(length) > 0 && Number(length) <= INSURANCE_MAX_BYTES)) { await response.body?.cancel().catch(() => {}); throw unavailable(); }
        return { body: response.body, length: length === null ? null : Number(length) };
      },
    };
  };
}

export const portalDocumentDrive = createPortalDocumentDrive();

const verified = (metadata, requestId, bytes) => Boolean(metadata && metadata.trashed !== true && metadata.mimeType === 'application/pdf' && Number(metadata.size) === bytes.length &&
  metadata.appProperties?.egcPortalDocument === 'insurance_certificate' && metadata.appProperties?.egcRequestId === requestId);

function publicStatus(settings, now) {
  const { flag, ...status } = insuranceCertificateStatus(settings, now);
  const history = Array.isArray(settings?.insuranceCertificateHistory) ? settings.insuranceCertificateHistory.filter(plain).slice(-5).reverse().map(item => ({ expiresOn: validDate(item.expiresOn) ? item.expiresOn : '', uploadedAt: text(item.uploadedAt, 40), uploadedBy: text(item.uploadedBy, 80), replacedAt: text(item.replacedAt, 40), withdrawnAt: text(item.withdrawnAt, 40), withdrawnBy: text(item.withdrawnBy, 80) })) : [];
  const pending = plain(settings?.pendingInsuranceUpload) ? { startedAt: text(settings.pendingInsuranceUpload.startedAt, 40), by: text(settings.pendingInsuranceUpload.actorId, 80) } : null;
  return { insurance: status, flag, history, pendingUpload: pending, revision: settings?.revision || '' };
}

/**
 * Hub owner/manager view: status, flag, any unfinished upload and short
 * history. Never the Drive id. Customers are refused while Drive is not
 * connected, so a certificate that would otherwise be offered reads as
 * 'unavailable' with its own flag instead of a green "current".
 */
export async function portalDocumentsStatus(store, session, env, now) {
  requirePortalDocumentsManager(session);
  const view = publicStatus(await store.read(), now), driveConfigured = portalDocumentsDriveConfigured(env);
  if (!driveConfigured && view.insurance.available) Object.assign(view, { insurance: { ...view.insurance, state: 'unavailable', available: false }, flag: 'insurance_certificate_drive_unconfigured' });
  return { ok: true, authority: 'employee_hub', ...view, driveConfigured, maxBytes: INSURANCE_MAX_BYTES };
}

function uploadInput(input, today) {
  if (!plain(input) || Object.keys(input).some(key => !['action', 'requestId', 'expectedRevision', 'expiresOn', 'filename', 'dataUrl'].includes(key))) throw fail('INVALID_REQUEST', 'The upload request has unexpected fields.');
  if (typeof input.requestId !== 'string' || !UUID.test(input.requestId)) throw fail('INVALID_REQUEST', 'A valid upload request ID is required.');
  if (typeof input.expectedRevision !== 'string' || input.expectedRevision.length > 80) throw fail('INVALID_REQUEST', 'Refresh the portal documents before uploading.');
  if (!validDate(input.expiresOn) || input.expiresOn <= today || input.expiresOn > addDays(today, MAX_VALID_DAYS)) throw fail('EXPIRATION_INVALID', 'Enter the policy expiration date printed on the certificate. It must be in the future.');
  const filename = (text(input.filename, 120).replace(/[\\/:*?"<>|]/g, '-').replace(/\.pdf$/i, '') || 'Certificate of insurance') + '.pdf';
  return { requestId: input.requestId.toLowerCase(), expectedRevision: input.expectedRevision, expiresOn: input.expiresOn, filename, bytes: decodeInsurancePdf(input.dataUrl) };
}

/**
 * Saves a new certificate: pending claim (with the allocated Drive id) ->
 * Drive upload -> metadata verification -> final record, each step
 * compare-and-set on the settings revision. The same requestId replays or
 * resumes; a different body under it is a 409.
 */
export async function uploadInsuranceCertificate({ store, drive }, session, input, now = new Date().toISOString()) {
  requirePortalDocumentsManager(session);
  const at = new Date(now), request = uploadInput(input, denverToday(at));
  const pdf = await sha256(request.bytes), actorId = String(session.user).trim().toLowerCase();
  const print = await fingerprint({ actor: actorId, input: { action: 'upload', expiresOn: request.expiresOn, filename: request.filename, sha256: pdf } });
  const done = settings => ({ ok: true, authority: 'employee_hub', requestId: request.requestId, ...publicStatus(settings, at) });
  let current = await store.read();
  const saved = record(current);
  if (saved?.requestId === request.requestId) {
    if (saved.fingerprint !== print) throw fail('IDEMPOTENCY_CONFLICT', 'This upload ID was already used for a different certificate. Start a new upload.', 409);
    return { ...done(current), replayed: true };
  }
  let pending = plain(current?.pendingInsuranceUpload) && current.pendingInsuranceUpload.requestId === request.requestId ? current.pendingInsuranceUpload : null;
  if (pending && pending.fingerprint !== print) throw fail('IDEMPOTENCY_CONFLICT', 'This upload ID was already used for a different certificate. Start a new upload.', 409);
  if (!pending) {
    if ((current?.revision || '') !== request.expectedRevision) throw fail('REVISION_CONFLICT', 'Portal documents changed. Refresh and review the latest certificate before uploading.', 409);
    pending = { requestId: request.requestId, fingerprint: print, fileId: await drive.allocate(), actorId, startedAt: now };
    await store.commit({ pendingInsuranceUpload: pending, updatedAt: now }, current?.revision);
    current = await store.read();
    if (current?.pendingInsuranceUpload?.requestId !== request.requestId) throw fail('REVISION_CONFLICT', 'Another certificate upload started. Refresh before trying again.', 409);
  }
  const meta = { requestId: request.requestId, expiresOn: request.expiresOn, filename: request.filename };
  if (!verified(await drive.metadata(pending.fileId), request.requestId, request.bytes)) {
    await drive.upload(pending.fileId, meta, request.bytes);
    if (!verified(await drive.metadata(pending.fileId), request.requestId, request.bytes)) throw fail('UPLOAD_UNVERIFIED', 'Google Drive has not confirmed the complete certificate. Retry the same upload.', 503);
  }
  const previous = record(current), history = Array.isArray(current.insuranceCertificateHistory) ? current.insuranceCertificateHistory.filter(plain) : [];
  const certificate = { driveFileId: pending.fileId, expiresOn: request.expiresOn, uploadedAt: now, uploadedBy: actorId, filename: request.filename, size: request.bytes.length, sha256: pdf, requestId: request.requestId, fingerprint: print };
  try {
    await store.commit({ insuranceCertificate: certificate, insuranceCertificateHistory: (previous ? [...history, { ...previous, replacedAt: now }] : history).slice(-HISTORY), pendingInsuranceUpload: null, updatedAt: now, updatedBy: actorId }, current.revision);
  } catch (problem) {
    // A lost or raced commit may still have saved this exact upload.
    const latest = await store.read().catch(() => null);
    if (record(latest)?.requestId === request.requestId && record(latest).fingerprint === print) return done(latest);
    throw problem;
  }
  return done(await store.read());
}

/**
 * Stops offering the certificate (e.g. a cancelled policy). The file stays in
 * Drive for audit. It also drops any unfinished upload claim: a retry of an
 * upload started before the withdrawal must pass the revision check again
 * instead of resuming and re-offering a certificate the owner withdrew.
 */
export async function withdrawInsuranceCertificate(store, session, input, now = new Date().toISOString()) {
  requirePortalDocumentsManager(session);
  if (!plain(input) || Object.keys(input).some(key => !['action', 'requestId', 'expectedRevision'].includes(key)) || typeof input.requestId !== 'string' || !UUID.test(input.requestId) || typeof input.expectedRevision !== 'string') throw fail('INVALID_REQUEST', 'A valid withdrawal request is required.');
  const at = new Date(now), requestId = input.requestId.toLowerCase(), actorId = String(session.user).trim().toLowerCase();
  const print = await fingerprint({ actor: actorId, input: { action: 'withdraw' } });
  const current = await store.read();
  if (current?.lastWithdrawal?.requestId === requestId) {
    if (current.lastWithdrawal.fingerprint !== print) throw fail('IDEMPOTENCY_CONFLICT', 'This request ID was already used by someone else. Refresh and try again.', 409);
    return { ok: true, authority: 'employee_hub', requestId, replayed: true, ...publicStatus(current, at) };
  }
  if ((current?.revision || '') !== input.expectedRevision) throw fail('REVISION_CONFLICT', 'Portal documents changed. Refresh and review the latest certificate first.', 409);
  const saved = record(current);
  if (!saved) throw fail('NOTHING_TO_WITHDRAW', 'There is no certificate to withdraw.', 409);
  const history = Array.isArray(current.insuranceCertificateHistory) ? current.insuranceCertificateHistory.filter(plain) : [];
  try {
    await store.commit({ insuranceCertificate: null, insuranceCertificateHistory: [...history, { ...saved, withdrawnAt: now, withdrawnBy: actorId }].slice(-HISTORY), lastWithdrawal: { requestId, fingerprint: print, at: now, by: actorId }, pendingInsuranceUpload: null, updatedAt: now, updatedBy: actorId }, current.revision);
  } catch (problem) {
    const latest = await store.read().catch(() => null);
    if (latest?.lastWithdrawal?.requestId === requestId && latest.lastWithdrawal.fingerprint === print) return { ok: true, authority: 'employee_hub', requestId, ...publicStatus(latest, at) };
    throw problem;
  }
  return { ok: true, authority: 'employee_hub', requestId, ...publicStatus(await store.read(), at) };
}
