import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createHubSessionCookie } from '../functions/_lib/hub-session.js';
import { commitDocuments, readJob } from '../functions/_lib/firestore-job.js';
import { fieldChecklist, fieldCommand } from '../functions/_lib/field-execution.js';
import { createFieldStore } from '../functions/_lib/field-execution-store.js';
import { funnelEventId } from '../functions/_lib/funnel-events.js';
import { definitionsHash } from '../functions/_lib/funnel-definitions.js';
import { fieldFunnelWrite, funnelActorId, jobEventRefs, liveSale, portalActor, portalEventKey, savedCents } from '../functions/_lib/job-funnel-events.js';
import { mutateMoney } from '../functions/_lib/money-service.js';
import { saveWalkthroughHandoff } from '../functions/_lib/walkthrough-handoff.js';
import * as route from '../functions/api/field-jobs.js';
import { storage } from './helpers/field-fixture.mjs';
import { NOW, fakeDom, portalCookie, portalHandlers, portalPost, portalScript, portalStore, portalView } from './helpers/portal-fixture.mjs';
import vm from './helpers/vm-realm.mjs';
import { readFileSync } from 'node:fs';

// FUN-03: crew status taps and customer-portal actions write their funnel
// events in the same Firestore commit as the change they record.

const env = { HUB_SESSION_SECRET: 'synthetic-fun03-session-secret', FIREBASE_API_KEY: 'firebase-test-fun03', HUB_AUTH_USERS_JSON: JSON.stringify({ ZacB: { passwordHash: 'synthetic-hash', role: 'owner', displayName: 'Owner' }, 'Crew.One': { passwordHash: 'synthetic-hash', role: 'crew', displayName: 'Crew One' } }), GOOGLE_CLIENT_ID: 'synthetic', GOOGLE_CLIENT_SECRET: 'synthetic', GOOGLE_REFRESH_TOKEN: 'synthetic' };
const FIELD_NOW = '2026-09-22T14:00:00.000Z';
const at = minutes => new Date(Date.parse(FIELD_NOW) + minutes * 60000).toISOString();
const crewJob = (extra = {}) => {
  const job = { id: 'job-1', type: 'job', customer: 'Synthetic Customer', address: '100 Synthetic Street', date: '2026-09-22', time: '08:00', endTime: '11:00', assignedCrew: ['Crew.One'], status: 'scheduled', pipelineStatus: 'scheduled', customerId: 'customer-1', projectId: 'project_w1', highlevelContactId: 'syntheticContact1', visitPurpose: 'service', total: 1500, ...extra };
  job.fieldExecution = { checks: Object.fromEntries(fieldChecklist(job).map(item => [item.id, { completed: true }])), photos: ['before', 'after'].map(category => ({ id: randomUUID(), fileId: `synthetic-${category}`, category, verified: true })) };
  return job;
};
const funnelDocs = store => [...store.documents.keys()].filter(key => key.startsWith('funnelEvents/')).map(key => ({ key, ...store.get(key) })).sort((a, b) => a.recordedAt.localeCompare(b.recordedAt));

// Captures the path set of every documents:commit the field handler sends.
function commitLog(t) {
  const provider = globalThis.fetch, commits = [];
  t.mock.method(globalThis, 'fetch', async (input, options) => {
    if (new URL(input).pathname.endsWith('/documents:commit')) commits.push(JSON.parse(options.body).writes.map(write => write.update.name.split('/documents/')[1]));
    return provider(input, options);
  });
  return commits;
}

async function crew(t) {
  const cookie = (await createHubSessionCookie(env, 'Crew.One')).split(';')[0];
  return (store, data) => route.onRequestPost({ env, request: new Request('https://easygaragecleaning.com/api/field-jobs', { method: 'POST', headers: { Cookie: cookie, Origin: 'https://easygaragecleaning.com', 'Content-Type': 'application/json' }, body: JSON.stringify({ jobId: 'job-1', requestId: randomUUID(), expectedRevision: store.revision('job-1'), ...data }) }) });
}

test('crew taps write job.dispatched, arrived, started and completed with their receipt and the job, on the server clock', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date(FIELD_NOW) });
  const store = storage(t); store.put('jobs/job-1', crewJob());
  const commits = commitLog(t), post = await crew(t), ids = {};
  const tap = async (name, data, minutes) => { t.mock.timers.tick(minutes * 60000); ids[name] = randomUUID(); const response = await post(store, { requestId: ids[name], ...data }); assert.equal(response.status, 200, `${name}: ${await response.clone().text()}`); };
  await tap('dispatched', { action: 'status', status: 'dispatched' }, 0);
  await tap('arrived', { action: 'status', status: 'arrived' }, 30);
  await tap('started', { action: 'status', status: 'in_progress' }, 15);
  await tap('paused', { action: 'status', status: 'paused', reason: 'Customer is reviewing the keep pile' }, 60);
  await tap('resumed', { action: 'status', status: 'in_progress' }, 10);
  await tap('note', { action: 'note', body: 'Keep the red toolbox.' }, 1);
  await tap('completed', { action: 'complete', notes: 'Garage cleaned, debris removed and customer walkthrough complete.', hasIssues: false }, 20);

  const events = funnelDocs(store);
  assert.deepEqual(events.map(event => event.type), ['job.dispatched', 'job.arrived', 'job.started', 'job.completed'], 'pauses, resumes and notes are not funnel milestones');
  const expected = { dispatched: [0, 'scheduled', 'dispatched'], arrived: [30, 'dispatched', 'arrived'], started: [45, 'arrived', 'in_progress'], completed: [136, 'in_progress', 'completed'] };
  for (const event of events) {
    const name = event.type.slice(4), [minutes, fromStatus, toStatus] = expected[name];
    assert.equal(event.key, `funnelEvents/${funnelEventId(event.type, { field: 'jobId', value: 'job-1' }, `requestId:${ids[name]}`)}`);
    assert.deepEqual({ occurredAt: event.occurredAt, recordedAt: event.recordedAt, clockSource: event.clockSource, denverDate: event.denverDate, via: event.via, actor: event.actor, source: event.source, data: event.data },
      { occurredAt: at(minutes), recordedAt: at(minutes), clockSource: 'server', denverDate: '2026-09-22', via: 'field', actor: { id: 'crew.one', kind: 'human', role: 'crew' }, source: { collection: 'fieldEvents', id: ids[name] }, data: { fromStatus, toStatus, ...(name === 'completed' ? { visitPurpose: 'service' } : {}) } }, name);
    assert.deepEqual([event.jobId, event.projectId, event.customerId, event.highlevelContactId, event.isTest, event.definitionsHash], ['job-1', 'project_w1', 'customer-1', 'syntheticContact1', false, definitionsHash()]);
  }
  // Each milestone is one commit: the job, its fieldEvents receipt and the funnel event together.
  for (const name of Object.keys(expected)) assert.ok(commits.some(paths => paths.length === 3 && paths[0] === 'jobs/job-1' && paths[1] === `jobs/job-1/fieldEvents/${ids[name]}` && paths[2].startsWith('funnelEvents/fe_')), name);
  assert.ok(commits.filter(paths => paths.length === 2).length >= 3, 'the other actions commit only the job and receipt');

  const receipt = name => store.get(`jobs/job-1/fieldEvents/${ids[name]}`);
  assert.deepEqual([receipt('dispatched').fromStatus, receipt('dispatched').toStatus], ['scheduled', 'dispatched']);
  assert.deepEqual([receipt('paused').fromStatus, receipt('paused').toStatus], ['in_progress', 'paused']);
  assert.deepEqual([receipt('resumed').fromStatus, receipt('resumed').toStatus], ['paused', 'in_progress']);
  assert.deepEqual([receipt('completed').fromStatus, receipt('completed').toStatus], ['in_progress', 'completed']);
  assert.equal(receipt('note').fromStatus, undefined);
  const saved = store.get('jobs/job-1');
  assert.deepEqual([saved.dispatchedAt, saved.dispatchedBy, saved.arrivedAt, saved.startedAt, saved.completedAt], [at(0), 'Crew.One', at(30), at(45), at(136)]);
});

test('a replayed, recovered or stale tap never writes a second or orphan event', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date(FIELD_NOW) });
  const store = storage(t); store.put('jobs/job-1', crewJob());
  const post = await crew(t), dispatched = { action: 'status', status: 'dispatched', requestId: randomUUID(), expectedRevision: store.revision('job-1') };
  assert.equal((await post(store, dispatched)).status, 200);
  t.mock.timers.tick(60000);
  assert.equal((await (await post(store, dispatched)).json()).alreadyApplied, true);
  assert.equal(funnelDocs(store).length, 1);
  // The commit response is lost: the receipt proves it applied, and the retry adds nothing.
  const provider = globalThis.fetch; let interrupt = true;
  t.mock.method(globalThis, 'fetch', async (input, options) => {
    const response = await provider(input, options);
    if (interrupt && new URL(input).pathname.endsWith('/documents:commit')) { interrupt = false; return Response.json({}, { status: 503 }); }
    return response;
  });
  const arrived = { action: 'status', status: 'arrived', requestId: randomUUID(), expectedRevision: store.revision('job-1') };
  assert.equal((await (await post(store, arrived)).json()).alreadyApplied, true);
  assert.equal((await (await post(store, arrived)).json()).alreadyApplied, true);
  assert.deepEqual(funnelDocs(store).map(event => event.type), ['job.dispatched', 'job.arrived']);
  // A tap against an older job version is refused with no event.
  const stale = await post(store, { action: 'status', status: 'in_progress', expectedRevision: '2026-09-22T00:00:00.000000001Z' });
  assert.equal(stale.status, 409);
  assert.equal(funnelDocs(store).length, 2);
});

