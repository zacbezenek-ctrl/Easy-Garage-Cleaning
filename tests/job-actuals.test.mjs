// Job actuals (owner): the arithmetic in integer cents with half-up rounding, the actual-hours signal (timecards first,
// then the crew lead's people × hours at Complete), the commission channels, the 30/90-day totals, the owner's cost
// settings store and /api/job-actuals.
process.env.TZ = 'Asia/Tokyo';
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildJobActuals, channelOf, commissionFor, divRoundHalfUp, jobActualsRow, jobActualsWindow, laborCostCents, milliHours, percentOf, summarizeJobActuals, truckLoads } from '../functions/_lib/job-actuals.js';
import { mutateJobActualsSettings, readJobActualsSettings, JOB_ACTUALS_SETTINGS, JOB_ACTUALS_SETTINGS_OPERATIONS } from '../functions/_lib/job-actuals-settings.js';
import { jobActualsHandlers, JOB_ACTUALS_FIELDS } from '../functions/api/job-actuals.js';
import { fieldChecklist, fieldCommand } from '../functions/_lib/field-execution.js';

const OWNER = { user: 'ZacB', role: 'owner', businessAccess: true, owner: true };
const MANAGER = { user: 'AlexK', role: 'manager', businessAccess: true, owner: false };
const CREW = { user: 'Synthetic.Crew', role: 'crew', businessAccess: false };
// Synthetic pay rates only (never a real wage): $10.00 per man-hour and 1% workers' comp, loaded $10.10.
const PAY = { wageCentsPerManHour: 1000, workersCompBp: 100 };
const ALL_SET = { ...PAY, payrollTaxBp: 765, burdenCentsPerManHour: 150, dumpFeeCentsPerLoad: 6500, truckCentsPerJob: 4000, goodsTaxBp: 755 };
const line = (id, kind, quantity, unitCents, extra = {}) => ({ id, kind, name: id, quantity, unitCents, totalCents: quantity * unitCents, optional: false, selected: true, taxable: false, ...extra });
// A two-car garage job sold with 8 man-hours of Labor at $53.00, two full junk loads and a partial, and $300 of shelving at retail.
const LINES = [line('removal-base', 'service', 1, 150000), line('removal-junk-full', 'service', 2, 75000), line('removal-junk-partial', 'service', 1, 40000),
  line('shelving-goods', 'product', 1, 39000, { split: { productCents: 30000, markupCents: 9000, laborCents: 0, laborMinutes: 0, disposalCents: 0 } }), line('labor', 'labor', 1, 42400)];
const garageJob = (extra = {}) => ({ id: 'job-two-car', type: 'job', date: '2026-10-10', customer: 'Synthetic Two-Car Garage', status: 'completed', completedAt: '2026-10-10T22:00:00.000Z',
  estimate: { status: 'accepted', amount: 4214, lineItems: LINES }, jobInstructions: { laborManHours: 8 }, sourceWalkthroughId: 'walk-1', serviceType: 'Garage transformation', ...extra });

test('division rounds half up in exact integers, negatives toward +infinity at the half', () => {
  assert.deepEqual([divRoundHalfUp(5, 10), divRoundHalfUp(4, 10), divRoundHalfUp(15, 10), divRoundHalfUp(25, 10)], [1, 0, 2, 3]);
  assert.deepEqual([divRoundHalfUp(-5, 10), divRoundHalfUp(-6, 10), divRoundHalfUp(-15, 10)], [0, -1, -1]);
  assert.equal(divRoundHalfUp(9007199254740993n * 3n, 3n), 9007199254740993, 'BigInt keeps products past 2^53 exact');
  assert.throws(() => divRoundHalfUp(1, 0), RangeError);
  assert.equal(percentOf(123450, 1300), 16049, '13% of $1,234.50 is $160.485, half up to $160.49');
  assert.equal(percentOf(123450, 700), 8642, '7% of $1,234.50 is $86.415, half up to $86.42');
  assert.equal(percentOf(1, 5000), 1, 'half a cent rounds up');
  assert.deepEqual([milliHours(18), milliHours(8.25), milliHours(1 / 3), milliHours(0.0005), milliHours(-1), milliHours(NaN)], [18000, 8250, 333, 1, null, null]);
});

