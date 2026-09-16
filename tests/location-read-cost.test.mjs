import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

function harness() {
  let now = 1700000000000;
  const calls = [], events = {}, cleared = [], callbacks = {};
  const values = new Map([['egc_u', 'SyntheticCrew'], ['egc_role', 'crew']]);
  const storage = { getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key) };
  const original = { id: 'time-synthetic', employee: 'SyntheticCrew', status: 'active', locationTracking: true, locationTrail: [], hourlyRate: 20 };
  let saved = { ...original };
  const env = { calls, events, callbacks, cleared, pending: null };
  const context = {
    console, URLSearchParams, Intl, Promise, Set, Map, Error,
    Date: class extends Date { static now() { return now; } },
    sessionStorage: storage, localStorage: storage, me: 'SyntheticCrew', jobsCache: [],
    location: { pathname: '/employee', search: '' },
    navigator: { geolocation: {
      watchPosition(success, failure) { callbacks.success = success; callbacks.failure = failure; return 7; },
      clearWatch(id) { cleared.push(id); },
    } },
    setInterval: () => 1, clearInterval() {}, setTimeout: () => 1, clearTimeout() {},
    addEventListener(name, callback) { events[name] = callback; },
    document: { readyState: 'loading', hidden: false, activeElement: null, addEventListener() {}, querySelector: () => null, querySelectorAll: () => [] },
    hubFetch: async (url, init = {}) => {
      calls.push({ url, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null });
      if (env.pending) return env.pending;
      assert.equal(url, '/api/employee-hub');
      assert.equal(init.method, 'POST', 'location updates must not reload employee collections');
      const payload = JSON.parse(init.body);
      assert.equal(payload.collection, 'timeEntries');
      assert.equal(payload.id, original.id);
      saved = { ...saved, ...payload.data, id: original.id, serverVerified: true };
      return { ok: true, json: async () => ({ ok: true, record: saved }) };
    },
  };
  context.window = context;
  const source = readFileSync(new URL('../employee-suite.js', import.meta.url), 'utf8')
    .replace(/\}\)\(\);\s*$/, 'globalThis.ui={S,startLocationWatch};})();');
  vm.runInNewContext(source, context);
  env.api = context.ui;
  env.context = context;
  env.api.S.people.timeEntries = [original];
  env.api.startLocationWatch(original.id);
  env.advance = milliseconds => { now += milliseconds; };
  return env;
}

const position = latitude => ({ coords: { latitude, longitude: -105.123456789, accuracy: 8.4 } });

test('minute location updates retain the server record and trail without rereading employee data', async () => {
  const env = harness();
  await env.callbacks.success(position(40.123456789));
  assert.equal(env.calls.length, 1);
  let entry = env.api.S.people.timeEntries[0];
  assert.equal(entry.serverVerified, true, 'local state must use the server response');
  assert.equal(entry.hourlyRate, 20);
  assert.equal(entry.lastLocation.lat, 40.123457);
  assert.equal(entry.lastLocation.lng, -105.123457);
  assert.equal(entry.lastLocation.accuracy, 8);
  assert.equal(entry.locationTrail.length, 1);
  await env.callbacks.success(position(41));
  assert.equal(env.calls.length, 1, 'GPS callbacks remain limited to one write a minute');
  env.advance(60000);
  env.context.document.hidden = true;
  await env.callbacks.success(position(42));
  assert.equal(env.calls.length, 2);
  entry = env.api.S.people.timeEntries[0];
  assert.equal(entry.locationTrail.length, 2, 'the next save includes the prior server-confirmed point');
  assert.equal(entry.locationTrail[0].lat, 40.123457);
  assert.equal(entry.locationTrail[1].lat, 42);
  assert.equal(entry.locationStatus, 'tracking');
  assert.equal(env.calls.every(call => call.method === 'POST'), true);
});

test('location errors save their status and stop tracking without a collection reload', async () => {
  const env = harness();
  await env.callbacks.failure(new Error('Location permission unavailable'));
  assert.equal(env.calls.length, 1);
  assert.equal(env.api.S.people.timeEntries[0].locationStatus, 'unavailable');
  assert.equal(env.api.S.people.timeEntries[0].locationError, 'Location permission unavailable');
  assert.equal(env.api.S.locationWatch, null);
  assert.deepEqual(env.cleared, [7]);
});

test('a location response arriving after signout cannot restore the previous employee data', async () => {
  const env = harness();
  let resolve;
  env.pending = new Promise(done => { resolve = done; });
  const pending = env.callbacks.success(position(40));
  env.events['egc:signout']();
  resolve({ ok: true, json: async () => ({ ok: true, record: { id: 'time-synthetic', employee: 'SyntheticCrew', locationStatus: 'tracking' } }) });
  await pending;
  assert.equal(env.api.S.people.timeEntries.length, 0);
  assert.equal(env.api.S.locationWatch, null);
  assert.equal(env.calls.length, 1);
});
