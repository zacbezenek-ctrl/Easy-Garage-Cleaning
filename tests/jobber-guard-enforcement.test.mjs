import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { servicePublicKeySet, signServiceRequest } from '../egc-platform/services/operations/src/service-auth.ts';
import { verifyApiServiceEnvelope } from '../functions/_lib/operations-service-auth.js';
import { createHubSessionCookie } from '../functions/_lib/hub-session.js';
import { createGhlMessenger } from '../functions/_lib/ghl-messenger.js';
import { mutateTemplate, readTemplate } from '../functions/_lib/message-template-store.js';
import { MONEY_RECEIPTS } from '../functions/_lib/money-service.js';
import { JOBBER_GUARD_ACTIONS, jobberGuardBillingError, jobberGuardInvoiceHolds, jobberGuardSends } from '../functions/_lib/jobber-guard.js';
import * as hook from '../functions/api/crew-hook.js';
import { moneyHandlers } from '../functions/api/money.js';
import { messagingCronHandlers, MESSAGING_CRON_PATH } from '../functions/api/messaging-cron.js';
import { env as messagingEnv, owner as messagingOwner, job, memoryStore, fakeGhl, clock, uuid, NOW } from './helpers/messaging-fixture.mjs';
import { definitionsWith } from './helpers/jobber-guard-fixture.mjs';

// NOW is 2026-09-22 12:00 in Denver; the synthetic cutover day is two days earlier.
// MOVED is a reached cutover day other than the one the saved check was made for.
const DEFS = definitionsWith('2026-09-20'), LATER_CUTOVER = definitionsWith('2026-09-30'), UNSET = definitionsWith(null), MOVED = definitionsWith('2026-09-21');
const finding = (code, fields) => ({ id: `${code}:${fields.ref}`, code, provider: 'jobber', surfaces: fields.surfaces, scope: fields.scope || 'customer', holds: fields.holds, open: true, at: '2026-09-21T16:00:00.000Z', customerId: fields.customerId ?? null, jobId: fields.jobId ?? null, match: 'jobber_client', ref: { id: fields.ref }, masked: { name: 'S*** C***', phone: '', email: '' } });
const state = findings => ({ schemaVersion: 1, runId: '1b4e28ba-2fa1-4d3b-a3f5-ef19b5a7633b', checkedAt: '2026-09-22T15:00:00.000Z', cutoverDate: '2026-09-20', coverage: { complete: true, sources: { hub: 'complete', jobber: 'complete', ghl: 'complete' }, reasons: [] }, counts: {}, truncated: false, findings });
const FINDINGS = [
  finding('jobber_visit_after_cutover', { ref: 'job:2001', surfaces: ['booking', 'messaging'], holds: ['messaging'], customerId: 'cust-held' }),
  finding('jobber_invoice_after_cutover', { ref: '3101', surfaces: ['billing', 'messaging'], holds: ['billing', 'messaging'], customerId: 'cust-billed' }),
  finding('jobber_imported_balance_changed', { ref: '4001', surfaces: ['billing'], scope: 'job', holds: ['billing'], customerId: 'cust-free', jobId: 'jobber_invoice_4001' }),
  finding('jobber_payment_after_cutover', { ref: '6001', surfaces: ['billing'], holds: [], customerId: 'cust-free' }),
];

// ── Booking: /api/crew-hook ────────────────────────────────────────────────
const origin = 'https://easygaragecleaning.com';
const hookEnv = {
  HUB_SESSION_SECRET: 'synthetic-jobber-guard-hook-secret', FIREBASE_API_KEY: 'firebase-test-jobber-guard', CREW_WEBHOOK_URL: 'https://hooks.synthetic.invalid/catch',
  HUB_AUTH_USERS_JSON: JSON.stringify({ ZacB: { passwordHash: 'synthetic', displayName: 'Synthetic Owner', role: 'owner' } }),
};
async function forward(t, env, body, deps) {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (input, options = {}) => { calls.push({ url: String(input), body: options.body }); return Response.json({ status: 'success' }); });
  const cookie = (await createHubSessionCookie(env, 'ZacB')).split(';')[0];
  const response = await hook.onRequestPost({ env, request: new Request(`${origin}/api/crew-hook`, { method: 'POST', headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) }, deps);
  t.mock.restoreAll();
  return { status: response.status, body: await response.json(), calls };
}
const GAME_PLAN = { tool: 'game_plan', job_id: 'job-1', client: { name: 'Synthetic Customer' } };
const at = iso => () => new Date(iso);

