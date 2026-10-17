import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from './helpers/vm-realm.mjs';
import test from 'node:test';
import { servedPricing } from './helpers/walkthrough-pricing.mjs';
import { handoffHandlers } from '../functions/api/walkthrough-handoff.js';
import { GAMEPLAN_WALKTHROUGH_FIELDS, gameplanWalkthroughStorage } from '../functions/_lib/gameplan-walkthroughs.js';

const html = fs.readFileSync(new URL('../crew/gameplan.html', import.meta.url), 'utf8');
const line = prefix => {
  const found = html.split(/\r?\n/).find(row => row.startsWith(prefix));
  assert.ok(found, prefix);
  return found;
};
const flush = async () => { for (let n = 0; n < 15; n++) await Promise.resolve(); };

// WP5: the gameplan loads its walkthroughs from GET /api/walkthrough-handoff?view=walkthroughs (the server answers for a
// Sales estimator, who has no Firestore schedule access). This fake server stands in for it; the page has no hubDb.
function harness({ requestedId = 'walkthrough-1', draft = null, manualDraft = null } = {}) {
  const nodes = new Map(), storage = new Map(), writes = [];
  const element = id => {
    if (!nodes.has(id)) nodes.set(id, { style: {}, innerHTML: '', textContent: '' });
    return nodes.get(id);
  };
  const state = { calls: [], photos: 0, error: null, status: 0, code: '', missing: false, wait: null, replaced: [] };
  const requested = { type: 'walkthrough', status: 'scheduled', customer: 'Current customer', phone: '9705550100', address: '12 Current Street', highlevelAppointmentId: 'appointment-1' };
  const rows = [{ id: 'other-walkthrough', type: 'walkthrough', status: 'scheduled', customer: 'Another appointment', time: '09:00' }];
  if (draft) storage.set(`egc_walkthrough_v3:${requestedId}`, JSON.stringify(draft));
  if (manualDraft) storage.set('egc_walkthrough_v3:manual', JSON.stringify(manualDraft));
  const reply = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => structuredClone(body) });
  const server = async (url, options = {}) => {
    state.calls.push({ url, options: { ...options } });
    const parsed = new URL(url, 'https://hub.example.invalid');
    assert.equal(parsed.pathname, '/api/walkthrough-handoff');
    assert.equal(parsed.searchParams.get('view'), 'walkthroughs');
    assert.equal(options.cache, 'no-store');
    if (state.wait) await state.wait;
    if (state.error) throw state.error;
    if (state.status) return reply(state.status, { ok: false, code: state.code, error: 'Refused' });
    const id = parsed.searchParams.get('walkthroughId');
    if (id && state.missing) return reply(404, { ok: false, code: 'handoff_walkthrough_unavailable', error: 'Missing' });
    return reply(200, { ok: true, authority: 'employee_hub', date: '2026-10-17', walkthroughs: rows, requested: id ? { id, ...requested } : null });
  };
  // PRICE-SCRUB: prices arrive from /api/pricing-config (loadPricing); here they are already loaded.
  const context = vm.createContext({
    PRICING: servedPricing(), loadPricing: async () => {}, URLSearchParams,
    $: element, esc: value => String(value).replaceAll('<', '&lt;'),
    SAVE: 'egc_walkthrough_v3', FLOW: '2026-09-simple', REQUESTED_WALKTHROUGH_ID: requestedId,
    walkthroughReady: false, APPTS_LOADING: false, APPTS_ERROR: '', APPTS: [],
    index: 0, error: '', SLOT_OPTIONS: [], SLOT_ERROR: '', SLOT_LOADING: false, SLOT_SIGNATURE: '',
    sections: ['Customer', 'Photos', 'Scope', 'Finish', 'Schedule', 'Review'],
    screens: Array.from({ length: 6 }, () => () => `<div>Editable walkthrough: ${context.S.name}</div>`),
    localStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => { writes.push(key); storage.set(key, value); } },
    location: { pathname: '/crew/gameplan', search: requestedId ? `?walkthroughId=${requestedId}` : '' },
    history: { replaceState: (...args) => state.replaced.push(args[2]) },
    refreshPhotoCount: () => { state.photos++; }, mountPhotos: () => {},
    slotSignature: () => '', findNearestSlots: () => {}, initSignature: () => {}, setTimeout: () => {},
    EGCHubAuth: { fetch: server, canRunBusiness: () => false },
  });
  vm.runInContext(line('const freshState='), context);
  context.S = vm.runInContext('freshState()', context);
  for (const prefix of ['const draftKey=', 'function save(){', 'function restore(', 'function applyPricingVersion(', 'function resetForWalkthrough(', 'function render(){', 'function useAppointment(', 'async function openApp()']) {
    vm.runInContext(line(prefix), context);
  }
  vm.runInContext(html.slice(html.indexOf('function walkthroughLoadPanel(){'), html.indexOf('function useAppointment(')), context);
  return { context, state, requested, rows, element, storage, writes };
}