test('a field commit that loses the revision race saves neither the change, the receipt nor the event', async t => {
  const store = storage(t); store.put('jobs/job-1', crewJob());
  const fieldStore = createFieldStore(env), job = await fieldStore.readJob('job-1'), requestId = randomUUID();
  const result = fieldCommand(job, { user: 'Crew.One', displayName: 'Crew One' }, { action: 'status', status: 'dispatched', requestId }, FIELD_NOW);
  const event = await fieldFunnelWrite(job, { user: 'Crew.One', role: 'crew' }, { requestId, type: 'job.dispatched', ...result.funnel }, FIELD_NOW);
  store.put('jobs/job-1', { ...store.get('jobs/job-1'), crewLead: 'Crew.One' });
  await assert.rejects(fieldStore.commit(job, result.patch, result.event, null, [event]), error => error.code === 'FIELD_REVISION_CONFLICT');
  assert.equal(funnelDocs(store).length, 0);
  assert.deepEqual(store.get(`jobs/job-1/fieldEvents/${requestId}`), {});
  assert.equal(store.get('jobs/job-1').dispatchedAt, undefined);
});

test('field milestones: first start only, activities without events, and ledger-safe payloads', async () => {
  const actor = { user: 'Crew.One', displayName: 'Crew One', manager: false };
  let job = crewJob();
  const step = input => { const result = fieldCommand(job, actor, { requestId: randomUUID(), ...input }, FIELD_NOW); job = { ...job, ...result.patch }; return result; };
  assert.deepEqual(step({ action: 'status', status: 'dispatched' }).funnel, { milestone: 'dispatched', fromStatus: 'scheduled', toStatus: 'dispatched' });
  assert.equal(job.dispatchedAt, FIELD_NOW);
  const delayed = step({ action: 'status', status: 'delayed', reason: 'Traffic on I-25' });
  assert.equal(delayed.funnel, null); assert.deepEqual([delayed.event.fromStatus, delayed.event.toStatus], ['dispatched', 'delayed']);
  assert.deepEqual(step({ action: 'status', status: 'arrived' }).funnel, { milestone: 'arrived', fromStatus: 'delayed', toStatus: 'arrived' });
  assert.equal(step({ action: 'status', status: 'waiting', reason: 'Customer is on a call' }).funnel, null);
  assert.deepEqual(step({ action: 'status', status: 'in_progress' }).funnel, { milestone: 'started', fromStatus: 'waiting', toStatus: 'in_progress' });
  assert.equal(step({ action: 'status', status: 'paused', reason: 'Lunch break' }).funnel, null);
  assert.equal(step({ action: 'status', status: 'in_progress' }).funnel, null, 'resuming is not a second start');
  assert.equal(step({ action: 'note', body: 'Customer approved the shelf plan.' }).funnel, null);
  assert.deepEqual(step({ action: 'complete', notes: 'All agreed services were completed and reviewed.', hasIssues: false }).funnel, { milestone: 'completed', fromStatus: 'in_progress', toStatus: 'completed' });

  // isTest comes from the eligibility function; odd usernames and unknown purposes never fail the tap.
  const requestId = randomUUID(), tested = await fieldFunnelWrite(crewJob({ isTest: true, visitPurpose: 'teardown', projectId: 'secure_project', customerId: '_egc_x', highlevelContactId: 'bad id' }), { user: 'Crew One (temp)', role: 'Crew Lead' }, { requestId, type: 'job.completed', fromStatus: 'In Progress', toStatus: 'completed' }, FIELD_NOW);
  assert.equal(tested.patch.isTest, true); assert.equal(tested.patch.exclusion, 'test');
  assert.deepEqual(tested.patch.data, { toStatus: 'completed' });
  assert.match(tested.patch.actor.id, /^sha256:[0-9a-f]{32}$/); assert.equal(tested.patch.actor.role, null);
  assert.deepEqual([tested.patch.projectId, tested.patch.customerId, tested.patch.highlevelContactId], [null, null, null]);
});

test('the helpers keep ids, keys, actors and amounts inside what the ledger accepts', () => {
  assert.deepEqual(jobEventRefs({ id: 'job-1', projectId: 'project_w1', customerId: 'secure_customer', businessAccountId: 'acct-1', highlevelContactId: 'a'.repeat(121), highlevelOpportunityId: 'opp_1' }), { jobId: 'job-1', projectId: 'project_w1', customerId: undefined, businessAccountId: 'acct-1', highlevelContactId: undefined, highlevelOpportunityId: 'opp_1' });
  assert.equal(portalEventKey('synthetic-approval-0001'), 'synthetic-approval-0001');
  for (const value of ['short', 'has space in it', 'x'.repeat(121), undefined]) assert.match(portalEventKey(value), /^portal-[0-9a-f]{40}$/, String(value));
  assert.equal(portalEventKey('short'), portalEventKey('short'), 'the fallback key is stable');
  assert.equal(funnelActorId('ZacB'), 'zacb');
  assert.equal(funnelActorId('Crew One'), funnelActorId('crew one'));
  assert.deepEqual(portalActor({}), { id: 'customer', kind: 'customer', role: 'customer' });
  assert.deepEqual(portalActor({ actorId: 'person-1' }), { id: 'person-1', kind: 'customer', role: 'collaborator' });
  const company = `biz_${'a'.repeat(32)}_${'b'.repeat(32)}_1`;
  assert.deepEqual(portalActor({ actorId: company }), { id: company, kind: 'customer', role: 'business' });
  assert.deepEqual([savedCents(800), savedCents(75.5), savedCents('$1,250.10'), savedCents(null), savedCents(''), savedCents(-5), savedCents('n/a')], [80000, 7550, 125010, null, null, null, null]);
  // The live sale comes only from the job's server-owned funnelSale, never from customerApproval or the estimate.
  const funnelSale = { jobId: 'job-1', cents: 80000, estimateRevision: 2, key: 'portalRequest:synthetic-approval-0001', eventId: `fe_${'a'.repeat(40)}`, soldAt: NOW };
  assert.deepEqual(liveSale({ id: 'job-1', funnelSale }), { cents: 80000, estimateRevision: 2, key: funnelSale.key, eventId: funnelSale.eventId });
  assert.equal(liveSale({ id: 'job-1', funnelSale: { ...funnelSale, estimateRevision: 'two' } }).estimateRevision, null);
  const signed = { status: 'approved', approvedAt: NOW, amount: 800, source: 'customer_portal', estimateRevision: 2 };
  for (const job of [{ id: 'job-1', customerApproval: signed, estimate: { status: 'accepted', amount: 800 } }, { id: 'job-2', funnelSale }, { funnelSale }, { id: 'job-1', funnelSale: null },
    { id: 'job-1', funnelSale: { ...funnelSale, cents: 12.5 } }, { id: 'job-1', funnelSale: { ...funnelSale, cents: -1 } }, { id: 'job-1', funnelSale: { ...funnelSale, cents: 100000001 } }, { id: 'job-1', funnelSale: [funnelSale] }]) assert.equal(liveSale(job), null, JSON.stringify(job));
});

test('commitDocuments sends one atomic commit with update and create-only preconditions', async t => {
  const bodies = [];
  let status = 200;
  t.mock.method(globalThis, 'fetch', async (input, options) => {
    assert.equal(new URL(input).pathname, '/v1/projects/egcw-1ec83/databases/(default)/documents:commit');
    bodies.push(JSON.parse(options.body));
    return Response.json(status === 200 ? { commitTime: NOW } : { error: { status: 'FAILED_PRECONDITION' } }, { status });
  });
  const testEnv = { FIREBASE_API_KEY: 'firebase-test-fun03-commit' };
  await commitDocuments(testEnv, [{ id: 'job-1', patch: { a: 1 }, updateTime: 'r1' }, { id: 'job-2', patch: { b: 'x' } }, { collection: 'funnelEvents', id: 'fe_1', patch: { type: 'deal.sold' }, create: true }]);
  assert.deepEqual(bodies[0].writes.map(write => [write.update.name.split('/documents/')[1], write.updateMask.fieldPaths, write.currentDocument]), [
    ['jobs/job-1', ['a'], { updateTime: 'r1' }], ['jobs/job-2', ['b'], { exists: true }], ['funnelEvents/fe_1', ['type'], { exists: false }],
  ]);
  status = 400;
  await assert.rejects(commitDocuments(testEnv, [{ id: 'job-1', patch: { a: 2 }, updateTime: 'r0' }]), error => /\(400\)/.test(error.message) && error.storageStatus === 400);
});

