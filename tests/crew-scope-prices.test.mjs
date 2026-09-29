import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import vm from './helpers/vm-realm.mjs';
import { servedPricing } from './helpers/walkthrough-pricing.mjs';
import { storage } from './helpers/field-fixture.mjs';
import { hasCrewMoney, signedBriefJob, stripCrewMoney, stripCrewMoneyDeep } from '../functions/_lib/crew-money.js';
import { normalizeHandoffPlan, saveWalkthroughHandoff, stripCrewMoney as handoffStrip } from '../functions/_lib/walkthrough-handoff.js';
import { fieldCommand, fieldCompletionMissing, fieldJobProjection } from '../functions/_lib/field-execution.js';
import { crewJobProjection, CREW_PROJECTION_FIELDS } from '../functions/_lib/crew-job-projection.js';
import { crewJobsHandlers, CREW_LISTING_FIELDS } from '../functions/api/crew-jobs.js';
import { handoffHandlers } from '../functions/api/walkthrough-handoff.js';
import { createHubSessionCookie } from '../functions/_lib/hub-session.js';
import * as fieldJobs from '../functions/api/field-jobs.js';
import { parseArgs, planCrewScopeBackfill, runCrewScopeBackfill, SCOPE_FIELDS } from '../scripts/backfill-crew-scope-prices.mjs';

// FIX-CREW-PRICE-LEAK (WTR-01): crew saw "HAZARDS: Pest waste (+$200)" and "Non-toxic mouse trapping (+$250)" in
// Scope & instructions, and GET /api/field-jobs returned both amounts inside `scope`.
const NOW = '2026-09-22T18:00:00.000Z';
const owner = { user: 'zacb', role: 'owner', businessAccess: true, displayName: 'Owner' };
const MONEY = /\$\s?\d/;
const html = fs.readFileSync(new URL('../crew/gameplan.html', import.meta.url), 'utf8');
const handoffClient = fs.readFileSync(new URL('../crew/gameplan-handoff.js', import.meta.url), 'utf8');
const line = prefix => { const found = html.split(/\r?\n/).find(row => row.startsWith(prefix)); assert.ok(found, prefix); return found; };
const plain = value => JSON.parse(JSON.stringify(value));
const fieldEnv = { HUB_SESSION_SECRET: 'synthetic-crew-scope-session-secret', FIREBASE_API_KEY: 'firebase-test-crew-scope', GOOGLE_CLIENT_ID: 'test', GOOGLE_CLIENT_SECRET: 'test', GOOGLE_REFRESH_TOKEN: 'test',
  HUB_AUTH_USERS_JSON: JSON.stringify({ zacb: { passwordHash: 'test', role: 'owner', displayName: 'Owner' }, 'crew.one': { passwordHash: 'test', role: 'crew', displayName: 'Crew One' } }) };
// The brief a walkthrough saved as the crew scope before the fix (the WTR-01 evidence).
const LEAKED = 'EGC INTERNAL JOB BRIEF\nCUSTOMER GOAL: Park two cars\nHAZARDS: Pest waste (+$200)\nFINISH SOLD: cleanout, One-car garage pressure wash (+$400), Non-toxic mouse trapping (+$250)\nMATERIALS: 2 metal shelf unit(s) · 3 tote(s)\nCREW / WINDOW: Crew One · 1 crew · 08:00–13:00\nWALKTHROUGH PHOTOS: 3 captured';
const CLEAN = 'EGC INTERNAL JOB BRIEF\nCUSTOMER GOAL: Park two cars\nHAZARDS: Pest waste\nFINISH SOLD: cleanout, One-car garage pressure wash, Non-toxic mouse trapping\nMATERIALS: 2 metal shelf unit(s) · 3 tote(s)\nCREW / WINDOW: Crew One · 1 crew · 08:00–13:00\nWALKTHROUGH PHOTOS: 3 captured';

test('stripCrewMoney removes every currency form and leaves times, quantities and clean text untouched', () => {
  for (const [input, expected] of [
    ['HAZARDS: Pest waste (+$200)', 'HAZARDS: Pest waste'],
    ['Pest waste (+$1,234.50), Glass', 'Pest waste, Glass'],
    ['Total $1501.00 due', 'Total due'],
    ['+$200', ''],
    ['USD 200', ''],
    ['Pay USD200 at the door', 'Pay at the door'],
    ['200 USD cash', 'cash'],
    ['about 150 dollars extra', 'about extra'],
    ['-$50 discount', 'discount'],
    ['US$ 40 tip', 'tip'],
    ['$200–$300 range', 'range'],
    ['A $5,000,000 garage', 'A garage'],
    ['price $1.5k ok', 'price ok'],
    ['(each $200)', '(each)'],
    ['line one\n$200 first\nline three (+$5)\n', 'line one\nfirst\nline three\n'],
    ['Arrive 8:00; 08:00–11:00 window', 'Arrive 8:00; 08:00–11:00 window'],
    ['MATERIALS: 2 shelf unit(s) · 3 tote(s)', 'MATERIALS: 2 shelf unit(s) · 3 tote(s)'],
    ['Order #200 x3, keep the $ sign card', 'Order #200 x3, keep the $ sign card'],
    [LEAKED, CLEAN],
    // Brackets and spacing around an amount go with it.
    ['Pest waste (+ $200)', 'Pest waste'],
    ['Pest [$200], Glass', 'Pest, Glass'],
    ['Pest (+$200)(+$50)', 'Pest'],
    ['Pay $5 $6 now', 'Pay now'],
    ['A  $5  B', 'A B'],
    ['- $200 deposit collected', '- deposit collected'],
    // The whole amount goes, never part of it.
    ['price was $ 1 500', 'price was'],
    ['$1,5000 quoted', 'quoted'],
    // Access details that only look like money stay.
    ['Parking at 200 Bucks Rd', 'Parking at 200 Bucks Rd'],
    ['Code 1234$ at the side door', 'Code 1234$ at the side door'],
    ['Gate code #$1234', 'Gate code #$1234'],
    ['PIN: 4455$, then collect 200$ cash', 'PIN: 4455$, then collect cash'],
    ['$5 100 boxes', '100 boxes'],
  ]) {
    assert.equal(stripCrewMoney(input), expected, input);
    assert.equal(handoffStrip(input), expected, 'walkthrough-handoff exports the same strip');
    assert.equal(stripCrewMoney(stripCrewMoney(input)), expected, 'stripping is idempotent');
    assert.equal(hasCrewMoney(expected), false, expected);
  }
  const untouched = 'Keep the red cabinet.  Two spaces stay.';
  assert.equal(stripCrewMoney(untouched), untouched);
  for (const value of [null, undefined, 42, ['$5']]) assert.deepEqual(stripCrewMoney(value), value);
  assert.deepEqual(stripCrewMoneyDeep({ a: ['Pest waste (+$200)', 3], b: { c: 'USD 5 fee', n: 250 }, d: null }), { a: ['Pest waste', 3], b: { c: 'fee', n: 250 }, d: null });
});

