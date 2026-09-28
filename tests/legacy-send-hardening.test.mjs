// LEGACY-SEND: the legacy customer send paths (Hub/crew thread SMS, portal
// replies mirrored to HighLevel, crew Quo scripts, the sales follow-up exit
// lookups) never double-send, never text a DND/opted-out contact and never read
// the real clock. Synthetic data only; every external host is faked.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createHubSessionCookie } from '../functions/_lib/hub-session.js';
import { encodeFirestoreFields, decodeFirestoreFields } from '../functions/_lib/firestore-job.js';
import { conversationMessages, deliverHighLevelMessage, threadIdempotencyKey, DELIVERY_STATUSES } from '../functions/_lib/customer-messaging.js';
import { customerIdentityStorage, phoneSpellings, emailSpellings } from '../functions/_lib/customer-identity.js';
import { crewJobsHandlers } from '../functions/api/crew-jobs.js';
import { quoSendHandlers, fillPlaceholders, renderScript, savedCrewSize, savedJobTime } from '../functions/api/quo-send.js';
import { extractEnvReferences } from '../scripts/env-inventory.mjs';
import { fakeGhl, clock } from './helpers/messaging-fixture.mjs';
import { NOW as PORTAL_NOW, env as portalEnv, portalStore, portalCookie, portalHandlers, portalView, portalPost } from './helpers/portal-fixture.mjs';

const NOW = '2026-09-22T12:00:00.000Z';
const origin = 'https://easygaragecleaning.com';
const ghlEnv = { HIGHLEVEL_API_KEY: 'ghl-synthetic-key', HIGHLEVEL_LOCATION_ID: 'location-1' };
const JOB = { id: 'job-1', type: 'job', customer: 'Synthetic Customer', phone: '(970) 555-0123', highlevelContactId: 'contact-1', highlevelAppointmentId: 'appointment-1' };
const deliver = (ghl, job = JOB, input = {}, env = ghlEnv) => deliverHighLevelMessage(env, job, { body: 'Synthetic crew update', direction: 'to_customer', requestId: 'crew-request-0001', ...input }, { fetcher: ghl.fetcher, clock: clock(NOW) });

test('a customer text carries a stable Idempotency-Key, a 15 s timeout, the verified number and the injected clock', async t => {
  const timeouts = [], timeout = AbortSignal.timeout.bind(AbortSignal);
  t.mock.method(AbortSignal, 'timeout', ms => { timeouts.push(ms); return timeout(ms); });
  const ghl = fakeGhl(), result = await deliver(ghl);
  assert.deepEqual(timeouts, [15000, 15000], 'the contact check and the send are both bounded');
  assert.deepEqual(result, { channel: 'sms', status: 'sent', attemptedAt: NOW, messageId: 'message-1', conversationId: 'conversation-1' });
  assert.deepEqual(ghl.calls.map(call => [call.method, call.path]), [['GET', '/contacts/contact-1'], ['POST', '/conversations/messages']]);
  const [send] = ghl.sends();
  assert.deepEqual(send.body, { type: 'SMS', contactId: 'contact-1', message: 'Synthetic crew update', status: 'pending', toNumber: '+19705550123', appointmentId: 'appointment-1' });
  assert.ok(send.signal instanceof AbortSignal, 'the send has a timeout signal');
  const key = await threadIdempotencyKey(JOB, 'to_customer', 'crew-request-0001');
  assert.match(key, /^egc-thread-[0-9a-f]{64}$/);
  assert.equal(send.headers['Idempotency-Key'], key);
  assert.equal(key, await threadIdempotencyKey({ ...JOB }, 'to_customer', 'crew-request-0001'), 'the same request always maps to the same key');
  const others = await Promise.all([[JOB, 'to_customer', 'crew-request-0002'], [{ ...JOB, id: 'job-2' }, 'to_customer', 'crew-request-0001'], [JOB, 'from_customer', 'crew-request-0001']].map(args => threadIdempotencyKey(...args)));
  assert.equal(new Set([key, ...others]).size, 4, 'keys differ per request, job and direction');
  assert.equal(await threadIdempotencyKey(JOB, 'to_customer', 'bad'), '');
  const unkeyed = fakeGhl();
  await deliver(unkeyed, JOB, { requestId: '' });
  assert.equal('Idempotency-Key' in unkeyed.sends()[0].headers, false, 'no key is invented without a request id');
});

