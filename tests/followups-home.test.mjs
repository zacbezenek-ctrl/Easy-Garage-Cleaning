import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { hubPage, createDocument, FixedDate, NOW } from './helpers/hub-dom.mjs';

// The real overdue follow-ups widget and home-widget registry in a vm DOM with a fake /api/operations and a fixed clock
// (2026-09-22T18:00:00Z, noon in Denver).
const source = readFileSync(new URL('../employee-followups-home.js', import.meta.url), 'utf8');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MIN = 60000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const iso = ms => new Date(ms).toISOString();
const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
const OWNERS = [{ id: 'zacb', name: 'Synthetic Owner', role: 'owner' }, { id: 'tylerg', name: 'Synthetic Phone', role: 'sales' }];
const identity = (actor = { id: 'zacb', role: 'owner', kind: 'human' }, enabled = true) => ({ ok: true, enabled, actor, owners: OWNERS, timeZone: 'America/Denver' });
const task = (n, extra = {}) => ({ id: `task-${n}`, title: `Synthetic follow-up ${n}`, kind: 'callback', status: 'open', assignedUserId: 'tylerg', waitingOn: 'none', dueAt: iso(NOW - (n + 1) * HOUR), reviewAt: null, revision: 1, ...extra });
const queue = (items, total = items.length) => ({ ok: true, items, total, offset: 0, nextOffset: total > items.length ? items.length : null, asOf: iso(NOW), coverage: { registeredTasks: 'complete', inferredCommitments: 'not_complete' } });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const flush = async (rounds = 25) => { for (let index = 0; index < rounds; index++) await Promise.resolve(); };
const posts = calls => calls.filter(call => call.init.method === 'POST').map(call => JSON.parse(call.init.body));

