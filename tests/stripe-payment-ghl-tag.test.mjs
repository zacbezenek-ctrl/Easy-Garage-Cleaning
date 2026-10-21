// Online portal payments reach HighLevel through the GHL-TRACK-1 tag outbox: with EGC_GHL_TAG_OUTBOX on, the Stripe
// webhook that records (or finds recorded) a customer-portal payment queues one entry keyed on the checkout session,
// carrying the tag a manager's save of the same money adds (egc-deposit-received or egc-payment-received) and an
// internal note; the drain then tells HighLevel. A Firestore REST fake (updateTime/exists preconditions), a fake
// Stripe and a recording HighLevel stand in for every service. Synthetic data, fixed clock, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { encodeFirestoreFields, decodeFirestoreFields } from '../functions/_lib/firestore-job.js';
import { GHL_TAG_OUTBOX, drainGhlTagOutbox, ghlTagEntryId, ghlTagOutboxStorage, paymentTagWrites } from '../functions/_lib/ghl-tag-outbox.js';
import { stripeWebhookHandlers } from '../functions/api/stripe-webhook.js';
import { recordingHighLevel } from './helpers/highlevel-recorder.mjs';

const NOW = '2026-09-22T18:00:00.000Z', origin = 'https://easygaragecleaning.com';
const base = {
  FIREBASE_API_KEY: 'firebase-test-stripe-ghl-tag', STRIPE_SECRET_KEY: 'sk_test_synthetic_ghl_tag', STRIPE_WEBHOOK_SECRET: 'whsec_synthetic_ghl_tag',
  HIGHLEVEL_API_KEY: 'synthetic-ghl-key', HIGHLEVEL_LOCATION_ID: 'location-1',
};
const ON = { ...base, EGC_GHL_TAG_OUTBOX: 'true' };
const seconds = at => Date.parse(at) / 1000;
const portalJob = (extra = {}) => ({ type: 'job', customer: 'Synthetic Portal Customer', email: 'synthetic@example.invalid', phone: '+1 (970) 555-0123', customerId: 'c1', highlevelContactId: 'contact-1',
  date: '2026-09-24', status: 'scheduled', total: 1000, estimate: { status: 'accepted', amount: 1000, revision: 2, depositRequired: 250 }, customerApproval: { status: 'approved', amount: 1000 }, ...extra });
const metadata = purpose => ({ kind: 'egc_customer_portal_payment', job_id: 'job-portal', payment_purpose: purpose, quote_revision: '2', quoted_total_cents: '100000' });

