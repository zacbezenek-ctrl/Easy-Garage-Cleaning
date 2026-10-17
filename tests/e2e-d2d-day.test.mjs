import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createPagesRouter } from './helpers/pages-router.mjs';
import { ROOT, firestoreRest } from './helpers/firestore-rest-queries.mjs';
import { approvedKnockSettings } from './helpers/knock-fixture.mjs';
import { syntheticHouses } from './knock-dev-server.mjs';
import { hashHubCredential } from '../functions/_lib/hub-session.js';
import { employeeInvitationStore } from '../functions/_lib/employee-accounts.js';
import { neighborhoodsByDistance } from '../crew/knock-doors.js';
import { drainScheduleMirror, scheduleMirrorStorage } from '../functions/_lib/ghl-schedule-mirror.js';
import { EGC_LOCATION } from '../functions/_lib/highlevel-calendars.js';
import { EGC_JOB_SCHEDULED_STAGE, EGC_PIPELINE, EGC_WALKTHROUGH_APPOINTMENT_STAGE } from '../functions/_lib/highlevel-pipeline.js';

/* E2E-D2D: one door-to-door rep's whole day, end to end, through the REAL Pages Functions (tests/helpers/pages-router.mjs
   routes every /api request through functions/_middleware.js to the production handler exports, rebuilt only with the
   injected clock), the real libraries and one in-memory Firestore (tests/helpers/firestore-rest-queries.mjs) shared by
   Knock, Dispatch, the encrypted staff vault and the HighLevel schedule mirror queue, as production shares one Firestore
   project. Every flag the owner will turn on is on. Nothing leaves the process: any request to a host other than
   Firestore is refused and recorded, and the test fails if one was attempted. Synthetic people and places only.

   The story (shared state, in order): the owner seeds Crew 1/2/3 and staffs them, gives Alex the estimator skill and
   Eli the team lead role; Rep One signs in, sorts the areas near the phone, claims the nearest, starts a shift and logs
   doors; sells Monday at the door (Crew 1); Rep Two sells the same Monday slot (Crew 2, the owner's example "slot booked
   for crew one, open slot for crew two"); a Saturday sale goes to Crew 3 and a weekday sale never does; Rep One sets an
   estimator walkthrough (13% setter / 7% estimator); each crew member, Eli and Alex read their schedules; HighLevel's
   second record is queued for every booking; My money shows the Hub jobs with commission pending; and the rep never
   sees another rep, another customer, the roster, costs or margins. */

const ORIGIN = 'https://easygaragecleaning.com';
const PASSWORD = 'Synthetic door-to-door day only!';
// Tuesday 2026-10-20 in Fort Collins (Denver time, UTC-6). A sale today may start a job on Saturday 2026-10-24 or later
// (three business days to cancel); Monday 2026-10-26 is the next weekday.
const AT = (hhmm, date = '2026-10-20') => Date.parse(`${date}T${hhmm}:00-06:00`);
const SAT = '2026-10-24', MON = '2026-10-26', TUE = '2026-10-27';
const MINUTE = 60000;
const CHECKLIST = { contractSigned: true, noticesHanded: true, rightToCancelTold: true };
const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri'];
// Where Rep One's phone is when the day starts: the north end of English Ranch.
const PHONE = { lat: 40.5560, lng: -105.0350 };

let serial = 0;
const uuid = () => `00000000-0000-4000-a000-${String(++serial).padStart(12, '0')}`;
const iso = ms => new Date(ms).toISOString();
// A whole-token match: 'eli' is a name, 'delivery' is not.
const mentions = (text, token) => new RegExp(`(?<![A-Za-z0-9])${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9])`).test(text);

// Configured Hub users (HUB_AUTH_USERS_JSON): [user, display name, role]. Eli is an employee account (below).
// The reps hold the least-privileged staff role (crew) and are marked as door-to-door reps by the door_to_door skill (D6);
// a Sales or Phone role would make them Hub bookers, who read the whole Dispatch board (see step 10).
const CONFIGURED = [['ZacB', 'Zac Owner', 'owner'], ['Rep.One', 'Rhea Rep', 'crew'], ['Rep.Two', 'Ravi Rep', 'crew'],
  ['Crew.A1', 'Andy Alpha', 'crew'], ['Crew.A2', 'Abe Alpha', 'crew'], ['Crew.B1', 'Bo Beta', 'crew'], ['Crew.B2', 'Ben Beta', 'crew'],
  ['Crew.C1', 'Cy Gamma', 'crew'], ['Crew.C2', 'Cal Gamma', 'crew'], ['Est.Alex', 'Alex Estimator', 'crew']];
// Every name, key and id a rep must never see of other people (roster ids, display names, the other rep).
const STAFF_SECRETS = ['crew.a1', 'crew.a2', 'crew.b1', 'crew.b2', 'crew.c1', 'crew.c2', 'est.alex', 'eli', 'Andy', 'Abe', 'Bo Beta', 'Ben', 'Cy Gamma', 'Cal', 'Alex Estimator', 'Eli Lead', 'Zac Owner', 'zacb'];

/* ---------- one Firestore for everything, reached through the global fetch every storage module uses ---------- */

function firestoreWorld(seed) {
  const fake = firestoreRest(seed), outside = [];
  const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const pathOf = name => decodeURIComponent(String(name).split('/documents/')[1] || '');
  async function fetcher(input, init = {}) {
    const url = new URL(input instanceof Request ? input.url : String(input)), method = (init.method || 'GET').toUpperCase();
    if (url.hostname !== 'firestore.googleapis.com') {
      outside.push(`${method} ${url.hostname}${url.pathname}`);
      throw new Error(`E2E: refused a request to ${url.hostname}; only the in-memory Firestore is reachable.`);
    }
    if (method === 'PATCH') {
      // The employee vault's single-document write (employee-vault.js writeOne, employee-accounts.js) as Firestore applies
      // it: one document, with its currentDocument precondition.
      const exists = url.searchParams.get('currentDocument.exists'), updateTime = url.searchParams.get('currentDocument.updateTime'), path = pathOf(url.pathname);
      const write = { update: { name: `${ROOT}/${path}`, fields: JSON.parse(init.body).fields || {} }, ...(exists === 'false' ? { currentDocument: { exists: false } } : updateTime ? { currentDocument: { updateTime } } : {}) };
      const done = await fake.fetcher({}, `https://firestore.googleapis.com/v1/${ROOT}:commit`, { method: 'POST', body: JSON.stringify({ writes: [write] }) });
      return done.ok ? reply(fake.documents.get(path)) : done;
    }
    const response = await fake.fetcher({}, url.href, init);
    if (method === 'POST' && url.pathname.endsWith(':commit') && response.ok) {
      // Firestore answers each write's updateTime (employee-vault.js commitVaultDocuments requires it).
      const body = await response.json(), writes = JSON.parse(init.body).writes || [];
      return reply({ ...body, writeResults: writes.map(write => ({ updateTime: fake.documents.get(pathOf(write.update.name))?.updateTime })) });
    }
    return response;
  }
  return { fake, fetcher, outside, get: fake.get, docs: prefix => [...fake.documents.keys()].filter(path => path.startsWith(prefix)).map(path => ({ path, id: path.split('/').pop(), ...fake.get(path) })) };
}

