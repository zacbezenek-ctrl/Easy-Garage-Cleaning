import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DEFAULT_COURTESY_OWNER_LIMIT_CENTS, DEFAULT_PREPAID_OWNER_LIMIT_CENTS, MAX_DECISIONS, MAX_WALLET_CARDS, courtesyOwnerLimitCents, lifecycleApiEnabled, lifecycleLimits, lifecycleProjection, mutateLifecycle, prepaidOwnerLimitCents, readLifecycle } from '../functions/_lib/customer-lifecycle.js';
import { customerMoneyTotals, paymentLedger } from '../functions/_lib/money-core.js';
import { funnelEventId } from '../functions/_lib/funnel-events.js';
import { applyGarageGuardEvent, garageGuardEvent } from '../functions/_lib/garage-guard-membership.js';

const NOW = '2026-09-22T18:00:00.000Z'; // noon in Denver
const owner = { user: 'zacb', role: 'owner', businessAccess: true, displayName: 'Synthetic Owner' };
const manager = { user: 'tylerg', role: 'manager', businessAccess: true, displayName: 'Synthetic Manager' };
const crew = { user: 'crew1', role: 'crew', businessAccess: false, displayName: 'Synthetic Crew' };
const MONEY = { estimate: { number: 'EST-ABC123', status: 'accepted', amount: 1400, depositRequired: 700 }, total: 1400, priceQuoted: 1400, deposit: { amount: 700, paidAmount: 700, status: 'paid', verified: true },
  payment: { amount: 700, verified: true, method: 'check', reference: 'CHK-1', lastAmount: 700, recordedBy: 'zacb', lastReceivedAt: '2026-09-20T18:00:00.000Z' }, invoice: { number: 'INV-ABC123', status: 'partial', amount: 1400, paid: 700, balance: 700 } };

function fixture(job = {}, extraJobs = []) {
  const docs = new Map([
    ['jobs/job-abc123', { id: 'job-abc123', revision: 'r0', type: 'job', customerId: 'c1', customer: 'Synthetic Customer', serviceType: 'Garage transformation', projectId: 'project_job-abc123', highlevelContactId: 'contactSynthetic1', date: '2026-09-24', status: 'scheduled', pipelineStatus: 'scheduled', ...MONEY, ...job }],
    ...extraJobs.map(row => [`jobs/${row.id}`, { revision: `${row.id}-r0`, type: 'job', customerId: 'c1', customer: 'Synthetic Customer', ...row }]),
  ]);
  let n = 0, hook = null;
  const commits = [], reads = [];
  const store = {
    async read(collection, id) { reads.push(`${collection}/${id}`); return structuredClone(docs.get(`${collection}/${id}`) ?? null); },
    async commit(writes) {
      if (hook) { const fn = hook; hook = null; await fn(writes); }
      const keys = new Set();
      for (const write of writes) {
        const key = `${write.collection}/${write.id}`, old = docs.get(key);
        assert(!keys.has(key), 'one write per document per commit'); keys.add(key);
        if (write.verify ? old?.revision !== write.revision : write.revision ? old?.revision !== write.revision : old) throw Object.assign(new Error('Conflict'), { code: 'lifecycle_revision_conflict', status: 409 });
      }
      commits.push(structuredClone(writes));
      for (const write of writes) { if (write.verify) continue; const key = `${write.collection}/${write.id}`; docs.set(key, { ...(write.revision ? docs.get(key) : {}), ...structuredClone(write.patch), id: write.id, revision: `r${++n}` }); }
    },
  };
  const f = { docs, store, commits, reads, job: (id = 'job-abc123') => docs.get(`jobs/${id}`), beforeCommit: fn => { hook = fn; },
    rows: prefix => [...docs].filter(([key]) => key.startsWith(prefix)).map(([, row]) => row),
    input: (action, fields = {}, id = 'job-abc123', revisionOf = id) => ({ action, requestId: randomUUID(), jobId: id, expectedRevision: docs.get(`jobs/${revisionOf}`).revision, ...fields }),
    run: (action, fields, { actor = owner, id, revisionOf, limit, prepaid } = {}) => mutateLifecycle(store, actor, f.input(action, fields, id, revisionOf), NOW, { ...(limit === undefined ? {} : { courtesyOwnerLimitCents: limit }), ...(prepaid === undefined ? {} : { prepaidOwnerLimitCents: prepaid }) }) };
  return f;
}
const credit = (fields = {}) => ({ accountId: 'job-abc123', amountCents: 5000, creditClass: 'garage_guard', label: 'EGC service credit', reason: 'Unused Garage Guard visit', ...fields });
// An active Garage Guard member with unused visits, as the Stripe sync mirrors it (source 'stripe' and the
// subscription id): the account a manager may turn a visit into Garage Guard credit on.
const MEMBER = { garageGuard: { plan: 'guard', status: 'active', visitsIncluded: 4, visitsRemaining: 2, membershipId: 'sub_SyntheticMember1', source: 'stripe', updatedBy: 'stripe_webhook' } };
const moneyFields = job => Object.fromEntries(['estimate', 'total', 'priceQuoted', 'deposit', 'payment', 'invoice', 'approvedChangeTotal', 'status', 'pipelineStatus', 'costs', 'paymentLedger'].map(key => [key, job[key] ?? null]));

test('credit.issue adds a classed wallet credit with a receipt, audit entry and credit.issued event in ONE commit, and never touches job money', async () => {
  const f = fixture(), before = moneyFields(f.job()), result = await f.run('credit.issue', credit());
  assert.equal(result.ok, true); assert.equal(result.replayed, false); assert.equal(result.action, 'credit.issue'); assert.equal(result.authority, 'employee_hub');
  assert.equal(f.commits.length, 1);
  const writes = f.commits[0];
  assert.deepEqual(writes.map(write => write.collection), ['jobs', 'lifecycleOperations', 'hub_audit', 'funnelEvents']);
  assert.equal(writes[0].revision, 'r0'); assert.deepEqual(Object.keys(writes[0].patch).sort(), ['giftWallet', 'updatedAt'], 'only the wallet (and updatedAt) change');
  assert.equal(writes[1].revision, undefined); assert.equal(writes[2].revision, undefined); assert.equal(writes[3].revision, undefined, 'receipt, audit and event are create-only');
  const card = f.job().giftWallet.cards[0];
  assert.deepEqual({ ...card }, { id: `credit-${result.requestId.toLowerCase()}`, label: 'EGC service credit', source: 'Garage Guard credit', creditClass: 'garage_guard', issuedAmount: 50, issuedAmountCents: 5000, remainingAmount: 50,
    issuedAt: NOW, issuedBy: 'zacb', issuedByOwner: true, requestId: result.requestId, sourceJobId: 'job-abc123', reason: 'Unused Garage Guard visit' });
  assert.equal(f.job().giftWallet.updatedAt, NOW);
  assert.deepEqual(moneyFields(f.job()), before, 'estimate, payment, deposit, invoice and status are untouched');
  const receipt = f.docs.get(`lifecycleOperations/${result.requestId.toLowerCase()}`);
  assert.match(receipt.fingerprint, /^[0-9a-f]{64}$/); assert.equal(receipt.actorId, 'zacb'); assert.equal(receipt.via, 'hub'); assert.equal(receipt.targetId, 'job-abc123');
  assert.deepEqual(receipt.result, { cardId: card.id, accountId: 'job-abc123', amountCents: 5000, creditClass: 'garage_guard', targetId: 'job-abc123' });
  const [audit] = f.rows('hub_audit/');
  assert.equal(audit.action, 'lifecycle.credit.issue'); assert.equal(audit.requestId, result.requestId); assert.equal(audit.visibility, 'business'); assert.equal(receipt.auditId, audit.id);
  assert.deepEqual(JSON.parse(audit.before), { credits: [] }); assert.equal(JSON.parse(audit.after).credits[0].remainingCents, 5000); assert.equal(JSON.parse(audit.after).credits[0].creditClass, 'garage_guard');
  assert.deepEqual(audit.changedKeys, ['credits']); assert.equal(audit.reason, '$50.00 garage_guard credit: Unused Garage Guard visit');
  const [event] = f.rows('funnelEvents/');
  assert.equal(event.type, 'credit.issued'); assert.deepEqual(event.data, { amountCents: 5000, creditClass: 'garage_guard' });
  assert.equal(event.entityKey, 'customerId:c1'); assert.equal(event.jobId, 'job-abc123'); assert.equal(event.projectId, 'project_job-abc123'); assert.equal(event.highlevelContactId, 'contactSynthetic1');
  assert.deepEqual([event.clockSource, event.occurredAt, event.recordedAt, event.denverDate], ['server', NOW, NOW, '2026-09-22']);
  assert.deepEqual(event.source, { collection: 'lifecycleOperations', id: result.requestId.toLowerCase() }); assert.deepEqual(event.actor, { id: 'zacb', kind: 'human', role: 'owner' });
  assert.equal(event.id, funnelEventId('credit.issued', { field: 'customerId', value: 'c1' }, `requestId:${result.requestId.toLowerCase()}`)); assert.deepEqual(receipt.eventIds, [event.id]);
  assert.equal(event.isTest, false);
  // The response carries the fresh manager view.
  assert.equal(result.result.cardId, card.id); assert.equal(result.context.account.availableCents, 5000); assert.equal(result.context.account.revision, f.job().revision);
  assert.deepEqual(result.context.account.credits.map(item => [item.creditClass, item.issuedCents, item.remainingCents]), [['garage_guard', 5000, 5000]]);
});

