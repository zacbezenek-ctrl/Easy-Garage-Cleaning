// PORTAL-LINKS (owner decision of 2026-10-21): B the server sends the first HighLevel sync and the portal invitation
// right away, for every estimator; A the quote-ready portal link on Send; C a fresh portal link when the job is done;
// D the estimator copies the link. A and C are off until a business user turns their switch on. Synthetic data only;
// every clock is injected and every provider call is simulated.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { firestoreMemory } from './helpers/firestore-memory.mjs';
import { saveWalkthroughHandoff } from '../functions/_lib/walkthrough-handoff.js';
import { HANDOFF_SYNC_WAIT, onRequestPost as highLevelPost, syncSavedHandoff } from '../functions/api/highlevel.js';
import { handoffHandlers } from '../functions/api/walkthrough-handoff.js';
import { PORTAL_MESSAGES, QUOTE_READY_COVER_MIN_DAYS_LEFT, portalLinkPreviews, sendAcceptedQuotePortal, sendPortalLink } from '../functions/_lib/portal-invitation.js';
import { verifyCustomerPortalAccessToken } from '../functions/_lib/customer-portal.js';
import { createHubSessionCookie } from '../functions/_lib/hub-session.js';
import { normalizeMessagingSettings } from '../functions/_lib/messaging-settings.js';
import { portalLinkSwitches, setPortalLinkSwitch } from '../functions/_lib/portal-link-settings.js';
import { messageTemplateHandlers } from '../functions/api/message-templates.js';
import { cronPortalInvite } from '../functions/api/messaging-cron.js';
import { portalLinkRetries, runDueMessages } from '../functions/_lib/messaging-scheduler.js';
import { customerPortalLinkHandler, estimatorOwnsJob } from '../functions/api/customer-portal-link.js';
import { AUTOMATION_REGISTRY, automationById, templateMatches } from '../functions/_lib/automation-registry.js';

// 2026-09-22 is a Tuesday. DAY is noon in Denver; LATE is 11:30 PM the same night; EIGHT is the next 8:01 AM.
const NOW = '2026-09-22T18:00:00.000Z', DAY = NOW, LATE = '2026-09-23T05:30:00.000Z', EIGHT = '2026-09-23T14:01:00.000Z';
const ON = { EGC_STAFF_ROLE_PERMISSIONS: 'true' };
const owner = { user: 'zacb', role: 'owner', businessAccess: true, displayName: 'Synthetic Owner' };
const sales = { user: 'sales.person', role: 'sales', businessAccess: false, displayName: 'Synthetic Sales', source: 'employee-account', staffRoles: ['sales'] };
const otherSales = { ...sales, user: 'other.sales', displayName: 'Synthetic Other Sales' };
const crew = { user: 'crew.person', role: 'crew', businessAccess: false, displayName: 'Synthetic Crew', staffRoles: ['crew'] };
const ENV = { ...ON, HUB_SESSION_SECRET: 'synthetic-portal-links-session-secret-0123456789', HUB_AUTH_USERS_JSON: JSON.stringify({ ZacB: { passwordHash: 'test-only', role: 'owner', displayName: 'Synthetic Owner' } }),
  HIGHLEVEL_API_KEY: 'synthetic', HIGHLEVEL_LOCATION_ID: 'location', FIREBASE_API_KEY: 'firebase-test-portal-links', EGC_OPERATIONS_ENABLED: 'true', EGC_OPERATIONS_SERVICE_AUTH: 'legacy',
  EGC_OPERATIONS_API_ORIGIN: 'https://api.example.test', EGC_OPERATIONS_PORTAL_SIGNING_SECRET: 's'.repeat(40) };
const clockAt = at => () => new Date(at);
const SETTINGS = 'messaging_settings/automation';

// The signed walkthrough handoff of tests/quote-permissions.test.mjs: one customer, one walkthrough, one project.
const plan = () => ({ client: { name: 'Synthetic Customer', phone: '9705550100', email: 'test@example.invalid', address: '100 Fixture Lane', highlevel_contact_id: 'provider1' }, quote: { title: 'Garage reset', total: 1400, deposit: 350, job_date: '2026-09-24', start_time: '09:00', end_time: '12:00', estimated_duration_min: 180 }, acceptance: { accepted_at: '2026-09-22T17:45:00.000Z', accepted_by: 'Synthetic Customer', signature_captured: true, method: 'in_person_signature', terms_version: '2026-10-deposit25' }, signature: 'data:image/png;base64,iVBORw0KGgo=', terms_version: '2026-10-deposit25', terms_accepted: true, photos: { before: 2 }, scope: { keep_items: 'Blue bicycle' }, discovery: { success: 'Park the car' }, logistics: { crew_size: 2 }, internal_notes: 'Synthetic brief', client_checklists: { preJob: [], postJob: [] }, notes: '' });
function handoffFixture() {
  const rows = new Map([
    ['customers/c1', { id: 'c1', revision: 'c1r', name: 'Synthetic Customer', phone: '9705550100', email: 'test@example.invalid', address: '100 Fixture Lane', highlevelContactId: 'provider1' }],
    ['jobs/w1', { id: 'w1', revision: 'w1r', type: 'walkthrough', status: 'scheduled', pipelineStatus: 'scheduled', customerId: 'c1', customer: 'Synthetic Customer', highlevelContactId: 'provider1', date: '2026-09-22', time: '11:00', endTime: '12:00', projectId: 'p1', assignedCrew: ['sales.person'], crewLead: 'sales.person' }],
    ['projects/p1', { id: 'p1', revision: 'p1r', customerId: 'c1', sourceRecordId: 'w1', sourceWalkthroughId: 'w1' }],
  ]);
  let n = 0;
  const roster = [{ id: 'zacb', name: 'Synthetic Owner', role: 'owner' }, { id: 'sales.person', name: 'Synthetic Sales', role: 'sales' }];
  const list = prefix => [...rows].filter(([key]) => key.startsWith(prefix)).map(([, value]) => structuredClone(value));
  const store = { read: async (c, id) => structuredClone(rows.get(`${c}/${id}`) || null), jobs: async () => list('jobs/'), resources: async () => [], customers: async () => list('customers/'), roster: async () => structuredClone(roster),
    commit: async writes => { for (const w of writes) { const old = rows.get(`${w.collection}/${w.id}`); if (w.revision ? old?.revision !== w.revision : !!old) throw Object.assign(new Error('Conflict'), { code: 'dispatch_revision_conflict', status: 409 }); } for (const w of writes) if (!w.verify) rows.set(`${w.collection}/${w.id}`, { ...rows.get(`${w.collection}/${w.id}`), ...structuredClone(w.patch), id: w.id, revision: `r${++n}` }); } };
  const input = () => ({ requestId: randomUUID(), customerId: 'c1', sourceWalkthroughId: 'w1', sourceRevision: rows.get('jobs/w1').revision, plan: plan() });
  return { rows, store, input };
}