// ---- Customer portal ----

const portalJob = (extra = {}) => ({ type: 'job', customer: 'Synthetic Customer', customerId: 'customer-1', projectId: 'project_w1', address: '100 Synthetic Street', serviceType: 'Garage Turnaround', total: 800, status: 'scheduled', estimate: { number: 'EST-1', status: 'sent', amount: 800, revision: 2, validUntil: '2026-10-01' }, ...extra });
const approve = (shown, extra = {}) => ({ action: 'approve_estimate', signed_name: 'Synthetic Customer', confirmed: true, estimate_revision: shown.revision, amount_cents: Math.round(shown.amount * 100), estimate_fingerprint: shown.fingerprint, ...extra });
const event = (f, type) => f.events().filter(item => item.type === type);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const netSold = events => events.reduce((sum, item) => sum + (item.type === 'deal.sold' ? item.data.amountCents : item.type === 'deal.approval_superseded' ? -item.data.amountCents : 0), 0);

test('a portal approval commits deal.sold with the approval, on the handler clock, and a re-signature is not a second sale', async t => {
  const f = portalStore(t, { 'job-1': portalJob() }), handlers = portalHandlers(), cookie = await portalCookie();
  const shown = (await portalView(handlers, cookie)).body.estimate;
  const approved = await portalPost(handlers, cookie, approve(shown, { request_id: 'synthetic-approval-0001' }));
  assert.equal(approved.status, 200);
  const [sold] = f.events();
  assert.equal(f.events().length, 1);
  assert.deepEqual({ type: sold.type, data: sold.data, occurredAt: sold.occurredAt, recordedAt: sold.recordedAt, clockSource: sold.clockSource, denverDate: sold.denverDate, via: sold.via, actor: sold.actor, entityKey: sold.entityKey, jobId: sold.jobId, customerId: sold.customerId, idempotencyKey: sold.idempotencyKey, source: sold.source },
    { type: 'deal.sold', data: { amountCents: 80000, estimateRevision: 2 }, occurredAt: NOW, recordedAt: NOW, clockSource: 'server', denverDate: '2026-09-22', via: 'portal', actor: { id: 'customer', kind: 'customer', role: 'customer' }, entityKey: 'projectId:project_w1', jobId: 'job-1', customerId: 'customer-1', idempotencyKey: 'portalRequest:synthetic-approval-0001', source: { collection: 'jobs', id: 'job-1:customerApproval:synthetic-approval-0001' } });
  const soldId = funnelEventId('deal.sold', { field: 'projectId', value: 'project_w1' }, 'portalRequest:synthetic-approval-0001');
  assert.deepEqual(f.commits[0], ['jobs/job-1', `funnelEvents/${soldId}`], 'the approval and its sale are one commit');
  assert.deepEqual([f.job('job-1').customerApproval.approvedAt, f.job('job-1').customerApproval.requestId, f.job('job-1').customerApproval.estimateRevision], [NOW, 'synthetic-approval-0001', 2]);
  // The job names the sale the ledger now counts, in the same commit.
  const sale = { jobId: 'job-1', cents: 80000, estimateRevision: 2, key: 'portalRequest:synthetic-approval-0001', eventId: soldId, soldAt: NOW };
  assert.deepEqual(f.job('job-1').funnelSale, sale);
  assert.ok(f.writes[0].fields.includes('funnelSale'));
  // The same request after a lost response returns the saved signature without writing.
  const replay = await portalPost(portalHandlers('2026-09-22T18:05:00.000Z'), cookie, approve(shown, { request_id: 'synthetic-approval-0001', signed_name: 'Synthetic Retry' }));
  assert.deepEqual([replay.status, replay.body.replayed, replay.body.approval.approvedAt, replay.body.approval.approvedBy], [200, true, NOW, 'Synthetic Customer']);
  assert.equal(f.writes.length, 1);
  // A double tap or stale tab re-signs the same total: the approval is saved again, no second sale is counted.
  const again = await portalPost(handlers, cookie, approve((await portalView(handlers, cookie)).body.estimate));
  assert.equal(again.status, 200);
  assert.equal(f.writes.length, 2);
  assert.equal(f.events().length, 1);
  // A page that sends no request_id still gets a request name on the saved approval.
  assert.match(f.job('job-1').customerApproval.requestId, UUID);
  // customerApproval.requestId names the last signature (its retry is a replay); the sale is still the first one.
  assert.deepEqual(f.job('job-1').funnelSale, sale);
  assert.ok(!f.writes[1].fields.includes('funnelSale'), 'a re-signature leaves the live sale as it is');
});

test('replacing the live sale at a different total records its supersede; a handoff sale at the same total adds nothing', async t => {
  // Walkthrough handoffs saved these approvals and, with their deal.sold, the job's funnelSale.
  const prior = { status: 'approved', approvedAt: '2026-09-20T17:00:00.000Z', approvedBy: 'Synthetic Customer', amount: 700, source: 'in_person_signature', estimateRevision: 1 };
  const handoffSale = (jobId, cents) => ({ jobId, cents, estimateRevision: 1, key: 'requestId:10000000-0000-4000-8000-000000000001', eventId: `fe_${'1'.repeat(40)}`, soldAt: '2026-09-20T17:00:00.000Z' });
  const f = portalStore(t, {
    'job-1': portalJob({ customerApproval: prior, funnelSale: handoffSale('job-1', 70000) }),
    'job-2': portalJob({ customerApproval: { ...prior, amount: 800 }, estimate: { ...portalJob().estimate, status: 'approved' }, funnelSale: handoffSale('job-2', 80000) }),
    // An approval with no live sale: history from before the sale writers, or a copy of another job's sale.
    'job-3': portalJob({ customerApproval: prior }),
    'job-4': portalJob({ customerApproval: prior, funnelSale: handoffSale('job-1', 70000) }),
  });
  const handlers = portalHandlers(), cookie = await portalCookie();
  assert.equal((await portalPost(handlers, cookie, approve((await portalView(handlers, cookie)).body.estimate))).status, 200);
  assert.deepEqual(f.events().map(item => [item.type, item.data]), [['deal.approval_superseded', { amountCents: 70000, estimateRevision: 1 }], ['deal.sold', { amountCents: 80000, estimateRevision: 2 }]]);
  assert.equal(f.commits[0].length, 3, 'the approval, the supersede and the sale are one commit');
  assert.equal(netSold(f.events()), 80000 - 70000, 'sold minus superseded moves by the change in the contract');
  assert.deepEqual([f.job('job-1').funnelSale.cents, f.job('job-1').funnelSale.key], [80000, event(f, 'deal.sold')[0].idempotencyKey]);
  const other = await portalCookie('job-2');
  assert.equal((await portalPost(handlers, other, approve((await portalView(handlers, other)).body.estimate))).status, 200);
  assert.equal(f.events().length, 2, 'the walkthrough handoff already recorded this sale');
  assert.deepEqual(f.job('job-2').funnelSale, handoffSale('job-2', 80000));
  for (const id of ['job-3', 'job-4']) {
    const cookie3 = await portalCookie(id);
    assert.equal(liveSale({ ...f.job(id), id }), null);
    assert.equal((await portalPost(handlers, cookie3, approve((await portalView(handlers, cookie3)).body.estimate))).status, 200);
    assert.deepEqual(f.events().filter(item => item.jobId === id).map(item => [item.type, item.data.amountCents]), [['deal.sold', 80000]], `${id}: nothing the ledger holds is retired`);
    assert.equal(f.job(id).funnelSale.jobId, id);
  }
});

test('an approval that cannot record its event, or loses the revision race, saves nothing', async t => {
  const f = portalStore(t, { 'job-1': portalJob({ total: 1500000, estimate: { ...portalJob().estimate, amount: 1500000 } }), 'job-2': portalJob() }), handlers = portalHandlers();
  const cookie = await portalCookie(), shown = (await portalView(handlers, cookie)).body.estimate;
  const invalid = await portalPost(handlers, cookie, approve(shown, { request_id: 'bad id' }));
  assert.deepEqual([invalid.status, invalid.body.code], [400, 'CUSTOMER_PORTAL_REQUEST_INVALID']);
  const refused = await portalPost(handlers, cookie, approve(shown));
  assert.deepEqual([refused.status, refused.body.code], [503, 'CUSTOMER_PORTAL_STORAGE_UNAVAILABLE'], 'an amount the ledger cannot hold is never approved without its sale');
  assert.equal(f.writes.length, 0); assert.equal(f.job('job-1').customerApproval, undefined);
  const second = await portalCookie('job-2'), view = (await portalView(handlers, second)).body.estimate;
  const racing = portalHandlers(NOW, { read: async (testEnv, id) => { const row = await readJob(testEnv, id); f.edit('job-2', { estimate: { ...f.job('job-2').estimate, scope: 'Staff edit' } }); return row; } });
  const raced = await portalPost(racing, second, approve(view));
  assert.deepEqual([raced.status, raced.body.code], [409, 'CUSTOMER_PORTAL_REVISION_CONFLICT']);
  assert.equal(f.events().length, 0);
});