test('stripCrewMoney stays linear on long blank runs, so a 20,000-character scope is never a CPU sink', () => {
  // The earlier pattern backtracked through every blank run: 20,000 blanks cost 9.6 s of CPU per call. A pattern that
  // never yields cannot be stopped by a test timeout, so the calls run in a child process killed after 20 s.
  const script = `import { hasCrewMoney, stripCrewMoney } from ${JSON.stringify(new URL('../functions/_lib/crew-money.js', import.meta.url).href)};
    const blanks = ' '.repeat(100000), tabs = '\\t'.repeat(100000);
    process.stdout.write(JSON.stringify([
      stripCrewMoney('EGC CREW JOB BRIEF' + blanks + 'x $5') === 'EGC CREW JOB BRIEF' + blanks + 'x',
      stripCrewMoney('Keep' + tabs + '(' + blanks + '+$5' + blanks + ')' + tabs + 'safe') === 'Keep safe',
      stripCrewMoney('(' + blanks + 'x ' + '1 '.repeat(50000) + '$5') === '(' + blanks + 'x ' + '1 '.repeat(49999) + '1',
      hasCrewMoney(blanks + '(' + blanks + '1'.repeat(100000) + blanks)]));`;
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 20000 });
  assert.equal(run.error?.code, undefined, 'the calls finished well inside the limit');
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout), [true, true, true, false]);
});

test('signed briefs are recognised by handoffVersion or by the brief text a recurring visit copied', () => {
  assert.equal(signedBriefJob({ handoffVersion: 1, operationalScope: { text: 'Anything' } }), true);
  assert.equal(signedBriefJob({ operationalScope: { text: LEAKED } }), true, 'a copied priced brief');
  assert.equal(signedBriefJob({ jobInstructions: 'EGC CREW JOB BRIEF\nHAZARDS: Glass' }), true);
  assert.equal(signedBriefJob({ jobInstructions: { operationalScope: 'EGC INTERNAL JOB BRIEF\nX' } }), true);
  assert.equal(signedBriefJob({ operationalScope: { text: 'Collect the $300 balance by check' } }), false, 'staff-written scope');
  assert.equal(signedBriefJob({ handoffVersion: null, jobInstructions: { customerGoal: 'Park' } }), false);
});

// crew/gameplan.html's own functions, priced with the tables /api/pricing-config serves.
class PageDate extends Date {
  constructor(...args) { super(...(args.length ? args : [NOW])); }
  static now() { return Date.parse(NOW); }
}
function gameplan(overrides = {}) {
  const context = vm.createContext({ Date: PageDate, PRICING: servedPricing(), save() {}, render() {}, invalidateAcceptance() {}, validateStep: () => [], PHOTO_COUNT: 3, uid: () => 'synthetic-job', normPhone: value => value });
  vm.runInContext(line('const freshState='), context);
  context.S = vm.runInContext('freshState()', context);
  Object.assign(context.S, { name: 'Synthetic Customer', phone: '9705550100', email: 'test@example.invalid', address: '100 Fixture Lane', highlevelContactId: 'provider1', whyNow: 'Moving soon', outcome: 'Park two cars',
    garageSize: '1', fill: 'medium', loads: '1', hazards: ['Pest waste'], finish: ['cleanout', 'pressure_wash', 'mouse_trapping', 'shelving', 'totes'], shelfQty: 2, toteQty: 3, keepNotes: 'Blue bicycle', removeNotes: 'Empty cartons',
    jobDate: '2026-09-24', startTime: '08:00', endTime: '13:00', crewSize: '1', assignedTo: 'Crew One', notes: 'Dog in the yard', signature: 'data:image/png;base64,iVBORw0KGgo=', approved: true,
    acceptanceAt: '2026-09-22T17:45:00.000Z', acceptanceBy: 'Synthetic Customer' }, overrides);
  for (const prefix of ['function recommend(', 'function estimatedJobMinutes(', 'function durationText(', 'function buildJobInstructions(', 'function signedLines(', 'function buildInternalNotes(', 'function buildCrewBrief(', 'function buildClientChecklists(', 'function payload(']) vm.runInContext(line(prefix), context);
  return context;
}

