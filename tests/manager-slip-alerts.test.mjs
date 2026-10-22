// MANAGER-SLIP-ALERTS: the owner and managers get one Hub browser alert per job, per slip, per Denver day when today's
// crew is late, not en route or not clocked in. Every instant is fixed (hub-dom.mjs FixedDate is 2026-09-22 12:00 in
// Denver); nothing reads the real clock, and nothing here reaches a customer, HighLevel or the network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from './helpers/vm-realm.mjs';
import { storage, FixedDate, NOW } from './helpers/hub-dom.mjs';
import { staffSessions } from './helpers/auth-roles-harness.mjs';
import { flags, visitRow } from '../functions/_lib/arrival-deadline.js';
import { managerSlipAlertsEnabled, slipAlertsFor } from '../functions/_lib/manager-slip-alerts.js';
import { LAUNCH_DEFAULTS } from '../functions/_lib/launch-defaults.js';
import { onRequestGet } from '../functions/api/employee-hub.js';
import '../employee-arrival-deadline.js';
import '../employee-slip-alerts.js';

const source = name => readFileSync(new URL('../' + name, import.meta.url), 'utf8');
const { pending, check, focusRow, KEY, LIMIT } = globalThis.EGCSlipAlerts;
const rule = globalThis.EGCArrivalDeadline;
const TODAY = '2026-09-22', TOMORROW_NOON = NOW + 86400000;
const job = (id, fields = {}) => ({ id, type: 'job', date: TODAY, time: '10:00', endTime: '12:00', status: 'scheduled', customer: `Synthetic ${id}`, assignedCrew: ['crew-a'], ...fields });
const entries = [{ employee: 'crew-a', clockInAt: '2026-09-22T14:00:00Z', status: 'active' }];
// The visits the Hub hands over (employee-suite.js flaggedToday): each visit with its flags.
const flagged = (jobs, now = NOW, timeEntries = entries) => jobs.map(row => visitRow(row)).map(visit => ({ visit, flags: flags(visit, { now, crew: visit.assignedCrew, timeEntries }) })).filter(row => row.flags.length);
const memory = () => { const values = new Map(); return { values, getItem: key => values.has(key) ? values.get(key) : null, setItem: (key, value) => values.set(key, String(value)) }; };

test('the switch is exactly "true", off by default, and not a launch default', () => {
  for (const value of [undefined, '', 'false', 'TRUE', 'True', ' true', 'true ', '1', 'yes', true]) assert.equal(managerSlipAlertsEnabled({ EGC_MANAGER_SLIP_ALERTS: value }), false, String(value));
  assert.equal(managerSlipAlertsEnabled({}), false);
  assert.equal(managerSlipAlertsEnabled({ EGC_MANAGER_SLIP_ALERTS: 'true' }), true);
  assert.equal('EGC_MANAGER_SLIP_ALERTS' in LAUNCH_DEFAULTS, false, 'the owner turns it on in Cloudflare; the middleware never fills it in');
  assert.match(source('.env.example'), /\nEGC_MANAGER_SLIP_ALERTS=\n/);
  const owner = { user: 'ZacB', businessAccess: true, role: 'owner' };
  assert.equal(slipAlertsFor(owner, {}), false, 'switched off, nobody gets them, the owner included');
  assert.equal(slipAlertsFor(owner, { EGC_MANAGER_SLIP_ALERTS: 'true' }), true);
  assert.equal(slipAlertsFor({ user: 'Crew.One', businessAccess: false, role: 'crew' }, { EGC_MANAGER_SLIP_ALERTS: 'true' }), false);
});

test('GET /api/employee-hub tells the owner and managers, never crew, sales or phone, and says nothing while it is off', async t => {
  const { env: base, cookies } = await staffSessions(t), on = { ...base, EGC_STAFF_ROLE_ACCESS: 'true', EGC_MANAGER_SLIP_ALERTS: 'true' };
  const read = async (user, env = on) => {
    const response = await onRequestGet({ env, request: new Request('https://easygaragecleaning.com/api/employee-hub', { headers: { Cookie: cookies[user] } }) });
    const body = await response.json();
    assert.equal(response.status, 200, `${user}: ${JSON.stringify(body).slice(0, 200)}`);
    return body.slipAlerts;
  };
  for (const user of ['ZacB', 'TylerG', 'Config.Manager', 'Mgr.Account']) assert.equal(await read(user), true, user);
  for (const user of ['Crew.Static', 'Sales.Account', 'Phone.Account', 'Config.Phone', 'Lead.Account', 'Crew.Account']) assert.equal(await read(user), false, user);
  const off = { ...on }; delete off.EGC_MANAGER_SLIP_ALERTS;
  for (const user of ['ZacB', 'Mgr.Account']) assert.equal(await read(user, off), false, `${user} with the switch unset`);
});

