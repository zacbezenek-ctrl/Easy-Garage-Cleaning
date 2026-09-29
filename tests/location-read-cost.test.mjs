import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from './helpers/vm-realm.mjs';
import { fakeIndexedDB } from './helpers/fake-indexeddb.mjs';
import { hubPage } from './helpers/hub-dom.mjs';
import { vaultFirestore, staffEnv, cookieFor, jsonRequest } from './helpers/vault-fixture.mjs';
import * as employeeHub from '../functions/api/employee-hub.js';
import * as hubAuth from '../functions/api/hub-auth.js';

// CREW-TIME (owner decision 2026-09-29, clock-in only): the Employee Hub reads the phone's position once, as a shift
// starts, and never again during it. These tests used to pin the HUB-PWA shift location watch (one save a minute, its
// errors and its trail); that watch is gone, so they now pin what replaced it, through the real Hub and the real
// endpoints: the one read at clock-in, its single retry on a weak signal, the clock-in with no position (flagged for a
// manager, behind EGC_CLOCK_IN_WITHOUT_FIX), and that nothing reads or sends a position after it, crew or manager,
// with offline saving (HUB_OFFLINE_ENABLED) on or off.

const queueSource = readFileSync(new URL('../employee-offline-queue.js', import.meta.url), 'utf8');
const NOW = '2026-09-22T18:00:00.000Z'; // hub-dom's fixed page clock; the server's clock is mocked to the same instant
const PATH = '/api/employee-hub';
const ENV = staffEnv();
const FLAGGED = staffEnv({ EGC_CLOCK_IN_WITHOUT_FIX: 'true' });
const CREW = 'Crew.Static';
const WHOS = [{ user: CREW, business: false, role: 'crew' }, { user: 'TylerG', business: true, role: 'manager' }];
const FIRST = { enableHighAccuracy: true, maximumAge: 60000, timeout: 15000 };
const RETRY = { enableHighAccuracy: false, maximumAge: 300000, timeout: 10000 };
const HERE = { latitude: 40.585123456, longitude: -105.084987654, accuracy: 6.4 };
const SAVED_HERE = { lat: 40.585123, lng: -105.084988, accuracy: 6, capturedAt: NOW };
const DENIED = 1, UNAVAILABLE = 2, TIMEOUT = 3;
const plain = value => JSON.parse(JSON.stringify(value));
const idle = () => new Promise(resolve => setTimeout(resolve, 0));
const until = async (done, rounds = 2000) => { for (let i = 0; i < rounds && !done(); i++) await idle(); return done(); };

// navigator.geolocation. Each getCurrentPosition call takes the next outcome: a position, an error code, or 'hold' (answered
// by the test). Every read's options are kept, and a watch the Hub started would be listed in watches.
function geolocation(outcomes = [HERE]) {
  const reads = [], watches = [], held = [];
  return {
    reads, watches, held,
    getCurrentPosition(success, failure, options) {
      const outcome = outcomes[reads.length] ?? outcomes.at(-1);
      reads.push(plain(options));
      if (outcome === 'hold') held.push({ success, failure });
      else if (typeof outcome === 'number') failure({ code: outcome, message: `Synthetic geolocation error ${outcome}` });
      else success({ coords: outcome });
    },
    watchPosition: (...args) => { watches.push(args); return watches.length; },
    clearWatch() {},
  };
}

// A signed-in viewer on the real endpoints (crew are onboarded, as the Hub requires before a first shift).
async function signedIn(t, who, env) {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(NOW) });
  vaultFirestore(t);
  const cookie = await cookieFor(env, who.user);
  if (who.role === 'crew') {
    const done = await employeeHub.onRequestPost({ env, request: jsonRequest(PATH, { collection: 'profiles', id: who.user.toLowerCase(), data: { onboardingCompletedAt: '2026-09-22T08:00:00.000Z', onboardingAcknowledgements: ['timekeeping', 'location_policy', 'safety', 'customer_care', 'hub_basics'] } }, cookie) });
    assert.equal(done.status, 200, await done.clone().text());
  }
  return cookie;
}

