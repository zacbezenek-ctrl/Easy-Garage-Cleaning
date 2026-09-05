import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHubSessionCookie } from '../functions/_lib/hub-session.js';
import { createCustomerPortalSessionCookie } from '../functions/_lib/customer-portal.js';
import { cleanMessage, cleanRequestId, conversationMessages } from '../functions/_lib/customer-messaging.js';
import { decodeFirestoreFields, encodeFirestoreFields } from '../functions/_lib/firestore-job.js';

const read = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const firestoreDocument = (id, data, updateTime = '2026-09-05T17:00:00.000000Z') => JSON.stringify({
  name: `projects/egcw-1ec83/databases/(default)/documents/jobs/${id}`,
  updateTime,
  fields: encodeFirestoreFields(data),
});

test('customer message values are bounded, cleaned, and normalized for display', () => {
  assert.equal(cleanMessage('  hello\r\n\u0000crew  '), 'hello\ncrew');
  assert.equal(cleanMessage('x'.repeat(1300)).length, 1200);
  assert.equal(cleanRequestId('portal-12345678'), 'portal-12345678');
  assert.equal(cleanRequestId('bad'), '');
  const rows = conversationMessages({ customerConversation: [{ id: '1', direction: 'to_customer', authorRole: 'crew', authorName: 'Alex', body: '<b>literal</b>', createdAt: '2026-09-05T17:00:00Z', delivery: { channel: 'sms', status: 'sent' } }] });
  assert.equal(rows[0].body, '<b>literal</b>');
  assert.equal(rows[0].direction, 'to_customer');
});

test('assigned crew can message only the job contact and HighLevel receives an SMS', async () => {
  const route = await import('../functions/api/crew-jobs.js');
  const users = { Assigned: { passwordHash: 'test', displayName: 'Assigned Crew', role: 'crew' }, Outsider: { passwordHash: 'test', displayName: 'Other Person', role: 'crew' } };
  const env = { HUB_SESSION_SECRET: 'customer-thread-crew', HUB_AUTH_USERS_JSON: JSON.stringify(users), FIREBASE_API_KEY: 'firebase-test-thread', HIGHLEVEL_API_KEY: 'ghl-test', HIGHLEVEL_LOCATION_ID: 'location-1' };
  const assignedCookie = (await createHubSessionCookie(env, 'Assigned', { displayName: 'Assigned Crew' })).split(';')[0];
  const outsiderCookie = (await createHubSessionCookie(env, 'Outsider', { displayName: 'Other Person' })).split(';')[0];
  let stored = { type: 'job', customer: 'Dana Customer', assignedCrew: ['Assigned Crew'], highlevelContactId: 'real-contact', highlevelAppointmentId: 'real-appt', customerConversation: [] };
  let update = 0, highLevelPayload = null;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).includes('services.leadconnectorhq.com')) {
      highLevelPayload = JSON.parse(options.body);
      return new Response(JSON.stringify({ messageId: 'ghl-message', conversationId: 'ghl-conversation' }), { status: 200 });
    }
    if ((options.method || 'GET') === 'PATCH') {
      stored = { ...stored, ...decodeFirestoreFields(JSON.parse(options.body).fields) };
      update += 1;
      return new Response(firestoreDocument('job-1', stored, `2026-09-05T17:00:0${update}.000000Z`), { status: 200 });
    }
    return new Response(firestoreDocument('job-1', stored, `2026-09-05T17:00:0${update}.000000Z`), { status: 200 });
  };
  try {
    const request = cookie => new Request('https://easygaragecleaning.com/api/crew-jobs', { method: 'POST', headers: { Origin: 'https://easygaragecleaning.com', Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'send_customer_message', jobId: 'job-1', body: 'We arrive in 20 minutes.', requestId: 'crew-request-12345', contactId: 'attacker-contact' }) });
    assert.equal((await route.onRequestPost({ request: request(outsiderCookie), env })).status, 403);
    const response = await route.onRequestPost({ request: request(assignedCookie), env });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(highLevelPayload.type, 'SMS');
    assert.equal(highLevelPayload.contactId, 'real-contact');
    assert.equal(highLevelPayload.appointmentId, 'real-appt');
    assert.equal(result.message.delivery.status, 'sent');
    assert.equal(stored.customerConversation[0].authorName, 'Assigned Crew');
    assert.equal(stored.customerConversation[0].delivery.messageId, 'ghl-message');
  } finally { globalThis.fetch = originalFetch; }
});