test('collaborator approvals and change orders name the person who acted', async t => {
  const person = { id: 'person-1', name: 'Synthetic Family', email: 'family@example.invalid', status: 'active', permissions: { view: true, decide: true, pay: false, rebook: false } };
  const decisions = [
    { id: 'decision-1', title: 'Remove the cabinet?', priceDelta: 75, status: 'pending', promptedAt: '2026-09-22T15:00:00Z', internalNote: 'Synthetic staff-only note', crewCost: 12 },
    { id: 'decision-2', title: 'Add epoxy touch-up?', priceDelta: '20.50', status: 'pending', promptedAt: '2026-09-22T15:05:00Z' },
    { id: 'decision-3', title: 'Haul the shelving?', priceDelta: 40, status: 'pending', promptedAt: '2026-09-22T15:10:00Z' },
  ];
  const f = portalStore(t, { 'job-1': portalJob({ customerCollaborators: [person], customerDecisions: decisions }) }), handlers = portalHandlers();
  const cookie = await portalCookie('job-1', { actorId: 'person-1', permissions: person.permissions });
  const answer = (id, response, extra = {}) => portalPost(handlers, cookie, { action: 'respond_decision', decision_id: id, response, responded_by: 'Synthetic Family', ...extra });
  // The page sends a UUID (CHANGE-ORDERS' request format), saved lowercased.
  const pageId = '5c0b8f2e-3a41-4d7e-9b6a-0f1e2d3c4b5a';
  const first = await answer('decision-1', 'approved', { request_id: pageId.toUpperCase() });
  assert.equal(first.status, 200);
  assert.deepEqual(Object.keys(first.body.decision).sort(), ['billed', 'closed', 'details', 'id', 'photoUrl', 'priceDelta', 'promptedAt', 'respondedAt', 'responseBy', 'responseNote', 'status', 'timeDeltaMinutes', 'title'], 'the answer is shown as the page sees decisions, never staff fields or request bookkeeping');
  assert.equal((await answer('decision-2', 'declined')).status, 200);
  assert.deepEqual(f.events().map(item => [item.type, item.data, item.source.id, item.actor]), [
    ['change_order.approved', { amountCents: 7500 }, 'job-1:customerDecisions:decision-1', { id: 'person-1', kind: 'customer', role: 'collaborator' }],
    ['change_order.declined', { amountCents: 2050 }, 'job-1:customerDecisions:decision-2', { id: 'person-1', kind: 'customer', role: 'collaborator' }],
  ]);
  assert.equal(f.events()[0].idempotencyKey, `portalRequest:${pageId}`);
  const [saved1, saved2] = f.job('job-1').customerDecisions;
  assert.deepEqual([saved1.responseRequestId, saved1.responseEventKey], [pageId, pageId]);
  assert.equal(saved2.responseRequestId, undefined, 'responseRequestId only ever names a page request');
  assert.match(saved2.responseEventKey, UUID, 'a page without a request id gets a server-named event key');
  assert.equal(f.events()[1].idempotencyKey, `portalRequest:${saved2.responseEventKey}`, 'the saved answer joins its event');
  // The same request after a lost response returns the saved answer; any other answer is a conflict.
  const replay = await answer('decision-1', 'approved', { request_id: pageId });
  assert.deepEqual([replay.status, replay.body.replayed, replay.body.approvedChangeTotal, replay.body.decision], [200, true, 75, first.body.decision]);
  assert.equal((await answer('decision-1', 'approved', { request_id: '6d1c9f3f-4b52-4e8f-8c7b-1f2e3d4c5b6a' })).status, 409);
  const reused = await answer('decision-3', 'approved', { request_id: pageId });
  assert.deepEqual([reused.status, reused.body.code], [409, 'CUSTOMER_PORTAL_IDEMPOTENCY_CONFLICT'], 'one request never answers two questions');
  const malformed = await answer('decision-3', 'approved', { request_id: 'synthetic-decision-0001' });
  assert.deepEqual([malformed.status, malformed.body.code], [400, 'CUSTOMER_PORTAL_REQUEST_INVALID']);
  assert.equal(f.job('job-1').customerDecisions[2].status, 'pending');
  assert.equal(f.events().length, 2);
  // The same person can also sign the estimate.
  assert.equal((await portalPost(handlers, cookie, approve((await portalView(handlers, cookie)).body.estimate))).status, 200);
  assert.deepEqual(event(f, 'deal.sold')[0].actor, { id: 'person-1', kind: 'customer', role: 'collaborator' });
});

test('a rebooking request is recorded as rebook.requested when it is written, once per request', async t => {
  const f = portalStore(t, { 'job-1': portalJob({ status: 'completed', completedAt: '2026-09-15T18:00:00Z' }) }), handlers = portalHandlers(NOW), cookie = await portalCookie();
  const first = await portalPost(handlers, cookie, { action: 'request_rebook', kind: 'touch_up', timing: 'asap', notes: 'Same setup as last time', request_id: 'synthetic-rebook-0001' });
  assert.equal(first.status, 200);
  const [requested] = f.events();
  assert.deepEqual([requested.type, requested.occurredAt, requested.source.id, requested.idempotencyKey, requested.jobId, requested.customerId], ['rebook.requested', NOW, `job-1:rebookingRequests:${first.body.request.id}`, 'portalRequest:synthetic-rebook-0001', 'job-1', 'customer-1']);
  assert.equal(first.body.request.requestId, 'synthetic-rebook-0001');
  // The same request, or the same pending ask from a page without an id, adds nothing.
  const retry = await portalPost(handlers, cookie, { action: 'request_rebook', kind: 'touch_up', timing: 'asap', notes: 'Same setup as last time', request_id: 'synthetic-rebook-0001' });
  assert.deepEqual([retry.status, retry.body.replayed, retry.body.request.id], [200, true, first.body.request.id]);
  assert.equal((await portalPost(handlers, cookie, { action: 'request_rebook', kind: 'touch_up', timing: 'asap', notes: 'Same setup as last time' })).body.request.id, first.body.request.id);
  // Changed details under a saved request_id (the response was lost, then the customer edited) are refused, never dropped.
  for (const changed of [{ notes: 'Changed wording' }, { kind: 'repeat' }, { timing: 'same_weekday' }, { preferred_crew: true }, { timing: 'choose_date', preferred_date: '2026-10-05' }]) {
    const edited = await portalPost(handlers, cookie, { action: 'request_rebook', kind: 'touch_up', timing: 'asap', notes: 'Same setup as last time', request_id: 'synthetic-rebook-0001', ...changed });
    assert.deepEqual([edited.status, edited.body.code], [409, 'CUSTOMER_PORTAL_IDEMPOTENCY_CONFLICT'], JSON.stringify(changed));
  }
  assert.equal(f.job('job-1').rebookingRequests.length, 1);
  assert.equal(f.events().length, 1);
  const second = await portalPost(handlers, cookie, { action: 'request_rebook', kind: 'garage_guard', timing: 'asap' });
  assert.equal(second.status, 200);
  assert.deepEqual(f.events().map(item => item.idempotencyKey), ['portalRequest:synthetic-rebook-0001', `portalRequest:${second.body.request.id}`], 'a page without a request id is keyed by the saved request');
  assert.equal(second.body.request.requestId, undefined);
});

test('a review click is recorded as review.clicked once per click request', async t => {
  const done = portalJob({ total: 600, estimate: undefined, status: 'completed', completedAt: '2026-09-22T16:00:00Z', payment: { amount: 600, verified: true } });
  const f = portalStore(t, { 'job-1': done }), handlers = portalHandlers(), cookie = await portalCookie(), id = randomUUID();
  assert.equal((await portalPost(handlers, cookie, { action: 'record_review_click', request_id: id })).body.recorded, true);
  assert.equal((await portalPost(handlers, cookie, { action: 'record_review_click', request_id: id })).body.duplicate, true);
  assert.equal((await portalPost(handlers, cookie, { action: 'record_review_click', request_id: randomUUID() })).body.recorded, false, 'a repeat visit inside a minute is not a new click');
  assert.deepEqual(f.events().map(item => [item.type, item.idempotencyKey, item.source.id, item.occurredAt]), [['review.clicked', `portalRequest:${id}`, `job-1:reviewClicks:${id}`, NOW]]);
  assert.deepEqual(f.commits, [['jobs/job-1', f.commits[0][1]]]);
});

