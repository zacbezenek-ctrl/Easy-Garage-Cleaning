const HIGHLEVEL_API = 'https://services.leadconnectorhq.com';
const HIGHLEVEL_ED25519_SPKI = 'MCowBQYDK2VwAyEAi2HR1srL4o18O8BRa7gVJY7G7bupbN3H9AwJrHCDiOg=';

const cleanInline = (value, max = 180) => String(value || '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, max);

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
      status: ['queued', 'sent', 'received', 'failed', 'needs_contact', 'not_configured'].includes(row?.delivery?.status) ? row.delivery.status : 'received',
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

export async function deliverHighLevelMessage(env, job, { body, direction }) {
  const config = highLevelConfig(env);
  const contactId = cleanInline(job?.highlevelContactId, 180);
  const attemptedAt = new Date().toISOString();
  if (!contactId) return { channel: direction === 'to_customer' ? 'sms' : 'highlevel', status: 'needs_contact', attemptedAt };
  if (!config.token) return { channel: direction === 'to_customer' ? 'sms' : 'highlevel', status: 'not_configured', attemptedAt };
  const payload = {
    type: direction === 'to_customer' ? 'SMS' : 'InternalComment',
    contactId,
    message: direction === 'to_customer' ? cleanMessage(body) : `Client portal reply: ${cleanMessage(body)}`,
    status: 'pending',
    ...(cleanInline(job?.highlevelAppointmentId, 180) ? { appointmentId: cleanInline(job.highlevelAppointmentId, 180) } : {}),
    ...(config.userId ? { userId: config.userId } : {}),
  };
  try {
    const response = await fetch(`${HIGHLEVEL_API}/conversations/messages`, {
      method: 'POST',
      headers: { Accept: 'application/json', Authorization: `Bearer ${config.token}`, Version: 'v3', 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) return { channel: direction === 'to_customer' ? 'sms' : 'highlevel', status: 'failed', attemptedAt };
    return {
      channel: direction === 'to_customer' ? 'sms' : 'highlevel', status: 'sent', attemptedAt,
      messageId: cleanInline(data.messageId, 180), conversationId: cleanInline(data.conversationId, 180),
    };
  } catch {
    return { channel: direction === 'to_customer' ? 'sms' : 'highlevel', status: 'failed', attemptedAt };
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