test('booking guard: after the cutover no signed game plan reaches the Zap that creates a Jobber job', async t => {
  const held = await forward(t, { ...hookEnv, EGC_JOBBER_GUARD_BOOKING: 'true' }, GAME_PLAN, { now: at(NOW), definitions: DEFS });
  assert.deepEqual([held.status, held.body.code, held.calls.length], [409, 'CREW_HOOK_JOBBER_RETIRED', 0]);
  assert.match(held.body.error, /retired on 2026-09-20.*nothing was sent to Jobber/);
  const other = await forward(t, { ...hookEnv, EGC_JOBBER_GUARD_BOOKING: 'true' }, { tool: 'post_job', job_id: 'job-1' }, { now: at(NOW), definitions: DEFS });
  assert.deepEqual([other.status, other.calls.length], [200, 1], 'other workflow triggers are unchanged');
});

test('booking guard stays today\'s behaviour when off, not exactly "true", before the cutover day or without a cutover day', async t => {
  for (const [env, definitions, now] of [
    [hookEnv, DEFS, NOW], [{ ...hookEnv, EGC_JOBBER_GUARD_BOOKING: 'TRUE' }, DEFS, NOW],
    [{ ...hookEnv, EGC_JOBBER_GUARD_BOOKING: 'true' }, LATER_CUTOVER, NOW], [{ ...hookEnv, EGC_JOBBER_GUARD_BOOKING: 'true' }, UNSET, NOW],
    [{ ...hookEnv, EGC_JOBBER_GUARD_BOOKING: 'true' }, DEFS, '2026-09-20T05:59:00.000Z'],
  ]) {
    const result = await forward(t, env, GAME_PLAN, { now: at(now), definitions });
    assert.deepEqual([result.status, result.calls.length], [200, 1], JSON.stringify([env.EGC_JOBBER_GUARD_BOOKING, definitions.jobber.cutoverDate, now]));
    assert.equal(result.calls[0].body, JSON.stringify(GAME_PLAN), 'the exact payload is forwarded');
  }
  const broken = new Proxy({}, { get() { throw new Error('unreadable definitions'); } });
  const closed = await forward(t, { ...hookEnv, EGC_JOBBER_GUARD_BOOKING: 'true' }, GAME_PLAN, { now: at(NOW), definitions: broken });
  assert.deepEqual([closed.status, closed.body.code, closed.calls.length], [503, 'CREW_HOOK_JOBBER_GUARD_UNAVAILABLE', 0], 'with the switch on, an unreadable cutover never forwards to Jobber');
});

