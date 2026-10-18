// One working day, end to end, with the owner's flags on (EGC_QUOTE_BUILDER_ENABLED, EGC_DISPATCH_CREW_AUTO_ASSIGN,
// EGC_JOB_MATERIALS, EGC_GHL_SCHEDULE_MIRROR, EGC_STAFF_DIRECTORY_ENABLED, EGC_STAFF_ROLE_ACCESS and nothing else):
// the office books an estimator's walkthrough -> the estimator opens it in the gameplan through the server -> the quote
// builder (removal, then shelving, then extra storage) -> the send gate -> the signed handoff books Crew 1 on Tuesday with
// the job breakdown and the buy and bring lists -> the owner approves the menu prices and the held job is released -> the
// office purchase list -> the Crew 1 member's schedule, grab list and time clock -> the team directory -> the 9:30 and
// 17:00 rules and the weekend crew. It extends tests/estimator-e2e.test.mjs (one in-memory dispatch store) to the real
// handlers over their real storage modules: every request carries a real signed Hub session cookie, and every read and
// write goes through the Firestore REST API into one in-memory Firestore (tests/helpers/crew-day-firestore.mjs), so a
// record written by one screen is what the next screen reads. Synthetic people and customers only; any request to a host
// other than Firestore fails the test, so nothing reaches HighLevel, Google or a customer.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import vm from 'node:vm';
import { crewDayFirestore } from './helpers/crew-day-firestore.mjs';
import { createHubSessionCookie } from '../functions/_lib/hub-session.js';
import { dispatchHandlers } from '../functions/api/dispatch.js';
import { dispatchOpeningsHandlers } from '../functions/api/dispatch-openings.js';
import { handoffHandlers } from '../functions/api/walkthrough-handoff.js';
import { quoteDraftHandlers } from '../functions/api/quote-draft.js';
import { catalogHandlers } from '../functions/api/catalog.js';
import { purchaseListHandlers } from '../functions/api/purchase-list.js';
import { crewScheduleHandlers } from '../functions/api/crew-schedule.js';
import { staffDirectoryHandlers } from '../functions/api/staff-directory.js';
import * as fieldJobs from '../functions/api/field-jobs.js';
import * as employeeHub from '../functions/api/employee-hub.js';
import * as hubAuth from '../functions/api/hub-auth.js';
import * as crewJobs from '../functions/api/crew-jobs.js';
import { GAMEPLAN_WALKTHROUGH_FIELDS } from '../functions/_lib/gameplan-walkthroughs.js';
import { readCollection } from '../functions/_lib/employee-vault.js';
import { GHL_SCHEDULE_MIRROR } from '../functions/_lib/ghl-schedule-mirror.js';
import { LABOR_CENTS, SHELF, TOTES, menuItem, selection, signedPlan, client } from './helpers/estimator-fixture.mjs';
import { servedPricing } from './helpers/walkthrough-pricing.mjs';

const ORIGIN = 'https://easygaragecleaning.com';
// Monday 2026-10-19 (Denver, UTC-6): walkthroughs and the sale; Tuesday: Crew 1 does the job; Saturday: the weekend crew.
const MON = '2026-10-19', TUE = '2026-10-20', WED = '2026-10-21', SAT = '2026-10-24', SUN = '2026-10-25';
const at = (date, time) => Date.parse(`${date}T${time}:00-06:00`);
const iso = (date, time) => new Date(at(date, time)).toISOString();
const USERS = {
  ZacB: { passwordHash: 'unused-synthetic-owner-hash', role: 'owner', displayName: 'Synthetic Owner', payType: 'owner' },
  TylerG: { passwordHash: 'unused-synthetic-manager-hash', role: 'manager', displayName: 'Synthetic Manager', hourlyRate: 30 },
  'Sales.Person': { passwordHash: 'unused-synthetic-estimator-hash', role: 'sales', displayName: 'Synthetic Estimator', hourlyRate: 20, staffRoles: ['sales'] },
  'Crew1.Lead': { passwordHash: 'unused-synthetic-hash', role: 'crew_lead', displayName: 'Synthetic Crew One Lead', hourlyRate: 22, staffRoles: ['crew_lead'] },
  'Crew1.Mate': { passwordHash: 'unused-synthetic-hash', role: 'crew', displayName: 'Synthetic Crew One Mate', hourlyRate: 19 },
  'Crew2.Lead': { passwordHash: 'unused-synthetic-hash', role: 'crew_lead', displayName: 'Synthetic Crew Two Lead', hourlyRate: 22, staffRoles: ['crew_lead'] },
  'Crew2.Mate': { passwordHash: 'unused-synthetic-hash', role: 'crew', displayName: 'Synthetic Crew Two Mate', hourlyRate: 19 },
  'Crew3.Lead': { passwordHash: 'unused-synthetic-hash', role: 'crew_lead', displayName: 'Synthetic Crew Three Lead', hourlyRate: 22, staffRoles: ['crew_lead'] },
  'Crew3.Mate': { passwordHash: 'unused-synthetic-hash', role: 'crew', displayName: 'Synthetic Crew Three Mate', hourlyRate: 19 },
  // The team lead (Eli's role, D6): every crew's schedule, crew-lead field rights otherwise.
  Eli: { passwordHash: 'unused-synthetic-hash', role: 'team_lead', displayName: 'Synthetic Team Lead', hourlyRate: 24, staffRoles: ['team_lead'] },
};
// The owner's flags, exactly as set in Cloudflare Pages for this rollout, and the secrets every Hub deployment has.
const OWNER_FLAGS = { EGC_QUOTE_BUILDER_ENABLED: 'true', EGC_DISPATCH_CREW_AUTO_ASSIGN: 'true', EGC_JOB_MATERIALS: 'true', EGC_GHL_SCHEDULE_MIRROR: 'true', EGC_STAFF_DIRECTORY_ENABLED: 'true', EGC_STAFF_ROLE_ACCESS: 'true' };
const ENV = { HUB_SESSION_SECRET: 'synthetic-crew-day-session-secret-0123456789abcdef', EMPLOYEE_HUB_DATA_SECRET: 'synthetic-crew-day-vault-secret-0123456789', FIREBASE_API_KEY: 'firebase-test-crew-day',
  HUB_AUTH_USERS_JSON: JSON.stringify(USERS), ...OWNER_FLAGS };
const MONEY = /\$\s?\d|Cents"|retailPerPack|markup|"split"/;

