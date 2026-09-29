// FIX-DISPATCH-READY: Dispatch shows whether a visit's customer reminder is set (from GHL-TRACK-1's tag outbox with
// EGC_GHL_TAG_OUTBOX on, else from today's calendar-sync fields, and says which) and, for owners and managers only,
// whether its price is approved and its deposit paid (money-core). Readiness never claims a reminder, price or deposit
// it cannot confirm, and nothing here writes to HighLevel. In-memory store, synthetic data, fixed clock.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { dispatchOverview, mutateDispatch, projectDispatchJob } from '../functions/_lib/dispatch-service.js';
import { dispatchHandlers } from '../functions/api/dispatch.js';
import { dispatchStorage } from '../functions/_lib/dispatch-storage.js';
import { encodeFirestoreFields } from '../functions/_lib/firestore-job.js';
import { MONEY_READY_FIELDS, REMINDER_STATES, moneyReadiness, moneyWarnings, notifyPatch, reminderReadiness, withDispatchReadiness } from '../functions/_lib/dispatch-readiness.js';
import { paymentLedger } from '../functions/_lib/money-core.js';
import { GHL_TAG_OUTBOX } from '../functions/_lib/ghl-tag-outbox.js';
import { canDispatch } from '../functions/_lib/dispatch-permissions.js';
import { fieldJobProjection } from '../functions/_lib/field-execution.js';
import { crewJobProjection } from '../functions/_lib/crew-job-projection.js';
import { crewJobsHandlers, CREW_LISTING_FIELDS } from '../functions/api/crew-jobs.js';
import * as fieldJobs from '../functions/api/field-jobs.js';
import { createHubSessionCookie } from '../functions/_lib/hub-session.js';
import { storage as fieldStorage } from './helpers/field-fixture.mjs';

// 12:00 UTC on 22 Sept is 06:00 in Denver. LATE is 23:30 Denver on 22 Sept, already 23 Sept in UTC.
const NOW = '2026-09-22T12:00:00.000Z', LATE = '2026-09-23T05:30:00.000Z';
const owner = { user: 'zacb', displayName: 'Synthetic Owner', role: 'owner', businessAccess: true };
const sales = { user: 'sales.one', displayName: 'Synthetic Sales', role: 'sales', businessAccess: false };
const crewSession = { user: 'crew1', displayName: 'Synthetic Crew', role: 'crew', businessAccess: false };
const ROSTER = [{ id: 'zacb', name: 'Synthetic Owner', role: 'owner' }, { id: 'crew1', name: 'Synthetic Crew', role: 'crew' }, { id: 'crew2', name: 'Synthetic Crew Two', role: 'crew' }];

function fixture({ outbox = false, importedOn = false, readMany = null } = {}) {
  const rows = new Map([
    ['customers/c1', { id: 'c1', name: 'Synthetic Customer', phone: '+1 (970) 555-0101', email: 'synthetic@example.invalid', address: '1 Synthetic Way', highlevelContactId: 'contact-1', revision: 'c1r' }],
    ['customers/c2', { id: 'c2', name: 'Synthetic Unlinked', phone: '+1 (970) 555-0102', email: 'unlinked@example.invalid', address: '2 Synthetic Way', revision: 'c2r' }],
  ]);
  let revision = 0;
  const clone = value => structuredClone(value), all = prefix => [...rows].filter(([key]) => key.startsWith(prefix + '/')).map(([, value]) => clone(value));
  const store = {
    ghlTagOutbox: outbox, notifyImportedOn: importedOn,
    jobs: async () => all('jobs'), resources: async () => all('dispatchResources'), customers: async () => all('customers'), roster: async () => clone(ROSTER),
    read: async (collection, id) => clone(rows.get(`${collection}/${id}`) || null),
    async commit(writes) {
      const seen = new Set();
      for (const write of writes) {
        const key = `${write.collection}/${write.id}`, old = rows.get(key);
        assert.ok(!seen.has(key), 'no duplicate writes per document'); seen.add(key);
        if (write.revision ? old?.revision !== write.revision : Boolean(old)) throw Object.assign(new Error('Conflict'), { code: 'dispatch_revision_conflict', status: 409 });
      }
      for (const write of writes) if (!write.verify) rows.set(`${write.collection}/${write.id}`, { ...(write.revision ? rows.get(`${write.collection}/${write.id}`) : {}), ...clone(write.patch), id: write.id, revision: `r${++revision}` });
    },
    ...(readMany ? { readMany } : {}),
  };
  const put = (id, data) => { rows.set(`jobs/${id}`, { id, revision: `${id}-r1`, type: 'job', customerId: 'c1', customer: 'Synthetic Customer', address: '1 Synthetic Way', jobInstructions: 'Synthetic scope', status: 'scheduled', pipelineStatus: 'scheduled', assignedCrew: ['crew1'], travelBufferMinutes: 0, date: '2026-09-25', time: '09:00', endDate: '2026-09-25', endTime: '11:00', ...data }); return rows.get(`jobs/${id}`); };
  const mutate = (input, at = NOW) => mutateDispatch(store, owner, input, at);
  const update = (id, changes, at = NOW) => mutate({ action: 'schedule.update', requestId: randomUUID(), jobId: id, expectedRevision: rows.get(`jobs/${id}`).revision, changes }, at);
  const create = (changes = {}, extra = {}) => mutate({ action: 'schedule.create', requestId: randomUUID(), customerId: 'c1', kind: 'walkthrough', changes: { date: '2026-09-25', time: '09:00', endTime: '10:00', assignedCrew: ['crew1'], jobInstructions: 'Synthetic walkthrough', ...changes }, ...extra });
  // GET /api/dispatch asks for readiness (functions/api/dispatch.js); the signed bridge and other callers do not.
  const board = (session = owner, at = NOW, options = { readiness: true }) => dispatchOverview(store, session, { startDate: '2026-09-22', endDate: '2026-09-29', includeUnscheduled: 'true' }, new Date(at), options);
  return { rows, store, put, mutate, update, create, board, job: id => clone(rows.get(`jobs/${id}`)) };
}
const find = (overview, id) => overview.jobs.find(job => job.id === id);
const MONEY_CODES = new Set(['no_price', 'deposit_unpaid']);
const codes = (overview, id) => overview.warnings.filter(warning => warning.jobId === id && MONEY_CODES.has(warning.code)).map(warning => warning.code).sort();
const approved = (amount, extra = {}) => ({ estimate: { amount, status: 'accepted', ...(extra.estimate || {}) }, customerApproval: { status: 'approved', amount, ...(extra.customerApproval || {}) } });

test('the Notify customer toggle persists notify and records when a person changed it', async () => {
  const f = fixture(), created = await f.create({ notify: false });
  assert.equal(f.job(created.job.id).notify, false, 'the create dialog can start a visit with reminders off');
  assert.equal(f.job(created.job.id).notifySetAt, undefined, 'a create only saves the choice');
  await f.update(created.job.id, { notify: true }, '2026-09-22T13:00:00.000Z');
  assert.deepEqual([f.job(created.job.id).notify, f.job(created.job.id).notifySetAt], [true, '2026-09-22T13:00:00.000Z']);
  await f.update(created.job.id, { notify: true, opsNotes: 'Synthetic note' }, '2026-09-22T14:00:00.000Z');
  assert.equal(f.job(created.job.id).notifySetAt, '2026-09-22T13:00:00.000Z', 'resending the same choice is no change');
  const receipt = [...f.rows.entries()].filter(([key]) => key.startsWith('dispatchOperations/')).map(([, row]) => row).find(row => row.after?.notify === true && row.before?.notify === false);
  assert.ok(receipt, 'the receipt records the change');
  await assert.rejects(f.update(created.job.id, { notify: 'yes' }), error => error.code === 'dispatch_invalid_field');
  // A legacy visit with no notify field is on: turning it on is no change, turning it off is.
  f.put('legacy', { date: '2026-09-26', endDate: '2026-09-26' });
  await f.update('legacy', { notify: true });
  assert.equal(f.job('legacy').notifySetAt, undefined);
  await f.update('legacy', { notify: false }, '2026-09-22T15:00:00.000Z');
  assert.deepEqual([f.job('legacy').notify, f.job('legacy').notifySetAt], [false, '2026-09-22T15:00:00.000Z']);
  assert.equal('notifySetAt' in projectDispatchJob(f.job('legacy')), false, 'the DTO keeps its fields');
});

