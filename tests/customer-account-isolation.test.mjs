import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ACCOUNT_JOB_FIELDS, customerAccountPortalCookie, customerAccountRoots, customerAccountStorage, readCustomerAccountContext, readCustomerAccountJob, revokeCustomerAccountSessions } from '../functions/_lib/customer-account-access.js';
import { CUSTOMER_SESSION_TTL_MS, clearCustomerSessionCookie, createCustomerAccountSession, portalSessionVersion, readCustomerAccountSession, signOutCustomerAccountSession } from '../functions/_lib/customer-account-session.js';
import { createCustomerPortalAccessToken, verifyCustomerPortalAccessToken, verifyCustomerPortalSessionToken } from '../functions/_lib/customer-portal.js';
import { readCustomerPortalContext } from '../functions/_lib/customer-portal-access.js';
import { customerPortalLinkAccount } from '../functions/_lib/customer-portal-revocation.js';
import { customerAccountRevokeHandlers } from '../functions/api/customer-account-revoke.js';
import { NOW, ORIGIN, env, memory, seed, job, owner, manager, crew, maskRow } from './helpers/customer-login-fixture.mjs';
import { projectReleased } from '../functions/_lib/business-hub-core.js';
import { encodeFirestoreFields } from '../functions/_lib/firestore-job.js';

const code = expected => error => { assert.equal(error.code, expected); return true; };
const signedOut = expected => error => { assert.deepEqual([error.code, error.status], [expected, 401]); return true; };
const request = cookie => new Request(`${ORIGIN}/customer-portal`, { headers: cookie ? { Cookie: cookie } : {} });
const JOB_KEYS = ['jobId', 'type', 'service', 'status', 'date', 'time', 'endTime', 'address', 'arrivalWindow'];

function accountRows() {
  return {
    ...seed(),
    // Its account root belongs to another customer: never shown to either.
    'jobs/job-a3': job('customer-a', { customerAccountOwnerJobId: 'job-b1', opsNotes: 'CANARY-A3' }),
    'jobs/job-a4': job('customer-a', { date: '2026-10-20', estimate: { number: 'EST-A4', status: 'draft', amount: 999 }, invoice: { number: 'INV-A4', status: 'draft' } }),
    'jobs/job-a5': job('customer-a', { date: '2026-09-10', status: 'completed', pipelineStatus: 'completed', estimate: { number: 'EST-A5', status: 'accepted', amount: 500 }, invoice: { number: 'INV-A5', status: 'issued', dueDate: '2026-09-30' }, payment: { amount: 200, verified: false } }),
    'jobs/job-a6': job('customer-a', { status: 'superseded', pipelineStatus: 'superseded' }),
    'jobs/job-a7': job('customer-a', { date: '2026-09-25', status: 'cancelled', pipelineStatus: 'cancelled' }),
    'jobs/job-a8': job('customer-a', { customerAccountOwnerJobId: 'job-missing' }),
    'jobs/_egc_schedule_lock_a': job('customer-a'),
    'jobs/secure_vault_a': job('customer-a'),
    'jobs/vault-a': job('customer-a', { recordType: 'employee_hub_v2' }),
    'jobs/block-a': job('customer-a', { type: 'blocked' }),
    'jobs/availability-a': job('customer-a', { type: 'availability' }),
  };
}

test('an account session sees only its own verified jobs, as allowlisted DTOs', async () => {
  const store = memory(accountRows());
  const { customerId, view, landing } = await readCustomerAccountContext(store, { customerId: 'customer-a' }, { now: new Date(NOW) });
  assert.equal(customerId, 'customer-a');
  assert.deepEqual(view.jobs.map(row => row.jobId), ['job-a4', 'job-a1', 'job-a7', 'job-a5', 'job-a2'], 'newest first; foreign-root, missing-root, superseded and private rows are absent');
  assert.deepEqual(view.coverage, { complete: true, needsReview: 2, businessProjects: 0, asOf: NOW });
  for (const row of view.jobs) assert.deepEqual(Object.keys(row), JOB_KEYS);
  assert.deepEqual(view.jobs.find(row => row.jobId === 'job-a7').status, 'cancelled');
  assert.deepEqual(view.quotes, [
    { jobId: 'job-a5', number: 'EST-A5', status: 'approved', amountCents: 50000, validUntil: '', approvedAt: '' },
    { jobId: 'job-a2', number: 'EST-A2', status: 'approved', amountCents: 120000, validUntil: '2026-09-15', approvedAt: '2026-08-20T12:00:00.000Z' },
  ], 'draft quotes are not released');
  assert.deepEqual(view.invoices, [
    { jobId: 'job-a5', number: 'INV-A5', status: 'pending_verification', totalCents: 50000, paidCents: null, balanceCents: null, dueDate: '2026-09-30', needsReview: true },
    { jobId: 'job-a2', number: 'INV-A2', status: 'paid', totalCents: 120000, paidCents: 120000, balanceCents: 0, dueDate: '2026-09-10', needsReview: false },
  ], 'an unverified payment shows no balance; drafts are hidden');
  assert.deepEqual(view.receipts, [{ jobId: 'job-a2', amountCents: 120000, paidAt: '2026-09-02T12:00:00.000Z', receiptUrl: 'https://pay.stripe.com/receipts/synthetic_a2' }]);
  assert.deepEqual(view.customer, { name: 'Synthetic customer-a', firstName: 'SyntheticA' });
  assert.deepEqual(landing, { jobId: 'job-a1', linkVersion: 0, linkRoot: 'job-a1' }, 'the soonest upcoming, non-cancelled project');
  const text = JSON.stringify(view);
  for (const canary of ['CANARY', 'cs_test', 'pi_', 'opsNotes', 'stripeSessionId', 'customerAccountOwnerJobId', 'job-b1', 'customer-b', 'revision', 'contact-a']) assert.ok(!text.includes(canary), `${canary} must not reach the customer`);
});