// One simulated world: Firestore in memory (tests/helpers/firestore-memory.mjs), the operations bridge (notes and
// appointments, idempotent per request like the platform) and HighLevel (the contact and the message send).
function world(rows = new Map(), { contact = {}, gate = null } = {}) {
  const memory = firestoreMemory(), rpc = [], messages = [], provider = [], notes = new Map(), original = globalThis.fetch;
  for (const [key, row] of rows) { const { revision, ...fields } = row; memory.put(key, fields); }
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname === 'firestore.googleapis.com') return memory.fetch(input, init);
    if (url.href === 'https://api.example.test/operations/rpc') {
      const body = JSON.parse(Buffer.from(JSON.parse(init.body).envelope.split('.')[0], 'base64url').toString()).request.body;
      rpc.push(body);
      if (gate) await gate(body);
      if (body.command === 'schedule.sync_provider') return Response.json({ ok: true, authority: 'employee_hub', portalVisitId: body.portalVisitId, providerSync: 'verified', appointmentId: `appt-${body.portalVisitId}` });
      if (body.command === 'provider.note.ensure') {
        const key = [body.portalJobId, body.scope, body.requestId].join('|'), hash = JSON.stringify([body.providerContactId, body.title, body.body]);
        if (!notes.has(key)) notes.set(key, { hash, noteId: `note-${notes.size + 1}` });
        if (notes.get(key).hash !== hash) return Response.json({ ok: false, error: 'provider_note_request_conflict' }, { status: 409 });
        return Response.json({ ok: true, authority: 'employee_hub', portalJobId: body.portalJobId, noteId: notes.get(key).noteId, outboxId: `outbox-${key}`, providerSync: 'verified' });
      }
      return Response.json({ ok: false, error: 'unexpected_command' }, { status: 400 });
    }
    if (url.hostname !== 'services.leadconnectorhq.com') throw new Error(`unexpected host ${url.hostname}`);
    provider.push(`${init.method || 'GET'} ${url.pathname}`);
    if (url.pathname === '/contacts/provider1') return Response.json({ contact: { id: 'provider1', locationId: 'location', phone: '9705550100', email: 'test@example.invalid', dnd: false, ...contact } });
    if (url.pathname === '/contacts/upsert') return Response.json({ contact: { id: 'provider1' } });
    if (url.pathname === '/conversations/messages') { messages.push(JSON.parse(init.body)); return Response.json({ messageId: `message-${messages.length}`, conversationId: 'conversation-1' }); }
    return Response.json({});
  };
  return { memory, rpc, messages, provider, notes, job: id => memory.get(`jobs/${id}`), put: (key, value) => memory.put(key, value), restore: () => { globalThis.fetch = original; } };
}
const briefs = w => w.rpc.filter(body => body.command === 'provider.note.ensure');
const appointments = (w, id) => w.rpc.filter(body => body.command === 'schedule.sync_provider' && body.portalVisitId === id);
const linkOf = message => new URL((message.message || message.html).match(/https:\/\/\S+?(?=["\s]|$)/)[0]);

// ---------------------------------------------------------------- B: the server's first sync, right away
test('B: the server runs a Sales estimator\'s first HighLevel sync and the portal invitation right after the save, with no Hub session', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(DAY) });
  const f = handoffFixture(), saved = await saveWalkthroughHandoff(f.store, sales, f.input(), NOW, { env: ON }), id = saved.job.id;
  assert.deepEqual([saved.job.syncStatus, f.rows.get(`jobs/${id}`).createdBy], ['pending', 'sales.person'], 'the save leaves the CRM sync pending, as before');
  const w = world(f.rows);
  try {
    const result = await syncSavedHandoff(ENV, sales, { jobId: id, handoffRequestId: saved.requestId });
    assert.equal(result.status, 'synced', JSON.stringify(result));
    assert.equal(result.portalInvitation.status, 'submitted');
    const job = w.job(id);
    assert.deepEqual([job.syncStatus, job.handoffSyncStatus, job.handoffSyncedRequestId, job.handoffSyncClaim ?? null, job.handoffServerSync.status, job.handoffServerSync.by, job.highlevelContactId, job.highlevelAppointmentId],
      ['synced', 'synced', saved.requestId, null, 'synced', 'sales.person', 'provider1', `appt-${id}`]);
    assert.equal(briefs(w).length, 1, 'one pinned internal brief');
    assert.deepEqual(briefs(w)[0].requestId, `walkthrough-handoff:${saved.requestId}`);
    assert.equal(appointments(w, id).length, 1, 'one job appointment');
    assert.equal(w.messages.length, 1);
    assert.match(w.messages[0].message, /^Hi Synthetic, your quote is approved\. Here is your private Easy Garage Cleaning project portal/);
    assert.equal((await verifyCustomerPortalAccessToken(ENV, linkOf(w.messages[0]).searchParams.get('access'), Date.parse(DAY))).jobId, id);
    assert.equal(w.memory.get(`portal_invitations/${id}`).status, 'submitted');
    assert.equal(JSON.stringify(job).includes('access='), false, 'the link never lands on the staff-readable job');
    // The iPad retrying its save (or a manager's Hub load) finds it synced: nothing is written twice.
    const calls = [w.rpc.length, w.provider.length];
    assert.deepEqual(await syncSavedHandoff(ENV, sales, { jobId: id, handoffRequestId: saved.requestId }), { status: 'skipped', reason: 'already_synced' });
    assert.deepEqual([w.rpc.length, w.provider.length], calls);
    // A manager's page sync of the same handoff replays the saved outcome.
    const cookie = (await createHubSessionCookie(ENV, 'ZacB')).split(';')[0];
    const response = await highLevelPost({ env: ENV, request: new Request('https://easygaragecleaning.com/api/highlevel', { method: 'POST', headers: { Origin: 'https://easygaragecleaning.com', Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ tool: 'game_plan', job_id: id, handoff_request_id: saved.requestId }) }) });
    const body = await response.json();
    assert.deepEqual([response.status, body.replayed, body.handoffSync.status, body.noteId, body.portalInvitation.status], [200, true, 'synced', 'note-1', 'submitted']);
    assert.deepEqual([briefs(w).length, appointments(w, id).length, w.messages.length], [1, 1, 1]);
  } finally { w.restore(); }
});

test('B: a manager\'s Hub retry racing the server\'s sync waits for it and replays it: one brief, one appointment, one text', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(DAY) });
  const wait = { ...HANDOFF_SYNC_WAIT };
  Object.assign(HANDOFF_SYNC_WAIT, { attempts: 200, ms: 5 });
  const f = handoffFixture(), saved = await saveWalkthroughHandoff(f.store, sales, f.input(), NOW, { env: ON }), id = saved.job.id;
  // The bridge holds the server's first note until the page request has arrived and found the claim.
  let release, arrived;
  const held = new Promise(resolve => { release = resolve; }), pageArrived = new Promise(resolve => { arrived = resolve; });
  let first = true;
  const w = world(f.rows, { gate: async body => { if (first && body.command === 'provider.note.ensure') { first = false; await held; } } });
  try {
    const server = syncSavedHandoff(ENV, sales, { jobId: id, handoffRequestId: saved.requestId });
    while (!w.job(id).handoffSyncClaim) await new Promise(resolve => setImmediate(resolve));
    assert.equal(w.job(id).handoffSyncClaim.by, 'server');
    const cookie = (await createHubSessionCookie(ENV, 'ZacB')).split(';')[0];
    const page = highLevelPost({ env: ENV, request: new Request('https://easygaragecleaning.com/api/highlevel', { method: 'POST', headers: { Origin: 'https://easygaragecleaning.com', Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ tool: 'game_plan', job_id: id, handoff_request_id: saved.requestId }) }) }).then(response => { arrived(); return response; });
    await new Promise(resolve => setTimeout(resolve, 30));
    release();
    const [result, response] = await Promise.all([server, page]);
    await pageArrived;
    const body = await response.json();
    assert.equal(result.status, 'synced');
    assert.deepEqual([response.status, body.ok, body.replayed], [200, true, true], JSON.stringify(body));
    assert.deepEqual([briefs(w).length, appointments(w, id).length, w.messages.length], [1, 1, 1], 'nothing written twice');
    assert.equal(w.job(id).handoffSyncClaim ?? null, null, 'the claim is released');
  } finally { Object.assign(HANDOFF_SYNC_WAIT, wait); w.restore(); }
});