test('an imported Jobber job: its first booking turns reminders on only with EGC_DISPATCH_NOTIFY_IMPORTED_ON', async () => {
  const imported = { scheduleSource: 'jobber_import', importSource: 'jobber', notify: false, customerAutomationEnabled: false, syncStatus: 'not_needed', highlevelContactId: 'contact-1', date: '', time: '', endDate: '', endTime: '', status: 'unscheduled', pipelineStatus: 'unscheduled', assignedCrew: [] };
  const book = { date: '2026-09-25', time: '09:00', endDate: '2026-09-25', endTime: '11:00', assignedCrew: ['crew1'] };
  const off = fixture();
  off.put('jobber_job_1', imported);
  assert.deepEqual(find(await off.board(), 'jobber_job_1').reminder, { state: 'off', source: 'none', jobberImport: true }, 'the edit dialog knows it is an imported job whose reminders were off');
  await off.update('jobber_job_1', book);
  assert.deepEqual([off.job('jobber_job_1').notify, off.job('jobber_job_1').notifySetAt, off.job('jobber_job_1').syncStatus], [false, undefined, 'pending'], 'flag off: reminders stay off');
  assert.equal((await off.board()).notifyImportedOn, undefined);

  const on = fixture({ importedOn: true, outbox: true });
  on.put('jobber_job_1', imported);
  assert.equal((await on.board()).notifyImportedOn, true, 'reads tell the dialog to preselect the toggle');
  await on.update('jobber_job_1', book, '2026-09-22T13:00:00.000Z');
  const saved = on.job('jobber_job_1');
  assert.deepEqual([saved.notify, saved.notifySetAt, saved.syncStatus], [true, '2026-09-22T13:00:00.000Z', 'pending']);
  const entry = on.rows.get(`${GHL_TAG_OUTBOX}/${saved.ghlTagEntry.id}`);
  assert.ok(entry.addTags.includes('egc-reminder-2d'), 'the booking tells HighLevel the reminder through the existing tags');
  // Unscheduling and booking again never turns a decided choice back on.
  await on.update('jobber_job_1', { notify: false }, '2026-09-22T14:00:00.000Z');
  await on.update('jobber_job_1', { date: '', time: '', endDate: '', endTime: '' });
  await on.update('jobber_job_1', book);
  assert.equal(on.job('jobber_job_1').notify, false);

  // A dispatcher who unchecks the preselected toggle keeps reminders off, and the decision is recorded.
  const kept = fixture({ importedOn: true });
  kept.put('jobber_job_2', imported);
  await kept.update('jobber_job_2', { ...book, notify: false }, '2026-09-22T13:00:00.000Z');
  assert.deepEqual([kept.job('jobber_job_2').notify, kept.job('jobber_job_2').notifySetAt], [false, '2026-09-22T13:00:00.000Z']);
  await kept.update('jobber_job_2', { date: '', time: '', endDate: '', endTime: '' });
  // Unscheduled again after the decision: the Edit dialog must not propose (and send) reminders on again, so the
  // board no longer marks it an undecided import; one nobody decided on still is.
  kept.put('jobber_job_3', imported);
  const unscheduled = await kept.board();
  assert.deepEqual(find(unscheduled, 'jobber_job_2').reminder, { state: 'off', source: 'none' }, 'a recorded choice is not re-proposed');
  assert.deepEqual(find(unscheduled, 'jobber_job_3').reminder, { state: 'off', source: 'none', jobberImport: true });
  assert.equal(unscheduled.notifyImportedOn, true);
  await kept.update('jobber_job_2', book);
  assert.equal(kept.job('jobber_job_2').notify, false, 'the recorded choice is final');

  // Only the first booking of an undated import: a dated import, a native job and a notify-on import are untouched.
  assert.deepEqual(notifyPatch({ ...imported, date: '2026-09-24' }, {}, { ...imported, ...book }, NOW, { importedOn: true }), {});
  assert.deepEqual(notifyPatch({ ...imported, scheduleSource: 'egc_hub' }, {}, { ...imported, ...book }, NOW, { importedOn: true }), {});
  assert.deepEqual(notifyPatch({ ...imported, notify: true }, {}, { ...imported, ...book }, NOW, { importedOn: true }), {});
  assert.deepEqual(notifyPatch(imported, { opsNotes: 'x' }, imported, NOW, { importedOn: true }), {}, 'still undated: no booking yet');
  assert.deepEqual(notifyPatch(imported, {}, { ...imported, ...book }, NOW, { importedOn: true }), { notify: true, notifySetAt: NOW });
});

test('money readiness: no approved price, a deposit due within 2 Denver days, a paid deposit and a walkthrough', async () => {
  const f = fixture();
  f.put('unpriced', { date: '2026-09-23' });
  f.put('draft', { date: '2026-09-23', estimate: { amount: 800, status: 'draft' } });
  f.put('superseded', { date: '2026-09-26', estimate: { amount: 900, status: 'draft' }, customerApproval: { status: 'superseded', amount: 800 } });
  f.put('mismatch', { date: '2026-09-26', estimate: { amount: 900, status: 'accepted' }, customerApproval: { status: 'approved', amount: 800 } });
  f.put('due-soon', { date: '2026-09-24', ...approved(1000) });
  f.put('due-later', { date: '2026-09-27', ...approved(1000) });
  f.put('paid', { date: '2026-09-23', ...approved(1000), payment: { amount: 500, verified: true } });
  f.put('unverified', { date: '2026-09-23', ...approved(1000), payment: { amount: 500 } });
  f.put('no-deposit', { date: '2026-09-23', ...approved(600, { estimate: { depositRequired: 0 } }) });
  f.put('walk', { type: 'walkthrough', date: '2026-09-23' });
  f.put('done', { date: '2026-09-21', status: 'completed', pipelineStatus: 'completed' });
  const board = await f.board();
  const ready = id => find(board, id).moneyReady;

  assert.deepEqual(ready('unpriced'), { checked: true, hasApprovedPrice: false, priceStatus: 'missing', depositRequiredCents: null, depositPaidCents: null, depositDueCents: null, depositVerified: null });
  assert.deepEqual(codes(board, 'unpriced'), ['no_price']);
  assert.equal(board.warnings.find(warning => warning.jobId === 'unpriced' && warning.code === 'no_price').message, 'No approved price: price it before the job');
  assert.deepEqual([ready('draft').hasApprovedPrice, ready('draft').priceStatus, ready('draft').depositRequiredCents], [false, 'not_approved', 40000]);
  assert.deepEqual(codes(board, 'draft'), ['deposit_unpaid', 'no_price'], 'a drafted price is not approved');
  assert.deepEqual([ready('superseded').hasApprovedPrice, ready('mismatch').hasApprovedPrice], [false, false], 'an old or different approval is not this price');

  assert.deepEqual(ready('due-soon'), { checked: true, hasApprovedPrice: true, priceStatus: 'approved', depositRequiredCents: 50000, depositPaidCents: 0, depositDueCents: 50000, depositVerified: null });
  assert.deepEqual(codes(board, 'due-soon'), ['deposit_unpaid']);
  const warning = board.warnings.find(row => row.jobId === 'due-soon' && row.code === 'deposit_unpaid');
  assert.deepEqual([warning.depositDueCents, warning.message], [50000, 'Deposit unpaid: $500.00 is still due before this job.']);
  assert.deepEqual([ready('due-later').depositDueCents, codes(board, 'due-later')], [50000, []], 'three days out: shown on the card, not yet a warning');

  assert.deepEqual([ready('paid').depositPaidCents, ready('paid').depositDueCents, ready('paid').depositVerified, codes(board, 'paid')], [50000, 0, true, []]);
  assert.deepEqual([ready('unverified').depositDueCents, ready('unverified').depositVerified], [0, false], 'money awaiting verification is never a paid deposit');
  assert.deepEqual([ready('no-deposit').depositRequiredCents, codes(board, 'no-deposit')], [0, []]);

  assert.equal('moneyReady' in find(board, 'walk'), false, 'walkthroughs get no money readiness');
  assert.deepEqual(codes(board, 'walk'), []);
  assert.deepEqual(codes(board, 'done'), [], 'a finished job is not warned');
  // The job view carries the same readiness.
  const view = await dispatchOverview(f.store, owner, { view: 'job', jobId: 'due-soon' }, new Date(NOW), { readiness: true });
  assert.deepEqual([view.job.moneyReady.depositDueCents, view.warnings.filter(row => row.code === 'deposit_unpaid').length], [50000, 1]);
  // Without the option (the signed hub.dispatch.overview bridge, operations-hub-commands.js) the board is as before: no money, no readiness.
  for (const read of [await f.board(owner, NOW, {}), await dispatchOverview(f.store, owner, { view: 'job', jobId: 'due-soon' }, new Date(NOW))]) {
    assert.doesNotMatch(JSON.stringify(read), /moneyReady|"reminder"|no_price|deposit_unpaid|50000/);
  }
});

