process.env.TZ = 'Asia/Tokyo';
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import { applyWrite } from './helpers/commit-write.mjs';
import { jobCostingHandlers } from '../functions/api/job-costing.js';
import { moneyHandlers } from '../functions/api/money.js';
import { integrationStatusHandlers } from '../functions/api/integration-status.js';
import { payOwnerOnly, seesLaborCost, seesOthersPay, staffPayOwnerOnly } from '../functions/_lib/pay-visibility.js';

// JOB-COST-PRIVACY: labor dollars are owner-only while EGC_STAFF_PAY_OWNER_ONLY is on. The rates below are
// canaries: no non-owner response may contain one, a labor dollar figure, or a pair of figures whose ratio is one.
const NOW = '2026-10-05T18:00:00.000Z';
const RATES = { 'crew.solo': 37.91, 'crew.two': 52.37, 'crew.three': 23.17 };
const NAMES = { 'crew.solo': 'Synthetic Solo', 'crew.two': 'Synthetic Two', 'crew.three': 'Synthetic Three' };
const at = (date, time) => `${date}T${time}:00-06:00`;
// parts: [kind, jobId, start HH:MM]; each segment runs until the next part or clock-out.
function card(id, employee, date, from, to, parts, extra = {}) {
  const segments = parts.map(([kind, jobId, start], index) => ({ id: `${id}-segment-${index}`, kind, jobId, jobLabel: `Synthetic ${jobId}`, startedAt: at(date, start), endedAt: at(date, parts[index + 1]?.[2] ?? to), actorId: employee, endReason: 'job_switch' }));
  return { id, employee, employeeName: NAMES[employee], payType: 'hourly', hourlyRate: RATES[employee], clockInAt: at(date, from), clockOutAt: at(date, to), status: 'submitted', approvalStatus: 'approved', breaks: [],
    jobTracking: { version: 1, coverageStartedAt: at(date, from), partialHistory: false, segments }, ...extra };
}
const WEEK = ['2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25'];
const solo = () => [card('solo-1', 'crew.solo', '2026-09-21', '08:00', '13:00', [['travel', 'job-solo', '08:00'], ['work', 'job-solo', '09:00']])];
const team = () => [
  card('team-2', 'crew.two', '2026-09-22', '08:00', '13:00', [['work', 'job-team', '08:00']]),
  card('team-3', 'crew.three', '2026-09-22', '08:00', '14:30', [['work', 'job-team', '08:00'], ['work', 'job-solo', '12:00']]),
  card('team-2b', 'crew.two', '2026-09-23', '08:00', '11:00', [['work', 'job-team', '08:00']], { approvalStatus: 'pending' }),
];
// 50 hours for one employee in one week: the weekly overtime premium is spread over both jobs.
const overtime = () => WEEK.map((date, index) => card(`ot-${index}`, 'crew.solo', date, '06:00', '16:00', [['work', index < 3 ? 'job-ot-a' : 'job-ot-b', '06:00']], index === 4 ? { approvalStatus: 'pending' } : {}));
const mixed = () => {
  const walk = card('walk-1', 'crew.two', '2026-09-24', '08:00', '12:00', [['work', 'walk-1', '08:00'], ['work', 'job-team', '10:00']]);
  walk.jobTracking.segments[0].visitKind = 'walkthrough';
  return [...solo(), ...team(), walk,
    card('norate', 'crew.three', '2026-09-25', '08:00', '10:00', [['work', 'job-norate', '08:00']], { hourlyRate: undefined }),
    card('salary', 'crew.two', '2026-09-25', '12:00', '15:00', [['work', 'job-salary', '12:00']], { payType: 'salary' }),
    { ...card('open', 'crew.solo', '2026-09-25', '08:00', '12:00', [['work', 'job-solo', '08:00']]), clockOutAt: '', status: 'active', approvalStatus: 'open' }];
};
const FIXTURES = { solo, team, overtime, mixed };
const QUERIES = ['?start=2026-09-21&end=2026-09-28', '?start=2026-09-21&end=2026-09-28&includeTravel=1', '?start=2026-09-21&end=2026-09-28&jobId=job-solo', '?start=2026-09-21&end=2026-09-28&jobId=walk-1', '?start=2026-09-24&end=2026-09-26'];

const ROLES = {
  owner: { user: 'zacb', role: 'owner', businessAccess: true, displayName: 'Synthetic Owner' },
  manager: { user: 'tylerg', role: 'manager', businessAccess: true, displayName: 'Synthetic Manager' },
  managerTwo: { user: 'alexk', role: 'manager', businessAccess: true, displayName: 'Synthetic Manager Two' },
  ownerRoleNotOwner: { user: 'tylerg', role: 'owner', businessAccess: true, displayName: 'Synthetic Manager' },
  crew_lead: { user: 'crew.lead', role: 'crew_lead', businessAccess: false, displayName: 'Synthetic Lead' },
  crew: { user: 'crew.solo', role: 'crew', businessAccess: false, displayName: 'Synthetic Solo' },
  sales: { user: 'sales.one', role: 'sales', businessAccess: false, displayName: 'Synthetic Sales' },
};
const STAFF_ROLES = { owner: ['owner'], manager: ['manager'], managerTwo: ['manager', 'sales'], ownerRoleNotOwner: ['owner', 'manager'], crew_lead: ['crew_lead'], crew: ['crew'], sales: ['sales'] };
const ENVS = { legacy: {}, staffRoles: { EGC_STAFF_ROLE_PERMISSIONS: 'true' } };
const sessionFor = (role, mode) => ({ ...ROLES[role], ...(mode === 'staffRoles' ? { staffRoles: STAFF_ROLES[role] } : {}) });

const costing = (role, mode, fixture) => jobCostingHandlers({ session: async () => sessionFor(role, mode), read: async () => FIXTURES[fixture](), now: () => new Date(NOW) }).get;
const costingRequest = query => new Request(`https://easygaragecleaning.com/api/job-costing${query}`);