test('the gameplan sends a crew brief with labels only and keeps the priced brief for managers', () => {
  const h = gameplan(), instructions = h.buildJobInstructions({}), internal = h.buildInternalNotes(instructions), crew = h.buildCrewBrief(instructions);
  assert.match(internal, /^EGC INTERNAL JOB BRIEF\n/);
  for (const priced of ['Pest waste (+$200)', 'One-car garage pressure wash (+$400)', 'Non-toxic mouse trapping (+$250)']) assert.ok(internal.includes(priced), priced);
  assert.match(crew, /^EGC CREW JOB BRIEF\n/);
  assert.doesNotMatch(crew, MONEY);
  for (const label of ['HAZARDS: Pest waste', 'One-car garage pressure wash', 'Non-toxic mouse trapping', 'MATERIALS: 2 metal shelf unit(s) · 3 tote(s)', 'CREW / WINDOW: Crew One · 1 crew · 08:00–13:00']) assert.ok(crew.includes(label), label);
  // The same sections in the same order; only the header and the fees differ.
  assert.deepEqual(crew.split('\n').slice(1).map(row => row.split(':')[0]), internal.split('\n').slice(1).map(row => row.split(':')[0]));
  assert.equal(crew.split('\n').slice(1).join('\n'), internal.split('\n').slice(1).join('\n').replace(/ \(\+\$\d+\)/g, ''));
  const sent = h.payload();
  assert.equal(sent.sent_at, NOW, 'the page reads the injected clock');
  assert.equal(sent.internal_notes, internal);
  assert.doesNotMatch(sent.crew_brief, MONEY);
  assert.ok(sent.internal_notes.includes('(+$200)'));
});

// In-memory dispatch store (tests/walkthrough-handoff.test.mjs fixture shape) with a mask-aware jobRecords scan.
function hubStore() {
  const rows = new Map([
    ['customers/c1', { id: 'c1', revision: 'c1r', name: 'Synthetic Customer', phone: '9705550100', email: 'test@example.invalid', address: '100 Fixture Lane', highlevelContactId: 'provider1' }],
    ['jobs/w1', { id: 'w1', revision: 'w1r', type: 'walkthrough', status: 'scheduled', pipelineStatus: 'scheduled', customerId: 'c1', customer: 'Synthetic Customer', highlevelContactId: 'provider1', date: '2026-09-22', time: '11:00', endTime: '12:00', projectId: 'p1' }],
    ['projects/p1', { id: 'p1', revision: 'p1r', customerId: 'c1', sourceRecordId: 'w1', sourceWalkthroughId: 'w1' }],
  ]);
  let n = 0;
  const roster = [{ id: 'zacb', name: 'Owner', role: 'owner' }, { id: 'crew.one', name: 'Crew One', role: 'crew' }];
  const store = { rows, commits: 0,
    read: async (collection, id) => structuredClone(rows.get(`${collection}/${id}`) || null),
    jobs: async () => [...rows].filter(([key]) => key.startsWith('jobs/')).map(([, value]) => structuredClone(value)),
    jobRecords: async fields => [...rows].filter(([key]) => key.startsWith('jobs/')).map(([, value]) => ({ ...masked(value, fields), id: value.id, revision: value.revision })),
    resources: async () => [], roster: async () => structuredClone(roster),
    async commit(writes) {
      const keys = new Set();
      for (const write of writes) {
        const key = `${write.collection}/${write.id}`, old = rows.get(key);
        assert.ok(!keys.has(key), 'one write per document'); keys.add(key);
        if (write.revision ? old?.revision !== write.revision : Boolean(old)) throw Object.assign(new Error('Conflict'), { code: 'dispatch_revision_conflict', status: 409 });
      }
      for (const write of writes) if (!write.verify) rows.set(`${write.collection}/${write.id}`, { ...rows.get(`${write.collection}/${write.id}`), ...structuredClone(write.patch), id: write.id, revision: `r${++n}` });
      store.commits++;
    } };
  return store;
}
// Firestore read-mask semantics: only the named (possibly nested) fields come back.
function masked(data, paths) {
  const out = {};
  for (const path of paths) {
    const keys = path.split('.');
    let value = data;
    for (const key of keys) value = value && typeof value === 'object' && !Array.isArray(value) && Object.hasOwn(value, key) ? value[key] : undefined;
    if (value === undefined) continue;
    let target = out;
    for (const key of keys.slice(0, -1)) target = target[key] ||= {};
    target[keys.at(-1)] = structuredClone(value);
  }
  return out;
}

// The page's payload, through the page's own handoff client, into the real /api/walkthrough-handoff handlers.
async function signAndSave(store, planInput) {
  const context = vm.createContext({ window: {}, URLSearchParams, AbortController, setTimeout, clearTimeout });
  vm.runInContext(handoffClient, context);
  const api = handoffHandlers({ session: async () => owner, storage: () => store, now: () => new Date(NOW), stripe: () => null }), records = new Map(), sent = [];
  const client = context.window.EGCWalkthroughHandoffClient({ actor: async () => 'zacb', storage: { getItem: k => records.get(k) || null, setItem: (k, v) => records.set(k, v), removeItem: k => records.delete(k) },
    uuid: () => randomUUID(), plan: () => structuredClone(planInput), source: () => 'w1', savedJobId: () => '', photoDraftId: () => 'local-photos', accept() {},
    fetch: async (url, options = {}) => {
      const request = new Request(`https://easygaragecleaning.com${url}`, options.body ? { method: 'POST', headers: { Origin: 'https://easygaragecleaning.com', 'Content-Type': 'application/json' }, body: options.body } : {});
      if (options.body) sent.push(JSON.parse(options.body));
      return options.body ? api.post({ request, env: {} }) : api.get({ request, env: {} });
    } });
  const saved = await client.save();
  return { saved, sent };
}

