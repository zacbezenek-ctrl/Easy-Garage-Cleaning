import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { customerLifecycleHandlers } from '../functions/api/customer-lifecycle.js';
import { lifecycleStorage, mutateLifecycle } from '../functions/_lib/customer-lifecycle.js';
import { createHubSessionCookie, hashHubCredential } from '../functions/_lib/hub-session.js';
import { decodeFirestoreFields, encodeFirestoreFields } from '../functions/_lib/firestore-job.js';
import { env as portalEnv, portalCookie, portalHandlers, portalPost, portalStore, portalView } from './helpers/portal-fixture.mjs';

const NOW = '2026-09-22T18:00:00.000Z';
const URL_BASE = 'https://easygaragecleaning.com/api/customer-lifecycle';
const ENABLED = { CUSTOMER_LIFECYCLE_API_ENABLED: 'true' };
const owner = { user: 'zacb', role: 'owner', businessAccess: true, displayName: 'Synthetic Owner' };
const manager = { user: 'tylerg', role: 'manager', businessAccess: true, displayName: 'Synthetic Manager' };
const crew = { user: 'crew1', role: 'crew', businessAccess: false, displayName: 'Synthetic Crew' };
const PAID = { estimate: { number: 'EST-ABC123', status: 'accepted', amount: 1400, depositRequired: 700 }, customerApproval: { status: 'approved', amount: 1400 }, total: 1400,
  payment: { amount: 700, verified: true, method: 'check', reference: 'CHK-1', lastAmount: 700, recordedBy: 'zacb', lastReceivedAt: '2026-09-20T18:00:00.000Z' }, invoice: { number: 'INV-ABC123', status: 'partial', amount: 1400, paid: 700, balance: 700 } };

