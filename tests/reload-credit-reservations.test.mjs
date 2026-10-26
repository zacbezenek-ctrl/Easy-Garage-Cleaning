import test from 'node:test';
import assert from 'node:assert/strict';
import { mappedReloadGrant, planReloadCreditOperation, reloadCreditAvailability } from '../functions/_lib/reload-credit-reservations.js';

const NOW = '2026-10-24T12:00:00.000Z';
const EXPIRY = '2026-10-25T12:00:00.000Z';
const actor = { accountId: 'account_a', customerId: 'customer_a', permissions: { rebook: true } };
const policy = { confirmed: true, version: 'policy_a', reservationExpiry: 'explicit', cancellation: 'release', expiration: 'release' };
function fixture(units = 1, rules = policy) {
  let revision = 1;
  const rows = new Map([['reload_credit_accounts/account_a', { id: 'account_a', customerId: 'customer_a', revision: String(revision), grants: [
    { id: 'grant_a', purchaseJobId: 'purchase_a', purchaseLineId: 'line_a', units, policyVersion: 'policy_a', policy: { version: rules.version, reservationExpiry: rules.reservationExpiry, cancellation: rules.cancellation, expiration: rules.expiration }, paymentState: 'verified', expiresAt: null, reservations: [] },
  ] }]]);
  const store = { read: async (c, id) => structuredClone(rows.get(`${c}/${id}`) || null), commit(writes) {
    for (const w of writes) { const old = rows.get(`${w.collection}/${w.id}`); if (w.exists === false && old || w.revision && old?.revision !== w.revision) throw new Error('Conflict'); }
    for (const w of writes) if (!w.verify) { const key = `${w.collection}/${w.id}`; rows.set(key, { ...(w.data || rows.get(key)), ...w.patch, revision: String(++revision) }); }
  } };
  const input = { actor, accountId: 'account_a', requestId: 'operation_a', action: 'reserve', grantId: 'grant_a', reservationId: 'reservation_a', jobId: 'visit_a', expiresAt: EXPIRY, policy: rules, now: NOW };
  return { store, input, rows, account: () => store.read('reload_credit_accounts', 'account_a'), async run(changes = {}) { const plan = await planReloadCreditOperation(store, { ...input, ...changes }); store.commit(plan.writes); return plan; } };
}
test('lost response and repeated reserve replay the durable receipt without spending twice', async () => {
  const f = fixture(); await f.run(); const replay = await f.run(); assert.equal(replay.result.duplicate, true); assert.equal(replay.writes.length, 0);
  assert.equal(reloadCreditAvailability(await f.account(), actor, NOW)[0].available, 0);
});
test('same request id with changed visit or action is refused', async () => {
  const f = fixture(); await f.run();
  for (const changes of [{ jobId: 'visit_b' }, { action: 'cancel', cancellationConfirmed: true }]) await assert.rejects(() => f.run(changes), { code: 'reload_credit_idempotency_conflict' });
});
test('two concurrent reservations cannot consume the last credit', async () => {
  const f = fixture(); const first = await planReloadCreditOperation(f.store, f.input);
  const secondInput = { ...f.input, requestId: 'operation_b', reservationId: 'reservation_b', jobId: 'visit_b' };
  const second = await planReloadCreditOperation(f.store, secondInput); f.store.commit(first.writes);
  assert.throws(() => f.store.commit(second.writes), /Conflict/);
  await assert.rejects(() => planReloadCreditOperation(f.store, secondInput), { code: 'reload_credit_exhausted' });
});
test('one canonical visit cannot reserve two grants or reservation ids', async () => {
  const f = fixture(2); await f.run();
  await assert.rejects(() => f.run({ requestId: 'other_operation', reservationId: 'other_reservation' }), { code: 'reload_credit_visit_conflict' });
});
test('cross-account, business, and non-rebooking actors cannot read availability or mutate', async () => {
  const f = fixture(); await f.run();
  for (const who of [{ ...actor, customerId: 'other' }, { ...actor, accountId: 'other' }, { ...actor, businessAccountId: 'business' }, { ...actor, permissions: {} }]) {
    assert.throws(() => reloadCreditAvailability(f.rows.get('reload_credit_accounts/account_a'), who, NOW), { status: 403 });
    await assert.rejects(() => f.run({ actor: who }), { status: 403 });
  }
});
test('an unconfirmed or changed policy cannot reserve credits', async () => {
  const f = fixture();
  for (const p of [{}, { ...policy, confirmed: false }, { ...policy, cancellation: 'guess' }]) await assert.rejects(() => f.run({ policy: p }), { code: 'reload_credit_policy_required' });
  await assert.rejects(() => f.run({ policy: { ...policy, version: 'new_policy' } }), { code: 'reload_credit_policy_changed' });
});
test('explicit expiry is required and cannot exceed a purchased entitlement expiry', async () => {
  const f = fixture();
  for (const expiresAt of [null, NOW, 'invalid']) await assert.rejects(() => f.run({ expiresAt }), { code: 'reload_credit_expiry_required' });
  f.rows.get('reload_credit_accounts/account_a').grants[0].expiresAt = '2026-10-25T00:00:00Z';
  await assert.rejects(() => f.run(), { code: 'reload_credit_expiry_required' });
});
test('no-expiry reservations require an explicit owner policy and null expiry', async () => {
  const p = { ...policy, reservationExpiry: 'none' }, f = fixture(1, p);
  await assert.rejects(() => f.run({ policy: p }), { code: 'reload_credit_expiry_required' });
  assert.equal((await f.run({ policy: p, expiresAt: null })).result.status, 'reserved');
});
test('expired holds retain capacity until canonical cancellation is committed', async () => {
  const f = fixture(); await f.run(); const later = '2026-10-26T12:00:00Z';
  assert.equal(reloadCreditAvailability(await f.account(), actor, later)[0].available, 0);
  await assert.rejects(() => f.run({ requestId: 'expire_a', action: 'expire', now: later }), { code: 'reload_credit_cancellation_required' });
  assert.equal((await f.run({ requestId: 'expire_a', action: 'expire', now: later, cancellationConfirmed: true })).result.status, 'released');
  assert.equal(reloadCreditAvailability(await f.account(), actor, later)[0].available, 1);
});
test('a hold cannot be expired early or completed after expiry', async () => {
  const f = fixture(); await f.run();
  await assert.rejects(() => f.run({ requestId: 'expire_a', action: 'expire', cancellationConfirmed: true }), { code: 'reload_credit_not_expired' });
  await assert.rejects(() => f.run({ requestId: 'complete_a', action: 'complete', completionConfirmed: true, now: EXPIRY }), { code: 'reload_credit_expired' });
});
test('completion consumes once; reopened and repeated completion cannot restore a credit', async () => {
  const f = fixture(); await f.run();
  await assert.rejects(() => f.run({ requestId: 'complete_a', action: 'complete' }), { code: 'reload_credit_completion_required' });
  await f.run({ requestId: 'complete_a', action: 'complete', completionConfirmed: true });
  assert.equal((await f.run({ requestId: 'complete_b', action: 'complete', completionConfirmed: true })).result.unchanged, true);
  await assert.rejects(() => f.run({ requestId: 'cancel_a', action: 'cancel', cancellationConfirmed: true }), { code: 'reload_credit_reservation_conflict' });
  assert.equal(reloadCreditAvailability(await f.account(), actor, NOW)[0].available, 0);
});
test('cancellation can release, forfeit, or require review only under explicit policy', async () => {
  for (const cancellation of ['release', 'forfeit', 'review']) {
    const f = fixture(1, { ...policy, cancellation }); await f.run();
    const input = { requestId: 'cancel_a', action: 'cancel', cancellationConfirmed: true, policy: { ...policy, cancellation } };
    if (cancellation === 'review') await assert.rejects(() => f.run(input), { code: 'reload_credit_cancellation_review' });
    else { await f.run(input); assert.equal(reloadCreditAvailability(await f.account(), actor, NOW)[0].available, cancellation === 'release' ? 1 : 0); }
  }
});