// The real Hub (employee-suite.js, and the offline queue when offline saving is on) against the real endpoints.
async function hub(t, { who = WHOS[0], env = ENV, geo = geolocation(), offline = false } = {}) {
  const cookie = await signedIn(t, who, env), posts = [];
  let serving = 0;
  const serve = async work => { serving++; try { return await work(); } finally { serving--; } };
  const page = hubPage({ user: who.user, business: who.business, role: who.role, fetcher: async (url, init = {}) => {
    if ((init.method || 'GET') === 'POST') { posts.push(JSON.parse(init.body)); return serve(() => employeeHub.onRequestPost({ env, request: jsonRequest(url, init.body, cookie) })); }
    if (url === '/api/hub-auth') return serve(() => hubAuth.onRequestGet({ env, request: jsonRequest(url, undefined, cookie) }));
    if (url.startsWith(PATH)) return serve(() => employeeHub.onRequestGet({ env, request: jsonRequest(url, undefined, cookie) }));
    return Response.json({ ok: false, error: 'Synthetic service unavailable' }, { status: 503 });
  } });
  page.context.navigator.geolocation = geo;
  page.context.navigator.onLine = true;
  if (offline) {
    Object.assign(page.context, { indexedDB: fakeIndexedDB(), Response, Event: class { constructor(type) { this.type = type; } }, dispatchEvent: event => { page.fire(event.type); return true; } });
    vm.runInContext(queueSource, page.context, { filename: 'employee-offline-queue.js' });
    page.context.EGCHubOffline.configure({ enabled: true });
  }
  const S = page.api.S;
  const settle = async () => { for (let round = 0; round < 3; round++) { await until(() => !serving && !S.peopleRequest && !page.context.EGCHubOffline?.state?.().syncing); for (let i = 0; i < 20; i++) await idle(); } };
  page.api.install();
  await settle();
  const records = async () => (await (await employeeHub.onRequestGet({ env, request: jsonRequest(PATH, undefined, cookie) })).json()).collections.timeEntries;
  return {
    page, S, geo, posts, settle, records,
    button: () => page.document.querySelector('#ops-clock-in'),
    card: () => page.document.querySelector('.ops-clock-card')?.textContent || '',
    clockIns: () => posts.filter(body => body.collection === 'timeEntries' && body.data.clockInAt),
    // Anything after the clock-in that carries a position, a trail, or a location status other than the clock-out's 'stopped'.
    locationSends: () => posts.filter(body => body.collection === 'timeEntries' && !body.data.clockInAt && (body.data.lastLocation || body.data.locationTrail || (body.data.locationStatus && body.data.locationStatus !== 'stopped') || body.data.locationTracking === true)),
    open: () => S.people.timeEntries.find(entry => entry.status === 'active' && !entry.clockOutAt) || null,
  };
}

// Everything a Hub tab does during a shift that once touched shift location: renders, the page shown again, back online,
// focus, a pending timer, Keep working, a break, and the clock-out.
async function wholeShift(p) {
  const { page } = p;
  page.api.render(true);
  page.document.hidden = true; page.document.dispatch({ type: 'visibilitychange' });
  page.document.hidden = false; page.document.dispatch({ type: 'visibilitychange' });
  page.fire('online'); page.fire('focus'); page.fire('pageshow');
  await p.settle();
  for (const timer of page.timers.splice(0)) timer.callback();
  await p.settle();
  page.context.opsKeepWorking();
  await page.context.opsStartBreak(); await p.settle();
  await page.context.opsEndBreak(); await p.settle();
  await page.context.opsClockOut(); await p.settle();
}

for (const who of WHOS) for (const offline of [false, true]) {
  const label = `${who.role}, offline saving ${offline ? 'on' : 'off'}`;
  test(`Hub (${label}): clocking in reads the position once, shares it once, and nothing reads or sends a position for the rest of the shift`, async t => {
    const p = await hub(t, { who, offline });
    assert.deepEqual(p.geo.reads, [], 'loading the Hub reads no position');
    await p.page.context.opsClockIn();
    await p.settle();
    assert.deepEqual(p.geo.reads, [FIRST], 'one read, as the shift starts');
    assert.equal(p.clockIns().length, 1);
    const sent = p.clockIns()[0].data;
    assert.deepEqual([sent.locationTracking, sent.locationStatus, sent.lastLocation, 'locationTrail' in sent], [true, 'hub_single_fix', SAVED_HERE, false]);
    assert.equal(p.page.toasts.at(-1), 'Clocked in · location shared once');
    const [stored] = await p.records();
    assert.deepEqual(plain([stored.status, stored.locationTracking, stored.locationStatus, stored.lastLocation, stored.locationTrail ?? 'none']), ['active', false, 'hub_single_fix', SAVED_HERE, 'none'], 'the server keeps the one position and no trail');
    if (who.role === 'crew') assert.match(p.card(), /Location shared once at clock-in/);

    await wholeShift(p);
    assert.equal(p.open(), null, 'the shift was clocked out');
    assert.deepEqual(p.geo.reads, [FIRST], 'no position was read after clock-in');
    assert.deepEqual(p.geo.watches, [], 'no location watch');
    assert.deepEqual(p.locationSends(), [], 'no position or location status left the tab after clock-in');
  });
}

test('Hub: while the phone looks for its position the button says Getting your location…, a second tap reads nothing, and the answer clocks in', async t => {
  const p = await hub(t, { geo: geolocation(['hold']) });
  assert.equal(p.button()?.textContent, 'Clock in');
  const clocking = p.page.context.opsClockIn();
  p.page.api.render(true);
  assert.equal(p.button().textContent, 'Getting your location…');
  assert.equal(p.button().hasAttribute('disabled'), true, 'the button cannot be tapped twice');
  await p.page.context.opsClockIn();
  assert.equal(p.geo.reads.length, 1, 'a second tap while locating reads nothing');
  p.geo.held[0].success({ coords: HERE });
  await clocking; await p.settle();
  assert.equal(p.clockIns().length, 1);
  assert.equal(p.button(), null, 'the shift started');
  assert.match(p.card(), /CLOCKED IN/); assert.match(p.card(), /Location shared once at clock-in/);
});