// What a Firestore batchGet with a field mask returns: only the masked paths (dotted paths are nested fields).
function masked(row, fields) {
  const out = {};
  for (const path of fields) {
    const keys = path.split('.');
    let from = row, to = out;
    for (const [index, key] of keys.entries()) {
      if (!from || typeof from !== 'object' || !(key in from)) break;
      if (index === keys.length - 1) to[key] = structuredClone(from[key]);
      else { to = to[key] ||= {}; from = from[key]; }
    }
  }
  return out;
}

test('an unreconciled refund or conflicting receipts never read as a verified deposit', async () => {
  const verified = { amount: 500, verified: true };
  const f = fixture({ readMany: async (collection, ids, fields) => ids.map(id => f.rows.get(`${collection}/${id}`)).filter(Boolean).map(row => collection === 'jobs' ? { ...masked(row, fields), id: row.id, revision: row.revision } : structuredClone(row)) });
  const visit = payment => ({ date: '2026-09-23', ...approved(1000), payment });
  f.put('settled', visit(verified));
  f.put('refund-list', { ...visit(verified), refunds: [{ amount: 500, at: '2026-09-21T10:00:00.000Z', reason: 'Synthetic refund' }] });
  f.put('refund-on-payment', visit({ ...verified, refunds: [{ amount: 200 }] }));
  f.put('refund-amount', visit({ ...verified, refundedAmount: 500 }));
  // One Stripe payment recorded twice with different amounts.
  f.put('conflict', visit({ ...verified, stripeSessions: [{ sessionId: 'cs_test_synthetic_a', amount: 500 }, { sessionId: 'cs_test_synthetic_a', amount: 400 }] }));
  assert.deepEqual(['refund-list', 'refund-on-payment', 'refund-amount', 'conflict'].map(id => paymentLedger(f.job(id)).issues),
    [['money_refunds_unreconciled'], ['money_refunds_unreconciled'], ['money_refunds_unreconciled'], ['money_payment_conflict']], 'the money-core issue each case raises');
  const board = await f.board(), ready = id => find(board, id).moneyReady;
  assert.deepEqual([ready('settled').depositPaidCents, ready('settled').depositVerified], [50000, true], 'a settled, verified deposit is paid');
  for (const id of ['refund-list', 'refund-on-payment', 'refund-amount', 'conflict']) {
    assert.deepEqual([ready(id).depositRequiredCents, ready(id).depositPaidCents, ready(id).depositDueCents, ready(id).depositVerified], [50000, 50000, 0, false], `${id}: "Deposit not verified", never "Deposit paid"`);
    assert.equal(moneyReadiness({ ...f.job(id), id }).depositVerified, false, id);
    assert.deepEqual(codes(board, id), [], 'no deposit is shown due: the chip says not verified');
  }
  // A partial refund is still unreconciled.
  assert.equal(moneyReadiness({ id: 'j', type: 'job', ...approved(1000), payment: { ...verified, refundedAmount: 100 } }).depositVerified, false);
});

test('the deposit window counts Denver calendar days, never UTC or the device clock', () => {
  const ready = moneyReadiness({ id: 'j', type: 'job', ...approved(1000) });
  const warned = date => moneyWarnings({ id: 'j', type: 'job', status: 'scheduled', date }, ready, LATE).some(row => row.code === 'deposit_unpaid');
  // LATE is still 22 Sept in Denver: the 24th is two days out, the 25th three.
  assert.deepEqual(['2026-09-22', '2026-09-24', '2026-09-25'].map(warned), [true, true, false]);
  assert.deepEqual(['2026-09-25', '2026-09-26'].map(date => moneyWarnings({ id: 'j', type: 'job', status: 'scheduled', date }, ready, '2026-09-23T06:30:00.000Z').some(row => row.code === 'deposit_unpaid')), [true, false], 'after Denver midnight the window moves');
  assert.deepEqual(moneyWarnings({ id: 'j', type: 'job', status: 'unscheduled', date: '' }, ready, NOW).map(row => row.code), [], 'an unscheduled job has no deposit deadline');
});

test('money figures reach only owners and managers; sales and crew sessions never get them', async () => {
  const f = fixture();
  f.put('priced', { date: '2026-09-23', ...approved(1000) });
  const raw = f.job('priced'), dto = projectDispatchJob(raw, ROSTER, NOW);
  assert.equal(canDispatch(sales), false);
  for (const session of [sales, crewSession, null]) {
    const result = await withDispatchReadiness(f.store, session, [raw], [dto], new Date(NOW));
    assert.equal('moneyReady' in result.jobs[0], false, session?.role || 'no session');
    assert.deepEqual(result.warnings, []);
    assert.equal(result.jobs[0].reminder.state, 'no_contact', 'reminder readiness is not money');
  }
  const manager = await withDispatchReadiness(f.store, owner, [raw], [dto], new Date(NOW));
  assert.equal(manager.jobs[0].moneyReady.hasApprovedPrice, true);
  // A handler whose session lacks dispatch.write never reaches the board.
  const handlers = dispatchHandlers({ session: async () => sales, storage: () => f.store, travel: () => null, now: () => new Date(NOW) });
  const response = await handlers.get({ request: new Request('https://easygaragecleaning.com/api/dispatch?startDate=2026-09-22&endDate=2026-09-29'), env: {} });
  assert.equal(response.status, 403);
  assert.doesNotMatch(await response.text(), /moneyReady|depositRequiredCents/);
});

