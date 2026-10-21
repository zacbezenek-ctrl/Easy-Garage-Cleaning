import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import vm from 'node:vm';
import { fakeIndexedDB } from './helpers/fake-indexeddb.mjs';

// CREW-CLOCK (WP15, crew side): the crew home's Clock in / Clock out run the real crew home script and the real field
// outbox (crew/field-outbox.js), so the time actions are exactly the ones Today's work sends to /api/employee-hub: one
// location fix at clock-in, EGC_CLOCK_IN_WITHOUT_FIX (clockInWithoutFix) for a phone that finds none, and no second
// time system. Synthetic people only.
const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const home = read('crew/index.html'), outbox = read('crew/field-outbox.js');
const script = home.slice(home.lastIndexOf('<script>') + '<script>'.length, home.lastIndexOf('</script>'));
const ENTRY = { id: 'time-crew.one-abc123', employee: 'Crew.One', status: 'active', clockInAt: '2026-10-16T15:00:00.000Z', breaks: [], lastLocation: { lat: 40.5, lng: -105.1 }, locationStatus: 'job_page_single_fix', hourlyRate: 20 };

// records: the timecard write answers with the saved timecard, as POST /api/employee-hub does (withJobTime(visiblePay(...)));
// history: this person's other timecards in the full read.
function crewHome({ business = false, online = true, position = 'ok', withoutFix = false, active = null, refuse = null, confirm = true, indexedDB = undefined, down = false, records = false, history = [] } = {}) {
  const nodes = new Map(), posts = [], reads = [], listeners = {}, server = { active, withoutFix, down, closed: [...history] };
  const element = id => { if (!nodes.has(id)) nodes.set(id, { id, hidden: false, textContent: '', innerHTML: '', className: '', dataset: { businessHref: '/crew/prejob' }, setAttribute() {}, classList: { toggle() {} } }); return nodes.get(id); };
  const geolocation = { getCurrentPosition(resolve, reject) { if (position === 'ok') resolve({ coords: { latitude: 40.5852601, longitude: -105.0844233, accuracy: 12.4 } }); else reject(Object.assign(new Error(position), { code: position === 'denied' ? 1 : 2 })); } };
  const respond = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const context = vm.createContext({
    Date, Intl, URLSearchParams, Promise, Set, Map, Number, String, Array, Math, JSON, Object, Error, TypeError, Boolean, encodeURIComponent, console, AbortSignal, Response,
    location: { search: '' }, navigator: { onLine: online, geolocation }, addEventListener(type, listener) { listeners[type] = listener; }, confirm: () => confirm, crypto: { randomUUID }, indexedDB,
    document: { getElementById: element },
    // The outbox's transport: the session check, the own-shift view and the timecard write, as on the job page.
    async fetch(url, init = {}) {
      const path = String(url);
      if (path === '/api/hub-auth') return respond(200, { ok: true, user: 'Crew.One' });
      if (path === '/api/employee-hub?view=own-job-time') return respond(200, { ok: true, user: 'Crew.One', entry: server.active ? { id: server.active.id, breaks: server.active.breaks } : null, clockInWithoutFix: server.withoutFix });
      if (path === '/api/employee-hub' && init.method === 'POST') {
        if (server.down) throw new TypeError('Failed to fetch');
        const body = JSON.parse(init.body); posts.push(body);
        if (refuse) return respond(refuse.status, { ok: false, error: refuse.error });
        let record;
        if (body.data.clockOutAt) { record = { ...server.active, clockOutAt: body.data.clockOutAt, status: 'submitted' }; if (records) server.closed.push(record); server.active = null; }
        else server.active = record = records ? { ...ENTRY, id: body.id, clockInAt: body.data.deviceCapturedAt, ...(body.data.lastLocation ? { lastLocation: body.data.lastLocation, locationStatus: body.data.locationStatus } : { lastLocation: null, locationStatus: body.data.locationStatus }), jobTime: { clockInLocation: body.data.lastLocation ? 'shared' : 'missing' } } : { ...ENTRY, id: body.id };
        return respond(200, { ok: true, ...(records ? { record } : {}) });
      }
      throw new Error(`Unexpected ${init.method || 'GET'} ${path}`);
    },
    EGCHubAuth: {
      profile: () => ({ user: 'Crew.One', displayName: 'Synthetic Crew', businessAccess: business }), canRunBusiness: () => business, canRunWalkthrough: () => false, canUseKnock: () => business, mountCrewNav() {},
      async fetch(path) {
        reads.push(path);
        if (path === '/api/crew-jobs') return Response.json({ ok: true, jobs: [] });
        if (path === '/api/employee-hub') return Response.json({ ok: true, collections: { timeEntries: [...server.closed, ...(server.active ? [server.active] : [])] }, clockInWithoutFix: server.withoutFix });
        throw new Error(`Unexpected ${path}`);
      },
    },
  });
  context.window = context;
  vm.runInContext(outbox, context);
  vm.runInContext(script, context);
  return { context, card: () => element('crew-overview').innerHTML, posts, reads, server, listeners };
}

