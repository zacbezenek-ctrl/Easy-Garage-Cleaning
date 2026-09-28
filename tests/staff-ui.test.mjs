import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createDocument, storage, hubPage, FixedDate } from './helpers/hub-dom.mjs';
import { staffEnv, cookieFor, ORIGIN } from './helpers/vault-fixture.mjs';
import { staffDirectoryHandlers } from '../functions/api/staff-directory.js';
import * as hubAuth from '../functions/api/hub-auth.js';
import { listHubUserProfiles } from '../functions/_lib/hub-session.js';
import { ROLE_CAPABILITIES, STAFF_CAPABILITIES, STAFF_ROLES } from '../functions/_lib/staff-roles.js';
import { SKILL_CATALOG, SKILL_CATALOG_VERSION, SKILL_LEVELS } from '../functions/_lib/staff-skills.js';
import { WEEK_DAYS } from '../functions/_lib/staff-directory.js';

const source = readFileSync(new URL('../employee-staff.js', import.meta.url), 'utf8');
const NOW = '2026-09-22T18:00:00.000Z', TODAY = '2026-09-22';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MANAGER = [...ROLE_CAPABILITIES.manager];
const settle = async () => { for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve)); };
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }

const rate = (effectiveFrom, hourlyRate, extra = {}) => ({ effectiveFrom, hourlyRate, payType: 'hourly', overtimeMultiplier: 1.5, setBy: 'zacb', setAt: '2026-09-01T15:00:00.000Z', ...extra });
const person = (username, overrides = {}) => ({
  username, displayName: `Synthetic ${username}`, source: 'employee_account', accountStatus: 'approved', staffRoles: ['crew'], staffRolesSource: 'account', primaryRole: 'crew',
  skills: [], weeklyAvailability: null, weeklyAvailabilityNeedsReview: false,
  pay: { current: { hourlyRate: 21, payType: 'hourly', overtimeMultiplier: 1.5, effectiveFrom: '2026-09-01', source: 'pay_rates', drift: false }, upcoming: [], schedule: [rate('2000-01-01', 20), rate('2026-09-01', 21)], needsReview: false },
  history: [], revision: `rev-${username}-1`, profileNeedsReview: false, ...overrides,
});
const directory = (people = [person('Zoe.Phone')], viewer = { user: 'ZacB', capabilities: [...STAFF_CAPABILITIES] }) => ({
  ok: true, authority: 'employee_hub', timeZone: 'America/Denver', today: TODAY, viewer,
  catalog: { version: SKILL_CATALOG_VERSION, skills: SKILL_CATALOG, levels: SKILL_LEVELS, roles: STAFF_ROLES, days: WEEK_DAYS },
  people, coverage: { complete: true, asOf: NOW },
});

// DOM helpers over tests/helpers/hub-dom.mjs (attribute values with spaces are matched in JS, not in selectors).
const all = (root, selector) => root.querySelectorAll(selector);
const buttonText = (root, text) => all(root, 'button').find(node => node.textContent.trim() === text);
const buttonLabel = (root, label) => all(root, 'button').find(node => node.getAttribute('aria-label') === label);
const cardFor = (root, username) => all(root, 'article').find(node => node.getAttribute('data-username') === username);
const named = (root, name) => all(root, 'input,select,textarea').find(node => node.getAttribute('name') === name);
const click = node => { assert.ok(node, 'the control is on screen'); node.click(); };
const change = (node, value, type = 'input') => { assert.ok(node, 'the field is on screen'); node.value = value; node.dispatchEvent({ type }); };
const toggle = (node, checked) => { assert.ok(node, 'the checkbox is on screen'); node.checked = checked; node.dispatchEvent({ type: 'change' }); };
const submit = root => { const form = root.querySelector('form.st-editor'); assert.ok(form, 'an editor is open'); form.dispatchEvent({ type: 'submit', preventDefault() {} }); };
const disabled = node => node.hasAttribute('disabled');
const checkbox = (root, role) => all(root, 'input').find(node => node.type === 'checkbox' && node.value === role);

// EGCStaff in a vm with a small DOM, a routed Hub fetch and injected timers (the real clock is never read).
function staffUi({ capabilities = ['crew', 'business', 'owner'], identity = 'ZacB', session = {}, get, post, ignoreAbort = false } = {}) {
  const document = createDocument(), events = {}, calls = [], toasts = [], timers = [];
  const state = { get: get || (async () => ({ body: directory() })), post: post || (async body => ({ body: { ok: true, authority: 'employee_hub', person: person(body.username, { revision: `rev-${body.username}-2` }) } })) };
  const context = {
    console, Intl, Promise, Set, Map, Error, JSON, Object, Array, Math, Number, String, Symbol, AbortController, crypto, Date: FixedDate, document,
    sessionStorage: storage(session), setTimeout: (callback, delay) => { timers.push({ callback, delay }); return timers.length; }, clearTimeout() {},
    addEventListener: (name, listener) => { (events[name] ||= []).push(listener); },
    fetch: async () => { throw new Error('the injected Hub fetch is always used'); },
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(source, context, { filename: 'employee-staff.js' });
  const host = document.createElement('div');
  document.body.append(host);
  const hubFetch = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ url, method: init.method || 'GET', body, headers: init.headers });
    // Like fetch, an aborted request rejects even when the server never answers (ignoreAbort models a fetch that answers anyway).
    const aborted = new Promise((resolve, reject) => { if (!ignoreAbort) init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' })), { once: true }); });
    const result = await Promise.race([body ? state.post(body) : state.get(url), aborted]);
    if (result instanceof Error) throw result;
    return { ok: (result.status || 200) < 400, status: result.status || 200, json: async () => structuredClone(result.body) };
  };
  const ctx = { identity, capabilities, hubFetch, toast: text => toasts.push(text) };
  return {
    context, document, host, calls, toasts, timers, events, state, session: context.sessionStorage,
    mount: (target = host, extra = {}) => context.EGCStaff.mount(target, { ...ctx, ...extra }),
    fire: name => (events[name] || []).forEach(listener => listener({ type: name })),
    gets: () => calls.filter(call => call.method === 'GET'), posts: () => calls.filter(call => call.method === 'POST'),
    text: () => host.textContent,
  };
}

test('the directory makes no requests for a crew viewer, even on refresh or with a saved change in the tab', async () => {
  const pending = { path: '/api/staff-directory', method: 'POST', requestId: '8f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b', kind: 'roles', label: 'Roles for Synthetic Zoe',
    body: { action: 'set_roles', requestId: '8f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b', username: 'Zoe.Phone', expectedRevision: 'rev', staffRoles: ['phone'] } };
  const ui = staffUi({ capabilities: ['crew'], identity: 'Synthetic.Crew', session: { 'egc.hub.pending.v1.staff.synthetic.crew': JSON.stringify(pending) } });
  ui.mount();
  await settle();
  await ui.context.EGCStaff.refresh();
  await settle();
  assert.equal(ui.calls.length, 0);
  assert.match(ui.text(), /Managers only/);
  assert.equal(buttonText(ui.host, 'Retry original save'), undefined, 'a crew viewer is never offered a staff save');
  assert.equal(buttonText(ui.host, 'Refresh'), undefined);
});

test('a failed or unverifiable load shows unavailable with Retry, never an empty roster', async () => {
  const cases = [
    [{ status: 503, body: { ok: false, code: 'staff_directory_unavailable', error: 'The staff directory could not be verified. Keep your request and retry the same change.' } }, /Staff directory unavailable/],
    [{ body: { ...directory(), coverage: { complete: false, asOf: NOW } } }, /Staff directory unavailable[\s\S]*incomplete/],
    [{ body: directory([{ ...person('Zoe.Phone'), revision: undefined }]) }, /Staff directory unavailable/],
    [{ body: directory([person('Zoe.Phone', { staffRoles: ['wizard'] })]) }, /Staff directory unavailable/],
    [{ body: { ok: true } }, /Staff directory unavailable/],
    [new TypeError('Failed to fetch'), /could not be reached/],
    [{ status: 503, body: { ok: false, code: 'staff_directory_not_enabled', error: 'The staff directory is not enabled yet.' } }, /turned off[\s\S]*EGC_STAFF_DIRECTORY_ENABLED/],
    [{ status: 403, body: { ok: false, code: 'staff_directory_forbidden', error: 'You can view only your own staff record.' } }, /access is limited[\s\S]*only your own staff record/],
  ];
  for (const [answer, expected] of cases) {
    const ui = staffUi({ get: async () => answer });
    ui.mount();
    await settle();
    assert.match(ui.text(), expected, JSON.stringify(answer.body || String(answer)));
    assert.doesNotMatch(ui.text(), /No active staff|0 people/);
    assert.equal(ui.host.querySelector('[role="alert"]') !== null, true, 'the failure is announced');
    assert.equal(ui.host.querySelectorAll('article').length, 0);
    ui.state.get = async () => ({ body: directory() });
    click(buttonText(ui.host, 'Retry'));
    await settle();
    assert.ok(cardFor(ui.host, 'Zoe.Phone'), 'Retry loads the directory');
    assert.match(ui.text(), /1 person · checked Sep 22, 2026/);
  }
});