function widget(respond, extra = {}) {
  const document = createDocument(), events = {}, timers = [], calls = [];
  const context = {
    console, URL, Intl, Promise, Map, Set, Error, JSON, Object, Array, Math, Number, String, AbortController, crypto, queueMicrotask,
    Date: FixedDate, Node: document.Node, document, location: { assign(url) { context.assigned = url; } },
    setTimeout: (callback, delay) => { timers.push({ callback, delay }); return timers.length; }, clearTimeout() {},
    addEventListener: (name, listener) => { (events[name] ||= []).push(listener); },
    fetch: (url, init = {}) => { calls.push({ url, init }); return respond(url, init, calls.length); },
    ...extra,
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(source, context, { filename: 'employee-followups-home.js' });
  const host = document.createElement('main');
  document.body.append(host);
  return { context, document, host, calls, timers, api: context.EGCFollowupsHome, fire: name => { for (const listener of events[name] || []) listener({ type: name }); } };
}
const api = handlers => (url, init) => {
  assert.equal(url, '/api/operations');
  assert.equal(init.credentials, 'same-origin');
  return init.method === 'POST' ? handlers.post(JSON.parse(init.body), init) : handlers.get(init);
};
const text = node => node.textContent.replace(/\s+/g, ' ');
const collections = () => Object.fromEntries(['profiles', 'timeEntries', 'announcements', 'requests', 'incidents', 'equipment', 'training', 'teamMessages', 'jobMessages', 'messageReads'].map(name => [name, []]));

test('renders the verified overdue count and the five most overdue actions with owner, kind and how late each is', async () => {
  const items = [
    task(1, { dueAt: iso(NOW - 3 * DAY), kind: 'followup_message', assignedUserId: 'zacb' }),
    task(2, { dueAt: iso(NOW - 26 * HOUR) }),
    task(3, { waitingOn: 'customer', dueAt: iso(NOW + DAY), reviewAt: iso(NOW - 25 * MIN), kind: 'send_quote' }),
    task(4, { assignedUserId: null, kind: 'prepare_quote' }),
    task(5, { title: '<img src=x onerror=alert(1)> Synthetic', assignedUserId: 'retired-user', dueAt: 'not a time' }),
  ];
  const page = widget(api({ get: () => json(identity()), post: () => json(queue(items, 7)) }));
  await page.api.mount(page.host, { home: 'today' });
  const [body] = posts(page.calls);
  assert.deepEqual(page.calls.map(call => call.init.method), ['GET', 'POST']);
  assert.match(body.requestId, UUID);
  assert.deepEqual(body.body, { command: 'queue', view: 'overdue', dueBefore: '2026-09-22T18:00:00.000Z', offset: 0, limit: 5 }, 'a manager on the Command center reads the whole team');
  assert.equal(page.calls[1].init.headers['Content-Type'], 'application/json');
  const root = page.host.querySelector('.egc-followups-home');
  assert.equal(root.querySelector('[data-fh-count]').textContent, '7');
  assert.match(text(root), /7 overdue actions/);
  assert.match(text(root), /Everyone on the team · registered actions/);
  const rows = root.querySelectorAll('.fh-item').map(text);
  assert.equal(rows.length, 5);
  assert.deepEqual(rows, [
    'Synthetic follow-up 1Synthetic Owner · Followup messageOverdue by 3 days',
    'Synthetic follow-up 2Synthetic Phone · CallbackOverdue by 26 h',
    'Synthetic follow-up 3Synthetic Phone · Send quoteOverdue by 25 min',
    'Synthetic follow-up 4Unassigned · Prepare quoteOverdue by 5 h',
    '<img src=x onerror=alert(1)> SyntheticOverdue · time needs review'.replace('Overdue', 'retired-user · CallbackOverdue'),
  ]);
  assert.equal(root.querySelectorAll('img').length, 0, 'titles are text, never markup');
  assert.equal(page.host.innerHTML, '', 'the widget never assigns innerHTML');
  assert.match(text(root), /Showing the 5 most overdue of 7\./);
  assert.match(text(root), /Updated 12:00 PM · Denver time/);
  assert.equal(root.querySelector('button').textContent, 'Open follow-ups');
  assert.doesNotMatch(text(root), /unavailable|No registered action/);
});

test('Action Center labels are used when the Action Center is on the page, and Open follow-ups opens its overdue view', async () => {
  const shown = [], went = [];
  const page = widget(api({ get: () => json(identity()), post: () => json(queue([task(1, { kind: 'followup_message' })])) }), {
    EGCActionCenter: { drafts: { labels: { followup_message: 'Follow-up message' } }, show: view => { shown.push(view); return true; } },
  });
  await page.api.mount(page.host, { home: 'today', go: view => went.push(view) });
  assert.match(text(page.host), /Synthetic Phone · Follow-up message/);
  assert.doesNotMatch(text(page.host), /Showing the/, 'no "showing" line when every overdue action is listed');
  page.host.querySelector('button').click();
  assert.deepEqual([shown, went], [['overdue'], ['action_center']]);
  const standalone = widget(api({ get: () => json(identity()), post: () => json(queue([])) }));
  await standalone.api.mount(standalone.host);
  standalone.host.querySelector('button').click();
  assert.equal(standalone.context.assigned, '/employee?view=action_center', 'without the Hub shell it links to the Action Center');
});

test('My day, and anyone who is not an owner or manager, sees only their own overdue actions', async () => {
  for (const [who, home] of [[{ id: 'zacb', role: 'owner', kind: 'human' }, 'my_day'], [{ id: 'tylerg', role: 'sales', kind: 'human' }, 'today'], [{ id: 'tylerg', role: 'sales', kind: 'human' }, undefined]]) {
    const page = widget(api({ get: () => json(identity(who)), post: () => json(queue([task(1)])) }));
    await page.api.mount(page.host, home ? { home } : {});
    assert.equal(posts(page.calls)[0].body.owner, who.id, `${who.role} on ${home}`);
    assert.match(text(page.host), /Assigned to you · registered actions/);
  }
});

test('a 503 shows unavailable with Retry, never an empty or zero state, and Retry loads the list', async () => {
  let fail = true;
  const page = widget(api({ get: () => json(identity()), post: () => fail ? json({ error: 'operations_unavailable', retryable: true, message: 'The outcome may be unknown.' }, 503) : json(queue([task(1)])) }));
  await page.api.mount(page.host, { home: 'today' });
  const alert = page.host.querySelector('[role="alert"]');
  assert.match(text(alert), /Overdue follow-ups are unavailable/);
  assert.match(text(alert), /This is not a count of zero/);
  assert.equal(page.host.querySelector('[data-fh-count]'), null);
  assert.doesNotMatch(text(page.host), /No registered action|overdue actions|\b0\b/);
  fail = false;
  alert.querySelector('button').click();
  await flush();
  assert.equal(page.host.querySelector('[data-fh-count]').textContent, '1');
  assert.equal(page.host.querySelector('[role="alert"]'), null);

  const identityDown = widget(api({ get: () => json({ ok: false, error: 'Synthetic service unavailable' }, 503), post: () => assert.fail('no queue read without a verified identity') }));
  await identityDown.api.mount(identityDown.host);
  assert.match(text(identityDown.host), /Overdue follow-ups are unavailable/);
  const signedOut = widget(api({ get: () => json({ error: 'business_session_required' }, 403), post: () => assert.fail('never') }));
  await signedOut.api.mount(signedOut.host);
  assert.match(text(signedOut.host), /Sign in with a business account/);
  const offline = widget(() => Promise.reject(new TypeError('Failed to fetch')));
  await offline.api.mount(offline.host);
  assert.match(text(offline.host), /could not be checked right now/);
});

test('malformed or incomplete responses are unverified, never shown as a count', async () => {
  const bad = [
    { ok: true, total: 3 },
    { ok: true, items: [task(1)], total: 0 },
    { ok: true, items: [task(1), task(2)], total: 9 },
    { ok: true, items: [1, 2, 3, 4, 5, 6].map(n => task(n)), total: 6 },
    { ok: true, items: [{ id: 'task-1' }], total: 1 },
    { ok: true, items: [task(1)], total: '1' },
    { items: [], total: 0 },
    'not json',
  ];
  for (const body of bad) {
    const page = widget(api({ get: () => json(identity()), post: () => json(body) }));
    await page.api.mount(page.host);
    assert.match(text(page.host), /could not be verified/, JSON.stringify(body));
    assert.equal(page.host.querySelector('[data-fh-count]'), null, JSON.stringify(body));
  }
  for (const who of [{ ok: true, enabled: true, owners: [] }, { ok: true, actor: { id: 'zacb' }, owners: [] }, { ok: true, enabled: true, actor: { id: '' }, owners: [] }]) {
    const page = widget(api({ get: () => json(who), post: () => assert.fail('no queue read without a verified identity') }));
    await page.api.mount(page.host);
    assert.match(text(page.host), /could not be verified/);
  }
});

test('a verified empty queue says so honestly, and a disabled backend is not shown as empty', async () => {
  const empty = widget(api({ get: () => json(identity()), post: () => json(queue([])) }));
  await empty.api.mount(empty.host, { home: 'today' });
  assert.equal(empty.host.querySelector('[data-fh-count]').textContent, '0');
  assert.match(text(empty.host), /0 overdue actions/);
  assert.equal(empty.host.querySelector('.fh-empty').textContent, 'No registered action is overdue.');
  assert.match(text(empty.host), /Commitments nobody recorded as an action are not counted\./);
  const off = widget(api({ get: () => json(identity(undefined, false)), post: () => assert.fail('no queue read while the backend is off') }));
  await off.api.mount(off.host, { home: 'today' });
  assert.match(text(off.host), /Follow-up tracking is not enabled/);
  assert.match(text(off.host), /This is not an empty list\./);
  assert.equal(off.host.querySelector('[data-fh-count]'), null);
});

test('sign-out aborts the in-flight request and a late answer renders nothing', async () => {
  const pending = deferred();
  let signal;
  const page = widget(api({ get: () => json(identity()), post: (body, init) => { signal = init.signal; return pending.promise; } }));
  const mounted = page.api.mount(page.host, { home: 'today' });
  await flush();
  assert.ok(page.host.querySelector('[aria-busy="true"]'), 'a skeleton shows while loading');
  assert.equal(signal.aborted, false);
  page.fire('egc:signout');
  assert.equal(signal.aborted, true);
  assert.equal(page.host.children.length, 0, 'private data is cleared on sign-out');
  pending.resolve(json(queue([task(1)])));
  await mounted;
  await flush();
  assert.equal(page.host.children.length, 0);
  assert.equal(page.host.querySelector('.fh-item'), null);
});

test('a refresh while loading keeps only the newest answer, and a timeout says unavailable', async () => {
  const answers = [deferred(), deferred()];
  let index = 0;
  const page = widget(api({ get: () => json(identity()), post: () => answers[index++].promise }));
  const first = page.api.mount(page.host, { home: 'today' });
  await flush();
  const second = page.api.refresh();
  await flush();
  answers[1].resolve(json(queue([task(2)], 1)));
  await second;
  answers[0].resolve(json(queue([task(1), task(3)], 2)));
  await first;
  await flush();
  assert.equal(page.host.querySelector('[data-fh-count]').textContent, '1', 'the stale first answer never replaces the newer one');
  assert.deepEqual(page.host.querySelectorAll('.fh-item').map(node => node.getAttribute('data-fh-task')), ['task-2']);

  const hung = widget(api({ get: () => json(identity()), post: (body, init) => new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))) }));
  const mounted = hung.api.mount(hung.host);
  await flush();
  const timer = hung.timers.findLast(entry => entry.delay === 20000);
  assert.ok(timer, 'each request has a 20 s timeout');
  timer.callback();
  await mounted;
  assert.match(text(hung.host), /did not answer in time/);
  assert.equal(hung.host.querySelector('[data-fh-count]'), null);
});