test('credits land on the verified customer account root; every lineage hop read is fenced, and a moved or broken link writes nothing', async () => {
  const extra = [{ id: 'root-job', type: 'walkthrough', giftWallet: { cards: [{ id: 'credit-old', label: 'Legacy credit', issuedAmount: 25, remainingAmount: '12.50', source: 'Manager-issued' }] } }, { id: 'mid-job', customerAccountOwnerJobId: 'root-job' }];
  const f = fixture({ customerAccountOwnerJobId: 'mid-job' }, extra);
  const result = await f.run('credit.issue', credit({ accountId: 'root-job' }), { revisionOf: 'root-job' });
  const writes = f.commits[0];
  assert.deepEqual(writes.slice(0, 3).map(write => [write.id, write.verify === true, write.revision]), [['job-abc123', true, 'r0'], ['mid-job', true, 'mid-job-r0'], ['root-job', false, 'root-job-r0']]);
  assert.equal(f.job().giftWallet, undefined, 'the child job never holds the wallet');
  assert.deepEqual(f.job('root-job').giftWallet.cards.map(card => card.id), ['credit-old', `credit-${result.requestId.toLowerCase()}`], 'the legacy credit is kept');
  assert.equal(f.job('root-job').giftWallet.cards[1].sourceJobId, 'job-abc123');
  assert.equal(result.context.account.id, 'root-job'); assert.equal(result.context.account.sameAsJob, false); assert.equal(result.context.account.availableCents, 6250);
  // A fenced hop that changes before the commit fails the whole change.
  f.beforeCommit(() => { f.job('mid-job').revision = 'moved'; });
  await assert.rejects(f.run('credit.issue', credit({ accountId: 'root-job' }), { revisionOf: 'root-job' }), error => error.code === 'lifecycle_revision_conflict' && error.status === 409);
  // The client's account must still be the account the server resolves.
  await assert.rejects(f.run('credit.issue', credit({ accountId: 'job-abc123' }), { revisionOf: 'job-abc123' }), error => error.code === 'lifecycle_revision_conflict');
  assert.equal(f.commits.length, 1);
  const other = fixture({ customerAccountOwnerJobId: 'root-job' }, [{ id: 'root-job', customerId: 'someone-else' }]);
  await assert.rejects(other.run('credit.issue', credit({ accountId: 'root-job' }), { revisionOf: 'root-job' }), error => error.code === 'lifecycle_account_invalid' && error.status === 409);
  const missing = fixture({ customerAccountOwnerJobId: 'gone-job' });
  await assert.rejects(missing.run('credit.issue', credit({ accountId: 'gone-job' })), error => error.code === 'lifecycle_account_unavailable' && error.status === 503);
  // An empty link means this job is the account, as the customer portal and the Hub suite read it.
  const own = fixture({ customerAccountOwnerJobId: '' });
  const ownCredit = await own.run('credit.issue', credit());
  assert.equal(ownCredit.context.account.id, 'job-abc123'); assert.equal(ownCredit.context.account.sameAsJob, true); assert.equal(ownCredit.context.accountIssue, null);
  assert.equal(own.job().giftWallet.cards.length, 1); assert.deepEqual(own.commits[0].map(write => [write.collection, write.id, write.verify === true]).slice(0, 1), [['jobs', 'job-abc123', false]]);
  assert.equal((await readLifecycle(own.store, owner, 'job-abc123', {}, new Date(NOW))).account.id, 'job-abc123');
  // Decisions live on the job itself, so a broken account link does not block them.
  const decided = await missing.run('decision.prompt', { title: 'Remove the damaged cabinet?', details: 'The back panel is broken.' });
  assert.equal(decided.ok, true); assert.equal(decided.context.account, null); assert.equal(decided.context.accountIssue.code, 'lifecycle_account_unavailable');
  assert.equal(missing.commits.length, 1); assert.equal(other.commits.length, 0);
});

test('courtesy and referral credits above the owner limit, and Garage Guard credits and gift-card sales above the prepaid limit, need the owner; gift_purchase credits need the owner and the original sale reference', async () => {
  // The limits bind a manager's running total per customer (next test), so each case starts from a customer with no
  // earlier manager credits; Garage Guard credits are issued on a member's account with unused visits.
  const fresh = () => fixture(MEMBER);
  const f = fresh();
  await assert.rejects(f.run('credit.issue', credit({ creditClass: 'courtesy', amountCents: 10001 }), { actor: manager }), error => error.code === 'lifecycle_owner_required' && error.status === 403 && error.details.limitCents === 10000);
  assert.equal(f.commits.length, 0);
  assert.equal((await f.run('credit.issue', credit({ creditClass: 'courtesy', amountCents: 10000 }), { actor: manager })).ok, true, 'at the limit a manager may issue it');
  assert.equal((await f.run('credit.issue', credit({ creditClass: 'courtesy', amountCents: 25000 }))).ok, true, 'the owner may issue more');
  // Referral rewards are contra revenue too, so a manager cannot route a large give-away through them.
  const r = fresh();
  await assert.rejects(r.run('credit.issue', credit({ creditClass: 'referral', amountCents: 25000 }), { actor: manager }), error => error.code === 'lifecycle_owner_required' && /Courtesy and referral credits over \$100\.00/.test(error.message) && error.details.limitCents === 10000);
  assert.equal((await r.run('credit.issue', credit({ creditClass: 'referral', amountCents: 10000 }), { actor: manager })).ok, true);
  assert.equal((await r.run('credit.issue', credit({ creditClass: 'referral', amountCents: 25000 }))).ok, true, 'the owner may issue a larger referral reward');
  await assert.rejects(fresh().run('credit.issue', credit({ creditClass: 'courtesy', amountCents: 1 }), { actor: manager, limit: 0 }), error => error.code === 'lifecycle_owner_required');
  // Garage Guard credits and gift-card sales (prepaid value) have their own, higher limit.
  const g = fresh();
  assert.equal((await g.run('credit.issue', credit({ creditClass: 'garage_guard', amountCents: DEFAULT_PREPAID_OWNER_LIMIT_CENTS }), { actor: manager })).ok, true);
  await assert.rejects(fresh().run('credit.issue', credit({ creditClass: 'garage_guard', amountCents: DEFAULT_PREPAID_OWNER_LIMIT_CENTS + 1 }), { actor: manager }), error => error.code === 'lifecycle_owner_required' && /Garage Guard credits over \$1,000\.00/.test(error.message) && error.details.limitCents === 100000);
  const s = fresh(), sale = (amountCents, reference) => ({ accountId: 'job-abc123', amountCents, label: 'EGC gift card', method: 'check', reference });
  await assert.rejects(s.run('gift_card.sell', sale(30000, 'Check 2001'), { actor: manager, prepaid: 25000 }), error => error.code === 'lifecycle_owner_required' && /Gift-card sales over \$250\.00/.test(error.message) && error.details.limitCents === 25000);
  assert.equal((await s.run('gift_card.sell', sale(25000, 'Check 2002'), { actor: manager, prepaid: 25000 })).ok, true);
  assert.equal((await s.run('gift_card.sell', sale(30000, 'Check 2001'), { prepaid: 25000 })).ok, true, 'the owner records the larger sale');
  await assert.rejects(fresh().run('credit.issue', credit({ creditClass: 'garage_guard', amountCents: 1 }), { actor: manager, prepaid: 0 }), error => error.code === 'lifecycle_owner_required');
  assert.equal(s.rows('giftCardSales/').length, 2, 'a refused sale records no cash');
  await assert.rejects(f.run('credit.issue', credit({ creditClass: 'gift_purchase' })), error => error.code === 'lifecycle_invalid_field' && /sale reference/.test(error.message));
  await assert.rejects(f.run('credit.issue', credit({ creditClass: 'gift_purchase', reference: 'Paper card #0042', amountCents: 100 }), { actor: manager }), error => error.code === 'lifecycle_owner_required' && /sold before the Hub/.test(error.message), 'a payment-class credit with no cash needs the owner');
  const gift = await f.run('credit.issue', credit({ creditClass: 'gift_purchase', reference: 'Paper card #0042 sold 2026-05-01' }));
  assert.equal(f.job().giftWallet.cards.at(-1).reference, 'Paper card #0042 sold 2026-05-01'); assert.equal(f.job().giftWallet.cards.at(-1).source, 'Gift card');
  assert.equal([f, r, g, s].reduce((sum, h) => sum + h.rows('funnelEvents/').filter(event => event.type === 'credit.issued').length, 0), 8); assert.equal(f.rows('giftCardSales/').length, 0, 'a pre-Hub gift card records no new cash');
  assert.equal(gift.result.creditClass, 'gift_purchase');
  for (const bad of [{ creditClass: 'unknown' }, { creditClass: 'bonus' }]) await assert.rejects(f.run('credit.issue', credit(bad)), error => error.code === 'lifecycle_invalid_credit_class');
  for (const bad of [{ amountCents: 0 }, { amountCents: 12.5 }, { amountCents: '5000' }, { amountCents: 100000001 }]) await assert.rejects(f.run('credit.issue', credit(bad)), error => error.code === 'lifecycle_invalid_amount');
  await assert.rejects(f.run('credit.issue', credit({ reason: '' })), error => error.code === 'lifecycle_invalid_field');
  assert.equal(DEFAULT_COURTESY_OWNER_LIMIT_CENTS, 10000); assert.equal(DEFAULT_PREPAID_OWNER_LIMIT_CENTS, 100000);
  assert.deepEqual([undefined, '', ' 2500 ', '0', 'abc', '-5', '1.5', '100000001'].map(value => courtesyOwnerLimitCents(value === undefined ? {} : { COURTESY_CREDIT_OWNER_LIMIT_CENTS: value })), [10000, 10000, 2500, 0, 0, 0, 0, 0]);
  assert.deepEqual([undefined, '', ' 50000 ', '0', 'abc', '-5', '1.5', '100000001'].map(value => prepaidOwnerLimitCents(value === undefined ? {} : { PREPAID_CREDIT_OWNER_LIMIT_CENTS: value })), [100000, 100000, 50000, 0, 0, 0, 0, 0]);
  assert.deepEqual(lifecycleLimits({ COURTESY_CREDIT_OWNER_LIMIT_CENTS: '2500', PREPAID_CREDIT_OWNER_LIMIT_CENTS: '50000' }), { courtesyOwnerLimitCents: 2500, prepaidOwnerLimitCents: 50000 });
});