test('one alert per job, per slip kind, per Denver day; a new kind alerts once; the next day starts again', () => {
  const store = memory(), shown = [], show = (title, options) => shown.push({ title, ...options });
  const jobs = [job('late', { assignedCrew: ['crew-a', 'crew-b'] }), job('soon', { time: '12:20', endTime: '14:00' })];
  const first = check({ visits: flagged(jobs), now: NOW, storage: store, show });
  assert.deepEqual(first.map(row => row.key), [`${TODAY}|late|late`, `${TODAY}|late|not_clocked_in`, `${TODAY}|soon|not_en_route`]);
  assert.deepEqual(shown.map(row => row.tag), first.map(row => 'egc-slip-' + row.key));
  assert.deepEqual(shown[0].data, { view: 'today', job: 'late' }, 'the alert names the job its tap opens');
  // Every later refresh that day finds the same flags and shows nothing again.
  for (const minutes of [1, 15]) assert.deepEqual(check({ visits: flagged(jobs, NOW + minutes * 60000), now: NOW + minutes * 60000, storage: store, show }), [], `${minutes} min later`);
  assert.equal(shown.length, 3);
  // A slip of a new kind on a job already alerted is its own alert: soon is late by 12:35.
  const later = NOW + 40 * 60000;
  assert.deepEqual(check({ visits: flagged(jobs, later), now: later, storage: store, show }).map(row => row.key), [`${TODAY}|soon|late`]);
  // A split job's two visits today are one job: one alert per kind.
  const split = job('split', { time: '09:00', assignmentSegments: [{ id: 's1', date: TODAY, time: '09:00', endTime: '10:00', assignedCrew: ['crew-a'] }, { id: 's2', date: TODAY, time: '10:30', endTime: '11:30', assignedCrew: ['crew-a'] }] });
  const visits = split.assignmentSegments.map(segment => visitRow(split, segment)).map(visit => ({ visit, flags: flags(visit, { now: NOW, crew: visit.assignedCrew, timeEntries: entries }) }));
  assert.deepEqual(pending({ visits, now: NOW, seen: [] }).map(row => row.key), [`${TODAY}|split|late`]);
  // The saved keys keep only today's: tomorrow the same job alerts again.
  const tomorrow = [job('late', { date: '2026-09-23', assignedCrew: ['crew-a'] })];
  assert.deepEqual(check({ visits: flagged(tomorrow, TOMORROW_NOON, []), now: TOMORROW_NOON, storage: store, show }).map(row => row.key), ['2026-09-23|late|late', '2026-09-23|late|not_clocked_in']);
  assert.deepEqual(JSON.parse(store.values.get(KEY)), ['2026-09-23|late|late', '2026-09-23|late|not_clocked_in'], 'yesterday\'s keys are dropped');
});

test('no alert once the crew is en route or on site, whatever is still flagged', () => {
  const now = NOW + 30 * 60000;
  const jobs = [
    job('en-route-late', { dispatchedAt: '2026-09-22T15:40:00Z', assignedCrew: ['crew-a', 'crew-b'] }), // late and crew-b not clocked in, but on the way
    job('on-site', { arrivedAt: '2026-09-22T16:05:00Z', assignedCrew: ['crew-b'] }), // on site; crew-b never clocked in
    job('tapped', { time: '12:45', endTime: '14:00', fieldExecution: { activity: 'dispatched', activityAt: '2026-09-22T18:20:00Z' } }),
    job('yesterday-arrival', { arrivedAt: '2026-09-21T16:05:00Z' }), // an earlier day's arrival says nothing about today
  ];
  const visits = flagged(jobs, now);
  assert.ok(visits.find(row => row.visit.id === 'en-route-late').flags.some(flag => flag.kind === 'late'), 'the Field agenda still shows the late chip');
  assert.ok(visits.find(row => row.visit.id === 'on-site').flags.some(flag => flag.kind === 'not_clocked_in'));
  assert.deepEqual(pending({ visits, now, seen: [] }).map(row => row.key), [`${TODAY}|yesterday-arrival|late`]);
  assert.equal(rule.underway(job('x', { dispatchedAt: '2026-09-22T15:40:00Z' }), { now }), true);
  assert.equal(rule.underway(job('x', { date: '2026-09-23', dispatchedAt: '2026-09-22T15:40:00Z' }), { now }), false, 'only today\'s visit');
});