test('a body that stalls after the headers arrive times out with Retry instead of a skeleton forever', async () => {
  // Weak phone signal: fetch resolves with headers, then json() only settles when the 20 s timer aborts the request.
  const stalled = init => ({ ok: true, status: 200, json: () => new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))) });
  for (const stall of ['GET', 'POST']) {
    let slow = true;
    const page = widget(api({ get: init => stall === 'GET' && slow ? stalled(init) : json(identity()), post: (body, init) => stall === 'POST' && slow ? stalled(init) : json(queue([task(1)])) }));
    const mounted = page.api.mount(page.host, { home: 'today' });
    await flush();
    assert.ok(page.host.querySelector('[aria-busy="true"]'), `${stall}: the skeleton shows while the body is pending`);
    page.timers.findLast(entry => entry.delay === 20000).callback();
    await mounted;
    await flush();
    const alert = page.host.querySelector('[role="alert"]');
    assert.ok(alert, `${stall}: a stalled body ends in an alert`);
    assert.match(text(alert), /did not answer in time/);
    assert.equal(page.host.querySelector('[aria-busy="true"]'), null, `${stall}: the skeleton is gone`);
    assert.equal(page.host.querySelector('[data-fh-count]'), null);
    slow = false;
    alert.querySelector('button').click();
    await flush();
    assert.equal(page.host.querySelector('[data-fh-count]').textContent, '1', `${stall}: Retry loads the list`);
  }
});

