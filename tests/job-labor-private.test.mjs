import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { JOB_LABOR_COSTS, JOB_LABOR_RECEIPTS, legacyJobLabor, legacyJobLaborCents, listJobLabor, saveJobLabor, withoutJobLabor } from '../functions/_lib/job-labor-private.js';
import { jobLaborCostsHandlers } from '../functions/api/job-labor-costs.js';
import { crewJobsHandlers } from '../functions/api/crew-jobs.js';
import { moneyStorage } from '../functions/_lib/money-storage.js';
import { encodeFirestoreFields } from '../functions/_lib/firestore-job.js';
import { applyWrite } from './helpers/commit-write.mjs';
import { parseArgs, planJobLaborBackfill, planJobLaborRestore, runJobLaborBackfill } from '../scripts/backfill-job-labor-private.mjs';

// JOB-COST-PRIVACY: labor dollars live in the server-only jobLaborCosts record, never on the job document every
// business user reads. Synthetic figures only; 15164 cents is the labor canary.
const NOW = '2026-10-05T18:00:00.000Z', LATER = '2026-10-06T18:00:00.000Z';
const owner = { user: 'zacb', role: 'owner', businessAccess: true, displayName: 'Synthetic Owner' };
const manager = { user: 'tylerg', role: 'manager', businessAccess: true, displayName: 'Synthetic Manager' };
const crew = { user: 'crew.solo', role: 'crew', businessAccess: false, displayName: 'Synthetic Crew' };
const OTHER = { disposal: 85.5, disposalCents: 8550, fuel: 12, fuelCents: 1200, recordedAt: '2026-09-25T18:00:00.000Z', recordedBy: 'zacb', source: 'egc_hub' };
const LEGACY_JOB = { type: 'job', customer: 'Synthetic Customer', total: 900, hoursOnSite: 4, crewSize: 1, laborCost: 189.55, costs: { labor: 151.64, laborCents: 15164, ...OTHER } };

function fixture(docs = {}) {
  const rows = new Map(Object.entries(docs).map(([key, row]) => [key, { revision: `${key}-r0`, id: key.split('/')[1], ...structuredClone(row) }]));
  const commits = [];
  let n = 0, hook = null;
  const store = {
    read: async (collection, id) => structuredClone(rows.get(`${collection}/${id}`) ?? null),
    laborRecords: async () => [...rows].filter(([key]) => key.startsWith(`${JOB_LABOR_COSTS}/`)).map(([, row]) => structuredClone(row)),
    laborCopies: async () => [...rows].filter(([key]) => key.startsWith('jobs/')).map(([, row]) => structuredClone(row)),
    async commit(writes) {
      if (hook) { const fn = hook; hook = null; await fn(writes); }
      const keys = new Set();
      for (const write of writes) {
        const key = `${write.collection}/${write.id}`, old = rows.get(key);
        assert(!keys.has(key), 'one write per document per commit'); keys.add(key);
        if (write.revision ? old?.revision !== write.revision : write.delete ? !old : old) throw Object.assign(new Error('Conflict'), { code: 'money_revision_conflict', status: 409 });
      }
      commits.push(structuredClone(writes));
      for (const write of writes) {
        const key = `${write.collection}/${write.id}`;
        if (write.delete) { rows.delete(key); continue; }
        rows.set(key, { ...applyWrite(write.revision ? rows.get(key) : {}, write), id: write.id, revision: `r${++n}` });
      }
    },
  };
  return { rows, store, commits, beforeCommit: fn => { hook = fn; } };
}
const input = (fields = {}) => ({ requestId: randomUUID(), jobId: 'job-costed', laborCents: 20250, expectedRevision: null, ...fields });
const viewer = (session, visible) => ({ ...session, laborCostVisible: visible });

test('the owner\'s labor save creates the private record and moves the job\'s copy off it, in one commit', async () => {
  const f = fixture({ 'jobs/job-costed': LEGACY_JOB }), body = input();
  const saved = await saveJobLabor(f.store, viewer(owner, true), body, NOW);
  assert.deepEqual(saved, { ok: true, authority: 'employee_hub', replayed: false, labor: { jobId: 'job-costed', laborCents: 20250, recordedAt: NOW, recordedBy: 'zacb', revision: 'r1' } });
  assert.equal(f.commits.length, 1);
  assert.deepEqual(f.commits[0].map(write => [write.collection, write.revision ?? null, write.remove ?? null]), [
    [JOB_LABOR_COSTS, null, null], ['jobs', 'jobs/job-costed-r0', ['costs.labor', 'costs.laborCents', 'laborCost']], [JOB_LABOR_RECEIPTS, null, null], ['hub_audit', null, null]]);
  const job = f.rows.get('jobs/job-costed'), audit = f.commits[0][3].patch;
  assert.deepEqual([job.laborCost, job.costs.labor, job.costs.laborCents, job.costs.disposalCents], [undefined, undefined, undefined, 8550], 'the other costs stay');
  assert.deepEqual([audit.visibility, audit.action, JSON.parse(audit.before), JSON.parse(audit.after)], ['owner', 'money.labor.save', { laborCents: 15164 }, { laborCents: 20250 }]);
  // A replay returns the saved record; the same id with another payload or actor is refused.
  assert.deepEqual(await saveJobLabor(f.store, viewer(owner, true), structuredClone(body), LATER), { ...saved, replayed: true });
  await assert.rejects(saveJobLabor(f.store, viewer(owner, true), { ...body, laborCents: 1 }, NOW), error => error.code === 'job_labor_idempotency_conflict' && error.status === 409);
  // An update needs the record's revision; a stale one writes nothing.
  await assert.rejects(saveJobLabor(f.store, viewer(owner, true), input({ laborCents: 5 }), NOW), error => error.code === 'job_labor_revision_conflict' && error.status === 409);
  const updated = await saveJobLabor(f.store, viewer(owner, true), input({ laborCents: 0, expectedRevision: 'r1' }), LATER);
  assert.deepEqual([updated.labor.laborCents, f.commits.length, f.commits[1].some(write => write.collection === 'jobs')], [0, 2, false], 'zero is a figure, and a clean job is not rewritten');
});

