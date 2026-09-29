// FIX-B2B-BILLING (MONEY-05): a company project (a job with businessAccountId) never gets a customer message or a
// homeowner portal link from the Hub. Every customer-audience job policy refuses it first, the approved-send path
// refuses it before any link is minted or any ledger row is claimed, and the scheduler counts it as skipped instead
// of attempting (and failing) it on every tick. Synthetic data, injected clock, no live provider or Firestore.
import test from 'node:test';
import assert from 'node:assert/strict';
import { MESSAGE_KINDS, messagePolicy } from '../functions/_lib/message-policies.js';
import { createApprovedSendService, messagingFlags } from '../functions/_lib/approved-send.js';
import { createGhlMessenger } from '../functions/_lib/ghl-messenger.js';
import { mutateTemplate, readTemplate } from '../functions/_lib/message-template-store.js';
import { dueMessages, runDueMessages, SCHEDULER_JOB_FIELDS } from '../functions/_lib/messaging-scheduler.js';
import { normalizeMessagingSettings } from '../functions/_lib/messaging-settings.js';
import { portalLinkProviders } from '../functions/_lib/message-links.js';
import { env, owner, crew, automation, job, memoryStore, fakeGhl, clock, uuid, NOW } from './helpers/messaging-fixture.mjs';

// NOW is Tuesday 2026-09-22 12:00 in Denver; "tomorrow" is 2026-09-23.
const TODAY = '2026-09-22', ACCOUNT = 'a1'.repeat(16), SETTINGS = normalizeMessagingSettings(null);
const company = (fields = {}) => ({ ...fields, businessAccountId: ACCOUNT, businessPropertyId: 'b2'.repeat(16) });
const code = (expected, reason) => error => { assert.equal(error.code, expected); if (reason) assert.equal(error.details?.reason, reason); return true; };
// A job with nothing due at NOW (a December visit, a December invoice, an accepted estimate). Overrides make one kind due.
const quiet = (overrides = {}) => job({ date: '2026-12-01', invoice: { number: 'INV-2001', amount: 1200, dueDate: '2026-12-31', status: 'issued' }, ...overrides });
const tomorrow = (overrides = {}) => quiet({ date: '2026-09-23', time: '09:00', deposit: { amount: 300, paidAmount: 300, verified: true }, ...overrides });
const deposit = (overrides = {}) => quiet({ date: '2026-09-25', ...overrides });
const expiring = (overrides = {}) => quiet({ estimate: { number: 'EST-1', status: 'sent', amount: 900, validUntil: '2026-09-23' }, ...overrides });
const notice = { id: 'notice-1', valid: true, date: '2026-09-24', endDate: '2026-09-24', time: '09:00', endTime: '12:00' };

// Every message kind, each with a context its policy accepts for a homeowner job, and what a company project gets.
// Customer-audience job kinds refuse it; crew kinds (the crew still needs its schedule) and account-target kinds (no
// job is involved: a customer account's sign-in link, the business hub's own invitation) are unchanged.
const REFUSED = { eligible: false, reason: 'business_account_job' };
const TABLE = {
  on_my_way: { job: job(), business: REFUSED },
  day_before_reminder: { job: tomorrow(), automated: true, business: REFUSED },
  deposit_reminder: { job: deposit(), automated: true, business: REFUSED },
  estimate_expiring: { job: expiring(), automated: true, business: REFUSED },
  review_request: { job: job({ status: 'completed', pipelineStatus: 'completed' }), business: REFUSED },
  followup_draft: { job: job(), business: REFUSED },
  portal_invitation_adapter: { job: job(), business: REFUSED },
  crew_assignment: { job: tomorrow(), business: 'unchanged' },
  crew_unassignment: { job: tomorrow(), notice, business: 'unchanged' },
  crew_schedule_change: { job: tomorrow(), notice, business: 'unchanged' },
  portal_magic_link: { job: null, account: { id: 'customer-1' }, business: 'unchanged' },
  b2b_invite: { job: null, account: { id: ACCOUNT }, business: 'unchanged' },
};
const context = (row, jobFields) => ({ job: jobFields === null ? null : { id: 'job-1', ...jobFields }, account: row.account || null, today: TODAY, now: new Date(NOW), automated: row.automated === true, notice: row.notice || null, overrides: {}, crewId: 'crew1' });

