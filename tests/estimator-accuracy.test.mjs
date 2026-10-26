// Estimator accuracy (owner, 2026-10-21): estimated vs actual man-hours per completed job, who estimated it, and a
// 30/90-day scorecard per estimator, on top of job actuals with no new reads and no money.
process.env.TZ = 'Asia/Tokyo';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { ESTIMATOR_FIELDS, ESTIMATOR_MIN_JOBS, accuracyRow, buildEstimatorAccuracy, errorTenths, estimatorOf, estimatorScorecard, exclusionOf } from '../functions/_lib/estimator-accuracy.js';
import { jobActualsRow } from '../functions/_lib/job-actuals.js';
import { jobActualsHandlers, JOB_ACTUALS_FIELDS } from '../functions/api/job-actuals.js';

const OWNER = { user: 'ZacB', role: 'owner', businessAccess: true, owner: true };
const MANAGER = { user: 'AlexK', role: 'manager', businessAccess: true, owner: false };
const CREW = { user: 'Synthetic.Crew', role: 'crew', businessAccess: false };
const signed = user => ({ acceptance: { method: 'in_person_signature', recordedBy: user } });
// A completed job sold with `sold` man-hours whose crew lead confirmed `people` × `hours` on site.
const job = (id, date, sold, people, hours, extra = {}) => ({ id, type: 'job', date, customer: `Synthetic ${id}`, status: 'completed', completedAt: `${date}T22:00:00.000Z`,
  estimate: { status: 'accepted', amount: 1000 }, serviceType: 'Garage transformation', jobInstructions: { laborManHours: sold },
  ...(people ? { fieldExecution: { completion: { crewOnSite: { people, hours } } } } : {}), ...extra });
const scored = (j, options) => accuracyRow(jobActualsRow(j, options), j);

test('the estimator is the walkthrough signer, else the quote builder, else the quote sender, else nobody: never a guess', () => {
  assert.deepEqual(estimatorOf(signed('Est.Alex')), { key: 'est.alex', evidence: 'walkthrough_signer' });
  assert.deepEqual(estimatorOf({ quoteDraft: { sentBy: 'Sales.Sam' } }), { key: 'sales.sam', evidence: 'quote_sender' });
  // The owner sends a quote an estimator built: the builder priced it, so the builder is credited (as on Open quotes).
  assert.deepEqual(estimatorOf({ quoteDraft: { createdBy: 'Est.Nora', sentBy: 'ZacB' } }), { key: 'est.nora', evidence: 'quote_builder' });
  assert.deepEqual(estimatorOf({ ...signed('Est.Alex'), quoteDraft: { sentBy: 'Office.Olive' } }).key, 'est.alex', 'the signer priced it on site');
  assert.equal(estimatorOf({ acceptance: { method: 'portal', recordedBy: 'Est.Alex' } }), null, 'only an in-person signature names the signer');
  assert.equal(estimatorOf({ acceptance: { method: 'in_person_signature', recordedBy: 'not a key!' } }), null);
  assert.equal(estimatorOf({}), null);
  assert.deepEqual([...ESTIMATOR_FIELDS], ['acceptance.recordedBy', 'acceptance.method', 'quoteDraft.createdBy', 'quoteDraft.sentBy']);
  assert.ok(ESTIMATOR_FIELDS.every(field => JOB_ACTUALS_FIELDS.includes(field)), 'the job actuals read asks for the estimator fields');
});

test('the error is (actual − estimated) / estimated in tenths, half up: + means the job ran longer than estimated', () => {
  assert.equal(errorTenths(8000, 10000), 250);
  assert.equal(errorTenths(8000, 6000), -250);
  assert.equal(errorTenths(3000, 3001), 0, '0.033% rounds to 0.0');
  assert.equal(errorTenths(6000, 6003), 1, '0.05% rounds half up to 0.1');
  assert.equal(errorTenths(0, 1000), null);
  const row = scored(job('j1', '2026-10-10', 8, 2, 5, signed('Est.Alex')));
  assert.deepEqual([row.estimatedManHours, row.actualManHours, row.differenceManHours, row.differencePercent, row.scored, row.estimator, row.estimatorEvidence],
    [8, 10, 2, 25, true, 'est.alex', 'walkthrough_signer']);
});

