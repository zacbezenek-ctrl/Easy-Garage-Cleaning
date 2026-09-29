import test from 'node:test';
import assert from 'node:assert/strict';
import { createHubSessionCookie } from '../functions/_lib/hub-session.js';
import { fieldChecklist } from '../functions/_lib/field-execution.js';
import * as route from '../functions/api/field-jobs.js';
import { storage } from './helpers/field-fixture.mjs';

// FUN-20 end to end: the crew completes a member visit through /api/field-jobs
// (Firestore REST emulated) and the membership is counted after the completion commit.
const NOW = Date.parse('2026-10-05T18:00:00.000Z');
const env = { HUB_SESSION_SECRET: 'garage-guard-field-session-secret', FIREBASE_API_KEY: 'firebase-test-garage-guard-field', HUB_AUTH_USERS_JSON: JSON.stringify({ 'Crew.One': { passwordHash: 'test', role: 'crew', displayName: 'Crew One' } }) };

function seed(store) {
  const job = { id: 'job-1', type: 'job', customerId: 'cust-dana', customerAccountOwnerJobId: 'job-root', customer: 'Synthetic Dana', address: '1 Synthetic Way', date: '2026-10-05', time: '08:00', endTime: '11:00', assignedCrew: ['Crew.One'], crewLead: 'Crew.One', status: 'in_progress', pipelineStatus: 'in_progress', startedAt: '2026-10-05T14:00:00.000Z', membershipId: 'sub_member_1', visitPurpose: 'member_visit' };
  job.fieldExecution = { checks: Object.fromEntries(fieldChecklist(job).map(item => [item.id, { completed: true, actorId: 'Crew.One' }])), photos: ['before', 'after'].map(category => ({ id: crypto.randomUUID(), fileId: `file-${category}`, category, verified: true })) };
  store.put('jobs/job-1', job);
  store.put('jobs/job-root', { type: 'job', customerId: 'cust-dana', customer: 'Synthetic Dana', status: 'paid', garageGuard: { plan: 'guard', status: 'active', visitsIncluded: 4, visitsRemaining: 4, membershipId: 'sub_member_1', source: 'stripe', updatedBy: 'stripe_webhook', updatedAt: '2026-09-22T12:00:00.000Z', nextVisit: '2026-10-05' } });
  store.put('memberships/sub_member_1', { subscriptionId: 'sub_member_1', plan: 'guard', status: 'active', visitsIncluded: 4, visitsRemaining: 4, link: { status: 'linked', customerId: 'cust-dana', accountJobId: 'job-root', mirroredAt: '2026-09-22T12:00:00.000Z' },
    periods: [{ id: 'in_guard_first', status: 'open', paidSource: 'invoice', paidCents: 80000, visitsIncluded: 4, visitsUsed: 0, recognizedCents: 0, visits: [], adjustments: [], periodStart: '2026-09-22T12:00:00.000Z', periodEnd: '2027-09-22T12:00:00.000Z' }] });
}

async function complete(t, environment) {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const store = storage(t); seed(store);
  const cookie = (await createHubSessionCookie(environment, 'Crew.One')).split(';')[0], background = [];
  const request = new Request('https://easygaragecleaning.com/api/field-jobs', { method: 'POST', headers: { Cookie: cookie, Origin: 'https://easygaragecleaning.com', 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'complete', jobId: 'job-1', requestId: crypto.randomUUID(), expectedRevision: store.revision('job-1'), notes: 'Garage swept, re-tidied and hauled.', hasIssues: false }) });
  const response = await route.onRequestPost({ env: environment, request, waitUntil: promise => background.push(promise) });
  assert.equal(response.status, 200);
  await Promise.all(background);
  return store;
}

test('with visit tracking on, completing a member visit counts it once against the membership', async t => {
  const store = await complete(t, { ...env, GARAGE_GUARD_VISIT_TRACKING_ENABLED: 'true' });
  const job = store.get('jobs/job-1'), membership = store.get('memberships/sub_member_1');
  assert.deepEqual([job.status, job.completedAt, job.membershipVisit.status, job.membershipVisit.occurrence, job.membershipVisit.via, job.membershipVisit.appliedBy], ['completed', '2026-10-05T18:00:00.000Z', 'applied', 1, 'field', 'crew.one']);
  assert.equal('allocatedCents' in job.membershipVisit, false, 'the member visit revenue is kept only in the server-only membership ledger');
  assert.deepEqual([membership.visitsRemaining, membership.periods[0].visitsUsed, membership.periods[0].recognizedCents, membership.periods[0].visits[0].allocatedCents], [3, 1, 20000, 20000]);
  assert.deepEqual([store.get('jobs/job-root').garageGuard.visitsRemaining, store.get('jobs/job-root').garageGuard.nextVisit], [3, '2026-10-05']);
  const events = [...store.documents.keys()].filter(path => path.startsWith('funnelEvents/')).map(path => store.get(path));
  // FUN-03 commits job.completed with the completion itself; the member visit is counted once after it.
  assert.deepEqual(events.map(event => [event.type, event.jobId, event.membershipId, event.occurredAt, event.via]), [['job.completed', 'job-1', null, '2026-10-05T18:00:00.000Z', 'field'], ['membership.visit_used', 'job-1', 'sub_member_1', '2026-10-05T18:00:00.000Z', 'field']]);
  const detail = await (await route.onRequestGet({ env, request: new Request('https://easygaragecleaning.com/api/field-jobs?jobId=job-1', { headers: { Cookie: (await createHubSessionCookie(env, 'Crew.One')).split(';')[0] } }) })).json();
  assert.equal(JSON.stringify(detail).includes('allocatedCents'), false, 'crew never see member revenue');
  assert.equal(JSON.stringify(detail).includes('membershipVisit'), false);
});

test('with visit tracking off, the completion keeps a pending member visit and the membership is untouched', async t => {
  const store = await complete(t, env);
  assert.deepEqual(store.get('jobs/job-1').membershipVisit.status, 'pending');
  assert.equal(store.get('memberships/sub_member_1').visitsRemaining, 4);
  assert.equal(store.get('jobs/job-root').garageGuard.visitsRemaining, 4);
  // Only FUN-03's job.completed from the completion commit: no membership event.
  assert.deepEqual([...store.documents.keys()].filter(path => path.startsWith('funnelEvents/')).map(path => store.get(path).type), ['job.completed']);
});