test('a verified empty directory says so, and a later failed refresh hides the stale roster', async () => {
  const ui = staffUi({ get: async () => ({ body: directory([]) }) });
  ui.mount();
  await settle();
  assert.match(ui.text(), /No active staff yet/);
  ui.state.get = async () => ({ body: directory([person('Zoe.Phone')]) });
  await ui.context.EGCStaff.refresh();
  assert.ok(cardFor(ui.host, 'Zoe.Phone'));
  ui.state.get = async () => ({ status: 502, body: { ok: false, error: 'Bad gateway from the synthetic edge' } });
  await ui.context.EGCStaff.refresh();
  assert.equal(cardFor(ui.host, 'Zoe.Phone'), undefined, 'nothing stale is shown as current');
  assert.match(ui.text(), /Staff directory unavailable/);
});

test('responses arriving after sign-out are discarded and the saved change is cleared', async () => {
  const load = deferred(), ui = staffUi({ get: () => load.promise, ignoreAbort: true });
  ui.session.setItem('egc.hub.pending.v1.staff.zacb', '{}');
  ui.session.setItem('egc.hub.pending.v1.staff.tylerg', '{}');
  ui.session.setItem('egc_u', 'ZacB');
  ui.mount();
  await settle();
  assert.match(ui.text(), /Loading the staff directory/);
  ui.fire('egc:signout');
  ui.host.replaceChildren(ui.document.createTextNode('Signed out'));
  load.resolve({ body: directory([person('Private.Old', { displayName: 'PRIVATE OLD ROSTER' })]) });
  await settle();
  assert.equal(ui.host.textContent, 'Signed out');
  assert.doesNotMatch(ui.document.body.textContent, /PRIVATE OLD ROSTER/);
  assert.equal(ui.session.getItem('egc.hub.pending.v1.staff.zacb'), null);
  assert.equal(ui.session.getItem('egc.hub.pending.v1.staff.tylerg'), null);
  assert.equal(ui.session.getItem('egc_u'), 'ZacB', 'only the directory keys are the module\'s to clear');
  const nextLoad = deferred();
  ui.state.get = () => nextLoad.promise;
  ui.mount(ui.host, { identity: 'TylerG' });
  await settle();
  assert.match(ui.text(), /Loading the staff directory/, 'the next viewer starts from nothing');
  assert.doesNotMatch(ui.text(), /PRIVATE OLD ROSTER/);

  // A save answered after sign-out cannot restore the previous viewer's records either.
  const save = deferred(), next = staffUi({ post: () => save.promise });
  next.mount();
  await settle();
  click(buttonLabel(next.host, 'Edit skills for Synthetic Zoe.Phone'));
  change(named(next.host, 'skill_customer_phone'), 'lead', 'change');
  submit(next.host);
  await settle();
  assert.equal(next.posts().length, 1);
  next.fire('egc:signout');
  save.resolve({ body: { ok: true, person: person('Zoe.Phone', { displayName: 'PRIVATE SAVED PERSON' }) } });
  await settle();
  assert.doesNotMatch(next.document.body.textContent, /PRIVATE SAVED PERSON/);
  assert.equal(next.context.EGCStaff.canLeave(), true);
  next.mount(next.host, { identity: 'TylerG' });
  await settle();
  assert.equal(next.gets().length, 2, 'the next viewer loads their own directory');
  assert.equal(buttonText(next.host, 'Retry original save'), undefined);
});

test('an older load answering late cannot replace the newer directory', async () => {
  const first = deferred(), ui = staffUi({ get: () => first.promise, ignoreAbort: true });
  ui.mount();
  await settle();
  ui.state.get = async () => ({ body: directory([person('Current.Person', { displayName: 'CURRENT ROSTER' })]) });
  await ui.context.EGCStaff.refresh();
  first.resolve({ body: directory([person('Old.Person', { displayName: 'STALE ROSTER' })]) });
  await settle();
  assert.match(ui.text(), /CURRENT ROSTER/);
  click(buttonLabel(ui.host, 'Edit skills for CURRENT ROSTER'));
  assert.match(ui.text(), /CURRENT ROSTER/, 'the next render still draws the newer directory');
  assert.doesNotMatch(ui.text(), /STALE ROSTER/);
  // A load still in flight when the section is left is dropped too.
  const late = deferred();
  ui.state.get = () => late.promise;
  await Promise.race([ui.context.EGCStaff.refresh(), settle()]);
  ui.context.EGCStaff.unmount();
  late.resolve({ body: directory([person('Old.Person', { displayName: 'LEFT BEHIND' })]) });
  await settle();
  ui.state.get = () => new Promise(() => {});
  ui.mount();
  await settle();
  assert.doesNotMatch(ui.text(), /LEFT BEHIND/);
  assert.match(ui.text(), /Loading the staff directory/);
});

test('names, labels, reasons and history text render as text, never markup', async () => {
  const hostile = '<img src=x onerror=alert(1)>';
  const ui = staffUi({ get: async () => ({ body: {
    ...directory([person('Hostile.Name', { displayName: hostile, skills: [{ id: 'cleanout', level: 'lead', verifiedBy: hostile, verifiedAt: NOW }],
      history: [{ action: 'set_roles', scope: 'roles', actor: hostile, at: NOW, reason: `<script>${hostile}</script>`, changes: { before: { staffRoles: ['crew'] }, after: { staffRoles: ['phone'] } } }] })]),
    catalog: { version: SKILL_CATALOG_VERSION, skills: [{ id: 'cleanout', label: `<b onmouseover=alert(2)>Cleanout</b>` }], levels: SKILL_LEVELS },
  } }) });
  ui.mount();
  await settle();
  assert.equal(ui.host.querySelectorAll('img,b,script').length, 0, 'no element was created from data');
  assert.equal(ui.host.innerHTML, '', 'the host was never given an HTML string');
  const card = cardFor(ui.host, 'Hostile.Name');
  assert.equal(card.querySelector('h3').textContent, hostile);
  assert.match(card.textContent, /<b onmouseover=alert\(2\)>Cleanout<\/b> · Lead/);
  assert.match(card.querySelector('details').textContent, /Roles: Crew → Phone · calls and follow-ups/);
  assert.ok(card.querySelector('details').textContent.includes(`<script>${hostile}</script>`));
  assert.equal(card.querySelector('.st-avatar').textContent, '<');
});

test('edit controls follow the capabilities the server returned, and configured Hub users keep their configuration', async () => {
  const people = [person('Zoe.Phone'), person('TylerG', { source: 'configured', staffRolesSource: 'default', staffRoles: ['manager'], primaryRole: 'manager' }), person('Review.Me', { profileNeedsReview: true })];
  const owner = staffUi({ get: async () => ({ body: directory(people) }) });
  owner.mount();
  await settle();
  const labels = root => all(root, '.st-person-actions button').map(node => node.textContent);
  assert.deepEqual(labels(cardFor(owner.host, 'Zoe.Phone')), ['Edit roles', 'Edit skills', 'Change pay', 'Edit availability']);
  assert.deepEqual(labels(cardFor(owner.host, 'TylerG')), ['Edit skills', 'Edit availability'], 'roles and pay of configured users stay in the Hub configuration');
  assert.match(cardFor(owner.host, 'TylerG').textContent, /From the account role/);
  assert.equal(cardFor(owner.host, 'Review.Me').querySelector('.st-person-actions'), null, 'an ambiguous profile cannot be edited');
  assert.match(cardFor(owner.host, 'Review.Me').textContent, /unrecognized id/);

  // A manager without pay.manage or accounts.approve: no pay (the server omitted it) and no role or pay buttons.
  const manager = staffUi({ identity: 'TylerG', capabilities: ['crew', 'business'], get: async () => ({ body: directory([{ ...person('Zoe.Phone'), pay: undefined }, person('TylerG', { source: 'configured' })], { user: 'TylerG', capabilities: MANAGER }) }) });
  manager.mount();
  await settle();
  assert.deepEqual(labels(cardFor(manager.host, 'Zoe.Phone')), ['Edit skills', 'Edit availability']);
  assert.equal(cardFor(manager.host, 'Zoe.Phone').querySelector('.st-pay'), null);
  assert.ok(cardFor(manager.host, 'TylerG').querySelector('.st-pay'), 'a manager sees their own pay');

  // Pay awaiting review cannot be changed until the owner fixes the schedule; drift is flagged but changeable.
  const review = staffUi({ get: async () => ({ body: directory([
    person('Broken.Pay', { pay: { current: { hourlyRate: 20, payType: 'hourly', overtimeMultiplier: null, effectiveFrom: null, source: 'pay_rates_need_review', drift: false }, upcoming: [], schedule: [], needsReview: true } }),
    person('Drift.Pay', { pay: { current: { hourlyRate: 24, payType: 'hourly', overtimeMultiplier: null, effectiveFrom: null, source: 'legacy_profile_edit', drift: true }, upcoming: [], schedule: [rate('2000-01-01', 20)], needsReview: true } }),
  ]) }) });
  review.mount();
  await settle();
  assert.ok(!labels(cardFor(review.host, 'Broken.Pay')).includes('Change pay'));
  assert.match(cardFor(review.host, 'Broken.Pay').textContent, /needs owner review/);
  assert.ok(labels(cardFor(review.host, 'Drift.Pay')).includes('Change pay'));
  assert.match(cardFor(review.host, 'Drift.Pay').textContent, /outside the dated schedule/);
});