// Money: owner-entered direct costs on a job (labor is a canary), read and changed through /api/money.
const LABOR_CENTS = 15164, LEGACY_LABOR = 189.55;
function moneyStore() {
  const docs = new Map([
    ['jobs/job-costed', { id: 'job-costed', revision: 'r0', type: 'job', customerId: 'c1', customer: 'Synthetic Customer', serviceType: 'Garage transformation', date: '2026-09-24', status: 'completed', total: 900, priceQuoted: 900, laborCost: LEGACY_LABOR,
      hoursOnSite: 4, crewSize: 1, estimate: { number: 'EST-000001', status: 'accepted', amount: 900, depositRequired: 450, lineItems: [{ id: 'line-1', kind: 'service', name: 'Synthetic cleanout', quantity: 1, amount: 900 }] },
      invoice: { number: 'INV-000001', status: 'issued', amount: 900, amountCents: 90000, issuedAt: '2026-09-24T20:00:00.000Z', dueDate: '2026-10-01' },
      costs: { labor: LABOR_CENTS / 100, laborCents: LABOR_CENTS, disposal: 85.5, disposalCents: 8550, materials: 0, materialsCents: 0, fuel: 12, fuelCents: 1200, processing: 0, processingCents: 0, other: 0, otherCents: 0, recordedAt: '2026-09-25T18:00:00.000Z', recordedBy: 'zacb', source: 'egc_hub' } }],
    ['jobs/job-uncosted', { id: 'job-uncosted', revision: 'r0', type: 'job', customerId: 'c2', customer: 'Synthetic Other', serviceType: 'Garage transformation', date: '2026-09-25', status: 'scheduled', laborCost: LEGACY_LABOR }],
  ]);
  let n = 0;
  return {
    read: async (collection, id) => structuredClone(docs.get(`${collection}/${id}`) ?? null),
    jobs: async () => [...docs].filter(([key]) => key.startsWith('jobs/')).map(([, row]) => structuredClone(row)),
    async commit(writes) {
      for (const write of writes) { const old = docs.get(`${write.collection}/${write.id}`); if (write.revision ? old?.revision !== write.revision : old) throw Object.assign(new Error('Conflict'), { code: 'money_revision_conflict', status: 409 }); }
      for (const write of writes) docs.set(`${write.collection}/${write.id}`, { ...applyWrite(write.revision ? docs.get(`${write.collection}/${write.id}`) : {}, write), id: write.id, revision: `r${++n}` });
    },
    laborRecords: async () => [...docs].filter(([key]) => key.startsWith('jobLaborCosts/')).map(([, row]) => structuredClone(row)),
  };
}
const money = (role, mode, store = moneyStore()) => moneyHandlers({ session: async () => sessionFor(role, mode), storage: () => store, now: () => new Date(NOW) });
const moneyGet = query => new Request(`https://easygaragecleaning.com/api/money${query}`, { headers: { 'Sec-Fetch-Site': 'same-origin' } });
const moneyPost = body => new Request('https://easygaragecleaning.com/api/money', { method: 'POST', headers: { Origin: 'https://easygaragecleaning.com', 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const REQUEST_IDS = ['6f1c7c1e-5d8a-4c55-9d2e-0a8f4f0e7a01', '6f1c7c1e-5d8a-4c55-9d2e-0a8f4f0e7a02'];
const MONEY_WRITES = [
  { action: 'costs.save', requestId: REQUEST_IDS[0], jobId: 'job-costed', expectedRevision: 'r0', costs: { laborCents: LABOR_CENTS, disposalCents: 9000, materialsCents: 0, fuelCents: 1200, processingCents: 0, otherCents: 0 } },
  { action: 'estimate.mark_sent', requestId: REQUEST_IDS[1], jobId: 'job-costed', expectedRevision: 'r0', channel: 'email' },
];
// Integration status: configuration readiness plus, for business users, a (stubbed) revocation state.
const integrationStatus = (role, mode) => integrationStatusHandlers({ session: async () => sessionFor(role, mode), revocations: () => null, now: () => new Date(NOW) });
const MONEY_READS = ['?jobId=job-costed', '?jobId=job-uncosted', '?view=invoices', '?view=invoices&format=csv', '?view=payments&format=csv'];

// Every response a role gets from the job-cost endpoints for one env, keyed for a byte-for-byte comparison.
async function responses(role, mode, env) {
  const out = [], text = async response => `${response.status} ${response.headers.get('Content-Type')}\n${await response.text()}`;
  for (const fixture of Object.keys(FIXTURES)) for (const query of QUERIES) out.push([`job-costing ${fixture} ${query}`, await text(await costing(role, mode, fixture)({ request: costingRequest(query), env }))]);
  for (const query of MONEY_READS) out.push([`money GET ${query}`, await text(await money(role, mode).get({ request: moneyGet(query), env }))]);
  for (const body of MONEY_WRITES) out.push([`money POST ${body.action}`, await text(await money(role, mode).post({ request: moneyPost(body), env: { ...env, MONEY_API_ENABLED: 'true' } }))]);
  out.push(['integration-status GET', await text(await integrationStatus(role, mode).get({ request: new Request('https://easygaragecleaning.com/api/integration-status'), env }))]);
  return out;
}
// The snapshot lists each (env, role, request) with the sha256 of its exact response, then every distinct response once.
const sha = text => createHash('sha256').update(text).digest('hex').slice(0, 16);
function render(matrix) {
  const bodies = new Map(), index = [];
  for (const [key, rows] of matrix) for (const [label, body] of rows) { bodies.set(sha(body), body); index.push(`${key} | ${label} | ${sha(body)}`); }
  return `${index.join('\n')}\n${[...bodies].sort(([a], [b]) => a.localeCompare(b)).map(([hash, body]) => `======== ${hash}\n${body}\n`).join('')}`;
}
const snapshot = new URL('./snapshots/job-cost-privacy-baseline.snap', import.meta.url);
const matrix = async env => { const out = []; for (const mode of Object.keys(ENVS)) for (const role of Object.keys(ROLES)) out.push([`${mode} ${role}`, await responses(role, mode, { ...ENVS[mode], ...env })]); return out; };

test('with EGC_STAFF_PAY_OWNER_ONLY=false every role gets byte-identical job-cost responses to before the change', async () => {
  const text = render(await matrix({ EGC_STAFF_PAY_OWNER_ONLY: 'false' }));
  if (process.env.UPDATE_SNAPSHOTS === '1') { mkdirSync(new URL('./snapshots/', import.meta.url), { recursive: true }); writeFileSync(snapshot, text); }
  assert.ok(existsSync(snapshot), 'the baseline snapshot was recorded from the code before JOB-COST-PRIVACY');
  assert.equal(text, readFileSync(snapshot, 'utf8'), 'a flag-off job-cost response changed');
});

// Storage, not just responses: with the flag off every save leaves the job the way the code before this change did
// (costs.save wrote the whole costs map, labor included, and left laborCost; the Hub dialog wrote costs.labor), and
// the private record only mirrors it, so reverting the code shows the same figure.
test('with EGC_STAFF_PAY_OWNER_ONLY=false, money and labor saves leave the job as the code before this change did', async () => {
  const { jobLaborCostsHandlers } = await import('../functions/api/job-labor-costs.js');
  const env = { EGC_STAFF_PAY_OWNER_ONLY: 'false', MONEY_API_ENABLED: 'true' };
  for (const role of ['manager', 'owner']) {
    const store = moneyStore(), response = await money(role, 'legacy', store).post({ request: moneyPost(MONEY_WRITES[0]), env });
    assert.equal(response.status, 200, role);
    const job = await store.read('jobs', 'job-costed');
    assert.deepEqual(job.costs, { recordedAt: NOW, recordedBy: ROLES[role].user, source: 'egc_hub', labor: LABOR_CENTS / 100, laborCents: LABOR_CENTS, disposal: 90, disposalCents: 9000, materials: 0, materialsCents: 0, fuel: 12, fuelCents: 1200, processing: 0, processingCents: 0, other: 0, otherCents: 0 }, role);
    assert.equal(job.laborCost, LEGACY_LABOR, `${role}: the older top-level copy stays, as before`);
    assert.equal((await store.read('jobLaborCosts', 'job-costed')).laborCents, LABOR_CENTS, `${role}: the record mirrors the job`);
    // The Hub dialog's labor save: only costs.labor changes on the job, as the dialog's own merge save did.
    const saved = await (await jobLaborCostsHandlers({ session: async () => sessionFor(role, 'legacy'), storage: () => store, now: () => new Date(NOW) }).post({
      request: new Request('https://easygaragecleaning.com/api/job-labor-costs', { method: 'POST', headers: { Origin: 'https://easygaragecleaning.com', 'Content-Type': 'application/json' }, body: JSON.stringify({ requestId: crypto.randomUUID(), jobId: 'job-costed', laborCents: 20250, expectedRevision: (await store.read('jobLaborCosts', 'job-costed')).revision }) }), env })).json();
    assert.equal(saved.ok, true, role);
    const after = await store.read('jobs', 'job-costed');
    assert.deepEqual([after.costs.labor, after.costs.laborCents, after.costs.disposal, after.laborCost], [202.5, LABOR_CENTS, 90, LEGACY_LABOR], role);
  }
});

// ---- With the flag on (the default) ------------------------------------------------------------------------------
const NON_OWNERS = ['manager', 'managerTwo', 'ownerRoleNotOwner', 'crew_lead', 'crew', 'sales'];
const HIDDEN_VIEWERS = ['manager', 'managerTwo', 'ownerRoleNotOwner'];
const ON_ENVS = [{}, { EGC_STAFF_PAY_OWNER_ONLY: 'true' }, { EGC_STAFF_PAY_OWNER_ONLY: 'FALSE' }, { EGC_STAFF_PAY_OWNER_ONLY: '0' }];
const numbers = (value, out = []) => { if (typeof value === 'number') out.push(value); else if (value && typeof value === 'object') for (const item of Object.values(value)) numbers(item, out); return out; };
const DOLLAR_KEYS = new Set(['straightCost', 'overtimePremium', 'cost', 'approvedCost', 'projectedCost']);
const dollarsOf = (value, out = new Set()) => { if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) { if (DOLLAR_KEYS.has(key) && typeof item === 'number' && item) out.add(item); else dollarsOf(item, out); } return out; };
// A rate, its time-and-a-half or its half-time premium rate, as a number, a string or a ratio of any two figures.
const RATE_FIGURES = Object.values(RATES).flatMap(rate => [rate, rate * 1.5, rate / 2]);
const derivesRate = values => values.flatMap(a => values.filter(b => b > 0).map(b => a / b)).filter(ratio => RATE_FIGURES.some(rate => Math.abs(ratio - rate) < 0.01));
function assertNoLaborDollars(text, owner = null, label = '') {
  for (const rate of Object.values(RATES)) assert.equal(text.includes(String(rate)), false, `${label}: rate ${rate} appears`);
  for (const canary of [String(LABOR_CENTS), String(LABOR_CENTS / 100), String(LEGACY_LABOR)]) assert.equal(text.includes(canary), false, `${label}: labor canary ${canary} appears`);
  let body = null; try { body = JSON.parse(text.slice(text.indexOf('\n') + 1)); } catch { return; }
  const values = numbers(body);
  assert.deepEqual(derivesRate(values), [], `${label}: two figures divide into a rate`);
  if (owner) for (const dollars of dollarsOf(owner)) assert.equal(values.includes(dollars), false, `${label}: the owner's labor figure ${dollars} appears`);
}

test('the canary check itself finds the rate in the owner\'s response (the detector works)', async () => {
  const owner = await (await costing('owner', 'legacy', 'solo')({ request: costingRequest(QUERIES[0]), env: {} })).json();
  assert.equal(owner.jobs[0].approved.cost / owner.jobs[0].approved.laborHours, RATES['crew.solo'], 'one employee alone on a job: cost over hours is the rate');
  assert.ok(derivesRate(numbers(owner.jobs[0].approved)).length, 'cost and hours divide into the rate');
  assert.throws(() => assertNoLaborDollars(`200 x\n${JSON.stringify(owner)}`, null, 'owner'), /labor canary|divide into a rate/);
});

test('flag on: the owner, and roles that were already refused, get the same bytes as before', async () => {
  const baseline = new Map(await matrix({ EGC_STAFF_PAY_OWNER_ONLY: 'false' }));
  for (const env of ON_ENVS) for (const [key, rows] of await matrix(env)) {
    if (/ (manager|managerTwo|ownerRoleNotOwner)$/.test(key)) continue;
    assert.deepEqual(rows, baseline.get(key), `${key} ${JSON.stringify(env)}`);
  }
});

test('flag on: no non-owner response from job costing, money reads, reports, CSV or money writes carries labor dollars or a rate', async () => {
  for (const env of ON_ENVS) for (const mode of Object.keys(ENVS)) for (const role of NON_OWNERS) {
    for (const [label, text] of await responses(role, mode, { ...ENVS[mode], ...env })) {
      let owner = null;
      if (label.startsWith('job-costing')) { const [, fixture, query] = label.split(' '); owner = await (await costing('owner', mode, fixture)({ request: costingRequest(query), env: ENVS[mode] })).json(); }
      assertNoLaborDollars(text, owner, `${mode} ${role} ${label} ${JSON.stringify(env)}`);
    }
  }
});

// Every key a hidden job-costing response may carry; the dollar keys are allowed only as null in totals.
const HIDDEN_KEYS = new Set(['ok', 'policy', 'name', 'weeklyHours', 'dailyHours', 'consecutiveHours', 'consecutiveGapMinutes', 'multiplier', 'start', 'end', 'endExclusive', 'jobId', 'includeTravel', 'asOf', 'source', 'jobs', 'totals',
  'walkthroughLabor', 'costedAs', 'visits', 'needsReviewCount', 'openShifts', 'legacyAssociationOnlyCount', 'coverage', 'complete', 'reasons', 'laborCostHidden', 'jobLabel', 'approved', 'pending', 'projected', 'employees',
  'approvedTimecards', 'pendingTimecards', 'workHours', 'travelHours', 'laborHours', 'overtimeHours', 'employee', 'approvedHours', 'pendingHours', 'approvedOvertimeHours', 'pendingOvertimeHours']);
function hiddenShape(value, path = '') {
  if (Array.isArray(value)) return value.forEach((item, index) => hiddenShape(item, `${path}[${index}]`));
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) {
    const at = `${path}.${key}`;
    if (['straightCost', 'overtimePremium', 'cost'].includes(key) && /^(\.walkthroughLabor)?\.totals\.(approved|pending|projected)$/.test(path)) { assert.equal(item, null, `${at} is null, never 0`); continue; }
    assert.ok(HIDDEN_KEYS.has(key), `${at} is not an hours-only field`);
    hiddenShape(item, at);
  }
}
const withoutPayReasons = reasons => reasons.filter(reason => !['missing_rate', 'missing_pto_rate', 'non_hourly_pay_type'].includes(reason));
const pick = bucket => ({ workHours: bucket.workHours, travelHours: bucket.travelHours, laborHours: bucket.laborHours });
const hoursOf = row => ({ jobId: row.jobId, jobLabel: row.jobLabel, approved: pick(row.approved), pending: pick(row.pending), projected: pick(row.projected), employees: row.employees.map(({ employee, name, approvedHours, pendingHours }) => ({ employee, name, approvedHours, pendingHours })),
  counts: [row.approvedTimecards, row.pendingTimecards, row.openShifts, row.needsReviewCount, row.legacyAssociationOnlyCount] });
const byId = rows => rows.map(hoursOf).sort((a, b) => a.jobId.localeCompare(b.jobId));

test('flag on: a manager gets the owner\'s hours, employees and jobs with every labor dollar removed', async () => {
  for (const mode of Object.keys(ENVS)) for (const role of HIDDEN_VIEWERS) for (const fixture of Object.keys(FIXTURES)) for (const query of QUERIES) {
    const label = `${mode} ${role} ${fixture} ${query}`, response = await costing(role, mode, fixture)({ request: costingRequest(query), env: ENVS[mode] });
    assert.equal(response.status, 200, label); assert.equal(response.headers.get('Cache-Control'), 'no-store');
    const body = await response.json(), owner = await (await costing('owner', mode, fixture)({ request: costingRequest(query), env: ENVS[mode] })).json();
    assert.equal(body.laborCostHidden, true, label);
    hiddenShape(body);
    assert.deepEqual(byId(body.jobs), byId(owner.jobs), `${label}: same jobs, hours and employees`);
    assert.deepEqual(byId(body.walkthroughLabor.visits), byId(owner.walkthroughLabor.visits), `${label}: same walkthrough hours`);
    for (const totals of ['totals', 'walkthroughLabor']) for (const key of ['approved', 'pending', 'projected']) {
      const hidden = totals === 'totals' ? body.totals[key] : body.walkthroughLabor.totals[key], full = totals === 'totals' ? owner.totals[key] : owner.walkthroughLabor.totals[key];
      assert.deepEqual(pick(hidden), pick(full), `${label} ${totals}.${key}`);
      assert.deepEqual([hidden.straightCost, hidden.overtimePremium, hidden.cost], [null, null, null], `${label}: hidden totals are null, never 0`);
    }
    assert.deepEqual(body.coverage.reasons, withoutPayReasons(owner.coverage.reasons), `${label}: coverage`);
    assert.equal(body.coverage.complete, !body.coverage.reasons.length);
    for (const key of ['policy', 'start', 'end', 'endExclusive', 'jobId', 'includeTravel', 'asOf', 'source', 'needsReviewCount', 'openShifts', 'legacyAssociationOnlyCount']) assert.deepEqual(body[key], owner[key], `${label} ${key}`);
    // Ordered by hours, never by cost, so the order cannot rank employees' rates.
    assert.deepEqual(body.jobs.map(row => row.jobId), [...body.jobs].sort((a, b) => b.projected.laborHours - a.projected.laborHours || a.jobId.localeCompare(b.jobId)).map(row => row.jobId));
  }
});

test('hidden overtime is allocated hours, and pay-only coverage reasons and missing-rate counts are left out', async () => {
  const body = await (await costing('manager', 'legacy', 'overtime')({ request: costingRequest(QUERIES[0]), env: {} })).json(), jobs = Object.fromEntries(body.jobs.map(row => [row.jobId, row]));
  // 40 approved hours carry no overtime; the pending fifth day makes 10 of 50 hours overtime, spread 30:20.
  assert.deepEqual(jobs['job-ot-a'].projected, { workHours: 30, travelHours: 0, laborHours: 30, overtimeHours: 6 });
  assert.deepEqual([jobs['job-ot-a'].approved.overtimeHours, jobs['job-ot-a'].pending.overtimeHours, jobs['job-ot-b'].projected.overtimeHours, jobs['job-ot-b'].pending.overtimeHours], [0, 6, 4, 4]);
  assert.deepEqual(jobs['job-ot-a'].employees, [{ employee: 'crew.solo', name: 'Synthetic Solo', approvedHours: 30, pendingHours: 0, approvedOvertimeHours: 0, pendingOvertimeHours: 6 }]);
  assert.deepEqual(body.totals.projected, { workHours: 50, travelHours: 0, laborHours: 50, overtimeHours: 10, straightCost: null, overtimePremium: null, cost: null });
  const owner = await (await costing('owner', 'legacy', 'mixed')({ request: costingRequest(QUERIES[0]), env: {} })).json();
  const hidden = await (await costing('manager', 'legacy', 'mixed')({ request: costingRequest(QUERIES[0]), env: {} })).json();
  assert.deepEqual(owner.coverage.reasons, ['open_shifts', 'pending_timecards', 'missing_rate', 'non_hourly_pay_type'], 'the fixture exercises both pay-only reasons');
  assert.deepEqual(hidden.coverage.reasons, ['open_shifts', 'pending_timecards']);
  assert.equal(owner.jobs.find(row => row.jobId === 'job-norate').missingRateCount, 1);
  assert.equal(hidden.jobs.some(row => 'missingRateCount' in row), false, 'a missing rate would say the rate is zero');
});

const OTHER_COSTS = { disposalCents: 9000, materialsCents: 0, fuelCents: 1200, processingCents: 0, otherCents: 0 };
const laborCopies = job => ['laborCost', 'costs.labor', 'costs.laborCents'].filter(path => { const [head, sub] = path.split('.'); return sub ? job.costs?.[sub] !== undefined : job[head] !== undefined; });

test('flag on: /api/money gives managers laborCents null while the owner keeps it, on reads and on writes', async () => {
  for (const mode of Object.keys(ENVS)) {
    for (const role of HIDDEN_VIEWERS) {
      const read = await (await money(role, mode).get({ request: moneyGet('?jobId=job-costed'), env: ENVS[mode] })).json();
      assert.deepEqual(read.job.costs, { laborCents: null, disposalCents: 8550, materialsCents: 0, fuelCents: 1200, processingCents: 0, otherCents: 0, recordedAt: '2026-09-25T18:00:00.000Z', recordedBy: 'zacb', laborCostHidden: true });
      assert.equal((await (await money(role, mode).get({ request: moneyGet('?jobId=job-uncosted'), env: ENVS[mode] })).json()).job.costs, null, 'no costs stay null, never a hidden zero');
      const store = moneyStore(), env = { ...ENVS[mode], MONEY_API_ENABLED: 'true' }, write = body => money(role, mode, store).post({ request: moneyPost(body), env });
      // Any laborCents is refused by its presence, whatever its value, so the answer never says whether a guess matched.
      for (const laborCents of [LABOR_CENTS, 0, LABOR_CENTS + 1]) {
        const refused = await write({ ...MONEY_WRITES[0], requestId: crypto.randomUUID(), costs: { ...OTHER_COSTS, laborCents } });
        assert.deepEqual([refused.status, (await refused.json()).code], [403, 'money_labor_owner_only'], `${mode} ${role} ${laborCents}`);
      }
      assert.equal((await store.read('jobs', 'job-costed')).revision, 'r0', 'a refused labor write changes nothing');
      const body = { ...MONEY_WRITES[0], costs: OTHER_COSTS }, saved = await (await write(body)).json();
      assert.deepEqual([saved.ok, saved.job.costs.laborCents, saved.job.costs.laborCostHidden, saved.job.costs.disposalCents], [true, null, true, 9000]);
      // Saving keeps the owner's figure: the copy on the job moves to the private record, which the manager never gets.
      const job = await store.read('jobs', 'job-costed'), record = await store.read('jobLaborCosts', 'job-costed');
      assert.deepEqual(laborCopies(job), [], 'no labor copy is left on the job');
      assert.deepEqual([record.laborCents, record.source, record.recordedBy], [LABOR_CENTS, 'legacy_job', 'zacb']);
      const replay = await (await write(body)).json();
      assert.deepEqual([replay.replayed, replay.job.costs.laborCents], [true, null], 'a replayed write is hidden the same way');
      const owner = await (await money('owner', mode, store).get({ request: moneyGet('?jobId=job-costed'), env: ENVS[mode] })).json();
      assert.deepEqual([owner.job.costs.laborCents, owner.job.costs.disposalCents], [LABOR_CENTS, 9000], 'the owner reads the kept figure from the private record');
    }
    const owner = await (await money('owner', mode).get({ request: moneyGet('?jobId=job-costed'), env: ENVS[mode] })).json();
    assert.deepEqual([owner.job.costs.laborCents, 'laborCostHidden' in owner.job.costs], [LABOR_CENTS, false]);
    // The owner's figure goes to the private record only; the manager's next read is still hidden.
    const store = moneyStore(), saved = await (await money('owner', mode, store).post({ request: moneyPost({ ...MONEY_WRITES[0], costs: { ...OTHER_COSTS, laborCents: 20250 } }), env: { ...ENVS[mode], MONEY_API_ENABLED: 'true' } })).json();
    assert.deepEqual([saved.job.costs.laborCents, (await store.read('jobLaborCosts', 'job-costed')).laborCents, laborCopies(await store.read('jobs', 'job-costed'))], [20250, 20250, []]);
    const hidden = await (await money('manager', mode, store).get({ request: moneyGet('?jobId=job-costed'), env: ENVS[mode] })).text();
    assert.equal(hidden.includes('20250') || hidden.includes('202.5'), false);
  }
});

test('integration status carries no labor field for any viewer, flag on or off (the finance board asks /api/job-labor-costs)', async () => {
  for (const mode of Object.keys(ENVS)) for (const role of Object.keys(ROLES)) {
    const read = async env => (await integrationStatus(role, mode).get({ request: new Request('https://easygaragecleaning.com/api/integration-status'), env: { ...ENVS[mode], ...env } })).text();
    const off = await read({ EGC_STAFF_PAY_OWNER_ONLY: 'false' });
    assert.equal(/labor/i.test(off), false, `${mode} ${role}`);
    for (const env of ON_ENVS) assert.equal(await read(env), off, `${mode} ${role} ${JSON.stringify(env)}: the flag changes nothing here`);
  }
});

// A job document carrying every labor figure the Hub stores or once stored, plus timecard-shaped pay fields.
const CANARY_JOB = { id: 'job-costed', type: 'job', customerId: 'c1', highlevelContactId: 'contact-canary', customer: 'Synthetic Customer', address: '123 Synthetic Street', date: '2026-09-22', time: '08:00', endTime: '12:00', status: 'completed', pipelineStatus: 'completed',
  completedAt: '2026-09-22T18:00:00.000Z', total: 900, assignedCrew: ['crew.solo'], hourlyRate: RATES['crew.solo'], laborCost: LEGACY_LABOR, hoursOnSite: 4, crewSize: 1,
  costs: { labor: LABOR_CENTS / 100, laborCents: LABOR_CENTS, disposal: 85.5, recordedAt: '2026-09-25T18:00:00.000Z', recordedBy: 'zacb' }, crewPay: { lead: RATES['crew.two'] },
  estimate: { number: 'EST-000001', status: 'accepted', amount: 900, acceptedAt: '2026-09-20T18:00:00.000Z' }, customerApproval: { status: 'approved', approvedAt: '2026-09-20T18:00:00.000Z', amount: 900 } };

test('closeout (FUN-19 field costs) carries no labor dollars or rates for any role', async () => {
  const { fieldExpenseHandlers } = await import('../functions/api/field-expenses.js');
  const expense = { id: '0c0c0c0c-1111-4222-8333-444455556666', jobId: 'job-costed', kind: 'dump_fee', amountCents: 8550, vendor: 'Synthetic Landfill', note: '', payer: 'crew_reimbursable', incurredOn: '2026-09-22', state: 'applied', status: 'recorded', actorId: 'crew.solo', createdAt: NOW };
  const store = { readJob: async id => id === 'job-costed' ? structuredClone(CANARY_JOB) : null, listExpenses: async () => [structuredClone(expense)], listAttestations: async () => [{ kind: 'material', attestation: 'none', actorId: 'crew.solo', at: NOW }] };
  const env = { FIELD_EXPENSES_ENABLED: 'true', FIELD_EXPENSE_CLOSEOUT_REQUIRED: 'true', FIREBASE_API_KEY: 'firebase-test-job-cost-privacy' };
  let listings = 0;
  for (const mode of Object.keys(ENVS)) for (const role of Object.keys(ROLES)) for (const flag of [{}, { EGC_STAFF_PAY_OWNER_ONLY: 'false' }]) {
    const handlers = fieldExpenseHandlers({ session: async () => sessionFor(role, mode), storage: () => store, now: () => new Date(NOW) });
    const response = await handlers.get({ request: new Request('https://easygaragecleaning.com/api/field-expenses?jobId=job-costed'), env: { ...env, ...ENVS[mode], ...flag } });
    const text = `${response.status} x\n${await response.text()}`;
    if (response.status === 200) listings++;
    if (role !== 'owner') assertNoLaborDollars(text, null, `closeout ${mode} ${role}`);
  }
  assert.ok(listings >= 20, 'managers and the assigned crew member got the closeout listing');
});

test('POST /api/case-study hands back the saved job without its labor copy unless the viewer sees labor dollars', async t => {
  const { onRequestPost } = await import('../functions/api/case-study.js');
  const { encodeFirestoreFields } = await import('../functions/_lib/firestore-job.js');
  const { createHubSessionCookie } = await import('../functions/_lib/hub-session.js');
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(NOW) });
  // A finished job whose older save left every labor copy on it (the Hub keeps no pay rate on jobs).
  const { hourlyRate, crewPay, ...job } = CANARY_JOB, stored = { name: 'projects/egcw-1ec83/databases/(default)/documents/jobs/job-costed', fields: encodeFirestoreFields(job), updateTime: '2026-09-25T18:00:00.000000Z' };
  t.mock.method(globalThis, 'fetch', async (url, init = {}) => {
    assert.equal(new URL(String(url)).hostname, 'firestore.googleapis.com');
    // Firestore answers a PATCH with the whole document after the update.
    return Response.json(init.method === 'PATCH' ? { ...stored, fields: { ...stored.fields, ...JSON.parse(init.body).fields } } : stored);
  });
  const users = { ZacB: 'owner', TylerG: 'manager', AlexK: 'manager' }, base = { HUB_SESSION_SECRET: 'synthetic-case-study-secret', FIREBASE_API_KEY: 'firebase-test-job-cost-privacy',
    HUB_AUTH_USERS_JSON: JSON.stringify(Object.fromEntries(Object.entries(users).map(([user, role]) => [user, { passwordHash: `synthetic-${user}`, displayName: `Synthetic ${user}`, role }]))) };
  const body = { jobId: 'job-costed', title: 'Two-Car Garage Reset in Fort Collins', city: 'Fort Collins', serviceType: 'Garage cleanout', customerProblem: 'Boxes blocked both bays.', workCompleted: 'Sorted, hauled and swept.', result: 'Both cars fit again.' };
  const save = async (user, env) => {
    const cookie = (await createHubSessionCookie({ ...base, ...env }, user)).split(';')[0];
    const response = await onRequestPost({ request: new Request('https://easygaragecleaning.com/api/case-study', { method: 'POST', headers: { Origin: 'https://easygaragecleaning.com', Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), env: { ...base, ...env } });
    assert.equal(response.status, 200, user);
    return response.text();
  };
  for (const env of ON_ENVS) for (const user of ['TylerG', 'AlexK']) {
    const text = await save(user, env), saved = JSON.parse(text);
    assertNoLaborDollars(`200 x\n${text}`, null, `case-study ${user} ${JSON.stringify(env)}`);
    assert.deepEqual([saved.job.id, saved.job.caseStudy.status, saved.job.costs.disposal, saved.job.laborCost, 'labor' in saved.job.costs], ['job-costed', 'draft', 85.5, undefined, false]);
  }
  const owner = JSON.parse(await save('ZacB', {})), flagOff = JSON.parse(await save('TylerG', { EGC_STAFF_PAY_OWNER_ONLY: 'false' }));
  assert.deepEqual([owner.job.costs.laborCents, owner.job.laborCost], [LABOR_CENTS, LEGACY_LABOR], 'the owner gets the whole job');
  assert.deepEqual([flagOff.job.costs.laborCents, flagOff.job.laborCost], [LABOR_CENTS, LEGACY_LABOR], 'flag off: as before');
});

test('the MCP bridge reads (portal.job, portal.revenue) carry no labor dollars or rates', async () => {
  const { encodeFirestoreFields } = await import('../functions/_lib/firestore-job.js');
  const { portalEvidence, portalJob } = await import('../functions/_lib/operations-portal-records.js');
  const { portalRevenue } = await import('../functions/_lib/operations-financials.js');
  const doc = { name: 'projects/egcw-1ec83/databases/(default)/documents/jobs/job-costed', fields: encodeFirestoreFields(CANARY_JOB), updateTime: '2026-09-25T18:00:00.000000Z' };
  const fetcher = async (_env, url) => Response.json(String(url).includes('/documents/jobs/job-costed') ? doc : { documents: [doc] });
  const job = await portalJob({}, 'job-costed', fetcher);
  assert.equal(job.job.id, 'job-costed');
  assertNoLaborDollars(`200 x\n${JSON.stringify(job)}`, null, 'portal.job');
  const revenue = await portalRevenue({}, { from: '2026-09-01T00:00:00.000Z', to: '2026-10-01T00:00:00.000Z' }, fetcher);
  assert.equal(revenue.eligibleJobs, 1);
  assertNoLaborDollars(`200 x\n${JSON.stringify({ ...revenue, asOf: null })}`, null, 'portal.revenue');
  const evidence = await portalEvidence({}, { contactProviderIds: ['contact-canary'] }, fetcher);
  assert.equal(JSON.stringify(evidence).includes('job-costed'), true, 'the canary job is in the evidence');
  assertNoLaborDollars(`200 x\n${JSON.stringify({ ...evidence, asOf: null })}`, null, 'portal.evidence');
});

// The legacy finance board in employee-suite.js, run in a vm with the lines it needs, a fixed clock and a stand-in for
// employee-labor-costs.js (window.EGCLaborCosts: the labor state the server answered, and the private records).
class FixedDate extends Date { constructor(...args) { super(...(args.length ? args : [NOW])); } static now() { return Date.parse(NOW); } }
// owner and baseline stand in for the owner's /api/pricing-config answer (employee-pricing.js): a manager never has one.
function financeBoard({ labor = 'hidden', records = {}, jobs = [], saveError = null, owner = false, baseline = null } = {}) {
  const source = readFileSync(new URL('../employee-suite.js', import.meta.url), 'utf8'), lines = source.split(/\r?\n/);
  const line = prefix => { const found = lines.find(item => item.startsWith(prefix)); assert.ok(found, prefix); return found; };
  const captured = { saves: [], toasts: [], order: [] };
  const EGCLaborCosts = { state: () => labor, record: id => labor === 'visible' ? records[id] || null : null,
    save: async args => { captured.order.push('labor'); captured.saves.push(args); if (saveError) throw new Error(saveError); return { ...args, revision: 'l1' }; }, load: async () => true };
  const EGCPricingConfig = { owner: () => owner && baseline !== null ? { laborCostPerCrewHour: baseline } : null };
  const context = vm.createContext({ Date: FixedDate, window: { EGCLaborCosts, EGCPricingConfig }, S: { integrations: {} }, isManager: () => true, isOwnerAccount: () => owner, jobs: () => jobs, jobStage: j => j.status, crewNames: () => [], esc: String, money: v => `$${Number(v || 0).toFixed(2)}`, badge: text => `[${text}]`,
    empty: text => text, dateLabel: () => 'date', portalInvitationControl: () => '', salesExitControl: () => '', financeState: j => ({ total: j.total, verifiedPaid: 0, pendingPaid: 0, balance: j.total, deposit: 0, paid: 0, estimate: 'draft', invoice: 'draft' }),
    askAction: async options => { captured.form = options; return captured.input; }, patchJob: async (id, update) => { captured.order.push('job'); captured.update = update; }, render: () => {}, employeeIdentity: () => 'tylerg', financeDatePlus: () => '2026-10-06', showToast: text => captured.toasts.push(text) });
  vm.runInContext([line('const ownerEconomics='), line('const laborBaseline='), line('const laborState='), line('function jobEconomics('), source.slice(source.indexOf('function financeSummary(){'), source.indexOf('function cacheSalesExit(')), line('function financeBoard('), source.slice(source.indexOf('window.opsFinanceAction='), source.indexOf('function addCalendarMonths'))].join('\n'), context);
  return { context, captured };
}
// After the backfill the job carries no labor; the owner's figure is the private record.
const BOARD_JOB = { id: 'job-costed', status: 'completed', customer: 'Synthetic Customer', total: 900, hoursOnSite: 4, crewSize: 1, costs: { disposal: 85.5, fuel: 12, recordedAt: '2026-09-25T18:00:00.000Z' } };
const LEGACY_BOARD_JOB = { ...BOARD_JOB, costs: { ...BOARD_JOB.costs, labor: 151.64, laborCents: 15164 } };
const RECORDS = { 'job-costed': { jobId: 'job-costed', laborCents: 15164, revision: 'l0' } };

test('the finance board shows a labor, direct-cost or contribution figure only once the server says labor is visible', async () => {
  const notes = { hidden: 'Labor $ hidden', idle: 'Labor $ loading…', loading: 'Labor $ loading…', unavailable: 'Labor $ unavailable' };
  for (const [labor, job, records] of [['hidden', LEGACY_BOARD_JOB, {}], ['idle', BOARD_JOB, {}], ['loading', LEGACY_BOARD_JOB, {}], ['unavailable', LEGACY_BOARD_JOB, {}], ['visible', BOARD_JOB, RECORDS], ['visible', LEGACY_BOARD_JOB, {}], ['visible', { ...LEGACY_BOARD_JOB, costs: { ...LEGACY_BOARD_JOB.costs, labor: 999 } }, RECORDS]]) {
    const { context } = financeBoard({ labor, records, jobs: [job] }), label = `${labor} ${JSON.stringify(job.costs)}`;
    const economics = context.jobEconomics(job), html = context.financeBoard() + context.financeSummary();
    assert.equal(economics.laborHidden, labor !== 'visible', label);
    if (labor !== 'visible') {
      assert.deepEqual([economics.labor, economics.directCost, economics.contribution, economics.margin, economics.otherCost, economics.crewHours], [null, null, null, null, 97.5, 4], label);
      assert.ok(html.includes(`4.0 crew-hrs · ${notes[labor]}`), label); assert.ok(html.includes(`<strong>${notes[labor]}</strong>`), label);
      for (const figure of ['151.64', '249.14', '650.86', '72.3%', 'direct cost', ' contribution ·']) assert.equal(html.includes(figure), false, `${label} ${figure}`);
      assert.equal(html.includes('opsRetryLaborCosts()'), labor === 'unavailable', `${label}: only a failed load offers Retry`);
    } else {
      // The private record wins over a stale copy on the job; before the backfill the copy is the fallback.
      assert.match(html, /\$249\.14 direct cost/, label); assert.match(html, /\$650\.86 contribution · 72\.3% margin/, label);
      assert.equal(/Labor \$ (hidden|loading|unavailable)/.test(html), false, label);
    }
  }
  // No costs and no hours: nothing is costed, so nothing reads as a hidden or a zero figure.
  const { context } = financeBoard({ jobs: [{ id: 'job-new', status: 'scheduled', total: 500 }] });
  assert.equal(context.jobEconomics({ id: 'job-new', total: 500 }).known, false);
  assert.equal(context.financeBoard().includes('crew-hrs'), false);
});

test('a manager\'s cost dialog has no labor field and never writes labor; the owner\'s labor goes to the private record first', async () => {
  const manager = financeBoard({ labor: 'hidden', jobs: [LEGACY_BOARD_JOB] });
  manager.captured.input = { disposal: '99.25', materials: '0', fuel: '12', processing: '0', other: '0' };
  await manager.context.window.opsFinanceAction('job-costed', 'cost');
  assert.deepEqual([...manager.captured.form.fields.map(field => field.name)], ['disposal', 'materials', 'fuel', 'processing', 'other']);
  assert.match(manager.captured.form.copy, /Labor \$ hidden \(owner only\); saving keeps it\./);
  assert.equal(JSON.stringify(manager.captured.form).includes('151.64'), false);
  assert.deepEqual(JSON.parse(JSON.stringify(manager.captured.update.costs)), { disposal: 99.25, materials: 0, fuel: 12, processing: 0, other: 0, recordedAt: NOW, recordedBy: 'tylerg', source: 'egc_hub' }, 'no labor key: the rules keep the copy, which Firestore merge leaves as it is');
  assert.deepEqual([manager.captured.update.updatedAt, manager.captured.saves], [NOW, []]);
  const loading = financeBoard({ labor: 'unavailable', jobs: [BOARD_JOB] });
  loading.captured.input = null;
  await loading.context.window.opsFinanceAction('job-costed', 'cost');
  assert.deepEqual([loading.captured.form.fields.some(field => field.name === 'labor'), /Labor \$ not loaded; saving keeps the saved figure\./.test(loading.captured.form.copy)], [false, true]);
  // The owner: a changed figure is saved to the private record before the job, and never onto the job.
  const owner = financeBoard({ labor: 'visible', records: RECORDS, jobs: [BOARD_JOB] });
  owner.captured.input = { labor: '160.25', disposal: '85.5', materials: '0', fuel: '12', processing: '0', other: '0' };
  await owner.context.window.opsFinanceAction('job-costed', 'cost');
  assert.deepEqual([owner.captured.form.fields[0].name, owner.captured.form.fields[0].value], ['labor', 151.64]);
  assert.equal(owner.captured.form.copy.includes('Labor $'), false);
  assert.deepEqual(JSON.parse(JSON.stringify(owner.captured.saves)), [{ jobId: 'job-costed', laborCents: 16025, viewer: 'tylerg' }]);
  assert.deepEqual([owner.captured.order, 'labor' in owner.captured.update.costs, owner.captured.update.costs.recordedAt], [['labor', 'job'], false, NOW]);
  // An unchanged figure is not saved again; a refused labor save stops before the job is written.
  const same = financeBoard({ labor: 'visible', records: RECORDS, jobs: [BOARD_JOB] });
  same.captured.input = { labor: '151.64', disposal: '85.5', materials: '0', fuel: '12', processing: '0', other: '0' };
  await same.context.window.opsFinanceAction('job-costed', 'cost');
  assert.deepEqual([same.captured.saves, same.captured.order], [[], ['job']]);
  const refused = financeBoard({ labor: 'visible', records: RECORDS, jobs: [BOARD_JOB], saveError: 'Synthetic refusal.' });
  refused.captured.input = { labor: '1', disposal: '85.5', materials: '0', fuel: '12', processing: '0', other: '0' };
  await refused.context.window.opsFinanceAction('job-costed', 'cost');
  assert.deepEqual([refused.captured.order, refused.captured.update, refused.captured.toasts], [['labor'], undefined, ['Synthetic refusal.']]);
});

// PRICE-SCRUB's "blank means unknown" and owner baseline, combined with the private record: the record wins (a null
// figure there is the owner's blank), then a blank costs.labor, then an older copy, then crew-hours x the baseline.
test('labor for the owner: the record, then a blank, then an older copy, then the baseline estimate; a blank never falls back to a copy', () => {
  const STALE = { ...BOARD_JOB, laborCost: 311.19 };
  const cases = [
    ['record figure beats a copy and the baseline', { ...LEGACY_BOARD_JOB }, RECORDS, 20, 151.64],
    ['a blank record with hours and a baseline: the estimate', { ...LEGACY_BOARD_JOB }, { 'job-costed': { ...RECORDS['job-costed'], laborCents: null } }, 20, 80],
    ['a blank record without a baseline: unknown', { ...LEGACY_BOARD_JOB }, { 'job-costed': { ...RECORDS['job-costed'], laborCents: null } }, null, null],
    ['a blank on the job hides an older laborCost', { ...STALE, costs: { ...BOARD_JOB.costs, labor: null } }, {}, null, null],
    ['a blank on the job with a baseline: the estimate, never the old copy', { ...STALE, costs: { ...BOARD_JOB.costs, labor: null } }, {}, 20, 80],
    ['an older costs.labor copy', { ...LEGACY_BOARD_JOB }, {}, 20, 151.64],
    ['an older laborCost copy', STALE, {}, 20, 311.19],
    ['no figure: the baseline estimate', BOARD_JOB, {}, 20, 80],
    ['no figure and no baseline: unknown', BOARD_JOB, {}, null, null],
    ['no hours and no blank: nothing to cost', { ...BOARD_JOB, hoursOnSite: 0 }, {}, 20, 0],
    ['no hours and a blank: unknown', { ...BOARD_JOB, hoursOnSite: 0, costs: { ...BOARD_JOB.costs, labor: null } }, {}, 20, null],
  ];
  for (const [label, job, records, baseline, labor] of cases) {
    const { context } = financeBoard({ labor: 'visible', owner: true, baseline, records, jobs: [job] }), economics = context.jobEconomics(job), html = context.financeBoard();
    assert.equal(economics.labor, labor, label);
    assert.equal(economics.laborUnknown, labor === null, label);
    if (labor === null) {
      assert.equal(economics.known, false, `${label}: no contribution from an unknown labor cost`);
      assert.match(html, /Labor cost unknown until actual costs are entered/, label);
      assert.doesNotMatch(html, /direct cost|contribution ·|311\.19/, label);
    } else assert.match(html, new RegExp(`\\$${(labor + 97.5).toFixed(2).replace('.', '\\.')} direct cost`), label);
  }
  // A manager gets no labor, direct cost, contribution or margin whatever the job, the record or a baseline holds.
  for (const [job, records] of [[{ ...STALE, costs: { ...BOARD_JOB.costs, labor: null } }, {}], [LEGACY_BOARD_JOB, RECORDS], [BOARD_JOB, {}]]) {
    const { context } = financeBoard({ labor: 'hidden', owner: false, baseline: 20, records, jobs: [job] }), economics = context.jobEconomics(job), html = context.financeBoard() + context.financeSummary();
    assert.deepEqual([economics.labor, economics.directCost, economics.contribution, economics.margin, economics.laborUnknown, economics.laborCopy], [null, null, null, null, false, false]);
    assert.match(html, /4\.0 crew-hrs · Labor \$ hidden/);
    assert.doesNotMatch(html, /Labor cost unknown|direct cost|contribution ·|311\.19|151\.64|\$80/);
  }
});

test('only the owner blanks labor: a saved figure or an older copy is blanked through the record, otherwise the job keeps a blank', async () => {
  const blank = { labor: '', disposal: '85.5', materials: '0', fuel: '12', processing: '0', other: '0' };
  const run = async (options, input = blank) => { const h = financeBoard({ labor: 'visible', owner: true, ...options }); h.captured.input = input; await h.context.window.opsFinanceAction('job-costed', 'cost'); return h.captured; };
  // A saved figure: the record becomes unknown (null), and the job gets no labor key.
  const saved = await run({ records: RECORDS, jobs: [BOARD_JOB] });
  assert.deepEqual([JSON.parse(JSON.stringify(saved.saves)), saved.order, 'labor' in saved.update.costs], [[{ jobId: 'job-costed', laborCents: null, viewer: 'tylerg' }], ['labor', 'job'], false]);
  const field = saved.form.fields.find(item => item.name === 'labor');
  assert.deepEqual([field.required, field.placeholder, field.value], [false, 'Unknown', 151.64]);
  // An older copy on the job and no record: blanked through the record too, which moves the copy off the job.
  for (const job of [LEGACY_BOARD_JOB, { ...BOARD_JOB, laborCost: 311.19 }]) {
    const copy = await run({ jobs: [job] });
    assert.deepEqual([JSON.parse(JSON.stringify(copy.saves)), 'labor' in copy.update.costs], [[{ jobId: 'job-costed', laborCents: null, viewer: 'tylerg' }], false], JSON.stringify(job));
  }
  // Nothing saved anywhere: no record is made, and the job's blank costs.labor says unknown (a null reveals nothing).
  const none = await run({ jobs: [{ ...BOARD_JOB, hoursOnSite: 0 }] });
  assert.deepEqual([none.saves, none.update.costs.labor, none.form.fields.find(item => item.name === 'labor').value], [[], null, '']);
  // Already blank in the record: nothing to save; a figure (even $0) is saved as a figure.
  const unknown = await run({ records: { 'job-costed': { ...RECORDS['job-costed'], laborCents: null } }, jobs: [{ ...BOARD_JOB, hoursOnSite: 0 }] });
  assert.deepEqual([unknown.saves, 'labor' in unknown.update.costs], [[], false]);
  const zero = await run({ records: { 'job-costed': { ...RECORDS['job-costed'], laborCents: null } }, jobs: [BOARD_JOB] }, { ...blank, labor: '0' });
  assert.deepEqual(JSON.parse(JSON.stringify(zero.saves)), [{ jobId: 'job-costed', laborCents: 0, viewer: 'tylerg' }]);
  // The owner's baseline is only a suggestion in the form; with hours and no figure it pre-fills the estimate.
  const estimate = await run({ baseline: 20, jobs: [BOARD_JOB] }, null);
  assert.equal(estimate.form.fields.find(item => item.name === 'labor').value, 80);
  // A manager (labor hidden) never sends labor and never blanks it: the form has no labor field at all.
  const manager = financeBoard({ labor: 'hidden', jobs: [{ ...BOARD_JOB, hoursOnSite: 0 }] });
  manager.captured.input = { disposal: '85.5', materials: '0', fuel: '12', processing: '0', other: '0' };
  await manager.context.window.opsFinanceAction('job-costed', 'cost');
  assert.deepEqual([manager.captured.saves, 'labor' in manager.captured.update.costs, manager.captured.form.fields.some(item => item.name === 'labor')], [[], false, false]);
});

test('the flag is on unless exactly "false", and only pay.manage (the owner) sees labor dollars', () => {
  assert.deepEqual([undefined, '', 'true', 'FALSE', 'False', '0', 'no', 'false'].map(value => staffPayOwnerOnly(value === undefined ? {} : { EGC_STAFF_PAY_OWNER_ONLY: value })), [true, true, true, true, true, true, true, false]);
  assert.equal(staffPayOwnerOnly(undefined), true); assert.equal(payOwnerOnly, staffPayOwnerOnly);
  for (const mode of Object.keys(ENVS)) for (const role of Object.keys(ROLES)) {
    assert.equal(seesLaborCost(sessionFor(role, mode), ENVS[mode]), role === 'owner', `${mode} ${role}`);
    assert.equal(seesLaborCost(sessionFor(role, mode), ENVS[mode]), seesOthersPay(sessionFor(role, mode), ENVS[mode]));
  }
  assert.equal(seesLaborCost({ user: 'zacb', role: 'owner', businessAccess: false }, {}), false, 'business access is required');
  assert.equal(seesLaborCost(null, {}), false);
});