test('gift_card.sell records the cash (dated when received) plus a gift_purchase liability, and it is never job revenue', async () => {
  const f = fixture(), before = moneyFields(f.job()), totals = customerMoneyTotals(f.job());
  const result = await f.run('gift_card.sell', { accountId: 'job-abc123', amountCents: 15000, label: 'Holiday gift card', method: 'card_terminal', reference: 'Square 8841', receivedAt: '2026-09-22T09:30:00-06:00' });
  const saleId = result.requestId.toLowerCase(), writes = f.commits[0];
  assert.deepEqual(writes.map(write => write.collection), ['jobs', 'giftCardSales', 'giftCardSaleRefs', 'lifecycleOperations', 'hub_audit', 'funnelEvents', 'funnelEvents']);
  const sale = f.docs.get(`giftCardSales/${saleId}`), card = f.job().giftWallet.cards[0];
  assert.equal(writes[1].revision, undefined, 'the sale record is create-only'); assert.equal(writes[2].revision, undefined, 'the payment reference claim is create-only');
  assert.match(sale.referenceKey, /^[0-9a-f]{64}$/); assert.equal(writes[2].id, sale.referenceKey);
  assert.deepEqual({ ...sale, revision: undefined }, { saleId, cardId: `giftcard-${saleId}`, accountJobId: 'job-abc123', sourceJobId: 'job-abc123', customerId: 'c1', amountCents: 15000, method: 'card_terminal', reference: 'Square 8841', receivedAt: '2026-09-22T15:30:00.000Z',
    label: 'Holiday gift card', creditClass: 'gift_purchase', status: 'recorded', recordedAt: NOW, recordedBy: 'zacb', via: 'hub', requestId: result.requestId, referenceKey: sale.referenceKey, id: saleId, revision: undefined });
  assert.deepEqual({ ...f.docs.get(`giftCardSaleRefs/${sale.referenceKey}`), revision: undefined }, { saleId, cardId: `giftcard-${saleId}`, method: 'card_terminal', amountCents: 15000, receivedAt: '2026-09-22T15:30:00.000Z', accountJobId: 'job-abc123', recordedAt: NOW, recordedBy: 'zacb', requestId: result.requestId, id: sale.referenceKey, revision: undefined });
  assert.deepEqual([card.id, card.creditClass, card.issuedAmount, card.remainingAmount, card.saleId, card.label], [`giftcard-${saleId}`, 'gift_purchase', 150, 150, saleId, 'Holiday gift card']);
  const events = Object.fromEntries(f.rows('funnelEvents/').map(event => [event.type, event]));
  assert.deepEqual(events['gift_card.sold'].data, { amountCents: 15000, method: 'card' });
  assert.deepEqual([events['gift_card.sold'].clockSource, events['gift_card.sold'].occurredAt, events['gift_card.sold'].recordedAt], ['attested', '2026-09-22T15:30:00.000Z', NOW], 'cash is dated when it was received, attested');
  assert.deepEqual(events['gift_card.sold'].source, { collection: 'giftCardSales', id: saleId });
  assert.deepEqual(events['credit.issued'].data, { amountCents: 15000, creditClass: 'gift_purchase' });
  assert.deepEqual(moneyFields(f.job()), before, 'a gift-card sale is never recorded as job payment');
  assert.deepEqual(customerMoneyTotals(f.job()), totals); assert.equal(paymentLedger(f.job()).paidCents, 70000);
  assert.deepEqual(result.result, { cardId: card.id, saleId, accountId: 'job-abc123', amountCents: 15000, creditClass: 'gift_purchase', method: 'card_terminal', receivedAt: '2026-09-22T15:30:00.000Z', targetId: 'job-abc123' });
  const [audit] = f.rows('hub_audit/');
  assert.deepEqual(JSON.parse(audit.after).sale, { saleId, amountCents: 15000, method: 'card_terminal', reference: 'Square 8841', receivedAt: '2026-09-22T15:30:00.000Z' });
  const methods = { cash: 'cash', check: 'check', stripe_link: 'card', bank_transfer: 'ach', other: 'other' };
  for (const [method, eventMethod] of Object.entries(methods)) {
    const sold = await f.run('gift_card.sell', { accountId: 'job-abc123', amountCents: 2500, label: 'EGC gift card', method, reference: `REF-${method}` });
    assert.equal(f.rows('funnelEvents/').find(event => event.type === 'gift_card.sold' && event.source.id === sold.requestId.toLowerCase()).data.method, eventMethod);
    assert.equal(f.docs.get(`giftCardSales/${sold.requestId.toLowerCase()}`).receivedAt, NOW, 'no time given means received now');
  }
  for (const receivedAt of ['2026-09-22T18:06:00.000Z', '2025-09-20T18:00:00.000Z', 'yesterday']) await assert.rejects(f.run('gift_card.sell', { accountId: 'job-abc123', amountCents: 100, label: 'Card', method: 'cash', reference: 'R1', receivedAt }), error => error.code === 'lifecycle_invalid_received_at');
  await assert.rejects(f.run('gift_card.sell', { accountId: 'job-abc123', amountCents: 100, label: 'Card', method: 'venmo', reference: 'R1' }), error => error.code === 'lifecycle_invalid_payment_method');
  await assert.rejects(f.run('gift_card.sell', { accountId: 'job-abc123', amountCents: 100, label: 'Card', method: 'cash', reference: '' }), error => error.code === 'lifecycle_invalid_field');
});

test('gift_card.sell refuses the same payment entered twice under another request ID, naming the earlier sale, and writes nothing', async () => {
  const f = fixture(), sale = (fields = {}) => ({ accountId: 'job-abc123', amountCents: 5000, label: 'EGC gift card', method: 'check', reference: 'Check #1001', ...fields });
  const first = await f.run('gift_card.sell', sale({ receivedAt: '2026-09-20T18:00:00.000Z' })), saleId = first.requestId.toLowerCase(), commits = f.commits.length;
  // The reference is compared without case, spaces or punctuation.
  for (const reference of ['Check #1001', 'check 1001', 'CHECK-1001', 'Check  #1001 ']) {
    await assert.rejects(f.run('gift_card.sell', sale({ reference, amountCents: 7000 })), error => error.code === 'lifecycle_sale_duplicate' && error.status === 409 && error.details.saleId === saleId
      && error.details.receivedAt === '2026-09-20T18:00:00.000Z' && error.details.amountCents === 5000 && error.message.includes(`sale ${saleId.slice(0, 8)}`) && error.message.includes('Sep 20, 2026') && /make the reference more specific/.test(error.message), reference);
  }
  assert.equal(f.commits.length, commits); assert.equal(f.rows('giftCardSales/').length, 1); assert.equal(f.job().giftWallet.cards.length, 1);
  // Replaying the original request still returns its saved result.
  const replay = await mutateLifecycle(f.store, owner, { ...f.input('gift_card.sell', sale({ receivedAt: '2026-09-20T18:00:00.000Z' })), requestId: first.requestId, expectedRevision: 'r0' }, NOW);
  assert.equal(replay.replayed, true); assert.equal(replay.result.saleId, saleId);
  // The claim is keyed by the reference alone (second review): the same check entered again under another method is
  // still the same payment; a more specific reference for a different payment is a new sale.
  for (const method of ['cash', 'other']) {
    await assert.rejects(f.run('gift_card.sell', sale({ method })), error => error.code === 'lifecycle_sale_duplicate' && error.details.saleId === saleId && error.details.method === 'check' && /^A check gift-card sale with this reference/.test(error.message), method);
  }
  assert.equal((await f.run('gift_card.sell', sale({ reference: 'Check #1001 from Synthetic Payer' }))).ok, true);
  assert.equal(f.rows('giftCardSales/').length, 2); assert.equal(f.rows('giftCardSaleRefs/').length, 2);
  assert.deepEqual(f.rows('giftCardSaleRefs/').map(claim => claim.method).sort(), ['check', 'check'], 'the method is kept as data on the claim');
  // Two copies racing past the read: the create-only claim fails the second commit and nothing is written.
  const race = fixture(), raced = race.input('gift_card.sell', sale({ reference: 'Square 5150' }));
  race.beforeCommit(writes => { const claim = writes.find(write => write.collection === 'giftCardSaleRefs'); race.docs.set(`giftCardSaleRefs/${claim.id}`, { saleId: 'someone-else', revision: 'x1' }); });
  await assert.rejects(mutateLifecycle(race.store, owner, raced, NOW), error => error.code === 'lifecycle_revision_conflict');
  assert.equal(race.rows('giftCardSales/').length, 0); assert.equal(race.job().giftWallet, undefined);
});

