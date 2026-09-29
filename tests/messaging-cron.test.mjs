import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { servicePublicKeySet, signServiceRequest } from '../egc-platform/services/operations/src/service-auth.ts';
import { verifyApiServiceEnvelope } from '../functions/_lib/operations-service-auth.js';
import { messagingCronHandlers, MESSAGING_CRON_PATH, onRequestGet } from '../functions/api/messaging-cron.js';
import { onRequestGet as integrationStatus } from '../functions/api/integration-status.js';
import { createHubSessionCookie } from '../functions/_lib/hub-session.js';
import { createGhlMessenger } from '../functions/_lib/ghl-messenger.js';
import { mutateTemplate, readTemplate } from '../functions/_lib/message-template-store.js';
import { env as messagingEnv, owner, job, memoryStore, fakeGhl, clock, uuid, NOW } from './helpers/messaging-fixture.mjs';

const API_ROOT = 'synthetic-messaging-cron-api-root-secret-0123456789';
// HUB_SESSION_SECRET (>= 32 chars) makes the Hub's operations bridge use v2
// signed service requests; the API root secret signs as the Railway worker.
const ENV = Object.freeze({ ...messagingEnv, EGC_SERVER_MESSAGING_ENABLED: 'true', EGC_MESSAGING_SUBREQUEST_BUDGET: '9500' });
const ACTOR = Object.freeze({ id: 'messaging-cron-worker', kind: 'integration', role: 'integration', workspace: 'egc' });
const LINKS = Object.freeze({ payLink: async () => 'https://easygaragecleaning.com/pay/synthetic', portalLink: async () => 'https://easygaragecleaning.com/portal/synthetic' });
const AT = Date.parse(NOW);
const tomorrow = (overrides = {}) => job({ date: '2026-09-23', time: '09:00', deposit: { amount: 300, paidAmount: 300, verified: true }, invoice: { number: 'INV-2001', amount: 1200, dueDate: '2026-12-31', status: 'issued' }, ...overrides });
// An accepted job three days out with its $300 deposit unpaid: the deposit reminder is due.
// (Payment reminders are HighLevel's, from the egc-invoice-overdue tag, so the cron never sends one.)
const depositDue = (overrides = {}) => job({ date: '2026-09-25', time: '10:00', invoice: { number: 'INV-3001', amount: 1200, dueDate: '2026-12-31', status: 'issued' }, ...overrides });
const claimsOf = token => JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString());
const tamper = (token, patch) => Buffer.from(JSON.stringify({ ...claimsOf(token), ...patch })).toString('base64url') + '.' + token.split('.')[1];

const sign = ({ requestId = uuid(), body = { command: 'messaging.run' }, path = MESSAGING_CRON_PATH, actor = ACTOR, at = AT } = {}) =>
  signServiceRequest({ service: 'api', rootSecret: API_ROOT, workspace: 'egc', path, actor, request: { requestId, body }, now: at });

// The real Hub verifier with the API key set pinned in memory and the
// Firestore nonce ledger emulated (create-only; a second claim is a 409).
function signedVerifier() {
  const nonces = new Set(), keys = servicePublicKeySet({ service: 'api', rootSecret: API_ROOT, workspace: 'egc' });
  const firestoreFetch = async (_env, url, init) => {
    assert.match(String(url), /^https:\/\/firestore\.googleapis\.com\/v1\/projects\/egcw-1ec83\/databases\/\(default\)\/documents:(commit|runQuery)$/);
    const body = JSON.parse(init.body);
    if (body.structuredQuery) return Response.json([]);
    const name = body.writes[0].update.name;
    assert.equal(body.writes[0].currentDocument.exists, false);
    if (nonces.has(name)) return new Response('{}', { status: 409 });
    nonces.add(name);
    return Response.json({});
  };
  return { nonces, verify: (env, token, path, options) => verifyApiServiceEnvelope(env, token, path, { ...options, resolveKey: async () => (await keys).keys[0], firestoreFetch }) };
}