const saved = (sourceWalkthroughId, name = 'Saved customer') => ({ flow: '2026-09-simple', index: 2, S: { sourceWalkthroughId, name, notes: 'Keep these field notes', signature: 'saved-signature', approved: true, termsVersion: '2026-09-deposit50', jobId: 'prepared-job' } });

test('booked customer instructions stay visible without becoming staff notes or estimated scope', async () => {
  const h = harness({ draft: saved('walkthrough-1') });
  h.requested.customerInstructions = 'Website inquiry\nGarage size: 3-car or larger\nRequested service: Organization <script>';
  await h.context.openApp();
  assert.equal(h.context.S.customerRequest, h.requested.customerInstructions);
  assert.equal(h.context.S.notes, 'Keep these field notes');
  assert.equal(h.context.S.garageSize, '2', 'customer input cannot silently change the priced scope');
  assert.equal(h.context.S.approved, true);
  vm.runInContext(line('function customerRequestMarkup('), h.context);
  const markup = h.context.customerRequestMarkup();
  assert.match(markup, /aria-label="Customer request"/);
  assert.match(markup, /Organization &lt;script>/);
  assert.doesNotMatch(markup, /Keep these field notes/);
  h.context.APPTS.push({ id: 'another', customer: 'Another customer' });
  h.context.useAppointment(h.context.APPTS.length - 1);
  assert.equal(h.context.S.customerRequest, '', 'a different walkthrough cannot inherit the previous request');
  h.context.S.customerRequest = 'Previous request';
  h.context.LOOK = [{ id: 'different-contact', name: 'Different contact' }];
  h.context.invalidateAcceptance = () => {};
  vm.runInContext(line('function useContact('), h.context);
  h.context.useContact(0);
  assert.equal(h.context.S.customerRequest, '', 'choosing a different CRM contact clears the request');
});

test('requested walkthrough stays blocked while loading and a failed read preserves the complete saved draft', async () => {
  const draft = saved('walkthrough-1'), h = harness({ draft });
  let resume;
  h.state.wait = new Promise(resolve => { resume = resolve; });
  h.state.error = Object.assign(new Error('Private provider detail'), { code: 'unavailable' });
  const pending = h.context.openApp(); await flush();
  assert.equal(h.context.walkthroughReady, false);
  assert.match(h.element('screen').innerHTML, /Opening walkthrough/);
  assert.doesNotMatch(h.element('screen').innerHTML, /Editable walkthrough|Saved customer/);
  assert.equal(h.element('next').style.display, 'none');
  assert.deepEqual(h.writes, []);
  resume(); await pending;
  assert.match(h.element('screen').innerHTML, /connection and retry/);
  assert.doesNotMatch(h.element('screen').innerHTML, /Private provider detail|Editable walkthrough/);
  assert.equal(h.state.photos, 0);
  assert.equal(h.context.APPTS_LOADING, false);
  assert.deepEqual(JSON.parse(h.storage.get('egc_walkthrough_v3:walkthrough-1')), draft);
});

test('retry opens the verified requested appointment and preserves saved notes, signature, and stage', async () => {
  const h = harness({ draft: saved('walkthrough-1') });
  h.state.error = Object.assign(new Error('Offline'), { code: 'unavailable' });
  await h.context.openApp();
  h.state.error = null;
  assert.equal(await h.context.loadAppointments(), true);
  assert.equal(h.state.calls.length, 2);
  assert.equal(h.state.calls[1].url, '/api/walkthrough-handoff?view=walkthroughs&walkthroughId=walkthrough-1');
  assert.equal(h.context.walkthroughReady, true);
  assert.equal(h.context.S.name, 'Current customer');
  assert.equal(h.context.S.highlevelAppointmentId, 'appointment-1');
  assert.equal(h.context.S.notes, 'Keep these field notes');
  assert.equal(h.context.S.signature, 'saved-signature');
  assert.equal(h.context.S.approved, true);
  assert.equal(h.context.S.jobId, 'prepared-job');
  assert.equal(h.context.index, 2);
  assert.equal(h.context.S.sourceWalkthroughId, 'walkthrough-1');
  assert.match(h.element('screen').innerHTML, /Editable walkthrough: Current customer/);
  assert.equal(h.state.photos, 1);
});

