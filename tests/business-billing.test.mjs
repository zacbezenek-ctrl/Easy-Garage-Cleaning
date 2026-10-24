import test from 'node:test';
import assert from 'node:assert/strict';
import { uid } from '../functions/_lib/business-hub-core.js';
import { resolveBusinessBillingRecipient } from '../functions/_lib/business-hub-billing.js';
import { billingFixture } from './helpers/business-billing-fixture.mjs';

async function portfolio() {
  const h = billingFixture(), a = await h.account();
  const north = await h.project(a, 'north', 120.11), south = await h.project(a, 'south', 230.22);
  const payer = await h.member(a, 'billing');
  const contact = { action: 'set_billing_contact', memberId: payer.id, requestId: uid() };
  assert.equal((await h.call(contact, a.cookie)).status, 200);
  return { h, a, north, south, payer, contact };
}
test('billing contact is explicit, active, scoped and cannot widen a role', async () => {
  const { h, a, north, payer, contact } = await portfolio();
  const saved = await h.store.read('business_accounts', a.id);
  assert.equal(resolveBusinessBillingRecipient(saved, north).memberId, payer.id);
  assert.equal((await h.call(contact, a.cookie)).data.duplicate, true);
  for (const role of ['manager', 'viewer']) {
    const m = await h.member(a, role);
    assert.equal((await h.call({ ...contact, memberId: m.id, requestId: uid() }, a.cookie)).status, 409);
    assert.equal((await h.call({ ...contact, requestId: uid() }, m.cookie)).status, 403);
    assert.equal((await h.call(null, m.cookie)).data.billing, undefined);
  }
  assert.equal((await h.call({ ...contact, requestId: uid() }, payer.cookie)).status, 403);
  await h.call({ action: 'revoke_member', memberId: payer.id }, a.cookie);
  assert.equal(resolveBusinessBillingRecipient(await h.store.read('business_accounts', a.id), north), null);
});
test('account route requires all-property access; scoped payer can receive only an explicit property route', async () => {
  const { h, a, north, south } = await portfolio(), payer = await h.member(a, 'billing', [north]);
  const contact = { action: 'set_billing_contact', memberId: payer.id, requestId: uid() };
  assert.equal((await h.call(contact, a.cookie)).status, 409);
  assert.equal((await h.call({ ...contact, requestId: uid(), propertyId: south }, a.cookie)).status, 409);
  assert.equal((await h.call({ ...contact, requestId: uid(), propertyId: north }, a.cookie)).status, 200);
  const prepare = { action: 'prepare_business_payment', jobIds: ['north'], requestId: uid() };
  assert.equal((await h.call(prepare, payer.cookie)).status, 201);
  assert.equal((await h.call({ ...prepare, jobIds: ['south'], requestId: uid() }, payer.cookie)).status, 403);
  assert.equal((await h.call({ action: 'prepare_business_payment', jobIds: ['north', 'south'], requestId: uid() }, a.cookie)).status, 409);
});
test('prepared multi-invoice review uses exact canonical totals and records no payment or message', async () => {
  const { h, a, payer } = await portfolio();
  const before = [...h.records].filter(([key]) => key.startsWith('jobs/')).map(([key, row]) => [key, { ...row, _version: undefined }]);
  const input = { action: 'prepare_business_payment', jobIds: ['south', 'north'], amountCents: 1, requestId: uid() };
  const result = await h.call(input, payer.cookie);
  assert.equal(result.status, 201, JSON.stringify(result.data));
  assert.equal(result.data.preparation.totalCents, 35033);
  assert.equal(result.data.preparation.paymentExecutionEnabled, false);
  assert.equal(result.data.preparation.recipient.memberId, payer.id);
  assert.deepEqual(result.data.preparation.invoices.map(row => row.amountCents), [12011, 23022]);
  assert.equal(JSON.stringify(result.data).includes('jobVersion'), false);
  const replay = await h.call({ ...input, jobIds: ['north', 'south'] }, payer.cookie);
  assert.equal(replay.status, 200); assert.equal(replay.data.duplicate, true);
  assert.deepEqual([...h.records].filter(([key]) => key.startsWith('jobs/')).map(([key, row]) => [key, { ...row, _version: undefined }]), before);
  assert.equal([...h.records.keys()].some(key => /message|stripe|outbox/.test(key)), false);
  assert.equal((await h.call(input, a.cookie)).status, 409);
  assert.equal((await h.call({ ...input, jobIds: ['north'] }, payer.cookie)).status, 409);
});
test('repeated cancellation is safe and never refunds or clears invoices', async () => {
  const { h, payer } = await portfolio(), input = { action: 'prepare_business_payment', jobIds: ['north', 'south'], requestId: uid() };
  assert.equal((await h.call(input, payer.cookie)).status, 201);
  const cancel = { action: 'cancel_business_payment', requestId: input.requestId };
  assert.equal((await h.call(cancel, payer.cookie)).status, 200);
  assert.equal((await h.call(cancel, payer.cookie)).data.duplicate, true);
  assert.equal((await h.call(input, payer.cookie)).status, 409);
  assert.equal((await h.store.read('jobs', 'north')).invoice.status, 'issued');
  assert.equal((await h.store.read('jobs', 'north')).payment, undefined);
});
test('changed, cancelled, refunded, pending, draft and malformed invoices fail closed', async () => {
  for (const patch of [
    { status: 'cancelled' }, { invoice: { number: 'INV', status: 'draft' } }, { invoice: { number: 'INV', status: 'issued' } },
    { fieldPaymentPendingId: 'pending' }, { payment: { amount: 10, verified: false } }, { estimate: { amount: 'invalid', status: 'accepted' } },
    { refunds: [{ amount: 10 }] }, { invoice: { number: 'INV', amount: 999, status: 'issued', issuedAt: '2026-10-23T12:00:00Z' } },
    { invoice: { number: 'INV', amount: 999, amountCents: 12011, status: 'issued', issuedAt: '2026-10-23T12:00:00Z' } },
    { invoice: { number: 'INV', amount: 120.111, status: 'issued', issuedAt: '2026-10-23T12:00:00Z' } },
    { status: 'scheduled' },
  ]) {
    const { h, payer } = await portfolio(); await h.change('jobs', 'north', patch);
    const result = await h.call({ action: 'prepare_business_payment', jobIds: ['north'], requestId: uid() }, payer.cookie);
    assert.equal(result.status, 409, JSON.stringify({ patch, result }));
  }
  const { h, payer } = await portfolio(), input = { action: 'prepare_business_payment', jobIds: ['north'], requestId: uid() };
  assert.equal((await h.call(input, payer.cookie)).status, 201);
  await h.change('jobs', 'north', { estimate: { amount: 200, status: 'accepted' } });
  assert.equal((await h.call(input, payer.cookie)).status, 409);
});
test('cross-account, duplicate ids, malformed requests and sales staff cannot prepare payments', async () => {
  const { h, a, payer } = await portfolio(), other = await h.account();
  await h.project(other, 'elsewhere');
  for (const jobIds of [['elsewhere'], ['north', 'north'], [], ['secure_hidden']]) {
    assert.ok([400, 403].includes((await h.call({ action: 'prepare_business_payment', jobIds, requestId: uid() }, payer.cookie)).status));
  }
  assert.equal((await h.call({ action: 'prepare_business_payment', jobIds: ['north'] }, payer.cookie)).status, 400);
  h.setStaff({ user: 'synthetic.owner', role: 'sales', businessAccess: false });
  assert.equal((await h.call({ action: 'prepare_business_payment', jobIds: ['north'], requestId: uid() }, '', a.query)).status, 403);
});
test('a saved review resumes after a lost response and rechecks the current payer and invoice scope', async () => {
  const { h, a, payer, north } = await portfolio(), input = { action: 'prepare_business_payment', jobIds: ['north'], requestId: uid() };
  assert.equal((await h.call(input, payer.cookie)).status, 201);
  const resume = { action: 'review_business_payment', requestId: input.requestId };
  assert.equal((await h.call(resume, payer.cookie)).data.preparation.totalCents, 12011);
  assert.equal((await h.call(resume, a.cookie)).status, 404);
  const other = await h.account(); assert.equal((await h.call(resume, other.cookie)).status, 404);
  const southOnly = (await h.store.read('business_accounts', a.id)).properties.find(p => p.id !== north).id;
  await h.call({ action: 'set_member_properties', memberId: payer.id, propertyIds: [southOnly], requestId: uid() }, a.cookie);
  assert.equal((await h.call(resume, payer.cookie)).status, 403);
});
test('simultaneous double clicks create one prepared review; retry after the race returns it', async () => {
  const { h, payer } = await portfolio(), input = { action: 'prepare_business_payment', jobIds: ['north'], requestId: uid() };
  const results = await Promise.all([h.call(input, payer.cookie), h.call(input, payer.cookie)]);
  assert.equal(results.filter(result => result.status === 201).length, 1);
  assert.ok(results.every(result => [200, 201, 409].includes(result.status)));
  assert.equal((await h.call(input, payer.cookie)).data.duplicate, true);
  assert.equal([...h.records.values()].filter(row => row.action === 'prepare_business_payment' && row.allocation).length, 1);
});
test('a failed atomic preparation leaves no receipt or allocation and the same id can retry', async () => {
  const { h, payer } = await portfolio(), original = h.store.commit;
  let fail = true;
  h.store.commit = async writes => {
    if (fail && writes.some(w => w.data?.action === 'prepare_business_payment' && w.data.allocation)) { fail = false; throw new Error('Synthetic storage interruption'); }
    return original(writes);
  };
  const input = { action: 'prepare_business_payment', jobIds: ['north', 'south'], requestId: uid() };
  assert.equal((await h.call(input, payer.cookie)).status, 503);
  assert.equal(await h.store.read('business_operations', input.requestId), null);
  assert.equal((await h.call(input, payer.cookie)).status, 201);
});
test('a payment landing during preparation cannot be overwritten by the review snapshot', async () => {
  const { h, payer } = await portfolio(), original = h.store.commit;
  let changed = false;
  h.store.commit = async writes => {
    if (!changed && writes.some(w => w.data?.allocation)) {
      changed = true;
      const job = await h.store.read('jobs', 'north');
      await original([{ collection: 'jobs', id: 'north', data: { ...job, payment: { amount: 120.11, verified: true } }, version: job._version }]);
    }
    return original(writes);
  };
  const input = { action: 'prepare_business_payment', jobIds: ['north'], requestId: uid() };
  assert.equal((await h.call(input, payer.cookie)).status, 409);
  assert.equal((await h.store.read('jobs', 'north')).payment.amount, 120.11);
  assert.equal(await h.store.read('business_operations', input.requestId), null);
  assert.equal((await h.call(input, payer.cookie)).status, 409);
});