test('editing rules under the same version cannot alter purchased entitlements', async () => {
  const f = fixture(); await f.run();
  await assert.rejects(() => f.run({ requestId: 'cancel_a', action: 'cancel', cancellationConfirmed: true, policy: { ...policy, cancellation: 'forfeit' } }), { code: 'reload_credit_policy_changed' });
  await assert.rejects(() => f.run({ requestId: 'reserve_b', jobId: 'visit_b', policy: { ...policy, expiration: 'forfeit' } }), { code: 'reload_credit_policy_changed' });
});

test('duplicate grants for one purchase line cannot double availability', async () => {
  const f = fixture(), account = f.rows.get('reload_credit_accounts/account_a');
  account.grants.push({ ...structuredClone(account.grants[0]), id: 'duplicate_grant' });
  assert.throws(() => reloadCreditAvailability(account, actor, NOW), { code: 'reload_credit_unavailable' });
});

test('Firestore map ordering does not change policy identity or retry receipts', async () => {
  const f = fixture(); await f.run();
  const grant = f.rows.get('reload_credit_accounts/account_a').grants[0];
  grant.policy = Object.fromEntries(Object.entries(grant.policy).reverse());
  const receipt = f.rows.get('reload_credit_operations/operation_a');
  receipt.payload = Object.fromEntries(Object.entries(receipt.payload).reverse());
  receipt.payload.policy = Object.fromEntries(Object.entries(receipt.payload.policy).reverse());
  assert.equal((await f.run()).result.duplicate, true);
  assert.equal(reloadCreditAvailability(await f.account(), actor, NOW)[0].available, 0);
});
test('refunded or disputed funding is held without automatically recreating entitlements', async () => {
  for (const paymentState of ['review', 'refunded']) {
    const f = fixture(); await f.run(); f.rows.get('reload_credit_accounts/account_a').grants[0].paymentState = paymentState;
    assert.equal(reloadCreditAvailability(await f.account(), actor, NOW)[0].available, 0);
    for (const action of ['complete', 'cancel']) await assert.rejects(() => f.run({ requestId: `${action}_a`, action, completionConfirmed: true, cancellationConfirmed: true }), { code: 'reload_credit_payment_review' });
  }
});
test('unknown/corrupt grants, reused visit IDs, and missing revisions fail closed', async () => {
  const f = fixture(); f.rows.get('reload_credit_accounts/account_a').grants[0].units = -1;
  await assert.rejects(() => f.run(), { code: 'reload_credit_unavailable' });
  const g = fixture(); delete g.rows.get('reload_credit_accounts/account_a').revision;
  await assert.rejects(() => g.run(), { code: 'reload_credit_unavailable' });
});