test('B: a page sync holding the claim makes the server\'s sync stand down without recording anything; an abandoned claim lapses', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(DAY) });
  const f = handoffFixture(), saved = await saveWalkthroughHandoff(f.store, sales, f.input(), NOW, { env: ON }), id = saved.job.id;
  const w = world(f.rows);
  try {
    w.put(`jobs/${id}`, { ...w.job(id), handoffSyncClaim: { by: 'page', id: 'synthetic-claim', at: DAY, requestId: saved.requestId } });
    const result = await syncSavedHandoff(ENV, sales, { jobId: id, handoffRequestId: saved.requestId });
    assert.deepEqual([result.status, result.reason], ['skipped', 'sync_in_progress']);
    assert.deepEqual([w.job(id).syncStatus, briefs(w).length, w.job(id).handoffServerSync], ['pending', 0, undefined], 'the page records its own result');
    // A claim older than ten minutes (a closed tab) is taken over.
    w.put(`jobs/${id}`, { ...w.job(id), handoffSyncClaim: { by: 'page', id: 'synthetic-claim', at: '2026-09-22T17:45:00.000Z', requestId: saved.requestId } });
    assert.equal((await syncSavedHandoff(ENV, sales, { jobId: id, handoffRequestId: saved.requestId })).status, 'synced');
    assert.equal(briefs(w).length, 1);
  } finally { w.restore(); }
});

test('B: a failed server sync records the page\'s backoff so the Hub retry finishes it; a Dispatch move since the save is left to the schedule sync', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(DAY) });
  const f = handoffFixture(), saved = await saveWalkthroughHandoff(f.store, sales, f.input(), NOW, { env: ON }), id = saved.job.id;
  const w = world(f.rows, { gate: async body => { if (body.command === 'provider.note.ensure') throw new Error('bridge down'); } });
  try {
    const result = await syncSavedHandoff(ENV, sales, { jobId: id, handoffRequestId: saved.requestId, now: clockAt(DAY) });
    assert.equal(result.status, 'error');
    const job = w.job(id);
    assert.deepEqual([job.syncStatus, job.syncAttempts, job.syncNextRetryAt, job.handoffServerSync.status, job.handoffSyncClaim ?? null], ['error', 1, '2026-09-22T18:10:00.000Z', 'error', null], 'the page\'s first backoff: ten minutes');
    // Moved by Dispatch: the schedule sync owns it now, not the handoff's first sync.
    w.put(`jobs/${id}`, { ...w.job(id), syncIdempotencyKey: 'dispatch:moved', syncStatus: 'pending' });
    assert.deepEqual(await syncSavedHandoff(ENV, sales, { jobId: id, handoffRequestId: saved.requestId }), { status: 'skipped', reason: 'not_this_handoff' });
  } finally { w.restore(); }
});

test('B: the walkthrough save starts the server sync after the response for every quote author, only while the job is unsynced and only with waitUntil', async () => {
  const f = handoffFixture(), started = [], waits = [];
  const serverSync = async (env, actor, input) => { started.push([actor.user, input.jobId, input.handoffRequestId, typeof input.waitUntil]); return { status: 'synced' }; };
  const post = (actor, body, waitUntil) => handoffHandlers({ session: async () => actor, storage: () => f.store, now: () => new Date(NOW), serverSync, stripe: () => null })
    .post({ request: new Request('https://easygaragecleaning.com/api/walkthrough-handoff', { method: 'POST', headers: { Origin: 'https://easygaragecleaning.com', 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), env: ON, ...(waitUntil ? { waitUntil } : {}) });
  const input = f.input(), response = await post(sales, input, promise => waits.push(promise)), body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  await Promise.all(waits);
  assert.equal(body.serverSync, 'started');
  assert.deepEqual(started, [['sales.person', body.job.id, input.requestId, 'function']]);
  // The same save again (a lost answer) asks again; the sync itself skips a synced job.
  await (await post(sales, input, promise => waits.push(promise))).json(); await Promise.all(waits);
  assert.equal(started.length, 2);
  // A synced job starts nothing; no waitUntil (tests, older runtimes) starts nothing.
  f.rows.set(`jobs/${body.job.id}`, { ...f.rows.get(`jobs/${body.job.id}`), syncStatus: 'synced' });
  const replay = await (await post(sales, input, promise => waits.push(promise))).json();
  assert.deepEqual([replay.serverSync, started.length], [undefined, 2]);
  const g = handoffFixture(), plain = await (await handoffHandlers({ session: async () => owner, storage: () => g.store, now: () => new Date(NOW), serverSync, stripe: () => null })
    .post({ request: new Request('https://easygaragecleaning.com/api/walkthrough-handoff', { method: 'POST', headers: { Origin: 'https://easygaragecleaning.com', 'Content-Type': 'application/json' }, body: JSON.stringify(g.input()) }), env: ON })).json();
  assert.deepEqual([plain.ok, plain.serverSync, started.length], [true, undefined, 2]);
});

test('B: held prices send no invitation at the sync; the release asks the server to send it, under its own rules', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(DAY) });
  const f = handoffFixture(), saved = await saveWalkthroughHandoff(f.store, sales, f.input(), NOW, { env: ON }), id = saved.job.id;
  const hold = { status: 'pending', reason: 'walkthrough_priced', at: NOW, by: 'sales.person', requestId: saved.requestId, items: [{ id: null, name: 'Walkthrough-priced quote' }] };
  f.rows.set(`jobs/${id}`, { ...f.rows.get(`jobs/${id}`), pricesPendingApproval: hold, customerPortalInvitationRequestedAt: null });
  const w = world(f.rows);
  try {
    const result = await syncSavedHandoff(ENV, sales, { jobId: id, handoffRequestId: saved.requestId });
    assert.deepEqual([result.status, result.portalInvitation], ['synced', { status: 'not_approved', reason: 'prices_pending_approval' }]);
    assert.deepEqual([w.messages.length, w.memory.get(`portal_invitations/${id}`)], [0, null], 'nothing sent, nothing recorded');
    // The owner releases the prices (walkthrough-handoff.js releasePatch): the invitation is requested, and the server sends it.
    w.put(`jobs/${id}`, { ...w.job(id), pricesPendingApproval: null, customerPortalInvitationRequestedAt: DAY });
    assert.equal((await sendAcceptedQuotePortal(ENV, id, { requireRequested: true, automatic: true })).status, 'submitted');
    assert.equal(w.messages.length, 1);
  } finally { w.restore(); }
  // The release request hands that send to waitUntil; a refused release asks for nothing.
  const invited = [], waits = [];
  const release = (actor, job) => handoffHandlers({ session: async () => actor, storage: () => f.store, now: () => new Date(NOW), invite: async (env, jobId) => { invited.push(jobId); } })
    .post({ request: new Request('https://easygaragecleaning.com/api/walkthrough-handoff', { method: 'POST', headers: { Origin: 'https://easygaragecleaning.com', 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'prices.release', requestId: randomUUID(), jobId: job.id, expectedRevision: job.revision }) }), env: { ...ON, EGC_QUOTE_BUILDER_ENABLED: 'true' }, waitUntil: promise => waits.push(promise) });
  f.rows.set(`jobs/${id}`, { ...f.rows.get(`jobs/${id}`), pricesPendingApproval: hold });
  const refused = await release(sales, f.rows.get(`jobs/${id}`));
  assert.equal(refused.status, 409);
  const done = await (await release(owner, f.rows.get(`jobs/${id}`))).json();
  await Promise.all(waits);
  assert.deepEqual([done.released, invited], [true, [id]]);
});