// ── Billing: /api/money invoice.issue ──────────────────────────────────────
const moneyOwner = { user: 'zacb', role: 'owner', businessAccess: true, displayName: 'Synthetic Owner' };
function moneyFixture(guardState = state(FINDINGS)) {
  const docs = new Map([
    ['jobs/job-held', { id: 'job-held', revision: 'h0', type: 'job', customerId: 'cust-billed', customer: 'Synthetic Billed', total: 500, estimate: { amount: 500 } }],
    ['jobs/job-free', { id: 'job-free', revision: 'f0', type: 'job', customerId: 'cust-free', customer: 'Synthetic Free', total: 400, estimate: { amount: 400 } }],
    ['jobs/jobber_invoice_4001', { id: 'jobber_invoice_4001', revision: 'i0', type: 'job', customerId: 'cust-free', customer: 'Synthetic Free', total: 250, estimate: { amount: 250 } }],
    ...(guardState ? [['jobberGuard/latest', { ...guardState, id: 'latest', revision: 'g0' }]] : []),
  ]);
  let n = 0;
  const store = {
    read: async (collection, id) => structuredClone(docs.get(`${collection}/${id}`) ?? null),
    async commit(writes) {
      for (const write of writes) { const old = docs.get(`${write.collection}/${write.id}`); if (write.revision ? old?.revision !== write.revision : old) throw Object.assign(new Error('Conflict'), { code: 'money_revision_conflict', status: 409 }); }
      for (const write of writes) { const key = `${write.collection}/${write.id}`; docs.set(key, { ...(write.revision ? docs.get(key) : {}), ...structuredClone(write.patch), id: write.id, revision: `r${++n}` }); }
    },
  };
  const api = (definitions = DEFS) => moneyHandlers({ session: async () => moneyOwner, storage: () => store, now: () => new Date(NOW), jobberGuard: (target, env, input, stamp) => jobberGuardInvoiceHolds(target, env, input, stamp, { receipts: MONEY_RECEIPTS, definitions }) });
  const issue = (id, requestId = randomUUID()) => ({ action: 'invoice.issue', requestId, jobId: id, expectedRevision: docs.get(`jobs/${id}`).revision, dueDate: '2026-09-29' });
  const post = async (input, env, definitions) => { const response = await api(definitions).post({ request: new Request('https://easygaragecleaning.com/api/money', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(input) }), env }); return { status: response.status, body: await response.json() }; };
  return { docs, store, issue, post, written: () => [...docs.keys()].filter(key => /^(moneyOperations|hub_audit)\//.test(key)) };
}
const BILLING = { MONEY_API_ENABLED: 'true', EGC_JOBBER_GUARD_BILLING: 'true' };

test('billing guard: the money API will not issue a Hub invoice while Jobber has billed the customer after the cutover', async () => {
  const f = moneyFixture();
  const held = await f.post(f.issue('job-held'), BILLING);
  assert.deepEqual([held.status, held.body.ok, held.body.code], [409, false, 'money_jobber_billing_hold']);
  assert.match(held.body.error, /^Jobber billed this customer after the cutover: .*Nothing was changed\.$/);
  assert.doesNotMatch(held.body.error, /imported balance/);
  assert.deepEqual(held.body.details, { checkedAt: '2026-09-22T15:00:00.000Z', findings: [{ id: 'jobber_invoice_after_cutover:3101', code: 'jobber_invoice_after_cutover', ref: { id: '3101' }, at: '2026-09-21T16:00:00.000Z', action: JOBBER_GUARD_ACTIONS.jobber_invoice_after_cutover }] });
  assert.equal(f.docs.get('jobs/job-held').invoice, undefined, 'nothing was changed');
  assert.deepEqual(f.written(), []);
  const free = await f.post(f.issue('job-free'), BILLING);
  assert.deepEqual([free.status, free.body.job.invoice.status], [200, 'issued'], 'a report-only Jobber payment and another job\'s settled balance hold nothing here');
  const estimate = await f.post({ action: 'estimate.mark_sent', requestId: randomUUID(), jobId: 'job-held', expectedRevision: 'h0', channel: 'email' }, BILLING);
  assert.notEqual(estimate.body.code, 'money_jobber_billing_hold', 'only invoice.issue is held');
  const imported = await f.post(f.issue('jobber_invoice_4001'), BILLING);
  assert.deepEqual([imported.status, imported.body.code, imported.body.details.findings.map(item => item.code)], [409, 'money_jobber_billing_hold', ['jobber_imported_balance_changed']]);
  assert.match(imported.body.error, /^Jobber shows this job's imported balance as paid or changed: record the payment in Hub finance or correct the Hub balance\./, 'the message names the reason the job is held');
  assert.doesNotMatch(imported.body.error, /billed this customer/);
  const both = jobberGuardBillingError([{ code: 'jobber_imported_balance_changed' }, { code: 'jobber_invoice_after_cutover' }]);
  assert.ok(/billed this customer/.test(both) && /imported balance/.test(both), 'both reasons are named when both hold');
});

test('billing guard: off, before the cutover, without a saved check or with a check for another cutover day the money API behaves as today, and a replay is never held', async () => {
  for (const [env, definitions, guardState] of [[{ MONEY_API_ENABLED: 'true' }, DEFS, state(FINDINGS)], [BILLING, LATER_CUTOVER, state(FINDINGS)], [BILLING, UNSET, state(FINDINGS)], [BILLING, DEFS, null], [BILLING, MOVED, state(FINDINGS)]]) {
    const f = moneyFixture(guardState), result = await f.post(f.issue('job-held'), env, definitions);
    assert.deepEqual([result.status, result.body.job?.invoice?.status], [200, 'issued'], JSON.stringify([env, definitions.jobber.cutoverDate, Boolean(guardState)]));
  }
  const f = moneyFixture(state([])), requestId = randomUUID(), input = f.issue('job-free', requestId);
  assert.equal((await f.post(input, BILLING)).status, 200);
  f.docs.set('jobberGuard/latest', { ...state([finding('jobber_invoice_after_cutover', { ref: '3999', surfaces: ['billing'], holds: ['billing'], customerId: 'cust-free' })]), id: 'latest', revision: 'g1' });
  const replay = await f.post(input, BILLING);
  assert.deepEqual([replay.status, replay.body.replayed], [200, true], 'the saved result of an applied request comes back even after a new hold');
  const broken = moneyFixture({ schemaVersion: 1, findings: 'unreadable', checkedAt: NOW });
  const unavailable = await broken.post(broken.issue('job-held'), BILLING);
  assert.deepEqual([unavailable.status, unavailable.body.code, broken.written()], [503, 'money_unavailable', []], 'an unreadable saved check fails closed while the switch is on');
});

// ── Messaging and billing: the signed messaging cron ───────────────────────
const API_ROOT = 'synthetic-jobber-guard-cron-api-root-secret-012345';
const CRON_ENV = Object.freeze({ ...messagingEnv, EGC_SERVER_MESSAGING_ENABLED: 'true', EGC_MESSAGING_SUBREQUEST_BUDGET: '9500' });
const ACTOR = Object.freeze({ id: 'messaging-cron-worker', kind: 'integration', role: 'integration', workspace: 'egc' });
const tomorrow = overrides => job({ date: '2026-09-23', time: '09:00', deposit: { amount: 300, paidAmount: 300, verified: true }, invoice: { number: 'INV-2001', amount: 1200, dueDate: '2026-12-31', status: 'issued' }, ...overrides });
const overdue = overrides => job({ date: '2026-12-01', status: 'completed', pipelineStatus: 'completed', completedAt: '2026-09-10T20:00:00.000Z', invoice: { number: 'INV-3001', amount: 1200, dueDate: '2026-09-21', status: 'issued' }, ...overrides });

async function cronFixture({ guardState = state(FINDINGS), definitions = DEFS } = {}) {
  const jobs = { 'day-held': tomorrow({ customerId: 'cust-held' }), 'day-ok': tomorrow({ customerId: 'cust-free', time: '13:00' }), 'pay-billed': overdue({ customerId: 'cust-billed' }), 'jobber_invoice_4001': overdue({ customerId: 'cust-free' }) };
  const store = memoryStore({ ...Object.fromEntries(Object.entries(jobs).map(([id, fields]) => [`jobs/${id}`, fields])), ...(guardState ? { 'jobberGuard/latest': guardState } : {}) });
  store.jobRecords = async () => Promise.all([...store.rows.keys()].filter(key => key.startsWith('jobs/')).map(key => store.read('jobs', key.slice(5))));
  for (const kind of ['day_before_reminder', 'payment_reminder']) {
    const template = await readTemplate(store, kind);
    await mutateTemplate(store, messagingOwner, { action: 'approve', requestId: uuid(), kind, expectedVersion: template.latestVersion, version: 1, hash: template.versions[0].hash }, NOW);
    await mutateTemplate(store, messagingOwner, { action: 'set_automation', requestId: uuid(), kind, expectedVersion: 1, enabled: true }, NOW);
  }
  const nonces = new Set(), keys = servicePublicKeySet({ service: 'api', rootSecret: API_ROOT, workspace: 'egc' });
  const firestoreFetch = async (_env, _url, init) => { const body = JSON.parse(init.body); if (body.structuredQuery) return Response.json([]); const name = body.writes[0].update.name; if (nonces.has(name)) return new Response('{}', { status: 409 }); nonces.add(name); return Response.json({}); };
  const verify = (env, token, path, options) => verifyApiServiceEnvelope(env, token, path, { ...options, resolveKey: async () => (await keys).keys[0], firestoreFetch });
  const ghl = fakeGhl(), time = clock(NOW);
  const handler = messagingCronHandlers({ verify, storage: () => store, now: time, links: () => ({ payLink: async () => 'https://easygaragecleaning.com/pay/synthetic', portalLink: async () => 'https://easygaragecleaning.com/portal/synthetic' }),
    messenger: env => createGhlMessenger({ env, fetcher: ghl.fetcher, clock: time }), portalInvite: () => async () => ({ status: 'submitted' }),
    jobberGuard: (service, deps) => jobberGuardSends(service, { ...deps, definitions }) });
  const run = async (env, body = { command: 'messaging.run' }) => {
    const envelope = await signServiceRequest({ service: 'api', rootSecret: API_ROOT, workspace: 'egc', path: MESSAGING_CRON_PATH, actor: ACTOR, request: { requestId: uuid(), body }, now: time().getTime() });
    const response = await handler.post({ request: new Request('https://easygaragecleaning.com/api/messaging-cron', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ envelope }) }), env });
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    return result.summary;
  };
  return { store, ghl, run };
}
const outcomes = summary => Object.fromEntries(summary.results.map(row => [row.jobId, row.reason ? `${row.status}:${row.reason}` : row.status]));

