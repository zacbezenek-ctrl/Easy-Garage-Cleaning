import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from './helpers/vm-realm.mjs';
import { createDocument } from './helpers/hub-dom.mjs';

// D2D-BOARD (owner 2026-10-17): the Hub schedule board in employee-dispatch-calendar.js. Crews by priority (Crew 1,
// Crew 2, then the weekend crew), then one row per estimator with their walkthroughs and open walkthrough time, then
// the door-to-door day. Synthetic people and customers only; the clock is fixed on Monday 2026-10-19 in Denver.
const NOW = '2026-10-19T16:00:00.000Z', MONDAY = '2026-10-19', SATURDAY = '2026-10-24';
const source = name => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');
function realm(document = createDocument(), extra = {}) {
  const Fixed = class extends Date { constructor(...args) { super(...(args.length ? args : [NOW])); } static now() { return Date.parse(NOW); } };
  const window = { addEventListener() {} };
  const context = vm.createContext({ window, document, Node: document.createElement('div').constructor, Date: Fixed, Intl, console, URLSearchParams, AbortController, setTimeout, clearTimeout, ...extra });
  return { window, context, run: name => vm.runInContext(source(name), context, { filename: name }) };
}
const plain = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
function calendar() { const { window, run } = realm(); run('employee-dispatch-calendar.js'); return Object.fromEntries(Object.entries(window.EGCDispatchCalendar).map(([name, value]) => [name, typeof value === 'function' ? (...args) => plain(value(...args)) : value])); }
const cal = calendar();

const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri'];
const roster = [
  { id: 'ana.crew', name: 'Ana Crew', role: 'crew' }, { id: 'ben.crew', name: 'Ben Crew', role: 'crew' }, { id: 'cy.crew', name: 'Cy Crew', role: 'crew' },
  { id: 'dee.est', name: 'Dee Estimator', role: 'crew', skills: [{ id: 'walkthrough_estimating', level: 'lead' }] },
  { id: 'eve.sales', name: 'Eve Sales', role: 'sales' },
  { id: 'fay.multi', name: 'Fay Multi', role: 'crew_lead', staffRoles: ['crew_lead', 'sales'] },
  { id: 'gus.phone', name: 'Gus Phone', role: 'phone', staffRoles: ['phone'] },
  { id: 'hal.owner', name: 'Hal Owner', role: 'owner', fieldWork: false },
];
const crews = [
  { id: 'three', name: 'Crew 3', code: 'crew-3', priority: 3, serviceDays: ['sat', 'sun'], memberIds: ['cy.crew'], leadId: 'cy.crew', status: 'active' },
  { id: 'two', name: 'Crew 2', code: 'crew-2', priority: 2, serviceDays: WEEKDAYS, memberIds: ['ben.crew'], leadId: 'ben.crew', status: 'active' },
  { id: 'one', name: 'Crew 1', code: 'crew-1', priority: 1, serviceDays: WEEKDAYS, memberIds: ['ana.crew', 'fay.multi'], leadId: 'fay.multi', status: 'active' },
  { id: 'old', name: 'Old crew', memberIds: ['ben.crew'], leadId: null, status: 'inactive' },
];
const job = (id, changes = {}) => ({ id, revision: `${id}-r1`, type: 'job', customer: `Synthetic ${id}`, address: '1 Synthetic Way', date: MONDAY, time: '09:30', endDate: MONDAY, endTime: '12:00', status: 'scheduled', assignedCrew: [], crewLead: null, crewId: null, travelBufferMinutes: 0, ...changes });
const walk = (id, who, time, endTime, changes = {}) => job(id, { type: 'walkthrough', assignedCrew: [who], crewLead: who, time, endTime, ...changes });
const data = (changes = {}) => ({ roster, crews, availability: [], warnings: [], dispatchRules: { workdayStart: '09:00', workdayEnd: '17:00' }, ...changes });
const lane = (model, id) => model.lanes.find(entry => entry.id === id);
const keys = entry => entry.items.map(item => item.key);

