import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { can, staffCapabilities, capabilityMatrix } from '../functions/_lib/staff-roles.js';
import { canDispatch } from '../functions/_lib/dispatch-permissions.js';
import { createHubSessionCookie, hasBusinessAccess } from '../functions/_lib/hub-session.js';
import { fieldCapabilities } from '../functions/_lib/field-permissions.js';
import { fieldChecklist } from '../functions/_lib/field-execution.js';
import { requireSignoffManager, signoffCommand } from '../functions/_lib/job-signoff.js';
import { jobOperationsHandlers } from '../functions/api/job-operations.js';
import { onRequestGet as fieldGet, onRequestPost as fieldPost } from '../functions/api/field-jobs.js';
import { fieldPaymentHandlers } from '../functions/api/field-payments.js';
import { fieldExpenseHandlers } from '../functions/api/field-expenses.js';
import { fieldPhotoSharingHandlers } from '../functions/api/field-photo-sharing.js';
import { mutateJobOperation, projectOperationalResult } from '../functions/_lib/job-operations.js';
import { memoryStore } from './helpers/auth-roles-harness.mjs';
import { storage } from './helpers/field-fixture.mjs';

const NOW = '2026-09-22T18:00:00.000Z', ORIGIN = 'https://easygaragecleaning.com';
const lead = { user: 'Team.Lead', role: 'crew', businessAccess: false, staffRoles: ['team_lead'], displayName: 'Synthetic Team Lead' };
const ON = { EGC_TEAM_LEAD_JOB_OPERATIONS: 'true' };
const create = changes => ({ action: 'schedule.create', requestId: randomUUID(), expectedUser: lead.user, customerId: 'c1', kind: 'job', sourceJobId: 'job-crewed', changes: { date: '2026-09-26', time: '09:00', endTime: '11:00', assignedCrew: ['crew.one'], ...changes } });
const edit = (job, changes = {}, action = 'schedule.update') => ({ action, requestId: randomUUID(), expectedUser: lead.user, jobId: job.id, expectedRevision: job.revision, changes });
const mutate = (store, input, actor = lead, env = ON) => mutateJobOperation(store, actor, input, NOW, env);
const req = (query = '', body, headers = {}) => new Request(`${ORIGIN}/api/job-operations${query}`, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', Origin: ORIGIN, ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) });

test('only exact role-access true grants scoped operations, never broader capabilities', () => {
  for (const flag of [undefined, 'false', 'TRUE', '1', true, 'true']) {
    const env = { EGC_TEAM_LEAD_JOB_OPERATIONS: flag, EGC_STAFF_ROLE_PERMISSIONS: 'true' };
    for (const role of ['crew', 'crew_lead', 'sales', 'phone', 'team_lead']) {
      const actor = { ...lead, staffRoles: [role] };
      assert.equal(can(actor, 'jobs.operate', env), role === 'team_lead' && flag === 'true');
    }
  }
  assert.deepEqual(staffCapabilities(lead, ON), ['jobs.operate']);
  assert.equal(can(lead, 'jobs.operate', { EGC_STAFF_ROLE_ACCESS: 'true' }), false, 'the broad switch does not activate this capability');
  assert.deepEqual(capabilityMatrix(ON).team_lead, ['jobs.operate']);
  assert.deepEqual(capabilityMatrix(ON).sales, ['customer.send', 'followups.own', 'quotes.author']);
  assert.equal(can(lead, 'jobs.operate', { ...ON, EGC_STAFF_ROLE_ACCESS: 'false', EGC_STAFF_ROLE_PERMISSIONS: 'false' }), true, 'the narrow switch works without broader role/access flags');
  assert.equal(hasBusinessAccess(lead), false);
  assert.equal(canDispatch(lead, ON), false);
  for (const cap of ['dispatch.write', 'schedule.book', 'quotes.author', 'pay.manage', 'accounts.approve', 'money.refund', 'money.charge_stored_card', 'customer.send', 'settings.manage', 'catalog.manage', 'mcp.write']) assert.equal(can(lead, cap, ON), false, cap);
  assert.throws(() => requireSignoffManager(lead, ON), error => error.code === 'job_signoff_forbidden');
  assert.throws(() => signoffCommand({ type: 'job', status: 'completed', completedAt: NOW, assignedCrew: [lead.user] }, lead, { action: 'sign_off', requestId: randomUUID() }, NOW), error => error.code === 'job_signoff_self');
});

test('dedicated projection strips structured financial fields, raw notes and money in operational strings', () => {
  const result = projectOperationalResult({ ok: true, job: { id: 'j', type: 'job', title: 'Work ($999)', jobInstructions: 'Shelving (+$123)', accessInstructions: 'Gate 1234', notes: 'Payment 6789', opsNotes: 'Salary 4567', total: 4567, payment: { amount: 999 }, materials: [{ name: 'Shelf', cost: 345 }], requiredSkills: [{ price: 4567 }, 'safe'], moneyReady: { depositDueCents: 888 }, assignmentSegments: [{ id: 's', date: '2026-09-22', notes: 'Price 4567', total: 4567 }] }, roster: [{ id: 'worker', name: 'Worker', hourlyRate: 7777, email: 'secret@example.invalid' }], warnings: [{ code: 'needs_follow_up', message: 'Pay $333', depositDueCents: 444 }] });
  const text = JSON.stringify(result);
  for (const forbidden of ['999', '123)', '6789', '4567', '345', '888', '7777', 'secret@example', 'depositDueCents', 'opsNotes', 'materials', 'moneyReady']) assert.equal(text.includes(forbidden), false, forbidden);
  assert.equal(result.job.accessInstructions, 'Gate 1234');
  assert.equal(result.job.jobInstructions, 'Shelving');
  assert.deepEqual(result.job.requiredSkills, ['safe']);
});

test('create, assign across crews, edit, schedule and cancel retain original financial and execution records', async () => {
  const store = memoryStore();
  const result = await mutate(store, create());
  const stored = store.rows.get(`jobs/${result.job.id}`);
  stored.payment = { cents: 87654 }; stored.estimate = { amount: 98765 }; stored.timecards = ['existing']; stored.fieldExecution = { checks: { safety: { completed: true } } };
  const saved = await mutate(store, edit(result.job, { assignedCrew: ['zacb'], crewLead: 'zacb', date: '2026-09-27', title: 'New scope', jobInstructions: 'Protect the shelving' }));
  assert.deepEqual(saved.job.assignedCrew, ['zacb']); assert.equal(saved.job.date, '2026-09-27');
  const raw = store.rows.get(`jobs/${result.job.id}`);
  assert.deepEqual(raw.payment, { cents: 87654 }); assert.deepEqual(raw.estimate, { amount: 98765 });
  assert.deepEqual(raw.timecards, ['existing']); assert.deepEqual(raw.fieldExecution, { checks: { safety: { completed: true } } });
  const cancelled = await mutate(store, { ...edit(saved.job, {}, 'schedule.cancel'), cancellationReason: 'Customer rescheduled later' });
  assert.equal(cancelled.job.status, 'cancelled'); assert.ok(store.rows.has(`jobs/${result.job.id}`));
});

test('unapproved actions, targets, fields, sources and account changes fail before commit', async () => {
  for (const action of ['schedule.restore', 'schedule.no_show', 'crew.save', 'vehicle.save', 'availability.save', 'crew.seed_defaults', 'delete', 'complete', 'sign_off', 'customer.send']) {
    const store = memoryStore(), before = JSON.stringify([...store.rows]);
    await assert.rejects(mutate(store, { ...edit({ id: 'job-crewed', revision: 'jr1' }), action }), error => error.status === 403);
    assert.equal(JSON.stringify([...store.rows]), before);
  }
  for (const field of ['notify', 'recurrence', 'reminderDays', 'shiftPickupEnabled', 'total', 'price', 'payment', 'hourlyRate', 'supervisorSignoff', 'notes', 'opsNotes', 'materials']) await assert.rejects(mutate(memoryStore(), create({ [field]: true })), error => error.status === 403);
  for (const input of [{ ...create(), kind: 'walkthrough' }, { ...create(), kind: 'blocked' }, { ...create(), sourceTemplateJobId: 'job-crewed' }, { ...create(), sourceWalkthroughId: 'walk-1' }, { ...create(), sourceJobId: 'walk-1' }, edit({ id: 'walk-1', revision: 'wr1' }), { ...create(), expectedUser: 'Other.User' }]) await assert.rejects(mutate(memoryStore(), input), error => [401, 403].includes(error.status));
  await assert.rejects(mutate(memoryStore(), create(), { ...lead, staffRoles: ['crew'] }), error => error.status === 403);
  await assert.rejects(mutate(memoryStore(), create(), lead, {}), error => error.status === 403);
});

test('revision conflicts, duplicate requests, changed retries and revoked roles stay fenced', async () => {
  const store = memoryStore(), input = create(), one = await mutate(store, input);
  assert.equal((await mutate(store, input)).replayed, true);
  await assert.rejects(mutate(store, { ...input, changes: { ...input.changes, title: 'Different' } }), error => error.code === 'dispatch_idempotency_conflict');
  const changed = await mutate(store, edit(one.job, { time: '12:00', endTime: '14:00' }));
  await assert.rejects(mutate(store, edit(one.job, { title: 'Stale' })), error => error.code === 'dispatch_revision_conflict');
  await assert.rejects(mutate(store, input), error => error.code === 'dispatch_changed_since_operation');
  await assert.rejects(mutate(store, edit(changed.job), { ...lead, staffRoles: [] }), error => error.status === 403);
  const race = memoryStore(), identical = create();
  const outcomes = await Promise.allSettled([mutate(race, identical), mutate(race, identical)]);
  assert.ok(outcomes.some(result => result.status === 'fulfilled'));
  assert.equal([...race.rows.values()].filter(row => row.dispatchRequestId === identical.requestId && row.type === 'job').length, 1);
});

test('existing overlap and multi-day safeguards still reject unsafe assignments', async () => {
  const store = memoryStore();
  await mutate(store, create());
  await assert.rejects(mutate(store, create({ time: '10:00', endTime: '12:00' })), error => error.code === 'dispatch_conflict');
  await assert.rejects(mutate(memoryStore(), create({ endDate: '2026-09-25' })), error => error.status === 400);
  await assert.rejects(mutate(memoryStore(), create({ assignmentSegments: [{ id: 'a', date: '2026-09-26', time: '09:00', endTime: '11:00', assignedCrew: ['crew.one'], payment: 1 }] })), error => error.status === 403);
});

test('operational scheduling queues no customer messages even with existing CRM flags enabled', async () => {
  const store = memoryStore(); store.ghlTagOutbox = true; store.ghlScheduleMirror = true; store.notifyImportedOn = true;
  await mutate(store, create());
  assert.equal(store.ghlTagOutbox, true, 'the existing store flags are unchanged');
  assert.equal([...store.rows.keys()].some(key => key.startsWith('ghlTagOutbox/') || key.startsWith('ghlScheduleMirror/')), false);
});

test('split jobs keep segment validation, all-day locks and non-retroactive crew snapshots', async () => {
  const store = memoryStore(); store.segmentsEnabled = true;
  const segment = (id, date, assignedCrew) => ({ id, date, time: '09:00', endTime: '11:00', assignedCrew });
  const input = { ...create(), changes: { assignmentSegments: [segment('first', '2026-09-26', ['crew.one']), segment('second', '2026-09-27', ['zacb'])] } };
  const made = await mutate(store, input);
  assert.equal(made.job.assignmentSegments.length, 2);
  assert.ok(store.rows.get('jobs/_egc_schedule_lock_2026-09-26'));
  assert.ok(store.rows.get('jobs/_egc_schedule_lock_2026-09-27'));
  store.rows.get(`jobs/${made.job.id}`).assignmentSegments[0].notes = 'Private price $9876';
  const edited = await mutate(store, edit(made.job, { assignmentSegments: [segment('first', '2026-09-26', ['zacb']), segment('second', '2026-09-27', ['crew.one'])] }));
  assert.deepEqual(edited.job.assignmentSegments[0].assignedCrew, ['zacb']);
  assert.equal(store.rows.get(`jobs/${made.job.id}`).assignmentSegments[0].notes, 'Private price $9876');
  assert.doesNotMatch(JSON.stringify(edited), /9876|Private price/);
  assert.deepEqual(store.rows.get('jobs/job-crewed').assignedCrew, ['crew.one'], 'another job snapshot stays unchanged');
  await assert.rejects(mutate(store, edit(edited.job, { assignmentSegments: [segment('same', '2026-09-26', ['zacb']), segment('overlap', '2026-09-26', ['zacb'])] })), error => error.status === 409);
});

test('scoped HTTP reads include customer lookup, all-crew board, search, openings and travel only', async () => {
  const store = memoryStore(), route = jobOperationsHandlers({ session: async () => lead, storage: () => store, now: () => new Date(NOW) });
  for (const query of ['?includeUnscheduled=true', '?view=customers&q=Synthetic', '?view=job&jobId=job-crewed', '?view=search&q=Synthetic', '?view=openings&startDate=2026-09-26&endDate=2026-09-27&employeeIds=crew.one', '?view=travel&date=2026-09-25']) {
    const response = await route.get({ request: req(query), env: ON });
    assert.equal(response.status, 200, `${query}: ${await response.clone().text()}`);
    assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
    assert.doesNotMatch(await response.text(), /"(?:estimate|payment|moneyReady|hourlyRate|opsNotes|notes)"/);
  }
  for (const query of ['?view=job&jobId=walk-1', '?view=resources', '?view=customers&collection=payments', '?view=openings&kind=walkthrough', '?view=board&startDate=2026-09-22&startDate=2026-09-23']) assert.ok((await route.get({ request: req(query), env: ON })).status >= 400);
  assert.equal((await route.get({ request: req(), env: {} })).status, 403);
  assert.equal((await route.post({ request: req('', create(), { Origin: 'https://other.invalid' }), env: ON })).status, 403);
  assert.equal((await route.post({ request: req('', create()), env: ON })).status, 200);
});

const fieldEnv = { ...ON, HUB_SESSION_SECRET: 'synthetic-team-lead-test-session', FIREBASE_API_KEY: 'firebase-test-team-lead', GOOGLE_CLIENT_ID: 'test', GOOGLE_CLIENT_SECRET: 'test', GOOGLE_REFRESH_TOKEN: 'test', HUB_AUTH_USERS_JSON: JSON.stringify({ 'Team.Lead': { passwordHash: 'test', role: 'crew', staffRoles: ['team_lead'], displayName: 'Synthetic Team Lead' }, 'Crew.One': { passwordHash: 'test', role: 'crew' } }) };
function preparedJob() {
  const job = { id: 'job-1', type: 'job', status: 'in_progress', pipelineStatus: 'in_progress', assignedCrew: ['Crew.One'], crewLead: 'Crew.One', date: '2026-09-22', endDate: '2026-09-22', time: '09:00', endTime: '11:00', customer: 'Synthetic Customer', payment: { amount: 98765 }, employeeTime: { sentinel: true } };
  job.fieldExecution = { checks: Object.fromEntries(fieldChecklist(job).map(item => [item.id, { completed: true }])), photos: ['before', 'after'].map(category => ({ id: randomUUID(), fileId: category, category, verified: true })) };
  return job;
}
async function fieldRequest(env, query = '', input) {
  const cookie = (await createHubSessionCookie(env, lead.user)).split(';')[0];
  return new Request(`${ORIGIN}/api/field-jobs${query}`, { method: input ? 'POST' : 'GET', headers: { Cookie: cookie, 'Content-Type': 'application/json', Origin: ORIGIN }, ...(input ? { body: JSON.stringify(input) } : {}) });
}

test('all-crew completion retains safety checks, exact receipts and unrelated payroll; no send or sign-off power', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(NOW) });
  const store = storage(t); store.put('jobs/job-1', preparedJob());
  const input = { action: 'complete', jobId: 'job-1', requestId: randomUUID(), expectedUser: lead.user, expectedRevision: store.revision('job-1'), hasIssues: false, notes: 'Completed the garage cleanout safely.' };
  const read = await fieldGet({ env: fieldEnv, request: await fieldRequest(fieldEnv, '?jobId=job-1') });
  assert.equal(read.status, 200, await read.clone().text()); const view = await read.json();
  assert.deepEqual(view.features, { jobCosts: false, fieldPay: false, fieldPayReview: false });
  assert.equal(view.job.capabilities.complete, true); assert.equal(view.job.capabilities.assigned, false);
  for (const key of ['sendOnMyWay', 'sharePhotos', 'configureChecklist']) assert.equal(view.job.capabilities[key], false);
  assert.doesNotMatch(JSON.stringify(view), /98765|employeeTime|payment/);
  for (const action of ['photo', 'note', 'status', 'configure_checklist', 'retry_completion_sync', 'resolve_issue', 'end_day']) assert.equal((await fieldPost({ env: fieldEnv, request: await fieldRequest(fieldEnv, '', { ...input, action }) })).status, 403, action);
  assert.equal((await fieldPost({ env: { ...fieldEnv, EGC_TEAM_LEAD_JOB_OPERATIONS: 'false' }, request: await fieldRequest(fieldEnv, '', input) })).status, 403);
  assert.equal((await fieldPost({ env: fieldEnv, request: await fieldRequest(fieldEnv, '', { ...input, expectedRevision: 'old' }) })).status, 409);
  const background = [];
  const first = await fieldPost({ env: { ...fieldEnv, EGC_GHL_TAG_OUTBOX: 'true', EGC_GHL_FIELD_COMPLETION_TAG: 'true' }, waitUntil: promise => background.push(promise), request: await fieldRequest(fieldEnv, '', input) });
  assert.equal(first.status, 200, await first.clone().text());
  assert.equal(store.get('jobs/job-1').status, 'completed');
  assert.deepEqual(store.get('jobs/job-1').employeeTime, { sentinel: true });
  assert.deepEqual(store.get('jobs/job-1').payment, { amount: 98765 });
  assert.equal(store.get('jobs/job-1').supervisorSignoff, undefined);
  assert.equal(store.get('jobs/job-1').fieldCompletionSync, undefined);
  assert.equal(background.length, 0, 'no new CRM send or completion-tag drain is scheduled');
  assert.equal((await (await fieldPost({ env: fieldEnv, request: await fieldRequest(fieldEnv, '', input) })).json()).alreadyApplied, true);
  assert.equal((await fieldPost({ env: fieldEnv, request: await fieldRequest(fieldEnv, '', { ...input, notes: 'Changed retry' }) })).status, 409);
});