for (const condition of ['missing', 'wrong-type', 'cancelled', 'completed', 'permission-denied', 'not-assigned']) {
  test(`${condition} requested walkthrough cannot silently open another appointment or a blank editor`, async () => {
    const draft = saved('walkthrough-1'), h = harness({ draft });
    if (condition === 'missing') h.state.missing = true;
    else if (condition === 'wrong-type') h.requested.type = 'job';
    else if (condition === 'permission-denied') Object.assign(h.state, { status: 403, code: 'quote_forbidden' });
    else if (condition === 'not-assigned') Object.assign(h.state, { status: 403, code: 'handoff_walkthrough_forbidden' });
    else h.requested.status = condition;
    await h.context.openApp();
    assert.equal(h.context.walkthroughReady, false);
    assert.equal(h.context.S.name, '');
    assert.deepEqual([...h.context.APPTS], []);
    assert.match(h.element('screen').innerHTML, /Retry loading/);
    assert.match(h.element('screen').innerHTML, /Open a manual walkthrough/);
    assert.doesNotMatch(h.element('screen').innerHTML, /Editable walkthrough|Another appointment/);
    assert.equal(h.state.photos, 0);
    assert.deepEqual(h.writes, []);
    assert.deepEqual(JSON.parse(h.storage.get('egc_walkthrough_v3:walkthrough-1')), draft);
    const message = h.element('screen').innerHTML;
    if (condition === 'permission-denied') assert.match(message, /This login cannot read the walkthrough schedule/);
    else if (condition === 'not-assigned') assert.match(message, /not assigned to you/);
    else assert.match(message, /missing, cancelled, or already completed/);
  });
}

test('a schedule query failure is visible and cannot publish a partial list or restore the requested draft', async () => {
  const h = harness({ draft: saved('walkthrough-1') });
  h.context.APPTS = [{ id: 'stale', customer: 'Stale customer' }];
  Object.assign(h.state, { status: 503, code: 'handoff_storage_unavailable' });
  await h.context.openApp();
  assert.equal(h.state.calls.length, 1, 'the requested walkthrough and today\'s list are one server answer');
  assert.equal(h.context.walkthroughReady, false);
  assert.deepEqual([...h.context.APPTS], []);
  assert.deepEqual(h.writes, []);
  assert.match(h.element('screen').innerHTML, /schedule could not load/);
});

test('a route without a requested appointment preserves manual work and reports schedule failures accurately', async () => {
  const h = harness({ requestedId: '', manualDraft: saved('', 'Manual customer') });
  h.state.error = new Error('Offline');
  await h.context.openApp();
  assert.equal(h.context.walkthroughReady, true);
  assert.equal(h.state.calls[0].url, '/api/walkthrough-handoff?view=walkthroughs', 'no walkthrough is requested');
  assert.equal(h.context.S.notes, 'Keep these field notes');
  assert.match(h.element('screen').innerHTML, /Editable walkthrough: Manual customer/);
  assert.match(h.element('screen').innerHTML, /schedule could not load/);
  h.context.S.notes = 'New unsaved work';
  h.state.error = null;
  await h.context.loadAppointments();
  assert.equal(h.context.S.notes, 'New unsaved work', 'retry must not restore over current work');
  assert.equal(h.context.APPTS_ERROR, '');
});

test('explicit manual entry after a missing direct link uses the manual draft and never overwrites the requested draft', async () => {
  const draft = saved('walkthrough-1'), h = harness({ draft, manualDraft: saved('', 'Manual customer') });
  h.state.missing = true;
  await h.context.openApp();
  await h.context.openManualWalkthrough();
  assert.equal(h.context.REQUESTED_WALKTHROUGH_ID, '');
  assert.equal(h.context.S.name, 'Manual customer');
  assert.equal(h.context.walkthroughReady, true);
  assert.deepEqual(h.state.replaced, ['/crew/gameplan']);
  h.context.S.notes = 'Manual edit'; h.context.save();
  assert.deepEqual(JSON.parse(h.storage.get('egc_walkthrough_v3:walkthrough-1')), draft);
  assert.equal(JSON.parse(h.storage.get('egc_walkthrough_v3:manual')).S.notes, 'Manual edit');
});

