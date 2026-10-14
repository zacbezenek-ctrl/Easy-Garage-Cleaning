import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from './helpers/vm-realm.mjs';

const sources = [
  ['job', 'crew/job.js', '  async function api(', '  function acceptViewer('],
  ['cost', 'crew/field-expenses.js', '  async function api(', '  async function load('],
  ['payment', 'crew/field-payments.js', 'async function request(', 'function view('],
];
const data = { ok: true, jobId: 'job-1', entries: [], totals: { totalCents: 0 } };
const payload = { action: 'synthetic', requestId: 'same-request-id' };

for (const [name, file, start, end] of sources) {
  function harness(fetcher) {
    const text = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    const timers = new Map();
    let next = 0;
    const context = vm.createContext({
      AbortController, AbortSignal: {}, Error, JSON,
      S: { jobId: 'job-1' }, forgetSnapshots() {}, renderLogin() {},
      fetch: fetcher,
      setTimeout(fn, delay) { timers.set(++next, { fn, delay }); return next; },
      clearTimeout(id) { timers.delete(id); },
    });
    vm.runInContext(text.slice(text.indexOf(start), text.indexOf(end)) + `\nglobalThis.call = ${name === 'payment' ? 'request' : 'api'};`, context);
    return { call: context.call, timers };
  }

  test(`${name} requests work without AbortSignal.timeout and preserve their action ID`, async () => {
    let sent;
    const h = harness(async (url, init) => {
      assert.equal(url, '/synthetic');
      assert.equal(init.credentials, 'same-origin');
      assert.equal(init.cache, 'no-store');
      assert.equal(init.signal.aborted, false);
      sent = JSON.parse(init.body);
      return { ok: true, status: 200, json: async () => data };
    });
    assert.equal(await h.call('/synthetic', payload), data);
    assert.deepEqual(sent, payload);
    assert.equal(h.timers.size, 0, 'completed requests release their deadline');
  });

  test(`${name} requests still abort at their deadline on older browsers`, async () => {
    let signal;
    const h = harness((url, init) => new Promise((resolve, reject) => {
      signal = init.signal;
      signal.addEventListener('abort', () => reject(new Error('synthetic abort')), { once: true });
    }));
    const request = h.call('/synthetic', payload);
    assert.equal(h.timers.size, 1);
    const timer = [...h.timers.values()][0];
    assert.equal(timer.delay, 30000);
    timer.fn();
    await assert.rejects(request, /server did not confirm/i);
    assert.equal(signal.aborted, true);
    assert.equal(h.timers.size, 0, 'failed requests release their deadline');
  });
}

test('a shared-cost job lookup times out with actionable wording on an older browser', async () => {
  const text = readFileSync(new URL('../crew/field-expenses.js', import.meta.url), 'utf8');
  const timers = new Map(), state = { jobId: 'job-1', shareToken: 0 };
  let next = 0;
  const context = vm.createContext({
    AbortController, AbortSignal: {}, Error, TypeError, S: state, render() {},
    fetch(url, init) {
      assert.match(url, /view=share_jobs$/);
      return new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }));
    },
    setTimeout(fn, delay) { timers.set(++next, { fn, delay }); return next; },
    clearTimeout(id) { timers.delete(id); },
  });
  vm.runInContext(text.slice(text.indexOf('  async function loadShareJobs('), text.indexOf('  function settle(')) + '\nglobalThis.call = loadShareJobs;', context);
  const request = context.call();
  const timer = [...timers.values()][0];
  assert.equal(timer.delay, 30000);
  timer.fn();
  await request;
  assert.equal(state.shareLoading, false);
  assert.equal(state.shareError, 'Your other jobs could not be loaded. Check your connection and retry.');
  assert.equal(timers.size, 0);
});