// B: a recorded approval (/api/money estimate.record_approval) hands the invitation to waitUntil: tests/money-api.test.mjs.
test('B: an approval in quiet hours is held, and the first automatic retry after 8 AM sends it once', async () => {
  const w = world(new Map([['jobs/job-1', { id: 'job-1', type: 'job', customer: 'Synthetic Pat', phone: '(970) 555-0100', email: 'test@example.invalid', highlevelContactId: 'provider1', estimate: { status: 'accepted', amount: 1400 }, customerPortalInvitationRequestedAt: LATE }]]));
  try {
    const held = await sendAcceptedQuotePortal(ENV, 'job-1', { requireRequested: true, automatic: true, now: clockAt(LATE) });
    assert.deepEqual([held.status, held.reason, held.notBefore, w.messages.length], ['deferred', 'quiet_hours', '2026-09-23T14:00:00.000Z', 0]);
    const sent = await cronPortalInvite(ENV, clockAt(EIGHT))('job-1', new Date(EIGHT), normalizeMessagingSettings(null));
    assert.deepEqual([sent.status, w.messages.length], ['submitted', 1]);
    assert.equal((await sendAcceptedQuotePortal(ENV, 'job-1', { requireRequested: true, automatic: true, now: clockAt(EIGHT) })).status, 'submitted');
    assert.equal(w.messages.length, 1);
  } finally { w.restore(); }
});

// ---------------------------------------------------------------- A: the quote-ready link on Send
const quoteJob = (extra = {}) => ({ id: 'job-1', type: 'job', customer: 'Synthetic Pat Customer', phone: '(970) 555-0100', email: 'test@example.invalid', highlevelContactId: 'provider1', customerId: 'c1', status: 'scheduled', pipelineStatus: 'scheduled',
  estimate: { status: 'sent', number: 'EST-1', revision: 1, amountCents: 140000, amount: 1400 }, ...extra });
const linkWorld = (job = quoteJob(), settings = { portalLinkQuoteReady: true, portalLinkJobDone: true }, options) => world(new Map([['jobs/job-1', job], ...(settings ? [[SETTINGS, settings]] : [])]), options);
const ledger = (w, kind) => w.memory.get(`portal_link_sends/${kind}~job-1`);

test('A: off by default, the quote-ready link sends nothing and records nothing', async () => {
  const w = linkWorld(quoteJob(), null);
  try {
    assert.deepEqual(await sendPortalLink(ENV, 'job-1', 'quote_ready', { automatic: true, now: clockAt(DAY) }), { kind: 'quote_ready', status: 'off', reason: 'owner_switch_off' });
    assert.deepEqual([w.messages.length, w.provider.length, ledger(w, 'quote_ready'), w.job('job-1').portalLinks], [0, 0, null, undefined]);
    assert.deepEqual([normalizeMessagingSettings(null).portalLinkQuoteReady, normalizeMessagingSettings(null).portalLinkJobDone], [false, false]);
    // A record the owner never touched also leaves both off; an unreadable switch fails closed.
    w.put(SETTINGS, { paused: false });
    assert.equal((await sendPortalLink(ENV, 'job-1', 'quote_ready', { automatic: true, now: clockAt(DAY) })).status, 'off');
    w.put(SETTINGS, { portalLinkQuoteReady: 'yes' });
    assert.deepEqual(await sendPortalLink(ENV, 'job-1', 'quote_ready', { automatic: true, now: clockAt(DAY) }), { kind: 'quote_ready', status: 'off', reason: 'messaging_settings_invalid' });
    assert.equal(w.messages.length, 0);
  } finally { w.restore(); }
});

test('A: switched on, the quote-ready link is texted once with the exact text and recorded on the job with the masked number', async () => {
  const w = linkWorld();
  try {
    const sent = await sendPortalLink(ENV, 'job-1', 'quote_ready', { automatic: true, now: clockAt(DAY) });
    assert.deepEqual([sent.status, sent.channel, sent.recipient, sent.kind], ['submitted', 'SMS', '(•••) •••-0100', 'quote_ready']);
    assert.equal(w.messages.length, 1);
    const url = linkOf(w.messages[0]);
    assert.equal(w.messages[0].message, PORTAL_MESSAGES.quote_ready.sms('Synthetic', url.href));
    assert.equal(w.messages[0].message, `Hi Synthetic, your Easy Garage Cleaning quote is ready. You can review it, approve it and pay the deposit in your private project portal: ${url.href}`);
    assert.equal(templateMatches(automationById(AUTOMATION_REGISTRY, 'hub.portal_quote_ready').templateText, w.messages[0].message), true);
    const token = await verifyCustomerPortalAccessToken(ENV, url.searchParams.get('access'), Date.parse(DAY));
    assert.equal(token.jobId, 'job-1');
    assert.ok(token.expiresAt >= Date.parse(DAY) + 29 * 86400000, 'a 30-day link');
    const mirror = w.job('job-1').portalLinks.quote_ready;
    assert.deepEqual([mirror.kind, mirror.status, mirror.channel, mirror.recipient, mirror.completedAt, mirror.attempts], ['quote_ready', 'submitted', 'SMS', '(•••) •••-0100', DAY, 1]);
    assert.doesNotMatch(JSON.stringify(w.job('job-1')), /access=/);
    // Once per job: a resend, a retry or a later send of a new revision never texts again.
    assert.equal((await sendPortalLink(ENV, 'job-1', 'quote_ready', { automatic: true, now: clockAt(DAY) })).status, 'submitted');
    w.put('jobs/job-1', { ...w.job('job-1'), estimate: { ...w.job('job-1').estimate, revision: 2 } });
    assert.equal((await sendPortalLink(ENV, 'job-1', 'quote_ready', { now: clockAt(DAY) })).status, 'submitted');
    assert.equal(w.messages.length, 1);
  } finally { w.restore(); }
  const email = linkWorld(quoteJob({ phone: '' }));
  try {
    assert.equal((await sendPortalLink(ENV, 'job-1', 'quote_ready', { automatic: true, now: clockAt(DAY) })).channel, 'Email');
    const entry = automationById(AUTOMATION_REGISTRY, 'hub.portal_quote_ready_email');
    assert.deepEqual([email.messages[0].subject, templateMatches(entry.templateText, email.messages[0].html)], [entry.subject, true]);
    assert.equal(email.job('job-1').portalLinks.quote_ready.recipient, 't•••@example.invalid');
  } finally { email.restore(); }
});

