import { firestoreFetch } from './firebase-service-account.js';
import { employeeVaultReadOnly, employeeVaultSecret } from './employee-vault-key.js';

// This collection is denied by Firestore's existing browser catch-all rules.
// The broadly writable jobs collection must never contain integration state.
const ROOT = 'https://firestore.googleapis.com/v1/projects/egcw-1ec83/databases/(default)/documents/gusto_integrations/';
const TYPE = 'gusto_sync_v1';
const encoder = new TextEncoder();
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

function failure(code, message, status = 503) { return Object.assign(new Error(message), { code, status, publicMessage: message }); }
function namespace(env, key) {
  if (!['demo', 'production'].includes(env.GUSTO_ENVIRONMENT) || !UUID.test(String(env.GUSTO_COMPANY_UUID || '')) || typeof key !== 'string' || !key || key.length > 1024) {
    throw failure('GUSTO_STORAGE_CONFIGURATION', 'Gusto storage configuration needs attention.');
  }
  return `${TYPE}\n${env.GUSTO_ENVIRONMENT}\n${env.GUSTO_COMPANY_UUID.toLowerCase()}\n${key}`;
}
function encode(bytes) { let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte); return btoa(binary); }
function decode(value) { return Uint8Array.from(atob(value), char => char.charCodeAt(0)); }
async function context(env, key) {
  const domain = namespace(env, key);
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(domain));
  const id = `${TYPE}_${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')}`;
  return { id, domain };
}
async function encryptionKey(env) {
  const secret = employeeVaultSecret(env);
  if (!secret) throw failure('GUSTO_STORAGE_CONFIGURATION', 'Gusto secure storage is not configured.');
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(`egc:gusto:aes-gcm:v1\n${secret}`));
  return crypto.subtle.importKey('raw', digest, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
function unreadable() { return failure('GUSTO_STORAGE_UNREADABLE', 'Saved Gusto settings could not be read. Restore the existing storage key before continuing.'); }

export async function readGustoRecord(env, key) {
  const { id, domain } = await context(env, key);
  const response = await firestoreFetch(env, ROOT + id);
  if (response.status === 404) return { data: null, version: null, id };
  if (!response.ok) throw failure('GUSTO_STORAGE_ERROR', 'Gusto secure storage is unavailable.');
  const document = await response.json().catch(() => null);
  const fields = document?.fields;
  if (!document?.updateTime || fields?.recordType?.stringValue !== TYPE || fields?.formatVersion?.integerValue !== '1' || !fields?.ciphertext?.stringValue || !fields?.iv?.stringValue) throw unreadable();
  let data;
  try {
    const iv = decode(fields.iv.stringValue);
    if (iv.byteLength !== 12) throw unreadable();
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(domain) }, await encryptionKey(env), decode(fields.ciphertext.stringValue));
    data = JSON.parse(new TextDecoder().decode(plaintext));
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw unreadable();
  } catch { throw unreadable(); }
  return { data, version: document.updateTime, id };
}

export async function writeGustoRecord(env, key, data, expected) {
  if (employeeVaultReadOnly(env)) throw failure('GUSTO_STORAGE_READ_ONLY', 'Gusto storage is read only until the existing storage key is verified.');
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw failure('GUSTO_STORAGE_INVALID', 'Invalid Gusto storage update.');
  const { id, domain } = await context(env, key);
  if (expected === undefined) throw failure('GUSTO_STORAGE_INVALID', 'A saved Gusto version is required.');
  const version = expected && typeof expected === 'object' ? expected.version : expected;
  if ((expected && typeof expected === 'object' && expected.id !== id) || (version !== null && (typeof version !== 'string' || !version))) throw failure('GUSTO_STORAGE_INVALID', 'Invalid Gusto storage version.');
  // A caller cannot replace an unreadable document by guessing its update time.
  if (version !== null) {
    const existing = await readGustoRecord(env, key);
    if (existing.version !== version) throw failure('GUSTO_WRITE_CONFLICT', 'Gusto settings changed. Reload and try again.', 409);
  }
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(domain) }, await encryptionKey(env), encoder.encode(JSON.stringify(data)));
  const url = new URL(ROOT + id);
  url.searchParams.set(version === null ? 'currentDocument.exists' : 'currentDocument.updateTime', version === null ? 'false' : version);
  const response = await firestoreFetch(env, url, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: { recordType: { stringValue: TYPE }, formatVersion: { integerValue: '1' }, iv: { stringValue: encode(iv) }, ciphertext: { stringValue: encode(new Uint8Array(ciphertext)) } } }),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    if ([409, 412].includes(response.status) || ['ALREADY_EXISTS', 'FAILED_PRECONDITION', 'ABORTED'].includes(error.error?.status)) throw failure('GUSTO_WRITE_CONFLICT', 'Gusto settings changed. Reload and try again.', 409);
    throw failure('GUSTO_STORAGE_ERROR', 'Gusto secure storage could not be updated.');
  }
  const saved = await response.json().catch(() => null);
  if (!saved?.updateTime) throw failure('GUSTO_STORAGE_ERROR', 'Gusto secure storage could not confirm the update.');
  return { data, version: saved.updateTime, id };
}