test('a crew member clocks in from the crew home with one location fix, through the same outbox and timecard write as Today’s work', async () => {
  const page = crewHome();
  await page.context.openCrewHome();
  assert.match(page.card(), /<strong>Clocked out<\/strong><small>Clocking in shares your location once<\/small><div class="clock-actions"><button type="button" class="clock-btn" onclick="crewClock\('clock_in'\)">Clock in<\/button><\/div>/);
  await page.context.crewClock('clock_in');
  assert.equal(page.posts.length, 1);
  const [post] = page.posts;
  assert.equal(post.collection, 'timeEntries');
  assert.match(post.id, /^time-crew\.one-[a-z0-9]+$/);
  assert.deepEqual(Object.keys(post.data).sort(), ['deviceCapturedAt', 'lastLocation', 'locationStatus', 'locationTracking']);
  assert.deepEqual([post.data.locationTracking, post.data.locationStatus, post.data.lastLocation], [true, 'job_page_single_fix', { lat: 40.58526, lng: -105.084423, accuracy: 12 }]);
  assert.match(page.card(), /<article class="status-card live"><span>Time clock<\/span><strong>Clocked in<\/strong>/);
  assert.match(page.card(), /onclick="crewClock\('clock_out'\)">Clock out<\/button><small class="clock-note" role="status">Clocked in\. Your location was shared once; nothing tracks it during your shift\.<\/small>/);
  assert.equal(await page.context.window.EGCFieldOutbox.create().items('Crew.One').then(rows => rows.length), 0, 'nothing is left waiting on the phone');
});

test('clock out asks first, then submits the open shift for approval', async () => {
  const page = crewHome({ active: { ...ENTRY } });
  await page.context.openCrewHome();
  assert.match(page.card(), /<strong>Clocked in<\/strong><small>[\d.]+ hours today · location shared once at clock-in<\/small><div class="clock-actions"><button type="button" class="clock-btn out" onclick="crewClock\('clock_out'\)">Clock out<\/button>/);
  const declined = crewHome({ active: { ...ENTRY }, confirm: false });
  await declined.context.openCrewHome();
  await declined.context.crewClock('clock_out');
  assert.equal(declined.posts.length, 0, 'cancelled at the question: nothing is sent');
  await page.context.crewClock('clock_out');
  assert.equal(page.posts.length, 1);
  assert.deepEqual([page.posts[0].id, page.posts[0].data.status, typeof page.posts[0].data.clockOutAt], [ENTRY.id, 'submitted', 'string']);
  assert.match(page.card(), /<strong>Clocked out<\/strong>.*Clocked out\. Your shift is submitted for approval\./);
  await page.context.crewClock('clock_out');
  assert.equal(page.posts.length, 1, 'an already closed shift is not clocked out twice');
});

test('location rules match Today’s work: a denied permission never clocks in; no fix clocks in only with EGC_CLOCK_IN_WITHOUT_FIX', async () => {
  const denied = crewHome({ position: 'denied', withoutFix: true });
  await denied.context.openCrewHome();
  await denied.context.crewClock('clock_in');
  assert.equal(denied.posts.length, 0);
  assert.match(denied.card(), /<small class="clock-note error" role="status">Clock-in needs location access\. Enable location for this site, then try again\.<\/small>/);
  const noFix = crewHome({ position: 'unavailable' });
  await noFix.context.openCrewHome();
  await noFix.context.crewClock('clock_in');
  assert.equal(noFix.posts.length, 0, 'flag off: no fix, no clock-in');
  assert.match(noFix.card(), /Your phone could not find its location\. Move near a window or outside, then try again\./);
  const allowed = crewHome({ position: 'unavailable', withoutFix: true });
  await allowed.context.openCrewHome();
  await allowed.context.crewClock('clock_in');
  assert.equal(allowed.posts.length, 1);
  assert.deepEqual([allowed.posts[0].data.locationStatus, 'lastLocation' in allowed.posts[0].data], ['location_unavailable_at_clock_in', false]);
  assert.match(allowed.card(), /Clocked in without a location\. A manager will review this shift\./);
});

