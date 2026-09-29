/* HighLevel delivery adapter shared by every approved send. Recipients come
   only from saved EGC data, and provider outcomes are classified so that an
   ambiguous result is never mistaken for a safe-to-retry failure. */
import { escapeHtml } from './message-templates.js';
import { NO_SMS_CONSENT_TAG } from './contact-consent.js';

const API = 'https://services.leadconnectorhq.com';
export { NO_SMS_CONSENT_TAG };
// The only contact tags the messenger may add or remove, each registered with
// its Hub write in the FUN-30 automation registry: egc-estimate-ready re-fires
// the existing estimate-ready workflow for a confirmed quote send (estimate-ready.js).
export const MESSENGER_TAG_WRITES = Object.freeze(['egc-estimate-ready']);
export const MESSAGE_CHANNELS = Object.freeze(['SMS', 'Email']);

export const normalizePhone = value => {
  const digits = String(value || '').replace(/\D/g, '');
  return digits.length === 10 ? `+1${digits}` : digits.length >= 11 && digits.length <= 15 ? `+${digits}` : '';
};
export const normalizeEmail = value => {
  const email = String(value || '').trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 180 ? email : '';
};
export function maskRecipient(channel, destination) {
  if (channel === 'SMS') { const digits = String(destination || '').replace(/\D/g, ''); return digits ? `(•••) •••-${digits.slice(-4)}` : ''; }
  const [name, domain] = String(destination || '').split('@');
  return name && domain ? `${name[0]}•••@${domain}` : '';
}
export function recipientDestination(channel, { phone, email } = {}) {
  return channel === 'SMS' ? normalizePhone(phone) : channel === 'Email' ? normalizeEmail(email) : '';
}
// Plain-text email bodies are escaped and turned into paragraphs.
export function emailHtml(message) {
  return String(message || '').replace(/\r\n?/g, '\n').split(/\n{2,}/).map(paragraph => `<p>${escapeHtml(paragraph).replace(/\n/g, '<br>')}</p>`).join('');
}

function config(env = {}) {
  return { token: String(env.HIGHLEVEL_API_KEY || env.GHL_API_KEY || ''), locationId: String(env.HIGHLEVEL_LOCATION_ID || env.GHL_LOCATION_ID || '') };
}