test('a backend that is switched off behind an enabled Hub shows the not-enabled state, not a retryable outage', async () => {
  const page = widget(api({ get: () => json(identity()), post: () => json({ error: 'operations_not_enabled' }, 503) }));
  await page.api.mount(page.host, { home: 'today' });
  assert.deepEqual(page.calls.map(call => call.init.method), ['GET', 'POST']);
  assert.match(text(page.host), /Follow-up tracking is not enabled/);
  assert.match(text(page.host), /This is not an empty list\./);
  assert.equal(page.host.querySelector('[role="alert"]'), null, 'not an error alert');
  assert.equal(page.host.querySelector('button'), null, 'no Retry that can never succeed');
  assert.equal(page.host.querySelector('[data-fh-count]'), null);
  assert.doesNotMatch(text(page.host), /could not be checked right now|overdue actions/);
});

// ---- The home-widget extension point in employee-hub-screens.js, driven through employee-suite.js ----

function shell(options = {}, respond) {
  let operations = 0;
  const fetcher = async (url, init = {}) => {
    if (url === '/api/operations') { operations++; return respond ? respond(url, init) : init.method === 'POST' ? json(queue([task(1), task(2)], 2)) : json(identity()); }
    if (url.startsWith('/api/employee-hub')) return json({ ok: true, collections: { ...collections(), profiles: options.profiles || [] }, accounts: [] });
    return json({ ok: false, error: 'Synthetic service unavailable' }, 503);
  };
  const page = hubPage({ fetcher, ...options });
  page.api.S.peopleState.loaded = true;
  page.api.S.accountState.loaded = true;
  if (options.module !== false) vm.runInContext(source, page.context, { filename: 'employee-followups-home.js' });
  return { page, operations: () => operations };
}
const slot = page => page.main().querySelector('#ops-home-widgets [data-hub-widget="overdue_followups"]');