test('jobs that cannot be scored are listed with the reason and left out of the scorecard', () => {
  const cases = [
    [job('junk', '2026-10-10', 0, 2, 2, { ...signed('Est.Alex'), serviceType: 'Junk removal' }), {}, 'junk_only'],
    [job('legacy', '2026-10-10', 0, 2, 2, signed('Est.Alex')), {}, 'no_labor_estimate'],
    [job('none', '2026-10-10', 8, 0, 0, signed('Est.Alex')), {}, 'actual_not_recorded'],
    [job('open', '2026-10-10', 8, 0, 0, signed('Est.Alex')), { labor: { workHours: 9, travelHours: 0, incomplete: true } }, 'timecards_incomplete'],
    [job('down', '2026-10-10', 8, 2, 4, signed('Est.Alex')), { timecardsAvailable: false }, 'timecards_unavailable'],
    [job('anon', '2026-10-10', 8, 2, 4), {}, 'no_estimator'],
  ];
  for (const [j, options, reason] of cases) {
    const row = scored(j, options);
    assert.deepEqual([row.scored, row.excluded], [false, reason], j.id);
    assert.equal(exclusionOf(jobActualsRow(j, options), estimatorOf(j)), reason, j.id);
  }
  assert.deepEqual(estimatorScorecard(cases.map(([j, options]) => scored(j, options))).estimators, []);
});

test('the scorecard: average miss, bias, ±10/±20 shares, and ranking only from the minimum job count', () => {
  const alex = [[8, 2, 4], [8, 2, 4.5], [10, 2, 5], [10, 2, 6]].map(([sold, p, h], i) => scored(job(`a${i}`, '2026-10-10', sold, p, h, signed('Est.Alex'))));
  // Alex: 0%, +12.5%, 0%, +20% → average miss 8.1% (32.5/4 = 8.125, half up), bias +8.1%, 50% within ±10, 100% within ±20.
  const sam = [[4, 2, 4], [4, 2, 2], [4, 1, 2]].map(([sold, p, h], i) => scored(job(`s${i}`, '2026-10-10', sold, p, h, { quoteDraft: { sentBy: 'Sales.Sam' } })));
  // Sam: +100%, 0%, −50% → average miss 50%, bias +16.7%.
  const lucky = [scored(job('l0', '2026-10-10', 5, 1, 5, signed('Lucky.Lee')))];
  const card = estimatorScorecard([...lucky, ...sam, ...alex]);
  assert.equal(card.minJobs, ESTIMATOR_MIN_JOBS);
  assert.deepEqual(card.estimators.map(e => [e.estimator, e.jobs, e.ranked, e.averageErrorPercent, e.biasPercent, e.within10Percent, e.within20Percent]), [
    ['est.alex', 4, true, 8.1, 8.1, 50, 100],
    ['sales.sam', 3, true, 50, 16.7, 33.3, 33.3],
    ['lucky.lee', 1, false, 0, 0, 100, 100],
  ], 'one perfect job never outranks a steady record');
  assert.deepEqual(card.top, { estimator: 'est.alex', averageErrorPercent: 8.1, jobs: 4 });
  assert.deepEqual(card.leaders, [card.top]);
  assert.deepEqual([card.estimators[0].estimatedManHours, card.estimators[0].actualManHours], [36, 39]);
  assert.equal(estimatorScorecard(lucky).top, null, 'nobody ranked, no callout');
  assert.equal(estimatorScorecard(lucky, { minJobs: 1 }).top.estimator, 'lucky.lee');
});