test('a manager\'s owner limits bind the running total per customer over 30 Denver days, per group, not each credit', async () => {
  // Courtesy + referral share the courtesy limit: a second credit that takes the total over it is refused.
  const f = fixture();
  assert.equal((await f.run('credit.issue', credit({ creditClass: 'courtesy', amountCents: 6000 }), { actor: manager })).ok, true);
  await assert.rejects(f.run('credit.issue', credit({ creditClass: 'referral', amountCents: 5000 }), { actor: manager }), error => error.code === 'lifecycle_owner_required' && error.status === 403
    && error.message === 'Courtesy and referral credits over $100.00 need the owner. That limit counts every courtesy or referral credit a manager gave this customer in the last 30 days: $60.00 so far. Ask the owner to issue this credit.'
    && JSON.stringify(error.details) === JSON.stringify({ limitCents: 10000, managerIssuedCents: 6000, windowDays: 30 }));
  assert.equal((await f.run('credit.issue', credit({ creditClass: 'courtesy', amountCents: 4000 }), { actor: manager })).ok, true, 'up to the limit in total');
  // The owner's own credits never use up the managers' allowance, and the owner is never limited.
  assert.equal((await f.run('credit.issue', credit({ creditClass: 'courtesy', amountCents: 50000 }))).ok, true);
  await assert.rejects(f.run('credit.issue', credit({ creditClass: 'courtesy', amountCents: 1 }), { actor: manager }), error => error.details?.managerIssuedCents === 10000);
  assert.deepEqual(f.job().giftWallet.cards.map(card => [card.creditClass, card.issuedAmountCents, card.issuedByOwner]), [['courtesy', 6000, false], ['courtesy', 4000, false], ['courtesy', 50000, true]]);
  // The finding's split: 20 courtesy credits of $100 each. Only the first gets through.
  const split = fixture();
  let issued = 0;
  for (let i = 0; i < 20; i++) issued += await split.run('credit.issue', credit({ creditClass: 'courtesy', amountCents: 10000 }), { actor: manager }).then(() => 1, error => { assert.equal(error.code, 'lifecycle_owner_required'); return 0; });
  assert.equal(issued, 1); assert.equal(split.job().giftWallet.cards.length, 1);

  // Garage Guard credits and a manager's gift-card sales share the prepaid limit.
  const p = fixture(MEMBER), sale = (amountCents, reference, fields = {}) => ({ accountId: 'job-abc123', amountCents, label: 'EGC gift card', method: 'check', reference, ...fields });
  assert.equal((await p.run('credit.issue', credit({ amountCents: 60000 }), { actor: manager })).ok, true);
  await assert.rejects(p.run('gift_card.sell', sale(50000, 'Check 4001'), { actor: manager }), error => error.code === 'lifecycle_owner_required'
    && error.message === 'Gift-card sales over $1,000.00 need the owner. That limit counts every Garage Guard credit or gift-card sale a manager recorded for this customer in the last 30 days: $600.00 so far. Ask the owner to record this sale.' && error.details.managerIssuedCents === 60000);
  assert.equal(p.rows('giftCardSales/').length, 0, 'the refused sale records no cash'); assert.equal(p.rows('giftCardSaleRefs/').length, 0, 'and claims no reference');
  assert.equal((await p.run('gift_card.sell', sale(40000, 'Check 4001'), { actor: manager })).ok, true, 'the same payment is recorded once within the limit');
  await assert.rejects(p.run('credit.issue', credit({ amountCents: 1 }), { actor: manager }), error => error.code === 'lifecycle_owner_required' && /^Garage Guard credits over \$1,000\.00 need the owner\. That limit counts every Garage Guard credit or gift-card sale a manager recorded for this customer in the last 30 days: \$1,000\.00 so far\./.test(error.message));
  assert.equal((await p.run('gift_card.sell', sale(500000, 'Check 4002'))).ok, true, 'the owner records a large sale');
  assert.equal((await p.run('credit.issue', credit({ creditClass: 'courtesy', amountCents: 10000 }), { actor: manager })).ok, true, 'the contra group has its own total');
  // A payment already recorded is reported as such before any limit.
  await assert.rejects(p.run('gift_card.sell', sale(40000, 'check 4001'), { actor: manager }), error => error.code === 'lifecycle_sale_duplicate');

  // The window is 30 Denver days, today included, on the injected clock: a card from the 31st Denver day back drops out.
  const old = (creditClass, cents, issuedAt, extra = {}) => ({ id: `credit-${creditClass}-${cents}`, label: 'Credit', creditClass, issuedAmount: cents / 100, issuedAmountCents: cents, remainingAmount: cents / 100, issuedAt, issuedBy: 'tylerg', issuedByOwner: false, ...extra });
  const w = fixture({ giftWallet: { cards: [
    old('courtesy', 9000, '2026-08-24T05:59:00.000Z'), // 23:59 on Aug 23 in Denver: outside the window of Sep 22
    old('referral', 3000, '2026-08-24T06:00:00.000Z', { issuedBy: 'former-manager' }), // 00:00 on Aug 24 in Denver: inside, whichever manager issued it
    old('courtesy', 50000, NOW, { issuedBy: 'zacb', issuedByOwner: true }),
    { id: 'credit-legacy', label: 'Older credit', issuedAmount: 500, remainingAmount: 500 },
    old('garage_guard', 20000, NOW),
  ] } });
  const inWindow = await readLifecycle(w.store, manager, 'job-abc123', {}, new Date(NOW));
  assert.deepEqual(inWindow.account.managerIssued, { contraCents: 3000, prepaidCents: 20000, since: '2026-08-24', windowDays: 30 });
  await assert.rejects(w.run('credit.issue', credit({ creditClass: 'courtesy', amountCents: 7001 }), { actor: manager }), error => error.details?.managerIssuedCents === 3000);
  // One minute into Sep 23 in Denver the Aug 24 card leaves the window too.
  const later = '2026-09-23T06:01:00.000Z';
  assert.deepEqual((await readLifecycle(w.store, manager, 'job-abc123', {}, new Date(later))).account.managerIssued, { contraCents: 0, prepaidCents: 20000, since: '2026-08-25', windowDays: 30 });
  assert.equal((await mutateLifecycle(w.store, manager, w.input('credit.issue', credit({ creditClass: 'courtesy', amountCents: 10000 })), later)).ok, true);
  // A group card with an unreadable time counts; one with an unreadable amount makes the total unknown and refuses the manager.
  const undated = fixture({ giftWallet: { cards: [old('courtesy', 8000, 'sometime')] } });
  await assert.rejects(undated.run('credit.issue', credit({ creditClass: 'courtesy', amountCents: 2001 }), { actor: manager }), error => error.details?.managerIssuedCents === 8000);
  const unreadable = fixture({ giftWallet: { cards: [{ ...old('referral', 100, NOW), issuedAmountCents: undefined, issuedAmount: 'lots' }] } });
  await assert.rejects(unreadable.run('credit.issue', credit({ creditClass: 'courtesy', amountCents: 100 }), { actor: manager }), error => error.code === 'lifecycle_owner_required' && error.details.managerIssuedCents === null && /could not be totalled/.test(error.message));
  assert.equal((await unreadable.run('credit.issue', credit({ creditClass: 'courtesy', amountCents: 100 }))).ok, true, 'the owner is not blocked by it');
  assert.equal((await readLifecycle(unreadable.store, manager, 'job-abc123', {}, new Date(NOW))).account.managerIssued.contraCents, null, 'unknown, never 0');
});

