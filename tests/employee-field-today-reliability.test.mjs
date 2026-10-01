import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createDocument } from './helpers/hub-dom.mjs';
import { fieldJobProjection } from '../functions/_lib/field-execution.js';
import { fieldVisitProjection } from '../functions/_lib/field-execution-visits.js';

const source = readFileSync(new URL('../employee-field-today.js', import.meta.url), 'utf8');
const MONDAY = '2026-09-21', TUESDAY = '2026-09-22', WEDNESDAY = '2026-09-23';
const NOW = '2026-09-22T18:00:00.000Z';
const flush = async () => { for (let index = 0; index < 30; index++) await Promise.resolve(); };
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const job = (extra = {}) => ({ id: 'synthetic-job', type: 'job', customer: 'Synthetic Garage', date: TUESDAY, endDate: TUESDAY, time: '08:00', endTime: '10:00', status: 'scheduled', assignedCrew: ['crew.one'], ...extra });
const body = (jobs = [job()], extra = {}) => ({ ok: true, jobs, generatedAt: NOW, ...extra });
const response = (data = body(), status = 200) => ({ ok: status < 400, status, json: async () => data });
const button = (page, label) => page.host.querySelectorAll('button').find(node => node.textContent === label);

// Only the real agenda code and small DOM are used. Every request is routed to
// an in-memory response; fake timers cover deadlines without wall-clock sleeps.
function page(t, { fetcher = () => response(), now = NOW, online = true } = {}) {
  const document = createDocument(), host = document.createElement('main'), timers = new Map(), events = new Map(), calls = [];
  document.body.append(host);
  let elapsed = 0, sequence = 0;
  class ClockDate extends Date {
    constructor(...args) { super(...(args.length ? args : [Date.parse(now) + elapsed])); }
    static now() { return Date.parse(now) + elapsed; }
  }
  const schedule = (callback, delay, interval = false) => { const id = ++sequence; timers.set(id, { callback, at: elapsed + delay, delay, interval }); return id; };
  const context = {
    document, Node: document.Node, Date: ClockDate, Intl, URLSearchParams, AbortController,
    navigator: { onLine: online },
    setTimeout: (callback, delay) => schedule(callback, delay), clearTimeout: id => timers.delete(id),
    setInterval: (callback, delay) => schedule(callback, delay, true), clearInterval: id => timers.delete(id),
    addEventListener(name, listener) { const listeners = events.get(name) || []; listeners.push(listener); events.set(name, listeners); },
    fetch(url, init) { assert.match(String(url), /^\/api\/field-jobs\?/); const call = { url: String(url), init }; calls.push(call); return Promise.resolve().then(() => fetcher(call, calls.length)); },
  };
  context.window = context;
  vm.runInNewContext(source, context, { filename: 'employee-field-today.js' });
  const api = context.EGCFieldToday;
  t.after(() => api.unmount());
  return {
    context, document, host, calls, timers, api,
    mount: (target = host) => api.mount(target),
    fire: name => { for (const listener of events.get(name) || []) listener({ type: name }); },
    deadlines: () => [...timers.values()].filter(timer => !timer.interval),
    async advance(milliseconds) {
      const target = elapsed + milliseconds;
      while (true) {
        const entry = [...timers].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!entry) break;
        const [id, timer] = entry;
        elapsed = timer.at;
        if (timer.interval) timer.at += timer.delay; else timers.delete(id);
        timer.callback();
        await flush();
      }
      elapsed = target;
      await flush();
    },
  };
}

test('Field Today uses an uncached read, Denver dates, and one mount/poll timer', async t => {
  const ui = page(t, { now: '2026-09-23T01:00:00.000Z' });
  ui.mount(); ui.mount();
  await flush();
  assert.equal(ui.calls.length, 1);
  const params = new URLSearchParams(ui.calls[0].url.split('?')[1]);
  assert.equal(params.get('date'), TUESDAY, 'the UTC date is already Wednesday');
  assert.equal(params.get('days'), '2');
  assert.equal(params.get('status'), 'all');
  assert.equal(ui.calls[0].init.cache, 'no-store');
  assert.equal(ui.calls[0].init.credentials, 'same-origin');
  assert.equal(ui.calls[0].init.method, undefined, 'this module only reads');
  assert.match(ui.host.querySelector('.ft-current').textContent, /Synthetic Garage/);
  assert.equal(ui.deadlines().length, 0);
  assert.equal(ui.timers.size, 1);
  ui.document.hidden = true;
  await ui.advance(60000);
  assert.equal(ui.calls.length, 1, 'a hidden tab does not poll');
  ui.document.hidden = false;
  await ui.advance(60000);
  assert.equal(ui.calls.length, 2);
  ui.api.unmount();
  assert.equal(ui.timers.size, 0);
  await ui.advance(60000);
  assert.equal(ui.calls.length, 2);
});

