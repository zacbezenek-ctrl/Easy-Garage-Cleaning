import test from 'node:test';
import assert from 'node:assert/strict';
import { createHubSessionCookie } from '../functions/_lib/hub-session.js';
import { storage } from './helpers/field-fixture.mjs';
import { fieldCancelled, fieldCommand, fieldJobProjection } from '../functions/_lib/field-execution.js';
import { advanceFieldTime, fieldJobTime } from '../functions/_lib/field-execution-time.js';
import { requireFieldExpenseCloseout } from '../functions/_lib/field-expenses.js';
import { dueMessages } from '../functions/_lib/messaging-scheduler.js';
import { normalizeMessagingSettings } from '../functions/_lib/messaging-settings.js';
import { job as messagingJob, NOW as MESSAGING_NOW } from './helpers/messaging-fixture.mjs';
import * as route from '../functions/api/field-jobs.js';

// FUN-02: dispatch can now mark a customer job no_show. Every reader that treats a
// cancelled job as closed treats a no-show the same way. Synthetic data, fixed clocks.
const NO_SHOW = ['no_show', 'noshow', 'no-show'];
const at = time => `2026-09-22T${time}:00.000Z`;
const actor = { user: 'Crew.One', displayName: 'Crew One', manager: false };
const baseline = (extra = {}) => ({ id: 'job-1', type: 'job', customer: 'Synthetic Customer', address: '100 Synthetic Lane', phone: '9705550100', date: '2026-09-22', time: '08:00', endTime: '11:00', assignedCrew: ['Crew.One'], crewLead: 'Crew.One', status: 'scheduled', pipelineStatus: 'scheduled', ...extra });
const noShow = (status = 'no_show', extra = {}) => baseline({ status, pipelineStatus: status, noShowAt: at('15:30'), noShowBy: 'zacb', noShowReasonCode: 'customer_not_home', ...extra });

test('the crew record of a no-show job is closed like a cancelled one: no checklist, material or status changes, notes still allowed', () => {
  for (const status of NO_SHOW) {
    const job = noShow(status);
    assert.equal(fieldCancelled(job), true, status);
    for (const input of [{ action: 'checklist', itemId: 'departure-address', completed: true }, { action: 'material', materialId: 'm1', status: 'used' }, { action: 'status', status: 'dispatched' }])
      assert.throws(() => fieldCommand(job, actor, { requestId: crypto.randomUUID(), ...input }, at('16:00')), error => error.code === 'FIELD_JOB_CLOSED', `${status} ${input.action}`);
    assert.equal(fieldCommand(job, actor, { requestId: crypto.randomUUID(), action: 'note', body: 'Synthetic gate was locked.' }, at('16:00')).event.body, 'Synthetic gate was locked.');
    const view = fieldJobProjection(job, [], { now: at('16:00') });
    assert.deepEqual([view.canEdit, view.allowedStatuses, view.completionMissing], [false, [], []], status);
  }
  assert.equal(fieldCancelled(baseline()), false);
});

test('a running job clock stops at the no-show time instead of running on', () => {
  let job = baseline();
  const clock = advanceFieldTime(job, 'dispatched', actor, 'status', at('14:00')).clock;
  job = { ...job, status: 'dispatched', pipelineStatus: 'dispatched', fieldExecution: { activity: 'dispatched', jobTime: clock } };
  assert.equal(fieldJobTime(job, at('15:00')).runningKind, 'travel');
  const stopped = fieldJobTime({ ...job, status: 'no_show', pipelineStatus: 'no_show', noShowAt: at('15:30') }, at('20:00'));
  assert.deepEqual([stopped.runningKind, stopped.travelMs, stopped.needsReview], [null, 90 * 60000, true]);
});