test('login input cannot save over a requested walkthrough before it has loaded', () => {
  const draft = saved('walkthrough-1'), h = harness({ draft });
  h.context.save();
  assert.deepEqual(h.writes, []);
  assert.deepEqual(JSON.parse(h.storage.get('egc_walkthrough_v3:walkthrough-1')), draft);
});

test('a saved draft under earlier deposit terms preserves its work but requires fresh customer approval', async () => {
  const draft=saved('walkthrough-1');
  draft.S.termsVersion='2026-09-simple';
  draft.S.lockedPrice='1425';
  draft.S.priceManuallySet=true;
  const h=harness({draft});
  await h.context.openApp();
  assert.equal(h.context.S.notes,'Keep these field notes');
  assert.equal(h.context.S.lockedPrice,'1425');
  assert.equal(h.context.S.jobId,'prepared-job');
  assert.equal(h.context.S.approved,false);
  assert.equal(h.context.S.signature,'');
  assert.equal(h.context.S.termsVersion,'2026-09-deposit50');
});

test('an unsigned automatic draft discards its old-rate total while preserving field work', async () => {
  const draft = saved('walkthrough-1');
  Object.assign(draft.S, { approved: false, signature: '', lockedPrice: '1550', priceManuallySet: false });
  const h = harness({ draft });
  await h.context.openApp();
  assert.equal(h.context.S.lockedPrice, '');
  assert.equal(h.context.S.notes, 'Keep these field notes');
  assert.equal(h.context.S.pricingVersion, '2026-10-optionB-truck950');
});

test('a pricing update preserves both manually quoted totals and already signed totals', async () => {
  for (const manual of [false, true]) {
    const draft = saved('walkthrough-1');
    Object.assign(draft.S, { approved: !manual, signature: manual ? '' : 'saved-signature', lockedPrice: '1550', priceManuallySet: manual, pricingVersion: '2026-09-load1000-pressure400', hazards: ['Pest waste'] });
    const h = harness({ draft });
    await h.context.openApp();
    assert.equal(h.context.S.lockedPrice, '1550');
    assert.equal(h.context.S.approved, !manual);
    assert.equal(h.context.S.signature, manual ? '' : 'saved-signature');
  }
});

test('an unsigned draft under the previous truck rates recalculates a newly chargeable pest hazard', async () => {
  const draft = saved('walkthrough-1');
  Object.assign(draft.S, { approved: false, signature: '', lockedPrice: '1000', priceManuallySet: false, pricingVersion: '2026-09-load1000-pressure400', hazards: ['Pest waste'] });
  const h = harness({ draft });
  await h.context.openApp();
  assert.equal(h.context.S.lockedPrice, '');
  assert.equal(h.context.S.hazards[0], 'Pest waste');
  assert.equal(h.context.S.pricingVersion, '2026-10-optionB-truck950');
});