test('a fetch ignoring abort times out at 30 seconds, clears stale jobs, and Retry gets a fresh deadline', async t => {
  const hanging = deferred();
  const ui = page(t, { fetcher: (_, index) => index === 2 ? hanging.promise : response(body([job({ customer: index === 1 ? 'Before timeout' : 'After retry' })])) });
  ui.mount(); await flush();
  let finished = false;
  const pending = ui.api.refresh().then(() => { finished = true; });
  await flush();
  await ui.advance(29999);
  assert.equal(finished, false);
  assert.equal(ui.host.querySelector('[role="alert"]'), null);
  await ui.advance(1);
  await pending;
  assert.equal(finished, true, 'the public refresh settles even if fetch does not');
  assert.equal(ui.calls[1].init.signal.aborted, true);
  assert.match(ui.host.querySelector('[role="alert"]').textContent, /timed out.*Retry/);
  assert.equal(ui.host.querySelector('.ft-job'), null, 'old assignments are not left verified on screen');
  assert.doesNotMatch(ui.host.textContent, /No jobs assigned today/);
  assert.equal(ui.deadlines().length, 0);
  button(ui, 'Retry').click();
  await flush();
  assert.match(ui.host.textContent, /After retry/);
  hanging.resolve(response(body([job({ customer: 'Late old response' })])));
  await flush();
  assert.doesNotMatch(ui.host.textContent, /Late old response|timed out/);
  assert.equal(ui.calls[2].init.signal.aborted, false);
  assert.equal(ui.deadlines().length, 0);
});

test('refresh replaces both a previously empty day and prior job cards with an unverified loading state', async t => {
  for (const jobs of [[], [job()]]) {
    const hanging = deferred();
    const ui = page(t, { fetcher: (_, index) => index === 1 ? response(body(jobs)) : hanging.promise });
    ui.mount(); await flush();
    assert.match(ui.host.textContent, jobs.length ? /Synthetic Garage/ : /No jobs assigned today/);
    const pending = ui.api.refresh(); await flush();
    assert.match(ui.host.querySelector('[role="status"]')?.textContent || '', /Loading your assigned jobs/);
    assert.equal(ui.host.querySelector('.ft-job'), null);
    assert.doesNotMatch(ui.host.textContent, /No jobs assigned today|Synthetic Garage|Checked/);
    await ui.advance(29999);
    assert.match(ui.host.textContent, /Loading your assigned jobs/);
    await ui.advance(1); await pending;
    assert.match(ui.host.textContent, /timed out/);
  }
});

test('the same 30-second deadline covers fetch and response.json, including abort-ignoring bodies', async t => {
  const headers = deferred(), json = deferred();
  const ui = page(t, { fetcher: (_, index) => index === 1 ? headers.promise : response(body([job({ customer: 'Verified retry' })])) });
  ui.mount(); await flush();
  await ui.advance(20000);
  let bodyReads = 0;
  headers.resolve({ ok: true, status: 200, json() { bodyReads++; return json.promise; } });
  await flush();
  assert.equal(bodyReads, 1);
  await ui.advance(9999);
  assert.equal(ui.host.querySelector('[role="alert"]'), null);
  await ui.advance(1);
  assert.match(ui.host.textContent, /timed out/);
  assert.equal(ui.calls[0].init.signal.aborted, true);
  button(ui, 'Retry').click(); await flush();
  json.resolve(body([job({ customer: 'Unverified late body' })])); await flush();
  assert.match(ui.host.textContent, /Verified retry/);
  assert.doesNotMatch(ui.host.textContent, /Unverified late body/);
  assert.equal(ui.deadlines().length, 0);
});