test('the crew day lists a no-show job under all, never under active, and refuses new photos on it', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(at('16:00')) });
  const env = { HUB_SESSION_SECRET: 'synthetic-no-show-session-secret', FIREBASE_API_KEY: 'firebase-test-no-show', HUB_AUTH_USERS_JSON: JSON.stringify({ 'Crew.One': { passwordHash: 'test', role: 'crew', displayName: 'Crew One' } }), GOOGLE_CLIENT_ID: 'test', GOOGLE_CLIENT_SECRET: 'test', GOOGLE_REFRESH_TOKEN: 'test' };
  const cookie = (await createHubSessionCookie(env, 'Crew.One')).split(';')[0];
  const request = (search, body) => new Request(`https://easygaragecleaning.com/api/field-jobs${search}`, { method: body ? 'POST' : 'GET', headers: { Cookie: cookie, Origin: 'https://easygaragecleaning.com', 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const store = storage(t);
  store.put('jobs/job-1', noShow());
  store.put('jobs/job-2', baseline({ id: 'job-2', time: '12:00', endTime: '14:00' }));
  store.put('jobs/job-3', baseline({ id: 'job-3', time: '15:00', endTime: '16:00', status: 'cancelled', pipelineStatus: 'cancelled' }));
  const list = async status => (await (await route.onRequestGet({ env, request: request(`?date=2026-09-22&status=${status}`) })).json()).jobs.map(job => job.id);
  assert.deepEqual(await list('active'), ['job-2']);
  assert.deepEqual(await list('all'), ['job-1', 'job-2', 'job-3']);
  const picture = `data:image/jpeg;base64,${Buffer.from([255, 216, 255, 224, 0, 16, 74, 70, 73, 70, 0, 1, 255, 217]).toString('base64')}`;
  const photo = await route.onRequestPost({ env, request: request('', { action: 'photo', jobId: 'job-1', requestId: crypto.randomUUID(), expectedRevision: store.revision('job-1'), category: 'after', caption: '', dataUrl: picture }) });
  const body = await photo.json();
  assert.deepEqual([photo.status, body.code, body.error], [409, 'FIELD_JOB_CLOSED', 'This job was marked a no-show. Ask operations before adding evidence.']);
  assert.deepEqual([store.calls.commits, store.calls.uploads, store.calls.generated], [0, 0, 0]);
});

test('completing a no-show job keeps the field command\'s own closed answer, without reading its costs', async () => {
  const store = { read: () => assert.fail('a closed job never reads its costs'), list: () => assert.fail('a closed job never reads its costs') };
  for (const status of NO_SHOW) assert.equal(await requireFieldExpenseCloseout({ EGC_FIELD_EXPENSES_ENABLED: 'true' }, noShow(status), {}, { store }), undefined, status);
});

test('automatic deposit and estimate reminders stop for a no-show job, as for a cancelled one, and an overdue invoice is never a Hub reminder', () => {
  const settings = normalizeMessagingSettings(null);
  // Payment reminders are HighLevel's (egc-invoice-overdue), so an unpaid overdue invoice selects nothing, no-show or not.
  const unpaid = extra => messagingJob({ date: '2026-12-01', invoice: { number: 'INV-3001', amount: 1200, dueDate: '2026-09-21', status: 'issued' }, deposit: { amount: 300, paidAmount: 300, verified: true }, ...extra });
  const depositDue = extra => messagingJob({ date: '2026-09-25', invoice: { number: 'INV-3002', amount: 1200, dueDate: '2026-12-31', status: 'issued' }, ...extra });
  const quoting = extra => messagingJob({ date: '2026-12-01', invoice: null, estimate: { number: 'EST-1', status: 'sent', amount: 900, validUntil: '2026-09-23' }, deposit: { amount: 300, paidAmount: 300, verified: true }, ...extra });
  const rows = { 'pay-open': unpaid({ status: 'completed', pipelineStatus: 'completed' }), 'deposit-open': depositDue({}), 'deposit-cancelled': depositDue({ status: 'cancelled', pipelineStatus: 'cancelled' }), 'estimate-open': quoting({}) };
  for (const status of NO_SHOW) Object.assign(rows, { [`pay-${status}`]: unpaid({ status, pipelineStatus: status }), [`deposit-${status}`]: depositDue({ status, pipelineStatus: status }), [`estimate-${status}`]: quoting({ status, pipelineStatus: status }) });
  const selected = dueMessages(Object.entries(rows).map(([id, fields]) => ({ ...fields, id })), { now: new Date(MESSAGING_NOW), settings, kinds: new Set(['deposit_reminder', 'estimate_expiring', 'payment_reminder']) });
  assert.deepEqual(selected.due.map(row => `${row.kind}:${row.jobId}`).sort(), ['deposit_reminder:deposit-open', 'estimate_expiring:estimate-open']);
});