test('A: the quote-ready link skips DND, notifications off, business projects, closed or approved quotes and held prices, and waits out quiet hours and the pause', async () => {
  const cases = [
    [{ job: quoteJob({ notify: false }) }, { status: 'suppressed', reason: 'job_notifications_off' }],
    [{ contact: { dnd: true } }, { status: 'suppressed', reason: 'contact_dnd' }],
    [{ job: quoteJob({ businessAccountId: 'a1'.repeat(16) }) }, { status: 'suppressed', reason: 'business_account_job' }],
    [{ job: quoteJob({ status: 'cancelled', pipelineStatus: 'cancelled' }) }, { status: 'not_eligible', reason: 'job_closed' }],
    [{ job: quoteJob({ estimate: { status: 'accepted', amountCents: 140000, amount: 1400 } }) }, { status: 'not_eligible', reason: 'quote_already_approved' }],
    [{ job: quoteJob({ estimate: { status: 'draft', amountCents: 140000 } }) }, { status: 'not_eligible', reason: 'quote_not_sent' }],
    [{ job: quoteJob({ pricesPendingApproval: { status: 'pending', reason: 'draft_prices', items: [] } }) }, { status: 'not_eligible', reason: 'prices_pending_approval' }],
  ];
  for (const [{ job = quoteJob(), contact = {} }, expected] of cases) {
    const w = linkWorld(job, undefined, { contact });
    try {
      const state = await sendPortalLink(ENV, 'job-1', 'quote_ready', { automatic: true, now: clockAt(DAY) });
      assert.deepEqual([state.status, state.reason], [expected.status, expected.reason], JSON.stringify(expected));
      assert.equal(w.messages.length, 0);
    } finally { w.restore(); }
  }
  const w = linkWorld();
  try {
    const night = await sendPortalLink(ENV, 'job-1', 'quote_ready', { automatic: true, now: clockAt(LATE) });
    assert.deepEqual([night.status, night.reason, night.notBefore, night.attempts], ['deferred', 'quiet_hours', '2026-09-23T14:00:00.000Z', 0]);
    assert.deepEqual(w.job('job-1').portalLinks.quote_ready.status, 'deferred');
    // The cron's retry (and the Hub's) picks the waiting link up at its notBefore, not before.
    assert.deepEqual(portalLinkRetries([{ ...w.job('job-1'), id: 'job-1' }], { now: new Date(LATE) }), []);
    assert.deepEqual(portalLinkRetries([{ ...w.job('job-1'), id: 'job-1' }], { now: new Date(EIGHT) }), [{ kind: 'portal_invitation', jobId: 'job-1', anchor: 'quote_ready', step: 0, link: 'quote_ready' }]);
    const morning = await cronPortalInvite(ENV, clockAt(EIGHT))('job-1', new Date(EIGHT), normalizeMessagingSettings({ portalLinkQuoteReady: true }), 'quote_ready');
    assert.deepEqual([morning.status, w.messages.length], ['submitted', 1]);
    // The owner switches it off before a waiting link goes out: it stays unsent.
  } finally { w.restore(); }
  const paused = linkWorld(quoteJob(), { portalLinkQuoteReady: true, paused: true });
  try {
    const state = await sendPortalLink(ENV, 'job-1', 'quote_ready', { automatic: true, now: clockAt(DAY) });
    assert.deepEqual([state.status, state.reason, paused.messages.length], ['deferred', 'messaging_paused', 0]);
    paused.put(SETTINGS, { portalLinkQuoteReady: false, paused: false });
    assert.equal((await sendPortalLink(ENV, 'job-1', 'quote_ready', { automatic: true, now: clockAt(DAY) })).status, 'off');
    assert.equal(paused.messages.length, 0);
  } finally { paused.restore(); }
  // A waiting link whose quote was approved meanwhile is closed out, so the retries stop.
  const approved = linkWorld();
  try {
    await sendPortalLink(ENV, 'job-1', 'quote_ready', { automatic: true, now: clockAt(LATE) });
    approved.put('jobs/job-1', { ...approved.job('job-1'), estimate: { status: 'accepted', amountCents: 140000, amount: 1400 } });
    const closed = await sendPortalLink(ENV, 'job-1', 'quote_ready', { automatic: true, now: clockAt(EIGHT) });
    assert.deepEqual([closed.status, closed.reason, approved.job('job-1').portalLinks.quote_ready.status, approved.messages.length], ['not_eligible', 'quote_already_approved', 'not_eligible', 0]);
    assert.deepEqual(portalLinkRetries([{ ...approved.job('job-1'), id: 'job-1' }], { now: new Date(EIGHT) }), []);
  } finally { approved.restore(); }
});