// WP5 read fix (critic V9): no Firestore SDK jobs read remains on the gameplan.
test('the gameplan reads walkthroughs only through the server, never the Firestore SDK', async () => {
  assert.doesNotMatch(html, /hubDb|\.collection\(|firebase\.firestore|firebase-firestore-compat/);
  assert.match(html, /firebase-auth-compat\.js/, 'the Hub sign-in keeps its Firebase session');
  const h = harness();
  await h.context.openApp();
  assert.deepEqual(h.state.calls.map(call => call.url), ['/api/walkthrough-handoff?view=walkthroughs&walkthroughId=walkthrough-1']);
  assert.equal(h.context.walkthroughReady, true);
  assert.deepEqual([...h.context.APPTS].map(row => row.id), ['walkthrough-1', 'other-walkthrough']);
});

// The server side of the same read: a Sales estimator (no business_access, so no Firestore schedule read) opens the
// walkthrough assigned to them; only the gameplan prefill leaves the server.
const NOW = new Date('2026-10-17T16:00:00.000Z'), TODAY = '2026-10-17';
const salesRep = { user: 'Sales.Rep', displayName: 'Synthetic Sales Rep', role: 'sales', businessAccess: false, source: 'employee-account', staffRoles: ['sales'] };
const PRIVATE = { notes: 'Private office note', internalNotes: 'Private internal brief', estimate: { amount: 1200 }, signatureData: 'data:image/png;base64,AAAA', opsNotes: 'Private ops note' };
function walkthroughStore() {
  const visit = (id, extra) => ({ id, revision: `${id}-r`, type: 'walkthrough', status: 'scheduled', pipelineStatus: 'scheduled', date: TODAY, time: '10:00', endTime: '11:00', customer: `Customer ${id}`, phone: '9705550100', address: '1 Fixture Lane', ...PRIVATE, ...extra });
  const rows = new Map([
    ['w-own', visit('w-own', { time: '13:00', assignedCrew: ['sales.rep'], email: 'own@example.invalid', highlevelContactId: 'contact-own', highlevelOpportunityId: 'opp-own', highlevelAppointmentId: 'appt-own', source: 'Door knock', customerInstructions: 'Gate code is on the call notes' })],
    ['w-other', visit('w-other', { assignedCrew: ['sales.two'] })],
    ['w-started', visit('w-started', { time: '09:00', assignedCrew: ['sales.two'], walkthroughVisit: { startedBy: 'Sales.Rep', startedAt: '2026-10-17T15:00:00.000Z' } })],
    ['w-unassigned', visit('w-unassigned', { time: '15:00', assignedCrew: [] })],
    ['w-cancelled', visit('w-cancelled', { status: 'cancelled', pipelineStatus: 'cancelled', assignedCrew: ['sales.rep'] })],
    ['job-1', { ...visit('job-1', { assignedCrew: ['sales.rep'] }), type: 'job' }],
  ]);
  const calls = { list: [], read: [] };
  return { rows, calls, store: { async read(id) { calls.read.push(id); return structuredClone(rows.get(id) || null); }, async walkthroughsOn(date) { calls.list.push(date); return [...rows.values()].filter(row => row.date === date).map(row => structuredClone(row)); } } };
}
async function getView(actor, query, env = { EGC_STAFF_ROLE_PERMISSIONS: 'true' }, fixture = walkthroughStore()) {
  const handlers = handoffHandlers({ session: async () => actor, walkthroughs: () => fixture.store, storage: () => { throw new Error('the gameplan view never prepares a handoff'); }, now: () => NOW });
  const response = await handlers.get({ request: new Request(`https://hub.example.invalid/api/walkthrough-handoff?${query}`), env });
  return { response, body: await response.json(), fixture };
}

test('a Sales estimator login loads its assigned walkthrough and today’s own list from /api/walkthrough-handoff', async () => {
  const { response, body, fixture } = await getView(salesRep, 'view=walkthroughs&walkthroughId=w-own');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal(body.date, TODAY);
  assert.deepEqual(body.walkthroughs.map(row => row.id), ['w-started', 'w-own'], 'assigned or started by this rep, by start time; never another rep\'s');
  assert.deepEqual({ ...body.requested, walkthroughState: undefined }, { ...body.walkthroughs[1], walkthroughState: undefined });
  const own = body.requested;
  assert.deepEqual([own.id, own.type, own.customer, own.phone, own.email, own.address, own.time, own.highlevelContactId, own.highlevelOpportunityId, own.highlevelAppointmentId, own.source, own.customerInstructions, own.walkthroughState],
    ['w-own', 'walkthrough', 'Customer w-own', '9705550100', 'own@example.invalid', '1 Fixture Lane', '13:00', 'contact-own', 'opp-own', 'appt-own', 'Door knock', 'Gate code is on the call notes', 'open']);
  const text = JSON.stringify(body);
  for (const secret of ['Private office note', 'Private internal brief', 'Private ops note', 'data:image', 'estimate', '1200', 'assignedCrew', 'sales.two']) assert.equal(text.includes(secret), false, secret);
  assert.deepEqual(fixture.calls, { list: [TODAY], read: ['w-own'] }, 'one masked query for today and one read for the requested walkthrough');
});

test('another rep\'s, a cancelled or a non-walkthrough record is refused; a crew login cannot read the schedule at all', async () => {
  for (const [id, status, code] of [['w-other', 403, 'handoff_walkthrough_forbidden'], ['w-unassigned', 403, 'handoff_walkthrough_forbidden'], ['w-cancelled', 404, 'handoff_walkthrough_unavailable'], ['job-1', 404, 'handoff_walkthrough_unavailable'], ['missing', 404, 'handoff_walkthrough_unavailable']]) {
    const { response, body } = await getView(salesRep, `view=walkthroughs&walkthroughId=${id}`);
    assert.equal(response.status, status, id); assert.equal(body.code, code, id);
    assert.equal(JSON.stringify(body).includes('Customer'), false, `${id}: a refusal names no customer`);
  }
  const crew = { user: 'Crew.One', role: 'crew', businessAccess: false, source: 'employee-account', staffRoles: ['crew'] }, fixture = walkthroughStore();
  const refused = await getView(crew, 'view=walkthroughs', { EGC_STAFF_ROLE_ACCESS: 'true' }, fixture);
  assert.equal(refused.response.status, 403); assert.equal(refused.body.code, 'quote_forbidden');
  assert.deepEqual(fixture.calls, { list: [], read: [] }, 'nothing is read for a login without walkthrough access');
  const invalid = await getView(salesRep, 'view=walkthroughs&jobId=job-1');
  assert.equal(invalid.response.status, 400); assert.equal(invalid.body.code, 'handoff_invalid_request');
});

test('a booker (EGC_STAFF_ROLE_ACCESS Sales) and a dispatcher see every open walkthrough today, as /api/walkthrough-visit lets them', async () => {
  const booker = await getView({ ...salesRep, staffRoles: undefined }, 'view=walkthroughs', { EGC_STAFF_ROLE_ACCESS: 'true' });
  assert.equal(booker.response.status, 200);
  assert.deepEqual(booker.body.walkthroughs.map(row => row.id), ['w-started', 'w-other', 'w-own', 'w-unassigned']);
  assert.equal(booker.body.requested, null);
  const manager = await getView({ user: 'AlexK', role: 'manager', businessAccess: true, displayName: 'Alex' }, 'view=walkthroughs&walkthroughId=w-other', {});
  assert.equal(manager.response.status, 200);
  assert.equal(manager.body.requested.id, 'w-other');
  assert.deepEqual(manager.body.walkthroughs.map(row => row.id), ['w-started', 'w-other', 'w-own', 'w-unassigned']);
});

test('the walkthrough storage asks Firestore for today\'s jobs and one walkthrough with the gameplan field mask only', async () => {
  const sent = [];
  const fetcher = async (env, url, options = {}) => {
    sent.push({ url: String(url), body: options.body ? JSON.parse(options.body) : null });
    if (String(url).endsWith(':runQuery')) return new Response(JSON.stringify([{ readTime: '2026-10-17T16:00:00Z', document: { name: 'projects/egcw-1ec83/databases/(default)/documents/jobs/w-own', updateTime: '2026-10-17T15:00:00Z', fields: { type: { stringValue: 'walkthrough' }, date: { stringValue: TODAY } } } }]), { status: 200 });
    return new Response(JSON.stringify({ name: 'projects/egcw-1ec83/databases/(default)/documents/jobs/w-own', updateTime: '2026-10-17T15:00:00Z', fields: { type: { stringValue: 'walkthrough' } } }), { status: 200 });
  };
  const store = gameplanWalkthroughStorage({}, fetcher);
  assert.deepEqual((await store.walkthroughsOn(TODAY)).map(row => [row.id, row.type, row.revision]), [['w-own', 'walkthrough', '2026-10-17T15:00:00Z']]);
  const query = sent[0].body.structuredQuery;
  assert.deepEqual(query.where, { fieldFilter: { field: { fieldPath: 'date' }, op: 'EQUAL', value: { stringValue: TODAY } } });
  assert.deepEqual(query.select.fields.map(field => field.fieldPath), [...GAMEPLAN_WALKTHROUGH_FIELDS]);
  for (const field of ['notes', 'internalNotes', 'estimate', 'signatureData', 'acceptance', 'opsNotes']) assert.equal(GAMEPLAN_WALKTHROUGH_FIELDS.includes(field), false, field);
  assert.equal((await store.read('w-own')).id, 'w-own');
  const read = new URL(sent[1].url);
  assert.equal(read.pathname.endsWith('/jobs/w-own'), true);
  assert.deepEqual(read.searchParams.getAll('mask.fieldPaths'), [...GAMEPLAN_WALKTHROUGH_FIELDS]);
});
