import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

// Defaults to site/tests; the override also lets this proposed file run before copying it there.
const siteRoot = process.env.EGC_TEST_SITE_ROOT || resolve(dirname(fileURLToPath(import.meta.url)), '..');
const suite = readFileSync(resolve(siteRoot, 'employee-suite.js'), 'utf8');
const walkthrough = readFileSync(resolve(siteRoot, 'crew/gameplan.html'), 'utf8');

function sourceLine(source, prefix) {
  const line = source.split(/\r?\n/).find(value => value.startsWith(prefix));
  assert.ok(line, `Missing executable frontend function: ${prefix}`);
  return line;
}

function sourceBetween(source, start, end) {
  const first = source.indexOf(start), last = source.indexOf(end, first);
  assert.ok(first >= 0 && last > first, `Missing frontend section: ${start}`);
  return source.slice(first, last);
}

function clock() {
  const state = { now: Date.parse('2026-09-06T12:00:00Z') };
  return {
    advance: () => { state.now += 60000; },
    Date: class extends Date {
      constructor(...args) { super(...(args.length ? args : [state.now])); }
      static now() { return state.now; }
    },
  };
}

function memoryStore({ transactional = false } = {}) {
  const records = new Map(), writes = [];
  const write = (key, patch) => {
    const copy = structuredClone(patch);
    records.set(key, { ...(records.get(key) || {}), ...copy });
    writes.push({ key, patch: copy });
  };
  const db = {
    collection: collection => ({
      doc: id => {
        const key = `${collection}/${id}`;
        return {
          key,
          get: async () => ({ exists: records.has(key), data: () => structuredClone(records.get(key) || {}) }),
          set: async patch => write(key, patch),
        };
      },
    }),
  };
  if (transactional) db.runTransaction = async run => {
    const pending = [];
    await run({ get: ref => ref.get(), set: (ref, patch) => pending.push([ref.key, patch]) });
    for (const [key, patch] of pending) write(key, patch);
  };
  return { db, records, writes };
}

function approvalFixture({ failFirstRequest = false } = {}) {
  const store = memoryStore(), time = clock(), requests = [];
  const initial = { id: 'job-1', type: 'job', customer: 'Test Customer', phone: '+19705550123', total: 1000, estimate: { status: 'draft' } };
  store.records.set('jobs/job-1', structuredClone(initial));
  const context = {
    window: {}, jobsCache: [structuredClone(initial)], Date: time.Date,
    db: store.db, askAction: async () => ({ acceptedBy: 'Test Customer' }),
    money: value => String(value), employeeIdentity: () => 'ZacB', render: () => {}, showToast: () => {},
    communicationNote: () => 'Approval', customerCommunicationTypes: { 'estimate-approved': { label: 'Estimate approved' } },
    hubFetch: async (url, options) => {
      const payload = JSON.parse(options.body);
      requests.push({ url, payload, persistedAtDispatch: structuredClone(store.records.get('jobs/job-1')) });
      if (failFirstRequest && requests.length === 1) return new Response(JSON.stringify({ ok: false, error: 'Temporary HighLevel failure' }), { status: 502 });
      return new Response(JSON.stringify({ ok: true, contactId: 'contact-1', automation: { trigger: 'egc-estimate-approved' }, portalInvitation: { jobId: 'job-1', status: 'submitted' } }));
    },
  };
  vm.createContext(context);
  vm.runInContext([
    'function jobs(){return jobsCache}',
    ...['async function patchJob(', 'function cachePortalInvitation(', 'function portalInvitationState(', 'function portalInvitationLabel(', 'async function syncLifecycle(', 'async function syncCustomerCommunication('].map(prefix => sourceLine(suite, prefix)),
    sourceBetween(suite, 'window.opsFinanceAction=', 'function addCalendarMonths'),
  ].join('\n'), context, { filename: 'employee-suite.js#approval-workflow' });
  return { context, requests, store, time };
}

test('Record approval persists the invitation request before the real lifecycle handoff and preserves its original marker', async () => {
  const { context, requests, store, time } = approvalFixture();
  await context.window.opsFinanceAction('job-1', 'accept');
  assert.equal(requests.length, 1);
  const { payload, persistedAtDispatch } = requests[0];
  assert.equal(persistedAtDispatch.estimate.status, 'accepted');
  assert.equal(persistedAtDispatch.customerApproval.status, 'approved');
  assert.equal(persistedAtDispatch.customerPortalInvitationRequestedAt, '2026-09-06T12:00:00.000Z');
  assert.equal(payload.tool, 'lifecycle');
  assert.equal(payload.event, 'estimate-approved');
  assert.equal(payload.job_id, 'job-1');
  assert.equal(store.records.get('jobs/job-1').lifecycleSyncPayload.job_id, 'job-1');
  assert.equal(context.jobsCache[0].customerPortalInvitation.status, 'submitted');

  time.advance();
  await context.window.opsFinanceAction('job-1', 'accept');
  assert.equal(store.records.get('jobs/job-1').estimate.acceptedAt, '2026-09-06T12:01:00.000Z');
  assert.equal(store.records.get('jobs/job-1').customerPortalInvitationRequestedAt, persistedAtDispatch.customerPortalInvitationRequestedAt);
  assert.equal(requests[1].persistedAtDispatch.customerPortalInvitationRequestedAt, persistedAtDispatch.customerPortalInvitationRequestedAt);
});