test('messaging and billing guards hold automatic reminders for customers with open Jobber strays and record why', async () => {
  const f = await cronFixture();
  const summary = await f.run({ ...CRON_ENV, EGC_JOBBER_GUARD_BILLING: 'true', EGC_JOBBER_GUARD_MESSAGING: 'true' });
  assert.deepEqual(outcomes(summary), { 'day-held': 'suppressed:jobber_guard_messaging', 'day-ok': 'submitted', 'pay-billed': 'suppressed:jobber_guard_billing', 'jobber_invoice_4001': 'suppressed:jobber_guard_billing' });
  assert.equal(f.ghl.sends().length, 1, 'only the customer without Jobber strays is messaged');
  const holds = f.store.get('messaging_holds/current').entries.map(entry => [entry.key.split(':')[1], entry.reason]).sort();
  assert.deepEqual(holds, [['day-held', 'jobber_guard_messaging'], ['jobber_invoice_4001', 'jobber_guard_billing'], ['pay-billed', 'jobber_guard_billing']], 'held reminders show in messaging holds');
  const billingOnly = await (await cronFixture()).run({ ...CRON_ENV, EGC_JOBBER_GUARD_BILLING: 'true' });
  assert.deepEqual(outcomes(billingOnly), { 'day-held': 'submitted', 'day-ok': 'submitted', 'pay-billed': 'suppressed:jobber_guard_billing', 'jobber_invoice_4001': 'suppressed:jobber_guard_billing' }, 'each surface has its own switch');
  const dry = await (await cronFixture()).run({ ...CRON_ENV, EGC_JOBBER_GUARD_MESSAGING: 'true' }, { command: 'messaging.run', dryRun: true });
  assert.deepEqual(outcomes(dry), { 'day-held': 'suppressed:jobber_guard_messaging', 'day-ok': 'would_send', 'pay-billed': 'suppressed:jobber_guard_messaging', 'jobber_invoice_4001': 'would_send' }, 'a dry run previews the holds');
});

