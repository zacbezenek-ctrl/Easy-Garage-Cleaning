import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createDocument, storage, FixedDate } from './helpers/hub-dom.mjs';

// EGCStaffAccess (employee-staff-access.js) in a vm with a small DOM, a routed Hub fetch and injected timers; the real clock
// is never read. The browser test (tests/browser/test_staff_access_ui.py) covers layout and the full Hub at 390px.
const source = readFileSync(new URL('../employee-staff-access.js', import.meta.url), 'utf8');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OWNER_CAPS = ['dispatch.write', 'time.approve', 'pay.manage', 'accounts.approve', 'customer.send'];
const settle = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)); };
const all = (root, selector) => root.querySelectorAll(selector);
const buttonText = (root, text) => all(root, 'button').find(node => node.textContent === text);

function ui({ capabilities = [...OWNER_CAPS, 'accounts.reset'], owner = true, user = 'ZacB', answer } = {}) {
  const document = createDocument(), events = {}, calls = [], session = storage({ egc_u: user, egc_owner: owner ? 'true' : 'false', egc_capabilities: JSON.stringify(capabilities) });
  const state = { answer: answer || (async () => ({ status: 503, body: { ok: false, error: 'unrouted' } })) };
  const context = {
    console, Intl, Promise, Set, Map, Error, JSON, Object, Array, Math, Number, String, Symbol, AbortController, crypto, Date: FixedDate, document,
    sessionStorage: session, localStorage: storage(), setTimeout: () => 0, clearTimeout() {}, navigator: {},
    addEventListener: (name, listener) => { (events[name] ||= []).push(listener); },
    fetch: async () => { throw new Error('the Hub fetch is always used'); },
  };
  context.window = context;
  context.hubFetch = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ url, method: init.method || 'GET', body });
    const result = await state.answer({ url, method: init.method || 'GET', body });
    if (result instanceof Error) throw result;
    return { ok: (result.status || 200) < 400, status: result.status || 200, json: async () => structuredClone(result.body) };
  };
  vm.createContext(context);
  vm.runInContext(source, context, { filename: 'employee-staff-access.js' });
  return { context, document, calls, state, session, api: context.EGCStaffAccess, dialog: () => document.body.querySelector('dialog.sa-dialog'), fire: name => (events[name] || []).forEach(listener => listener({ type: name })) };
}
const submit = dialog => { const form = dialog.querySelector('form'); assert.ok(form, 'the dialog has a form'); form.dispatchEvent({ type: 'submit', preventDefault() {} }); };
const pendingKeys = session => [...session.values.keys()].filter(key => key.startsWith('egc.hub.pending.v1.staffaccess.'));

test('the flag is read from the capabilities the server reported: nothing shows without them', () => {
  const off = ui({ capabilities: OWNER_CAPS });
  assert.deepEqual([off.api.enabled(), off.api.approves(), off.api.resets(), off.api.approvalCopy()], [false, false, false, '']);
  off.api.openReset({ username: 'Crew.One', displayName: 'Synthetic Crew One' });
  assert.equal(off.dialog(), null, 'no reset without accounts.reset');
  const owner = ui();
  assert.deepEqual([owner.api.enabled(), owner.api.approves(), owner.api.resets()], [true, true, true]);
  assert.match(owner.api.approvalCopy(), /Only the owner sets pay/);
  // A manager holds accounts.approve only by the owner's grant, so that alone means the flag is on.
  const manager = ui({ capabilities: ['time.approve', 'dispatch.write', 'accounts.approve'], owner: false, user: 'TylerG' });
  assert.deepEqual([manager.api.enabled(), manager.api.approves(), manager.api.resets()], [true, true, false]);
  const crew = ui({ capabilities: ['password.change'], owner: false, user: 'Crew.One' });
  assert.deepEqual([crew.api.enabled(), crew.api.approves(), crew.api.resets()], [true, false, false]);
  assert.deepEqual(Object.keys(owner.api).sort(), ['applyRate', 'approvalCopy', 'approves', 'canLeave', 'enabled', 'mount', 'openReset', 'refresh', 'resets', 'review', 'unmount']);
});