test('role chips, skills, dated pay history and the week render from the directory', async () => {
  const ui = staffUi({ get: async () => ({ body: directory([person('Zoe.Phone', {
    staffRoles: ['crew', 'phone'], primaryRole: 'phone', skills: [{ id: 'customer_phone', level: 'lead', verifiedBy: 'zacb', verifiedAt: NOW }, { id: 'old_skill', level: 'trainee', verifiedBy: '', verifiedAt: '', retired: true }],
    weeklyAvailability: { mon: [{ start: '08:00', end: '12:00' }, { start: '13:00', end: '17:30' }], tue: [], wed: [{ start: '18:00', end: '24:00' }], thu: [], fri: [], sat: [], sun: [] },
    pay: { current: { hourlyRate: 21, payType: 'hourly', overtimeMultiplier: 1.5, effectiveFrom: '2026-09-01', source: 'pay_rates', drift: false }, upcoming: [rate('2026-10-01', 23.5)],
      schedule: [rate('2000-01-01', 20), rate('2026-09-01', 21), rate('2026-10-01', 23.5)], needsReview: false },
  })]) }) });
  ui.mount();
  await settle();
  const card = cardFor(ui.host, 'Zoe.Phone');
  assert.deepEqual(all(card, '.st-chip').map(node => node.textContent), ['Crew', 'Phone · calls and follow-ups', 'Customer phone follow-up · Lead', 'old_skill · Trainee (retired)']);
  assert.equal(card.querySelector('.st-person-head .st-tag').textContent, 'Phone · calls and follow-ups');
  assert.match(card.querySelector('.st-pay-current').textContent, /\$21\.00\/hr hourly · Effective Sep 1, 2026/);
  assert.deepEqual(all(card, '.st-pay-row').map(row => [row.querySelector('.st-pay-date').textContent, row.querySelector('strong').textContent, row.querySelector('.st-tag').textContent]),
    [['Oct 1, 2026', '$23.50/hr', 'Scheduled'], ['Sep 1, 2026', '$21.00/hr', 'Current'], ['Before the dated schedule', '$20.00/hr', 'Earlier']]);
  const week = card.querySelector('.st-week');
  assert.deepEqual(all(week, 'dd').map(node => node.textContent), ['8:00 AM–12:00 PM, 1:00 PM–5:30 PM', 'Not available', '6:00 PM–midnight', 'Not available', 'Not available', 'Not available', 'Not available']);
});

test('a pay change sends exact numbers with the reviewed revision, from the Denver date the server reported', async () => {
  const ui = staffUi();
  ui.mount();
  await settle();
  click(buttonLabel(ui.host, 'Change pay for Synthetic Zoe.Phone'));
  const rateField = named(ui.host, 'hourlyRate'), when = named(ui.host, 'effectiveFrom'), overtime = named(ui.host, 'overtimeMultiplier');
  assert.deepEqual([rateField.type, rateField.getAttribute('inputmode'), rateField.getAttribute('step')], ['number', 'decimal', '0.01']);
  assert.deepEqual([overtime.type, overtime.getAttribute('inputmode')], ['number', 'decimal']);
  assert.deepEqual([when.type, when.value, when.getAttribute('min'), when.getAttribute('max')], ['date', TODAY, TODAY, '2027-09-23']);
  assert.equal(rateField.getAttribute('placeholder'), '21');
  assert.equal(ui.context.EGCStaff.canLeave(), true, 'opening an editor is not a change');
  for (const [field, value, message] of [[rateField, '23.456', /to the cent/], [rateField, '600', /to the cent/], [when, '2026-09-21', /effective date from Sep 22, 2026 through Sep 23, 2027/], [overtime, '0.5', /overtime multiplier/]]) {
    change(rateField, '23.50'); change(when, '2026-10-01'); change(overtime, '1.5');
    change(field, value);
    submit(ui.host);
    await settle();
    assert.match(ui.host.querySelector('.st-error').textContent, message);
  }
  assert.equal(ui.posts().length, 0, 'invalid drafts never spend a request');
  assert.equal(ui.context.EGCStaff.canLeave(), false, 'a typed draft guards navigation');
  change(rateField, '23.50'); change(when, '2026-10-01'); change(overtime, '1.75');
  change(named(ui.host, 'payType'), 'salary', 'change');
  change(named(ui.host, 'reason'), 'Synthetic annual raise');
  submit(ui.host);
  await settle();
  const [post] = ui.posts();
  assert.equal(post.url, '/api/staff-directory');
  assert.equal(post.headers['Content-Type'], 'application/json');
  assert.match(post.body.requestId, UUID);
  assert.deepEqual(post.body, { action: 'set_pay', requestId: post.body.requestId, username: 'Zoe.Phone', expectedRevision: 'rev-Zoe.Phone-1', expectedUser: 'zacb', effectiveFrom: '2026-10-01', hourlyRate: 23.5, payType: 'salary', overtimeMultiplier: 1.75, reason: 'Synthetic annual raise' });
  assert.equal(ui.host.querySelector('form.st-editor'), null, 'the editor closes after a verified save');
  assert.match(ui.text(), /Saved: Pay for Synthetic Zoe\.Phone\./);
  assert.deepEqual(ui.toasts, ['Saved: Pay for Synthetic Zoe.Phone.']);
  assert.equal(ui.session.getItem('egc.hub.pending.v1.staff.zacb'), null);
  assert.equal(ui.context.EGCStaff.canLeave(), true);
});

test('a save with a lost answer is kept and retried with the same requestId and body', async () => {
  let attempt = 0;
  const ui = staffUi({ post: async body => (++attempt === 1 ? new TypeError('Failed to fetch') : { body: { ok: true, replayed: true, person: person(body.username, { staffRoles: ['phone'], revision: 'rev-Zoe.Phone-2' }) } }) });
  ui.mount();
  await settle();
  click(buttonLabel(ui.host, 'Edit roles for Synthetic Zoe.Phone'));
  const box = role => all(ui.host, 'input').find(node => node.type === 'checkbox' && node.value === role);
  assert.equal(box('owner'), undefined, 'the owner role is never offered');
  assert.equal(box('crew').checked, true);
  toggle(box('crew'), false);
  submit(ui.host);
  await settle();
  assert.match(ui.host.querySelector('.st-error').textContent, /at least one role/);
  assert.equal(ui.posts().length, 0);
  toggle(box('phone'), true);
  submit(ui.host);
  await settle();
  const saved = JSON.parse(ui.session.getItem('egc.hub.pending.v1.staff.zacb'));
  assert.deepEqual(saved.body, ui.posts()[0].body, 'the exact request was stored before it was sent');
  assert.deepEqual(saved.body.staffRoles, ['phone']);
  assert.match(ui.text(), /Unconfirmed change: Roles for Synthetic Zoe\.Phone/);
  assert.match(ui.text(), /could not be reached/);
  assert.equal(ui.context.EGCStaff.canLeave(), false);
  assert.ok(disabled(all(ui.host, 'form.st-editor button').find(node => node.type === 'submit')), 'no second change while one is unconfirmed');

  // A reload of the page keeps the saved change for the same viewer only.
  const other = staffUi({ identity: 'TylerG', session: { 'egc.hub.pending.v1.staff.zacb': ui.session.getItem('egc.hub.pending.v1.staff.zacb') } });
  other.mount();
  await settle();
  assert.equal(buttonText(other.host, 'Retry original save'), undefined);
  const again = staffUi({ session: { 'egc.hub.pending.v1.staff.zacb': ui.session.getItem('egc.hub.pending.v1.staff.zacb') } });
  again.mount();
  await settle();
  assert.ok(buttonText(again.host, 'Retry original save'));

  click(buttonText(ui.host, 'Retry original save'));
  await settle();
  assert.equal(ui.posts().length, 2);
  assert.deepEqual(ui.posts()[1].body, ui.posts()[0].body, 'the retry is byte-for-byte the original request');
  assert.equal(ui.session.getItem('egc.hub.pending.v1.staff.zacb'), null);
  assert.match(ui.text(), /Confirmed: Roles for Synthetic Zoe\.Phone/);
  assert.deepEqual(all(cardFor(ui.host, 'Zoe.Phone'), '.st-chip').map(node => node.textContent), ['Phone · calls and follow-ups']);
});

test('timeouts and server errors keep the change; validation errors discard it; discard clears it', async () => {
  for (const [answer, kept] of [
    [{ status: 503, body: { ok: false, code: 'staff_directory_outcome_unknown', error: 'The result could not be confirmed.' } }, true],
    [{ status: 500, body: { ok: false, error: 'Synthetic failure' } }, true],
    [{ status: 429, body: { ok: false, error: 'Too many requests right now' } }, true],
    [{ status: 400, body: { ok: false, code: 'staff_directory_invalid_skills', error: 'Choose skills from the current skill catalog.' } }, false],
    [{ status: 409, body: { ok: false, code: 'staff_directory_idempotency_conflict', error: 'This request id was already used for a different change.' } }, false],
    // 403s the API documents as permanent are dropped; any other 403 (a sign-in or edge refusal) is kept for retry.
    [{ status: 403, body: { ok: false, code: 'staff_directory_forbidden', error: 'Only a manager can change another staff member.' } }, false],
    [{ status: 403, body: { ok: false, code: 'staff_directory_owner_role_reserved', error: 'The owner role belongs only to the configured owner account.' } }, false],
    [{ status: 403, body: { ok: false, code: 'staff_directory_origin_forbidden', error: 'Open the staff directory in the Employee Hub to save changes.' } }, false],
    [{ status: 403, body: { ok: false, error: 'Synthetic edge refused the request' } }, true],
    [{ status: 401, body: { ok: false, code: 'staff_directory_account_changed', error: 'This change was made while signed in as another account. Sign in as that account to retry it, or discard it.' } }, true],
  ]) {
    const ui = staffUi({ post: async () => answer });
    ui.mount();
    await settle();
    click(buttonLabel(ui.host, 'Edit skills for Synthetic Zoe.Phone'));
    change(named(ui.host, 'skill_first_aid'), 'proficient', 'change');
    submit(ui.host);
    await settle();
    assert.equal(Boolean(ui.session.getItem('egc.hub.pending.v1.staff.zacb')), kept, JSON.stringify(answer.body));
    assert.equal(Boolean(buttonText(ui.host, 'Retry original save')), kept);
    assert.ok(ui.host.querySelector('form.st-editor'), 'the draft stays open');
    if (answer.body.code === 'staff_directory_idempotency_conflict') assert.ok(buttonText(ui.host, 'Reload staff directory'));
    if (answer.status === 403 || answer.status === 401) assert.ok(ui.text().includes(answer.body.error), 'the server\'s reason is shown');
    if (kept) { click(buttonText(ui.host, 'Discard saved change')); assert.equal(ui.session.getItem('egc.hub.pending.v1.staff.zacb'), null); }
  }
  // A save that never answers times out through the injected 30 second timer and is kept for retry.
  const hang = staffUi({ post: () => new Promise(() => {}) });
  hang.mount();
  await settle();
  click(buttonLabel(hang.host, 'Edit availability for Synthetic Zoe.Phone'));
  submit(hang.host);
  await settle();
  assert.ok(disabled(buttonText(hang.host, 'Saving…')), 'the pending save disables its button instead of hiding it');
  assert.equal(hang.context.EGCStaff.canLeave(), false);
  const timers = hang.timers.filter(item => item.delay === 30000);
  assert.equal(timers.length, 2, 'the load and the save each carry a timeout');
  timers.at(-1).callback();
  await settle();
  assert.match(hang.text(), /did not answer in time/);
  assert.ok(hang.session.getItem('egc.hub.pending.v1.staff.zacb'), 'a timed-out save is kept to retry, never re-created');
  assert.ok(buttonText(hang.host, 'Retry original save'));
});