test('a refused clock-in is reported and dropped; managers, offline phones and pages without the outbox get no button', async () => {
  // As on the job page: a definite refusal of the action being watched (400/403/404/415) is dropped and reported; any
  // other refusal waits on the phone for Retry or Discard in Today's work, and holds later clock actions until then.
  const invalid = crewHome({ refuse: { status: 400, error: 'Choose a valid time entry.' } });
  await invalid.context.openCrewHome();
  await invalid.context.crewClock('clock_in');
  assert.match(invalid.card(), /Choose a valid time entry\. Nothing was recorded\./);
  assert.equal((await invalid.context.window.EGCFieldOutbox.create().items('Crew.One')).length, 0);
  const refused = crewHome({ refuse: { status: 409, error: 'You already have an active shift. Clock out first.' } });
  await refused.context.openCrewHome();
  await refused.context.crewClock('clock_in');
  assert.match(refused.card(), /You already have an active shift\. Clock out first\. It waits on this phone: open any job in Today’s work to retry or discard it\.<\/small><a class="clock-review" href="\/crew\/job\.html">Open Today’s work<\/a>/);
  await refused.context.crewClock('clock_in');
  assert.equal(refused.posts.length, 1, 'a refused clock action holds the clock until it is reviewed');
  assert.match(refused.card(), /A saved time action needs review: open any job in Today’s work to retry or discard it before you clock in or out here\./);
  const manager = crewHome({ business: true });
  await manager.context.openCrewHome();
  assert.doesNotMatch(manager.card(), /clock-btn/);
  assert.match(manager.card(), /Open My Hub when your shift starts · clocking in shares your location once/);
  await manager.context.crewClock('clock_in');
  assert.equal(manager.posts.length, 0, 'managers clock in from the employee time clock, as on the job page');
  const offline = crewHome({ online: false });
  await offline.context.openCrewHome();
  assert.match(offline.card(), /<button type="button" class="clock-btn" onclick="crewClock\('clock_in'\)" disabled>Clock in<\/button><small class="clock-note" role="status">Connect to clock in or out here\.<\/small>/);
  await offline.context.crewClock('clock_in');
  assert.equal(offline.posts.length, 0);
  assert.match(home, /<script src="\/crew\/field-outbox\.js\?v=20260929crewtime2"><\/script>/, 'the home loads the same outbox build the job page and worker use');
  assert.ok(home.indexOf('field-outbox.js') < home.lastIndexOf('<script>'), 'before the page script');
});

test('a quick double tap clocks in once: the button is busy before the first wait, as on the job page', async () => {
  const page = crewHome({ indexedDB: fakeIndexedDB() });
  await page.context.openCrewHome();
  await Promise.all([page.context.crewClock('clock_in'), page.context.crewClock('clock_in')]);
  assert.equal(page.posts.length, 1, 'the second tap queues nothing');
  assert.equal((await page.context.window.EGCFieldOutbox.create().items('Crew.One')).length, 0, 'and leaves no refused clock-in to block the home');
  assert.match(page.card(), /<strong>Clocked in<\/strong>.*Clocked in\. Your location was shared once/);
  const out = crewHome({ active: { ...ENTRY } });
  await out.context.openCrewHome();
  await Promise.all([out.context.crewClock('clock_out'), out.context.crewClock('clock_out')]);
  assert.equal(out.posts.length, 1);
});

test('losing the connection disables the clock buttons at once and says why; a tap then sends nothing', async () => {
  const page = crewHome();
  await page.context.openCrewHome();
  assert.match(page.card(), /onclick="crewClock\('clock_in'\)">Clock in<\/button>/, 'online: enabled');
  page.context.navigator.onLine = false;
  page.listeners.offline();
  assert.match(page.card(), /onclick="crewClock\('clock_in'\)" disabled>Clock in<\/button><small class="clock-note" role="status">Connect to clock in or out here\.<\/small>/);
  await page.context.crewClock('clock_in');
  assert.equal(page.posts.length, 0);
  assert.match(page.card(), /disabled>Clock in<\/button><small class="clock-note" role="status">Connect to clock in or out here\.<\/small>/, 'the tap is answered, not ignored');
  // Before the overview has loaded, going offline leaves the loading card alone.
  const early = crewHome();
  early.context.navigator.onLine = false;
  early.listeners.offline();
  assert.equal(early.card(), '');
});

test('a time action the connection dropped stays on this phone and is sent once, in order, when the crew home opens online', async () => {
  const indexedDB = fakeIndexedDB();
  const dropped = crewHome({ indexedDB, down: true });
  await dropped.context.openCrewHome();
  await dropped.context.crewClock('clock_in');
  assert.equal(dropped.posts.length, 0);
  assert.match(dropped.card(), /<strong>Clocked in<\/strong><small>Clock-in waiting to sync<\/small>.*Saved on this phone\. It syncs in order when the connection is back\./);
  const [queued] = indexedDB.rows('egc-field-outbox', 'actions');
  assert.deepEqual([queued.kind, queued.user, queued.payload.op, queued.state], ['clock', 'Crew.One', 'clock_in', 'queued']);
  const reopened = crewHome({ indexedDB });
  await reopened.context.openCrewHome();
  assert.equal(reopened.posts.length, 1, 'sent once when the home opens online');
  assert.equal(reopened.posts[0].id, queued.payload.entryId, 'with the entry id and action id it was saved with');
  assert.deepEqual(indexedDB.rows('egc-field-outbox', 'actions'), []);
  assert.match(reopened.card(), /<strong>Clocked in<\/strong><small>[\d.]+ hours today · location shared once at clock-in<\/small>/);
  const again = crewHome({ indexedDB, active: reopened.server.active });
  await again.context.openCrewHome();
  assert.equal(again.posts.length, 0, 'nothing is sent twice');
});