test('a gift credit is recorded as credit.redeemed with the job and the account wallet in one commit', async t => {
  const wallet = { cards: [{ id: 'credit-1', label: 'Holiday gift card', issuedAmount: 100, remainingAmount: 100, source: 'gift_purchase' }], redemptions: [] };
  const f = portalStore(t, { root: { type: 'job', customerId: 'customer-1', customer: 'Synthetic Customer', address: '100 Synthetic Street', giftWallet: wallet }, 'job-1': portalJob({ customerAccountOwnerJobId: 'root', estimate: { ...portalJob().estimate, status: 'approved' } }) });
  const handlers = portalHandlers(), cookie = await portalCookie();
  const applied = await portalPost(handlers, cookie, { action: 'apply_gift_credit', card_id: 'credit-1', amount: 75, request_id: 'credit-credit-1-1790000000000' });
  assert.deepEqual([applied.status, applied.body.applied], [200, 75]);
  const [redeemed] = f.events(), redemption = f.job('root').giftWallet.redemptions[0];
  assert.deepEqual([redeemed.type, redeemed.data, redeemed.jobId, redeemed.source, redeemed.idempotencyKey], ['credit.redeemed', { amountCents: 7500, creditClass: 'gift_purchase' }, 'job-1', { collection: 'jobs', id: `root:giftWallet.redemptions:${redemption.id}` }, 'portalRequest:credit-credit-1-1790000000000']);
  assert.deepEqual(f.commits[0].slice(0, 2), ['jobs/root', 'jobs/job-1']);
  assert.equal(f.commits.length, 1);
  assert.equal((await portalPost(handlers, cookie, { action: 'apply_gift_credit', card_id: 'credit-1', amount: 75, request_id: 'credit-credit-1-1790000000000' })).status, 200);
  assert.equal(f.events().length, 1, 'a replayed redemption is not counted twice');
});

// ---- Hub revisions between portal approvals (review fix) ----

const owner = { user: 'zacb', role: 'owner', businessAccess: true, displayName: 'Synthetic Owner' };
// The M3 money service over the same fake Firestore jobs as the portal; its receipts, audit and events land in docs.
function moneyStore(f) {
  const docs = new Map();
  return {
    docs, events: () => [...docs].filter(([key]) => key.startsWith('funnelEvents/')).map(([, row]) => structuredClone(row)),
    read: async (collection, id) => collection === 'jobs' ? f.rows.has(id) ? { ...f.job(id), id, revision: f.revision(id) } : null : structuredClone(docs.get(`${collection}/${id}`) ?? null),
    async commit(writes) {
      for (const write of writes) if (write.collection === 'jobs' ? write.revision !== f.revision(write.id) : docs.has(`${write.collection}/${write.id}`)) throw Object.assign(new Error('Conflict'), { code: 'money_revision_conflict', status: 409 });
      for (const write of writes) if (write.collection === 'jobs') f.edit(write.id, write.patch); else docs.set(`${write.collection}/${write.id}`, structuredClone(write.patch));
    },
  };
}
const revision = (f, unitCents, id = 'job-1') => ({ action: 'estimate.save', requestId: randomUUID(), jobId: id, expectedRevision: f.revision(id), lineItems: [{ id: 'line-1', kind: 'service', name: 'Synthetic garage reset', description: 'Synthetic scope', quantity: 1, unitCents }], scope: 'Synthetic revised scope', validUntil: '2026-10-01' });
const revise = (store, f, unitCents, id = 'job-1', now = '2026-09-22T18:30:00.000Z') => mutateMoney(store, owner, revision(f, unitCents, id), now);

test('portal approve $800, Hub revise to $900, portal approve $900: the revision retires the first sale, net sold is $900', async t => {
  const f = portalStore(t, { 'job-1': portalJob() }), money = moneyStore(f), handlers = portalHandlers(), cookie = await portalCookie();
  assert.equal((await portalPost(handlers, cookie, approve((await portalView(handlers, cookie)).body.estimate))).status, 200);
  const input = revision(f, 90000), revised = await mutateMoney(money, owner, input, '2026-09-22T18:30:00.000Z');
  assert.deepEqual(revised.warnings.map(warning => warning.code), ['approval_superseded']);
  const saved = f.job('job-1').customerApproval;
  assert.deepEqual([saved.status, saved.reason, saved.supersededRequestId], ['superseded', 'estimate_revised', revised.requestId]);
  // The revision's own commit carries deal.approval_superseded for the $800 sale, keyed by the money request.
  const [superseded] = money.events();
  assert.equal(money.events().length, 1);
  assert.deepEqual({ type: superseded.type, data: superseded.data, via: superseded.via, actor: superseded.actor, source: superseded.source, idempotencyKey: superseded.idempotencyKey, occurredAt: superseded.occurredAt, clockSource: superseded.clockSource, jobId: superseded.jobId },
    { type: 'deal.approval_superseded', data: { amountCents: 80000, estimateRevision: 2 }, via: 'hub', actor: { id: 'zacb', kind: 'human', role: 'owner' }, source: { collection: 'moneyOperations', id: revised.requestId.toLowerCase() }, idempotencyKey: `requestId:${revised.requestId.toLowerCase()}`, occurredAt: '2026-09-22T18:30:00.000Z', clockSource: 'server', jobId: 'job-1' });
  assert.ok(money.docs.has(`moneyOperations/${revised.requestId.toLowerCase()}`), 'with its receipt');
  assert.equal(f.job('job-1').funnelSale, null, 'the revision commit clears the retired sale');
  const shown = (await portalView(handlers, cookie)).body.estimate;
  assert.deepEqual([shown.amount, shown.revision, shown.approvable], [900, 3, true]);
  assert.equal((await portalPost(handlers, cookie, approve(shown))).status, 200);
  const ledger = [...f.events(), ...money.events()];
  assert.deepEqual(ledger.map(item => [item.type, item.data.amountCents]), [['deal.sold', 80000], ['deal.sold', 90000], ['deal.approval_superseded', 80000]]);
  assert.equal(netSold(ledger), 90000, 'net deal.sold minus superseded is the current contract');
  assert.equal(f.job('job-1').funnelSale.cents, 90000);
  // A retried revision request is answered from its receipt and writes nothing more.
  assert.equal((await mutateMoney(money, owner, structuredClone(input), '2026-09-22T18:40:00.000Z')).replayed, true);
  assert.equal(money.events().length, 1);
});

// The Hub's legacy browser finance writers (employee-suite.js opsFinanceAction,
// MONEY_API_ENABLED off). patchJob saves with set(update, {merge: true}), which
// merges nested maps key by key; neither writer names funnelSale.
const plainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const setMerge = (base, update) => Object.fromEntries([...new Set([...Object.keys(base), ...Object.keys(update)])].map(key => [key, !(key in update) ? base[key] : plainObject(update[key]) && plainObject(base[key]) ? setMerge(base[key], update[key]) : update[key]]));
const browserSave = (f, id, update) => f.put(id, setMerge(f.job(id), update));
const unattributed = ({ approvedByActorId, approvedByBusinessAccountId, approvedByBusinessMemberId, ...record } = {}) => record;
// "Record approval": the always-visible button that records a verbal yes.
function legacyRecordApproval(f, id, at = '2026-09-22T18:20:00.000Z') {
  const j = f.job(id), total = Number(j.total || j.priceQuoted || 0);
  browserSave(f, id, { updatedAt: at, quoteStatus: 'approved', customerPortalInvitationRequestedAt: j.customerPortalInvitationRequestedAt || at,
    estimate: { ...unattributed(j.estimate), number: j.estimate?.number || 'EST-SYNTH', status: 'accepted', amount: total, acceptedAt: at, acceptedBy: 'Synthetic Customer', acceptanceMethod: 'employee_recorded', termsVersion: j.estimate?.termsVersion || '2026-09', updatedAt: at },
    customerApproval: { status: 'approved', approvedAt: at, approvedBy: 'Synthetic Customer', amount: total, source: 'employee_recorded' } });
}
// "Update estimate" with a new total on an approved estimate.
function legacyReviseEstimate(f, id, amount, at = '2026-09-22T18:10:00.000Z') {
  const j = f.job(id), current = j.estimate || {}, scope = current.scope || 'Synthetic scope';
  browserSave(f, id, { updatedAt: at, total: amount, priceQuoted: amount, customerAutomationEnabled: true, quoteStatus: 'draft',
    estimate: { ...unattributed(current), number: current.number || 'EST-SYNTH', status: 'draft', amount, scope, lineItems: [{ name: 'Garage transformation', description: scope, quantity: 1, amount }], depositRequired: amount / 2, validUntil: '2026-10-01', termsVersion: '2026-09', revision: Number(current.revision || 1) + 1, createdAt: current.createdAt || at, updatedAt: at, source: 'egc_hub' },
    deposit: { ...(j.deposit || {}), amount: amount / 2, status: 'required' },
    customerApproval: { ...(j.customerApproval || {}), status: 'superseded', supersededAt: at, reason: 'estimate_revised' } });
}
const sale = (f, id) => liveSale({ ...f.job(id), id });
const ledgerOf = (events, id) => events.filter(item => item.jobId === id).map(item => [item.type, item.data.amountCents]);