test('the Command center mounts the overdue widget once into #ops-home-widgets and background renders keep it', async () => {
  const { page, operations } = shell();
  page.api.install();
  await page.flush();
  assert.equal(page.api.S.active, 'today');
  const mounted = slot(page);
  assert.ok(mounted, 'the widget has its own slot in the home node');
  assert.equal(mounted.querySelector('[data-fh-count]').textContent, '2');
  assert.equal(operations(), 2, 'one identity read and one queue read');
  const kit = page.document.head.querySelectorAll('link').map(node => node.getAttribute('href'));
  assert.deepEqual(kit, ['employee-ui-kit.css?v=20260927hubreg'], 'the kit stylesheet loads before a widget mounts');
  page.api.render();
  page.api.render(true);
  page.context.refresh();
  await page.flush();
  assert.equal(slot(page), mounted, 'renders move the same slot into the new home node');
  assert.equal(page.main().querySelectorAll('[data-hub-widget]').length, 1);
  assert.equal(operations(), 2, 'background renders do not refetch');
  await page.context.opsRefresh();
  await page.flush();
  assert.equal(operations(), 4, 'the Hub Refresh button refreshes the widget');
  page.api.go('customers');
  assert.equal(page.main().querySelector('[data-hub-widget]'), null);
  assert.equal(mounted.isConnected, false, 'leaving the home unmounts the widget');
  page.api.go('today');
  await page.flush();
  assert.notEqual(slot(page), mounted, 'returning mounts a fresh widget with current data');
  assert.equal(operations(), 6);
  page.fire('egc:signout');
  assert.equal(page.document.querySelector('[data-hub-widget]'), null);
});

test('My day mounts the widget for business users only, filtered to the signed-in account', async () => {
  const bodies = [];
  const respond = (url, init) => { if (init.method === 'POST') { bodies.push(JSON.parse(init.body).body); return json(queue([task(1)])); } return json(identity({ id: 'alexk', role: 'manager', kind: 'human' })); };
  const { page } = shell({ user: 'AlexK', role: 'manager' }, respond);
  page.api.install();
  page.api.go('my_day');
  await page.flush();
  assert.ok(slot(page));
  assert.equal(bodies.at(-1).owner, 'alexk', 'My day is the viewer’s own list, even for a manager');
  assert.match(slot(page).textContent, /Assigned to you/);

  const ready = { id: 'synthetic.crew', username: 'Synthetic.Crew', displayName: 'Synthetic Crew', role: 'crew', status: 'active', onboardingCompletedAt: '2026-09-01T15:00:00.000Z', onboardingVersion: '2026-09-location-v2' };
  const crew = shell({ user: 'Synthetic.Crew', business: false, role: 'crew', profiles: [ready] });
  crew.page.api.install();
  await crew.page.flush();
  assert.equal(crew.page.api.S.active, 'my_day');
  assert.ok(crew.page.main().querySelector('#ops-home-widgets'), 'the extension point renders for everyone');
  assert.equal(crew.page.main().querySelector('[data-hub-widget]'), null, 'crew never gets a business widget');
  assert.equal(crew.operations(), 0);
  assert.deepEqual([...crew.page.context.EGCHubScreens.homeWidgets('my_day', crew.page.api.hubCapabilities()).map(entry => entry.id)], []);
});

