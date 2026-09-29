import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { DURATION_SOURCES, SOLD_ESTIMATE_STATUSES, dispatchCrewSize, dispatchDurationFields, dispatchDurationOverride, suggestedDuration, withQuoteLines } from '../functions/_lib/dispatch-duration.js';
import { suggestedDurationMinutes } from '../functions/_lib/quote-duration.js';
import { dispatchOverview, mutateDispatch, projectDispatchJob } from '../functions/_lib/dispatch-service.js';
import { dispatchSearch } from '../functions/_lib/dispatch-search.js';
import { dispatchStorage } from '../functions/_lib/dispatch-storage.js';
import { encodeFirestoreFields } from '../functions/_lib/firestore-job.js';
import { scheduleInterval } from '../functions/_lib/dispatch-time.js';
import { dispatchHandlers } from '../functions/api/dispatch.js';
import { dispatchFunnelOptions } from '../functions/_lib/dispatch-funnel.js';
import { crewJobProjection } from '../functions/_lib/crew-job-projection.js';
import { saveWalkthroughHandoff } from '../functions/_lib/walkthrough-handoff.js';

const NOW = '2026-09-22T12:00:00.000Z';
const manager = { user: 'zacb', displayName: 'Owner', role: 'owner', businessAccess: true };
const line = (extra = {}) => ({ id: 'reset', kind: 'service', name: 'Synthetic garage reset', unitCents: 100000, ...extra });
const floors = { id: 'floors', label: 'Floors', selection: 'single' };
// 240 + 3 x 20 (labor minutes only) + 10 x 3 (chosen add-on) + 30 (chosen alternative) = 360 person-minutes.
const soldLines = () => [
  line({ durationMinutes: 240 }),
  line({ id: 'shelf', kind: 'product', quantity: 3, unitCents: 45000, split: { productCents: 30000, laborCents: 15000, laborMinutes: 20 } }),
  line({ id: 'rush', kind: 'fee', unitCents: 5000, optional: true, durationMinutes: 600 }),
  line({ id: 'totes', kind: 'product', unitCents: 2150, quantity: 10, optional: true, selected: true, durationMinutes: 3 }),
  line({ id: 'epoxy', unitCents: 90000, group: floors, durationMinutes: 480 }),
  line({ id: 'sweep', unitCents: 20000, group: floors, selected: true, durationMinutes: 30 }),
  line({ id: 'off', kind: 'discount', unitCents: 1000, durationMinutes: 500 }),
  line({ id: 'tip', kind: 'tip', unitCents: 1000, durationMinutes: 500 }),
];
const sold = lineItems => ({ status: 'accepted', lineItems });
const quoted = (extra = {}) => ({ id: 'job-quoted', type: 'job', crewNeeded: 3, estimate: sold(soldLines()), ...extra });
const pick = result => [result.source, result.minutes];

test('selected quote lines give person-minutes divided by the dispatch crew and rounded up to 15 minutes', () => {
  const result = suggestedDuration(quoted());
  assert.deepEqual([result.source, result.minutes, result.crewSize, result.breakdown.personMinutes, result.breakdown.crewMinutes], ['line_items', 120, 3, 360, 120]);
  assert.deepEqual(result.breakdown.items.map(item => item.id), ['reset', 'shelf', 'totes', 'sweep'], 'deselected options, the unchosen alternative, discounts and tips add nothing');
  assert.deepEqual(pick(suggestedDuration(quoted({ crewNeeded: 4 }))), ['line_items', 90]);
  assert.deepEqual(pick(suggestedDuration(quoted({ crewNeeded: 7 }))), ['line_items', 60], '360 / 7 = 51.4 minutes rounds up to 60');
  assert.deepEqual(pick(suggestedDuration(quoted({ crewNeeded: undefined, requiredCrewSize: 2 }))), ['line_items', 180], 'requiredCrewSize is the legacy crew');
  for (const crewNeeded of [0, 21, 2.5, '3', null]) assert.equal(suggestedDuration(quoted({ crewNeeded })).minutes, 360, `an unreadable crew (${crewNeeded}) is one person`);
  assert.deepEqual(pick(suggestedDuration(quoted(), { crewSize: 5 })), ['line_items', 75], 'an explicit crew wins: 72 minutes rounds up to 75');
  const setup = suggestedDuration(quoted(), { settings: { setupMinutes: 20 } });
  assert.deepEqual([setup.minutes, setup.breakdown.rawMinutes, setup.breakdown.setupMinutes], [150, 140, 20], 'setup is added once, not divided by the crew');
  assert.throws(() => suggestedDuration(quoted(), { crewSize: 0 }), error => error.code === 'quote_invalid_crew_size' && error.status === 400);
  assert.deepEqual(DURATION_SOURCES, ['duration_override', 'line_items', 'estimated_duration', 'schedule_span', 'default']);
  assert.deepEqual([dispatchCrewSize({ crewNeeded: 2, requiredCrewSize: 4 }), dispatchCrewSize({ requiredCrewSize: 4 }), dispatchCrewSize({ crewNeeded: 'x' }), dispatchCrewSize(null)], [2, 4, 1, 1]);
  assert.equal(suggestedDuration(quoted({ crewNeeded: undefined, crewSize: 4, logistics: { crew_size: 4 } })).minutes, 360, 'unmasked fields do not change the crew, so list and single-job reads agree');
});