test('policy table: every message kind is classified and each customer job kind refuses a company project first', () => {
  assert.deepEqual(Object.keys(TABLE).sort(), [...MESSAGE_KINDS].sort(), 'a new message kind must be added to this table');
  // M5-SEND removed the invoice and payment-reminder kinds (HighLevel's egc-invoice-issued / egc-invoice-overdue workflows send them).
  assert.deepEqual([messagePolicy('invoice_send'), messagePolicy('payment_reminder')], [null, null]);
  for (const kind of MESSAGE_KINDS) {
    const row = TABLE[kind], policy = messagePolicy(kind);
    const homeowner = policy.eligible(context(row, row.job));
    assert.deepEqual(homeowner, { eligible: true }, `${kind}: the fixture is eligible for a homeowner job`);
    const business = policy.eligible(context(row, row.job === null ? null : company(row.job)));
    if (row.business === 'unchanged') {
      assert.ok(policy.audience === 'crew' || policy.target === 'account', `${kind}: only crew and account kinds keep company projects`);
      assert.deepEqual(business, homeowner, kind);
    } else {
      assert.deepEqual([policy.audience, policy.target], ['customer', 'job'], kind);
      assert.deepEqual(business, row.business, kind);
    }
  }
});

test('the business check runs before each kind\'s own rule and follows businessAccountJob exactly', () => {
  // A company project whose own rule would also refuse it still reads business_account_job (checked first).
  assert.deepEqual(messagePolicy('review_request').eligible(context({}, company(job({ status: 'scheduled' })))), REFUSED);
  assert.deepEqual(messagePolicy('deposit_reminder').eligible(context({ automated: true }, company(deposit({ estimate: { status: 'sent', amount: 1200 } })))), REFUSED);
  for (const [value, refused] of [[ACCOUNT, true], ['  ', false], ['', false], [null, false], [false, false], [true, true], [42, true]]) {
    const result = messagePolicy('day_before_reminder').eligible(context({ automated: true }, tomorrow({ businessAccountId: value })));
    assert.deepEqual(result, refused ? REFUSED : { eligible: true }, JSON.stringify(value));
  }
});

async function approve(store, kinds) {
  for (const kind of kinds) {
    const state = await readTemplate(store, kind);
    await mutateTemplate(store, owner, { action: 'approve', requestId: uuid(), kind, expectedVersion: state.latestVersion, version: 1, hash: state.versions[0].hash }, NOW);
    await mutateTemplate(store, owner, { action: 'set_automation', requestId: uuid(), kind, expectedVersion: 1, enabled: true }, NOW);
  }
}
// Link providers that record every job they are asked about; they only mint for homeowner jobs.
function spyLinks() {
  const asked = [];
  const provider = name => async context => { asked.push({ name, jobId: context.job?.id, purpose: context.purpose }); return `https://easygaragecleaning.com/${name}/synthetic`; };
  return { asked, links: { payLink: provider('pay'), portalLink: provider('portal') } };
}

