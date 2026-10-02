import { firestoreFetch } from './firebase-service-account.js';
import { employeeVaultReadOnly, employeeVaultSecret } from './employee-vault-key.js';
import { encodeFirestoreFields } from './firestore-job.js';

// Sealed Employee Hub records. The key derivation strings, the AAD (document id)
// and the '<collection>:<id>' document-id HMAC input are storage contracts:
// changing any of them makes every saved employee record unreadable.
const PROJECT_ID = 'egcw-1ec83';
const DOCUMENTS = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;
export const EMPLOYEE_HUB_RECORD_TYPE = 'employee_hub_v2';
export const EMPLOYEE_HUB_COLLECTIONS = new Set(['profiles', 'timeEntries', 'announcements', 'requests', 'incidents', 'equipment', 'training', 'teamMessages', 'jobMessages', 'messageReads']);
const encoder = new TextEncoder();
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export function unreadableStorage() {
  const error = new Error('Employee records could not be read safely. Please contact the Hub administrator.');
  error.code = 'EMPLOYEE_HUB_STORAGE_UNREADABLE';
  return error;
}

function unsupportedCollection() {
  return new TypeError('Unsupported employee vault collection');
}

function base64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function fromBase64Url(value) {
  const padded = String(value).replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((String(value).length + 3) % 4);
  return Uint8Array.from(atob(padded), char => char.charCodeAt(0));
}

async function encryptionKey(env) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(`${employeeVaultSecret(env)}:employee-hub-v2:data`));
  return crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export async function opaqueId(env, collection, id) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(employeeVaultSecret(env)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return `secure_${base64Url(new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(`${collection}:${id}`))))}`;
}

export async function seal(env, documentId, payload) {
  // Every vault write seals first; never write under a recovery key or an empty key.
  if (employeeVaultReadOnly(env)) throw Object.assign(new Error('Employee setup is being verified. Existing records are preserved and cannot be changed yet.'), { code: 'EMPLOYEE_HUB_RECOVERY_READ_ONLY', status: 503 });
  if (!employeeVaultSecret(env)) throw Object.assign(new Error('Employee Hub storage is not configured'), { code: 'EMPLOYEE_HUB_NOT_CONFIGURED', status: 503 });
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: encoder.encode(documentId) },
    await encryptionKey(env),
    encoder.encode(JSON.stringify(payload)),
  );
  return { iv: base64Url(iv), payload: base64Url(new Uint8Array(encrypted)) };
}

export async function open(env, documentId, iv, payload) {
  const clear = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromBase64Url(iv), additionalData: encoder.encode(documentId) },
    await encryptionKey(env),
    fromBase64Url(payload),
  );
  return JSON.parse(new TextDecoder().decode(clear));
}

const stringField = value => ({ stringValue: String(value ?? '') });

export function firestoreDoc(collection, documentId, encrypted, updatedAt) {
  return { fields: {
    recordType: stringField(EMPLOYEE_HUB_RECORD_TYPE),
    employeeHubType: stringField(collection),
    sealedPayload: stringField(encrypted.payload),
    sealedIv: stringField(encrypted.iv),
    schemaVersion: { integerValue: '2' },
    updatedAt: stringField(updatedAt),
    vaultId: stringField(documentId),
  } };
}

function valueOf(field) {
  if (!field) return undefined;
  if ('stringValue' in field) return field.stringValue;
  if ('integerValue' in field) return Number(field.integerValue);
  return undefined;
}

export function parseFirestoreDocument(document) {
  const fields = document?.fields || {};
  const stored = {
    documentId: String(document?.name || '').split('/').pop(),
    collection: valueOf(fields.employeeHubType),
    updateTime: typeof document?.updateTime === 'string' ? document.updateTime : '',
    payload: valueOf(fields.sealedPayload),
    iv: valueOf(fields.sealedIv),
  };
  if (!stored.documentId || !(EMPLOYEE_HUB_COLLECTIONS.has(stored.collection) || stored.collection === 'timeLocks') ||
      valueOf(fields.recordType) !== EMPLOYEE_HUB_RECORD_TYPE ||
      valueOf(fields.vaultId) !== stored.documentId ||
      valueOf(fields.schemaVersion) !== 2 ||
      typeof stored.payload !== 'string' || !stored.payload ||
      typeof stored.iv !== 'string' || !stored.iv) throw unreadableStorage();
  return stored;
}

export async function openStored(env, stored) {
  try {
    const data = await open(env, stored.documentId, stored.iv, stored.payload);
    if (!isRecord(data) || typeof data.id !== 'string' || !data.id ||
        await opaqueId(env, stored.collection, data.id) !== stored.documentId) throw unreadableStorage();
    return data;
  } catch {
    throw unreadableStorage();
  }
}