test('without line minutes the suggestion falls back to the estimate, the schedule span, then the default', () => {
  const legacy = { estimate: sold([{ name: 'Garage transformation', description: 'Synthetic scope', quantity: 1, amount: 1425 }]) };
  const estimated = suggestedDuration({ ...legacy, estimatedDurationMin: 170, date: '2026-09-24', time: '09:00', endTime: '17:00' });
  assert.deepEqual([...pick(estimated), estimated.breakdown.coverage, estimated.breakdown.unestimated], ['estimated_duration', 180, 'fallback', ['line-1']], 'a saved estimate beats the span and rounds up to 15');
  assert.deepEqual(pick(suggestedDuration({ estimatedDurationMin: 2000, date: '2026-09-24', time: '09:00', endTime: '10:00' })), ['estimated_duration', 2010], 'a multi-day expectation is kept');
  assert.deepEqual(pick(suggestedDuration({ estimatedDurationMin: 10080 })), ['estimated_duration', 10080]);
  for (const estimatedDurationMin of [14, 10081, 90.5, '120', null]) assert.deepEqual(pick(suggestedDuration({ estimatedDurationMin, date: '2026-09-24', time: '09:00', endTime: '12:20' })), ['schedule_span', 210], `ignored estimate ${estimatedDurationMin}`);
  assert.deepEqual(pick(suggestedDuration({ date: '2026-11-01', time: '00:30', endTime: '03:30' })), ['schedule_span', 240], 'the Denver fall-back hour is elapsed time');
  assert.deepEqual(pick(suggestedDuration({ date: '2026-11-01', time: '01:30', endTime: '03:00' })), ['default', 120], 'a repeated DST wall time is not trusted');
  assert.deepEqual(pick(suggestedDuration({ date: '2026-09-24', time: '08:00', endDate: '2026-09-25', endTime: '17:00' })), ['schedule_span', 1440], 'the span is capped at one day, like the openings search');
  assert.deepEqual(pick(suggestedDuration({})), ['default', 120]);
  assert.deepEqual(pick(suggestedDuration(null)), ['default', 120]);
  assert.deepEqual(pick(suggestedDuration({ estimate: sold([line({ durationMinutes: 0 })]), estimatedDurationMin: 150 })), ['estimated_duration', 150], 'zero line minutes never schedule nothing');
  const partial = suggestedDuration({ estimate: sold([line({ durationMinutes: 60 }), line({ id: 'haul', kind: 'disposal', unitCents: 17500 })]), estimatedDurationMin: 300 });
  assert.deepEqual([...pick(partial), partial.breakdown.coverage, partial.breakdown.unestimated], ['line_items', 60, 'partial', ['haul']], 'any line minutes win; the rest are reported as unestimated');
  assert.deepEqual(pick(suggestedDuration({ estimate: 'damaged', estimatedDurationMin: 45 })), ['estimated_duration', 45]);
  assert.deepEqual(pick(suggestedDuration({ estimate: sold({ reset: line({ durationMinutes: 240 }) }) })), ['default', 120], 'a line map is not a line list');
});

test('only the lines of a sold quote count; draft, sent or declined quotes fall back', () => {
  assert.deepEqual(SOLD_ESTIMATE_STATUSES, ['accepted', 'approved']);
  for (const status of ['approved', 'Accepted'])
    assert.deepEqual(pick(suggestedDuration(quoted({ estimate: { status, lineItems: soldLines() } }))), ['line_items', 120], `a ${status} quote is sold`);
  for (const status of ['draft', 'sent', 'declined', 'superseded', 'accepted ', undefined, null, 7])
    assert.deepEqual(pick(suggestedDuration(quoted({ estimate: { status, lineItems: soldLines() }, estimatedDurationMin: 150 }))), ['estimated_duration', 150], `a ${status} quote is not sold`);
  assert.deepEqual(pick(suggestedDuration(quoted({ estimate: { status: 'sent', lineItems: soldLines() } }))), ['default', 120]);
  assert.deepEqual(pick(suggestedDuration(quoted({ estimate: { status: 'accepted' }, estimatedDurationMin: 90 }))), ['estimated_duration', 90], 'a sold quote without lines keeps the estimate');
});

test('a walkthrough override recorded with a reason wins only for the crew it was judged for', () => {
  const override = (extra = {}) => ({ suggestedMinutes: 180, minutes: 290, reason: 'Synthetic narrow alley adds carry time', recordedBy: 'zacb', recordedAt: NOW, ...extra });
  const job = (extra = {}) => quoted({ crewNeeded: 2, logistics: { crew_size: 2 }, estimatedDurationMin: 290, durationOverride: override(), ...extra });
  const result = suggestedDuration(job());
  assert.deepEqual([...pick(result), result.crewSize, result.breakdown.rawMinutes, result.breakdown.overridden], ['duration_override', 300, 2, 290, { source: 'line_items', minutes: 180 }]);
  assert.deepEqual(pick(suggestedDuration(job(), { crewSize: 2 })), ['duration_override', 300], 'the same crew keeps the override');
  assert.deepEqual(pick(suggestedDuration(job(), { crewSize: 4 })), ['line_items', 90], 'another crew is recomputed from the lines');
  assert.deepEqual(pick(suggestedDuration(job({ crewNeeded: 4 }))), ['line_items', 90], 'dispatch changing the crew retires the override');
  assert.deepEqual(pick(suggestedDuration(job({ crewNeeded: 4, estimate: undefined }))), ['estimated_duration', 300], 'without lines the saved estimate stays the fallback');
  assert.deepEqual(pick(suggestedDuration(job({ crewNeeded: 3, durationOverride: override({ crewSize: 3 }) }))), ['duration_override', 300], 'a recorded crewSize wins over logistics');
  assert.deepEqual(pick(suggestedDuration(job({ durationOverride: override({ crewSize: 3 }) }))), ['line_items', 180]);
  assert.deepEqual(pick(suggestedDuration(job({ durationOverride: null, estimatedDurationMin: 180 }))), ['line_items', 180], 'no override: the lines match the handoff estimate');
  for (const changed of [{ durationOverride: override({ reason: '  ' }) }, { durationOverride: override({ reason: 7 }) }, { durationOverride: override({ minutes: '290' }) }, { durationOverride: [override()] }, { estimatedDurationMin: 360 }, { logistics: undefined }, { logistics: { crew_size: '2' } }, { durationOverride: override({ crewSize: 0 }) }])
    assert.deepEqual(pick(suggestedDuration(job(changed))), ['line_items', 180], `not a recorded override: ${JSON.stringify(changed)}`);
  assert.deepEqual(pick(suggestedDuration({ estimatedDurationMin: 200, logistics: { crew_size: 1 }, durationOverride: override({ minutes: 200 }) })), ['duration_override', 210], 'an override on an unitemized job still rounds to 15');
});