test('a sale the legacy browser editor superseded stays live and is retired by the next portal approval, once', async t => {
  const f = portalStore(t, { 'job-1': portalJob() }), handlers = portalHandlers(), cookie = await portalCookie();
  assert.equal((await portalPost(handlers, cookie, approve((await portalView(handlers, cookie)).body.estimate))).status, 200);
  legacyReviseEstimate(f, 'job-1', 900);
  assert.equal(f.job('job-1').customerApproval.status, 'superseded');
  assert.equal(sale(f, 'job-1').cents, 80000, 'the browser writer cannot record the supersede, so the sale is still live');
  assert.equal((await portalPost(handlers, cookie, approve((await portalView(handlers, cookie)).body.estimate, { request_id: 'synthetic-approval-0900' }))).status, 200);
  assert.deepEqual(f.events().map(item => [item.type, item.data, item.idempotencyKey, item.source.id]), [
    ['deal.sold', { amountCents: 80000, estimateRevision: 2 }, f.events()[0].idempotencyKey, f.events()[0].source.id],
    ['deal.approval_superseded', { amountCents: 80000, estimateRevision: 2 }, 'portalRequest:synthetic-approval-0900', 'job-1:customerApproval:synthetic-approval-0900'],
    ['deal.sold', { amountCents: 90000, estimateRevision: 3 }, 'portalRequest:synthetic-approval-0900', 'job-1:customerApproval:synthetic-approval-0900'],
  ]);
  assert.equal(netSold(f.events()), 90000);
  // Re-signing $900 is not a second sale.
  assert.equal((await portalPost(handlers, cookie, approve((await portalView(handlers, cookie)).body.estimate))).status, 200);
  assert.equal(f.events().length, 3);
  assert.deepEqual([sale(f, 'job-1').cents, sale(f, 'job-1').key], [90000, 'portalRequest:synthetic-approval-0900']);
});

test('S1: a staff "Record approval" after a portal sale never hides it: a stale tab re-signing writes nothing, and a Hub revision retires it', async t => {
  const f = portalStore(t, { 'job-1': portalJob() }), money = moneyStore(f), handlers = portalHandlers(), cookie = await portalCookie();
  const stale = (await portalView(handlers, cookie)).body.estimate; // a second tab or a collaborator's page
  assert.equal((await portalPost(handlers, cookie, approve(stale))).status, 200);
  legacyRecordApproval(f, 'job-1');
  assert.deepEqual([f.job('job-1').customerApproval.source, sale(f, 'job-1').cents], ['employee_recorded', 80000]);
  const again = await portalPost(handlers, cookie, approve(stale));
  assert.equal(again.status, 200, 'the binding checks still pass: the staff approval changed no revision, total or content');
  assert.deepEqual(ledgerOf(f.events(), 'job-1'), [['deal.sold', 80000]]);
  assert.equal(netSold(f.events()), 80000, 'net is the $800 contract, not $1,600');
  // The Hub revises the estimate: the live sale is retired in the revision's commit, and the next signature records the new one.
  await revise(money, f, 95000);
  assert.deepEqual(ledgerOf(money.events(), 'job-1'), [['deal.approval_superseded', 80000]]);
  assert.equal(f.job('job-1').funnelSale, null);
  assert.equal((await portalPost(handlers, cookie, approve((await portalView(handlers, cookie)).body.estimate))).status, 200);
  assert.equal(netSold([...f.events(), ...money.events()]), 95000);
});

test('S2: portal $800, legacy revise to $900, staff approval (legacy or M3), then a tab loaded after the revision signs $900: net $900', async t => {
  const f = portalStore(t, { 'job-1': portalJob(), 'job-2': portalJob() }), money = moneyStore(f), handlers = portalHandlers();
  const staff = {
    'job-1': id => legacyRecordApproval(f, id),
    'job-2': id => mutateMoney(money, owner, { action: 'estimate.record_approval', requestId: randomUUID(), jobId: id, expectedRevision: f.revision(id), approvedBy: 'Synthetic Customer' }, '2026-09-22T18:20:00.000Z'),
  };
  for (const id of ['job-1', 'job-2']) {
    const cookie = await portalCookie(id);
    assert.equal((await portalPost(handlers, cookie, approve((await portalView(handlers, cookie)).body.estimate))).status, 200);
    legacyReviseEstimate(f, id, 900);
    const shown900 = (await portalView(handlers, cookie)).body.estimate; // the customer reads the update, then phones a yes
    await staff[id](id);
    assert.equal(f.job(id).customerApproval.source, 'employee_recorded');
    const signed = await portalPost(handlers, cookie, approve(shown900));
    assert.equal(signed.status, 200, id);
    assert.deepEqual(ledgerOf(f.events(), id), [['deal.sold', 80000], ['deal.approval_superseded', 80000], ['deal.sold', 90000]], id);
    assert.equal(netSold(f.events().filter(item => item.jobId === id)), 90000, `${id}: net is the $900 contract`);
    assert.equal(sale(f, id).cents, 90000);
  }
  assert.deepEqual(money.events(), [], 'a staff-recorded approval writes no sale of its own');
});

test('S3: a re-signature keeps the live sale\'s key; customerApproval.requestId names only the last signature', async t => {
  const f = portalStore(t, { 'job-1': portalJob() }), handlers = portalHandlers(), cookie = await portalCookie();
  const shown = (await portalView(handlers, cookie)).body.estimate;
  assert.equal((await portalPost(handlers, cookie, approve(shown, { request_id: 'synthetic-first-0001' }))).status, 200);
  assert.equal((await portalPost(handlers, cookie, approve(shown, { request_id: 'synthetic-second-0002' }))).status, 200);
  assert.deepEqual(f.events().map(item => item.idempotencyKey), ['portalRequest:synthetic-first-0001']);
  assert.deepEqual([f.job('job-1').funnelSale.key, f.job('job-1').funnelSale.eventId], ['portalRequest:synthetic-first-0001', funnelEventId('deal.sold', { field: 'projectId', value: 'project_w1' }, 'portalRequest:synthetic-first-0001')], 'the job joins its deal.sold through funnelSale');
  assert.equal(f.job('job-1').customerApproval.requestId, 'synthetic-second-0002');
  // Either request retried after a lost response writes nothing more.
  const writes = f.writes.length;
  assert.equal((await portalPost(handlers, cookie, approve(shown, { request_id: 'synthetic-second-0002' }))).body.replayed, true);
  assert.equal((await portalPost(handlers, cookie, approve(shown, { request_id: 'synthetic-first-0001' }))).status, 200);
  assert.equal(f.writes.length, writes + 1);
  assert.equal(f.events().length, 1);
});

// A signature whose response was lost keeps its request_id on the button. The
// staff then revise the estimate and record a phoned approval before the
// customer taps Approve on the revised total with that same request_id.
test('a lost response, a legacy revise and Record approval: the spent request_id is refused, never replayed as the staff approval', async t => {
  const f = portalStore(t, { 'job-1': portalJob() }), handlers = portalHandlers(), cookie = await portalCookie();
  const spent = '7c1f6a51-2a53-4c55-9d4a-5b0c3d2e1f00', fresh = '7c1f6a51-2a53-4c55-9d4a-5b0c3d2e1f10';
  assert.equal((await portalPost(handlers, cookie, approve((await portalView(handlers, cookie)).body.estimate, { request_id: spent }))).status, 200); // its response is lost
  legacyReviseEstimate(f, 'job-1', 900);
  const shown900 = (await portalView(handlers, cookie)).body.estimate; // the page's quiet poll
  legacyRecordApproval(f, 'job-1');
  assert.deepEqual([f.job('job-1').customerApproval.requestId, f.job('job-1').customerApproval.source], [spent, 'employee_recorded'], 'set(merge) keeps the portal requestId under the staff approval');
  const writes = f.writes.length;
  const reused = await portalPost(handlers, cookie, approve(shown900, { request_id: spent, terms_version: shown900.termsVersion }));
  assert.deepEqual([reused.status, reused.body.code, reused.body.replayed], [409, 'CUSTOMER_PORTAL_IDEMPOTENCY_CONFLICT', undefined], 'the staff approval is never returned as the customer\'s signature');
  assert.equal(f.writes.length, writes);
  assert.deepEqual(ledgerOf(f.events(), 'job-1'), [['deal.sold', 80000]]);
  // The page starts a new request_id: the customer's signature, its terms and the $900 sale are recorded.
  const signed = await portalPost(handlers, cookie, approve(shown900, { request_id: fresh, terms_version: shown900.termsVersion }));
  assert.deepEqual([signed.status, signed.body.replayed], [200, undefined]);
  const approval = f.job('job-1').customerApproval;
  assert.deepEqual([approval.source, approval.requestId, approval.estimateRevision, approval.amount, approval.termsVersion], ['customer_portal', fresh, 3, 900, shown900.termsVersion]);
  assert.deepEqual(ledgerOf(f.events(), 'job-1'), [['deal.sold', 80000], ['deal.approval_superseded', 80000], ['deal.sold', 90000]]);
  assert.equal(netSold(f.events()), 90000, 'net is the $900 contract');
  assert.deepEqual([sale(f, 'job-1').cents, sale(f, 'job-1').key], [90000, `portalRequest:${fresh}`]);
  // That request retried after a lost response is a replay of the portal signature.
  const replay = await portalPost(handlers, cookie, approve(shown900, { request_id: fresh, terms_version: shown900.termsVersion }));
  assert.deepEqual([replay.status, replay.body.replayed, replay.body.approval.source], [200, true, 'customer_portal']);
  assert.equal(f.events().length, 3);
});

