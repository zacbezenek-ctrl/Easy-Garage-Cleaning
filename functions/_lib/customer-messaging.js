import { createGhlMessenger } from './ghl-messenger.js';

const HIGHLEVEL_API = 'https://services.leadconnectorhq.com';
const HIGHLEVEL_ED25519_SPKI = 'MCowBQYDK2VwAyEAi2HR1srL4o18O8BRa7gVJY7G7bupbN3H9AwJrHCDiOg=';

const cleanInline = (value, max = 180) => String(value || '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, max);
// uncertain: HighLevel may have sent it (timeout, 5xx, lost or id-less reply),
// so it is never re-sent automatically. suppressed: the saved contact opted out.
export const DELIVERY_STATUSES = Object.freeze(['queued', 'sent', 'received', 'failed', 'uncertain', 'suppressed', 'needs_contact', 'not_configured']);

export function cleanMessage(value, max = 1200) {
  return String(value || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim()
    .slice(0, max);
}

export function cleanRequestId(value) {
  const requestId = cleanInline(value, 120);
  return /^[A-Za-z0-9][A-Za-z0-9:_-]{7,119}$/.test(requestId) ? requestId : '';
}

export function conversationMessages(job = {}) {
  const rows = Array.isArray(job.customerConversation) ? job.customerConversation : [];
  return rows.slice(-100).map(row => ({
    id: cleanInline(row?.id, 140),
    requestId: cleanInline(row?.requestId, 120),
    providerMessageId: cleanInline(row?.providerMessageId, 180),
    direction: row?.direction === 'to_customer' ? 'to_customer' : 'from_customer',
    authorRole: row?.authorRole === 'crew' ? 'crew' : row?.authorRole === 'manager' ? 'manager' : 'customer',
    authorName: cleanInline(row?.authorName || (row?.direction === 'to_customer' ? 'Easy Garage Cleaning' : 'Customer'), 120),
    body: cleanMessage(row?.body),
    createdAt: cleanInline(row?.createdAt, 50),
    delivery: {
      channel: ['sms', 'highlevel', 'portal'].includes(row?.delivery?.channel) ? row.delivery.channel : 'portal',
      status: DELIVERY_STATUSES.includes(row?.delivery?.status) ? row.delivery.status : 'received',
      attemptedAt: cleanInline(row?.delivery?.attemptedAt, 50),
      messageId: cleanInline(row?.delivery?.messageId, 180),
      conversationId: cleanInline(row?.delivery?.conversationId, 180),
    },
  })).filter(row => row.id && row.body && row.createdAt);
}

export function findConversationMessage(job, { requestId = '', providerMessageId = '' } = {}) {
  return conversationMessages(job).find(row =>
    (requestId && row.requestId === requestId) || (providerMessageId && row.providerMessageId === providerMessageId));
}

export function appendConversationMessage(job, message) {
  const rows = conversationMessages(job);
  if (findConversationMessage({ customerConversation: rows }, message)) return rows;
  return [...rows, message].slice(-100);
}

export function replaceConversationMessage(job, messageId, replacement) {
  return conversationMessages(job).map(row => row.id === messageId ? { ...row, ...replacement } : row).slice(-100);
}

function highLevelConfig(env = {}) {
  return {
    token: String(env.HIGHLEVEL_API_KEY || env.GHL_API_KEY || ''),
    locationId: String(env.HIGHLEVEL_LOCATION_ID || env.GHL_LOCATION_ID || ''),
    userId: String(env.HIGHLEVEL_USER_ID || env.GHL_USER_ID || ''),
  };
}

const sha256 = async text => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map(byte => byte.toString(16).padStart(2, '0')).join('');
const RECIPIENT_DELIVERY = { not_configured: 'not_configured', suppressed: 'suppressed', unavailable: 'failed' };

// One provider key per thread message, derived from its requestId, so a replayed
// request cannot be delivered twice where HighLevel honours Idempotency-Key.
export async function threadIdempotencyKey(job, direction, requestId) {
  const id = cleanRequestId(requestId);
  return id ? `egc-thread-${await sha256(JSON.stringify([cleanInline(job?.id, 180), direction === 'to_customer' ? 'to_customer' : 'from_customer', id]))}` : '';
}

/* Customer-bound texts go only to the saved contact after the same identity,
   DND and SMS-consent check as approved sends. A 2xx with a message id is
   sent and other 4xx (except 408) failed; a timeout, 5xx, throw or id-less
   2xx is uncertain. Nothing here retries. */
export async function deliverHighLevelMessage(env, job, { body, direction, requestId = '' } = {}, { fetcher = fetch, clock = () => new Date() } = {}) {
  const config = highLevelConfig(env), toCustomer = direction === 'to_customer', attemptedAt = clock().toISOString();
  const result = (status, extra = {}) => ({ channel: toCustomer ? 'sms' : 'highlevel', status, attemptedAt, ...extra });
  const contactId = cleanInline(job?.highlevelContactId, 180);
  if (!contactId) return result('needs_contact');
  if (!config.token) return result('not_configured');
  let toNumber = '';
  if (toCustomer) {
    const recipient = await createGhlMessenger({ env, fetcher, clock }).resolveRecipient({ contactId, phone: job?.phone, preferred: 'SMS', upsert: false });
    if (recipient.status !== 'ready') return result(RECIPIENT_DELIVERY[recipient.status] || 'needs_contact');
    toNumber = recipient.toNumber;
  }
  const payload = {
    type: toCustomer ? 'SMS' : 'InternalComment',
    contactId,
    message: toCustomer ? cleanMessage(body) : `Client portal reply: ${cleanMessage(body)}`,
    status: 'pending',
    ...(toNumber ? { toNumber } : {}),
    ...(cleanInline(job?.highlevelAppointmentId, 180) ? { appointmentId: cleanInline(job.highlevelAppointmentId, 180) } : {}),
    ...(config.userId ? { userId: config.userId } : {}),
  };
  const idempotencyKey = await threadIdempotencyKey(job, direction, requestId);
  try {
    const response = await fetcher(`${HIGHLEVEL_API}/conversations/messages`, {
      method: 'POST',
      headers: { Accept: 'application/json', Authorization: `Bearer ${config.token}`, Version: 'v3', 'Content-Type': 'application/json', ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}) },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15000),
    });
    const data = await response.json().catch(() => ({}));
    const messageId = cleanInline(data?.messageId, 180);
    if (response.ok && messageId) return result('sent', { messageId, conversationId: cleanInline(data.conversationId, 180) });
    if (response.status >= 400 && response.status < 500 && response.status !== 408) return result('failed');
    return result('uncertain');
  } catch {
    return result('uncertain');
  }
}

function decodeBase64(value) {
  try { return Uint8Array.from(atob(String(value || '')), character => character.charCodeAt(0)); }
  catch { return new Uint8Array(); }
}

export async function verifyHighLevelSignature(rawBody, signature) {
  const signatureBytes = decodeBase64(signature);
  if (!signatureBytes.length) return false;
  try {
    const key = await crypto.subtle.importKey('spki', decodeBase64(HIGHLEVEL_ED25519_SPKI), { name: 'Ed25519' }, false, ['verify']);
    return crypto.subtle.verify('Ed25519', key, signatureBytes, new TextEncoder().encode(rawBody));
  } catch {
    return false;
  }
}

export function highLevelLocationMatches(env, payload = {}) {
  const configured = highLevelConfig(env).locationId;
  return Boolean(configured && cleanInline(payload.locationId, 180) === configured);
}
