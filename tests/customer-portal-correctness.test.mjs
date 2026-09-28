import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from './helpers/vm-realm.mjs';
import { readJob } from '../functions/_lib/firestore-job.js';
import { verifyCustomerPortalAccessToken } from '../functions/_lib/customer-portal.js';
import * as portal from '../functions/api/customer-portal.js';
import { NOW, env, portalStore, portalCookie, portalHandlers, portalView, portalPost, portalScript, fakeDom } from './helpers/portal-fixture.mjs';

const html = readFileSync(new URL('../customer-portal.html', import.meta.url), 'utf8');
const base = () => ({ type: 'job', customer: 'Synthetic Customer', customerId: 'customer-1', address: '100 Synthetic Street', serviceType: 'Garage Turnaround', total: 800, status: 'scheduled' });
const person = (id, extra = {}) => ({ id, name: `Synthetic ${id}`, email: `${id}@example.invalid`, role: 'Family', status: 'active', permissions: { view: true, decide: true, pay: false, rebook: false }, ...extra });
const PERSON_ID = /^person-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
// Edits the job right after this request reads it, as staff or another tab would.
const racingRead = (f, patch) => async (testEnv, id) => { const job = await readJob(testEnv, id); f.edit('job-1', patch); return job; };
const progressPage = () => {
  const step = name => { const classes = new Set(); return { dataset: { step: name }, textContent: '', classes, classList: { toggle: (value, on) => on ? classes.add(value) : classes.delete(value) } }; };
  const dom = fakeDom(), steps = ['scheduled', 'dispatched', 'in_progress', 'completed'].map(step);
  const context = { $: dom.node, setText: (id, value) => { dom.node(id).textContent = value; }, document: { querySelectorAll: selector => { assert.equal(selector, '.progress-step'); return steps; } } };
  vm.runInNewContext(portalScript(html, ['function renderProgress(']), context);
  return { dom, steps, context, note: dom.node('progress-note') };
};

test('portal exports stay bound to the default factory instance', () => {
  assert.equal(typeof portal.onRequestGet, 'function');
  assert.equal(typeof portal.onRequestPost, 'function');
  assert.equal(typeof portal.onRequestDelete, 'function');
  assert.equal(typeof portal.createCustomerPortalHandlers, 'function');
});

test('field statuses map onto the customer progress steps with a customer-safe activity', async t => {
  const cases = [
    [{ status: 'arrived' }, 'arrived', ''],
    [{ status: 'arrived', pipelineStatus: 'arrived', fieldExecution: { activity: 'waiting', activityReason: 'Synthetic internal reason' } }, 'arrived', 'waiting'],
    [{ status: 'dispatched', fieldExecution: { activity: 'delayed', activityReason: 'Synthetic traffic' } }, 'dispatched', 'delayed'],
    [{ status: 'in_progress', startedAt: '2026-09-22T16:00:00Z', fieldExecution: { activity: 'paused' } }, 'in_progress', 'paused'],
    [{ status: 'in_progress', startedAt: '2026-09-22T16:00:00Z', fieldExecution: { activity: 'delayed', activityReason: 'Synthetic traffic' } }, 'in_progress', 'delayed'],
    [{ status: 'delayed' }, 'dispatched', 'delayed'],
    [{ status: 'waiting' }, 'arrived', 'waiting'],
    [{ status: 'paused' }, 'in_progress', 'paused'],
    [{ status: 'scheduled', arrivedAt: '2026-09-22T15:00:00Z' }, 'arrived', ''],
    [{ status: 'review_requested' }, 'completed', ''],
    [{ status: 'closed' }, 'completed', ''],
    [{ status: 'invoiced', completedAt: '2026-09-22T17:00:00Z' }, 'completed', ''],
    [{ status: 'invoiced' }, 'scheduled', ''],
    [{ status: 'completed', fieldExecution: { activity: 'delayed' } }, 'completed', ''],
    [{ status: 'paid' }, 'paid', ''],
  ];
  const jobs = Object.fromEntries(cases.map(([extra], index) => [`job-${index}`, { ...base(), ...extra }]));
  portalStore(t, jobs);
  const handlers = portalHandlers();
  for (const [index, [extra, status, activity]] of cases.entries()) {
    const view = await portalView(handlers, await portalCookie(`job-${index}`));
    assert.equal(view.status, 200);
    assert.equal(view.body.appointment.status, status, JSON.stringify(extra));
    assert.equal(view.body.progress.status, status);
    assert.equal(view.body.progress.activity, activity, JSON.stringify(extra));
    assert.doesNotMatch(JSON.stringify(view.body), /Synthetic internal reason|Synthetic traffic/, 'crew activity reasons stay internal');
  }
});

