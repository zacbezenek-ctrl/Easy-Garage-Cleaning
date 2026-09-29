// GHL-ALIGN. Owner rule (2026-09-28): "don't fuck with GHL, all follow-ups and customer communication goes through
// high level, we just need tracking through high level". A fake HighLevel records every request by method and path:
// a messaging dry run writes nothing to HighLevel, a real send is unchanged, and the 6-month check-in is a HighLevel
// task unless the operations platform reports its own (opt-in) task. Synthetic data, fixed clock, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createApprovedSendService, messagingFlags } from '../functions/_lib/approved-send.js';
import { createGhlMessenger } from '../functions/_lib/ghl-messenger.js';
import { mutateTemplate, readTemplate } from '../functions/_lib/message-template-store.js';
import { messagesHandlers } from '../functions/api/messages.js';
import { runDueMessages } from '../functions/_lib/messaging-scheduler.js';
import { createHubSessionCookie } from '../functions/_lib/hub-session.js';
import { syncFieldCompletion } from '../functions/_lib/field-execution-sync.js';
import { createFieldStore } from '../functions/_lib/field-execution-store.js';
import { storage } from './helpers/field-fixture.mjs';
import { CHECKIN_TASK_BODY, CHECKIN_TASK_TITLE, checkinDueDate, ensureHighLevelCheckin } from '../functions/_lib/highlevel-checkin.js';
import { env as messagingEnv, owner, crew, job, memoryStore, clock, uuid, NOW } from './helpers/messaging-fixture.mjs';

const ORIGIN = 'https://easygaragecleaning.com';
const DRY_RUN_DEFAULT = Object.freeze({ ...messagingEnv, EGC_MESSAGING_DRY_RUN: undefined });
const writesOf = calls => calls.filter(call => call.method !== 'GET').map(call => `${call.method} ${call.path}`);

// Fake HighLevel: every request is recorded as {method, path, body, headers}; only services.leadconnectorhq.com answers.
function recordingGhl({ contacts = { 'contact-1': { id: 'contact-1', locationId: 'location-1', phone: '+19705550123', email: 'synthetic@example.invalid', dnd: false, tags: [] } }, tasks = {}, taskStatus = 201, storeDue = due => due, listGate = null } = {}) {
  const calls = [], state = { contacts, tasks, taskStatus, next: 0, listGate };
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  async function fetcher(url, options = {}) {
    const parsed = new URL(String(url));
    if (parsed.hostname !== 'services.leadconnectorhq.com') throw new Error(`External host refused: ${parsed.hostname}`);
    const method = options.method || 'GET', path = parsed.pathname;
    const headers = Object.fromEntries(Object.entries(options.headers || {}).map(([key, value]) => [key, String(value)]));
    calls.push({ method, path, search: parsed.search, headers, body: options.body ? JSON.parse(options.body) : null });
    if (path === '/contacts/upsert') { state.contacts['contact-new'] ??= { id: 'contact-new', locationId: 'location-1', phone: '+19705550123', email: 'synthetic@example.invalid', tags: [] }; return json({ contact: { id: 'contact-new' } }); }
    let match = /^\/contacts\/([^/]+)$/.exec(path);
    if (match && method === 'GET') { const found = state.contacts[decodeURIComponent(match[1])]; return found ? json({ contact: found }) : json({}, 404); }
    match = /^\/contacts\/([^/]+)\/tasks$/.exec(path);
    if (match) {
      const list = state.tasks[match[1]] ||= [];
      if (method === 'GET') { if (state.listGate) await state.listGate(); return json({ tasks: list }); }
      const posted = JSON.parse(options.body), task = { id: `ghl-task-${++state.next}`, ...posted, dueDate: storeDue(posted.dueDate) };
      list.push(task);
      return typeof state.taskStatus === 'function' ? state.taskStatus(task) : json({ task }, state.taskStatus);
    }
    if (/^\/contacts\/[^/]+\/(tags|notes)$/.test(path)) return json(path.endsWith('notes') ? { note: { id: 'ghl-note-1' } } : { tags: [] });
    if (path === '/conversations/messages') return json({ messageId: `message-${calls.filter(call => call.path === path).length}`, conversationId: 'conversation-1' });
    if (path === '/opportunities/search') return json({ opportunities: [], meta: { total: 0 } });
    if (path === '/opportunities/upsert') return json({ opportunity: { id: 'opportunity-1' } });
    return json({}, 404);
  }
  return { fetcher, calls, state, writes: () => writesOf(calls), tasks: () => calls.filter(call => call.method === 'POST' && /\/tasks$/.test(call.path)) };
}

async function approved(store, kinds, automated = []) {
  for (const kind of kinds) {
    const state = await readTemplate(store, kind);
    await mutateTemplate(store, owner, { action: 'approve', requestId: uuid(), kind, expectedVersion: state.latestVersion, version: 1, hash: state.versions[0].hash }, NOW);
  }
  for (const kind of automated) await mutateTemplate(store, owner, { action: 'set_automation', requestId: uuid(), kind, expectedVersion: 1, enabled: true }, NOW);
}
async function sendService({ settings, jobFields = {} } = {}) {
  const store = memoryStore({ 'jobs/job-1': job(jobFields) }), ghl = recordingGhl(), time = clock(NOW);
  await approved(store, ['on_my_way']);
  const service = createApprovedSendService({ store, messenger: createGhlMessenger({ env: settings, fetcher: ghl.fetcher, clock: time }), clock: time, env: settings });
  return { store, ghl, service };
}
const onMyWay = { kind: 'on_my_way', jobId: 'job-1', overrides: { etaMinutes: 20 } };
async function confirmedSend(f, actor = owner) {
  const preview = await f.service.preview(actor, onMyWay);
  assert.equal(preview.status, 'ready', JSON.stringify(preview));
  return f.service.send(actor, { ...onMyWay, requestId: uuid(), confirmToken: preview.confirmToken });
}

