import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { getHubUserProfile } from '../functions/_lib/hub-session.js';
import { fieldPaymentHandlers } from '../functions/api/field-payments.js';
import { customerPaymentNeedsReview } from '../functions/_lib/customer-payments.js';
import { mutateMoney } from '../functions/_lib/money-service.js';

const ORIGIN = 'https://easygaragecleaning.com', NOW = '2026-09-29T18:00:00.000Z';
const jpeg = Buffer.from([255, 216, 255, 224, 0, 16, 74, 70, 73, 70, 0, 1, 255, 217]);
const photo = `data:image/jpeg;base64,${jpeg.toString('base64')}`;
const env = { FIREBASE_API_KEY: 'firebase-test-field-pay', EGC_FIELD_PAY_ENABLED: 'true', MONEY_API_ENABLED: 'true', MONEY_UNIFIED_TOTALS: 'true', MONEY_INVOICE_STATE_ENABLED: 'true', HUB_AUTH_USERS_JSON: JSON.stringify({
  ZacB: { role: 'owner', displayName: 'Synthetic Owner', passwordHash: 'synthetic' },
  'Lead.One': { role: 'crew', displayName: 'Synthetic Lead', passwordHash: 'synthetic' },
  'Crew.Two': { role: 'crew', displayName: 'Synthetic Member', passwordHash: 'synthetic' },
  'Away.One': { role: 'crew', displayName: 'Synthetic Away', passwordHash: 'synthetic' },
}) };

function memory(initial = {}) {
  const docs = new Map([['jobs/job-1', { id: 'job-1', type: 'job', status: 'completed', pipelineStatus: 'completed', customer: 'Synthetic Customer', total: 100, payment: { amount: 0, verified: true }, assignedCrew: ['lead.one', 'crew.two'], crewLead: 'lead.one', ...initial, revision: 'v1' }]]);
  let sequence = 1, lose = false;
  const store = {
    totalsMode: 'unified', invoiceState: true, paymentEvents: false,
    read: async (collection, id) => structuredClone(docs.get(`${collection}/${id}`) || null),
    async commit(writes) {
      for (const write of writes) {
        const previous = docs.get(`${write.collection}/${write.id}`);
        if (write.revision && previous?.revision !== write.revision || write.exists === false && previous || write.exists === true && !previous) throw Object.assign(new Error('Synthetic stale revision'), { code: 'money_revision_conflict', status: 409 });
      }
      for (const write of writes) {
        const key = `${write.collection}/${write.id}`, previous = docs.get(key);
        if (write.delete === true) { if (write.exists !== false) docs.delete(key); continue; }
        const next = { ...(previous || {}), ...structuredClone(write.patch), id: write.id, revision: `v${++sequence}` };
        for (const path of write.remove || []) delete next[path];
        docs.set(key, next);
      }
      if (lose) { lose = false; throw Object.assign(new Error('Synthetic lost reply'), { code: 'money_outcome_unknown', status: 503 }); }
      return {};
    },
  };
  return { docs, store, job: () => docs.get('jobs/job-1'), loseReply: () => { lose = true; }, edit: patch => { docs.set('jobs/job-1', { ...docs.get('jobs/job-1'), ...patch, revision: `v${++sequence}` }); } };
}