function fixture(job = {}) {
  const docs = new Map([['jobs/job-abc123', { id: 'job-abc123', revision: 'r0', type: 'job', customerId: 'c1', customer: 'Synthetic Customer', serviceType: 'Garage transformation', date: '2026-09-24', status: 'in_progress', ...PAID, ...job }]]);
  let n = 0, fault = null;
  const store = {
    read: async (collection, id) => { if (fault) throw fault; return structuredClone(docs.get(`${collection}/${id}`) ?? null); },
    async commit(writes) {
      for (const write of writes) { const old = docs.get(`${write.collection}/${write.id}`); if (write.revision ? old?.revision !== write.revision : old) throw Object.assign(new Error('Conflict'), { code: 'lifecycle_revision_conflict', status: 409 }); }
      for (const write of writes) { if (write.verify) continue; const key = `${write.collection}/${write.id}`; docs.set(key, { ...(write.revision ? docs.get(key) : {}), ...structuredClone(write.patch), id: write.id, revision: `r${++n}` }); }
    },
  };
  return { docs, store, fail: error => { fault = error; }, job: (id = 'job-abc123') => docs.get(`jobs/${id}`) };
}
const handlers = (f, actor = owner) => customerLifecycleHandlers({ session: async () => actor, storage: () => f.store, now: () => new Date(NOW) });
const post = (body, headers = {}) => new Request(URL_BASE, { method: 'POST', headers: { Origin: 'https://easygaragecleaning.com', 'Content-Type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
const get = (query = '', headers = {}) => new Request(`${URL_BASE}${query}`, { headers: { 'Sec-Fetch-Site': 'same-origin', ...headers } });
const issue = (f, extra = {}) => ({ action: 'credit.issue', requestId: randomUUID(), jobId: 'job-abc123', accountId: 'job-abc123', expectedRevision: f.job().revision, amountCents: 5000, creditClass: 'referral', label: 'Referral reward', reason: 'Referred a neighbor', ...extra });
const json = async response => ({ status: response.status, body: await response.json(), headers: response.headers });

test('POST refuses cross-site and foreign-origin requests before reading the session or the store', async () => {
  const f = fixture();
  let sessions = 0;
  const api = customerLifecycleHandlers({ session: async () => { sessions++; return owner; }, storage: () => f.store, now: () => new Date(NOW) });
  for (const headers of [{ 'Sec-Fetch-Site': 'cross-site' }, { Origin: 'https://evil.example' }, { Origin: '', Referer: 'https://easygaragecleaning.com.evil.example/x' }, { Origin: 'null' }]) {
    const response = await json(await api.post({ request: post(issue(f), headers), env: ENABLED }));
    assert.equal(response.status, 403, JSON.stringify(headers)); assert.equal(response.body.code, 'lifecycle_origin_forbidden');
  }
  assert.equal(sessions, 0); assert.equal(f.job().giftWallet, undefined);
  const request = new Request(URL_BASE, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(issue(f)) });
  assert.equal((await api.post({ request, env: ENABLED })).status, 200, 'a missing Origin is allowed only because the session cookie is SameSite=Strict');
});

test('POST stays off unless CUSTOMER_LIFECYCLE_API_ENABLED is exactly true, so the browser keeps its current tools', async () => {
  const f = fixture();
  for (const env of [{}, { CUSTOMER_LIFECYCLE_API_ENABLED: 'TRUE' }, { CUSTOMER_LIFECYCLE_API_ENABLED: '1' }, { CUSTOMER_LIFECYCLE_API_ENABLED: 'false' }]) {
    const response = await json(await handlers(f).post({ request: post(issue(f)), env }));
    assert.equal(response.status, 404); assert.equal(response.body.code, 'lifecycle_api_disabled');
  }
  assert.equal(f.job().giftWallet, undefined);
  const read = await json(await handlers(f).get({ request: get('?jobId=job-abc123'), env: {} }));
  assert.equal(read.status, 200); assert.equal(read.body.enabled, false, 'reads report the flag so the Hub can hand over to its current tools');
});

test('POST saves through the service with JSON, size and role checks, and maps every failure to a safe lifecycle_* reply', async () => {
  const f = fixture(), api = handlers(f);
  const saved = await json(await api.post({ request: post(issue(f)), env: ENABLED }));
  assert.equal(saved.status, 200); assert.equal(saved.body.ok, true); assert.equal(saved.body.action, 'credit.issue');
  assert.equal(saved.headers.get('Cache-Control'), 'no-store'); assert.equal(saved.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.equal(f.job().giftWallet.cards[0].creditClass, 'referral'); assert.equal(saved.body.context.account.availableCents, 5000);
  assert.equal(f.docs.get(`lifecycleOperations/${saved.body.requestId.toLowerCase()}`).createdAt, NOW, 'the injected clock stamps the receipt');
  const wrongType = await json(await api.post({ request: post(issue(f), { 'Content-Type': 'text/plain' }), env: ENABLED }));
  assert.equal(wrongType.status, 415); assert.equal(wrongType.body.code, 'lifecycle_json_required');
  const big = await json(await api.post({ request: post(JSON.stringify({ ...issue(f), reason: 'x'.repeat(16001) })), env: ENABLED }));
  assert.equal(big.status, 413); assert.equal(big.body.code, 'lifecycle_request_too_large');
  const declared = await json(await api.post({ request: post(issue(f), { 'Content-Length': '16001' }), env: ENABLED }));
  assert.equal(declared.status, 413);
  const broken = await json(await api.post({ request: post('{"action":'), env: ENABLED }));
  assert.equal(broken.status, 400); assert.equal(broken.body.code, 'lifecycle_json_invalid');
  const stale = await json(await api.post({ request: post({ ...issue(f), expectedRevision: 'r0' }), env: ENABLED }));
  assert.equal(stale.status, 409); assert.equal(stale.body.code, 'lifecycle_revision_conflict');
  const limited = await json(await handlers(f, manager).post({ request: post(issue(f, { creditClass: 'courtesy', amountCents: 2600 })), env: { ...ENABLED, COURTESY_CREDIT_OWNER_LIMIT_CENTS: '2500' } }));
  assert.equal(limited.status, 403); assert.equal(limited.body.code, 'lifecycle_owner_required'); assert.deepEqual(limited.body.details, { limitCents: 2500, managerIssuedCents: 0, windowDays: 30 }, 'the owner\'s own referral credit does not count toward a manager\'s total');
  const referral = await json(await handlers(f, manager).post({ request: post(issue(f, { amountCents: 2600 })), env: { ...ENABLED, COURTESY_CREDIT_OWNER_LIMIT_CENTS: '2500' } }));
  assert.equal(referral.status, 403); assert.equal(referral.body.code, 'lifecycle_owner_required', 'referral credits share the courtesy owner limit');
  const sale = { action: 'gift_card.sell', requestId: randomUUID(), jobId: 'job-abc123', accountId: 'job-abc123', expectedRevision: f.job().revision, amountCents: 60000, label: 'EGC gift card', method: 'cash', reference: 'Cash receipt 9' };
  const prepaid = await json(await handlers(f, manager).post({ request: post(sale), env: { ...ENABLED, PREPAID_CREDIT_OWNER_LIMIT_CENTS: '50000' } }));
  assert.equal(prepaid.status, 403); assert.equal(prepaid.body.code, 'lifecycle_owner_required'); assert.deepEqual(prepaid.body.details, { limitCents: 50000, managerIssuedCents: 0, windowDays: 30 });
  assert.equal((await handlers(f, manager).post({ request: post(sale), env: ENABLED })).status, 200, 'under the default $1,000.00 prepaid limit a manager may record it');
  const again = await json(await handlers(f, manager).post({ request: post({ ...sale, requestId: randomUUID(), expectedRevision: f.job().revision, reference: 'cash receipt #9' }), env: ENABLED }));
  assert.equal(again.status, 409); assert.equal(again.body.code, 'lifecycle_sale_duplicate'); assert.equal(again.body.details.saleId, sale.requestId.toLowerCase());
  const over = await json(await handlers(f, manager).post({ request: post({ ...sale, requestId: randomUUID(), expectedRevision: f.job().revision, amountCents: 40001, reference: 'Cash receipt 10' }), env: ENABLED }));
  assert.equal(over.status, 403); assert.deepEqual(over.body.details, { limitCents: 100000, managerIssuedCents: 60000, windowDays: 30 }, 'the manager\'s earlier sale counts toward the prepaid limit');
  const other = await json(await handlers(f, manager).post({ request: post({ ...sale, requestId: randomUUID(), expectedRevision: f.job().revision, amountCents: 100, method: 'other', reference: 'comp' }), env: ENABLED }));
  assert.equal(other.status, 403); assert.equal(other.body.code, 'lifecycle_owner_required'); assert.deepEqual(other.body.details, { reason: 'sale_method_other' });
  const guard = await json(await handlers(f, manager).post({ request: post(issue(f, { creditClass: 'garage_guard', amountCents: 100 })), env: ENABLED }));
  assert.equal(guard.status, 403); assert.deepEqual(guard.body.details, { reason: 'garage_guard_membership' }, 'no Garage Guard membership on this account');
  for (const actor of [null, crew]) {
    const denied = await json(await handlers(f, actor).post({ request: post(issue(f)), env: ENABLED }));
    assert.equal(denied.status, actor ? 403 : 401); assert.equal(denied.body.code, actor ? 'lifecycle_forbidden' : 'lifecycle_sign_in_required');
  }
  f.fail(Object.assign(new Error('socket hang up at 10.0.0.1 with token sk_live_secret'), { code: 'ECONNRESET' }));
  const unknown = await json(await api.post({ request: post(issue(f)), env: ENABLED }));
  assert.equal(unknown.status, 503); assert.equal(unknown.body.code, 'lifecycle_unavailable'); assert.match(unknown.body.error, /retry it unchanged/);
  assert.equal(JSON.stringify(unknown.body).includes('sk_live'), false, 'raw exception text never reaches the browser');
  assert.equal(f.job().giftWallet.cards.length, 2);
});

test('GET returns the allowlisted customer view for exactly one job to managers, and refuses sibling sites and other filters', async () => {
  const f = fixture({ giftWallet: { cards: [{ id: 'credit-1', label: 'Credit', issuedAmount: 40, remainingAmount: 40, creditClass: 'courtesy' }] } });
  const read = await json(await handlers(f, manager).get({ request: get('?jobId=job-abc123'), env: { ...ENABLED, COURTESY_CREDIT_OWNER_LIMIT_CENTS: '7500', PREPAID_CREDIT_OWNER_LIMIT_CENTS: '40000' } }));
  assert.equal(read.status, 200); assert.equal(read.body.authority, 'employee_hub'); assert.equal(read.body.enabled, true); assert.equal(read.body.asOf, NOW);
  assert.deepEqual(read.body.viewer, { id: 'tylerg', owner: false }); assert.equal(read.body.limits.courtesyOwnerLimitCents, 7500); assert.equal(read.body.limits.prepaidOwnerLimitCents, 40000);
  assert.equal(read.body.account.availableCents, 4000); assert.equal(read.body.job.revision, 'r0'); assert.equal(read.headers.get('Cache-Control'), 'no-store');
  // The owner-limit window runs on the injected clock (Sep 22 in Denver, so from Aug 24).
  assert.equal(read.body.limits.managerLimitDays, 30); assert.deepEqual(read.body.account.managerIssued, { contraCents: 4000, prepaidCents: 0, since: '2026-08-24', windowDays: 30 });
  assert.deepEqual(read.body.account.garageGuard, { plan: null, visitsRemaining: null, eligible: false });
  assert.equal(JSON.stringify(read.body).includes('CHK-1'), false, 'payments are not part of this view');
  for (const query of ['', '?jobId=job-abc123&jobId=job-abc123', '?jobId=job-abc123&view=all', '?view=all']) {
    const bad = await json(await handlers(f).get({ request: get(query), env: ENABLED }));
    assert.equal(bad.status, 400, query); assert.equal(bad.body.code, 'lifecycle_query_invalid');
  }
  for (const headers of [{ 'Sec-Fetch-Site': 'same-site' }, { 'Sec-Fetch-Site': 'cross-site' }, { Origin: 'https://evil.example' }]) assert.equal((await handlers(f).get({ request: get('?jobId=job-abc123', headers), env: ENABLED })).status, 403);
  assert.equal((await json(await handlers(f).get({ request: get('?jobId=missing'), env: ENABLED }))).body.code, 'lifecycle_job_not_found');
  assert.equal((await handlers(f, crew).get({ request: get('?jobId=job-abc123'), env: ENABLED })).status, 403);
});

test('integration-status surfaces the lifecycle flag (exactly "true") to signed-in Hub users only', async () => {
  const { onRequestGet } = await import('../functions/api/integration-status.js');
  const env = { HUB_SESSION_SECRET: 'synthetic-lifecycle-flag-secret', HUB_AUTH_USERS_JSON: JSON.stringify({ ZacB: await hashHubCredential('ZacB', 'synthetic password') }) };
  const cookie = (await createHubSessionCookie(env, 'ZacB')).split(';')[0];
  const read = async extra => (await onRequestGet({ request: new Request('https://easygaragecleaning.com/api/integration-status', { headers: { Cookie: cookie } }), env: { ...env, ...extra } })).json();
  assert.equal((await read({})).flags.lifecycleApi, false);
  assert.equal((await read(ENABLED)).flags.lifecycleApi, true);
  assert.equal((await read({ CUSTOMER_LIFECYCLE_API_ENABLED: 'yes' })).flags.lifecycleApi, false);
  const anonymous = await onRequestGet({ request: new Request('https://easygaragecleaning.com/api/integration-status'), env: { ...env, ...ENABLED } });
  assert.equal(anonymous.status, 401); assert.equal((await anonymous.json()).flags, undefined);
});

// Firestore REST as dispatchStorage speaks it: document reads, a transaction
// fence (beginTransaction + masked batchGet) and :commit with preconditions.
function firestore({ commitFails = null } = {}) {
  const docs = new Map(), calls = [];
  let stamp = 0;
  const name = path => `projects/egcw-1ec83/databases/(default)/documents/${path}`;
  const put = (path, data) => docs.set(path, { data: structuredClone(data), updateTime: `2026-09-22T00:00:00.${String(++stamp).padStart(6, '0')}Z` });
  const doc = path => ({ name: name(path), updateTime: docs.get(path).updateTime, fields: encodeFirestoreFields(docs.get(path).data) });
  async function fetcher(_env, url, options = {}) {
    const target = new URL(url), method = options.method || 'GET', body = options.body ? JSON.parse(options.body) : null;
    assert.equal(target.hostname, 'firestore.googleapis.com');
    const path = decodeURIComponent(target.pathname.split('/documents')[1] || '');
    calls.push({ method, path, transaction: body?.transaction || null });
    if (path === ':beginTransaction') return Response.json({ transaction: 'tx-1' });
    if (path === ':rollback') return Response.json({});
    if (path === ':batchGet') { assert.equal(body.transaction, 'tx-1'); return Response.json(body.documents.map(full => { const key = full.split('/documents/')[1]; return docs.has(key) ? { found: doc(key) } : { missing: full }; })); }
    if (path === ':commit') {
      if (commitFails) return commitFails();
      for (const write of body.writes) {
        const key = write.update.name.split('/documents/')[1], current = docs.get(key);
        if (write.currentDocument.exists === false ? current : current?.updateTime !== write.currentDocument.updateTime) return Response.json({ error: { status: 'FAILED_PRECONDITION' } }, { status: 400 });
      }
      for (const write of body.writes) { const key = write.update.name.split('/documents/')[1]; put(key, { ...(docs.get(key)?.data || {}), ...decodeFirestoreFields(write.update.fields) }); }
      return Response.json({ writeResults: body.writes.map(() => ({})) });
    }
    const key = path.replace(/^\//, '');
    return docs.has(key) ? Response.json(doc(key)) : Response.json({ error: { status: 'NOT_FOUND' } }, { status: 404 });
  }
  return { docs, calls, put, fetcher, data: path => docs.get(path)?.data, revision: path => docs.get(path)?.updateTime };
}

test('lifecycleStorage commits the account write, sale, receipt, audit and events atomically with the lineage fence in one transaction', async () => {
  const fs = firestore();
  fs.put('jobs/root-job', { type: 'job', customerId: 'c1', customer: 'Synthetic Customer' });
  fs.put('jobs/child-job', { type: 'job', customerId: 'c1', customer: 'Synthetic Customer', customerAccountOwnerJobId: 'root-job' });
  const store = lifecycleStorage({}, fs.fetcher), childRevision = fs.revision('jobs/child-job');
  const input = { action: 'gift_card.sell', requestId: randomUUID(), jobId: 'child-job', accountId: 'root-job', expectedRevision: fs.revision('jobs/root-job'), amountCents: 10000, label: 'EGC gift card', method: 'cash', reference: 'Cash receipt 12' };
  const result = await mutateLifecycle(store, owner, input, NOW);
  assert.equal(result.ok, true); assert.equal(result.context.account.id, 'root-job'); assert.equal(result.context.account.availableCents, 10000);
  const commit = fs.calls.find(call => call.path === ':commit');
  assert.equal(commit.transaction, 'tx-1', 'the fence and the writes share one transaction');
  assert.deepEqual(fs.calls.filter(call => call.method === 'POST').map(call => call.path), [':beginTransaction', ':batchGet', ':commit']);
  assert.equal(fs.revision('jobs/child-job'), childRevision, 'the fenced child job is only verified, never written');
  assert.equal(fs.data('jobs/root-job').giftWallet.cards[0].creditClass, 'gift_purchase');
  assert.equal(fs.data(`giftCardSales/${input.requestId.toLowerCase()}`).amountCents, 10000);
  const claim = fs.data(`giftCardSales/${input.requestId.toLowerCase()}`).referenceKey;
  assert.equal(fs.data(`giftCardSaleRefs/${claim}`).saleId, input.requestId.toLowerCase(), 'the payment reference claim is created in the same commit');
  assert.equal([...fs.docs.keys()].filter(key => key.startsWith('funnelEvents/')).length, 2);
  // Replaying reads the receipt and writes nothing more.
  const writes = fs.calls.filter(call => call.path === ':commit').length;
  assert.equal((await mutateLifecycle(store, owner, input, NOW)).replayed, true);
  assert.equal(fs.calls.filter(call => call.path === ':commit').length, writes);
});

test('lifecycleStorage maps a stale updateTime to a revision conflict and a lost or failed commit to outcome unknown', async () => {
  const stale = firestore();
  stale.put('jobs/job-1', { type: 'job', customerId: 'c1' });
  const store = lifecycleStorage({}, stale.fetcher), revision = stale.revision('jobs/job-1');
  stale.put('jobs/job-1', { type: 'job', customerId: 'c1', note: 'changed' });
  await assert.rejects(store.commit([{ collection: 'jobs', id: 'job-1', revision, patch: { updatedAt: NOW } }]), error => error.code === 'lifecycle_revision_conflict' && error.status === 409);
  for (const commitFails of [() => { throw new Error('socket closed'); }, () => new Response('{}', { status: 500 }), () => Response.json({ error: { status: 'INTERNAL' } }, { status: 400 })]) {
    const lost = firestore({ commitFails });
    await assert.rejects(lifecycleStorage({}, lost.fetcher).commit([{ collection: 'jobs', id: 'job-1', patch: { updatedAt: NOW } }]), error => error.code === 'lifecycle_outcome_unknown' && error.status === 503);
  }
  const unreadable = lifecycleStorage({}, async () => new Response('{}', { status: 500 }));
  await assert.rejects(unreadable.read('jobs', 'job-1'), error => error.code === 'lifecycle_storage_unavailable' && error.status === 503);
  assert.equal(await lifecycleStorage({}, stale.fetcher).read('jobs', 'missing'), null);
});

test('server-issued credits and decisions work unchanged in the customer portal: shown, redeemed and answered by the existing portal actions', async t => {
  const f = fixture({ customerPortalLinkVersion: 0 });
  const credit = await mutateLifecycle(f.store, owner, issue(f, { amountCents: 7500, creditClass: 'garage_guard', label: 'Garage Guard credit', reason: 'Unused visit' }), NOW);
  const decision = await mutateLifecycle(f.store, manager, { action: 'decision.prompt', requestId: randomUUID(), jobId: 'job-abc123', expectedRevision: f.job().revision, title: 'Remove the damaged cabinet?', details: 'The back panel is broken.', priceDeltaCents: 5000, timeDeltaMinutes: 20 }, NOW);
  const { id, revision, ...saved } = f.job();
  const portal = portalStore(t, { 'job-abc123': saved }), handlers = portalHandlers(NOW), cookie = await portalCookie('job-abc123');
  const view = await portalView(handlers, cookie);
  assert.equal(view.status, 200);
  assert.deepEqual(view.body.experience.giftWallet.cards.map(card => [card.id, card.label, card.issuedAmount, card.remainingAmount, card.source]), [[credit.result.cardId, 'Garage Guard credit', 75, 75, 'Garage Guard credit']]);
  assert.equal(view.body.experience.giftWallet.available, 75);
  assert.equal(JSON.stringify(view.body).includes('Unused visit'), false, 'the internal reason never reaches the customer');
  assert.deepEqual(view.body.experience.decisions.map(item => [item.id, item.status, item.priceDelta, item.timeDeltaMinutes, item.promptedAt]), [[decision.result.decisionId, 'pending', 50, 20, NOW]]);
  const redeemed = await portalPost(handlers, cookie, { action: 'apply_gift_credit', card_id: credit.result.cardId, amount: 25, request_id: 'redeem-synthetic-1' });
  assert.equal(redeemed.status, 200); assert.equal(redeemed.body.applied, 25);
  const answered = await portalPost(handlers, cookie, { action: 'respond_decision', decision_id: decision.result.decisionId, response: 'approved', responded_by: 'Synthetic Customer' });
  assert.equal(answered.status, 200); assert.equal(answered.body.approvedChangeTotal, 50);
  const after = portal.job('job-abc123');
  assert.equal(after.giftWallet.cards[0].remainingAmount, 50); assert.equal(after.giftWallet.cards[0].creditClass, 'garage_guard', 'the class stays on the card for the redemption event (FUN-03)');
  assert.equal(after.customerDecisions[0].status, 'approved'); assert.equal(after.customerDecisions[0].priceDeltaCents, 5000);
  assert.equal(portal.calls.every(call => call.host === 'firestore.googleapis.com'), true); assert.ok(portalEnv.CUSTOMER_PORTAL_SECRET);
});

test('lifecycle receipts, the gift-card sales ledger and its reference claims are explicitly server-only in firestore.rules', async () => {
  const { readFileSync } = await import('node:fs');
  const rules = readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8');
  for (const name of ['lifecycleOperations', 'giftCardSales', 'giftCardSaleRefs']) assert.match(rules, new RegExp(`match /${name}/\\{documentId\\} \\{\\s*allow read, write: if false;\\s*\\}`), name);
});
