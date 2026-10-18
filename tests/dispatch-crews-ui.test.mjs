import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from './helpers/vm-realm.mjs';
import { createDocument, storage } from './helpers/hub-dom.mjs';

// WP1/WP3 Hub dispatch: the crew editor (priority, days, code, Create Crew 1/2/3), crew pickers by
// priority with a Weekend label, the "Any crew (priority order)" openings search and the automatic crew
// choice. employee-dispatch.js runs in a vm realm on the small DOM with a fixed clock; every request is
// answered here, so nothing reaches a server.
const NOON = '2026-10-17T18:00:00.000Z';
const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri'];
const CREWS = [
  { id: 'crew-north', revision: 'n1', recordType: 'crew', name: 'North', memberIds: ['c9a'], leadId: 'c9a', status: 'active' },
  { id: 'crew-three', revision: 't1', recordType: 'crew', name: 'Crew 3', memberIds: ['c3a'], leadId: 'c3a', status: 'active', priority: 3, serviceDays: ['sat', 'sun'], code: 'crew-3' },
  { id: 'crew-one', revision: 'o1', recordType: 'crew', name: 'Crew 1', memberIds: ['c1a', 'c1b'], leadId: 'c1a', status: 'active', priority: 1, serviceDays: WEEKDAYS, code: 'crew-1' },
];
const ROSTER = ['c1a', 'c1b', 'c3a', 'c9a'].map(id => ({ id, name: `Synthetic ${id}`, role: 'crew' }));
const board = (viewer, extra = {}) => ({ ok: true, viewer, timeZone: 'America/Denver', jobs: [], roster: ROSTER, crews: CREWS, vehicles: [], availability: [], warnings: [], coverage: { complete: true, asOf: NOON }, dispatchRules: { workdayStart: '09:00', workdayEnd: '17:00', defaultTravelBufferMinutes: 20 }, ...extra });
const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
function page(data) {
  const document = createDocument(), posts = [], gets = [], clock = Date.parse(NOON), state = { openings: null };
  class Clock extends Date { constructor(...args) { super(...(args.length ? args : [clock])); } static now() { return clock; } }
  Object.defineProperty(document.Element.prototype, 'parentElement', { configurable: true, get() { return this.parentNode?.nodeType === 1 ? this.parentNode : null; } });
  Object.assign(document.Element.prototype, {
    prepend(...nodes) { const first = this.childNodes[0] || null; for (const node of nodes) this.insertBefore(node, first); },
    showModal() { this.open = true; }, close() { this.open = false; }, getBoundingClientRect: () => ({ left: 0, right: 0, top: 0, bottom: 0 }),
  });
  Object.defineProperty(document.Element.prototype, 'elements', { configurable: true, get() { return this.querySelectorAll('input,select,textarea,button'); } });
  // A select takes the value of its selected option (else its first), as in a browser.
  const appendChild = document.Element.prototype.appendChild;
  document.Element.prototype.appendChild = function (node) {
    const added = appendChild.call(this, node);
    if (this.tagName === 'SELECT' && node.tagName === 'OPTION' && (node.hasAttribute('selected') || this.children.length === 1)) this.value = node.value;
    return added;
  };
  class FormData {
    constructor(form) { this.list = form.querySelectorAll('input,textarea,select').filter(field => field.name && !(['checkbox', 'radio'].includes(field.type) && !field.checked)).map(field => [field.name, field.value]); }
    entries() { return this.list[Symbol.iterator](); } get(name) { return this.list.find(([key]) => key === name)?.[1] ?? null; }
    getAll(name) { return this.list.filter(([key]) => key === name).map(([, value]) => value); } has(name) { return this.list.some(([key]) => key === name); }
  }
  const context = { console, URL, URLSearchParams, Intl, Promise, Set, Map, Error, JSON, Object, Array, Math, AbortController, structuredClone, crypto, queueMicrotask, FormData,
    Date: Clock, Node: document.Node, document, sessionStorage: storage(), Event: class { constructor(type) { this.type = type; } },
    setTimeout: () => 0, clearTimeout() {}, setInterval() {}, clearInterval() {}, addEventListener() {},
    fetch: async (url, options = {}) => {
      if (options.method === 'POST') { const body = JSON.parse(options.body); posts.push(body); return json(body.action === 'crew.seed_defaults' ? { ok: true, requestId: body.requestId, created: [], updated: [], existing: [], resources: [], warnings: [] } : { ok: true, requestId: body.requestId, warnings: [], resource: { id: body.id || 'crew-new', revision: 'x2' } }); }
      if (url.startsWith('/api/dispatch-openings?')) { gets.push(new URLSearchParams(url.split('?')[1])); return json(state.openings); }
      assert.match(url, /^\/api\/dispatch\?/); return json(data);
    } };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(readFileSync(new URL('../employee-dispatch.js', import.meta.url), 'utf8'), context, { filename: 'employee-dispatch.js' });
  const host = document.createElement('main'); document.body.append(host);
  const flush = async () => { for (let index = 0; index < 60; index++) await Promise.resolve(); };
  const dialog = () => document.querySelector('dialog');
  const button = (root, text) => root.querySelectorAll('button').find(node => node.textContent.trim() === text);
  const submit = () => dialog().querySelector('form').dispatchEvent({ type: 'submit', preventDefault() {} });
  const named = name => dialog().querySelectorAll('input,select').filter(node => node.name === name);
  return { document, host, posts, gets, state, flush, dialog, button, submit, named, dispatch: context.EGCDispatch };
}
const manager = { id: 'ZacB' }, booker = { id: 'Synthetic.Sales', booker: true };