// GHL-TRACK-1's third review: Retry on the HighLevel chip posts to /api/ghl-tag-drain, which needs dispatch.write. A booker
// (AUTH-ROLES schedule.book: a sales or phone session reading the board) is told not to offer it; the bridge is unchanged.
test('only a viewer who may retry HighLevel tags gets ghlTagRetry; the bridge read carries neither it nor notifyImportedOn', async () => {
  const f = fixture({ outbox: true, importedOn: true });
  const id = (await f.create()).job.id, entryKey = `${GHL_TAG_OUTBOX}/${f.job(id).ghlTagEntry.id}`;
  f.rows.set(entryKey, { ...f.rows.get(entryKey), status: 'parked', attempts: 8, lastError: 'highlevel_503' });
  const raw = f.job(id), dto = projectDispatchJob(raw, ROSTER, NOW);
  for (const session of [sales, crewSession, null]) {
    const result = await withDispatchReadiness(f.store, session, [raw], [dto], new Date(NOW));
    assert.deepEqual([result.ghlTagRetry, result.jobs[0].ghlTags.status], [false, 'parked'], `${session?.role || 'no session'}: the stuck chip, no Retry`);
  }
  assert.equal((await withDispatchReadiness(f.store, owner, [raw], [dto], new Date(NOW))).ghlTagRetry, true);
  const board = await f.board(), view = await dispatchOverview(f.store, owner, { view: 'job', jobId: id }, new Date(NOW), { readiness: true });
  assert.deepEqual([board.ghlTagRetry, board.notifyImportedOn, view.ghlTagRetry, view.notifyImportedOn], [true, true, true, true]);
  // The signed hub.dispatch.overview bridge and other callers (no readiness option) read the board as before.
  for (const read of [await f.board(owner, NOW, {}), await dispatchOverview(f.store, owner, { view: 'job', jobId: id }, new Date(NOW))]) {
    assert.deepEqual(['ghlTagRetry', 'notifyImportedOn'].filter(key => key in read), []);
    assert.equal(read.ghlTagOutbox, true, 'the HighLevel chip itself is unchanged');
  }
  // The Hub's GET /api/dispatch: an owner or manager may retry.
  const handlers = dispatchHandlers({ session: async () => owner, storage: () => f.store, travel: () => null, now: () => new Date(NOW), ghlTags: () => true });
  const response = await handlers.get({ request: new Request('https://easygaragecleaning.com/api/dispatch?startDate=2026-09-22&endDate=2026-09-29'), env: {} });
  assert.equal((await response.json()).ghlTagRetry, true);
});

test('an unreadable money read leaves the price and deposit unchecked and the board working', async () => {
  const f = fixture({ readMany: async collection => { if (collection === 'jobs') throw Object.assign(new Error('down'), { code: 'dispatch_storage_unavailable' }); return []; } });
  f.put('priced', { date: '2026-09-23', ...approved(1000) });
  const board = await f.board();
  assert.deepEqual(find(board, 'priced').moneyReady, { checked: false, hasApprovedPrice: null, priceStatus: 'unknown', depositRequiredCents: null, depositPaidCents: null, depositDueCents: null, depositVerified: null });
  assert.deepEqual(codes(board, 'priced'), [], 'unknown money raises no warning and never a paid chip');
  assert.equal(board.coverage.complete, true, 'the schedule itself was read in full');
});

test('the production money read masks the job to the money fields: never signatures, notes or photos', async () => {
  const calls = [];
  const env = { FIREBASE_API_KEY: 'firebase-test-dispatch-ready' };
  const fetcher = async (_env, url, init = {}) => {
    calls.push({ url: String(url), body: init.body ? JSON.parse(init.body) : null });
    const fields = encodeFirestoreFields({ type: 'job', status: 'scheduled', ...approved(1000), payment: { amount: 500, verified: true } });
    return Response.json([{ found: { name: 'projects/egcw-1ec83/databases/(default)/documents/jobs/priced', fields, updateTime: '2026-09-22T00:00:00.000001Z' } }]);
  };
  const store = dispatchStorage(env, fetcher), raw = { id: 'priced', type: 'job', status: 'scheduled', date: '2026-09-23', time: '09:00', endTime: '11:00' };
  const result = await withDispatchReadiness(store, owner, [raw], [projectDispatchJob(raw, [], NOW)], new Date(NOW));
  assert.deepEqual([result.jobs[0].moneyReady.hasApprovedPrice, result.jobs[0].moneyReady.depositPaidCents], [true, 50000]);
  const batch = calls.find(call => call.url.endsWith(':batchGet'));
  assert.deepEqual(batch.body.mask.fieldPaths, [...MONEY_READY_FIELDS]);
  for (const field of batch.body.mask.fieldPaths) assert.doesNotMatch(field, /^(estimate|customerApproval|invoice|deposit)$|signature|internalNotes|photo|acceptance|costs/i, field);
});

test('reminder readiness from the calendar sync says set only for the reminder tag that sync reported adding', () => {
  const base = { id: 'v', type: 'job', status: 'scheduled', date: '2026-09-25', time: '09:00', endDate: '2026-09-25', endTime: '11:00', highlevelContactId: 'contact-1' };
  // What employee-suite.js syncJobRecord saves after a tool=schedule sync that added egc-reminder-2d.
  const told = { ...base, syncStatus: 'synced', automationTagSynced: true, highlevelAppointmentId: 'appt-1', syncLastAttemptAt: '2026-09-21T10:00:00.000Z', automationReminderTag: 'egc-reminder-2d', automationReminderTaggedAt: '2026-09-21T10:00:00.000Z' };
  const legacy = { ...told, automationReminderTag: undefined, automationReminderTaggedAt: undefined };
  const state = (job, options = {}) => reminderReadiness(job, { now: NOW, ...options });
  assert.deepEqual(state(told), { state: 'set', source: 'calendar_sync' });
  assert.equal(state({ ...base, syncStatus: 'pending' }).state, 'pending');
  assert.equal(state({ ...base, syncStatus: 'syncing' }).state, 'pending');
  assert.equal(state({ ...base, syncStatus: 'error' }).state, 'stuck');
  assert.equal(state({ ...base, highlevelContactId: '', syncStatus: 'not_needed' }).state, 'no_contact');
  assert.equal(state({ ...told, automationTagSynced: undefined }).state, 'unknown', 'a sync that did not confirm its tags');
  assert.equal(state({ ...told, automationTagSynced: false }).state, 'unknown');
  assert.equal(state({ ...told, highlevelAppointmentId: '' }).state, 'unknown', 'no appointment for the reminder to follow');
  assert.equal(state({ ...base, syncStatus: 'synced', syncedAt: NOW }).state, 'unknown', 'a server mirror that recorded no tags');
  assert.equal(state({ ...told, syncedAt: '2026-09-21T11:00:00.000Z' }).state, 'unknown', 'a server mirror after the page sync wrote the appointment without tags');
  // A job sold from a walkthrough is synced by its Game Plan (tool=game_plan), which adds egc-job-scheduled and no
  // reminder tag but still reports tagSynced: never "set".
  const handoff = { ...base, sourceWalkthroughId: 'w1', handoffVersion: 1, highlevelContactId: 'c', highlevelAppointmentId: 'a', syncStatus: 'synced', automationTagSynced: true, syncLastAttemptAt: '2026-09-21T10:00:00.000Z' };
  assert.deepEqual(state(handoff), { state: 'unknown', source: 'calendar_sync' }, 'synced before the sync recorded its reminder tag');
  assert.deepEqual(state({ ...handoff, automationReminderTag: '' }), { state: 'not_told', source: 'calendar_sync' }, 'the Game Plan sync added no reminder tag');
  // A legacy visit whose Notify customer was turned on before this change (no notifySetAt, nothing recorded).
  assert.equal(state(legacy).state, 'unknown');
  // Notify customer turned on after the last sync started: HighLevel has not heard it.
  assert.equal(state({ ...told, notifySetAt: '2026-09-22T09:00:00.000Z' }).state, 'not_told');
  assert.equal(state({ ...told, notifySetAt: '2026-09-21T09:00:00.000Z' }).state, 'set', 'changed before the sync that told HighLevel');
  assert.equal(state({ ...told, syncLastAttemptAt: undefined, notifySetAt: '2026-09-21T09:00:00.000Z' }).state, 'not_told');
  assert.deepEqual(state({ ...base, notify: false }), { state: 'off', source: 'calendar_sync' });
  assert.equal(state({ ...told, notify: false, notifySetAt: '2026-09-22T09:00:00.000Z' }).state, 'off_told', 'turned off after HighLevel was told to remind');
  assert.equal(state({ ...legacy, notify: false, notifySetAt: '2026-09-22T09:00:00.000Z' }).state, 'off_told', 'a legacy sync with reminders on, then turned off');
  assert.equal(state({ ...legacy, notify: false, notifySetAt: '2026-09-21T09:00:00.000Z' }).state, 'off', 'already off at the last sync');
  assert.equal(state({ ...handoff, automationReminderTag: '', notify: false, notifySetAt: '2026-09-22T09:00:00.000Z' }).state, 'off', 'no reminder tag was ever sent');
  // A later move synced with reminders off adds no reminder tag, but the one an earlier sync added is still on the contact.
  const moved = { ...told, notify: false, notifySetAt: '2026-09-21T12:00:00.000Z', automationReminderTag: '', syncLastAttemptAt: '2026-09-22T11:00:00.000Z' };
  assert.deepEqual(state(moved), { state: 'off_told', source: 'calendar_sync' });
  assert.equal(state({ ...base, notify: false }, { earlier: true }).state, 'off_told', 'an earlier outbox entry told HighLevel the reminder');
  assert.equal(state({ ...base, notify: false }, { earlier: null }).state, 'unknown', 'earlier entries that could not be read');
  assert.deepEqual(state({ ...base, date: '', time: '', endDate: '', endTime: '' }), { state: 'not_scheduled', source: 'none' });
  assert.equal(state({ ...told, date: '2026-09-22', endDate: '2026-09-22', time: '05:00', endTime: '07:00' }), null, 'a visit already started is past its reminder');
  for (const status of ['cancelled', 'completed', 'no_show']) assert.equal(state({ ...told, status, pipelineStatus: status }), null, status);
  assert.equal(state({ ...told, type: 'blocked' }), null);
  assert.equal(state({ ...told, type: 'walkthrough' }).state, 'set', 'walkthroughs get reminders too');
  for (const job of [told, base, legacy, handoff, { ...base, syncStatus: 'error' }, { ...told, notify: false }]) assert.ok(REMINDER_STATES.includes(state(job).state));
});