function fixture(initial = {}, environment = env) {
  const data = memory(initial), handlers = fieldPaymentHandlers({ session: request => getHubUserProfile(environment, request.headers.get('X-Test-User')), storage: () => data.store, hold: async () => false, now: () => new Date(NOW) });
  const get = async (user, query = '?job_id=job-1') => handlers.get({ env: environment, request: new Request(`${ORIGIN}/api/field-payments${query}`, { headers: { 'X-Test-User': user, Origin: ORIGIN } }) });
  const post = async (user, body) => handlers.post({ env: environment, request: new Request(`${ORIGIN}/api/field-payments`, { method: 'POST', headers: { 'X-Test-User': user, Origin: ORIGIN, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
  const submit = (body = {}, user = 'Lead.One') => post(user, { action: 'submit', jobId: 'job-1', requestId: randomUUID(), expectedBalanceCents: 10000, method: 'cash', amountCents: 10000, reference: 'Receipt 101', receiptDataUrl: photo, ...body });
  const review = (submission, action, body = {}, user = 'ZacB') => post(user, { action, jobId: 'job-1', submissionId: submission.id, requestId: randomUUID(), expectedRevision: submission.revision, ...(action === 'reject' ? { reason: 'Customer did not provide cash' } : {}), ...body });
  return { ...data, get, post, submit, review };
}

const body = async response => ({ status: response.status, ...(await response.json()) });

test('only the current assigned lead can view and submit; feature flag off cannot start a collection', async () => {
  const f = fixture();
  const view = await body(await f.get('Lead.One'));
  assert.equal(view.status, 200); assert.equal(view.balanceCents, 10000); assert.equal(view.capabilities.submit, true); assert.equal(view.capabilities.review, false);
  assert.equal((await f.get('Crew.Two')).status, 403);
  assert.equal((await f.get('Away.One')).status, 403);
  assert.equal((await f.submit({}, 'Crew.Two')).status, 403);
  const off = fixture({}, { ...env, EGC_FIELD_PAY_ENABLED: '' });
  assert.equal((await body(await off.get('Lead.One'))).enabled, false);
  assert.equal((await off.submit()).status, 404);
  assert.equal(off.docs.size, 1);
  for (const visits of ['', 'true']) {
    const removed = fixture({ assignedCrew: ['crew.two'], crewLead: 'lead.one' }, { ...env, FIELD_MULTIDAY_VISITS: visits });
    assert.equal((await removed.get('Lead.One')).status, 403, `stale named lead cannot read with visits=${visits || 'off'}`);
    assert.equal((await removed.submit()).status, 403, `stale named lead cannot submit with visits=${visits || 'off'}`);
  }
});

test('exact balance stays integer cents across fractional dollars and malformed money fails closed', async () => {
  for (const [total, cents] of [[1.15, 115], [19.99, 1999], [999999.99, 99999999]]) {
    const f = fixture({ total });
    assert.equal((await body(await f.get('Lead.One'))).balanceCents, cents);
    assert.equal((await f.submit({ expectedBalanceCents: cents, amountCents: cents })).status, 200);
  }
  const bad = fixture({ total: 'not money' });
  const view = await body(await bad.get('Lead.One'));
  assert.equal(view.balanceCents, null); assert.equal(view.capabilities.submit, false);
  assert.equal((await bad.submit()).status, 409);
});

test('partial cash receipt is private, pending does not enter money, and manager accepts exactly once', async () => {
  const f = fixture(), requestId = randomUUID();
  const submitted = await body(await f.submit({ requestId, amountCents: 4000, method: 'check', reference: 'CHK-400' }));
  assert.equal(submitted.status, 200); assert.equal(submitted.submissions[0].status, 'pending'); assert.equal(submitted.balanceCents, 10000);
  assert.equal(f.job().payment.amount, 0); assert.equal(customerPaymentNeedsReview(f.job()), true);
  assert.equal(f.docs.has(`fieldPaymentReceipts/${requestId}`), true);
  const replay = await body(await f.submit({ requestId, amountCents: 4000, method: 'check', reference: 'CHK-400' }));
  assert.equal(replay.alreadyApplied, true); assert.equal(f.docs.size, 3);
  assert.equal((await f.get('Lead.One', `?job_id=job-1&receipt_id=${requestId}`)).status, 403);
  const receipt = await f.get('ZacB', `?job_id=job-1&receipt_id=${requestId}`);
  assert.equal(receipt.status, 200); assert.equal(receipt.headers.get('Content-Type'), 'image/jpeg'); assert.deepEqual(Buffer.from(await receipt.arrayBuffer()), jpeg);
  const row = (await body(await f.get('ZacB'))).submissions[0], approval = randomUUID();
  const accepted = await body(await f.review(row, 'accept', { requestId: approval }));
  assert.equal(accepted.status, 200); assert.equal(accepted.submissions[0].status, 'accepted'); assert.equal(accepted.balanceCents, 6000);
  assert.equal(accepted.crmSynced, false, 'missing CRM configuration never rolls back verified money');
  assert.deepEqual(accepted.syncPending.map(item => item.sourceId), [requestId]);
  assert.equal(f.job().fieldPaymentPendingId, null); assert.equal(f.job().payment.amount, 40);
  assert.equal(f.job().paymentLedger.filter(item => item.id === `offline:${approval}`).length, 1);
  assert.equal(f.docs.get(`moneyOperations/${approval}`).action, 'payment.record_offline');
  const retry = await body(await f.post('ZacB', { action: 'sync_payment', jobId: 'job-1', requestId: randomUUID(), kind: 'receipt', sourceId: requestId }));
  assert.equal(retry.status, 200); assert.equal(retry.crmSynced, false);
  assert.equal(f.job().payment.amount, 40); assert.equal(f.job().paymentLedger.filter(item => item.id === `offline:${approval}`).length, 1);
  const again = await body(await f.review(row, 'accept', { requestId: approval }));
  assert.equal(again.status, 200); assert.equal(again.alreadyApplied, true); assert.equal(f.job().payment.amount, 40);
  const second = await body(await f.submit({ amountCents: 2000, expectedBalanceCents: 6000 }));
  assert.equal(second.status, 200); assert.equal(second.submissions[0].status, 'pending');
  const oldReplay = await body(await f.review(row, 'accept', { requestId: approval }));
  assert.equal(oldReplay.status, 200); assert.equal(oldReplay.alreadyApplied, true); assert.equal(f.job().payment.amount, 40);
  assert.equal(f.job().paymentLedger.filter(item => item.id === `offline:${approval}`).length, 1, 'replaying an older accepted review after a new receipt cannot pay twice');
});

test('an exact card lock blocks direct manager money mutations until the checkout is settled or cancelled', async () => {
  const f = fixture({ fieldPaymentCardRequestId: randomUUID() });
  const actor = getHubUserProfile(env, 'ZacB');
  for (const [action, extra] of [['payment.record_offline', { amountCents: 100, method: 'cash', reference: 'Cash 101' }], ['estimate.save', { lineItems: [], scope: 'Changed scope', depositCents: 0 }]]) {
    await assert.rejects(mutateMoney(f.store, actor, { action, jobId: 'job-1', requestId: randomUUID(), expectedRevision: f.job().revision, ...extra }, NOW), error => /field_card_checkout_open/.test(error.code || ''), action);
  }
  assert.equal(f.job().payment.amount, 0);
});

test('a confirmed held card review permits fenced manager money reconciliation, while an open unreviewed card does not', async () => {
  const requestId = randomUUID(), f = fixture({ fieldPaymentCardRequestId: requestId });
  const actor = getHubUserProfile(env, 'ZacB'), base = { action: 'payment.record_offline', jobId: 'job-1', requestId: randomUUID(), expectedRevision: f.job().revision, amountCents: 3000, method: 'check', reference: 'Held charge review' };
  await assert.rejects(mutateMoney(f.store, actor, base, NOW), error => /field_card_checkout_open/.test(error.code || ''));
  f.docs.set('fieldPaymentCardCheckouts/job-1', { id: 'job-1', jobId: 'job-1', requestId, status: 'open', sessionId: 'cs_test_held_field', revision: 'v-card' });
  f.docs.set('payment_reviews/cs_test_held_field', { id: 'cs_test_held_field', jobId: 'job-1', sessionId: 'cs_test_held_field', kind: 'egc_job_payment', status: 'open', revision: 'v-review' });
  const settled = await mutateMoney(f.store, actor, base, NOW);
  assert.equal(settled.ok, true); assert.equal(f.job().payment.amount, 30);
  assert.equal(f.docs.get('payment_reviews/cs_test_held_field').fieldPaymentMoneyGuardAt, NOW);
  assert.equal(f.job().fieldPaymentCardRequestId, requestId, 'owner review still holds the next collection');
  f.docs.get('payment_reviews/cs_test_held_field').status = 'resolved';
  await assert.rejects(mutateMoney(f.store, actor, { ...base, requestId: randomUUID(), expectedRevision: f.job().revision }, NOW), error => /field_card_checkout_open/.test(error.code || ''));
});

test('rejected evidence never pays, and a changed balance cannot be silently accepted', async () => {
  const f = fixture();
  await f.submit({ amountCents: 6000 });
  const row = (await body(await f.get('ZacB'))).submissions[0];
  const denied = await body(await f.review(row, 'accept', {}, 'Crew.Two'));
  assert.equal(denied.status, 403);
  f.edit({ payment: { amount: 20, verified: true } });
  assert.equal((await body(await f.review(row, 'accept'))).code, 'FIELD_PAY_BALANCE_CHANGED');
  assert.equal(f.job().payment.amount, 20);
  const rejected = await body(await f.review(row, 'reject'));
  assert.equal(rejected.status, 200); assert.equal(rejected.submissions[0].status, 'rejected');
  assert.equal(f.job().payment.amount, 20); assert.equal(f.job().fieldPaymentPendingId, null);
});

test('lost submit response replays one private receipt and malformed or oversized photos save nothing', async () => {
  const f = fixture(); f.loseReply();
  const result = await body(await f.submit());
  assert.equal(result.status, 200); assert.equal(result.alreadyApplied, true); assert.equal(f.docs.size, 3);
  const other = fixture();
  assert.equal((await other.submit({ receiptDataUrl: 'data:image/jpeg;base64,SGVsbG8gd29ybGQ=' })).status, 400);
  const huge = Buffer.alloc(400001, 1); huge[0] = 255; huge[1] = 216; huge[2] = 255;
  assert.equal((await other.submit({ receiptDataUrl: `data:image/jpeg;base64,${huge.toString('base64')}` })).status, 413);
  assert.equal(other.docs.size, 1);
});

test('turning off intake keeps existing evidence reviewable but accepting requires unified money prerequisites', async () => {
  const f = fixture(); await f.submit();
  const row = (await body(await f.get('ZacB'))).submissions[0];
  const disabled = { ...env, EGC_FIELD_PAY_ENABLED: '', MONEY_API_ENABLED: '' }, handlers = fieldPaymentHandlers({ session: request => getHubUserProfile(disabled, request.headers.get('X-Test-User')), storage: () => f.store, now: () => new Date(NOW) });
  const post = (action, extra = {}) => handlers.post({ env: disabled, request: new Request(`${ORIGIN}/api/field-payments`, { method: 'POST', headers: { 'X-Test-User': 'ZacB', Origin: ORIGIN, 'Content-Type': 'application/json' }, body: JSON.stringify({ action, jobId: 'job-1', submissionId: row.id, expectedRevision: row.revision, requestId: randomUUID(), ...(action === 'reject' ? { reason: 'Unable to verify receipt' } : {}), ...extra }) }) });
  assert.equal((await body(await post('accept'))).code, 'FIELD_PAY_MONEY_UNAVAILABLE');
  const receipt = await handlers.get({ env: disabled, request: new Request(`${ORIGIN}/api/field-payments?job_id=job-1&receipt_id=${row.id}`, { headers: { 'X-Test-User': 'ZacB', Origin: ORIGIN } }) });
  assert.equal(receipt.status, 200);
  assert.equal((await body(await post('reject'))).submissions[0].status, 'rejected');
  assert.equal(f.job().payment.amount, 0);
});
