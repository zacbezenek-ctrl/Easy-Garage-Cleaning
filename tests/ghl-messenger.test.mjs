import test from 'node:test';
import assert from 'node:assert/strict';
import { createGhlMessenger, emailHtml, maskRecipient, NO_SMS_CONSENT_TAG } from '../functions/_lib/ghl-messenger.js';
import { env, fakeGhl, clock } from './helpers/messaging-fixture.mjs';

const saved = { contactId: 'contact-1', phone: '(970) 555-0123', email: 'Synthetic@Example.invalid', name: 'Synthetic Customer' };
const messenger = (ghl, overrides = {}) => createGhlMessenger({ env: { ...env, ...overrides }, fetcher: ghl.fetcher, clock: clock() });

test('verified saved contact resolves to the saved destination with a masked display', async () => {
  const ghl = fakeGhl(), result = await messenger(ghl).resolveRecipient(saved);
  assert.deepEqual(result, { status: 'ready', contactId: 'contact-1', channel: 'SMS', masked: '(•••) •••-0123', toNumber: '+19705550123' });
  assert.equal(ghl.calls.length, 1);
  assert.equal(ghl.calls[0].path, '/contacts/contact-1');
  assert.equal(ghl.calls[0].headers.Authorization, 'Bearer ghl-synthetic-key');
  assert.equal(ghl.calls[0].headers.Version, 'v3');
  assert.ok(ghl.calls[0].signal instanceof AbortSignal, 'every provider call carries a timeout signal');
  const email = await messenger(fakeGhl()).resolveRecipient({ ...saved, preferred: 'Email' });
  assert.equal(email.emailTo, 'synthetic@example.invalid'); assert.equal(email.masked, 's•••@example.invalid');
});

test('identity mismatch on id, location, phone or email returns contact_mismatch', async () => {
  for (const contact of [{ id: 'contact-2' }, { locationId: 'location-2' }, { phone: '+19705559999' }]) {
    const result = await messenger(fakeGhl({ contact })).resolveRecipient(saved);
    assert.equal(result.status, 'contact_mismatch', JSON.stringify(contact));
  }
  assert.equal((await messenger(fakeGhl({ contact: { email: 'other@example.invalid' } })).resolveRecipient({ ...saved, preferred: 'Email' })).status, 'contact_mismatch');
  assert.equal((await messenger(fakeGhl()).resolveRecipient({ ...saved, contactId: '../contacts' })).status, 'contact_mismatch');
});

test('DND applies per channel and a global DND blocks every channel', async () => {
  const smsDnd = { dndSettings: { SMS: { status: 'active' }, Email: { status: 'inactive' } } };
  assert.deepEqual(await messenger(fakeGhl({ contact: smsDnd })).resolveRecipient(saved).then(r => [r.status, r.reason]), ['suppressed', 'contact_dnd_sms']);
  assert.equal((await messenger(fakeGhl({ contact: smsDnd })).resolveRecipient({ ...saved, preferred: 'Email' })).status, 'ready');
  const emailDnd = { dndSettings: { Email: { status: 'permanent' } } };
  assert.equal((await messenger(fakeGhl({ contact: emailDnd })).resolveRecipient(saved)).status, 'ready');
  assert.equal((await messenger(fakeGhl({ contact: emailDnd })).resolveRecipient({ ...saved, preferred: 'Email' })).reason, 'contact_dnd_email');
  for (const preferred of ['SMS', 'Email']) assert.equal((await messenger(fakeGhl({ contact: { dnd: true } })).resolveRecipient({ ...saved, preferred })).status, 'suppressed');
});

test('the egc-no-sms-consent tag blocks SMS but not email', async () => {
  const contact = { tags: ['VIP', ` ${NO_SMS_CONSENT_TAG.toUpperCase()} `] };
  const sms = await messenger(fakeGhl({ contact })).resolveRecipient(saved);
  assert.deepEqual([sms.status, sms.reason], ['suppressed', 'no_sms_consent']);
  assert.equal((await messenger(fakeGhl({ contact })).resolveRecipient({ ...saved, preferred: 'Email' })).status, 'ready');
});

test('a missing contact is upserted only from saved data, and previews never create contacts', async () => {
  const ghl = fakeGhl();
  const pending = await messenger(ghl).resolveRecipient({ ...saved, contactId: '', upsert: false });
  assert.equal(pending.status, 'ready'); assert.equal(pending.pendingUpsert, true); assert.equal(ghl.calls.length, 0);
  const ready = await messenger(ghl).resolveRecipient({ ...saved, contactId: '' });
  assert.equal(ready.contactId, 'contact-1');
  assert.deepEqual(ghl.calls.map(call => call.path), ['/contacts/upsert', '/contacts/contact-1']);
  assert.equal(ghl.calls[0].body.phone, '+19705550123'); assert.equal(ghl.calls[0].body.email, 'synthetic@example.invalid'); assert.equal(ghl.calls[0].body.locationId, 'location-1');
  const failed = fakeGhl(); failed.state.upsertId = 422;
  assert.equal((await messenger(failed).resolveRecipient({ ...saved, contactId: '' })).status, 'needs_contact');
});