test('approved sends refuse a company project before any link, contact lookup or ledger claim, from the Hub, MCP and cron', async () => {
  const store = memoryStore({
    'jobs/home-1': deposit(), 'jobs/biz-1': company(deposit()),
    'jobs/home-2': job({ status: 'completed', pipelineStatus: 'completed' }), 'jobs/biz-2': company(job({ status: 'completed', pipelineStatus: 'completed' })),
    'jobs/biz-3': company(job()),
  });
  await approve(store, ['deposit_reminder', 'review_request', 'on_my_way']);
  const ghl = fakeGhl(), time = clock(NOW), spy = spyLinks();
  const service = createApprovedSendService({ store, messenger: createGhlMessenger({ env, fetcher: ghl.fetcher, clock: time }), clock: time, env, links: spy.links });
  // The homeowner twins preview normally, with a real link, so the refusal below is the company link alone.
  const ready = await service.preview(owner, { kind: 'deposit_reminder', jobId: 'home-1' });
  assert.equal(ready.status, 'ready');
  assert.equal((await service.preview({ ...owner, source: 'mcp' }, { kind: 'review_request', jobId: 'home-2' })).status, 'ready');
  const before = { asked: spy.asked.length, ghl: ghl.calls.length };
  assert.deepEqual(spy.asked.map(row => row.jobId), ['home-1', 'home-2']);
  for (const [actor, input] of [
    [owner, { kind: 'deposit_reminder', jobId: 'biz-1' }], [{ ...owner, source: 'mcp' }, { kind: 'review_request', jobId: 'biz-2' }],
    [crew, { kind: 'on_my_way', jobId: 'biz-3', overrides: { etaMinutes: 20 } }],
  ]) {
    await assert.rejects(service.preview(actor, input), code('messaging_not_eligible', 'business_account_job'), input.kind);
    await assert.rejects(service.send(actor, { ...input, requestId: uuid(), confirmToken: ready.confirmToken }), code('messaging_not_eligible', 'business_account_job'), input.kind);
  }
  await assert.rejects(service.send(automation, { kind: 'deposit_reminder', jobId: 'biz-1' }), code('messaging_not_eligible', 'business_account_job'));
  assert.deepEqual([spy.asked.length, ghl.calls.length], [before.asked, before.ghl], 'no link was minted and HighLevel was never asked about a company project');
  assert.deepEqual([...store.rows.keys()].filter(key => key.startsWith('message_sends/')), [], 'no ledger row was claimed');
  assert.equal(store.get('jobs/biz-1').communicationLog, undefined);
});

// Projects a document to Firestore mask paths, as dispatchStorage.jobRecords does, so the scheduler only sees the
// fields it asks for: without businessAccountId in SCHEDULER_JOB_FIELDS a company project would look like a homeowner's.
function masked(row, fields) {
  const out = { id: row.id, revision: row.revision };
  for (const path of fields) {
    const [head, ...rest] = path.split('.');
    if (!(head in row)) continue;
    if (!rest.length) { out[head] = row[head]; continue; }
    let source = row[head], target = out[head] ||= {};
    for (const [index, key] of rest.entries()) {
      if (source === null || typeof source !== 'object' || !(key in source)) break;
      if (index === rest.length - 1) target[key] = source[key];
      else { target = target[key] ||= {}; source = source[key]; }
    }
  }
  return out;
}

test('dueMessages counts company projects as skipped and never selects them, whatever else would hold them back', () => {
  assert.ok(SCHEDULER_JOB_FIELDS.includes('businessAccountId'), 'the masked scan reads the company link');
  const rows = {
    'home-day': tomorrow(), 'biz-day': company(tomorrow()), 'home-dep': deposit(), 'biz-dep': company(deposit()), 'home-est': expiring(), 'biz-est': company(expiring()),
    // Held back for another reason too: the company link is what is counted.
    'biz-muted': company(tomorrow({ notify: false })), 'biz-review': company(deposit({ payment: { amount: 100 } })), 'biz-no-start': company(tomorrow({ time: '' })),
    // Nothing due: a company project is not counted at all.
    'biz-quiet': company(quiet()),
  };
  const selected = dueMessages(Object.entries(rows).map(([id, fields]) => ({ ...fields, id })), { now: new Date(NOW), settings: SETTINGS });
  assert.deepEqual(selected.due.map(row => `${row.kind}:${row.jobId}`), ['day_before_reminder:home-day', 'deposit_reminder:home-dep', 'estimate_expiring:home-est']);
  assert.deepEqual(selected.skipped, { business_account_job: 6 });
  // Unlinking the company makes the same job due again.
  const unlinked = dueMessages([{ ...company(deposit()), businessAccountId: '', id: 'was-biz' }], { now: new Date(NOW), settings: SETTINGS });
  assert.deepEqual([unlinked.due.map(row => row.jobId), unlinked.skipped], [['was-biz'], {}]);
});