// Review of #236 — finding 1: End day leaves a job worked on day 1 in_progress, and day 2's visit inherits that status;
// only day 2's own evidence (a tap, an arrival or a dispatch today) may stop its alerts.
const twoDay = (fields = {}) => job('two-day', { date: '2026-09-21', endDate: TODAY, time: '08:00', endTime: '16:00', status: 'in_progress', pipelineStatus: 'in_progress',
  arrivedAt: '2026-09-21T14:05:00Z', startedAt: '2026-09-21T14:10:00Z', assignedCrew: ['crew-b'],
  assignmentSegments: [{ id: 'day-1', date: '2026-09-21', time: '08:00', endTime: '16:00', assignedCrew: ['crew-b'] }, { id: 'day-2', date: TODAY, time: '08:00', endTime: '16:00', assignedCrew: ['crew-b'] }], ...fields });
const dayTwo = row => { const visit = visitRow(row, row.assignmentSegments[1]); return [{ visit, flags: flags(visit, { now: NOW, crew: visit.assignedCrew, timeEntries: entries }) }]; };

test('day 2 of a multi-day job worked on day 1 alerts when nobody has arrived or clocked in today', () => {
  const visits = dayTwo(twoDay());
  assert.deepEqual(visits[0].flags.map(flag => flag.kind), ['late', 'not_clocked_in'], 'the Field agenda flags day 2');
  assert.equal(visits[0].visit.firstVisit, false);
  assert.equal(rule.underway(visits[0].visit, { now: NOW }), false, 'day 1\'s in_progress status says nothing about day 2');
  assert.deepEqual(pending({ visits, now: NOW, seen: [] }).map(row => [row.kind, row.title]), [['late', 'Crew late: Synthetic two-day'], ['not_clocked_in', 'Not clocked in: Synthetic two-day']]);
  // Today's own evidence still stops them: a Working tap today, or today's arrival.
  for (const today of [{ fieldExecution: { activity: 'in_progress', activityAt: '2026-09-22T14:20:00Z' } }, { arrivedAt: '2026-09-22T14:05:00Z' }, { dispatchedAt: '2026-09-22T13:40:00Z' }]) {
    const visit = visitRow(twoDay(today), twoDay(today).assignmentSegments[1]);
    assert.equal(rule.underway(visit, { now: NOW }), true, JSON.stringify(today));
    assert.deepEqual(pending({ visits: [{ visit, flags: flags(visit, { now: NOW, crew: visit.assignedCrew, timeEntries: entries }) }], now: NOW, seen: [] }), [], JSON.stringify(today));
  }
});