test('a revision conflict keeps the draft, drops the request and reloads without losing the draft', async () => {
  let revision = 1;
  const ui = staffUi({
    get: async () => ({ body: directory([person('Zoe.Phone', { revision: `rev-${revision}` })]) }),
    post: async body => body.expectedRevision === `rev-${revision}` ? { body: { ok: true, person: person('Zoe.Phone', { revision: `rev-${++revision}`, weeklyAvailability: body.weeklyAvailability }) } }
      : { status: 409, body: { ok: false, code: 'staff_directory_revision_conflict', error: 'This staff record changed since you opened it.', details: { currentRevision: `rev-${revision}` } } },
  });
  ui.mount();
  await settle();
  click(buttonLabel(ui.host, 'Edit availability for Synthetic Zoe.Phone'));
  click(buttonLabel(ui.host, 'Add hours on Monday'));
  click(buttonLabel(ui.host, 'Add hours on Monday'));
  change(named(ui.host, 'mon_end_0'), '12:00');
  change(named(ui.host, 'mon_start_1'), '18:00');
  change(named(ui.host, 'mon_end_1'), '00:00');
  revision = 2; // someone else saved the record meanwhile
  submit(ui.host);
  await settle();
  assert.equal(ui.session.getItem('egc.hub.pending.v1.staff.zacb'), null, 'a conflicted request is not retried');
  assert.match(ui.text(), /changed since you opened it/);
  assert.equal(named(ui.host, 'mon_end_1').value, '00:00', 'the draft is still on screen');
  click(buttonText(ui.host, 'Reload record, keep my draft'));
  await settle();
  assert.equal(ui.gets().length, 2);
  assert.equal(named(ui.host, 'mon_start_1').value, '18:00', 'reloading kept the draft');
  submit(ui.host);
  await settle();
  const last = ui.posts().at(-1).body;
  assert.equal(last.expectedRevision, 'rev-2', 'the save is made against the record just reviewed');
  assert.deepEqual(last.weeklyAvailability, { mon: [{ start: '08:00', end: '12:00' }, { start: '18:00', end: '24:00' }], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] });
  assert.match(cardFor(ui.host, 'Zoe.Phone').querySelector('.st-week').textContent, /Mon8:00 AM–12:00 PM, 6:00 PM–midnight/);

  // Discard throws the draft away and loads the latest record.
  click(buttonLabel(ui.host, 'Edit availability for Synthetic Zoe.Phone'));
  click(buttonLabel(ui.host, 'Remove Monday window 1'));
  revision = 9;
  submit(ui.host);
  await settle();
  click(buttonText(ui.host, 'Discard draft and load latest'));
  await settle();
  assert.equal(ui.host.querySelector('form.st-editor'), null);
  assert.equal(ui.context.EGCStaff.canLeave(), true);
});

test('availability checks overlap, order and the four-window limit before sending', async () => {
  const ui = staffUi();
  ui.mount();
  await settle();
  click(buttonLabel(ui.host, 'Edit availability for Synthetic Zoe.Phone'));
  for (let i = 0; i < 4; i++) click(buttonLabel(ui.host, 'Add hours on Friday'));
  assert.ok(disabled(buttonLabel(ui.host, 'Add hours on Friday')), 'a day holds at most four windows');
  submit(ui.host);
  await settle();
  assert.match(ui.host.querySelector('.st-error').textContent, /Each Friday window needs a start before its end/);
  for (const index of [3, 2, 1]) click(buttonLabel(ui.host, `Remove Friday window ${index + 1}`));
  click(buttonLabel(ui.host, 'Add hours on Friday'));
  change(named(ui.host, 'fri_start_1'), '16:00');
  change(named(ui.host, 'fri_end_1'), '19:00');
  submit(ui.host);
  await settle();
  assert.match(ui.host.querySelector('.st-error').textContent, /Friday windows cannot overlap/);
  change(named(ui.host, 'fri_start_1'), '06:00');
  change(named(ui.host, 'fri_end_1'), '07:30');
  submit(ui.host);
  await settle();
  assert.deepEqual(ui.posts()[0].body.weeklyAvailability.fri, [{ start: '06:00', end: '07:30' }, { start: '08:00', end: '17:00' }], 'windows are sent in order');
});

test('the Team page section moves with background renders without refetching, and the registered screen reuses it', async () => {
  const ui = staffUi();
  ui.mount();
  await settle();
  const root = ui.host.firstElementChild;
  click(buttonLabel(ui.host, 'Edit skills for Synthetic Zoe.Phone'));
  change(named(ui.host, 'skill_cleanout'), 'lead', 'change');
  const slot = ui.document.createElement('div');
  ui.document.body.append(slot);
  ui.mount(slot);
  assert.equal(slot.firstElementChild, root, 'the same section (and the typed draft) moved into the new slot');
  assert.equal(ui.gets().length, 1);
  assert.equal(root.querySelector('h2').textContent, 'Roles, skills, pay and availability');
  const screen = ui.document.createElement('main');
  ui.mount(screen, { screen: 'staff' });
  assert.equal(screen.firstElementChild, root);
  assert.equal(root.querySelector('h1').textContent, 'Staff directory', 'as a registered screen it carries the page heading');
  const selected = root => all(named(root, 'skill_cleanout'), 'option').filter(option => option.hasAttribute('selected')).map(option => option.value);
  assert.deepEqual(selected(root), ['lead'], 'the heading change re-rendered the editor from the draft');
  ui.context.EGCStaff.unmount();
  assert.equal(root.isConnected, false);
  ui.mount(slot);
  await settle();
  assert.equal(ui.gets().length, 2, 'a remount after leaving loads fresh data');
  assert.deepEqual(selected(slot), ['lead'], 'the open draft survives leaving and coming back');
});

// A directory whose record moves to rev-2 once `changed()` is called; saves only succeed on the current revision.
function movingRecord(overrides = {}) {
  const state = { revision: 1, fields: {} };
  const record = () => person('Zoe.Phone', { revision: `rev-${state.revision}`, ...state.fields });
  const ui = staffUi({
    get: async () => ({ body: directory([record()]) }),
    post: async body => {
      if (body.expectedRevision !== `rev-${state.revision}`) return { status: 409, body: { ok: false, code: 'staff_directory_revision_conflict', error: 'This staff record changed since you opened it.', details: { currentRevision: `rev-${state.revision}` } } };
      state.revision++;
      if (body.staffRoles) state.fields.staffRoles = body.staffRoles;
      if (body.weeklyAvailability) state.fields.weeklyAvailability = body.weeklyAvailability;
      return { body: { ok: true, person: record() } };
    },
    ...overrides,
  });
  return { ui, state, changed: fields => { state.revision++; Object.assign(state.fields, fields); } };
}
const conflictActions = root => [buttonText(root, 'Reload record, keep my draft'), buttonText(root, 'Discard draft and load latest')].every(Boolean);