test('a messaging dry run (the default) makes zero HighLevel writes: no contact upsert, tag or message', async () => {
  assert.deepEqual(messagingFlags(DRY_RUN_DEFAULT), { enabled: true, dryRun: true });
  // A customer not yet in HighLevel: a real send would create the contact, which can start "contact created" workflows.
  const unknown = await sendService({ settings: DRY_RUN_DEFAULT, jobFields: { highlevelContactId: '' } });
  const result = await confirmedSend(unknown, crew);
  assert.deepEqual([result.status, result.contact, result.attempts], ['dry_run', 'unknown', 0]);
  assert.deepEqual(unknown.ghl.calls, [], 'an unknown contact stays unknown; HighLevel is not even read');
  const [ledger] = [...unknown.store.rows].filter(([key]) => key.startsWith('message_sends/')).map(([, value]) => value);
  assert.deepEqual([ledger.status, ledger.contactId], ['dry_run', '']);
  // A linked customer is only read, to report DND or a mismatch in the preview.
  const linked = await sendService({ settings: DRY_RUN_DEFAULT });
  const linkedResult = await confirmedSend(linked);
  assert.equal(linkedResult.status, 'dry_run'); assert.equal('contact' in linkedResult, false);
  assert.deepEqual(linked.ghl.writes(), []);
  assert.deepEqual(linked.ghl.calls.map(call => `${call.method} ${call.path}`), ['GET /contacts/contact-1', 'GET /contacts/contact-1']);
  // Messaging switched off: refused before any provider call.
  const off = await sendService({ settings: { ...DRY_RUN_DEFAULT, EGC_MESSAGING_ENABLED: undefined }, jobFields: { highlevelContactId: '' } });
  await assert.rejects(off.service.send(owner, { ...onMyWay, requestId: uuid(), confirmToken: 'x.y' }), error => error.code === 'messaging_disabled');
  assert.deepEqual(off.ghl.calls, []);
});

