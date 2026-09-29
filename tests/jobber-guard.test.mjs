import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { funnelDefinitions, validateFunnelDefinitions } from '../functions/_lib/funnel-definitions.js';
import { jobberGraphql } from '../functions/_lib/jobber-graphql.js';
import { SCHEDULED_KINDS } from '../functions/_lib/messaging-scheduler.js';
import { messagePolicy } from '../functions/_lib/message-policies.js';
import { GUARDED_MESSAGE_KINDS, JOBBER_GUARD_ACTIONS, JOBBER_GUARD_FINDING_LIMIT, ghlJobberMarker, jobberCutover, jobberGuardFindings, jobberGuardHolds, jobberGuardSwitches, readGhlJobberRecords, readJobberActivity, readJobberGuardState, runJobberGuardCheck, saveJobberGuardState } from '../functions/_lib/jobber-guard.js';
import { jobberGuardHandlers } from '../functions/api/jobber-guard.js';
import { parseArgs, runCli } from '../scripts/jobber-guard.mjs';
import { CLIENTS, CUTOVER, CUTOVER_AT, GHL_ENV, JOBBER_ENV, NOW, definitionsWith, ghlData, gid, hubData, hubStore, jobberData, providers } from './helpers/jobber-guard-fixture.mjs';

const DEFS = definitionsWith();
const SINCE = { date: CUTOVER, at: CUTOVER_AT };
const ON = { EGC_JOBBER_GUARD_BOOKING: 'true', EGC_JOBBER_GUARD_BILLING: 'true', EGC_JOBBER_GUARD_MESSAGING: 'true' };
const check = (options = {}) => { const api = providers(options); return { api, run: (extra = {}) => runJobberGuardCheck({ env: { ...JOBBER_ENV, ...GHL_ENV }, store: hubStore(), now: NOW, since: SINCE, runId: '1b4e28ba-2fa1-4d3b-a3f5-ef19b5a7633b', definitions: DEFS, fetcher: api.fetcher, sleep: async () => {}, ...extra }) }; };
const noPii = text => { for (const value of ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', '555-01', '970555', 'alpha@', 'charlie@', 'echo@', 'synthetic-refresh-token', 'synthetic-jobber-secret', 'synthetic-access-token']) assert.ok(!text.includes(value), `no ${value} in the output`); };

test('the definitions carry the Jobber cutover day (unset until the owner decides) and every finding the guard reports', () => {
  const shipped = funnelDefinitions().jobber;
  assert.equal(shipped.cutoverDate, null, 'no cutover day is set, so nothing can block today');
  assert.deepEqual(jobberCutover(), { date: null, at: null });
  assert.deepEqual(jobberCutover(DEFS), { date: CUTOVER, at: CUTOVER_AT }, 'the cutover instant is Denver midnight');
  assert.deepEqual(Object.keys(shipped.findings).sort(), Object.keys(JOBBER_GUARD_ACTIONS).sort(), 'every finding has a next step');
  assert.ok(funnelDefinitions().vocabularies.coverageReasons.includes('jobber_after_cutover'));
  assert.ok(Object.hasOwn(funnelDefinitions().eventIntegrity, 'cutoverDate'), 'the funnel data cutover stays a separate setting');
  const invalid = change => validateFunnelDefinitions(definitionsWith(CUTOVER, change));
  assert.deepEqual(invalid(() => {}), []);
  for (const [change, pattern] of [
    [d => { d.jobber.cutoverDate = '2026-02-30'; }, /cutoverDate must be null or a real/],
    [d => { d.jobber.cutoverDate = '10/01/2026'; }, /cutoverDate must be null or a real/],
    [d => { d.jobber.findings.jobber_job_after_cutover.surfaces = ['booking', 'sms']; }, /finding jobber_job_after_cutover is invalid/],
    [d => { d.jobber.findings.jobber_job_after_cutover.scope = 'visit'; }, /finding jobber_job_after_cutover is invalid/],
    [d => { delete d.jobber.findings.ghl_contact_from_jobber; }, /finding ghl_contact_from_jobber is missing/],
    [d => { d.jobber.guardSurfaces = ['booking', 'billing']; }, /guardSurfaces needs messaging/],
    [d => { d.jobber.ghlAppMarkers = { sources: [], tags: [], createdBySourceIds: [] }; }, /needs at least one marker/],
    [d => { d.jobber.ghlAppMarkers.tags = ['Jobber App']; }, /ghlAppMarkers.tags must be a list/],
    [d => { delete d.jobber; }, /jobber is required/],
  ]) assert.match(invalid(change).join('\n'), pattern);
});

test('switches are off unless exactly "true", read no definitions while off, and block only from the Denver cutover day', () => {
  const trap = new Proxy({}, { get() { throw new Error('definitions read'); } });
  for (const env of [{}, { EGC_JOBBER_GUARD_BOOKING: 'TRUE', EGC_JOBBER_GUARD_BILLING: '1', EGC_JOBBER_GUARD_MESSAGING: 'yes' }]) {
    assert.deepEqual(jobberGuardSwitches(env, new Date(NOW), trap), { enabled: { booking: false, billing: false, messaging: false }, cutoverDate: null, reached: false, booking: false, billing: false, messaging: false });
  }
  assert.deepEqual(jobberGuardSwitches(ON, new Date(NOW), definitionsWith(null)), { enabled: { booking: true, billing: true, messaging: true }, cutoverDate: null, reached: false, booking: false, billing: false, messaging: false }, 'no cutover day, nothing blocks');
  const before = jobberGuardSwitches(ON, new Date('2026-10-01T05:59:59.000Z'), DEFS), after = jobberGuardSwitches({ EGC_JOBBER_GUARD_BILLING: 'true' }, '2026-10-01T06:00:00.000Z', DEFS);
  assert.deepEqual([before.reached, before.booking, before.billing], [false, false, false], '23:59 on Sep 30 in Denver is before the cutover');
  assert.deepEqual([after.reached, after.booking, after.billing, after.messaging], [true, false, true, false], 'each surface has its own switch');
  assert.throws(() => jobberGuardSwitches(ON, 'not a time', DEFS), error => error.code === 'jobber_guard_clock_invalid');
});

test('automatic reminders guarded per surface are exactly the cron kinds that reach customers', () => {
  const customer = SCHEDULED_KINDS.filter(kind => messagePolicy(kind).audience === 'customer');
  assert.deepEqual([...GUARDED_MESSAGE_KINDS.messaging].sort(), [...customer].sort());
  assert.ok(GUARDED_MESSAGE_KINDS.billing.every(kind => customer.includes(kind)));
  assert.ok(!GUARDED_MESSAGE_KINDS.messaging.includes('crew_assignment'), 'crew messages are never held');
});

test('the Jobber reader sends only read queries with the cutover filters and normalizes ids, money and contacts', async () => {
  const { fetcher, calls } = providers();
  const activity = await readJobberActivity(JOBBER_ENV, { since: CUTOVER_AT, fetcher, sleep: async () => {} });
  const graph = calls.filter(call => call.kind === 'jobber');
  assert.ok(graph.every(call => /^\s*query /.test(call.query) && !/mutation/i.test(call.query)));
  const first = name => graph.find(call => call.name === name).variables.filter;
  const after = '2026-10-01T05:59:59.000Z';
  assert.deepEqual([first('EgcGuardRequests'), first('EgcGuardJobs'), first('EgcGuardVisits'), first('EgcGuardInvoices'), first('EgcGuardPayments')],
    [{ createdAt: { after } }, { createdAt: { after } }, { startAt: { after }, isComplete: false }, { updatedAt: { after } }, { entryDate: { after } }]);
  assert.equal(graph.filter(call => call.name === 'EgcGuardVisits').length, 3, 'every page is read');
  assert.deepEqual(activity.requests[0], { id: '501', title: 'Garage walkthrough', createdAt: '2026-10-02T15:00:00.000Z', status: 'new', client: { jobberId: '1004', name: 'Synthetic Delta', phones: ['+19705550199'], emails: [], receivesReminders: false, receivesInvoiceFollowUps: null } });
  assert.deepEqual(activity.invoices.find(row => row.number === '3101'), { id: '9101', number: '3101', status: 'awaiting_payment', createdAt: '2026-10-05T16:00:00.000Z', updatedAt: '2026-10-05T16:00:00.000Z', totalCents: 30000, balanceCents: 30000, client: activity.invoices[0].client });
  assert.deepEqual(activity.payments[0], { id: '6001', createdAt: '2026-10-03T16:00:00.000Z', amountCents: 50000, invoiceNumber: '3001', client: activity.payments[0].client });
  assert.equal(activity.jobs[1].number, '2102');
  assert.match(calls[0].body, /grant_type=refresh_token/);
});

test('Jobber failures never leak tokens or provider text, and the shared client refuses anything but a query', async () => {
  await assert.rejects(readJobberActivity({}, { since: CUTOVER_AT }), error => error.code === 'jobber_guard_graphql_not_configured');
  const denied = providers({ grant: {} });
  await assert.rejects(readJobberActivity(JOBBER_ENV, { since: CUTOVER_AT, fetcher: denied.fetcher }), error => error.code === 'jobber_guard_graphql_auth_failed' && /requests, jobs, visits, invoices and payments/.test(error.message) && !/synthetic/.test(error.message));
  const rejected = providers({ jobberFails: 'EgcGuardInvoices' });
  await assert.rejects(readJobberActivity(JOBBER_ENV, { since: CUTOVER_AT, fetcher: rejected.fetcher, sleep: async () => {} }), error => error.code === 'jobber_guard_graphql_failed' && !/synthetic-provider-detail/.test(error.message));
  const client = await jobberGraphql(JOBBER_ENV, { fetcher: providers().fetcher });
  await assert.rejects(client.query('mutation Forged { clientCreate { client { id } } }', {}), error => error.code === 'jobber_graphql_failed');
  const rotating = providers({ grant: { access_token: 'synthetic-access-token', refresh_token: 'synthetic-rotated-refresh-token' } });
  await assert.rejects(readJobberActivity(JOBBER_ENV, { since: CUTOVER_AT, fetcher: rotating.fetcher, sleep: async () => {} }), error => error.code === 'jobber_guard_graphql_rotation_on' && /Refresh Token Rotation is on/.test(error.message) && !/synthetic/.test(error.message));
  assert.deepEqual(rotating.calls.map(call => call.kind), ['jobber_token'], 'a rotated grant stops the run before any query');
  const echoed = providers({ grant: { access_token: 'synthetic-access-token', refresh_token: JOBBER_ENV.JOBBER_REFRESH_TOKEN } });
  assert.equal((await readJobberActivity(JOBBER_ENV, { since: CUTOVER_AT, fetcher: echoed.fetcher, sleep: async () => {} })).requests.length, 4, 'a grant that returns the same refresh token (rotation off) is read as usual');
  let throttled = 0;
  const slow = providers();
  const throttling = async (url, init) => { if (String(url).endsWith('/graphql') && throttled++ === 0) return Response.json({ errors: [{ extensions: { code: 'THROTTLED' } }], extensions: { cost: { requestedQueryCost: 500, throttleStatus: { currentlyAvailable: 100, restoreRate: 50 } } } }); return slow.fetcher(url, init); };
  const sleeps = [];
  await readJobberActivity(JOBBER_ENV, { since: CUTOVER_AT, fetcher: throttling, sleep: async ms => { sleeps.push(ms); } });
  assert.deepEqual(sleeps, [8000], 'a throttled page waits for the cost to restore, then retries');
});

test('HighLevel reader reads newest first, stops at the first record before the cutover and keeps only Jobber-app records', async () => {
  const api = providers();
  const found = await readGhlJobberRecords(GHL_ENV, { since: CUTOVER_AT, fetcher: api.fetcher, markers: DEFS.jobber.ghlAppMarkers, pageLimit: 2 });
  assert.deepEqual(found.contacts.map(row => [row.id, row.marker, row.phone]), [['contact-new', 'source', '+19705550105'], ['contact-tag', 'tag', '']]);
  assert.deepEqual(found.opportunities.map(row => [row.id, row.marker, row.contactId]), [['opp-1', 'source', 'contact-echo']]);
  const ghl = api.calls.filter(call => call.kind === 'ghl');
  assert.deepEqual(ghl.map(call => [call.method, call.path, call.version, call.body?.page ?? Number(call.query.page)]), [['POST', '/contacts/search', '2021-07-28', 1], ['POST', '/contacts/search', '2021-07-28', 2], ['GET', '/opportunities/search', 'v3', 1], ['GET', '/opportunities/search', 'v3', 2]], 'no page after the first older record is read');
  assert.deepEqual(ghl[0].body.sort, [{ field: 'dateAdded', direction: 'desc' }]);
  assert.deepEqual([ghl[2].query.order, ghl[2].query.status, ghl[2].query.locationId], ['added_desc', 'all', 'location-1']);
  await assert.rejects(readGhlJobberRecords({}, { since: CUTOVER_AT }), error => error.code === 'jobber_guard_ghl_not_configured');
  await assert.rejects(readGhlJobberRecords(GHL_ENV, { since: CUTOVER_AT, fetcher: providers({ ghlStatus: 401 }).fetcher }), error => error.code === 'jobber_guard_ghl_unavailable' && !/synthetic/.test(error.message));
  const shuffled = ghlData(); shuffled.contacts.reverse();
  await assert.rejects(readGhlJobberRecords(GHL_ENV, { since: CUTOVER_AT, fetcher: providers({ ghl: shuffled }).fetcher }), error => error.code === 'jobber_guard_ghl_incomplete', 'without newest-first order the stop rule proves nothing');
});

test('Jobber-app markers are folded sources, tags or the creating app id', () => {
  const markers = { sources: ['jobber'], tags: ['jobber'], createdBySourceIds: ['app-123'] };
  assert.equal(ghlJobberMarker({ source: 'Official Jobber Integration' }, markers), 'source');
  assert.equal(ghlJobberMarker({ source: 'Jobberish leads' }, markers), null, 'a whole word must match');
  assert.equal(ghlJobberMarker({ contact: { tags: ['Jobber'] } }, markers), 'tag');
  assert.equal(ghlJobberMarker({ createdBy: { source: 'INTEGRATION', sourceId: 'app-123' } }, markers), 'app');
  assert.equal(ghlJobberMarker({ source: 'Website form', tags: ['web-lead'] }, markers), null);
});

test('findings list every stray once, match Hub customers, and hold only open, matched work and bills', async () => {
  const api = providers();
  assert.deepEqual(jobberGuardFindings({ jobber: null, ghl: null, hub: hubData(), since: SINCE, definitions: DEFS }), [], 'sources that were not read add nothing');
  {
    const jobber = await readJobberActivity(JOBBER_ENV, { since: CUTOVER_AT, fetcher: api.fetcher, sleep: async () => {} });
    const ghl = await readGhlJobberRecords(GHL_ENV, { since: CUTOVER_AT, fetcher: api.fetcher, markers: DEFS.jobber.ghlAppMarkers });
    const all = jobberGuardFindings({ jobber, ghl, hub: hubData(), since: SINCE, definitions: DEFS });
    const row = all.map(item => [item.id, item.open, item.holds.join('+'), item.customerId, item.match, item.jobId]);
    assert.deepEqual(row, [
      ['ghl_contact_from_jobber:contact-tag', true, '', null, 'none', null],
      ['ghl_contact_from_jobber:contact-new', true, '', 'cust-echo', 'phone', null],
      ['ghl_opportunity_from_jobber:opp-1', true, '', 'cust-echo', 'crm_contact', null],
      ['jobber_imported_balance_changed:3001', true, 'billing', 'jobber_client_1001', 'imported', 'jobber_invoice_3001'],
      ['jobber_invoice_after_cutover:3101', true, 'billing', 'cust-bravo', 'jobber_client', null],
      ['jobber_invoice_after_cutover:3102', false, '', 'jobber_client_1001', 'jobber_client', null],
      ['jobber_job_after_cutover:2101', true, '', null, 'none', null],
      ['jobber_job_after_cutover:2102', true, 'messaging', 'jobber_client_1001', 'jobber_client', null],
      ['jobber_payment_after_cutover:6001', false, '', 'jobber_client_1001', 'jobber_client', null],
      ['jobber_request_after_cutover:501', true, '', null, 'none', null],
      ['jobber_request_after_cutover:503', false, '', 'jobber_client_1001', 'jobber_client', null],
      ['jobber_request_after_cutover:504', true, '', null, 'ambiguous', null],
      ['jobber_visit_after_cutover:job:2001', true, 'messaging', 'cust-bravo', 'jobber_client', null],
    ], 'the request before the cutover, the completed and pre-cutover visits, the unchanged and never-imported invoices and the older HighLevel records are not strays');
    const byId = Object.fromEntries(all.map(item => [item.id, item]));
    assert.deepEqual(byId['jobber_visit_after_cutover:job:2001'].ref, { id: 'job:2001', number: '2001', visits: 3, firstDate: '2026-10-06', lastDate: '2026-10-20' });
    assert.deepEqual(byId['jobber_invoice_after_cutover:3101'].surfaces, ['billing'], 'Jobber sends this client no invoice follow-ups, so no messaging risk');
    assert.deepEqual(byId['jobber_job_after_cutover:2101'].surfaces, ['booking'], 'Jobber sends this client no reminders');
    assert.deepEqual(byId['jobber_imported_balance_changed:3001'].ref, { id: '3001', number: '3001', status: 'paid', balanceCents: 0, importedBalanceCents: 50000 });
    assert.deepEqual(byId['jobber_request_after_cutover:501'].masked, { name: 'S*** D***', phone: '***-***-0199', email: '' });
    assert.equal(byId['ghl_contact_from_jobber:contact-new'].provider, 'ghl');
    assert.ok(all.every(item => item.action === JOBBER_GUARD_ACTIONS[item.code]));
    noPii(JSON.stringify(all).replace(/\*\*\*-\*\*\*-01\d\d/g, ''));
    const state = { findings: all };
    assert.deepEqual(jobberGuardHolds(state, 'billing', { customerId: 'cust-bravo' }).map(item => item.id), ['jobber_invoice_after_cutover:3101']);
    assert.deepEqual(jobberGuardHolds(state, 'billing', { customerId: 'jobber_client_1001', jobId: 'job-other' }).map(item => item.id), [], 'a settled imported balance holds only its own job');
    assert.deepEqual(jobberGuardHolds(state, 'billing', { customerId: 'jobber_client_1001', jobId: 'jobber_invoice_3001' }).map(item => item.id), ['jobber_imported_balance_changed:3001']);
    assert.deepEqual(jobberGuardHolds(state, 'messaging', { customerId: 'jobber_client_1001' }).map(item => item.id), ['jobber_job_after_cutover:2102']);
    assert.deepEqual(jobberGuardHolds(state, 'messaging', { customerId: 'cust-echo' }), [], 'HighLevel records never hold Hub work');
    assert.deepEqual(jobberGuardHolds(null, 'billing', { customerId: 'cust-bravo' }), []);
  }
});

test('closed Jobber work, Hub-paid balances, opted-out clients and phone or email matches hold nothing; rows without a time are still listed', async () => {
  const golf = { id: gid('Client', 1005), name: 'Synthetic Golf', phones: [], emails: [], receivesReminders: false, receivesInvoiceFollowUps: true };
  const hotel = { id: gid('Client', 1006), name: 'Synthetic Hotel', phones: [{ number: '970-555-0107' }], emails: [], receivesReminders: true, receivesInvoiceFollowUps: true };
  const india = { id: gid('Client', 1007), name: 'Synthetic India', phones: [], emails: [{ address: 'india@example.invalid' }], receivesReminders: true, receivesInvoiceFollowUps: true };
  const jobber = {
    requests: [{ id: gid('Request', 505), title: 'No time', requestStatus: 'new', client: golf }],
    jobs: [
      { id: gid('Job', 7103), jobNumber: 2103, title: 'Archived', createdAt: '2026-10-04T16:00:00Z', jobStatus: 'archived', client: CLIENTS.alpha },
      { id: gid('Job', 7104), jobNumber: 2104, title: 'Shared email', createdAt: '2026-10-04T17:00:00Z', jobStatus: 'active', client: india },
    ],
    visits: [{ id: gid('Visit', 8101), startAt: '2026-10-09T15:00:00Z', createdAt: '2026-09-01T12:00:00Z', isComplete: false, job: { jobNumber: 2004 }, client: golf }],
    invoices: [
      { id: gid('Invoice', 9004), invoiceNumber: '3004', invoiceStatus: 'awaiting_payment', createdAt: '2026-08-04T16:00:00Z', updatedAt: '2026-10-04T16:00:00Z', amounts: { total: 400, invoiceBalance: 100 }, client: golf },
      { id: gid('Invoice', 9105), invoiceNumber: '3105', invoiceStatus: 'awaiting_payment', createdAt: '2026-10-05T16:00:00Z', updatedAt: '2026-10-05T16:00:00Z', amounts: { total: 250, invoiceBalance: 250 }, client: hotel },
    ],
    payments: [],
  };
  const base = hubData(), hub = {
    customers: [...base.customers, { id: 'jobber_client_1005', name: 'Synthetic Golf' }, { id: 'cust-landlord', name: 'Synthetic Landlord', phone: '9705550107' }, { id: 'cust-india', email: 'India@example.invalid' }],
    jobs: [...base.jobs, { id: 'jobber_invoice_3004', type: 'job', customerId: 'jobber_client_1005', status: 'invoiced', pipelineStatus: 'invoiced', invoice: { status: 'paid' }, jobber: { jobberClientId: '1005', invoiceNumber: '3004', balanceCents: 40000 } }],
  };
  const activity = await readJobberActivity(JOBBER_ENV, { since: CUTOVER_AT, fetcher: providers({ jobber }).fetcher, sleep: async () => {} });
  const all = jobberGuardFindings({ jobber: activity, hub, since: SINCE, definitions: DEFS });
  assert.deepEqual(all.map(item => [item.id, item.open, item.holds.join('+'), item.surfaces.join('+'), item.customerId, item.match, item.at]), [
    ['jobber_imported_balance_changed:3004', false, '', 'billing', 'jobber_client_1005', 'imported', '2026-10-04T16:00:00.000Z'],
    ['jobber_invoice_after_cutover:3105', true, '', 'billing+messaging', 'cust-landlord', 'phone', '2026-10-05T16:00:00.000Z'],
    ['jobber_job_after_cutover:2103', false, '', 'booking+messaging', 'jobber_client_1001', 'jobber_client', '2026-10-04T16:00:00.000Z'],
    ['jobber_job_after_cutover:2104', true, '', 'booking+messaging', 'cust-india', 'email', '2026-10-04T17:00:00.000Z'],
    ['jobber_request_after_cutover:505', true, '', 'booking', 'jobber_client_1005', 'jobber_client', null],
    ['jobber_visit_after_cutover:job:2004', true, '', 'booking', 'jobber_client_1005', 'jobber_client', '2026-10-09T15:00:00.000Z'],
  ], 'a balance the Hub already recorded as paid, an archived Jobber job, visits for a client Jobber sends no reminders and a stray matched only by a shared phone or email hold nothing; a request without a creation time is still a stray');
  const byId = Object.fromEntries(all.map(item => [item.id, item]));
  assert.deepEqual(byId['jobber_imported_balance_changed:3004'].ref, { id: '3004', number: '3004', status: 'awaiting_payment', balanceCents: 10000, importedBalanceCents: 40000 });
  const forged = { findings: [{ ...byId['jobber_invoice_after_cutover:3105'], holds: ['billing', 'messaging'] }, { ...byId['jobber_job_after_cutover:2104'], holds: ['messaging'] }] };
  assert.deepEqual([jobberGuardHolds(forged, 'billing', { customerId: 'cust-landlord' }), jobberGuardHolds(forged, 'messaging', { customerId: 'cust-india' })], [[], []], 'a saved phone or email match never holds, even if a check recorded one');
});

test('a check reports complete coverage, or names each source it could not read instead of reporting no strays', async () => {
  const complete = check(), report = await complete.run();
  assert.deepEqual([report.coverage, report.cutoverDate, report.since, report.checkedAt, report.truncated], [{ complete: true, sources: { hub: 'complete', jobber: 'complete', ghl: 'complete' }, reasons: [] }, CUTOVER, CUTOVER_AT, NOW, false]);
  assert.deepEqual(report.counts, { findings: 13, open: 10, holding: 4, unmatched: 4, holdingCustomers: 2, byCode: { ghl_contact_from_jobber: 2, ghl_opportunity_from_jobber: 1, jobber_imported_balance_changed: 1, jobber_invoice_after_cutover: 2, jobber_job_after_cutover: 2, jobber_payment_after_cutover: 1, jobber_request_after_cutover: 3, jobber_visit_after_cutover: 1 } });
  assert.equal(report.definitionsVersion, DEFS.definitionsVersion);
  noPii(JSON.stringify(report).replace(/\*\*\*-\*\*\*-01\d\d/g, ''));
  const ghlDown = await check({ ghlStatus: 503 }).run();
  assert.deepEqual([ghlDown.coverage.complete, ghlDown.coverage.sources.ghl, ghlDown.coverage.reasons, ghlDown.counts.findings], [false, 'ghl_unavailable', ['ghl_ghl_unavailable'], 10], 'Jobber strays are still listed');
  const skipped = await check().run({ ghl: false });
  assert.deepEqual([skipped.coverage.complete, skipped.coverage.sources.ghl, skipped.counts.findings], [false, 'skipped', 10]);
  const jobberDown = await check({ jobberFails: 'EgcGuardJobs' }).run();
  assert.deepEqual([jobberDown.coverage.sources.jobber, jobberDown.counts.findings], ['graphql_failed', 3]);
  await assert.rejects(check().run({ since: { date: null, at: null } }), error => error.code === 'jobber_guard_cutover_unset' && error.status === 409);
  await assert.rejects(check().run({ now: 'yesterday' }), error => error.code === 'jobber_guard_clock_invalid');
});

test('only a complete check governed by the definitions cutover is saved, atomically with its run summary', async () => {
  const store = hubStore(), report = await check().run();
  const saved = await saveJobberGuardState(store, report, { definitions: DEFS });
  assert.deepEqual(saved, { saved: true, runId: report.runId, findings: 13 });
  assert.equal(store.commits.length, 1);
  assert.deepEqual(store.commits[0].map(write => [write.collection, write.id, write.revision ?? null]), [['jobberGuard', 'latest', null], ['jobberGuardRuns', report.runId, null]]);
  assert.equal(store.commits[0][1].patch.findings, undefined, 'the run summary keeps counts, not findings');
  assert.ok(store.commits[0][0].patch.findings.every(item => item.action === undefined), 'next steps are derived from the code, not stored');
  const state = await readJobberGuardState(store);
  assert.deepEqual([state.checkedAt, state.findings.length, state.savedBy, state.coverage.complete], [NOW, 13, 'jobber-guard-check', true]);
  const later = await check().run({ now: '2026-10-08T18:00:00.000Z', runId: '6f1c1f63-4a57-4f55-9a3e-0a53a6d3f0f1', ghl: false });
  await saveJobberGuardState(store, later, { definitions: DEFS });
  assert.equal(store.commits[1][0].revision, 'r1', 'the next save is revision-checked');
  assert.deepEqual([(await readJobberGuardState(store)).coverage.sources.ghl, (await readJobberGuardState(store)).findings.length], ['skipped', 10], 'a deliberately skipped source may be saved and says so');
  const refusals = [
    [{ ...(await check({ ghlStatus: 503 }).run()), runId: 'e1f1b0c2-8d1a-4d3c-9a51-1c2f7c0b9e11' }, 'jobber_guard_coverage_incomplete'],
    [{ ...(await check({ jobberFails: 'EgcGuardVisits' }).run({ ghl: false })), runId: 'e1f1b0c2-8d1a-4d3c-9a51-1c2f7c0b9e12' }, 'jobber_guard_coverage_incomplete'],
    [{ ...report, runId: 'e1f1b0c2-8d1a-4d3c-9a51-1c2f7c0b9e13', checkedAt: '2026-10-09T18:00:00.000Z', truncated: true }, 'jobber_guard_too_many_findings'],
    [{ ...report, runId: 'e1f1b0c2-8d1a-4d3c-9a51-1c2f7c0b9e14', checkedAt: '2026-10-09T18:00:00.000Z', cutoverDate: '2026-11-01' }, 'jobber_guard_preview_not_saved'],
    [{ ...report, runId: 'e1f1b0c2-8d1a-4d3c-9a51-1c2f7c0b9e15', checkedAt: '2026-10-07T00:00:00.000Z' }, 'jobber_guard_state_newer'],
    [{ ...report, runId: '../latest' }, 'jobber_guard_report_invalid'],
  ];
  for (const [bad, code] of refusals) await assert.rejects(saveJobberGuardState(store, bad, { definitions: DEFS }), error => error.code === code, code);
  assert.equal(store.commits.length, 2, 'a refused save writes nothing; the last saved check stays in force');
  assert.equal(JOBBER_GUARD_FINDING_LIMIT, 1000);
  const broken = hubStore(hubData(), { 'jobberGuard/latest': { schemaVersion: 1, findings: 'none', checkedAt: NOW } });
  await assert.rejects(readJobberGuardState(broken), error => error.code === 'jobber_guard_state_unreadable');
  assert.equal(await readJobberGuardState(hubStore()), null);
});

test('guard checks are server-only in firestore.rules', () => {
  const rules = readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8');
  for (const collection of ['jobberGuard', 'jobberGuardRuns']) assert.match(rules, new RegExp(`match /${collection}/\\{documentId\\} \\{\\s*allow read, write: if false;\\s*\\}`));
});

const URL_BASE = 'https://easygaragecleaning.com/api/jobber-guard';
const owner = { user: 'zacb', role: 'owner', businessAccess: true };
async function api({ actor = owner, env = ON, headers = { 'Sec-Fetch-Site': 'same-origin' }, url = URL_BASE, rows = {}, at = NOW, store, definitions = DEFS } = {}) {
  const handler = jobberGuardHandlers({ session: async () => actor, storage: () => store || hubStore(hubData(), rows), now: () => new Date(at), definitions: () => definitions });
  const response = await handler.get({ request: new Request(url, { headers }), env });
  return { status: response.status, cache: response.headers.get('Cache-Control'), body: await response.json() };
}

test('GET /api/jobber-guard shows owners and managers the cutover, each switch and the last saved check', async () => {
  const store = hubStore(), report = await check().run();
  await saveJobberGuardState(store, report, { definitions: DEFS });
  const shown = await api({ store, env: { EGC_JOBBER_GUARD_BILLING: 'true' } });
  assert.deepEqual([shown.status, shown.cache, shown.body.cutoverDate, shown.body.cutoverReached], [200, 'no-store', CUTOVER, true]);
  assert.deepEqual(shown.body.surfaces, { booking: { enabled: false, blocking: false }, billing: { enabled: true, blocking: true }, messaging: { enabled: false, blocking: false } });
  assert.deepEqual([shown.body.check.runId, shown.body.check.stale, shown.body.check.inForce, shown.body.check.findings.length, shown.body.check.counts.holding], [report.runId, false, true, 13, 4]);
  assert.ok(shown.body.check.findings.every(item => item.action === JOBBER_GUARD_ACTIONS[item.code]));
  noPii(JSON.stringify(shown.body).replace(/\*\*\*-\*\*\*-01\d\d/g, ''));
  assert.deepEqual([(await api({ store, at: '2026-10-20T18:00:00.000Z' })).body.check.stale, (await api({ store, at: '2026-10-20T18:00:00.000Z' })).body.check.inForce], [true, true], 'a check older than a week is flagged and still holds');
  const moved = (await api({ store, definitions: definitionsWith('2026-10-02') })).body.check;
  assert.deepEqual([moved.cutoverDate, moved.stale, moved.inForce], [CUTOVER, true, false], 'a check for a cutover day that has since moved no longer holds');
  assert.equal((await api({ store, at: '2026-09-30T18:00:00.000Z' })).body.surfaces.billing.blocking, false, 'nothing blocks before the cutover day');
  const empty = await api();
  assert.deepEqual([empty.status, empty.body.check], [200, null]);
  for (const [options, status, code] of [
    [{ actor: null }, 401, 'jobber_guard_sign_in_required'], [{ actor: { user: 'crew1', role: 'crew', businessAccess: false } }, 403, 'jobber_guard_forbidden'],
    [{ headers: { 'Sec-Fetch-Site': 'cross-site' } }, 403, 'jobber_guard_origin_forbidden'], [{ headers: { Origin: 'https://evil.example' } }, 403, 'jobber_guard_origin_forbidden'],
    [{ url: `${URL_BASE}?all=1` }, 400, 'jobber_guard_query_invalid'],
    [{ rows: { 'jobberGuard/latest': { schemaVersion: 2, findings: [], checkedAt: NOW } } }, 503, 'jobber_guard_unavailable'],
  ]) { const result = await api(options); assert.deepEqual([result.status, result.body.ok, result.body.code], [status, false, code], code); }
});

test('the guard CLI is read-only by default, previews without saving, and saves only a complete check', async () => {
  assert.deepEqual(parseArgs([]), { since: '', ghl: true, report: '', save: false, help: false });
  assert.deepEqual(parseArgs(['--since', '2026-11-02', '--without-ghl', '--report', 'out.json']), { since: '2026-11-02', ghl: false, report: 'out.json', save: false, help: false });
  for (const [argv, pattern] of [[['--since', '2026-02-30'], /YYYY-MM-DD/], [['--since', '2026-11-02', '--save'], /cannot be combined/], [['--apply'], /Unknown option/], [['--report'], /needs a value/]]) assert.throws(() => parseArgs(argv), pattern);
  const env = { ...JOBBER_ENV, ...GHL_ENV, FIREBASE_API_KEY: 'firebase-test-jobber-guard' };
  async function cli(argv, { definitions = DEFS, store = hubStore(), options = {}, environment = env } = {}) {
    const out = [], err = [], reports = [], api = providers(options);
    const code = await runCli(argv, { env: environment, storage: () => store, now: () => new Date(NOW), fetcher: api.fetcher, sleep: async () => {}, runId: () => '1b4e28ba-2fa1-4d3b-a3f5-ef19b5a7633b', definitions, writeReport: async (path, text) => { reports.push({ path, text }); }, stdout: text => out.push(text), stderr: text => err.push(text) });
    return { code, out: out.join(''), err: err.join(''), reports, store };
  }
  assert.equal((await cli([], { environment: JOBBER_ENV })).code, 2, 'the Hub service account is required');
  const unset = await cli([], { definitions: definitionsWith(null) });
  assert.deepEqual([unset.code, /No Jobber cutover day is set/.test(unset.err)], [2, true]);
  const dry = await cli(['--report', 'guard.json']);
  assert.deepEqual([dry.code, dry.store.commits.length, JSON.parse(dry.out).counts.findings, dry.reports.map(report => report.path)], [0, 0, 13, ['guard.json']]);
  assert.match(dry.err, /13 strays \(10 open, 4 can hold Hub actions for 2 customers, 4 not matched to a Hub customer\).*Nothing was written\./);
  const preview = await cli(['--since', '2026-10-05'], { definitions: definitionsWith(null) });
  assert.deepEqual([preview.code, JSON.parse(preview.out).cutoverDate, preview.store.commits.length], [0, '2026-10-05', 0]);
  const saved = await cli(['--save']);
  assert.deepEqual([saved.code, saved.store.commits.length, /Saved as jobberGuard\/latest/.test(saved.err)], [0, 1, true]);
  const partial = await cli(['--save'], { options: { ghlStatus: 503 } });
  assert.deepEqual([partial.code, partial.store.commits.length, /not saved/.test(partial.err)], [1, 0, true]);
  const unread = await cli([], { options: { ghlStatus: 503 } });
  assert.deepEqual([unread.code, /JOBBER GUARD CHECK \(INCOMPLETE\).*ghl ghl_unavailable/.test(unread.err)], [1, true], 'a source that could not be read fails the run');
  const skipped = await cli(['--save', '--without-ghl']);
  assert.deepEqual([skipped.code, skipped.store.commits.length], [0, 1]);
  const rotated = await cli(['--save'], { options: { grant: { access_token: 'synthetic-access-token', refresh_token: 'synthetic-rotated-refresh-token' } } });
  assert.deepEqual([rotated.code, rotated.store.commits.length, /jobber graphql_rotation_on/.test(rotated.err), /synthetic/.test(rotated.out + rotated.err)], [1, 0, true, false], 'rotation on fails the check without printing a token');
  noPii((dry.out + dry.err + saved.err).replace(/\*\*\*-\*\*\*-01\d\d/g, ''));
});