test('a widget whose script is missing shows unavailable with Retry instead of an empty home', async () => {
  const { page } = shell({ module: false });
  page.api.install();
  await page.flush();
  const alert = slot(page).querySelector('[role="alert"]');
  assert.match(alert.textContent, /Overdue follow-ups is unavailable/);
  assert.match(alert.textContent, /This section could not load/);
  vm.runInContext(source, page.context, { filename: 'employee-followups-home.js' });
  alert.querySelector('button').click();
  await page.flush();
  assert.equal(slot(page).querySelector('[data-fh-count]').textContent, '2');
});

test('widget registration refuses ambiguous access, unknown homes, markup and bad modules, and ships the overdue widget', () => {
  const page = hubPage(), registry = page.context.EGCHubScreens;
  assert.deepEqual([...registry.homeWidgets('today', ['crew', 'business']).map(entry => entry.id)], ['overdue_followups']);
  assert.deepEqual([...registry.homeWidgets('today', ['crew'])], []);
  const shipped = registry.homeWidgets('my_day', ['crew', 'business'])[0];
  assert.deepEqual({ ...shipped, homes: [...shipped.homes] }, { id: 'overdue_followups', label: 'Overdue follow-ups', homes: ['today', 'my_day'], capability: 'business', crewVisible: false, module: 'EGCFollowupsHome', load: null });
  assert.ok(Object.isFrozen(shipped));
  const base = { id: 'fixture_widget', label: 'Fixture widget', homes: ['today'], capability: 'owner', module: 'EGCFixtureWidget' };
  for (const spec of [
    { ...base, id: 'overdue_followups' }, { ...base, id: 'Bad-Id' }, { ...base, homes: [] }, { ...base, homes: ['customers'] },
    { ...base, capability: undefined }, { ...base, crewVisible: true }, { ...base, label: '<b>x</b>' }, { ...base, module: 'window.alert' },
    { ...base, load: { js: 'https://example.invalid/x.js', v: '1' } }, null,
  ]) assert.throws(() => registry.registerWidget(spec), /Hub screen registry/, JSON.stringify(spec));
  registry.registerWidget(base);
  assert.deepEqual([...registry.homeWidgets('today', ['crew', 'business']).map(entry => entry.id)], ['overdue_followups']);
  assert.deepEqual([...registry.homeWidgets('today', ['crew', 'business', 'owner']).map(entry => entry.id)], ['overdue_followups', 'fixture_widget']);
  assert.deepEqual([...registry.homeWidgets('my_day', ['crew', 'business', 'owner']).map(entry => entry.id)], ['overdue_followups']);
});

