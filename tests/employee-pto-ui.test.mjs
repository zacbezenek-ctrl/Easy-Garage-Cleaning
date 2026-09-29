import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import vm from 'node:vm';

const read = name => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const plain = value => JSON.parse(JSON.stringify(value));
const tick = () => new Promise(resolve => setImmediate(resolve));
const response = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
const storage = initial => {
  const values = new Map(Object.entries(initial || {}));
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key),
    key: index => [...values.keys()][index] ?? null, get length() { return values.size; }, values };
};
const request = (overrides = {}) => ({ id: 'pto_1', type: 'time_off', employee: 'crew.one', employeeName: 'Crew One', startDate: '2026-09-23', endDate: '2026-09-25', reason: 'Family trip', status: 'pending', paid: true, hoursPerDay: 8, paidHours: 24, createdAt: '2026-09-20T10:00:00.000Z', ...overrides });
// What a workflow approval stores: its approve decision's by/at are the request's reviewedBy/reviewedAt.
const approval = (extra = {}, at = '2026-09-21T15:00:00.000Z') => ({ status: 'approved', reviewedBy: 'zacb', reviewedAt: at, decisions: [{ action: 'approve', status: 'approved', by: 'zacb', at, ...extra }] });

// Just enough DOM for the board's h() builder: elements, text, attributes and click listeners.
class FakeNode {}
class FakeText extends FakeNode { constructor(value) { super(); this.data = String(value); } get textContent() { return this.data; } }
class FakeElement extends FakeNode {
  constructor(tag) { super(); this.tagName = tag.toUpperCase(); this.childNodes = []; this.attributes = {}; this.listeners = {}; this.className = ''; this.type = ''; this.disabled = false; }
  // Like the real DOM, a value that is not a node becomes text (so a stray null shows up as "null").
  append(...nodes) { this.childNodes.push(...nodes.map(node => node instanceof FakeNode ? node : new FakeText(node))); }
  replaceChildren(...nodes) { this.childNodes = []; this.append(...nodes); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  addEventListener(name, listener) { (this.listeners[name] ||= []).push(listener); }
  get textContent() { return this.childNodes.map(node => node.textContent).join(''); }
  all() { return [this, ...this.childNodes.filter(node => node instanceof FakeElement).flatMap(node => node.all())]; }
  buttons() { return this.all().filter(node => node.tagName === 'BUTTON'); }
  button(label) { return this.buttons().find(node => node.textContent === label); }
  click() { if (!this.disabled) for (const listener of this.listeners.click || []) listener({}); }
}
// The Hub clock is fixed at a Tuesday morning in Denver; tests never read the real clock.
const NOW = Date.parse('2026-09-22T18:00:00.000Z');
class FixedDate extends Date { constructor(...args) { super(...(args.length ? args : [NOW])); } static now() { return NOW; } }
const fakeDocument = extra => ({ createElement: tag => new FakeElement(tag), createTextNode: text => new FakeText(text), ...extra });
const cards = host => host.all().filter(node => node.tagName === 'ARTICLE').map(node => ({ id: node.getAttribute('data-request-id'), text: node.textContent, actions: node.buttons().map(button => button.textContent) }));

function client(route, user = 'Crew.One') {
  const events = {}, calls = [];
  const fetcher = async (url, init = {}) => { const body = init.body ? JSON.parse(init.body) : null; calls.push({ url, init, body }); return route(body, calls.length); };
  const context = { console, Promise, Error, JSON, Number, String, Array, Object, Date: FixedDate, Intl, AbortController, setTimeout: () => 1, clearTimeout() {},
    crypto: { randomUUID }, sessionStorage: storage({ egc_u: user }), localStorage: storage(), hubFetch: fetcher, Node: FakeNode, document: fakeDocument(),
    addEventListener: (name, callback) => { events[name] = callback; } };
  context.window = context;
  vm.runInNewContext(read('employee-pto.js'), context, { filename: 'employee-pto.js' });
  const dialogs = [], answers = [], toasts = [], saved = [];
  const deps = (manager = false, today = '2026-09-22') => ({ manager, today, askAction: async dialog => { dialogs.push(dialog); return answers.shift() ?? null; }, toast: message => toasts.push(message), saved: row => saved.push(row) });
  return { context, events, calls, pto: context.EGCPto, dialogs, answers, toasts, saved, deps, storage: context.sessionStorage };
}

test('a time-off request keeps its frozen body until confirmed and retries it unchanged after a lost response', async () => {
  let lost = true;
  const env = client(body => {
    if (lost) { lost = false; throw new TypeError('Failed to fetch'); }
    return response({ ok: true, requestId: body.requestId, request: request({ id: 'pto_' + body.requestId.replaceAll('-', '') }) });
  });
  env.answers.push({ startDate: '2026-09-23', endDate: '2026-09-25', paid: 'yes', hoursPerDay: '7.5', reason: 'Family trip' });
  assert.equal(await env.pto.submitDialog('time_off', env.deps()), null);
  const dialog = env.dialogs[0];
  assert.equal(dialog.title, 'Request time off');
  assert.deepEqual(plain(dialog.fields.map(field => [field.name, field.type || 'text', field.required !== false])), [['startDate', 'date', true], ['endDate', 'date', true], ['paid', 'select', true], ['hoursPerDay', 'number', false], ['reason', 'text', false]]);
  const first = env.calls[0];
  assert.equal(first.url, '/api/employee-pto'); assert.equal(first.init.method, 'POST'); assert.equal(first.init.headers['Content-Type'], 'application/json');
  assert.match(first.body.requestId, UUID);
  assert.deepEqual({ ...first.body, requestId: undefined }, { action: 'request', requestId: undefined, type: 'time_off', startDate: '2026-09-23', endDate: '2026-09-25', reason: 'Family trip', paid: true, hoursPerDay: 7.5 });
  assert.deepEqual(plain(env.pto.pending()), first.body); assert.equal(env.toasts.at(-1), 'Failed to fetch'); assert.equal(env.saved.at(-1), null);
  env.answers.push({ startDate: '2026-10-01', endDate: '2026-10-01', paid: 'no', reason: '' });
  await env.pto.submitDialog('time_off', env.deps());
  assert.equal(env.calls.length, 1); assert.match(env.toasts.at(-1), /has not been confirmed/);
  const retried = await env.pto.retryPending(env.deps());
  assert.deepEqual(env.calls[1].body, first.body); assert.equal(retried.request.status, 'pending'); assert.equal(env.pto.pending(), null); assert.equal(env.saved.at(-1).id, retried.request.id);
  env.answers.push({ startDate: '2026-10-01', endDate: '', paid: 'yes', hoursPerDay: '7.3', reason: '' });
  await env.pto.submitDialog('time_off', env.deps());
  assert.equal(env.calls.length, 2); assert.match(env.toasts.at(-1), /quarter hours/);
  env.answers.push({ startDate: '2026-10-02', endDate: '', reason: 'Swap Friday' });
  await env.pto.submitDialog('shift_change', env.deps());
  assert.deepEqual({ ...env.calls[2].body, requestId: undefined }, { action: 'request', requestId: undefined, type: 'shift_change', startDate: '2026-10-02', endDate: '2026-10-02', reason: 'Swap Friday' });
  assert.equal(env.dialogs.at(-1).fields.find(field => field.name === 'reason').required, true);
});

test('manager approval confirms the paid total, lists assigned work and needs an explicit second confirmation', async () => {
  const env = client((body, count) => count === 1
    ? response({ ok: false, code: 'crew_availability_assignment_conflict', error: 'This employee is assigned to work during this time off.', details: { acknowledgeable: true, conflicts: [{ jobId: 'job-1', date: '2026-09-23', time: '09:00', label: 'Synthetic Customer' }] } }, 409)
    : response({ ok: true, requestId: body.requestId, request: request({ status: 'approved' }), warnings: [{ code: 'availability_conflicts' }] }), 'ZacB');
  env.answers.push({ paid: 'yes', hoursPerDay: '6', paidDays: 'weekdays' }, {}, {});
  const result = await env.pto.reviewDialog(request(), 'approved', env.deps(true));
  const [approve, total, conflict] = env.dialogs;
  assert.equal(approve.title, 'Approve time off for Crew One?'); assert.match(approve.copy, /3 days\./); assert.equal(approve.fields[0].value, 'yes'); assert.equal(approve.fields[1].value, '8');
  assert.deepEqual(plain(approve.fields.map(field => field.name)), ['paid', 'hoursPerDay', 'paidDays']);
  assert.deepEqual(plain(approve.fields[2].options), [{ value: 'weekdays', label: 'Every requested day (3 days)' }, { value: 'custom', label: 'Pick the paid days one by one' }]);
  assert.equal(total.title, 'Approve 18 paid hours for Crew One?'); assert.equal(total.copy, '3 paid days × 6 hours = 18 hours for 2026-09-23 – 2026-09-25. Paid: Wed Sep 23, Thu Sep 24, Fri Sep 25. These hours go on the timesheet.');
  assert.match(conflict.copy, /2026-09-23 09:00 Synthetic Customer/); assert.equal(conflict.confirmLabel, 'Approve anyway'); assert.equal(conflict.danger, true);
  const [first, second] = env.calls.map(call => call.body);
  assert.deepEqual({ ...first, requestId: undefined }, { action: 'approve', requestId: undefined, id: 'pto_1', paid: true, hoursPerDay: 6, paidDates: ['2026-09-23', '2026-09-24', '2026-09-25'] });
  assert.notEqual(second.requestId, first.requestId); assert.equal(second.acknowledgeConflicts, true); assert.equal(second.hoursPerDay, 6); assert.deepEqual(second.paidDates, first.paidDates);
  assert.equal(result.request.status, 'approved'); assert.match(env.toasts.at(-1), /Reassign the affected jobs/); assert.equal(env.pto.pending(), null);
  // Declining the paid total or the conflict confirmation sends nothing more.
  const declined = client(() => response({ ok: false, code: 'crew_availability_assignment_conflict', error: 'Assigned', details: { acknowledgeable: true, conflicts: [] } }, 409), 'ZacB');
  declined.answers.push({ paid: 'yes', hoursPerDay: '8', paidDays: 'weekdays' }, null);
  assert.equal(await declined.pto.reviewDialog(request(), 'approved', declined.deps(true)), null); assert.equal(declined.calls.length, 0);
  declined.answers.push({ paid: 'no' });
  assert.equal(await declined.pto.reviewDialog(request(), 'approved', declined.deps(true)), null); assert.equal(declined.calls.length, 1);
  assert.deepEqual({ ...declined.calls[0].body, requestId: undefined }, { action: 'approve', requestId: undefined, id: 'pto_1', paid: false });
});

test('paid days default to the requested weekdays; the manager can add or remove any day, weekends included, and sees them before confirming', async () => {
  const env = client(body => response({ ok: true, requestId: body.requestId, request: request({ status: 'approved' }), warnings: [] }), 'ZacB');
  const weekend = request({ startDate: '2026-09-25', endDate: '2026-09-28' }), bodies = () => env.calls.map(call => call.body);
  env.answers.push({ paid: 'yes', hoursPerDay: '8', paidDays: 'weekdays' }, {});
  await env.pto.reviewDialog(weekend, 'approved', env.deps(true));
  const choice = env.dialogs[0].fields.find(field => field.name === 'paidDays');
  assert.match(env.dialogs[0].copy, /4 days, 2 on weekdays/); assert.equal(choice.value, 'weekdays'); assert.equal(choice.required, false);
  assert.deepEqual(plain(choice.options), [{ value: 'weekdays', label: 'Weekdays only (2 days)' }, { value: 'all', label: 'Every day, weekends included (4 days)' }, { value: 'custom', label: 'Pick the paid days one by one' }]);
  assert.equal(env.dialogs[1].title, 'Approve 16 paid hours for Crew One?');
  assert.equal(env.dialogs[1].copy, '2 paid days × 8 hours = 16 hours for 2026-09-25 – 2026-09-28. Paid: Fri Sep 25, Mon Sep 28. Not paid: Sat Sep 26, Sun Sep 27. These hours go on the timesheet.');
  assert.deepEqual(bodies()[0].paidDates, ['2026-09-25', '2026-09-28']);
  env.answers.push({ paid: 'yes', hoursPerDay: '4', paidDays: 'all' }, {});
  await env.pto.reviewDialog(weekend, 'approved', env.deps(true));
  assert.equal(env.dialogs[3].confirmLabel, 'Approve 16 paid hours'); assert.deepEqual(bodies()[1].paidDates, ['2026-09-25', '2026-09-26', '2026-09-27', '2026-09-28']);
  // One by one: weekdays start paid and weekend days unpaid; the summary lists exactly what the manager chose.
  env.answers.push({ paid: 'yes', hoursPerDay: '8', paidDays: 'custom' }, { 'day-2026-09-25': 'unpaid', 'day-2026-09-26': 'paid', 'day-2026-09-27': 'unpaid', 'day-2026-09-28': 'paid' }, {});
  await env.pto.reviewDialog(weekend, 'approved', env.deps(true));
  const [pick, sum] = env.dialogs.slice(5);
  assert.equal(pick.title, 'Choose the paid days for Crew One');
  assert.deepEqual(plain(pick.fields.map(field => [field.name, field.label, field.value])), [['day-2026-09-25', 'Fri Sep 25', 'paid'], ['day-2026-09-26', 'Sat Sep 26', 'unpaid'], ['day-2026-09-27', 'Sun Sep 27', 'unpaid'], ['day-2026-09-28', 'Mon Sep 28', 'paid']]);
  assert.deepEqual(plain(pick.fields[0].options), [{ value: 'paid', label: 'Paid, 8 hours' }, { value: 'unpaid', label: 'Not paid' }]);
  assert.match(sum.copy, /^2 paid days × 8 hours = 16 hours for 2026-09-25 – 2026-09-28\. Paid: Sat Sep 26, Mon Sep 28\. Not paid: Fri Sep 25, Sun Sep 27\./);
  assert.deepEqual(bodies()[2].paidDates, ['2026-09-26', '2026-09-28']);
  // No paid day chosen, or the choice left open, sends nothing; unpaid time off needs no paid days.
  env.answers.push({ paid: 'yes', hoursPerDay: '8', paidDays: 'custom' }, { 'day-2026-09-25': 'unpaid', 'day-2026-09-26': 'unpaid', 'day-2026-09-27': 'unpaid', 'day-2026-09-28': 'unpaid' });
  assert.equal(await env.pto.reviewDialog(weekend, 'approved', env.deps(true)), null); assert.equal(env.calls.length, 3); assert.equal(env.toasts.at(-1), 'Choose which days are paid, or approve the time off as unpaid.');
  const onlyWeekend = request({ startDate: '2026-09-26', endDate: '2026-09-27' }), dialogs = env.dialogs.length;
  env.answers.push({ paid: 'yes', hoursPerDay: '8', paidDays: '' });
  assert.equal(await env.pto.reviewDialog(onlyWeekend, 'approved', env.deps(true)), null); assert.equal(env.calls.length, 3);
  assert.deepEqual(plain(env.dialogs[dialogs].fields.find(field => field.name === 'paidDays').options), [{ value: '', label: 'Choose the paid days' }, { value: 'all', label: 'Every day, weekends included (2 days)' }, { value: 'custom', label: 'Pick the paid days one by one' }]);
  assert.equal(env.dialogs[dialogs].fields.find(field => field.name === 'paidDays').value, '');
  env.answers.push({ paid: 'no', paidDays: '' });
  await env.pto.reviewDialog(onlyWeekend, 'approved', env.deps(true));
  assert.deepEqual({ ...bodies()[3], requestId: undefined }, { action: 'approve', requestId: undefined, id: 'pto_1', paid: false });
  env.answers.push({ paid: 'yes', hoursPerDay: '8', paidDays: 'all' }, {});
  await env.pto.reviewDialog(onlyWeekend, 'approved', env.deps(true));
  assert.equal(env.dialogs.at(-1).copy, '2 paid days × 8 hours = 16 hours for 2026-09-26 – 2026-09-27. Paid: Sat Sep 26, Sun Sep 27. These hours go on the timesheet.'); assert.deepEqual(bodies()[4].paidDates, ['2026-09-26', '2026-09-27']);
  // A single weekday needs no choice; a single weekend day is paid only when the manager picks it.
  env.answers.push({ paid: 'yes', hoursPerDay: '8' }, {});
  await env.pto.reviewDialog(request({ startDate: '2026-09-23', endDate: '2026-09-23' }), 'approved', env.deps(true));
  assert.equal(env.dialogs.at(-2).fields.some(field => field.name === 'paidDays'), false); assert.deepEqual(bodies()[5].paidDates, ['2026-09-23']);
  env.answers.push({ paid: 'yes', hoursPerDay: '8', paidDays: '' });
  assert.equal(await env.pto.reviewDialog(request({ startDate: '2026-09-26', endDate: '2026-09-26' }), 'approved', env.deps(true)), null);
  assert.deepEqual(plain(env.dialogs.at(-1).fields.find(field => field.name === 'paidDays').options), [{ value: '', label: 'Choose the paid days' }, { value: 'all', label: 'Every day, weekends included (1 day)' }]);
  assert.equal(env.calls.length, 6);
});

test('older approvals show the hours payroll pays: a manager-set paidHoursPerDay, and workflow fields only when a workflow decision set them', async () => {
  const env = client(() => response({ ok: false, code: 'pto_unavailable', error: 'Unavailable' }, 503), 'ZacB'), host = new FakeElement('div');
  const older = { id: 'request-older', type: 'time_off', employee: 'crew.one', employeeName: 'Crew One', startDate: '2026-09-25', endDate: '2026-09-28', status: 'approved', reviewedBy: 'zacb', reviewedAt: '2026-09-15T10:00:00.000Z', paidHoursPerDay: 8, createdAt: '2026-09-02T00:00:00.000Z' };
  const crafted = { ...older, paidHoursPerDay: undefined, paid: true, hoursPerDay: 12, paidHours: 60 };
  const rows = [older, { ...older, id: 'request-weekends', paidWeekends: true, createdAt: '2026-09-01T00:00:00.000Z' }, { ...older, ...approval(), paid: false, id: 'request-both', createdAt: '2026-08-31T00:00:00.000Z' }, { ...older, id: 'request-ended', endedEarlyFrom: '2026-09-26', createdAt: '2026-08-30T00:00:00.000Z' },
    // Pay fields no workflow decision set: payroll pays only the manager-set paidHoursPerDay, or nothing.
    { ...crafted, id: 'request-unbound', paidHoursPerDay: 8, createdAt: '2026-08-29T00:00:00.000Z' }, { ...crafted, id: 'request-crafted', decisions: [{ action: 'approve', status: 'approved', by: 'zacb', at: '2026-09-01T00:00:00.000Z' }], createdAt: '2026-08-28T00:00:00.000Z' },
    // A server projection has applied the rule already.
    { ...crafted, id: 'request-projected', paid: true, paidHours: 16, payModel: 'legacy', createdAt: '2026-08-27T00:00:00.000Z' }];
  env.pto.mount(host, { rows, manager: true, today: '2026-09-22', owned: () => false });
  assert.deepEqual(cards(host).map(card => [card.id, (card.text.match(/Paid (\d+) h/) || [])[1] || '']), [['request-older', '16'], ['request-weekends', '32'], ['request-both', ''], ['request-ended', '8'], ['request-unbound', '16'], ['request-crafted', ''], ['request-projected', '16']]);
  env.answers.push({ note: '' });
  await env.pto.cancelDialog(older, env.deps(true));
  assert.match(env.dialogs[0].copy, /its 16 paid hours are removed from the timesheet/);
});

test('approving an older request that carries a manager-set paidHoursPerDay starts from the pay the board shows, before and after a refresh', async () => {
  const env = client(body => response({ ok: true, requestId: body.requestId, request: request({ ...approval(), id: body.id }) }), 'ZacB'), host = new FakeElement('div');
  const older = request({ id: 'request-older', paid: undefined, hoursPerDay: undefined, paidHours: undefined, startDate: '2026-09-25', endDate: '2026-09-28', paidHoursPerDay: 8, paidWeekends: true });
  // The same record as the server projects it once a change has refreshed the row.
  const projected = { ...older, paidHoursPerDay: undefined, paidWeekends: undefined, paid: true, hoursPerDay: 8, paidHours: 32, payModel: 'legacy', paidDays: ['2026-09-25', '2026-09-26', '2026-09-27', '2026-09-28'].map(date => ({ date, hours: 8 })) };
  env.pto.mount(host, { rows: [older], manager: true, today: '2026-09-22', owned: () => false });
  assert.match(cards(host)[0].text, /Paid 32 h/);
  for (const row of [older, projected]) {
    env.answers.push({ paid: 'yes', hoursPerDay: '8', paidDays: 'all' }, {});
    await env.pto.reviewDialog(row, 'approved', env.deps(true));
    const [first, total] = env.dialogs.slice(-2);
    assert.deepEqual(plain(first.fields.map(field => [field.name, field.value])), [['paid', 'yes'], ['hoursPerDay', '8'], ['paidDays', 'all']]);
    assert.equal(total.title, 'Approve 32 paid hours for Crew One?');
    assert.deepEqual({ ...env.calls.at(-1).body, requestId: undefined }, { action: 'approve', requestId: undefined, id: 'request-older', paid: true, hoursPerDay: 8, paidDates: ['2026-09-25', '2026-09-26', '2026-09-27', '2026-09-28'] });
  }
  // Without paidWeekends the weekdays are preset; hours the workflow cannot pay must be changed before approving.
  env.answers.push(null);
  await env.pto.reviewDialog({ ...older, paidWeekends: undefined }, 'approved', env.deps(true));
  assert.equal(env.dialogs.at(-1).fields.find(field => field.name === 'paidDays').value, 'weekdays');
  env.answers.push({ paid: 'yes', hoursPerDay: '16', paidDays: 'weekdays' });
  await env.pto.reviewDialog({ ...older, paidHoursPerDay: 16 }, 'approved', env.deps(true));
  assert.deepEqual(plain(env.dialogs.at(-1).fields.slice(0, 2).map(field => field.value)), ['yes', '16']);
  assert.match(env.toasts.at(-1), /quarter hours/); assert.equal(env.calls.length, 2);
});

test('a manager changes what approved time off pays, sees the hours it replaces, and the schedule is untouched', async () => {
  const env = client(body => response({ ok: true, requestId: body.requestId, request: request({ ...approval(), id: body.id, paid: body.paid, paidHours: body.paid ? body.paidDates.length * body.hoursPerDay : 0 }) }), 'ZacB');
  const trip = request({ ...approval(), startDate: '2026-09-25', endDate: '2026-09-28', paid: false, hoursPerDay: null, paidDates: [], paidHours: 0 }), bodies = () => env.calls.map(call => ({ ...call.body, requestId: undefined }));
  assert.equal(await env.pto.payDialog(trip, env.deps(false)), null); assert.equal(await env.pto.payDialog(request(), env.deps(true)), null); assert.equal(env.dialogs.length, 0);
  env.answers.push({ paid: 'yes', hoursPerDay: '6', paidDays: 'custom', note: 'Approved as paid' }, { 'day-2026-09-25': 'paid', 'day-2026-09-26': 'paid', 'day-2026-09-27': 'unpaid', 'day-2026-09-28': 'unpaid' }, {});
  const result = await env.pto.payDialog(trip, env.deps(true, '2026-09-30'));
  const [first, pick, total] = env.dialogs;
  assert.deepEqual([first.kicker, first.title, first.copy, first.confirmLabel], ['CHANGE PAY', 'Change pay for Crew One?', '2026-09-25 – 2026-09-28. Paid now: 0 hours. The schedule does not change.', 'Review pay']);
  assert.deepEqual(plain(first.fields.map(field => [field.name, field.value ?? ''])), [['paid', 'no'], ['hoursPerDay', '8'], ['paidDays', 'weekdays'], ['note', '']]);
  assert.match(pick.copy, /The schedule does not change\.$/); assert.equal(pick.note, 'Nothing is saved until you confirm the paid hours.');
  assert.deepEqual([total.title, total.confirmLabel], ['Save 12 paid hours for Crew One?', 'Save 12 paid hours']);
  assert.equal(total.copy, '2 paid days × 6 hours = 12 hours for 2026-09-25 – 2026-09-28. Paid: Fri Sep 25, Sat Sep 26. Not paid: Sun Sep 27, Mon Sep 28. They replace the 0 paid hours on the timesheet now. If payroll for these days was already exported, correct it there too.');
  assert.deepEqual(bodies()[0], { action: 'amend', requestId: undefined, id: 'pto_1', paid: true, hoursPerDay: 6, paidDates: ['2026-09-25', '2026-09-26'], note: 'Approved as paid' });
  assert.match(env.calls[0].body.requestId, UUID); assert.equal(result.request.paidHours, 12); assert.equal(env.toasts.at(-1), 'Pay saved: 12 paid hours'); assert.equal(env.pto.pending(), null);
  // The dialogs start from what it pays now; making it unpaid needs its own confirmation.
  const paid = { ...trip, paid: true, hoursPerDay: 6, paidDates: ['2026-09-25', '2026-09-26'], paidHours: 12 }, seen = env.dialogs.length;
  env.answers.push({ paid: 'yes', hoursPerDay: '6', paidDays: 'custom' }, null);
  await env.pto.payDialog(paid, env.deps(true));
  assert.deepEqual(plain(env.dialogs[seen].fields.slice(0, 3).map(field => field.value)), ['yes', '6', 'custom']); assert.match(env.dialogs[seen].copy, /Paid now: 12 hours/);
  assert.deepEqual(plain(env.dialogs[seen + 1].fields.map(field => field.value)), ['paid', 'paid', 'unpaid', 'unpaid']); assert.equal(env.calls.length, 1);
  env.answers.push({ paid: 'no', note: '' }, null);
  await env.pto.payDialog(paid, env.deps(true));
  assert.deepEqual([env.dialogs.at(-1).title, env.dialogs.at(-1).confirmLabel], ['Make this time off unpaid for Crew One?', 'Make unpaid']);
  assert.equal(env.dialogs.at(-1).copy, '2026-09-25 – 2026-09-28. Its 12 paid hours are removed from the timesheet. If payroll for these days was already exported, correct it there too.'); assert.equal(env.calls.length, 1);
  env.answers.push({ paid: 'no', note: '' }, {});
  await env.pto.payDialog(paid, env.deps(true));
  assert.deepEqual(bodies()[1], { action: 'amend', requestId: undefined, id: 'pto_1', paid: false });
  // After an early end only the days before the first day back can be paid; dates that need review can only be made unpaid.
  env.answers.push({ paid: 'yes', hoursPerDay: '8', paidDays: 'weekdays' }, {});
  await env.pto.payDialog({ ...paid, endedEarlyFrom: '2026-09-27' }, env.deps(true));
  assert.match(env.dialogs.at(-2).copy, /^2026-09-25 – 2026-09-28, back 2026-09-27\. Paid now: 12 hours\./);
  assert.deepEqual(plain(env.dialogs.at(-2).fields.find(field => field.name === 'paidDays').options.map(option => option.value)), ['weekdays', 'all', 'custom']);
  assert.deepEqual(bodies()[2].paidDates, ['2026-09-25']);
  const undated = request({ ...approval(), startDate: 'soon', endDate: '', paid: false, paidHours: 0 });
  env.answers.push({ paid: 'yes', hoursPerDay: '8' });
  assert.equal(await env.pto.payDialog(undated, env.deps(true)), null);
  assert.equal(env.toasts.at(-1), 'This time off has dates that need review, so it can only be made unpaid.'); assert.equal(env.calls.length, 3);
  env.answers.push({ paid: 'no' }, {});
  await env.pto.payDialog(undated, env.deps(true));
  assert.deepEqual(bodies()[3], { action: 'amend', requestId: undefined, id: 'pto_1', paid: false });
});

test('deny, cancel and end send notes; crew cannot open review or end; definitive rejections discard and sign-out clears the pending body', async () => {
  let status = 409, code = 'pto_not_pending';
  const env = client(body => status === 200 ? response({ ok: true, requestId: body.requestId, request: request({ status: body.action === 'deny' ? 'denied' : body.action === 'end' ? 'approved' : 'cancelled' }) }) : response({ ok: false, code, error: 'This request is already approved.' }, status), 'ZacB');
  assert.equal(await env.pto.reviewDialog(request(), 'approved', env.deps(false)), null); assert.equal(await env.pto.endDialog(request({ status: 'approved' }), env.deps(false)), null); assert.equal(env.dialogs.length, 0);
  env.answers.push({ note: 'Short staffed' });
  await env.pto.reviewDialog(request(), 'denied', env.deps(true));
  assert.deepEqual({ ...env.calls[0].body, requestId: undefined }, { action: 'deny', requestId: undefined, id: 'pto_1', note: 'Short staffed' });
  assert.equal(env.pto.pending(), null); assert.equal(env.toasts.at(-1), 'This request is already approved.');
  status = 503; env.answers.push({ note: '' });
  await env.pto.cancelDialog(request(approval()), env.deps(true));
  assert.equal(env.dialogs.at(-1).copy, '2026-09-23 – 2026-09-25. The approved time off is removed from the schedule and its 24 paid hours are removed from the timesheet.');
  assert.deepEqual({ ...env.calls[1].body, requestId: undefined }, { action: 'cancel', requestId: undefined, id: 'pto_1' });
  assert.equal(env.pto.pending().requestId, env.calls[1].body.requestId);
  env.events['egc:signout']();
  assert.equal(env.pto.pending(), null); assert.equal([...env.storage.values.keys()].some(key => key.startsWith('egc.pto.pending')), false);
  status = 503; env.answers.push({ note: '' }); await env.pto.cancelDialog(request(), env.deps(true));
  env.answers.push(null); await env.pto.discardPending(env.deps(true)); assert.ok(env.pto.pending());
  env.answers.push({}); await env.pto.discardPending(env.deps(true)); assert.equal(env.pto.pending(), null);
  // Another viewer on the same tab never sees this viewer's pending body.
  status = 503; env.answers.push({ note: '' }); await env.pto.cancelDialog(request(), env.deps(true));
  env.storage.setItem('egc_u', 'crew2'); assert.equal(env.pto.pending(), null); env.storage.setItem('egc_u', 'ZacB'); env.events['egc:signout']();
  // A permission refusal is final; a session or storage refusal keeps the body for the same retry.
  for (const [nextStatus, nextCode, kept] of [[403, 'pto_forbidden', false], [403, 'pto_employee_inactive', false], [403, undefined, true], [401, 'pto_sign_in_required', true], [429, undefined, true], [400, 'pto_invalid_dates', false]]) {
    status = nextStatus; code = nextCode; env.answers.push({ note: '' });
    await env.pto.cancelDialog(request(), env.deps(true));
    assert.equal(Boolean(env.pto.pending()), kept, `${nextStatus} ${nextCode}`); env.events['egc:signout']();
  }
  status = 200; env.answers.push({ endedEarlyFrom: '2026-09-24', note: 'Back early' });
  await env.pto.endDialog(request({ ...approval(), startDate: '2026-09-21' }), env.deps(true, '2026-09-23'));
  const end = env.dialogs.at(-1);
  assert.equal(end.title, 'End time off early for Crew One?'); assert.equal(end.fields[0].type, 'date'); assert.equal(end.fields[0].min, '2026-09-23'); assert.equal(end.fields[0].value, '2026-09-23'); assert.match(end.copy, /keep their paid hours/);
  assert.deepEqual({ ...env.calls.at(-1).body, requestId: undefined }, { action: 'end', requestId: undefined, id: 'pto_1', endedEarlyFrom: '2026-09-24', note: 'Back early' });
  assert.equal(env.toasts.at(-1), 'Time off ended early');
  // A confirmation for some other request does not verify this change: the body stays for the same retry.
  const mismatched = client(body => response({ ok: true, requestId: body.requestId, request: request({ id: 'pto_other' }) }), 'ZacB');
  mismatched.answers.push({ note: '' }); await mismatched.pto.cancelDialog(request(), mismatched.deps(true));
  assert.match(mismatched.toasts.at(-1), /could not be verified/); assert.equal(mismatched.pto.pending().requestId, mismatched.calls[0].body.requestId);
  mismatched.answers.push({ note: '' }); await mismatched.pto.reviewDialog(request(), 'denied', mismatched.deps(true)); assert.equal(mismatched.calls.length, 1);
});

test('the actions offered for each request mirror the server rules', () => {
  const { pto } = client(() => response({}));
  const mine = row => row.employee === 'crew.one', manager = { manager: true, today: '2026-09-24', owned: () => false }, crew = { manager: false, today: '2026-09-24', owned: mine };
  const rows = {
    pending: request(), approvedFuture: request({ status: 'approved', startDate: '2026-09-25', endDate: '2026-09-26' }), approvedToday: request({ status: 'approved', startDate: '2026-09-24', endDate: '2026-09-26' }),
    started: request({ status: 'approved', startDate: '2026-09-22', endDate: '2026-09-26' }), endedEarly: request({ status: 'approved', startDate: '2026-09-22', endDate: '2026-09-26', endedEarlyFrom: '2026-09-24' }),
    over: request({ status: 'approved', startDate: '2026-09-20', endDate: '2026-09-23' }), shift: request({ type: 'shift_change', status: 'approved', startDate: '2026-09-30' }),
    denied: request({ status: 'denied' }), cancelled: request({ status: 'canceled' }), legacy: request({ status: undefined, startDate: 'soon' }), badApproved: request({ status: 'approved', startDate: 'soon' }), other: request({ employee: 'crew2' }),
  };
  const offered = options => Object.fromEntries(Object.entries(rows).map(([name, row]) => [name, plain(pto.actionsFor(row, options))]));
  // Time off has started on its first day, so a manager ends it early from then on instead of cancelling it.
  // A manager can change what approved time off pays at any time, even after it ended or when its dates need review.
  assert.deepEqual(offered(manager), { pending: ['approve', 'deny', 'cancel'], approvedFuture: ['cancel', 'pay'], approvedToday: ['end', 'pay'], started: ['end', 'pay'], endedEarly: ['pay'], over: ['pay'], shift: ['cancel'], denied: [], cancelled: [], legacy: ['approve', 'deny', 'cancel'], badApproved: ['pay'], other: ['approve', 'deny', 'cancel'] });
  assert.deepEqual(offered(crew), { pending: ['cancel'], approvedFuture: ['cancel'], approvedToday: [], started: [], endedEarly: [], over: [], shift: [], denied: [], cancelled: [], legacy: ['cancel'], badApproved: [], other: [] });
  assert.deepEqual(plain(pto.actionsFor(rows.pending, { manager: true, today: 'soon' })), []);
});

test('the board renders requests with DOM nodes, disables actions while a change is in flight, and offers the unconfirmed retry', async () => {
  let release, lost = false;
  const env = client(body => {
    if (lost) { lost = false; throw new TypeError('Failed to fetch'); }
    return new Promise(resolve => { release = () => resolve(response({ ok: true, requestId: body.requestId, request: request({ id: body.id, status: 'approved', endedEarlyFrom: body.endedEarlyFrom }) })); });
  }, 'ZacB');
  const host = new FakeElement('div'), saved = [], toasts = [], answers = [], dialogs = [];
  const options = rows => ({ rows, manager: true, today: '2026-09-24', owned: () => false, toast: message => toasts.push(message), saved: row => saved.push(row), go: view => saved.push('go:' + view),
    askAction: async dialog => { dialogs.push(dialog); return answers.shift() ?? null; } });
  const rows = [request({ id: 'pto_old', createdAt: '2026-09-01T00:00:00.000Z', ...approval({ note: 'Enjoy <b>it</b>' }), startDate: '2026-09-22', endDate: '2026-09-26', paidHours: 40 }),
    request({ id: 'pto_new', createdAt: '2026-09-21T00:00:00.000Z' }), { id: 'legacy-1', type: 'shift_change', employee: 'Crew.Two', startDate: '2026-10-01', reason: '<img src=x>' }];
  env.pto.mount(host, options(rows));
  assert.deepEqual(cards(host).map(card => [card.id, card.actions]), [['pto_new', ['Approve', 'Deny', 'Cancel']], ['pto_old', ['End early', 'Edit pay']], ['legacy-1', ['Approve', 'Deny', 'Cancel']]]);
  assert.doesNotMatch(host.textContent, /null|undefined/); assert.equal(host.all().some(node => node.className === 'ops-pto-pending'), false);
  const [fresh, old, legacy] = cards(host);
  assert.match(legacy.text, /^SHIFT CHANGECrew\.Two2026-10-01 · <img src=x>pending/); assert.match(fresh.text, /Paid 24 h/); assert.match(old.text, /Paid 40 h · Note: Enjoy <b>it<\/b>/);
  assert.equal(host.all().some(node => node.tagName === 'IMG' || node.tagName === 'B'), false);
  assert.deepEqual(host.button('Request time off') && host.all().filter(node => node.className === 'ops-page-actions ops-request-actions')[0].buttons().map(button => button.textContent), ['Request time off', 'Open time-off calendar', 'Request shift change']);
  host.button('Open time-off calendar').click(); assert.equal(saved.at(-1), 'go:availability');
  answers.push({ endedEarlyFrom: '2026-09-25', note: '' });
  host.button('End early').click(); await tick();
  assert.equal(dialogs[0].kicker, 'END TIME OFF EARLY'); assert.equal(env.calls.length, 1);
  assert.ok(host.buttons().filter(button => button.textContent !== 'Open time-off calendar').every(button => button.disabled)); assert.equal(host.all().find(node => node.className === 'ops-request-list').getAttribute('aria-busy'), 'true');
  host.button('Approve').click(); await tick(); assert.equal(dialogs.length, 1);
  release(); await tick(); await tick();
  assert.equal(toasts.at(-1), 'Time off ended early'); assert.equal(saved.at(-1).endedEarlyFrom, '2026-09-25');
  assert.ok(host.buttons().every(button => !button.disabled)); assert.equal(host.all().find(node => node.className === 'ops-request-list').getAttribute('aria-busy'), 'false');
  // A lost response leaves the frozen body: the board locks new changes and offers the same retry.
  lost = true; answers.push({ note: '' });
  host.button('Deny').click(); await tick(); await tick();
  const banner = host.all().find(node => node.className === 'ops-pto-pending');
  assert.equal(banner.getAttribute('role'), 'alert'); assert.equal(host.button('Request time off').disabled, true); assert.equal(host.button('Approve').disabled, true);
  const frozen = env.calls.at(-1).body;
  host.button('Retry original save').click(); await tick(); release(); await tick(); await tick();
  assert.deepEqual(env.calls.at(-1).body, frozen); assert.equal(host.all().some(node => node.className === 'ops-pto-pending'), false);
  env.pto.mount(host, options([]));
  assert.equal(cards(host).length, 0); assert.match(host.textContent, /No requests/);
  env.pto.mount(null); host.replaceChildren(); env.pto.mount(null, options(rows)); assert.equal(host.childNodes.length, 0);
});

function suite(route) {
  const events = {}, calls = [], main = { innerHTML: '', querySelector: () => null }, board = new FakeElement('div');
  const fetcher = async (url, init = {}) => { calls.push({ url: String(url), body: init.body ? JSON.parse(init.body) : null }); return route(String(url), init.body ? JSON.parse(init.body) : null); };
  const context = { console, URLSearchParams, Date: FixedDate, Intl, Promise, Set, Map, Error, Event, JSON, Number, String, Array, Object, AbortController, Node: FakeNode,
    crypto: { randomUUID }, navigator: {}, location: { pathname: '/employee', search: '' },
    sessionStorage: storage({ egc_u: 'ZacB', egc_business_access: 'true', egc_owner: 'true', egc_role: 'owner' }), localStorage: storage(),
    setInterval: () => 1, clearInterval() {}, setTimeout: () => 1, clearTimeout() {},
    addEventListener: (name, callback) => { events[name] = callback; }, dispatchEvent: event => events[event.type]?.(event),
    FormData: class { constructor(form) { this.form = form; } forEach(callback) { Object.entries(this.form.values).forEach(([key, value]) => callback(value, key)); } },
    showToast: message => { context.toast = message; }, me: 'ZacB', jobsCache: [], hubFetch: fetcher,
    db: { collection() { throw new Error('Unexpected browser database write'); } },
    document: fakeDocument({ readyState: 'complete', activeElement: null, body: { classList: { add() {}, remove() {}, toggle() {} } }, addEventListener() {}, querySelectorAll: () => [],
      getElementById: () => null, querySelector: selector => selector === '#ops-main' ? main : selector === '#ops-pto-board' && main.innerHTML.includes('id="ops-pto-board"') ? board : null }) };
  context.window = context;
  vm.runInNewContext(read('employee-pto.js'), context, { filename: 'employee-pto.js' });
  vm.runInNewContext(read('employee-suite.js').replace(/\}\)\(\);\s*$/, 'Object.assign(globalThis,{ui:{S,render}});})();'), context, { filename: 'employee-suite.js' });
  return { context, calls, main, board, ui: context.ui };
}
const collections = requests => ({ profiles: [], timeEntries: [], announcements: [], requests, incidents: [], equipment: [], training: [], teamMessages: [], jobMessages: [], messageReads: [] });
const submit = (env, values) => env.context.opsActionSubmit({ preventDefault() {}, currentTarget: { values } });

