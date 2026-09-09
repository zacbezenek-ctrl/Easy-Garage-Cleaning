import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { onRequest as middleware } from '../functions/_middleware.js';

const source = await fs.readFile(new URL('../employee-gusto.js', import.meta.url), 'utf8');
const settle = async () => { for (let i = 0; i < 3; i += 1) await new Promise(resolve => setImmediate(resolve)); };
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
const readyRow = (id, changes = {}) => ({ id, employee: `crew.${id}`, employeeName: `Crew ${id}`, status: 'approved', clockInAt: '2026-09-07T15:00:00Z', hours: 8, reviewToken: `original-review-${id}`, transferToken: `original-transfer-${id}`, mapping: { employeeUuid: `employee-${id}`, jobUuid: `job-${id}`, employeeName: `Gusto crew ${id}`, jobTitle: 'Crew' }, classification: { regular: 8, overtime: 0, doubleOvertime: 0 }, issues: [], sync: { status: 'not_synced' }, ...changes });
const preview = (rows = [readyRow('a')], changes = {}) => ({ ok: true, connection: { configured: true, connected: true, environment: 'production', message: 'Connected to Gusto.' }, rows, excluded: [], ...changes });
function fixture(initial = preview()) {
  const host = { innerHTML: '' }, events = new Map(), calls = [], dialogs = [];
  const state = { preview: initial, ask: async () => null, post: async () => ({ ok: true, results: [] }), roster: { ok: true, employees: [] }, load: null };
  const window = { addEventListener: (name, handler) => events.set(name, handler) };
  const sandbox = vm.createContext({
    window, document: { getElementById: id => id === 'ops-gusto-payroll' ? host : null }, location: { search: '' }, URLSearchParams, Date,
    hubFetch: async (path, options = {}) => {
      const body = options.body ? JSON.parse(options.body) : null;
      calls.push({ path, method: options.method || 'GET', body, options });
      let result;
      if (body) result = await state.post(body);
      else if (path.includes('view=roster')) result = state.roster;
      else result = state.load ? await state.load(path) : state.preview;
      return Response.json(result, { status: result.httpStatus || 200 });
    },
  });
  vm.runInContext(source, sandbox);
  const askAction = async spec => { dialogs.push(spec); return state.ask(spec); };
  const options = { owner: true, identity: 'ZacB', generation: 1, startDate: '2026-09-07', endDate: '2026-09-13', askAction };
  return { window, host, state, calls, dialogs, events, options, mount: changed => window.EGCGusto.mount({ ...options, ...changed }), posts: () => calls.filter(call => call.method === 'POST') };
}

test('Gusto UI makes no requests for a non-owner', async () => {
  const ui = fixture();
  ui.mount({ owner: false });
  await settle();
  assert.equal(ui.calls.length, 0);
  await ui.window.egcGustoRefresh();
  await ui.window.egcGustoSync();
  await ui.window.egcGustoMap('a');
  assert.equal(ui.calls.length, 0);
});

test('mount only reads a preview and missing configuration offers no connect or send action', async () => {
  const ui = fixture(preview([], { connection: { configured: false, connected: false, message: 'Gusto approval is required.' } }));
  ui.mount();
  await settle();
  assert.equal(ui.calls.length, 1);
  assert.equal(ui.calls[0].method, 'GET');
  const url = new URL(ui.calls[0].path, 'https://easygaragecleaning.com');
  assert.equal(url.searchParams.get('view'), 'preview');
  assert.equal(url.searchParams.get('start'), '2026-09-07');
  assert.equal(url.searchParams.get('end'), '2026-09-13');
  assert.match(ui.host.innerHTML, /Gusto approval is required/);
  assert.ok(!ui.host.innerHTML.includes('href="/api/gusto-auth"'));
  assert.ok(!ui.host.innerHTML.includes('onclick="egcGustoSync()"'));
  await ui.window.egcGustoSync();
  assert.equal(ui.posts().length, 0);
});