async function fixture({ jobs = { 'day-1': tomorrow(), 'dep-1': depositDue() }, rows = {}, automated = ['day_before_reminder', 'deposit_reminder'], ghl: ghlOptions = {}, webLeads } = {}) {
  const store = memoryStore({ ...Object.fromEntries(Object.entries(jobs).map(([id, fields]) => [`jobs/${id}`, fields])), ...rows });
  store.jobRecords = async fields => { assert.ok(fields.length > 5, 'jobs scans are always masked'); return Promise.all([...store.rows.keys()].filter(key => key.startsWith('jobs/')).map(key => store.read('jobs', key.slice(5)))); };
  for (const kind of automated) {
    const state = await readTemplate(store, kind);
    await mutateTemplate(store, owner, { action: 'approve', requestId: uuid(), kind, expectedVersion: state.latestVersion, version: 1, hash: state.versions[0].hash }, NOW);
    await mutateTemplate(store, owner, { action: 'set_automation', requestId: uuid(), kind, expectedVersion: 1, enabled: true }, NOW);
  }
  const ghl = fakeGhl(ghlOptions), time = clock(NOW), signed = signedVerifier(), invites = [];
  const handler = messagingCronHandlers({
    verify: signed.verify, storage: () => store, now: time, links: () => LINKS,
    messenger: env => createGhlMessenger({ env, fetcher: ghl.fetcher, clock: time }),
    portalInvite: () => async jobId => { invites.push(jobId); return { status: 'submitted' }; },
    ...(webLeads ? { webLeads } : {}),
  });
  const post = (envelope, { env = ENV, headers = {}, body } = {}) => handler.post({ request: new Request('https://easygaragecleaning.com/api/messaging-cron', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: body ?? JSON.stringify({ envelope }) }), env });
  const runs = () => [...store.rows].filter(([key]) => key.startsWith('messaging_runs/')).map(([, value]) => value);
  const ledgers = () => [...store.rows].filter(([key]) => key.startsWith('message_sends/')).map(([, value]) => value);
  return { store, ghl, time, signed, invites, handler, post, runs, ledgers };
}
const json = async response => ({ status: response.status, body: await response.json(), cache: response.headers.get('Cache-Control') });

test('unsigned, tampered, expired, wrong-path and wrong-actor envelopes are rejected before any work', async () => {
  const f = await fixture(), commits = () => f.store.commits.length, before = commits(), token = await sign();
  const cases = [
    ['not-an-envelope', 401, 'messaging_cron_unauthorized'],
    [tamper(token, { actor: { ...ACTOR, id: 'someone-else' } }), 401, 'messaging_cron_unauthorized'],
    [tamper(token, { request: { requestId: uuid(), body: { command: 'messaging.run', dryRun: true } } }), 401, 'messaging_cron_unauthorized'],
    [await sign({ at: AT - 120000 }), 401, 'messaging_cron_unauthorized'],
    [await sign({ at: AT + 60000 }), 401, 'messaging_cron_unauthorized'],
    [await sign({ path: '/api/operations-portal' }), 401, 'messaging_cron_unauthorized'],
    [await sign({ actor: { id: 'zacb', kind: 'human', role: 'owner', workspace: 'egc' } }), 403, 'messaging_cron_forbidden'],
    [await sign({ actor: { ...ACTOR, id: 'hub-schedule:job-1' } }), 403, 'messaging_cron_forbidden'],
  ];
  for (const [envelope, status, code] of cases) {
    const result = await json(await f.post(envelope));
    assert.deepEqual([result.status, result.body.ok, result.body.code, result.cache], [status, false, code, 'no-store'], code);
    assert.doesNotMatch(JSON.stringify(result.body), /synthetic|invalid_service|signature/i, 'no verification internals are echoed');
  }
  assert.equal(f.signed.nonces.size, 2, 'only the two correctly signed envelopes (with the wrong actor) consumed a nonce');
  assert.deepEqual([commits(), f.runs().length, f.ghl.calls.length], [before, 0, 0]);
});