test('a manager\'s Garage Guard credit needs an active, Stripe-backed Garage Guard membership with whole unused visits, and a manager\'s "other" sale needs the owner', async () => {
  const refused = error => error.code === 'lifecycle_owner_required' && error.status === 403 && error.details.reason === 'garage_guard_membership' && /no active Garage Guard membership recorded from Stripe/.test(error.message);
  const member = (fields = {}) => ({ garageGuard: { ...MEMBER.garageGuard, ...fields } });
  // The Hub's "Garage Guard status" editor (opsSetCustomerMembership) replaces garageGuard with exactly these fields: no source, no membershipId.
  const hubEdit = { plan: 'guard', status: 'active', visitsIncluded: 4, visitsRemaining: 4, nextVisit: '', renewalDate: '', updatedAt: NOW, updatedBy: 'tylerg' };
  for (const account of [{}, { garageGuard: {} }, member({ visitsRemaining: 0 }), member({ status: 'cancelled' }), member({ plan: 'Platinum' }), member({ visitsRemaining: '2' }), { garageGuard: 'guard' },
    // Only an active membership: paused (the Hub editor offers it), past_due (a failed payment), pending (an unpaid checkout), the American spelling and a fractional visit are refused.
    member({ status: 'paused' }), member({ status: 'past_due' }), member({ status: 'pending' }), member({ status: 'canceled' }), member({ status: 'Active' }), member({ status: undefined }), member({ visitsRemaining: 0.5 }), member({ visitsRemaining: 1.5 }),
    // Only a membership the Stripe sync mirrored: what a manager types into the Hub editor, or half of the marker, does not count.
    { garageGuard: hubEdit }, { garageGuard: { ...hubEdit, plan: 'black', visitsRemaining: 12 } }, member({ source: undefined }), member({ membershipId: undefined }), member({ membershipId: '' }), member({ membershipId: 'cus_SyntheticMember1' }),
    member({ membershipId: 'sub_ spaced' }), member({ membershipId: 42 }), member({ source: 'hub' }), member({ source: 'Stripe' })]) {
    const f = fixture(account);
    await assert.rejects(f.run('credit.issue', credit({ amountCents: 900 }), { actor: manager }), refused, JSON.stringify(account));
    assert.equal(f.commits.length, 0);
    assert.equal((await f.run('credit.issue', credit({ amountCents: 90000 }))).ok, true, 'the owner may issue it');
  }
  // The relabelling from the review: a courtesy amount refused as courtesy is also refused as Garage Guard credit on a non-member.
  const relabel = fixture();
  await assert.rejects(relabel.run('credit.issue', credit({ creditClass: 'courtesy', amountCents: 90000 }), { actor: manager }), error => error.code === 'lifecycle_owner_required');
  await assert.rejects(relabel.run('credit.issue', credit({ creditClass: 'garage_guard', amountCents: 90000 }), { actor: manager }), refused);
  // The third review's probe: a manager marks a non-member active in the Hub editor, then tries a $900 Garage Guard credit.
  const typed = fixture();
  typed.docs.set('jobs/job-abc123', { ...typed.job(), garageGuard: hubEdit, revision: 'r-hub-edit' });
  await assert.rejects(typed.run('credit.issue', credit({ amountCents: 90000 }), { actor: manager }), refused);
  assert.equal(typed.job().giftWallet, undefined);
  // An active, Stripe-backed member with whole unused visits (the portal's legacy `membership` copy counts as the portal reads it, with the same marker).
  for (const account of [MEMBER, member({ plan: 'black', visitsRemaining: 1 }), member({ plan: 'lite', visitsRemaining: 1, updatedBy: 'someone' }), { membership: member({ plan: 'lite', visitsRemaining: 1 }).garageGuard }]) {
    assert.equal((await fixture(account).run('credit.issue', credit({ amountCents: 900 }), { actor: manager })).ok, true, JSON.stringify(account));
  }
  // Read as the portal reads a child job: the account root's garageGuard, else the child job's own `membership`; never the child's garageGuard.
  const child = (root, own) => fixture(root, [{ id: 'job-child1', customerAccountOwnerJobId: 'job-abc123', ...own }]);
  const onChild = f => f.run('credit.issue', credit({ amountCents: 900 }), { actor: manager, id: 'job-child1', revisionOf: 'job-abc123' });
  await assert.rejects(onChild(child({}, { garageGuard: MEMBER.garageGuard })), refused, 'a membership only on the child job');
  await assert.rejects(onChild(child({ garageGuard: hubEdit }, { membership: MEMBER.garageGuard })), refused, 'the account\'s own garageGuard wins, as in the portal');
  assert.equal((await onChild(child({}, { membership: MEMBER.garageGuard }))).ok, true, 'the portal falls back to the child job\'s membership');
  const view = await readLifecycle(fixture(MEMBER).store, manager, 'job-abc123', {}, new Date(NOW));
  assert.deepEqual(view.account.garageGuard, { plan: 'guard', visitsRemaining: 2, eligible: true });
  assert.deepEqual((await readLifecycle(fixture(member({ status: 'paused' })).store, manager, 'job-abc123', {}, new Date(NOW))).account.garageGuard, { plan: 'guard', visitsRemaining: 2, eligible: false });
  assert.deepEqual((await readLifecycle(typed.store, manager, 'job-abc123', {}, new Date(NOW))).account.garageGuard, { plan: 'guard', visitsRemaining: 4, eligible: false });
  assert.deepEqual((await readLifecycle(relabel.store, manager, 'job-abc123', {}, new Date(NOW))).account.garageGuard, { plan: null, visitsRemaining: null, eligible: false });
  // A sale paid 'other' has no evidence to reconcile, so a manager cannot record it (for example a made-up 'comp').
  const s = fixture(), sale = fields => ({ accountId: 'job-abc123', amountCents: 100000, label: 'EGC gift card', method: 'other', reference: 'comp', ...fields });
  await assert.rejects(s.run('gift_card.sell', sale(), { actor: manager }), error => error.code === 'lifecycle_owner_required' && error.details.reason === 'sale_method_other' && /paid some other way needs the owner/.test(error.message));
  await assert.rejects(s.run('gift_card.sell', sale({ amountCents: 100 }), { actor: manager }), error => error.details?.reason === 'sale_method_other', 'whatever the amount');
  assert.equal(s.commits.length, 0); assert.equal(s.rows('giftCardSales/').length, 0); assert.equal(s.rows('giftCardSaleRefs/').length, 0);
  assert.equal((await s.run('gift_card.sell', sale({ reference: 'Venmo @synthetic-payer 2026-09-22' }))).ok, true, 'the owner may record it');
  assert.equal((await s.run('gift_card.sell', sale({ method: 'cash', reference: 'Cash receipt 55', amountCents: 5000 }), { actor: manager })).ok, true, 'a manager records cash with a receipt');
});

test('a membership the Garage Guard Stripe sync mirrors qualifies while it is active; a Hub status edit removes the marker until the next Stripe event', async () => {
  const f = fixture(), T0 = Math.floor(Date.parse(NOW) / 1000), subscription = 'sub_SyntheticSync1', identity = { customer: 'cus_SyntheticSync1', customer_email: 'synthetic.member@example.invalid' };
  f.docs.set('customers/c1', { id: 'c1', name: 'Synthetic Customer', phone: '970-555-0142', email: 'synthetic.member@example.invalid' });
  f.store.customers = async () => f.rows('customers/').map(row => structuredClone(row));
  f.store.customerJobs = async (customerId, limit) => f.rows('jobs/').filter(row => row.customerId === customerId).slice(0, limit).map(row => structuredClone(row));
  const stripe = event => applyGarageGuardEvent(f.store, garageGuardEvent({ livemode: false, ...event }), { now: NOW });
  const invoice = (id, type, created) => ({ id, type, created, data: { object: { ...identity, billing_reason: 'subscription_cycle', subscription, subscription_details: { metadata: { plan: 'guard' } }, lines: { data: [{ type: 'subscription', subscription, period: { end: T0 + 365 * 86400 }, metadata: { plan: 'guard' } }] } } } });
  const gg = (amountCents = 900) => f.run('credit.issue', credit({ amountCents }), { actor: manager });
  const refused = error => error.code === 'lifecycle_owner_required' && error.details.reason === 'garage_guard_membership';
  // A paid checkout: the real sync links the member by exact email and mirrors garageGuard onto the account root.
  const checkout = await stripe({ id: 'evt_SyntheticCheckout', type: 'checkout.session.completed', created: T0, data: { object: { mode: 'subscription', payment_status: 'paid', subscription, customer: identity.customer, metadata: { plan: 'guard' }, customer_details: { email: identity.customer_email, name: 'Synthetic Customer' } } } });
  assert.equal(checkout.mirrored, true);
  assert.deepEqual([f.job().garageGuard.source, f.job().garageGuard.membershipId, f.job().garageGuard.status, f.job().garageGuard.visitsRemaining], ['stripe', subscription, 'active', 4]);
  assert.equal((await gg()).ok, true, 'a manager turns a paying member\'s unused visit into credit');
  // The Hub's Garage Guard status editor replaces garageGuard without the marker: only the owner may issue until Stripe mirrors it again.
  const account = f.job();
  f.docs.set('jobs/job-abc123', { ...account, garageGuard: { plan: 'guard', status: 'active', visitsIncluded: 4, visitsRemaining: 3, nextVisit: '', renewalDate: '', updatedAt: NOW, updatedBy: 'tylerg' }, revision: 'r-hub-edit' });
  await assert.rejects(gg(), refused);
  assert.equal((await f.run('credit.issue', credit({ amountCents: 900 }))).ok, true, 'the owner may');
  // The next paid invoice mirrors the marker back (keeping the manager's visit count until the new period resets it).
  assert.equal((await stripe(invoice('evt_SyntheticPaid', 'invoice.paid', T0 + 60))).mirrored, true);
  assert.deepEqual([f.job().garageGuard.source, f.job().garageGuard.membershipId, f.job().garageGuard.status], ['stripe', subscription, 'active']);
  assert.equal((await gg()).ok, true);
  // A failed payment makes the member past_due: no manager Garage Guard credit until it is paid.
  await stripe(invoice('evt_SyntheticFailed', 'invoice.payment_failed', T0 + 120));
  assert.equal(f.job().garageGuard.status, 'past_due');
  await assert.rejects(gg(), refused);
  assert.deepEqual(f.job().giftWallet.cards.map(card => [card.creditClass, card.issuedByOwner]), [['garage_guard', false], ['garage_guard', true], ['garage_guard', false]]);
});