test('a tick skips company projects on every run: nothing attempted, held, linked, claimed or sent', async () => {
  const jobs = { 'home-dep': deposit(), 'biz-day': company(tomorrow()), 'biz-dep': company(deposit()), 'biz-est': company(expiring()) };
  const store = memoryStore(Object.fromEntries(Object.entries(jobs).map(([id, fields]) => [`jobs/${id}`, fields])));
  store.jobRecords = async fields => Promise.all([...store.rows.keys()].filter(key => key.startsWith('jobs/')).map(async key => masked(await store.read('jobs', key.slice(5)), fields)));
  await approve(store, ['day_before_reminder', 'deposit_reminder', 'estimate_expiring']);
  const ghl = fakeGhl(), time = clock(NOW), asked = [];
  // The production providers over the same store (they refuse a company project), wrapped to record which jobs they
  // were asked about; a minted link is swapped for a short one so the default wording fits one SMS.
  const real = portalLinkProviders({ env, read: id => store.read('jobs', id), now: () => time().getTime() });
  const links = Object.fromEntries(Object.entries(real).map(([name, provider]) => [name, async context => {
    asked.push(context.job?.id);
    const link = await provider(context);
    return typeof link === 'string' && link.startsWith('https://easygaragecleaning.com/api/customer-portal-session?access=') ? `https://easygaragecleaning.com/${name}/synthetic` : link;
  }]));
  const service = createApprovedSendService({ store, messenger: createGhlMessenger({ env, fetcher: ghl.fetcher, clock: time }), clock: time, env, links });
  const run = () => runDueMessages({ store, service, flags: messagingFlags(env), links }, { now: time() });
  const first = await run();
  assert.deepEqual([first.scanned, first.due, first.attempted, first.sent, first.skipped], [4, 1, 1, 1, { business_account_job: 3 }]);
  assert.deepEqual(first.results.map(row => [row.kind, row.jobId, row.status]), [['deposit_reminder', 'home-dep', 'submitted']]);
  // Days later the company projects are still only counted: never refused at send, so never held for retry.
  time.set('2026-09-23T18:00:00.000Z');
  const next = await run();
  assert.deepEqual([next.attempted, next.skipped.business_account_job, next.results.filter(row => row.jobId.startsWith('biz-'))], [0, 2, []]);
  assert.equal(store.get('messaging_holds/current'), null, 'no company project was held back for a later retry');
  assert.deepEqual([...new Set(asked)], ['home-dep'], 'links were only minted for the homeowner job');
  assert.equal(ghl.sends().length, 1);
  const ledgers = [...store.rows].filter(([key]) => key.startsWith('message_sends/')).map(([, row]) => row.targetId);
  assert.deepEqual(ledgers, ['home-dep']);
  for (const id of ['biz-day', 'biz-dep', 'biz-est']) assert.deepEqual([store.get(`jobs/${id}`).communicationLog, store.get(`jobs/${id}`).automationMilestones], [undefined, undefined], id);
});

// A later visit is lineage-linked to its account root (customerAccountOwnerJobId) and carries no businessAccountId of
// its own. When that root is a company project the visit is one too: approved-send resolves the verified root (as a
// portal link does) and the policies refuse the visit, so even wording with no link (the default day-before reminder)
// never reaches the visit's phone.
const visits = () => ({
  'jobs/root-biz': company(quiet({ customerId: 'cust-biz' })), 'jobs/visit-biz': tomorrow({ customerId: 'cust-biz', customerAccountOwnerJobId: 'root-biz' }),
  'jobs/root-home': quiet({ customerId: 'cust-home' }), 'jobs/visit-home': tomorrow({ customerId: 'cust-home', customerAccountOwnerJobId: 'root-home' }),
});

