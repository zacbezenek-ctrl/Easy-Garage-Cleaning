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
import { fieldJobsHandlers } from '../functions/api/field-jobs.js';
import { createHubSessionCookie } from '../functions/_lib/hub-session.js';
import { storage as fieldStorage } from './helpers/field-fixture.mjs';
import { SELF_RUN_DAYS, SELF_WALKTHROUGH, selfRunCardHidden, selfRunVisit, selfWalkthroughSession } from '../functions/_lib/knock-self-walkthrough.js';

const ORIGIN = 'https://easygaragecleaning.com';
const NOW = new Date('2026-10-17T15:00:00.000Z');
const rep = { user: 'Rep.Two', role: 'crew', businessAccess: false, displayName: 'Rep Two' };
const BRIDGE = { ...ON_ENV, EGC_KNOCK_JOB_BRIDGE: 'true', EGC_WALKTHROUGH_VISIT_ENABLED: 'true' };
const ENVS = [['legacy roles', BRIDGE], ['EGC_STAFF_ROLE_ACCESS on', { ...BRIDGE, EGC_STAFF_ROLE_ACCESS: 'true' }]];
const selfRun = (repKey, extra = {}) => ({ source: 'door_to_door', d2d: { kind: 'walkthrough', repKey, setterEventId: 'kw-1', selfRun: true }, assignedCrew: [repKey], ...extra });

// w1: Rep Two's own self-run visit. w2: an estimator's ordinary visit. w3: another rep's self-run visit. w4: Rep Two's
// self-run visit an estimator took over (reassigned).
function world({ walkthroughSelf = true, status = 'active', now = NOW, visit = {} } = {}) {
  const f = fixture(BRIDGE);
  for (const [id, extra] of [['w1', selfRun('rep.two', visit)], ['w3', selfRun('rep.three')], ['w4', selfRun('rep.two', { assignedCrew: ['sales.person'] })]]) f.rows.set(`jobs/${id}`, { ...f.rows.get(`jobs/${id}`), ...extra });
  const roster = f.store.roster;
  const store = { ...f.store, roster: async () => [...await roster(), { id: 'rep.two', name: 'Rep Two', role: 'crew' }, { id: 'rep.three', name: 'Rep Three', role: 'crew' }] };
  const reps = { 'rep.two': { repKey: 'rep.two', status, walkthroughSelf }, 'rep.three': { repKey: 'rep.three', status: 'active', walkthroughSelf: true } };
  const knock = () => ({ get: async (collection, id) => collection === 'knock_reps' ? reps[id] || null : null });
  const walkthroughs = () => ({ read: id => store.read('jobs', id), walkthroughsOn: async date => (await store.jobs()).filter(job => job.date === date) });
  const visitStore = env => ({ ...store, env, assigned: (session, job) => createJobAssignmentAccess(env, session).assigned(job), activeShift: async () => null });
  const deps = { session: async () => rep, knock, now: () => now };
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
    // Signed: the right ends. No live record of the customer through the job, the visit or the quote reads.
    assert.equal((await call(w.handoff.get, get(`/api/walkthrough-handoff?jobId=${job.id}`), env)).status, 403, 'the signed job is not the rep\'s to reopen');
    assert.equal((await call(w.handoff.get, get('/api/walkthrough-handoff?sourceWalkthroughId=w1'), env)).status, 403);
    assert.equal((await call(w.quotes.get, get(`/api/quote-draft?jobId=${job.id}`), env)).status, 403);
    assert.equal((await lookup(w, env, 'w1')).status, 403);
    for (const n of [2, 3, 4]) assert.equal((await sign(w, env, n)).status, 403, `w${n} cannot be signed by the rep`);
    assert.equal((await sign(w, env, 1, { jobId: 'cq1' })).status, 403, 'a job of another walkthrough rides with no self-run request');
    assert.equal((await call(w.handoff.get, get('/api/walkthrough-handoff?view=crew_openings'), env)).status, 403, 'crew openings stay the estimator\'s');

    // No Dispatch, no customer lookups.
    assert.equal((await call(w.dispatch.get, get('/api/dispatch'), env)).status, 403);
    const resolved = await call(w.resolve, post('/api/customer-resolve', { requestId: randomUUID(), customer: { name: 'Synthetic Customer 2', phone: '9705550102' } }), env);
    assert.equal(resolved.status, 403, JSON.stringify(resolved.body));
  });

  test(`${label}: without Walkthroughs on (or inactive, the bridge off, past the window, cancelled or lost) the rep\'s own visit stays closed`, async () => {
    for (const [why, w, e] of [['Walkthroughs off', world({ walkthroughSelf: false }), env], ['inactive', world({ status: 'inactive' }), env],
      // The visit's date (2026-10-17) plus SELF_RUN_DAYS (3) is the last day: the 21st is past it.
      ['past the cap', world({ now: new Date('2026-10-21T15:00:00.000Z') }), env], ['cancelled', world({ visit: { status: 'cancelled', pipelineStatus: 'cancelled' } }), env],
      ['lost', world({ visit: { walkthroughOutcome: { outcome: 'not_interested' } } }), env],
      ['bridge off', world(), { ...env, EGC_KNOCK_JOB_BRIDGE: 'false' }]]) {
      assert.equal((await lookup(w, e, 'w1')).status, 403, why);
      assert.equal((await call(w.visit.get, get('/api/walkthrough-visit?visitId=w1'), e)).status, 403, why);
      // The price menu (no customer in it) follows the switch, not the visit.
      if (!['past the cap', 'cancelled', 'lost'].includes(why)) {
        assert.equal((await call(w.quotes.get, get('/api/quote-draft?view=builder'), e)).status, 403, why);
        assert.equal((await call(w.pricing.get, get('/api/pricing-config?parts=walkthrough'), e)).status, 403, why);
      }
      assert.equal((await call(w.handoff.get, get('/api/walkthrough-handoff?sourceWalkthroughId=w1'), e)).status, 403, why);
      assert.equal((await sign(w, e, 1)).status, 403, why);
    }
  });
}