test('cards without a class (the flag-off browser tool, or from before FUN-36) count toward the courtesy total when a non-owner issued them at a readable time in the window', async () => {
  // opsIssueCustomerCredit (employee-suite.js) writes {id, label, source, issuedAmount, remainingAmount, issuedAt, issuedBy: employeeIdentity() || 'manager'} with no class.
  const tool = (issuedAt, issuedBy, amount, extra = {}) => ({ id: `credit-${String(issuedBy).trim() || 'blank'}-${amount}`, label: 'EGC service credit', source: 'Manager-issued', issuedAmount: amount, remainingAmount: amount, issuedAt, issuedBy, ...extra });
  const cards = [
    tool('2026-09-21T16:00:00.000Z', 'tylerg', 60), // yesterday, a manager: counts
    tool('2026-08-24T06:00:00.000Z', 'manager', 25), // 00:00 on Aug 24 in Denver, the tool's fallback name: inside the window
    tool('2026-08-24T05:59:00.000Z', 'alexk', 90), // 23:59 on Aug 23 in Denver: outside
    tool('2026-09-21T16:00:00.000Z', 'zacb', 500), tool('2026-09-21T16:00:00.000Z', ' ZacB ', 501), // the owner: never
    tool('2026-09-21T16:00:00.000Z', '', 400), tool('2026-09-21T16:00:00.000Z', undefined, 402), tool('2026-09-21T16:00:00.000Z', 42, 403), // no named issuer: not counted
    tool('sometime', 'tylerg', 404), tool(undefined, 'tylerg', 405), tool('2026-09-21', 'tylerg', 406), // no readable issue time: not counted (unlike a classed card)
    tool('2026-09-21T16:00:00.000Z', 'tylerg', 300, { issuedByOwner: true }),
    tool('2026-09-21T16:00:00.000Z', 'alexk', 5, { creditClass: 'promo' }), // an unknown class is unclassed too: counts
    { id: 'credit-legacy', label: 'Older credit', issuedAmount: 500, remainingAmount: 500 },
  ];
  const f = fixture({ giftWallet: { cards } }), at = new Date(NOW);
  assert.deepEqual((await readLifecycle(f.store, manager, 'job-abc123', {}, at)).account.managerIssued, { contraCents: 9000, prepaidCents: 0, since: '2026-08-24', windowDays: 30 });
  await assert.rejects(f.run('credit.issue', credit({ creditClass: 'courtesy', amountCents: 1001 }), { actor: manager }), error => error.code === 'lifecycle_owner_required' && error.details.managerIssuedCents === 9000 && /\$90\.00 so far/.test(error.message));
  await assert.rejects(f.run('credit.issue', credit({ creditClass: 'referral', amountCents: 1001 }), { actor: manager }), error => error.details?.managerIssuedCents === 9000, 'referral shares the contra total');
  assert.equal((await f.run('credit.issue', credit({ creditClass: 'courtesy', amountCents: 1000 }), { actor: manager })).ok, true, 'up to the limit');
  assert.equal((await f.run('credit.issue', credit({ creditClass: 'courtesy', amountCents: 50000 }))).ok, true, 'the owner is not limited');
  // They never count toward the prepaid group.
  const p = fixture({ ...MEMBER, giftWallet: { cards: [tool('2026-09-21T16:00:00.000Z', 'tylerg', 90)] } });
  assert.equal((await p.run('credit.issue', credit({ amountCents: DEFAULT_PREPAID_OWNER_LIMIT_CENTS }), { actor: manager })).ok, true);
  // One day later the Aug 24 card leaves the window; the tool's card from yesterday stays.
  assert.equal((await readLifecycle(f.store, manager, 'job-abc123', {}, new Date('2026-09-23T06:01:00.000Z'))).account.managerIssued.contraCents, 7500);
  // A counted card with an unreadable amount makes the total unknown and refuses the manager.
  const unreadable = fixture({ giftWallet: { cards: [tool('2026-09-21T16:00:00.000Z', 'tylerg', 'lots')] } });
  await assert.rejects(unreadable.run('credit.issue', credit({ creditClass: 'courtesy', amountCents: 100 }), { actor: manager }), error => error.details?.managerIssuedCents === null && /could not be totalled/.test(error.message));
  const ownerCard = fixture({ giftWallet: { cards: [tool('2026-09-21T16:00:00.000Z', 'zacb', 'lots'), tool('sometime', 'tylerg', 'lots')] } });
  assert.equal((await ownerCard.run('credit.issue', credit({ creditClass: 'courtesy', amountCents: 10000 }), { actor: manager })).ok, true, 'an uncounted card never blocks');
});

test('a gift card sold before the Hub claims its reference like a sale: never added twice, never on top of a recorded sale', async () => {
  const f = fixture(), sold = await f.run('gift_card.sell', { accountId: 'job-abc123', amountCents: 5000, label: 'EGC gift card', method: 'check', reference: 'CHK 77' });
  const saleId = sold.requestId.toLowerCase(), preHub = reference => credit({ creditClass: 'gift_purchase', amountCents: 5000, label: 'EGC gift card', reason: 'Paper card from before the Hub', reference });
  // The review's probe: the sold card's reference imported again (twice) is refused, naming the sale.
  for (const reference of ['CHK 77', 'chk-77']) {
    await assert.rejects(f.run('credit.issue', preHub(reference)), error => error.code === 'lifecycle_sale_duplicate' && error.status === 409 && error.details.saleId === saleId && error.details.method === 'check'
      && error.message.startsWith(`A check gift-card sale with this reference was already recorded (sale ${saleId.slice(0, 8)}, received Sep 22, 2026)`) && /different card, make the reference more specific/.test(error.message), reference);
  }
  const imported = await f.run('credit.issue', preHub('Paper card #0042'));
  const card = f.job().giftWallet.cards.at(-1), claim = f.docs.get(`giftCardSaleRefs/${card.referenceKey}`), writes = f.commits.at(-1);
  assert.deepEqual(writes.map(write => write.collection), ['jobs', 'giftCardSaleRefs', 'lifecycleOperations', 'hub_audit', 'funnelEvents'], 'the claim is in the same commit');
  assert.equal(writes[1].revision, undefined, 'create-only'); assert.match(card.referenceKey, /^[0-9a-f]{64}$/);
  assert.deepEqual({ ...claim, id: undefined, revision: undefined }, { saleId: null, cardId: imported.result.cardId, method: 'pre_hub', amountCents: 5000, receivedAt: null, accountJobId: 'job-abc123', recordedAt: NOW, recordedBy: 'zacb', requestId: imported.requestId, id: undefined, revision: undefined });
  const cardShort = imported.requestId.toLowerCase().slice(0, 8);
  await assert.rejects(f.run('credit.issue', preHub('paper card 0042')), error => error.code === 'lifecycle_sale_duplicate' && error.details.method === 'pre_hub' && error.details.saleId === null && error.details.cardId === imported.result.cardId
    && error.message.startsWith(`A gift card sold before the Hub was already added with this reference (card ${cardShort}, added Sep 22, 2026)`));
  // A sale under the imported card's reference, by any method, is the same card.
  for (const method of ['check', 'other']) await assert.rejects(f.run('gift_card.sell', { accountId: 'job-abc123', amountCents: 5000, label: 'EGC gift card', method, reference: 'PAPER CARD #0042' }), error => error.code === 'lifecycle_sale_duplicate' && error.details.method === 'pre_hub', method);
  assert.deepEqual(f.job().giftWallet.cards.map(item => [item.creditClass, item.issuedAmountCents]), [['gift_purchase', 5000], ['gift_purchase', 5000]], 'one sold card and one imported card; the liability is never doubled');
  assert.equal(f.rows('funnelEvents/').filter(event => event.type === 'credit.issued').length, 2); assert.equal(f.rows('giftCardSales/').length, 1); assert.equal(f.rows('giftCardSaleRefs/').length, 2);
  // Two imports racing past the read: the create-only claim fails the second commit and nothing is written.
  const race = fixture(), raced = race.input('credit.issue', preHub('Paper card 0099'));
  race.beforeCommit(writes => { const taken = writes.find(write => write.collection === 'giftCardSaleRefs'); race.docs.set(`giftCardSaleRefs/${taken.id}`, { saleId: 'someone-else', revision: 'x1' }); });
  await assert.rejects(mutateLifecycle(race.store, owner, raced, NOW), error => error.code === 'lifecycle_revision_conflict');
  assert.equal(race.job().giftWallet, undefined); assert.equal(race.rows('lifecycleOperations/').length, 0);
});

test('replaying a requestId returns the saved result; another payload, actor or signed-in employee is refused; a lost response is recovered', async () => {
  const f = fixture(), input = f.input('credit.issue', credit());
  const first = await mutateLifecycle(f.store, owner, input, NOW), second = await mutateLifecycle(f.store, owner, structuredClone(input), NOW);
  assert.deepEqual({ ...second, replayed: false }, first); assert.equal(second.replayed, true); assert.equal(f.commits.length, 1);
  await assert.rejects(mutateLifecycle(f.store, owner, { ...input, amountCents: 5001 }, NOW), error => error.code === 'lifecycle_idempotency_conflict' && error.status === 409);
  await assert.rejects(mutateLifecycle(f.store, manager, input, NOW), error => error.code === 'lifecycle_idempotency_conflict');
  await assert.rejects(mutateLifecycle(f.store, owner, { ...f.input('credit.issue', credit()), actorId: 'tylerg' }, NOW), error => error.code === 'lifecycle_actor_changed' && error.status === 403);
  // A later change never makes the saved result fail: the receipt is the proof it applied.
  await f.run('credit.issue', credit({ amountCents: 700 }));
  const later = await mutateLifecycle(f.store, owner, input, NOW);
  assert.equal(later.replayed, true); assert.deepEqual(later.result, first.result); assert.equal(later.context.account.credits.length, 2);
  assert.equal(f.job().giftWallet.cards.length, 2);
  // Lost commit response: the same request is recovered, never applied twice.
  const g = fixture(), lost = g.input('decision.prompt', { title: 'Haul the extra shelving?', details: 'Two more units behind the freezer.', priceDeltaCents: 7500 }), commit = g.store.commit;
  g.store.commit = async writes => { await commit(writes); throw Object.assign(new Error('lost'), { code: 'lifecycle_outcome_unknown', status: 503 }); };
  const recovered = await mutateLifecycle(g.store, owner, lost, NOW);
  g.store.commit = commit;
  assert.equal(recovered.replayed, false); assert.equal(recovered.result.decisionId, `decision-${lost.requestId.toLowerCase()}`);
  assert.equal((await mutateLifecycle(g.store, owner, lost, NOW)).replayed, true); assert.equal(g.job().customerDecisions.length, 1); assert.equal(g.commits.length, 1);
  // A failure before anything saved stays a failure (no receipt).
  const h = fixture(), failing = h.input('credit.issue', credit());
  h.store.commit = async () => { throw Object.assign(new Error('lost'), { code: 'lifecycle_outcome_unknown', status: 503 }); };
  await assert.rejects(mutateLifecycle(h.store, owner, failing, NOW), error => error.code === 'lifecycle_outcome_unknown' && error.status === 503);
});