test('the same approved-send dry run through POST /api/messages and a messaging cron tick writes nothing to HighLevel; portal invitation retries (row 5) ignore the dry run', async () => {
  const store = memoryStore({ 'jobs/job-1': job({ highlevelContactId: '' }), 'jobs/day-1': job({ highlevelContactId: '', date: '2026-09-23', deposit: { amount: 300, paidAmount: 300, verified: true } }),
    'jobs/portal-1': job({ highlevelContactId: '', customerPortalInvitationRequestedAt: '2026-09-22T12:00:00.000Z' }) });
  await approved(store, ['on_my_way', 'day_before_reminder'], ['day_before_reminder']);
  const ghl = recordingGhl(), time = clock(NOW), messenger = settings => createGhlMessenger({ env: settings, fetcher: ghl.fetcher, clock: time });
  const handlers = messagesHandlers({ session: async () => ({ ...owner }), storage: () => store, messenger, now: time });
  const post = async body => (await handlers.post({ request: new Request(`${ORIGIN}/api/messages`, { method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), env: DRY_RUN_DEFAULT })).json();
  const preview = await post({ action: 'preview', requestId: uuid(), ...onMyWay });
  const sent = await post({ action: 'send', requestId: uuid(), ...onMyWay, confirmToken: preview.confirmToken });
  assert.deepEqual([sent.ok, sent.status, sent.contact], [true, 'dry_run', 'unknown']);
  store.jobRecords = async () => Promise.all([...store.rows.keys()].filter(key => key.startsWith('jobs/')).map(key => store.read('jobs', key.slice(5))));
  const service = createApprovedSendService({ store, messenger: messenger(DRY_RUN_DEFAULT), clock: time, env: DRY_RUN_DEFAULT });
  // functions/api/messaging-cron.js always wires the accepted-quote portal invitation retry in; here it only records.
  const invites = [], portalInvite = async jobId => { invites.push(jobId); return { status: 'submitted' }; };
  for (const dryRun of [true, false]) {
    const summary = await runDueMessages({ store, service, flags: messagingFlags(DRY_RUN_DEFAULT), portalInvite }, { now: new Date(NOW), dryRun });
    assert.equal(summary.results.find(row => row.jobId === 'day-1')?.status, dryRun ? 'would_send' : 'dry_run', JSON.stringify(summary.results));
    assert.equal(summary.results.find(row => row.jobId === 'portal-1')?.status, dryRun ? 'would_retry' : 'submitted', JSON.stringify(summary.results));
  }
  assert.deepEqual(ghl.writes(), [], 'the approved-send core wrote nothing to HighLevel');
  // The documented exception: a real (non-preview) tick still runs the portal invitation retry, which sends through HighLevel.
  assert.deepEqual(invites, ['portal-1'], 'only the non-preview tick retried the portal invitation, whatever EGC_MESSAGING_DRY_RUN says');
});

test('a real send is unchanged: the same upsert, verification read and message requests as before GHL-ALIGN', async () => {
  const f = await sendService({ settings: messagingEnv, jobFields: { highlevelContactId: '' } });
  const result = await confirmedSend(f, crew);
  assert.deepEqual([result.status, result.messageId], ['submitted', 'message-1']);
  const body = 'Hi Synthetic, this is Casey with Easy Garage Cleaning. Our crew is on the way and should arrive in about 20 minutes. If anything has changed, just reply here. See you soon!';
  const headers = { Authorization: 'Bearer ghl-synthetic-key', Version: 'v3', Accept: 'application/json', 'Content-Type': 'application/json' };
  assert.deepEqual(f.ghl.calls.map(({ method, path, headers, body }) => ({ method, path, headers, body })), [
    { method: 'POST', path: '/contacts/upsert', headers, body: { locationId: 'location-1', name: 'Synthetic Customer', phone: '+19705550123', email: 'synthetic@example.invalid', source: 'EGC Hub approved message' } },
    { method: 'GET', path: '/contacts/contact-new', headers, body: null },
    { method: 'POST', path: '/conversations/messages', headers: { ...headers, 'Idempotency-Key': f.ghl.calls[2].headers['Idempotency-Key'] }, body: { type: 'SMS', contactId: 'contact-new', message: body, status: 'pending', toNumber: '+19705550123' } },
  ]);
  assert.match(f.ghl.calls[2].headers['Idempotency-Key'], /^egc-msg-[a-f0-9]{40}-1$/);
});

// POST /api/highlevel post_job (the closeout handoff) with a fake operations API. Firestore is left unconfigured, so
// the durable-link read-back is skipped exactly as when storage is unavailable.
const OPS_API = 'https://api.example.test';
const hubEnv = operations => ({
  HUB_SESSION_SECRET: 'synthetic-ghl-align-session', HUB_AUTH_USERS_JSON: JSON.stringify({ ZacB: { passwordHash: 'synthetic', displayName: 'Synthetic Owner', role: 'owner' } }),
  HIGHLEVEL_API_KEY: 'ghl-synthetic-key', HIGHLEVEL_LOCATION_ID: 'location-1',
  ...(operations ? { EGC_OPERATIONS_ENABLED: 'true', EGC_OPERATIONS_API_ORIGIN: OPS_API, EGC_OPERATIONS_PORTAL_SIGNING_SECRET: 's'.repeat(40) } : { EGC_OPERATIONS_ENABLED: 'false' }),
});
async function closeoutHarness(t, { operations, platformTask = null, ghl = recordingGhl(), upstream = null, settings = {}, payload: overrides = {} }) {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(NOW) });
  const { onRequestPost } = await import('../functions/api/highlevel.js'), env = { ...hubEnv(operations), ...settings }, rpc = [];
  t.mock.method(globalThis, 'fetch', async (url, init = {}) => {
    // With a storage fixture, Firestore (and its token exchange) is answered by it.
    if (upstream && /^(?:firestore|oauth2)\.googleapis\.com$/.test(new URL(String(url)).hostname)) return upstream(url, init);
    const target = new URL(String(url));
    if (target.origin === OPS_API && target.pathname === '/operations/rpc') {
      const command = JSON.parse(Buffer.from(JSON.parse(init.body).envelope.split('.')[0], 'base64url')).request.body;
      rpc.push(command);
      return Response.json({ ok: true, authority: 'employee_hub', portalJobId: command.portalJobId, providerSync: 'verified', noteId: 'platform-note-1', outboxId: 'outbox-1', ...(platformTask ? { followupTaskId: platformTask } : {}) });
    }
    return ghl.fetcher(url, init);
  });
  const payload = { tool: 'post_job', job_id: 'job-1', idempotency_key: 'post-job:job-1', highlevel_contact_id: 'contact-1', client: { name: 'Synthetic Customer', phone: '(970) 555-0123', highlevel_contact_id: 'contact-1' }, job: { customer: 'Synthetic Customer', locked_total: 1200 }, sent_at: NOW, ...overrides };
  for (const key of Object.keys(overrides)) if (overrides[key] === undefined) delete payload[key];
  return async () => {
    const cookie = (await createHubSessionCookie(env, 'ZacB')).split(';')[0];
    const response = await onRequestPost({ request: new Request(`${ORIGIN}/api/highlevel`, { method: 'POST', headers: { Origin: ORIGIN, Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }), env });
    return { status: response.status, body: await response.json(), ghl, rpc };
  };
}
const closeout = async (t, options) => (await closeoutHarness(t, options))();
const sixMonths = () => { const due = new Date(NOW); due.setMonth(due.getMonth() + 6); return due.toISOString(); };
const checkinTask = { title: '6-month garage check-in', body: 'Ask how the system is holding up and offer maintenance / Garage Guard if useful.', completed: false, assignedTo: 'w92vfhwm3a8twTIowpQz' };

test('Hub operations off: the closeout creates the HighLevel 6-month check-in task, as main always has', async t => {
  const r = await closeout(t, { operations: false });
  assert.equal(r.status, 200, JSON.stringify(r.body)); assert.deepEqual(r.rpc, []);
  const [task, ...more] = r.ghl.tasks();
  assert.deepEqual(more, []); assert.equal(task.path, '/contacts/contact-1/tasks'); assert.deepEqual(task.body, { ...checkinTask, dueDate: sixMonths() });
  assert.equal(r.body.taskId, 'ghl-task-1');
});