test('labor is the owner wage × (1 + workers comp + payroll tax) + burden, and nothing while the wage is blank', () => {
  assert.equal(laborCostCents(1000, PAY), 1010);
  assert.equal(laborCostCents(18000, PAY), 18180, '18 people-hours at a synthetic $10.10 loaded');
  assert.equal(laborCostCents(500, { wageCentsPerManHour: 1001 }), 501, 'half an hour at $10.01 is $5.005, half up to $5.01');
  assert.equal(laborCostCents(1000, {}), null, 'no wage, no labor cost: never a guessed wage');
  assert.equal(laborCostCents(1000, { workersCompBp: 100 }), null);
  // 8.25 h × ($10.00 × (1 + 1% + 7.65%) + $1.50) = 8.25 × $12.3650 = $102.01125 → $102.01
  assert.equal(laborCostCents(8250, { ...PAY, payrollTaxBp: 765, burdenCentsPerManHour: 150 }), 10201);
  assert.equal(laborCostCents(0, ALL_SET), 0);
});

test('commission by channel on revenue: estimator 7%, setter 13% + estimator 7%, door sale 25%, junk-only and none 0%', () => {
  assert.deepEqual(commissionFor(421400, 'direct_estimator'), { channel: 'direct_estimator', lines: [{ role: 'estimator', bp: 700, cents: 29498 }], totalCents: 29498 });
  assert.deepEqual(commissionFor(123450, 'appointment_setter').lines.map(item => item.cents), [16049, 8642]);
  assert.equal(commissionFor(123450, 'appointment_setter').totalCents, 24691, 'each share rounds on its own');
  assert.equal(commissionFor(100001, 'door_sale').totalCents, 25000, '25% of $1,000.01 is $250.0025 → $250.00');
  assert.equal(commissionFor(150000, 'junk_only').totalCents, 0);
  assert.equal(commissionFor(150000, 'none').totalCents, 0);
  assert.equal(commissionFor(0, 'door_sale').totalCents, 0);
});

test('the channel: junk-only first, then a setter walkthrough, a linked door sale, any signed walkthrough, else none', () => {
  const sets = { setterWalkthroughs: new Set(['walk-1']), doorSaleJobs: new Set(['job-two-car', 'job-door']) };
  assert.equal(channelOf(garageJob(), sets), 'appointment_setter');
  assert.equal(channelOf(garageJob({ serviceType: 'Junk removal' }), sets), 'junk_only');
  assert.equal(channelOf(garageJob({ sourceWalkthroughId: 'walk-2' }), sets), 'door_sale');
  assert.equal(channelOf(garageJob({ id: 'job-x', sourceWalkthroughId: 'walk-2' }), sets), 'direct_estimator');
  assert.equal(channelOf(garageJob({ id: 'job-x', sourceWalkthroughId: undefined }), sets), 'none');
});

test('a completed two-car job: billed 8 versus 18 timecard man-hours, quoted loads, goods at retail, and an upper-bound margin', () => {
  const row = jobActualsRow(garageJob(), { labor: { workHours: 18, travelHours: 1 }, settings: PAY, channel: 'direct_estimator' });
  assert.equal(row.revenueCents, 421400);
  assert.deepEqual(row.billed, { manHours: 8, source: 'labor_line' });
  assert.deepEqual(row.actual, { manHours: 18, paidManHours: 19, source: 'timecards' });
  assert.equal(row.varianceManHours, 10); assert.equal(row.variancePercent, 125);
  assert.deepEqual(row.truckLoads, { count: 3, source: 'quote' });
  assert.equal(row.goodsRetailCents, 30000, 'retail is the product split, not the 1.30 sell price');
  assert.equal(row.laborCents, 19190, '19 paid hours (work + travel) × $10.10');
  assert.equal(row.commission.totalCents, 29498);
  assert.equal(row.directCostCents, 19190 + 30000);
  assert.equal(row.grossMarginCents, 421400 - 49190); assert.equal(row.grossMarginPercent, 88.3, '372210 / 421400 = 88.33%');
  assert.equal(row.contributionCents, 421400 - 49190 - 29498);
  assert.equal(row.upperBound, true); assert.deepEqual(row.reasons, ['cost_settings_incomplete']);
});

test('with every cost setting entered the margin is no longer an upper bound and every cost is applied', () => {
  const row = jobActualsRow(garageJob(), { labor: { workHours: 18, travelHours: 1 }, settings: ALL_SET, channel: 'direct_estimator' });
  // 19 h × ($10.00 × 1.0865 + $1.50) = 19 × $12.365 = $234.935 → $234.94
  assert.equal(row.laborCents, 23494);
  assert.equal(row.goodsCostCents, 30000 + 2265, '7.55% tax on $300.00 retail');
  assert.equal(row.dumpCents, 3 * 6500); assert.equal(row.truckCents, 4000);
  assert.equal(row.directCostCents, 23494 + 32265 + 19500 + 4000);
  assert.equal(row.grossMarginCents, 421400 - 79259);
  assert.equal(row.grossMarginPercent, 81.2, '342141 / 421400 = 81.19% → 81.2');
  assert.equal(row.upperBound, false); assert.deepEqual(row.reasons, []);
});