test('a lost response, a legacy revise and an M3 record_approval: the spent request_id is refused, not reported as a changed estimate', async t => {
  const f = portalStore(t, { 'job-1': portalJob() }), money = moneyStore(f), handlers = portalHandlers(), cookie = await portalCookie();
  const spent = '7c1f6a51-2a53-4c55-9d4a-5b0c3d2e1f01', fresh = '7c1f6a51-2a53-4c55-9d4a-5b0c3d2e1f11';
  assert.equal((await portalPost(handlers, cookie, approve((await portalView(handlers, cookie)).body.estimate, { request_id: spent }))).status, 200); // its response is lost
  legacyReviseEstimate(f, 'job-1', 900);
  const shown900 = (await portalView(handlers, cookie)).body.estimate;
  await mutateMoney(money, owner, { action: 'estimate.record_approval', requestId: randomUUID(), jobId: 'job-1', expectedRevision: f.revision('job-1'), approvedBy: 'Synthetic Customer' }, '2026-09-22T18:20:00.000Z');
  assert.deepEqual([f.job('job-1').customerApproval.requestId, f.job('job-1').customerApproval.source], [undefined, 'employee_recorded'], 'M3 replaces the approval, request id and all');
  assert.equal(sale(f, 'job-1').key, `portalRequest:${spent}`, 'the $800 sale is still live under that request');
  const writes = f.writes.length, rejected = f.rejected.length;
  const reused = await portalPost(handlers, cookie, approve(shown900, { request_id: spent }));
  assert.deepEqual([reused.status, reused.body.code], [409, 'CUSTOMER_PORTAL_IDEMPOTENCY_CONFLICT'], 'a second deal.sold under the same key is refused as a spent request, not as a changed estimate');
  assert.deepEqual([f.writes.length, f.rejected.length], [writes, rejected], 'nothing is committed');
  assert.deepEqual(ledgerOf(f.events(), 'job-1'), [['deal.sold', 80000]]);
  const signed = await portalPost(handlers, cookie, approve(shown900, { request_id: fresh }));
  assert.equal(signed.status, 200);
  assert.deepEqual([f.job('job-1').customerApproval.source, f.job('job-1').customerApproval.requestId], ['customer_portal', fresh]);
  assert.deepEqual(ledgerOf(f.events(), 'job-1'), [['deal.sold', 80000], ['deal.approval_superseded', 80000], ['deal.sold', 90000]]);
  assert.equal(netSold([...f.events(), ...money.events()]), 90000, 'net is the $900 contract');
  assert.deepEqual(money.events(), [], 'the staff approval writes no sale of its own');
});

test('a staff-recorded approval has no sale in the ledger: it is never superseded, and a portal signature records the sale', async t => {
  const staff = { status: 'approved', approvedAt: '2026-09-21T16:00:00.000Z', approvedBy: 'Synthetic Customer', amount: 800, source: 'employee_recorded', recordedBy: 'zacb', estimateRevision: 2 };
  const f = portalStore(t, { 'job-1': portalJob({ customerApproval: staff, estimate: { ...portalJob().estimate, status: 'accepted' } }), 'job-2': portalJob({ customerApproval: staff, estimate: { ...portalJob().estimate, status: 'accepted' } }) });
  const money = moneyStore(f), handlers = portalHandlers();
  assert.equal(sale(f, 'job-1'), null);
  const first = await portalCookie('job-1');
  assert.equal((await portalPost(handlers, first, approve((await portalView(handlers, first)).body.estimate))).status, 200);
  assert.deepEqual(f.events().map(item => [item.type, item.data.amountCents]), [['deal.sold', 80000]], 'the customer signature is the recorded sale');
  await revise(money, f, 90000, 'job-2');
  assert.equal(f.job('job-2').customerApproval.status, 'superseded');
  assert.deepEqual(money.events(), [], 'no sale was recorded, so none is retired');
  assert.equal(f.job('job-2').funnelSale, undefined);
  const second = await portalCookie('job-2');
  assert.equal((await portalPost(handlers, second, approve((await portalView(handlers, second)).body.estimate))).status, 200);
  assert.deepEqual(f.events().filter(item => item.jobId === 'job-2').map(item => [item.type, item.data.amountCents]), [['deal.sold', 90000]]);
});

// ---- The FUN-02 walkthrough handoff and the portal share the job's live sale ----

const ROSTER = [{ id: 'zacb', name: 'Owner', role: 'owner' }, { id: 'crew1', name: 'Crew One', role: 'crew' }];
// The dispatch store saveWalkthroughHandoff uses, over the portal fixture's jobs (revision = updateTime).
function handoffStore(f, seed) {
  const docs = new Map(Object.entries(seed).map(([key, value]) => [key, { ...structuredClone(value), id: key.split('/')[1], revision: `${key}-r0` }]));
  let n = 0;
  const job = id => f.rows.has(id) ? { ...f.job(id), id, revision: f.revision(id) } : null;
  const list = prefix => [...docs].filter(([key]) => key.startsWith(`${prefix}/`)).map(([, value]) => structuredClone(value));
  const store = {
    events: () => list('funnelEvents'), jobs: async () => [...f.rows.keys()].map(job), resources: async () => [], roster: async () => structuredClone(ROSTER), customers: async () => list('customers'),
    read: async (collection, id) => collection === 'jobs' ? job(id) : structuredClone(docs.get(`${collection}/${id}`) ?? null),
    async commit(writes) {
      for (const write of writes) { const current = await store.read(write.collection, write.id); if (write.revision ? current?.revision !== write.revision : current) throw Object.assign(new Error('Conflict'), { code: 'dispatch_revision_conflict', status: 409 }); }
      for (const write of writes.filter(item => !item.verify)) {
        if (write.collection === 'jobs') f.put(write.id, { ...(write.revision ? f.job(write.id) : {}), ...structuredClone(write.patch) });
        else docs.set(`${write.collection}/${write.id}`, { ...(write.revision ? docs.get(`${write.collection}/${write.id}`) : {}), ...structuredClone(write.patch), id: write.id, revision: `r${++n}` });
      }
    },
  };
  return store;
}
// The signed plan of tests/funnel-booking-events.test.mjs (FUN-02) at a given total.
const handoffPlan = total => ({ client: { name: 'Synthetic Customer', phone: '9705550100', email: 'test@example.invalid', address: '100 Fixture Lane', highlevel_contact_id: 'provider1' }, quote: { title: 'Garage reset', total, deposit: total / 2, job_date: '2026-09-24', start_time: '09:00', end_time: '12:00', estimated_duration_min: 180 }, acceptance: { accepted_at: '2026-09-22T17:45:00.000Z', accepted_by: 'Synthetic Customer', signature_captured: true, method: 'in_person_signature', terms_version: '2026-09-deposit50' }, signature: 'data:image/png;base64,iVBORw0KGgo=', terms_version: '2026-09-deposit50', terms_accepted: true, photos: { before: 3 }, scope: { keep_items: 'Blue bicycle', finish: ['shelving'], finish_details: { shelf_type: 'metal', shelf_qty: 2 } }, discovery: { success: 'Park a vehicle' }, logistics: { crew_size: 2, assigned_to: 'Crew of 2', notes: 'Use side gate' }, internal_notes: 'Keep blue bicycle.', notes: 'Call before arrival', client_checklists: { preJob: [{ id: 'keep-bike', label: 'Protect blue bicycle', detail: 'Move to safe area', critical: true }], postJob: [] } });

test('handoff and portal: a legacy revision between them never double-counts, and a re-signature after a handoff adds nothing', async t => {
  const f = portalStore(t, { w1: { type: 'walkthrough', status: 'scheduled', pipelineStatus: 'scheduled', customerId: 'c1', customer: 'Synthetic Customer', highlevelContactId: 'provider1', date: '2026-09-22', time: '11:00', endTime: '12:00', projectId: 'p1' } });
  const store = handoffStore(f, { 'customers/c1': { name: 'Synthetic Customer', phone: '9705550100', email: 'test@example.invalid', address: '100 Fixture Lane', highlevelContactId: 'provider1' }, 'projects/p1': { customerId: 'c1', sourceRecordId: 'w1', sourceWalkthroughId: 'w1' } });
  const handoff = (total, extra = {}) => saveWalkthroughHandoff(store, owner, { requestId: randomUUID(), customerId: 'c1', sourceWalkthroughId: 'w1', sourceRevision: f.revision('w1'), plan: handoffPlan(total), ...extra }, '2026-09-22T18:00:00.000Z');
  const ledger = () => [...store.events(), ...f.events()], net = () => netSold(ledger());
  const first = await handoff(800), id = first.job.id;
  assert.deepEqual([sale(f, id).cents, sale(f, id).eventId], [80000, store.events().find(item => item.type === 'deal.sold').id], 'the handoff saves the sale it records');
  const handlers = portalHandlers(), cookie = await portalCookie(id), view = async () => (await portalView(handlers, cookie)).body.estimate;
  // A tab re-signing the handoff's $800 is not a second sale.
  assert.equal((await portalPost(handlers, cookie, approve(await view()))).status, 200);
  assert.equal(net(), 80000);
  // Legacy revise to $900, the portal signs $900: the handoff sale is retired once.
  legacyReviseEstimate(f, id, 900);
  assert.equal((await portalPost(handlers, cookie, approve(await view()))).status, 200);
  assert.equal(net(), 90000);
  // Legacy revise to $1,000, then a revised handoff signs $1,400: the portal's live sale is retired (FUN-02 alone retired only an 'approved' approval).
  legacyReviseEstimate(f, id, 1000);
  assert.equal(f.job(id).customerApproval.status, 'superseded');
  await handoff(1400, { jobId: id, expectedRevision: f.revision(id) });
  assert.deepEqual(ledgerOf(store.events(), id).slice(-2), [['deal.approval_superseded', 90000], ['deal.sold', 140000]]);
  assert.equal(net(), 140000, 'net is the $1,400 signed contract, not $2,300');
  // The portal re-signs the handoff's $1,400: nothing is written.
  const count = ledger().length;
  assert.equal((await portalPost(handlers, cookie, approve(await view()))).status, 200);
  assert.deepEqual([ledger().length, net(), sale(f, id).cents], [count, 140000, 140000]);
});