test('the policies refuse a job whose verified account root is a company project, and only then', () => {
  const policy = messagePolicy('day_before_reminder'), at = accountRoot => ({ ...context({ automated: true }, tomorrow()), accountRoot });
  assert.deepEqual([policy.eligible(at(company(quiet()))), policy.eligible(at(quiet())), policy.eligible(at(null)), policy.eligible(at(undefined))], [REFUSED, { eligible: true }, { eligible: true }, { eligible: true }]);
  assert.deepEqual(messagePolicy('crew_assignment').eligible({ ...context({}, tomorrow()), accountRoot: company(quiet()) }), { eligible: true }, 'crew notices are unchanged');
});

test('approved sends refuse a visit under a company project\'s account root from the Hub, MCP and cron; a homeowner visit still sends', async () => {
  const store = memoryStore({ ...visits(), 'jobs/visit-orphan': tomorrow({ customerId: 'cust-orphan', customerAccountOwnerJobId: 'root-gone' }), 'jobs/visit-flaky': tomorrow({ customerId: 'cust-flaky', customerAccountOwnerJobId: 'root-flaky' }) });
  await approve(store, ['day_before_reminder']);
  const ghl = fakeGhl(), time = clock(NOW), spy = spyLinks(), reads = [];
  const target = { ...store, read: async (collection, id) => { reads.push(id); if (id === 'root-flaky') throw Object.assign(new Error('Synthetic read failure'), { code: 'synthetic_read_failed' }); return store.read(collection, id); } };
  const service = createApprovedSendService({ store: target, messenger: createGhlMessenger({ env, fetcher: ghl.fetcher, clock: time }), clock: time, env, links: spy.links });
  const ready = await service.preview(owner, { kind: 'day_before_reminder', jobId: 'visit-home' });
  assert.equal(ready.status, 'ready', 'a visit under a homeowner root previews normally');
  assert.ok(reads.includes('root-home'), 'the root is read to verify the lineage');
  const calls = ghl.calls.length;
  for (const actor of [owner, { ...owner, source: 'mcp' }]) {
    await assert.rejects(service.preview(actor, { kind: 'day_before_reminder', jobId: 'visit-biz' }), code('messaging_not_eligible', 'business_account_job'), actor.source);
    await assert.rejects(service.send(actor, { kind: 'day_before_reminder', jobId: 'visit-biz', requestId: uuid(), confirmToken: ready.confirmToken }), code('messaging_not_eligible', 'business_account_job'), actor.source);
  }
  await assert.rejects(service.send(automation, { kind: 'day_before_reminder', jobId: 'visit-biz' }), code('messaging_not_eligible', 'business_account_job'));
  assert.equal(ghl.calls.length, calls, 'HighLevel was never asked about the visit');
  // A lineage that needs review proves no root, so the visit's own fields decide, as before; a failed read fails the send.
  assert.equal((await service.preview(owner, { kind: 'day_before_reminder', jobId: 'visit-orphan' })).status, 'ready');
  await assert.rejects(service.preview(owner, { kind: 'day_before_reminder', jobId: 'visit-flaky' }), error => error.code === 'synthetic_read_failed');
  const sent = await service.send(automation, { kind: 'day_before_reminder', jobId: 'visit-home' });
  assert.equal(sent.status, 'submitted');
  assert.equal(ghl.sends().length, 1);
  assert.deepEqual([...store.rows].filter(([key]) => key.startsWith('message_sends/')).map(([, row]) => row.targetId), ['visit-home'], 'no ledger row was claimed for the company visit');
  assert.equal(store.get('jobs/visit-biz').communicationLog, undefined);
  // Unlinking the company from the root makes its visit a homeowner job again.
  store.edit('jobs/root-biz', { businessAccountId: '' });
  assert.equal((await service.preview(owner, { kind: 'day_before_reminder', jobId: 'visit-biz' })).status, 'ready');
});