test('the board runs Crew 1, Crew 2, the weekend crew, individual work, then each estimator by name', () => {
  const jobs = [job('c1', { crewId: 'one', assignedCrew: ['ana.crew', 'fay.multi'], crewLead: 'fay.multi' }), job('c2', { crewId: 'two', assignedCrew: ['ben.crew'], time: '13:00', endTime: '15:00' }),
    job('open'), job('solo', { assignedCrew: ['cy.crew'], time: '15:00', endTime: '16:00' }), job('retired', { crewId: 'old', assignedCrew: ['ben.crew'], time: '16:00', endTime: '17:00' }),
    walk('w-dee', 'dee.est', '10:00', '11:00'), walk('w-eve', 'eve.sales', '13:00', '14:00'), walk('w-ana', 'ana.crew', '16:00', '17:00')];
  const model = cal.laneModel(data(), jobs, MONDAY, { mode: 'board' });
  assert.deepEqual(model.lanes.map(entry => [entry.id, entry.label, entry.group || '']), [
    ['unassigned', 'Unassigned', ''],
    ['crew:one', 'Crew 1', 'crews'], ['crew:two', 'Crew 2', 'crews'], ['crew:three', 'Crew 3 · Weekend', 'crews'], ['individual', 'Individual assignments', 'crews'], ['crew:old', 'Old crew · inactive', 'crews'],
    ['estimator:ana.crew', 'Ana Crew', 'estimators'], ['estimator:dee.est', 'Dee Estimator', 'estimators'], ['estimator:eve.sales', 'Eve Sales', 'estimators'], ['estimator:fay.multi', 'Fay Multi', 'estimators']]);
  assert.deepEqual(keys(lane(model, 'unassigned')), ['open']);
  assert.deepEqual([keys(lane(model, 'crew:one')), keys(lane(model, 'crew:two')), keys(lane(model, 'crew:three')), keys(lane(model, 'individual'))], [['c1'], ['c2'], [], ['solo']]);
  assert.deepEqual([keys(lane(model, 'estimator:dee.est')), keys(lane(model, 'estimator:eve.sales')), keys(lane(model, 'estimator:fay.multi'))], [['w-dee'], ['w-eve'], []], 'walkthroughs go to their estimator; the Sales role (primary or stored) marks an estimator');
  assert.deepEqual(keys(lane(model, 'estimator:ana.crew')), ['w-ana'], 'a walkthrough held by someone not marked an estimator still shows, on a row for them');
  assert.equal(model.lanes.some(entry => entry.id.endsWith('gus.phone') || entry.id.endsWith('hal.owner')), false, 'Phone and office-only owners are not estimators');
  assert.equal(model.lanes.some(entry => entry.kind === 'employee' && !entry.estimator), false, 'the board has no plain employee rows');
  // Drops: active crews and roster estimators take work; an inactive crew does not.
  assert.deepEqual(['crew:one', 'crew:three', 'crew:old', 'estimator:dee.est'].map(id => Boolean(lane(model, id).drop)), [true, true, false, true]);
});

test('a crew that does not work the day says so: Crew 3 on Monday, Crews 1 and 2 on Saturday', () => {
  const monday = cal.laneModel(data(), [], MONDAY, { mode: 'board' }), saturday = cal.laneModel(data(), [], SATURDAY, { mode: 'board' });
  assert.deepEqual(['crew:one', 'crew:two', 'crew:three'].map(id => lane(monday, id).offDay), [false, false, true]);
  assert.deepEqual(['crew:one', 'crew:two', 'crew:three'].map(id => lane(saturday, id).offDay), [true, true, false]);
  assert.deepEqual(lane(monday, 'crew:three').shades.map(shade => [shade.kind, shade.start, shade.end, shade.label]), [['offday', 0, 1440, 'Not working today · works Sat, Sun']]);
  assert.equal(cal.boardStatus(lane(monday, 'crew:three')), 'Off today · works Sat, Sun');
  assert.equal(cal.boardStatus(lane(saturday, 'crew:one')), 'Off today · works Mon–Fri');
  assert.equal(cal.boardStatus(lane(monday, 'crew:one')), 'No work');
  const booked = cal.laneModel(data(), [job('sat-job', { date: SATURDAY, endDate: SATURDAY, crewId: 'one', assignedCrew: ['ana.crew'] })], SATURDAY, { mode: 'board' });
  assert.equal(cal.boardStatus(lane(booked, 'crew:one')), '1 job · 2.5 hr · not a work day', 'a hand-assigned job on a crew\'s day off stays on its row and is flagged');
  // The other modes are untouched: no groups, no off-day shading.
  const crewMode = cal.laneModel(data(), [], MONDAY, { mode: 'crew' });
  assert.deepEqual(crewMode.lanes.map(entry => [entry.id, entry.group, entry.offDay, entry.shades.length]), [['crew:one', undefined, undefined, 0], ['crew:two', undefined, undefined, 0], ['crew:three', undefined, undefined, 0]]);
});