/* ---------- a synthetic HighLevel for the schedule mirror's delivery (never the real one) ---------- */

function fakeHighLevel() {
  const calls = [], contacts = new Map(), opportunities = new Map();
  const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  async function fetcher(input, init = {}) {
    const url = new URL(String(input)), method = (init.method || 'GET').toUpperCase(), body = init.body ? JSON.parse(init.body) : null;
    assert.equal(url.hostname, 'services.leadconnectorhq.com', 'the mirror only ever talks to HighLevel');
    calls.push({ method, path: url.pathname, search: url.search, body });
    if (method === 'POST' && url.pathname === '/contacts/upsert') { const id = `contact-${contacts.size + 1}`; contacts.set(id, { id, ...body }); return reply({ contact: { id } }); }
    if (method === 'GET' && url.pathname === '/opportunities/pipelines') return reply({ pipelines: [{ id: EGC_PIPELINE, name: 'EGC Pipeline', stages: [{ id: 'synthetic-new-lead', position: 0 }, { id: EGC_WALKTHROUGH_APPOINTMENT_STAGE, position: 1 }, { id: EGC_JOB_SCHEDULED_STAGE, position: 2 }] }] });
    if (method === 'GET' && url.pathname === '/opportunities/search') {
      const rows = [...opportunities.values()].filter(row => row.contactId === url.searchParams.get('contactId') && row.pipelineId === url.searchParams.get('pipelineId'));
      return reply({ opportunities: rows, meta: { total: rows.length } });
    }
    if (method === 'POST' && url.pathname === '/opportunities/') { const id = `opp-${opportunities.size + 1}`; opportunities.set(id, { id, ...body }); return reply({ opportunity: { id } }); }
    if (method === 'POST' && /^\/contacts\/[^/]+\/notes$/.test(url.pathname)) return reply({ note: { id: `note-${calls.length}` } });
    return reply({ message: 'Not part of the synthetic HighLevel' }, 404);
  }
  return { calls, contacts, opportunities, fetcher };
}

/* ---------- the neighborhoods around Rep One's phone ---------- */

const NEIGHBORHOOD = (name, extra = {}) => ({ name, tier: 'Volume', status: 'open', cityKey: 'fort-collins', holdReason: '', importedCount: 0, ...extra });
function territorySeed() {
  const english = syntheticHouses('english-ranch', { base: [40.5555, -105.0365], streets: ['BLUE LEAF DR', 'CANYON WREN CT'], perSide: 6 });
  const ridgewood = syntheticHouses('ridgewood-hills', { base: [40.5212, -105.0611], streets: ['SYNTHETIC RIDGE DR'], perSide: 6 });
  const harvest = syntheticHouses('harvest-park', { base: [40.4975, -105.0158], streets: ['PREVIEW PARK LN'], perSide: 5 });
  const premium = syntheticHouses('premium-point', { base: [40.5600, -105.0300], streets: ['PRIVATE ESTATE CT'], perSide: 2 });
  return {
    // No stored centers: the server places each listed neighborhood from a sample of its houses on first use.
    'knock_neighborhoods/english-ranch': NEIGHBORHOOD('English Ranch', { importedCount: Object.keys(english).length }),
    'knock_neighborhoods/ridgewood-hills': NEIGHBORHOOD('Ridgewood Hills', { importedCount: Object.keys(ridgewood).length }),
    'knock_neighborhoods/harvest-park': NEIGHBORHOOD('Harvest Park', { importedCount: Object.keys(harvest).length }),
    'knock_neighborhoods/premium-point': NEIGHBORHOOD('Premium Point', { tier: 'Premium', importedCount: Object.keys(premium).length }),
    'knock_neighborhoods/old-town-hold': NEIGHBORHOOD('Old Town Hold', { status: 'hold', holdReason: 'HOA review', importedCount: 4 }),
    'knock_neighborhoods/never-imported': NEIGHBORHOOD('Never Imported'),
    ...english, ...ridgewood, ...harvest, ...premium,
    'knock_reps/rep.one': { repKey: 'rep.one', username: 'Rep.One', displayName: 'Rhea Rep', role: 'knocker', status: 'active', permitListed: true, premiumCleared: false, leadKey: '', trainingMinutes: 0, createdAt: '2026-10-01T12:00:00.000Z' },
    'knock_reps/rep.two': { repKey: 'rep.two', username: 'Rep.Two', displayName: 'Ravi Rep', role: 'knocker', status: 'active', permitListed: true, premiumCleared: false, leadKey: '', trainingMinutes: 0, createdAt: '2026-10-01T12:00:00.000Z' },
    // The office gave Rep Two Ridgewood Hills last week.
    'knock_assignments/rep.two__ridgewood-hills__all': { repKey: 'rep.two', neighborhoodId: 'ridgewood-hills', street: '', active: true, source: 'admin', assignedAt: '2026-10-13T15:00:00.000Z', assignedBy: 'ZacB', endedAt: null },
    // Synthetic compensation approval (tests/helpers/knock-fixture.mjs): never a business decision.
    'knock_settings/current': approvedKnockSettings(),
  };
}

/* ---------- the world ---------- */

const W = {};