test('a replayed envelope is refused while a fresh envelope for the same request replays the saved run', async () => {
  const f = await fixture(), requestId = uuid(), envelope = await sign({ requestId });
  const first = await json(await f.post(envelope));
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.deepEqual([first.body.ok, first.body.runId, first.body.summarySaved, first.body.summary.sent, first.body.summary.counts], [true, requestId, true, 2, { submitted: 2 }]);
  assert.equal(f.ghl.sends().length, 2);
  const replayed = await json(await f.post(envelope));
  assert.deepEqual([replayed.status, replayed.body.code], [409, 'messaging_cron_replayed']);
  const again = await json(await f.post(await sign({ requestId })));
  assert.deepEqual([again.status, again.body.replayed, again.body.summary], [200, true, first.body.summary]);
  const conflict = await json(await f.post(await sign({ requestId, body: { command: 'messaging.run', dryRun: true } })));
  assert.deepEqual([conflict.status, conflict.body.code], [409, 'messaging_idempotency_conflict']);
  const [run] = f.runs();
  assert.deepEqual([run.runId, run.status, run.actorId, run.dryRun, run.startedAt, run.completedAt, run.summary.sent], [requestId, 'completed', 'messaging-cron-worker', false, NOW, NOW, 2]);
  assert.ok(f.ledgers().every(row => row.requestId === requestId && row.actorId === 'messaging-cron-worker'));
  assert.equal(f.ghl.sends().length, 2, 'no replay ever sends again');
});

test('two ticks at the same instant send each message once', async () => {
  const f = await fixture({ jobs: { 'day-1': tomorrow(), 'day-2': tomorrow({ time: '14:00' }), 'dep-1': depositDue() } });
  const results = await Promise.all([f.post(await sign()), f.post(await sign())].map(async response => json(await response)));
  assert.deepEqual(results.map(result => result.status), [200, 200]);
  assert.equal(results.reduce((total, result) => total + result.body.summary.sent, 0), 3);
  assert.equal(f.ghl.sends().length, 3);
  assert.ok(f.ledgers().every(row => row.status === 'submitted' && row.attempts === 1));
  assert.deepEqual(f.runs().map(run => run.status), ['completed', 'completed']);
});

test('live runs stay off until the owner turns server messaging on; dry runs report without sending', async () => {
  const f = await fixture({ jobs: { 'day-1': tomorrow(), 'invite-1': job({ date: '2026-12-01', invoice: { number: 'INV-4001', amount: 1200, dueDate: '2026-12-31', status: 'issued' }, customerPortalInvitationRequestedAt: '2026-09-22T10:00:00.000Z' }) } });
  const { EGC_SERVER_MESSAGING_ENABLED, ...off } = ENV;
  const refused = await json(await f.post(await sign(), { env: off }));
  assert.deepEqual([refused.status, refused.body.code, f.runs().length], [409, 'messaging_cron_disabled', 0]);
  const dry = await json(await f.post(await sign({ body: { command: 'messaging.run', dryRun: true } }), { env: off }));
  assert.equal(dry.status, 200, JSON.stringify(dry.body));
  assert.deepEqual([dry.body.summary.dryRun, dry.body.summary.counts], [true, { would_send: 1, would_retry: 1 }]);
  assert.deepEqual([f.ghl.calls.filter(call => call.method === 'POST').length, f.invites.length, f.ledgers().length], [0, 0, 0]);
  assert.equal(f.runs()[0].dryRun, true);
  const live = await json(await f.post(await sign()));
  assert.deepEqual([live.status, live.body.summary.counts, f.invites], [200, { submitted: 2 }, ['invite-1']], 'the existing automatic portal invitation retry now runs on the server');
});

test('the default subrequest budget sends what fits and still records the run', async () => {
  const f = await fixture({ jobs: { 'day-1': tomorrow(), 'day-2': tomorrow({ time: '13:00' }), 'dep-1': depositDue() } });
  const { EGC_MESSAGING_SUBREQUEST_BUDGET, ...standard } = ENV;
  const result = await json(await f.post(await sign(), { env: standard }));
  assert.equal(result.status, 200);
  assert.deepEqual([result.body.summary.sent, result.body.summary.budgetExhausted, result.body.summarySaved], [1, true, true]);
  assert.ok(result.body.summary.results.slice(1).every(row => row.status === 'not_attempted' && row.reason === 'subrequest_budget'));
  assert.deepEqual(f.ledgers().map(row => row.status), ['submitted'], 'nothing is stranded in sending');
});