test('only ready approved rows enter the send confirmation and cancelling makes no write', async () => {
  const ui = fixture(preview([
    readyRow('a'), readyRow('b'), readyRow('unmapped', { mapping: null }), readyRow('unclassified', { classification: null }),
    readyRow('issue', { issues: [{ message: 'Hours need correction' }] }), readyRow('sent', { sync: { status: 'synced' } }),
    readyRow('uncertain', { sync: { status: 'uncertain' } }), readyRow('unreviewed', { transferToken: '' }),
  ]));
  ui.mount();
  await settle();
  const approval = deferred();
  ui.state.ask = () => approval.promise;
  const sending = ui.window.egcGustoSync();
  await settle();
  assert.equal(ui.dialogs.length, 1);
  assert.match(ui.dialogs[0].title, /Send 2 approved timecards/);
  assert.equal(ui.posts().length, 0, 'opening confirmation never sends timecards');
  approval.resolve(null);
  await sending;
  assert.equal(ui.posts().length, 0, 'cancelled confirmation never sends timecards');
});

test('classification sends numeric reviewed amounts and the original review token', async () => {
  const ui = fixture();
  ui.mount();
  await settle();
  const approval = deferred();
  ui.state.ask = () => approval.promise;
  ui.state.post = async () => ({ ok: true });
  const classifying = ui.window.egcGustoClassify('a');
  await settle();
  assert.equal(ui.posts().length, 0);
  assert.equal(ui.dialogs[0].fields[0].name, 'regular');
  ui.state.preview = preview([readyRow('a', { reviewToken: 'newer-review-token' })]);
  await ui.window.egcGustoRefresh();
  approval.resolve({ regular: '7.5', overtime: '0.5', doubleOvertime: '0' });
  await classifying;
  assert.deepEqual(ui.posts()[0].body, { action: 'classify', timecardId: 'a', reviewToken: 'original-review-a', regular: 7.5, overtime: 0.5, doubleOvertime: 0 });
});

test('sync waits for approval and sends the tokens captured for those reviewed rows', async () => {
  const ui = fixture(preview([readyRow('a'), readyRow('b'), readyRow('sent', { sync: { status: 'synced' } })]));
  ui.mount();
  await settle();
  const approval = deferred();
  ui.state.ask = () => approval.promise;
  ui.state.post = async () => ({ ok: true, results: [{ timecardId: 'a', status: 'synced' }, { timecardId: 'b', status: 'unchanged' }] });
  const sending = ui.window.egcGustoSync();
  await settle();
  assert.equal(ui.posts().length, 0);
  ui.state.preview = preview([readyRow('a', { transferToken: 'newer-transfer-a' }), readyRow('b', { transferToken: 'newer-transfer-b' })]);
  await ui.window.egcGustoRefresh();
  approval.resolve({});
  await sending;
  assert.deepEqual(ui.posts()[0].body, { action: 'sync', timecardIds: ['a', 'b'], reviewTokens: { a: 'original-transfer-a', b: 'original-transfer-b' } });
  assert.match(ui.host.innerHTML, /2 of 2 timecards confirmed in Gusto/);
});

test('a preview arriving after signout cannot restore the previous employee roster', async () => {
  const ui = fixture(), pending = deferred();
  ui.state.load = () => pending.promise;
  ui.mount();
  await settle();
  ui.events.get('egc:signout')();
  ui.host.innerHTML = '<p>Signed out</p>';
  pending.resolve(preview([readyRow('private', { employeeName: 'PRIVATE OLD ROSTER' })]));
  await settle();
  assert.equal(ui.host.innerHTML, '<p>Signed out</p>');
  await ui.window.egcGustoSync();
  assert.equal(ui.posts().length, 0);
});

test('a stale range preview cannot replace the new range roster', async () => {
  const ui = fixture(), old = deferred();
  ui.state.load = path => path.includes('start=2026-09-07') ? old.promise : Promise.resolve(preview([readyRow('new', { employeeName: 'CURRENT WEEK EMPLOYEE' })]));
  ui.mount();
  await settle();
  ui.mount({ startDate: '2026-09-14', endDate: '2026-09-20' });
  await settle();
  assert.match(ui.host.innerHTML, /CURRENT WEEK EMPLOYEE/);
  old.resolve(preview([readyRow('old', { employeeName: 'STALE PREVIOUS EMPLOYEE' })]));
  await settle();
  assert.match(ui.host.innerHTML, /CURRENT WEEK EMPLOYEE/);
  assert.ok(!ui.host.innerHTML.includes('STALE PREVIOUS EMPLOYEE'));
});

