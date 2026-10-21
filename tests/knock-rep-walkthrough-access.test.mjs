// REP-WALKTHROUGH (owner decision 2026-10-21): a door-to-door rep with Walkthroughs on in Knock Admin runs the
// walkthrough of their own "Do the walkthrough now" visit, and only that one: no Sales role, no Dispatch, no customer
// lookups, no other visit. Synthetic data only (tests/helpers/estimator-fixture.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import vm from './helpers/vm-realm.mjs';
import { ON_ENV, builderState, fixture, signedPlan } from './helpers/estimator-fixture.mjs';
import { handoffHandlers } from '../functions/api/walkthrough-handoff.js';
import { walkthroughVisitHandlers } from '../functions/api/walkthrough-visit.js';
import { quoteDraftHandlers } from '../functions/api/quote-draft.js';
import { pricingConfigHandlers } from '../functions/api/pricing-config.js';
import { dispatchHandlers } from '../functions/api/dispatch.js';
import { customerResolveHandler } from '../functions/api/customer-resolve.js';
import { createJobAssignmentAccess } from '../functions/_lib/job-assignment.js';
import { SELF_WALKTHROUGH, selfRunVisit, selfWalkthroughSession } from '../functions/_lib/knock-self-walkthrough.js';

const ORIGIN = 'https://easygaragecleaning.com';
const NOW = new Date('2026-10-17T15:00:00.000Z');
const rep = { user: 'Rep.Two', role: 'crew', businessAccess: false, displayName: 'Rep Two' };
const BRIDGE = { ...ON_ENV, EGC_KNOCK_JOB_BRIDGE: 'true', EGC_WALKTHROUGH_VISIT_ENABLED: 'true' };
const ENVS = [['legacy roles', BRIDGE], ['EGC_STAFF_ROLE_ACCESS on', { ...BRIDGE, EGC_STAFF_ROLE_ACCESS: 'true' }]];
const selfRun = (repKey, extra = {}) => ({ source: 'door_to_door', d2d: { kind: 'walkthrough', repKey, setterEventId: 'kw-1', selfRun: true }, assignedCrew: [repKey], ...extra });

// w1: Rep Two's own self-run visit. w2: an estimator's ordinary visit. w3: another rep's self-run visit. w4: Rep Two's
// self-run visit an estimator took over (reassigned).
function world({ walkthroughSelf = true, status = 'active' } = {}) {
  const f = fixture(BRIDGE);
  for (const [id, extra] of [['w1', selfRun('rep.two')], ['w3', selfRun('rep.three')], ['w4', selfRun('rep.two', { assignedCrew: ['sales.person'] })]]) f.rows.set(`jobs/${id}`, { ...f.rows.get(`jobs/${id}`), ...extra });
  const roster = f.store.roster;
  const store = { ...f.store, roster: async () => [...await roster(), { id: 'rep.two', name: 'Rep Two', role: 'crew' }, { id: 'rep.three', name: 'Rep Three', role: 'crew' }] };
  const reps = { 'rep.two': { repKey: 'rep.two', status, walkthroughSelf }, 'rep.three': { repKey: 'rep.three', status: 'active', walkthroughSelf: true } };
  const knock = () => ({ get: async (collection, id) => collection === 'knock_reps' ? reps[id] || null : null });
  const walkthroughs = () => ({ read: id => store.read('jobs', id), walkthroughsOn: async date => (await store.jobs()).filter(job => job.date === date) });
  const visitStore = env => ({ ...store, env, assigned: (session, job) => createJobAssignmentAccess(env, session).assigned(job), activeShift: async () => null });
  const deps = { session: async () => rep, knock, now: () => NOW };
  return {
    f, store,
    handoff: handoffHandlers({ ...deps, storage: () => store, walkthroughs, compositeState: async () => { throw new Error('a walkthrough-priced handoff reads no builder state'); } }),
    visit: walkthroughVisitHandlers({ ...deps, storage: visitStore }),
    quotes: quoteDraftHandlers({ ...deps, storage: () => store, compositeState: async () => builderState() }),
    pricing: pricingConfigHandlers({ ...deps }),
    dispatch: dispatchHandlers({ session: deps.session, storage: () => store, now: deps.now }),
    resolve: customerResolveHandler({ session: deps.session, storage: () => store }),
  };
}
const get = path => new Request(ORIGIN + path);
const post = (path, body) => new Request(ORIGIN + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN }, body: JSON.stringify(body) });
const call = async (handler, request, env) => { const response = await handler({ request, env }); return { status: response.status, body: await response.json() }; };
const lookup = (w, env, id) => call(w.handoff.get, get(`/api/walkthrough-handoff?view=walkthroughs${id ? `&walkthroughId=${id}` : ''}`), env);
const sign = (w, env, n, extra = {}) => call(w.handoff.post, post('/api/walkthrough-handoff', { requestId: randomUUID(), customerId: `c${n}`, sourceWalkthroughId: `w${n}`, sourceRevision: w.f.rows.get(`jobs/w${n}`).revision, plan: signedPlan(n), ...extra }), env);