test('an arrived job lights the on-the-way step as crew arrived and explains waiting', () => {
  const { dom, steps, context } = progressPage();
  const done = () => steps.filter(step => step.classes.has('done')).map(step => step.dataset.step);
  context.renderProgress({ appointment: { status: 'arrived' }, progress: { status: 'arrived', activity: '' } });
  assert.deepEqual(done(), ['scheduled', 'dispatched']);
  assert.equal(steps[1].textContent, 'Crew arrived');
  assert.equal(dom.node('progress-note').classList.contains('hidden'), true);
  context.renderProgress({ appointment: { status: 'arrived' }, progress: { status: 'arrived', activity: 'waiting' } });
  assert.match(dom.node('progress-note').textContent, /waiting on a quick answer/);
  assert.equal(dom.node('progress-note').classList.contains('hidden'), false);
  context.renderProgress({ appointment: { status: 'in_progress' }, progress: { activity: 'paused' } });
  assert.deepEqual(done(), ['scheduled', 'dispatched', 'in_progress']);
  assert.equal(steps[1].textContent, 'On the way');
  assert.match(dom.node('progress-note').textContent, /briefly paused/);
  context.renderProgress({ appointment: { status: 'paid' }, progress: {} });
  assert.deepEqual(done(), ['scheduled', 'dispatched', 'in_progress', 'completed']);
  assert.equal(dom.node('progress-note').classList.contains('hidden'), true);
});

test('a delay reads as a late arrival on the way and as a longer job once work has started', () => {
  const { steps, context, note } = progressPage();
  context.renderProgress({ appointment: { status: 'dispatched' }, progress: { status: 'dispatched', activity: 'delayed' } });
  assert.match(note.textContent, /running a little behind.*arrival time/);
  assert.equal(note.classList.contains('hidden'), false);
  context.renderProgress({ appointment: { status: 'in_progress' }, progress: { status: 'in_progress', activity: 'delayed' } });
  assert.match(note.textContent, /taking a little longer than planned/);
  assert.doesNotMatch(note.textContent, /arrival|running a little behind/, 'a crew already on site is not described as arriving late');
  assert.equal(steps[2].classes.has('done'), true);
  assert.equal(note.classList.contains('hidden'), false);
});

test('the top-level arrival window wins over older instruction copies', async t => {
  portalStore(t, {
    'job-1': { ...base(), arrivalWindow: '9:00 AM – 9:30 AM', jobInstructions: { arrivalWindow: '2026-09-20 · 08:00–12:00' }, instructions: { arrivalWindow: 'Older copy' } },
    'job-2': { ...base(), jobInstructions: { arrivalWindow: '2026-09-20 · 08:00–12:00' } },
  });
  const handlers = portalHandlers();
  assert.equal((await portalView(handlers, await portalCookie('job-1'))).body.appointment.arrivalWindow, '9:00 AM – 9:30 AM');
  assert.equal((await portalView(handlers, await portalCookie('job-2'))).body.appointment.arrivalWindow, '2026-09-20 · 08:00–12:00');
});

test('internal job notes never become the customer estimate scope', async t => {
  const secret = 'Synthetic internal note: gate code 4321, difficult customer';
  portalStore(t, { 'job-1': { ...base(), notes: secret }, 'job-2': { ...base(), notes: secret, scopeSummary: 'Synthetic customer-facing scope' } });
  const handlers = portalHandlers();
  const onlyNotes = await portalView(handlers, await portalCookie('job-1'));
  assert.equal(onlyNotes.status, 200);
  assert.equal(onlyNotes.body.estimate.scope, 'Your flat-rate garage service based on the agreed walkthrough scope.');
  assert.equal(onlyNotes.body.estimate.lineItems[0].description, '');
  assert.equal(JSON.stringify(onlyNotes.body).includes('4321'), false, 'no part of the internal note reaches the customer');
  const withScope = await portalView(handlers, await portalCookie('job-2'));
  assert.equal(withScope.body.estimate.scope, 'Synthetic customer-facing scope');
  assert.equal(JSON.stringify(withScope.body).includes('4321'), false);
});