test('Hub operations on and no platform check-in (the new flag unset): the HighLevel task is created, no platform task', async t => {
  const r = await closeout(t, { operations: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.rpc.map(command => [command.command, command.scope]), [['provider.note.ensure', 'post_job']], 'the note goes through the platform, which reports no task of its own');
  const [task, ...more] = r.ghl.tasks();
  // Six months after the saved closeout time (sent_at, as Firestore is unavailable here), read back before writing.
  assert.deepEqual(more, []); assert.equal(task.path, '/contacts/contact-1/tasks'); assert.deepEqual(task.body, { ...checkinTask, dueDate: '2027-03-22T18:00:00.000Z' });
  assert.deepEqual(r.ghl.calls.filter(call => call.path.endsWith('/tasks')).map(call => call.method), ['GET', 'POST']);
  assert.equal(r.body.taskId, 'ghl-task-1'); assert.equal(r.body.noteId, 'platform-note-1');
  assert.ok(!r.ghl.writes().includes('POST /contacts/contact-1/notes'), 'the note is not written twice');
});

test('Hub operations on: a retried closeout days later finds its check-in in HighLevel and adds no second task', async t => {
  const run = await closeoutHarness(t, { operations: true }), first = await run();
  t.mock.timers.setTime(Date.parse(NOW) + 3 * 86400000);
  const retry = await run();
  assert.deepEqual([first.status, retry.status], [200, 200], JSON.stringify(retry.body));
  assert.deepEqual(retry.ghl.tasks().map(call => call.body.dueDate), ['2027-03-22T18:00:00.000Z']);
  assert.deepEqual(retry.ghl.calls.filter(call => call.path.endsWith('/tasks')).map(call => call.method), ['GET', 'POST', 'GET']);
  assert.equal(retry.body.taskId, first.body.taskId);
});

test('Hub operations on: a closeout with no saved completion, completed_at or sent_at writes no check-in task', async t => {
  // A due date taken from the clock would move with every retry, so a later retry could never find the task again.
  const r = await closeout(t, { operations: true, payload: { sent_at: undefined } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.ghl.calls.filter(call => call.path.endsWith('/tasks')), [], 'HighLevel tasks are not even read');
  assert.equal(r.body.taskId, '');
  assert.deepEqual(r.rpc.map(command => command.scope), ['post_job'], 'the closeout note still goes through the platform');
});

test('Hub operations on, with storage: a closeout days after a field completion anchors to the saved completedAt and adds no second task', async t => {
  const fixture = storage(t), firestore = globalThis.fetch, settings = { FIREBASE_API_KEY: 'firebase-test-ghl-align' }, ghl = recordingGhl();
  fixture.put('jobs/job-1', completedFieldJob());
  const env = { ...hubEnv(true), ...settings };
  const field = await syncFieldCompletion(env, 'job-1', { store: createFieldStore(env), syncNote: verifiedNote(null), checkin: (value, input) => ensureHighLevelCheckin(value, input, ghl.fetcher), now: fieldClock() });
  assert.deepEqual([field.status, field.checkinTaskId], ['synced', 'ghl-task-1']);
  assert.deepEqual(ghl.tasks().map(call => call.body.dueDate), ['2027-02-28T16:00:00.000Z']);
  // Three weeks after the completion the office sends the closeout; its sent_at alone would give a different due day.
  const r = await closeout(t, { operations: true, ghl, upstream: firestore, settings });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.taskId, 'ghl-task-1', 'the closeout adopts the field completion\'s task');
  assert.deepEqual(ghl.writes().filter(write => write.endsWith('/tasks')), ['POST /contacts/contact-1/tasks'], 'exactly one check-in task');
  assert.deepEqual(ghl.calls.filter(call => call.path.endsWith('/tasks')).map(call => call.method), ['GET', 'POST', 'GET']);
  assert.equal(fixture.get('jobs/job-1').completedAt, COMPLETED_AT, 'the saved completion is the anchor');
});

test('with the platform check-in opted in, today\'s behaviour stays: the platform task only, never both', async t => {
  const r = await closeout(t, { operations: true, platformTask: 'platform-task-1' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.ghl.tasks(), []); assert.equal(r.body.taskId, 'platform-task-1');
});

// Field completion (the crew's native closeout) follows the same rule through functions/_lib/highlevel-checkin.js.
const COMPLETED_AT = '2026-08-31T16:00:00.000Z';
function completedFieldJob() {
  const requestId = uuid();
  return {
    id: 'job-1', type: 'job', status: 'completed', pipelineStatus: 'completed', customer: 'Synthetic Customer', highlevelContactId: 'contact-1', completedAt: COMPLETED_AT,
    fieldExecution: { completion: { completedAt: COMPLETED_AT } }, completionEvidence: { kind: 'verified_field_execution', requestId },
    fieldCompletionSync: { requestId, status: 'pending', attempts: 0, requestedBy: 'crew1', requestedByName: 'Casey Crew', providerContactId: 'contact-1', title: 'EGC field completion', body: 'Synthetic completion note' },
  };
}
function fieldStore(initial) {
  let row = structuredClone(initial), revision = 1;
  const events = new Map();
  return {
    row: () => structuredClone(row), events,
    readJob: async () => ({ ...structuredClone(row), __updateTime: `r${revision}` }),
    readEvent: async (_jobId, id) => structuredClone(events.get(id) || null),
    commit: async (latest, patch, event) => {
      if (latest.__updateTime !== `r${revision}`) throw Object.assign(new Error('conflict'), { code: 'FIELD_REVISION_CONFLICT' });
      row = { ...row, ...structuredClone(patch) }; revision += 1; if (event) events.set(event.id, structuredClone(event));
    },
  };
}
const fieldEnv = { EGC_OPERATIONS_ENABLED: 'true', EGC_OPERATIONS_SERVICE_AUTH: 'legacy', HIGHLEVEL_API_KEY: 'ghl-synthetic-key', HIGHLEVEL_LOCATION_ID: 'location-1' };
const verifiedNote = followupTaskId => async (_env, _actor, input) => ({ note: { id: 'platform-note-1' }, outboxId: 'outbox-1', providerSync: 'verified', followupTaskId, input });

const fieldClock = () => clock(NOW);

test('field completion with no platform check-in creates one HighLevel task due six months after completion; retries never add a second', async () => {
  const store = fieldStore(completedFieldJob()), ghl = recordingGhl({ taskStatus: () => new Response('{}', { status: 503 }) }), now = fieldClock();
  const checkin = (env, input) => ensureHighLevelCheckin(env, input, ghl.fetcher);
  let result = await syncFieldCompletion(fieldEnv, 'job-1', { store, syncNote: verifiedNote(null), checkin, now });
  assert.deepEqual([result.status, result.errorCode], ['error', 'HIGHLEVEL_CHECKIN_UNAVAILABLE'], 'an unconfirmed task is visible and retryable');
  assert.deepEqual(result.checkin, { status: 'uncertain', attemptId: result.checkin.attemptId, at: NOW, httpStatus: 503 }, 'the claim is released with its result');
  // The lost response did create the task; the manager retry reads before writing and adopts it.
  ghl.state.taskStatus = 201;
  result = await syncFieldCompletion(fieldEnv, 'job-1', { store, syncNote: verifiedNote(null), checkin, now, actor: { user: 'zacb', displayName: 'Synthetic Owner' } });
  assert.deepEqual([result.status, result.checkinTaskId, result.followupTaskId, result.checkin.status], ['synced', 'ghl-task-1', null, 'exists']);
  assert.deepEqual(ghl.writes(), ['POST /contacts/contact-1/tasks']);
  assert.deepEqual(ghl.tasks()[0].body, { title: CHECKIN_TASK_TITLE, body: CHECKIN_TASK_BODY, dueDate: '2027-02-28T16:00:00.000Z', completed: false, assignedTo: 'w92vfhwm3a8twTIowpQz' });
  assert.equal(checkinDueDate(COMPLETED_AT), '2027-02-28T16:00:00.000Z', 'Aug 31 + 6 months clamps to the end of February');
  await syncFieldCompletion(fieldEnv, 'job-1', { store, syncNote: verifiedNote(null), checkin, now });
  assert.deepEqual(ghl.writes(), ['POST /contacts/contact-1/tasks'], 'a synced completion never calls HighLevel again');
});

test('a completion time with milliseconds still dedupes when HighLevel returns the due date at a coarser precision', async () => {
  const completedAt = '2026-08-31T16:03:27.456Z', due = '2027-02-28T16:03:00.000Z';
  assert.equal(checkinDueDate(completedAt), due, 'the due date is sent in whole minutes');
  // HighLevel drops the milliseconds and answers in a local offset; the first response is lost after the task is stored.
  const ghl = recordingGhl({ storeDue: value => new Date(Date.parse(value) - 6 * 3600000).toISOString().replace(/\.\d{3}Z$/, '-06:00'), taskStatus: () => new Response('{}', { status: 504 }) });
  const input = { contactId: 'contact-1', completedAt };
  assert.equal((await ensureHighLevelCheckin(fieldEnv, input, ghl.fetcher)).status, 'uncertain');
  assert.equal(ghl.state.tasks['contact-1'][0].dueDate, '2027-02-28T10:03:00-06:00');
  assert.deepEqual(await ensureHighLevelCheckin(fieldEnv, input, ghl.fetcher), { status: 'exists', taskId: 'ghl-task-1', dueDate: due });
  // Seconds-only precision and a different minute on the same UTC day are the same check-in.
  const coarse = recordingGhl({ tasks: { 'contact-1': [{ id: 'task-7', title: CHECKIN_TASK_TITLE, dueDate: '2027-02-28T16:03:27Z' }, { id: 'task-8', title: 'Other task', dueDate: due }] } });
  assert.deepEqual(await ensureHighLevelCheckin(fieldEnv, input, coarse.fetcher), { status: 'exists', taskId: 'task-7', dueDate: due });
  assert.deepEqual(coarse.writes(), []);
  // Through field completion: the retry after a lost response adopts the stored task.
  const job = completedFieldJob(); job.completedAt = completedAt; job.fieldExecution.completion.completedAt = completedAt;
  const store = fieldStore(job), lossy = recordingGhl({ storeDue: value => value.replace(/\.\d{3}Z$/, 'Z'), taskStatus: () => new Response('{}', { status: 502 }) }), now = fieldClock();
  const checkin = (env, value) => ensureHighLevelCheckin(env, value, lossy.fetcher);
  assert.equal((await syncFieldCompletion(fieldEnv, 'job-1', { store, syncNote: verifiedNote(null), checkin, now })).status, 'error');
  const retried = await syncFieldCompletion(fieldEnv, 'job-1', { store, syncNote: verifiedNote(null), checkin, now });
  assert.deepEqual([retried.status, retried.checkinTaskId], ['synced', 'ghl-task-1']);
  assert.deepEqual(lossy.writes(), ['POST /contacts/contact-1/tasks']);
});

test('the background sync after completion and a manager retry running together create one HighLevel task', async () => {
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; }), reading = new Promise(resolve => { entered = resolve; });
  const store = fieldStore(completedFieldJob()), now = fieldClock();
  const ghl = recordingGhl({ listGate: async () => { entered(); await gate; } });
  const checkin = (env, input) => ensureHighLevelCheckin(env, input, ghl.fetcher);
  const background = syncFieldCompletion(fieldEnv, 'job-1', { store, syncNote: verifiedNote(null), checkin, now });
  await reading;
  assert.equal(store.row().fieldCompletionSync.checkin.status, 'creating', 'the background run claimed the check-in before reading HighLevel');
  ghl.state.listGate = null;
  const managerId = uuid(), manager = await syncFieldCompletion(fieldEnv, 'job-1', { store, syncNote: verifiedNote(null), checkin, now, eventId: managerId, actor: { user: 'zacb', displayName: 'Synthetic Owner' } });
  assert.deepEqual([manager.status, manager.errorCode], ['pending', 'HIGHLEVEL_CHECKIN_IN_PROGRESS']);
  assert.match(manager.message, /Another attempt is creating the HighLevel 6-month check-in task/);
  assert.equal(store.events.get(managerId).completionRequestId, store.row().fieldCompletionSync.requestId, 'the manager request has its receipt');
  release();
  const done = await background;
  assert.deepEqual([done.status, done.checkinTaskId, done.checkin.status], ['synced', 'ghl-task-1', 'created']);
  assert.deepEqual(ghl.writes(), ['POST /contacts/contact-1/tasks']);
  assert.equal(store.row().fieldCompletionSync.status, 'synced');
  // Both claims start from the same revision: the second one's precondition fails, it re-reads, sees the fresh claim and backs off.
  const raced = fieldStore(completedFieldJob()), both = recordingGhl(), commit = raced.commit, outcomes = [];
  let first = null;
  raced.commit = async (latest, patch, event) => {
    if (event === null && !first) await new Promise(resolve => { first = resolve; });
    else if (event === null && outcomes.length === 0) { first(); await new Promise(resolve => setImmediate(resolve)); }
    try { await commit(latest, patch, event); if (event === null) outcomes.push('claimed'); } catch (error) { outcomes.push(error.code); throw error; }
  };
  const call = eventId => syncFieldCompletion(fieldEnv, 'job-1', { store: raced, syncNote: verifiedNote(null), checkin: (env, input) => ensureHighLevelCheckin(env, input, both.fetcher), now, eventId });
  const results = await Promise.all([call(uuid()), call(uuid())]);
  assert.deepEqual(outcomes.slice(0, 2), ['claimed', 'FIELD_REVISION_CONFLICT']);
  assert.deepEqual(both.writes(), ['POST /contacts/contact-1/tasks']);
  assert.ok(results.every(row => ['pending', 'synced'].includes(row.status)), JSON.stringify(results));
  assert.equal(raced.row().fieldCompletionSync.status, 'synced');
});