for (const [label, env] of ENVS) {
  test(`${label}: the rep opens, records and signs their own self-run walkthrough, and only that one`, async () => {
    const w = world();
    const own = await lookup(w, env, 'w1');
    assert.equal(own.status, 200, JSON.stringify(own.body));
    assert.deepEqual([own.body.selfRun, own.body.requested.id, own.body.walkthroughs.map(row => row.id)], [true, 'w1', ['w1']], 'only their own visit is listed');
    for (const id of ['w2', 'w3', 'w4']) assert.equal((await lookup(w, env, id)).status, 403, `${id} is not the rep's own self-run visit`);
    assert.equal((await lookup(w, env)).status, 403, 'no Today list of anyone\'s walkthroughs');

    // The visit recorder: their own visit only.
    const state = await call(w.visit.get, get('/api/walkthrough-visit?visitId=w1'), env);
    assert.equal(state.status, 200, JSON.stringify(state.body));
    assert.equal(state.body.visit.id, 'w1');
    assert.equal((await call(w.visit.get, get('/api/walkthrough-visit?visitId=w2'), env)).status, 403);
    assert.equal((await call(w.visit.get, get('/api/walkthrough-visit'), env)).status, 403);

    // The prices to quote it, the walkthrough table only.
    assert.equal((await call(w.quotes.get, get('/api/quote-draft?view=builder'), env)).status, 200);
    assert.equal((await call(w.pricing.get, get('/api/pricing-config?parts=walkthrough'), env)).status, 200);
    assert.equal((await call(w.pricing.get, get('/api/pricing-config?parts=phone'), env)).status, 403);

    // The handoff: prepared and signed for their own visit (its customer comes from the visit, not a lookup).
    const prepared = await call(w.handoff.get, get('/api/walkthrough-handoff?sourceWalkthroughId=w1'), env);
    assert.equal(prepared.status, 200, JSON.stringify(prepared.body));
    assert.deepEqual([prepared.body.customerId, prepared.body.roster], ['c1', []], 'never the roster');
    const signed = await sign(w, env, 1);
    assert.equal(signed.status, 200, JSON.stringify(signed.body));
    const job = [...w.f.rows.values()].find(row => row.type === 'job' && row.sourceWalkthroughId === 'w1');
    assert.ok(job, 'the signed job is saved from the rep\'s walkthrough');
    assert.equal((await call(w.handoff.get, get(`/api/walkthrough-handoff?jobId=${job.id}`), env)).status, 200, 'and the job saved from it reopens');
    for (const n of [2, 3, 4]) assert.equal((await sign(w, env, n)).status, 403, `w${n} cannot be signed by the rep`);
    assert.equal((await sign(w, env, 1, { jobId: 'cq1' })).status, 403, 'a job of another walkthrough rides with no self-run request');
    assert.equal((await call(w.handoff.get, get('/api/walkthrough-handoff?view=crew_openings'), env)).status, 403, 'crew openings stay the estimator\'s');

    // No Dispatch, no customer lookups.
    assert.equal((await call(w.dispatch.get, get('/api/dispatch'), env)).status, 403);
    const resolved = await call(w.resolve, post('/api/customer-resolve', { requestId: randomUUID(), customer: { name: 'Synthetic Customer 2', phone: '9705550102' } }), env);
    assert.equal(resolved.status, 403, JSON.stringify(resolved.body));
  });

  test(`${label}: without Walkthroughs on (or inactive, or the bridge off) the rep\'s own visit stays closed`, async () => {
    for (const [why, w, e] of [['Walkthroughs off', world({ walkthroughSelf: false }), env], ['inactive', world({ status: 'inactive' }), env],
      ['bridge off', world(), { ...env, EGC_KNOCK_JOB_BRIDGE: 'false' }]]) {
      assert.equal((await lookup(w, e, 'w1')).status, 403, why);
      assert.equal((await call(w.visit.get, get('/api/walkthrough-visit?visitId=w1'), e)).status, 403, why);
      assert.equal((await call(w.quotes.get, get('/api/quote-draft?view=builder'), e)).status, 403, why);
      assert.equal((await call(w.pricing.get, get('/api/pricing-config?parts=walkthrough'), e)).status, 403, why);
      assert.equal((await sign(w, e, 1)).status, 403, why);
    }
  });
}

