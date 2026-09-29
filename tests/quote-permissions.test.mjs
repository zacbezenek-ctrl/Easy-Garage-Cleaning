import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { isDispatcher, quoteAuthorAccess, requireQuoteAuthor } from '../functions/_lib/quote-permissions.js';
import { mutateDispatch, requireDispatcher } from '../functions/_lib/dispatch-service.js';
import { prepareHandoff, saveWalkthroughHandoff, savedHandoffPayload } from '../functions/_lib/walkthrough-handoff.js';
import { handoffHandlers } from '../functions/api/walkthrough-handoff.js';
import { dispatchHandlers } from '../functions/api/dispatch.js';
import { customerResolveHandler } from '../functions/api/customer-resolve.js';

const NOW = '2026-09-22T18:00:00.000Z';
const ON = { EGC_STAFF_ROLE_PERMISSIONS: 'true' };
const owner = { user: 'zacb', role: 'owner', businessAccess: true, displayName: 'Synthetic Owner' };
const manager = { user: 'tylerg', role: 'manager', businessAccess: true, displayName: 'Synthetic Manager' };
const businessNoRole = { user: 'alexk', role: 'crew', businessAccess: true, displayName: 'Synthetic Business' };
const sales = { user: 'sales.person', role: 'sales', businessAccess: false, displayName: 'Synthetic Sales', source: 'employee-account', staffRoles: ['sales'] };
const phone = { ...sales, user: 'phone.person', staffRoles: ['phone'] };
const crew = { user: 'crew.person', role: 'crew', businessAccess: false, displayName: 'Synthetic Crew', staffRoles: ['crew'] };
const employeeManager = { user: 'lead.person', role: 'crew', businessAccess: false, displayName: 'Synthetic Lead', staffRoles: ['manager'] };
const allowed = (fn, session, env) => { try { fn(session, env); return true; } catch { return false; } };

test('with role permissions off, quote authors are exactly today\'s dispatchers', () => {
  for (const env of [{}, { EGC_STAFF_ROLE_PERMISSIONS: 'false' }, { EGC_STAFF_ROLE_PERMISSIONS: 'TRUE' }]) {
    for (const session of [owner, manager, businessNoRole, sales, phone, crew, employeeManager, { ...owner, businessAccess: false }, { user: 'impostor', role: 'owner', businessAccess: true }]) {
      assert.equal(allowed(requireQuoteAuthor, session, env), allowed(requireDispatcher, session), `${session.user} ${JSON.stringify(env)}`);
      assert.equal(quoteAuthorAccess(session, env).dispatcher, isDispatcher(session));
    }
  }
  assert.throws(() => requireQuoteAuthor(null), error => error.code === 'quote_sign_in_required' && error.status === 401);
  assert.throws(() => requireQuoteAuthor({ user: ' ' }), error => error.status === 401);
  assert.throws(() => requireQuoteAuthor(sales), error => error.code === 'quote_forbidden' && error.status === 403);
});

test('with role permissions on, the sales/walkthrough role authors quotes but never becomes a dispatcher', () => {
  assert.deepEqual(quoteAuthorAccess(sales, ON), { dispatcher: false, author: true });
  assert.deepEqual(quoteAuthorAccess(employeeManager, ON), { dispatcher: false, author: true });
  assert.deepEqual(quoteAuthorAccess(owner, ON), { dispatcher: true, author: true });
  assert.deepEqual(quoteAuthorAccess({ ...manager, staffRoles: ['crew'] }, ON), { dispatcher: true, author: true }, 'a dispatcher keeps quote access');
  for (const session of [crew, phone, { ...sales, staffRoles: [] }, { ...sales, staffRoles: ['owner'] }, { ...sales, staffRoles: 'sales' }]) assert.throws(() => requireQuoteAuthor(session, ON), error => error.code === 'quote_forbidden', session.user);
  assert.equal(allowed(requireDispatcher, sales), false);
});

const plan = (logistics = {}) => ({ client: { name: 'Synthetic Customer', phone: '9705550100', email: 'test@example.invalid', address: '100 Fixture Lane', highlevel_contact_id: 'provider1' }, quote: { title: 'Garage reset', total: 1400, deposit: 700, job_date: '2026-09-24', start_time: '09:00', end_time: '12:00', estimated_duration_min: 180 }, acceptance: { accepted_at: '2026-09-22T17:45:00.000Z', accepted_by: 'Synthetic Customer', signature_captured: true, method: 'in_person_signature', terms_version: '2026-09-deposit50' }, signature: 'data:image/png;base64,iVBORw0KGgo=', terms_version: '2026-09-deposit50', terms_accepted: true, photos: { before: 2 }, scope: { keep_items: 'Blue bicycle' }, discovery: { success: 'Park the car' }, logistics: { crew_size: 2, ...logistics }, internal_notes: 'Synthetic brief', client_checklists: { preJob: [], postJob: [] }, notes: '' });
function fixture() {
  const rows = new Map([
    ['customers/c1', { id: 'c1', revision: 'c1r', name: 'Synthetic Customer', phone: '9705550100', email: 'test@example.invalid', address: '100 Fixture Lane', highlevelContactId: 'provider1' }],
    ['jobs/w1', { id: 'w1', revision: 'w1r', type: 'walkthrough', status: 'scheduled', pipelineStatus: 'scheduled', customerId: 'c1', customer: 'Synthetic Customer', highlevelContactId: 'provider1', date: '2026-09-22', time: '11:00', endTime: '12:00', projectId: 'p1' }],
    ['projects/p1', { id: 'p1', revision: 'p1r', customerId: 'c1', sourceRecordId: 'w1', sourceWalkthroughId: 'w1' }],
  ]);
  let n = 0; const calls = [];
  const roster = [{ id: 'zacb', name: 'Synthetic Owner', role: 'owner' }, { id: 'crew1', name: 'Crew One', role: 'crew' }, { id: 'crew2', name: 'Crew Two', role: 'crew' }];
  const store = { read: async (c, id) => structuredClone(rows.get(`${c}/${id}`) || null), jobs: async () => [...rows].filter(([k]) => k.startsWith('jobs/')).map(([, v]) => structuredClone(v)), resources: async () => [], customers: async () => [...rows].filter(([k]) => k.startsWith('customers/')).map(([, v]) => structuredClone(v)), roster: async () => structuredClone(roster),
    commit: async writes => { for (const w of writes) { const old = rows.get(`${w.collection}/${w.id}`); if (w.revision ? old?.revision !== w.revision : !!old) throw Object.assign(new Error('Conflict'), { code: 'dispatch_revision_conflict', status: 409 }); } calls.push(structuredClone(writes)); for (const w of writes) if (!w.verify) rows.set(`${w.collection}/${w.id}`, { ...rows.get(`${w.collection}/${w.id}`), ...structuredClone(w.patch), id: w.id, revision: `r${++n}` }); } };
  const input = (logistics, change = {}) => ({ requestId: randomUUID(), customerId: 'c1', sourceWalkthroughId: 'w1', sourceRevision: rows.get('jobs/w1').revision, plan: plan(logistics), ...change });
  return { rows, store, calls, input };
}