test('missing safety evidence and early multi-day completion remain denied across crews', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(NOW) });
  const store = storage(t), job = preparedJob(); job.fieldExecution.photos = []; store.put('jobs/job-1', job);
  const input = () => ({ action: 'complete', jobId: 'job-1', requestId: randomUUID(), expectedUser: lead.user, expectedRevision: store.revision('job-1'), hasIssues: false, notes: 'Completed safely with all work done.' });
  assert.equal((await fieldPost({ env: fieldEnv, request: await fieldRequest(fieldEnv, '', input()) })).status, 409);
  store.put('jobs/job-1', { ...preparedJob(), endDate: '2026-09-24' });
  const response = await fieldPost({ env: { ...fieldEnv, FIELD_MULTIDAY_VISITS: 'true' }, request: await fieldRequest(fieldEnv, '', input()) });
  assert.equal(response.status, 409, await response.clone().text());
  assert.equal(store.get('jobs/job-1').status, 'in_progress');
});

test('payment, expense and publication APIs still refuse an unrelated job for a Team Lead', async () => {
  const job = preparedJob(), env = { ...fieldEnv, FIELD_EXPENSES_ENABLED: 'true', FIELD_CUSTOMER_PHOTOS_ENABLED: 'true' };
  const payments = fieldPaymentHandlers({ session: async () => lead, storage: () => ({ read: async () => job }), now: () => new Date(NOW) });
  const costs = fieldExpenseHandlers({ session: async () => lead, storage: () => ({ readJob: async () => job }), now: () => new Date(NOW) });
  const photos = fieldPhotoSharingHandlers({ session: async () => lead });
  const payment = await payments.get({ request: req('?job_id=job-1'), env });
  assert.equal(payment.status, 403); assert.equal((await payment.json()).code, 'FIELD_PAY_LEAD_REQUIRED');
  assert.equal((await costs.get({ request: req('?jobId=job-1'), env })).status, 403);
  assert.equal((await photos.get({ request: req('?jobId=job-1'), env })).status, 403);
  const unrelated = await fieldCapabilities({ session: lead, job, env, access: { assigned: async () => false, matches: async () => false } });
  assert.equal(unrelated.assigned, false); assert.equal(unrelated.lead, false);
  const ownJob = await fieldCapabilities({ session: lead, job: { ...job, crewLead: lead.user }, env, access: { assigned: async () => true, matches: async () => true } });
  assert.equal(ownJob.assigned, true); assert.equal(ownJob.lead, true, 'the named, assigned lead exception remains intact');
});