test('mountHome only mounts on a home, keeps order, and remounts when the viewer changes', async () => {
  const page = hubPage({ loadRegistry: true }), registry = page.context.EGCHubScreens, log = [];
  const module = name => ({ mount(host, ctx) { log.push(['mount', name, ctx.home, ctx.widget, ctx.identity]); host.append(page.document.createElement('p')); }, unmount() { log.push(['unmount', name]); } });
  page.context.EGCFixtureA = module('a');
  page.context.EGCFixtureB = module('b');
  registry.registerWidget({ id: 'fixture_b', label: 'Fixture B', homes: ['today'], capability: 'business', module: 'EGCFixtureB' });
  registry.registerWidget({ id: 'fixture_a', label: 'Fixture A', homes: ['today', 'my_day'], crewVisible: true, module: 'EGCFixtureA' });
  const host = page.document.createElement('div'), ctx = who => ({ identity: who, role: 'manager', capabilities: ['crew', 'business'] });
  page.document.body.append(host);
  assert.deepEqual([...registry.mountHome('customers', host, ctx('alexk'))], []);
  assert.deepEqual([...registry.mountHome('today', null, ctx('alexk'))], []);
  assert.deepEqual([...registry.mountHome('today', host, ctx('alexk'))], ['overdue_followups', 'fixture_b', 'fixture_a']);
  await page.flush();
  assert.deepEqual(host.children.map(node => node.getAttribute('data-hub-widget')), ['overdue_followups', 'fixture_b', 'fixture_a']);
  assert.deepEqual(log, [['mount', 'b', 'today', 'fixture_b', 'alexk'], ['mount', 'a', 'today', 'fixture_a', 'alexk']]);
  const next = page.document.createElement('div');
  registry.mountHome('today', next, ctx('alexk'));
  assert.deepEqual(next.children.map(node => node.getAttribute('data-hub-widget')), ['overdue_followups', 'fixture_b', 'fixture_a']);
  assert.equal(host.children.length, 0);
  assert.equal(log.length, 2, 'moving to a new node does not remount');
  registry.mountHome('today', next, ctx('tylerg'));
  await page.flush();
  assert.deepEqual(log.slice(2), [['unmount', 'b'], ['unmount', 'a'], ['mount', 'b', 'today', 'fixture_b', 'tylerg'], ['mount', 'a', 'today', 'fixture_a', 'tylerg']]);
  registry.mountHome('my_day', next, ctx('tylerg'));
  await page.flush();
  assert.deepEqual(log.slice(6), [['unmount', 'b'], ['unmount', 'a'], ['mount', 'a', 'my_day', 'fixture_a', 'tylerg']]);
  registry.unmountHome();
  assert.equal(next.children.length, 0);
  assert.deepEqual(log.at(-1), ['unmount', 'a']);
});

test('Open follow-ups lands on the real Action Center overdue view, and unknown views are refused', async () => {
  const document = createDocument(), requests = [];
  const context = {
    console, URL, Intl, Promise, Map, Set, Error, JSON, Object, Array, Math, Number, String, AbortController, crypto, queueMicrotask, Date: FixedDate, Node: document.Node, document,
    setTimeout: () => 0, clearTimeout() {}, addEventListener() {},
    fetch: async (url, init = {}) => { requests.push(init.body ? JSON.parse(init.body).body : { method: 'GET' }); return json(init.method === 'POST' ? queue([task(1)]) : identity()); },
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(readFileSync(new URL('../employee-operations.js', import.meta.url), 'utf8'), context, { filename: 'employee-operations.js' });
  const center = context.EGCActionCenter;
  assert.equal(center.show('sent'), false);
  assert.equal(center.show('calendar'), false, 'only queue views can be opened from a home widget');
  assert.equal(center.show('overdue'), true);
  const host = document.createElement('main');
  document.body.append(host);
  await center.mount(host);
  await flush();
  assert.equal(host.querySelector('[data-ac-view="overdue"]').getAttribute('aria-selected'), 'true');
  assert.equal(host.querySelector('[data-ac-view="due"]').getAttribute('aria-selected'), 'false');
  assert.ok(requests.some(body => body.command === 'queue' && body.view === 'overdue' && body.limit === 50), JSON.stringify(requests));
  assert.equal(center.show('approvals'), true, 'while mounted it switches the view in place');
  await flush();
  assert.equal(host.querySelector('[data-ac-view="approvals"]').getAttribute('aria-selected'), 'true');
  center.unmount();
});
