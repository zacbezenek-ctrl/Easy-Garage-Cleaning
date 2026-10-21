// PORTAL-LINKS (owner decision of 2026-10-21), what people read: the Hub's Estimates & payments row (every portal link
// send and copy, which automatic retry sends a held one), the estimator's send screen, and the walkthrough page of a
// quote author following the server's first sync. The server behaviour is tests/portal-links.test.mjs. Synthetic data.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from './helpers/vm-realm.mjs';

const DAY = '2026-09-22T18:00:00.000Z', LATE = '2026-09-23T05:30:00.000Z', EIGHT = '2026-09-23T14:01:00.000Z';

function hubContext(extra = {}) {
  const suite = readFileSync(new URL('../employee-suite.js', import.meta.url), 'utf8'), line = prefix => suite.split(/\r?\n/).find(value => value.startsWith(prefix));
  const context = vm.createContext({ Date, Intl, JSON, Number, String, Map, Response, S: { integrations: {} }, jobsCache: [], isManager: () => true, render: () => {}, showToast: () => {}, ...extra });
  context.window = context;
  vm.runInContext(['function jobs(){return jobsCache}', ...['const esc=', 'const portalInvitationChecks=', 'function cachePortalInvitation(', 'function portalInvitationState(', 'function portalRetryNote(', 'function portalStamp(', 'function portalInvitationLabel(', 'function portalInvitationControl(', 'const PORTAL_LINK_NAMES=', 'function portalLinkState(', 'function portalLinkLabel(', 'function portalLinkControl(', 'function cachePortalLink(', 'window.opsRetryPortalLink=', 'window.opsRetryPortalInvitation=', 'async function runPortalInvitationRetries(', 'async function runPortalLinkRetries('].map(line)].join('\n'), context);
  return context;
}

test('Hub: the Estimates & payments row shows every portal link send and copy, says which retry sends a held one, and retries waiting links', async () => {
  const bodies = [], now = Date.parse(EIGHT);
  const context = hubContext({ Date: class extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } }, hubFetch: async (url, options) => { bodies.push(JSON.parse(options.body)); return new Response(JSON.stringify({ ok: true, portalInvitation: { status: 'submitted' } })); } });
  const job = { id: 'job-1', type: 'job', estimate: { status: 'sent' }, portalLinks: { quote_ready: { kind: 'quote_ready', jobId: 'job-1', status: 'submitted', channel: 'SMS', recipient: '(•••) •••-0100', completedAt: '2026-10-21T20:14:00.000Z' } }, portalLinkCopies: [{ by: 'sales.person', at: '2026-10-21T20:20:00.000Z', role: 'estimator' }] };
  const html = context.portalLinkControl(job);
  assert.match(html, /Portal link texted 10\/21 2:14 PM \(quote ready\) · \(•••\) •••-0100/);
  assert.match(html, /Portal link copied by sales\.person 10\/21 2:20 PM/);
  assert.doesNotMatch(html, /<button/, 'a sent link has no retry');
  const waiting = { quote_ready: { kind: 'quote_ready', jobId: 'job-1', status: 'deferred', reason: 'quiet_hours', notBefore: '2026-09-23T14:00:00.000Z', attempts: 0, deferredAt: LATE } };
  assert.equal(context.portalLinkLabel('quote_ready', waiting.quote_ready), 'Portal link (quote ready) waits for 8 AM (quiet hours) · sends on the next manager Hub load (or the server, if server messaging is on)');
  context.S.integrations.serverMessaging = false;
  assert.equal(context.portalLinkLabel('job_done', { status: 'deferred', reason: 'quiet_hours' }), 'Portal link (job done) waits for 8 AM (quiet hours) · sends on the next manager Hub load');
  context.S.integrations.serverMessaging = true;
  assert.equal(context.portalInvitationLabel({ id: 'job-2', customerPortalInvitation: { jobId: 'job-2', status: 'deferred', reason: 'quiet_hours' } }), 'Portal invitation waits for 8 AM (quiet hours) · the server sends it automatically');
  assert.equal(context.portalLinkLabel('job_done', { status: 'not_eligible', reason: 'job_closed' }), 'Portal link (job done) not sent · job is closed');
  assert.equal(context.portalLinkLabel('quote_ready', { status: 'suppressed', reason: 'contact_dnd' }), 'Portal link (quote ready) not sent · customer is on Do Not Disturb');
  // The approved invitation a delivered quote-ready link made unnecessary: said so, and no retry.
  const covered = { id: 'job-3', customerPortalInvitationRequestedAt: DAY, customerPortalInvitation: { jobId: 'job-3', status: 'covered', reason: 'quote_ready_link_delivered', coveredBy: { kind: 'quote_ready', sentAt: '2026-10-21T20:14:00.000Z', channel: 'SMS' } } };
  assert.equal(context.portalInvitationLabel(covered), 'Portal invitation not needed · quote-ready link texted 10/21 2:14 PM still works');
  assert.doesNotMatch(context.portalInvitationControl(covered), /<button/);
  // Page-load retries: the waiting link at its notBefore, as an automatic (unmarked) request; the covered invitation is left alone.
  context.jobsCache = [{ ...job, portalLinks: waiting }, { ...covered, type: 'job', estimate: { status: 'accepted' } }];
  await context.runPortalInvitationRetries();
  assert.deepEqual(bodies, [{ job_id: 'job-1', kind: 'quote_ready' }]);
  await context.opsRetryPortalLink('job-1', 'quote_ready');
  assert.deepEqual(bodies.at(-1), { job_id: 'job-1', kind: 'quote_ready', manual: true });
});