test('a tick refuses a visit under a company root once a day, then counts it as skipped instead of trying it on every tick', async () => {
  const store = memoryStore({ ...visits(), 'jobs/visit-biz': tomorrow({ customerId: 'cust-biz', customerAccountOwnerJobId: 'root-biz', estimate: { number: 'EST-9', status: 'sent', amount: 900, validUntil: '2026-09-23' } }) });
  store.jobRecords = async fields => Promise.all([...store.rows.keys()].filter(key => key.startsWith('jobs/')).map(async key => masked(await store.read('jobs', key.slice(5)), fields)));
  await approve(store, ['day_before_reminder', 'estimate_expiring']);
  const ghl = fakeGhl(), time = clock(NOW), attempts = [];
  const real = portalLinkProviders({ env, read: id => store.read('jobs', id), now: () => time().getTime() });
  const links = Object.fromEntries(Object.entries(real).map(([name, provider]) => [name, async context => { const link = await provider(context); return typeof link === 'string' ? `https://easygaragecleaning.com/${name}/synthetic` : link; }]));
  const approved = createApprovedSendService({ store, messenger: createGhlMessenger({ env, fetcher: ghl.fetcher, clock: time }), clock: time, env, links });
  const service = { ...approved, send: (actor, input) => { attempts.push(`${input.kind}:${input.jobId}`); return approved.send(actor, input); } };
  const run = () => runDueMessages({ store, service, flags: messagingFlags(env), links }, { now: time() });
  // The masked scan cannot see the lineage, so the first tick selects the visit and the send path refuses it.
  const first = await run();
  assert.deepEqual([first.due, first.attempted, first.sent, first.skipped], [3, 3, 1, {}]);
  assert.deepEqual(first.results.map(row => [row.kind, row.jobId, row.status, row.reason || '']), [
    ['day_before_reminder', 'visit-biz', 'not_eligible', 'business_account_job'], ['day_before_reminder', 'visit-home', 'submitted', ''], ['estimate_expiring', 'visit-biz', 'not_eligible', 'business_account_job'],
  ]);
  assert.deepEqual(store.get('messaging_holds/current').entries.map(entry => [entry.key, entry.reason]), [['day_before_reminder:visit-biz:2026-09-23:-1', 'business_account_job'], ['estimate_expiring:visit-biz:2026-09-23:-1', 'business_account_job']]);
  // Later the same Denver day both are counted, not attempted.
  time.advance(3600000);
  const again = await run();
  assert.deepEqual([again.due, again.attempted, again.skipped, again.results.map(row => [row.jobId, row.status])], [1, 0, { business_account_job: 2 }, [['visit-home', 'already_sent']]]);
  // The next Denver day the still-due estimate reminder is refused once more, then skipped for the rest of that day.
  time.set('2026-09-23T18:00:00.000Z');
  const next = await run();
  assert.deepEqual([next.attempted, next.skipped, next.results.map(row => [row.kind, row.jobId, row.status])], [1, {}, [['estimate_expiring', 'visit-biz', 'not_eligible']]]);
  time.advance(3600000);
  assert.deepEqual([(await run()).attempted, (await run()).skipped], [0, { business_account_job: 1 }]);
  assert.deepEqual(attempts, ['day_before_reminder:visit-biz', 'day_before_reminder:visit-home', 'estimate_expiring:visit-biz', 'estimate_expiring:visit-biz']);
  assert.equal(ghl.sends().length, 1, 'only the homeowner visit was texted');
  assert.deepEqual([...store.rows].filter(([key]) => key.startsWith('message_sends/')).map(([, row]) => row.targetId), ['visit-home']);
  assert.deepEqual([store.get('jobs/visit-biz').communicationLog, store.get('jobs/visit-biz').automationMilestones], [undefined, undefined]);
});