test('an estimator row shows their walkthroughs, their other work as busy, and their open walkthrough time', () => {
  const availability = [{ id: 'a1', employeeId: 'eve.sales', date: MONDAY, allDay: false, time: '15:00', endTime: '17:00', reason: 'Synthetic appointment', status: 'active' }];
  const jobs = [walk('w1', 'dee.est', '10:00', '11:00'), walk('w2', 'dee.est', '13:00', '14:00'), walk('w-gone', 'dee.est', '14:00', '15:30', { status: 'cancelled' }),
    job('crew-work', { crewId: 'one', assignedCrew: ['ana.crew', 'fay.multi'], time: '09:30', endTime: '12:30' }),
    { id: 'b1', type: 'blocked', title: 'Synthetic meeting', date: MONDAY, time: '16:00', endDate: MONDAY, endTime: '16:30', status: 'scheduled', assignedCrew: [] }];
  const model = cal.laneModel(data({ availability }), jobs, MONDAY, { mode: 'board' });
  const dee = lane(model, 'estimator:dee.est'), eve = lane(model, 'estimator:eve.sales'), fay = lane(model, 'estimator:fay.multi');
  assert.deepEqual(keys(dee), ['w1', 'w2', 'w-gone']);
  // 9:00-17:00 less 10-11, 13-14 and the 16:00 company block; a cancelled visit frees its time; runs under an hour are dropped.
  assert.deepEqual(dee.open.map(gap => [gap.start, gap.end]), [[540, 600], [660, 780], [840, 960]]);
  assert.deepEqual(eve.open.map(gap => [gap.start, gap.end]), [[540, 900]], 'time off and the company block close the afternoon');
  assert.deepEqual(fay.shades.filter(shade => shade.kind === 'busy').map(shade => [shade.start, shade.end, shade.label]), [[570, 750, 'On Crew 1 · Synthetic crew-work']]);
  assert.deepEqual(fay.open.map(gap => [gap.start, gap.end]), [[750, 960]], 'a crew job makes an estimator busy; 9:00-9:30 is too short to offer');
  assert.equal(cal.boardStatus(dee), '3 walkthroughs · 3 open slots');
  assert.equal(cal.boardStatus(lane(cal.laneModel(data(), [], MONDAY, { mode: 'board' }), 'estimator:eve.sales')), 'No walkthroughs · 1 open slot');
  // Today, time already gone is not offered (from the next quarter hour).
  const today = cal.laneModel(data(), [walk('w1', 'dee.est', '10:00', '11:00')], MONDAY, { mode: 'board', fromMinute: 622 });
  assert.deepEqual(lane(today, 'estimator:dee.est').open.map(gap => [gap.start, gap.end]), [[660, 1020]]);
});

test('open time follows recorded weekly availability inside the owner\'s workday, and the owner\'s workday when none is recorded', () => {
  const week = { mon: [{ start: '08:00', end: '12:00' }, { start: '13:00', end: '20:00' }], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] };
  const people = roster.map(person => person.id === 'dee.est' ? { ...person, weeklyAvailability: week } : person.id === 'eve.sales' ? { ...person, weeklyAvailability: { ...week, mon: [] } } : person);
  const model = cal.laneModel(data({ roster: people, dispatchRules: { workdayStart: '09:00', workdayEnd: '18:00' } }), [], MONDAY, { mode: 'board' });
  assert.deepEqual(lane(model, 'estimator:dee.est').open.map(gap => [gap.start, gap.end]), [[540, 720], [780, 1080]]);
  assert.deepEqual(lane(model, 'estimator:eve.sales').open, [], 'no availability that day is no open time');
  assert.deepEqual(lane(model, 'estimator:fay.multi').open.map(gap => [gap.start, gap.end]), [[540, 1080]]);
  assert.deepEqual(cal.workWindows({}, {}, MONDAY), [{ start: 540, end: 1020 }], 'the default job day is 9:00-17:00');
  assert.deepEqual(cal.openGaps([{ start: 540, end: 1020 }], [{ start: 600, end: 650 }, { start: 620, end: 700 }], { minimum: 60 }).map(gap => [gap.start, gap.end]), [[540, 600], [700, 1020]], 'overlapping busy spans merge');
});