test('an open editor saves against the revision it was opened at, even after a refresh or a remount loads a newer record', async () => {
  for (const reopen of ['refresh', 'remount', 'registry refresh']) {
    const { ui, changed } = movingRecord();
    ui.mount();
    await settle();
    click(buttonLabel(ui.host, 'Edit roles for Synthetic Zoe.Phone'));
    toggle(checkbox(ui.host, 'sales'), true);
    changed({ staffRoles: ['crew', 'phone'] }); // another session adds the phone role (rev-2)
    if (reopen === 'refresh') click(buttonLabel(ui.host, 'Refresh the staff directory'));
    else if (reopen === 'remount') { ui.context.EGCStaff.unmount(); ui.mount(); }
    else await ui.context.EGCStaff.refresh();
    await settle();
    assert.deepEqual(all(cardFor(ui.host, 'Zoe.Phone'), '.st-chip.role-phone').map(node => node.textContent), ['Phone · calls and follow-ups'], `${reopen}: the latest record is on screen`);
    assert.match(ui.text(), /changed since you opened it/, `${reopen}: the viewer is told before saving`);
    assert.ok(conflictActions(ui.host));
    assert.equal(checkbox(ui.host, 'sales').checked, true, 'the typed draft is kept');
    assert.equal(checkbox(ui.host, 'phone').checked, false, 'the draft is not silently rebuilt');
    submit(ui.host);
    await settle();
    const [post] = ui.posts();
    assert.equal(post.body.expectedRevision, 'rev-1', `${reopen}: the save is checked against the record the draft was built on`);
    assert.deepEqual(post.body.staffRoles, ['crew', 'sales']);
    assert.match(ui.text(), /changed since you opened it\. Your draft is kept/);
    assert.ok(conflictActions(ui.host), 'the conflict is offered for review, nothing was overwritten');
    assert.equal(ui.session.getItem('egc.hub.pending.v1.staff.zacb'), null);
    // Only the acknowledged reload moves the draft onto the latest revision.
    click(buttonText(ui.host, 'Reload record, keep my draft'));
    await settle();
    assert.doesNotMatch(ui.text(), /changed since you opened it/);
    toggle(checkbox(ui.host, 'phone'), true);
    submit(ui.host);
    await settle();
    assert.deepEqual([ui.posts().at(-1).body.expectedRevision, ui.posts().at(-1).body.staffRoles], ['rev-2', ['crew', 'sales', 'phone']]);
    assert.match(ui.text(), /Saved: Roles for Synthetic Zoe\.Phone/);
  }
});

test('an untouched editor follows a refreshed record, and a left availability draft cannot wipe hours saved elsewhere', async () => {
  const fresh = movingRecord();
  fresh.ui.mount();
  await settle();
  click(buttonLabel(fresh.ui.host, 'Edit roles for Synthetic Zoe.Phone'));
  fresh.changed({ staffRoles: ['crew', 'phone'] });
  await fresh.ui.context.EGCStaff.refresh();
  assert.equal(checkbox(fresh.ui.host, 'phone').checked, true, 'nothing was typed, so the editor shows the latest roles');
  assert.doesNotMatch(fresh.ui.text(), /changed since you opened it/);
  submit(fresh.ui.host);
  await settle();
  assert.deepEqual([fresh.ui.posts()[0].body.expectedRevision, fresh.ui.posts()[0].body.staffRoles], ['rev-2', ['crew', 'phone']]);

  // The employee saves Tuesday hours through self-service while the manager's Monday draft waits on another page.
  const { ui, changed } = movingRecord();
  ui.mount();
  await settle();
  click(buttonLabel(ui.host, 'Edit availability for Synthetic Zoe.Phone'));
  click(buttonLabel(ui.host, 'Add hours on Monday'));
  ui.context.EGCStaff.unmount();
  changed({ weeklyAvailability: { mon: [], tue: [{ start: '09:00', end: '15:00' }], wed: [], thu: [], fri: [], sat: [], sun: [] } });
  ui.mount();
  await settle();
  assert.match(cardFor(ui.host, 'Zoe.Phone').querySelector('.st-week').textContent, /Tue9:00 AM–3:00 PM/);
  assert.match(ui.text(), /changed since you opened it/);
  submit(ui.host);
  await settle();
  assert.equal(ui.posts()[0].body.expectedRevision, 'rev-1');
  assert.ok(conflictActions(ui.host));
  click(buttonText(ui.host, 'Discard draft and load latest'));
  await settle();
  assert.equal(ui.host.querySelector('form.st-editor'), null);
  assert.equal(ui.posts().length, 1, 'the Tuesday hours were never overwritten');
});

test('a retried save with no editor behind it that meets a revision conflict offers a reload, not a kept draft', async () => {
  const requestId = '8f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b';
  const pending = { path: '/api/staff-directory', method: 'POST', requestId, kind: 'skills', label: 'Skills for Synthetic Zoe.Phone',
    body: { action: 'set_skills', requestId, username: 'Zoe.Phone', expectedRevision: 'rev-old', expectedUser: 'zacb', skills: [] } };
  const ui = staffUi({ session: { 'egc.hub.pending.v1.staff.zacb': JSON.stringify(pending) },
    post: async () => ({ status: 409, body: { ok: false, code: 'staff_directory_revision_conflict', error: 'This staff record changed since you opened it.' } }) });
  ui.mount();
  await settle();
  // An editor opened after the page reload is not the one that built the kept request.
  click(buttonLabel(ui.host, 'Edit availability for Synthetic Zoe.Phone'));
  click(buttonText(ui.host, 'Retry original save'));
  await settle();
  assert.deepEqual(ui.posts()[0].body, pending.body);
  assert.match(ui.text(), /changed before the saved change was confirmed, so it was not saved/);
  assert.doesNotMatch(ui.text(), /Your draft is kept/);
  assert.ok(buttonText(ui.host, 'Reload staff directory'));
  assert.equal(buttonText(ui.host, 'Reload record, keep my draft'), undefined, 'the open editor is not rebased by someone else\'s conflict');
  assert.equal(ui.session.getItem('egc.hub.pending.v1.staff.zacb'), null);
  click(buttonText(ui.host, 'Reload staff directory'));
  await settle();
  assert.ok(ui.host.querySelector('form.st-editor'), 'the unrelated editor stays open');
});

test('a directory answered for another account is not shown, and a change kept for this tab is not retried under it', async () => {
  const requestId = '8f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b';
  const pending = { path: '/api/staff-directory', method: 'POST', requestId, kind: 'skills', label: 'Skills for Synthetic Zoe.Phone',
    body: { action: 'set_skills', requestId, username: 'Zoe.Phone', expectedRevision: 'rev-Zoe.Phone-1', skills: [] } };
  const ui = staffUi({ session: { 'egc.hub.pending.v1.staff.zacb': JSON.stringify(pending) },
    get: async () => ({ body: directory([person('Zoe.Phone', { displayName: 'PRIVATE OTHER VIEW' })], { user: 'TylerG', capabilities: MANAGER }) }) });
  ui.mount();
  await settle();
  assert.match(ui.text(), /Signed in as another account/);
  assert.doesNotMatch(ui.text(), /PRIVATE OTHER VIEW/);
  assert.equal(ui.host.querySelectorAll('article').length, 0);
  assert.match(ui.text(), /kept for zacb\. Sign in as that account in this tab to retry it/);
  assert.equal(buttonText(ui.host, 'Retry original save'), undefined);
  assert.ok(buttonText(ui.host, 'Discard saved change'));
  await ui.context.EGCStaff.refresh();
  assert.equal(ui.posts().length, 0);
  // Signed back in as the tab's account, the kept change can be retried again.
  ui.state.get = async () => ({ body: directory() });
  click(buttonText(ui.host, 'Retry'));
  await settle();
  assert.ok(cardFor(ui.host, 'Zoe.Phone'));
  assert.ok(buttonText(ui.host, 'Retry original save'));
});

test('the pay editor moves to the new Denver day when the tab stays open past midnight', async () => {
  const ui = staffUi(), clock = { now: 5000 };
  ui.context.performance = { now: () => clock.now }; // monotonic time only; asOf (noon Denver) comes from the server
  ui.mount();
  await settle();
  const open = () => { click(buttonLabel(ui.host, 'Change pay for Synthetic Zoe.Phone')); return named(ui.host, 'effectiveFrom'); };
  clock.now += 11 * 3600000; // 11 PM in Denver
  let when = open();
  assert.deepEqual([when.value, when.getAttribute('min')], [TODAY, TODAY]);
  assert.match(ui.text(), /Today in Denver is Sep 22, 2026/);
  change(named(ui.host, 'hourlyRate'), '22');
  clock.now += 2 * 3600000; // 1 AM the next day, draft still open
  submit(ui.host);
  await settle();
  assert.match(ui.host.querySelector('.st-error').textContent, /from Sep 23, 2026 through Sep 24, 2027/);
  assert.equal(ui.posts().length, 0, 'yesterday is caught before a request is spent');
  click(buttonText(ui.host, 'Cancel'));
  when = open();
  assert.deepEqual([when.value, when.getAttribute('min'), when.getAttribute('max')], ['2026-09-23', '2026-09-23', '2027-09-24']);
  assert.match(ui.text(), /Today in Denver is Sep 23, 2026/);
  change(named(ui.host, 'hourlyRate'), '22');
  submit(ui.host);
  await settle();
  assert.equal(ui.posts()[0].body.effectiveFrom, '2026-09-23');
});

test('focus returns to the button that opened the editor after Cancel, a save or a discarded conflict', async () => {
  const { ui, changed } = movingRecord();
  ui.mount();
  await settle();
  const opener = () => buttonLabel(ui.host, 'Edit roles for Synthetic Zoe.Phone');
  const focused = () => ui.document.activeElement;
  opener().focus();
  click(opener());
  assert.ok(ui.host.querySelector('form.st-editor').contains(focused()), 'opening moves focus into the editor');
  click(buttonText(ui.host, 'Cancel'));
  assert.equal(focused(), opener());
  click(opener());
  toggle(checkbox(ui.host, 'sales'), true);
  submit(ui.host);
  await settle();
  assert.match(ui.text(), /Saved: Roles/);
  assert.equal(focused(), opener());
  click(opener());
  toggle(checkbox(ui.host, 'phone'), true);
  changed({});
  submit(ui.host);
  await settle();
  click(buttonText(ui.host, 'Discard draft and load latest'));
  await settle();
  assert.equal(ui.host.querySelector('form.st-editor'), null);
  assert.equal(focused(), opener(), 'focus stays on the opener through the reload');
  // A button that re-renders the section keeps its focus.
  click(buttonLabel(ui.host, 'Edit availability for Synthetic Zoe.Phone'));
  buttonLabel(ui.host, 'Add hours on Monday').focus();
  click(buttonLabel(ui.host, 'Add hours on Monday'));
  assert.equal(focused(), buttonLabel(ui.host, 'Add hours on Monday'));
  assert.equal(focused().isConnected, true);
});