test('the grant is the server\'s own: one visit, never a session field a browser can send', async () => {
  const visit = { id: 'w1', type: 'walkthrough', ...selfRun('rep.two') };
  assert.equal(selfRunVisit(visit, rep), true);
  assert.equal(selfRunVisit({ ...visit, d2d: { ...visit.d2d, selfRun: false } }, rep), false);
  assert.equal(selfRunVisit({ ...visit, source: 'website' }, rep), false);
  assert.equal(selfRunVisit({ ...visit, assignedCrew: ['rep.two', 'sales.person'] }, rep), false);
  const knock = { get: async () => ({ status: 'active', walkthroughSelf: true }) }, jobs = { w1: visit, w2: { id: 'w2', type: 'walkthrough', assignedCrew: ['rep.two'] } };
  const readJob = id => jobs[id] || null;
  const granted = await selfWalkthroughSession(rep, BRIDGE, ['w1'], { readJob, knock });
  assert.equal(granted[SELF_WALKTHROUGH], 'w1');
  assert.equal(JSON.stringify(granted), JSON.stringify(rep), 'nothing of the grant serializes');
  for (const ids of [['w1', 'w2'], ['w2'], [], ['../w1']]) assert.equal(await selfWalkthroughSession(rep, BRIDGE, ids, { readJob, knock }), rep, JSON.stringify(ids));
  // A session that already runs walkthroughs is left as it is.
  assert.equal(await selfWalkthroughSession(rep, BRIDGE, ['w1'], { readJob, knock, performer: () => true }), rep);
});

test('the walkthrough page opens for a rep without a walkthrough role only when the server answers selfRun for the visit in its address', async () => {
  const html = readFileSync(new URL('../crew/gameplan.html', import.meta.url), 'utf8');
  const line = prefix => html.split(/\r?\n/).find(row => row.startsWith(prefix)) || assert.fail(prefix);
  const page = async (search, answer) => {
    const asked = [], context = vm.createContext({ URLSearchParams, location: { search, replace: url => { context.replaced = url; } },
      EGCHubAuth: { session: async () => ({ user: 'Rep.Two' }), canRunWalkthrough: () => false,
        fetch: async url => { asked.push(url); return { ok: answer.ok !== false, json: async () => answer.body }; } } });
    vm.runInContext(['let REQUESTED_WALKTHROUGH_ID=', 'function denyWalkthrough(', 'let SELF_RUN=', 'async function selfRunOpen(', 'async function validSession('].map(line).join('\n'), context);
    const user = await vm.runInContext('validSession()', context);
    return { user, replaced: context.replaced || '', asked };
  };
  const own = await page('?walkthroughId=w1', { body: { selfRun: true, requested: { id: 'w1' } } });
  assert.deepEqual([own.user?.user, own.replaced, own.asked], ['Rep.Two', '', ['/api/walkthrough-handoff?view=walkthroughs&walkthroughId=w1']]);
  for (const [search, answer] of [['?walkthroughId=w1', { ok: false, body: { ok: false } }], ['?walkthroughId=w1', { body: { requested: { id: 'w1' } } }],
    ['?walkthroughId=w1', { body: { selfRun: true, requested: { id: 'w2' } } }], ['', { body: { selfRun: true } }]]) {
    const refused = await page(search, answer);
    assert.deepEqual([refused.user, refused.replaced], [null, '/crew/?notice=walkthrough-restricted'], JSON.stringify([search, answer]));
  }
});