test('reset: the request is kept before it is sent, a lost answer is retried with the same requestId, and sign-out clears it', async () => {
  const t = ui();
  t.state.answer = async () => new TypeError('Failed to fetch');
  t.api.openReset({ username: 'Crew.One', displayName: 'Synthetic Crew One' });
  const dialog = t.dialog();
  assert.match(dialog.textContent, /Reset sign-in for Synthetic Crew One\?[\s\S]*The Hub sends nothing\./);
  submit(dialog);
  await settle();
  assert.equal(t.calls.length, 1);
  const first = t.calls[0].body;
  assert.deepEqual([first.action, first.username, first.expectedUser], ['reset_signin', 'Crew.One', 'ZacB']); assert.match(first.requestId, UUID);
  assert.match(t.dialog().textContent, /could not be reached/);
  assert.match(t.dialog().textContent, /kept exactly as sent/);
  assert.equal(pendingKeys(t.session).length, 1);
  assert.ok(buttonText(t.dialog(), 'Retry original reset'));
  // Closing and reopening the dialog offers the same kept request.
  buttonText(t.dialog(), 'Cancel').click();
  assert.equal(t.dialog(), null);
  t.api.openReset({ username: 'Crew.One', displayName: 'Synthetic Crew One' });
  t.state.answer = async ({ body }) => ({ body: { ok: true, username: body.username, link: 'https://easygaragecleaning.com/staff-setup#invite=reset-x.' + 'A'.repeat(43), expiresAt: '2026-09-23T18:00:00.000Z', linkShown: true, sent: false, firebaseRevocation: { status: 'revoked' } } });
  submit(t.dialog());
  await settle();
  assert.equal(t.calls[1].body.requestId, first.requestId, 'the retry reuses the requestId');
  assert.deepEqual(t.calls[1].body, first);
  assert.equal(t.dialog().querySelector('input.sa-link').value, 'https://easygaragecleaning.com/staff-setup#invite=reset-x.' + 'A'.repeat(43));
  assert.match(t.dialog().textContent, /The Hub has not sent it\. It works once, until Wed, Sep 23, 12:00 PM \(Denver\)/);
  assert.equal(pendingKeys(t.session).length, 0);
  // A permanent refusal is not kept; sign-out clears anything kept and closes the dialog.
  t.state.answer = async () => ({ status: 403, body: { ok: false, code: 'staff_access_forbidden', error: 'Only the owner can reset a manager\'s sign-in.' } });
  t.api.openReset({ username: 'Stored.Manager' });
  submit(t.dialog());
  await settle();
  assert.match(t.dialog().textContent, /Only the owner can reset a manager's sign-in\./);
  assert.equal(pendingKeys(t.session).length, 0);
  t.state.answer = async () => ({ status: 503, body: { ok: false, code: 'staff_access_outcome_unknown', error: 'The save could not be verified.' } });
  submit(t.dialog());
  await settle();
  assert.equal(pendingKeys(t.session).length, 1);
  t.fire('egc:signout');
  assert.equal(t.dialog(), null); assert.equal(pendingKeys(t.session).length, 0);
});

test('review: the owner must enter a starting rate; a granted manager is asked for the role only', async () => {
  const owner = ui(), done = [];
  owner.state.answer = async ({ method, body }) => method === 'GET' ? { body: { ok: true, accounts: [], staffAccess: { setsPay: true, roles: ['manager', 'crew_lead', 'crew', 'sales', 'phone'], resets: true } } }
    : { body: { ok: true, account: { username: body.username, status: 'approved', staffRoles: body.staffRoles }, firebaseRevocation: { status: 'revocation_pending' }, payPending: false } };
  owner.api.review({ username: 'New.Hire', displayName: 'Synthetic New Hire', decision: 'approved', onDone: (result, text) => done.push(text) });
  await settle();
  const rate = owner.dialog().querySelector('input[name="hourlyRate"]'), role = owner.dialog().querySelector('select[name="role"]');
  assert.ok(rate && role);
  assert.equal(rate.getAttribute('inputmode'), 'decimal');
  assert.deepEqual(all(role, 'option').map(option => option.value), ['manager', 'crew_lead', 'crew', 'sales', 'phone']);
  for (const bad of ['', '0', '12.345', '600', 'abc']) {
    rate.value = bad; rate.dispatchEvent({ type: 'input', target: rate });
    submit(owner.dialog()); await settle();
    assert.match(owner.dialog().textContent, /Enter the starting hourly rate/, bad);
  }
  assert.equal(owner.calls.filter(call => call.method === 'POST').length, 0);
  role.value = 'sales'; role.dispatchEvent({ type: 'change', target: role });
  const typed = owner.dialog().querySelector('input[name="hourlyRate"]');
  typed.value = '$21.5'; typed.dispatchEvent({ type: 'input', target: typed });
  submit(owner.dialog()); await settle();
  const post = owner.calls.find(call => call.method === 'POST').body;
  assert.deepEqual({ ...post, requestId: 'x' }, { action: 'review', requestId: 'x', username: 'New.Hire', decision: 'approved', staffRoles: ['sales'], hourlyRate: 21.5 });
  assert.equal(owner.dialog(), null);
  assert.equal(done.length, 1); assert.match(done[0], /Synthetic New Hire is on the team and can now sign in\. Ending their Firebase data sessions is pending/);
  const manager = ui({ capabilities: ['time.approve', 'accounts.approve'], owner: false, user: 'TylerG' }), notes = [];
  manager.state.answer = async ({ method, body }) => method === 'GET' ? { body: { ok: true, accounts: [], staffAccess: { setsPay: false, roles: ['crew_lead', 'crew', 'sales', 'phone'], resets: false } } }
    : { body: { ok: true, account: { username: body.username, status: 'approved' }, firebaseRevocation: { status: 'revoked' }, payPending: true } };
  manager.api.review({ username: 'New.Hire', decision: 'approved', onDone: (result, text) => notes.push(text) });
  await settle();
  assert.equal(manager.dialog().querySelector('input[name="hourlyRate"]'), null);
  assert.match(manager.dialog().textContent, /Pay stays pending: only the owner sets the starting rate/);
  submit(manager.dialog()); await settle();
  const sent = manager.calls.find(call => call.method === 'POST').body;
  assert.equal('hourlyRate' in sent, false); assert.deepEqual(sent.staffRoles, ['crew']);
  assert.match(notes[0], /Pay is pending: the owner sets the starting rate before their first shift\./);
  // Options that cannot be verified show unavailable with Retry, never a form.
  const broken = ui();
  broken.state.answer = async () => ({ body: { ok: true, accounts: [] } });
  broken.api.review({ username: 'New.Hire', decision: 'approved' });
  await settle();
  assert.match(broken.dialog().textContent, /Account review unavailable/); assert.ok(buttonText(broken.dialog(), 'Retry'));
  assert.equal(broken.dialog().querySelector('form'), null);
});

test('apply rate: exported weeks cannot be chosen, and a change since the preview asks for a new preview', async () => {
  const t = ui({ capabilities: [...OWNER_CAPS, 'accounts.reset'] });
  const weeks = [{ weekStart: '2026-09-14', weekEnd: '2026-09-20', exported: true, exportedAt: '2026-09-21T15:00:00.000Z', timecards: 1, hours: 5, rates: [22.5], pay: 112.5 },
    { weekStart: '2026-09-21', weekEnd: '2026-09-27', exported: false, timecards: 2, hours: 7, rates: [22.5], pay: 157.5 }];
  let apply = async () => ({ status: 409, body: { ok: false, code: 'staff_access_revision_conflict', error: 'The pay schedule or these timecards changed since the preview. Preview again before applying.' } });
  t.state.answer = async ({ body }) => body.action === 'preview_apply_rate' ? { body: { ok: true, username: body.username, expectedRevision: 'rev-1', planDigest: 'b'.repeat(64), weeks } } : apply(body);
  t.api.applyRate({ username: 'Crew.One', displayName: 'Synthetic Crew One' }, { ctx: { hubFetch: t.context.hubFetch } });
  await settle();
  const boxes = all(t.dialog(), 'input').filter(node => node.getAttribute('name') === 'week');
  assert.deepEqual(boxes.map(box => [box.value, box.hasAttribute('disabled'), box.checked]), [['2026-09-14', true, false], ['2026-09-21', false, true]]);
  assert.match(t.dialog().textContent, /Exported Mon, Sep 21, 9:00 AM \(Denver\): keeps its saved rate/);
  submit(t.dialog()); await settle();
  const sent = t.calls.at(-1).body;
  assert.deepEqual({ ...sent, requestId: 'x' }, { action: 'apply_rate', requestId: 'x', username: 'Crew.One', expectedRevision: 'rev-1', planDigest: 'b'.repeat(64), weeks: ['2026-09-21'], expectedUser: 'ZacB' });
  assert.match(t.dialog().textContent, /changed since the preview/);
  assert.ok(buttonText(t.dialog(), 'Preview again'));
  buttonText(t.dialog(), 'Preview again').click(); await settle();
  apply = async body => ({ body: { ok: true, username: body.username, applied: { weeks: body.weeks, timecards: 2 } } });
  submit(t.dialog()); await settle();
  assert.notEqual(t.calls.at(-1).body.requestId, sent.requestId, 'a new preview is a new request');
  assert.match(t.dialog().textContent, /Saved: 2 timecards now use the scheduled rate \(week of Sep 21\)/);
});

test('the staff setup page turns into a new-password form for a reset link and never asks for the work email', async () => {
  const { onRequest } = await import('../functions/staff-setup.js');
  const html = await (await onRequest({ request: new Request('https://easygaragecleaning.com/staff-setup') })).text();
  assert.match(html, /\/staff-setup\.js\?v=2/);
  const document = createDocument(), calls = [];
  document.body.innerHTML = /<body>([\s\S]*)<\/body>/.exec(html)[1];
  const form = document.getElementById('setup');
  form.reset = () => { for (const input of form.querySelectorAll('input')) input.value = ''; };
  const invite = 'reset-Y3Jldy5vbmU.' + 'A'.repeat(43);
  const answers = [{ ok: true, kind: 'reset', username: 'Crew.One', name: 'Synthetic Crew One', status: 'reset', expiresAt: '2026-09-23T18:00:00.000Z' }, { ok: true, username: 'Crew.One', reset: true, loginUrl: '/staff-login' }];
  const context = { document, console, Promise, JSON, Date: FixedDate, URLSearchParams, location: { hash: '#invite=' + invite, pathname: '/staff-setup' }, history: { replaceState() {} },
    fetch: async (url, init) => { calls.push({ url, body: JSON.parse(init.body), headers: init.headers }); return { ok: true, json: async () => answers.shift() }; } };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(readFileSync(new URL('../staff-setup.js', import.meta.url), 'utf8'), context, { filename: 'staff-setup.js' });
  await settle();
  assert.deepEqual(calls[0].body, { action: 'inspect', invite });
  assert.equal(document.querySelector('h1').textContent, 'Choose a new password.');
  assert.equal(document.getElementById('email').closest('label').hidden, true);
  assert.equal(document.getElementById('activate').textContent, 'Save my new password');
  assert.match(document.getElementById('identity').textContent, /Synthetic Crew One · Username: Crew\.One/);
  document.getElementById('password').value = 'Fresh-Synthetic-Pass-2026';
  document.getElementById('confirm').value = 'Fresh-Synthetic-Pass-2026';
  form.dispatchEvent({ type: 'submit', preventDefault() {} });
  await settle();
  assert.deepEqual(calls[1].body, { action: 'reset', invite, password: 'Fresh-Synthetic-Pass-2026', confirmPassword: 'Fresh-Synthetic-Pass-2026' });
  assert.equal(calls[1].headers['X-EGC-Staff-Setup'], '1');
  assert.equal(document.getElementById('complete').hidden, false);
  assert.match(document.getElementById('complete').textContent, /Your new password is saved[\s\S]*Go to staff sign-in/);
  assert.equal(document.getElementById('password').value, '');
});