test('ambiguous HighLevel responses are uncertain; only definite 4xx rejections are failed', async () => {
  const uncertain = [{ sendStatus: 500 }, { sendStatus: 502 }, { sendStatus: 503 }, { sendStatus: 408 }, { sendThrows: true }, { sendStatus: 200, sendBody: {} }, { sendStatus: 201, sendBody: { conversationId: 'conversation-1' } }];
  for (const options of uncertain) {
    const ghl = fakeGhl(options), result = await deliver(ghl);
    assert.equal(result.status, 'uncertain', JSON.stringify(options));
    assert.equal(result.attemptedAt, NOW);
    assert.equal(ghl.sends().length, 1, 'one attempt, never an automatic resend');
  }
  const timeout = { fetcher: async (url, options) => { if (String(url).includes('/contacts/')) return fakeGhl().fetcher(url, options); throw new DOMException('The operation timed out.', 'TimeoutError'); } };
  assert.equal((await deliver(timeout)).status, 'uncertain', 'a 15 s timeout may have delivered');
  for (const sendStatus of [400, 401, 403, 404, 422, 429]) assert.equal((await deliver(fakeGhl({ sendStatus }))).status, 'failed', String(sendStatus));
  assert.ok(DELIVERY_STATUSES.includes('uncertain') && DELIVERY_STATUSES.includes('suppressed'));
  const [row] = conversationMessages({ customerConversation: [{ id: 'm1', body: 'Synthetic', createdAt: NOW, direction: 'to_customer', delivery: { channel: 'sms', status: 'uncertain', attemptedAt: NOW } }] });
  assert.equal(row.delivery.status, 'uncertain', 'the thread keeps the uncertain state instead of downgrading it');
  assert.equal(conversationMessages({ customerConversation: [{ ...row, delivery: { status: 'suppressed' } }] })[0].delivery.status, 'suppressed');
  assert.equal(conversationMessages({ customerConversation: [{ ...row, delivery: { status: 'mystery' } }] })[0].delivery.status, 'received');
});

test('DND, SMS consent and saved-identity checks run before any customer text is sent', async () => {
  const cases = [
    [{ contact: { dnd: true } }, JOB, 'suppressed'],
    [{ contact: { dndSettings: { SMS: { status: 'active' } } } }, JOB, 'suppressed'],
    [{ contact: { tags: ['egc-no-sms-consent'] } }, JOB, 'suppressed'],
    [{ contact: { phone: '+19705559999' } }, JOB, 'needs_contact'],
    [{ contact: { locationId: 'location-2' } }, JOB, 'needs_contact'],
    [{ contacts: {} }, JOB, 'needs_contact'],
    [{}, { ...JOB, phone: '' }, 'needs_contact'],
  ];
  for (const [options, job, status] of cases) {
    const ghl = fakeGhl(options), result = await deliver(ghl, job);
    assert.equal(result.status, status, JSON.stringify(options));
    assert.equal(ghl.sends().length, 0, 'nothing is sent to a blocked recipient');
  }
  const outage = fakeGhl(); outage.state.contactStatus = 503;
  assert.equal((await deliver(outage)).status, 'failed', 'a contact check outage is a definite not-sent');
  assert.equal(outage.sends().length, 0);
  const none = fakeGhl();
  assert.equal((await deliver(none, { ...JOB, highlevelContactId: '' })).status, 'needs_contact');
  assert.equal((await deliver(none, JOB, {}, { HIGHLEVEL_API_KEY: 'ghl-synthetic-key' })).status, 'not_configured', 'the location is required to verify the contact');
  assert.equal((await deliver(none, JOB, {}, {})).status, 'not_configured');
  assert.equal(none.calls.length, 0);
});