test('Not clocked in waits for fresh time entries; a burst is capped and the rest come next time; the text has no money', () => {
  const jobs = Array.from({ length: 7 }, (_, i) => job(`job-${i}`, { time: '10:00', customer: `Synthetic Customer ${i}`, priceQuoted: 125000, total: 99900, assignedCrew: ['crew-b'] }));
  const stale = pending({ visits: flagged(jobs), now: NOW, seen: [], clockInsFresh: false });
  assert.equal(stale.some(row => row.kind === 'not_clocked_in'), false, 'a hidden tab\'s old time entries never say nobody clocked in');
  assert.equal(stale.length, 7);
  const store = memory(), shown = [];
  const first = check({ visits: flagged(jobs), now: NOW, storage: store, show: (title, options) => shown.push({ title, ...options }) });
  assert.equal(first.length, LIMIT);
  const second = check({ visits: flagged(jobs), now: NOW + 60000, storage: store, show: (title, options) => shown.push({ title, ...options }) });
  assert.equal(first.length + second.length, LIMIT * 2, 'nothing is dropped: each check shows the next ones');
  assert.equal(new Set(shown.map(row => row.tag)).size, shown.length);
  for (const row of shown) {
    assert.doesNotMatch(`${row.title} ${row.body}`, /\$|\d{3,},|1250|999/, row.title);
    assert.ok(row.body.length <= 200);
  }
  assert.equal(shown[0].title, 'Crew late: Synthetic Customer 0');
  assert.equal(shown[0].body, 'Due by 10:15 AM and not arrived. Tap to open the Field agenda.');
  assert.equal(shown[1].title, 'Not clocked in: Synthetic Customer 0');
  assert.equal(shown[1].body, 'crew-b not clocked in for the 10:00 AM start. Tap to open the Field agenda.');
  const soon = pending({ visits: flagged([job('soon', { time: '12:20', endTime: '14:00' })]), now: NOW, seen: [] });
  assert.deepEqual([soon[0].title, soon[0].body], ['Not en route: Synthetic soon', 'Starts 12:20 PM and the crew has not left. Tap to open the Field agenda.']);
});

test('a delivery that throws is caught, and its key is still saved so it is not retried every refresh', () => {
  const store = memory();
  const shown = check({ visits: flagged([job('late')]), now: NOW, storage: store, show: () => { throw new TypeError('Illegal constructor'); } });
  assert.equal(shown.length, 1);
  assert.deepEqual(JSON.parse(store.values.get(KEY)), [`${TODAY}|late|late`]);
  assert.deepEqual(check({ visits: flagged([job('late')]), now: NOW, storage: { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } }, show() {} }).length, 1, 'blocked storage never throws');
});

test('the page alert opens the job on tap; where the constructor throws it goes through the service worker', async () => {
  const realm = (Notification, registration) => {
    const context = { Intl, Date, Promise, JSON, Set, Map, Number, String, Array, Object, navigator: { serviceWorker: { getRegistration: async () => registration } }, Notification, focus() { context.focused = true; } };
    context.window = context; vm.createContext(context);
    vm.runInContext(source('employee-slip-alerts.js'), context);
    return context;
  };
  const made = [];
  class PageAlert { constructor(title, options) { this.title = title; this.options = options; made.push(this); } close() { this.closed = true; } }
  const page = realm(PageAlert, null), opened = [];
  page.EGCSlipAlerts.deliver('Crew late: Synthetic', { tag: 't', data: { view: 'today', job: 'late' } }, () => opened.push('late'));
  made[0].onclick();
  assert.deepEqual([made[0].title, made[0].closed, page.focused, opened], ['Crew late: Synthetic', true, true, ['late']]);
  const worker = [];
  class AndroidAlert { constructor() { throw new TypeError("Failed to construct 'Notification': Illegal constructor."); } }
  const android = realm(AndroidAlert, { showNotification: async (title, options) => worker.push({ title, data: options.data }) });
  android.EGCSlipAlerts.deliver('Crew late: Synthetic', { tag: 't', data: { view: 'today', job: 'late' } }, () => {});
  for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
  assert.deepEqual(JSON.parse(JSON.stringify(worker)), [{ title: 'Crew late: Synthetic', data: { view: 'today', job: 'late' } }]);
  // Neither a missing worker nor a missing Notification throws.
  realm(AndroidAlert, null).EGCSlipAlerts.deliver('x', {}, () => {});
  realm(undefined, null).EGCSlipAlerts.deliver('x', {}, () => {});
});

test('focusRow highlights and scrolls to the job\'s Field agenda row, retrying while the screen renders', () => {
  const node = (attrs = {}) => { const classes = new Set(); return { attrs, classList: { add: name => classes.add(name), remove: name => classes.delete(name), has: name => classes.has(name) }, getAttribute: name => attrs[name] ?? null, scrollIntoView() { this.scrolled = true; }, querySelector: () => null, focus() { this.focused = true; } }; };
  const card = node(), cell = { ...node({ 'data-agenda-job': 'late' }), closest: () => card }, other = { ...node({ 'data-agenda-job': 'other' }), closest: () => node() };
  let rows = [], waits = 0;
  const doc = { querySelectorAll: selector => selector === '[data-agenda-job]' ? rows : [] };
  assert.equal(focusRow('late', { doc, wait: fn => { waits += 1; rows = [other, cell]; fn(); } }), false, 'not rendered yet: it waits');
  assert.equal(waits, 1);
  assert.equal(card.classList.has('ops-agenda-focus'), true);
  assert.equal(card.scrolled, true);
  assert.equal(focusRow('', { doc }), false);
});