test('the report block: 30-day and 90-day scorecards, every job listed newest first, exclusions counted', () => {
  const jobs = [job('new', '2026-10-15', 8, 2, 4, signed('Est.Alex')), job('mid', '2026-10-01', 8, 2, 4, signed('Est.Alex')), job('old', '2026-08-01', 8, 2, 4, signed('Est.Alex')),
    job('junk', '2026-10-12', 0, 2, 2, { ...signed('Est.Alex'), serviceType: 'Junk removal' })];
  const rows = jobs.map(j => jobActualsRow(j)).sort((a, b) => b.date.localeCompare(a.date));
  const block = buildEstimatorAccuracy({ rows, jobs, shortStart: '2026-09-22' });
  assert.deepEqual(block.rows.map(row => row.jobId), ['new', 'junk', 'mid', 'old']);
  assert.deepEqual([block.excluded, block.last30.excluded, block.last30.jobIds, block.last90.jobIds], [{ junk_only: 1 }, { junk_only: 1 }, ['new', 'junk', 'mid'], ['new', 'junk', 'mid', 'old']]);
  assert.deepEqual([block.last30.estimators[0].jobs, block.last30.top, block.last90.estimators[0].jobs, block.last90.top.estimator], [2, null, 3, 'est.alex']);
});

// The handler with synthetic jobs and the read calls it makes.
function api({ actor = OWNER, jobs } = {}) {
  const calls = [];
  const handlers = jobActualsHandlers({
    session: async () => actor, now: () => new Date('2026-10-21T18:00:00.000Z'), timecards: async () => [],
    settingsStore: () => ({ async read() { return { schemaVersion: 1, wageCentsPerManHour: 1000, revision: 'rev-pay' }; }, async commit() {} }),
    dispatch: () => ({ datedJobs: async (start, end, fields) => { calls.push({ start, end, fields }); return jobs; } }),
    knock: () => ({ getMany: async (collection, ids) => { calls.push({ collection, ids }); return new Map(); }, query: async (collection) => { calls.push({ collection }); return []; } }),
  });
  return { handlers, calls };
}
const get = handlers => handlers.get({ request: new Request('https://easygaragecleaning.com/api/job-actuals'), env: {} });

test('GET /api/job-actuals adds estimator accuracy with the same reads, business accounts only, and no money in it', async () => {
  for (const [actor, status] of [[null, 401], [CREW, 403]]) assert.equal((await get(api({ actor, jobs: [] }).handlers)).status, status);
  const jobs = [1, 2, 3].map(n => job(`j${n}`, `2026-10-1${n}`, 8, 2, 4 + n / 4, signed('Est.Alex')));
  const { handlers, calls } = api({ actor: MANAGER, jobs });
  const body = await (await get(handlers)).json();
  assert.deepEqual(calls.map(call => call.collection || 'jobs'), ['jobs', 'knock_sales'], 'the same reads as job actuals: one dated jobs query and the door-sale lookup');
  assert.deepEqual(calls[0].fields, [...JOB_ACTUALS_FIELDS]);
  const block = body.estimatorAccuracy;
  assert.equal(block.last30.top.estimator, 'est.alex');
  assert.deepEqual(block.rows.map(row => row.differencePercent), [18.8, 12.5, 6.3]);
  assert.doesNotMatch(JSON.stringify(block), /Cents|revenue|margin|commission|hourlyRate|wage/i, 'hours only: no money or pay in the estimator block');
});