test('a job moved to another customer disappears on the next request; roots are re-verified every time', async () => {
  const store = memory(accountRows());
  const ids = async customerId => (await readCustomerAccountContext(store, { customerId }, { now: new Date(NOW) })).view.jobs.map(row => row.jobId);
  assert.ok((await ids('customer-a')).includes('job-a2'));
  store.edit('jobs/job-a2', { customerId: 'customer-b' });
  assert.ok(!(await ids('customer-a')).includes('job-a2'), 'moved away from A');
  assert.deepEqual(await ids('customer-b'), ['job-b1'], 'and B does not inherit it while its account root still belongs to A');
  store.edit('jobs/job-a1', { customerId: 'customer-b' });
  const a = await readCustomerAccountContext(store, { customerId: 'customer-a' }, { now: new Date(NOW) });
  assert.ok(!a.view.jobs.some(row => row.jobId === 'job-a1'));
  assert.notEqual(a.landing?.jobId, 'job-a1');
  assert.deepEqual((await ids('customer-b')).sort(), ['job-a1', 'job-a2', 'job-b1'], 'the whole account now verifies under B');
});

test('quotes follow the business hub release rule: drafts, void, withdrawn, replaced and unsent quotes stay hidden', async () => {
  const quotes = {
    'jobs/q-ready-unsent': job('customer-q', { date: '2026-10-02', estimate: { number: 'Q1', status: 'ready', amount: 100 } }),
    'jobs/q-ready-sent': job('customer-q', { date: '2026-10-03', estimate: { number: 'Q2', status: 'ready', amount: 200, sentAt: '2026-09-20T12:00:00.000Z' } }),
    'jobs/q-sent': job('customer-q', { date: '2026-10-04', estimate: { number: 'Q3', status: 'sent', amount: 300 } }),
    'jobs/q-void-approved': job('customer-q', { date: '2026-10-05', estimate: { number: 'Q4', status: 'void', amount: 400, sentAt: '2026-09-20T12:00:00.000Z' }, customerApproval: { status: 'approved' } }),
    'jobs/q-withdrawn': job('customer-q', { date: '2026-10-06', quoteStatus: 'withdrawn', estimate: { number: 'Q5', status: 'sent', amount: 500, sentAt: '2026-09-20T12:00:00.000Z' } }),
    'jobs/q-not-issued': job('customer-q', { date: '2026-10-07', quoteStatus: 'not_issued', estimate: { number: 'Q6', amount: 600 } }),
    'jobs/q-replaced': job('customer-q', { date: '2026-10-08', estimate: { number: 'Q7', status: 'draft', amount: 700, sentAt: '2026-09-20T12:00:00.000Z' }, customerApproval: { status: 'superseded' } }),
    'jobs/q-approval-draft': job('customer-q', { date: '2026-10-09', estimate: { number: 'Q8', status: 'sent', amount: 800, sentAt: '2026-09-20T12:00:00.000Z' }, customerApproval: { status: 'draft' } }),
    'jobs/q-declined': job('customer-q', { date: '2026-10-10', estimate: { number: 'Q9', status: 'sent', amount: 900, sentAt: '2026-09-20T12:00:00.000Z' }, customerApproval: { status: 'declined' } }),
    'jobs/q-accepted': job('customer-q', { date: '2026-10-11', estimate: { number: 'Q10', status: 'accepted', amount: 1000 } }),
  };
  const store = memory({ 'customers/customer-q': { name: 'Synthetic Quotes', phone: '9705550191' }, ...quotes });
  const { view } = await readCustomerAccountContext(store, { customerId: 'customer-q' }, { now: new Date(NOW) });
  assert.deepEqual(view.quotes.map(quote => [quote.number, quote.status]), [['Q10', 'approved'], ['Q9', 'declined'], ['Q3', 'sent'], ['Q2', 'ready']]);
  // The same rows the business hub would release, read through the same field mask.
  const released = Object.entries(quotes).filter(([, row]) => projectReleased(maskRow(row, ACCOUNT_JOB_FIELDS)) && !['draft', 'superseded'].includes(row.customerApproval?.status)).map(([, row]) => row.estimate.number);
  assert.deepEqual(view.quotes.map(quote => quote.number).sort(), released.sort());
});

test('a supplied job id never crosses accounts: foreign, missing and private ids answer the same 404', async () => {
  const store = memory(accountRows());
  const session = { customerId: 'customer-a' };
  const answers = [];
  for (const jobId of ['job-b1', 'job-missing', '_egc_schedule_lock_a', 'secure_vault_a', 'vault-a', 'job-a3', 'job-a6', '../job-b1', '']) {
    const error = await readCustomerAccountJob(store, session, jobId).catch(problem => problem);
    assert.equal(error.code, 'CUSTOMER_ACCOUNT_JOB_NOT_FOUND', jobId);
    answers.push([error.status, error.message]);
    await assert.rejects(customerAccountPortalCookie(store, env, session, jobId, Date.parse(NOW)), code('CUSTOMER_ACCOUNT_JOB_NOT_FOUND'));
  }
  assert.equal(new Set(answers.map(answer => answer.join('|'))).size, 1);
  assert.deepEqual(await readCustomerAccountJob(store, session, 'job-a2').then(result => [result.job.jobId, result.linkVersion, result.linkRoot]), ['job-a2', 0, 'job-a1']);
  const cookie = await customerAccountPortalCookie(store, env, session, 'job-a2', Date.parse(NOW));
  const claims = await verifyCustomerPortalSessionToken(env, cookie.split(';')[0].split('=')[1], Date.parse(NOW));
  assert.deepEqual([claims.jobId, claims.linkVersion, claims.linkRoot, claims.actorId], ['job-a2', 0, 'job-a1', '']);
  store.edit('jobs/job-a1', { customerPortalLinkVersion: 3 });
  const bumped = await readCustomerAccountJob(store, session, 'job-a2');
  assert.equal(bumped.linkVersion, 3, 'the hand-off carries the account root\'s current P4-15 version');
  store.edit('jobs/job-a1', { customerPortalLinkVersion: 'broken' });
  await assert.rejects(readCustomerAccountJob(store, session, 'job-a2'), code('CUSTOMER_ACCOUNT_JOB_REVIEW'));
  await assert.rejects(readCustomerAccountJob(store, {}, 'job-a2'), code('CUSTOMER_ACCOUNT_AUTH_REQUIRED'));
  store.hooks.failRead = () => true;
  await assert.rejects(readCustomerAccountJob(store, session, 'job-a2'), code('CUSTOMER_ACCOUNT_STORAGE_UNAVAILABLE'));
});