for (const phase of ['fetch', 'json']) {
  test(`a superseding refresh fences late ${phase} results and cancels only its own deadline`, async t => {
    const stale = deferred(), fresh = deferred();
    const ui = page(t, { fetcher: (_, index) => index === 1 ? phase === 'fetch' ? stale.promise : { ok: true, status: 200, json: () => stale.promise } : fresh.promise });
    ui.mount(); await flush(); await ui.advance(20000);
    const refreshed = ui.api.refresh(); await flush();
    assert.equal(ui.calls[0].init.signal.aborted, true);
    assert.equal(ui.calls[1].init.signal.aborted, false);
    assert.equal(ui.deadlines().length, 1);
    await ui.advance(10000);
    assert.equal(ui.host.querySelector('[role="alert"]'), null, 'the previous deadline cannot fail the new request');
    stale.resolve(phase === 'fetch' ? response(body([job({ customer: 'Stale schedule' })])) : body([job({ customer: 'Stale schedule' })]));
    await flush();
    assert.doesNotMatch(ui.host.textContent, /Stale schedule/);
    fresh.resolve(response(body([job({ customer: 'Fresh schedule' })])));
    await refreshed;
    assert.match(ui.host.textContent, /Fresh schedule/);
    assert.equal(ui.calls[1].init.signal.aborted, false);
    assert.equal(ui.deadlines().length, 0);
  });

  for (const action of ['unmount', 'egc:signout']) {
    test(`${action} cancels a pending ${phase} read and a remount cannot receive the old response`, async t => {
      const stale = deferred();
      const ui = page(t, { fetcher: (_, index) => index === 2 ? phase === 'fetch' ? stale.promise : { ok: true, status: 200, json: () => stale.promise } : response(body([job({ customer: index === 1 ? 'Old viewer' : 'New viewer' })])) });
      ui.mount(); await flush();
      let settled = false;
      const pending = ui.api.refresh().then(() => { settled = true; }); await flush();
      if (action === 'unmount') ui.api.unmount(); else ui.fire(action);
      await flush();
      assert.equal(settled, true, 'cancellation settles without waiting for a timeout or transport cooperation');
      await pending;
      assert.equal(ui.host.textContent, '');
      assert.equal(ui.calls[1].init.signal.aborted, true);
      assert.equal(ui.timers.size, 0);
      ui.mount(); await flush();
      stale.resolve(phase === 'fetch' ? response(body([job({ customer: 'Old viewer late data' })])) : body([job({ customer: 'Old viewer late data' })]));
      await flush();
      assert.match(ui.host.textContent, /New viewer/);
      assert.doesNotMatch(ui.host.textContent, /Old viewer/);
      await ui.advance(30000);
      assert.doesNotMatch(ui.host.textContent, /timed out/);
    });
  }
}

test('late rejection after a superseding read is consumed and cannot replace the latest agenda', async t => {
  const stale = deferred();
  const ui = page(t, { fetcher: (_, index) => index === 1 ? { ok: true, status: 200, json: () => stale.promise } : response() });
  ui.mount(); await flush();
  await ui.api.refresh();
  stale.reject(new Error('Old body failed')); await flush();
  assert.match(ui.host.textContent, /Synthetic Garage/);
  assert.equal(ui.host.querySelector('[role="alert"]'), null);
});

test('a detached host never receives a response and refresh does not fetch until remounted', async t => {
  const stale = deferred();
  const ui = page(t, { fetcher: (_, index) => index === 1 ? stale.promise : response() });
  ui.mount(); await flush(); ui.host.remove();
  stale.resolve(response()); await flush();
  assert.equal(ui.host.querySelector('.ft-job'), null);
  await ui.api.refresh();
  assert.equal(ui.calls.length, 1);
  const other = ui.document.createElement('main'); ui.document.body.append(other);
  ui.mount(other); await flush();
  assert.match(other.textContent, /Synthetic Garage/);
  assert.equal(ui.host.textContent, '');
});