test('the cron sends exactly as today when the guard is off, before the cutover or without a check for the deployed cutover day, and holds when the check is unreadable', async () => {
  const allSent = { 'day-held': 'submitted', 'day-ok': 'submitted', 'pay-billed': 'submitted', 'jobber_invoice_4001': 'submitted' };
  assert.deepEqual(outcomes(await (await cronFixture()).run(CRON_ENV)), allSent);
  assert.deepEqual(outcomes(await (await cronFixture({ definitions: LATER_CUTOVER })).run({ ...CRON_ENV, EGC_JOBBER_GUARD_BILLING: 'true', EGC_JOBBER_GUARD_MESSAGING: 'true' })), allSent);
  assert.deepEqual(outcomes(await (await cronFixture({ guardState: null })).run({ ...CRON_ENV, EGC_JOBBER_GUARD_MESSAGING: 'true' })), allSent);
  assert.deepEqual(outcomes(await (await cronFixture({ definitions: MOVED })).run({ ...CRON_ENV, EGC_JOBBER_GUARD_BILLING: 'true', EGC_JOBBER_GUARD_MESSAGING: 'true' })), allSent, 'a check saved for 2026-09-20 holds nothing once the cutover day moves to 2026-09-21');
  const broken = await cronFixture({ guardState: { schemaVersion: 1, findings: null, checkedAt: NOW } });
  assert.deepEqual(Object.values(outcomes(await broken.run({ ...CRON_ENV, EGC_JOBBER_GUARD_MESSAGING: 'true' }))), Array(4).fill('suppressed:jobber_guard_unavailable'));
  assert.equal(broken.ghl.sends().length, 0);
});

test('the send wrapper returns the service untouched unless a switched-on surface has a saved check', async () => {
  const service = { preview: async () => ({ status: 'ready' }), send: async () => ({ status: 'submitted' }), status: async () => ({}) };
  const store = memoryStore({ 'jobberGuard/latest': state(FINDINGS), 'jobs/job-1': { customerId: 'cust-billed' } });
  assert.equal(await jobberGuardSends(service, { store, env: {}, now: new Date(NOW), definitions: DEFS }), service);
  assert.equal(await jobberGuardSends(service, { store: memoryStore(), env: { EGC_JOBBER_GUARD_MESSAGING: 'true' }, now: new Date(NOW), definitions: DEFS }), service);
  assert.equal(await jobberGuardSends(service, { store, env: { EGC_JOBBER_GUARD_MESSAGING: 'true' }, now: new Date(NOW), definitions: MOVED }), service, 'a check for another cutover day is not in force');
  const wrapped = await jobberGuardSends(service, { store, env: { EGC_JOBBER_GUARD_MESSAGING: 'true' }, now: new Date(NOW), definitions: DEFS });
  assert.deepEqual(await wrapped.send({}, { kind: 'payment_reminder', jobId: 'job-1' }), { status: 'suppressed', reason: 'jobber_guard_messaging' });
  assert.deepEqual(await wrapped.send({}, { kind: 'crew_assignment', jobId: 'job-1' }), { status: 'submitted' }, 'crew messages are never held');
  assert.equal(wrapped.status, service.status);
});