test('revoked, expired and version-bumped sessions are 401; storage failures are 503', async () => {
  const store = memory(seed());
  const created = await createCustomerAccountSession(store, env, { customerId: 'customer-a', sessionVersion: 0, via: 'magic_link' }, NOW);
  assert.match(created.cookie, /^__Host-egc_customer=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000$/);
  const cookie = created.cookie.split(';')[0], read = (value = cookie, at = NOW) => readCustomerAccountSession(store, env, request(value), at);
  const session = await read();
  assert.deepEqual([session.customerId, session.sessionVersion, session.via, session.expiresAt], ['customer-a', 0, 'magic_link', new Date(Date.parse(NOW) + CUSTOMER_SESSION_TTL_MS).toISOString()]);
  await assert.rejects(read(''), signedOut('CUSTOMER_ACCOUNT_AUTH_REQUIRED'));
  await assert.rejects(read('__Host-egc_customer=not-a-token'), signedOut('CUSTOMER_ACCOUNT_AUTH_REQUIRED'));
  await assert.rejects(read(`__Host-egc_customer=${'A'.repeat(43)}`), signedOut('CUSTOMER_ACCOUNT_AUTH_REQUIRED'));
  await assert.rejects(read(`egc_customer_portal=${created.token}`), signedOut('CUSTOMER_ACCOUNT_AUTH_REQUIRED'), 'only the account cookie counts');
  await assert.rejects(read(cookie, created.expiresAt), signedOut('CUSTOMER_ACCOUNT_SESSION_EXPIRED'));
  assert.equal((await read(cookie, new Date(Date.parse(created.expiresAt) - 1).toISOString())).customerId, 'customer-a');
  store.edit('customers/customer-a', { portalSessionVersion: 1 });
  await assert.rejects(read(), signedOut('CUSTOMER_ACCOUNT_SESSION_REVOKED'), 'a version bump ends it');
  store.edit('customers/customer-a', { portalSessionVersion: 'broken' });
  await assert.rejects(read(), signedOut('CUSTOMER_ACCOUNT_SESSION_REVOKED'), 'a malformed version fails closed');
  store.edit('customers/customer-a', { portalSessionVersion: 0 });
  assert.equal((await read()).customerId, 'customer-a');
  store.edit(`customer_sessions/${created.id}`, { revokedAt: NOW });
  await assert.rejects(read(), signedOut('CUSTOMER_ACCOUNT_SESSION_REVOKED'));
  const other = await createCustomerAccountSession(store, env, { customerId: 'customer-b', sessionVersion: 0, via: 'magic_link' }, NOW);
  store.remove('customers/customer-b');
  await assert.rejects(read(other.cookie.split(';')[0]), signedOut('CUSTOMER_ACCOUNT_SESSION_REVOKED'), 'a removed customer has no sessions');
  store.hooks.failRead = () => true;
  await assert.rejects(read(), code('CUSTOMER_ACCOUNT_STORAGE_UNAVAILABLE'));
  assert.equal(portalSessionVersion({}), 0); assert.equal(portalSessionVersion({ portalSessionVersion: 2 }), 2);
  for (const bad of [-1, 1.5, '1', true]) assert.equal(portalSessionVersion({ portalSessionVersion: bad }), null);
  await assert.rejects(createCustomerAccountSession(store, env, { customerId: 'customer-a', sessionVersion: 0, via: 'password' }, NOW), code('CUSTOMER_ACCOUNT_SESSION_INVALID'));
  await assert.rejects(createCustomerAccountSession(store, env, { customerId: 'secure_x', sessionVersion: 0, via: 'magic_link' }, NOW), code('CUSTOMER_ACCOUNT_SESSION_INVALID'));
});

test('signing out marks the session revoked and clears the host-only cookie', async () => {
  const store = memory(seed());
  const created = await createCustomerAccountSession(store, env, { customerId: 'customer-a', sessionVersion: 0, via: 'magic_link' }, NOW);
  const out = await signOutCustomerAccountSession(store, env, request(created.cookie.split(';')[0]), NOW);
  assert.deepEqual(out, { revoked: true, cookie: '__Host-egc_customer=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0' });
  assert.equal(out.cookie, clearCustomerSessionCookie());
  assert.deepEqual([store.get(`customer_sessions/${created.id}`).revokedAt, store.get(`customer_sessions/${created.id}`).revokedReason], [NOW, 'signed_out']);
  await assert.rejects(readCustomerAccountSession(store, env, request(created.cookie.split(';')[0]), NOW), code('CUSTOMER_ACCOUNT_SESSION_REVOKED'));
  assert.deepEqual(await signOutCustomerAccountSession(store, env, request(''), NOW), { revoked: false, cookie: clearCustomerSessionCookie() });
});