// ── the real server behind the screen ──
function memoryStore(env, { accounts, profiles }) {
  let revision = 0;
  const next = () => `2026-09-22T18:00:00.${String(++revision).padStart(6, '0')}Z`;
  const rows = new Map(profiles.map(data => [data.id, { documentId: `doc_${data.id}`, updateTime: next(), data: structuredClone(data) }]));
  const accountRows = new Map(accounts.map(data => [data.username.toLowerCase(), { account: structuredClone(data), version: next() }]));
  const receipts = new Map(), commits = [];
  const conflict = () => Object.assign(new Error('changed'), { code: 'staff_directory_revision_conflict', status: 409 });
  return {
    rows, accountRows, commits,
    configured: () => true, readOnly: () => false,
    async staff() { return { configured: listHubUserProfiles(env), accounts: [...accountRows.values()].map(row => structuredClone(row.account)) }; },
    async profiles() { return [...rows.values()].map(row => structuredClone(row)); },
    async readAccount(username) { const row = accountRows.get(username.toLowerCase()); return row ? structuredClone(row) : null; },
    async readReceipt(id) { return structuredClone(receipts.get(id) ?? null); },
    async fingerprint(text) { return createHash('sha256').update(text).digest('hex'); },
    async commit(plan) {
      const current = rows.get(plan.profile.id);
      if ((current?.updateTime || '') !== (plan.profile.revision || '')) throw conflict();
      if (plan.account && accountRows.get(plan.account.account.username.toLowerCase())?.version !== plan.account.version) throw conflict();
      if (receipts.has(plan.receipt.id)) throw conflict();
      const updateTime = next();
      rows.set(plan.profile.id, { documentId: current?.documentId || `doc_${plan.profile.id}`, updateTime, data: structuredClone(plan.profile.data) });
      if (plan.account) accountRows.set(plan.account.account.username.toLowerCase(), { account: structuredClone(plan.account.account), version: updateTime });
      receipts.set(plan.receipt.id, { ...structuredClone(plan.receipt.data), id: plan.receipt.id });
      commits.push(structuredClone(plan));
      return { profileRevision: updateTime };
    },
  };
}
function serverUi(user, capabilities) {
  // The session is shared by every tab: signInAs models another tab signing in with the same cookie jar.
  const env = staffEnv({ EGC_STAFF_DIRECTORY_ENABLED: 'true' }), profile = name => listHubUserProfiles(env).find(row => row.user === name);
  let actor = profile(user);
  const store = memoryStore(env, { accounts: [{ username: 'Zoe.Phone', displayName: 'Synthetic Zoe', status: 'approved', role: 'crew', payType: 'hourly', hourlyRate: 21, businessAccess: false }], profiles: [{ id: 'zoe.phone', username: 'Zoe.Phone', hourlyRate: 21, payType: 'hourly' }] });
  const handlers = staffDirectoryHandlers({ session: async () => actor, storage: () => store, now: () => new Date(NOW) }), statuses = [];
  const ui = staffUi({ identity: user, capabilities });
  ui.context.EGCStaff.unmount();
  const hubFetch = async (url, init = {}) => {
    const request = new Request(ORIGIN + url, { method: init.method || 'GET', headers: { Origin: ORIGIN, ...(init.headers || {}) }, ...(init.body ? { body: init.body } : {}) });
    const response = await (request.method === 'POST' ? handlers.post({ request, env }) : handlers.get({ request, env }));
    statuses.push([request.method, response.status]);
    return response;
  };
  return { ui, store, statuses, signInAs: name => { actor = profile(name); }, mount: () => ui.context.EGCStaff.mount(ui.host, { identity: user, capabilities, hubFetch, toast() {} }) };
}

test('against the real staff directory API the owner sets Zoe as phone, schedules a raise, records skills and a week', async () => {
  const { ui, store, statuses, mount } = serverUi('ZacB', ['crew', 'business', 'owner']);
  mount();
  await settle();
  const zoe = () => cardFor(ui.host, 'Zoe.Phone');
  assert.ok(zoe(), ui.text());
  assert.ok(cardFor(ui.host, 'ZacB') && cardFor(ui.host, 'Crew.Static'), 'configured Hub users are listed too');
  assert.match(zoe().textContent, /\$21\.00\/hr/);

  click(buttonLabel(ui.host, 'Edit roles for Synthetic Zoe'));
  const box = role => all(ui.host, 'input').find(node => node.type === 'checkbox' && node.value === role);
  toggle(box('crew'), false); toggle(box('phone'), true);
  change(named(ui.host, 'reason'), 'Synthetic phone coverage');
  submit(ui.host);
  await settle();
  assert.deepEqual(store.accountRows.get('zoe.phone').account.staffRoles, ['phone']);
  assert.match(ui.text(), /Saved: Roles for Synthetic Zoe\. They were signed out/);
  assert.deepEqual(all(zoe(), '.st-chip').map(node => node.textContent), ['Phone · calls and follow-ups']);

  click(buttonLabel(ui.host, 'Change pay for Synthetic Zoe'));
  change(named(ui.host, 'effectiveFrom'), '2026-10-01');
  change(named(ui.host, 'hourlyRate'), '23.50');
  submit(ui.host);
  await settle();
  assert.deepEqual(all(zoe(), '.st-pay-row').map(row => [row.querySelector('.st-pay-date').textContent, row.querySelector('strong').textContent, row.querySelector('.st-tag').textContent]),
    [['Oct 1, 2026', '$23.50/hr', 'Scheduled'], ['Before the dated schedule', '$21.00/hr', 'Current']]);
  assert.match(zoe().querySelector('.st-pay-current').textContent, /\$21\.00\/hr/, 'today\'s rate is unchanged until the effective date');

  click(buttonLabel(ui.host, 'Edit skills for Synthetic Zoe'));
  change(named(ui.host, 'skill_customer_phone'), 'lead', 'change');
  submit(ui.host);
  await settle();
  assert.ok(all(zoe(), '.st-chip').some(node => node.textContent === 'Customer phone follow-up · Lead'));

  click(buttonLabel(ui.host, 'Edit availability for Synthetic Zoe'));
  click(buttonLabel(ui.host, 'Add hours on Saturday'));
  change(named(ui.host, 'sat_end_0'), '00:00');
  submit(ui.host);
  await settle();
  assert.match(zoe().querySelector('.st-week').textContent, /Sat8:00 AM–midnight/);

  assert.deepEqual(statuses, [['GET', 200], ['POST', 200], ['POST', 200], ['POST', 200], ['POST', 200]], 'every change the screen built was accepted, each on the revision it returned');
  assert.equal(store.commits.length, 4);
  const saved = store.rows.get('zoe.phone').data;
  assert.deepEqual(saved.weeklyAvailability.sat, [{ start: '08:00', end: '24:00' }]);
  assert.deepEqual(saved.payRates.at(-1), { effectiveFrom: '2026-10-01', hourlyRate: 23.5, payType: 'hourly', overtimeMultiplier: 1.5, setBy: 'ZacB', setAt: NOW });
  assert.deepEqual(all(zoe(), '.st-history li').map(node => node.firstElementChild.textContent),
    ['Weekly availability updated', 'Skills updated (1 recorded)', 'Pay from Oct 1, 2026: $23.50/hr', 'Roles: Crew → Phone · calls and follow-ups']);
  assert.match(zoe().querySelector('.st-history').textContent, /ZacB · Sep 22, 2026, 12:00 PM · Synthetic phone coverage/);
});

test('against the real API a change made as the owner is refused, and kept, after another tab signs in as a manager', async () => {
  const { ui, store, statuses, signInAs, mount } = serverUi('ZacB', ['crew', 'business', 'owner']);
  mount();
  await settle();
  click(buttonLabel(ui.host, 'Edit skills for Synthetic Zoe'));
  change(named(ui.host, 'skill_cleanout'), 'lead', 'change');
  signInAs('TylerG'); // a manager may change skills, so only the account check stands between this draft and his name
  submit(ui.host);
  await settle();
  assert.deepEqual(statuses.at(-1), ['POST', 401]);
  assert.equal(store.commits.length, 0, 'nothing was applied under the manager');
  assert.match(ui.text(), /made while signed in as another account/);
  assert.ok(buttonText(ui.host, 'Retry original save'), 'the change is kept for the owner');
  await ui.context.EGCStaff.refresh();
  assert.match(ui.text(), /Signed in as another account/, 'the next load notices the switch too');
  assert.equal(buttonText(ui.host, 'Retry original save'), undefined);
  signInAs('ZacB');
  click(buttonText(ui.host, 'Retry'));
  await settle();
  click(buttonText(ui.host, 'Retry original save'));
  await settle();
  assert.deepEqual(statuses.map(([, status]) => status), [200, 401, 200, 200, 200]);
  assert.equal(store.commits.length, 1);
  assert.equal(store.commits[0].receipt.data.actor, 'zacb');
  assert.ok(all(cardFor(ui.host, 'Zoe.Phone'), '.st-chip').some(node => node.textContent === 'Garage cleanout · Lead'));
});

