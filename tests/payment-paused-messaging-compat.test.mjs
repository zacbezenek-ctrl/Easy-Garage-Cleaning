// Compatibility of canonical payment callbacks with a paused server scheduler.
// This does not turn on the held payment-tag or eager portal-link PRs. All
// payment-provider reads are injected, and the shared Firestore fake rejects
// every external host, so no contact, message, charge or task can be created.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { stripeWebhookHandlers } from '../functions/api/stripe-webhook.js';
import { dispatchStorage } from '../functions/_lib/dispatch-storage.js';
import { customerMoneyState } from '../functions/_lib/customer-payments.js';
import { customerMoneyTotals, paymentLedger } from '../functions/_lib/money-core.js';
import { dueMessages, runDueMessages } from '../functions/_lib/messaging-scheduler.js';
import { normalizeMessagingSettings } from '../functions/_lib/messaging-settings.js';
import { FUNNEL_EVENTS_COLLECTION } from '../functions/_lib/funnel-events.js';
import { crewDayFirestore } from './helpers/crew-day-firestore.mjs';

const NOW = '2026-10-19T18:00:00.000Z';
const ENV = {
  FIREBASE_API_KEY: 'firebase-test-paused-payment',
  STRIPE_WEBHOOK_SECRET: 'whsec_synthetic_paused_payment',
  MONEY_API_ENABLED: 'true', FUNNEL_PAYMENT_EVENTS_ENABLED: 'true',
  // This flag stays off in the compatibility fixture, as it does at its review gate.
  EGC_GHL_TAG_OUTBOX: 'false',
};
const JOB = {
  type: 'job', customer: 'Synthetic Customer', customerId: 'synthetic-customer',
  highlevelContactId: 'synthetic-contact', phone: '+19705550123', email: 'synthetic@example.invalid',
  total: 1000, date: '2026-10-22', time: '09:30', endTime: '12:30',
  status: 'scheduled', pipelineStatus: 'scheduled', notify: true, customerAutomationEnabled: true,
  estimate: { status: 'accepted', amount: 1000, revision: 2, depositRequired: 250 },
  customerApproval: { status: 'approved', amount: 1000 },
  invoice: { number: 'SYNTHETIC-1', amount: 1000, status: 'issued', dueDate: '2026-10-22' },
  customerPortalInvitationRequestedAt: '2026-10-19T17:00:00.000Z',
};

function fixture(t, { completed = false, losePaymentCommit = false } = {}) {
  const fire = crewDayFirestore(t), sessions = new Map(), providerReads = [], forbiddenCalls = [];
  let lostResponses = 0;
  fire.put('jobs/synthetic-job', { ...JOB, ...(completed ? {
    status: 'completed', pipelineStatus: 'completed', completedAt: '2026-10-19T17:00:00.000Z',
    fieldExecution: { completion: { completedAt: '2026-10-19T17:00:00.000Z', notes: 'Synthetic completed work' } },
    fieldCompletionSync: { status: 'pending', requestId: '00000000-0000-4000-8000-000000000001' },
  } : {}) });
  fire.put('messaging_settings/automation', { paused: true });
  if (losePaymentCommit) {
    const serve = fire.fetch;
    t.mock.method(globalThis, 'fetch', async (url, init) => {
      const response = await serve(url, init);
      if (losePaymentCommit && new URL(url).pathname.endsWith('/documents:commit') && String(init?.body).includes('stripeSessions')) {
        losePaymentCommit = false;
        lostResponses++;
        throw new TypeError('Synthetic lost response after the payment commit');
      }
      return response;
    });
  }
  const webhook = stripeWebhookHandlers({ now: () => new Date(NOW), readCheckout: async (_env, id) => {
    providerReads.push(id);
    assert.ok(sessions.has(id), 'only a known synthetic checkout may be read');
    return structuredClone(sessions.get(id));
  } });
  const forbidden = name => async () => { forbiddenCalls.push(name); throw new Error(`Paused scheduler invoked ${name}`); };
  const scheduler = () => runDueMessages({
    store: dispatchStorage(ENV), flags: { enabled: true, dryRun: false },
    service: { preview: forbidden('preview'), send: forbidden('send') },
    portalInvite: forbidden('portalInvite'), crewOutbox: { pending: forbidden('crewOutbox') },
  }, { now: new Date(NOW), dryRun: false });
  function session(id, amount, purpose) {
    sessions.set(id, {
      id, object: 'checkout.session', mode: 'payment', status: 'complete', payment_status: 'paid',
      currency: 'usd', amount_total: amount, livemode: false, client_reference_id: 'synthetic-job',
      metadata: { kind: 'egc_customer_portal_payment', job_id: 'synthetic-job', payment_purpose: purpose, quote_revision: '2', quoted_total_cents: '100000' },
      payment_intent: { id: `pi_${id}`, created: Date.parse(NOW) / 1000 - 60,
        latest_charge: { id: `ch_${id}`, created: Date.parse(NOW) / 1000 - 30, payment_method_details: { type: 'card' } } },
    });
  }
  async function callback(id, { type = 'checkout.session.completed', signatureValid = true } = {}) {
    const expanded = sessions.get(id), raw = JSON.stringify({ id: `evt_${id}_${type}`, type,
      data: { object: { ...expanded, payment_intent: expanded?.payment_intent.id } } });
    const timestamp = Date.parse(NOW) / 1000;
    const signature = createHmac('sha256', ENV.STRIPE_WEBHOOK_SECRET).update(`${timestamp}.${raw}`).digest('hex');
    const response = await webhook.post({ env: ENV, request: new Request('https://easygaragecleaning.com/api/stripe-webhook', {
      method: 'POST', headers: { 'Stripe-Signature': `t=${timestamp},v1=${signatureValid ? signature : '0'.repeat(64)}` }, body: raw,
    }) });
    return { status: response.status, body: await response.json() };
  }
  return { fire, sessions, providerReads, forbiddenCalls, scheduler, session, callback, lostResponses: () => lostResponses, job: () => fire.get('jobs/synthetic-job') };
}