test('failed approval handoff retains the job ID and persisted invitation request for the real lifecycle retry', async () => {
  const { context, requests, store, time } = approvalFixture({ failFirstRequest: true });
  await context.window.opsFinanceAction('job-1', 'accept');
  const failed = store.records.get('jobs/job-1');
  assert.equal(failed.lifecycleSync.status, 'error');
  assert.equal(failed.lifecycleSyncPayload.job_id, 'job-1');
  assert.equal(failed.estimate.status, 'accepted');
  assert.ok(failed.customerPortalInvitationRequestedAt);

  time.advance();
  await context.syncLifecycle(context.jobsCache[0], failed.lifecycleSync.event, failed.lifecycleSyncPayload);
  assert.equal(requests.length, 2);
  assert.equal(requests[1].payload.job_id, 'job-1');
  assert.equal(requests[1].payload.idempotency_key, requests[0].payload.idempotency_key);
  assert.equal(requests[1].persistedAtDispatch.customerPortalInvitationRequestedAt, failed.customerPortalInvitationRequestedAt);
  assert.equal(store.records.get('jobs/job-1').lifecycleSync.status, 'synced');
  assert.equal(context.jobsCache[0].customerPortalInvitation.status, 'submitted');
});

for (const transactional of [false, true]) {
  test(`signed walkthrough persists approval and its invitation request before handoff using ${transactional ? 'transaction' : 'fallback'} storage`, async () => {
    const store = memoryStore({ transactional }), time = clock(), requests = [], status = {};
    const context = {
      S: { jobId: 'job-1', name: 'Test Customer', phone: '9705550123', email: 'test@example.com', address: 'Test Address', jobDate: '2026-09-10', startTime: '08:00', endTime: '12:00', lockedPrice: 1000, crewSize: 2, approved: true, signature: 'data:synthetic', acceptanceAt: '2026-09-06T10:00:00Z' },
      hubDb: store.db, PHOTO_COUNT: 0, APPTS: [], Date: time.Date,
      normPhone: value => value, recommend: () => 1000, estimatedJobMinutes: () => 240,
      buildJobInstructions: () => ({}), buildInternalNotes: () => 'Crew brief', buildClientChecklists: () => ({}), customerDocId: () => 'customer-1',
      hubScheduleConflict: async () => null, highLevelScheduleConflict: async () => null, readyToSend: () => [], $: () => status,
      writeActive: () => {}, syncWalkthroughPhotos: async () => ({ status: 'synced' }),
      firebase: { firestore: { FieldValue: { increment: () => 1 } } }, localStorage: { removeItem: () => {} }, draftKey: () => 'draft',
      EGCHubAuth: { fetch: async (url, options) => {
        requests.push({ url, payload: JSON.parse(options.body), persistedAtDispatch: structuredClone(store.records.get('jobs/job-1')) });
        return new Response(JSON.stringify({ ok: true, contactId: 'contact-1', portalInvitation: { status: 'submitted' } }));
      } },
    };
    vm.createContext(context);
    vm.runInContext(['function payload(', 'async function saveHubJob(', 'async function sendHighLevel('].map(prefix => sourceLine(walkthrough, prefix)).join('\n'), context, { filename: 'crew/gameplan.html#signed-handoff' });

    await context.sendHighLevel({});
    assert.equal(requests.length, 1);
    const { payload, persistedAtDispatch } = requests[0];
    assert.equal(persistedAtDispatch.estimate.status, 'accepted');
    assert.equal(persistedAtDispatch.acceptance.signatureCaptured, true);
    assert.equal(persistedAtDispatch.customerPortalInvitationRequestedAt, '2026-09-06T12:00:00.000Z');
    assert.equal(payload.tool, 'game_plan');
    assert.equal(payload.job_id, persistedAtDispatch.id);
    assert.equal(payload.terms_accepted, true);

    time.advance();
    await context.sendHighLevel({});
    assert.equal(requests.length, 2);
    assert.equal(store.records.get('jobs/job-1').updatedAt, '2026-09-06T12:01:00.000Z');
    assert.equal(requests[1].persistedAtDispatch.customerPortalInvitationRequestedAt, persistedAtDispatch.customerPortalInvitationRequestedAt);
    assert.equal(store.records.get('jobs/job-1').customerPortalInvitationRequestedAt, persistedAtDispatch.customerPortalInvitationRequestedAt);
  });
}