test('with the default budget, undeliverable reminders are held back so a deliverable one behind them still goes out', async () => {
  // Three do-not-disturb contacts sort ahead of the deliverable reminder and
  // never reach the send ledger, so without holds they would use every tick.
  const dnd = { id: 'contact-dnd', locationId: 'location-1', phone: '+19705550123', email: 'synthetic@example.invalid', dnd: true, tags: [] };
  const ok = { id: 'contact-1', locationId: 'location-1', phone: '+19705550123', email: 'synthetic@example.invalid', dnd: false, tags: [] };
  const f = await fixture({ jobs: { 'a-dnd': depositDue({ highlevelContactId: 'contact-dnd' }), 'a-dnd2': depositDue({ highlevelContactId: 'contact-dnd' }), 'a-dnd3': depositDue({ highlevelContactId: 'contact-dnd' }), 'b-ok': depositDue() }, automated: ['deposit_reminder'], ghl: { contacts: { 'contact-1': ok, 'contact-dnd': dnd } } });
  const { EGC_MESSAGING_SUBREQUEST_BUDGET, ...standard } = ENV;
  const tick = async (body = { command: 'messaging.run' }) => {
    const result = await json(await f.post(await sign({ at: f.time().getTime(), body }), { env: standard }));
    assert.equal(result.status, 200, JSON.stringify(result.body));
    f.time.advance(15 * 60000);
    return result.body.summary;
  };
  const rows = summary => summary.results.map(row => `${row.jobId}:${row.status}`), holds = () => f.store.get('messaging_holds/current');
  const first = await tick();
  assert.deepEqual([rows(first), first.held], [['a-dnd:suppressed', 'a-dnd2:suppressed', 'a-dnd3:not_attempted', 'b-ok:not_attempted'], 0]);
  const second = await tick();
  assert.deepEqual([rows(second), second.held], [['a-dnd3:suppressed', 'b-ok:submitted', 'a-dnd:not_attempted', 'a-dnd2:not_attempted'], 2], 'held items wait behind the deliverable one');
  assert.deepEqual(f.ghl.sends().map(call => call.body.contactId), ['contact-1']);
  assert.deepEqual([holds().day, holds().entries.map(entry => [entry.key, entry.status, entry.reason])], ['2026-09-22', [
    ['deposit_reminder:a-dnd:2026-09-25:-3', 'suppressed', 'contact_dnd_sms'], ['deposit_reminder:a-dnd2:2026-09-25:-3', 'suppressed', 'contact_dnd_sms'], ['deposit_reminder:a-dnd3:2026-09-25:-3', 'suppressed', 'contact_dnd_sms'],
  ]]);
  assert.equal(rows(await tick()).at(0), 'b-ok:already_sent');
  // Dry runs read the holds for the same order but never change them.
  const before = holds();
  assert.equal((await tick({ command: 'messaging.run', dryRun: true })).held, 3);
  assert.deepEqual(holds(), before);
  // The next Denver day tries every stage in order again.
  f.time.set('2026-09-23T18:00:00.000Z');
  const next = await tick();
  assert.deepEqual([rows(next).slice(0, 2), next.held, holds().day], [['a-dnd:suppressed', 'a-dnd2:suppressed'], 0, '2026-09-23']);
  assert.equal(f.ghl.sends().length, 1, 'nothing was ever sent to a do-not-disturb contact or sent twice');
});

test('FUN-13: website-lead sync retries run on the signed tick even while server messaging is off, after the reminders and from what they left', async () => {
  const calls = [];
  let f;
  const runner = async options => {
    const at = options.elapsed();
    f.time.advance(31000);
    calls.push({ ...options, startBudget: options.budget(), sentBefore: f.ghl.sends().length, elapsed: [at, options.elapsed()] });
    f.time.advance(-31000);
    options.charge(10);
    return { due: 1, attempted: 1, synced: 1 };
  };
  f = await fixture({ webLeads: () => runner });
  const { EGC_SERVER_MESSAGING_ENABLED, ...off } = ENV;
  const refused = await json(await f.post(await sign(), { env: off }));
  assert.deepEqual([refused.status, refused.body.code, refused.body.webLeads, f.runs().length], [409, 'messaging_cron_disabled', { due: 1, attempted: 1, synced: 1 }, 0]);
  assert.deepEqual([calls[0].now.toISOString(), calls[0].dryRun, calls[0].startBudget], [NOW, false, Math.floor((9500 - 4) / 3)]);
  assert.deepEqual(calls[0].elapsed, [0, 31000], 'the retry pass is told how long the tick has run, so it can stop starting retries');
  const dry = await json(await f.post(await sign({ body: { command: 'messaging.run', dryRun: true } }), { env: off }));
  assert.deepEqual([dry.status, calls[1].dryRun, dry.body.webLeads.synced], [200, true, 1]);
  const live = await json(await f.post(await sign()));
  assert.deepEqual([live.status, live.body.summary.sent, live.body.webLeads.synced], [200, 2, 1]);
  assert.equal(calls[2].sentBefore, 2, 'the reminder run goes first, so slow HighLevel lead retries never cost it its tick');
  const broken = await fixture({ webLeads: () => async () => { throw new Error('synthetic outage'); } });
  const survived = await json(await broken.post(await sign()));
  assert.deepEqual([survived.status, survived.body.webLeads, survived.body.summary.sent], [200, { error: 'web_lead_retry_unavailable' }, 2]);
  const plain = await fixture();
  const untouched = await json(await plain.post(await sign()));
  assert.equal('webLeads' in untouched.body, false, 'without the ledger the tick is unchanged');
});