export async function readOne(env, collection, id) {
  const documentId = await opaqueId(env, collection, id);
  const physicalCollection = collection === 'timeLocks' ? 'employee_time_locks' : 'jobs';
  const response = await firestoreFetch(env, `${DOCUMENTS}/${physicalCollection}/${encodeURIComponent(documentId)}`);
  if (response.status === 404) return { documentId, data: null };
  if (!response.ok) throw new Error(`Employee Hub storage read failed (${response.status})`);
  const stored = parseFirestoreDocument(await response.json().catch(() => { throw unreadableStorage(); }));
  if (stored.documentId !== documentId || stored.collection !== collection) throw unreadableStorage();
  return { documentId, updateTime: stored.updateTime, data: await openStored(env, stored) };
}

const equalTo = (fieldPath, value) => ({ fieldFilter: { field: { fieldPath }, op: 'EQUAL', value: stringField(value) } });

function runQuery(env, where, collectionId = 'jobs') {
  return firestoreFetch(env, `${DOCUMENTS}:runQuery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ structuredQuery: { from: [{ collectionId }], where } }),
  });
}

// A malformed or partial query response is never treated as an empty vault.
async function decodeRows(env, response, accepts, withRevision = false) {
  if (!response.ok) throw new Error(`Employee Hub storage query failed (${response.status})`);
  const rows = await response.json().catch(() => { throw unreadableStorage(); });
  if (!Array.isArray(rows)) throw unreadableStorage();
  const decoded = [];
  for (const row of rows) {
    if (!isRecord(row) || row.error) throw unreadableStorage();
    if (!row.document) {
      if (typeof row.readTime !== 'string') throw unreadableStorage();
      continue;
    }
    const stored = parseFirestoreDocument(row.document);
    if (!accepts(stored.collection)) throw unreadableStorage();
    decoded.push({ collection: stored.collection, data: await openStored(env, stored), ...(withRevision ? { documentId: stored.documentId, updateTime: stored.updateTime } : {}) });
  }
  return decoded;
}

export async function readAll(env, withRevision = false) {
  return decodeRows(env, await runQuery(env, equalTo('recordType', EMPLOYEE_HUB_RECORD_TYPE)), collection => EMPLOYEE_HUB_COLLECTIONS.has(collection), withRevision);
}

// Firestore rejects a query it cannot serve without a composite index with
// HTTP 400 FAILED_PRECONDITION, as {error} or as a one-row [{error}] stream.
// Only that exact answer is recognised; the body is read only for a 400.
async function indexRequired(response) {
  if (response.status !== 400) return false;
  let body = null;
  try { body = await response.json(); } catch { return false; }
  const error = Array.isArray(body) ? (body.length === 1 && isRecord(body[0]) ? body[0].error : null) : body?.error;
  return isRecord(error) && error.status === 'FAILED_PRECONDITION';
}

// EGC_EMPLOYEE_VAULT_QUERY=legacy makes every family read use the whole-vault
// query. Any other value (or none) uses the two-filter family query.
const legacyFamilyQuery = env => String(env?.EGC_EMPLOYEE_VAULT_QUERY ?? '').trim().toLowerCase() === 'legacy';

// Two single-field equality filters are served by index merging (no composite
// index). Only the requested family is decrypted; a row of any other family
// means the filter was not honored, so the read fails closed. If Firestore
// reports that the query needs an index, the read falls back to the whole-vault
// query; every other failed or malformed response still fails closed.
export async function readCollection(env, collection, { fallback } = {}) {
  if (!EMPLOYEE_HUB_COLLECTIONS.has(collection)) throw unsupportedCollection();
  return (await familyRows(env, collection, false, fallback)).map(row => row.data);
}

// The same fail-closed family read, keeping each record's vault document id and
// Firestore updateTime for compare-and-set writes (staff directory, migrations).
// Time locks live in their own physical collection and are read with the same filters.
export async function readCollectionRecords(env, collection) {
  const rows = await familyRows(env, collection, true);
  if (rows.some(row => !row.updateTime)) throw unreadableStorage();
  return rows.map(({ documentId, updateTime, data }) => ({ documentId, updateTime, data }));
}

async function familyRows(env, collection, withRevision = false, fallback = () => readAll(env, withRevision)) {
  const where = { compositeFilter: { op: 'AND', filters: [equalTo('recordType', EMPLOYEE_HUB_RECORD_TYPE), equalTo('employeeHubType', collection)] } };
  if (collection === 'timeLocks') return decodeRows(env, await runQuery(env, where, 'employee_time_locks'), type => type === collection, withRevision);
  if (!EMPLOYEE_HUB_COLLECTIONS.has(collection)) throw unsupportedCollection();
  if (legacyFamilyQuery(env)) return (await fallback()).filter(row => row.collection === collection);
  const response = await runQuery(env, where);
  if (await indexRequired(response)) {
    console.warn(`Employee vault: the ${collection} family query needs a Firestore index (FAILED_PRECONDITION); using the whole-vault read.`);
    return (await fallback()).filter(row => row.collection === collection);
  }
  return decodeRows(env, response, type => type === collection, withRevision);
}

export async function writeOne(env, collection, id, data, expected = null, updatedAt = new Date().toISOString()) {
  if (!EMPLOYEE_HUB_COLLECTIONS.has(collection)) throw unsupportedCollection();
  const documentId = await opaqueId(env, collection, id);
  const encrypted = await seal(env, documentId, { ...data, id, updatedAt: data.updatedAt || updatedAt });
  const guardedUrl = new URL(`${DOCUMENTS}/jobs/${encodeURIComponent(documentId)}`);
  if (expected) {
    if (!expected.data) guardedUrl.searchParams.set('currentDocument.exists', 'false');
    else if (expected.updateTime) guardedUrl.searchParams.set('currentDocument.updateTime', expected.updateTime);
    else throw unreadableStorage();
  }
  const response = await firestoreFetch(env, guardedUrl, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(firestoreDoc(collection, documentId, encrypted, updatedAt)),
  });
  if (!response.ok) {
    const failure = await response.json().catch(() => ({}));
    if (expected && ([409, 412].includes(response.status) ||
        ['FAILED_PRECONDITION', 'ABORTED', 'ALREADY_EXISTS', 'NOT_FOUND'].includes(failure.error?.status))) {
      const conflict = new Error('Employee record changed while saving. Refresh and retry.');
      conflict.code = 'EMPLOYEE_HUB_WRITE_CONFLICT';
      throw conflict;
    }
    throw new Error(`Employee Hub storage write failed (${response.status})`);
  }
  return { ...data, id, updatedAt: data.updatedAt || updatedAt };
}

export function expectedDocument(target) {
  if (!target.data) return { exists: false };
  if (!target.updateTime) throw unreadableStorage();
  return { updateTime: target.updateTime };
}

// Plain field values of a sealed vault document (the firestoreDoc shape), for
// multi-document commits that write a vault record with other documents.
export async function sealedFields(env, collection, documentId, data, updatedAt) {
  if (!EMPLOYEE_HUB_COLLECTIONS.has(collection) && collection !== 'timeLocks') throw unsupportedCollection();
  const { fields } = firestoreDoc(collection, documentId, await seal(env, documentId, data), updatedAt);
  return Object.fromEntries(Object.entries(fields).map(([name, field]) => [name, valueOf(field)]));
}

// One atomic commit of several documents ({collection, id, revision?, patch} with
// plain values, the dispatchStorage/auditWrite shape). Each write carries its own
// precondition: currentDocument.updateTime, or exists:false without a revision.
// Firestore answers a stale updateTime with 400 FAILED_PRECONDITION and an existing
// create with 409 ALREADY_EXISTS; both are conflicts and nothing was written. A lost
// or unrecognized reply is an unknown outcome: callers re-read their receipt.
export async function commitVaultDocuments(env, writes, fetcher = firestoreFetch) {
  const unknown = () => Object.assign(new Error('The employee record save could not be verified. Retry the same request.'), { code: 'EMPLOYEE_HUB_OUTCOME_UNKNOWN', status: 503 });
  if (!Array.isArray(writes) || !writes.length || writes.some(write => !isRecord(write?.patch) || typeof write.collection !== 'string' || typeof write.id !== 'string' || !write.id)) throw new TypeError('Invalid employee vault commit');
  let response;
  try {
    response = await fetcher(env, `${DOCUMENTS}:commit`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ writes: writes.map(write => ({
      update: { name: `projects/${PROJECT_ID}/databases/(default)/documents/${write.collection}/${write.id}`, fields: encodeFirestoreFields(write.patch) },
      updateMask: { fieldPaths: Object.keys(write.patch) },
      currentDocument: write.revision ? { updateTime: write.revision } : { exists: false },
    })) }) });
  } catch { throw unknown(); }
  if (!response.ok) {
    const failure = await response.json().catch(() => ({}));
    if ([409, 412].includes(response.status) || ['FAILED_PRECONDITION', 'ABORTED', 'ALREADY_EXISTS', 'NOT_FOUND'].includes(failure?.error?.status)) {
      throw Object.assign(new Error('Employee record changed while saving. Refresh and retry.'), { code: 'EMPLOYEE_HUB_WRITE_CONFLICT', status: 409 });
    }
    throw unknown();
  }
  const result = await response.json().catch(() => null);
  if (!Array.isArray(result?.writeResults) || result.writeResults.length !== writes.length || result.writeResults.some(item => typeof item?.updateTime !== 'string' || !item.updateTime)) throw unknown();
  return result;
}

// Keyed digest for server-only receipts: a plain SHA-256 of a small payload (for
// example a pay rate) could be guessed; this key is derived from the vault secret.
export async function vaultDigest(env, purpose, text) {
  const secret = employeeVaultSecret(env);
  if (!secret) throw Object.assign(new Error('Employee Hub storage is not configured'), { code: 'EMPLOYEE_HUB_NOT_CONFIGURED', status: 503 });
  const material = await crypto.subtle.digest('SHA-256', encoder.encode(`${secret}:${purpose}`));
  const key = await crypto.subtle.importKey('raw', material, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return [...new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(String(text))))].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