// The Hub, as Cloudflare Pages serves it: each path to its real handler. The HighLevel first attempts after a dispatch
// save and the customer's estimate delivery are recorded instead of sent (the drain and the messenger are other tests).
function hub() {
  const sent = { mirror: [], tags: [], estimates: [] };
  const handlers = {
    '/api/dispatch': dispatchHandlers({ ghlMirror: async (_context, jobId, requestId) => { sent.mirror.push({ jobId, requestId }); return false; }, ghlTags: (_context, ids) => { sent.tags.push(...ids); } }),
    '/api/dispatch-openings': dispatchOpeningsHandlers(),
    '/api/walkthrough-handoff': handoffHandlers(),
    '/api/quote-draft': quoteDraftHandlers({ stripe: () => null, delivery: () => ({ deliver: async input => { sent.estimates.push(input); return { status: 'sent' }; } }) }),
    '/api/catalog': catalogHandlers({ cache: new Map() }),
    '/api/purchase-list': purchaseListHandlers(),
    '/api/crew-schedule': crewScheduleHandlers(),
    '/api/staff-directory': staffDirectoryHandlers({ revocations: () => null }),
    '/api/field-jobs': { get: fieldJobs.onRequestGet, post: fieldJobs.onRequestPost },
    '/api/employee-hub': { get: employeeHub.onRequestGet, post: employeeHub.onRequestPost },
    '/api/hub-auth': { get: hubAuth.onRequestGet },
    '/api/crew-jobs': { get: crewJobs.onRequestGet },
  };
  // A session signed at the moment of the request (the test clock jumps days; a Hub session lasts one work day).
  const cookie = async user => (await createHubSessionCookie(ENV, user)).split(';')[0];
  async function call(user, path, body, { method = body === undefined ? 'GET' : 'POST', env = ENV, headers = {} } = {}) {
    const url = new URL(path, ORIGIN), handler = handlers[url.pathname];
    assert.ok(handler, `no handler for ${url.pathname}`);
    const request = new Request(url, { method, headers: { ...(user ? { Cookie: await cookie(user) } : {}), ...(method === 'POST' ? { Origin: ORIGIN, 'Content-Type': 'application/json' } : {}), ...headers }, ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }) });
    const response = await handler[method.toLowerCase()]({ request, env, waitUntil: () => {} });
    const text = await response.text();
    let json = null; try { json = JSON.parse(text); } catch {}
    return { status: response.status, body: json, text };
  }
  const ok = async (...args) => { const result = await call(...args); assert.equal(result.status, 200, `${args[1]}: ${result.text}`); return result.body; };
  return { call, ok, sent, cookie };
}

function world(t, start) {
  t.mock.timers.enable({ apis: ['Date'], now: start });
  const fire = crewDayFirestore(t), api = hub();
  // The customers the office already has (lead intake made them); HighLevel ids are synthetic.
  for (const n of [1, 2, 3]) {
    const c = client(n);
    fire.put(`customers/c${n}`, { name: c.name, phone: c.phone, email: c.email, address: c.address, highlevelContactId: c.highlevel_contact_id, createdAt: '2026-10-01T15:00:00.000Z' });
  }
  return { fire, api, clock: ms => t.mock.timers.setTime(ms) };
}

// The owner's crew setup (Dispatch > Crews & vehicles): Create Crew 1/2/3, then each crew's members and lead.
async function setUpCrews(api) {
  const seeded = await api.ok('ZacB', '/api/dispatch', { action: 'crew.seed_defaults', requestId: randomUUID() });
  assert.deepEqual(seeded.resources.map(row => [row.name, row.code, row.priority, row.serviceDays]), [['Crew 1', 'crew-1', 1, ['mon', 'tue', 'wed', 'thu', 'fri']], ['Crew 2', 'crew-2', 2, ['mon', 'tue', 'wed', 'thu', 'fri']], ['Crew 3', 'crew-3', 3, ['sat', 'sun']]]);
  const crews = {};
  for (const [row, members] of seeded.resources.map((row, index) => [row, [`crew${index + 1}.lead`, `crew${index + 1}.mate`]])) {
    const saved = await api.ok('ZacB', '/api/dispatch', { action: 'crew.save', requestId: randomUUID(), id: row.id, expectedRevision: row.revision, changes: { memberIds: members, leadId: members[0] } });
    crews[row.code] = { id: row.id, name: row.name, members };
    assert.deepEqual([saved.resource.memberIds, saved.resource.leadId], [members, members[0]]);
  }
  return crews;
}

// The walkthrough gameplan (crew/gameplan.html) opening a booked walkthrough on the estimator's iPad: its own
// openApp/loadAppointments code, with EGCHubAuth.fetch going to the real GET /api/walkthrough-handoff?view=walkthroughs
// under the estimator's session. The page holds no Firestore SDK database; every other dependency is inert.
const GAMEPLAN = readFileSync(new URL('../crew/gameplan.html', import.meta.url), 'utf8');
async function gameplanPage(api, user, walkthroughId) {
  const line = prefix => GAMEPLAN.split(/\r?\n/).find(row => row.startsWith(prefix)) || assert.fail(prefix);
  const nodes = new Map(), storage = new Map(), calls = [];
  const element = id => { if (!nodes.has(id)) nodes.set(id, { style: {}, innerHTML: '', textContent: '' }); return nodes.get(id); };
  const context = vm.createContext({
    PRICING: servedPricing(), loadPricing: async () => {}, URLSearchParams, $: element, esc: value => String(value).replaceAll('<', '&lt;'),
    SAVE: 'egc_walkthrough_v3', FLOW: '2026-09-simple', REQUESTED_WALKTHROUGH_ID: walkthroughId, walkthroughReady: false, APPTS_LOADING: false, APPTS_ERROR: '', APPTS: [],
    index: 0, error: '', SLOT_OPTIONS: [], SLOT_ERROR: '', SLOT_LOADING: false, SLOT_SIGNATURE: '', sections: ['Customer', 'Photos', 'Scope', 'Finish', 'Schedule', 'Review'],
    screens: Array.from({ length: 6 }, () => () => `<div>Walkthrough for ${context.S.name}</div>`),
    localStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value) },
    location: { pathname: '/crew/gameplan', search: `?walkthroughId=${walkthroughId}` }, history: { replaceState() {} },
    refreshPhotoCount() {}, mountPhotos() {}, slotSignature: () => '', findNearestSlots() {}, initSignature() {}, setTimeout() {},
    EGCHubAuth: { canRunBusiness: () => false, fetch: async (url, init = {}) => { calls.push(url); const result = await api.call(user, url); return { ok: result.status === 200, status: result.status, json: async () => result.body }; } },
  });
  vm.runInContext(line('const freshState='), context);
  context.S = vm.runInContext('freshState()', context);
  for (const prefix of ['const draftKey=', 'function save(){', 'function restore(', 'function applyPricingVersion(', 'function resetForWalkthrough(', 'function render(){', 'function useAppointment(', 'async function openApp()']) vm.runInContext(line(prefix), context);
  vm.runInContext(GAMEPLAN.slice(GAMEPLAN.indexOf('function walkthroughLoadPanel(){'), GAMEPLAN.indexOf('function useAppointment(')), context);
  await context.openApp();
  return { context, calls, screen: () => element('screen').innerHTML };
}

// The crew home (crew/index.html) and its field outbox (crew/field-outbox.js), run as the phone runs them, with every
// request going to the real handlers under the crew member's own session: GET /api/hub-auth and /api/employee-hub, the
// Time clock card's Clock in / Clock out (the outbox's POST /api/employee-hub, the timecard path Today's work uses) and
// the Next assigned work card (GET /api/crew-jobs). The one location fix is the phone's.
const HOME = readFileSync(new URL('../crew/index.html', import.meta.url), 'utf8'), OUTBOX = readFileSync(new URL('../crew/field-outbox.js', import.meta.url), 'utf8');
async function crewHome(api, user) {
  const nodes = new Map(), calls = [], listeners = {};
  const element = id => { if (!nodes.has(id)) nodes.set(id, { id, hidden: false, textContent: '', innerHTML: '', className: '', dataset: { businessHref: '/crew/prejob' }, setAttribute() {}, classList: { toggle() {} }, querySelector: () => ({ addEventListener() {} }) }); return nodes.get(id); };
  const route = async (url, init = {}) => {
    const method = (init.method || 'GET').toUpperCase(), path = String(url);
    calls.push(`${method} ${path}`);
    const result = await api.call(user, path, init.body === undefined ? undefined : JSON.parse(init.body), { method });
    return new Response(result.text, { status: result.status, headers: { 'Content-Type': 'application/json' } });
  };
  const profile = (await api.ok(user, '/api/hub-auth'));
  const script = HOME.slice(HOME.lastIndexOf('<script>') + '<script>'.length, HOME.lastIndexOf('</script>'));
  const context = vm.createContext({
    Date, Intl, URLSearchParams, Promise, Set, Map, Number, String, Array, Math, JSON, Object, Error, TypeError, Boolean, encodeURIComponent, console, AbortSignal, Response,
    location: { search: '' }, navigator: { onLine: true, geolocation: { getCurrentPosition(resolve) { resolve({ coords: { latitude: 40.5852601, longitude: -105.0844233, accuracy: 9.6 } }); } } },
    addEventListener(type, listener) { listeners[type] = listener; }, confirm: () => true, crypto: { randomUUID }, document: { getElementById: element }, fetch: route,
    EGCHubAuth: { profile: () => profile, canRunBusiness: () => profile.businessAccess === true, canRunWalkthrough: () => false, mountCrewNav() {}, fetch: route },
  });
  context.window = context;
  vm.runInContext(OUTBOX, context);
  vm.runInContext(script, context);
  return { context, calls, card: () => element('crew-overview').innerHTML, next: () => element('next-work').innerHTML };
}