test('portal replies mirror to HighLevel as internal comments with a key and no DND lookup', async () => {
  const ghl = fakeGhl({ contact: { dnd: true } });
  const result = await deliver(ghl, JOB, { direction: 'from_customer', body: 'Synthetic side door is open', requestId: 'portal-request-0001' });
  assert.equal(result.status, 'sent'); assert.equal(result.channel, 'highlevel');
  assert.deepEqual(ghl.calls.map(call => call.path), ['/conversations/messages'], 'an internal note is not a customer text');
  assert.equal(ghl.sends()[0].body.type, 'InternalComment');
  assert.equal(ghl.sends()[0].body.toNumber, undefined);
  assert.equal(ghl.sends()[0].headers['Idempotency-Key'], await threadIdempotencyKey(JOB, 'from_customer', 'portal-request-0001'));
  assert.equal((await deliver(fakeGhl({ sendStatus: 504 }), JOB, { direction: 'from_customer' })).status, 'uncertain');
});

// Firestore job document emulation (updateTime preconditions) for /api/crew-jobs.
function crewFixture(t, job, ghlOptions = {}) {
  const ghl = fakeGhl(ghlOptions);
  let stored = structuredClone(job), revision = 1;
  const doc = () => ({ name: 'projects/egcw-1ec83/databases/(default)/documents/jobs/job-1', fields: encodeFirestoreFields(stored), updateTime: `2026-09-22T12:00:00.00000${revision}Z` });
  t.mock.method(globalThis, 'fetch', async (input, options = {}) => {
    const url = new URL(input);
    if (url.hostname === 'services.leadconnectorhq.com') return ghl.fetcher(input, options);
    assert.equal(url.hostname, 'firestore.googleapis.com', 'no other host may be contacted');
    assert.ok(url.pathname.endsWith('/jobs/job-1'));
    if ((options.method || 'GET') === 'PATCH') {
      if (url.searchParams.get('currentDocument.updateTime') !== doc().updateTime) return Response.json({}, { status: 400 });
      stored = { ...stored, ...decodeFirestoreFields(JSON.parse(options.body).fields) }; revision++;
    }
    return Response.json(doc());
  });
  return { ghl, stored: () => stored };
}
const crewEnv = { ...ghlEnv, HUB_SESSION_SECRET: 'synthetic-legacy-send-secret', FIREBASE_API_KEY: 'firebase-test-legacy-send',
  HUB_AUTH_USERS_JSON: JSON.stringify({ 'Crew.One': { passwordHash: 'synthetic-hash', displayName: 'Synthetic Crew', role: 'crew' } }) };
const crewCookie = (await createHubSessionCookie(crewEnv, 'Crew.One')).split(';')[0];
const crewSend = crewJobsHandlers({ now: () => new Date(NOW) }).post;
const crewRequest = (requestId, body = 'Synthetic arriving in 20 minutes') => new Request(`${origin}/api/crew-jobs`, {
  method: 'POST', headers: { Origin: origin, Cookie: crewCookie, 'Content-Type': 'application/json' },
  body: JSON.stringify({ action: 'send_customer_message', jobId: 'job-1', body, requestId, phone: '+15555550199', contactId: 'attacker-contact' }),
});
const crewJob = { type: 'job', customer: 'Synthetic Customer', phone: '(970) 555-0123', highlevelContactId: 'contact-1', assignedCrew: ['Crew.One'], customerConversation: [] };

test('a duplicate crew message request id texts the customer once', async t => {
  const { ghl, stored } = crewFixture(t, crewJob);
  const first = await (await crewSend({ env: crewEnv, request: crewRequest('crew-request-0001') })).json();
  assert.equal(first.message.delivery.status, 'sent');
  assert.equal(first.message.delivery.attemptedAt, NOW);
  const again = await (await crewSend({ env: crewEnv, request: crewRequest('crew-request-0001') })).json();
  assert.equal(again.duplicate, true);
  assert.equal(ghl.sends().length, 1);
  assert.equal(ghl.sends()[0].body.contactId, 'contact-1', 'the saved contact, never the request body');
  assert.equal(ghl.sends()[0].body.toNumber, '+19705550123');
  assert.equal(ghl.sends()[0].headers['Idempotency-Key'], await threadIdempotencyKey({ id: 'job-1' }, 'to_customer', 'crew-request-0001'));
  assert.equal(stored().customerConversation.length, 1);
});