test('a sales author saves a signed handoff and revises it, but cannot assign or reassign crew', async () => {
  const f = fixture();
  await assert.rejects(saveWalkthroughHandoff(f.store, sales, f.input(), NOW), error => error.code === 'quote_forbidden', 'flag off: unchanged');
  await assert.rejects(saveWalkthroughHandoff(f.store, sales, f.input({ assigned_to: 'Crew One' }), NOW, { env: ON }), error => error.code === 'handoff_crew_assignment_forbidden' && error.status === 403);
  assert.equal(f.calls.length, 0);
  const saved = await saveWalkthroughHandoff(f.store, sales, f.input({ assigned_to: 'crew of 2' }), NOW, { env: ON }), job = f.rows.get(`jobs/${saved.job.id}`);
  assert.deepEqual([job.estimate.status, job.date, job.assignedCrew, job.createdBy, job.acceptance.recordedBy], ['accepted', '2026-09-24', [], 'sales.person', 'sales.person']);
  assert.ok(saved.warnings.some(warning => warning.code === 'unassigned'), 'Dispatch still staffs the job');
  // A manager assigns the crew; the sales author's later signed revision keeps it and cannot change it.
  const staffed = await saveWalkthroughHandoff(f.store, owner, f.input({ assigned_to: 'Crew One, Crew Two' }, { jobId: job.id, expectedRevision: job.revision, sourceRevision: f.rows.get('jobs/w1').revision }), NOW);
  assert.deepEqual(staffed.job.assignedCrew, ['crew1', 'crew2']);
  const current = () => ({ jobId: job.id, expectedRevision: f.rows.get(`jobs/${job.id}`).revision, sourceRevision: f.rows.get('jobs/w1').revision });
  await assert.rejects(saveWalkthroughHandoff(f.store, sales, f.input({ assigned_to: 'Crew One' }, current()), NOW, { env: ON }), error => error.code === 'handoff_crew_assignment_forbidden');
  const kept = await saveWalkthroughHandoff(f.store, sales, f.input({ assigned_to: 'Crew Two, Crew One' }, current()), NOW, { env: ON });
  assert.deepEqual(kept.job.assignedCrew, ['crew1', 'crew2']);
  const blank = await saveWalkthroughHandoff(f.store, sales, f.input({}, current()), NOW, { env: ON });
  assert.deepEqual(blank.job.assignedCrew, ['crew1', 'crew2']);
});