test('the Firestore field store writes the check-in claim on the job alone, fenced by the job revision', async t => {
  const fixture = storage(t), env = { ...fieldEnv, FIREBASE_API_KEY: 'firebase-test-ghl-align' }, seen = [];
  fixture.put('jobs/job-1', completedFieldJob());
  const store = createFieldStore(env), ghl = recordingGhl({ listGate: async () => { seen.push(fixture.get('jobs/job-1').fieldCompletionSync.checkin); } });
  const result = await syncFieldCompletion(env, 'job-1', { store, syncNote: verifiedNote(null), checkin: (settings, input) => ensureHighLevelCheckin(settings, input, ghl.fetcher), now: fieldClock() });
  assert.deepEqual([result.status, result.checkinTaskId], ['synced', 'ghl-task-1']);
  assert.deepEqual(seen.map(claim => [claim.status, claim.at]), [['creating', NOW]], 'the claim was committed before HighLevel was read');
  assert.equal(fixture.calls.commits, 2, 'one claim, one result');
  assert.equal([...fixture.documents.keys()].filter(key => key.startsWith('jobs/job-1/fieldEvents/')).length, 1, 'the claim adds no history event');
  const stale = await store.readJob('job-1');
  fixture.put('jobs/job-1', { ...fixture.get('jobs/job-1'), customerInstructions: 'Changed meanwhile' });
  await assert.rejects(store.commit(stale, { fieldCompletionSync: { ...stale.fieldCompletionSync, checkin: { status: 'creating', attemptId: uuid(), at: NOW } } }, null), error => error.code === 'FIELD_REVISION_CONFLICT');
  assert.equal(fixture.get('jobs/job-1').fieldCompletionSync.checkin.status, 'created');
});