test('FUN-13: the lead retries get at most a third of the budget, and only what the reminder run left', async () => {
  const seen = [];
  const runner = async options => { seen.push(options.budget()); return { due: 0 }; };
  const { EGC_MESSAGING_SUBREQUEST_BUDGET, ...standard } = ENV;
  const light = await fixture({ jobs: {}, webLeads: () => runner });
  assert.equal((await json(await light.post(await sign(), { env: standard }))).status, 200);
  assert.equal(seen[0], Math.floor((45 - 4) / 3), 'an idle reminder run leaves the lead retries their full third');
  // A reminder run that stops for budget ends with less left than one reminder needs (24), below a third of 86.
  const jobs = Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`dep-${String(index).padStart(2, '0')}`, depositDue()]));
  const busy = await fixture({ jobs, automated: ['deposit_reminder'], webLeads: () => runner });
  const result = await json(await busy.post(await sign(), { env: { ...ENV, EGC_MESSAGING_SUBREQUEST_BUDGET: '90' } }));
  assert.deepEqual([result.status, result.body.summary.budgetExhausted, result.body.summary.limitReached], [200, true, false], JSON.stringify(result.body.summary));
  assert.ok(seen[1] >= 0 && seen[1] < 24, `the lead retries get only what the reminder run left (${seen[1]}), not their third (${Math.floor((90 - 4) / 3)})`);
});

test('unreadable settings fail the run closed and are recorded', async () => {
  const f = await fixture({ rows: { 'messaging_settings/automation': { depositReminderDaysBefore: 'weekly' } } });
  const result = await json(await f.post(await sign()));
  assert.deepEqual([result.status, result.body.code], [503, 'messaging_settings_invalid']);
  assert.match(result.body.error, /paused until they are fixed/);
  assert.deepEqual(f.runs().map(run => [run.status, run.code]), [['failed', 'messaging_settings_invalid']]);
  assert.equal(f.ghl.calls.length, 0);
});

test('transport, configuration and command checks fail before anything is read', async () => {
  const f = await fixture(), token = await sign();
  assert.equal((await onRequestGet()).status, 405);
  const cases = [
    [{ headers: { 'Content-Type': 'text/plain' } }, 415, 'messaging_cron_json_required'],
    [{ headers: { 'Content-Length': '32001' } }, 413, 'messaging_cron_request_too_large'],
    [{ body: 'x'.repeat(32001) }, 413, 'messaging_cron_request_too_large'],
    [{ body: '{"envelope":' }, 400, 'messaging_cron_json_invalid'],
    [{ body: JSON.stringify({ envelope: token, command: 'messaging.run' }) }, 400, 'messaging_cron_request_invalid'],
    [{ env: { ...ENV, EGC_OPERATIONS_SERVICE_AUTH: 'legacy', EGC_OPERATIONS_PORTAL_SIGNING_SECRET: 'synthetic-legacy-shared-secret-0123456789' } }, 503, 'messaging_cron_not_configured'],
    [{ env: { ...ENV, EGC_OPERATIONS_ENABLED: 'false' } }, 503, 'messaging_cron_not_configured'],
    [{ env: { ...ENV, HUB_SESSION_SECRET: 'short' } }, 503, 'messaging_cron_not_configured'],
  ];
  for (const [options, status, code] of cases) assert.deepEqual(await f.post(token, options).then(json).then(result => [result.status, result.body.code]), [status, code], code);
  for (const body of [{ command: 'messaging.send' }, { command: 'messaging.run', dryRun: 'yes' }, { command: 'messaging.run', kind: 'deposit_reminder' }]) {
    assert.deepEqual(await f.post(await sign({ body })).then(json).then(result => [result.status, result.body.code]), [400, 'messaging_cron_command_invalid'], JSON.stringify(body));
  }
  assert.deepEqual([f.runs().length, f.ghl.calls.length], [0, 0]);
});