test('against the real API a manager sees no pay or role controls and the server agrees', async () => {
  const { ui, mount } = serverUi('TylerG', ['crew', 'business']);
  mount();
  await settle();
  const zoe = cardFor(ui.host, 'Zoe.Phone');
  assert.equal(zoe.querySelector('.st-pay'), null);
  assert.deepEqual(all(zoe, '.st-person-actions button').map(node => node.textContent), ['Edit skills', 'Edit availability']);
  assert.ok(cardFor(ui.host, 'TylerG').querySelector('.st-pay'), 'their own pay is visible');
});

test('the staff directory API checks expectedUser before permissions and validates it', async () => {
  const env = staffEnv({ EGC_STAFF_DIRECTORY_ENABLED: 'true' }), tyler = listHubUserProfiles(env).find(row => row.user === 'TylerG');
  const store = memoryStore(env, { accounts: [{ username: 'Zoe.Phone', displayName: 'Synthetic Zoe', status: 'approved', role: 'crew', payType: 'hourly', hourlyRate: 21, businessAccess: false }], profiles: [{ id: 'zoe.phone', username: 'Zoe.Phone', hourlyRate: 21, payType: 'hourly' }] });
  const handlers = staffDirectoryHandlers({ session: async () => tyler, storage: () => store, now: () => new Date(NOW) });
  const post = async body => {
    const response = await handlers.post({ env, request: new Request(`${ORIGIN}/api/staff-directory`, { method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json' }, body: JSON.stringify({ requestId: crypto.randomUUID(), username: 'Zoe.Phone', expectedRevision: 'rev-stale', ...body }) }) });
    return [response.status, (await response.json()).code];
  };
  const pay = { action: 'set_pay', effectiveFrom: TODAY, hourlyRate: 30 };
  assert.deepEqual(await post({ ...pay, expectedUser: 'zacb' }), [401, 'staff_directory_account_changed'], 'the owner\'s kept change is refused as another account (kept), not as forbidden (dropped)');
  assert.deepEqual(await post(pay), [403, 'staff_directory_forbidden'], 'without expectedUser nothing changes for older clients');
  for (const expectedUser of ['', ' ', 7, null, 'x'.repeat(81)]) assert.deepEqual(await post({ ...pay, expectedUser }), [400, 'staff_directory_invalid_request'], JSON.stringify(expectedUser));
  assert.deepEqual(await post({ action: 'set_skills', skills: [], expectedUser: ' TYLERG ' }), [409, 'staff_directory_revision_conflict'], 'the same account in any case passes on to the revision check');
  assert.equal(store.commits.length, 0);
});

// ── the Employee Hub shell ──
const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => structuredClone(body) });
const collections = () => Object.fromEntries(['profiles', 'timeEntries', 'announcements', 'requests', 'incidents', 'equipment', 'training', 'teamMessages', 'jobMessages', 'messageReads'].map(name => [name, []]));
function shell(options = {}, answers = {}) {
  const page = hubPage({ fetcher: async url => {
    if (url.startsWith('/api/staff-directory')) return answers.staff ? answers.staff() : json(directory());
    if (url.startsWith('/api/employee-hub')) return answers.employeeHub ? answers.employeeHub() : json({ ok: true, collections: collections(), accounts: [] });
    if (url.startsWith('/api/highlevel')) return json({ ok: true, pipelines: [], opportunities: [], events: [] });
    return json({ ok: false, error: 'Synthetic service unavailable' }, 503);
  }, ...options });
  vm.runInContext(source, page.context, { filename: 'employee-staff.js' });
  page.api.S.peopleState.loaded = true;
  page.api.S.accountState.loaded = true;
  return page;
}
const staffCalls = page => page.calls.filter(call => call.url.startsWith('/api/staff-directory'));

test('the Team page renders #ops-staff-directory and mounts the directory there only for the Team view', async () => {
  const page = shell();
  page.api.install();
  await page.flush();
  page.api.go('people');
  await settle();
  const slot = page.main().querySelector('#ops-staff-directory');
  assert.ok(slot, 'teamBoard renders the slot');
  assert.ok(cardFor(slot, 'Zoe.Phone'), 'EGCStaff mounted into the slot');
  assert.equal(staffCalls(page).length, 1);
  const section = slot.firstElementChild;
  page.api.render();
  page.context.refresh();
  await settle();
  assert.equal(page.main().querySelector('#ops-staff-directory').firstElementChild, section, 'a background render moves the section into the new slot');
  assert.equal(staffCalls(page).length, 1, 'without another request');
  page.api.go('customers');
  await settle();
  assert.equal(section.isConnected, false, 'leaving the Team page unmounts it');
  page.api.go('people');
  await settle();
  assert.equal(staffCalls(page).length, 2);
});

test('the Team page never asks for the directory while employee records are unavailable or for crew', async () => {
  const page = shell({}, { employeeHub: () => json({ ok: false, error: 'Synthetic employee records are offline' }, 503) });
  page.api.S.peopleState.loaded = false;
  page.api.install();
  await page.flush();
  page.api.go('people');
  await settle();
  assert.match(page.main().textContent, /Employee records unavailable/);
  assert.equal(page.main().querySelector('#ops-staff-directory'), null);
  assert.equal(staffCalls(page).length, 0);
  const crew = shell({ user: 'Synthetic.Crew', business: false, role: 'crew' });
  crew.api.install();
  await crew.flush();
  crew.api.go('people');
  crew.api.go('staff');
  await settle();
  assert.equal(crew.api.S.active, 'my_day');
  assert.equal(staffCalls(crew).length, 0);
  assert.ok(!crew.api.visibleNav().some(item => item[1] === 'staff'));
});

test('the Staff directory is a registered business screen that lazily mounts EGCStaff with the Hub context', async () => {
  const page = shell();
  const entry = page.context.EGCHubScreens.get('staff');
  assert.deepEqual({ ...entry, load: { ...entry.load } }, { id: 'staff', group: 'RUN THE BUSINESS', label: 'Staff directory', iconPath: entry.iconPath, capability: 'business', crewVisible: false,
    load: { js: 'employee-staff.js', css: 'employee-staff.css', v: '20260928team' }, module: 'EGCStaff', mount: null, unmount: null, canLeave: null, refresh: null, homeWidget: null });
  const nav = page.api.visibleNav(), at = nav.findIndex(item => item[1] === 'staff');
  assert.deepEqual([...nav[at]], ['RUN THE BUSINESS', 'staff', 'Staff directory']);
  assert.equal(nav[at - 1][1], 'delivery');
  page.context.EGCHubKit = {};
  page.api.install();
  await page.flush();
  page.api.go('staff');
  await settle();
  await page.flush();
  const main = page.main();
  assert.equal(main.querySelector('h1').textContent, 'Staff directory');
  assert.ok(cardFor(main, 'Zoe.Phone'));
  assert.deepEqual(page.document.assets.map(node => node.getAttribute('src') || node.getAttribute('href')).filter(url => /staff/.test(url)).sort(), ['employee-staff.css?v=20260928team', 'employee-staff.js?v=20260928team']);
  // A draft on the registered screen blocks leaving through the registry's canLeave.
  click(buttonLabel(main, 'Edit skills for Synthetic Zoe.Phone'));
  change(named(main, 'skill_cleanout'), 'lead', 'change');
  page.api.go('customers');
  assert.equal(page.api.S.active, 'staff');
  assert.match(page.toasts.at(-1), /Finish or save the changes/);
  click(buttonText(main, 'Cancel'));
  page.api.go('people');
  await settle();
  assert.ok(cardFor(page.main().querySelector('#ops-staff-directory'), 'Zoe.Phone'));
  page.fire('egc:signout');
  assert.equal(page.document.querySelectorAll('.egc-staff').length, 0, 'sign-out removes the directory');
});

test('leaving the Team page for another registered screen unmounts the directory, so coming back loads it again', async () => {
  const page = shell();
  page.context.EGCHubKit = {};
  page.context.EGCHubScreens.register({ id: 'synthetic_screen', group: 'RUN THE BUSINESS', label: 'Synthetic screen', capability: 'business', mount(host) { host.textContent = 'Synthetic registered screen'; } });
  page.api.install();
  await page.flush();
  page.api.go('people');
  await settle();
  const section = page.main().querySelector('#ops-staff-directory').firstElementChild;
  assert.ok(cardFor(section, 'Zoe.Phone'));
  page.api.go('synthetic_screen');
  await settle();
  await page.flush();
  assert.match(page.main().textContent, /Synthetic registered screen/);
  assert.equal(section.isConnected, false);
  page.api.go('people');
  await settle();
  assert.equal(staffCalls(page).length, 2, 'the directory is loaded again instead of showing the answer from before');
  assert.notEqual(page.main().querySelector('#ops-staff-directory').firstElementChild, section);
  // The registered Staff directory screen still takes over the Team page section rather than unmounting it.
  page.api.go('staff');
  await settle();
  await page.flush();
  assert.ok(cardFor(page.main(), 'Zoe.Phone'));
  assert.equal(staffCalls(page).length, 2);
});

test('with staff-role permissions a business account narrowed to crew views is not sent to crew onboarding', async () => {
  const onboarding = async (options, mode) => {
    const page = shell(options);
    if (mode) { page.session.setItem('egc_capability_mode', 'staff_roles'); page.session.setItem('egc_capabilities', JSON.stringify(['customer.send', 'followups.own'])); }
    page.api.S.peopleState.loaded = false;
    page.api.install();
    await page.flush();
    await page.api.loadAll();
    await settle();
    await page.flush();
    assert.equal(page.api.S.peopleState.loaded, true);
    return page.api.S.active;
  };
  assert.notEqual(await onboarding({}, 'staff_roles'), 'onboarding');
  assert.notEqual(await onboarding({}), 'onboarding');
  assert.equal(await onboarding({ user: 'Synthetic.Crew', business: false, role: 'crew' }), 'onboarding', 'crew still finish their profile first');
});

test('isManager and canView consult server capabilities only when the server reports staff-role permissions', () => {
  const views = page => ['people', 'schedule', 'timesheets', 'action_center', 'communications', 'finance', 'staff', 'my_day'].filter(view => page.api.canView(view));
  const legacy = shell();
  assert.deepEqual(views(legacy), ['people', 'schedule', 'timesheets', 'action_center', 'communications', 'finance', 'staff', 'my_day']);
  const cases = [
    ['legacy', JSON.stringify([]), ['people', 'schedule', 'timesheets', 'action_center', 'communications', 'finance', 'staff', 'my_day'], 'legacy mode ignores the list'],
    ['staff_roles', JSON.stringify(MANAGER), ['people', 'schedule', 'timesheets', 'action_center', 'communications', 'finance', 'staff', 'my_day']],
    ['staff_roles', JSON.stringify(['time.approve']), ['people', 'timesheets', 'finance', 'staff', 'my_day'], 'time approval without dispatch'],
    ['staff_roles', JSON.stringify(['customer.send', 'followups.own']), ['my_day'], 'phone capabilities alone are not manager access'],
    ['staff_roles', JSON.stringify([]), ['my_day'], 'a business account demoted to crew'],
    ['staff_roles', '{not json', ['my_day'], 'an unreadable list narrows to nothing'],
  ];
  for (const [mode, list, expected, why] of cases) {
    const page = shell();
    page.session.setItem('egc_capability_mode', mode);
    page.session.setItem('egc_capabilities', list);
    assert.deepEqual(views(page), expected, why || list);
    assert.equal(page.api.hubCapabilities().includes('business'), expected.includes('people'));
  }
  // Capabilities never widen: a non-business account with manager capabilities stays crew.
  const crew = shell({ user: 'Synthetic.Sales', business: false, role: 'crew' });
  crew.session.setItem('egc_capability_mode', 'staff_roles');
  crew.session.setItem('egc_capabilities', JSON.stringify([...STAFF_CAPABILITIES]));
  assert.deepEqual(views(crew), ['my_day']);
  // Crew pages store the profile in both storages; the tab's own sign-in wins over a stale browser-wide copy.
  const both = shell();
  both.context.localStorage.setItem('egc_capability_mode', 'staff_roles');
  both.context.localStorage.setItem('egc_capabilities', '[]');
  assert.deepEqual(views(both), ['my_day']);
  both.session.setItem('egc_capability_mode', 'legacy');
  assert.ok(views(both).includes('people'));
});

test('/api/hub-auth reports the capability mode with the capabilities it enforces', async t => {
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('configured users need no storage'); });
  const users = { 'Zoe.Static': { passwordHash: 'unused-synthetic-phone-hash', role: 'crew', displayName: 'Synthetic Zoe', staffRoles: ['phone'] } };
  const read = async (env, user) => (await hubAuth.onRequestGet({ env, request: new Request(`${ORIGIN}/api/hub-auth`, { headers: { Cookie: await cookieFor(env, user) } }) })).json();
  const off = staffEnv({}, users), on = staffEnv({ EGC_STAFF_ROLE_PERMISSIONS: 'true' }, users);
  for (const user of ['ZacB', 'TylerG', 'Zoe.Static']) assert.equal((await read(off, user)).capabilityMode, 'legacy', user);
  const zoe = await read(on, 'Zoe.Static');
  assert.deepEqual([zoe.capabilityMode, zoe.capabilities], ['staff_roles', ['customer.send', 'followups.own']]);
  const manager = await read(on, 'TylerG');
  assert.deepEqual([manager.capabilityMode, manager.capabilities], ['legacy', MANAGER], 'no stored roles keeps the legacy grants');
});