test('an abandoned check-in claim expires after two minutes, and the next attempt reads HighLevel before writing', async () => {
  const job = completedFieldJob(), now = fieldClock();
  job.fieldCompletionSync.checkin = { status: 'creating', attemptId: uuid(), at: NOW };
  const store = fieldStore(job), ghl = recordingGhl({ tasks: { 'contact-1': [{ id: 'task-3', title: CHECKIN_TASK_TITLE, dueDate: '2027-02-28T16:00:00.000Z' }] } });
  const checkin = (env, input) => ensureHighLevelCheckin(env, input, ghl.fetcher);
  now.advance(119000);
  assert.equal((await syncFieldCompletion(fieldEnv, 'job-1', { store, syncNote: verifiedNote(null), checkin, now })).status, 'pending');
  assert.deepEqual(ghl.calls, [], 'a live claim is never overtaken');
  now.advance(2000);
  const result = await syncFieldCompletion(fieldEnv, 'job-1', { store, syncNote: verifiedNote(null), checkin, now });
  assert.deepEqual([result.status, result.checkinTaskId], ['synced', 'task-3']);
  assert.deepEqual(ghl.writes(), []);
});

test('a check-in that retrying cannot fix is blocked with the cause; a transient one stays a retryable error', async () => {
  const run = async (env, fetcher) => syncFieldCompletion(env, 'job-1', { store: fieldStore(completedFieldJob()), syncNote: verifiedNote(null), checkin: (settings, input) => ensureHighLevelCheckin(settings, input, fetcher), now: fieldClock() });
  const unconfigured = await run({ ...fieldEnv, HIGHLEVEL_API_KEY: undefined }, recordingGhl().fetcher);
  assert.deepEqual([unconfigured.status, unconfigured.errorCode], ['blocked', 'FIELD_COMPLETION_CHECKIN_NOT_CONFIGURED']);
  assert.match(unconfigured.message, /HIGHLEVEL_API_KEY and HIGHLEVEL_LOCATION_ID on Cloudflare Pages/);
  const unlinked = completedFieldJob(); unlinked.highlevelContactId = 'bad/contact'; unlinked.fieldCompletionSync.providerContactId = '';
  const invalid = await syncFieldCompletion(fieldEnv, 'job-1', { store: fieldStore(unlinked), syncNote: verifiedNote(null), checkin: (settings, input) => ensureHighLevelCheckin(settings, input, recordingGhl().fetcher), now: fieldClock() });
  assert.deepEqual([invalid.status, invalid.errorCode], ['blocked', 'FIELD_COMPLETION_CHECKIN_INVALID']);
  const refused = await run(fieldEnv, recordingGhl({ taskStatus: () => new Response('{}', { status: 422 }) }).fetcher);
  assert.deepEqual([refused.status, refused.errorCode, refused.checkin.httpStatus], ['blocked', 'FIELD_COMPLETION_CHECKIN_REJECTED', 422]);
  const unauthorized = await run(fieldEnv, async () => new Response('{}', { status: 401 }));
  assert.deepEqual([unauthorized.status, unauthorized.errorCode], ['blocked', 'FIELD_COMPLETION_CHECKIN_REJECTED']);
  for (const fetcher of [async () => { throw new Error('offline'); }, async () => new Response('{}', { status: 503 }), recordingGhl({ taskStatus: () => new Response('{}', { status: 429 }) }).fetcher]) {
    const transient = await run(fieldEnv, fetcher);
    assert.deepEqual([transient.status, transient.errorCode], ['error', 'HIGHLEVEL_CHECKIN_UNAVAILABLE']);
  }
  // Once the Pages key is set, the same completion syncs.
  const store = fieldStore(completedFieldJob()), ghl = recordingGhl(), now = fieldClock(), checkin = (settings, input) => ensureHighLevelCheckin(settings, input, ghl.fetcher);
  assert.equal((await syncFieldCompletion({ ...fieldEnv, HIGHLEVEL_LOCATION_ID: '' }, 'job-1', { store, syncNote: verifiedNote(null), checkin, now })).status, 'blocked');
  assert.equal((await syncFieldCompletion(fieldEnv, 'job-1', { store, syncNote: verifiedNote(null), checkin, now })).status, 'synced');
  assert.deepEqual(ghl.writes(), ['POST /contacts/contact-1/tasks']);
});