test('only a viewer who sees labor dollars saves or lists them; everyone else is refused before any read', async () => {
  const f = fixture({ 'jobs/job-costed': LEGACY_JOB }), reads = [];
  const store = { ...f.store, read: async (...args) => { reads.push(args); return f.store.read(...args); }, laborRecords: async () => { reads.push(['list']); return f.store.laborRecords(); } };
  for (const [actor, code, status] of [[viewer(manager, false), 'job_labor_owner_only', 403], [manager, 'job_labor_owner_only', 403], [viewer(owner, false), 'job_labor_owner_only', 403], [viewer(crew, true), 'job_labor_forbidden', 403], [null, 'job_labor_sign_in_required', 401]]) {
    await assert.rejects(saveJobLabor(store, actor, input(), NOW), error => error.code === code && error.status === status, JSON.stringify(actor));
    await assert.rejects(listJobLabor(store, actor), error => error.code === code, JSON.stringify(actor));
  }
  assert.deepEqual(reads, []);
  // Without the handler's answer only the owner sees labor dollars, the flag's default.
  assert.equal((await saveJobLabor(store, owner, input(), NOW)).labor.laborCents, 20250);
  for (const bad of [{ laborCents: -1 }, { laborCents: 1.5 }, { laborCents: 100000001 }, { laborCents: '100' }, { jobId: '_egc_lock' }, { jobId: 'secure_vault' }, { requestId: 'not-a-uuid' }, { expectedRevision: undefined }, { extra: true }, { actorId: 'someone.else' }])
    await assert.rejects(saveJobLabor(f.store, viewer(owner, true), input(bad), NOW), error => /^job_labor_(request_invalid|invalid_amount|actor_changed)$/.test(error.code), JSON.stringify(bad));
  const walk = fixture({ 'jobs/walk-1': { type: 'walkthrough' } });
  await assert.rejects(saveJobLabor(walk.store, viewer(owner, true), input({ jobId: 'walk-1' }), NOW), error => error.code === 'job_labor_job_not_found' && error.status === 404);
});

test('a lost commit response is recovered from the receipt, and other storage failures ask for the same request again', async () => {
  const f = fixture({ 'jobs/job-costed': LEGACY_JOB }), body = input();
  const commit = f.store.commit;
  f.store.commit = async writes => { await commit(writes); throw Object.assign(new Error('lost'), { code: 'money_outcome_unknown', status: 503 }); };
  assert.equal((await saveJobLabor(f.store, viewer(owner, true), body, NOW)).labor.laborCents, 20250);
  f.store.commit = async () => { throw Object.assign(new Error('down'), { code: 'money_storage_unavailable', status: 503 }); };
  await assert.rejects(saveJobLabor(f.store, viewer(owner, true), input({ expectedRevision: 'r1' }), NOW), error => error.code === 'job_labor_outcome_unknown' && error.status === 503);
  f.store.commit = async () => { throw Object.assign(new Error('raced'), { code: 'money_revision_conflict', status: 409 }); };
  await assert.rejects(saveJobLabor(f.store, viewer(owner, true), input({ expectedRevision: 'r1' }), NOW), error => error.code === 'job_labor_revision_conflict');
});

test('listing fails closed on a record it cannot read, never showing a partial list', async () => {
  const f = fixture({ 'jobLaborCosts/b-job': { jobId: 'b-job', laborCents: 100 }, 'jobLaborCosts/a-job': { jobId: 'a-job', laborCents: 0, recordedAt: NOW, recordedBy: 'zacb' }, 'jobLaborCosts/c-job': { jobId: 'c-job', laborCents: null, recordedAt: NOW, recordedBy: 'zacb' } });
  assert.deepEqual(await listJobLabor(f.store, viewer(owner, true)), [
    { jobId: 'a-job', laborCents: 0, recordedAt: NOW, recordedBy: 'zacb', revision: 'jobLaborCosts/a-job-r0' }, { jobId: 'b-job', laborCents: 100, recordedAt: null, recordedBy: null, revision: 'jobLaborCosts/b-job-r0' },
    { jobId: 'c-job', laborCents: null, recordedAt: NOW, recordedBy: 'zacb', revision: 'jobLaborCosts/c-job-r0' }], 'a null figure is the owner\'s blank (unknown)');
  for (const bad of [{ laborCents: 1.5 }, { laborCents: undefined }, { laborCents: -1 }, { laborCents: '100' }]) {
    const broken = fixture({ 'jobLaborCosts/a-job': { jobId: 'a-job', ...bad } });
    await assert.rejects(listJobLabor(broken.store, viewer(owner, true)), error => error.code === 'job_labor_storage_incomplete' && error.status === 503);
  }
  await assert.rejects(listJobLabor({ laborRecords: async () => { throw new Error('down'); } }, viewer(owner, true)), error => error.code === 'job_labor_storage_unavailable');
});

test('the legacy copy reads as the finance board and /api/money showed it, and is stripped whole', () => {
  assert.equal(legacyJobLaborCents(LEGACY_JOB), 15164);
  assert.equal(legacyJobLaborCents({ costs: { labor: 151.64 }, laborCost: 1 }), 15164);
  assert.equal(legacyJobLaborCents({ laborCost: 189.55 }), 18955);
  assert.equal(legacyJobLaborCents({ costs: { labor: 0 }, laborCost: 1 }), 0, 'zero is a figure');
  assert.equal(legacyJobLaborCents({ costs: { disposal: 1 } }), null);
  assert.equal(legacyJobLaborCents({ laborCost: 2000000 }), null, 'beyond what a record holds: left for review');
  assert.deepEqual(withoutJobLabor(LEGACY_JOB), { type: 'job', customer: 'Synthetic Customer', total: 900, hoursOnSite: 4, crewSize: 1, costs: OTHER });
  const clean = { type: 'job', costs: { disposal: 1 } };
  assert.equal(withoutJobLabor(clean), clean);
});