// The Hub wiring (employee-suite.js): switch off → nothing; on → one alert per slip; a tap opens Today on the row.
function hub({ slipAlerts = true, alerts = 'on', role = 'owner', business = true } = {}) {
  const local = storage(alerts ? { egc_browser_alerts: alerts } : {}), made = [];
  class PageAlert { static permission = 'granted'; constructor(title, options) { this.title = title; this.options = options; made.push(this); } close() {} }
  const context = { Date: FixedDate, Intl, URLSearchParams, console, Notification: PageAlert,
    sessionStorage: storage({ egc_u: role === 'owner' ? 'ZacB' : 'Crew.One', ...(business ? { egc_business_access: 'true', egc_owner: 'true' } : {}), egc_role: role }),
    localStorage: local, navigator: { serviceWorker: { addEventListener(type, fn) { if (type === 'message') context.workerMessage = fn; } } }, location: { search: '' }, jobsCache: [], timers: [],
    managerScheduleState: { loaded: true, loading: false, error: '', fromCache: false, pending: false }, setTimeout: () => 1, clearTimeout() {}, setInterval(fn, ms) { context.timers.push({ fn, ms }); return context.timers.length; }, clearInterval() {}, addEventListener() {}, focus() {},
    document: { readyState: 'loading', hidden: false, querySelector: () => null, querySelectorAll: () => [], addEventListener() {} } };
  context.window = context; vm.createContext(context);
  vm.runInContext(source('employee-arrival-deadline.js'), context);
  vm.runInContext(source('employee-slip-alerts.js'), context);
  vm.runInContext(source('employee-suite.js').replace(/\}\)\(\);\s*$/, 'globalThis.api={notifySlips,agenda,S};})();'), context);
  const S = context.api.S;
  Object.assign(S.peopleState, { loaded: true, error: '' });
  S.people.timeEntries = entries; S.peopleLastFullRefreshAt = NOW; S.slipAlerts = slipAlerts;
  context.jobsCache = [job('late', { assignedCrew: ['crew-a'] })];
  return { context, made, local, S };
}

test('the Hub shows nothing with the switch off, alerts browser-alert users with it on, and a tap opens that row', () => {
  const off = hub({ slipAlerts: false });
  off.context.api.notifySlips();
  assert.equal(off.made.length, 0, 'switch off (the server said no): no alert, no timer');
  assert.equal(off.context.timers.length, 0);
  assert.equal(off.local.getItem(KEY), null);
  const noOptIn = hub({ alerts: '' });
  noOptIn.context.api.notifySlips();
  assert.equal(noOptIn.made.length, 0, 'only after the person turned on browser alerts on My day');
  const crew = hub({ role: 'crew', business: false });
  crew.context.api.notifySlips();
  assert.equal(crew.made.length, 0, 'crew never get one, even if a flag said so');
  const on = hub();
  on.context.api.notifySlips();
  on.context.api.notifySlips();
  assert.deepEqual(on.made.map(row => row.title), ['Crew late: Synthetic late'], 'once, however often the Hub refreshes');
  assert.deepEqual(on.context.timers.map(row => row.ms), [60000], 'one hidden-tab check a minute');
  assert.match(on.context.api.agenda(), /<div data-agenda-job="late">/, 'the agenda row carries the job its alert opens');
  on.made[0].onclick();
  assert.equal(on.S.active, 'today');
});