function fixture(t, { job = portalJob(), env = ON } = {}) {
  const docs = new Map([['jobs/job-portal', { value: structuredClone(job), version: 1 }]]), sessions = new Map(), ghl = recordingHighLevel();
  let outboxDown = false, outboxCommits = 0;
  const version = row => `2026-09-22T00:00:00.${String(row.version).padStart(6, '0')}Z`;
  const named = name => decodeURIComponent(name.split('/documents/')[1]);
  const doc = (path, row) => ({ name: `projects/egcw-1ec83/databases/(default)/documents/${path}`, fields: encodeFirestoreFields(row.value), updateTime: version(row) });
  t.mock.method(globalThis, 'fetch', async (input, options = {}) => {
    const url = new URL(String(input)), method = options.method || 'GET';
    if (url.hostname === 'services.leadconnectorhq.com') return ghl.fetcher(input, options);
    if (url.hostname === 'firestore.googleapis.com') {
      if (url.pathname.endsWith('/documents:commit')) {
        const { writes } = JSON.parse(options.body);
        const outbox = writes.some(write => named(write.update.name).startsWith(`${GHL_TAG_OUTBOX}/`));
        if (outbox && outboxDown) return Response.json({ error: { code: 503, status: 'UNAVAILABLE' } }, { status: 503 });
        for (const write of writes) {
          const row = docs.get(named(write.update.name)), want = write.currentDocument;
          if (want.updateTime ? !row || want.updateTime !== version(row) : want.exists === false && row) return Response.json({ error: { code: row && !want.updateTime ? 409 : 400, status: row && !want.updateTime ? 'ALREADY_EXISTS' : 'FAILED_PRECONDITION' } }, { status: row && !want.updateTime ? 409 : 400 });
        }
        for (const write of writes) {
          const path = named(write.update.name), row = docs.get(path), fields = decodeFirestoreFields(write.update.fields);
          docs.set(path, { value: { ...(row?.value || {}), ...Object.fromEntries(write.updateMask.fieldPaths.map(field => [field, fields[field]])) }, version: (row?.version || 0) + 1 });
        }
        if (outbox) outboxCommits++;
        return Response.json({ writeResults: writes.map(() => ({})), commitTime: NOW });
      }
      const path = decodeURIComponent(url.pathname.split('/documents/')[1]); let row = docs.get(path);
      if (method === 'PATCH') {
        if (row ? url.searchParams.get('currentDocument.updateTime') !== version(row) : url.searchParams.get('currentDocument.exists') !== 'false') return Response.json({ error: { code: 400, status: 'FAILED_PRECONDITION' } }, { status: 400 });
        row = { value: { ...(row?.value || {}), ...decodeFirestoreFields(JSON.parse(options.body).fields) }, version: (row?.version || 0) + 1 }; docs.set(path, row);
      }
      return row ? Response.json(doc(path, row)) : Response.json({}, { status: 404 });
    }
    if (url.hostname === 'api.stripe.com') {
      const session = sessions.get(url.pathname.split('/')[4]);
      return session ? Response.json(session) : Response.json({}, { status: 404 });
    }
    throw new Error(`Unexpected request ${url.hostname}${url.pathname}`);
  });
  const webhook = stripeWebhookHandlers({ now: () => new Date(NOW) });
  let events = 0;
  return {
    docs, ghl,
    job: () => docs.get('jobs/job-portal').value,
    entries: () => [...docs].filter(([key]) => key.startsWith(`${GHL_TAG_OUTBOX}/`)).map(([key, row]) => ({ id: key.split('/')[1], ...row.value })),
    outboxCommits: () => outboxCommits, outboxDown: value => { outboxDown = value; },
    // A paid portal checkout as Stripe returns it with its charge expanded.
    paid(id, amountCents, purpose) {
      sessions.set(id, { id, object: 'checkout.session', mode: 'payment', status: 'complete', payment_status: 'paid', currency: 'usd', livemode: false, amount_total: amountCents, client_reference_id: 'job-portal', metadata: metadata(purpose),
        customer_details: { email: 'synthetic@example.invalid' }, payment_intent: { id: `pi_${id.slice(3)}`, created: seconds(NOW) - 60, latest_charge: { id: `ch_${id.slice(3)}`, created: seconds(NOW) - 30, receipt_url: `https://pay.stripe.com/receipts/${id}`, payment_method_details: { type: 'card' } } } });
    },
    async event(id, { type = 'checkout.session.completed', environment = env, waitUntil } = {}) {
      const object = { ...sessions.get(id), payment_intent: sessions.get(id).payment_intent.id };
      const timestamp = seconds(NOW), raw = JSON.stringify({ id: `evt_synthetic_ghl_tag_${++events}`, type, created: timestamp, data: { object } });
      const signature = createHmac('sha256', environment.STRIPE_WEBHOOK_SECRET).update(`${timestamp}.${raw}`).digest('hex');
      const response = await webhook.post({ env: environment, waitUntil, request: new Request(`${origin}/api/stripe-webhook`, { method: 'POST', headers: { 'Stripe-Signature': `t=${timestamp},v1=${signature}` }, body: raw }) });
      return { status: response.status, body: await response.json() };
    },
    drain: (ids, environment = env) => drainGhlTagOutbox(ghlTagOutboxStorage(environment), { env: environment, now: NOW, ids, fetcher: ghl.fetcher }),
  };
}