test('missing destinations, configuration and provider outages never resolve as ready', async () => {
  const ghl = fakeGhl();
  assert.equal((await messenger(ghl).resolveRecipient({ ...saved, phone: '', email: '' })).status, 'needs_contact');
  assert.equal((await messenger(ghl).resolveRecipient({ ...saved, preferred: 'Email', email: 'not-an-email' })).reason, 'no_email');
  assert.equal((await messenger(ghl, { HIGHLEVEL_API_KEY: '' }).resolveRecipient(saved)).status, 'not_configured');
  assert.equal(ghl.calls.length, 0);
  const outage = fakeGhl(); outage.state.contactStatus = 503;
  assert.equal((await messenger(outage).resolveRecipient(saved)).status, 'unavailable');
  const thrown = createGhlMessenger({ env, fetcher: async () => { throw new Error('offline'); }, clock: clock() });
  assert.equal((await thrown.resolveRecipient(saved)).status, 'unavailable');
});

test('send classifies definite rejections as failed and ambiguous outcomes as uncertain', async () => {
  const input = { type: 'SMS', contactId: 'contact-1', message: 'Synthetic message', toNumber: '9705550123', idempotencyKey: 'egc-msg-key-1' };
  const cases = [[200, undefined, 'submitted'], [400, undefined, 'failed'], [422, undefined, 'failed'], [429, undefined, 'failed'], [408, undefined, 'uncertain'], [500, undefined, 'uncertain'], [503, undefined, 'uncertain'], [200, {}, 'uncertain']];
  for (const [sendStatus, sendBody, expected] of cases) {
    const result = await messenger(fakeGhl({ sendStatus, sendBody })).send(input);
    assert.equal(result.status, expected, `${sendStatus}`);
    assert.equal(result.at, '2026-09-22T18:00:00.000Z');
  }
  assert.equal((await messenger(fakeGhl({ sendThrows: true })).send(input)).status, 'uncertain');
  const ghl = fakeGhl(), submitted = await messenger(ghl).send(input);
  assert.deepEqual([submitted.messageId, submitted.conversationId], ['message-1', 'conversation-1']);
  const [call] = ghl.sends();
  assert.equal(call.headers['Idempotency-Key'], 'egc-msg-key-1');
  assert.ok(call.signal instanceof AbortSignal);
  assert.deepEqual(call.body, { type: 'SMS', contactId: 'contact-1', message: 'Synthetic message', status: 'pending', toNumber: '+19705550123' });
});

test('attachments are passed through and invalid attachments are refused before any call', async () => {
  const ghl = fakeGhl(), attachments = ['https://files.example.invalid/invoice-1001.pdf'];
  await messenger(ghl).send({ type: 'Email', contactId: 'contact-1', message: 'See attached', subject: 'Invoice', emailTo: 'synthetic@example.invalid', attachments });
  assert.deepEqual(ghl.sends()[0].body.attachments, attachments);
  const refused = fakeGhl();
  for (const bad of [['http://insecure.example.invalid/a.pdf'], ['javascript:alert(1)'], Array(11).fill(attachments[0])]) {
    assert.equal((await messenger(refused).send({ type: 'SMS', contactId: 'contact-1', message: 'x', attachments: bad })).reason, 'invalid_attachment');
  }
  assert.equal(refused.calls.length, 0);
});

test('email HTML is escaped when the caller does not supply rendered HTML', async () => {
  const ghl = fakeGhl();
  await messenger(ghl).send({ type: 'Email', contactId: 'contact-1', subject: 'Hello', emailTo: 'synthetic@example.invalid', message: 'Hi <b>"Sam"</b> & co\nline two\n\n<script>alert(1)</script>' });
  const { html, emailTo, subject } = ghl.sends()[0].body;
  assert.equal(html, '<p>Hi &lt;b&gt;&quot;Sam&quot;&lt;/b&gt; &amp; co<br>line two</p><p>&lt;script&gt;alert(1)&lt;/script&gt;</p>');
  assert.equal(emailTo, 'synthetic@example.invalid'); assert.equal(subject, 'Hello');
  assert.equal(emailHtml("it's"), '<p>it&#39;s</p>');
  assert.equal(maskRecipient('SMS', '+19705550123'), '(•••) •••-0123');
});

test('unconfigured or malformed sends never reach HighLevel', async () => {
  const ghl = fakeGhl();
  assert.equal((await messenger(ghl, { HIGHLEVEL_LOCATION_ID: '' }).send({ type: 'SMS', contactId: 'contact-1', message: 'x' })).reason, 'not_configured');
  assert.equal((await messenger(ghl).send({ type: 'Fax', contactId: 'contact-1', message: 'x' })).reason, 'invalid_message');
  assert.equal((await messenger(ghl).send({ type: 'SMS', contactId: 'contact-1', message: '   ' })).reason, 'invalid_message');
  assert.equal(ghl.calls.length, 0);
});