test('a save_collaborators based on a stale updateTime returns 409 and writes nothing', async t => {
  const f = portalStore(t, { 'job-1': { ...base(), customerCollaborators: [person('person-1')] } });
  const cookie = await portalCookie();
  // Staff (or another tab) changes the people list after this request read the job.
  const handlers = portalHandlers(NOW, { read: async (testEnv, id) => { const job = await readJob(testEnv, id); f.edit('job-1', { customerCollaborators: [person('person-1'), person('person-staff')] }); return job; } });
  const before = f.revision('job-1');
  const stale = await portalPost(handlers, cookie, { action: 'save_collaborators', collaborators: [{ id: 'person-1', name: 'Renamed Person', email: 'renamed@example.invalid' }] });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, 'CUSTOMER_PORTAL_REVISION_CONFLICT');
  assert.equal(f.writes.length, 0);
  assert.equal(f.rejected.length, 1);
  assert.equal(f.rejected[0].precondition, before, 'the write carried the revision the request observed');
  assert.deepEqual(f.job('job-1').customerCollaborators.map(item => item.id), ['person-1', 'person-staff'], 'the concurrent change is preserved');
});

test('two concurrent collaborator saves cannot both win', async t => {
  const f = portalStore(t, { 'job-1': { ...base(), customerCollaborators: [person('person-1')] } });
  let arrived = 0, release;
  const barrier = new Promise(resolve => { release = resolve; });
  const handlers = portalHandlers(NOW, { read: async (testEnv, id) => { const job = await readJob(testEnv, id); if (++arrived === 2) release(); await barrier; return job; } });
  const cookie = await portalCookie();
  const [first, second] = await Promise.all([
    portalPost(handlers, cookie, { action: 'save_collaborators', collaborators: [{ id: 'person-1', name: 'First Tab', email: 'first@example.invalid' }] }),
    portalPost(handlers, cookie, { action: 'save_collaborators', collaborators: [{ id: 'person-1', name: 'Second Tab', email: 'second@example.invalid' }] }),
  ]);
  assert.deepEqual([first.status, second.status].sort(), [200, 409]);
  assert.equal(f.writes.length, 1);
  const winner = first.status === 200 ? 'First Tab' : 'Second Tab';
  assert.deepEqual(f.job('job-1').customerCollaborators.map(item => item.name), [winner]);
});

test('every Firestore precondition failure is a revision conflict, not a retry-later outage', async t => {
  // Real Firestore answers a stale currentDocument.updateTime with 400
  // FAILED_PRECONDITION; 409 ABORTED and 412 are accepted too.
  for (const conflictStatus of [400, 409, 412]) {
    await t.test(`HTTP ${conflictStatus}`, async st => {
      const f = portalStore(st, { 'job-1': { ...base(), customerCollaborators: [person('person-1')] } }, { conflictStatus });
      const cookie = await portalCookie();
      const cases = [
        [{ action: 'save_job_day_rules', away_mode: false }, { jobDayRules: { updatedAt: 'staff' } }, 'CUSTOMER_PORTAL_REVISION_CONFLICT'],
        [{ action: 'save_collaborators', collaborators: [] }, { collaboratorsUpdatedAt: 'staff' }, 'CUSTOMER_PORTAL_REVISION_CONFLICT'],
        [{ action: 'save_customer_memory', parking_notes: 'Synthetic driveway note' }, { customerMemory: { parkingNotes: 'Staff note' } }, undefined],
      ];
      for (const [body, patch, code] of cases) {
        const stale = await portalPost(portalHandlers(NOW, { read: racingRead(f, patch) }), cookie, body);
        assert.equal(stale.status, 409, body.action);
        assert.equal(stale.body.code, code, body.action);
      }
      assert.equal(f.writes.length, 0);
      assert.equal(f.rejected.length, 3);
      assert.equal(f.job('job-1').customerMemory.parkingNotes, 'Staff note', 'the concurrent change is preserved');
    });
  }
});

test('property memory saves fail closed and then succeed against the fresh revision', async t => {
  const f = portalStore(t, { 'job-1': base() });
  const cookie = await portalCookie(), memory = { action: 'save_customer_memory', parking_notes: 'Synthetic driveway note' };
  f.failNextWrite();
  const unavailable = await portalPost(portalHandlers(), cookie, memory);
  assert.equal(unavailable.status, 503, 'a storage outage is not reported as someone else\'s change');
  const saved = await portalPost(portalHandlers(), cookie, memory);
  assert.equal(saved.status, 200);
  assert.equal(f.writes.length, 1);
  assert.match(f.writes[0].precondition, /^2026-09-22T/);
  assert.equal(f.job('job-1').customerMemory.parkingNotes, 'Synthetic driveway note');
});