test('the requests view mounts the board and approves time off through the workflow API, never a browser database write', async () => {
  const legacy = request({ id: 'legacy-1', type: 'shift_change', employeeName: undefined, employee: 'Crew.Two', status: undefined, paid: undefined, paidHours: undefined });
  let saved = request();
  const env = suite((url, body) => url === '/api/employee-pto'
    ? response({ ok: true, requestId: body.requestId, request: body.action === 'approve' ? (saved = request({ status: 'approved', paidHours: 24 })) : { ...legacy, status: 'denied' }, warnings: [] })
    : url.startsWith('/api/employee-hub') ? response({ ok: true, collections: collections([saved, legacy]) }) : response({ ok: true, accounts: [] }));
  Object.assign(env.ui.S, { active: 'requests' }); Object.assign(env.ui.S.peopleState, { loaded: true, loading: false, error: '' });
  env.ui.S.people.requests = [request(), legacy];
  env.ui.render(); await tick();
  assert.match(env.main.innerHTML, /<div id="ops-pto-board"><\/div>/); assert.doesNotMatch(env.main.innerHTML, /Family trip/);
  assert.deepEqual(cards(env.board).map(card => card.actions), [['Approve', 'Deny', 'Cancel'], ['Approve', 'Deny', 'Cancel']]);
  env.board.all().filter(node => node.tagName === 'ARTICLE').find(node => node.getAttribute('data-request-id') === 'pto_1').button('Approve').click(); await tick();
  assert.equal(env.ui.S.actionDialog.title, 'Approve time off for Crew One?');
  submit(env, { paid: 'yes', hoursPerDay: '8', paidDays: 'weekdays' }); await tick();
  assert.equal(env.ui.S.actionDialog.title, 'Approve 24 paid hours for Crew One?'); assert.match(env.ui.S.actionDialog.copy, /Paid: Wed Sep 23, Thu Sep 24, Fri Sep 25\./);
  submit(env, {}); await tick(); await tick(); await tick();
  const post = env.calls.find(call => call.url === '/api/employee-pto');
  assert.deepEqual({ ...post.body, requestId: undefined }, { action: 'approve', requestId: undefined, id: 'pto_1', paid: true, hoursPerDay: 8, paidDates: ['2026-09-23', '2026-09-24', '2026-09-25'] }); assert.match(post.body.requestId, UUID);
  assert.equal(env.calls.filter(call => call.url.startsWith('/api/employee-hub') && call.body).length, 0);
  assert.equal(env.ui.S.people.requests.find(row => row.id === 'pto_1').status, 'approved'); assert.equal(env.context.toast, 'Request approved');
  assert.deepEqual(cards(env.board).find(card => card.id === 'pto_1').actions, ['Cancel', 'Edit pay']);
  // The older global entry point opens the same reviewed workflow.
  env.context.opsReviewRequest('legacy-1', 'denied'); await tick();
  assert.equal(env.ui.S.actionDialog.title, 'Deny shift change for Crew.Two?');
  submit(env, { note: 'Short staffed' }); await tick(); await tick();
  assert.deepEqual({ ...env.calls.filter(call => call.url === '/api/employee-pto').at(-1).body, requestId: undefined }, { action: 'deny', requestId: undefined, id: 'legacy-1', note: 'Short staffed' });
});

test('the suite no longer writes time-off blocks or request records from the browser', () => {
  const suiteSource = read('employee-suite.js'), page = read('employee.html');
  assert.doesNotMatch(suiteSource, /-pto`|availability-\$\{personKey/);
  assert.doesNotMatch(suiteSource, /peopleSet\(peopleCollections\.requests/);
  assert.match(suiteSource, /function requestsBoard\(\)\{[^\n]*window\.EGCPto\?\.mount\(\$\('#ops-pto-board'\),ptoOptions\(\)\)/);
  const pto = page.indexOf('employee-pto.js?v='), suiteTag = page.indexOf('employee-suite.js?v=');
  assert.ok(pto > 0 && pto < suiteTag); assert.match(page, /employee-pto\.css\?v=/);
  assert.doesNotMatch(read('employee-pto.js'), /innerHTML|insertAdjacentHTML|outerHTML/);
});