test('purchase mapping requires a reviewed exact selected line and verified full payment', () => {
  const purchase = { id: 'purchase_a', customerId: 'customer_a', revision: 'v1', estimate: { status: 'accepted', amount: 100, depositRequired: 25, lineItems: [{ id: 'line_a', kind: 'service', name: 'Synthetic package', quantity: 1, unitCents: 10000, totalCents: 10000 }] }, payment: { amount: 100, verified: true, stripeSessions: [{ sessionId: 'cs_test_reload', amount: 100, verifiedAt: NOW }] } };
  const mapping = { confirmed: true, id: 'grant_a', purchaseJobId: purchase.id, lineId: 'line_a', units: 2, expiresAt: null };
  assert.equal(mappedReloadGrant(purchase, mapping, policy, NOW).units, 2);
  for (const change of [{ confirmed: false }, { lineId: 'unknown' }, { purchaseJobId: 'other' }, { units: 0 }, { expiresAt: NOW }]) assert.throws(() => mappedReloadGrant(purchase, { ...mapping, ...change }, policy, NOW));
  for (const change of [{ payment: { amount: 25, verified: true } }, { payment: { amount: 100, verified: false } }, { refunds: [{ amount: 10 }] }, { fieldPaymentPendingId: 'pending' }, { businessAccountId: 'business' }, { pricesPendingApproval: { status: 'pending' } }, { pricesPendingApproval: {} }, { pricesPendingApproval: { status: 'review' } }]) assert.throws(() => mappedReloadGrant({ ...purchase, ...change }, mapping, policy, NOW));
  const optional = structuredClone(purchase); optional.estimate.lineItems[0].optional = true; optional.estimate.lineItems[0].selected = false;
  assert.throws(() => mappedReloadGrant(optional, mapping, policy, NOW), { code: 'reload_credit_mapping_required' });
});