test('a length saved in dispatch outranks the lines and a walkthrough override for its crew', () => {
  const job = (extra = {}) => quoted({ crewNeeded: 2, logistics: { crew_size: 2 }, estimatedDurationMin: 300, durationOverride: dispatchDurationOverride(300, 2, 'zacb', NOW), ...extra });
  assert.deepEqual(dispatchDurationOverride(300, 2, 'zacb', NOW), { minutes: 300, reason: 'Set in dispatch', source: 'dispatch', crewSize: 2, recordedBy: 'zacb', recordedAt: NOW });
  const result = suggestedDuration(job());
  assert.deepEqual([...pick(result), result.breakdown.overridden], ['estimated_duration', 300, undefined]);
  assert.deepEqual(pick(suggestedDuration(job({ estimatedDurationMin: 2000, durationOverride: dispatchDurationOverride(2000, 2, 'zacb', NOW) }))), ['estimated_duration', 2010], 'a multi-day length is kept');
  assert.deepEqual(pick(suggestedDuration(job({ crewNeeded: 3 }))), ['line_items', 120], 'another crew is recomputed from the lines');
  assert.deepEqual(pick(suggestedDuration(job({ estimatedDurationMin: 240 }))), ['line_items', 180], 'a length changed by another writer is no longer the recorded one');
});

test('the walkthrough handoff estimate and the dispatch suggestion agree for the handoff crew', () => {
  const lines = soldLines(), handoff = suggestedDurationMinutes(lines, { crewSize: 2 });
  const job = { crewNeeded: 2, logistics: { crew_size: 2 }, estimatedDurationMin: handoff.minutes, durationOverride: null, estimate: sold(lines) };
  assert.deepEqual(pick(suggestedDuration(job)), ['line_items', handoff.minutes]);
  assert.equal(suggestedDuration({ ...job, crewNeeded: 4 }).minutes, 90, 'dispatch adding crew shortens the job');
});

test('a projection reuses its schedule interval, so the span fallback adds no Denver conversion', () => {
  const job = { date: '2026-09-24', time: '09:00', endTime: '12:20' }, interval = scheduleInterval(job);
  assert.deepEqual(pick(suggestedDuration(job, { interval: null })), ['default', 120], 'the caller interval is authoritative');
  assert.deepEqual(pick(suggestedDuration({}, { interval })), ['schedule_span', 210]);
  const original = Intl.DateTimeFormat; let conversions = 0;
  Intl.DateTimeFormat = new Proxy(original, { construct(target, args, newTarget) { conversions++; return Reflect.construct(target, args, newTarget); } });
  try {
    assert.deepEqual(dispatchDurationFields(job, interval), { suggestedDurationMin: 210, durationSource: 'schedule_span', durationCoverage: null, durationCapped: false });
    assert.deepEqual(dispatchDurationFields({ ...job, estimatedDurationMin: 60 }), { suggestedDurationMin: 60, durationSource: 'estimated_duration', durationCoverage: null, durationCapped: false }, 'a saved estimate never computes the span');
    assert.deepEqual(dispatchDurationFields({ ...job, estimate: sold([line({ durationMinutes: 45 })]) }), { suggestedDurationMin: 45, durationSource: 'line_items', durationCoverage: 'complete', durationCapped: false });
  } finally { Intl.DateTimeFormat = original; }
  assert.equal(conversions, 0);
});

test('the DTO fields are plain values that flag an undercount, and unreadable data gives nulls', () => {
  assert.deepEqual(dispatchDurationFields(quoted()), { suggestedDurationMin: 120, durationSource: 'line_items', durationCoverage: 'complete', durationCapped: false });
  assert.deepEqual(dispatchDurationFields({}), { suggestedDurationMin: 120, durationSource: 'default', durationCoverage: null, durationCapped: false });
  assert.deepEqual(dispatchDurationFields(quoted({ estimate: sold([...soldLines(), line({ id: 'haul', kind: 'disposal', unitCents: 17500 })]) })), { suggestedDurationMin: 120, durationSource: 'line_items', durationCoverage: 'partial', durationCapped: false }, 'a sold line without minutes makes the suggestion partial');
  assert.deepEqual(dispatchDurationFields(quoted({ crewNeeded: 1, estimate: sold([line({ durationMinutes: 900, quantity: 2 })]) })), { suggestedDurationMin: 1440, durationSource: 'line_items', durationCoverage: 'complete', durationCapped: true }, '1800 minutes are capped at one day');
  assert.deepEqual(dispatchDurationFields({ date: '2026-09-24', time: '08:00', endDate: '2026-09-26', endTime: '17:00' }), { suggestedDurationMin: 1440, durationSource: 'schedule_span', durationCoverage: null, durationCapped: true });
  const broken = { get estimate() { throw new Error('unreadable'); } };
  assert.deepEqual(dispatchDurationFields(broken), { suggestedDurationMin: null, durationSource: null, durationCoverage: null, durationCapped: null });
});