test('Hub: a read that times out or finds no position is tried once more with a coarse, cached position, and that one is shared', async t => {
  for (const first of [TIMEOUT, UNAVAILABLE]) {
    const p = await hub(t, { geo: geolocation([first, HERE]) });
    await p.page.context.opsClockIn(); await p.settle();
    assert.deepEqual(p.geo.reads, [FIRST, RETRY], `error ${first}: one retry, enableHighAccuracy false and maximumAge 300000`);
    assert.deepEqual([p.clockIns().length, p.clockIns()[0].data.locationStatus, p.clockIns()[0].data.lastLocation], [1, 'hub_single_fix', SAVED_HERE]);
    assert.equal(p.page.toasts.at(-1), 'Clocked in · location shared once');
    t.mock.timers.reset();
  }
});

test('Hub, EGC_CLOCK_IN_WITHOUT_FIX unset: no position after the retry (or no location on the phone) starts no shift and says what to do', async t => {
  for (const [outcomes, geolocationOn] of [[[TIMEOUT, TIMEOUT], true], [[UNAVAILABLE, TIMEOUT], true], [[], false]]) {
    const geo = geolocation(outcomes), p = await hub(t, { geo });
    if (!geolocationOn) delete p.page.context.navigator.geolocation;
    assert.equal(p.S.clockInWithoutFix, false);
    await p.page.context.opsClockIn(); await p.settle();
    assert.equal(geo.reads.length, geolocationOn ? 2 : 0);
    assert.deepEqual(p.clockIns(), [], 'nothing was sent');
    assert.equal(p.page.toasts.at(-1), 'Your phone could not find its location. Move near a window or outside, then try again.');
    assert.equal(p.open(), null);
    assert.equal(p.button().textContent, 'Clock in'); assert.equal(p.button().hasAttribute('disabled'), false, 'the crew member can try again');
    t.mock.timers.reset();
  }
});

test('Hub, EGC_CLOCK_IN_WITHOUT_FIX=true: no position after the retry clocks in without one, flagged for a manager, and still nothing is read later', async t => {
  for (const who of WHOS) {
    const p = await hub(t, { who, env: FLAGGED, geo: geolocation([TIMEOUT, UNAVAILABLE]) });
    assert.equal(p.S.clockInWithoutFix, true, 'the Hub learns the switch from its records');
    await p.page.context.opsClockIn(); await p.settle();
    assert.deepEqual(p.geo.reads, [FIRST, RETRY]);
    const sent = p.clockIns()[0].data;
    assert.deepEqual([sent.locationStatus, 'lastLocation' in sent], ['location_unavailable_at_clock_in', false]);
    assert.equal(p.page.toasts.at(-1), 'Clocked in without a location · a manager will review it');
    const [stored] = await p.records();
    assert.deepEqual([stored.status, stored.locationReview, stored.locationStatus, stored.lastLocation ?? null], ['active', 'location_unavailable_at_clock_in', 'location_unavailable_at_clock_in', null]);
    if (who.role === 'crew') { assert.match(p.card(), /No location at clock-in/); assert.match(p.card(), /A manager reviews this shift/); }
    await wholeShift(p);
    assert.equal(p.geo.reads.length, 2, `${who.role}: no position read after clock-in`);
    assert.deepEqual(p.geo.watches, []); assert.deepEqual(p.locationSends(), []);
    t.mock.timers.reset();
  }
});

test('Hub: location access denied is never retried or flagged; it asks for location access, with the switch on or off', async t => {
  for (const env of [ENV, FLAGGED]) {
    const p = await hub(t, { env, geo: geolocation([DENIED, HERE]) });
    await p.page.context.opsClockIn(); await p.settle();
    assert.deepEqual(p.geo.reads, [FIRST], 'no retry after a denial');
    assert.deepEqual(p.clockIns(), []);
    assert.equal(p.page.toasts.at(-1), 'Clock-in needs location access. Enable location for this site, then try again.');
    t.mock.timers.reset();
  }
});

test('Hub: the onboarding location test reads a position before a shift, and none during one', async t => {
  const p = await hub(t);
  await p.page.context.opsVerifyLocation(); await p.settle();
  assert.equal(p.geo.reads.length, 1);
  assert.equal(p.page.toasts.at(-1), 'Location is ready for clock-in');
  const profile = p.posts.find(body => body.collection === 'profiles' && body.data.locationVerifiedAt).data;
  assert.equal('lastLocation' in profile || 'lat' in profile, false, 'only the check and its accuracy are saved');
  await p.page.context.opsClockIn(); await p.settle();
  assert.equal(p.geo.reads.length, 2);
  await p.page.context.opsVerifyLocation(); await p.settle();
  assert.equal(p.geo.reads.length, 2, 'no read during the shift');
  assert.equal(p.page.toasts.at(-1), 'You are clocked in · test your location before your next shift');
});