test('reminder readiness follows the tag outbox entry when EGC_GHL_TAG_OUTBOX is on, and says so', async () => {
  let failOutbox = false;
  const f = fixture({ outbox: true, readMany: async (collection, ids) => { if (collection === GHL_TAG_OUTBOX && failOutbox) throw new Error('down'); return ids.map(id => structuredClone(f.rows.get(`${collection}/${id}`))).filter(Boolean); } });
  const created = await f.create();
  const id = created.job.id, entryKey = () => `${GHL_TAG_OUTBOX}/${f.job(id).ghlTagEntry.id}`;
  const reminder = async () => find(await f.board(), id).reminder;
  assert.deepEqual(await reminder(), { state: 'pending', source: 'ghl_outbox' }, 'queued with the reminder tag, not told yet');
  f.rows.set(entryKey(), { ...f.rows.get(entryKey()), status: 'done', doneAt: NOW });
  assert.deepEqual(await reminder(), { state: 'set', source: 'ghl_outbox' });
  f.rows.set(entryKey(), { ...f.rows.get(entryKey()), status: 'parked', lastError: 'highlevel_503' });
  assert.equal((await reminder()).state, 'stuck');
  failOutbox = true;
  assert.deepEqual(await reminder(), { state: 'unknown', source: 'ghl_outbox' }, 'an unreadable outbox is unknown, never set');
  failOutbox = false;
  f.rows.set(entryKey(), { ...f.rows.get(entryKey()), status: 'done' });
  // Turning Notify customer off does not take the reminder tag back: the card says HighLevel may still remind.
  await f.update(id, { notify: false });
  assert.equal((await reminder()).state, 'off_told');
  // A move writes a new entry without the reminder while it is off, but the earlier entry told HighLevel one: it may still remind.
  await f.update(id, { date: '2026-09-26', endDate: '2026-09-26' });
  assert.deepEqual(await reminder(), { state: 'off_told', source: 'ghl_outbox' });
  f.rows.set(entryKey(), { ...f.rows.get(entryKey()), status: 'done', doneAt: NOW });
  assert.equal((await reminder()).state, 'off_told', 'and after that entry is told too');
  // Turning it back on is not told until the next move.
  await f.update(id, { notify: true });
  assert.deepEqual(await reminder(), { state: 'not_told', source: 'ghl_outbox' });
  await f.update(id, { time: '10:00', endTime: '11:00' });
  assert.equal((await reminder()).state, 'pending', 'the next move queues the reminder tag');
  // An entry closed without telling HighLevel hands the reminder back to the calendar sync, as scheduleTagOwner does.
  f.rows.set(entryKey(), { ...f.rows.get(entryKey()), status: 'done', skipped: 'superseded' });
  assert.deepEqual(await reminder(), { state: 'pending', source: 'calendar_sync' });
  // A visit moved by a path that wrote no entry has no current entry either.
  f.rows.set(`jobs/${id}`, { ...f.job(id), time: '12:00', endTime: '13:00', syncStatus: 'synced', automationTagSynced: true, highlevelAppointmentId: 'appt-1', syncLastAttemptAt: '2026-09-22T12:05:00.000Z', automationReminderTag: 'egc-reminder-2d' });
  assert.deepEqual(await reminder(), { state: 'set', source: 'calendar_sync' });
});

// GHL-TRACK-1 (31a8de8) shows a pending entry the tag worker is overdue on as "HighLevel stuck"; the reminder chip agrees.
test('an outbox entry the tag worker is overdue on is a stuck reminder, as the HighLevel chip shows it', async () => {
  const f = fixture({ outbox: true });
  const id = (await f.create()).job.id, entryKey = () => `${GHL_TAG_OUTBOX}/${f.job(id).ghlTagEntry.id}`;
  const minutes = count => new Date(Date.parse(NOW) + count * 60000).toISOString();
  const read = async (at, options = { readiness: true }) => find(await f.board(owner, at, options), id);
  let job = await read(NOW);
  assert.deepEqual([job.reminder, job.ghlTags.overdue], [{ state: 'pending', source: 'ghl_outbox' }, false], 'just queued: waiting');
  job = await read(minutes(15));
  assert.deepEqual([job.reminder.state, job.ghlTags.overdue], ['pending', false], 'the first 15 minutes are the normal wait');
  job = await read(minutes(16));
  assert.deepEqual([job.reminder, job.ghlTags.status, job.ghlTags.overdue], [{ state: 'stuck', source: 'ghl_outbox' }, 'pending', true], 'the worker stopped: stuck on both');
  const view = await dispatchOverview(f.store, owner, { view: 'job', jobId: id }, new Date(minutes(16)), { readiness: true });
  assert.deepEqual([view.job.reminder.state, view.job.ghlTags.overdue], ['stuck', true], 'the job view agrees');
  // Without readiness (the signed bridge) the board and the job view still pass the clock, so the chip says overdue.
  const bridge = await f.board(owner, minutes(16), {});
  assert.deepEqual([find(bridge, id).ghlTags.overdue, 'reminder' in find(bridge, id)], [true, false]);
  const bridgeView = await dispatchOverview(f.store, owner, { view: 'job', jobId: id }, new Date(minutes(16)));
  assert.deepEqual([bridgeView.job.ghlTags.overdue, 'reminder' in bridgeView.job], [true, false]);
  // An attempt in flight (a live claim) or a retry backing off is not overdue.
  f.rows.set(entryKey(), { ...f.rows.get(entryKey()), claimedUntil: minutes(20) });
  assert.equal((await read(minutes(16))).reminder.state, 'pending');
  f.rows.set(entryKey(), { ...f.rows.get(entryKey()), claimedUntil: '', nextAttemptAt: minutes(10) });
  assert.equal((await read(minutes(16))).reminder.state, 'pending');
  assert.equal((await read(minutes(26))).reminder.state, 'stuck');
  // With reminders off an overdue entry still reads by its tags, never as a reminder that is stuck.
  await f.update(id, { notify: false }, minutes(26));
  assert.equal((await read(minutes(26))).reminder.state, 'off_told');
  assert.deepEqual(reminderReadiness(f.job(id), { outbox: true, entry: { status: 'pending', addTags: ['egc-hub-scheduled'], nextAttemptAt: NOW }, now: minutes(60) }), { state: 'off', source: 'ghl_outbox' });
});