const CANARIES = ['CANARY-LINE', 'CANARY-DESC', 'CANARY-REASON', 'canary-catalog', '98765', '12345', '424242', '313131'];
const MONEY = /amount|price|cents|deposit|invoice|payment|markup|split|lineitems|"estimate"|durationoverride|logistics|"status":"accepted"/i;
function moneyJob(extra = {}) {
  return { id: 'job-money', type: 'job', customerId: 'c1', customer: 'Synthetic Customer', address: '100 Synthetic Street', date: '2026-09-23', time: '08:00', endDate: '2026-09-23', endTime: '10:00', status: 'scheduled', assignedCrew: ['crew1'], crewNeeded: 2, jobInstructions: 'Synthetic scope',
    total: 98765.43, priceQuoted: 98765.43, deposit: { amount: 424242, paidAmount: 313131, status: 'partial' }, invoice: { amount: 98765.43, status: 'sent' }, payments: [{ amount: 313131 }],
    estimate: { amount: 98765.43, depositRequired: 424242, status: 'accepted', lineItems: [line({ name: 'CANARY-LINE', description: 'CANARY-DESC', unitCents: 1234567, totalCents: 1234567, amount: 12345.67, durationMinutes: 150, catalog: { itemId: 'canary-catalog', version: 2 }, split: { productCents: 424242, laborCents: 313131, markupCents: 12345, laborMinutes: 150 } })] },
    durationOverride: { suggestedMinutes: 75, minutes: 90, reason: 'CANARY-REASON' }, logistics: { crew_size: 2 }, estimatedDurationMin: 90, ...extra };
}
// FIX-DISPATCH-READY (updated deliberately): GET /api/dispatch now adds, for an owner or manager, moneyReady (money-core
// cents for the price and deposit chips) and the no_price / deposit_unpaid warnings. Those are checked to be exactly
// that and set aside; every other part of a dispatch read stays free of quote money, as DISPATCH-DURATION requires.
const READY_KEYS = ['checked', 'depositDueCents', 'depositPaidCents', 'depositRequiredCents', 'depositVerified', 'hasApprovedPrice', 'priceStatus'];
function withoutReadiness(value) {
  if (Array.isArray(value)) return value.map(withoutReadiness);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === 'moneyReady') { assert.deepEqual(Object.keys(item).sort(), READY_KEYS); continue; }
    out[key] = key === 'warnings' && Array.isArray(item) ? item.filter(warning => !['no_price', 'deposit_unpaid'].includes(warning?.code)).map(withoutReadiness) : withoutReadiness(item);
  }
  return out;
}
function assertNoMoney(value, label) {
  const json = JSON.stringify(value);
  for (const canary of CANARIES) assert.ok(!json.includes(canary), `${label} leaks ${canary}`);
  assert.doesNotMatch(json, MONEY, `${label} carries a money or quote key`);
}

function fixture(jobs = []) {
  const rows = new Map([['customers/c1', { id: 'c1', name: 'Synthetic Customer', phone: '+1 (970) 555-0100', address: '100 Synthetic Street', revision: 'c1r' }], ...jobs.map(job => [`jobs/${job.id}`, { revision: 'seed', ...job }])]);
  let revision = 0;
  const clone = value => structuredClone(value), all = collection => [...rows.entries()].filter(([key]) => key.startsWith(collection + '/')).map(([, value]) => clone(value));
  const roster = [{ id: 'zacb', name: 'Owner', role: 'owner' }, { id: 'crew1', name: 'Crew One', role: 'crew' }, { id: 'crew2', name: 'Crew Two', role: 'crew' }];
  const store = {
    jobs: async () => all('jobs'), resources: async () => all('dispatchResources'), customers: async () => all('customers'), roster: async () => clone(roster),
    read: async (collection, id) => clone(rows.get(`${collection}/${id}`) || null),
    commit: async writes => {
      const seen = new Set();
      for (const write of writes) {
        const key = `${write.collection}/${write.id}`, old = rows.get(key);
        assert.ok(!seen.has(key), 'No duplicate writes per document'); seen.add(key);
        if (write.revision ? old?.revision !== write.revision : Boolean(old)) throw Object.assign(new Error('Conflict'), { code: 'dispatch_revision_conflict', status: 409 });
      }
      for (const write of writes) if (!write.verify) rows.set(`${write.collection}/${write.id}`, { ...rows.get(`${write.collection}/${write.id}`), ...clone(write.patch), id: write.id, revision: `r${++revision}` });
    },
  };
  const mutate = input => mutateDispatch(store, manager, input, NOW);
  const edit = (job, changes) => ({ action: 'schedule.update', requestId: randomUUID(), jobId: job.id, expectedRevision: job.revision, changes });
  return { rows, store, roster, mutate, edit };
}

test('projectDispatchJob adds only the suggestion and never an amount, price or quote line', () => {
  const dto = projectDispatchJob(moneyJob(), [], NOW);
  assert.deepEqual([dto.suggestedDurationMin, dto.durationSource, dto.estimatedDurationMin, dto.durationCoverage, dto.durationCapped], [90, 'duration_override', 90, null, false]);
  assertNoMoney(dto, 'the dispatch DTO');
  const itemized = projectDispatchJob(moneyJob({ durationOverride: null }), [], NOW);
  assert.deepEqual([itemized.suggestedDurationMin, itemized.durationSource], [75, 'line_items'], '150 person-minutes for a crew of 2');
  assertNoMoney(itemized, 'the itemized DTO');
});