test('Crews & vehicles lists crews by priority with days, offers Create Crew 1/2/3, and posts the seed action', async () => {
  const p = page(board(manager));
  p.dispatch.mount(p.host); await p.flush();
  p.button(p.host, 'Crews & vehicles').click(); await p.flush();
  const text = p.dialog().textContent;
  assert.ok(text.indexOf('Crew 1') < text.indexOf('Crew 3 · Weekend') && text.indexOf('Crew 3 · Weekend') < text.indexOf('North'), 'priority order: Crew 1, Crew 3, then the legacy crew');
  assert.match(text, /Priority 1 · Mon–Fri · Synthetic c1a, Synthetic c1b/); assert.match(text, /Priority 3 · Sat, Sun/); assert.match(text, /Priority 99 · Every day/);
  p.button(p.dialog(), 'Create Crew 1/2/3').click(); await p.flush();
  assert.deepEqual(p.posts.map(body => Object.keys(body).sort()), [['action', 'requestId']]);
  assert.equal(p.posts[0].action, 'crew.seed_defaults');
  const seeded = page(board(manager, { crews: [...CREWS, { id: 'crew-two', revision: 'w1', recordType: 'crew', name: 'Crew 2', memberIds: [], leadId: null, status: 'active', priority: 2, serviceDays: WEEKDAYS, code: 'crew-2' }] }));
  seeded.dispatch.mount(seeded.host); await seeded.flush();
  seeded.button(seeded.host, 'Crews & vehicles').click(); await seeded.flush();
  assert.equal(seeded.button(seeded.dialog(), 'Create Crew 1/2/3'), undefined, 'hidden once every code exists');
});