test('integration status tells the Hub whether the server owns reminders', async () => {
  const env = { HUB_SESSION_SECRET: 'synthetic-status-session-secret', HUB_AUTH_USERS_JSON: JSON.stringify({ ZacB: { passwordHash: 'synthetic-hash', displayName: 'Zac', role: 'owner' } }) };
  const cookie = (await createHubSessionCookie(env, 'ZacB')).split(';')[0];
  const status = async extra => (await (await integrationStatus({ request: new Request('https://easygaragecleaning.com/api/integration-status', { headers: { Cookie: cookie } }), env: { ...env, ...extra } })).json()).status.serverMessaging;
  assert.deepEqual([await status({}), await status({ EGC_SERVER_MESSAGING_ENABLED: 'yes' }), await status({ EGC_SERVER_MESSAGING_ENABLED: 'true' })], [false, false, true]);
  const anonymous = await integrationStatus({ request: new Request('https://easygaragecleaning.com/api/integration-status'), env: { ...env, EGC_SERVER_MESSAGING_ENABLED: 'true' } });
  assert.equal(anonymous.status, 401);
});

test('messaging settings, run summaries and holds are server-only Firestore collections', () => {
  const rules = readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8');
  for (const collection of ['messaging_settings', 'messaging_runs', 'messaging_holds']) assert.match(rules, new RegExp(`match /${collection}/\\{documentId\\} \\{\\s*allow read, write: if false;\\s*\\}`), collection);
});

// Loads the real employee-suite.js into a VM with a fake Hub API and runs the
// same loadAll -> retryDueSyncs path a manager's page load does.
function suite(status, { jobs = [], remembered } = {}) {
  const now = Date.parse(NOW), timeouts = [], calls = [], writes = [];
  const values = new Map([['egc_u', 'ZacB'], ['egc_business_access', 'true'], ['egc_owner', 'true'], ['egc_role', 'owner'], ...(remembered === undefined ? [] : [['egc.serverMessaging.v1', remembered]])]);
  const storage = { getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key) };
  const response = (body, code = 200) => ({ ok: code < 400, status: code, json: async () => body });
  const base = { type: 'job', customer: 'Synthetic Customer', phone: '(970) 555-0123', email: 'synthetic@example.invalid', customerAutomationEnabled: true, date: '2026-10-20', time: '09:00' };
  const context = {
    console, URLSearchParams, Intl, Promise, Set, Map, Error, JSON, Math, Number, String, Array, Object,
    Date: class extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } },
    sessionStorage: storage, localStorage: storage, navigator: {}, me: 'ZacB', location: { pathname: '/employee', search: '' },
    jobsCache: [
      { ...base, id: 'estimate-expiring', estimate: { status: 'sent', amount: 900, validUntil: '2026-09-23' } },
      { ...base, id: 'invoice-overdue', estimate: { status: 'accepted', amount: 1200 }, invoice: { number: 'INV-1', amount: 1200, dueDate: '2026-09-01', status: 'issued' } },
      { ...base, id: 'portal-invite', estimate: { status: 'accepted', amount: 1200 }, customerPortalInvitationRequestedAt: '2026-09-22T10:00:00.000Z' },
      ...jobs.map(job => ({ ...base, ...job })),
    ],
    db: { collection: name => ({ doc: id => ({ set: async (update, options) => { writes.push({ name, id, update, options }); } }) }) },
    setTimeout: (callback, delay) => { timeouts.push({ callback, delay }); return timeouts.length; }, clearTimeout() {}, setInterval: () => 1, clearInterval() {},
    addEventListener() {}, document: { readyState: 'loading', hidden: false, activeElement: null, addEventListener() {}, querySelector: () => null, querySelectorAll: () => [] },
  };
  context.window = context;
  context.hubFetch = async (url, init = {}) => {
    calls.push({ url, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null });
    if (url === '/api/integration-status') return status === 'unavailable' ? response({ ok: false, error: 'Configuration readiness is unavailable' }, 503) : response({ ok: true, status: { highlevel: true, serverMessaging: status } });
    if (url.startsWith('/api/employee-hub')) return response(init.method === 'POST' ? { ok: true, record: JSON.parse(init.body).data } : { ok: true, collections: {}, accounts: [] });
    if (url.startsWith('/api/employee-accounts')) return response({ ok: true, accounts: [] });
    if (url.startsWith('/api/highlevel?')) return response({ ok: true, pipelines: [], opportunities: [], events: [] });
    if (url === '/api/highlevel') return response({ ok: true, automation: { trigger: 'egc-synthetic' } });
    if (url === '/api/customer-portal-invitation') return response({ ok: true, portalInvitation: { jobId: 'portal-invite', status: 'submitted' } });
    return response({ ok: false, error: 'unexpected' }, 404);
  };
  const source = readFileSync(new URL('../employee-suite.js', import.meta.url), 'utf8').replace(/\}\)\(\);\s*$/, 'Object.assign(globalThis,{ui:{S,loadAll}});})();');
  vm.runInNewContext(source, context);
  // Render through a mounted module so the test needs no full Hub DOM.
  context.ui.S.active = 'availability';
  context.EGCAvailability = { mount() {}, unmount() {} };
  return {
    calls, writes, values, context,
    async loadAll() {
      await context.ui.loadAll();
      const retry = timeouts.splice(0).filter(timer => timer.delay === 1500);
      assert.equal(retry.length, 1, 'loadAll schedules one background retry pass for managers');
      // The timer callback does not return the retry promise; let it settle.
      retry[0].callback();
      for (let turn = 0; turn < 50; turn += 1) await new Promise(resolve => setImmediate(resolve));
    },
    customerPosts: () => calls.filter(call => call.method === 'POST' && ((call.url === '/api/highlevel' && call.body?.tool === 'lifecycle') || call.url === '/api/customer-portal-invitation')),
    posted: () => calls.filter(call => call.method === 'POST' && ((call.url === '/api/highlevel' && call.body?.tool === 'lifecycle') || call.url === '/api/customer-portal-invitation')).map(call => call.url === '/api/highlevel' ? `${call.body.event}:${call.body.job_id}` : `portal:${call.body.job_id}`).sort(),
  };
}