test('the grant is the server\'s own: one visit, never a session field a browser can send', async () => {
  const visit = { id: 'w1', type: 'walkthrough', date: '2026-10-17', status: 'scheduled', ...selfRun('rep.two') };
  assert.equal(selfRunVisit(visit, rep), true);
  assert.equal(selfRunVisit({ ...visit, d2d: { ...visit.d2d, selfRun: false } }, rep), false);
  assert.equal(selfRunVisit({ ...visit, source: 'website' }, rep), false);
  assert.equal(selfRunVisit({ ...visit, assignedCrew: ['rep.two', 'sales.person'] }, rep), false);
  const knock = { get: async () => ({ status: 'active', walkthroughSelf: true }) }, jobs = { w1: visit, w2: { id: 'w2', type: 'walkthrough', assignedCrew: ['rep.two'] } };
  const readJob = id => jobs[id] || null;
  const granted = await selfWalkthroughSession(rep, BRIDGE, ['w1'], { readJob, knock, now: NOW });
  assert.equal(granted[SELF_WALKTHROUGH], 'w1');
  assert.equal(JSON.stringify(granted), JSON.stringify(rep), 'nothing of the grant serializes');
  for (const ids of [['w1', 'w2'], ['w2'], [], ['../w1']]) assert.equal(await selfWalkthroughSession(rep, BRIDGE, ids, { readJob, knock, now: NOW }), rep, JSON.stringify(ids));
  // A session that already runs walkthroughs is left as it is.
  assert.equal(await selfWalkthroughSession(rep, BRIDGE, ['w1'], { readJob, knock, now: NOW, performer: () => true }), rep);
  // Nothing is read for a session without the right.
  const reads = [];
  await selfWalkthroughSession(rep, BRIDGE, ['w1'], { readJob: id => { reads.push(id); return jobs[id]; }, knock: { get: async () => ({ status: 'active', walkthroughSelf: false }) }, now: NOW });
  assert.deepEqual(reads, []);
});