test('a portal deposit paid online queues egc-deposit-received once and the drain adds it with an internal note, no stage or message', async t => {
  const f = fixture(t), id = 'cs_test_portal_deposit_1';
  f.paid(id, 25000, 'deposit');
  const first = await f.event(id);
  assert.deepEqual([first.status, first.body], [200, { ok: true, received: true, recorded: true, duplicate: false, highLevel: 'queued' }]);
  const [entry] = f.entries();
  assert.equal(entry.id, await ghlTagEntryId('job-portal', `stripe-payment:${id}`), 'keyed on the job and the checkout session');
  assert.deepEqual({ kind: entry.kind, addTags: entry.addTags, appointmentStatus: entry.appointmentStatus, opportunityStage: entry.opportunityStage, status: entry.status, attempts: entry.attempts, expect: entry.expect, sessionId: entry.sessionId, paymentPurpose: entry.paymentPurpose, noteTitle: entry.noteTitle, source: entry.source },
    { kind: 'payment_received', addTags: ['egc-deposit-received'], appointmentStatus: null, opportunityStage: null, status: 'pending', attempts: 0, expect: { state: 'payment', sessionId: id }, sessionId: id, paymentPurpose: 'deposit', noteTitle: 'EGC Lifecycle — deposit-received', source: 'stripe_webhook' });
  assert.match(entry.note, /^Deposit received online \$250\.00 \(Stripe, customer portal\)\./);
  assert.equal('ghlTagEntry' in f.job(), false, 'the visit keeps its schedule pointer');
  assert.equal(f.ghl.calls.length, 0, 'nothing reaches HighLevel without waitUntil until the drain');
  const summary = await f.drain([entry.id]);
  assert.deepEqual([summary.attempted, summary.done], [1, 1]);
  assert.deepEqual(f.ghl.lines(), ['POST /contacts/contact-1/notes', 'POST /contacts/contact-1/tags']);
  assert.deepEqual(f.ghl.tags()[0].body.tags, ['egc-deposit-received']);
  assert.equal(f.ghl.calls[0].body.title, 'EGC Lifecycle — deposit-received');
  assert.equal(f.ghl.calls[0].headers['Idempotency-Key'], entry.id);
  assert.ok(!f.ghl.calls.some(call => /opportunit|conversations|appointments/.test(call.path)), 'no stage move, appointment or message');
  assert.equal(f.entries()[0].status, 'done');
});

test('the balance queues egc-payment-received; a replay and the async event queue nothing more', async t => {
  const f = fixture(t, { job: portalJob({ payment: { amount: 250, verified: true, stripeSessions: [{ sessionId: 'cs_test_portal_dep_old', paymentIntentId: 'pi_old', amount: 250, purpose: 'deposit', verifiedAt: '2026-09-10T15:00:00.000Z' }] } }) }), id = 'cs_test_portal_balance_1';
  f.paid(id, 75000, 'balance');
  assert.equal((await f.event(id)).body.highLevel, 'queued');
  const replay = await f.event(id), async = await f.event(id, { type: 'checkout.session.async_payment_succeeded' });
  assert.deepEqual([replay.body.duplicate, replay.body.highLevel, async.body.duplicate, async.body.highLevel], [true, 'duplicate', true, 'duplicate']);
  assert.equal(f.entries().length, 1, 'one entry for the session, whatever Stripe redelivers');
  assert.equal(f.outboxCommits(), 1);
  const [entry] = f.entries();
  assert.deepEqual([entry.addTags, entry.paymentPurpose, entry.noteTitle], [['egc-payment-received'], 'balance', 'EGC Lifecycle — payment-received']);
  await f.drain([entry.id]); await f.drain([entry.id]);
  assert.deepEqual(f.ghl.tags().map(call => call.body.tags), [['egc-payment-received']], 'told once');
});