test('field completion with the opted-in platform check-in writes nothing to HighLevel', async () => {
  const store = fieldStore(completedFieldJob()), ghl = recordingGhl();
  const result = await syncFieldCompletion(fieldEnv, 'job-1', { store, syncNote: verifiedNote('platform-task-1'), checkin: (env, input) => ensureHighLevelCheckin(env, input, ghl.fetcher), now: fieldClock() });
  assert.deepEqual([result.status, result.followupTaskId, 'checkinTaskId' in result, 'checkin' in result], ['synced', 'platform-task-1', false, false]);
  assert.deepEqual(ghl.calls, []);
});

test('turning the platform check-in on after an uncertain HighLevel POST: HighLevel is read first and its task is kept', async () => {
  // Flag off: the HighLevel POST lands, but its response is lost.
  const store = fieldStore(completedFieldJob()), ghl = recordingGhl({ taskStatus: () => new Response('{}', { status: 504 }) }), now = fieldClock();
  const checkin = (env, input) => ensureHighLevelCheckin(env, input, ghl.fetcher);
  const lost = await syncFieldCompletion(fieldEnv, 'job-1', { store, syncNote: verifiedNote(null), checkin, now });
  assert.deepEqual([lost.status, lost.checkin.status], ['error', 'uncertain']);
  // The owner turns EGC_OPERATIONS_CHECKIN_TASKS_ENABLED on and a retry follows: egc-api now reports a platform task.
  const retried = await syncFieldCompletion(fieldEnv, 'job-1', { store, syncNote: verifiedNote('platform-task-1'), checkin, now });
  assert.deepEqual([retried.status, retried.checkinTaskId, retried.followupTaskId, retried.duplicateFollowupTaskId, retried.checkin.status], ['synced', 'ghl-task-1', null, 'platform-task-1', 'exists']);
  assert.match(retried.message, /cancel the duplicate platform check-in task in the Action Center/);
  assert.deepEqual(ghl.writes(), ['POST /contacts/contact-1/tasks'], 'the retry only read HighLevel');
  assert.deepEqual(ghl.calls.map(call => call.method), ['GET', 'POST', 'GET']);
  // Had the lost POST never landed, the platform task is accepted and HighLevel is still not written.
  const empty = fieldStore(completedFieldJob()), none = recordingGhl({ taskStatus: () => { throw new Error('offline'); } });
  const before = await syncFieldCompletion(fieldEnv, 'job-1', { store: empty, syncNote: verifiedNote(null), checkin: (env, input) => ensureHighLevelCheckin(env, input, none.fetcher), now });
  assert.equal(before.checkin.status, 'uncertain');
  none.state.tasks['contact-1'] = [];
  const accepted = await syncFieldCompletion(fieldEnv, 'job-1', { store: empty, syncNote: verifiedNote('platform-task-1'), checkin: (env, input) => ensureHighLevelCheckin(env, input, none.fetcher), now });
  assert.deepEqual([accepted.status, accepted.followupTaskId, 'checkinTaskId' in accepted, 'duplicateFollowupTaskId' in accepted, accepted.checkin.status], ['synced', 'platform-task-1', false, false, 'absent']);
  assert.equal(none.calls.filter(call => call.method === 'GET').length, 2);
  // HighLevel unreadable during the retry: nothing is accepted, and the next retry reads again.
  const unread = fieldStore(completedFieldJob()), flaky = recordingGhl({ taskStatus: () => new Response('{}', { status: 504 }) });
  await syncFieldCompletion(fieldEnv, 'job-1', { store: unread, syncNote: verifiedNote(null), checkin: (env, input) => ensureHighLevelCheckin(env, input, flaky.fetcher), now });
  const blind = await syncFieldCompletion(fieldEnv, 'job-1', { store: unread, syncNote: verifiedNote('platform-task-1'), checkin: (env, input) => ensureHighLevelCheckin(env, input, async () => new Response('{}', { status: 503 })), now });
  assert.deepEqual([blind.status, blind.errorCode], ['error', 'HIGHLEVEL_CHECKIN_UNAVAILABLE']);
  const recovered = await syncFieldCompletion(fieldEnv, 'job-1', { store: unread, syncNote: verifiedNote('platform-task-1'), checkin: (env, input) => ensureHighLevelCheckin(env, input, flaky.fetcher), now });
  assert.deepEqual([recovered.status, recovered.checkinTaskId, recovered.duplicateFollowupTaskId], ['synced', 'ghl-task-1', 'platform-task-1']);
  assert.deepEqual(flaky.writes(), ['POST /contacts/contact-1/tasks']);
});