test('the sales role cannot change dispatch directly, and only dispatchers see the roster', async () => {
  const f = fixture();
  const input = { action: 'schedule.create', requestId: randomUUID(), customerId: 'c1', kind: 'job', changes: {} };
  await assert.rejects(mutateDispatch(f.store, sales, input, NOW), error => error.code === 'dispatch_forbidden');
  const request = body => new Request('https://easygaragecleaning.com/api/dispatch', { method: 'POST', headers: { Origin: 'https://easygaragecleaning.com', 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const dispatch = dispatchHandlers({ session: async () => sales, storage: () => f.store });
  assert.equal((await dispatch.post({ request: request(input), env: ON })).status, 403);
  assert.equal((await dispatch.post({ request: request({ action: 'schedule.update', requestId: randomUUID(), jobId: 'w1', expectedRevision: 'w1r', changes: { assignedCrew: ['crew1'] } }), env: ON })).status, 403);
  assert.equal((await dispatch.get({ request: new Request('https://easygaragecleaning.com/api/dispatch'), env: ON })).status, 403);
  assert.equal(f.calls.length, 0);
  const prepared = await prepareHandoff(f.store, sales, { sourceWalkthroughId: 'w1' }, { env: ON });
  assert.deepEqual([prepared.customerId, prepared.roster, prepared.customer], ['c1', [], null], 'contact details only through a job the author may revise');
  assert.equal((await prepareHandoff(f.store, owner, { sourceWalkthroughId: 'w1' })).roster.length, 3);
});

test('handoff and customer-resolve APIs admit sales authors only with role permissions on; crew stays 403 and owners are unchanged', async () => {
  const f = fixture();
  const post = (path, body) => new Request(`https://easygaragecleaning.com/api/${path}`, { method: 'POST', headers: { Origin: 'https://easygaragecleaning.com', 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const get = new Request('https://easygaragecleaning.com/api/walkthrough-handoff?sourceWalkthroughId=w1');
  for (const [actor, env, status] of [[null, ON, 401], [crew, ON, 403], [sales, {}, 403], [businessNoRole, ON, 403], [sales, ON, 200], [owner, {}, 200]]) {
    const handlers = handoffHandlers({ session: async () => actor, storage: () => f.store });
    const response = await handlers.get({ request: get, env });
    assert.equal(response.status, status, `${actor?.user} ${JSON.stringify(env)}`);
    if (status !== 200) assert.match((await response.json()).code, /^quote_(sign_in_required|forbidden)$/);
    const resolve = customerResolveHandler({ session: async () => actor, storage: () => f.store, verifyContact: async () => { throw new Error('not used'); } });
    const resolved = await resolve({ request: post('customer-resolve', { requestId: randomUUID(), customer: { name: 'Synthetic New', phone: '9705550142', email: '', address: '1 New Lane', highlevelContactId: '' } }), env });
    assert.equal(resolved.status, status, `resolve ${actor?.user}`);
  }
  const handlers = handoffHandlers({ session: async () => sales, storage: () => f.store, now: () => new Date(NOW) });
  const refused = await handlers.post({ request: post('walkthrough-handoff', f.input({ assigned_to: 'Crew One' })), env: ON });
  assert.deepEqual([refused.status, (await refused.json()).code], [403, 'handoff_crew_assignment_forbidden']);
  assert.equal((await handlers.post({ request: post('walkthrough-handoff', f.input()), env: ON })).status, 200);
});

function browser(profile) {
  const store = () => { const map = new Map(); return { getItem: key => map.has(key) ? map.get(key) : null, setItem: (key, value) => map.set(key, String(value)), removeItem: key => map.delete(key) }; };
  const context = { sessionStorage: store(), localStorage: store(), fetch: async () => { throw new Error('offline'); }, document: { readyState: 'loading', querySelector: () => null, getElementById: () => null }, location: { pathname: '/crew/' }, addEventListener() {}, dispatchEvent() {}, Event: class {}, Error, Promise, JSON, Number, String, Array, Math };
  context.window = context;
  vm.runInNewContext(readFileSync(new URL('../crew/hub-auth.js', import.meta.url), 'utf8'), context);
  for (const [key, value] of Object.entries(profile)) context.sessionStorage.setItem(key, value);
  return context.EGCHubAuth;
}

test('the crew client opens the walkthrough for business staff and for accounts the server says author quotes', () => {
  const business = browser({ egc_u: 'TylerG', egc_business_access: 'true', egc_capabilities: '["dispatch.write","quotes.author"]' });
  assert.equal(business.canRunWalkthrough(), true); assert.equal(business.canRunWalkthrough('tylerg'), true); assert.equal(business.canRunWalkthrough('other'), false);
  const author = browser({ egc_u: 'Sales.Person', egc_business_access: 'false', egc_capabilities: '["customer.send","quotes.author"]' });
  assert.equal(author.canRunBusiness(), false); assert.equal(author.canRunWalkthrough(), true); assert.equal(author.canRunWalkthrough('Sales.Person'), true); assert.equal(author.canRunWalkthrough('someone.else'), false);
  for (const profile of [{ egc_u: 'Crew.Person', egc_business_access: 'false', egc_capabilities: '[]' }, { egc_u: 'Phone.Person', egc_capabilities: '["customer.send"]' }, { egc_u: '', egc_capabilities: '["quotes.author"]' }]) assert.equal(browser(profile).canRunWalkthrough(), false, profile.egc_u);
  // Security invariant: the walkthrough page gates on the server-reported capability, never on a name list.
  const page = readFileSync(new URL('../crew/gameplan.html', import.meta.url), 'utf8'), auth = readFileSync(new URL('../crew/hub-auth.js', import.meta.url), 'utf8');
  assert.match(page, /if\(user&&!EGCHubAuth\.canRunWalkthrough\(user\)\)\{denyWalkthrough\(\);return null\}/);
  assert.match(auth, /href !== '\/crew\/gameplan' \|\| canRunWalkthrough\(\)/);
  assert.doesNotMatch(auth, /zacb|tylerg|alexk/i);
});

test('a sales author cannot use the signed handoff to take over, move or re-notify a job Dispatch placed; the owner still can', async () => {
  const f = fixture();
  const at = (date, start, end, total, logistics = {}) => { const value = plan(logistics); Object.assign(value.quote, { job_date: date, start_time: start, end_time: end, total, deposit: total / 2 }); return value; };
  // A dispatcher's job with no walkthrough or quote draft: scheduled, staffed, notifications off and a manager-recorded estimate.
  f.rows.set('jobs/j1', { id: 'j1', revision: 'j1r', type: 'job', status: 'scheduled', pipelineStatus: 'scheduled', customerId: 'c1', customer: 'Synthetic Customer', phone: '9705550100', email: 'test@example.invalid', address: '100 Fixture Lane', title: 'Garage reset', date: '2026-09-25', endDate: '2026-09-25', time: '09:00', endTime: '12:00', assignedCrew: ['crew1'], assignedTo: 'Crew One', crewNeeded: 1, notify: false, createdBy: 'tylerg', scheduleSource: 'egc_hub', estimate: { number: 'EST-J1', revision: 1, status: 'accepted', amount: 3000, depositRequired: 1500 }, customerApproval: { status: 'approved', source: 'manager_recorded' }, quoteStatus: 'approved', syncStatus: 'synced' });
  const dispatched = structuredClone(f.rows.get('jobs/j1'));
  const takeover = (actor, env) => saveWalkthroughHandoff(f.store, actor, { requestId: randomUUID(), customerId: 'c1', jobId: 'j1', expectedRevision: f.rows.get('jobs/j1').revision, plan: at('2026-09-29', '13:00', '16:00', 400) }, NOW, { env });
  await assert.rejects(takeover(sales, ON), error => error.code === 'handoff_revision_forbidden' && error.status === 403);
  await assert.rejects(prepareHandoff(f.store, sales, { jobId: 'j1' }, { env: ON }), error => error.code === 'handoff_job_forbidden' && error.status === 403);
  assert.deepEqual(f.rows.get('jobs/j1'), dispatched); assert.equal(f.calls.length, 0);
  assert.deepEqual([(await prepareHandoff(f.store, owner, { jobId: 'j1' })).customer.phone, (await prepareHandoff(f.store, owner, { jobId: 'j1' })).expectedRevision], ['9705550100', 'j1r']);
  const moved = await takeover(owner, {});
  assert.deepEqual([moved.job.date, moved.job.time, f.rows.get('jobs/j1').notify, f.rows.get('jobs/j1').estimate.amount], ['2026-09-29', '13:00', true, 400], 'the owner may still revise it');

  // The job of this walkthrough, once Dispatch placed and staffed it with notifications off.
  const signed = await saveWalkthroughHandoff(f.store, owner, f.input({ assigned_to: 'Crew One' }), NOW), id = signed.job.id;
  await mutateDispatch(f.store, owner, { action: 'schedule.update', requestId: randomUUID(), jobId: id, expectedRevision: f.rows.get(`jobs/${id}`).revision, changes: { notify: false } }, NOW);
  const placed = structuredClone(f.rows.get(`jobs/${id}`)), commits = f.calls.length;
  assert.deepEqual([placed.date, placed.time, placed.endTime, placed.assignedCrew, placed.notify], ['2026-09-24', '09:00', '12:00', ['crew1'], false]);
  const revise = (actor, value, env = ON) => saveWalkthroughHandoff(f.store, actor, f.input(undefined, { jobId: id, expectedRevision: f.rows.get(`jobs/${id}`).revision, sourceRevision: f.rows.get('jobs/w1').revision, plan: value }), NOW, { env });
  for (const value of [at('2026-09-29', '13:00', '16:00', 1600), at('2026-09-24', '10:00', '12:00', 1600), at('2026-09-24', '09:00', '13:00', 1600)]) await assert.rejects(revise(sales, value), error => error.code === 'handoff_schedule_change_forbidden' && error.status === 403 && /2026-09-24 09:00–12:00/.test(error.message));
  assert.deepEqual(f.rows.get(`jobs/${id}`), placed); assert.equal(f.calls.length, commits);
  // The sales author sees this walkthrough's own job and may re-sign it in its saved slot.
  const prepared = await prepareHandoff(f.store, sales, { sourceWalkthroughId: 'w1' }, { env: ON });
  assert.deepEqual([prepared.jobId, prepared.customer?.id, prepared.roster], [id, 'c1', []]);
  await revise(sales, at('2026-09-24', '09:00', '12:00', 1600));
  const resigned = f.rows.get(`jobs/${id}`);
  assert.deepEqual([resigned.date, resigned.time, resigned.endTime, resigned.assignedCrew, resigned.notify, resigned.estimate.amount, resigned.updatedBy], ['2026-09-24', '09:00', '12:00', ['crew1'], false, 1600, 'sales.person']);
  // The owner moves it, and a dispatcher's handoff turns notifications back on as before.
  await revise(owner, at('2026-09-30', '13:00', '16:00', 1600), {});
  assert.deepEqual([f.rows.get(`jobs/${id}`).date, f.rows.get(`jobs/${id}`).time, f.rows.get(`jobs/${id}`).notify], ['2026-09-30', '13:00', true]);
});

test('a sales author cannot re-sign a placed job to another service address or crew size; the owner still can', async () => {
  const f = fixture();
  // Dispatch placed and staffed this walkthrough's job at the customer's address with a crew of two.
  const signed = await saveWalkthroughHandoff(f.store, owner, f.input({ assigned_to: 'Crew One, Crew Two' }), NOW), id = signed.job.id;
  const placed = structuredClone(f.rows.get(`jobs/${id}`)), commits = f.calls.length;
  assert.deepEqual([placed.address, placed.crewNeeded, placed.assignedCrew, placed.date], ['100 Fixture Lane', 2, ['crew1', 'crew2'], '2026-09-24']);
  const revise = (actor, change, env = ON) => { const value = plan(); change(value); return saveWalkthroughHandoff(f.store, actor, f.input(undefined, { jobId: id, expectedRevision: f.rows.get(`jobs/${id}`).revision, sourceRevision: f.rows.get('jobs/w1').revision, plan: value }), NOW, { env }); };
  await assert.rejects(revise(sales, value => { value.client.address = '999 Different Road, Other Town'; Object.assign(value.quote, { total: 400, deposit: 200 }); }), error => error.code === 'handoff_schedule_change_forbidden' && error.status === 403 && /service address/.test(error.message) && error.message.includes('(100 Fixture Lane)'));
  for (const crewSize of [5, 1]) await assert.rejects(revise(sales, value => { value.logistics.crew_size = crewSize; }), error => error.code === 'handoff_schedule_change_forbidden' && error.status === 403 && /crew size/.test(error.message) && error.message.includes('(2)'));
  assert.deepEqual(f.rows.get(`jobs/${id}`), placed); assert.equal(f.calls.length, commits);
  // The same place written differently, and the price the author sold, may be re-signed; Dispatch's address is kept verbatim.
  await revise(sales, value => { value.client.address = ' 100 FIXTURE  lane. '; Object.assign(value.quote, { total: 1600, deposit: 800 }); });
  const resigned = f.rows.get(`jobs/${id}`);
  assert.deepEqual([resigned.address, resigned.crewNeeded, resigned.assignedCrew, resigned.date, resigned.estimate.amount, resigned.acceptance.recordedBy], ['100 Fixture Lane', 2, ['crew1', 'crew2'], '2026-09-24', 1600, 'sales.person']);
  // A dispatcher may still move the work to another address and crew size.
  await revise(owner, value => { value.client.address = '200 Moved Lane'; value.logistics.crew_size = 3; }, {});
  assert.deepEqual([f.rows.get(`jobs/${id}`).address, f.rows.get(`jobs/${id}`).crewNeeded], ['200 Moved Lane', 3]);
});

test('customer-resolve tells a sales author only which customer matched, with masked contact hints', async () => {
  const f = fixture();
  const post = body => new Request('https://easygaragecleaning.com/api/customer-resolve', { method: 'POST', headers: { Origin: 'https://easygaragecleaning.com', 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const resolve = actor => customerResolveHandler({ session: async () => actor, storage: () => f.store, verifyContact: async () => { throw new Error('not used'); } });
  // Someone types in a phone number that already belongs to a customer.
  const lookup = { name: 'Anyone At All', phone: '(970) 555-0100', email: '', address: '', highlevelContactId: '' }, body = { requestId: randomUUID(), customer: lookup };
  const response = await resolve(sales)({ request: post(body), env: ON }), text = await response.text(), result = JSON.parse(text);
  assert.equal(response.status, 200);
  assert.deepEqual(result.customer, { id: 'c1', revision: 'c1r', phone: '(•••) •••-0100', email: 't•••@example.invalid', contactDetails: 'masked' });
  for (const secret of ['Synthetic Customer', '100 Fixture Lane', 'provider1', 'test@example.invalid', '9705550100']) assert.equal(text.includes(secret), false, secret);
  // A replay of the request is masked the same way; a dispatcher still gets the full record.
  const replay = await (await resolve(sales)({ request: post(body), env: ON })).json();
  assert.deepEqual([replay.replayed, replay.customer], [true, result.customer]);
  const full = await (await resolve(owner)({ request: post({ requestId: randomUUID(), customer: lookup }), env: {} })).json();
  assert.deepEqual([full.customer.id, full.customer.name, full.customer.phone, full.customer.address, full.customer.highlevelContactId], ['c1', 'Synthetic Customer', '9705550100', '100 Fixture Lane', 'provider1']);
  assert.equal(f.rows.get('customers/c1').name, 'Synthetic Customer', 'resolving never renames the customer');
});

function suite() {
  const storage = { getItem: () => null };
  const context = { crypto, structuredClone, console: { log() {}, error() {} }, URLSearchParams, Date, Intl, Promise, Set, Map, Error, JSON, sessionStorage: storage, localStorage: storage, navigator: {}, location: { pathname: '/employee', search: '' }, setInterval: () => 1, clearInterval() {}, setTimeout: () => 1, clearTimeout() {}, addEventListener() {}, jobsCache: [], document: { readyState: 'loading', hidden: false, querySelector: () => null, querySelectorAll: () => [], addEventListener() {} } };
  context.window = context;
  vm.runInNewContext(readFileSync(new URL('../employee-suite.js', import.meta.url), 'utf8').replace(/\}\)\(\);\s*$/, 'globalThis.ui={syncPayload};})();'), context);
  return context.ui;
}

test('a sales author\'s signed job is left for a manager\'s Hub, which synchronizes it from the saved snapshot', async () => {
  const f = fixture(), saved = await saveWalkthroughHandoff(f.store, sales, f.input(), NOW, { env: ON }), job = f.rows.get(`jobs/${saved.job.id}`);
  assert.deepEqual([job.syncStatus, job.handoffVersion], ['pending', 1]);
  // The sales author's phone does not call /api/highlevel (it requires business access) and says a manager finishes it.
  const context = vm.createContext({ window: {}, URLSearchParams, AbortController, setTimeout, clearTimeout });
  vm.runInContext(readFileSync(new URL('../crew/gameplan-handoff.js', import.meta.url), 'utf8'), context);
  const calls = [], client = context.window.EGCWalkthroughHandoffClient({ actor: async () => 'sales.person', managerSync: () => false, storage: { getItem: () => null, setItem() {}, removeItem() {} }, fetch: async url => { calls.push(url); throw new Error('unexpected'); } });
  const synced = await client.sync({ pending: { actor: 'sales.person', requestId: saved.requestId }, result: saved });
  assert.deepEqual([synced.handoffSync.status, synced.portalInvitation.status, calls.length], ['manager_required', 'manager_required', 0]);
  // A manager's Hub retry names only the job and its original request; the server rebuilds the rest from storage.
  const payload = JSON.parse(JSON.stringify(suite().syncPayload(job)));
  assert.deepEqual(payload, { tool: 'game_plan', job_id: job.id, handoff_request_id: saved.requestId, idempotency_key: `walkthrough-handoff:${saved.requestId}` });
  const snapshot = savedHandoffPayload(job, payload.handoff_request_id);
  assert.deepEqual([snapshot.job_id, snapshot.quote.total, snapshot.quote.job_date, snapshot.client.address], [job.id, 1400, '2026-09-24', '100 Fixture Lane']);
  assert.throws(() => savedHandoffPayload(job, ''), error => error.code === 'handoff_sync_snapshot_changed', 'without the request identity the saved snapshot cannot be verified');
  const page = readFileSync(new URL('../crew/gameplan-handoff.js', import.meta.url), 'utf8');
  assert.match(page, /managerSync:\(\)=>EGCHubAuth\.canRunBusiness\(\)/);
  assert.match(page, /A manager completes the CRM sync and the portal invitation from the Hub\./);
});

// Dispatch moves a signed (v1) job with notify:false: a new time and a corrected address.
const silentMove = async (f, id, changes = {}) => mutateDispatch(f.store, owner, { action: 'schedule.update', requestId: randomUUID(), jobId: id, expectedRevision: f.rows.get(`jobs/${id}`).revision, changes: { date: '2026-09-25', endDate: '2026-09-25', time: '13:00', endTime: '16:00', address: '200 Corrected Ave', notify: false, ...changes } }, NOW);

test('after Dispatch moves a signed job silently, the Hub retry syncs only its schedule and never runs customer automations', async () => {
  const f = fixture(), saved = await saveWalkthroughHandoff(f.store, owner, f.input(), NOW, { env: ON }), id = saved.job.id;
  // The handoff's own first sync names the saved snapshot.
  assert.equal(suite().syncPayload(f.rows.get(`jobs/${id}`)).tool, 'game_plan');
  f.rows.set(`jobs/${id}`, { ...f.rows.get(`jobs/${id}`), syncStatus: 'synced', handoffSyncStatus: 'synced', highlevelAppointmentId: 'appt-1' });
  await silentMove(f, id);
  const moved = f.rows.get(`jobs/${id}`);
  assert.deepEqual([moved.syncStatus, moved.notify, moved.handoffVersion, moved.address, moved.time], ['pending', false, 1, '200 Corrected Ave', '13:00']);
  assert.notEqual(moved.syncIdempotencyKey, `walkthrough-handoff:${saved.requestId}`);
  // The retry is the schedule tool with the Dispatch choice, the new address and the Dispatch request identity:
  // no snapshot game_plan (which would force notifications, write another Job Brief note and re-advance the opportunity).
  const payload = JSON.parse(JSON.stringify(suite().syncPayload(moved)));
  assert.deepEqual([payload.tool, payload.notify, payload.handoff_request_id, payload.internal_notes, payload.address, payload.appointment_id, payload.idempotency_key], ['schedule', false, undefined, undefined, '200 Corrected Ave', 'appt-1', moved.syncIdempotencyKey]);
  assert.equal(payload.start_time, '2026-09-25T19:00:00.000Z');
  // A later move Dispatch wants the customer told about still notifies.
  await silentMove(f, id, { time: '14:00', endTime: '17:00', notify: true });
  assert.deepEqual(Object.values((({ tool, notify }) => ({ tool, notify }))(suite().syncPayload(f.rows.get(`jobs/${id}`)))), ['schedule', true]);
  // A re-signed quote is a new handoff: its own sync names the new snapshot, although the earlier handoff was confirmed.
  f.rows.set(`jobs/${id}`, { ...f.rows.get(`jobs/${id}`), syncStatus: 'synced' });
  const value = plan(); Object.assign(value.quote, { total: 1600, deposit: 800, job_date: '2026-09-25', start_time: '14:00', end_time: '17:00' });
  const resigned = await saveWalkthroughHandoff(f.store, owner, f.input(undefined, { jobId: id, expectedRevision: f.rows.get(`jobs/${id}`).revision, sourceRevision: f.rows.get('jobs/w1').revision, plan: value }), NOW, { env: ON });
  const current = f.rows.get(`jobs/${id}`);
  assert.deepEqual([current.syncStatus, current.handoffSyncStatus, current.estimate.amount], ['pending', 'synced', 1600]);
  assert.deepEqual(JSON.parse(JSON.stringify(suite().syncPayload(current))), { tool: 'game_plan', job_id: id, handoff_request_id: resigned.requestId, idempotency_key: `walkthrough-handoff:${resigned.requestId}` });
});

test('a sales author\'s signed job that Dispatch moves silently before a manager syncs it goes out as a silent schedule sync', async () => {
  const f = fixture(), saved = await saveWalkthroughHandoff(f.store, sales, f.input(), NOW, { env: ON }), id = saved.job.id;
  assert.deepEqual([f.rows.get(`jobs/${id}`).syncStatus, f.rows.get(`jobs/${id}`).handoffSyncStatus], ['pending', undefined]);
  await silentMove(f, id);
  const payload = JSON.parse(JSON.stringify(suite().syncPayload(f.rows.get(`jobs/${id}`))));
  assert.deepEqual([payload.tool, payload.notify, payload.handoff_request_id], ['schedule', false, undefined]);
  // A job signed without a source walkthrough behaves the same, as it did before snapshot syncs.
  const manual = { ...f.rows.get(`jobs/${id}`), sourceWalkthroughId: '' };
  assert.deepEqual(Object.values((({ tool, notify }) => ({ tool, notify }))(suite().syncPayload(manual))), ['schedule', false]);
});

test('the server syncs a signed snapshot with the notification choice Dispatch saved', async () => {
  const f = fixture(), saved = await saveWalkthroughHandoff(f.store, owner, f.input(), NOW, { env: ON }), id = saved.job.id;
  await silentMove(f, id);
  assert.equal(savedHandoffPayload(f.rows.get(`jobs/${id}`), saved.requestId).notify, false);
  const { firestoreMemory } = await import('./helpers/firestore-memory.mjs');
  const { createHubSessionCookie } = await import('../functions/_lib/hub-session.js');
  const { onRequestPost } = await import('../functions/api/highlevel.js');
  const memory = firestoreMemory(), rpc = [], provider = [], original = globalThis.fetch;
  for (const [key, row] of f.rows) if (key.startsWith('jobs/')) { const { revision, ...fields } = row; memory.put(key, fields); }
  const env = { HUB_SESSION_SECRET: 'synthetic-quote-permissions-session', HUB_AUTH_USERS_JSON: JSON.stringify({ ZacB: { passwordHash: 'test-only', role: 'owner', displayName: 'Synthetic Owner' } }), HIGHLEVEL_API_KEY: 'synthetic', HIGHLEVEL_LOCATION_ID: 'location', FIREBASE_API_KEY: 'firebase-test-quote-permissions', EGC_OPERATIONS_ENABLED: 'true', EGC_OPERATIONS_SERVICE_AUTH: 'legacy', EGC_OPERATIONS_API_ORIGIN: 'https://api.example.test', EGC_OPERATIONS_PORTAL_SIGNING_SECRET: 's'.repeat(40) };
  const cookie = (await createHubSessionCookie(env, 'ZacB')).split(';')[0];
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname === 'firestore.googleapis.com') return memory.fetch(input, init);
    if (url.href === 'https://api.example.test/operations/rpc') {
      const body = JSON.parse(Buffer.from(JSON.parse(init.body).envelope.split('.')[0], 'base64url').toString()).request.body;
      rpc.push(body);
      if (body.command === 'schedule.sync_provider') return Response.json({ ok: true, authority: 'employee_hub', portalVisitId: body.portalVisitId, providerSync: 'verified', appointmentId: `appt-${body.portalVisitId}` });
      if (body.command === 'provider.note.ensure') return Response.json({ ok: true, authority: 'employee_hub', portalJobId: body.portalJobId, noteId: 'note-1', outboxId: 'outbox-1', providerSync: 'verified' });
      return Response.json({ ok: false, error: 'unexpected_command' }, { status: 400 });
    }
    provider.push(`${init.method || 'GET'} ${url.pathname}`);
    if (url.pathname === '/contacts/provider1') return Response.json({ contact: { id: 'provider1', locationId: 'location', phone: '9705550100', email: 'test@example.invalid' } });
    return Response.json({});
  };
  try {
    const request = new Request('https://easygaragecleaning.com/api/highlevel', { method: 'POST', headers: { Origin: 'https://easygaragecleaning.com', Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ tool: 'game_plan', job_id: id, handoff_request_id: saved.requestId }) });
    const response = await onRequestPost({ request, env }), result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    const schedule = rpc.filter(body => body.command === 'schedule.sync_provider');
    assert.deepEqual(schedule.map(body => [body.portalVisitId, body.runAutomations]), [['w1', false], [id, false]], 'neither the source visit nor the silently moved job runs customer automations');
    assert.equal(schedule[1].requestId, f.rows.get(`jobs/${id}`).syncIdempotencyKey);
    assert.equal(memory.get(`jobs/${id}`).handoffSyncStatus, 'synced');
    assert.ok(!provider.some(call => call.includes('/calendars/')), 'the legacy calendar write is never used');
  } finally { globalThis.fetch = original; }
});

// The real /api/highlevel handler against in-memory Firestore (a copy of the fixture's jobs), the operations RPC and HighLevel.
// provider.note.ensure follows the operations API: one note per (job, scope, requestId); the same request with another body is a 409.
async function highlevelHarness(f) {
  const { firestoreMemory } = await import('./helpers/firestore-memory.mjs');
  const { createHubSessionCookie } = await import('../functions/_lib/hub-session.js');
  const { onRequestPost } = await import('../functions/api/highlevel.js');
  const memory = firestoreMemory(), rpc = [], provider = [], notes = new Map(), original = globalThis.fetch;
  for (const [key, row] of f.rows) if (key.startsWith('jobs/')) { const { revision, ...fields } = row; memory.put(key, fields); }
  const env = { HUB_SESSION_SECRET: 'synthetic-quote-permissions-session', HUB_AUTH_USERS_JSON: JSON.stringify({ ZacB: { passwordHash: 'test-only', role: 'owner', displayName: 'Synthetic Owner' } }), HIGHLEVEL_API_KEY: 'synthetic', HIGHLEVEL_LOCATION_ID: 'location', FIREBASE_API_KEY: 'firebase-test-quote-permissions', EGC_OPERATIONS_ENABLED: 'true', EGC_OPERATIONS_SERVICE_AUTH: 'legacy', EGC_OPERATIONS_API_ORIGIN: 'https://api.example.test', EGC_OPERATIONS_PORTAL_SIGNING_SECRET: 's'.repeat(40) };
  const cookie = (await createHubSessionCookie(env, 'ZacB')).split(';')[0];
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname === 'firestore.googleapis.com') return memory.fetch(input, init);
    if (url.href === 'https://api.example.test/operations/rpc') {
      const body = JSON.parse(Buffer.from(JSON.parse(init.body).envelope.split('.')[0], 'base64url').toString()).request.body;
      rpc.push(body);
      if (body.command === 'schedule.sync_provider') return Response.json({ ok: true, authority: 'employee_hub', portalVisitId: body.portalVisitId, providerSync: 'verified', appointmentId: `appt-${body.portalVisitId}` });
      if (body.command === 'provider.note.ensure') {
        const key = [body.portalJobId, body.scope, body.requestId].join('|'), hash = JSON.stringify([body.providerContactId, body.title, body.body]);
        if (!notes.has(key)) notes.set(key, { hash, noteId: `note-${notes.size + 1}` });
        if (notes.get(key).hash !== hash) return Response.json({ ok: false, error: 'provider_note_request_conflict' }, { status: 409 });
        return Response.json({ ok: true, authority: 'employee_hub', portalJobId: body.portalJobId, noteId: notes.get(key).noteId, outboxId: `outbox-${key}`, providerSync: 'verified' });
      }
      return Response.json({ ok: false, error: 'unexpected_command' }, { status: 400 });
    }
    provider.push(`${init.method || 'GET'} ${url.pathname}${init.body ? ' ' + init.body : ''}`);
    if (url.pathname === '/contacts/provider1') return Response.json({ contact: { id: 'provider1', locationId: 'location', phone: '9705550100', email: 'test@example.invalid' } });
    return Response.json({});
  };
  const post = async payload => {
    const request = new Request('https://easygaragecleaning.com/api/highlevel', { method: 'POST', headers: { Origin: 'https://easygaragecleaning.com', Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const response = await onRequestPost({ request, env }), result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    return result;
  };
  // Carry a Dispatch change made through the fixture store into the stored job the handler reads.
  const follow = (id, keys) => { const row = f.rows.get(`jobs/${id}`); memory.put(`jobs/${id}`, { ...memory.get(`jobs/${id}`), ...Object.fromEntries(keys.filter(key => row[key] !== undefined).map(key => [key, row[key]])) }); };
  return { memory, rpc, provider, notes, post, follow, restore: () => { globalThis.fetch = original; } };
}
const MOVED = ['date', 'endDate', 'time', 'endTime', 'address', 'notify', 'status', 'pipelineStatus', 'syncStatus', 'syncIdempotencyKey'];

// A game_plan rebuild after a Dispatch move (the crew walkthrough page's "Retry remaining synchronization", or a Hub tab
// loaded before the schedule-only retry) must not write a second pinned Job Brief.
test('a game_plan rebuild after a silent Dispatch move replays the handoff\'s Job Brief and walkthrough sync', async () => {
  const f = fixture(), saved = await saveWalkthroughHandoff(f.store, owner, f.input(), NOW, { env: ON }), id = saved.job.id, handoffKey = `walkthrough-handoff:${saved.requestId}`;
  const h = await highlevelHarness(f), sync = () => h.post({ tool: 'game_plan', job_id: id, handoff_request_id: saved.requestId });
  try {
    const first = await sync();
    assert.equal(first.noteId, 'note-1');
    // Dispatch moves the signed job silently; the stored job the handler reads follows the move.
    await silentMove(f, id); h.follow(id, MOVED);
    const moved = f.rows.get(`jobs/${id}`);
    assert.notEqual(moved.syncIdempotencyKey, handoffKey);
    const again = await sync();
    const briefs = h.rpc.filter(body => body.command === 'provider.note.ensure');
    assert.deepEqual(briefs.map(body => [body.scope, body.requestId]), [['game_plan', handoffKey], ['game_plan', handoffKey]], 'the brief stays keyed on the handoff');
    assert.equal(briefs[1].body, briefs[0].body, 'the brief is the signed one, not the moved schedule');
    assert.match(briefs[0].body, /^Signed date: 2026-09-24 · 09:00–12:00; the current time is on the appointment$/m);
    assert.doesNotMatch(briefs[0].body, /Target date|2026-09-25|13:00/, 'the brief never reads as the current plan');
    assert.deepEqual([h.notes.size, again.noteId], [1, 'note-1'], 'one pinned Job Brief');
    // The source walkthrough replays its first request; only the job's appointment follows Dispatch's request, silently.
    const schedule = h.rpc.filter(body => body.command === 'schedule.sync_provider').map(body => [body.portalVisitId, body.requestId, body.runAutomations]);
    assert.deepEqual(schedule, [['w1', `${handoffKey}:walkthrough`, false], [id, handoffKey, true], ['w1', `${handoffKey}:walkthrough`, false], [id, moved.syncIdempotencyKey, false]]);
    assert.equal(h.memory.get(`jobs/${id}`).handoffSyncStatus, 'synced');
  } finally { h.restore(); }
});

// The Job Brief of a signed handoff is written from the signed quote, so its date line is labelled as the signed schedule
// (the moved time lives on the appointment). Every other brief keeps its "Target date" wording unchanged.
test('the Job Brief labels a signed handoff\'s date as the signed schedule and leaves other briefs unchanged', () => {
  const source = readFileSync(new URL('../functions/api/highlevel.js', import.meta.url), 'utf8'), context = { Number, String, Array, Math, Date };
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('function finishSummary('), source.indexOf('function closeoutNote(')), context);
  const quote = { total: 1400, deposit: 700, job_date: '2026-09-24', start_time: '09:00', end_time: '12:00' };
  const brief = { sent_at: NOW, quote, internal_notes: 'Synthetic brief' }, walkthrough = { sent_at: NOW, quote, scope: {}, logistics: {}, discovery: {} };
  assert.equal(context.noteBody(brief), ['EGC INTERNAL JOB BRIEF', `Completed: ${NOW}`, 'Locked total: $1,400', 'Deposit: $700', 'Target date: 2026-09-24 · 09:00–12:00', '', 'Synthetic brief'].join('\n'));
  assert.equal(context.noteBody(brief, { signed: true }), ['EGC INTERNAL JOB BRIEF', `Completed: ${NOW}`, 'Locked total: $1,400', 'Deposit: $700', 'Signed date: 2026-09-24 · 09:00–12:00; the current time is on the appointment', '', 'Synthetic brief'].join('\n'));
  const plain = context.noteBody(walkthrough), signed = context.noteBody(walkthrough, { signed: true });
  assert.match(plain, /^Target date: 2026-09-24\nArrival window: 09:00–12:00$/m);
  assert.match(signed, /^Signed date: 2026-09-24; the current time is on the appointment\nSigned arrival window: 09:00–12:00$/m);
  assert.equal(signed.replace('Signed date: 2026-09-24; the current time is on the appointment\nSigned arrival window', 'Target date: 2026-09-24\nArrival window'), plain, 'only the date lines differ');
  assert.equal(context.noteBody(brief, { signed: true }), context.noteBody(structuredClone(brief), { signed: true }), 'the body depends only on the brief');
});

// A handoff whose first sync wrote the brief before the signed label existed: a later rebuild replays that note (the
// signed body conflicts under the same request) rather than failing the retry or writing a second pinned brief.
test('a rebuild replays a Job Brief first written with the earlier date label', async () => {
  const f = fixture(), saved = await saveWalkthroughHandoff(f.store, owner, f.input(), NOW, { env: ON }), id = saved.job.id, handoffKey = `walkthrough-handoff:${saved.requestId}`;
  const h = await highlevelHarness(f), sync = () => h.post({ tool: 'game_plan', job_id: id, handoff_request_id: saved.requestId });
  try {
    const first = await sync(), signed = h.rpc.find(body => body.command === 'provider.note.ensure').body;
    assert.equal(first.noteId, 'note-1');
    const legacy = signed.replace('Signed date: 2026-09-24 · 09:00–12:00; the current time is on the appointment', 'Target date: 2026-09-24 · 09:00–12:00');
    assert.notEqual(legacy, signed);
    // What the earlier handler stored for this request: the same brief with the earlier label.
    h.notes.set([id, 'game_plan', handoffKey].join('|'), { hash: JSON.stringify(['provider1', 'EGC Internal Job Brief', legacy]), noteId: 'note-legacy' });
    await silentMove(f, id); h.follow(id, MOVED);
    const again = await sync();
    const briefs = h.rpc.filter(body => body.command === 'provider.note.ensure').slice(1);
    assert.deepEqual(briefs.map(body => [body.requestId, body.body]), [[handoffKey, signed], [handoffKey, legacy]], 'the signed body conflicts, then the stored body replays');
    assert.deepEqual([again.noteId, h.notes.size], ['note-legacy', 1], 'still one pinned Job Brief');
    assert.equal(h.memory.get(`jobs/${id}`).handoffSyncStatus, 'synced');
  } finally { h.restore(); }
});

// What "Notify customer" governs on the Hub's schedule sync: the appointment's automations and the reminder tag. The
// scheduled tags and the Scheduled stage follow every scheduled job; a cancelled job gets neither.
test('the schedule sync of a moved signed job keeps its scheduled tags and stage; a cancelled one adds no tag and no stage move', async () => {
  const f = fixture(), saved = await saveWalkthroughHandoff(f.store, owner, f.input(), NOW, { env: ON }), id = saved.job.id;
  f.rows.set(`jobs/${id}`, { ...f.rows.get(`jobs/${id}`), syncStatus: 'synced', handoffSyncStatus: 'synced', highlevelAppointmentId: 'appt-1' });
  const h = await highlevelHarness(f);
  try {
    await silentMove(f, id); h.follow(id, MOVED);
    const moved = JSON.parse(JSON.stringify(suite().syncPayload(f.rows.get(`jobs/${id}`))));
    assert.deepEqual([moved.tool, moved.notify], ['schedule', false]);
    const silent = await h.post(moved);
    assert.deepEqual([silent.automation.trigger, silent.automation.reminderTrigger, silent.automation.notificationsRequested], ['egc-job-scheduled', '', false]);
    const tags = h.provider.filter(call => call.startsWith('POST /contacts/provider1/tags'));
    assert.deepEqual(tags.map(call => JSON.parse(call.slice(call.indexOf('{'))).tags), [['egc-hub-scheduled', 'egc-job-scheduled']], 'no reminder tag for a silent move');
    assert.ok(h.provider.some(call => call.includes('/opportunities/')), 'the opportunity is kept at Scheduled');
    // A move Dispatch wants the customer told about adds the reminder tag too.
    await silentMove(f, id, { time: '14:00', endTime: '17:00', notify: true }); h.follow(id, MOVED);
    const told = await h.post(JSON.parse(JSON.stringify(suite().syncPayload(f.rows.get(`jobs/${id}`)))));
    assert.deepEqual([told.automation.reminderTrigger, told.automation.notificationsRequested], ['egc-reminder-2d', true]);
    // Dispatch then cancels it (Notify customer still on): only the appointment, i.e. its cancellation, follows Notify customer.
    await mutateDispatch(f.store, owner, { action: 'schedule.cancel', requestId: randomUUID(), jobId: id, expectedRevision: f.rows.get(`jobs/${id}`).revision }, NOW);
    h.follow(id, MOVED);
    const cancelled = f.rows.get(`jobs/${id}`);
    assert.deepEqual([cancelled.status, cancelled.syncStatus, cancelled.notify], ['cancelled', 'pending', true]);
    const payload = JSON.parse(JSON.stringify(suite().syncPayload(cancelled)));
    assert.deepEqual([payload.tool, payload.notify], ['schedule', true]);
    const before = h.provider.length;
    const result = await h.post(payload);
    assert.deepEqual([result.automation.cancelled, result.automation.trigger, result.automation.reminderTrigger, result.pipeline.reason], [true, '', '', 'visit-cancelled']);
    const after = h.provider.slice(before);
    assert.equal(after.some(call => call.includes('/tags')), false, 'no scheduled or reminder tag for a cancelled job');
    assert.equal(after.some(call => call.includes('/opportunities')), false, 'a cancelled job is never moved to Scheduled');
    const appointment = h.rpc.filter(body => body.command === 'schedule.sync_provider').at(-1);
    assert.deepEqual([appointment.portalVisitId, appointment.requestId, appointment.runAutomations], [id, cancelled.syncIdempotencyKey, true]);
  } finally { h.restore(); }
});