test('the dispatch board and save paths never write to HighLevel or queue anything for readiness', async () => {
  const f = fixture({ outbox: true });
  const created = await f.create();
  const before = [...f.rows.keys()].sort();
  await f.board(); await dispatchOverview(f.store, owner, { view: 'job', jobId: created.job.id }, new Date(NOW), { readiness: true });
  assert.deepEqual([...f.rows.keys()].sort(), before, 'reads write nothing');
  const calls = [];
  const handlers = dispatchHandlers({ session: async () => owner, storage: () => f.store, travel: () => null, now: () => new Date(NOW), ghlTags: (...args) => { calls.push(args); return true; } });
  const response = await handlers.get({ request: new Request('https://easygaragecleaning.com/api/dispatch?startDate=2026-09-22&endDate=2026-09-29&includeUnscheduled=true'), env: {} });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(find(body, created.job.id).reminder.source, 'ghl_outbox');
  assert.deepEqual(calls, [], 'a read never starts a HighLevel attempt');
  // A notify-only save queues no tag entry: HighLevel hears the choice with the next schedule change.
  const entries = () => [...f.rows.keys()].filter(key => key.startsWith(GHL_TAG_OUTBOX + '/')).length, count = entries();
  await f.update(created.job.id, { notify: false });
  assert.equal(entries(), count);
});

test('with reminders off, earlier outbox entries decide whether HighLevel may still remind; a board reads each entry once', async () => {
  let failChain = false;
  const reads = [];
  // The board's outbox read asks for doneAt (the HighLevel chip); only the earlier-entry reads leave it out.
  const f = fixture({ outbox: true, readMany: async (collection, ids, fields) => {
    reads.push({ collection, ids: [...ids], fields: [...(fields || [])] });
    if (collection === GHL_TAG_OUTBOX && failChain && !fields.includes('doneAt')) throw new Error('down');
    return ids.map(id => structuredClone(f.rows.get(`${collection}/${id}`))).filter(Boolean);
  } });
  const silent = (await f.create({ notify: false })).job.id, untold = (await f.create({ time: '11:00', endTime: '12:00' })).job.id, told = (await f.create({ time: '13:00', endTime: '14:00' })).job.id;
  const entryKey = id => `${GHL_TAG_OUTBOX}/${f.job(id).ghlTagEntry.id}`, settle = (key, patch) => f.rows.set(key, { ...f.rows.get(key), ...patch });
  settle(entryKey(silent), { status: 'done', doneAt: NOW }); settle(entryKey(told), { status: 'done', doneAt: NOW });
  const untoldFirst = entryKey(untold);
  const outboxReads = () => reads.filter(read => read.collection === GHL_TAG_OUTBOX);
  let board = await f.board();
  assert.equal(outboxReads().length, 1, 'the HighLevel chip and the reminder share one outbox read');
  assert.ok(outboxReads()[0].fields.includes('addTags'));
  assert.deepEqual([find(board, told).ghlTags.status, find(board, told).reminder], ['done', { state: 'set', source: 'ghl_outbox' }]);
  assert.deepEqual(find(board, silent).reminder, { state: 'off', source: 'ghl_outbox' });
  // Reminders go off on all three, and each moves: every new entry leaves the reminder tag out.
  for (const id of [silent, untold, told]) { await f.update(id, { notify: false }); await f.update(id, { date: '2026-09-26', endDate: '2026-09-26' }); }
  // The untold visit's first entry was still queued at the move: the drain closes it without telling HighLevel.
  settle(untoldFirst, { status: 'done', doneAt: NOW, skipped: 'superseded' });
  reads.length = 0;
  board = await f.board();
  assert.deepEqual([silent, untold, told].map(id => find(board, id).reminder.state), ['off', 'off', 'off_told'], 'only an entry HighLevel was told counts');
  assert.equal(outboxReads().length, 2, 'the board read, then one read of the earlier entries');
  assert.deepEqual(outboxReads()[1].fields, ['status', 'skipped', 'addTags', 'previousEntryId']);
  // Earlier entries that cannot be read are unknown, never "off", and the board still loads.
  failChain = true;
  board = await f.board();
  assert.deepEqual([silent, untold, told].map(id => find(board, id).reminder.state), ['unknown', 'unknown', 'unknown']);
  assert.equal(board.coverage.complete, true);
  // A visit whose page sync once added the reminder tag needs no earlier entry to be read.
  failChain = false;
  f.rows.set(`jobs/${silent}`, { ...f.job(silent), automationReminderTaggedAt: '2026-09-21T10:00:00.000Z' });
  reads.length = 0;
  assert.equal(find(await f.board(), silent).reminder.state, 'off_told');
  assert.ok(!outboxReads().slice(1).some(read => read.ids.some(id => f.job(silent).ghlTagEntry.id === id)));
  // Without readiness (the signed bridge) the outbox read is the HighLevel chip's alone, as on GHL-TRACK-1 (whose
  // 31a8de8 chip also reads claimedUntil, createdAt and expect for overdue and current): never addTags or previousEntryId.
  reads.length = 0;
  await f.board(owner, NOW, {});
  assert.deepEqual(outboxReads().map(read => read.fields), [['status', 'doneAt', 'skipped', 'attempts', 'nextAttemptAt', 'lastError', 'claimedUntil', 'createdAt', 'expect']]);
});

test('a recurring plan visit at its plan price is plan priced: no Price this job and no no_price warning', async () => {
  // What recurring-plan-price.js visitEstimateInput saves through money-service estimate.save: a draft at the plan price, no deposit.
  const planEstimate = amount => ({ estimate: { amount, depositRequired: 0, status: 'draft', scope: 'Synthetic service — recurring visit (Every week).' } });
  const seed = f => {
    f.rows.set('recurringPlans/plan-1', { id: 'plan-1', revision: 'plan-r1', status: 'active', pricePerVisitCents: 15000, lineItems: [{ id: 'recurring-visit', kind: 'service', name: 'Synthetic service (recurring visit)', quantity: 1, unitCents: 15000 }] });
    f.put('plan-visit', { date: '2026-09-23', recurringPlanId: 'plan-1', ...planEstimate(150) });
    f.put('plan-changed', { date: '2026-09-23', recurringPlanId: 'plan-1', ...planEstimate(175) });
    f.put('plan-unpriced', { date: '2026-09-23', recurringPlanId: 'plan-1' });
    f.put('plan-gone', { date: '2026-09-23', recurringPlanId: 'plan-missing', ...planEstimate(150) });
    f.put('not-a-plan', { date: '2026-09-23', ...planEstimate(150) });
    f.put('plan-approved', { date: '2026-09-23', recurringPlanId: 'plan-1', ...approved(150, { estimate: { depositRequired: 0 } }) });
  };
  const f = fixture();
  seed(f);
  const board = await f.board(), ready = id => find(board, id).moneyReady;
  assert.deepEqual(ready('plan-visit'), { checked: true, hasApprovedPrice: false, priceStatus: 'plan', depositRequiredCents: 0, depositPaidCents: 0, depositDueCents: 0, depositVerified: null });
  assert.deepEqual(codes(board, 'plan-visit'), [], 'the plan price is the agreed price: nothing to review');
  for (const id of ['plan-changed', 'plan-gone', 'not-a-plan']) assert.deepEqual([ready(id).priceStatus, codes(board, id)], ['not_approved', ['no_price']], id);
  assert.deepEqual([ready('plan-unpriced').priceStatus, codes(board, 'plan-unpriced')], ['missing', ['no_price']]);
  assert.deepEqual([ready('plan-approved').priceStatus, codes(board, 'plan-approved')], ['approved', []]);
  // Plans that cannot be read leave their visits to the ordinary rules.
  const g = fixture({ readMany: async (collection, ids) => { if (collection === 'recurringPlans') throw new Error('down'); return ids.map(id => structuredClone(g.rows.get(`${collection}/${id}`))).filter(Boolean); } });
  seed(g);
  const fallback = await g.board();
  assert.deepEqual([find(fallback, 'plan-visit').moneyReady.priceStatus, codes(fallback, 'plan-visit')], ['not_approved', ['no_price']]);
  assert.equal(find(fallback, 'plan-approved').moneyReady.priceStatus, 'approved');
  // A plan price never reaches a sales or crew viewer either.
  assert.doesNotMatch(JSON.stringify(await withDispatchReadiness(f.store, sales, [f.job('plan-visit')], [projectDispatchJob(f.job('plan-visit'), ROSTER, NOW)], new Date(NOW))), /moneyReady|15000|"plan"/);
});