test('the right is time-limited: the open visit and its unsigned draft, never past SELF_RUN_DAYS after the visit, never once signed or sent', async () => {
  const knock = { get: async () => ({ status: 'active', walkthroughSelf: true }) };
  const visit = { id: 'w1', type: 'walkthrough', date: '2026-10-17', status: 'scheduled', ...selfRun('rep.two') };
  const draft = { id: 'd1', type: 'job', status: 'draft', sourceWalkthroughId: 'w1', quoteDraft: { status: 'draft' } };
  const grant = async (rows, id, now = NOW) => (await selfWalkthroughSession(rep, BRIDGE, [id], { readJob: key => rows[key] || null, knock, now }))[SELF_WALKTHROUGH] || '';
  assert.equal(await grant({ w1: visit }, 'w1'), 'w1', 'before signing: the visit');
  assert.equal(await grant({ w1: visit, d1: draft }, 'd1'), 'w1', 'before signing: the draft saved from it');
  assert.equal(await grant({ w1: visit }, 'w1', new Date('2026-10-20T23:00:00.000Z')), 'w1', 'the last day of the window (Denver)');
  for (const [why, rows, id, now] of [
    ['past the cap', { w1: visit }, 'w1', new Date('2026-10-21T07:00:00.000Z')],
    ['draft past the cap', { w1: visit, d1: draft }, 'd1', new Date('2026-10-21T07:00:00.000Z')],
    ['visit converted by the signed handoff', { w1: { ...visit, convertedJobId: 'j1' } }, 'w1'],
    ['job signed', { w1: visit, d1: { ...draft, acceptance: { recordedBy: 'rep.two' }, handoffRequestId: 'r1' } }, 'd1'],
    ['quote sent', { w1: visit, d1: { ...draft, quoteDraft: { sentAt: '2026-10-17T16:00:00Z' } } }, 'd1'],
    ['cancelled visit', { w1: { ...visit, status: 'cancelled' } }, 'w1'],
    ['draft of a cancelled visit', { w1: { ...visit, pipelineStatus: 'cancelled' }, d1: draft }, 'd1'],
    ['no-show', { w1: { ...visit, walkthroughOutcome: { outcome: 'customer_no_show' } } }, 'w1'],
    ['no date', { w1: { ...visit, date: '' } }, 'w1'],
  ]) assert.equal(await grant(rows, id, now), '', why);
  // A Finish recording the sale keeps it open for the signature.
  assert.equal(await grant({ w1: { ...visit, walkthroughOutcome: { outcome: 'sold_on_site' } } }, 'w1'), 'w1');
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

// FUN-05 with a self-run walkthrough: Start, then sign (the handoff converts the visit and leaves its Finish to the rep),
// then Finish; the rep's next Start is not held up. And the phone's unchanged resend of a signed save replays it.
const visitAction = (w, env, body) => call(w.visit.post, post('/api/walkthrough-visit', { requestId: randomUUID(), expectedRevision: w.f.rows.get(`jobs/${body.visitId}`).revision, skipTimecard: true, ...body }), env);
for (const [label, env] of ENVS) {
  test(`${label}: start, sign, then finish the rep's own walkthrough; their next start is not blocked`, async () => {
    const w = world();
    w.f.rows.set('jobs/w5', { ...w.f.rows.get('jobs/w2'), id: 'w5', revision: 'w5r', ...selfRun('rep.two'), time: '13:00', endTime: '14:00' });
    const started = await visitAction(w, env, { action: 'start', visitId: 'w1', recordingStatus: 'declined' });
    assert.equal(started.status, 200, JSON.stringify(started.body));
    const signed = await sign(w, env, 1);
    assert.equal(signed.status, 200, JSON.stringify(signed.body));
    assert.ok(w.f.rows.get('jobs/w1').convertedJobId, 'the handoff converted the visit');
    assert.equal(w.f.rows.get('jobs/w1').walkthroughOutcome, undefined, 'a started visit keeps its Finish for the rep');
    assert.equal((await call(w.visit.get, get('/api/walkthrough-visit?visitId=w1'), env)).status, 200, 'the recorder still opens it to finish');
    assert.equal((await lookup(w, env, 'w1')).status, 403, 'but not the walkthrough itself');
    const finished = await visitAction(w, env, { action: 'finish', visitId: 'w1', outcome: 'sold_on_site', recordingStatus: 'declined' });
    assert.equal(finished.status, 200, JSON.stringify(finished.body));
    assert.equal(w.f.rows.get('jobs/w1').walkthroughOutcome?.outcome, 'sold_on_site');
    // Finished: nothing more on that visit.
    assert.equal((await call(w.visit.get, get('/api/walkthrough-visit?visitId=w1'), env)).status, 403);
    const next = await visitAction(w, env, { action: 'start', visitId: 'w5', recordingStatus: 'declined' });
    assert.equal(next.status, 200, JSON.stringify(next.body));
  });

  test(`${label}: the phone's unchanged resend of a signed save replays it; a changed one is refused and nothing is written`, async () => {
    const w = world(), body = { requestId: randomUUID(), customerId: 'c1', sourceWalkthroughId: 'w1', sourceRevision: w.f.rows.get('jobs/w1').revision, plan: signedPlan(1) };
    const first = await call(w.handoff.post, post('/api/walkthrough-handoff', body), env);
    assert.equal(first.status, 200, JSON.stringify(first.body));
    const writes = w.f.calls.length;
    const again = await call(w.handoff.post, post('/api/walkthrough-handoff', body), env);
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.deepEqual([again.body.replayed, again.body.job.id], [true, first.body.job.id]);
    const changed = await call(w.handoff.post, post('/api/walkthrough-handoff', { ...body, plan: signedPlan(1, { total: 1500 }) }), env);
    assert.notEqual(changed.status, 200);
    const fresh = await call(w.handoff.post, post('/api/walkthrough-handoff', { ...body, requestId: randomUUID() }), env);
    assert.equal(fresh.status, 403, 'a new request after signing gets nothing');
    assert.equal(w.f.calls.length, writes, 'no writes after the signed save');
  });
}

test('/api/field-jobs leaves the rep\'s own self-run card out of their day once their right to it ends', () => {
  const visit = { id: 'w1', type: 'walkthrough', date: '2026-10-17', status: 'scheduled', ...selfRun('rep.two') };
  assert.equal(selfRunCardHidden(visit, rep, NOW), false, 'open: shown');
  const converted = { ...visit, convertedJobId: 'j1', walkthroughVisit: { startedBy: 'rep.two', startedAt: '2026-10-17T15:00:00Z' } };
  assert.equal(selfRunCardHidden(converted, rep, NOW), false, 'signed, Finish still to record: shown');
  assert.equal(selfRunCardHidden({ ...converted, walkthroughOutcome: { outcome: 'sold_on_site' } }, rep, NOW), true, 'signed and finished: hidden');
  assert.equal(selfRunCardHidden(visit, rep, new Date('2026-10-25T15:00:00Z')), true, 'past the window: hidden');
  assert.equal(selfRunCardHidden({ ...visit, status: 'cancelled' }, rep, NOW), true, 'cancelled: hidden');
  assert.equal(selfRunCardHidden({ ...visit, d2d: { ...visit.d2d, selfRun: false } }, rep, new Date('2026-10-25T15:00:00Z')), false, 'an ordinary visit is untouched');
});

test('/api/field-jobs on an injected clock: the rep\'s self-run card shows inside its window and is gone past the cap', async t => {
  const env = { HUB_SESSION_SECRET: 'knock-self-run-field-jobs-secret-synthetic', FIREBASE_API_KEY: 'firebase-test-self-run',
    HUB_AUTH_USERS_JSON: JSON.stringify({ 'Rep.Two': { passwordHash: 'unused-synthetic', role: 'crew', displayName: 'Rep Two' } }) };
  const cookie = (await createHubSessionCookie(env, 'Rep.Two')).split(';')[0], store = fieldStorage(t);
  const card = { type: 'walkthrough', status: 'scheduled', pipelineStatus: 'scheduled', customerId: 'c9', customer: 'Synthetic Door Customer', phone: '(970) 555-0199',
    address: '9 Synthetic Way, Fort Collins, CO', date: '2026-10-17', endDate: '2026-10-17', time: '11:00', endTime: '12:00', ...selfRun('rep.two') };
  store.put('jobs/w9', card);
  const day = async now => (await (await fieldJobsHandlers({ now: () => now }).get({ env, request: new Request(`${ORIGIN}/api/field-jobs?date=2026-10-17&days=1&status=all`, { headers: { Cookie: cookie } }) })).json());
  assert.deepEqual((await day(NOW)).walkthroughs.map(row => row.id), ['w9'], 'the visit day: shown');
  const late = await day(new Date('2026-10-25T15:00:00.000Z'));
  assert.deepEqual(late.walkthroughs, [], 'past the cap: gone, though the day asked for is the visit\'s');
  assert.equal(JSON.stringify(late).includes('555-0199'), false);
  assert.equal(late.generatedAt, '2026-10-25T15:00:00.000Z', 'the answer is stamped with the injected clock');
});