test('collaborators save against the verified account root with its own revision', async t => {
  const f = portalStore(t, {
    'job-1': { ...base(), customerAccountOwnerJobId: 'root' },
    root: { ...base(), address: '200 Synthetic Street', customerCollaborators: [person('person-1')] },
  });
  const result = await portalPost(portalHandlers(), await portalCookie(), { action: 'save_collaborators', collaborators: [{ id: 'person-1', name: 'Kept Person', email: 'kept@example.invalid' }] });
  assert.equal(result.status, 200);
  assert.deepEqual(f.writes.map(write => write.id), ['root']);
  assert.match(f.writes[0].precondition, /^2026-09-22T/);
  assert.equal(f.job('root').customerCollaborators[0].id, 'person-1');
  assert.equal(f.job('job-1').customerCollaborators, undefined, 'the recurring job keeps no copy');
});

test('job-day rules carry a revision precondition and fail closed', async t => {
  const f = portalStore(t, { 'job-1': base() });
  const cookie = await portalCookie(), rules = { action: 'save_job_day_rules', away_mode: true, decision_maker: 'Synthetic Decider', payer: 'Synthetic Payer' };
  const staleHandlers = portalHandlers(NOW, { read: async (testEnv, id) => { const job = await readJob(testEnv, id); f.edit('job-1', { jobDayRules: { awayMode: false, updatedAt: 'staff' } }); return job; } });
  const stale = await portalPost(staleHandlers, cookie, rules);
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, 'CUSTOMER_PORTAL_REVISION_CONFLICT');
  assert.equal(f.writes.length, 0);
  assert.equal(f.job('job-1').jobDayRules.updatedAt, 'staff');
  f.failNextWrite();
  const unavailable = await portalPost(portalHandlers(), cookie, rules);
  assert.equal(unavailable.status, 503);
  assert.equal(unavailable.body.code, 'CUSTOMER_PORTAL_STORAGE_UNAVAILABLE');
  assert.doesNotMatch(unavailable.body.error, /500|storage write failed/i, 'no internal error text reaches the customer');
  const saved = await portalPost(portalHandlers(), cookie, rules);
  assert.equal(saved.status, 200);
  assert.equal(f.writes.length, 1);
  assert.match(f.writes[0].precondition, /^2026-09-22T/);
  assert.equal(f.job('job-1').jobDayRules.decisionMaker, 'Synthetic Decider');
  assert.equal(f.job('job-1').jobDayRules.updatedAt, NOW, 'timestamps come from the injected clock');
});

test('collaborator ids are server-issued and never business-grant shaped', async t => {
  const f = portalStore(t, { 'job-1': { ...base(), customerCollaborators: [person('person-1'), person('biz_legacy')] } });
  const result = await portalPost(portalHandlers(), await portalCookie(), { action: 'save_collaborators', collaborators: [
    { id: 'person-1', name: 'Existing Person', email: 'existing@example.invalid' },
    { id: 'biz_attacker', name: 'Business Looking', email: 'biz@example.invalid', permissions: { pay: true } },
    { id: 'person-1', name: 'Duplicate Id', email: 'duplicate@example.invalid' },
    { id: 'person-made-up', name: 'Browser Minted', email: 'minted@example.invalid' },
    { id: 'biz_legacy', name: 'Legacy Business Id', email: 'legacy@example.invalid' },
    { name: 'New Person', email: 'new@example.invalid' },
    null,
  ] });
  assert.equal(result.status, 200);
  const saved = f.job('job-1').customerCollaborators, ids = saved.map(item => item.id);
  assert.equal(saved.length, 6);
  assert.equal(ids[0], 'person-1', 'an existing person keeps the id their invitation was issued for');
  for (const value of ids.slice(1)) assert.match(value, PERSON_ID);
  assert.equal(ids.some(value => value.startsWith('biz_')), false);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(result.body.collaborators.map(item => item.id), ids);
  assert.equal(saved[1].name, 'Business Looking');
  assert.equal(saved[1].permissions.pay, true);
});

test('a stored business-shaped collaborator id can never receive an invitation', async t => {
  portalStore(t, { 'job-1': { ...base(), customerCollaborators: [person('biz_legacy'), person('person-1')] } });
  const handlers = portalHandlers(), cookie = await portalCookie();
  const refused = await portalPost(handlers, cookie, { action: 'create_collaborator_invite', person_id: 'biz_legacy' });
  assert.equal(refused.status, 404);
  const invite = await portalPost(handlers, cookie, { action: 'create_collaborator_invite', person_id: 'person-1' });
  assert.equal(invite.status, 200);
  const token = new URL(invite.body.url).searchParams.get('access');
  assert.equal((await verifyCustomerPortalAccessToken(env, token, Date.parse(NOW))).actorId, 'person-1');
  assert.equal((await verifyCustomerPortalAccessToken(env, token, Date.parse(NOW) + 31 * 86400000)), null, 'the invitation lifetime starts at the injected time');
});

