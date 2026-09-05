import { firestoreFetch } from './firebase-service-account.js';

const PROJECT_ID = 'egcw-1ec83';

function endpoint(jobId) {
  return `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/jobs/${encodeURIComponent(jobId)}`;
}

function documentName(jobId) {
  return `projects/${PROJECT_ID}/databases/(default)/documents/jobs/${encodeURIComponent(jobId)}`;
}

export function decodeFirestoreValue(field) {
  if (!field || 'nullValue' in field) return null;
  if ('stringValue' in field) return field.stringValue;
  if ('integerValue' in field) return Number(field.integerValue);
  if ('doubleValue' in field) return Number(field.doubleValue);
  if ('booleanValue' in field) return Boolean(field.booleanValue);
  if ('timestampValue' in field) return field.timestampValue;
  if ('arrayValue' in field) return (field.arrayValue.values || []).map(decodeFirestoreValue);
  if ('mapValue' in field) return decodeFirestoreFields(field.mapValue.fields || {});
  return undefined;
}

export function decodeFirestoreFields(fields = {}) {
  return Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, decodeFirestoreValue(value)]));
}

export function encodeFirestoreValue(value) {
  if (value === null || value === undefined) return { nullValue: null };
  if (typeof value === 'string') return { stringValue: value };
  if (typeof value === 'boolean') return { booleanValue: value };
  if (typeof value === 'number') return Number.isInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
  if (Array.isArray(value)) return { arrayValue: { values: value.map(encodeFirestoreValue) } };
  if (typeof value === 'object') return { mapValue: { fields: encodeFirestoreFields(value) } };
  return { stringValue: String(value) };
}

export function encodeFirestoreFields(value = {}) {
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, encodeFirestoreValue(item)]));
}

export async function readJob(env, jobId) {
  const response = await firestoreFetch(env, endpoint(jobId));
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Job storage read failed (${response.status})`);
  const document = await response.json();
  return { id: String(document.name || '').split('/').pop() || jobId, __updateTime: document.updateTime || '', ...decodeFirestoreFields(document.fields || {}) };
}

export async function patchJob(env, jobId, patch, updateTime = '') {
  const fields = Object.keys(patch || {});
  if (!fields.length) return readJob(env, jobId);
  const url = new URL(endpoint(jobId));
  fields.forEach(field => url.searchParams.append('updateMask.fieldPaths', field));
  if (updateTime) url.searchParams.set('currentDocument.updateTime', updateTime);
  const response = await firestoreFetch(env, url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: encodeFirestoreFields(patch) }),
  });
  if (!response.ok) throw new Error(`Job storage write failed (${response.status})`);
  const document = await response.json();
  return { id: jobId, ...decodeFirestoreFields(document.fields || {}) };
}

export async function patchJobsAtomic(env, updates = []) {
  const valid = updates.filter(item => item?.jobId && Object.keys(item.patch || {}).length);
  if (!valid.length) return [];
  const url = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents:commit`;
  const writes = valid.map(item => ({
    update: { name: documentName(item.jobId), fields: encodeFirestoreFields(item.patch) },
    updateMask: { fieldPaths: Object.keys(item.patch) },
    ...(item.updateTime ? { currentDocument: { updateTime: item.updateTime } } : {}),
  }));
  const response = await firestoreFetch(env, url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ writes }) });
  if (!response.ok) throw new Error(`Job storage transaction failed (${response.status})`);
  return response.json();
}