// A legacy overdue reminder whose HighLevel trigger failed earlier is saved
// for the lifecycle retry loop; an estimate-expiring reminder and a
// cancellation sync failed the same way.
const failedReminder = { id: 'failed-reminder', estimate: { status: 'accepted', amount: 1200 }, invoice: { number: 'INV-2', amount: 1200, dueDate: '2026-12-01', status: 'issued' },
  lifecycleSync: { event: 'invoice-overdue', status: 'error', error: 'HighLevel lifecycle sync failed', attemptedAt: '2026-09-22T15:00:00.000Z' },
  lifecycleSyncPayload: { tool: 'lifecycle', event: 'invoice-overdue', job_id: 'failed-reminder', idempotency_key: 'communication:failed-reminder:invoice-overdue:2026-09-01' } };
const failedEstimate = { id: 'failed-estimate', estimate: { status: 'sent', amount: 900, validUntil: '2026-12-01' },
  lifecycleSync: { event: 'estimate-expiring', status: 'error', error: 'HighLevel lifecycle sync failed', attemptedAt: '2026-09-22T15:00:00.000Z' },
  lifecycleSyncPayload: { tool: 'lifecycle', event: 'estimate-expiring', job_id: 'failed-estimate', idempotency_key: 'communication:failed-estimate:estimate-expiring:2026-09-21' } };
const failedCancellation = { id: 'failed-cancel', estimate: { status: 'accepted', amount: 1200 },
  lifecycleSync: { event: 'job-cancelled', status: 'error', error: 'HighLevel lifecycle sync failed', attemptedAt: '2026-09-22T15:00:00.000Z' },
  lifecycleSyncPayload: { tool: 'lifecycle', event: 'job-cancelled', job_id: 'failed-cancel', idempotency_key: 'lifecycle:failed-cancel:job-cancelled:2026-09-22T15:00:00.000Z' } };

