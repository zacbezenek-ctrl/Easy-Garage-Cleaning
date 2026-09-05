import { patchJob, queryJobsByField } from '../_lib/firestore-job.js';
import { appendConversationMessage, cleanMessage, highLevelLocationMatches, findConversationMessage, verifyHighLevelSignature } from '../_lib/customer-messaging.js';
import { firebaseServiceAccountConfigured } from '../_lib/firebase-service-account.js';

const reply = (status, body) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
});

function newestRelevantJob(rows = []) {
  const active = rows.filter(job => !['cancelled', 'paid'].includes(String(job.pipelineStatus || job.status || '').toLowerCase()));
  return [...(active.length ? active : rows)].sort((left, right) =>
    String(right.updatedAt || right.date || '').localeCompare(String(left.updatedAt || left.date || '')))[0] || null;
}

export async function onRequestPost({ request, env }) {
  const raw = await request.text();
  if (!raw || raw.length > 64 * 1024) return reply(413, { ok: false, error: 'Invalid webhook body' });
  if (!await verifyHighLevelSignature(raw, request.headers.get('X-GHL-Signature'))) {
    return reply(401, { ok: false, error: 'Invalid webhook signature' });
  }
  if (!firebaseServiceAccountConfigured(env)) return reply(503, { ok: false, error: 'Secure data access is not configured' });
  let event;
  try { event = JSON.parse(raw); } catch { return reply(400, { ok: false, error: 'Invalid JSON' }); }
  if (!highLevelLocationMatches(env, event)) return reply(403, { ok: false, error: 'Wrong HighLevel location' });
  if (event.type !== 'InboundMessage' || event.direction !== 'inbound') return reply(200, { ok: true, ignored: true });
  const messageType = String(event.messageType || '').toUpperCase();
  if (!messageType.includes('SMS') && !messageType.includes('EMAIL')) return reply(200, { ok: true, ignored: true });
  const contactId = String(event.contactId || '').trim(), providerMessageId = String(event.messageId || event.webhookId || '').trim().slice(0, 180);
  const body = cleanMessage(event.body || event.message || '');
  if (!contactId || !providerMessageId || !body) return reply(200, { ok: true, ignored: true });
  let job;
  try { job = newestRelevantJob(await queryJobsByField(env, 'highlevelContactId', contactId, 20)); }
  catch { return reply(502, { ok: false, error: 'Project lookup failed' }); }
  if (!job) return reply(202, { ok: true, matched: false });
  const existing = findConversationMessage(job, { providerMessageId });
  if (existing) return reply(200, { ok: true, duplicate: true, matched: true });
  const now = new Date().toISOString(), message = {
    id: `ghl-${providerMessageId}`.slice(0, 140), providerMessageId,
    direction: 'from_customer', authorRole: 'customer', authorName: String(job.customer || event.contactName || 'Customer').slice(0, 120),
    body, createdAt: event.dateAdded && Number.isFinite(Date.parse(event.dateAdded)) ? new Date(event.dateAdded).toISOString() : now,
    delivery: { channel: messageType.includes('EMAIL') ? 'highlevel' : 'sms', status: 'received', attemptedAt: now, messageId: providerMessageId, conversationId: String(event.conversationId || '').slice(0, 180) },
  };
  try {
    await patchJob(env, job.id, { customerConversation: appendConversationMessage(job, message), customerConversationUpdatedAt: now, updatedAt: now }, job.__updateTime);
    return reply(200, { ok: true, matched: true });
  } catch {
    return reply(409, { ok: false, error: 'Conversation changed; retry webhook' });
  }
}

export function onRequestGet() {
  return reply(405, { ok: false, error: 'Method not allowed' });
}