test('moving a walkthrough between estimator rows swaps the estimator, as employee rows do', () => {
  const jobs = [walk('w1', 'dee.est', '10:00', '11:00')];
  const model = cal.laneModel(data(), jobs, MONDAY, { mode: 'board' }), item = lane(model, 'estimator:dee.est').items[0];
  assert.deepEqual(cal.crewChange(data(), item, lane(model, 'estimator:eve.sales')), { assignedCrew: ['eve.sales'], crewLead: 'eve.sales', crewId: null });
  assert.equal(cal.crewChange(data(), item, lane(model, 'estimator:dee.est')), null);
  const two = walk('w2', 'dee.est', '10:00', '11:00', { assignedCrew: ['dee.est', 'eve.sales'], crewLead: 'eve.sales' });
  const paired = cal.laneModel(data(), [two], MONDAY, { mode: 'board' });
  assert.deepEqual(cal.crewChange(data(), lane(paired, 'estimator:dee.est').items[0], lane(paired, 'estimator:fay.multi')), { assignedCrew: ['fay.multi', 'eve.sales'], crewLead: 'eve.sales', crewId: null }, 'only the estimator dragged from is replaced');
  const moved = cal.moveChanges(data(), item, lane(model, 'estimator:eve.sales'), { date: MONDAY, start: 780 });
  assert.deepEqual(moved.changes, { date: MONDAY, time: '13:00', endDate: MONDAY, endTime: '14:00', assignedCrew: ['eve.sales'], crewLead: 'eve.sales', crewId: null });
});

test('door-to-door work is marked from the job itself or from the D2D day answer', () => {
  assert.equal(cal.d2dJob({ id: 'a', source: 'door_to_door' }), true);
  assert.equal(cal.d2dJob({ id: 'b', d2d: { repKey: 'rep.one', kind: 'sale' } }), true);
  assert.equal(cal.d2dJob({ id: 'c', source: 'hub' }), false);
  assert.equal(cal.d2dJob(null), false);
  const answer = { ok: true, date: MONDAY, reps: [{ repKey: 'rep.one', name: 'Synthetic Rep', shifts: [], areas: [], saleList: [{ id: 's1', jobId: 'job_1' }], jobs: [{ id: 'job_2' }] }], jobs: [{ id: 'job_1', kind: 'sale' }], totals: {}, coverage: { complete: true } };
  assert.equal(cal.validD2d(answer, MONDAY), true);
  assert.equal(cal.validD2d(answer, SATURDAY), false, 'an answer for another date is never shown');
  assert.equal(cal.validD2d({ ...answer, jobs: [{ id: '../x', kind: 'sale' }] }, MONDAY), false);
  assert.equal(cal.validD2d({ ...answer, reps: [{ ...answer.reps[0], saleList: [{ id: 's1', jobId: 'bad id' }] }] }, MONDAY), false);
  assert.equal(cal.validD2d({ ...answer, coverage: undefined }, MONDAY), false);
});