test('employee matching uses the parent dialog options and safely renders names', async () => {
  const name = '<img src=x onerror=alert(1)>';
  const ui = fixture(preview([readyRow('a', { employeeName: name, mapping: null })]));
  ui.state.roster = { ok: true, employees: [{ uuid: 'employee-a', name, email: 'crew@example.test', jobs: [{ uuid: 'job-a', title: 'Crew & lead' }] }] };
  ui.mount();
  await settle();
  assert.ok(!ui.host.innerHTML.includes(name));
  assert.match(ui.host.innerHTML, /&lt;img src=x onerror=alert\(1\)&gt;/);
  const approval = deferred();
  ui.state.ask = () => approval.promise;
  ui.state.post = async () => ({ ok: true });
  const mapping = ui.window.egcGustoMap('a');
  await settle();
  const options = ui.dialogs[0].fields[0].options;
  assert.equal(ui.dialogs[0].fields[0].type, 'select');
  assert.equal(options[1].value, 'employee-a:job-a');
  assert.equal(options[1].label, `${name} · crew@example.test · Crew & lead`);
  assert.equal(ui.posts().length, 0);
  assert.ok(!ui.host.innerHTML.includes(name));
  approval.resolve({ match: 'employee-a:job-a' });
  await mapping;
  assert.deepEqual(ui.posts()[0].body, { action: 'map', username: 'crew.a', employeeUuid: 'employee-a', jobUuid: 'job-a', confirmed: true });
});

test('a sync failure remains visible after the follow-up preview refresh', async () => {
  const ui = fixture();
  ui.mount();
  await settle();
  ui.state.ask = async () => ({});
  ui.state.post = async () => ({ ok: false, httpStatus: 503, error: 'Reconnect Gusto before syncing hours.' });
  await ui.window.egcGustoSync();
  assert.equal(ui.posts().length, 1);
  assert.equal(ui.calls.filter(call => call.method === 'GET').length, 2);
  assert.match(ui.host.innerHTML, /role="alert"[^>]*>Reconnect Gusto before syncing hours/);
});

test('pending confirmation from a previous week cannot submit into the new view', async () => {
  const ui = fixture(), approval = deferred();
  ui.mount();
  await settle();
  ui.state.ask = () => approval.promise;
  const sending = ui.window.egcGustoSync();
  await settle();
  ui.mount({ startDate: '2026-09-14', endDate: '2026-09-20' });
  await settle();
  approval.resolve({});
  await sending;
  assert.equal(ui.posts().length, 0);
});

test('per-timecard failure reasons survive refresh and are escaped', async () => {
  const ui = fixture();
  ui.mount();
  await settle();
  ui.state.ask = async () => ({});
  ui.state.post = async () => ({ ok: true, results: [{ id: 'a', status: 'error', message: 'Employee <changed> before sending.' }] });
  await ui.window.egcGustoSync();
  assert.equal(ui.posts().length, 1);
  assert.equal(ui.calls.filter(call => call.method === 'GET').length, 2);
  assert.match(ui.host.innerHTML, /Employee &lt;changed&gt; before sending/);
  assert.ok(!ui.host.innerHTML.includes('Employee <changed>'));
  await ui.window.egcGustoSync();
  assert.equal(ui.posts().length, 1, 'An unresolved failure requires refresh or correction before retry');
});

test('Gusto OAuth middleware preserves the nonce CSP and prohibits referrer and frame leakage', async () => {
  const csp = "default-src 'none'; script-src 'nonce-synthetic'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";
  const response = await middleware({ request: new Request('https://easygaragecleaning.com/api/gusto-auth?code=synthetic-code'), next: async () => new Response('<script nonce="synthetic">complete()</script>', { headers: { 'Content-Type': 'text/html', 'Content-Security-Policy': csp, 'Referrer-Policy': 'no-referrer' } }) });
  assert.equal(response.headers.get('Content-Security-Policy'), csp);
  assert.equal(response.headers.get('Referrer-Policy'), 'no-referrer');
  assert.equal(response.headers.get('X-Frame-Options'), 'DENY');
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.match(await response.text(), /nonce="synthetic"/);
});