// The server never sends payment reminders (HighLevel's egc-invoice-overdue
// workflow does), so the page adds the invoice-overdue tag whatever
// serverMessaging says; only the reminders the server owns stop on the page.
test('once the server owns messaging, a manager page load makes no estimate-reminder or portal-invitation POSTs and still adds the invoice-overdue tag', async () => {
  const legacy = suite(false);
  await legacy.loadAll();
  assert.deepEqual(legacy.customerPosts().map(call => call.url === '/api/highlevel' ? `${call.body.event}:${call.body.job_id}` : `portal:${call.body.job_id}`).sort(), ['estimate-expiring:estimate-expiring', 'invoice-overdue:invoice-overdue', 'portal:portal-invite'], 'with the flag off today\'s browser triggers still run');
  for (const status of [true, 'unavailable']) {
    const server = suite(status);
    await server.loadAll();
    assert.ok(server.calls.some(call => call.url === '/api/integration-status'), 'the page did load');
    assert.deepEqual(server.posted(), ['invoice-overdue:invoice-overdue'], String(status));
    const logged = server.writes.filter(write => write.update.automationMilestones || write.update.communicationLog);
    assert.ok(logged.length > 0 && logged.every(write => write.id === 'invoice-overdue'), 'only the overdue trigger writes its log and marker');
  }
});

test('once the server owns messaging, a failed estimate reminder is not retried from the page while the overdue tag and other workflow retries continue', async () => {
  const legacy = suite(false, { jobs: [failedReminder, failedEstimate, failedCancellation] });
  await legacy.loadAll();
  for (const expected of ['invoice-overdue:failed-reminder', 'estimate-expiring:failed-estimate', 'job-cancelled:failed-cancel']) assert.ok(legacy.posted().includes(expected), `with the flag off the legacy retry still runs: ${expected}`);
  const server = suite(true, { jobs: [failedReminder, failedEstimate, failedCancellation] });
  await server.loadAll();
  assert.deepEqual(server.posted(), ['invoice-overdue:failed-reminder', 'invoice-overdue:invoice-overdue', 'job-cancelled:failed-cancel']);
  // A manager's bulk "Retry all" leaves the estimate reminder to the server too.
  await server.context.opsRetryAll();
  assert.deepEqual(server.posted(), ['invoice-overdue:failed-reminder', 'invoice-overdue:invoice-overdue', 'job-cancelled:failed-cancel']);
});

test('when the status check fails the tab keeps its last known answer, and only fails closed without one', async () => {
  const fresh = suite(false);
  await fresh.loadAll();
  assert.equal(fresh.values.get('egc.serverMessaging.v1'), 'false', 'a confirmed answer is remembered for this tab');
  const offline = suite('unavailable', { remembered: 'false', jobs: [failedReminder] });
  await offline.loadAll();
  assert.deepEqual(offline.posted(), ['estimate-expiring:estimate-expiring', 'invoice-overdue:failed-reminder', 'invoice-overdue:invoice-overdue', 'portal:portal-invite'], 'the default-off flag keeps today\'s behaviour through a status outage');
  for (const remembered of ['true', undefined, 'corrupt']) {
    const closed = suite('unavailable', { remembered, jobs: [failedReminder] });
    await closed.loadAll();
    assert.deepEqual(closed.posted(), ['invoice-overdue:failed-reminder', 'invoice-overdue:invoice-overdue'], `${remembered}: only the page-owned overdue tag runs`);
  }
  const switched = suite(true, { remembered: 'false' });
  await switched.loadAll();
  assert.deepEqual([switched.posted(), switched.values.get('egc.serverMessaging.v1')], [['invoice-overdue:invoice-overdue'], 'true'], 'a fresh answer always wins over the remembered one');
});

test('the per-customer opt-in describes the reminders the server will send once it owns messaging', async () => {
  for (const [status, expected] of [[false, /one estimate-expiring reminder and one invoice-overdue reminder/], [true, /day-before appointment, deposit and estimate-expiring\..*It also triggers one invoice-overdue reminder through HighLevel\./]]) {
    const hub = suite(status);
    await hub.loadAll();
    void hub.context.opsSetCustomerAutomation('estimate-expiring', true);
    await new Promise(resolve => setImmediate(resolve));
    assert.match(hub.context.ui.S.actionDialog.copy, expected, String(status));
    assert.equal(hub.context.ui.S.actionDialog.confirmLabel, 'Enable reminders');
  }
});