// The rendered board, through the real dispatch screen with a fake /api/dispatch and /api/d2d-day.
function mounted({ viewer = { id: 'manager.one' }, d2d = null, jobs = [], date = MONDAY, endDate = '2026-10-20' } = {}) {
  const document = createDocument(), calls = [], create = document.createElement.bind(document);
  // The small test DOM keeps style as a plain object; the lanes set custom properties on it.
  document.createElement = tag => { const node = create(tag); node.style.setProperty = (name, value) => { node.style[name] = String(value); }; return node; };
  const overview = { ok: true, viewer, jobs, roster, crews, vehicles: [], availability: [], warnings: [], coverage: { complete: true, asOf: NOW }, startDate: date, endDate, dispatchRules: { workdayStart: '09:00', workdayEnd: '17:00' } };
  const fetch = async (path) => {
    calls.push(String(path));
    if (String(path).startsWith('/api/d2d-day')) return d2d ? { ok: d2d.status === 200, status: d2d.status, json: async () => d2d.body } : new Promise(() => {});
    return { ok: true, status: 200, json: async () => overview };
  };
  const { window, run } = realm(document, { fetch, crypto: globalThis.crypto, sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} } });
  window.matchMedia = () => ({ matches: false });
  run('employee-dispatch.js'); run('employee-dispatch-calendar.js');
  const api = window.EGCDispatch.internals, state = api.state(), root = document.createElement('main'), body = document.createElement('section');
  body.setAttribute('data-dp-body', ''); root.append(body); document.body.append(root); state.root = root;
  state.data = overview; state.view = 'board'; state.date = date; state.loading = false; state.error = '';
  return { api, body, calls, window };
}
const settle = () => new Promise(resolve => setTimeout(resolve, 0));
const D2D_ANSWER = {
  ok: true, authority: 'employee_hub', date: MONDAY, timeZone: 'America/Denver',
  reps: [{ repKey: 'rep.one', name: 'Synthetic Rep', onShift: true, onBreak: false, shifts: [{ startedAt: '2026-10-19T15:05:00.000Z', endedAt: null, autoEnded: false }], knockingMinutes: 55,
    areas: [{ id: 'nb1', name: 'Synthetic Park', claim: 'self', worked: true }], doors: 41, answers: 12, looks: 4, sales: 1, walkthroughsSet: 1,
    saleList: [{ id: 'sale-1', status: 'booked', package: 'Synthetic Package', jobDate: '2026-10-23', jobStartTime: '09:30', jobId: 'job_sale' }],
    jobs: [{ id: 'job_sale', kind: 'sale', type: 'job', date: '2026-10-23', time: '09:30', status: 'scheduled' }, { id: 'walk_set', kind: 'walkthrough', type: 'walkthrough', date: '2026-10-21', time: '10:00', status: 'scheduled' }] }],
  totals: { reps: 1, onShift: 1, doors: 41, sales: 1, walkthroughsSet: 1 },
  jobs: [{ id: 'job_sale', kind: 'sale', repKey: 'rep.one', repName: 'Synthetic Rep', type: 'job', date: '2026-10-23', time: '09:30', status: 'scheduled', bookedToday: false, createdToday: true },
    { id: 'walk_set', kind: 'walkthrough', repKey: 'rep.one', repName: 'Synthetic Rep', type: 'walkthrough', date: '2026-10-21', time: '10:00', status: 'scheduled', bookedToday: false, createdToday: true },
    { id: 'd2d_today', kind: 'sale', repKey: 'rep.one', repName: 'Synthetic Rep', type: 'job', date: MONDAY, time: '09:30', status: 'scheduled', bookedToday: true, createdToday: false }],
  coverage: { complete: true, truncated: [], missing: [], asOf: NOW },
};