test('a private record saves its portal changes without funnel events, and a refused event is a 503 that saves nothing', async t => {
  const decisions = [{ id: 'decision-1', title: 'Remove the cabinet?', priceDelta: 75, status: 'pending' }, { id: 'decision-2', title: 'Synthetic runaway price', priceDelta: 2000000, status: 'pending' }];
  const f = portalStore(t, { 'job-1': portalJob({ recordType: 'jobber_history', customerDecisions: decisions, status: 'completed', completedAt: '2026-09-15T18:00:00Z' }), 'job-2': portalJob({ customerDecisions: decisions }) });
  const handlers = portalHandlers(), cookie = await portalCookie();
  assert.equal((await portalPost(handlers, cookie, approve((await portalView(handlers, cookie)).body.estimate))).status, 200);
  assert.equal((await portalPost(handlers, cookie, { action: 'respond_decision', decision_id: 'decision-1', response: 'approved', responded_by: 'Synthetic Customer' })).status, 200);
  assert.equal((await portalPost(handlers, cookie, { action: 'request_rebook', kind: 'repeat', timing: 'asap' })).status, 200);
  assert.deepEqual([f.job('job-1').customerApproval.status, f.job('job-1').customerDecisions[0].status, f.job('job-1').rebookingRequests.length], ['approved', 'approved', 1]);
  assert.deepEqual(f.events(), [], 'private records never enter the funnel ledger');
  // A change order the ledger cannot hold ($2M) is refused as unavailable, not as "refresh".
  const other = await portalCookie('job-2');
  const refused = await portalPost(handlers, other, { action: 'respond_decision', decision_id: 'decision-2', response: 'approved', responded_by: 'Synthetic Customer' });
  assert.deepEqual([refused.status, refused.body.code], [503, 'CUSTOMER_PORTAL_STORAGE_UNAVAILABLE']);
  assert.equal(f.job('job-2').customerDecisions[1].status, 'pending');
  assert.deepEqual(f.events(), []);
});

test('a restored job: stale field times never show the customer a crew on the way, and a second start is not a second job.started', async t => {
  const actor = { user: 'Crew.One', displayName: 'Crew One', manager: false };
  let job = crewJob();
  const step = (input, now) => { const result = fieldCommand(job, actor, { requestId: randomUUID(), ...input }, now); job = { ...job, ...result.patch }; return result; };
  step({ action: 'status', status: 'dispatched' }, at(0)); step({ action: 'status', status: 'arrived' }, at(30));
  assert.equal(step({ action: 'status', status: 'in_progress' }, at(40)).funnel.milestone, 'started');
  // Dispatch cancels and restores the visit (schedule.cancel / schedule.restore keep the field times).
  const cancelled = { ...job, status: 'cancelled', pipelineStatus: 'cancelled', cancelledAt: at(60) };
  job = { ...cancelled, status: 'scheduled', pipelineStatus: 'scheduled', cancelledAt: null, restoredAt: at(24 * 60) };
  const restored = { ...job };
  assert.deepEqual(step({ action: 'status', status: 'dispatched' }, at(25 * 60)).funnel, { milestone: 'dispatched', fromStatus: 'scheduled', toStatus: 'dispatched' });
  step({ action: 'status', status: 'arrived' }, at(25 * 60 + 30));
  const again = step({ action: 'status', status: 'in_progress' }, at(25 * 60 + 40));
  assert.equal(again.funnel, null, 'the first start stays the job.started');
  assert.deepEqual([job.startedAt, job.dispatchedAt], [at(40), at(25 * 60)]);

  const portalJobs = { cancelled: { ...portalJob(), ...cancelled }, restored: { ...portalJob(), ...restored }, redispatched: { ...portalJob(), ...restored, status: 'dispatched', pipelineStatus: 'dispatched', dispatchedAt: at(25 * 60) }, legacy: { ...portalJob(), arrivedAt: at(30) } };
  for (const value of Object.values(portalJobs)) delete value.id;
  portalStore(t, portalJobs);
  const handlers = portalHandlers(at(25 * 60 + 5));
  const status = async id => (await portalView(handlers, await portalCookie(id, {}, Date.parse(at(25 * 60))))).body.appointment.status;
  assert.equal(await status('cancelled'), 'scheduled', 'a cancelled visit is never shown as in progress');
  assert.equal(await status('restored'), 'scheduled', 'times from before the restore belong to the earlier attempt');
  assert.equal(await status('redispatched'), 'dispatched');
  assert.equal(await status('legacy'), 'arrived', 'a field time with no restore still counts (P4-01)');
});

test('the portal page names decision answers and rebooking requests, and resends the same request_id on a retry', async () => {
  const html = readFileSync(new URL('../customer-portal.html', import.meta.url), 'utf8'), dom = fakeDom(), calls = [];
  let failures = 1;
  const form = dom.node('rebook-form'); form.reset = () => {};
  for (const [id, value] of [['rebook-timing', 'asap'], ['rebook-date', ''], ['rebook-notes', 'Same setup']]) dom.node(id).value = value;
  // CHANGE-ORDERS: respondDecision takes the decision item and keeps its request_id per viewer, job, decision and answer in sessionStorage.
  const stored = new Map();
  const context = { $: dom.node, crypto: globalThis.crypto, setText: () => {}, toast: () => {}, load: async () => {}, money: value => `$${value}`, portalData: { viewer: { jobKey: 'synthetic-job-key' } }, sessionStorage: { getItem: key => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, value), removeItem: key => stored.delete(key) }, document: { querySelector: () => ({ value: 'touch_up' }) },
    api: async body => { calls.push(body); if (conflicts) { conflicts -= 1; throw Object.assign(new Error('Synthetic changed details'), { code: 'CUSTOMER_PORTAL_IDEMPOTENCY_CONFLICT' }); } if (failures) { failures -= 1; throw new Error('Synthetic network failure'); } return { ok: true }; } };
  let conflicts = 0;
  vm.runInNewContext(portalScript(html, ['function reviewRequestId(', 'function decisionKey(', 'async function respondDecision(', 'function newRebookRequest(', "$('rebook-form').addEventListener('input',", "$('rebook-form').addEventListener('change',", "$('rebook-form').addEventListener('submit',"]), context);
  const answer = { disabled: false, textContent: 'Approve', dataset: {} }, name = { value: 'Synthetic Customer' }, note = { value: '' };
  await context.respondDecision({ id: 'decision-1', priceDelta: 75 }, 'approved', name, note, answer);
  await context.respondDecision({ id: 'decision-1', priceDelta: 75 }, 'approved', name, note, answer);
  assert.deepEqual(calls.map(body => [body.action, body.decision_id, body.request_id]), [['respond_decision', 'decision-1', calls[0].request_id], ['respond_decision', 'decision-1', calls[0].request_id]]);
  assert.match(calls[0].request_id, UUID);
  failures = 1;
  const submit = () => form.listeners.submit({ preventDefault() {}, submitter: { disabled: false }, target: form });
  await submit(); await submit(); await submit();
  const rebooks = calls.slice(2);
  assert.deepEqual(rebooks.map(body => body.action), ['request_rebook', 'request_rebook', 'request_rebook']);
  assert.equal(rebooks[1].request_id, rebooks[0].request_id, 'a retry resends the same request');
  assert.notEqual(rebooks[2].request_id, rebooks[1].request_id, 'a saved request is not reused for the next one');
  assert.match(rebooks[2].request_id, UUID);
  // A failed send keeps its request, but editing the form (or a changed-details conflict) starts a new one.
  failures = 1;
  await submit(); form.listeners.input(); await submit();
  failures = 1;
  await submit(); form.listeners.change(); await submit();
  conflicts = 1;
  await submit(); await submit();
  const edited = calls.slice(5).map(body => body.request_id);
  assert.equal(new Set(edited).size, 6, 'every send after an edit or a conflict is a new request');
});