test('the Hub card shows the callout, the scorecard and why jobs were not scored, with no money on it', () => {
  const nodes = [];
  const el = (tag, props = {}, ...children) => { const node = { tag, props, children: children.flat(Infinity).filter(child => child !== null && child !== undefined && child !== false) }; nodes.push(node); return node; };
  const text = node => typeof node === 'string' ? node : node ? node.children.map(text).join('') : '';
  const context = { window: {}, sessionStorage: { getItem: () => null }, Intl, Date, Number, String, Array, Object, JSON, Math, Set, Map, console };
  context.window = context;
  context.EGCHubKit = { h: el, button: (label, onclick, kind, props) => el('button', { onclick, kind, ...props }, label), money: cents => `$${(cents / 100).toFixed(2)}`, pending: () => ({ get: () => null }) };
  context.addEventListener = () => {};
  vm.runInNewContext(read('employee-job-actuals.js').replace(/\}\)\(\);\s*$/, 'globalThis.__ja={S,accuracyCard};})();'), context);
  const jobs = [1, 2, 3].map(n => job(`j${n}`, `2026-10-1${n}`, 8, 2, 4 + n / 4, signed('Est.Alex'))).concat([job('anon', '2026-10-09', 8, 2, 4)]);
  const rows = jobs.map(j => jobActualsRow(j)).sort((a, b) => b.date.localeCompare(a.date));
  context.__ja.S.data = { estimatorAccuracy: JSON.parse(JSON.stringify(buildEstimatorAccuracy({ rows, jobs, shortStart: '2026-09-22' }))) };
  const card = text(context.__ja.accuracyCard());
  assert.match(card, /Most accurate in the last 30 days: est\.alex — off by 12\.5% on average across 3 jobs\./);
  assert.match(card, /Under by 12\.5%/);
  assert.match(card, /Not scored in the last 30 days: No estimator on record: 1\./);
  assert.match(card, /job by job in the last 30 days \(4\)/);
  assert.doesNotMatch(card, /\$/, 'no dollar figure on the estimator card');
});

// The card's job list: Show all moves focus to the first row it adds (not the summary above the list, which scrolled the
// page back to its top), an unsettled conflict names who signed, and a job not scored for its hours shows no difference.
test('the Hub card: Show all focuses the first added row, a conflict names who signed, and a travel-only job shows no difference', () => {
  const nodes = [];
  const el = (tag, props = {}, ...children) => { const node = { tag, props, children: children.flat(Infinity).filter(child => child !== null && child !== undefined && child !== false) }; nodes.push(node); return node; };
  const text = node => typeof node === 'string' ? node : node ? node.children.map(text).join('') : '';
  const context = { window: {}, sessionStorage: { getItem: () => null }, Intl, Date, Number, String, Array, Object, JSON, Math, Set, Map, console };
  context.window = context;
  context.EGCHubKit = { h: el, button: (label, onclick, kind, props) => el('button', { onclick, kind, ...props }, label), money: cents => `$${(cents / 100).toFixed(2)}`, pending: () => ({ get: () => null }) };
  context.addEventListener = () => {};
  vm.runInNewContext(read('employee-job-actuals.js').replace(/\}\)\(\);\s*$/, 'globalThis.__ja={S,accuracyCard};})();'), context);
  const jobs = Array.from({ length: 24 }, (_, n) => job(`j${String(n).padStart(2, '0')}`, `2026-10-${String(n + 1).padStart(2, '0')}`, 8, 2, 4, signed('Est.Alex')));
  const travel = job('travel', '2026-10-25', 8, 0, 0, signed('Est.Alex')), conflict = job('conflict', '2026-10-26', 8, 2, 4, { ...signed('Est.Bea'), sourceWalkthroughId: 'walk-1' });
  const all = [...jobs, travel, conflict], setters = new Map([['walk-1', { estimatorKey: 'Est.Alex', source: 'knock_walkthrough' }]]);
  const rows = all.map(j => j === travel ? jobActualsRow(j, { labor: { workHours: 0, travelHours: 2, incomplete: false } }) : jobActualsRow(j)).sort((a, b) => b.date.localeCompare(a.date));
  context.__ja.S.data = { estimatorAccuracy: JSON.parse(JSON.stringify(buildEstimatorAccuracy({ rows, jobs: all, setters, shortStart: '2026-09-22' }))) };
  context.__ja.S.accuracyWindow = 'last30';
  const first = context.__ja.accuracyCard(), rowsOf = () => nodes.filter(node => node.tag === 'tr' && node.props['data-accuracy-job']);
  const firstText = text(first);
  assert.match(firstText, /Not scored: The setter record names a different estimator \(est\.bea signed it; settle it in Knock Admin\)/);
  const travelRow = rowsOf().find(node => node.props['data-accuracy-job'] === 'travel');
  assert.doesNotMatch(text(travelRow), /-8\.00|100\.0%/, 'no difference on a travel-only job');
  assert.match(text(travelRow), /—Not scored: Actual hours not recorded/);
  const button = nodes.find(node => node.tag === 'button' && /^Show all \d+ jobs$/.test(text(node)));
  nodes.length = 0;
  button.props.onclick();
  assert.equal(context.__ja.S.accuracyFocus, '[data-accuracy-first-added]', 'focus goes to the first added row, not the summary');
  context.__ja.accuracyCard();
  const added = rowsOf().filter(node => node.props['data-accuracy-first-added'] !== undefined);
  assert.deepEqual([rowsOf().length, added.length, added[0].props.tabindex, rowsOf().indexOf(added[0])], [26, 1, '-1', 20]);
});