test('offline mounting, Retry and polling do not fetch; reconnect verifies the agenda', async t => {
  const ui = page(t, { online: false });
  ui.mount(); await flush();
  assert.match(ui.host.textContent, /offline.*Reconnect and retry/);
  button(ui, 'Retry').click(); await flush(); await ui.advance(60000);
  assert.equal(ui.calls.length, 0);
  assert.equal(ui.deadlines().length, 0);
  ui.context.navigator.onLine = true; ui.fire('online'); await flush();
  assert.equal(ui.calls.length, 1);
  assert.match(ui.host.textContent, /Synthetic Garage/);
});

test('going offline fences an in-flight body and removes stale verified assignments', async t => {
  const stale = deferred();
  const ui = page(t, { fetcher: (_, index) => index === 2 ? { ok: true, status: 200, json: () => stale.promise } : response() });
  ui.mount(); await flush();
  const pending = ui.api.refresh(); await flush();
  ui.context.navigator.onLine = false; ui.fire('offline'); await pending;
  assert.equal(ui.calls.length, 2);
  assert.equal(ui.calls[1].init.signal.aborted, true);
  assert.equal(ui.deadlines().length, 0);
  assert.match(ui.host.textContent, /offline/);
  assert.equal(ui.host.querySelector('.ft-job'), null);
  stale.resolve(body()); await flush();
  assert.equal(ui.host.querySelector('.ft-job'), null);
  ui.context.navigator.onLine = true; ui.fire('online'); await flush();
  assert.match(ui.host.textContent, /Synthetic Garage/);
});

test('malformed success and unavailable reads fail closed; 401 offers sign-in and Retry recovers', async t => {
  for (const data of [null, { ok: true }, body([null]), body([{ customer: 'No ID' }]), body([], { walkthroughs: [{}] })]) {
    const ui = page(t, { fetcher: () => response(data) });
    ui.mount(); await flush();
    assert.match(ui.host.textContent, /could not be verified/);
    assert.equal(ui.host.querySelector('.ft-job'), null);
    assert.doesNotMatch(ui.host.textContent, /No jobs assigned today/);
    assert.equal(ui.deadlines().length, 0);
  }
  const ui = page(t, { fetcher: (_, index) => index === 2 ? response({ ok: false, error: 'Sign in again.' }, 401) : response() });
  ui.mount(); await flush(); await ui.api.refresh();
  assert.equal(ui.host.querySelector('.ft-job'), null);
  assert.ok(ui.host.querySelectorAll('a').find(link => link.textContent === 'Sign in again'));
  button(ui, 'Retry').click(); await flush();
  assert.match(ui.host.textContent, /Synthetic Garage/);
});

const segment = (id, date, extra = {}) => ({ id, date, endDate: date, time: '08:00', endTime: '10:00', assignedCrew: ['crew.one'], ...extra });
function projected(raw, { visits = false, assignedToday = true, today = TUESDAY } = {}) {
  const view = fieldJobProjection(raw, [], { viewer: 'crew.one', crewNames: { 'crew.one': 'Crew One', 'crew.two': 'Crew Two' }, resourceNames: { monday: 'Monday truck', wednesday: 'Wednesday truck' } });
  return visits ? { ...view, visits: fieldVisitProjection(raw, { today, viewer: 'crew.one', assignedToday }) } : view;
}