test('the Board view is registered once and draws crews, then estimators, then the door-to-door day', async () => {
  const jobs = [job('d2d_today', { crewId: 'one', assignedCrew: ['ana.crew', 'fay.multi'], crewLead: 'fay.multi' }), walk('w1', 'dee.est', '10:00', '11:00')];
  const { api, body, calls, window } = mounted({ jobs, d2d: { status: 200, body: D2D_ANSWER } });
  assert.throws(() => window.EGCDispatch.registerView('board', { label: 'Again', range: date => ({ startDate: date, endDate: date }), render() {} }), /already registered/);
  api.redraw();
  const heads = body.querySelectorAll('.dc-group-head').map(node => node.textContent);
  assert.deepEqual(heads, ['Crews', 'Estimators']);
  const rows = body.querySelectorAll('.dc-lane').map(node => node.getAttribute('data-dc-lane'));
  assert.deepEqual(rows, ['crew:one', 'crew:two', 'crew:three', 'estimator:dee.est', 'estimator:eve.sales', 'estimator:fay.multi']);
  assert.match(body.textContent, /Loading door-to-door/);
  assert.deepEqual(calls.filter(path => path.startsWith('/api/d2d-day')), ['/api/d2d-day?date=2026-10-19']);
  await settle(); await settle();
  const text = body.textContent;
  for (const expected of ['Door-to-door', 'Synthetic Rep', 'On shift', 'Synthetic Park · claimed · worked today', '41', 'Walkthroughs set', 'Sale · Synthetic Package', 'Walkthrough set', 'Door-to-door work on this day'])
    assert.ok(text.includes(expected), expected);
  assert.ok(body.querySelectorAll('a.dc-d2d-link').some(link => link.getAttribute('href') === '/crew/gameplan.html?walkthroughId=walk_set'));
  assert.ok(body.querySelectorAll('a.dc-d2d-link').some(link => link.getAttribute('href') === '/crew/job.html?jobId=job_sale'));
  // The day's D2D job on Crew 1 is marked on the board once the answer names it.
  const marked = body.querySelectorAll('.dc-item.dc-item-d2d').map(node => node.getAttribute('data-dc-item'));
  assert.deepEqual(marked, ['d2d_today']);
  // A redraw (the one-minute board refresh) does not read the door-to-door day again.
  api.redraw(); api.redraw(); await settle();
  assert.equal(calls.filter(path => path.startsWith('/api/d2d-day')).length, 1);
  // Estimator open time is a button that books a walkthrough with that estimator.
  assert.ok(body.querySelectorAll('button.dc-open').length >= 3);
});

test('a booker never asks for the door-to-door day, and a 403 or 404 hides the panel without retrying', async () => {
  const booker = mounted({ viewer: { id: 'sales.one', booker: true } });
  booker.api.redraw(); await settle();
  assert.deepEqual(booker.calls.filter(path => path.startsWith('/api/d2d-day')), []);
  assert.equal(booker.body.querySelectorAll('.dc-d2d').length, 0);
  assert.equal(booker.body.querySelectorAll('button.dc-open').length, 0, 'a booker cannot pick who goes, so open time is not a button');
  for (const [status, code] of [[403, 'd2d_day_forbidden'], [404, 'd2d_day_disabled']]) {
    const page = mounted({ d2d: { status, body: { ok: false, code, error: 'Synthetic refusal' } } });
    page.api.redraw(); await settle(); await settle();
    assert.equal(page.body.querySelectorAll('.dc-d2d').length, 0, code);
    page.api.redraw(); await settle();
    assert.equal(page.calls.filter(path => path.startsWith('/api/d2d-day')).length, 1, code);
  }
  const failing = mounted({ d2d: { status: 503, body: { ok: false, code: 'd2d_day_storage_unavailable', error: 'Synthetic outage' } } });
  failing.api.redraw(); await settle(); await settle();
  assert.match(failing.body.textContent, /Synthetic outage/);
  assert.ok(failing.body.querySelectorAll('button').some(button => button.textContent === 'Refresh door-to-door'));
});

test('with the staff directory on (rows carry skills), only the Walkthrough estimating skill makes an estimator', () => {
  // D6: the Sales role stands in only while the roster carries no skills. A door-to-door rep with a Sales account is not an estimator.
  const directory = [
    { id: 'dee.est', name: 'Dee Estimator', role: 'crew', staffRoles: ['crew'], skills: [{ id: 'walkthrough_estimating', level: 'lead' }] },
    { id: 'eve.sales', name: 'Eve Sales', role: 'sales', staffRoles: ['sales'], skills: [{ id: 'walkthrough_estimating', level: 'trained' }] },
    { id: 'kim.knock', name: 'Kim Knock', role: 'sales', staffRoles: ['sales'], skills: [{ id: 'door_to_door', level: 'trained' }] },
    { id: 'lou.sales', name: 'Lou Sales', role: 'sales', staffRoles: ['sales'], skills: [] },
    { id: 'fay.multi', name: 'Fay Multi', role: 'crew_lead', staffRoles: ['crew_lead', 'sales'], skills: [] },
  ];
  assert.deepEqual(directory.map(person => cal.estimatorPerson(person)), [true, true, false, false, false]);
  const model = cal.laneModel(data({ roster: directory }), [walk('w-kim', 'kim.knock', '10:00', '11:00')], MONDAY, { mode: 'board' });
  assert.deepEqual(model.lanes.filter(entry => entry.group === 'estimators').map(entry => entry.id), ['estimator:dee.est', 'estimator:eve.sales', 'estimator:kim.knock']);
  assert.deepEqual(keys(lane(model, 'estimator:kim.knock')), ['w-kim'], 'a walkthrough someone already holds still shows on a row for them');
  // Directory off (no skills on any row): the Sales role, primary or stored, stands in.
  assert.deepEqual([{ role: 'sales' }, { role: 'crew', staffRoles: ['crew', 'sales'] }, { role: 'crew' }, { role: 'phone', staffRoles: ['phone'] }].map(person => cal.estimatorPerson(person)), [true, true, false, false]);
});