test('every dispatch read path returns the suggestion without quote money', async () => {
  const f = fixture([moneyJob({ durationOverride: null }), { id: 'job-plain', type: 'job', customerId: 'c1', customer: 'Synthetic Customer', date: '', time: '', status: 'unscheduled', estimatedDurationMin: 200 }]);
  const overview = await dispatchOverview(f.store, manager, { startDate: '2026-09-22', endDate: '2026-09-29', includeUnscheduled: 'true' }, new Date(NOW));
  assert.deepEqual(overview.jobs.map(job => [job.id, job.suggestedDurationMin, job.durationSource]), [['job-money', 75, 'line_items'], ['job-plain', 210, 'estimated_duration']]);
  assertNoMoney(overview, 'the dispatch overview');
  const single = await dispatchOverview(f.store, manager, { view: 'job', jobId: 'job-money' }, new Date(NOW));
  assert.equal(single.job.suggestedDurationMin, 75); assertNoMoney(single, 'the single-job view');
  const search = await dispatchSearch(f.store, manager, { q: 'Synthetic Customer' }, new Date(NOW));
  assert.ok(search.results.some(row => row.job.durationSource === 'line_items')); assertNoMoney(search, 'dispatch search');
  const response = await dispatchHandlers({ session: async () => manager, storage: () => f.store, now: () => new Date(NOW) }).get({ request: new Request('https://easygaragecleaning.com/api/dispatch?startDate=2026-09-22&endDate=2026-09-29&includeUnscheduled=true'), env: {} });
  assert.equal(response.status, 200);
  const body = await response.json();
  // FUN-02 adds the static booking and reason vocabulary as body.funnel ('price' is a cancel reason code, not a
  // money field): it must be exactly that list, and everything else in the reply is checked for quote money.
  const { funnel, ...reply } = body;
  assert.deepEqual(funnel, dispatchFunnelOptions());
  assert.equal(body.jobs.find(job => job.id === 'job-money').suggestedDurationMin, 75); assert.ok(body.jobs.find(job => job.id === 'job-money').moneyReady, 'the manager board carries money readiness');
  assertNoMoney(withoutReadiness(reply), 'GET /api/dispatch');
});

// A Firestore REST mask returns only the named paths.
function masked(value, paths) {
  const out = {};
  for (const path of paths) {
    const keys = path.split('.');
    let from = value;
    for (const key of keys) from = from !== null && typeof from === 'object' && !Array.isArray(from) && key in from ? from[key] : undefined;
    if (from === undefined) continue;
    let to = out;
    for (const key of keys.slice(0, -1)) to = to[key] ??= {};
    to[keys.at(-1)] = from;
  }
  return out;
}
const documentName = id => `projects/egcw-1ec83/databases/(default)/documents/jobs/${id}`;

test('the shared jobs scan leaves quote lines out; they are read by id, masked, for sold jobs only', async () => {
  const saved = { 'job-money': moneyJob({ durationOverride: null }), 'job-sent': moneyJob({ id: 'job-sent', durationOverride: null, estimate: { status: 'sent', lineItems: [line({ durationMinutes: 900 })] } }) };
  const REVISION = '2026-09-22T12:00:00.000001Z', requests = [];
  const store = dispatchStorage({}, async (env, url, init = {}) => {
    const target = new URL(url), body = init.body ? JSON.parse(init.body) : null;
    requests.push({ url: target, body });
    if (target.pathname.endsWith(':batchGet')) return Response.json(body.documents.map(name => { const id = name.split('/').at(-1); return saved[id] ? { found: { name, updateTime: REVISION, fields: encodeFirestoreFields(masked(saved[id], body.mask.fieldPaths)) } } : { missing: name }; }));
    const paths = target.searchParams.getAll('mask.fieldPaths');
    return Response.json({ documents: Object.entries(saved).map(([id, job]) => ({ name: documentName(id), updateTime: REVISION, fields: encodeFirestoreFields(masked(job, paths)) })) });
  });
  const rows = await store.jobs(), mask = requests[0].url.searchParams.getAll('mask.fieldPaths');
  for (const path of ['estimate.status', 'durationOverride.minutes', 'durationOverride.reason', 'durationOverride.crewSize', 'durationOverride.source', 'logistics.crew_size', 'estimatedDurationMin', 'crewNeeded', 'requiredCrewSize']) assert.ok(mask.includes(path), path);
  for (const path of ['estimate', 'estimate.lineItems', 'estimate.amount', 'estimate.depositRequired', 'total', 'priceQuoted', 'deposit', 'invoice', 'payments', 'durationOverride', 'logistics']) assert.ok(!mask.includes(path), path);
  assert.deepEqual(rows.map(row => [row.id, row.estimate]), [['job-money', { status: 'accepted' }], ['job-sent', { status: 'sent' }]], 'the shared scan carries no quote line');
  const lined = await withQuoteLines(store, rows);
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1].body, { documents: [documentName('job-money')], mask: { fieldPaths: ['estimate.lineItems'] } }, 'only the sold job is read, and only its lines');
  const dtos = lined.map(row => projectDispatchJob(row, [], NOW));
  assert.deepEqual(dtos.map(dto => [dto.id, dto.suggestedDurationMin, dto.durationSource, dto.durationCoverage]), [['job-money', 75, 'line_items', 'complete'], ['job-sent', 90, 'estimated_duration', null]]);
  assertNoMoney(dtos, 'DTOs from the Firestore REST shape');
  requests.length = 0;
  const found = await store.quoteLines(Array.from({ length: 150 }, (_, index) => index ? `job-${index}` : 'job-money'));
  assert.deepEqual(requests.map(request => request.body.documents.length), [100, 50], 'batchGet is chunked at 100 ids');
  assert.deepEqual([...found.keys()], ['job-money'], 'missing jobs are left out');
  const EMPTY = { suggestedDurationMin: null, durationSource: null, durationCoverage: null, durationCapped: null };
  const changed = await withQuoteLines({ quoteLines: async () => new Map([['job-money', { id: 'job-money', revision: 'newer', estimate: { lineItems: saved['job-money'].estimate.lineItems } }]]) }, rows);
  assert.deepEqual(dispatchDurationFields(changed[0]), EMPTY, 'lines saved after the scan give no suggestion');
  const down = await withQuoteLines({ quoteLines: async () => { throw new Error('unavailable'); } }, rows);
  assert.deepEqual([projectDispatchJob(down[0], [], NOW).suggestedDurationMin, projectDispatchJob(down[1], [], NOW).suggestedDurationMin], [null, 90], 'unreadable lines never become a guess; unsold jobs need none');
  assert.equal(down[1], rows[1]);
  assert.deepEqual(dispatchDurationFields((await withQuoteLines({ quoteLines: async () => new Map() }, rows))[0]), EMPTY, 'a job missing from the read gives no suggestion');
  assert.equal(await withQuoteLines({}, rows), rows, 'a store of whole records is used as it is');
  let asked = 0;
  assert.equal(await withQuoteLines({ quoteLines: async () => { asked++; return new Map(); } }, [rows[1]]).then(list => list[0]), rows[1]);
  assert.equal(asked, 0, 'no sold job, no read');
});