test('the crew lead count stands in when no timecard hours were tagged to the job, and timecards win when both exist', () => {
  const completion = { crewOnSite: { people: 3, hours: 5.5 }, truckLoads: 2 };
  const lead = jobActualsRow(garageJob({ fieldExecution: { completion } }), { settings: PAY, channel: 'none' });
  assert.deepEqual(lead.actual, { manHours: 16.5, paidManHours: 16.5, source: 'crew_lead' });
  assert.deepEqual(lead.crewLead, { people: 3, hours: 5.5, manHours: 16.5 });
  assert.deepEqual(lead.truckLoads, { count: 2, source: 'crew_lead' });
  assert.equal(lead.laborCents, divRoundHalfUp(16500 * 1010, 1000));
  assert.equal(jobActualsRow(garageJob({ fieldExecution: { completion } }), { labor: { workHours: 12, travelHours: 0 } }).actual.source, 'timecards');
  const none = jobActualsRow(garageJob(), { labor: { workHours: 0, travelHours: 0 }, settings: PAY });
  assert.deepEqual(none.actual, { manHours: null, paidManHours: null, source: 'not_recorded' });
  assert.equal(none.grossMarginCents, null, 'no actual hours: no margin, never a guess'); assert.equal(none.contributionCents, null);
  assert.ok(none.reasons.includes('actual_hours_missing'));
  for (const bad of [{ people: 0, hours: 2 }, { people: 2, hours: 2.1 }, { people: 2.5, hours: 2 }, { people: 2, hours: 30 }, { people: 2, hours: 2, extra: 1 }])
    assert.equal(jobActualsRow(garageJob({ fieldExecution: { completion: { crewOnSite: bad } } })).actual.source, 'not_recorded', JSON.stringify(bad));
});

test('a junk-only job has no billed labor and earns no commission; an unknown revenue holds the margin', () => {
  const junk = jobActualsRow(garageJob({ serviceType: 'Junk removal', jobInstructions: {} }), { labor: { workHours: 4, travelHours: 0 }, channel: 'junk_only' });
  assert.deepEqual(junk.billed, { manHours: null, source: 'junk_only' }); assert.equal(junk.varianceManHours, null);
  assert.equal(junk.commission.totalCents, 0);
  const unknown = jobActualsRow(garageJob({ estimate: { lineItems: LINES } }), { labor: { workHours: 4, travelHours: 0 } });
  assert.equal(unknown.revenueCents, null); assert.equal(unknown.grossMarginCents, null); assert.ok(unknown.reasons.includes('revenue_unknown'));
  assert.deepEqual(truckLoads({ estimate: { lineItems: [{ ...LINES[1], optional: true, selected: false }] } }), { count: 0, source: 'none' }, 'an unselected load is not hauled');
});

test('the report lists completed work jobs in the last 90 days, newest first, with 30- and 90-day totals', () => {
  const today = '2026-10-21', window = jobActualsWindow(today);
  assert.deepEqual(window, { start: '2026-07-24', end: '2026-10-22', shortStart: '2026-09-22', today });
  const jobs = [garageJob(), garageJob({ id: 'old', date: '2026-08-01' }), garageJob({ id: 'too-old', date: '2026-07-23' }), garageJob({ id: 'open', status: 'scheduled', completedAt: undefined }),
    garageJob({ id: 'walk', type: 'walkthrough' }), garageJob({ id: 'test-job', isTest: true }), garageJob({ id: 'cancelled', status: 'cancelled', completedAt: undefined })];
  const labor = { jobs: [{ jobId: 'job-two-car', projected: { workHours: 18, travelHours: 1 } }, { jobId: 'old', projected: { workHours: 6, travelHours: 0 } }] };
  const report = buildJobActuals({ jobs, labor, settings: PAY, today, asOf: '2026-10-21T18:00:00.000Z' });
  assert.deepEqual(report.rows.map(row => row.jobId), ['job-two-car', 'old']);
  assert.equal(report.settingsComplete, false); assert.equal(report.missingSettings.length, 5);
  assert.ok(report.rows.every(row => row.grossMarginCents !== null));
  assert.equal(report.totals.last30.jobs, 1); assert.equal(report.totals.last90.jobs, 2);
  assert.equal(report.totals.last90.revenueCents, 842800);
  assert.equal(report.totals.last90.billedManHours, 16); assert.equal(report.totals.last90.actualManHours, 24); assert.equal(report.totals.last90.variancePercent, 50);
  assert.equal(report.totals.last90.grossMarginCents, report.rows[0].grossMarginCents + report.rows[1].grossMarginCents);
  assert.equal(report.totals.last90.upperBound, true);
  assert.equal(report.totals.last90.commissionCents, 2 * 29498, 'both are signed walkthroughs without a setter: the estimator 7%');
  const empty = summarizeJobActuals([]);
  assert.equal(empty.variancePercent, null); assert.equal(empty.grossMarginPercent, null); assert.equal(empty.revenueCents, 0);
});