test('staff sign a customer out everywhere with an audited, idempotent version bump', async () => {
  const store = memory(seed());
  const created = await createCustomerAccountSession(store, env, { customerId: 'customer-a', sessionVersion: 0, via: 'magic_link' }, NOW);
  const revision = store.revisions.get('customers/customer-a'), input = { requestId: randomUUID(), customerId: 'customer-a', expectedRevision: revision };
  await assert.rejects(revokeCustomerAccountSessions(store, null, input, NOW), code('CUSTOMER_ACCOUNT_REVOKE_SIGN_IN_REQUIRED'));
  await assert.rejects(revokeCustomerAccountSessions(store, crew, input, NOW), code('CUSTOMER_ACCOUNT_REVOKE_FORBIDDEN'));
  await assert.rejects(revokeCustomerAccountSessions(store, { ...manager, businessAccess: false }, input, NOW), code('CUSTOMER_ACCOUNT_REVOKE_FORBIDDEN'));
  for (const bad of [{ ...input, requestId: 'x' }, { ...input, customerId: 'secure_x' }, { ...input, expectedRevision: '' }, { ...input, extra: true }]) await assert.rejects(revokeCustomerAccountSessions(store, manager, bad, NOW), code('CUSTOMER_ACCOUNT_REVOKE_INVALID_REQUEST'));
  // The per-job owner session a sign-in hands out, still open before the revoke.
  const handoff = await customerAccountPortalCookie(store, env, { customerId: 'customer-a' }, 'job-a2', Date.parse(NOW));
  const portalSession = await verifyCustomerPortalSessionToken(env, handoff.split(';')[0].split('=')[1], Date.parse(NOW));
  const portalRead = async (_, id) => { const row = await store.read('jobs', id); return row && { ...row, __updateTime: row.revision }; };
  assert.equal((await readCustomerPortalContext(env, portalSession, { read: portalRead })).session.jobId, 'job-a2');
  const commits = store.commits.length, rootRevision = store.revisions.get('jobs/job-a1');
  const result = await revokeCustomerAccountSessions(store, manager, input, NOW);
  assert.deepEqual(result, { ok: true, customerId: 'customer-a', portalSessionVersion: 1, previousPortalSessionVersion: 0, portalLinkAccounts: [{ jobId: 'job-a1', linkVersion: 1 }], portalLinksComplete: true, needsReview: 0, revokedAt: NOW, revokedBy: 'tylerg' });
  assert.equal(store.commits.length, commits + 1, 'one atomic commit');
  const writes = store.commits.at(-1);
  assert.deepEqual(writes.map(write => write.collection).sort(), ['customerPortalOperations', 'customers', 'hub_audit', 'hub_audit', 'jobs']);
  const audit = writes.find(write => write.collection === 'hub_audit' && write.patch.entityKey === 'customers/customer-a').patch;
  assert.deepEqual([audit.action, audit.entityKey, audit.actor.id, audit.via, audit.before, audit.after, audit.requestId], ['customer.portal_sessions_revoked', 'customers/customer-a', 'tylerg', 'hub', '{"portalSessionVersion":0}', '{"portalSessionVersion":1}', input.requestId.toLowerCase()]);
  const linkAudit = writes.find(write => write.collection === 'hub_audit' && write.patch.entityKey === 'jobs/job-a1').patch;
  assert.deepEqual([linkAudit.action, linkAudit.before, linkAudit.after], ['customer.portal_links_revoked', '{"customerPortalLinkVersion":0}', '{"customerPortalLinkVersion":1}']);
  assert.equal(writes.find(write => write.collection === 'customers').revision, revision, 'conditioned on the revision staff saw');
  assert.equal(writes.find(write => write.collection === 'jobs').revision, rootRevision, 'the account root is bumped on the revision that was read');
  await assert.rejects(readCustomerAccountSession(store, env, request(created.cookie.split(';')[0]), NOW), code('CUSTOMER_ACCOUNT_SESSION_REVOKED'));
  await assert.rejects(readCustomerPortalContext(env, portalSession, { read: portalRead }), code('CUSTOMER_PORTAL_ACCESS_REVOKED'), 'the per-job owner session handed out at sign-in ends too');
  assert.deepEqual([store.get('jobs/job-a1').customerPortalLinkVersion, store.get('jobs/job-a1').customerPortalLinksRevokedBy], [1, 'tylerg']);
  const replay = await revokeCustomerAccountSessions(store, manager, input, NOW);
  assert.equal(replay.replayed, true); assert.equal(replay.portalSessionVersion, 1);
  assert.equal(store.commits.length, commits + 1, 'a replay writes nothing');
  await assert.rejects(revokeCustomerAccountSessions(store, owner, input, NOW), code('CUSTOMER_ACCOUNT_REVOKE_IDEMPOTENCY_CONFLICT'));
  await assert.rejects(revokeCustomerAccountSessions(store, manager, { ...input, requestId: randomUUID() }, NOW), code('CUSTOMER_ACCOUNT_REVOKE_REVISION_CONFLICT'), 'a stale revision');
  await assert.rejects(revokeCustomerAccountSessions(store, manager, { ...input, requestId: randomUUID(), customerId: 'customer-none' }, NOW), code('CUSTOMER_ACCOUNT_REVOKE_NOT_FOUND'));
  store.edit('customers/customer-b', { portalSessionVersion: 'broken' });
  await assert.rejects(revokeCustomerAccountSessions(store, manager, { requestId: randomUUID(), customerId: 'customer-b', expectedRevision: store.revisions.get('customers/customer-b') }, NOW), code('CUSTOMER_ACCOUNT_REVOKE_ACCOUNT_REVIEW'));
  const lost = memory(seed());
  lost.hooks.loseResponse = writes => writes.some(write => write.collection === 'hub_audit');
  const recovered = await revokeCustomerAccountSessions(lost, owner, { requestId: randomUUID(), customerId: 'customer-a', expectedRevision: lost.revisions.get('customers/customer-a') }, NOW);
  assert.deepEqual([recovered.replayed, recovered.portalSessionVersion, recovered.portalLinkAccounts], [true, 1, [{ jobId: 'job-a1', linkVersion: 1 }]], 'a lost response is recovered from the receipt');
});