test('dispatch lists read quote lines only for the sold jobs they return', async () => {
  const f = fixture([moneyJob({ durationOverride: null }), moneyJob({ id: 'job-later', date: '2026-10-20', endDate: '2026-10-20', durationOverride: null }), moneyJob({ id: 'job-sent', durationOverride: null, estimate: { status: 'sent', lineItems: [line({ durationMinutes: 900 })] } })]);
  const asked = [];
  const store = { ...f.store, jobs: async () => (await f.store.jobs()).map(({ estimate, ...job }) => estimate ? { ...job, estimate: { status: estimate.status } } : job),
    quoteLines: async ids => { asked.push(ids); return new Map(ids.map(id => { const row = f.rows.get('jobs/' + id); return [id, { id, revision: row.revision, estimate: { lineItems: row.estimate.lineItems } }]; })); } };
  const overview = await dispatchOverview(store, manager, { startDate: '2026-09-22', endDate: '2026-09-29' }, new Date(NOW));
  assert.deepEqual(asked, [['job-money']], 'the unsold job and the job outside the range are not read');
  assert.deepEqual(overview.jobs.map(job => [job.id, job.suggestedDurationMin, job.durationSource]), [['job-money', 75, 'line_items'], ['job-sent', 90, 'estimated_duration']]);
  const search = await dispatchSearch(store, manager, { q: 'Synthetic Customer' }, new Date(NOW));
  assert.deepEqual(asked[1].toSorted(), ['job-later', 'job-money']);
  assert.deepEqual(search.results.map(row => [row.job.id, row.job.suggestedDurationMin, row.job.durationSource]).toSorted(), [['job-later', 75, 'line_items'], ['job-money', 75, 'line_items'], ['job-sent', 90, 'estimated_duration']]);
  assertNoMoney([overview, search], 'masked list reads');
  await dispatchOverview(store, manager, { view: 'job', jobId: 'job-money' }, new Date(NOW));
  assert.equal(asked.length, 2, 'the single-job view reads the whole record');
});

test('dispatch saves an expected duration of 15 minutes to one week and audits it', async () => {
  const f = fixture();
  const created = await f.mutate({ action: 'schedule.create', requestId: randomUUID(), customerId: 'c1', kind: 'job', changes: { date: '2026-09-23', time: '08:00', endTime: '10:00', assignedCrew: ['crew1'], jobInstructions: 'Synthetic scope', estimatedDurationMin: 180 } });
  assert.deepEqual([created.job.estimatedDurationMin, created.job.suggestedDurationMin, created.job.durationSource], [180, 180, 'estimated_duration'], 'the saved estimate beats the two-hour span');
  assert.equal(created.job.endTime, '10:00', 'the expected duration never moves the saved schedule');
  const row = () => f.rows.get('jobs/' + created.job.id);
  assert.deepEqual(row().durationOverride, dispatchDurationOverride(180, created.job.crewNeeded, 'zacb', NOW), 'the saved length records the crew it was set for');
  const input = f.edit(created.job, { estimatedDurationMin: 2880 }), updated = await f.mutate(input);
  assert.deepEqual([updated.job.estimatedDurationMin, updated.job.suggestedDurationMin], [2880, 2880]);
  const receipt = f.rows.get('dispatchOperations/' + input.requestId);
  assert.deepEqual([receipt.before.estimatedDurationMin, receipt.after.estimatedDurationMin, receipt.before.durationOverride.minutes, receipt.after.durationOverride.minutes], [180, 2880, 180, 2880]);
  assert.equal((await f.mutate(f.edit(updated.job, { estimatedDurationMin: 10080 }))).job.estimatedDurationMin, 10080);
  const latest = () => ({ id: created.job.id, revision: row().revision });
  for (const estimatedDurationMin of [14, 10081, 90.5, '120', true, 0]) {
    const before = latest().revision;
    await assert.rejects(f.mutate(f.edit(latest(), { estimatedDurationMin })), error => error.code === 'dispatch_invalid_field' && error.status === 400, String(estimatedDurationMin));
    assert.equal(latest().revision, before, 'a rejected value writes nothing');
  }
  const clear = f.edit(latest(), { estimatedDurationMin: null }), cleared = await f.mutate(clear);
  assert.deepEqual([cleared.job.estimatedDurationMin, cleared.job.suggestedDurationMin, cleared.job.durationSource, row().durationOverride], [null, 120, 'schedule_span', null], 'null clears the length and its record');
  assert.deepEqual([f.rows.get('dispatchOperations/' + clear.requestId).after.estimatedDurationMin, crewJobProjection(row()).estimatedDurationMin], [null, null], 'crews read a cleared length as absent, not 0');
  const block = await f.mutate({ action: 'schedule.create', requestId: randomUUID(), kind: 'blocked', changes: { date: '2026-09-24', time: '08:00', endTime: '10:00' } });
  await assert.rejects(f.mutate(f.edit(block.job, { estimatedDurationMin: 60 })), error => error.code === 'dispatch_patch_not_allowed');
});