test('a stale expectedRevision or a concurrent write is lifecycle_revision_conflict and writes nothing', async () => {
  const f = fixture();
  await assert.rejects(mutateLifecycle(f.store, owner, { ...f.input('credit.issue', credit()), expectedRevision: 'stale' }, NOW), error => error.code === 'lifecycle_revision_conflict' && error.status === 409);
  f.beforeCommit(() => { f.job().revision = 'changed-by-someone-else'; });
  await assert.rejects(f.run('decision.prompt', { title: 'Keep the bikes?', details: 'Customer was unsure.' }), error => error.code === 'lifecycle_revision_conflict');
  assert.equal(f.commits.length, 0);
  for (const prefix of ['hub_audit/', 'lifecycleOperations/', 'funnelEvents/', 'giftCardSales/']) assert.equal(f.rows(prefix).length, 0, prefix);
});

test('decision.prompt stamps a pending decision with the server clock and emits change_order.proposed; money totals do not move until the customer approves', async () => {
  const f = fixture(), totals = customerMoneyTotals(f.job());
  const result = await f.run('decision.prompt', { title: 'Remove the damaged cabinet?', details: 'The back panel is broken.\nIt is not safe to rehang.', priceDeltaCents: 7550, timeDeltaMinutes: 30, photoUrl: 'https://drive.google.com/file/d/synthetic-photo/view' }, { actor: manager });
  const decision = f.job().customerDecisions[0], writes = f.commits[0];
  assert.deepEqual(writes.map(write => write.collection), ['jobs', 'lifecycleOperations', 'hub_audit', 'funnelEvents']);
  assert.deepEqual(Object.keys(writes[0].patch).sort(), ['customerDecisionUpdatedAt', 'customerDecisions', 'updatedAt']);
  assert.deepEqual({ ...decision }, { id: `decision-${result.requestId.toLowerCase()}`, title: 'Remove the damaged cabinet?', details: 'The back panel is broken.\nIt is not safe to rehang.', priceDelta: 75.5, priceDeltaCents: 7550, timeDeltaMinutes: 30,
    photoUrl: 'https://drive.google.com/file/d/synthetic-photo/view', status: 'pending', promptedAt: NOW, promptedBy: 'tylerg', requestId: result.requestId, source: 'egc_hub' });
  assert.equal(f.job().customerDecisionUpdatedAt, NOW); assert.equal(f.job().approvedChangeTotal, undefined);
  assert.deepEqual(customerMoneyTotals(f.job()), totals, 'a pending decision never changes the job total');
  const [event] = f.rows('funnelEvents/');
  assert.equal(event.type, 'change_order.proposed'); assert.equal(event.group, 'deal'); assert.deepEqual(event.data, { amountCents: 7550 }); assert.equal(event.entityKey, 'projectId:project_job-abc123'); assert.equal(event.actor.role, 'manager');
  assert.deepEqual(result.context.job.decisions.map(item => [item.status, item.priceDeltaCents, item.promptedAt]), [['pending', 7550, NOW]]);
  // The customer's approval (the portal writes status approved) is what moves money, through the existing reader.
  const approved = { ...f.job(), customerDecisions: [{ ...decision, status: 'approved' }], approvedChangeTotal: 75.5 };
  assert.equal(customerMoneyTotals(approved).totalCents, totals.totalCents + 7550);
  // The client never chooses the time or the status.
  await assert.rejects(f.run('decision.prompt', { title: 'Keep?', details: 'Unsure.', promptedAt: '2020-01-01T00:00:00.000Z' }), error => error.code === 'lifecycle_request_invalid' && error.details.fields.includes('promptedAt'));
  const zero = await f.run('decision.prompt', { title: 'Donate the old paint?', details: 'Six cans, half full.' });
  assert.deepEqual([f.job().customerDecisions[1].priceDeltaCents, f.job().customerDecisions[1].timeDeltaMinutes, f.job().customerDecisions[1].photoUrl], [0, 0, '']);
  assert.equal(f.rows('funnelEvents/').find(item => item.source.id === zero.requestId.toLowerCase()).data.amountCents, 0);
  for (const bad of [{ photoUrl: 'https://evil.example.invalid/photo' }, { photoUrl: 'javascript:alert(1)' }, { timeDeltaMinutes: -5 }, { timeDeltaMinutes: 4321 }, { timeDeltaMinutes: 1.5 }, { priceDeltaCents: -1 }, { title: '' }, { details: 'x'.repeat(1201) }]) {
    await assert.rejects(f.run('decision.prompt', { title: 'Keep the bikes?', details: 'Customer was unsure.', ...bad }), error => /^lifecycle_invalid_(field|amount)$/.test(error.code), JSON.stringify(bad));
  }
});

test('decision.prompt refuses walkthroughs, cancelled jobs, unreadable lists and a full list instead of dropping an old decision', async () => {
  const walk = fixture({ type: 'walkthrough' });
  await assert.rejects(walk.run('decision.prompt', { title: 'Keep?', details: 'Unsure.' }), error => error.code === 'lifecycle_job_not_supported' && error.status === 409);
  const cancelled = fixture({ status: 'cancelled', pipelineStatus: 'cancelled' });
  await assert.rejects(cancelled.run('decision.prompt', { title: 'Keep?', details: 'Unsure.' }), error => error.code === 'lifecycle_job_closed');
  const broken = fixture({ customerDecisions: { id: 'not-a-list' } });
  await assert.rejects(broken.run('decision.prompt', { title: 'Keep?', details: 'Unsure.' }), error => error.code === 'lifecycle_record_invalid' && error.status === 409);
  const approved = { id: 'decision-approved', title: 'Extra haul', priceDelta: 150, status: 'approved' };
  const full = fixture({ customerDecisions: [approved, ...Array.from({ length: MAX_DECISIONS - 1 }, (_, i) => ({ id: `decision-${i}`, title: `Old ${i}`, priceDelta: 0, status: 'declined' }))], approvedChangeTotal: 150 });
  await assert.rejects(full.run('decision.prompt', { title: 'Keep?', details: 'Unsure.' }), error => error.code === 'lifecycle_decision_limit' && error.status === 409 && /cannot archive answered decisions yet: ask the owner to have the developer archive/.test(error.message));
  assert.equal(full.job().customerDecisions[0].id, 'decision-approved', 'the approved change order is never dropped');
  for (const f of [walk, cancelled, broken, full]) assert.equal(f.commits.length, 0);
});

test('rebook.mark_contacted marks one pending portal request contacted with the server clock and emits rebook.contacted', async () => {
  const requests = [{ id: 'rebook-1', kind: 'touch_up', timing: 'asap', status: 'pending', requestedAt: '2026-09-20T15:00:00.000Z', notes: 'Same crew please', preferredCrew: true }, { id: 'rebook-2', kind: 'repeat', timing: 'choose_date', preferredDate: '2026-10-10', status: 'pending', requestedAt: '2026-09-21T15:00:00.000Z' }];
  const f = fixture({ rebookingRequests: requests, rebookingStatus: 'pending' });
  const result = await f.run('rebook.mark_contacted', { rebookingRequestId: 'rebook-2', note: 'Called; holding Oct 10 morning.' }, { actor: manager });
  const saved = f.job().rebookingRequests;
  assert.deepEqual(saved[0], requests[0], 'the other request is unchanged');
  assert.deepEqual({ ...saved[1] }, { ...requests[1], status: 'contacted', reviewedAt: NOW, reviewedBy: 'tylerg', reviewNote: 'Called; holding Oct 10 morning.', contactedAt: NOW, contactedRequestId: result.requestId });
  assert.equal(f.job().rebookingStatus, 'pending', 'another request is still waiting'); assert.equal(f.job().rebookingUpdatedAt, NOW);
  assert.deepEqual(Object.keys(f.commits[0][0].patch).sort(), ['rebookingRequests', 'rebookingStatus', 'rebookingUpdatedAt', 'updatedAt']);
  const [event] = f.rows('funnelEvents/');
  assert.equal(event.type, 'rebook.contacted'); assert.equal(event.entityKey, 'jobId:job-abc123'); assert.deepEqual(event.data, {}); assert.equal(event.customerId, 'c1');
  assert.deepEqual(result.result, { rebookingRequestId: 'rebook-2', targetId: 'job-abc123' });
  await f.run('rebook.mark_contacted', { rebookingRequestId: 'rebook-1', note: 'Texted to confirm.' });
  assert.equal(f.job().rebookingStatus, 'contacted');
  await assert.rejects(f.run('rebook.mark_contacted', { rebookingRequestId: 'rebook-1', note: 'Again' }), error => error.code === 'lifecycle_rebooking_not_pending' && error.status === 409);
  await assert.rejects(f.run('rebook.mark_contacted', { rebookingRequestId: 'rebook-9', note: 'Called' }), error => error.code === 'lifecycle_rebooking_not_found' && error.status === 404);
  await assert.rejects(f.run('rebook.mark_contacted', { rebookingRequestId: '../x', note: 'Called' }), error => error.code === 'lifecycle_request_invalid');
  const fresh = fixture({ rebookingRequests: requests });
  await assert.rejects(fresh.run('rebook.mark_contacted', { rebookingRequestId: 'rebook-1', note: '' }), error => error.code === 'lifecycle_invalid_field');
  const legacy = fixture({ rebookingRequests: 'unreadable' });
  await assert.rejects(legacy.run('rebook.mark_contacted', { rebookingRequestId: 'rebook-1', note: 'Called' }), error => error.code === 'lifecycle_record_invalid');
  assert.equal(fresh.commits.length + legacy.commits.length, 0);
  assert.equal(f.commits.length, 2);
});