test('a blank costs.labor hides an older laborCost, and copies that disagree or cannot be read are left for the owner', () => {
  const state = job => { const legacy = legacyJobLabor(job); return [legacy.state, legacy.cents, legacy.reason ?? null, legacy.figure]; };
  // Readers before the private record: the finance board showed costs.labor, else laborCost (a blank costs.labor
  // hides laborCost), and /api/money showed costs.laborCents, else costs.labor. A laborCost behind costs.labor never showed.
  assert.deepEqual(state({ costs: { labor: 200, laborCents: 20000 } }), ['value', 20000, null, true]);
  assert.deepEqual(state({ costs: { labor: 151.64 }, laborCost: 999 }), ['value', 15164, null, true], 'a shadowed laborCost was never shown');
  assert.deepEqual(state({ costs: { labor: 200, laborCents: 15000 } }), ['review', null, 'labor_copies_disagree', true], 'the board showed $200, /api/money $150');
  assert.deepEqual(state({ laborCost: 150, costs: { laborCents: 20000 } }), ['review', null, 'labor_copies_disagree', true]);
  assert.deepEqual(state({ laborCost: 311.19, costs: { labor: null } }), ['unknown', null, null, true], 'the owner marked it unknown: never 31119');
  assert.deepEqual(state({ costs: { labor: null, laborCents: 15000 } }), ['review', null, 'labor_copies_disagree', true]);
  assert.deepEqual(state({ costs: { labor: null } }), ['unknown', null, null, false], 'a lone blank reveals nothing');
  assert.deepEqual(state({ costs: { labor: '$177.03' } }), ['review', null, 'labor_copy_unreadable', true]);
  assert.deepEqual(state({ costs: { labor: 177.03, laborCents: 'x' } }), ['review', null, 'labor_copy_unreadable', true]);
  assert.deepEqual(state({ laborCost: null }), ['empty', null, null, false]);
  assert.deepEqual(state({ costs: { disposal: 1 } }), ['none', null, null, false]);
  for (const job of [{ costs: { labor: 200, laborCents: 15000 } }, { laborCost: 311.19, costs: { labor: null } }, { costs: { labor: '$177.03' } }]) assert.equal(legacyJobLaborCents(job), null, JSON.stringify(job));
});

test('the owner can leave labor unknown: a null figure blanks a saved one and moves any copy off the job', async () => {
  const f = fixture({ 'jobs/job-costed': LEGACY_JOB, 'jobs/blank-only': { type: 'job', laborCost: 311.19, costs: { labor: null, disposal: 1 } } });
  const saved = await saveJobLabor(f.store, viewer(owner, true), input(), NOW);
  const blank = await saveJobLabor(f.store, viewer(owner, true), input({ laborCents: null, expectedRevision: saved.labor.revision }), LATER);
  assert.deepEqual([blank.labor.laborCents, f.rows.get('jobLaborCosts/job-costed').laborCents], [null, null]);
  const audit = f.commits[1].find(write => write.collection === 'hub_audit').patch;
  assert.deepEqual([JSON.parse(audit.before), JSON.parse(audit.after)], [{ laborCents: 20250 }, { laborCents: null }]);
  // A blank on the job hiding an older laborCost: both go, and the record holds the blank.
  await saveJobLabor(f.store, viewer(owner, true), input({ jobId: 'blank-only', laborCents: null }), NOW);
  const job = f.rows.get('jobs/blank-only');
  assert.deepEqual([job.laborCost, 'labor' in job.costs, job.costs.disposal, f.rows.get('jobLaborCosts/blank-only').laborCents], [undefined, false, 1, null]);
  await assert.rejects(saveJobLabor(f.store, viewer(owner, true), (({ laborCents, ...rest }) => rest)(input()), NOW), error => error.code === 'job_labor_invalid_amount', 'the figure, or null, is required');
  // Through the API.
  const api2 = jobLaborCostsHandlers({ session: async () => owner, storage: () => f.store, now: () => new Date(NOW) });
  const response = await api2.post({ request: new Request('https://easygaragecleaning.com/api/job-labor-costs', { method: 'POST', headers: { Origin: 'https://easygaragecleaning.com', 'Content-Type': 'application/json' }, body: JSON.stringify(input({ laborCents: 0, expectedRevision: blank.labor.revision })) }), env: {} });
  assert.deepEqual([response.status, (await response.json()).labor.laborCents], [200, 0]);
  const listed = await (await api2.get({ request: new Request('https://easygaragecleaning.com/api/job-labor-costs', { headers: { 'Sec-Fetch-Site': 'same-origin' } }), env: {} })).json();
  assert.deepEqual(listed.jobs.map(row => [row.jobId, row.laborCents]), [['blank-only', null], ['job-costed', 0]]);
});

test('EGC_STAFF_PAY_OWNER_ONLY=false: every labor save also writes costs.labor onto the job as the Hub dialog did, and nothing is removed', async () => {
  const f = fixture({ 'jobs/job-costed': LEGACY_JOB }), flagOff = { ...manager, laborCostVisible: true, laborOnJob: true };
  const saved = await saveJobLabor(f.store, flagOff, input(), NOW);
  const job = f.rows.get('jobs/job-costed'), write = f.commits[0].find(item => item.collection === 'jobs');
  assert.deepEqual([write.revision, write.mask, write.remove], ['jobs/job-costed-r0', ['costs.labor'], undefined]);
  assert.deepEqual(job, { ...LEGACY_JOB, id: 'job-costed', revision: job.revision, costs: { ...LEGACY_JOB.costs, labor: 202.5 } }, 'only costs.labor changes: laborCents and laborCost stay as a dialog save left them');
  assert.equal(f.rows.get('jobLaborCosts/job-costed').laborCents, 20250, 'the record gets the same figure');
  await saveJobLabor(f.store, flagOff, input({ laborCents: null, expectedRevision: saved.labor.revision }), LATER);
  assert.equal(f.rows.get('jobs/job-costed').costs.labor, null, 'a blank is a blank costs.labor, as before');
  // The handler resolves the flag from env: the same manager request writes onto the job only with the flag off.
  const env = { EGC_STAFF_PAY_OWNER_ONLY: 'false' }, g = fixture({ 'jobs/job-costed': { type: 'job', costs: { disposal: 1 } } });
  const response = await jobLaborCostsHandlers({ session: async () => manager, storage: () => g.store, now: () => new Date(NOW) }).post({ request: new Request('https://easygaragecleaning.com/api/job-labor-costs', { method: 'POST', headers: { Origin: 'https://easygaragecleaning.com', 'Content-Type': 'application/json' }, body: JSON.stringify(input({ laborCents: 12345 })) }), env });
  assert.equal(response.status, 200);
  assert.deepEqual(g.rows.get('jobs/job-costed').costs, { disposal: 1, labor: 123.45 });
});