test('a length saved in dispatch wins over the lines and the walkthrough override for its crew, and null clears it', async () => {
  // The lines give 75 minutes for the crew of 2; the walkthrough manager recorded 90.
  const f = fixture([{ ...moneyJob(), date: '', time: '', endDate: '', endTime: '', status: 'unscheduled', pipelineStatus: 'unscheduled' }]);
  const before = projectDispatchJob(f.rows.get('jobs/job-money'), [], NOW);
  assert.deepEqual([before.suggestedDurationMin, before.durationSource], [90, 'duration_override']);
  const saved = await f.mutate(f.edit({ id: 'job-money', revision: 'seed' }, { estimatedDurationMin: 300 }));
  assert.deepEqual([saved.job.estimatedDurationMin, saved.job.suggestedDurationMin, saved.job.durationSource], [300, 300, 'estimated_duration'], 'the dispatcher value never drops back to the lines');
  assert.deepEqual(f.rows.get('jobs/job-money').durationOverride, dispatchDurationOverride(300, 2, 'zacb', NOW));
  const bigger = await f.mutate(f.edit(saved.job, { crewNeeded: 3 }));
  assert.deepEqual([bigger.job.suggestedDurationMin, bigger.job.durationSource], [60, 'line_items'], 'another crew is recomputed: 150 person-minutes for 3 is 50, rounded up to 60');
  const both = await f.mutate(f.edit(bigger.job, { crewNeeded: 4, estimatedDurationMin: 120 }));
  assert.deepEqual([both.job.suggestedDurationMin, both.job.durationSource, f.rows.get('jobs/job-money').durationOverride.crewSize], [120, 'estimated_duration', 4], 'a length saved with a new crew is recorded for that crew');
  const cleared = await f.mutate(f.edit(both.job, { estimatedDurationMin: null }));
  assert.deepEqual([cleared.job.suggestedDurationMin, cleared.job.durationSource], [45, 'line_items'], 'cleared: 150 person-minutes for 4 is 38, rounded up to 45');
  assertNoMoney([saved.job, bigger.job, both.job, cleared.job], 'the mutation responses');
});

// Synthetic signed itemized plan (the walkthrough-handoff-items.test.mjs shape): 120
// person-minutes suggest 60 minutes for the crew of 2; the manager records 180.
const signedPlan = () => ({ client: { name: 'Synthetic Customer', phone: '+1 (970) 555-0100', email: 'synthetic@example.invalid', address: '100 Synthetic Street' },
  quote: { title: 'Garage reset', total: 1400, deposit: 700, job_date: '2026-09-24', start_time: '09:00', end_time: '12:00', estimated_duration_min: 180, duration_override_reason: 'Synthetic narrow alley adds carry time',
    line_items: [{ id: 'cleanout', kind: 'service', name: 'Garage cleanout and reset', description: 'Synthetic scope', quantity: 1, unitCents: 140000, totalCents: 140000, durationMinutes: 120 }] },
  acceptance: { accepted_at: '2026-09-22T11:45:00.000Z', accepted_by: 'Synthetic Customer', signature_captured: true, method: 'in_person_signature', terms_version: '2026-09-deposit50' }, signature: 'data:image/png;base64,iVBORw0KGgo=', terms_version: '2026-09-deposit50', terms_accepted: true, photos: { before: 3 },
  scope: { keep_items: 'Blue bicycle', remove_items: 'Empty cartons', exclusions: 'Locked cabinet', finish: ['cleanout'] }, discovery: { success: 'Park a vehicle' }, logistics: { crew_size: 2, assigned_to: 'Crew of 2', notes: 'Use side gate' },
  internal_notes: 'Synthetic brief', notes: 'Synthetic note', client_checklists: { preJob: [{ id: 'keep-bike', label: 'Protect blue bicycle', detail: 'Move to safe area', critical: true }], postJob: [{ id: 'scope-review', label: 'Review with customer', detail: 'Confirm agreed scope' }] } });

test('a walkthrough override holds only for the crew it was judged for, end to end', async () => {
  const f = fixture(), handoff = await saveWalkthroughHandoff(f.store, manager, { requestId: randomUUID(), customerId: 'c1', plan: signedPlan() }, NOW);
  const id = handoff.job.id, saved = f.rows.get('jobs/' + id);
  assert.deepEqual([saved.crewNeeded, saved.logistics.crew_size, saved.estimatedDurationMin, saved.durationOverride.minutes, saved.estimate.status], [2, 2, 180, 180, 'accepted']);
  const { job } = await dispatchOverview(f.store, manager, { view: 'job', jobId: id }, new Date(NOW));
  assert.deepEqual([job.durationSource, job.suggestedDurationMin], ['duration_override', 180]);
  const bigger = await f.mutate(f.edit({ id, revision: saved.revision }, { crewNeeded: 4 }));
  assert.deepEqual([bigger.job.durationSource, bigger.job.suggestedDurationMin], ['line_items', 30], 'the override was judged for 2; 120 person-minutes for 4 is 30');
  const back = await f.mutate(f.edit(bigger.job, { crewNeeded: 2 }));
  assert.deepEqual([back.job.durationSource, back.job.suggestedDurationMin], ['duration_override', 180], 'the judged crew gets the override back');
});