test('client portal replies derive identity from the signed job and notify HighLevel', async () => {
  const route = await import('../functions/api/customer-portal.js');
  const env = { HUB_SESSION_SECRET: 'customer-thread-client', FIREBASE_API_KEY: 'firebase-test-thread-client', HIGHLEVEL_API_KEY: 'ghl-test', HIGHLEVEL_LOCATION_ID: 'location-1' };
  const cookie = (await createCustomerPortalSessionCookie(env, 'job-2')).split(';')[0];
  let stored = { customer: 'Dana Customer', highlevelContactId: 'real-client-contact', customerConversation: [] };
  let update = 0, highLevelPayload = null;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).includes('services.leadconnectorhq.com')) {
      highLevelPayload = JSON.parse(options.body);
      return new Response(JSON.stringify({ messageId: 'internal-comment', conversationId: 'conversation-2' }), { status: 200 });
    }
    if ((options.method || 'GET') === 'PATCH') {
      stored = { ...stored, ...decodeFirestoreFields(JSON.parse(options.body).fields) };
      update += 1;
      return new Response(firestoreDocument('job-2', stored, `2026-09-05T18:00:0${update}.000000Z`), { status: 200 });
    }
    return new Response(firestoreDocument('job-2', stored, `2026-09-05T18:00:0${update}.000000Z`), { status: 200 });
  };
  try {
    const response = await route.onRequestPost({ request: new Request('https://easygaragecleaning.com/api/customer-portal', { method: 'POST', headers: { Origin: 'https://easygaragecleaning.com', Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'send_message', body: 'The side door is unlocked.', request_id: 'portal-request-12345', authorName: 'Imposter', contactId: 'attacker-contact' }) }), env });
    assert.equal(response.status, 200);
    assert.equal(highLevelPayload.type, 'InternalComment');
    assert.equal(highLevelPayload.contactId, 'real-client-contact');
    assert.match(highLevelPayload.message, /The side door is unlocked/);
    assert.equal(stored.customerConversation[0].authorName, 'Dana Customer');
    assert.equal(stored.customerConversation[0].direction, 'from_customer');
  } finally { globalThis.fetch = originalFetch; }
});

test('HighLevel inbound message webhook rejects unsigned requests before reading project data', async () => {
  const route = await import('../functions/api/highlevel-message-event.js');
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; return new Response('{}', { status: 200 }); };
  try {
    const response = await route.onRequestPost({ request: new Request('https://easygaragecleaning.com/api/highlevel-message-event', { method: 'POST', body: JSON.stringify({ type: 'InboundMessage' }) }), env: { FIREBASE_API_KEY: 'firebase-test-webhook', HIGHLEVEL_LOCATION_ID: 'location-1' } });
    assert.equal(response.status, 401);
    assert.equal(calls, 0);
  } finally { globalThis.fetch = originalFetch; }
});

test('client and crew interfaces label the shared thread separately from private notes', () => {
  const portal = read('customer-portal.html'), suite = read('employee-suite.js'), css = read('employee-suite.css');
  for (const marker of ['Project messages', 'Talk with your crew', 'message-form', 'send_message', 'Thread + text connected']) assert.match(portal, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  for (const marker of ['VISIBLE TO CUSTOMER', 'Customer thread', 'PRIVATE · EGC ONLY', 'opsSendCustomerMessage', 'send_customer_message']) assert.match(suite, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(css, /ops-customer-thread-messages/);
});