test('a past day offers no open walkthrough time; today offers it from now; a future day all of it', async () => {
  const past = mounted({ date: '2026-10-16', endDate: '2026-10-17', d2d: { status: 200, body: { ...D2D_ANSWER, date: '2026-10-16' } } });
  past.api.redraw(); await settle();
  assert.equal(past.body.querySelectorAll('button.dc-open').length, 0, 'no booking a walkthrough in the past');
  assert.equal(past.body.querySelectorAll('.dc-open').length, 0);
  assert.ok(past.body.textContent.includes('No walkthroughs · no open time'));
  const future = mounted({ date: '2026-10-20', endDate: '2026-10-21' });
  future.api.redraw();
  assert.equal(future.body.querySelectorAll('button.dc-open').length, 3, 'one whole working day for each roster estimator');
  // Today (Monday, 10:00 in Denver): open time starts at 10:00, not 9:00.
  const today = mounted();
  today.api.redraw();
  assert.ok(today.body.querySelectorAll('button.dc-open').every(button => !button.textContent.includes('9:00')));
  assert.ok(today.body.querySelectorAll('button.dc-open').some(button => button.textContent.includes('Open 10:00 AM')));
});

test('a door-to-door job is marked from its own Dispatch record, for a booker too (no door-to-door day read)', async () => {
  const jobs = [job('d2d_sale', { source: 'door_to_door', d2d: { kind: 'sale' }, crewId: 'one', assignedCrew: ['ana.crew', 'fay.multi'] }), job('office', { crewId: 'two', assignedCrew: ['ben.crew'] })];
  const page = mounted({ viewer: { id: 'sales.one', booker: true }, jobs });
  page.api.redraw(); await settle();
  assert.deepEqual(page.calls.filter(path => path.startsWith('/api/d2d-day')), []);
  assert.deepEqual(page.body.querySelectorAll('.dc-item.dc-item-d2d').map(node => node.getAttribute('data-dc-item')), ['d2d_sale']);
  assert.ok(page.body.querySelectorAll('.dc-item.dc-item-d2d')[0].textContent.includes('Door-to-door'));
});

test('the door-to-door panel says which part of the day could not be read', async () => {
  for (const [coverage, expected, unexpected] of [
    [{ complete: false, truncated: [], missing: ['areas'] }, 'The areas reps hold could not be read, so some may be missing. Refresh to try again.', 'job links'],
    [{ complete: false, truncated: [], missing: ['jobs'] }, 'The Hub jobs door-to-door made could not be checked, so job links may be missing. Refresh to try again.', 'areas reps hold'],
    [{ complete: false, truncated: ['shifts'], missing: [] }, 'There was more door-to-door activity than one view shows, so some of it is left out.', 'Refresh to try again.'],
  ]) {
    const page = mounted({ d2d: { status: 200, body: { ...D2D_ANSWER, coverage: { ...coverage, asOf: NOW } } } });
    page.api.redraw(); await settle(); await settle();
    const text = page.body.querySelectorAll('.dc-d2d')[0].textContent;
    assert.ok(text.includes(expected), expected);
    assert.ok(!text.includes(unexpected), unexpected);
  }
});