// Loads the real employee-suite.js (as tests/schedule-sync-queue.test.mjs does) with a fake /api/highlevel and runs the
// page's calendar sync, then reads the visit it saved back through reminderReadiness.
function suitePage(jobs, answer) {
  const now = Date.parse(NOW), docs = new Map(jobs.map(job => [job.id, structuredClone(job)]));
  const merge = (id, update) => docs.set(id, { ...(docs.get(id) || {}), ...structuredClone(update) });
  const values = new Map([['egc_u', 'ZacB'], ['egc_business_access', 'true'], ['egc_owner', 'true'], ['egc_role', 'owner']]);
  const storage = { getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key) };
  const response = (body, code = 200) => ({ ok: code < 400, status: code, json: async () => body });
  const context = {
    console, URLSearchParams, Intl, Promise, Set, Map, Error, JSON, Math, Number, String, Array, Object,
    Date: class extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } },
    sessionStorage: storage, localStorage: storage, navigator: {}, me: 'ZacB', location: { pathname: '/employee', search: '' },
    jobsCache: jobs.map(job => structuredClone(job)),
    db: {
      collection: () => ({ doc: id => ({ id, set: async update => merge(id, update) }) }),
      runTransaction: async run => run({ get: async ref => ({ exists: docs.has(ref.id), data: () => structuredClone(docs.get(ref.id)) }), set: (ref, update) => merge(ref.id, update) }),
    },
    setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {},
    addEventListener() {}, document: { readyState: 'loading', hidden: false, activeElement: null, addEventListener() {}, querySelector: () => null, querySelectorAll: () => [] },
  };
  context.window = context;
  context.hubFetch = async (url, init = {}) => url === '/api/highlevel' ? response(answer(JSON.parse(init.body))) : response({ ok: false, error: 'unexpected' }, 404);
  const source = readFileSync(new URL('../employee-suite.js', import.meta.url), 'utf8').replace(/\}\)\(\);\s*$/, 'Object.assign(globalThis,{ui:{S,syncJobRecord}});})();');
  vm.runInNewContext(source, context);
  context.ui.S.active = 'availability';
  context.EGCAvailability = { mount() {}, unmount() {} };
  return { sync: id => context.ui.syncJobRecord(id, { manual: true }), job: id => structuredClone(docs.get(id)) };
}

test('the page calendar sync records the reminder tag HighLevel was given, so a Game Plan sync never reads as Reminder set', async () => {
  const visit = (id, extra = {}) => ({ id, type: 'job', customerId: 'c1', customer: 'Synthetic Customer', highlevelContactId: 'contact-1', date: '2026-09-25', time: '09:00', endDate: '2026-09-25', endTime: '11:00', status: 'scheduled', pipelineStatus: 'scheduled', address: '1 Synthetic Way', syncStatus: 'pending', syncIdempotencyKey: randomUUID(), updatedAt: '2026-09-21T10:00:00.000Z', ...extra });
  const handoffRequestId = randomUUID();
  const jobs = [visit('scheduled'), visit('silent', { notify: false }), visit('queued'), visit('failed-tags'), visit('owned-done'), visit('owned-silent', { notify: false }),
    visit('handoff', { sourceWalkthroughId: 'w1', handoffVersion: 1, handoffRequestId, syncIdempotencyKey: `walkthrough-handoff:${handoffRequestId}`, internalNotes: 'Synthetic notes', acceptance: { acceptedAt: '2026-09-20T10:00:00.000Z' } })];
  const tools = [];
  // What functions/api/highlevel.js answers: tool=schedule names its reminder tag (none with Notify off); the Game Plan's
  // job booking adds egc-hub-scheduled and egc-job-scheduled only, yet reports tagSynced.
  const page = suitePage(jobs, body => {
    tools.push([body.job_id, body.tool]);
    const base = { ok: true, contactId: 'contact-1', appointmentId: `appt-${body.job_id}` };
    if (body.tool === 'game_plan') return { ...base, automation: { trigger: 'egc-job-scheduled', tagSynced: true } };
    const reminderTrigger = body.notify === false ? '' : 'egc-reminder-2d';
    if (body.job_id === 'queued') return { ...base, automation: { trigger: 'egc-job-scheduled', reminderTrigger, tagSynced: false, notificationsRequested: true, tagOwner: 'outbox', tagStatus: 'queued' } };
    // EGC_GHL_TAG_OUTBOX on and the visit's entry already told HighLevel: the page mirrors the appointment and adds no tag.
    if (body.job_id.startsWith('owned-')) return { ...base, automation: { trigger: 'egc-job-scheduled', reminderTrigger, tagSynced: true, notificationsRequested: body.notify !== false, tagOwner: 'outbox', tagStatus: 'done' } };
    if (body.job_id === 'failed-tags') return { ...base, automation: { trigger: 'egc-job-scheduled', reminderTrigger, tagSynced: false, notificationsRequested: true } };
    return { ...base, automation: { trigger: 'egc-job-scheduled', reminderTrigger, tagSynced: true, notificationsRequested: body.notify !== false } };
  });
  for (const job of jobs) assert.equal(await page.sync(job.id), true, job.id);
  assert.deepEqual(Object.fromEntries(tools), { scheduled: 'schedule', silent: 'schedule', queued: 'schedule', 'failed-tags': 'schedule', 'owned-done': 'schedule', 'owned-silent': 'schedule', handoff: 'game_plan' });
  const saved = id => { const job = page.job(id); return [job.syncStatus, job.automationTagSynced, job.automationReminderTag, job.automationReminderTaggedAt ?? null]; };
  assert.deepEqual(saved('scheduled'), ['synced', true, 'egc-reminder-2d', NOW]);
  assert.deepEqual(saved('silent'), ['synced', true, '', null]);
  // The tag outbox owns the tags: the page added none, so it records no reminder evidence of its own.
  assert.deepEqual(saved('queued'), ['synced', false, 'outbox', null], 'queued for the outbox: the page gave no tag');
  assert.deepEqual(saved('owned-done'), ['synced', true, 'outbox', null], 'the outbox told HighLevel, not this page');
  assert.deepEqual(saved('owned-silent'), ['synced', true, 'outbox', null]);
  assert.deepEqual(saved('failed-tags'), ['synced', false, 'egc-reminder-2d', null]);
  assert.deepEqual(saved('handoff'), ['synced', true, '', null], 'the Game Plan sync added no reminder tag');
  const reminder = id => reminderReadiness(page.job(id), { now: NOW }).state;
  assert.deepEqual(['scheduled', 'silent', 'queued', 'failed-tags', 'owned-done', 'owned-silent', 'handoff'].map(reminder), ['set', 'off', 'unknown', 'unknown', 'unknown', 'unknown', 'not_told']);
});