async function crewAndManagerReads(t, job) {
  t.mock.timers.enable({ apis: ['Date'], now: new Date(NOW) });
  const firestore = storage(t), { id, revision, ...data } = job;
  firestore.put(`jobs/${id}`, data);
  const cookie = async user => (await createHubSessionCookie(fieldEnv, user)).split(';')[0];
  const get = async user => fieldJobs.onRequestGet({ env: fieldEnv, request: new Request(`https://easygaragecleaning.com/api/field-jobs?jobId=${id}`, { headers: { Cookie: await cookie(user) } }) });
  const crew = await get('crew.one'), manager = await get('zacb');
  assert.equal(crew.status, 200); assert.equal(manager.status, 200);
  return { firestore, crew: await crew.text(), manager: await manager.text() };
}

test('a signed walkthrough with pest waste, trapping and pressure wash reaches crew without a single price', async t => {
  const h = gameplan(), planInput = plain(h.payload()), store = hubStore();
  const { saved, sent } = await signAndSave(store, planInput);
  assert.equal(sent.at(-1).plan.crew_brief, planInput.crew_brief, 'the handoff client forwards the crew brief');
  const job = store.rows.get(`jobs/${saved.result.job.id}`);
  assert.equal(job.handoffVersion, 1);
  assert.match(job.operationalScope.text, /^EGC CREW JOB BRIEF\n/);
  assert.doesNotMatch(job.operationalScope.text, MONEY, 'the stored crew scope');
  assert.ok(job.operationalScope.text.includes('HAZARDS: Pest waste\n'));
  assert.doesNotMatch(JSON.stringify(job.jobInstructions), MONEY);
  // The manager-only brief and the signed snapshot the HighLevel Job Brief is written from keep every price.
  for (const priced of ['Pest waste (+$200)', 'Non-toxic mouse trapping (+$250)', 'One-car garage pressure wash (+$400)']) {
    assert.ok(job.internalNotes.includes(priced), priced);
    assert.ok(job.acceptedHandoffPayload.internal_notes.includes(priced), priced);
  }
  const { firestore, crew, manager } = await crewAndManagerReads(t, job);
  assert.doesNotMatch(crew, MONEY, 'the crew-session /api/field-jobs response');
  assert.ok(JSON.parse(crew).job.scope.includes('Non-toxic mouse trapping'));
  assert.doesNotMatch(crew, /internalNotes|INTERNAL JOB BRIEF/);
  assert.doesNotMatch(manager, MONEY, 'the field page shows a manager the same crew brief');
  // Managers read the priced brief from the stored job document: firestore.rules let business users, never crew, read
  // jobs/{id} (pinned on the emulator by tests/firestore-emulator-crew-scope.test.mjs). No Hub API returns internalNotes.
  const record = firestore.get(`jobs/${job.id}`);
  assert.ok(record.internalNotes.includes('Pest waste (+$200)'));
  assert.ok(record.internalNotes.includes('Non-toxic mouse trapping (+$250)'));
  assert.ok(record.internalNotes.includes('One-car garage pressure wash (+$400)'));
});

test('a page saved before the fix (no crew_brief) still stores a price-free crew scope', async () => {
  const h = gameplan(), planInput = plain(h.payload());
  delete planInput.crew_brief;
  const store = hubStore(), { saved, sent } = await signAndSave(store, planInput);
  assert.equal('crew_brief' in sent.at(-1).plan, false, 'an older frozen request body is unchanged');
  const job = store.rows.get(`jobs/${saved.result.job.id}`);
  assert.equal(job.operationalScope.text, stripCrewMoney(planInput.internal_notes));
  assert.doesNotMatch(job.operationalScope.text, MONEY);
  assert.ok(job.internalNotes.includes('(+$250)'));
  // Crew checks, instructions and notes typed with an amount lose it; the signed scope and notes keep it for managers.
  const typed = plain(gameplan({ notes: 'Customer adds $50 for the old fridge' }).payload());
  typed.client_checklists.preJob.push({ id: 'extra', label: 'Collect the agreed $75 disposal fee', detail: 'USD 75 in cash', critical: false });
  const other = hubStore(), result = await saveWalkthroughHandoff(other, owner, { requestId: randomUUID(), customerId: 'c1', sourceWalkthroughId: 'w1', sourceRevision: 'w1r', plan: typed }, NOW);
  const row = other.rows.get(`jobs/${result.job.id}`), crewCopies = { scope: row.operationalScope.text, jobInstructions: row.jobInstructions, customerInstructions: row.customerInstructions, customerNotesSummary: row.customerNotesSummary, clientChecklists: row.clientChecklists };
  assert.doesNotMatch(JSON.stringify(crewCopies), MONEY);
  assert.equal(row.customerInstructions, 'Customer adds for the old fridge');
  assert.equal(row.notes, 'Customer adds $50 for the old fridge');
  assert.ok(row.clientChecklists.preJob.some(item => item.label === 'Collect the agreed disposal fee' && item.detail === 'in cash'));
});