// ---- /api/job-labor-costs ------------------------------------------------------------------------------------------
const api = (session, store) => jobLaborCostsHandlers({ session: async () => session, storage: () => store, now: () => new Date(NOW) });
const get = (query = '', headers = { 'Sec-Fetch-Site': 'same-origin' }) => new Request(`https://easygaragecleaning.com/api/job-labor-costs${query}`, { headers });
const post = (body, headers = {}) => new Request('https://easygaragecleaning.com/api/job-labor-costs', { method: 'POST', headers: { Origin: 'https://easygaragecleaning.com', 'Content-Type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });

test('GET answers a manager "hidden" with no figures, and the owner (or everyone, flag off) the records', async () => {
  const f = fixture({ 'jobLaborCosts/job-costed': { jobId: 'job-costed', laborCents: 15164, recordedAt: NOW, recordedBy: 'zacb' } });
  const hidden = await api(manager, f.store).get({ request: get(), env: {} }), text = await hidden.text();
  assert.equal(hidden.status, 200); assert.equal(hidden.headers.get('Cache-Control'), 'no-store');
  assert.deepEqual(JSON.parse(text), { ok: true, authority: 'employee_hub', laborCostHidden: true, jobs: null, asOf: NOW });
  assert.equal(/15164|151\.64/.test(text), false);
  for (const [session, env] of [[owner, {}], [manager, { EGC_STAFF_PAY_OWNER_ONLY: 'false' }]]) {
    const body = await (await api(session, f.store).get({ request: get(), env })).json();
    assert.deepEqual([body.laborCostHidden, body.complete, body.jobs.map(row => [row.jobId, row.laborCents])], [false, true, [['job-costed', 15164]]], session.user);
  }
  assert.deepEqual([(await api(crew, f.store).get({ request: get(), env: {} })).status, (await api(null, f.store).get({ request: get(), env: {} })).status], [403, 401]);
  assert.equal((await api(owner, f.store).get({ request: get('?jobId=job-costed'), env: {} })).status, 400);
  assert.equal((await api(owner, f.store).get({ request: get('', { 'Sec-Fetch-Site': 'cross-site' }), env: {} })).status, 403);
  const broken = await api(owner, { laborRecords: async () => [{ id: 'x', laborCents: 'lots', revision: 'r' }] }).get({ request: get(), env: {} });
  assert.deepEqual([broken.status, (await broken.json()).code], [503, 'job_labor_storage_incomplete']);
});

test('POST saves the owner\'s figure and refuses a manager, other origins, non-JSON and oversized bodies', async () => {
  const f = fixture({ 'jobs/job-costed': LEGACY_JOB }), body = input();
  const saved = await api(owner, f.store).post({ request: post(body), env: {} });
  assert.equal(saved.status, 200); assert.equal((await saved.json()).labor.laborCents, 20250);
  const refused = await api(manager, f.store).post({ request: post(input({ expectedRevision: 'r1' })), env: {} });
  assert.deepEqual([refused.status, (await refused.json()).code], [403, 'job_labor_owner_only']);
  assert.equal((await api(manager, f.store).post({ request: post(input({ expectedRevision: 'r1', laborCents: 1 })), env: { EGC_STAFF_PAY_OWNER_ONLY: 'false' } })).status, 200, 'flag off: managers enter labor as before');
  for (const [request, status] of [[post(body, { Origin: 'https://evil.example' }), 403], [post(body, { 'Sec-Fetch-Site': 'cross-site' }), 403], [post(body, { 'Content-Type': 'text/plain' }), 415], [post('x'.repeat(5000)), 413], [post('{'), 400]])
    assert.equal((await api(owner, f.store).post({ request, env: {} })).status, status);
  const lost = await api(owner, { read: async () => { throw new Error('private detail'); } }).post({ request: post(input()), env: {} }), lostBody = await lost.text();
  assert.equal(lost.status, 503); assert.equal(lostBody.includes('private detail'), false);
});

// ---- A raw job to a manager (crew-jobs) --------------------------------------------------------------------------
test('POST /api/crew-jobs never hands a manager who does not see labor dollars the job\'s labor copy', async t => {
  const message = { id: 'crew-synthetic-request-1', requestId: 'synthetic-request-1', direction: 'to_customer', authorRole: 'manager', authorName: 'Synthetic Manager', body: 'On our way', createdAt: NOW, delivery: { channel: 'sms', status: 'sent' } };
  const document = { name: 'projects/egcw-1ec83/databases/(default)/documents/jobs/job-costed', fields: encodeFirestoreFields({ ...LEGACY_JOB, customerConversation: [message] }), updateTime: '2026-10-05T18:00:00.000000Z' };
  t.mock.method(globalThis, 'fetch', async url => { assert.equal(new URL(String(url)).hostname, 'firestore.googleapis.com'); return Response.json(document); });
  const send = async (session, env = {}) => (await crewJobsHandlers({ session: async () => session, now: () => new Date(NOW) }).post({
    request: new Request('https://easygaragecleaning.com/api/crew-jobs', { method: 'POST', headers: { Origin: 'https://easygaragecleaning.com', 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'send_customer_message', jobId: 'job-costed', body: 'On our way', requestId: 'synthetic-request-1' }) }),
    env: { FIREBASE_API_KEY: 'firebase-test-job-labor', ...env } })).json();
  const hidden = await send(manager);
  assert.equal(hidden.duplicate, true);
  assert.deepEqual([hidden.job.laborCost, hidden.job.costs.labor, hidden.job.costs.laborCents, hidden.job.costs.disposalCents], [undefined, undefined, undefined, 8550]);
  assert.equal(/15164|151\.64|189\.55/.test(JSON.stringify(hidden)), false);
  assert.equal((await send(owner)).job.costs.laborCents, 15164, 'the owner still gets the whole job');
  assert.equal((await send(manager, { EGC_STAFF_PAY_OWNER_ONLY: 'false' })).job.costs.laborCents, 15164, 'flag off: as before');
});

test('moneyStorage sends a write\'s `mask` as its update mask and a `delete` write under its revision', async () => {
  let body = null;
  const store = moneyStorage({ FIREBASE_API_KEY: 'firebase-test-job-labor' }, async (_env, _url, init) => { body = JSON.parse(init.body); return Response.json({}); });
  await store.commit([{ collection: 'jobs', id: 'job-costed', revision: 'r1', patch: { costs: { labor: 202.5 } }, mask: ['costs.labor'] }, { collection: 'jobLaborCosts', id: 'job-costed', revision: 'r2', delete: true }]);
  assert.deepEqual(body.writes[0].updateMask.fieldPaths, ['costs.labor']);
  assert.deepEqual(body.writes[0].update.fields, { costs: { mapValue: { fields: { labor: { doubleValue: 202.5 } } } } });
  assert.deepEqual(body.writes[1], { delete: 'projects/egcw-1ec83/databases/(default)/documents/jobLaborCosts/job-costed', currentDocument: { updateTime: 'r2' } });
});

test('moneyStorage deletes a write\'s `remove` paths through the update mask', async () => {
  let body = null;
  const store = moneyStorage({ FIREBASE_API_KEY: 'firebase-test-job-labor' }, async (_env, _url, init) => { body = JSON.parse(init.body); return Response.json({}); });
  await store.commit([{ collection: 'jobs', id: 'job-costed', revision: '2026-10-05T18:00:00.000000Z', patch: { costs: { disposalCents: 1 } }, remove: ['laborCost'] }, { collection: 'jobs', id: 'job-two', revision: 'r', patch: {}, remove: ['costs.labor', 'costs.laborCents'] }]);
  assert.deepEqual(body.writes.map(write => [write.updateMask.fieldPaths, Object.keys(write.update.fields)]), [[['costs', 'laborCost'], ['costs']], [['costs.labor', 'costs.laborCents'], []]]);
});

test('firestore.rules keep labor records server-only and refuse a browser write that adds or changes a labor copy on a job, or drops one not yet moved', () => {
  const rules = readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8');
  for (const collection of ['jobLaborCosts', 'jobLaborCostOperations']) assert.match(rules, new RegExp(`match /${collection}/\\{documentId\\} \\{\\s*allow read, write: if false;\\s*\\}`), collection);
  const jobs = rules.slice(rules.indexOf('match /jobs/{documentId}'), rules.indexOf('match /customers/{documentId}'));
  assert.match(jobs, /allow create: if [^;]*jobLaborUnchanged\(request\.resource\.data, \{\}, documentId\);/);
  assert.match(jobs, /allow update: if [^;]*jobLaborUnchanged\(request\.resource\.data, resource\.data, documentId\);/);
  const helpers = rules.slice(rules.indexOf('function laborCopy('), rules.indexOf('match /jobs/{documentId}'));
  for (const field of ["'laborCost'", "'labor'", "'laborCents'"]) assert.ok(helpers.includes(field), field);
  // Dropping or blanking a copy needs the job's private record first (the emulator suite runs the rule itself).
  assert.match(helpers, /laborCopiesKept\(next, previous\) \|\|\s*laborCopiesKeptOrDropped\(next, previous\) &&\s*exists\(\/databases\/\$\(database\)\/documents\/jobLaborCosts\/\$\(documentId\)\)/);
});

// ---- scripts/backfill-job-labor-private.mjs ------------------------------------------------------------------------
const BACKFILL = {
  'jobs/copy-only': { type: 'job', laborCost: 189.55, costs: { labor: 151.64, laborCents: 15164, disposal: 85.5, recordedAt: '2026-09-25T18:00:00.000Z', recordedBy: 'zacb' } },
  'jobs/top-level-only': { type: 'job', laborCost: 60 },
  'jobs/record-wins': { type: 'job', costs: { labor: 999, fuel: 12 } },
  'jobLaborCosts/record-wins': { jobId: 'record-wins', laborCents: 15164, source: 'egc_hub' },
  'jobs/clean': { type: 'job', costs: { disposal: 10 } },
  'jobs/unreadable': { type: 'job', laborCost: 'about $150' },
  'jobs/_egc_schedule_lock_2026-10-05': { recordType: 'schedule_lock', laborCost: 1 },
  'jobs/secure_vault': { recordType: 'employee_hub_v2' },
};

test('the backfill dry run plans each move and writes nothing; the report carries no labor figure', async () => {
  const f = fixture(BACKFILL), report = await runJobLaborBackfill(f.store, { now: NOW, runId: 'run-1' });
  assert.equal(f.commits.length, 0);
  assert.deepEqual([report.mode, report.jobs.clean, report.jobs.skippedRecords, report.jobs.needsReview], ['dry_run', 1, 2, [{ id: 'unreadable', fields: ['laborCost'], reason: 'labor_copy_unreadable' }]]);
  assert.deepEqual(report.preview, [{ id: 'copy-only', action: 'move', fields: ['costs.labor', 'costs.laborCents', 'laborCost'] }, { id: 'record-wins', action: 'remove_copy', fields: ['costs.labor'] }, { id: 'top-level-only', action: 'move', fields: ['laborCost'] }]);
  assert.deepEqual([report.writes.planned, report.writes.moves, report.writes.copiesRemovedOnly], [3, 2, 1]);
  assert.equal(/15164|151\.64|189\.55|18955|6000|999/.test(JSON.stringify(report)), false);
  assert.throws(() => planJobLaborBackfill(null, []), error => error.code === 'job_labor_backfill_input_invalid');
});

test('--apply moves copies with preconditions, an owner-only audit and a receipt in one commit, and a rerun is a no-op', async () => {
  const f = fixture(BACKFILL), report = await runJobLaborBackfill(f.store, { apply: true, now: NOW, runId: 'run-1' });
  assert.deepEqual([report.mode, report.writes.committed, report.writes.changedDuringRun, f.commits.length], ['apply', 3, [], 1]);
  const record = id => f.rows.get(`jobLaborCosts/${id}`), job = id => f.rows.get(`jobs/${id}`);
  assert.deepEqual([record('copy-only').laborCents, record('copy-only').source, record('copy-only').recordedBy, record('copy-only').movedAt], [15164, 'legacy_job', 'zacb', NOW]);
  assert.deepEqual([record('top-level-only').laborCents, record('record-wins').laborCents, record('record-wins').source], [6000, 15164, 'egc_hub']);
  assert.deepEqual([job('copy-only').costs, job('copy-only').laborCost, job('top-level-only').laborCost, job('record-wins').costs], [{ disposal: 85.5, recordedAt: '2026-09-25T18:00:00.000Z', recordedBy: 'zacb' }, undefined, undefined, { fuel: 12 }]);
  assert.deepEqual([job('unreadable').laborCost, job('_egc_schedule_lock_2026-10-05').laborCost], ['about $150', 1], 'review items and private rows are never written');
  const writes = f.commits[0], audits = writes.filter(write => write.collection === 'hub_audit');
  assert.ok(writes.filter(write => write.collection === 'jobs').every(write => write.revision && write.remove.length));
  assert.ok(writes.filter(write => write.collection === JOB_LABOR_COSTS).every(write => !write.revision), 'records are create-only');
  assert.deepEqual([audits.length, audits.every(write => write.patch.visibility === 'owner')], [3, true]);
  assert.equal(writes.filter(write => write.collection === JOB_LABOR_RECEIPTS).length, 1);
  const rerun = await runJobLaborBackfill(f.store, { apply: true, now: LATER, runId: 'run-2' });
  assert.deepEqual([rerun.writes.planned, f.commits.length], [0, 1]);
});

test('a job or record saved during the run is skipped and reported while the rest is written, and a lost response is recovered', async () => {
  const f = fixture(BACKFILL);
  f.beforeCommit(() => { f.rows.get('jobs/copy-only').revision = 'saved-meanwhile'; });
  const report = await runJobLaborBackfill(f.store, { apply: true, now: NOW, runId: 'run-1' });
  assert.deepEqual([report.writes.committed, report.writes.changedDuringRun], [2, ['copy-only']]);
  assert.equal(f.rows.get('jobs/copy-only').costs.laborCents, 15164, 'the changed job is left for a rerun');
  const lost = fixture(BACKFILL), commit = lost.store.commit;
  lost.store.commit = async writes => { await commit(writes); throw Object.assign(new Error('lost'), { code: 'money_outcome_unknown' }); };
  const recovered = await runJobLaborBackfill(lost.store, { apply: true, now: NOW, runId: 'run-1' });
  assert.deepEqual([recovered.writes.committed, recovered.aborted], [3, undefined]);
  const failing = fixture(BACKFILL);
  failing.store.commit = async () => { throw Object.assign(new Error('down'), { code: 'money_outcome_unknown' }); };
  assert.equal((await runJobLaborBackfill(failing.store, { apply: true, now: NOW, runId: 'run-1' })).aborted.code, 'money_outcome_unknown');
});

test('the backfill never moves a laborCost over a blank, and leaves disagreeing or unreadable copies for the owner', async () => {
  const EDGE = {
    'jobs/blank-hides-old': { type: 'job', laborCost: 311.19, costs: { labor: null, disposal: 1 } },
    'jobs/blank-only': { type: 'job', costs: { labor: null, disposal: 1 } },
    'jobs/disagree': { type: 'job', costs: { labor: 200, laborCents: 15000 } },
    'jobs/disagree-moved': { type: 'job', costs: { labor: 200, laborCents: 15000 } },
    'jobLaborCosts/disagree-moved': { jobId: 'disagree-moved', laborCents: 20000, source: 'egc_hub' },
    'jobs/dollar-sign': { type: 'job', costs: { labor: '$177.03' } },
    'jobs/agree': { type: 'job', costs: { labor: 200, laborCents: 20000 } },
  };
  const f = fixture(EDGE), report = await runJobLaborBackfill(f.store, { apply: true, now: NOW, runId: 'run-1' });
  assert.deepEqual(report.jobs.needsReview, [{ id: 'disagree', fields: ['costs.labor', 'costs.laborCents'], reason: 'labor_copies_disagree' }, { id: 'dollar-sign', fields: ['costs.labor'], reason: 'labor_copy_unreadable' }]);
  assert.deepEqual(report.preview, [{ id: 'agree', action: 'move', fields: ['costs.labor', 'costs.laborCents'] }, { id: 'blank-hides-old', action: 'move', fields: ['costs.labor', 'laborCost'] }, { id: 'disagree-moved', action: 'remove_copy', fields: ['costs.labor', 'costs.laborCents'] }]);
  assert.equal(report.jobs.clean, 1, 'a lone blank reveals nothing and stays');
  const record = id => f.rows.get(`jobLaborCosts/${id}`), job = id => f.rows.get(`jobs/${id}`);
  assert.deepEqual([record('blank-hides-old').laborCents, job('blank-hides-old').laborCost, 'labor' in job('blank-hides-old').costs], [null, undefined, false], 'the blank moves, and the old figure goes with it');
  assert.deepEqual([record('agree').laborCents, record('disagree-moved').laborCents, record('disagree'), record('dollar-sign')], [20000, 20000, undefined, undefined]);
  assert.deepEqual([job('disagree').costs, job('dollar-sign').costs, job('blank-only').costs], [{ labor: 200, laborCents: 15000 }, { labor: '$177.03' }, { labor: null, disposal: 1 }], 'review copies and a lone blank are never written');
  const rerun = await runJobLaborBackfill(f.store, { now: LATER, runId: 'run-2' });
  assert.deepEqual([rerun.writes.planned, rerun.jobs.needsReview.length], [0, 2], 'a rerun changes nothing and still lists the review items');
});

test('--restore writes every record back onto its job and deletes it, so the older code shows the owner\'s figure; a later backfill moves it again', async () => {
  const RESTORE = {
    'jobs/moved': { type: 'job', costs: { disposal: 85.5, recordedAt: '2026-09-25T18:00:00.000Z' } },
    'jobLaborCosts/moved': { jobId: 'moved', laborCents: 15164, source: 'legacy_job' },
    'jobs/blanked': { type: 'job', costs: { disposal: 1, laborCents: 5 } },
    'jobLaborCosts/blanked': { jobId: 'blanked', laborCents: null, source: 'egc_hub' },
    'jobs/flag-off': { type: 'job', costs: { labor: 202.5, disposal: 1 }, laborCost: 189.55 },
    'jobLaborCosts/flag-off': { jobId: 'flag-off', laborCents: 20250, source: 'egc_hub' },
    'jobLaborCosts/gone': { jobId: 'gone', laborCents: 100, source: 'egc_hub' },
    'jobLaborCosts/broken': { jobId: 'broken', laborCents: 'lots' },
    'jobs/untouched': { type: 'job', costs: { disposal: 2 } },
  };
  const f = fixture(RESTORE), dry = await runJobLaborBackfill(f.store, { restore: true, now: NOW, runId: 'restore-1' });
  assert.deepEqual([dry.mode, f.commits.length, dry.writes.planned, dry.records.missingJobs, dry.records.unreadableRecords], ['restore_dry_run', 0, 3, [{ id: 'gone', reason: 'job_missing' }], [{ id: 'broken', reason: 'labor_record_unreadable' }]]);
  assert.equal(/15164|151\.64|20250|202\.5/.test(JSON.stringify(dry)), false, 'the report carries no labor figure');
  const applied = await runJobLaborBackfill(f.store, { restore: true, apply: true, now: NOW, runId: 'restore-1' });
  assert.deepEqual([applied.mode, applied.writes.committed, f.commits.length], ['restore_apply', 3, 1]);
  const job = id => f.rows.get(`jobs/${id}`), previous = row => Number(row.costs?.labor ?? row.laborCost ?? NaN);
  assert.deepEqual(job('moved').costs, { disposal: 85.5, recordedAt: '2026-09-25T18:00:00.000Z', labor: 151.64, laborCents: 15164 });
  assert.deepEqual(job('blanked').costs, { disposal: 1, labor: null }, 'a blank goes back as a blank costs.labor');
  assert.deepEqual([job('flag-off').costs, job('flag-off').laborCost], [{ labor: 202.5, disposal: 1, laborCents: 20250 }, 189.55]);
  assert.deepEqual([previous(job('moved')), previous(job('flag-off'))], [151.64, 202.5], 'the finance board before this change reads costs.labor, then laborCost');
  assert.deepEqual(['moved', 'blanked', 'flag-off', 'gone', 'broken'].map(id => f.rows.has(`jobLaborCosts/${id}`)), [false, false, false, true, true], 'restored records are deleted; the rest stay');
  const writes = f.commits[0];
  assert.ok(writes.filter(write => write.collection === 'jobs').every(write => write.revision && write.mask.join() === 'costs.labor,costs.laborCents'));
  assert.ok(writes.filter(write => write.collection === JOB_LABOR_COSTS).every(write => write.delete === true && write.revision));
  assert.deepEqual(writes.filter(write => write.collection === 'hub_audit').map(write => [write.patch.action, write.patch.visibility]), Array(3).fill(['money.labor.restore', 'owner']));
  assert.equal(writes.filter(write => write.collection === JOB_LABOR_RECEIPTS)[0].patch.scope, 'job_labor_restore');
  assert.equal((await runJobLaborBackfill(f.store, { restore: true, apply: true, now: LATER, runId: 'restore-2' })).writes.planned, 0, 'a rerun is a no-op');
  // Redeploying later: the backfill moves the restored figures into new records again.
  const again = await runJobLaborBackfill(f.store, { apply: true, now: LATER, runId: 'run-3' });
  assert.deepEqual([again.writes.moves, f.rows.get('jobLaborCosts/moved').laborCents, f.rows.get('jobLaborCosts/flag-off').laborCents, 'labor' in job('moved').costs], [2, 15164, 20250, false]);
  // A record saved during the restore is skipped and reported, never overwritten.
  const g = fixture(RESTORE);
  g.beforeCommit(() => { g.rows.get('jobLaborCosts/moved').revision = 'saved-meanwhile'; });
  const raced = await runJobLaborBackfill(g.store, { restore: true, apply: true, now: NOW, runId: 'restore-3' });
  assert.deepEqual([raced.writes.committed, raced.writes.changedDuringRun, g.rows.get('jobLaborCosts/moved').laborCents, 'labor' in g.rows.get('jobs/moved').costs], [2, ['moved'], 15164, false]);
  assert.throws(() => planJobLaborRestore([], null), error => error.code === 'job_labor_backfill_input_invalid');
});

test('backfill arguments default to a dry run and refuse ambiguous modes', () => {
  assert.deepEqual(parseArgs([]), { apply: false, restore: false, report: '', help: false });
  assert.deepEqual(parseArgs(['--apply', '--report', 'out.json']), { apply: true, restore: false, report: 'out.json', help: false });
  assert.deepEqual(parseArgs(['--restore']), { apply: false, restore: true, report: '', help: false }, 'the restore is a dry run by default too');
  assert.deepEqual(parseArgs(['--restore', '--apply']), { apply: true, restore: true, report: '', help: false });
  assert.throws(() => parseArgs(['--restore', '--apply', '--dry-run']), /either/);
  assert.throws(() => parseArgs(['--apply', '--dry-run']), /either/);
  assert.throws(() => parseArgs(['--force']), /Unknown/);
});

// ---- employee-labor-costs.js in a vm ------------------------------------------------------------------------------
function laborModule(responses) {
  const calls = [], storage = new Map(), listeners = {};
  const sessionStorage = { getItem: key => storage.has(key) ? storage.get(key) : null, setItem: (key, value) => storage.set(key, String(value)), removeItem: key => storage.delete(key), key: index => [...storage.keys()][index] ?? null, get length() { return storage.size; } };
  let uuid = 0;
  const context = vm.createContext({ sessionStorage, AbortController, setTimeout, clearTimeout, JSON, Promise,
    crypto: { randomUUID: () => `00000000-0000-4000-8000-00000000000${++uuid}` },
    fetch: async (url, init = {}) => { calls.push({ url, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null, stored: [...storage.values()] }); const next = responses.shift(); if (next instanceof Error) throw next; return Response.json(next.body, { status: next.status || 200 }); },
    window: { addEventListener: (name, fn) => { listeners[name] = fn; } } });
  vm.runInContext(readFileSync(new URL('../employee-labor-costs.js', import.meta.url), 'utf8'), context);
  return { labor: context.window.EGCLaborCosts, calls, storage, signout: () => listeners['egc:signout']() };
}
const VISIBLE = { ok: true, laborCostHidden: false, complete: true, jobs: [{ jobId: 'job-costed', laborCents: 15164, revision: 'l0', recordedAt: NOW, recordedBy: 'zacb' }] };

test('the Hub labor module shows hidden, visible or unavailable only from a complete server answer', async () => {
  const hidden = laborModule([{ body: { ok: true, laborCostHidden: true, jobs: null } }]);
  assert.equal(hidden.labor.state(), 'idle');
  assert.equal(await hidden.labor.load(), true);
  assert.deepEqual([hidden.labor.state(), hidden.labor.record('job-costed')], ['hidden', null]);
  for (const body of [{ ...VISIBLE, complete: false }, { ...VISIBLE, jobs: [...VISIBLE.jobs, VISIBLE.jobs[0]] }, { ...VISIBLE, jobs: [{ ...VISIBLE.jobs[0], laborCents: 1.5 }] }, { ok: true, laborCostHidden: true, jobs: [] }, { ok: true }]) {
    const broken = laborModule([{ body }]);
    await broken.labor.load();
    assert.equal(broken.labor.state(), 'unavailable', JSON.stringify(body));
  }
  const retry = laborModule([{ status: 503, body: { ok: false } }, { body: VISIBLE }]);
  await retry.labor.load();
  assert.equal(retry.labor.state(), 'unavailable');
  await retry.labor.load();
  assert.equal(retry.labor.state(), 'unavailable', 'a settled state is not reloaded without force');
  await retry.labor.load({ force: true });
  assert.deepEqual([retry.labor.state(), retry.labor.record('job-costed').laborCents], ['visible', 15164]);
});

test('the Hub labor module shows labor hidden, not unavailable, to an account the server refuses as not an operations manager', async () => {
  // A crew lead or sales account with business access: /api/job-labor-costs answers 403 job_labor_forbidden whatever
  // EGC_STAFF_PAY_OWNER_ONLY says, so there is nothing to retry and no figure to show.
  const forbidden = laborModule([{ status: 403, body: { ok: false, code: 'job_labor_forbidden', error: 'Only an operations manager or owner can open job labor cost.' } }]);
  assert.equal(await forbidden.labor.load(), true);
  assert.deepEqual([forbidden.labor.state(), forbidden.labor.record('job-costed'), forbidden.calls.length], ['hidden', null, 1]);
  assert.equal(await forbidden.labor.load(), false, 'a settled refusal is not asked again');
  assert.equal(forbidden.calls.length, 1);
  await assert.rejects(forbidden.labor.save({ jobId: 'job-costed', laborCents: 100, viewer: 'Synthetic.Lead' }), /has not loaded/);
  assert.equal(forbidden.calls.length, 1, 'nothing is sent for a hidden viewer');
  // Only that refusal: any other 403, a sign-in 401, or a body that does not say job_labor_forbidden stays unavailable (Retry).
  for (const [status, body] of [[403, { ok: false, code: 'job_labor_origin_forbidden' }], [401, { ok: false, code: 'job_labor_sign_in_required' }], [403, { ok: false }], [200, { ok: false, code: 'job_labor_forbidden' }], [503, { ok: false, code: 'job_labor_forbidden' }]]) {
    const other = laborModule([{ status, body }]);
    await other.labor.load();
    assert.equal(other.labor.state(), 'unavailable', `${status} ${JSON.stringify(body)}`);
  }
});

test('the Hub labor module keeps a save it could not confirm and repeats it unchanged, and drops it once settled', async () => {
  const saved = { ok: true, labor: { jobId: 'job-costed', laborCents: 20250, revision: 'l1', recordedAt: NOW, recordedBy: 'zacb' } };
  const m = laborModule([{ body: VISIBLE }, new TypeError('network'), { status: 503, body: { ok: false, error: 'Synthetic outage.' } }, { body: saved }]);
  await m.labor.load();
  await assert.rejects(m.labor.save({ jobId: 'job-costed', laborCents: 20250, viewer: 'ZacB' }), /may not have saved/);
  assert.equal(m.calls[1].stored.length, 1, 'the request is kept before it is sent');
  await assert.rejects(m.labor.save({ jobId: 'job-costed', laborCents: 20250, viewer: 'ZacB' }), /Synthetic outage\. Save the same figure again/);
  const result = await m.labor.save({ jobId: 'job-costed', laborCents: 20250, viewer: 'ZacB' });
  assert.deepEqual(m.calls.slice(1).map(call => call.body.requestId), Array(3).fill(m.calls[1].body.requestId), 'every retry is the same request');
  assert.deepEqual(m.calls[1].body, { requestId: m.calls[1].body.requestId, jobId: 'job-costed', laborCents: 20250, expectedRevision: 'l0', actorId: 'ZacB' });
  assert.deepEqual([result.laborCents, m.labor.record('job-costed').revision, m.storage.size], [20250, 'l1', 0]);
  // A conflict drops the request and reloads the latest figure; signing out clears everything.
  const conflict = laborModule([{ body: VISIBLE }, { status: 409, body: { ok: false, code: 'job_labor_revision_conflict', error: 'Changed.' } }, { body: { ...VISIBLE, jobs: [{ ...VISIBLE.jobs[0], laborCents: 1, revision: 'l9' }] } }]);
  await conflict.labor.load();
  await assert.rejects(conflict.labor.save({ jobId: 'job-costed', laborCents: 5, viewer: 'ZacB' }), /latest figure is loaded/);
  assert.deepEqual([conflict.storage.size, conflict.labor.record('job-costed').revision], [0, 'l9']);
  const signout = laborModule([{ body: VISIBLE }, new TypeError('network')]);
  await signout.labor.load();
  await assert.rejects(signout.labor.save({ jobId: 'job-costed', laborCents: 7, viewer: 'ZacB' }));
  signout.signout();
  assert.deepEqual([signout.storage.size, signout.labor.state()], [0, 'idle']);
  await assert.rejects(signout.labor.save({ jobId: 'job-costed', laborCents: 7, viewer: 'ZacB' }), /has not loaded/);
});

test('the Hub labor module loads and saves the owner\'s blank (null), and still refuses anything that is not cents', async () => {
  const blankRow = { jobId: 'job-blank', laborCents: null, revision: 'l3', recordedAt: NOW, recordedBy: 'zacb' };
  const m = laborModule([{ body: { ...VISIBLE, jobs: [...VISIBLE.jobs, blankRow] } }, { body: { ok: true, labor: { ...VISIBLE.jobs[0], laborCents: null, revision: 'l1' } } }]);
  await m.labor.load();
  assert.deepEqual([m.labor.state(), m.labor.record('job-blank').laborCents], ['visible', null]);
  const saved = await m.labor.save({ jobId: 'job-costed', laborCents: null, viewer: 'ZacB' });
  assert.deepEqual([m.calls[1].body.laborCents, m.calls[1].body.expectedRevision, saved.laborCents, m.labor.record('job-costed').revision], [null, 'l0', null, 'l1']);
  for (const laborCents of [undefined, -1, 1.5, '100']) await assert.rejects(m.labor.save({ jobId: 'job-costed', laborCents, viewer: 'ZacB' }), /dollar amount/, String(laborCents));
  assert.equal(m.calls.length, 2, 'nothing invalid is sent');
});