test('A: a delivered quote-ready link means the "quote is approved" text is not sent again; never delivered (or expiring), it goes as today', async () => {
  const approve = w => w.put('jobs/job-1', { ...w.job('job-1'), estimate: { status: 'accepted', amount: 1400, amountCents: 140000 }, customerPortalInvitationRequestedAt: DAY });
  // Delivered: the approval records 'covered' and texts nothing; automatic retries leave it; it is never sent twice.
  const covered = linkWorld();
  try {
    assert.equal((await sendPortalLink(ENV, 'job-1', 'quote_ready', { automatic: true, now: clockAt(DAY) })).status, 'submitted');
    approve(covered);
    const state = await sendAcceptedQuotePortal(ENV, 'job-1', { requireRequested: true, automatic: true, now: clockAt(DAY) });
    assert.deepEqual([state.status, state.reason, state.coveredBy, state.attempts], ['covered', 'quote_ready_link_delivered', { kind: 'quote_ready', sentAt: DAY, channel: 'SMS' }, 0]);
    assert.deepEqual([covered.messages.length, covered.job('job-1').customerPortalInvitation.status], [1, 'covered']);
    assert.equal((await sendAcceptedQuotePortal(ENV, 'job-1', { requireRequested: true, automatic: true, now: clockAt(DAY) })).status, 'covered');
    assert.equal(covered.messages.length, 1);
    const { portalRetries } = await import('../functions/_lib/messaging-scheduler.js');
    assert.deepEqual(portalRetries([{ ...covered.job('job-1'), id: 'job-1' }], { now: new Date(EIGHT) }), [], 'the cron never retries a covered invitation');
  } finally { covered.restore(); }
  // Never delivered (the switch was off): the approved invitation goes out exactly as before.
  const off = linkWorld(quoteJob(), null);
  try {
    assert.equal((await sendPortalLink(ENV, 'job-1', 'quote_ready', { automatic: true, now: clockAt(DAY) })).status, 'off');
    approve(off);
    const state = await sendAcceptedQuotePortal(ENV, 'job-1', { requireRequested: true, automatic: true, now: clockAt(DAY) });
    assert.equal(state.status, 'submitted');
    assert.match(off.messages[0].message, /^Hi Synthetic, your quote is approved\./);
  } finally { off.restore(); }
  // Not delivered (DND at quote time, the contact opted back in since): the invitation goes.
  const dnd = linkWorld(quoteJob(), undefined, { contact: { dnd: true } });
  try {
    assert.equal((await sendPortalLink(ENV, 'job-1', 'quote_ready', { automatic: true, now: clockAt(DAY) })).status, 'suppressed');
  } finally { dnd.restore(); }
  // Delivered, but the link has fewer than QUOTE_READY_COVER_MIN_DAYS_LEFT days to run: a fresh invitation goes.
  const old = linkWorld();
  try {
    const sentAt = new Date(Date.parse(DAY) - (30 - QUOTE_READY_COVER_MIN_DAYS_LEFT + 1) * 86400000).toISOString();
    assert.equal((await sendPortalLink(ENV, 'job-1', 'quote_ready', { automatic: true, now: clockAt(sentAt) })).status, 'submitted');
    approve(old);
    assert.equal((await sendAcceptedQuotePortal(ENV, 'job-1', { requireRequested: true, automatic: true, now: clockAt(DAY) })).status, 'submitted');
    assert.deepEqual(old.messages.map(message => message.message.split('.')[0]), ['Hi Synthetic, your Easy Garage Cleaning quote is ready', 'Hi Synthetic, your quote is approved']);
  } finally { old.restore(); }
});

// ---------------------------------------------------------------- C: a fresh link when the job is done
const doneJob = (extra = {}) => quoteJob({ status: 'completed', pipelineStatus: 'completed', completedAt: DAY, estimate: { status: 'accepted', amount: 1400, amountCents: 140000 }, total: 1400, ...extra });

test('C: off by default; on, the job-done link is sent once with the balance-due or the nothing-due wording and a fresh 30-day link', async () => {
  const off = linkWorld(doneJob(), null);
  try {
    assert.deepEqual(await sendPortalLink(ENV, 'job-1', 'job_done', { automatic: true, now: clockAt(DAY) }), { kind: 'job_done', status: 'off', reason: 'owner_switch_off' });
    assert.deepEqual([off.messages.length, ledger(off, 'job_done')], [0, null]);
  } finally { off.restore(); }
  const due = linkWorld(doneJob({ payment: { amount: 350, verified: true } }));
  try {
    const state = await sendPortalLink(ENV, 'job-1', 'job_done', { automatic: true, now: clockAt(DAY) });
    assert.deepEqual([state.status, state.variant], ['submitted', 'balance_due']);
    const url = linkOf(due.messages[0]);
    assert.equal(due.messages[0].message, `Hi Synthetic, your Easy Garage Cleaning job is done — thank you! Your remaining balance, receipts and photos are in your private project portal: ${url.href}`);
    assert.equal(templateMatches(automationById(AUTOMATION_REGISTRY, 'hub.portal_job_done').templateText, due.messages[0].message), true);
    assert.ok((await verifyCustomerPortalAccessToken(ENV, url.searchParams.get('access'), Date.parse(DAY))).expiresAt >= Date.parse(DAY) + 29 * 86400000);
    assert.deepEqual([due.job('job-1').portalLinks.job_done.status, due.job('job-1').portalLinks.job_done.variant], ['submitted', 'balance_due']);
  } finally { due.restore(); }
  const paid = linkWorld(doneJob({ status: 'paid', pipelineStatus: 'paid', payment: { amount: 1400, verified: true } }));
  try {
    assert.equal((await sendPortalLink(ENV, 'job-1', 'job_done', { automatic: true, now: clockAt(DAY) })).variant, 'paid');
    assert.equal(paid.messages[0].message, `Hi Synthetic, your Easy Garage Cleaning job is done — thank you! Your receipts and job details are in your private project portal: ${linkOf(paid.messages[0]).href}`);
    assert.equal(templateMatches(automationById(AUTOMATION_REGISTRY, 'hub.portal_job_done_paid').templateText, paid.messages[0].message), true);
  } finally { paid.restore(); }
});

test('C: a reopened and re-completed job is not texted again; not-done, cancelled, business and opted-out jobs are skipped', async () => {
  const w = linkWorld(doneJob());
  try {
    assert.equal((await sendPortalLink(ENV, 'job-1', 'job_done', { automatic: true, now: clockAt(DAY) })).status, 'submitted');
    w.put('jobs/job-1', { ...w.job('job-1'), status: 'in_progress', pipelineStatus: 'in_progress', completedAt: null });
    assert.deepEqual((await sendPortalLink(ENV, 'job-1', 'job_done', { automatic: true, now: clockAt(DAY) })).reason, 'job_not_done', 'reopened: not done');
    assert.equal(ledger(w, 'job_done').status, 'submitted', 'the one recorded send is kept');
    w.put('jobs/job-1', { ...w.job('job-1'), status: 'completed', pipelineStatus: 'completed', completedAt: EIGHT });
    assert.equal((await sendPortalLink(ENV, 'job-1', 'job_done', { automatic: true, now: clockAt(EIGHT) })).status, 'submitted');
    assert.equal(w.messages.length, 1);
  } finally { w.restore(); }
  for (const [job, expected] of [[quoteJob(), ['not_eligible', 'job_not_done']], [doneJob({ status: 'cancelled', pipelineStatus: 'cancelled' }), ['not_eligible', 'job_closed']],
    [doneJob({ businessAccountId: 'b2'.repeat(16) }), ['suppressed', 'business_account_job']], [doneJob({ notify: false }), ['suppressed', 'job_notifications_off']], [{ ...doneJob(), type: 'walkthrough' }, ['not_eligible', 'job_not_done']]]) {
    const s = linkWorld(job);
    try {
      const state = await sendPortalLink(ENV, 'job-1', 'job_done', { automatic: true, now: clockAt(DAY) });
      assert.deepEqual([state.status, state.reason, s.messages.length], [...expected, 0], JSON.stringify(expected));
    } finally { s.restore(); }
  }
});

test('C: the crew\'s completion hands the job-done link to waitUntil after the commit', () => {
  const source = readFileSync(new URL('../functions/api/field-jobs.js', import.meta.url), 'utf8');
  const hook = source.slice(source.indexOf("if (input.action === 'complete' && typeof handlerContext.waitUntil === 'function') {"), source.indexOf('// A failed or skipped count stays'));
  assert.match(hook, /handlerContext\.waitUntil\(syncFieldCompletion\(env, job\.id, \{ actor: ctx\.session \}\)\);/);
  assert.match(hook, /sendPortalLink\(env, job\.id, 'job_done', \{ automatic: true \}\)/);
  assert.ok(source.indexOf('await ctx.store.commit(job, result.patch') < source.indexOf("sendPortalLink(env, job.id, 'job_done'"), 'only after the completion is saved');
});