test('crew and open-shift views never read a multi-day or cleared length as one shift', () => {
  const lines = readFileSync(new URL('../employee-suite.js', import.meta.url), 'utf8').split('\n');
  const take = prefix => { const found = lines.find(row => row.startsWith(prefix)); assert.ok(found, prefix); return found; };
  const context = {};
  vm.runInNewContext([take('const minutes='), take('function eventTime('), take('function scheduledJobMinutes('), take('function expectedShiftHours('), 'this.scheduledJobMinutes=scheduledJobMinutes;this.expectedShiftHours=expectedShiftHours;'].join('\n'), context);
  const job = { time: '08:00', endTime: '14:00' };
  assert.deepEqual([300, 1440, 1455, 2880, 10080, null, undefined].map(estimatedDurationMin => context.scheduledJobMinutes({ ...job, estimatedDurationMin })), [300, 1440, 360, 360, 360, 360, 360]);
  assert.equal(context.expectedShiftHours({ ...job, estimatedDurationMin: 10080 }), 7.5, 'the schedule span, not a 169.5-hour shift');
  assert.deepEqual([2880, null, undefined].map(estimatedDurationMin => crewJobProjection({ id: 'job-crew', type: 'job', estimatedDurationMin }).estimatedDurationMin), [2880, null, null]);
});

function dispatchHelpers() {
  const source = readFileSync(new URL('../employee-dispatch.js', import.meta.url), 'utf8');
  const exposed = source.replace(/\}\)\(\);\s*$/, 'window.__duration={durationSuggestion,durationText,durationNote,durationOptions};})();');
  assert.notEqual(exposed, source, 'employee-dispatch.js still ends in its IIFE');
  const window = { addEventListener() {} };
  vm.runInNewContext(exposed, { window, document: {}, sessionStorage: {}, crypto: globalThis.crypto, Intl, Date, URLSearchParams, Event: class {} });
  // Values cross the vm realm; compare them as plain JSON.
  return Object.fromEntries(Object.entries(window.__duration).map(([name, fn]) => [name, (...args) => JSON.parse(JSON.stringify(fn(...args)) ?? 'null')]));
}

test('the Hub offers only informative, well-formed suggestions and labels them in the duration list', () => {
  const { durationSuggestion, durationText, durationNote, durationOptions } = dispatchHelpers();
  assert.deepEqual(durationSuggestion({ suggestedDurationMin: 165, durationSource: 'line_items' }), { minutes: 165, source: 'line_items', partial: false, capped: false });
  assert.deepEqual(durationSuggestion({ suggestedDurationMin: 1440, durationSource: 'line_items', durationCoverage: 'partial', durationCapped: true }), { minutes: 1440, source: 'line_items', partial: true, capped: true });
  assert.equal(durationSuggestion({ suggestedDurationMin: 90, durationSource: 'estimated_duration', durationCoverage: 'partial', durationCapped: 'yes' }).partial || durationSuggestion({ suggestedDurationMin: 90, durationSource: 'estimated_duration', durationCapped: 'yes' }).capped, false, 'only line coverage is partial, and only true caps');
  const note = (job, extra = {}) => durationNote(job, { ...durationSuggestion({ suggestedDurationMin: 165, durationSource: 'line_items', ...extra }) });
  assert.equal(note({ crewNeeded: 3 }), 'Suggested from the sold quote: 2 hr 45 min for a crew of 3.');
  assert.equal(note({ crewNeeded: 3 }, { durationCoverage: 'partial' }), 'Suggested from the sold quote: 2 hr 45 min for a crew of 3. Some sold lines have no time estimate, so allow extra time.');
  assert.equal(durationNote({}, durationSuggestion({ suggestedDurationMin: 1440, durationSource: 'line_items', durationCapped: true })), 'Suggested from the sold quote: 24 hr for a crew of 1. The lines add up to more than 24 hr, so plan the work across days.');
  assert.equal(durationNote({ crewNeeded: 2 }, durationSuggestion({ suggestedDurationMin: 300, durationSource: 'estimated_duration' })), 'Suggested from the saved estimate: 5 hr.');
  for (const durationSource of ['duration_override', 'estimated_duration']) assert.equal(durationSuggestion({ suggestedDurationMin: 90, durationSource })?.minutes, 90);
  for (const job of [null, {}, { suggestedDurationMin: 120, durationSource: 'default' }, { suggestedDurationMin: 180, durationSource: 'schedule_span' }, { suggestedDurationMin: null, durationSource: null }, { suggestedDurationMin: 170, durationSource: 'line_items' }, { suggestedDurationMin: 10095, durationSource: 'line_items' }, { suggestedDurationMin: '165', durationSource: 'line_items' }, { suggestedDurationMin: 165, durationSource: 'toString' }])
    assert.equal(durationSuggestion(job), null, JSON.stringify(job));
  assert.deepEqual([15, 60, 165, 480, 2010].map(durationText), ['15 min', '1 hr', '2 hr 45 min', '8 hr', '33 hr 30 min']);
  const plain = durationOptions(null).map(([value]) => value);
  assert.deepEqual(plain, ['', '30', '60', '90', '120', '180', '240', '360', '480'], 'no suggestion keeps the original list');
  const inserted = durationOptions({ minutes: 165, source: 'line_items' });
  assert.deepEqual(inserted.map(([value]) => value), ['', '30', '60', '90', '120', '165', '180', '240', '360', '480']);
  assert.equal(inserted[5][1], '2 hr 45 min · suggested');
  const existing = durationOptions({ minutes: 180, source: 'line_items' });
  assert.deepEqual([existing.length, existing[5][1]], [9, '3 hours · suggested']);
  assert.deepEqual(durationOptions({ minutes: 600, source: 'estimated_duration' }).at(-1), ['600', '10 hr · suggested']);
  assert.equal(durationOptions(null)[5][1], '3 hours', 'labels are not shared between forms');
});