export function createGhlMessenger({ env = {}, fetcher = fetch, clock = () => new Date() } = {}) {
  const c = config(env);
  async function request(path, options = {}, headers = {}) {
    const response = await fetcher(API + path, {
      ...options,
      signal: AbortSignal.timeout(15000),
      headers: { Authorization: `Bearer ${c.token}`, Version: 'v3', Accept: 'application/json', 'Content-Type': 'application/json', ...headers },
    });
    return { response, data: await response.json().catch(() => ({})) };
  }
  const unavailable = { status: 'unavailable', reason: 'provider_unreachable' };

  // Upsert only from saved data, then verify the contact's id, location and
  // destination. DND applies per channel; the no-consent tag blocks SMS.
  async function resolveRecipient({ contactId = '', phone = '', email = '', name = '', preferred = '', upsert = true } = {}) {
    if (!c.token || !c.locationId) return { status: 'not_configured', reason: 'highlevel' };
    const channel = MESSAGE_CHANNELS.includes(preferred) ? preferred : normalizePhone(phone) ? 'SMS' : 'Email';
    const destination = recipientDestination(channel, { phone, email });
    if (!destination) return { status: 'needs_contact', reason: channel === 'SMS' ? 'no_phone' : 'no_email', channel };
    const masked = maskRecipient(channel, destination), to = channel === 'SMS' ? { toNumber: destination } : { emailTo: destination };
    let id = String(contactId || '').trim();
    if (id && !/^[A-Za-z0-9_-]{1,120}$/.test(id)) return { status: 'contact_mismatch', reason: 'contact_id_invalid', channel, masked };
    if (!id && !upsert) return { status: 'ready', pendingUpsert: true, contactId: '', channel, masked, ...to };
    try {
      if (!id) {
        const { response, data } = await request('/contacts/upsert', { method: 'POST', body: JSON.stringify({
          locationId: c.locationId, name: String(name || '').slice(0, 120) || undefined,
          phone: normalizePhone(phone) || undefined, email: normalizeEmail(email) || undefined, source: 'EGC Hub approved message',
        }) });
        if (response.status >= 500) return { ...unavailable, channel, masked };
        if (!response.ok) return { status: 'needs_contact', reason: 'contact_upsert_failed', channel, masked };
        id = String(data.contact?.id || '');
        if (!/^[A-Za-z0-9_-]{1,120}$/.test(id)) return { status: 'needs_contact', reason: 'contact_upsert_failed', channel, masked };
      }
      const { response, data } = await request(`/contacts/${encodeURIComponent(id)}`);
      if (response.status >= 500) return { ...unavailable, channel, masked };
      if (!response.ok || !data.contact) return { status: 'needs_contact', reason: 'contact_not_found', channel, masked };
      const contact = data.contact;
      const matches = channel === 'SMS' ? normalizePhone(contact.phone) === destination : normalizeEmail(contact.email) === destination;
      if (contact.id !== id || contact.locationId !== c.locationId || !matches) return { status: 'contact_mismatch', reason: 'contact_identity_mismatch', channel, masked };
      const dnd = contact.dndSettings?.[channel]?.status;
      if (contact.dnd === true || (dnd && String(dnd).toLowerCase() !== 'inactive')) return { status: 'suppressed', reason: `contact_dnd_${channel.toLowerCase()}`, channel, masked };
      const tags = Array.isArray(contact.tags) ? contact.tags.map(tag => String(tag).trim().toLowerCase()) : [];
      if (channel === 'SMS' && tags.includes(NO_SMS_CONSENT_TAG)) return { status: 'suppressed', reason: 'no_sms_consent', channel, masked };
      return { status: 'ready', contactId: id, channel, masked, ...to };
    } catch { return { ...unavailable, channel, masked }; }
  }

  // 2xx with a message id is submitted. Other 4xx (except 408) is a definite
  // rejection; timeouts, 5xx, throws and missing ids are uncertain.
  async function send({ type, contactId, message, subject = '', html = '', attachments = [], toNumber = '', emailTo = '', emailFrom = '', idempotencyKey = '' } = {}) {
    const at = clock().toISOString();
    if (!c.token || !c.locationId) return { status: 'failed', reason: 'not_configured', at };
    if (!MESSAGE_CHANNELS.includes(type) || !/^[A-Za-z0-9_-]{1,120}$/.test(String(contactId || '')) || typeof message !== 'string' || !message.trim()) return { status: 'failed', reason: 'invalid_message', at };
    if (!Array.isArray(attachments) || attachments.length > 10 || attachments.some(url => typeof url !== 'string' || !/^https:\/\/[^\s"'<>]+$/.test(url))) return { status: 'failed', reason: 'invalid_attachment', at };
    const body = {
      type, contactId, message, status: 'pending',
      ...(attachments.length ? { attachments } : {}),
      ...(type === 'Email'
        ? { subject: String(subject || '').slice(0, 200), html: html || emailHtml(message), ...(normalizeEmail(emailTo) ? { emailTo: normalizeEmail(emailTo) } : {}), ...(normalizeEmail(emailFrom) ? { emailFrom: normalizeEmail(emailFrom) } : {}) }
        : normalizePhone(toNumber) ? { toNumber: normalizePhone(toNumber) } : {}),
    };
    try {
      const { response, data } = await request('/conversations/messages', { method: 'POST', body: JSON.stringify(body) }, idempotencyKey ? { 'Idempotency-Key': String(idempotencyKey).slice(0, 200) } : {});
      const messageId = String(data?.messageId || '').slice(0, 180);
      if (response.ok && messageId) return { status: 'submitted', messageId, conversationId: String(data.conversationId || '').slice(0, 180), at };
      if (response.status >= 400 && response.status < 500 && response.status !== 408) return { status: 'failed', httpStatus: response.status, at };
      return { status: 'uncertain', ...(response.ok ? { reason: 'missing_message_id' } : { httpStatus: response.status }), at };
    } catch { return { status: 'uncertain', reason: 'no_provider_response', at }; }
  }

  // Tags start the existing HighLevel workflows (e.g. egc-estimate-ready), so a
  // tag on a verified contact is classified exactly like send(). removeTags
  // clears a tag first, because HighLevel's tag-added trigger does not fire for
  // a contact that already has the tag.
  async function tagRequest(method, { contactId, tags = [], idempotencyKey = '' } = {}) {
    const at = clock().toISOString(), wanted = [...new Set((Array.isArray(tags) ? tags : []).filter(tag => typeof tag === 'string' && /^[a-z0-9][a-z0-9-]{0,59}$/.test(tag) && MESSENGER_TAG_WRITES.includes(tag)))];
    if (!c.token || !c.locationId) return { status: 'failed', reason: 'not_configured', at };
    if (!/^[A-Za-z0-9_-]{1,120}$/.test(String(contactId || '')) || !wanted.length) return { status: 'failed', reason: 'invalid_tags', at };
    try {
      const { response } = await request(`/contacts/${encodeURIComponent(contactId)}/tags`, { method, body: JSON.stringify({ tags: wanted }) }, idempotencyKey ? { 'Idempotency-Key': String(idempotencyKey).slice(0, 200) } : {});
      if (response.ok) return { status: 'submitted', httpStatus: response.status, at };
      if (response.status >= 400 && response.status < 500 && response.status !== 408) return { status: 'failed', httpStatus: response.status, at };
      return { status: 'uncertain', httpStatus: response.status, at };
    } catch { return { status: 'uncertain', reason: 'no_provider_response', at }; }
  }
  const addTags = input => tagRequest('POST', input);
  const removeTags = input => tagRequest('DELETE', input);

  return { configured: () => Boolean(c.token && c.locationId), resolveRecipient, send, addTags, removeTags };
}