test('paused scheduling never sends while concurrent deposit callbacks record one payment and stop deposit reminders', async t => {
  const f = fixture(t);
  const selection = () => dueMessages([f.job()], { now: new Date(NOW), settings: normalizeMessagingSettings(null), kinds: new Set(['deposit_reminder']) });
  assert.equal(selection().due.length, 1, 'the unpaid approved deposit would otherwise need a reminder');
  assert.equal((await f.scheduler()).paused, true);
  f.session('cs_test_pause_deposit', 25000, 'deposit');
  const callbacks = await Promise.all([
    f.callback('cs_test_pause_deposit'), f.callback('cs_test_pause_deposit'),
    f.callback('cs_test_pause_deposit', { type: 'checkout.session.async_payment_succeeded' }),
  ]);
  assert.ok(callbacks.every(result => result.status === 200), JSON.stringify(callbacks));
  assert.equal(f.job().payment.stripeSessions.length, 1);
  assert.deepEqual([customerMoneyState(f.job()).balance, customerMoneyTotals(f.job(), { unified: true }).balanceCents], [750, 75000]);
  assert.equal(paymentLedger(f.job()).entries.length, 1);
  assert.equal(selection().due.length, 0, 'payment state prevents stale deposit chasing even before another messaging tick');
  assert.equal((await f.scheduler()).paused, true);
  assert.deepEqual(f.forbiddenCalls, []);
  assert.deepEqual(f.fire.refused, []);
});

test('a lost balance-payment response under pause recovers once without reopening completion or creating follow-ups', async t => {
  const f = fixture(t, { completed: true, losePaymentCommit: true });
  const originalCompletion = structuredClone(f.job().fieldExecution.completion);
  f.session('cs_test_pause_balance', 100000, 'balance');
  const first = await f.callback('cs_test_pause_balance');
  assert.equal(first.status, 200);
  assert.equal(f.lostResponses(), 1);
  assert.equal(first.body.duplicate, true, 'the callback finds the committed payment after its reply was lost');
  const again = await f.callback('cs_test_pause_balance', { type: 'checkout.session.async_payment_succeeded' });
  assert.deepEqual([again.status, again.body.duplicate], [200, true]);
  assert.deepEqual([customerMoneyState(f.job()).balance, customerMoneyTotals(f.job(), { unified: true }).balanceCents], [0, 0]);
  assert.equal(f.job().payment.stripeSessions.length, 1);
  assert.equal(f.fire.list(FUNNEL_EVENTS_COLLECTION).filter(event => event.type === 'payment.received').length, 1);
  assert.deepEqual(f.job().fieldExecution.completion, originalCompletion);
  assert.equal(f.job().fieldCompletionSync.status, 'pending', 'recording money cannot pretend the CRM handoff succeeded');
  assert.equal((await f.scheduler()).paused, true);
  assert.deepEqual(f.forbiddenCalls, []);
  assert.deepEqual(f.fire.refused, []);
});

test('an invalid payment callback cannot bypass the pause or change money', async t => {
  const f = fixture(t), before = structuredClone(f.job());
  f.session('cs_test_pause_invalid', 25000, 'deposit');
  const response = await f.callback('cs_test_pause_invalid', { signatureValid: false });
  assert.equal(response.status, 400);
  assert.deepEqual(f.providerReads, []);
  assert.deepEqual(f.job(), before);
  assert.equal((await f.scheduler()).paused, true);
  assert.deepEqual(f.forbiddenCalls, []);
});

test('unreadable pause settings stop messaging without rolling back a durable payment', async t => {
  const f = fixture(t);
  f.fire.put('messaging_settings/automation', { paused: 'not-a-boolean' });
  f.session('cs_test_pause_settings', 25000, 'deposit');
  assert.equal((await f.callback('cs_test_pause_settings')).status, 200);
  await assert.rejects(f.scheduler, { code: 'messaging_settings_invalid' });
  assert.equal(f.job().payment.stripeSessions.length, 1);
  assert.equal(customerMoneyState(f.job()).balance, 750);
  assert.deepEqual(f.forbiddenCalls, []);
});