test('estimate expiry and approval use the injected clock on the Denver calendar', async t => {
  portalStore(t, { 'job-1': { ...base(), estimate: { number: 'EST-1', status: 'sent', amount: 800, validUntil: '2026-09-22' } } });
  const cookie = await portalCookie();
  const lastEvening = portalHandlers('2026-09-23T05:30:00.000Z'); // 11:30 PM Sept 22 in Denver, already Sept 23 in UTC
  assert.equal((await portalView(lastEvening, cookie)).body.estimate.status, 'sent');
  const nextMorning = portalHandlers('2026-09-23T06:30:00.000Z'); // 12:30 AM Sept 23 in Denver
  assert.equal((await portalView(nextMorning, cookie)).body.estimate.status, 'expired');
  const expired = await portalPost(nextMorning, cookie, { action: 'approve_estimate', signed_name: 'Synthetic Customer', confirmed: true });
  assert.equal(expired.status, 409);
  assert.match(expired.body.error, /expired/);
});

test('approval inside the validity window records the injected time', async t => {
  const f = portalStore(t, { 'job-1': { ...base(), estimate: { number: 'EST-1', status: 'sent', amount: 800, validUntil: '2026-09-22' } } });
  const at = '2026-09-23T05:30:00.000Z', handlers = portalHandlers(at), cookie = await portalCookie('job-1', {}, Date.parse(at));
  // Approvals name the revision and total the page displayed (portal approval binding, M14).
  const shown = (await portalView(handlers, cookie)).body.estimate;
  const approved = await portalPost(handlers, cookie, { action: 'approve_estimate', signed_name: 'Synthetic Customer', confirmed: true, estimate_revision: shown.revision, amount_cents: Math.round(shown.amount * 100), estimate_fingerprint: shown.fingerprint });
  assert.equal(approved.status, 200);
  assert.equal(f.job('job-1').customerApproval.approvedAt, at);
  assert.equal(f.job('job-1').estimate.acceptedAt, at);
});

test('a far-future estimate still expires when the injected clock passes it', async t => {
  portalStore(t, { 'job-1': { ...base(), estimate: { number: 'EST-9', status: 'sent', amount: 800, validUntil: '2099-01-01' } } });
  const future = '2099-01-02T18:00:00.000Z';
  assert.equal((await portalView(portalHandlers(future), await portalCookie('job-1', {}, Date.parse(future)))).body.estimate.status, 'expired');
});

test('rebooking date checks use the injected Denver day', async t => {
  const f = portalStore(t, { 'job-1': { ...base(), status: 'completed' } });
  const at = '2026-09-23T05:30:00.000Z', handlers = portalHandlers(at), cookie = await portalCookie('job-1', {}, Date.parse(at));
  const past = await portalPost(handlers, cookie, { action: 'request_rebook', kind: 'repeat', timing: 'choose_date', preferred_date: '2026-09-21' });
  assert.equal(past.status, 400);
  const today = await portalPost(handlers, cookie, { action: 'request_rebook', kind: 'repeat', timing: 'choose_date', preferred_date: '2026-09-22' });
  assert.equal(today.status, 200, 'the Denver day is still Sept 22 even though UTC is Sept 23');
  assert.equal(f.job('job-1').rebookingRequests[0].requestedAt, at);
  assert.match(f.job('job-1').rebookingRequests[0].id, /^rebook-[0-9a-f-]{36}$/);
});

test('portal sessions expire against the injected clock', async t => {
  portalStore(t, { 'job-1': base() });
  const cookie = await portalCookie();
  assert.equal((await portalView(portalHandlers('2026-09-29T17:00:00.000Z'), cookie)).status, 200);
  const expired = await portalView(portalHandlers('2026-09-29T18:00:01.000Z'), cookie);
  assert.equal(expired.status, 401);
  assert.equal(expired.body.code, 'CUSTOMER_PORTAL_AUTH_REQUIRED');
});

test('non-object request bodies are rejected before any write', async t => {
  const f = portalStore(t, { 'job-1': base() });
  const cookie = await portalCookie();
  for (const body of [null, [], 'save_job_day_rules']) {
    const result = await portalPost(portalHandlers(), cookie, body);
    assert.equal(result.status, 400);
  }
  assert.equal(f.writes.length, 0);
});