test('a page sync that left the tags to the tag outbox is never reminder evidence, also after EGC_GHL_TAG_OUTBOX is rolled back', async () => {
  const entryId = 'gto_' + 'c'.repeat(40), startAt = '2026-09-25T15:00:00.000Z';
  const visit = (id, extra = {}) => ({ id, type: 'job', customerId: 'c1', customer: 'Synthetic Customer', highlevelContactId: 'contact-1', date: '2026-09-25', time: '09:00', endDate: '2026-09-25', endTime: '11:00', status: 'scheduled', pipelineStatus: 'scheduled',
    address: '1 Synthetic Way', syncStatus: 'pending', syncIdempotencyKey: randomUUID(), updatedAt: '2026-09-21T10:00:00.000Z', ghlTagEntry: { id: entryId, kind: 'scheduled', startAt, requestId: randomUUID(), queuedAt: '2026-09-21T09:00:00.000Z' }, ...extra });
  let owner = 'outbox';
  // The reviewer's case: flag on, the visit's entry already told HighLevel (tagStatus done, tagSynced true) and the
  // sync still names the reminder tag the entry carried.
  const page = suitePage([visit('owned'), visit('owned-off', { notify: false })], body => ({ ok: true, contactId: 'contact-1', appointmentId: `appt-${body.job_id}`,
    automation: { trigger: 'egc-job-scheduled', reminderTrigger: 'egc-reminder-2d', tagSynced: true, notificationsRequested: body.notify !== false, ...(owner ? { tagOwner: owner, tagStatus: 'done' } : {}) } }));
  for (const id of ['owned', 'owned-off']) assert.equal(await page.sync(id), true);
  const read = async (id, outbox, entry = { status: 'done', doneAt: NOW, addTags: ['egc-hub-scheduled', 'egc-job-scheduled', 'egc-reminder-2d'], previousEntryId: null }) => {
    const f = fixture({ outbox });
    f.rows.set(`jobs/${id}`, { ...page.job(id), revision: `${id}-r1` });
    f.rows.set(`${GHL_TAG_OUTBOX}/${entryId}`, { id: entryId, revision: 'e1', jobId: id, attempts: 1, nextAttemptAt: NOW, createdAt: NOW, expect: { state: 'active', startAt }, ...entry });
    return find(await f.board(), id).reminder;
  };
  // Flag on: the entry, not the page, decides; it did tell HighLevel the reminder tag.
  assert.deepEqual(await read('owned', true), { state: 'set', source: 'ghl_outbox' });
  // Rolled back: only the page's own evidence is read, and the page added no tag: never "set".
  assert.deepEqual(await read('owned', false), { state: 'unknown', source: 'calendar_sync' });
  assert.deepEqual(reminderReadiness(page.job('owned'), { now: NOW }), { state: 'unknown', source: 'calendar_sync' });
  // Flag on but the entry closed without telling HighLevel: the page's sync is read, and it is not evidence either.
  assert.deepEqual(await read('owned', true, { status: 'done', skipped: 'superseded', addTags: ['egc-reminder-2d'] }), { state: 'unknown', source: 'calendar_sync' });
  // Reminders off: whether HighLevel already has a reminder is not known after the rollback, so never a plain "off".
  assert.deepEqual(await read('owned-off', false), { state: 'unknown', source: 'calendar_sync' });
  for (const later of ['2026-09-23T12:00:00.000Z', '2026-09-24T12:00:00.000Z']) assert.notEqual(reminderReadiness(page.job('owned'), { now: later }).state, 'set');
  // The first page sync after the rollback adds the tags itself (no tagOwner) and records them again.
  owner = null;
  assert.equal(await page.sync('owned'), true);
  assert.deepEqual([page.job('owned').automationReminderTag, page.job('owned').automationReminderTaggedAt], ['egc-reminder-2d', NOW]);
  assert.deepEqual(await read('owned', false), { state: 'set', source: 'calendar_sync' });
});

test('crew DTOs never carry money readiness: /api/field-jobs and /api/crew-jobs canary', async t => {
  const f = fixture(), MONEY = /4321|1234\.56|123456|432187|moneyReady|hasApprovedPrice|deposit(Required|Paid|Due)Cents|depositVerified|priceStatus/;
  const job = f.put('crew-canary', { date: '2026-09-22', time: '13:00', endTime: '15:00', assignedCrew: ['crew.one'], ...approved(4321.87, { estimate: { depositRequired: 1234.56 } }), payment: { amount: 1234.56, verified: true }, serviceType: 'Synthetic cleanout' });
  const board = await f.board();
  assert.equal(find(board, 'crew-canary').moneyReady.depositRequiredCents, 123456, 'the manager board carries the figures');
  const manager = find(board, 'crew-canary');
  for (const dto of [fieldJobProjection({ ...job, ...manager }, [], { viewer: 'crew.one' }), crewJobProjection({ ...job, ...manager }, { viewer: 'crew.one' })]) assert.doesNotMatch(JSON.stringify(dto), MONEY);
  assert.equal(CREW_LISTING_FIELDS.some(field => /^(moneyReady|estimate|payment|deposit|customerApproval)(\.|$)/.test(field)), false, 'the crew listing mask reads no quote, payment or deposit');
  const masked = row => Object.fromEntries(Object.entries(row).filter(([key]) => CREW_LISTING_FIELDS.includes(key)));
  const listingStore = { jobRecords: async fields => [...f.rows].filter(([key]) => key.startsWith('jobs/')).map(([, value]) => ({ ...masked(value), ...Object.fromEntries(fields.filter(field => field in value).map(field => [field, value[field]])), id: value.id, revision: value.revision })) };
  const listing = await crewJobsHandlers({ session: async () => ({ user: 'crew.one', displayName: 'Crew One', role: 'crew' }), storage: () => listingStore, now: () => new Date(NOW) })
    .get({ request: new Request('https://easygaragecleaning.com/api/crew-jobs'), env: { FIREBASE_API_KEY: 'firebase-test-dispatch-ready' } });
  const text = await listing.text();
  assert.ok(JSON.parse(text).jobs.some(row => row.id === 'crew-canary'), 'the crew sees the job');
  assert.doesNotMatch(text, MONEY);
  // Through the real crew-session GET /api/field-jobs.
  t.mock.timers.enable({ apis: ['Date'], now: new Date(NOW) });
  const env = { HUB_SESSION_SECRET: 'synthetic-dispatch-ready-session-secret', FIREBASE_API_KEY: 'firebase-test-dispatch-ready', GOOGLE_CLIENT_ID: 'test', GOOGLE_CLIENT_SECRET: 'test', GOOGLE_REFRESH_TOKEN: 'test',
    HUB_AUTH_USERS_JSON: JSON.stringify({ zacb: { passwordHash: 'test', role: 'owner', displayName: 'Owner' }, 'crew.one': { passwordHash: 'test', role: 'crew', displayName: 'Crew One' } }) };
  const firestore = fieldStorage(t), { id, revision, ...data } = job;
  firestore.put(`jobs/${id}`, data);
  const cookie = (await createHubSessionCookie(env, 'crew.one')).split(';')[0];
  const response = await fieldJobs.onRequestGet({ env, request: new Request(`https://easygaragecleaning.com/api/field-jobs?jobId=${id}`, { headers: { Cookie: cookie } }) });
  assert.equal(response.status, 200);
  assert.doesNotMatch(await response.text(), MONEY);
});