for (const visits of [false, true]) {
  test(`a continuous Monday–Wednesday assignment is active Tuesday (${visits ? 'with' : 'without'} visits projection)`, async t => {
    const raw = job({ date: MONDAY, endDate: WEDNESDAY, endTime: '17:00' });
    const ui = page(t, { fetcher: () => response(body([projected(raw, { visits })])) });
    ui.mount(); await flush();
    assert.match(ui.host.querySelector('.ft-current').textContent, /Synthetic Garage/);
    assert.equal(ui.host.querySelectorAll('.ft-job').length, 1, 'the current spanning job is not repeated as tomorrow’s next job');
  });

  test(`separate Monday and Wednesday segments do not become Tuesday work (${visits ? 'with' : 'without'} visits projection)`, async t => {
    const raw = job({ date: MONDAY, endDate: WEDNESDAY, assignmentSegments: [segment('mon', MONDAY, { vehicleId: 'monday' }), segment('wed', WEDNESDAY, { time: '13:00', endTime: '15:00', vehicleId: 'wednesday', assignedCrew: ['crew.one', 'crew.two'], crewLead: 'crew.two' })] });
    const ui = page(t, { fetcher: () => response(body([projected(raw, { visits, assignedToday: false })])) });
    ui.mount(); await flush();
    assert.equal(ui.host.querySelector('.ft-current'), null);
    assert.match(ui.host.textContent, /No jobs assigned today/);
    const next = ui.host.querySelector('.ft-job');
    assert.match(next.textContent, /NEXT JOB · TOMORROW/);
    assert.match(next.textContent, /1:00 PM – 3:00 PM · 2026-09-23/);
    assert.match(next.textContent, /Wednesday truck/);
    assert.match(next.textContent, /Crew One, Crew Two/);
    assert.doesNotMatch(next.textContent, /Monday truck/);
    assert.equal(next.querySelector('.ft-actions a').href, '/crew/job.html?jobId=synthetic-job', 'a segment never replaces the job link identity');
  });
}

test('one continuous assignment segment keeps intervening days active', async t => {
  const raw = job({ date: MONDAY, endDate: WEDNESDAY, assignmentSegments: [segment('span', MONDAY, { endDate: WEDNESDAY, endTime: '17:00' })] });
  const ui = page(t, { fetcher: () => response(body([projected(raw)])) });
  ui.mount(); await flush();
  assert.ok(ui.host.querySelector('.ft-current'));
});

test('another crew’s Tuesday segment and recorded visit do not authorize Tuesday work', async t => {
  const raw = job({ date: MONDAY, endDate: WEDNESDAY, assignedCrew: ['crew.one', 'crew.two'], assignmentSegments: [segment('mon', MONDAY), segment('tue', TUESDAY, { assignedCrew: ['crew.two'] }), segment('wed', WEDNESDAY)], fieldExecution: { visits: { [TUESDAY]: { status: 'ended', endedBy: 'crew.two', endedAt: NOW } } } });
  const view = projected(raw, { visits: true, assignedToday: false });
  assert.deepEqual(view.assignmentSegments.map(part => part.date), [MONDAY, WEDNESDAY]);
  assert.equal(view.visits.days.find(day => day.date === TUESDAY).scheduled, false);
  for (const withSegments of [true, false]) {
    const value = { ...view };
    if (!withSegments) delete value.assignmentSegments;
    const ui = page(t, { fetcher: () => response(body([value])) });
    ui.mount(); await flush();
    assert.equal(ui.host.querySelector('.ft-current'), null);
    assert.match(ui.host.querySelector('.ft-job').textContent, /NEXT JOB · TOMORROW/);
  }
  // Even a historical entry with no matching `today` lock cannot be treated as
  // a scheduled visit when consuming the projected visits-only shape.
  delete view.assignmentSegments;
  view.visits.today = MONDAY;
  const ui = page(t, { fetcher: () => response(body([view])) });
  ui.mount(); await flush();
  assert.equal(ui.host.querySelector('.ft-current'), null);
});

test('midnight releases the ending day for continuous jobs and assignment segments', async t => {
  for (const segmented of [false, true]) {
    const raw = job({ date: MONDAY, endDate: TUESDAY, endTime: '00:00', ...(segmented ? { assignmentSegments: [segment('night', MONDAY, { endDate: TUESDAY, endTime: '00:00' })] } : {}) });
    const ui = page(t, { fetcher: () => response(body([projected(raw)])) });
    ui.mount(); await flush();
    assert.equal(ui.host.querySelector('.ft-job'), null);
    assert.match(ui.host.textContent, /No jobs assigned today/);
  }
});

test('an explicitly empty viewer-segment projection cannot fall back to the job hull', async t => {
  const view = projected(job({ date: MONDAY, endDate: WEDNESDAY, assignmentSegments: [segment('other', MONDAY, { endDate: WEDNESDAY, assignedCrew: ['crew.two'] })] }));
  assert.deepEqual(view.assignmentSegments, []);
  const ui = page(t, { fetcher: () => response(body([view])) });
  ui.mount(); await flush();
  assert.equal(ui.host.querySelector('.ft-job'), null);
});