test('a crew brief is validated like the internal brief and cannot be used to smuggle amounts', () => {
  const base = { ...plain(gameplan().payload()), terms_accepted: true };
  assert.equal(normalizeHandoffPlan({ ...base, crew_brief: 'EGC CREW JOB BRIEF\nFINISH SOLD: Pressure wash (+$400)' }, NOW).crew_brief, 'EGC CREW JOB BRIEF\nFINISH SOLD: Pressure wash');
  assert.throws(() => normalizeHandoffPlan({ ...base, crew_brief: 42 }, NOW), error => error.code === 'handoff_invalid_plan');
  assert.throws(() => normalizeHandoffPlan({ ...base, crew_brief: 'x'.repeat(4901) }, NOW), error => error.code === 'handoff_invalid_plan');
});

test('a handoff request frozen before the page sent a crew brief is recovered unchanged, not refused as a different version', async () => {
  const context = vm.createContext({ window: {}, URLSearchParams, AbortController, setTimeout, clearTimeout });
  vm.runInContext(handoffClient, context);
  const planInput = plain(gameplan().payload()), older = structuredClone(planInput); delete older.crew_brief;
  const records = new Map(), bodies = []; let current = older, lose = true;
  const deps = { actor: async () => 'zacb', storage: { getItem: k => records.get(k) || null, setItem: (k, v) => records.set(k, v), removeItem: k => records.delete(k) }, uuid: () => randomUUID(), plan: () => structuredClone(current),
    source: () => 'w1', savedJobId: () => '', photoDraftId: () => 'local-photos', accept() {},
    fetch: async (url, options = {}) => {
      if (!options.body) return { ok: true, status: 200, json: async () => ({ ok: true, viewer: { id: 'zacb' }, customerId: 'c1', sourceRevision: 'w1r', jobId: '' }) };
      const body = JSON.parse(options.body); bodies.push(options.body);
      if (lose) { lose = false; throw new Error('Response lost'); }
      return { ok: true, status: 200, json: async () => ({ ok: true, requestId: body.requestId, job: { id: 'job-1', customerId: 'c1' }, warnings: [] }) };
    } };
  await assert.rejects(context.window.EGCWalkthroughHandoffClient(deps).save(), /Response lost/);
  current = planInput; // the reloaded page now builds a crew brief as well
  const saved = await context.window.EGCWalkthroughHandoffClient(deps).save();
  assert.equal(saved.result.job.id, 'job-1');
  assert.equal(bodies[1], bodies[0], 'the original frozen request is retried byte for byte');
});

test('jobs saved before the fix stop leaking at once: crew projections strip a signed brief, staff scopes are untouched', async t => {
  const leaked = { id: 'job-leaked', type: 'job', status: 'scheduled', pipelineStatus: 'scheduled', date: '2026-09-24', time: '08:00', endTime: '13:00', assignedCrew: ['crew.one'], customer: 'Synthetic Customer', address: '100 Fixture Lane',
    handoffVersion: 1, operationalScope: { text: LEAKED, updatedBy: 'zacb' }, jobInstructions: { customerGoal: 'Park two cars', keepItems: 'Blue bicycle', customerNotes: 'Customer adds $50 for the fridge', hazards: ['Pest waste'] },
    customerInstructions: 'Customer adds $50 for the fridge', clientChecklists: { preJob: [{ id: 'goal', label: 'Repeat the promised outcome to the crew', detail: 'Park two cars (+$0 extra)' }], postJob: [] },
    internalNotes: `${LEAKED}\nINTERNAL-CANARY`, estimate: { amount: 1675 }, acceptance: { signatureData: 'data:image/png;base64,SYNTHETIC' } };
  const projected = fieldJobProjection(leaked, [], { viewer: 'crew.one' });
  assert.equal(projected.scope, CLEAN);
  assert.equal(projected.customerInstructions, 'Customer adds for the fridge');
  assert.equal(projected.checklist.find(item => item.id === 'client-preJob-goal').detail, 'Park two cars (extra)');
  assert.doesNotMatch(JSON.stringify(projected), MONEY);
  // A recurring visit copied from the job keeps the brief text but not handoffVersion.
  const copy = { ...leaked, id: 'job-copy', handoffVersion: undefined, sourceTemplateJobId: 'job-leaked' };
  assert.equal(fieldJobProjection(copy).scope, CLEAN);
  // Staff-written scope on an ordinary job is the crew's instruction and is never rewritten.
  const staff = { ...leaked, id: 'job-staff', handoffVersion: undefined, operationalScope: { text: 'Collect the $300 balance by check.' } };
  const plainProjection = fieldJobProjection(staff);
  assert.equal(plainProjection.scope, 'Collect the $300 balance by check.');
  assert.equal(plainProjection.customerInstructions, 'Customer adds $50 for the fridge');
  // /api/crew-jobs reads a masked scan: the mask carries handoffVersion, so the crew row is stripped too.
  assert.ok(CREW_PROJECTION_FIELDS.includes('handoffVersion') && CREW_LISTING_FIELDS.includes('handoffVersion'));
  const store = hubStore(); store.rows.set('jobs/job-leaked', { ...leaked, revision: 'leak-r1' });
  const listing = await crewJobsHandlers({ session: async () => ({ user: 'crew.one', displayName: 'Crew One', role: 'crew' }), storage: () => store, now: () => new Date(NOW) })
    .get({ request: new Request('https://easygaragecleaning.com/api/crew-jobs'), env: { FIREBASE_API_KEY: 'firebase-test-crew-scope' } });
  const text = await listing.text(), row = JSON.parse(text).jobs.find(job => job.id === 'job-leaked');
  assert.equal(row.scope, CLEAN);
  assert.doesNotMatch(text, MONEY);
  // internalNotes and the estimate never reach a crew DTO.
  for (const dto of [projected, crewJobProjection(leaked, { viewer: 'crew.one' }), row]) {
    const serialized = JSON.stringify(dto);
    for (const canary of ['internalNotes', 'INTERNAL-CANARY', 'SYNTHETIC', '1675']) assert.equal(serialized.includes(canary), false, canary);
  }
  // Through the real crew-session GET /api/field-jobs as well.
  const { crew } = await crewAndManagerReads(t, { ...leaked, revision: undefined });
  assert.equal(JSON.parse(crew).job.scope, CLEAN);
  assert.doesNotMatch(crew, MONEY);
});