// READ-BUDGET (review finding read-budget-perf-2): GET /api/employee-hub without a view decrypts every Employee Hub record.
// A clock action answered with its saved timecard updates the card and the pay estimate on the phone instead of reading
// all of them again, and the card reads exactly as a fresh full read of the same records shows it.
const fullReads = page => page.reads.filter(path => path === '/api/employee-hub').length;
const withoutNote = html => html.replace(/<small class="clock-note[^"]*" role="status">[^<]*<\/small>/, '');
test('a clock action answered with its timecard costs no second full Employee Hub read; the card matches a fresh read', async () => {
  const hour = 3600000, now = Date.now();
  // This person's finished shift earlier in the current pay period (4 hours at $20) and an open one since 2 hours ago.
  const done = { ...ENTRY, id: 'time-crew.one-done', status: 'approved', clockInAt: new Date(now - 6 * hour).toISOString(), clockOutAt: new Date(now - 2.5 * hour).toISOString(), breaks: [{ startAt: new Date(now - 5 * hour).toISOString(), endAt: new Date(now - 4.5 * hour).toISOString() }], jobTime: { clockInLocation: 'shared' } };
  const page = crewHome({ records: true, history: [done], active: { ...ENTRY, clockInAt: new Date(now - 2 * hour).toISOString(), jobTime: { clockInLocation: 'shared' } } });
  await page.context.openCrewHome();
  assert.equal(fullReads(page), 1, 'the home reads the Hub once when it opens');
  assert.match(page.card(), /<strong>Clocked in<\/strong><small>2\.00 hours today · location shared once at clock-in<\/small>/);
  assert.match(page.card(), /<span>Estimated pay<\/span><strong>\$\d+\.\d\d<\/strong><small>\d+\.\d\d hours · current two-week period<\/small>/);
  await page.context.crewClock('clock_out');
  assert.equal(page.posts.length, 1);
  assert.equal(fullReads(page), 1, 'clocking out reads nothing more: the saved timecard closes the shift and the pay estimate');
  assert.match(page.card(), /<strong>Clocked out<\/strong>.*Clocked out\. Your shift is submitted for approval\./);
  const fresh = crewHome({ records: true, history: page.server.closed });
  await fresh.context.openCrewHome();
  assert.equal(withoutNote(page.card()), withoutNote(fresh.card()), 'the same card a full read of the saved timecards shows');
  await page.context.crewClock('clock_in');
  assert.equal(fullReads(page), 1, 'clocking in reads nothing more either');
  const freshIn = crewHome({ records: true, history: page.server.closed, active: page.server.active });
  await freshIn.context.openCrewHome();
  assert.match(page.card(), /<strong>Clocked in<\/strong><small>0\.00 hours today · location shared once at clock-in<\/small>/);
  assert.equal(withoutNote(page.card()), withoutNote(freshIn.card()));
  // Without the timecard in the answer (an older server, or an already-applied replay) the Hub is read again, as before.
  const legacy = crewHome();
  await legacy.context.openCrewHome();
  await legacy.context.crewClock('clock_in');
  assert.equal(fullReads(legacy), 2);
});

test('a queued time action sent as the home opens is applied from its answer: one full Employee Hub read, not two', async () => {
  const indexedDB = fakeIndexedDB();
  const dropped = crewHome({ indexedDB, down: true, records: true });
  await dropped.context.openCrewHome();
  await dropped.context.crewClock('clock_in');
  assert.equal(dropped.posts.length, 0);
  const reopened = crewHome({ indexedDB, records: true });
  await reopened.context.openCrewHome();
  assert.equal(reopened.posts.length, 1, 'sent once when the home opens online');
  assert.equal(fullReads(reopened), 1, 'before: a second full read after the flush');
  assert.match(reopened.card(), /<strong>Clocked in<\/strong><small>[\d.]+ hours today · location shared once at clock-in<\/small>/);
  const fresh = crewHome({ records: true, active: reopened.server.active });
  await fresh.context.openCrewHome();
  assert.equal(reopened.card(), fresh.card());
});