test('an open installed Hub told a job by its service worker opens that row; anything else is ignored', () => {
  const p = hub();
  p.S.active = 'my_day';
  for (const data of [{ type: 'egc-alert-open', view: 'today', job: 'late&view=finance' }, { type: 'egc-alert-open', view: 'finance', job: 'late' }, { type: 'other', view: 'today', job: 'late' }, null]) {
    p.context.workerMessage({ data });
    assert.equal(p.S.active, 'my_day', JSON.stringify(data));
  }
  p.context.workerMessage({ data: { type: 'egc-alert-open', view: 'today', job: 'late' } });
  assert.equal(p.S.active, 'today');
  assert.match(p.context.api.agenda(), /<article class="ops-agenda-focus">/, 'that job\'s row is outlined');
  const crew = hub({ role: 'crew', business: false });
  crew.S.active = 'my_day';
  crew.context.workerMessage({ data: { type: 'egc-alert-open', view: 'today', job: 'late' } });
  assert.equal(crew.S.active, 'my_day', 'a crew session never opens Today from it');
});

test('the Hub alerts day 2 of a multi-day job worked on day 1 (review of #236, finding 1)', () => {
  const p = hub();
  p.context.jobsCache = [twoDay()];
  assert.match(p.context.api.agenda(), /Late · due 8:15 AM/, 'the Field agenda shows the slip');
  p.context.api.notifySlips();
  assert.deepEqual(p.made.map(row => row.title), ['Crew late: Synthetic two-day', 'Not clocked in: Synthetic two-day']);
});

test('Not clocked in names each person by their display name, falls back to the username, and a rename never alerts again', () => {
  const p = hub();
  p.context.jobsCache = [job('late', { assignedCrew: ['crew-b', 'crew-c'] })];
  p.S.people.profiles = [{ id: 'crew-b', username: 'crew-b', displayName: 'Synthetic Crew Bee', status: 'active' }];
  assert.match(p.context.api.agenda(), /<li class="amber">Not clocked in: Synthetic Crew Bee, crew-c<\/li>/, 'the chip: display name, and the username where there is no profile');
  p.context.api.notifySlips();
  assert.deepEqual(p.made.map(row => [row.title, row.options.body]), [['Crew late: Synthetic late', 'Due by 10:15 AM and not arrived. Tap to open the Field agenda.'],
    ['Not clocked in: Synthetic late', 'Synthetic Crew Bee, crew-c not clocked in for the 10:00 AM start. Tap to open the Field agenda.']]);
  assert.deepEqual(JSON.parse(p.local.getItem(KEY)), [`${TODAY}|late|late`, `${TODAY}|late|not_clocked_in`], 'the keys name the job and kind, never a person');
  p.S.people.profiles = [{ id: 'crew-b', username: 'crew-b', displayName: 'Synthetic Crew Bee Renamed', preferredName: 'Bee', status: 'active' }];
  p.context.api.notifySlips();
  assert.equal(p.made.length, 2, 'renaming someone the same day sends nothing new');
  assert.match(p.context.api.agenda(), /Not clocked in: Bee, crew-c/, 'a preferred name wins, as in chat');
});

test('a hidden tab re-checks once a minute and skips Not clocked in from old time entries', () => {
  const p = hub();
  p.context.jobsCache = [job('late', { assignedCrew: ['crew-b'] })];
  p.S.peopleLastFullRefreshAt = NOW - 10 * 60000;
  p.context.api.notifySlips();
  assert.deepEqual(p.made.map(row => row.title), ['Crew late: Synthetic late'], 'the time entries are 10 minutes old: no Not clocked in');
  p.S.peopleLastFullRefreshAt = NOW;
  p.context.document.hidden = false;
  p.context.timers[0].fn();
  assert.equal(p.made.length, 1, 'the minute timer only runs while the tab is hidden; a visible tab is covered by the refresh');
  p.context.document.hidden = true;
  p.context.timers[0].fn();
  assert.deepEqual(p.made.map(row => row.title), ['Crew late: Synthetic late', 'Not clocked in: Synthetic late']);
});

test('the Hub loads the slip-alert file, and no switch or customer path is touched', () => {
  assert.match(source('employee.html'), /<script src="employee-slip-alerts\.js\?v=[^"]+"><\/script>/);
  const file = source('employee-slip-alerts.js');
  for (const forbidden of [/fetch\(/, /hubFetch/, /\/api\//, /ghl|highlevel/i, /sms|email/i]) assert.doesNotMatch(file.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ''), forbidden, String(forbidden));
});