// ---------------------------------------------------------------- D: the estimator copies the link
test('D: the estimator who owns the quote copies its 30-day portal link and the copy is recorded; another estimator gets 403; the office keeps its button', async () => {
  const rows = new Map([
    ['jobs/job-1', { ...quoteJob(), createdBy: 'sales.person', quoteDraft: { createdBy: 'sales.person' }, sourceWalkthroughId: 'w1' }],
    ['jobs/job-2', { ...quoteJob(), id: 'job-2', createdBy: 'zacb', quoteDraft: { createdBy: 'zacb' }, sourceWalkthroughId: 'w1' }],
    ['jobs/job-3', { ...quoteJob(), id: 'job-3', createdBy: 'zacb' }],
    ['jobs/w1', { id: 'w1', type: 'walkthrough', customerId: 'c1', assignedCrew: ['visit.estimator'], crewLead: 'visit.estimator', status: 'completed' }],
  ]);
  const w = world(rows);
  const call = async (actor, jobId) => {
    const response = await customerPortalLinkHandler({ now: clockAt(DAY), session: async () => actor })({ env: ENV, request: new Request('https://easygaragecleaning.com/api/customer-portal-link', { method: 'POST', headers: { Origin: 'https://easygaragecleaning.com' }, body: JSON.stringify({ job_id: jobId }) }) });
    return { status: response.status, body: await response.json() };
  };
  try {
    const mine = await call(sales, 'job-1');
    assert.equal(mine.status, 200, JSON.stringify(mine.body));
    const url = new URL(mine.body.url);
    assert.deepEqual([url.pathname, mine.body.expiresInDays, (await verifyCustomerPortalAccessToken(ENV, url.searchParams.get('access'), Date.parse(DAY))).jobId], ['/api/customer-portal-session', 30, 'job-1']);
    assert.deepEqual(w.job('job-1').portalLinkCopies, [{ by: 'sales.person', at: DAY, role: 'estimator' }]);
    assert.doesNotMatch(JSON.stringify(w.job('job-1')), /access=/);
    // The visit's assigned estimator owns a quote built from it, whoever saved the quote.
    const visitEstimator = { ...sales, user: 'visit.estimator' };
    assert.equal((await call(visitEstimator, 'job-2')).status, 200);
    assert.deepEqual(w.job('job-2').portalLinkCopies.map(row => row.by), ['visit.estimator']);
    // Another estimator's quote, a crew member, a signed-out caller: refused, nothing recorded.
    for (const [actor, jobId, status] of [[otherSales, 'job-1', 403], [sales, 'job-3', 403], [crew, 'job-1', 403], [null, 'job-1', 401]]) {
      const refused = await call(actor, jobId);
      assert.equal(refused.status, status, `${actor?.user} ${jobId}`);
      if (status === 403 && actor !== crew) assert.equal(refused.body.code, 'PORTAL_LINK_NOT_YOURS');
    }
    assert.equal(w.job('job-1').portalLinkCopies.length, 1);
    assert.equal(w.job('job-3').portalLinkCopies, undefined);
    // Business users keep their button on every job, recorded the same way.
    const office = await call(owner, 'job-3');
    assert.equal(office.status, 200);
    assert.deepEqual(w.job('job-3').portalLinkCopies, [{ by: 'zacb', at: DAY, role: 'office' }]);
    assert.deepEqual([w.job('job-3').customerPortalLinkCreatedBy, w.job('job-3').customerPortalEnabled], ['zacb', true]);
    // A business-account project never gets a homeowner link, from anyone.
    w.put('jobs/job-1', { ...w.job('job-1'), businessAccountId: 'a1'.repeat(16) });
    assert.equal((await call(sales, 'job-1')).status, 409);
  } finally { w.restore(); }
  assert.equal(await estimatorOwnsJob(ENV, sales, { id: 'x', createdBy: 'zacb' }, { read: async () => null }), false);
  assert.equal(await estimatorOwnsJob(ENV, sales, { id: 'x', createdBy: ' Sales.Person ' }, { read: async () => null }), true, 'usernames compare without case or spaces');
});

test('D: an estimator\'s copy that cannot be recorded creates no link', async () => {
  const w = world(new Map([['jobs/job-1', { ...quoteJob(), createdBy: 'sales.person' }]]));
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => init.method === 'PATCH' && String(input).includes('/jobs/job-1') ? Response.json({ error: { status: 'UNAVAILABLE' } }, { status: 503 }) : original(input, init);
  try {
    const response = await customerPortalLinkHandler({ now: clockAt(DAY), session: async () => sales })({ env: ENV, request: new Request('https://easygaragecleaning.com/api/customer-portal-link', { method: 'POST', body: JSON.stringify({ job_id: 'job-1' }) }) });
    const body = await response.json();
    assert.deepEqual([response.status, body.url], [503, undefined]);
  } finally { globalThis.fetch = original; w.restore(); }
});

// ---------------------------------------------------------------- the owner's switches
test('switches: Hub → Message templates shows both off with their exact text; only business users turn them on; each change is idempotent', async () => {
  const w = world();
  try {
    const store = (await import('../functions/_lib/message-send-store.js')).messagingStorage(ENV);
    const view = await portalLinkSwitches(store, owner);
    assert.deepEqual([view.quoteReady, view.jobDone, view.canChange, view.paused], [false, false, true, false]);
    assert.deepEqual(view.texts, portalLinkPreviews());
    assert.equal(view.texts.quote_ready, 'Hi {first}, your Easy Garage Cleaning quote is ready. You can review it, approve it and pay the deposit in your private project portal: {portal link}');
    assert.deepEqual(view.texts.job_done, { balance: 'Hi {first}, your Easy Garage Cleaning job is done — thank you! Your remaining balance, receipts and photos are in your private project portal: {portal link}', paid: 'Hi {first}, your Easy Garage Cleaning job is done — thank you! Your receipts and job details are in your private project portal: {portal link}' });
    await assert.rejects(setPortalLinkSwitch(store, sales, { action: 'set_portal_link', requestId: randomUUID(), link: 'quote_ready', enabled: true }, DAY), error => error.status === 403);
    for (const bad of [{ link: 'everything', enabled: true }, { link: 'quote_ready', enabled: 'yes' }, { link: 'quote_ready', enabled: true, extra: 1 }]) await assert.rejects(setPortalLinkSwitch(store, owner, { action: 'set_portal_link', requestId: randomUUID(), ...bad }, DAY), error => error.code === 'messaging_request_invalid', JSON.stringify(bad));
    const requestId = randomUUID(), input = { action: 'set_portal_link', requestId, link: 'quote_ready', enabled: true };
    const on = await setPortalLinkSwitch(store, owner, input, DAY);
    assert.deepEqual([on.portalLinks.quoteReady, on.portalLinks.jobDone], [true, false]);
    assert.deepEqual([w.memory.get(SETTINGS).portalLinkQuoteReady, w.memory.get(SETTINGS).portalLinksUpdatedBy], [true, 'zacb']);
    assert.equal((await setPortalLinkSwitch(store, owner, input, DAY)).replayed, true);
    await assert.rejects(setPortalLinkSwitch(store, owner, { ...input, enabled: false }, DAY), error => error.code === 'messaging_idempotency_conflict');
    // The record keeps the pause and the cadence it had; the scheduler still reads it.
    assert.deepEqual(normalizeMessagingSettings(w.memory.get(SETTINGS)).paused, false);
    // An invalid record is never written into: every automatic message is held until it is fixed.
    w.put(SETTINGS, { ...w.memory.get(SETTINGS), maxSendsPerTick: 99 });
    await assert.rejects(setPortalLinkSwitch(store, owner, { action: 'set_portal_link', requestId: randomUUID(), link: 'job_done', enabled: true }, DAY), error => error.code === 'messaging_settings_invalid');
    assert.equal((await portalLinkSwitches(store, owner)).error, 'invalid');
  } finally { w.restore(); }
});