function memoryStore() {
  const docs = new Map(); let tick = 0;
  return { docs, async read(collection, id) { const row = docs.get(`${collection}/${id}`); return row ? structuredClone(row) : null; },
    async commit(writes) {
      for (const write of writes) { const current = docs.get(`${write.collection}/${write.id}`); if (write.revision ? current?.revision !== write.revision : current) throw Object.assign(new Error('conflict'), { code: 'job_actuals_revision_conflict', status: 409 }); }
      for (const write of writes) { const current = docs.get(`${write.collection}/${write.id}`) || {}; docs.set(`${write.collection}/${write.id}`, { ...current, ...structuredClone(write.patch), id: write.id, revision: `rev-${++tick}` }); }
    } };
}
const settingsBody = (settings, extra = {}) => ({ action: 'job_actuals.settings.set', requestId: crypto.randomUUID(), expectedRevision: null, settings: { wageCentsPerManHour: null, workersCompBp: null, payrollTaxBp: null, burdenCentsPerManHour: null, dumpFeeCentsPerLoad: null, truckCentsPerJob: null, goodsTaxBp: null, ...settings }, ...extra });

test('only the owner saves cost settings; blanks stay null, a replay is idempotent and a stale revision is refused', async () => {
  const store = memoryStore();
  assert.deepEqual(await readJobActualsSettings(store), { revision: null, updatedAt: null, updatedBy: null, wageCentsPerManHour: null, workersCompBp: null, payrollTaxBp: null, burdenCentsPerManHour: null, dumpFeeCentsPerLoad: null, truckCentsPerJob: null, goodsTaxBp: null, complete: false, missing: ['wageCentsPerManHour', 'workersCompBp', 'payrollTaxBp', 'burdenCentsPerManHour', 'dumpFeeCentsPerLoad', 'truckCentsPerJob', 'goodsTaxBp'] });
  await assert.rejects(mutateJobActualsSettings(store, MANAGER, settingsBody({ payrollTaxBp: 765 })), { code: 'job_actuals_owner_required', status: 403 });
  await assert.rejects(mutateJobActualsSettings(store, CREW, settingsBody({ payrollTaxBp: 765 })), { code: 'job_actuals_forbidden', status: 403 });
  await assert.rejects(mutateJobActualsSettings(store, OWNER, settingsBody({ payrollTaxBp: 7.65 })), { code: 'job_actuals_amount_invalid' });
  await assert.rejects(mutateJobActualsSettings(store, OWNER, settingsBody({ dumpFeeCentsPerLoad: -1 })), { code: 'job_actuals_amount_invalid' });
  await assert.rejects(mutateJobActualsSettings(store, OWNER, settingsBody({ wageCentsPerManHour: 20001 })), { code: 'job_actuals_amount_invalid' });
  await assert.rejects(mutateJobActualsSettings(store, OWNER, { ...settingsBody({}), settings: { payrollTaxBp: 1 } }), { code: 'job_actuals_request_invalid' });
  const body = settingsBody({ ...PAY, payrollTaxBp: 765, dumpFeeCentsPerLoad: 0 });
  const saved = await mutateJobActualsSettings(store, OWNER, body, '2026-10-21T18:00:00.000Z');
  assert.equal(saved.replayed, false);
  assert.equal(saved.settings.payrollTaxBp, 765); assert.equal(saved.settings.dumpFeeCentsPerLoad, 0, 'an entered $0 is kept, unlike a blank');
  assert.deepEqual(saved.settings.missing, ['burdenCentsPerManHour', 'truckCentsPerJob', 'goodsTaxBp']);
  assert.ok([...store.docs.keys()].some(key => key.startsWith(`${JOB_ACTUALS_SETTINGS_OPERATIONS}/`)));
  assert.ok([...store.docs.keys()].some(key => key.startsWith('hub_audit/')), 'the audit entry commits with the save');
  assert.equal((await mutateJobActualsSettings(store, OWNER, body)).replayed, true);
  await assert.rejects(mutateJobActualsSettings(store, OWNER, { ...body, settings: { ...body.settings, payrollTaxBp: 800 } }), { code: 'job_actuals_idempotency_conflict', status: 409 });
  await assert.rejects(mutateJobActualsSettings(store, OWNER, settingsBody({ payrollTaxBp: 800 })), { code: 'job_actuals_revision_conflict', status: 409 });
  const revision = store.docs.get(`${JOB_ACTUALS_SETTINGS}/current`).revision;
  await assert.rejects(mutateJobActualsSettings(store, OWNER, settingsBody({ ...PAY, payrollTaxBp: 765, dumpFeeCentsPerLoad: 0 }, { expectedRevision: revision })), { code: 'job_actuals_no_change' });
  store.docs.set(`${JOB_ACTUALS_SETTINGS}/current`, { ...store.docs.get(`${JOB_ACTUALS_SETTINGS}/current`), payrollTaxBp: 'lots' });
  await assert.rejects(readJobActualsSettings(store), { code: 'job_actuals_settings_invalid', status: 503 }, 'a damaged record fails closed');
});