test('a quote sent and accepted online is scored from the hours its builder breakdown sold, and junk-only by its lines', () => {
  const sent = { quoteDraft: { sentBy: 'Sales.Sam', breakdown: { source: 'composite', labor: { manHours: 8 }, lines: [{ section: 'removal', group: 'junk' }, { section: 'organize', group: 'shelving' }] } } };
  const online = job('online', '2026-10-10', undefined, 2, 5, sent);
  delete online.jobInstructions;
  const row = scored(online);
  assert.deepEqual([row.estimatedManHours, row.actualManHours, row.differencePercent, row.scored, row.estimator, row.estimatorEvidence], [8, 10, 25, true, 'sales.sam', 'quote_sender']);
  const junk = job('junk-online', '2026-10-10', undefined, 2, 2, { quoteDraft: { sentBy: 'Sales.Sam', breakdown: { source: 'composite', lines: [{ section: 'removal', group: 'junk' }] } } });
  delete junk.jobInstructions;
  assert.equal(scored(junk).excluded, 'junk_only');
  const other = job('other-source', '2026-10-10', undefined, 2, 5, { quoteDraft: { sentBy: 'Sales.Sam', breakdown: { source: 'legacy', labor: { manHours: 8 } } } });
  delete other.jobInstructions;
  assert.equal(scored(other).excluded, 'no_labor_estimate', 'only a composite breakdown counts');
  for (const field of ['quoteDraft.breakdown.source', 'quoteDraft.breakdown.labor.manHours', 'quoteDraft.breakdown.lines']) assert.ok(JOB_ACTUALS_FIELDS.includes(field), field);
});