test('switches: the message templates API returns them and changes them through set_portal_link for business users only', async () => {
  const w = world();
  try {
    const handlers = actor => messageTemplateHandlers({ session: async () => actor, now: clockAt(DAY) });
    const got = await (await handlers(owner).get({ request: new Request('https://easygaragecleaning.com/api/message-templates'), env: ENV })).json();
    assert.deepEqual([got.ok, got.portalLinks.quoteReady, got.portalLinks.jobDone, got.portalLinks.canChange], [true, false, false, true]);
    const post = async (actor, body) => { const response = await handlers(actor).post({ request: new Request('https://easygaragecleaning.com/api/message-templates', { method: 'POST', headers: { Origin: 'https://easygaragecleaning.com', 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), env: ENV }); return { status: response.status, body: await response.json() }; };
    const changed = await post(owner, { action: 'set_portal_link', requestId: randomUUID(), link: 'job_done', enabled: true });
    assert.deepEqual([changed.status, changed.body.portalLinks.jobDone], [200, true]);
    assert.equal((await post(sales, { action: 'set_portal_link', requestId: randomUUID(), link: 'job_done', enabled: false })).status, 403);
    assert.equal(w.memory.get(SETTINGS).portalLinkJobDone, true);
  } finally { w.restore(); }
});

test('registry: the two new kinds are registered with their exact texts, off by default, and the approved invitation text is unchanged', () => {
  for (const id of ['hub.portal_quote_ready', 'hub.portal_quote_ready_email', 'hub.portal_job_done', 'hub.portal_job_done_paid', 'hub.portal_job_done_email', 'hub.portal_job_done_paid_email']) {
    const entry = automationById(AUTOMATION_REGISTRY, id);
    assert.deepEqual([entry.sendsToday, entry.classification, entry.disposition, entry.contentSource], ['no', 'owner_automation', 'needs_owner_approval', 'fixed_template'], id);
    assert.match(entry.notes, /default false/);
  }
  assert.equal(automationById(AUTOMATION_REGISTRY, 'hub.portal_invitation').templateText, '{{opening}} quote is approved. Here is your private Easy Garage Cleaning project portal for job details, messages, and payments: {{portalLink}}');
  assert.equal(PORTAL_MESSAGES.approved.sms('Pat', 'https://x.invalid/l'), 'Hi Pat, your quote is approved. Here is your private Easy Garage Cleaning project portal for job details, messages, and payments: https://x.invalid/l');
  const doc = readFileSync(new URL('../docs/automation-registry.md', import.meta.url), 'utf8');
  for (const name of ['Quote-ready portal link (SMS)', 'Job-done portal link, balance due (SMS)', 'Job-done portal link, nothing due (SMS)']) assert.ok(doc.includes(name), name);
});

test('cron: a waiting portal link is retried by the signed messaging run while server messaging is on', async () => {
  const jobs = [{ id: 'job-1', type: 'job', portalLinks: { job_done: { kind: 'job_done', jobId: 'job-1', status: 'deferred', reason: 'quiet_hours', notBefore: '2026-09-23T14:00:00.000Z', attempts: 0 } } },
    { id: 'job-2', type: 'job', portalLinks: { quote_ready: { kind: 'quote_ready', jobId: 'job-2', status: 'failed', attempts: 1, attemptedAt: LATE } } },
    { id: 'job-3', type: 'job', notify: false, portalLinks: { quote_ready: { kind: 'quote_ready', jobId: 'job-3', status: 'failed', attempts: 1, attemptedAt: LATE } } },
    { id: 'job-4', type: 'job', portalLinks: { quote_ready: { kind: 'quote_ready', jobId: 'job-4', status: 'off', attempts: 0 } } },
    { id: 'job-5', type: 'job', portalLinks: { quote_ready: { kind: 'quote_ready', jobId: 'other', status: 'failed', attempts: 1 } } }];
  const calls = [];
  const store = { read: async () => null, commit: async () => {}, jobRecords: async () => structuredClone(jobs) };
  const summary = await runDueMessages({ store, service: { send: async () => { throw new Error('no approved sends here'); } }, templates: { active: async () => null, read: async () => null }, portalInvite: async (jobId, at, settings, link) => { calls.push([jobId, link, settings.portalLinkJobDone]); return { status: 'submitted' }; } }, { now: new Date(EIGHT) });
  assert.deepEqual(calls, [['job-1', 'job_done', false], ['job-2', 'quote_ready', false]]);
  assert.equal(summary.sent, 2);
});

test('B: view=sync tells the walkthrough page where the server\'s sync stands, statuses only, for the quote\'s own author', async () => {
  const f = handoffFixture(), saved = await saveWalkthroughHandoff(f.store, sales, f.input(), NOW, { env: ON }), id = saved.job.id;
  const get = async (actor, query) => { const response = await handoffHandlers({ session: async () => actor, storage: () => f.store, now: () => new Date(NOW) }).get({ request: new Request(`https://easygaragecleaning.com/api/walkthrough-handoff?${new URLSearchParams(query)}`), env: ON }); return { status: response.status, body: await response.json() }; };
  const pending = await get(sales, { view: 'sync', jobId: id });
  assert.deepEqual([pending.status, pending.body.sync, pending.body.portalInvitation], [200, { status: 'pending' }, null]);
  f.rows.set(`jobs/${id}`, { ...f.rows.get(`jobs/${id}`), syncStatus: 'synced', handoffSyncStatus: 'synced', handoffSyncedRequestId: saved.requestId, customerPortalInvitation: { jobId: id, status: 'submitted', channel: 'SMS', attemptId: 'synthetic', messageId: 'synthetic-message', recipient: '(•••) •••-0100' } });
  const synced = await get(sales, { view: 'sync', jobId: id });
  assert.deepEqual([synced.body.sync, synced.body.portalInvitation], [{ status: 'synced' }, { status: 'submitted', channel: 'SMS' }]);
  assert.doesNotMatch(JSON.stringify(synced.body), /synthetic-message|•••|1400|Synthetic Customer/);
  assert.equal((await get(otherSales, { view: 'sync', jobId: id })).status, 403, 'another author\'s job');
  assert.equal((await get(sales, { view: 'sync', jobId: id, extra: '1' })).status, 400);
});