function payStore() { const store = memoryStore(); store.docs.set(`${JOB_ACTUALS_SETTINGS}/current`, { schemaVersion: 1, ...PAY, id: 'current', revision: 'rev-pay' }); return store; }
function api({ actor = OWNER, jobs = [garageJob()], timecards = async () => [], setters = new Map(), sales = [], store = payStore() } = {}) {
  const calls = [];
  const handlers = jobActualsHandlers({
    session: async () => actor, now: () => new Date('2026-10-21T18:00:00.000Z'), timecards, settingsStore: () => store,
    dispatch: () => ({ datedJobs: async (start, end, fields) => { calls.push({ start, end, fields }); return jobs; } }),
    knock: () => ({ getMany: async (collection, ids) => { calls.push({ collection, ids }); return setters; }, query: async (collection, options) => { calls.push({ collection, options }); return sales; } }),
  });
  return { handlers, calls, store };
}
const get = (handlers, path = '/api/job-actuals') => handlers.get({ request: new Request(`https://easygaragecleaning.com${path}`), env: {} });
const post = (handlers, body, headers = {}) => handlers.post({ request: new Request('https://easygaragecleaning.com/api/job-actuals', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://easygaragecleaning.com', ...headers }, body: JSON.stringify(body) }), env: {} });

test('GET /api/job-actuals: business accounts only, a 90-day masked read, timecard hours and the commission channel', async () => {
  for (const [actor, status, code] of [[null, 401, 'job_actuals_sign_in_required'], [CREW, 403, 'job_actuals_forbidden']]) {
    const response = await get(api({ actor }).handlers);
    assert.equal(response.status, status); assert.equal((await response.json()).code, code);
  }
  assert.equal((await get(api().handlers, '/api/job-actuals?start=2026-01-01')).status, 400);
  const at = (time) => `2026-10-10T${time}:00-06:00`;
  const card = { id: 'card-1', employee: 'Crew.One', employeeName: 'Crew One', payType: 'hourly', hourlyRate: 31, clockInAt: at('07:00'), clockOutAt: at('16:00'), status: 'submitted', approvalStatus: 'approved', breaks: [],
    jobTracking: { version: 1, coverageStartedAt: at('07:00'), partialHistory: false, segments: [{ id: 's0', kind: 'travel', jobId: 'job-two-car', startedAt: at('07:00'), endedAt: at('08:00'), actorId: 'Crew.One' }, { id: 's1', kind: 'work', jobId: 'job-two-car', startedAt: at('08:00'), endedAt: at('16:00'), actorId: 'Crew.One' }] } };
  const { handlers, calls } = api({ actor: MANAGER, timecards: async () => [card], setters: new Map([['walk-1', { walkthroughId: 'walk-1' }]]) });
  const response = await get(handlers), body = await response.json();
  assert.equal(response.status, 200); assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
  assert.deepEqual(calls[0], { start: '2026-07-24', end: '2026-10-21', fields: [...JOB_ACTUALS_FIELDS] });
  assert.ok(JOB_ACTUALS_FIELDS.includes('jobInstructions.laborManHours') && JOB_ACTUALS_FIELDS.includes('fieldExecution.completion.crewOnSite') && JOB_ACTUALS_FIELDS.includes('date'));
  assert.deepEqual(calls[1], { collection: 'knock_setters', ids: ['walk-1'] });
  const [row] = body.rows;
  assert.deepEqual(row.actual, { manHours: 8, paidManHours: 9, source: 'timecards' });
  assert.equal(row.laborCents, 9 * 1010, 'the owner-entered wage, never the employee\'s own $31 rate');
  assert.equal(row.commission.channel, 'appointment_setter');
  assert.equal(body.canEdit, false); assert.equal(body.settings.revision, 'rev-pay'); assert.deepEqual(body.sources, { timecards: 'ok' });
  assert.doesNotMatch(JSON.stringify(body), /hourlyRate|"31"|Crew One/, 'no employee pay or names reach the report');
});

test('GET keeps the crew-lead hours when timecards cannot be read, and says so', async () => {
  const jobs = [garageJob({ fieldExecution: { completion: { crewOnSite: { people: 2, hours: 4 } } } })];
  const body = await (await get(api({ jobs, timecards: async () => { throw new Error('vault down'); } }).handlers)).json();
  assert.deepEqual(body.sources, { timecards: 'unavailable' });
  assert.equal(body.rows[0].actual.source, 'crew_lead'); assert.equal(body.canEdit, true);
});

test('POST saves the owner cost settings from the Hub only', async () => {
  const { handlers, store } = api({ store: memoryStore() });
  assert.equal((await post(handlers, settingsBody({ truckCentsPerJob: 4000 }), { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await handlers.post({ request: new Request('https://easygaragecleaning.com/api/job-actuals', { method: 'POST', headers: { Origin: 'https://easygaragecleaning.com' }, body: 'x' }), env: {} })).status, 415);
  const saved = await post(handlers, settingsBody({ truckCentsPerJob: 4000 }));
  assert.equal(saved.status, 200);
  const body = await saved.json();
  assert.equal(body.settings.truckCentsPerJob, 4000); assert.equal(body.replayed, false); assert.equal(body.canEdit, true);
  assert.equal((await post(api({ actor: MANAGER, store }).handlers, settingsBody({ truckCentsPerJob: 5000 }))).status, 403);
  const report = await (await get(api({ store }).handlers)).json();
  assert.equal(report.settings.truckCentsPerJob, 4000); assert.equal(report.rows[0].truckCents, 4000);
});

test('Complete records the crew lead\'s optional people × hours on site and truck loads, and refuses invalid ones', () => {
  const actor = { user: 'Crew.One', displayName: 'Crew One', manager: false };
  const job = { id: 'job-1', type: 'job', customer: 'Test', date: '2026-09-22', time: '08:00', assignedCrew: ['Crew.One'], crewLead: 'Crew.One', status: 'in_progress', pipelineStatus: 'in_progress', startedAt: '2026-09-22T14:00:00.000Z' };
  job.fieldExecution = { checks: Object.fromEntries(fieldChecklist(job).map(item => [item.id, { completed: true, actorId: actor.user }])), photos: ['before', 'after'].map(category => ({ id: crypto.randomUUID(), fileId: `file-${category}`, category, verified: true })) };
  const complete = extra => fieldCommand(job, actor, { action: 'complete', requestId: crypto.randomUUID(), notes: 'The agreed garage services and walkthrough are complete.', hasIssues: false, ...extra });
  const { patch } = complete({ crewOnSite: { people: 3, hours: 5.5 }, truckLoads: 2 });
  assert.deepEqual(patch.fieldExecution.completion.crewOnSite, { people: 3, hours: 5.5 });
  assert.equal(patch.fieldExecution.completion.truckLoads, 2);
  const plain = complete({}).patch.fieldExecution.completion;
  assert.equal(Object.hasOwn(plain, 'crewOnSite'), false); assert.equal(Object.hasOwn(plain, 'truckLoads'), false);
  assert.throws(() => complete({ crewOnSite: { people: 3, hours: 5.3 } }), /quarter hours/);
  assert.throws(() => complete({ crewOnSite: { people: 0, hours: 5 } }), /people on site/);
  assert.throws(() => complete({ truckLoads: 1.5 }), /truck loads/);
  assert.equal(jobActualsRow({ ...job, ...patch, estimate: { amount: 900 } }).actual.source, 'crew_lead');
});