test('travel-only timecards are not an actual, the miss is rounded on its own size, and tied leaders are all named', () => {
  const travelOnly = scored(job('travel', '2026-10-10', 8, 0, 0, signed('Est.Alex')), { labor: { workHours: 0, travelHours: 2, incomplete: false } });
  assert.equal(travelOnly.excluded, 'actual_not_recorded');
  // A travel-only job shows no difference: there is nothing to compare (not −8.00 h, −100%).
  assert.deepEqual([travelOnly.differenceManHours, travelOnly.differencePercent, travelOnly.absoluteErrorPercent], [null, null, null]);
  // 6 h sold, 5.997 h worked: the −0.05% miss rounds half up on its size to 0.1, and the signed figure keeps that size.
  const tiny = accuracyRow({ jobId: 't', date: '2026-10-10', billed: { manHours: 6, source: 'labor_line' }, actual: { manHours: 5.997, source: 'crew_lead' }, reasons: [] }, signed('Est.Alex'));
  assert.deepEqual([tiny.differencePercent, tiny.absoluteErrorPercent], [-0.1, 0.1]);
  // 9.9 h sold, 8.9 h worked: −10.101…% shows as −10.1% beside its 10.1% miss, never −10.0%.
  const under = accuracyRow({ jobId: 'u', date: '2026-10-10', billed: { manHours: 9.9, source: 'labor_line' }, actual: { manHours: 8.9, source: 'crew_lead' }, reasons: [] }, signed('Est.Alex'));
  assert.deepEqual([under.differencePercent, under.absoluteErrorPercent], [-10.1, 10.1]);
  assert.equal(errorTenths(20000, 19990), -1, '−0.05% rounds to −0.1, the same size as its miss');
  const even = name => [[8, 2, 4], [8, 2, 4], [8, 2, 4]].map(([sold, p, h], i) => scored(job(`${name}${i}`, '2026-10-10', sold, p, h, signed(name))));
  const card = estimatorScorecard([...even('Est.Alex'), ...even('Est.Bea')]);
  assert.deepEqual(card.leaders.map(l => l.estimator), ['est.alex', 'est.bea']);
});

// As the commission does (knock-setters.js projectSetterAttribution): an estimator the Knock bridge booked, with another
// signer, is a conflict until the office settles it; one the office recorded or settled is credited with no conflict.
test('a setter walkthrough uses the setter record\'s estimator; a Knock-booked one with another signer is a conflict until the office settles it', () => {
  const booked = { estimatorKey: 'Est.Alex', source: 'knock_walkthrough', estimatorReference: 'knock-walkthrough:w1' };
  assert.deepEqual(estimatorOf(signed('Est.Alex'), booked), { key: 'est.alex', evidence: 'setter_record' });
  assert.deepEqual(estimatorOf({}, booked), { key: 'est.alex', evidence: 'setter_record' });
  assert.deepEqual(estimatorOf(signed('Est.Bea'), booked), { key: 'est.alex', evidence: 'setter_record', conflict: 'est.bea' });
  const conflict = scored(job('c', '2026-10-10', 8, 2, 4, { ...signed('Est.Bea'), sourceWalkthroughId: 'walk-1' }));
  assert.equal(conflict.excluded, null);
  const j = job('c', '2026-10-10', 8, 2, 4, { ...signed('Est.Bea'), sourceWalkthroughId: 'walk-1' });
  const block = setter => buildEstimatorAccuracy({ rows: [jobActualsRow(j)], jobs: [j], setters: new Map([['walk-1', setter]]), shortStart: '2026-09-22' }).rows[0];
  // Unsettled: not scored, naming the other person.
  const open = block(booked);
  assert.deepEqual([open.estimator, open.excluded, open.estimatorConflict, open.scored], ['est.alex', 'estimator_conflict', 'est.bea', false]);
  // The office settles it (setter.classify, estimatorClassifiedAt): credited to the settled estimator, scored.
  const settled = block({ ...booked, estimatorKey: 'Est.Bea', estimatorClassifiedAt: '2026-10-11T15:00:00.000Z', estimatorClassifiedBy: 'zacb' });
  assert.deepEqual([settled.estimator, settled.excluded, settled.scored, 'estimatorConflict' in settled], ['est.bea', null, true, false]);
  const kept = block({ ...booked, estimatorClassifiedAt: '2026-10-11T15:00:00.000Z' });
  assert.deepEqual([kept.estimator, kept.excluded, kept.scored], ['est.alex', null, true], 'the office kept the booked estimator: no conflict');
  // An estimator the office recorded (not the Knock bridge) is credited even when someone else signed.
  const office = block({ estimatorKey: 'Est.Alex', estimatorReference: 'review-12' });
  assert.deepEqual([office.estimator, office.excluded, office.scored], ['est.alex', null, true]);
});

function read(name) { return readFileSync(new URL(`../${name}`, import.meta.url), 'utf8'); }