test('a signed job shows checklist labels without amounts wherever crew read them; a staff job keeps its own wording', () => {
  const actor = { user: 'crew.one', displayName: 'Crew One' }, fee = 'Checklist: Collect the agreed disposal fee';
  // A manager-written check on a signed job (the handoff already strips the checks it writes).
  const signed = { id: 'job-fee', type: 'job', status: 'arrived', pipelineStatus: 'arrived', assignedCrew: ['crew.one'], handoffVersion: 1, operationalScope: { text: CLEAN },
    fieldExecution: { checklistTemplate: [{ id: 'fee', stage: 'arrival', label: 'Collect the agreed $75 disposal fee', detail: 'USD 75 in cash', required: true }] },
    clientChecklists: { preJob: [{ id: 'goal', label: 'Repeat the promised outcome to the crew', detail: 'Park two cars' }], postJob: [] } };
  const recorded = { id: randomUUID(), state: 'applied', action: 'checklist', summary: 'Checked: Collect the agreed $75 disposal fee', createdAt: NOW, actorId: 'crew.one', visibility: 'crew' };
  const projected = fieldJobProjection(signed, [recorded], { viewer: 'crew.one' });
  const item = projected.checklist.find(row => row.id === 'fee');
  assert.equal(item.label, 'Collect the agreed disposal fee'); assert.equal(item.detail, 'in cash');
  assert.ok(projected.completionMissing.includes(fee), 'Required before completion');
  assert.equal(projected.history[0].summary, 'Checked: Collect the agreed disposal fee', 'a check recorded before the fix');
  assert.doesNotMatch(JSON.stringify(projected), MONEY);
  assert.equal(hasCrewMoney(JSON.stringify([projected.checklist, projected.completionMissing, projected.history])), false);
  // Starting and completing refuse with what is missing; checking the item records a price-free history entry.
  const clean = error => !hasCrewMoney(error.missing.join('\n'));
  assert.throws(() => fieldCommand(signed, actor, { action: 'status', status: 'in_progress', requestId: randomUUID() }, NOW), error => error.code === 'FIELD_START_INCOMPLETE' && error.missing.includes(fee) && clean(error));
  const working = { ...signed, status: 'in_progress', pipelineStatus: 'in_progress' };
  assert.throws(() => fieldCommand(working, actor, { action: 'complete', hasIssues: false, notes: 'Synthetic closeout notes', requestId: randomUUID() }, NOW), error => error.code === 'FIELD_COMPLETION_INCOMPLETE' && error.missing.includes(fee) && clean(error));
  const checked = fieldCommand(signed, actor, { action: 'checklist', itemId: 'fee', completed: true, requestId: randomUUID() }, NOW);
  assert.equal(checked.event.summary, 'Checked: Collect the agreed disposal fee');
  assert.equal(checked.patch.fieldExecution.checklistTemplate[0].label, 'Collect the agreed $75 disposal fee', 'the stored template is not rewritten');
  // The same check on an ordinary job with a staff-written scope is the crew's instruction and keeps its amount.
  const staff = { ...signed, handoffVersion: undefined, operationalScope: { text: 'Collect the $300 balance by check.' } };
  assert.ok(fieldCompletionMissing(staff).includes('Checklist: Collect the agreed $75 disposal fee'));
  assert.equal(fieldCommand(staff, actor, { action: 'checklist', itemId: 'fee', completed: true, requestId: randomUUID() }, NOW).event.summary, 'Checked: Collect the agreed $75 disposal fee');
  assert.equal(fieldJobProjection(staff, [recorded]).history[0].summary, 'Checked: Collect the agreed $75 disposal fee');
});