test('estimator to crew, one day through the real handlers: walkthrough, builder, send gate, signed handoff, owner approval, purchase list, crew schedule, grab list, clock and team directory', async t => {
  const { fire, api, clock } = world(t, at(MON, '08:00'));
  const crews = await setUpCrews(api);

  // 1) The office books a walkthrough for the estimator, and the estimator (Sales role, no business access) opens the
  // gameplan: its walkthrough list comes from GET /api/walkthrough-handoff?view=walkthroughs, never a Firestore SDK read.
  const booked = await api.ok('TylerG', '/api/dispatch', { action: 'schedule.create', requestId: randomUUID(), customerId: 'c1', kind: 'walkthrough', changes: { date: MON, time: '10:00', endTime: '11:00', title: 'Garage walkthrough', assignedCrew: ['sales.person'] } });
  const walkthrough = booked.job;
  assert.deepEqual([walkthrough.type, walkthrough.date, walkthrough.time, walkthrough.assignedCrew], ['walkthrough', MON, '10:00', ['sales.person']]);
  clock(at(MON, '09:50'));
  const mark = fire.mark();
  const today = await api.ok('Sales.Person', `/api/walkthrough-handoff?view=walkthroughs&walkthroughId=${walkthrough.id}`);
  assert.deepEqual(today.walkthroughs.map(row => [row.id, row.time, row.customer]), [[walkthrough.id, '10:00', client(1).name]]);
  assert.equal(today.requested.id, walkthrough.id);
  assert.equal(today.requested.address, client(1).address);
  assert.doesNotMatch(JSON.stringify(today), /estimate|signature|internalNotes|crew1\./i, 'no money, signatures or crew on the estimator\'s list');
  const reads = fire.since(mark);
  assert.deepEqual(reads.map(row => [row.method, row.action || row.path]), [['GET', `jobs/${walkthrough.id}`], ['POST', 'runQuery']], 'one masked walkthrough read and one masked query of today\'s jobs');
  assert.deepEqual(reads[1].body.structuredQuery.select.fields.map(field => field.fieldPath), [...GAMEPLAN_WALKTHROUGH_FIELDS]);
  assert.deepEqual(reads[1].body.structuredQuery.where, { fieldFilter: { field: { fieldPath: 'date' }, op: 'EQUAL', value: { stringValue: MON } } });
  // The gameplan page itself, opened from the crew home's "Start walkthrough" link, fills the customer from that answer.
  assert.doesNotMatch(GAMEPLAN, /firebase\.firestore\(|\.collection\(['"]jobs['"]\)/, 'the gameplan holds no Firestore SDK database');
  const page = await gameplanPage(api, 'Sales.Person', walkthrough.id);
  assert.deepEqual(page.calls, [`/api/walkthrough-handoff?view=walkthroughs&walkthroughId=${walkthrough.id}`]);
  assert.deepEqual([page.context.walkthroughReady, page.context.S.sourceWalkthroughId, page.context.S.name, page.context.S.address, page.context.APPTS.map(row => row.id)], [true, walkthrough.id, client(1).name, client(1).address, [walkthrough.id]]);
  assert.match(page.screen(), new RegExp(`Walkthrough for ${client(1).name}`));
  // A crew member is no walkthrough author: the same request is refused.
  assert.deepEqual((await api.call('Crew1.Mate', `/api/walkthrough-handoff?view=walkthroughs&walkthroughId=${walkthrough.id}`)).body.code, 'quote_forbidden');

  // 2) The quote builder (crew/quote-draft.js over /api/quote-draft): removal, then shelving, then extra storage, each
  // step priced by the server from the owner's menu with a running total; the estimator never sees a cost.
  clock(at(MON, '10:40'));
  const menu = await api.ok('Sales.Person', '/api/quote-draft?view=builder');
  assert.deepEqual([menu.enabled, menu.steps, menu.viewer.internal, 'internal' in menu], [true, ['removal', 'shelving', 'storage'], false, false]);
  assert.doesNotMatch(JSON.stringify(menu), /retailPerPackCents|goodsMarkup/, 'sell prices only');
  // D12: the owner's labor rate, approved, on the estimator's menu; installation is billed through the Labor line.
  assert.deepEqual([menu.labor.rateCents, menu.labor.approved, menu.installation], [4000, true, { included: true, billedAs: 'labor' }]);
  // The step previews carry no labor (as crew/quote-draft.js sends them); the review prices the estimator's man-hours.
  const chosen = selection(), { labor: _labor, ...items } = chosen, upTo = steps => ({ ...items, steps, ...Object.fromEntries(['removal', 'shelving', 'storage'].filter(step => !steps.includes(step)).map(step => [step, []])) });
  const removal = await api.ok('Sales.Person', '/api/quote-draft', { action: 'composite_preview', compositePricing: upTo(['removal']) });
  const shelving = await api.ok('Sales.Person', '/api/quote-draft', { action: 'composite_preview', compositePricing: upTo(['removal', 'shelving']) });
  const priced = await api.ok('Sales.Person', '/api/quote-draft', { action: 'composite_preview', compositePricing: chosen });
  assert.deepEqual(priced.steps.map(step => [step.id, step.runningTotalCents]), [['removal', removal.totalCents], ['shelving', shelving.totalCents], ['storage', priced.totalCents - LABOR_CENTS], ['labor', priced.totalCents]]);
  assert.ok(removal.totalCents < shelving.totalCents && shelving.totalCents < priced.totalCents);
  assert.deepEqual([priced.lineItems.at(-1).id, priced.lineItems.at(-1).name, priced.lineItems.at(-1).totalCents, priced.labor.prefilledManHours, priced.labor.adjusted], ['labor', 'Labor: 6 man-hours × $40.00', LABOR_CENTS, 6, false]);
  assert.deepEqual(priced.breakdown.sections.map(section => section.id), ['removal', 'shelving', 'storage']);
  // The server prices the selection again on save: a browser-made line is refused, the server's lines are kept.
  const prepared = await api.ok('Sales.Person', `/api/walkthrough-handoff?sourceWalkthroughId=${walkthrough.id}`);
  const draftOf = (lines, extra = {}) => ({ client: client(1), title: 'Garage reset', scope: 'Removal, then shelving, then extra storage.', line_items: lines, valid_until: '2026-11-02', catalog_version: priced.menuVersion, crew_size: 2, estimated_duration_min: 180, composite_pricing: chosen, ...extra });
  const cheaper = priced.lineItems.map((line, index) => index ? line : { ...line, unitCents: line.unitCents - 10000, totalCents: line.totalCents - 10000 });
  const tampered = await api.call('Sales.Person', '/api/quote-draft', { action: 'save', requestId: randomUUID(), customerId: 'c1', sourceWalkthroughId: walkthrough.id, sourceRevision: prepared.sourceRevision, draft: draftOf(cheaper) });
  assert.deepEqual([tampered.status, tampered.body.code], [409, 'quote_draft_composite_price_changed']);
  // A cheaper Labor line, or a rate sent with the selection, is refused the same way.
  const cheapLabor = priced.lineItems.map(line => line.id === 'labor' ? { ...line, name: 'Labor: 6 man-hours × $20.00', unitCents: 12000, totalCents: 12000 } : line);
  const laborTampered = await api.call('Sales.Person', '/api/quote-draft', { action: 'save', requestId: randomUUID(), customerId: 'c1', sourceWalkthroughId: walkthrough.id, sourceRevision: prepared.sourceRevision, draft: draftOf(cheapLabor) });
  assert.deepEqual([laborTampered.status, laborTampered.body.code], [409, 'quote_draft_composite_price_changed']);
  const rateSent = await api.call('Sales.Person', '/api/quote-draft', { action: 'save', requestId: randomUUID(), customerId: 'c1', sourceWalkthroughId: walkthrough.id, sourceRevision: prepared.sourceRevision, draft: draftOf(priced.lineItems, { composite_pricing: { ...chosen, labor: { ...chosen.labor, rateCents: 2000 } } }) });
  assert.deepEqual([rateSent.status, rateSent.body.code], [400, 'quote_draft_composite_invalid_labor']);
  const saved = await api.ok('Sales.Person', '/api/quote-draft', { action: 'save', requestId: randomUUID(), customerId: 'c1', sourceWalkthroughId: walkthrough.id, sourceRevision: prepared.sourceRevision, draft: draftOf(priced.lineItems) });
  const draft = saved.job;
  assert.deepEqual([draft.estimate.amountCents, fire.get(`jobs/${draft.id}`).quoteDraft.compositePricing.steps], [priced.totalCents, ['removal', 'shelving', 'storage']]);
  // Draft menu prices: the quote is saved but the customer send is refused, each held price with its reason.
  const preview = await api.call('Sales.Person', '/api/quote-draft', { action: 'send_preview', jobId: draft.id, expectedRevision: fire.get(`jobs/${draft.id}`).updateTime });
  assert.deepEqual([preview.status, preview.body.code], [409, 'quote_draft_composite_prices_unapproved']);
  const held = preview.body.details.unapproved;
  assert.deepEqual(held.map(row => row.name), ['Two-car garage base', SHELF.name, TOTES.name], 'the labor rate is the owner\'s and installation is billed through it, so neither holds the send');
  assert.ok(held.every(row => typeof row.reason === 'string' && row.reason.length > 20), 'every held price says why');
  assert.equal(fire.get(`jobs/${draft.id}`).estimate.status, 'draft', 'nothing went to the customer');

  // 4) Back on the first walkthrough the customer signs in person. The gameplan offers crew openings (crew-mode, no
  // roster), the customer picks Tuesday 9:30 with Crew 1, and the signed handoff books it: the server prices the builder
  // selection again, staffs Crew 1 inside the dispatch locks and writes the job breakdown and the buy and bring lists.
  clock(at(MON, '11:05'));
  const openings = await api.ok('Sales.Person', `/api/walkthrough-handoff?view=crew_openings&startDate=${TUE}&durationMinutes=180&travelBufferMinutes=20`);
  assert.deepEqual(openings.openings.slice(0, 2), [{ date: TUE, time: '09:30', endTime: '12:30', crewId: crews['crew-1'].id, crewLabel: 'Crew 1', priority: 1 }, { date: TUE, time: '09:30', endTime: '12:30', crewId: crews['crew-2'].id, crewLabel: 'Crew 2', priority: 2 }]);
  assert.doesNotMatch(JSON.stringify(openings), /crew1\.|crew2\.|employeeIds|roster|Synthetic Customer/, 'no employee and no other customer');
  const resume = await api.ok('Sales.Person', `/api/walkthrough-handoff?sourceWalkthroughId=${walkthrough.id}&jobId=${draft.id}`);
  assert.deepEqual([resume.jobId, resume.roster, resume.crewAutoAssign], [draft.id, [], true]);
  const signedLines = priced.lineItems.map(line => ({ id: line.id, kind: line.kind, name: line.name, description: line.description, quantity: line.quantity, unitCents: line.unitCents, totalCents: line.totalCents }));
  const handoff = { actorId: 'Sales.Person', requestId: randomUUID(), customerId: 'c1', sourceWalkthroughId: walkthrough.id, sourceRevision: resume.sourceRevision, jobId: draft.id, expectedRevision: resume.expectedRevision,
    plan: signedPlan(1, { total: priced.totalCents / 100, date: TUE, start: '09:30', end: '12:30', quote: { composite_pricing: priced.compositePricing, line_items: signedLines, catalog_version: priced.menuVersion }, logistics: { crew_id: openings.openings[0].crewId } }) };
  const signed = await api.ok('Sales.Person', '/api/walkthrough-handoff', handoff);
  const job = () => fire.get(`jobs/${draft.id}`);
  assert.equal(signed.job.id, draft.id, 'the saved builder quote becomes the signed job');
  assert.deepEqual(signed.crew, { status: 'assigned', crewName: 'Crew 1', priority: 1, date: TUE, time: '09:30', endTime: '12:30' });
  assert.doesNotMatch(JSON.stringify(signed), /crew1\.|crew2\./, 'the estimator sees the crew, never its people');
  assert.deepEqual([job().status, job().date, job().time, job().endTime, job().crewId, job().assignedCrew, job().crewLead, job().soldNeedsCrew ?? null], ['scheduled', TUE, '09:30', '12:30', crews['crew-1'].id, ['crew1.lead', 'crew1.mate'], 'crew1.lead', null]);
  assert.deepEqual(job().estimate.amountCents ?? Math.round(job().estimate.amount * 100), priced.totalCents);
  // The job breakdown, by step, and what to buy (packs, store, product page) and what the crew brings from stock.
  assert.deepEqual(job().jobBreakdown.sections.map(section => section.id), ['removal', 'shelving', 'storage', 'cleaning', 'labor']);
  assert.deepEqual(job().jobBreakdown.sections.at(-1).items, ['6 man-hours (about 3 hours on site for a crew of 2)'], 'the crew sees the man-hours sold, never the rate or amount');
  // The total the customer signed, its deposit and the HighLevel deal value (job.total) include the Labor line.
  assert.deepEqual([job().total, job().estimate.depositRequired, job().estimate.lineItems.at(-1).name], [priced.totalCents / 100, Math.round(priced.totalCents / 2) / 100, 'Labor: 6 man-hours × $40.00']);
  assert.deepEqual(job().jobBreakdown.sections.find(section => section.id === 'shelving').items, [`${SHELF.name} × 2 packs`]);
  assert.deepEqual(job().jobBreakdown.sections.find(section => section.id === 'storage').items, [`${TOTES.name} × 2 packs of 4`]);
  const buy = job().materials.filter(item => item.source === 'buy');
  assert.deepEqual(buy.map(item => [item.name, item.quantity, item.packs, item.unitsPerPack, item.store, item.sku, item.productUrl, item.purchaseState]), [
    [SHELF.name, 2, 2, 1, 'The Home Depot', SHELF.sku, SHELF.productUrl, 'to_buy'], [TOTES.name, 8, 2, 4, 'The Home Depot', TOTES.sku, TOTES.productUrl, 'to_buy']]);
  assert.deepEqual(job().materials.filter(item => item.source === 'stock').map(item => item.name), ['Hand truck / dolly', 'Contractor bags']);
  assert.doesNotMatch(JSON.stringify([job().materials, job().jobBreakdown]), MONEY, 'the breakdown and the lists carry no price or cost');
  // Draft prices: booked and staffed, but held from the customer until the owner approves them.
  assert.deepEqual([job().pricesPendingApproval.status, job().pricesPendingApproval.reason, job().pricesPendingApproval.items.map(item => item.name)], ['pending', 'draft_prices', ['Two-car garage base', SHELF.name, TOTES.name]]);
  assert.equal(job().customerPortalInvitationRequestedAt, undefined, 'no estimate or deposit request yet');
  assert.deepEqual(signed.pricing, { source: 'builder', ready: false, pending: ['Two-car garage base', SHELF.name, TOTES.name] });
  // D9b: the HighLevel schedule mirror (contact, opportunity, note; no calendar needed) is queued in the same commit.
  const mirror = fire.list(GHL_SCHEDULE_MIRROR).filter(row => row.jobId === draft.id);
  assert.equal(mirror.length, 1);
  assert.deepEqual([mirror[0].kind, mirror[0].stage, mirror[0].status], ['scheduled', 'job_scheduled', 'pending']);
  assert.match(mirror[0].note.body, /Crew: Crew 1/);
  assert.match(mirror[0].note.body, /\nLabor: 6 man-hours \(about 3 hours on site for a crew of 2\)\n/, 'the HighLevel note names the man-hours, never the labor amount');

  // 3) The owner approves the draft menu prices on the quote (Hub > Catalog & pricing > Menu prices, POST /api/catalog
  // menu.approve): every held job those prices now cover is released in the same request. Catalog pricing is off (not
  // one of the owner's flags); the labor rate ($40.00, D12) is already approved and installation is billed through it,
  // so the approval of the menu prices alone releases the job.
  clock(at(MON, '12:00'));
  const ownerMenu = await api.ok('ZacB', '/api/quote-draft?view=builder');
  assert.deepEqual([ownerMenu.viewer.canApprove, ownerMenu.internal.approvalsRevision, ownerMenu.labor.rateCents, ownerMenu.labor.source, ownerMenu.installation], [true, null, 4000, 'default', { included: true, billedAs: 'labor' }]);
  assert.deepEqual((await api.ok('ZacB', '/api/catalog')).enabled, false, 'no Pricing tab: catalog pricing is off');
  // As the Menu prices screen does: the approvals revision the owner reviewed comes from the reloaded builder menu.
  const menuApproval = async extra => ({ action: 'menu.approve', requestId: randomUUID(), expectedRevision: (await api.ok('ZacB', '/api/quote-draft?view=builder')).internal.approvalsRevision, menuVersion: ownerMenu.menuVersion, settingsVersion: ownerMenu.settingsVersion, approve: [], revoke: [], ...extra });
  const drafts = priced.breakdown.lines.filter(line => !line.approved).map(line => ({ id: line.id, unitCents: line.unitCents }));
  assert.deepEqual(drafts.map(row => row.id), [menuItem('Two-car garage base').id, SHELF.id, TOTES.id]);
  const prices = await api.ok('ZacB', '/api/catalog', await menuApproval({ approve: drafts }));
  assert.deepEqual(prices.heldJobs, { released: [draft.id], waiting: 0, more: false }, 'every price approved: the job is released, labor included');
  assert.deepEqual([job().pricesPendingApproval, job().customerPortalInvitationRequestedAt, job().pricesRelease.source, job().pricesRelease.gate, job().compositeQuote.approval.ready], [null, iso(MON, '12:00'), 'menu.approve', 'approved_prices', true]);
  // A replayed approval (a lost response) changes nothing and releases nothing again. The owner keeps the $40.00 rate:
  // re-entering it is one change, recorded, and prices stay as they are.
  const again = await menuApproval({ laborRatePerManHourCents: 4000 }), once = await api.ok('ZacB', '/api/catalog', again), twice = await api.ok('ZacB', '/api/catalog', again);
  assert.deepEqual([once.replayed, twice.replayed, 'heldJobs' in twice, once.approvals.laborRatePerManHourCents], [false, true, false, 4000]);
  assert.deepEqual((await api.ok('Sales.Person', '/api/quote-draft?view=builder')).labor.source, 'owner');

  // 2, continued) The $750 full truck is the one price the menu itself approves: the estimator's removal-only quote for
  // the afternoon walkthrough is ready at once and goes to the customer (no draft price, no installation question).
  const second = (await api.ok('TylerG', '/api/dispatch', { action: 'schedule.create', requestId: randomUUID(), customerId: 'c2', kind: 'walkthrough', changes: { date: MON, time: '13:00', endTime: '14:00', title: 'Junk walkthrough', assignedCrew: ['sales.person'] } })).job;
  clock(at(MON, '13:40'));
  // The estimator keeps the labor pre-fill: the gameplan's estimate is a crew of 2 for 2 hours on site, so 4 man-hours.
  const truck = selection({ removal: [{ id: menuItem('Full truck load').id, quantity: 1 }], shelving: [], storage: [], labor: { manHours: null, estimate: { crewSize: 2, onSiteMinutes: 120 } } });
  const truckPriced = await api.ok('Sales.Person', '/api/quote-draft', { action: 'composite_preview', compositePricing: truck });
  assert.deepEqual([truckPriced.totalCents, truckPriced.approval, truckPriced.labor.manHours, truckPriced.compositePricing.labor], [75000 + 16000, { ready: true, blocked: [] }, 4, { manHours: 4, estimate: { crewSize: 2, onSiteMinutes: 120 } }]);
  const truckSource = await api.ok('Sales.Person', `/api/walkthrough-handoff?sourceWalkthroughId=${second.id}`);
  const truckDraft = (await api.ok('Sales.Person', '/api/quote-draft', { action: 'save', requestId: randomUUID(), customerId: 'c2', sourceWalkthroughId: second.id, sourceRevision: truckSource.sourceRevision, draft: { client: client(2), title: 'Junk removal', scope: 'One full truck load.', line_items: truckPriced.lineItems, valid_until: '2026-11-02', catalog_version: truckPriced.menuVersion, crew_size: 2, estimated_duration_min: 120, composite_pricing: truckPriced.compositePricing } })).job;
  // A new quote's 25/75 payment dates need the job's date, so the send waits for it (an unchanged rule since 2026-10-14).
  const undated = await api.call('Sales.Person', '/api/quote-draft', { action: 'send_preview', jobId: truckDraft.id, expectedRevision: fire.get(`jobs/${truckDraft.id}`).updateTime });
  assert.deepEqual([undated.status, undated.body.code], [409, 'quote_draft_payment_dates_pending']);
  // The estimator books it (Sales is a booker, D2): the server staffs the first free weekday crew, Crew 1, on Wednesday.
  const truckBooked = await api.ok('Sales.Person', '/api/dispatch', { action: 'schedule.update', requestId: randomUUID(), jobId: truckDraft.id, expectedRevision: fire.get(`jobs/${truckDraft.id}`).updateTime, changes: { date: WED, time: '09:30', endTime: '11:30' } });
  assert.deepEqual([fire.get(`jobs/${truckDraft.id}`).date, fire.get(`jobs/${truckDraft.id}`).crewId, truckBooked.autoCrew?.status, truckBooked.autoCrew?.crewName], [WED, crews['crew-1'].id, 'assigned', 'Crew 1']);
  // D9b: the booking queued its HighLevel mirror (no calendar involved) and asked for its first attempt after the save.
  assert.deepEqual(fire.list(GHL_SCHEDULE_MIRROR).filter(row => row.jobId === truckDraft.id).map(row => [row.kind, row.stage, row.status]), [['scheduled', 'job_scheduled', 'pending']]);
  assert.ok(api.sent.mirror.some(row => row.jobId === truckDraft.id));
  const truckPreview = await api.ok('Sales.Person', '/api/quote-draft', { action: 'send_preview', jobId: truckDraft.id, expectedRevision: fire.get(`jobs/${truckDraft.id}`).updateTime });
  assert.match(truckPreview.summary, /\$910\.00/, 'the $750 truck and 4 man-hours of labor');
  const truckSent = await api.ok('Sales.Person', '/api/quote-draft', { action: 'send', requestId: randomUUID(), jobId: truckDraft.id, expectedRevision: fire.get(`jobs/${truckDraft.id}`).updateTime, confirmToken: truckPreview.confirmToken });
  assert.deepEqual([fire.get(`jobs/${truckDraft.id}`).estimate.status, fire.get(`jobs/${truckDraft.id}`).estimate.amount, fire.get(`jobs/${truckDraft.id}`).estimate.sentBy], ['sent', 910, 'Sales.Person']);
  // Customer messaging is not switched on here: the send is recorded and says so; HighLevel was not asked to text anyone.
  assert.deepEqual([truckSent.delivery.status, truckSent.warnings.map(row => row.code), api.sent.estimates], ['messaging_disabled', ['messaging_disabled'], []]);

  // A second sale the same afternoon, priced with the owner's approved menu: ready for the customer at once, booked by
  // the server on the first free crew for the Thursday opening the customer chose (Crew 1).
  const third = (await api.ok('TylerG', '/api/dispatch', { action: 'schedule.create', requestId: randomUUID(), customerId: 'c3', kind: 'walkthrough', changes: { date: MON, time: '14:30', endTime: '15:30', title: 'Shelving walkthrough', assignedCrew: ['sales.person'] } })).job;
  clock(at(MON, '15:00'));
  const small = selection({ removal: [{ id: menuItem('Full truck load').id, quantity: 1 }], shelving: [{ id: SHELF.id, quantity: 1 }], storage: [{ id: TOTES.id, quantity: 1 }] });
  const smallPriced = await api.ok('Sales.Person', '/api/quote-draft', { action: 'composite_preview', compositePricing: small });
  assert.deepEqual(smallPriced.approval, { ready: true, blocked: [] });
  const smallSource = await api.ok('Sales.Person', `/api/walkthrough-handoff?sourceWalkthroughId=${third.id}`);
  const thu = (await api.ok('Sales.Person', '/api/walkthrough-handoff?view=crew_openings&startDate=2026-10-22&durationMinutes=120')).openings[0];
  assert.deepEqual([thu.date, thu.time, thu.endTime, thu.crewLabel], ['2026-10-22', '09:30', '11:30', 'Crew 1']);
  const smallSigned = await api.ok('Sales.Person', '/api/walkthrough-handoff', { actorId: 'Sales.Person', requestId: randomUUID(), customerId: 'c3', sourceWalkthroughId: third.id, sourceRevision: smallSource.sourceRevision,
    plan: signedPlan(3, { total: smallPriced.totalCents / 100, date: thu.date, start: thu.time, end: thu.endTime, minutes: 120, quote: { composite_pricing: smallPriced.compositePricing, line_items: smallPriced.lineItems.map(line => ({ id: line.id, kind: line.kind, name: line.name, description: line.description, quantity: line.quantity, unitCents: line.unitCents, totalCents: line.totalCents })), catalog_version: smallPriced.menuVersion }, logistics: { crew_id: thu.crewId } }) });
  const smallJob = fire.get(`jobs/${smallSigned.job.id}`);
  assert.deepEqual([smallSigned.crew.crewName, smallSigned.pricing, smallJob.pricesPendingApproval ?? null, smallJob.customerPortalInvitationRequestedAt], ['Crew 1', { source: 'builder', ready: true, pending: [] }, null, iso(MON, '15:00')]);

  // 5) The office purchase list for the week (Hub > Purchase list, GET /api/purchase-list) sums the buy items across
  // both jobs by store and product, packs to buy and product page; marking ordered and then purchased is recorded on the
  // job with a management-only history event (the audit and the idempotency receipt in one commit).
  clock(at(MON, '16:00'));
  const week = await api.ok('TylerG', `/api/purchase-list?start=${MON}&end=${SUN}`);
  assert.deepEqual([week.jobs, week.lines, week.stores.map(store => store.store)], [2, 4, ['The Home Depot']]);
  assert.deepEqual(week.stores[0].products.map(row => [row.name, row.quantity, row.unitsPerPack, row.packsToBuy, row.productUrl, row.byState.to_buy, row.jobs.map(entry => [entry.jobId, entry.date, entry.packs])]), [
    [TOTES.name, 12, 4, 3, TOTES.productUrl, 12, [[draft.id, TUE, 2], [smallJob.id, '2026-10-22', 1]]],
    [SHELF.name, 3, 1, 3, SHELF.productUrl, 3, [[draft.id, TUE, 2], [smallJob.id, '2026-10-22', 1]]]]);
  assert.doesNotMatch(JSON.stringify(week), MONEY, 'no price, cost or margin on the purchase list');
  assert.equal((await api.call('Sales.Person', `/api/purchase-list?start=${MON}&end=${SUN}`)).body.code, 'purchase_forbidden');
  const buyIds = job().materials.filter(item => item.source === 'buy').map(item => item.id);
  assert.equal((await api.call('Crew1.Lead', '/api/purchase-list', { requestId: randomUUID(), jobId: draft.id, materialIds: buyIds, state: 'purchased' })).status, 403, 'the crew ticks Loaded on the job; the office buys');
  const ordered = await api.ok('TylerG', '/api/purchase-list', { requestId: randomUUID(), jobId: draft.id, materialIds: buyIds, state: 'ordered' });
  assert.deepEqual(ordered.changed.map(row => [row.name, row.from, row.to]), [[SHELF.name, 'to_buy', 'ordered'], [TOTES.name, 'to_buy', 'ordered']]);
  clock(at(MON, '17:30'));
  const purchase = { requestId: randomUUID(), jobId: draft.id, materialIds: buyIds, state: 'purchased' }, purchased = await api.ok('TylerG', '/api/purchase-list', purchase);
  assert.deepEqual(purchased.changed.map(row => [row.from, row.to]), [['ordered', 'purchased'], ['ordered', 'purchased']]);
  assert.deepEqual((await api.ok('TylerG', '/api/purchase-list', purchase)).alreadyApplied, true, 'a retried mark is answered from its receipt');
  const audit = fire.get(`jobs/${draft.id}/fieldEvents/${purchase.requestId}`);
  assert.deepEqual([audit.action, audit.actorId, audit.visibility, audit.state, audit.createdAt, audit.summary], ['purchase_state', 'TylerG', 'management', 'applied', iso(MON, '17:30'), `${SHELF.name}: ordered → purchased; ${TOTES.name}: ordered → purchased`]);
  assert.deepEqual(job().materials.filter(item => item.source === 'buy').map(item => [item.purchaseState, item.purchaseUpdatedBy]), [['purchased', 'TylerG'], ['purchased', 'TylerG']]);
  const after = await api.ok('TylerG', `/api/purchase-list?start=${MON}&end=${SUN}`);
  assert.deepEqual(after.stores[0].products.map(row => [row.name, row.byState.purchased, row.byState.to_buy]), [[TOTES.name, 8, 4], [SHELF.name, 2, 1]]);

  // 6) Tuesday morning. The Crew 1 member sees Crew 1's week on the crew schedule (GET /api/crew-schedule) and the job's
  // grab list on Today's work (GET /api/field-jobs, the crew job projection): store, SKU, product page and that the office
  // bought it, never a price. A Crew 2 member cannot open it, and only the team lead sees every crew.
  clock(at(TUE, '07:30'));
  const schedule = await api.ok('Crew1.Mate', '/api/crew-schedule');
  assert.deepEqual([schedule.scope, schedule.from, schedule.groups.map(group => [group.crew.name, group.crew.mine, group.crew.lead])], ['mine', TUE, [['Crew 1', true, 'Synthetic Crew One Lead']]]);
  assert.deepEqual(schedule.groups[0].jobs.map(row => [row.id, row.date, row.time, row.endTime, row.crewName, row.mine, row.canOpen]), [
    [draft.id, TUE, '09:30', '12:30', 'Crew 1', true, true], [truckDraft.id, WED, '09:30', '11:30', 'Crew 1', true, true], [smallJob.id, '2026-10-22', '09:30', '11:30', 'Crew 1', true, true]]);
  assert.doesNotMatch(JSON.stringify(schedule), /Synthetic Customer|Fixture Lane|970555|estimate/, 'first names only: no full name, address, phone or money');
  assert.deepEqual((await api.call('Crew1.Mate', '/api/crew-schedule?scope=all')).body.code, 'crew_schedule_forbidden');
  const lead = await api.ok('Eli', '/api/crew-schedule?scope=all');
  assert.deepEqual(lead.groups.map(group => [group.crew.name, group.jobs.length]), [['Crew 1', 3], ['Crew 2', 0], ['Crew 3', 0]], 'the team lead sees every crew');
  assert.deepEqual((await api.ok('Crew2.Mate', '/api/crew-schedule')).groups.map(group => [group.crew.name, group.jobs.length]), [['Crew 2', 0]]);
  const workday = await api.ok('Crew1.Mate', `/api/field-jobs?date=${TUE}`);
  assert.deepEqual(workday.jobs.map(row => [row.id, row.time, row.crewName]), [[draft.id, '09:30', 'Crew 1']]);
  const grab = workday.jobs[0].materials;
  assert.deepEqual(grab.filter(item => item.source === 'buy').map(item => [item.name, item.quantity, item.packs, item.unitsPerPack, item.store, item.sku, item.productUrl, item.purchaseState]), [
    [SHELF.name, 2, 2, 1, 'The Home Depot', SHELF.sku, SHELF.productUrl, 'purchased'], [TOTES.name, 8, 2, 4, 'The Home Depot', TOTES.sku, TOTES.productUrl, 'purchased']]);
  assert.deepEqual(grab.filter(item => item.source === 'stock').map(item => item.name), ['Hand truck / dolly', 'Contractor bags']);
  assert.match(workday.jobs[0].walkthroughBrief.find(row => row.label === 'Job breakdown').text, /^Removal: .*\nShelving: .*× 2 packs\nStorage: .*× 2 packs of 4\nLabor: 6 man-hours \(about 3 hours on site for a crew of 2\)$/s);
  assert.deepEqual(workday.jobs[0].walkthroughBrief.find(row => row.label === 'Man-hours sold'), { label: 'Man-hours sold', text: '6 man-hours' });
  assert.doesNotMatch(JSON.stringify(workday), MONEY, 'the crew sees no price, cost or margin');
  const detail = await api.ok('Crew1.Mate', `/api/field-jobs?jobId=${draft.id}`);
  assert.deepEqual(detail.job.materials, grab);
  const other = await api.call('Crew2.Mate', `/api/field-jobs?jobId=${draft.id}`);
  assert.deepEqual([other.status, other.body.code], [403, 'FIELD_JOB_NOT_ASSIGNED']);

  // The crew home's Time clock: its Clock in button calls crewClock('clock_in'), which sends the time action through
  // the field outbox to POST /api/employee-hub, the same timecard Today's work writes; Clock out submits the shift.
  const home = await crewHome(api, 'Crew1.Mate');
  await home.context.openCrewHome();
  assert.match(home.card(), /<strong>Clocked out<\/strong><small>Clocking in shares your location once<\/small><div class="clock-actions"><button type="button" class="clock-btn" onclick="crewClock\('clock_in'\)">Clock in<\/button>/);
  assert.match(home.next(), /<h2>Synthetic Customer 1<\/h2>.*<strong>Tue, Oct 20<\/strong>.*<strong>09:30–12:30<\/strong>.*">Open job brief<\/a>/s, 'Next assigned work is Tuesday\'s job');
  assert.ok(home.next().includes(`/crew/job.html?jobId=${draft.id}"`));
  clock(at(TUE, '09:20'));
  const before = home.calls.length;
  await home.context.crewClock('clock_in');
  // READ-BUDGET: the write answers with the saved timecard, so the card shows it without reading every Hub record again.
  assert.deepEqual(home.calls.slice(before), ['GET /api/hub-auth', 'POST /api/employee-hub'], 'the outbox checks the session and writes the timecard; no second full read');
  assert.match(home.card(), /<strong>Clocked in<\/strong>.*onclick="crewClock\('clock_out'\)">Clock out<\/button><small class="clock-note" role="status">Clocked in\. Your location was shared once; nothing tracks it during your shift\.<\/small>/s);
  const [shift] = await readCollection(ENV, 'timeEntries');
  assert.deepEqual([shift.employee, shift.status, shift.clockInAt, shift.clockOutAt, shift.locationStatus, shift.hourlyRate], ['Crew1.Mate', 'active', iso(TUE, '09:20'), '', 'job_page_single_fix', 19]);
  assert.deepEqual(shift.lastLocation, { lat: 40.58526, lng: -105.084423, accuracy: 10, capturedAt: iso(TUE, '09:20') });
  clock(at(TUE, '12:50'));
  const beforeOut = home.calls.length;
  await home.context.crewClock('clock_out');
  assert.ok(!home.calls.slice(beforeOut).includes('GET /api/employee-hub'), 'clocking out reads no full Employee Hub view either');
  assert.match(home.card(), /<strong>Clocked out<\/strong>.*Clocked out\. Your shift is submitted for approval\..*3\.50 hours · current two-week period/s);
  const reopened = await crewHome(api, 'Crew1.Mate');
  await reopened.context.openCrewHome();
  assert.equal(reopened.card().replace(/<small class="clock-note[^"]*" role="status">[^<]*<\/small>/, ''), home.card().replace(/<small class="clock-note[^"]*" role="status">[^<]*<\/small>/, ''), 'the card a fresh full read shows');
  const [closed] = await readCollection(ENV, 'timeEntries');
  assert.deepEqual([closed.id, closed.status, closed.approvalStatus, closed.clockOutAt, closed.history.map(row => row.action)], [shift.id, 'submitted', 'pending', iso(TUE, '12:50'), ['clock_in', 'clock_out']]);
  // The manager reviews it on the Hub time clock (GET /api/employee-hub): the shift waits for approval.
  const timesheet = (await api.ok('TylerG', '/api/employee-hub')).collections.timeEntries.find(entry => entry.id === shift.id);
  assert.deepEqual([timesheet.employee, timesheet.approvalStatus, timesheet.clockInAt, timesheet.clockOutAt], ['Crew1.Mate', 'pending', shift.clockInAt, closed.clockOutAt]);

  // 7) The team directory (D10): the crew member sets a shirt size and birthday; a teammate sees the size and the
  // birthday's month and day but never the birth year or age; a manager sees the age. Nobody edits another's card.
  const self = (await api.ok('Crew1.Mate', '/api/staff-directory?view=team')).people.find(person => person.self);
  assert.deepEqual([self.username, self.shirtSize, self.birthday, self.birthDate, self.revision], ['Crew1.Mate', null, null, null, '']);
  const forbidden = await api.call('Crew1.Lead', '/api/staff-directory', { action: 'set_personal', requestId: randomUUID(), username: 'Crew1.Mate', expectedRevision: self.revision, shirtSize: 'S' });
  assert.deepEqual([forbidden.status, forbidden.body.code], [403, 'staff_directory_forbidden']);
  const set = await api.ok('Crew1.Mate', '/api/staff-directory', { action: 'set_personal', requestId: randomUUID(), username: 'Crew1.Mate', expectedRevision: self.revision, shirtSize: 'L', birthDate: '1998-05-14' });
  assert.equal(set.ok, true);
  const seenBy = async viewer => (await api.ok(viewer, '/api/staff-directory?view=team')).people.find(person => person.username === 'Crew1.Mate');
  for (const teammate of ['Crew1.Lead', 'Crew2.Mate', 'Sales.Person']) {
    const card = await seenBy(teammate);
    assert.deepEqual([card.shirtSize, card.birthday, card.crews.map(crew => crew.name)], ['L', { month: 5, day: 14 }, ['Crew 1']], teammate);
    assert.deepEqual(['birthDate', 'age', 'phone', 'emergencyContact', 'highlevelUserId'].filter(key => key in card), [], `${teammate} sees no birth year or age`);
    assert.doesNotMatch(JSON.stringify(card), /1998/);
  }
  const managed = await seenBy('TylerG');
  assert.deepEqual([managed.shirtSize, managed.birthday, managed.birthDate, managed.age], ['L', { month: 5, day: 14 }, '1998-05-14', 28]);
  const own = await seenBy('Crew1.Mate');
  assert.deepEqual([own.birthDate, own.age, own.birthdayVisibleToTeam], ['1998-05-14', 28, true], 'the employee sees their own');
  // An employee who hides their birthday shows only the shirt size to the team.
  const quiet = (await api.ok('Crew2.Mate', '/api/staff-directory?view=team')).people.find(person => person.self);
  await api.ok('Crew2.Mate', '/api/staff-directory', { action: 'set_personal', requestId: randomUUID(), username: 'Crew2.Mate', expectedRevision: quiet.revision, shirtSize: '2XL', birthDate: '2001-12-02', birthdayVisibleToTeam: false });
  const hidden = (await api.ok('Crew1.Mate', '/api/staff-directory?view=team')).people.find(person => person.username === 'Crew2.Mate');
  assert.deepEqual([hidden.shirtSize, hidden.birthday], ['2XL', null]);

  // 8) The day's rules. Job openings start at 9:30 at the earliest and end by 17:00 (dispatchSettings default 09:00-17:00);
  // a walkthrough may still start at 9:00. Weekday openings are Crew 1 and Crew 2, the weekend's Crew 3 only.
  clock(at(TUE, '13:00'));
  const week2 = await api.ok('TylerG', `/api/dispatch-openings?startDate=${TUE}&endDate=2026-10-27&durationMinutes=120&crews=auto&kind=job`);
  assert.deepEqual([week2.constraints.workdayStart, week2.constraints.workdayEnd, week2.constraints.mode], ['09:00', '17:00', 'crews']);
  assert.ok(week2.candidates.length > 10);
  assert.ok(week2.candidates.every(row => row.time >= '09:30' && row.endTime <= '17:00' && row.endDate === row.date), 'never before 9:30, never past 17:00');
  const weekend = new Set([SAT, SUN]);
  assert.ok(week2.candidates.every(row => weekend.has(row.date) ? row.crewName === 'Crew 3' : ['Crew 1', 'Crew 2'].includes(row.crewName)), 'weekday crews on weekdays, the weekend crew on the weekend');
  assert.ok(week2.candidates.some(row => row.date === SAT && row.time === '09:30' && row.crewName === 'Crew 3'));
  const longest = await api.ok('TylerG', `/api/dispatch-openings?startDate=${SAT}&endDate=2026-10-26&durationMinutes=450&crews=auto&kind=job`);
  assert.deepEqual(longest.candidates.map(row => [row.date, row.time, row.endTime, row.crewName]), [[SAT, '09:30', '17:00', 'Crew 3'], [SUN, '09:30', '17:00', 'Crew 3']], 'a 7.5-hour job fits only 9:30 to 17:00');
  assert.deepEqual((await api.ok('TylerG', `/api/dispatch-openings?startDate=${SAT}&endDate=2026-10-26&durationMinutes=480&crews=auto&kind=job`)).candidates, [], 'an 8-hour job would end after 17:00 or start before 9:30');
  const walk = await api.ok('TylerG', '/api/dispatch-openings?startDate=2026-10-23&endDate=2026-10-24&durationMinutes=60&employeeIds=sales.person&kind=walkthrough');
  assert.equal(walk.candidates[0].time, '09:00', 'a walkthrough keeps its 9:00 start');
  // A job booked before 9:30 is refused, whoever books it; the same booking at 9:30 on Saturday goes to Crew 3.
  fire.put('customers/c4', { name: client(4).name, phone: client(4).phone, email: client(4).email, address: client(4).address, highlevelContactId: client(4).highlevel_contact_id, createdAt: '2026-10-01T15:00:00.000Z' });
  const booking = changes => ({ action: 'schedule.create', requestId: randomUUID(), customerId: 'c4', kind: 'job', changes: { jobInstructions: 'Weekend garage reset', crewNeeded: 2, ...changes } });
  for (const user of ['Sales.Person', 'TylerG']) {
    const early = await api.call(user, '/api/dispatch', booking({ date: SAT, time: '09:00', endTime: '11:00' }));
    assert.deepEqual([early.status, early.body.code], [400, 'dispatch_job_start_too_early'], user);
  }
  const earlySale = await api.call('Sales.Person', '/api/walkthrough-handoff', { actorId: 'Sales.Person', requestId: randomUUID(), customerId: 'c4', plan: signedPlan(4, { date: SAT, start: '09:00', end: '11:00', minutes: 120 }) });
  assert.deepEqual([earlySale.status, earlySale.body.code], [400, 'dispatch_job_start_too_early'], 'a signed sale cannot start before 9:30 either');
  const saturday = await api.ok('Sales.Person', '/api/dispatch', booking({ date: SAT, time: '09:30', endTime: '11:30' }));
  const weekendJob = fire.get(`jobs/${saturday.job.id}`);
  assert.deepEqual([saturday.autoCrew.status, saturday.autoCrew.crewName, weekendJob.crewId, weekendJob.assignedCrew, weekendJob.crewLead], ['assigned', 'Crew 3', crews['crew-3'].id, ['crew3.lead', 'crew3.mate'], 'crew3.lead']);
  assert.deepEqual((await api.ok('Crew3.Mate', '/api/crew-schedule')).groups.map(group => [group.crew.name, group.jobs.map(row => [row.date, row.time])]), [['Crew 3', [[SAT, '09:30']]]]);

  // Nothing in the whole day reached any service but the Hub's own Firestore.
  assert.deepEqual(fire.refused, []);
});