async function call(path, { cookie = '', body, method } = {}) {
  const request = new Request(ORIGIN + path, { method: method || (body === undefined ? 'GET' : 'POST'),
    headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json', Origin: ORIGIN }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const response = await W.router.fetch(request, W.env);
  const text = await response.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { unparsed: text.slice(0, 400) }; }
  return { status: response.status, body: json, headers: response.headers };
}
async function signIn(username, password = PASSWORD) {
  const response = await call('/api/hub-auth', { body: { username, password } });
  assert.equal(response.status, 200, `${username} signs in: ${JSON.stringify(response.body)}`);
  const cookie = response.headers.getSetCookie().map(line => line.split(';')[0]).find(line => line.startsWith('egc_hub_session='));
  assert.ok(cookie, `${username} gets a Hub session`);
  return { cookie, profile: response.body };
}
const ok = (response, label) => { assert.equal(response.status, 200, `${label}: ${JSON.stringify(response.body)}`); return response.body; };
const setClock = ms => { W.clock = ms; };
const jobs = () => W.db.docs('jobs/').filter(row => typeof row.type === 'string' && !row.recordType);
const jobFor = saleId => saleId ? jobs().find(row => row.knockSaleId === saleId) : undefined;
// Everything a rep's phone is answered is kept, so step 10 can check it all at once.
W.seen = { 'rep.one': [], 'rep.two': [] };
async function asRep(rep, path, options = {}) {
  const response = await call(path, { ...options, cookie: W.cookies[rep] });
  W.seen[rep].push({ path, status: response.status, body: response.body });
  return response;
}
const sync = (rep, events) => asRep(rep, '/api/knock-sync', { body: { events } });
const book = (rep, kind, id) => asRep(rep, '/api/knock-job-bridge', { body: { kind, id } });
const house = (n, street) => `h-${n}-${street.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
function saleEvents({ shiftId, houseId, at, ticket, pkg, customer, jobDate, jobStartTime = '09:30', slot = null, zip = '80525' }) {
  const knockId = uuid(), saleId = uuid();
  return { knockId, saleId, events: [
    { id: knockId, type: 'knock', shiftId, houseId, outcome: 'sold', quotedAmount: ticket, carOutside: true, at: iso(at) },
    { id: saleId, type: 'sale', knockId, houseId, at: iso(at + MINUTE), ticket, package: pkg, customer, checklist: CHECKLIST, jobDate, jobStartTime,
      textConsent: true, zip, city: 'Fort Collins', ...(slot ? { slot } : {}) },
  ] };
}

before(async () => {
  W.clock = AT('07:30');
  const users = {};
  for (const [user, displayName, role] of CONFIGURED) users[user] = { passwordHash: await hashHubCredential(user, PASSWORD), displayName, role };
  W.env = {
    HUB_SESSION_SECRET: 'synthetic-e2e-d2d-day-session-secret-0123456789abcdef',
    EMPLOYEE_HUB_DATA_SECRET: 'synthetic-e2e-d2d-day-vault-secret-0123456789abcdef',
    FIREBASE_API_KEY: 'firebase-test-e2e-d2d-day',
    HUB_AUTH_USERS_JSON: JSON.stringify(users),
    // Every flag the owner will turn on for the door-to-door launch.
    EGC_KNOCK_JOB_BRIDGE: 'true', EGC_DISPATCH_CREW_AUTO_ASSIGN: 'true', EGC_GHL_SCHEDULE_MIRROR: 'true',
    EGC_STAFF_DIRECTORY_ENABLED: 'true', EGC_STAFF_ROLE_ACCESS: 'true', EGC_JOB_MATERIALS: 'true',
  };
  W.db = firestoreWorld(territorySeed());
  W.realFetch = globalThis.fetch;
  globalThis.fetch = W.db.fetcher;
  W.router = createPagesRouter({ env: W.env, now: () => new Date(W.clock), middleware: true });
  // Eli signed up and was approved as crew (an encrypted employee account), as the Hub's staff signup leaves it.
  const store = employeeInvitationStore(W.env), at = '2026-10-01T12:00:00.000Z';
  await store.create({ username: 'Eli', usernameKey: 'eli', displayName: 'Eli Lead', firstName: 'Eli', lastName: 'Lead', email: 'eli@example.invalid', phone: '9705550199',
    ...(await store.password(PASSWORD)), status: 'approved', role: 'crew', payType: 'hourly', hourlyRate: 24, businessAccess: false,
    appliedAt: at, updatedAt: at, reviewedAt: at, reviewedBy: 'zacb', sessionVersion: 'synthetic-eli-v1' });
});

after(async () => {
  await W.router?.settle();
  if (W.realFetch) globalThis.fetch = W.realFetch;
});

describe('a door-to-door rep\'s day, end to end, with every launch flag on', () => {
  it('1) the owner seeds Crew 1/2/3, staffs them, gives Alex the estimator skill and Eli the team lead role', async () => {
    const zac = await signIn('ZacB');
    W.zac = zac.cookie;
    const seeded = ok(await call('/api/dispatch', { cookie: W.zac, body: { action: 'crew.seed_defaults', requestId: uuid() } }), 'crew.seed_defaults');
    assert.equal(seeded.created.length, 3);
    assert.deepEqual(seeded.warnings.map(row => row.code), ['crew_members_needed']);
    const byCode = Object.fromEntries(seeded.resources.map(row => [row.code, row]));
    assert.deepEqual(['crew-1', 'crew-2', 'crew-3'].map(code => [byCode[code].name, byCode[code].priority, byCode[code].serviceDays.join()]),
      [['Crew 1', 1, WEEKDAYS.join()], ['Crew 2', 2, WEEKDAYS.join()], ['Crew 3', 3, 'sat,sun']]);
    W.crews = {};
    for (const [code, members] of [['crew-1', ['crew.a1', 'crew.a2']], ['crew-2', ['crew.b1', 'crew.b2']], ['crew-3', ['crew.c1', 'crew.c2']]]) {
      const crew = byCode[code];
      const saved = ok(await call('/api/dispatch', { cookie: W.zac, body: { action: 'crew.save', requestId: uuid(), id: crew.id, expectedRevision: crew.revision, changes: { memberIds: members, leadId: members[0] } } }), `staff ${code}`);
      assert.deepEqual([saved.resource.memberIds, saved.resource.leadId, saved.resource.code], [members, members[0], code]);
      W.crews[code] = crew.id;
    }
    // Seeding again changes nothing: every code is held.
    const again = ok(await call('/api/dispatch', { cookie: W.zac, body: { action: 'crew.seed_defaults', requestId: uuid() } }), 'seed again');
    assert.deepEqual([again.created, again.existing.length], [[], 3]);

    // People: Alex estimates walkthroughs, the two reps knock doors (D6 skills); Eli becomes the team lead (D6, data).
    const directory = ok(await call('/api/staff-directory', { cookie: W.zac }), 'staff directory');
    const person = name => directory.people.find(row => row.username.toLowerCase() === name.toLowerCase());
    const revisions = {};
    for (const [username, skills] of [['Est.Alex', [{ id: 'walkthrough_estimating', level: 'proficient' }]], ['Rep.One', [{ id: 'door_to_door', level: 'proficient' }]], ['Rep.Two', [{ id: 'door_to_door', level: 'trainee' }]]]) {
      const saved = ok(await call('/api/staff-directory', { cookie: W.zac, body: { action: 'set_skills', requestId: uuid(), username, expectedRevision: person(username).revision, skills } }), `skills for ${username}`);
      assert.deepEqual(saved.person.skills.map(skill => [skill.id, skill.level]), skills.map(skill => [skill.id, skill.level]));
      revisions[username] = saved.person.revision;
    }
    // Alex's HighLevel user, so the walkthroughs he is booked for are assigned to him in HighLevel too. An ID in a form the
    // schedule mirror would ignore is refused here instead of being shown as linked (E2E-D2D fix).
    const malformed = await call('/api/staff-directory', { cookie: W.zac, body: { action: 'set_personal', requestId: uuid(), username: 'Est.Alex', expectedRevision: revisions['Est.Alex'], highlevelUserId: 'synthetic-ghl-user-alex' } });
    assert.deepEqual([malformed.status, malformed.body.code], [400, 'staff_directory_invalid_personal']);
    ok(await call('/api/staff-directory', { cookie: W.zac, body: { action: 'set_personal', requestId: uuid(), username: 'Est.Alex', expectedRevision: revisions['Est.Alex'], highlevelUserId: 'SyntheticAlexGhl01' } }), 'Alex HighLevel user');
    const eli = person('Eli');
    assert.deepEqual([eli.source, eli.staffRoles], ['employee_account', ['crew']]);
    const promoted = ok(await call('/api/staff-directory', { cookie: W.zac, body: { action: 'set_roles', requestId: uuid(), username: 'Eli', expectedRevision: eli.revision, staffRoles: ['team_lead'], reason: 'Eli leads every crew' } }), 'Eli team lead');
    assert.deepEqual([promoted.person.staffRoles, promoted.person.primaryRole, promoted.sessionsRevoked], [['team_lead'], 'team_lead', true]);
    const team = ok(await call('/api/staff-directory?view=team', { cookie: W.zac }), 'team directory');
    const card = name => team.people.find(row => row.username.toLowerCase() === name);
    assert.deepEqual(card('eli').primaryRole, 'team_lead');
    assert.deepEqual(card('crew.a1').crews.map(crew => [crew.name, crew.lead]), [['Crew 1', true]]);
    assert.deepEqual(card('crew.c2').crews.map(crew => [crew.name, crew.lead]), [['Crew 3', false]]);
  });

  it('2) Rep One signs in, sorts the areas near the phone, claims the nearest, starts a shift and logs doors', async () => {
    setClock(AT('09:55'));
    W.cookies = { 'rep.one': (await signIn('Rep.One')).cookie, 'rep.two': (await signIn('Rep.Two')).cookie };
    const me = ok(await asRep('rep.one', '/api/knock-me'), 'knock-me');
    assert.equal(me.viewer.jobBridge, true, 'the phone offers crew slots, ZIP and Walkthrough set');
    const available = ok(await asRep('rep.one', '/api/knock-territory?view=available'), 'available areas');
    // Rep Two's area, the Premium area, the area on hold and the one with no houses are hidden, by count only.
    assert.deepEqual(available.hidden, { hold: 1, town: 0, premium: 1, taken: 1, empty: 1 });
    assert.deepEqual(available.selfClaim, { enabled: true, max: 2, used: 0 });
    // "Near me": the phone sorts what the server lists by straight-line distance from its GPS fix.
    const near = neighborhoodsByDistance(PHONE, available.neighborhoods);
    assert.deepEqual(near.map(row => [row.id, row.claim]), [['english-ranch', 'open'], ['harvest-park', 'open']]);
    assert.ok(near[0].meters < 1000 && near[1].meters > 5000, JSON.stringify(near.map(row => row.meters)));
    assert.ok(near.every(row => row.center && Array.isArray(row.bbox)), 'each listed area was placed from its houses');
    const claimed = ok(await asRep('rep.one', '/api/knock-territory', { body: { action: 'claim', neighborhoodId: near[0].id } }), 'claim English Ranch');
    assert.deepEqual([claimed.claimed, claimed.used, claimed.max], [true, 1, 2]);
    // Rep Two's area cannot be claimed, and the refusal does not say who holds it.
    const taken = await asRep('rep.one', '/api/knock-territory', { body: { action: 'claim', neighborhoodId: 'ridgewood-hills' } });
    assert.deepEqual([taken.status, taken.body.code], [409, 'knock_neighborhood_taken']);
    const territory = ok(await asRep('rep.one', '/api/knock-territory'), 'territory');
    assert.deepEqual(territory.neighborhoods.map(row => row.id), ['english-ranch']);
    assert.ok(territory.houses.length === 24 && territory.houses.every(row => row.n === 'english-ranch' || row.neighborhoodId === 'english-ranch'), 'only the claimed area\'s houses');

    setClock(AT('10:12'));
    W.shiftOne = uuid();
    const doors = ok(await sync('rep.one', [
      { id: uuid(), type: 'shift.start', shiftId: W.shiftOne, cityKey: 'fort-collins', at: iso(AT('10:00')), lat: PHONE.lat, lng: PHONE.lng, accuracy: 12 },
      { id: uuid(), type: 'knock', shiftId: W.shiftOne, houseId: house(2900, 'BLUE LEAF DR'), outcome: 'no_answer', carOutside: false, at: iso(AT('10:05')) },
      { id: uuid(), type: 'knock', shiftId: W.shiftOne, houseId: house(2901, 'BLUE LEAF DR'), outcome: 'not_interested', carOutside: true, at: iso(AT('10:09')) },
    ]), 'shift and doors');
    assert.deepEqual(doors.results.map(row => row.status), ['applied', 'applied', 'applied'], JSON.stringify(doors.results));
    assert.equal(W.db.get(`knock_houses/${house(2901, 'BLUE LEAF DR')}`).summary.lastOutcome, 'not_interested');
    // Rep Two starts the day in the area the office gave him.
    const two = ok(await asRep('rep.two', '/api/knock-territory?view=available'), 'Rep Two areas');
    assert.deepEqual(two.neighborhoods.filter(row => row.claim === 'mine').map(row => [row.id, row.source]), [['ridgewood-hills', 'admin']]);
    assert.equal(two.neighborhoods.some(row => row.id === 'english-ranch'), false, 'English Ranch is Rep One\'s now');
    W.shiftTwo = uuid();
    assert.deepEqual(ok(await sync('rep.two', [{ id: uuid(), type: 'shift.start', shiftId: W.shiftTwo, cityKey: 'fort-collins', at: iso(AT('10:02')) }]), 'Rep Two shift').results.map(row => row.status), ['applied']);
  });

  it('3) Rep One sells on a Monday: rep-safe crew openings, then the sale syncs and books a Crew 1 Hub job at 9:30', async () => {
    setClock(AT('10:40'));
    const openings = ok(await asRep('rep.one', `/api/knock-crew-openings?from=${MON}&package=${encodeURIComponent('The Works')}&days=1`), 'crew openings');
    assert.deepEqual([openings.earliestJobDate, openings.from, openings.minutes], [SAT, MON, 420]);
    for (const slot of openings.slots) assert.deepEqual(Object.keys(slot).sort(), ['crewLabel', 'date', 'endTime', 'priority', 'time'], 'a slot is a time and a crew label, nothing else');
    assert.deepEqual(openings.slots[0], { date: MON, time: '09:30', endTime: '16:30', crewLabel: 'Crew 1', priority: 1 });
    assert.ok(openings.slots.every(slot => slot.date === MON && slot.time >= '09:30' && slot.endTime <= '17:00' && slot.crewLabel !== 'Crew 3'), JSON.stringify(openings.slots));
    const sale = saleEvents({ shiftId: W.shiftOne, houseId: house(2902, 'BLUE LEAF DR'), at: AT('10:30'), ticket: 1650, pkg: 'The Works', jobDate: MON,
      customer: { name: 'Morgan Synthetic', phone: '(970) 555-0142', email: 'morgan.synthetic@example.com' }, slot: { date: MON, time: '09:30', crewLabel: 'Crew 1' } });
    const synced = ok(await sync('rep.one', sale.events), 'sale sync');
    assert.deepEqual(synced.results.map(row => row.status), ['applied', 'applied']);
    assert.deepEqual(synced.results[1].bridge, { kind: 'sale', status: 'pending' }, 'the phone is told to book it');
    const booked = ok(await book('rep.one', 'sale', sale.saleId), 'bridge books the sale');
    assert.deepEqual(booked.booking, { kind: 'sale', id: sale.saleId, status: 'booked', date: MON, time: '09:30', endTime: '16:30', crewLabel: 'Crew 1', moved: false, message: 'Booked: Crew 1, Mon Oct 26, 9:30 am' });
    const job = jobFor(sale.saleId);
    assert.deepEqual([job.type, job.date, job.time, job.endTime, job.crewId, job.assignedCrew, job.crewLead, job.status], ['job', MON, '09:30', '16:30', W.crews['crew-1'], ['crew.a1', 'crew.a2'], 'crew.a1', 'scheduled']);
    assert.deepEqual([job.crewAutoAssigned.crewName, job.crewAutoAssigned.mode, job.crewAutoAssigned.by], ['Crew 1', 'pick', 'knock-bridge']);
    assert.equal(W.db.get(`customers/${job.customerId}`).name, 'Morgan Synthetic');
    W.saleMon1 = sale.saleId;
  });

  it('4) Rep Two sells the same Monday slot: Crew 1 is booked, so the phone offers Crew 2\'s open slot and the job goes to Crew 2', async () => {
    setClock(AT('11:10'));
    const openings = ok(await asRep('rep.two', `/api/knock-crew-openings?from=${MON}&package=${encodeURIComponent('The Works')}&days=1`), 'Rep Two openings');
    assert.deepEqual(openings.slots[0], { date: MON, time: '09:30', endTime: '16:30', crewLabel: 'Crew 2', priority: 2 }, 'slot booked for crew one, open slot for crew two');
    assert.ok(openings.slots.every(slot => slot.crewLabel === 'Crew 2'), 'Crew 1 has no seven-hour gap left on Monday');
    const sale = saleEvents({ shiftId: W.shiftTwo, houseId: house(2900, 'SYNTHETIC RIDGE DR'), at: AT('11:00'), ticket: 1800, pkg: 'The Works', jobDate: MON,
      customer: { name: 'Jordan Fixture', phone: '(970) 555-0177', email: 'jordan.fixture@example.com' }, slot: { date: MON, time: '09:30', crewLabel: 'Crew 2' } });
    assert.deepEqual(ok(await sync('rep.two', sale.events), 'Rep Two sale sync').results.map(row => row.status), ['applied', 'applied']);
    const booked = ok(await book('rep.two', 'sale', sale.saleId), 'Rep Two booking');
    assert.deepEqual([booked.booking.status, booked.booking.date, booked.booking.time, booked.booking.crewLabel, booked.booking.moved], ['booked', MON, '09:30', 'Crew 2', false]);
    const job = jobFor(sale.saleId);
    assert.deepEqual([job.date, job.time, job.crewId, job.assignedCrew], [MON, '09:30', W.crews['crew-2'], ['crew.b1', 'crew.b2']]);
    assert.equal(jobFor(W.saleMon1).crewId, W.crews['crew-1'], 'Rep One\'s job keeps Crew 1');
    W.saleMon2 = sale.saleId;
  });

  it('5) a Saturday sale goes to Crew 3 only; a weekday sale never goes to Crew 3, even when both weekday crews are full', async () => {
    setClock(AT('11:30'));
    const week = ok(await asRep('rep.one', `/api/knock-crew-openings?from=${SAT}&package=${encodeURIComponent('Quick Clear')}&days=7`), 'a week of openings');
    const weekday = date => new Date(`${date}T12:00:00Z`).getUTCDay();
    assert.ok(week.slots.length > 0);
    for (const slot of week.slots) {
      const weekend = [0, 6].includes(weekday(slot.date));
      assert.equal(slot.crewLabel === 'Crew 3', weekend, `${slot.date} ${slot.time} ${slot.crewLabel}: Crew 3 works weekends only, and only Crew 3 does`);
    }
    assert.deepEqual(week.slots.find(slot => slot.date === SAT), { date: SAT, time: '09:30', endTime: '12:30', crewLabel: 'Crew 3', priority: 3 });
    const saturday = saleEvents({ shiftId: W.shiftOne, houseId: house(2904, 'BLUE LEAF DR'), at: AT('11:20'), ticket: 900, pkg: 'Quick Clear', jobDate: SAT,
      customer: { name: 'Casey Sample', phone: '(970) 555-0163', email: 'casey.sample@example.com' }, slot: { date: SAT, time: '09:30', crewLabel: 'Crew 3' } });
    assert.deepEqual(ok(await sync('rep.one', saturday.events), 'Saturday sale sync').results.map(row => row.status), ['applied', 'applied']);
    const sat = ok(await book('rep.one', 'sale', saturday.saleId), 'Saturday booking');
    assert.deepEqual([sat.booking.status, sat.booking.date, sat.booking.time, sat.booking.endTime, sat.booking.crewLabel], ['booked', SAT, '09:30', '12:30', 'Crew 3']);
    assert.deepEqual([jobFor(saturday.saleId).crewId, jobFor(saturday.saleId).assignedCrew], [W.crews['crew-3'], ['crew.c1', 'crew.c2']]);
    W.saleSat = saturday.saleId;

    // Both weekday crews are booked all Monday: Monday has no opening at all (Crew 3 does not work Mondays) ...
    setClock(AT('11:50'));
    const monday = ok(await asRep('rep.two', `/api/knock-crew-openings?from=${MON}&package=${encodeURIComponent('The Works')}&days=1`), 'full Monday');
    assert.deepEqual(monday.slots, []);
    // ... so a Monday sale made offline (the rep chose a morning, no slot) is booked on the nearest weekday a weekday crew
    // is free, never on Crew 3, and the office is told it moved.
    const full = saleEvents({ shiftId: W.shiftTwo, houseId: house(2902, 'SYNTHETIC RIDGE DR'), at: AT('11:40'), ticket: 1750, pkg: 'The Works', jobDate: MON,
      customer: { name: 'Riley Placeholder', phone: '(970) 555-0188', email: 'riley.placeholder@example.com' } });
    full.events[1].dayPart = 'am';
    assert.deepEqual(ok(await sync('rep.two', full.events), 'full-Monday sale sync').results.map(row => row.status), ['applied', 'applied']);
    const moved = ok(await book('rep.two', 'sale', full.saleId), 'full-Monday booking');
    assert.deepEqual([moved.booking.status, moved.booking.date, moved.booking.time, moved.booking.crewLabel, moved.booking.moved], ['booked', TUE, '09:30', 'Crew 1', true]);
    const job = jobFor(full.saleId);
    assert.deepEqual([job.date, job.crewId], [TUE, W.crews['crew-1']]);
    assert.match(job.opsNotes, /asked for Mon Oct 26 9:30 am; booked Tue Oct 27 9:30 am instead because no crew was free then/);
    const weekdayJobs = jobs().filter(row => row.type === 'job' && ![0, 6].includes(weekday(row.date)));
    assert.equal(weekdayJobs.length, 3);
    assert.ok(weekdayJobs.every(row => row.crewId !== W.crews['crew-3']), 'no weekday job is on Crew 3');
    W.saleTue = full.saleId;
  });

  it('6) Rep One sets a walkthrough: it lands on the estimator\'s schedule, and the 13% setter / 7% estimator split is recorded', async () => {
    setClock(AT('12:10'));
    const slots = ok(await asRep('rep.one', '/api/knock-walkthrough-slots'), 'walkthrough slots');
    assert.ok(slots.slots.length > 0);
    for (const slot of slots.slots) assert.deepEqual([Object.keys(slot).sort().join(), slot.estimator], ['date,endTime,estimator,ref,time', 'Alex'], 'the estimator\'s first name and an opaque handle only');
    const pick = slots.slots.find(slot => slot.date === '2026-10-21' && slot.time === '10:00');
    assert.ok(pick, JSON.stringify(slots.slots.slice(0, 5)));
    const knockId = uuid(), walkId = uuid(), houseId = house(2906, 'BLUE LEAF DR');
    const synced = ok(await sync('rep.one', [
      { id: knockId, type: 'knock', shiftId: W.shiftOne, houseId, outcome: 'walkthrough_set', carOutside: true, at: iso(AT('12:00')) },
      { id: walkId, type: 'walkthrough', knockId, houseId, at: iso(AT('12:02')), customer: { name: 'Taylor Example', phone: '970-555-0121', email: 'taylor.example@example.com' },
        date: pick.date, time: pick.time, estimatorRef: pick.ref, textConsent: true, note: 'Three-car garage, wants shelving', zip: '80525' },
    ]), 'walkthrough sync');
    assert.deepEqual(synced.results.map(row => row.status), ['applied', 'applied']);
    assert.deepEqual(synced.results[1].bridge, { kind: 'walkthrough', status: 'pending' });
    const booked = ok(await book('rep.one', 'walkthrough', walkId), 'walkthrough booking');
    assert.deepEqual(booked.booking, { kind: 'walkthrough', id: walkId, status: 'booked', date: '2026-10-21', time: '10:00', endTime: '11:00', estimator: 'Alex', message: 'Walkthrough booked: Wed Oct 21, 10:00 am with Alex' });
    const visit = jobs().find(row => row.knockWalkthroughId === walkId);
    assert.deepEqual([visit.type, visit.date, visit.time, visit.endTime, visit.assignedCrew, visit.status], ['walkthrough', '2026-10-21', '10:00', '11:00', ['est.alex'], 'scheduled']);
    const setter = W.db.get(`knock_setters/${visit.id}`);
    assert.deepEqual([setter.setterKey, setter.estimatorKey, setter.channel, setter.source, setter.recordedBy], ['rep.one', 'est.alex', 'appointment_setter', 'knock_walkthrough', 'knock-bridge']);
    assert.deepEqual(setter.rates, { setter: 0.13, estimator: 0.07, total: 0.2 }, 'D6b: 13% setter + 7% estimator = 20% of the garage job');
    W.walkId = walkId; W.walkVisit = visit.id;
  });

  it('7) each crew member sees exactly their crew\'s jobs, Eli (team lead) sees every crew, Alex sees the walkthrough on his own schedule', async () => {
    setClock(AT('13:00'));
    const window = `from=2026-10-20&to=${TUE}`;
    const schedule = async (user, scope = 'mine') => call(`/api/crew-schedule?${window}&scope=${scope}`, { cookie: (await signIn(user)).cookie });
    const ids = rows => rows.map(row => row.id).sort();
    const crewJobs = code => ids(jobs().filter(row => row.type === 'job' && row.crewId === W.crews[code]));
    assert.deepEqual([crewJobs('crew-1').length, crewJobs('crew-2').length, crewJobs('crew-3').length], [2, 1, 1]);

    for (const [user, code, others] of [['Crew.A2', 'crew-1', ['crew-2', 'crew-3']], ['Crew.B2', 'crew-2', ['crew-1', 'crew-3']], ['Crew.C1', 'crew-3', ['crew-1', 'crew-2']]]) {
      const mine = ok(await schedule(user), `${user} schedule`);
      assert.deepEqual(mine.groups.map(group => [group.crew.code, group.crew.mine]), [[code, true]], `${user} sees only their own crew`);
      assert.deepEqual(ids(mine.groups[0].jobs), crewJobs(code), `${user} sees exactly ${code}'s jobs`);
      assert.deepEqual(mine.unassigned, []);
      const text = JSON.stringify(mine);
      for (const other of others) for (const id of crewJobs(other)) assert.equal(text.includes(id), false, `${user} never sees ${other}'s job ${id}`);
      assert.equal(mine.viewer.canViewAll, false);
      assert.deepEqual((await schedule(user, 'all')).status, 403, `${user} cannot read every crew`);
    }
    const crewOne = ok(await schedule('Crew.A1'), 'Crew 1 lead');
    const monday = crewOne.groups[0].jobs.find(row => row.date === MON);
    assert.deepEqual([monday.time, monday.endTime, monday.customer, monday.area, monday.crewName, monday.lead, monday.crewSize, monday.mine, monday.canOpen], ['09:30', '16:30', 'Morgan', 'Fort Collins', 'Crew 1', 'Andy Alpha', 2, true, true]);
    assert.doesNotMatch(JSON.stringify(crewOne), /555-0142|morgan\.synthetic|Blue Leaf|\$|1650/, 'no phone, email, street or price on the crew schedule');

    // Eli: the owner made him team lead (his old session ended with the role change); he signs in again and reads every crew.
    const eli = await signIn('Eli');
    assert.ok(eli.profile.capabilities.includes('schedule.view'), JSON.stringify(eli.profile.capabilities));
    const all = ok(await call(`/api/crew-schedule?${window}&scope=all`, { cookie: eli.cookie }), 'Eli every crew');
    assert.equal(all.viewer.canViewAll, true);
    assert.deepEqual(all.groups.map(group => [group.crew.name, ids(group.jobs)]), [['Crew 1', crewJobs('crew-1')], ['Crew 2', crewJobs('crew-2')], ['Crew 3', crewJobs('crew-3')]]);
    assert.deepEqual(all.unassigned, [], 'an estimator\'s walkthrough is on the estimator\'s schedule, not the crews\'');
    const eliMine = ok(await call(`/api/crew-schedule?${window}`, { cookie: eli.cookie }), 'Eli own crews');
    assert.deepEqual([eliMine.groups, eliMine.unassigned], [[], []], 'Eli is on no crew himself');

    // Alex: the door walkthrough is on his own schedule, on no crew.
    const alex = ok(await schedule('Est.Alex'), 'Alex schedule');
    assert.deepEqual(alex.groups, []);
    // (The page labels a type 'walkthrough' row "Walkthrough" and opens its game plan.)
    assert.deepEqual(alex.unassigned.map(row => [row.id, row.type, row.crewId, row.date, row.time, row.endTime, row.customer, row.area, row.mine, row.canOpen]),
      [[W.walkVisit, 'walkthrough', '', '2026-10-21', '10:00', '11:00', 'Taylor', 'Fort Collins', true, true]]);

    // A rep is on no crew: their schedule is empty and every crew's is refused.
    const repMine = await asRep('rep.one', `/api/crew-schedule?${window}`);
    assert.deepEqual([repMine.status, repMine.body.groups, repMine.body.unassigned], [200, [], []]);
    assert.deepEqual([(await asRep('rep.one', `/api/crew-schedule?${window}&scope=all`)).status], [403]);
  });

  it('8) every Hub booking queued its HighLevel second record (contact, EGC Pipeline stage, note); each job carries the door-to-door attribution', async () => {
    setClock(AT('13:30'));
    const sales = [W.saleMon1, W.saleMon2, W.saleSat, W.saleTue], booked = sales.map(jobFor), visit = jobs().find(row => row.id === W.walkVisit);
    const entries = W.db.docs('ghlScheduleMirror/');
    assert.deepEqual(entries.map(entry => entry.jobId).sort(), [...booked.map(job => job.id), visit.id].sort(), 'one schedule-mirror entry per Hub booking, queued in the booking\'s own commit');
    const entryOf = job => entries.find(entry => entry.jobId === job.id);
    const expected = [
      [W.saleMon1, 'Monday, October 26, 2026', '9:30 AM – 4:30 PM', 'Crew 1: Andy Alpha (lead), Abe Alpha', '2902 Blue Leaf Dr, Fort Collins, CO 80525', 'The Works'],
      [W.saleMon2, 'Monday, October 26, 2026', '9:30 AM – 4:30 PM', 'Crew 2: Bo Beta (lead), Ben Beta', '2900 Synthetic Ridge Dr, Fort Collins, CO 80525', 'The Works'],
      [W.saleSat, 'Saturday, October 24, 2026', '9:30 AM – 12:30 PM', 'Crew 3: Cy Gamma (lead), Cal Gamma', '2904 Blue Leaf Dr, Fort Collins, CO 80525', 'Quick Clear'],
      [W.saleTue, 'Tuesday, October 27, 2026', '9:30 AM – 4:30 PM', 'Crew 1: Andy Alpha (lead), Abe Alpha', '2902 Synthetic Ridge Dr, Fort Collins, CO 80525', 'The Works'],
    ];
    for (const [saleId, day, time, crew, address, pkg] of expected) {
      const job = jobFor(saleId), entry = entryOf(job), sale = W.db.get(`knock_sales/${saleId}`);
      assert.deepEqual([entry.kind, entry.visitType, entry.stage, entry.status, entry.attempts, entry.customerId], ['scheduled', 'job', 'job_scheduled', 'pending', 0, job.customerId]);
      assert.equal(entry.note.title, 'EGC schedule: Job scheduled');
      for (const line of [`Date: ${day}`, `Time: ${time} (Denver time)`, `Crew: ${crew}`, `Address: ${address}`, `Service: ${pkg}`, `Scope: Sold at the door: ${pkg}.`]) assert.ok(entry.note.body.includes(line), `${line}\n${entry.note.body}`);
      assert.doesNotMatch(entry.note.body, new RegExp(`\\$|@|555-|(?<![\\d,])${sale.ticket}(?!\\d)`), 'the note has no price and no customer contact details');
      // The door-to-door attribution rides on the Hub job (and its new customer) for HighLevel and the office to read.
      assert.deepEqual([job.source, job.knockSaleId, job.ghlTags, job.d2d.kind, job.d2d.saleId, job.d2d.repKey, job.d2d.contactSource], ['door_to_door', saleId, ['egc-d2d-sale'], 'sale', saleId, sale.repKey, 'Door to door']);
      assert.deepEqual(W.db.get(`customers/${job.customerId}`).acquisition.channel, 'door_to_door');
    }
    const walk = entryOf(visit);
    assert.deepEqual([walk.kind, walk.visitType, walk.stage, walk.estimatorId, walk.note.title], ['scheduled', 'walkthrough', 'walkthrough_appointment', 'est.alex', 'EGC schedule: Walkthrough booked']);
    for (const line of ['Date: Wednesday, October 21, 2026', 'Time: 10:00 AM – 11:00 AM (Denver time)', 'Estimator: Alex Estimator', 'Address: 2906 Blue Leaf Dr, Fort Collins, CO 80525']) assert.ok(walk.note.body.includes(line), line);
    assert.deepEqual([visit.source, visit.ghlTags, visit.d2d.kind, visit.d2d.setterEventId, visit.d2d.contactSource], ['door_to_door', ['egc-d2d-walkthrough'], 'walkthrough', W.walkId, 'Door to door']);

    // The drain (the egc-worker's signed tick runs this library) delivers them to a synthetic HighLevel: the contact, one
    // opportunity per customer job in the EGC Pipeline at Job Scheduled or Walkthrough Appointment, and the note. No
    // calendar is involved (D9b), and nothing is tagged, booked or sent to the customer.
    const hl = fakeHighLevel(), drainEnv = { ...W.env, HIGHLEVEL_API_KEY: 'synthetic-highlevel-token', HIGHLEVEL_LOCATION_ID: EGC_LOCATION, EGC_MESSAGING_DRY_RUN: 'false' };
    const summary = await drainScheduleMirror(scheduleMirrorStorage(drainEnv), { env: drainEnv, now: iso(W.clock), ids: entries.map(entry => entry.id), limit: entries.length, fetcher: hl.fetcher });
    assert.deepEqual([summary.attempted, summary.done, summary.retrying, summary.parked], [5, 5, 0, 0], JSON.stringify(summary));
    assert.deepEqual(hl.calls.filter(row => row.method !== 'GET').map(row => row.path).sort(), [...Array(5).fill('/contacts/upsert'), ...Array(5).fill('/opportunities/'), ...[1, 2, 3, 4, 5].map(n => `/contacts/contact-${n}/notes`)].sort());
    assert.equal(hl.calls.some(row => /tags|calendars|conversations|messages/.test(row.path)), false, 'no tag, calendar or message');
    const deals = [...hl.opportunities.values()];
    assert.deepEqual(deals.map(deal => [deal.pipelineId, deal.pipelineStageId, deal.status]).sort(), [...Array(4).fill([EGC_PIPELINE, EGC_JOB_SCHEDULED_STAGE, 'open']), [EGC_PIPELINE, EGC_WALKTHROUGH_APPOINTMENT_STAGE, 'open']].sort());
    assert.equal(deals.find(deal => deal.pipelineStageId === EGC_WALKTHROUGH_APPOINTMENT_STAGE).assignedTo, 'SyntheticAlexGhl01', 'the walkthrough deal is Alex\'s in HighLevel');
    const contactFor = name => [...hl.contacts.values()].find(contact => contact.name === name);
    assert.deepEqual(['Morgan Synthetic', 'Jordan Fixture', 'Casey Sample', 'Riley Placeholder', 'Taylor Example'].map(name => Boolean(contactFor(name)?.phone)), [true, true, true, true, true]);
    for (const entry of W.db.docs('ghlScheduleMirror/')) assert.deepEqual([entry.status, Boolean(entry.steps.contactId), Boolean(entry.steps.note)], ['done', true, true]);
    W.highLevel = hl;
  });

  it('9) each rep\'s My money lists their sales with the Hub job\'s day, crew and status, and the commission still pending', async () => {
    setClock(AT('16:30'));
    const one = ok(await asRep('rep.one', '/api/knock-reports?view=my-money'), 'Rep One money');
    assert.deepEqual(one.sales.map(sale => sale.id), [W.saleSat, W.saleMon1], 'only Rep One\'s own sales, newest first');
    const line = id => one.sales.find(sale => sale.id === id);
    assert.deepEqual(line(W.saleMon1).job, { kind: 'sale', id: W.saleMon1, status: 'booked', date: MON, time: '09:30', endTime: '16:30', crewLabel: 'Crew 1', moved: false,
      message: 'Booked: Crew 1, Mon Oct 26, 9:30 am', live: { status: 'scheduled', date: MON, time: '09:30', crewLabel: 'Crew 1' } });
    assert.deepEqual(line(W.saleSat).job.live, { status: 'scheduled', date: SAT, time: '09:30', crewLabel: 'Crew 3' });
    // Commission: projected on the booking at the approved 25%, not earned (the job is not done or collected) and not payable.
    assert.deepEqual(line(W.saleMon1).commission, { state: 'pending', amount: 412.5 });
    assert.deepEqual(line(W.saleSat).commission, { state: 'pending', amount: 225 });
    const [period] = one.periods;
    assert.deepEqual([period.compensationState, period.salesBooked, period.booked, period.projectedCommission, period.earnedCommission, period.payableCommission, period.commissionPaid],
      ['configured', 2, 2550, 637.5, 0, 0, 0]);
    // The walkthrough Rep One set: 13% to the setter (7% to the estimator), awaiting the close; the setter route is not payable
    // until the owner approves its terms (knock-setters.js setterPolicy.approval).
    assert.deepEqual(one.setters.rows.map(row => [row.walkthroughId, row.setterKey, row.rate, row.state, row.earnedCommission, row.payableCommission]), [[W.walkVisit, 'rep.one', 0.13, 'awaiting_close', 0, 0]]);
    assert.deepEqual([one.setters.policy.rate, one.setters.policy.estimatorRate, one.setters.policy.totalRate, one.setters.policy.approval], [0.13, 0.07, 0.2, 'unconfigured']);

    const two = ok(await asRep('rep.two', '/api/knock-reports?view=my-money'), 'Rep Two money');
    assert.deepEqual(two.sales.map(sale => sale.id), [W.saleTue, W.saleMon2]);
    const moved = two.sales.find(sale => sale.id === W.saleTue);
    assert.deepEqual([moved.jobDate, moved.job.status, moved.job.date, moved.job.crewLabel, moved.job.moved, moved.job.live.date], [TUE, 'booked', TUE, 'Crew 1', true, TUE], 'the sale moved with its job');
    assert.deepEqual(two.sales.find(sale => sale.id === W.saleMon2).job.live, { status: 'scheduled', date: MON, time: '09:30', crewLabel: 'Crew 2' });
    assert.deepEqual(two.sales.map(sale => sale.commission.state), ['pending', 'pending']);
    assert.deepEqual(two.setters.rows, []);
  });

  it('10) nothing a rep was shown names another rep, another rep\'s customer, the roster, a crew member, costs or margins', async () => {
    // The Hub's office views stay closed to a door-to-door rep: the Dispatch board (every customer and crew), crew
    // openings with the roster, the door-to-door day board (every rep) and every crew's schedule.
    for (const path of [`/api/dispatch?startDate=${MON}&endDate=${TUE}`, `/api/dispatch-openings?startDate=${MON}&endDate=${TUE}&durationMinutes=60&crews=auto`, '/api/d2d-day?date=2026-10-20', `/api/crew-schedule?from=2026-10-20&to=${TUE}&scope=all`]) {
      const refused = await asRep('rep.one', path);
      assert.ok([401, 403].includes(refused.status), `${path}: ${refused.status} ${JSON.stringify(refused.body).slice(0, 300)}`);
    }
    // Another rep's sale or walkthrough cannot be booked, or even confirmed to exist, from a rep's phone.
    for (const [kind, id] of [['sale', W.saleMon1], ['walkthrough', W.walkId]]) {
      const refused = await asRep('rep.two', '/api/knock-job-bridge', { body: { kind, id } });
      assert.deepEqual([refused.status, refused.body.code], [404, `knock_${kind}_missing`]);
    }
    assert.deepEqual(W.db.outside, [], 'no request ever left for a host other than Firestore');
    assert.deepEqual(W.router.errors, [], 'no handler threw');
    const theirs = rep => {
      const sales = W.db.docs('knock_sales/').filter(row => row.repKey !== rep), other = rep === 'rep.one' ? 'rep.two' : 'rep.one';
      const otherJobs = sales.map(sale => jobFor(sale.id)).filter(Boolean);
      const walks = W.db.docs('knock_walkthroughs/').filter(row => row.repKey !== rep);
      return [other, other === 'rep.two' ? 'Ravi' : 'Rhea', ...sales.flatMap(sale => [sale.customer.name, sale.customer.email, sale.customer.phone, sale.customer.phone.slice(-7), sale.id]),
        ...walks.flatMap(row => [row.customer.name, row.customer.phone]), ...otherJobs.flatMap(job => [job.id, job.customerId, job.address])].filter(Boolean);
    };
    const STRUCTURE = ['memberIds', 'employeeIds', 'roster', 'assignedCrew', 'crewLead', 'leadId', 'searchedEmployeeIds', ...Object.values(W.crews)];
    // Company costs and margins, and other people's pay: never on a rep's phone. (The rep's own commission and training
    // rates, and the canvassing plan's targets, are the rep's own terms and are shown.)
    const MONEY = /"[A-Za-z]*(?:cost|Cost|margin|Margin|markup|Markup)[A-Za-z]*"|"(?:laborCents|laborMinutes|productCents|disposalCents|hourlyRate|payRate|wage|payType)"/;
    for (const rep of ['rep.one', 'rep.two']) {
      assert.ok(W.seen[rep].length > 5, `${rep} made requests`);
      for (const { path, body } of W.seen[rep]) {
        const text = JSON.stringify(body);
        for (const secret of [...STAFF_SECRETS, ...STRUCTURE, ...theirs(rep)]) assert.equal(mentions(text, secret), false, `${rep} ${path} shows ${secret}: ${text.slice(0, 2000)}`);
        assert.doesNotMatch(text, MONEY, `${rep} ${path} shows a cost or margin`);
      }
    }
  });
});