test('a full wallet is refused instead of dropping a live credit, and unreadable wallets are never overwritten', async () => {
  const cards = Array.from({ length: MAX_WALLET_CARDS }, (_, i) => ({ id: `credit-${i}`, label: 'Credit', issuedAmount: 10, remainingAmount: i === 0 ? 10 : 0 }));
  const f = fixture({ giftWallet: { cards } });
  await assert.rejects(f.run('credit.issue', credit()), error => error.code === 'lifecycle_wallet_full' && error.status === 409 && /cannot archive used credits yet: ask the owner to have the developer archive/.test(error.message));
  await assert.rejects(f.run('gift_card.sell', { accountId: 'job-abc123', amountCents: 100, label: 'Card', method: 'cash', reference: 'R1' }), error => error.code === 'lifecycle_wallet_full');
  const view = lifecycleProjection({ job: f.job(), account: f.job() });
  assert.equal(view.account.full, true); assert.equal(view.account.availableCents, 1000);
  for (const giftWallet of [{ cards: 'nope' }, 'nope']) {
    const g = fixture({ giftWallet });
    await assert.rejects(g.run('credit.issue', credit()), error => error.code === 'lifecycle_record_invalid');
    assert.equal(lifecycleProjection({ job: g.job(), account: g.job() }).account.availableCents, null, 'an unreadable wallet is unknown, never $0');
  }
  const unknown = fixture({ giftWallet: { cards: [{ id: 'credit-x', remainingAmount: 'twelve' }] } });
  assert.equal(lifecycleProjection({ job: unknown.job(), account: unknown.job() }).account.availableCents, null);
  assert.equal(f.commits.length, 0);
});

test('only signed-in operations managers and the owner may act, with a supported action, known fields and valid ids', async () => {
  const f = fixture();
  await assert.rejects(f.run('credit.issue', credit(), { actor: null }), error => error.code === 'lifecycle_sign_in_required' && error.status === 401);
  await assert.rejects(f.run('credit.issue', credit(), { actor: crew }), error => error.code === 'lifecycle_forbidden' && error.status === 403);
  await assert.rejects(f.run('credit.issue', credit(), { actor: { ...manager, businessAccess: false } }), error => error.code === 'lifecycle_forbidden');
  await assert.rejects(f.run('credit.issue', credit(), { actor: { user: 'someone', role: 'owner', businessAccess: true } }), error => error.code === 'lifecycle_forbidden');
  await assert.rejects(f.run('credit.refund', {}), error => error.code === 'lifecycle_request_invalid');
  await assert.rejects(f.run('credit.issue', credit({ giftWallet: {} })), error => error.code === 'lifecycle_request_invalid' && error.details.fields[0] === 'giftWallet');
  await assert.rejects(mutateLifecycle(f.store, owner, { ...f.input('credit.issue', credit()), requestId: 'not-a-uuid' }, NOW), error => error.code === 'lifecycle_request_invalid');
  for (const jobId of ['_egc_schedule_lock_2026-09-22', 'secure_vault', '../jobs', '']) await assert.rejects(mutateLifecycle(f.store, owner, { ...f.input('credit.issue', credit()), jobId }, NOW), error => error.code === 'lifecycle_request_invalid', jobId);
  await assert.rejects(f.run('credit.issue', credit({ accountId: undefined })), error => error.code === 'lifecycle_request_invalid');
  const blocked = fixture({ type: 'blocked' }), vault = fixture({ recordType: 'employee_hub_v2' });
  for (const g of [blocked, vault]) await assert.rejects(g.run('decision.prompt', { title: 'Keep?', details: 'Unsure.' }), error => error.code === 'lifecycle_job_not_found' && error.status === 404);
  assert.equal(f.commits.length, 0);
});

test('MCP-sourced actors are recorded as via mcp, and test jobs mark their events as test', async () => {
  const f = fixture({ isTest: true });
  await mutateLifecycle(f.store, { ...owner, via: 'mcp' }, f.input('credit.issue', credit()), NOW);
  const [event] = f.rows('funnelEvents/'), [audit] = f.rows('hub_audit/'), [receipt] = f.rows('lifecycleOperations/');
  assert.deepEqual([event.via, audit.via, receipt.via], ['mcp', 'mcp', 'mcp']); assert.deepEqual([event.isTest, event.exclusion], [true, 'test']);
});

test('readLifecycle projects an allowlist: credits in cents, pending requests and what the viewer may do, never payment or private data', async () => {
  const f = fixture({ opsNotes: 'PRIVATE-NOTE', signature: 'data:image/png;base64,PRIVATE', giftWallet: { cards: [{ id: 'credit-1', label: 'Garage Guard credit', issuedAmount: 100, remainingAmount: 25, creditClass: 'garage_guard', reason: 'PRIVATE-REASON', issuedBy: 'zacb' }], redemptions: [{ id: 'r1', amount: 75 }] },
    customerDecisions: [{ id: 'decision-1', title: 'Remove cabinet?', details: 'PRIVATE-DETAIL', priceDelta: 75, status: 'approved', promptedAt: '2026-09-04T18:00:00Z' }], rebookingRequests: [{ id: 'rebook-1', kind: 'touch_up', status: 'pending', notes: 'Same crew', requestedAt: '2026-09-20T15:00:00.000Z' }] });
  const at = new Date(NOW), view = await readLifecycle(f.store, manager, 'job-abc123', { courtesyOwnerLimitCents: 5000, prepaidOwnerLimitCents: 60000 }, at);
  assert.deepEqual(view.viewer, { id: 'tylerg', owner: false }); assert.equal((await readLifecycle(f.store, owner, 'job-abc123', {}, at)).viewer.owner, true);
  assert.deepEqual(view.limits, { courtesyOwnerLimitCents: 5000, prepaidOwnerLimitCents: 60000, maxCredits: 20, maxDecisions: 20, maxTimeDeltaMinutes: 4320, managerLimitDays: 30 });
  assert.deepEqual((await readLifecycle(f.store, owner, 'job-abc123', {}, at)).limits, { courtesyOwnerLimitCents: 10000, prepaidOwnerLimitCents: 100000, maxCredits: 20, maxDecisions: 20, maxTimeDeltaMinutes: 4320, managerLimitDays: 30 });
  // A classed card without issuedByOwner (and without an issue time) counts toward the managers' total; no membership is on file.
  assert.deepEqual(view.account.managerIssued, { contraCents: 0, prepaidCents: 10000, since: '2026-08-24', windowDays: 30 });
  assert.deepEqual(view.account.garageGuard, { plan: null, visitsRemaining: null, eligible: false });
  assert.deepEqual(view.account.credits, [{ id: 'credit-1', label: 'Garage Guard credit', creditClass: 'garage_guard', issuedCents: 10000, remainingCents: 2500, issuedAt: null, issuedBy: 'zacb', saleId: null }]);
  assert.equal(view.account.availableCents, 2500); assert.equal(view.job.revision, 'r0'); assert.equal(view.job.decisionsAllowed, true);
  assert.deepEqual(view.job.decisions.map(item => [item.id, item.status, item.priceDeltaCents]), [['decision-1', 'approved', 7500]]);
  assert.deepEqual(view.job.rebooking.map(item => [item.id, item.kind, item.status, item.notes]), [['rebook-1', 'touch_up', 'pending', 'Same crew']]);
  const json = JSON.stringify(view);
  for (const secret of ['PRIVATE-NOTE', 'PRIVATE-REASON', 'PRIVATE-DETAIL', 'data:image', 'CHK-1', 'paymentLedger', 'estimate', 'invoice']) assert.equal(json.includes(secret), false, secret);
  await assert.rejects(readLifecycle(f.store, crew, 'job-abc123', {}, at), error => error.code === 'lifecycle_forbidden');
  await assert.rejects(readLifecycle(f.store, owner, 'secure_x', {}, at), error => error.code === 'lifecycle_query_invalid');
  await assert.rejects(readLifecycle(f.store, owner, 'missing-job', {}, at), error => error.code === 'lifecycle_job_not_found');
  assert.equal(lifecycleApiEnabled({ CUSTOMER_LIFECYCLE_API_ENABLED: 'true' }), true);
  for (const value of [undefined, 'TRUE', '1', 'yes', ' true']) assert.equal(lifecycleApiEnabled({ CUSTOMER_LIFECYCLE_API_ENABLED: value }), false, String(value));
});