test('with waitUntil the first attempt runs in the background right after the save', async t => {
  const f = fixture(t), id = 'cs_test_portal_deposit_bg', pending = [];
  f.paid(id, 25000, 'deposit');
  assert.equal((await f.event(id, { waitUntil: promise => pending.push(promise) })).body.highLevel, 'queued');
  assert.equal(pending.length, 1);
  await Promise.all(pending);
  assert.deepEqual(f.ghl.tags().map(call => call.body.tags), [['egc-deposit-received']]);
  assert.equal(f.entries()[0].status, 'done');
});

test('with the outbox off the payment is recorded exactly as before: no entry, no HighLevel request, the same answer', async t => {
  const f = fixture(t, { env: base }), id = 'cs_test_portal_deposit_off', pending = [];
  f.paid(id, 25000, 'deposit');
  const response = await f.event(id, { waitUntil: promise => pending.push(promise) });
  assert.deepEqual([response.status, response.body], [200, { ok: true, received: true, recorded: true, duplicate: false }]);
  assert.equal(f.job().payment.stripeSessions[0].sessionId, id);
  assert.deepEqual([f.entries().length, f.outboxCommits(), pending.length, f.ghl.calls.length], [0, 0, 0, 0]);
});

test('a failed queue write never fails the recorded payment; the next delivery queues it once', async t => {
  const f = fixture(t), id = 'cs_test_portal_deposit_down';
  f.paid(id, 25000, 'deposit');
  const logged = t.mock.method(console, 'error', () => {});
  f.outboxDown(true);
  const failed = await f.event(id);
  assert.deepEqual([failed.status, failed.body], [200, { ok: true, received: true, recorded: true, duplicate: false, highLevel: 'queue_failed' }], 'Stripe gets its 200: the payment is durable');
  assert.equal(f.job().payment.stripeSessions[0].sessionId, id);
  assert.equal(f.entries().length, 0);
  assert.equal(logged.mock.callCount(), 1);
  assert.deepEqual(JSON.parse(logged.mock.calls[0].arguments[0]), { event: 'ghl_payment_tag_queue_failed', jobId: 'job-portal', sessionId: id, code: 'dispatch_outcome_unknown' });
  f.outboxDown(false);
  const redelivered = await f.event(id);
  assert.deepEqual([redelivered.body.duplicate, redelivered.body.highLevel], [true, 'queued']);
  assert.equal(f.entries().length, 1);
});

test('a notify-off job gets the note without the tag, as the manager save suppresses it', async t => {
  const f = fixture(t, { job: portalJob({ notify: false }) }), id = 'cs_test_portal_deposit_quiet';
  f.paid(id, 25000, 'deposit');
  await f.event(id);
  const [entry] = f.entries();
  assert.deepEqual(entry.addTags, []);
  await f.drain([entry.id]);
  assert.deepEqual(f.ghl.lines(), ['POST /contacts/contact-1/notes']);
});

test('only a session the job recorded as verified money is queued', async () => {
  const job = portalJob({ payment: { amount: 250, verified: true, stripeSessions: [{ sessionId: 'cs_test_known', amount: 250, purpose: 'deposit' }] } });
  assert.equal(await paymentTagWrites({ jobId: 'job-portal', job, sessionId: 'cs_test_unknown', now: NOW }), null);
  assert.equal(await paymentTagWrites({ jobId: 'job-portal', job: { ...job, payment: { ...job.payment, verified: false } }, sessionId: 'cs_test_known', now: NOW }), null);
  assert.equal(await paymentTagWrites({ jobId: 'job/portal', job, sessionId: 'cs_test_known', now: NOW }), null);
  assert.ok(await paymentTagWrites({ jobId: 'job-portal', job, sessionId: 'cs_test_known', now: NOW }));
});