test('the revoke endpoint requires a same-origin JSON request from signed-in staff', async () => {
  const store = memory(seed());
  const handlers = actor => customerAccountRevokeHandlers({ session: async () => actor, storage: () => store, now: () => new Date(NOW) });
  const post = (actor, body, headers = {}) => handlers(actor).post({ env, request: new Request(`${ORIGIN}/api/customer-account-revoke`, { method: 'POST', body: JSON.stringify(body), headers: { Origin: ORIGIN, 'Content-Type': 'application/json', ...headers } }) });
  const input = { requestId: randomUUID(), customerId: 'customer-a', expectedRevision: store.revisions.get('customers/customer-a') };
  assert.equal((await post(manager, input, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await post(null, input)).status, 401);
  assert.equal((await post(manager, input, { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await post(crew, input)).status, 403);
  const saved = await post(manager, input);
  assert.equal(saved.status, 200);
  assert.equal((await saved.json()).portalSessionVersion, 1);
  assert.equal(saved.headers.get('Cache-Control'), 'no-store');
  store.hooks.failRead = () => true;
  const down = await post(manager, { ...input, requestId: randomUUID() });
  assert.deepEqual([down.status, (await down.json()).code], [503, 'CUSTOMER_ACCOUNT_REVOKE_UNAVAILABLE']);
});

test('pagination is bounded, cursor-ordered and never presents a partial list as complete', async () => {
  const rows = { 'customers/customer-p': { name: 'Synthetic Pages', phone: '9705550190' } };
  for (let index = 0; index < 250; index += 1) rows[`jobs/job-p${String(index).padStart(3, '0')}`] = job('customer-p', { date: '2026-08-01' });
  const store = memory(rows);
  const big = await readCustomerAccountContext(store, { customerId: 'customer-p' }, { now: new Date(NOW), pageSize: 100, maxJobs: 200 });
  assert.equal(big.view.jobs.length, 200);
  assert.equal(big.view.coverage.complete, false);
  assert.deepEqual(store.calls.customerJobs, [{ customerId: 'customer-p', limit: 100, after: '' }, { customerId: 'customer-p', limit: 100, after: 'job-p099' }]);
  store.calls.customerJobs.length = 0;
  const all = await readCustomerAccountContext(store, { customerId: 'customer-p' }, { now: new Date(NOW), pageSize: 100, maxJobs: 300 });
  assert.deepEqual([all.view.jobs.length, all.view.coverage.complete], [250, true]);
  assert.deepEqual(store.calls.customerJobs.map(call => [call.limit, call.after]), [[100, ''], [100, 'job-p099'], [100, 'job-p199']]);
  const broken = [
    ['an oversized page', async () => Array.from({ length: 6 }, (_, index) => ({ id: `job-x${index}`, customerId: 'customer-p' }))],
    ['another customer\'s row', async () => [{ id: 'job-b1', customerId: 'customer-b' }]],
    ['rows out of order', async () => [{ id: 'job-2', customerId: 'customer-p' }, { id: 'job-1', customerId: 'customer-p' }]],
    ['a repeated cursor', async (id, { after }) => after ? [{ id: after, customerId: 'customer-p' }] : Array.from({ length: 5 }, (_, index) => ({ id: `job-${index}`, customerId: 'customer-p' }))],
    ['no list', async () => null],
  ];
  for (const [label, customerJobs] of broken) await assert.rejects(readCustomerAccountContext({ ...store, customerJobs }, { customerId: 'customer-p' }, { now: new Date(NOW), pageSize: 5, maxJobs: 50 }), code('CUSTOMER_ACCOUNT_STORAGE_UNAVAILABLE'), label);
  await assert.rejects(readCustomerAccountContext(store, { customerId: 'customer-none' }, { now: new Date(NOW) }), code('CUSTOMER_ACCOUNT_SESSION_REVOKED'));
  await assert.rejects(readCustomerAccountContext(store, { customerId: '_egc_x' }, { now: new Date(NOW) }), code('CUSTOMER_ACCOUNT_AUTH_REQUIRED'));
});

test('a full page that ends on a legacy job id pages on past it; the legacy row is never shown', async () => {
  const rows = { 'customers/customer-l': { name: 'Synthetic Legacy', phone: '9705550192' } };
  for (const id of ['job-l1', 'job-l2', 'job-l3', 'job-l4', 'job-l4 legacy #7.2', 'job-l5', 'zz-job.l9:x']) rows[`jobs/${id}`] = job('customer-l', { date: '2026-08-01' });
  const store = memory(rows), root = 'projects/egcw-1ec83/databases/(default)/documents', cursors = [];
  // The real adapter over a Firestore query double serving the same rows in name order.
  const firestore = async (settings, url, options) => {
    const query = JSON.parse(options.body).structuredQuery, after = query.startAt?.values[0].referenceValue.slice(`${root}/jobs/`.length) ?? '';
    cursors.push(after);
    const page = (await store.customerJobs(query.where.fieldFilter.value.stringValue, { limit: query.limit, after })).map(({ id, revision, ...fields }) => ({ document: { name: `${root}/jobs/${id}`, updateTime: revision, fields: encodeFirestoreFields(fields) } }));
    return Response.json(page.length ? page : [{ readTime: NOW }]);
  };
  const context = await readCustomerAccountContext({ ...store, customerJobs: customerAccountStorage(env, firestore).customerJobs }, { customerId: 'customer-l' }, { now: new Date(NOW), pageSize: 5, maxJobs: 50 });
  assert.deepEqual(cursors, ['', 'job-l4 legacy #7.2'], 'the first page ends on the legacy id, and the adapter accepts it as the next cursor');
  assert.deepEqual([context.view.jobs.map(row => row.jobId).sort(), context.view.coverage.complete], [['job-l1', 'job-l2', 'job-l3', 'job-l4', 'job-l5'], true]);
});

test('the Firestore adapter issues a masked, ordered, cursor query and fails closed on bad answers', async () => {
  const root = 'projects/egcw-1ec83/databases/(default)/documents', calls = [];
  const answer = body => async (settings, url, options) => { calls.push({ url: String(url), body: JSON.parse(options.body) }); return typeof body === 'function' ? body() : Response.json(body); };
  const docs = [{ document: { name: `${root}/jobs/job-a1`, updateTime: '2026-09-22T10:00:00.000000Z', fields: { customerId: { stringValue: 'customer-a' }, type: { stringValue: 'job' } } } }, { readTime: '2026-09-22T12:00:00Z' }];
  const rows = await customerAccountStorage(env, answer(docs)).customerJobs('customer-a', { limit: 50, after: 'job-a0' });
  assert.deepEqual(rows, [{ customerId: 'customer-a', type: 'job', id: 'job-a1', revision: '2026-09-22T10:00:00.000000Z' }]);
  const query = calls[0].body.structuredQuery;
  assert.ok(calls[0].url.endsWith('/documents:runQuery'));
  assert.deepEqual(query.select.fields.map(field => field.fieldPath), ACCOUNT_JOB_FIELDS);
  for (const secret of ['opsNotes', 'notes', 'customerCollaborators', 'giftWallet', 'signature']) assert.ok(!ACCOUNT_JOB_FIELDS.includes(secret), secret);
  // Maps are read by named subfield only: never whole quotes, approvals (signature images), invoices or payments.
  for (const whole of ['estimate', 'customerApproval', 'invoice', 'payment', 'deposit']) assert.ok(!ACCOUNT_JOB_FIELDS.includes(whole), whole);
  assert.ok(ACCOUNT_JOB_FIELDS.every(path => /^[A-Za-z]+(?:\.[A-Za-z]+)?$/.test(path) && !/lineItems|signature|stripe|intent|token|notes/i.test(path)), 'plain field paths with no private subfields');
  const canary = job('customer-a', { estimate: { number: 'EST-C', status: 'sent', amount: 10, lineItems: [{ name: 'CANARY-LINE' }] }, customerApproval: { status: 'approved', signature: 'data:image/png;base64,CANARY', signedName: 'CANARY-NAME' }, payment: { amount: 10, verified: true, stripeSessionId: 'cs_test_CANARY' } });
  assert.ok(!JSON.stringify(maskRow(canary, ACCOUNT_JOB_FIELDS)).includes('CANARY'), 'the fixture applies the same mask');
  await customerAccountStorage(env, answer([])).customerJobs('customer-a', { after: 'Legacy job #7.2' });
  assert.deepEqual(calls.at(-1).body.structuredQuery.startAt, { values: [{ referenceValue: `${root}/jobs/Legacy job #7.2` }], before: false }, 'a legacy id is a valid cursor');
  assert.deepEqual(query.where, { fieldFilter: { field: { fieldPath: 'customerId' }, op: 'EQUAL', value: { stringValue: 'customer-a' } } });
  assert.deepEqual(query.orderBy, [{ field: { fieldPath: '__name__' }, direction: 'ASCENDING' }]);
  assert.deepEqual(query.startAt, { values: [{ referenceValue: `${root}/jobs/job-a0` }], before: false });
  assert.equal(query.limit, 50);
  await customerAccountStorage(env, answer([])).customerJobs('customer-a');
  assert.equal(calls.at(-1).body.structuredQuery.startAt, undefined);
  for (const [label, fetcher] of [
    ['throws', async () => { throw new Error('offline'); }], ['500', answer(() => Response.json({}, { status: 500 }))], ['not a list', answer({})],
    ['another collection', answer([{ document: { name: `${root}/customers/customer-a`, updateTime: 'x', fields: {} } }])], ['no revision', answer([{ document: { name: `${root}/jobs/job-a1`, fields: {} } }])],
  ]) await assert.rejects(customerAccountStorage(env, fetcher).customerJobs('customer-a'), code('CUSTOMER_ACCOUNT_STORAGE_UNAVAILABLE'), label);
  for (const [id, options] of [['secure_x', {}], ['customer-a', { limit: 101 }], ['customer-a', { limit: 0 }], ['customer-a', { after: '../x' }], ['customer-a', { after: '.' }], ['customer-a', { after: '..' }], ['customer-a', { after: 'x'.repeat(1501) }], ['customer-a', { after: 7 }]]) await assert.rejects(customerAccountStorage(env, answer([])).customerJobs(id, options), code('CUSTOMER_ACCOUNT_QUERY_INVALID'));
});

test('business-linked projects (B2B-SAFE) are never listed, landed on or handed an owner portal session', async () => {
  const store = memory({
    ...accountRows(),
    // Soonest upcoming, so it would be the landing project if it were a homeowner project.
    'jobs/job-a9': job('customer-a', { businessAccountId: 'biz_acme', date: '2026-09-23', estimate: { number: 'EST-A9', status: 'sent', amount: 900, sentAt: '2026-09-20T12:00:00.000Z' }, invoice: { number: 'INV-A9', status: 'issued' } }),
    // Linked through its account root only.
    'jobs/job-a10': job('customer-a', { customerAccountOwnerJobId: 'job-a9', date: '2026-09-24' }),
    // Malformed markers still count as linked; an unlinked marker ('') is a homeowner project again.
    'jobs/job-a11': job('customer-a', { businessAccountId: 7, date: '2026-09-26' }),
    'jobs/job-a12': job('customer-a', { businessAccountId: '', date: '2026-10-25' }),
  });
  const session = { customerId: 'customer-a' };
  const { view, landing } = await readCustomerAccountContext(store, session, { now: new Date(NOW) });
  assert.deepEqual(view.jobs.map(row => row.jobId), ['job-a12', 'job-a4', 'job-a1', 'job-a7', 'job-a5', 'job-a2']);
  assert.ok(![...view.quotes, ...view.invoices, ...view.receipts].some(row => ['job-a9', 'job-a10', 'job-a11'].includes(row.jobId)), 'no quote, invoice or receipt of a company project');
  assert.deepEqual(view.coverage, { complete: true, needsReview: 2, businessProjects: 3, asOf: NOW });
  assert.deepEqual(landing, { jobId: 'job-a1', linkVersion: 0, linkRoot: 'job-a1' }, 'the landing skips the company projects');
  assert.ok(!JSON.stringify(view).includes('biz_acme'));
  for (const jobId of ['job-a9', 'job-a10', 'job-a11']) {
    await assert.rejects(readCustomerAccountJob(store, session, jobId), error => { assert.deepEqual([error.code, error.status], ['CUSTOMER_ACCOUNT_JOB_BUSINESS', 409]); return true; });
    await assert.rejects(customerAccountPortalCookie(store, env, session, jobId, Date.parse(NOW)), code('CUSTOMER_ACCOUNT_JOB_BUSINESS'));
  }
  assert.equal((await readCustomerAccountJob(store, session, 'job-a12')).job.jobId, 'job-a12');
  // Linking the account root takes its whole account (root and children) out on the next request.
  store.edit('jobs/job-a1', { businessAccountId: 'biz_acme' });
  const linked = await readCustomerAccountContext(store, session, { now: new Date(NOW) });
  assert.ok(!linked.view.jobs.some(row => ['job-a1', 'job-a2'].includes(row.jobId)));
  assert.deepEqual([linked.landing.jobId, linked.view.coverage.businessProjects], ['job-a4', 5]);
  await assert.rejects(readCustomerAccountJob(store, session, 'job-a2'), code('CUSTOMER_ACCOUNT_JOB_BUSINESS'));
});

test('signing a customer out bumps every verified account root, skips unreadable versions and leaves company sessions alone', async () => {
  const rows = { ...accountRows(), 'jobs/job-a9': job('customer-a', { businessAccountId: 'biz_acme', customerPortalLinkVersion: 3 }), 'jobs/job-a5': { ...accountRows()['jobs/job-a5'], customerPortalLinkVersion: 'broken' } };
  const store = memory(rows);
  const scan = await customerAccountRoots(store, 'customer-a');
  assert.deepEqual([scan.roots.map(root => root.id), scan.complete, scan.needsReview], [['job-a1', 'job-a4', 'job-a5', 'job-a6', 'job-a7', 'job-a9'], true, 2], 'closed, superseded and company projects are included; private rows, schedule rows and foreign or missing roots are not');
  const partial = await customerAccountRoots(store, 'customer-a', { pageSize: 2, maxJobs: 4 });
  assert.equal(partial.complete, false);
  const bizRead = async (_, actorId, project) => { assert.equal(actorId, 'biz_acme_m1'); return { name: 'Synthetic Co', permissions: { view: true, decide: false, pay: false, rebook: false }, projectId: project.id }; };
  const portalRead = async (_, id) => { const row = await store.read('jobs', id); return row && { ...row, __updateTime: row.revision }; };
  const company = { jobId: 'job-a9', actorId: 'biz_acme_m1', permissions: { view: true } };
  const input = { requestId: randomUUID(), customerId: 'customer-a', expectedRevision: store.revisions.get('customers/customer-a') };
  const result = await revokeCustomerAccountSessions(store, owner, input, NOW);
  assert.deepEqual(result.portalLinkAccounts, [{ jobId: 'job-a1', linkVersion: 1 }, { jobId: 'job-a4', linkVersion: 1 }, { jobId: 'job-a6', linkVersion: 1 }, { jobId: 'job-a7', linkVersion: 1 }, { jobId: 'job-a9', linkVersion: 4 }]);
  assert.equal(result.portalLinksComplete, false, 'a root with an unreadable version is reported, not guessed');
  assert.equal(result.needsReview, 2, 'the foreign-root and missing-root projects are reported for review');
  assert.equal(store.get('jobs/job-a5').customerPortalLinkVersion, 'broken', 'left for an owner to review; the portal already refuses its links');
  assert.equal(store.get('jobs/job-b1').customerPortalLinkVersion, undefined, 'another customer\'s root is never touched');
  const writes = store.commits.at(-1);
  assert.equal(writes.filter(write => write.collection === 'hub_audit').length, 6, 'one audit entry for the customer and one per bumped root');
  assert.equal((await readCustomerPortalContext(env, company, { read: portalRead, businessRead: bizRead })).session.actorId, 'biz_acme_m1', 'company sessions follow the business account, not the homeowner version');
  // A root edited between the scan and the commit: nothing applies.
  const raced = memory(accountRows());
  let edited = false;
  raced.hooks.beforeCommit = writes => { if (!edited && writes.some(write => write.collection === 'jobs')) { edited = true; raced.edit('jobs/job-a4', { address: '200 Synthetic Way' }); } };
  const before = raced.get('customers/customer-a');
  await assert.rejects(revokeCustomerAccountSessions(raced, manager, { requestId: randomUUID(), customerId: 'customer-a', expectedRevision: raced.revisions.get('customers/customer-a') }, NOW), code('CUSTOMER_ACCOUNT_REVOKE_REVISION_CONFLICT'));
  assert.deepEqual(raced.get('customers/customer-a'), before);
  assert.equal(raced.get('jobs/job-a1').customerPortalLinkVersion, undefined);
  // The projects cannot be read: nothing is changed and the same request can be retried.
  const down = memory(accountRows()), commits = down.commits.length, customerJobs = down.customerJobs;
  down.customerJobs = async () => { throw Object.assign(new Error('outage'), { code: 'CUSTOMER_ACCOUNT_STORAGE_UNAVAILABLE', status: 503 }); };
  const retry = { requestId: randomUUID(), customerId: 'customer-a', expectedRevision: down.revisions.get('customers/customer-a') };
  await assert.rejects(revokeCustomerAccountSessions(down, manager, retry, NOW), error => { assert.deepEqual([error.code, error.status], ['CUSTOMER_ACCOUNT_REVOKE_UNAVAILABLE', 503]); return true; });
  assert.equal(down.commits.length, commits);
  down.customerJobs = customerJobs;
  assert.equal((await revokeCustomerAccountSessions(down, manager, retry, NOW)).portalSessionVersion, 1, 'the same request succeeds once the projects can be read');
});

test('a legacy project with no type is signed out as the portal resolves it, and an owner chain that needs review makes the answer incomplete', async () => {
  const rows = seed();
  // Legacy customer-a records with no type, each given an owner link with "Copy customer portal":
  // a completed project that is its own account root, and a follow-up under job-a1.
  const untyped = extra => { const row = job('customer-a', extra); delete row.type; return row; };
  rows['jobs/job-legacy'] = untyped({ date: '2025-06-01', status: 'completed', pipelineStatus: 'completed' });
  rows['jobs/job-legacy-2'] = untyped({ date: '2025-07-01', customerAccountOwnerJobId: 'job-a1' });
  const store = memory(rows);
  const portalRead = async (_, id) => { const row = await store.read('jobs', id); return row && { ...row, __updateTime: row.revision }; };
  const shared = {};
  for (const [jobId, root] of [['job-legacy', 'job-legacy'], ['job-legacy-2', 'job-a1']]) {
    const { account, linkVersion } = await customerPortalLinkAccount(id => store.read('jobs', id), await store.read('jobs', jobId));
    const access = await verifyCustomerPortalAccessToken(env, await createCustomerPortalAccessToken(env, jobId, Date.parse(NOW), linkVersion, account.id), Date.parse(NOW));
    shared[jobId] = { jobId: access.jobId, linkVersion: access.linkVersion, linkRoot: access.linkRoot };
    assert.equal((await readCustomerPortalContext(env, shared[jobId], { read: portalRead })).accountJobId, root, `the staff-shared owner link for ${jobId} opens before the revoke`);
  }
  const scan = await customerAccountRoots(store, 'customer-a');
  assert.deepEqual([scan.roots.map(root => root.id), scan.complete, scan.needsReview], [['job-a1', 'job-legacy'], true, 0], 'each row resolves to the root the portal uses, whatever its type');
  const input = { requestId: randomUUID(), customerId: 'customer-a', expectedRevision: store.revisions.get('customers/customer-a') };
  const result = await revokeCustomerAccountSessions(store, manager, input, NOW);
  assert.deepEqual([result.portalLinkAccounts, result.portalLinksComplete, result.needsReview], [[{ jobId: 'job-a1', linkVersion: 1 }, { jobId: 'job-legacy', linkVersion: 1 }], true, 0]);
  assert.deepEqual([store.get('jobs/job-legacy').customerPortalLinkVersion, store.get('jobs/job-legacy').customerPortalLinksRevokedBy], [1, 'tylerg']);
  for (const jobId of ['job-legacy', 'job-legacy-2']) await assert.rejects(readCustomerPortalContext(env, shared[jobId], { read: portalRead }), code('CUSTOMER_PORTAL_ACCESS_REVOKED'), `the staff-shared owner link for ${jobId} stops working`);
  // A project whose owner chain needs review: every root is still bumped, but the answer says what was not covered.
  store.edit('jobs/job-a8', job('customer-a', { customerAccountOwnerJobId: 'job-missing' }));
  const again = { requestId: randomUUID(), customerId: 'customer-a', expectedRevision: store.revisions.get('customers/customer-a') };
  const partial = await revokeCustomerAccountSessions(store, owner, again, NOW);
  assert.deepEqual([partial.portalLinkAccounts, partial.needsReview, partial.portalLinksComplete], [[{ jobId: 'job-a1', linkVersion: 2 }, { jobId: 'job-legacy', linkVersion: 2 }], 1, false]);
  assert.equal(store.commits.at(-1).find(write => write.collection === 'customerPortalOperations').patch.needsReview, 1, 'the receipt keeps the count');
  const replay = await revokeCustomerAccountSessions(store, owner, again, NOW);
  assert.deepEqual([replay.replayed, replay.needsReview, replay.portalLinksComplete], [true, 1, false], 'a replay answers the same');
});