test('send screen: the estimator is told what happened to the portal link, in plain words', () => {
  const source = readFileSync(new URL('../crew/quote-draft.js', import.meta.url), 'utf8');
  const context = vm.createContext({ window: {}, URLSearchParams, AbortController, setTimeout, clearTimeout, Intl, Date });
  vm.runInContext(source, context);
  const text = context.window.EGCQuoteDraft.portalLinkText;
  assert.equal(text({ status: 'submitted', channel: 'SMS', recipient: '(•••) •••-1234' }), 'Portal link texted to (•••) •••-1234.');
  assert.equal(text({ status: 'submitted', channel: 'Email', recipient: 't•••@example.invalid' }), 'Portal link emailed to t•••@example.invalid.');
  assert.equal(text({ status: 'deferred', reason: 'quiet_hours' }), 'Waiting for 8 AM: the portal link goes out automatically after quiet hours.');
  assert.equal(text({ status: 'off', reason: 'owner_switch_off' }), 'Off — share the quote yourself (the owner can turn on texting in Hub → Message templates).');
  assert.equal(text({ status: 'suppressed', reason: 'contact_dnd' }), 'Not texted: the customer is on Do Not Disturb.');
  assert.equal(text({ status: 'not_eligible', reason: 'prices_pending_approval' }), 'Not texted: prices wait for the owner’s approval.');
  assert.equal(text({ status: 'failed' }), 'Not texted: HighLevel refused the message.');
  assert.equal(text({ status: 'uncertain' }), 'Portal link delivery is unconfirmed: check HighLevel before sharing the link again.');
  assert.equal(text(null), '', 'an older server says nothing about it');
});

test('B: a quote author\'s walkthrough page follows the server\'s sync instead of waiting for a manager; a manager\'s page still syncs directly', async () => {
  const context = vm.createContext({ window: {}, URLSearchParams, AbortController, setTimeout, clearTimeout });
  vm.runInContext(readFileSync(new URL('../crew/gameplan-handoff.js', import.meta.url), 'utf8'), context);
  const answers = [{ ok: true, sync: { status: 'pending' }, portalInvitation: null }, { ok: true, sync: { status: 'syncing' }, portalInvitation: null }, { ok: true, sync: { status: 'synced' }, portalInvitation: { status: 'deferred', reason: 'quiet_hours', notBefore: '2026-09-23T14:00:00.000Z' } }];
  const urls = [], sleeps = [];
  const client = manager => context.window.EGCWalkthroughHandoffClient({ actor: async () => 'sales.person', managerSync: () => manager, sleep: async ms => { sleeps.push(ms); }, storage: { getItem: () => null, setItem() {}, removeItem() {} },
    fetch: async (url, options) => { urls.push([url, options?.method || 'GET', options?.body ? JSON.parse(options.body) : null]); return { ok: true, status: 200, json: async () => manager ? { ok: true, handoffSync: { status: 'synced' }, portalInvitation: { status: 'submitted' } } : answers.shift() }; } });
  const saved = { pending: { actor: 'sales.person', requestId: 'synthetic-request' }, result: { job: { id: 'job-9' }, serverSync: 'started' } };
  const followed = await client(false).sync(saved);
  assert.deepEqual(JSON.parse(JSON.stringify(followed)), { ok: true, server: true, handoffSync: { status: 'synced' }, portalInvitation: { status: 'deferred', reason: 'quiet_hours', notBefore: '2026-09-23T14:00:00.000Z' } });
  assert.deepEqual(urls.map(([url, method]) => [url, method]), Array(3).fill(['/api/walkthrough-handoff?view=sync&jobId=job-9', 'GET']));
  assert.equal(sleeps.length, 2);
  // An older server that did not start a sync: the page says a manager finishes it, and calls nothing.
  urls.length = 0;
  const old = await client(false).sync({ ...saved, result: { job: { id: 'job-9' } } });
  assert.deepEqual([old.handoffSync.status, urls.length], ['manager_required', 0]);
  // A manager's page calls /api/highlevel as before (which replays the server's result when it ran first).
  const direct = await client(true).sync(saved);
  assert.deepEqual([direct.handoffSync.status, urls.at(-1)[0], urls.at(-1)[2]], ['synced', '/api/highlevel', { tool: 'game_plan', job_id: 'job-9', handoff_request_id: 'synthetic-request' }]);
  const page = readFileSync(new URL('../crew/gameplan-handoff.js', import.meta.url), 'utf8');
  assert.match(page, /The server is finishing the CRM sync and the portal invitation; the office sees the result in the Hub\./);
});