test('an ambiguous HighLevel response is saved as uncertain and a retry of the same request never resends', async t => {
  const { ghl, stored } = crewFixture(t, crewJob, { sendStatus: 503 });
  const response = await crewSend({ env: crewEnv, request: crewRequest('crew-request-0002') });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).message.delivery.status, 'uncertain');
  assert.equal(stored().customerConversation[0].delivery.status, 'uncertain');
  ghl.state.sendStatus = 200;
  const retry = await (await crewSend({ env: crewEnv, request: crewRequest('crew-request-0002') })).json();
  assert.equal(retry.duplicate, true);
  assert.equal(retry.job.customerConversation[0].delivery.status, 'uncertain');
  assert.equal(ghl.sends().length, 1, 'uncertain is never re-sent automatically');
});

test('a crew message to a DND contact is kept in the thread as suppressed and never sent', async t => {
  const { ghl, stored } = crewFixture(t, crewJob, { contact: { dnd: true } });
  const result = await (await crewSend({ env: crewEnv, request: crewRequest('crew-request-0003') })).json();
  assert.equal(result.message.delivery.status, 'suppressed');
  assert.equal(stored().customerConversation[0].delivery.status, 'suppressed');
  assert.equal(ghl.sends().length, 0);
});

test('the Hub thread labels uncertain and suppressed deliveries so staff do not resend blindly', () => {
  const suite = readFileSync(new URL('../employee-suite.js', import.meta.url), 'utf8');
  const source = suite.slice(suite.indexOf('function customerConversation('), suite.indexOf('window.opsSendCustomerMessage='));
  const context = vm.createContext({ esc: value => String(value ?? '').replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`), timeLabel: () => '6:00 AM' });
  vm.runInContext(`${source};globalThis.list=customerMessageList;`, context);
  const message = (id, status) => ({ id, direction: 'to_customer', authorName: 'Synthetic Crew', body: `Synthetic ${status}`, createdAt: `${NOW.slice(0, 18)}${id}.000Z`, delivery: { channel: 'sms', status } });
  const html = context.list({ customer: 'Synthetic Customer', customerConversation: ['sent', 'uncertain', 'suppressed', 'failed', 'needs_contact'].map((status, index) => message(String(index), status)) });
  const labels = [...html.matchAll(/<em>([^<]*)<\/em>/g)].map(match => match[1]);
  assert.deepEqual(labels, ['SMS sent', 'Saved · SMS may have sent · check HighLevel before resending', 'Saved · Not texted · customer opted out', 'Saved · SMS needs retry', 'Saved · Not texted · check the job phone and HighLevel contact']);
  // The thread header claims SMS only when both the contact link and the saved job phone exist.
  const line = suite.split(/\r?\n/).find(row => row.startsWith('function customerThread('));
  vm.runInContext(`const badge=(text,tone='')=>'<span class="'+tone+'">'+text+'</span>';var S={};${line};globalThis.thread=customerThread;`, context);
  const header = job => context.thread({ id: 'job-1', customer: 'Synthetic Customer', customerConversation: [], ...job }).match(/<span class="(good|warn)">([^<]*)<\/span>/).slice(1);
  assert.deepEqual(header({ highlevelContactId: 'contact-1', phone: '(970) 555-0123' }), ['good', 'SMS connected']);
  assert.deepEqual(header({ highlevelContactId: 'contact-1', phone: ' ' }), ['warn', 'Portal only']);
  assert.deepEqual(header({ phone: '(970) 555-0123' }), ['warn', 'Portal only']);
});

test('bounded job lookups use IN for spellings, read only identity fields and fail closed on stray rows', async () => {
  const calls = [];
  const doc = (id, fields) => ({ document: { name: `projects/egcw-1ec83/databases/(default)/documents/jobs/${id}`, fields: encodeFirestoreFields(fields), updateTime: NOW } });
  let rows = [doc('job-1', { type: 'job', phone: '970-555-0123' }), doc('_egc_schedule_lock_2026-09-22', { phone: '970-555-0123' })];
  const store = customerIdentityStorage({}, async (env, url, init) => { calls.push(JSON.parse(init.body).structuredQuery); return Response.json(rows); });
  const spellings = phoneSpellings('(970) 555-0123');
  assert.ok(spellings.length <= 30 && ['(970) 555-0123', '9705550123', '+19705550123', '970-555-0123', '970.555.0123'].every(value => spellings.includes(value)));
  assert.deepEqual(emailSpellings(' Synthetic@Example.invalid '), ['Synthetic@Example.invalid', 'synthetic@example.invalid']);
  const found = await store.queryJobsByField('phone', spellings, { fields: ['type', 'status'], limit: 100 });
  assert.deepEqual(found.map(row => row.id), ['job-1', '_egc_schedule_lock_2026-09-22'], 'private rows are returned for the caller to skip');
  assert.equal(calls[0].where.fieldFilter.op, 'IN');
  assert.deepEqual(calls[0].where.fieldFilter.value.arrayValue.values.map(value => value.stringValue), spellings);
  assert.deepEqual(calls[0].select.fields.map(field => field.fieldPath), ['type', 'status', 'phone']);
  assert.equal(calls[0].limit, 100);
  rows = [doc('job-1', { highlevelContactId: 'contact-1' })];
  await store.queryJobsByField('highlevelContactId', 'contact-1');
  assert.deepEqual(calls[1].where.fieldFilter, { field: { fieldPath: 'highlevelContactId' }, op: 'EQUAL', value: { stringValue: 'contact-1' } });
  rows = [doc('job-9', { highlevelContactId: 'contact-2' })];
  await assert.rejects(store.queryJobsByField('highlevelContactId', 'contact-1'), error => error.code === 'customer_identity_storage_incomplete');
  for (const [field, values] of [['notes', 'x'], ['highlevelContactId', '../x'], ['customerId', 'secure_vault'], ['phone', []], ['phone', Array.from({ length: 31 }, (_, i) => `97055501${String(i).padStart(2, '0')}`)]]) {
    await assert.rejects(store.queryJobsByField(field, values), error => error.code === 'customer_identity_query_invalid', field);
  }
  assert.equal(calls.length, 3, 'invalid lookups never reach storage');
});

test('the confirmation script renders the saved start time and crew size instead of literal placeholders', () => {
  const job = { customer: 'Dana Synthetic', total: 450, time: '13:30', crewNeeded: 3, assignedCrew: ['a', 'b'] };
  assert.equal(savedJobTime(job), '1:30 PM');
  assert.equal(savedCrewSize(job), '3');
  assert.equal(savedCrewSize({ assignedCrew: ['a', 'b'] }), '2', 'falls back to the assigned crew');
  assert.equal(savedCrewSize({ crewSize: 0 }), '');
  assert.equal(savedJobTime({ time: '25:00' }), '');
  const script = "Hi [NAME], it's Easy Garage Cleaning — confirming your garage comeback tomorrow at [TIME]. Crew of [N], we'll knock when we arrive. Flat rate locked at $[RATE] like we agreed — nothing changes. Reply C to confirm. — Alex";
  const rendered = renderScript(job, { message: script });
  assert.equal(rendered.message, script.replace('[NAME]', 'Dana').replace('[TIME]', '1:30 PM').replace('[N]', '3').replace('[RATE]', '450'));
  assert.deepEqual(rendered.missing, []);
  assert.deepEqual(renderScript({ customer: 'Dana Synthetic', total: 450 }, { template: 'confirmation' }).missing, ['TIME', 'N']);
  assert.equal(renderScript(job, { message: script.replace('[N]', '4') }), null, 'a crew size other than the saved one is off-script');
  assert.deepEqual(fillPlaceholders(job, 'Synthetic see you at [TIME] with [N] crew'), { message: 'Synthetic see you at 1:30 PM with 3 crew', missing: [] });
  assert.deepEqual(fillPlaceholders({}, 'Synthetic at [TIME] for $[RATE]').missing.sort(), ['RATE', 'TIME']);
});

// Firestore receipts and jobs plus a Quo stub, as in quo-send-idempotency.test.mjs.
function quoFixture(t, job) {
  const docs = new Map(), quo = [];
  let revision = 0;
  const put = (path, data) => { const saved = { name: `projects/egcw-1ec83/databases/(default)/documents/${path}`, fields: encodeFirestoreFields(data), updateTime: `2026-09-22T12:00:00.${String(++revision).padStart(6, '0')}Z` }; docs.set(path, saved); return saved; };
  put('jobs/job-1', job);
  t.mock.method(globalThis, 'fetch', async (input, options = {}) => {
    const url = new URL(input), method = options.method || 'GET';
    if (url.hostname === 'api.openphone.com') { quo.push(JSON.parse(options.body)); return Response.json({ data: { id: `synthetic-quo-${quo.length}` } }); }
    assert.equal(url.hostname, 'firestore.googleapis.com');
    const path = decodeURIComponent(url.pathname.split('/documents/')[1]), existing = docs.get(path);
    if (method === 'GET') return existing ? Response.json(existing) : Response.json({}, { status: 404 });
    if (url.searchParams.get('currentDocument.exists') === 'false' && existing) return Response.json({}, { status: 409 });
    const expected = url.searchParams.get('currentDocument.updateTime');
    if (expected && expected !== existing?.updateTime) return Response.json({}, { status: 400 });
    const incoming = decodeFirestoreFields(JSON.parse(options.body).fields), mask = url.searchParams.getAll('updateMask.fieldPaths');
    return Response.json(put(path, mask.length ? { ...decodeFirestoreFields(existing?.fields || {}), ...Object.fromEntries(mask.map(field => [field, incoming[field]])) } : incoming));
  });
  return { quo, docs };
}
const quoUsers = { ZacB: { passwordHash: 'synthetic-hash', displayName: 'Synthetic Owner', role: 'owner' }, 'Crew.One': { passwordHash: 'synthetic-hash', displayName: 'Synthetic Crew', role: 'crew' } };
const quoEnv = { HUB_SESSION_SECRET: 'synthetic-legacy-quo-secret', HUB_AUTH_USERS_JSON: JSON.stringify(quoUsers), FIREBASE_API_KEY: 'firebase-test-legacy-quo', QUO_API_KEY: 'synthetic-quo-key' };
const quoCookies = Object.fromEntries(await Promise.all(Object.keys(quoUsers).map(async user => [user, (await createHubSessionCookie(quoEnv, user)).split(';')[0]])));
const quoSend = quoSendHandlers({ now: () => new Date(NOW) }).post;
const quoRequest = (user, body, key) => new Request(`${origin}/api/quo-send`, { method: 'POST', headers: { Origin: origin, Cookie: quoCookies[user], 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify({ job_id: 'job-1', idempotency_key: key, ...body }) });
const PAGE_CONFIRMATION = "Hi Dana, it's Easy Garage Cleaning — confirming your garage comeback tomorrow at [TIME]. Crew of [N], we'll knock when we arrive. Flat rate locked at $450 like we agreed — nothing changes. Reply C to confirm. — Alex";
const quoJob = { type: 'job', customer: 'Dana Synthetic', phone: '(970) 555-0100', address: '746 Synthetic Grass Ln', total: 450, date: '2026-09-23', time: '08:30', crewSize: 2, assignedCrew: ['Crew.One'] };

test('a duplicate quo-send key sends the rendered confirmation once and never a literal placeholder', async t => {
  const { quo } = quoFixture(t, quoJob);
  for (let i = 0; i < 3; i++) assert.equal((await quoSend({ env: quoEnv, request: quoRequest('Crew.One', { message: PAGE_CONFIRMATION }, 'prejob-confirmation:job-1:synthetic-1') })).status, 200);
  assert.equal(quo.length, 1);
  assert.equal(quo[0].content, PAGE_CONFIRMATION.replace('[TIME]', '8:30 AM').replace('[N]', '2'));
  assert.doesNotMatch(quo[0].content, /\[(TIME|N|RATE|NAME|ADDRESS)\]/);
});

test('a confirmation for a job without a saved time or crew is refused for crew and managers before Quo', async t => {
  const { quo, docs } = quoFixture(t, { ...quoJob, time: '', crewSize: null, assignedCrew: [] });
  docs.set('jobs/job-1', { ...docs.get('jobs/job-1'), fields: encodeFirestoreFields({ ...quoJob, time: '', crewSize: null, assignedCrew: [] }) });
  let n = 0;
  for (const [user, body] of [['ZacB', { message: PAGE_CONFIRMATION }], ['ZacB', { message: 'Synthetic see you tomorrow at [TIME]' }], ['ZacB', { template: 'confirmation' }]]) {
    const response = await quoSend({ env: quoEnv, request: quoRequest(user, body, `synthetic-missing-${++n}`) });
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.equal((await response.json()).code, 'QUO_SEND_SCHEDULE_UNAVAILABLE');
  }
  assert.equal(quo.length, 0);
  assert.equal([...docs.keys()].filter(path => path.startsWith('messageReceipts/')).length, 0, 'a refused text claims no receipt');
  assert.equal((await quoSend({ env: quoEnv, request: quoRequest('ZacB', { message: 'Synthetic manager update without placeholders' }, 'synthetic-free-form') })).status, 200, 'business free-form texts still send');
  assert.equal(quo.length, 1);
});

test('refusals tell crew to ask a manager and tell managers what to save or type', async t => {
  const { quo, docs } = quoFixture(t, { ...quoJob, total: '', time: '' });
  const refusal = async (user, body, key) => (await quoSend({ env: quoEnv, request: quoRequest(user, body, key) })).json();
  const crewRate = await refusal('Crew.One', { message: PAGE_CONFIRMATION.replace('$450', '$[RATE]') }, 'synthetic-copy-1');
  const managerRate = await refusal('ZacB', { message: PAGE_CONFIRMATION.replace('$450', '$[RATE]') }, 'synthetic-copy-2');
  assert.equal(crewRate.code, 'QUO_SEND_RATE_UNAVAILABLE'); assert.equal(managerRate.code, 'QUO_SEND_RATE_UNAVAILABLE');
  assert.match(crewRate.error, /Ask a manager/);
  assert.doesNotMatch(managerRate.error, /Ask a manager/, 'a manager is not told to ask a manager');
  assert.match(managerRate.error, /Save the flat rate on the job, or type the amount in place of \[RATE\]/);
  docs.set('jobs/job-1', { ...docs.get('jobs/job-1'), fields: encodeFirestoreFields({ ...quoJob, time: '' }) });
  const crewTime = await refusal('Crew.One', { message: PAGE_CONFIRMATION }, 'synthetic-copy-3');
  const managerTime = await refusal('ZacB', { message: PAGE_CONFIRMATION }, 'synthetic-copy-4');
  assert.equal(crewTime.code, 'QUO_SEND_SCHEDULE_UNAVAILABLE'); assert.equal(managerTime.code, 'QUO_SEND_SCHEDULE_UNAVAILABLE');
  assert.match(crewTime.error, /Ask a manager to save them on the job/);
  assert.match(managerTime.error, /Save them on the job, or type them in place of \[TIME\] and \[N\]/);
  assert.equal(quo.length, 0);
});

test('the confirmation says "tomorrow", so it is sent only the day before the saved job date in Denver', async t => {
  const { quo, docs } = quoFixture(t, quoJob);
  const at = now => quoSendHandlers({ now: () => new Date(now) }).post;
  const setDate = date => docs.set('jobs/job-1', { ...docs.get('jobs/job-1'), fields: encodeFirestoreFields({ ...quoJob, date }) });
  let n = 0;
  const attempt = (user, body, now = NOW) => at(now)({ env: quoEnv, request: quoRequest(user, body, `synthetic-day-${++n}`) });
  for (const date of ['2026-09-22', '2026-09-24', '', '09/23/2026']) {
    setDate(date);
    for (const [user, body] of [['Crew.One', { message: PAGE_CONFIRMATION }], ['Crew.One', { template: 'confirmation' }], ['ZacB', { message: PAGE_CONFIRMATION }]]) {
      const response = await attempt(user, body), result = await response.json();
      assert.equal(response.status, 400, `${date} ${user}`);
      assert.equal(result.code, 'QUO_SEND_CONFIRMATION_DATE_MISMATCH');
      assert.match(result.error, /not saved for tomorrow/);
      assert.equal(/your own wording/.test(result.error), user === 'ZacB');
    }
    assert.equal((await attempt('Crew.One', { template: 'arrival' })).status, 200, 'the arrival text has no day in it');
    assert.equal((await attempt('ZacB', { message: 'Synthetic see you Thursday at [TIME]' })).status, 200, 'a manager\'s own wording is not the script');
  }
  assert.equal(quo.length, 8);
  assert.ok(quo.every(body => !body.content.includes('comeback tomorrow')), 'no wrong-day confirmation reached Quo');
  setDate('2026-09-23');
  // 05:30 UTC on the 23rd is still the evening of the 22nd in Denver.
  assert.equal((await attempt('Crew.One', { message: PAGE_CONFIRMATION }, '2026-09-23T05:30:00.000Z')).status, 200);
  assert.equal((await attempt('Crew.One', { template: 'confirmation' }, '2026-09-23T06:30:00.000Z')).status, 400, 'after midnight in Denver it is the job day');
  assert.equal(quo.length, 9);
  assert.match(quo.at(-1).content, /comeback tomorrow at 8:30 AM\. Crew of 2,/);
});

test('a portal approval records the sales exit with the portal handler clock', async t => {
  const f = portalStore(t, { 'job-1': { type: 'job', customer: 'Synthetic Customer', customerId: 'customer-1', address: '100 Synthetic Street', serviceType: 'Garage Turnaround', total: 800, status: 'scheduled', estimate: { number: 'EST-1', status: 'sent', amount: 800, revision: 2, validUntil: '2026-10-01' } } });
  const jobs = globalThis.fetch, handoffs = [];
  // The sales-exit ledger is its own server-only collection; everything else is the portal job store.
  t.mock.method(globalThis, 'fetch', async (input, options = {}) => {
    const url = new URL(input);
    if (!url.pathname.includes('/sales_handoffs/')) return jobs(input, options);
    handoffs.push(options.method || 'GET');
    return Response.json({}, { status: 404 });
  });
  const testEnv = { ...portalEnv, ...ghlEnv }, handlers = portalHandlers(), cookie = await portalCookie();
  const shown = (await portalView(handlers, cookie, testEnv)).body.estimate;
  const approved = await portalPost(handlers, cookie, { action: 'approve_estimate', signed_name: 'Synthetic Customer', confirmed: true, estimate_revision: shown.revision, amount_cents: 80000, estimate_fingerprint: shown.fingerprint }, testEnv);
  assert.equal(approved.status, 200);
  assert.deepEqual(approved.body.salesFollowupExit, { status: 'needs_review', reason: 'contact_not_linked', checkedAt: PORTAL_NOW });
  assert.equal(f.job('job-1').salesFollowupExit.checkedAt, PORTAL_NOW, 'the mirrored exit uses the injected clock, not the real one');
  assert.deepEqual(handoffs, ['GET']);
  assert.equal(f.calls.some(call => call.host !== 'firestore.googleapis.com'), false, 'an unlinked contact is never contacted');
});

test('the messaging owner setup doc covers every env var the customer send paths read', () => {
  const doc = readFileSync(new URL('../docs/messaging-owner-setup.md', import.meta.url), 'utf8');
  const sources = ['functions/_lib/customer-messaging.js', 'functions/_lib/ghl-messenger.js', 'functions/_lib/approved-send.js', 'functions/_lib/portal-invitation.js',
    'functions/_lib/sales-followup-exit.js', 'functions/api/messages.js', 'functions/api/quo-send.js', 'functions/api/crew-hook.js', 'functions/api/highlevel-message-event.js'];
  const names = new Set(sources.flatMap(path => extractEnvReferences(readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')).flatMap(reference => reference.names)));
  for (const name of ['HIGHLEVEL_API_KEY', 'HIGHLEVEL_LOCATION_ID', 'EGC_MESSAGING_ENABLED', 'EGC_MESSAGING_DRY_RUN', 'QUO_API_KEY']) assert.ok(names.has(name), `inventory sanity: ${name}`);
  const example = readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
  for (const name of example.match(/^(?:# )?EGC_MESSAGING_[A-Z_]+(?==)/gm).map(line => line.replace(/^# /, ''))) names.add(name);
  for (const name of names) assert.match(doc, new RegExp(`\`${name}\``), `docs/messaging-owner-setup.md must document ${name}`);
  for (const topic of ['A2P 10DLC', 'Private integration', 'InboundMessage', 'Idempotency-Key', 'uncertain', 'Railway', 'dry run']) assert.match(doc, new RegExp(topic, 'i'), topic);
  assert.match(readFileSync(new URL('../docs/portal-invitations.md', import.meta.url), 'utf8'), /\(messaging-owner-setup\.md\)/, 'the portal invitation doc links the owner setup');
});