test('the HighLevel check-in helper classifies outcomes and never writes without a verified contact and due date', async () => {
  const ghl = recordingGhl(), call = (env, input) => ensureHighLevelCheckin(env, input, ghl.fetcher);
  assert.deepEqual(await call({}, { contactId: 'contact-1', completedAt: COMPLETED_AT }), { status: 'not_configured' });
  for (const input of [{ contactId: '../x', completedAt: COMPLETED_AT }, { contactId: 'contact-1', completedAt: 'not-a-date' }, { contactId: 'contact-1' }]) assert.deepEqual(await call(fieldEnv, input), { status: 'invalid' });
  assert.deepEqual(ghl.calls, []);
  const existing = recordingGhl({ tasks: { 'contact-1': [{ id: 'task-9', title: CHECKIN_TASK_TITLE, dueDate: '2027-02-28T16:00:00Z' }] } });
  assert.deepEqual(await ensureHighLevelCheckin(fieldEnv, { contactId: 'contact-1', completedAt: COMPLETED_AT }, existing.fetcher), { status: 'exists', taskId: 'task-9', dueDate: '2027-02-28T16:00:00.000Z' });
  assert.deepEqual(existing.writes(), []);
  const rejected = recordingGhl({ taskStatus: () => new Response('{}', { status: 422 }) });
  assert.equal((await ensureHighLevelCheckin(fieldEnv, { contactId: 'contact-1', completedAt: COMPLETED_AT }, rejected.fetcher)).status, 'failed');
  const limited = recordingGhl({ taskStatus: () => new Response('{}', { status: 429 }) });
  assert.deepEqual(await ensureHighLevelCheckin(fieldEnv, { contactId: 'contact-1', completedAt: COMPLETED_AT }, limited.fetcher), { status: 'unavailable', httpStatus: 429 });
  const unreadable = await ensureHighLevelCheckin(fieldEnv, { contactId: 'contact-1', completedAt: COMPLETED_AT }, async () => new Response('{}', { status: 500 }));
  assert.deepEqual(unreadable, { status: 'unavailable', httpStatus: 500 });
  assert.deepEqual(await ensureHighLevelCheckin(fieldEnv, { contactId: 'contact-1', completedAt: COMPLETED_AT }, async () => new Response('{}', { status: 403 })), { status: 'failed', httpStatus: 403 });
  assert.equal((await ensureHighLevelCheckin(fieldEnv, { contactId: 'contact-1', completedAt: COMPLETED_AT }, async url => { throw new Error(`offline ${url}`); })).status, 'unavailable');
  assert.equal(checkinDueDate('2026-01-31T10:30:00.000Z'), '2026-07-31T10:30:00.000Z');
});