test('the crew editor sends priority, days and code only when set, so a legacy crew keeps its shape', async () => {
  const p = page(board(manager));
  p.dispatch.mount(p.host); await p.flush();
  const edit = async name => { p.button(p.host, 'Crews & vehicles').click(); await p.flush(); const row = p.dialog().querySelectorAll('article').find(node => node.textContent.startsWith(name)); p.button(row, 'Edit').click(); await p.flush(); };
  await edit('North');
  assert.deepEqual(p.named('serviceDays').filter(box => box.checked).map(box => box.value), ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']);
  p.submit(); await p.flush();
  assert.deepEqual(p.posts.at(-1).changes, { name: 'North', status: 'active', memberIds: ['c9a'], leadId: 'c9a' }, 'untouched v2 fields are not sent');
  await edit('North');
  p.named('priority')[0].value = '2'; p.named('code')[0].value = 'crew-2';
  for (const box of p.named('serviceDays')) box.checked = WEEKDAYS.includes(box.value);
  p.submit(); await p.flush();
  assert.deepEqual(p.posts.at(-1).changes, { name: 'North', status: 'active', memberIds: ['c9a'], leadId: 'c9a', priority: 2, code: 'crew-2', serviceDays: WEEKDAYS });
  await edit('Crew 3');
  p.named('priority')[0].value = ''; p.named('code')[0].value = '';
  p.submit(); await p.flush();
  assert.deepEqual(p.posts.at(-1).changes, { name: 'Crew 3', status: 'active', memberIds: ['c3a'], leadId: 'c3a', priority: null, code: null, serviceDays: ['sat', 'sun'] }, 'cleared fields are sent as null');
  const before = p.posts.length;
  await edit('Crew 1');
  for (const box of p.named('serviceDays')) box.checked = false;
  p.submit(); await p.flush();
  assert.equal(p.posts.length, before, 'no day chosen: nothing is sent');
  assert.match(p.dialog().textContent, /Choose at least one day this crew works\./);
});

test('Find opening: Any crew (priority order) asks for crews=auto and a job kind, shows full and open crews, and books the crew', async () => {
  const p = page(board(manager, { crewAutoAssign: true }));
  p.state.openings = { ok: true, coverage: { complete: true, consistent: true }, warnings: [], total: 1, truncated: false,
    candidates: [{ date: '2026-10-19', time: '09:30', endDate: '2026-10-19', endTime: '11:30', crewId: 'crew-one', crewName: 'Crew 1', crewCode: 'crew-1', priority: 1, weekend: false, employeeIds: ['c1a', 'c1b'] }],
    byDate: [{ date: '2026-10-19', crews: [{ crewId: 'crew-one', crewName: 'Crew 1', priority: 1, weekend: false, open: true, count: 1, first: { time: '09:30', endDate: '2026-10-19', endTime: '11:30' } }, { crewId: 'crew-two', crewName: 'Crew 2', priority: 2, weekend: false, open: false, count: 0, first: null }] }] };
  p.dispatch.mount(p.host); await p.flush();
  p.button(p.host, 'Find opening').click(); await p.flush();
  const search = p.dialog().querySelectorAll('select').find(node => node.querySelectorAll('option').some(option => option.value === 'crews'));
  assert.equal(search.value, 'crews', 'with crew auto-assign a manager\'s search starts on Any crew too (D2D-BOARD 2026-10-17)');
  assert.deepEqual(p.dialog().querySelectorAll('select').find(node => node.querySelectorAll('option').some(option => option.value === 'crew-three')).querySelectorAll('option').map(option => option.textContent), ['Choose employees individually', 'Crew 1', 'Crew 3 · Weekend', 'North'], 'saved crews by priority');
  search.value = 'crews'; search.dispatchEvent({ type: 'change', target: search });
  p.submit(); await p.flush();
  const query = p.gets.at(-1);
  assert.deepEqual([query.get('crews'), query.get('kind'), query.get('employeeIds'), query.get('workdayStart')], ['auto', 'job', null, '09:00']);
  assert.match(p.dialog().textContent, /Crew 1 · 1 opening, first 9:30 AM/); assert.match(p.dialog().textContent, /Crew 2 · full/);
  p.button(p.dialog(), 'Use this opening').click(); await p.flush();
  assert.match(p.dialog().querySelector('h2')?.textContent || p.dialog().textContent, /job/i);
  const crewSelect = p.named('crewId')[0];
  assert.equal(crewSelect.value, 'crew-one');
  assert.deepEqual(p.dialog().querySelectorAll('fieldset input').filter(box => box.type === 'checkbox' && box.checked).map(box => box.value).filter(id => id.startsWith('c')), ['c1a', 'c1b'], 'the opening crew is preselected');
});

test('a booker with crew auto-assign searches any crew by default and the job form names the offered crew; a manager may ask for the first free crew', async () => {
  const p = page(board(booker, { crewAutoAssign: true }));
  p.state.openings = { ok: true, coverage: { complete: true, consistent: true }, warnings: [], total: 1, truncated: false,
    candidates: [{ date: '2026-10-19', time: '09:30', endDate: '2026-10-19', endTime: '11:30', crewId: 'crew-one', crewName: 'Crew 1', crewCode: 'crew-1', priority: 1, weekend: false }],
    byDate: [{ date: '2026-10-19', crews: [{ crewId: 'crew-one', crewName: 'Crew 1', priority: 1, weekend: false, open: true, count: 1, first: { time: '09:30', endDate: '2026-10-19', endTime: '11:30' } }] }] };
  p.dispatch.mount(p.host); await p.flush();
  p.button(p.host, 'Find opening').click(); await p.flush();
  p.submit(); await p.flush();
  assert.equal(p.gets.at(-1).get('crews'), 'auto');
  p.button(p.dialog(), 'Use this opening').click(); await p.flush();
  assert.equal(p.named('crewId')[0].value, 'crew-one', 'the crew the booker accepts; the server checks it again');
  assert.match(p.dialog().textContent, /Crew: Crew 1\. It is checked again when you save/);
  assert.equal(p.named('autoCrew').length, 0, 'a booker never chooses the pick mode');
  const plainBooker = page(board(booker, { crewAutoAssign: true }));
  plainBooker.dispatch.mount(plainBooker.host); await plainBooker.flush();
  plainBooker.dispatch.book({ kind: 'job', name: 'Synthetic Lead' }); await plainBooker.flush();
  assert.match(plainBooker.dialog().textContent, /gets the first free crew automatically when you save/);
  const off = page(board(booker));
  off.dispatch.mount(off.host); await off.flush();
  off.dispatch.book({ kind: 'job', name: 'Synthetic Lead' }); await off.flush();
  assert.match(off.dialog().textContent, /A manager assigns the crew and vehicle in Dispatch\./, 'flag off: as before');
  const m = page(board(manager, { crewAutoAssign: true }));
  m.dispatch.mount(m.host); await m.flush();
  m.button(m.host, 'Create job').click(); await m.flush();
  assert.deepEqual(m.named('autoCrew').map(box => box.checked), [true], 'a new job asks for the first free crew unless people are chosen');
  const plain = page(board(manager));
  plain.dispatch.mount(plain.host); await plain.flush();
  plain.button(plain.host, 'Create job').click(); await plain.flush();
  assert.equal(plain.named('autoCrew').length, 0, 'flag off: no automatic crew choice');
});

// A To-schedule service job, as GET /api/dispatch lists it to a booker.
const QUEUED = { id: 'job-q', revision: 'q1', type: 'job', customer: 'Synthetic Queue', customerId: 'cust-1', status: 'unscheduled', pipelineStatus: 'unscheduled', date: '', time: '', endDate: '', endTime: '', assignedCrew: [], assignedTo: '', crewId: null, crewLead: null, vehicleId: null, address: '1 Fixture Lane', crewNeeded: 2, travelBufferMinutes: 20, jobInstructions: 'Synthetic garage reset' };
const MONDAY_OPENING = { ok: true, coverage: { complete: true, consistent: true }, warnings: [], total: 1, truncated: false,
  candidates: [{ date: '2026-10-19', time: '09:30', endDate: '2026-10-19', endTime: '11:30', crewId: 'crew-one', crewName: 'Crew 1', crewCode: 'crew-1', priority: 1, weekend: false }],
  byDate: [{ date: '2026-10-19', crews: [{ crewId: 'crew-one', crewName: 'Crew 1', priority: 1, weekend: false, open: true, count: 1, first: { time: '09:30', endDate: '2026-10-19', endTime: '11:30' } }] }] };
const searchMode = p => p.dialog().querySelectorAll('select').find(node => node.querySelectorAll('option').some(option => option.value === 'people'));

test('a booker: a crew accepted from an opening is sent only for that opening; another day drops it so the server picks', async () => {
  for (const changeDay of [false, true]) {
    const p = page(board(booker, { crewAutoAssign: true, jobs: [QUEUED] }));
    p.state.openings = MONDAY_OPENING;
    p.dispatch.mount(p.host); await p.flush();
    p.dispatch.internals.show('queue'); await p.flush();
    p.button(p.host, 'Find a time').click(); await p.flush();
    assert.equal(searchMode(p).value, 'crews', 'an unstaffed job searches any crew');
    p.submit(); await p.flush();
    p.button(p.dialog(), 'Use this opening').click(); await p.flush();
    if (changeDay) { const day = p.named('date')[0]; day.value = '2026-10-20'; day.dispatchEvent({ type: 'change', target: day }); }
    p.submit(); await p.flush();
    const body = p.posts.at(-1);
    assert.equal(body?.action, 'schedule.update', p.dialog()?.textContent);
    assert.deepEqual([body.changes.date, body.changes.crewId], changeDay ? ['2026-10-20', null] : ['2026-10-19', 'crew-one']);
  }
});

test('the Any crew default: on for every service-job search with crew auto-assign, off with it off or for a job a manager staffed', async () => {
  const off = page(board(manager));
  off.dispatch.mount(off.host); await off.flush();
  off.button(off.host, 'Find opening').click(); await off.flush();
  assert.equal(searchMode(off).value, 'people', 'flag off: the search starts on the employees a manager chooses, as before');
  const on = page(board(manager, { crewAutoAssign: true }));
  on.dispatch.mount(on.host); await on.flush();
  on.button(on.host, 'Find opening').click(); await on.flush();
  const kind = on.dialog().querySelectorAll('select').find(node => node.querySelectorAll('option').some(option => option.value === 'walkthrough'));
  assert.equal(searchMode(on).value, 'crews');
  kind.value = 'walkthrough'; kind.dispatchEvent({ type: 'change', target: kind });
  assert.equal(searchMode(on).value, 'people', 'a walkthrough searches people');
  kind.value = 'job'; kind.dispatchEvent({ type: 'change', target: kind });
  assert.equal(searchMode(on).value, 'crews', 'back to a service job: Any crew again, since the manager did not choose');
  const staffed = { ...QUEUED, assignedCrew: ['c9a'], assignedTo: 'c9a', crewId: 'crew-north', crewLead: 'c9a' };
  const mine = page(board(manager, { crewAutoAssign: true, jobs: [staffed] }));
  mine.dispatch.mount(mine.host); await mine.flush();
  mine.dispatch.internals.show('queue'); await mine.flush();
  mine.button(mine.host, 'Find a time').click(); await mine.flush();
  assert.equal(searchMode(mine).value, 'people', 'a manager\'s own staffing is searched as chosen');
  const unstaffed = page(board(manager, { crewAutoAssign: true, jobs: [QUEUED] }));
  unstaffed.dispatch.mount(unstaffed.host); await unstaffed.flush();
  unstaffed.dispatch.internals.show('queue'); await unstaffed.flush();
  unstaffed.button(unstaffed.host, 'Find a time').click(); await unstaffed.flush();
  assert.equal(searchMode(unstaffed).value, 'crews');
  unstaffed.submit(); await unstaffed.flush();
  assert.equal(unstaffed.gets.at(-1).get('crews'), 'auto');
});

test('Any crew is offered only for service jobs, and never to a booker moving a job a manager staffed', async () => {
  const p = page(board(manager, { crewAutoAssign: true }));
  p.dispatch.mount(p.host); await p.flush();
  p.button(p.host, 'Find opening').click(); await p.flush();
  const mode = searchMode(p), crewsOption = mode.querySelectorAll('option').find(option => option.value === 'crews');
  mode.value = 'crews'; mode.dispatchEvent({ type: 'change', target: mode });
  const kind = p.dialog().querySelectorAll('select').find(node => node.querySelectorAll('option').some(option => option.value === 'walkthrough'));
  kind.value = 'walkthrough'; kind.dispatchEvent({ type: 'change', target: kind });
  assert.deepEqual([mode.value, crewsOption.disabled], ['people', true], 'crews do service jobs, not walkthroughs');
  kind.value = 'job'; kind.dispatchEvent({ type: 'change', target: kind });
  assert.equal(crewsOption.disabled, false);
  const staffed = { ...QUEUED, assignedCrew: ['c9a'], assignedTo: 'c9a', crewId: 'crew-north', crewLead: 'c9a' };
  const hand = page(board(booker, { crewAutoAssign: true, jobs: [staffed] }));
  hand.dispatch.mount(hand.host); await hand.flush();
  hand.dispatch.internals.show('queue'); await hand.flush();
  hand.button(hand.host, 'Find a time').click(); await hand.flush();
  assert.deepEqual([searchMode(hand).value, searchMode(hand).querySelectorAll('option').map(option => option.value)], ['people', ['people']], 'the manager\'s crew is searched, not any crew');
  const auto = page(board(booker, { crewAutoAssign: true, jobs: [{ ...staffed, crewAutoAssigned: { crewId: 'crew-north', memberIds: ['c9a'], leadId: 'c9a', mode: 'pick' } }] }));
  auto.dispatch.mount(auto.host); await auto.flush();
  auto.dispatch.internals.show('queue'); await auto.flush();
  auto.button(auto.host, 'Find a time').click(); await auto.flush();
  assert.equal(searchMode(auto).value, 'crews', 'a job the server staffed may take another offered crew');
});