// Backfill: rows as the masked scan returns them.
function backfillStore(rows) {
  const store = hubStore();
  store.rows.clear();
  for (const row of rows) store.rows.set(`jobs/${row.id}`, row);
  return store;
}
const leakedRows = () => [
  { id: 'a-handoff', revision: 'a1', type: 'job', handoffVersion: 1, operationalScope: { text: LEAKED, updatedBy: 'zacb', reason: 'Updated in dispatch', approvalKind: 'staff_operational_instructions' }, jobInstructions: { customerGoal: 'Park two cars', crewSize: 1 }, internalNotes: LEAKED },
  { id: 'b-recurring-copy', revision: 'b1', type: 'job', sourceTemplateJobId: 'a-handoff', operationalScope: { text: LEAKED, updatedBy: 'zacb', reason: 'Copied from recurring template' } },
  { id: 'c-legacy-string', revision: 'c1', type: 'job', handoffVersion: 1, jobInstructions: 'EGC INTERNAL JOB BRIEF\nFINISH SOLD: Non-toxic mouse trapping (+$250)' },
  { id: 'd-instructions', revision: 'd1', type: 'job', handoffVersion: 1, operationalScope: { text: CLEAN }, jobInstructions: { customerNotes: 'Adds $50 for the fridge', hazards: ['Pest waste'], estimatedJobMinutes: 240 } },
  { id: 'e-clean', revision: 'e1', type: 'job', handoffVersion: 1, operationalScope: { text: CLEAN }, jobInstructions: { customerGoal: 'Park' } },
  { id: 'f-staff', revision: 'f1', type: 'job', operationalScope: { text: 'Collect the $300 balance by check.' } },
  { id: '_egc_schedule_lock_2026-09-24', revision: 'g1', type: 'job', operationalScope: { text: LEAKED } },
  { id: 'h-availability', revision: 'h1', type: 'availability', recordType: 'crew_availability', reason: '$5' },
];

test('backfill: dry run lists N, apply rewrites N with an audit entry each, a rerun finds 0', async () => {
  assert.deepEqual(parseArgs([]), { apply: false, includeStaff: false, report: '', help: false }, 'dry run of signed briefs is the default');
  assert.equal(parseArgs(['--apply']).apply, true);
  assert.deepEqual(parseArgs(['--include-staff']), { apply: false, includeStaff: true, report: '', help: false });
  assert.throws(() => parseArgs(['--apply', '--dry-run']));
  assert.throws(() => parseArgs(['--force']));
  const store = backfillStore(leakedRows()), requested = [];
  const scan = store.jobRecords; store.jobRecords = async fields => { requested.push(fields); return scan(fields); };
  const before = structuredClone([...store.rows]);
  const dry = await runCrewScopeBackfill(store, { now: NOW, runId: 'run-dry' });
  assert.deepEqual(requested[0], [...SCOPE_FIELDS]);
  assert.equal(dry.mode, 'dry_run');
  assert.deepEqual(dry.preview, [{ id: 'a-handoff', fields: ['operationalScope.text'] }, { id: 'b-recurring-copy', fields: ['operationalScope.text'] }, { id: 'c-legacy-string', fields: ['jobInstructions'] }, { id: 'd-instructions', fields: ['jobInstructions'] }]);
  assert.deepEqual(dry.jobs, { scanned: 8, skippedRecords: 2, clean: 1, staffWritten: [{ id: 'f-staff', fields: ['operationalScope.text'] }] });
  assert.equal(dry.writes.planned, 4); assert.equal(dry.writes.committed, 0);
  assert.equal(store.commits, 0); assert.deepEqual([...store.rows], before, 'a dry run writes nothing');
  assert.doesNotMatch(JSON.stringify(dry), MONEY, 'the report holds ids and field names only');

  const applied = await runCrewScopeBackfill(store, { apply: true, now: NOW, runId: 'run-apply', batchSize: 3 });
  assert.equal(applied.writes.committed, 4); assert.deepEqual(applied.writes.changedDuringRun, []); assert.equal(applied.writes.receipts.length, 2);
  const a = store.rows.get('jobs/a-handoff');
  assert.equal(a.operationalScope.text, CLEAN);
  assert.deepEqual({ ...a.operationalScope, text: undefined }, { text: undefined, updatedBy: 'zacb', reason: 'Updated in dispatch', approvalKind: 'staff_operational_instructions' }, 'the other scope keys stay');
  assert.equal(a.internalNotes, LEAKED, 'the manager-only brief keeps its prices');
  assert.equal(store.rows.get('jobs/b-recurring-copy').operationalScope.text, CLEAN);
  assert.equal(store.rows.get('jobs/c-legacy-string').jobInstructions, 'EGC INTERNAL JOB BRIEF\nFINISH SOLD: Non-toxic mouse trapping');
  assert.deepEqual(store.rows.get('jobs/d-instructions').jobInstructions, { customerNotes: 'Adds for the fridge', hazards: ['Pest waste'], estimatedJobMinutes: 240 });
  assert.equal(store.rows.get('jobs/f-staff').operationalScope.text, 'Collect the $300 balance by check.', 'staff-written scope is never rewritten');
  assert.equal(store.rows.get('jobs/_egc_schedule_lock_2026-09-24').operationalScope.text, LEAKED, 'private records are never touched');
  const audits = [...store.rows].filter(([key]) => key.startsWith('hub_audit/')).map(([, row]) => row);
  assert.deepEqual(audits.map(row => row.entity.id).sort(), ['a-handoff', 'b-recurring-copy', 'c-legacy-string', 'd-instructions']);
  for (const audit of audits) {
    assert.equal(audit.action, 'jobs.crew_scope.prices_removed'); assert.equal(audit.via, 'cron'); assert.equal(audit.actor.id, 'crew-scope-price-backfill'); assert.equal(audit.at, NOW); assert.equal(audit.visibility, 'business');
  }
  assert.ok(JSON.parse(audits.find(row => row.entity.id === 'a-handoff').before).operationalScopeText.includes('(+$200)'), 'the audit keeps the text as it was');
  const receipts = applied.writes.receipts.map(id => store.rows.get(`dispatchOperations/${id}`));
  assert.deepEqual(receipts.flatMap(row => row.targets.map(target => target.id)), ['a-handoff', 'b-recurring-copy', 'c-legacy-string', 'd-instructions']);
  assert.ok(receipts.every(row => row.runId === 'run-apply' && row.createdAt === NOW));

  const commits = store.commits, rerun = await runCrewScopeBackfill(store, { apply: true, now: NOW, runId: 'run-again' });
  assert.equal(rerun.writes.planned, 0); assert.equal(rerun.writes.committed, 0); assert.equal(store.commits, commits, 'a rerun is a no-op');
  assert.deepEqual(rerun.jobs.staffWritten, [{ id: 'f-staff', fields: ['operationalScope.text'] }], 'staff-written scopes are left for review unless --include-staff');
});