function signIn(profile) {
  const page = readFileSync(new URL('../employee.html', import.meta.url), 'utf8');
  const script = page.slice(page.indexOf('let me = null;'), page.indexOf('async function sendBookingConfirmation'));
  const element = () => ({ value: '', textContent: '', style: {}, disabled: false, classList: { add() {}, remove() {} }, setAttribute() {}, focus() {} });
  const elements = new Map(), events = {};
  const context = {
    console, URLSearchParams, Date: FixedDate, Intl, Promise, Set, Map, Error, Event: class { constructor(type) { this.type = type; } },
    sessionStorage: storage(), localStorage: storage({ egc_capability_mode: 'staff_roles', egc_capabilities: '[]' }), navigator: {}, location: { pathname: '/employee', search: '' },
    setInterval: () => 1, clearInterval() {}, setTimeout: () => 1, clearTimeout() {},
    addEventListener: (name, callback) => { events[name] = callback; }, dispatchEvent: event => events[event.type]?.(event),
    document: { readyState: 'complete', body: { classList: { add() {}, remove() {} } }, addEventListener() {}, querySelectorAll: () => [],
      getElementById: id => { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); },
      querySelector(selector) { return selector === '#login-screen .btn-main' ? this.getElementById('login-button') : null; } },
    fetch: async (url, init = {}) => ({ ok: true, status: 200, json: async () => url.includes('firebase-session') ? { ok: true, token: 'synthetic-token' } : init.method === 'DELETE' ? { ok: true } : { ok: true, ...profile } }),
    firebase: { auth: () => ({ signInWithCustomToken: async () => {}, signOut: async () => {} }) },
    showModeSelect() {}, bootDashboard() {}, _dataGeneration: 0, _dataUnsubscribers: [], _listenersStarted: false, _leadsTimer: null,
    jobsCache: [], custsCache: [], leadsCache: [], blockedDays: new Set(), blockedSlots: new Set(),
  };
  context.window = context;
  vm.runInNewContext(`${script}\nglobalThis.ui={doLogin,doLogout};`, context);
  context.document.getElementById('l-user').value = profile.user;
  context.document.getElementById('l-pass').value = 'SyntheticPassword1';
  return context;
}

test('employee.html keeps the server capabilities and mode for the tab and clears them at sign-out', async () => {
  const zoe = signIn({ user: 'Zoe.Phone', role: 'crew', businessAccess: false, capabilities: ['customer.send', 'followups.own', 7], capabilityMode: 'staff_roles' });
  await zoe.ui.doLogin();
  assert.equal(zoe.sessionStorage.getItem('egc_capabilities'), JSON.stringify(['customer.send', 'followups.own']));
  assert.equal(zoe.sessionStorage.getItem('egc_capability_mode'), 'staff_roles');
  await zoe.ui.doLogout();
  for (const store of [zoe.sessionStorage, zoe.localStorage]) for (const key of ['egc_capabilities', 'egc_capability_mode']) assert.equal(store.getItem(key), null, key);
  const legacy = signIn({ user: 'TylerG', role: 'manager', businessAccess: true, capabilities: MANAGER });
  await legacy.ui.doLogin();
  assert.equal(legacy.sessionStorage.getItem('egc_capability_mode'), 'legacy', 'anything but staff_roles is stored as legacy');
});

test('the crew sign-in client stores and clears the capability mode with the capabilities', async () => {
  const context = { sessionStorage: storage(), localStorage: storage(), console, Error, Promise, JSON, Number, String, Array, Math,
    document: { readyState: 'loading', querySelector: () => null, getElementById: () => null, createElement: () => ({}) }, location: { pathname: '/crew/' },
    firebase: { auth: () => ({ signInWithCustomToken: async () => {}, signOut: async () => {} }) }, addEventListener() {}, dispatchEvent() {}, Event: class {},
    fetch: async url => ({ ok: true, status: 200, json: async () => String(url).includes('firebase-session') ? { ok: true, token: 'synthetic-token' } : { ok: true, user: 'Zoe.Phone', role: 'crew', businessAccess: false, capabilities: ['customer.send'], capabilityMode: 'staff_roles' } }) };
  context.window = context;
  vm.runInNewContext(readFileSync(new URL('../crew/hub-auth.js', import.meta.url), 'utf8'), context);
  assert.equal(await context.EGCHubAuth.session(), 'Zoe.Phone');
  for (const store of [context.sessionStorage, context.localStorage]) assert.equal(store.getItem('egc_capability_mode'), 'staff_roles');
  await context.EGCHubAuth.signOut();
  for (const store of [context.sessionStorage, context.localStorage]) assert.equal(store.getItem('egc_capability_mode'), null);
});

test('employee.html loads the staff directory before the suite with one cache-busted script', () => {
  const page = readFileSync(new URL('../employee.html', import.meta.url), 'utf8');
  assert.equal(page.match(/<script src="employee-staff\.js\?v=20260928team"><\/script>/g)?.length, 1);
  assert.equal(page.match(/<link rel="stylesheet" href="employee-staff\.css\?v=20260928team">/g)?.length, 1);
  assert.ok(page.indexOf('employee-staff.js?v=') < page.indexOf('employee-suite.js?v='));
  // Loading it again through the screen registry must not reset the module (the registry injects its own tag).
  const context = { window: null, document: createDocument(), addEventListener() {}, crypto, AbortController, sessionStorage: storage() };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(source, context);
  const first = context.EGCStaff;
  vm.runInContext(source, context);
  assert.equal(context.EGCStaff, first);
});
