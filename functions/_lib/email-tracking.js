import { firestoreFetch } from './firebase-service-account.js';
import { encodeFirestoreFields, decodeFirestoreFields } from './firestore-job.js';

const PROJECT_ID = 'egcw-1ec83';
const COLLECTION = 'email_tracking';

function docUrl(token) {
  return `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/${COLLECTION}/${encodeURIComponent(token)}`;
}

export function safeTrackingToken(value) {
  const token = String(value || '').trim().toLowerCase();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(token) ? token : '';
}

export function trackingPixelUrl(token, origin = 'https://easygaragecleaning.com') {
  const clean = safeTrackingToken(token);
  return clean ? `${String(origin).replace(/\/$/, '')}/api/email-open/${clean}.gif` : '';
}

export async function createEmailTracking(env, metadata = {}) {
  const token = crypto.randomUUID().toLowerCase();
  const now = new Date().toISOString();
  const record = {
    token,
    recipient: String(metadata.recipient || '').trim().toLowerCase().slice(0, 320),
    subject: String(metadata.subject || '').trim().slice(0, 300),
    messageId: String(metadata.messageId || '').trim().slice(0, 180),
    campaign: String(metadata.campaign || '').trim().slice(0, 180),
    contactId: String(metadata.contactId || '').trim().slice(0, 180),
    source: String(metadata.source || '').trim().slice(0, 120),
    createdAt: now,
    sentAt: String(metadata.sentAt || '').trim().slice(0, 50),
    firstOpenedAt: '',
    lastOpenedAt: '',
    openCount: 0,
    status: 'created',
  };

  const response = await firestoreFetch(env, docUrl(token), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: encodeFirestoreFields(record) }),
  });
  if (!response.ok) throw new Error(`Email tracking create failed (${response.status})`);
  return record;
}

export async function markEmailTrackingSent(env, token) {
  const clean = safeTrackingToken(token);
  if (!clean) return false;
  const now = new Date().toISOString();
  const url = new URL(docUrl(clean));
  ['status', 'sentAt'].forEach(field => url.searchParams.append('updateMask.fieldPaths', field));
  const response = await firestoreFetch(env, url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: encodeFirestoreFields({ status: 'sent', sentAt: now }) }),
  });
  return response.ok;
}

export async function recordEmailOpen(env, token, request = null) {
  const clean = safeTrackingToken(token);
  if (!clean) return false;

  const existingResponse = await firestoreFetch(env, docUrl(clean));
  if (!existingResponse.ok) return false;
  const existingDoc = await existingResponse.json();
  const existing = decodeFirestoreFields(existingDoc.fields || {});
  const now = new Date().toISOString();

  const patch = {
    firstOpenedAt: existing.firstOpenedAt || now,
    lastOpenedAt: now,
    openCount: Math.max(0, Number(existing.openCount || 0)) + 1,
    status: 'opened',
    lastUserAgent: String(request?.headers?.get('User-Agent') || '').slice(0, 500),
    lastReferer: String(request?.headers?.get('Referer') || '').slice(0, 500),
  };

  const url = new URL(docUrl(clean));
  Object.keys(patch).forEach(field => url.searchParams.append('updateMask.fieldPaths', field));
  const response = await firestoreFetch(env, url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: encodeFirestoreFields(patch) }),
  });
  return response.ok;
}