test('backfill --include-staff: staff-written scopes are listed, then cleaned with the original text kept in the audit entry', async () => {
  const store = backfillStore(leakedRows());
  const dry = await runCrewScopeBackfill(store, { includeStaff: true, now: NOW, runId: 'run-staff-dry' });
  assert.equal(dry.includeStaff, true);
  assert.deepEqual(dry.preview.find(row => row.id === 'f-staff'), { id: 'f-staff', fields: ['operationalScope.text'], staffWritten: true });
  assert.deepEqual(dry.jobs.staffWritten, []); assert.equal(dry.writes.planned, 5); assert.equal(store.commits, 0);
  const applied = await runCrewScopeBackfill(store, { apply: true, includeStaff: true, now: NOW, runId: 'run-staff' });
  assert.equal(applied.writes.committed, 5);
  assert.equal(store.rows.get('jobs/f-staff').operationalScope.text, 'Collect the balance by check.');
  assert.equal(store.rows.get('jobs/_egc_schedule_lock_2026-09-24').operationalScope.text, LEAKED, 'private records are never touched');
  const audit = [...store.rows.values()].find(row => row.entity?.id === 'f-staff');
  assert.match(audit.reason, /staff-written crew scope/);
  assert.equal(JSON.parse(audit.before).operationalScopeText, 'Collect the $300 balance by check.', 'the only other copy of the staff text');
  assert.ok(applied.writes.receipts.map(id => store.rows.get(`dispatchOperations/${id}`)).some(row => row.targets.some(target => target.id === 'f-staff' && target.staffWritten === true)));
  // The spec's rerun: nothing with an amount is left in any crew scope.
  const rerun = await runCrewScopeBackfill(store, { includeStaff: true, now: NOW, runId: 'run-staff-again' });
  assert.equal(rerun.writes.planned, 0); assert.deepEqual(rerun.jobs.staffWritten, []);
  assert.deepEqual((await runCrewScopeBackfill(store, { now: NOW, runId: 'run-default' })).jobs.staffWritten, []);
});

test('backfill: a job saved during the run is left untouched and reported; the rest of the batch still applies', async () => {
  const store = backfillStore(leakedRows()), commit = store.commit;
  store.commit = async writes => {
    // Dispatch saves a-handoff between the scan and the write.
    if (!store.rows.get('jobs/a-handoff').touched) store.rows.set('jobs/a-handoff', { ...store.rows.get('jobs/a-handoff'), revision: 'a2', touched: true });
    return commit(writes);
  };
  const result = await runCrewScopeBackfill(store, { apply: true, now: NOW, runId: 'run-conflict' });
  assert.deepEqual(result.writes.changedDuringRun, ['a-handoff']);
  assert.equal(result.writes.committed, 3);
  const a = store.rows.get('jobs/a-handoff');
  assert.equal(a.operationalScope.text, LEAKED, 'the conflicting job is untouched');
  assert.equal(a.revision, 'a2');
  assert.equal([...store.rows.keys()].filter(key => key.startsWith('hub_audit/')).length, 3, 'no audit entry for an unwritten job');
  assert.equal(store.rows.get('jobs/b-recurring-copy').operationalScope.text, CLEAN);
  // The next run cleans it.
  store.commit = commit;
  const rerun = await runCrewScopeBackfill(store, { apply: true, now: NOW, runId: 'run-next' });
  assert.deepEqual(rerun.preview, [{ id: 'a-handoff', fields: ['operationalScope.text'] }]);
  assert.equal(store.rows.get('jobs/a-handoff').operationalScope.text, CLEAN);
});

test('backfill: a lost commit response is recovered from its receipt and an unknown failure aborts without guessing', async () => {
  const store = backfillStore(leakedRows()), commit = store.commit;
  store.commit = async writes => { await commit(writes); throw new Error('response lost'); };
  const recovered = await runCrewScopeBackfill(store, { apply: true, now: NOW, runId: 'run-lost' });
  assert.equal(recovered.writes.committed, 4); assert.equal(recovered.aborted, undefined);
  const failing = backfillStore(leakedRows());
  failing.commit = async () => { throw Object.assign(new Error('unavailable'), { code: 'dispatch_storage_unavailable' }); };
  const aborted = await runCrewScopeBackfill(failing, { apply: true, now: NOW, runId: 'run-fail' });
  assert.equal(aborted.aborted.code, 'dispatch_storage_unavailable'); assert.equal(aborted.writes.committed, 0);
  assert.equal(failing.rows.get('jobs/a-handoff').operationalScope.text, LEAKED);
  assert.throws(() => planCrewScopeBackfill(null), error => error.code === 'crew_scope_backfill_input_invalid');
});
