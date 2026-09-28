import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createDocument, storage, FixedDate } from './helpers/hub-dom.mjs';

const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
function kit(initial = { egc_u: 'Synthetic.Crew' }) {
  const document = createDocument(), timers = [], events = {}, session = storage(initial);
  const context = {
    console, URL, URLSearchParams, Intl, Promise, Map, Set, Error, JSON, Object, Array, Math, AbortController, crypto, Blob,
    Date: FixedDate, Node: document.Node, document, sessionStorage: session,
    setTimeout: (callback, delay) => { timers.push({ callback, delay }); return timers.length; }, clearTimeout: id => { if (timers[id - 1]) timers[id - 1].cleared = true; },
    addEventListener: (name, listener) => { (events[name] ||= []).push(listener); },
  };
  context.window = context;
  vm.runInNewContext(readFileSync(new URL('../employee-ui-kit.js', import.meta.url), 'utf8'), context, { filename: 'employee-ui-kit.js' });
  return { api: context.EGCHubKit, context, document, timers, events, session };
}
const flush = async () => { for (let index = 0; index < 20; index++) await Promise.resolve(); };

test('localToIso converts Denver wall time and rejects the spring gap and the fall overlap', () => {
  const { api } = kit();
  assert.equal(api.localToIso('2026-07-04', '09:30'), '2026-07-04T15:30:00.000Z');
  assert.equal(api.localToIso('2026-12-01', '09:30'), '2026-12-01T16:30:00.000Z');
  assert.equal(api.localToIso('2026-03-08', '01:59'), '2026-03-08T08:59:00.000Z');
  assert.equal(api.localToIso('2026-03-08', '02:30'), null, '2:30 AM does not exist on the spring-forward day');
  assert.equal(api.localToIso('2026-03-08', '03:00'), '2026-03-08T09:00:00.000Z');
  assert.equal(api.localToIso('2026-11-01', '01:30'), null, '1:30 AM happens twice on the fall-back day');
  assert.equal(api.localToIso('2026-11-01', '01:00'), null);
  assert.equal(api.localToIso('2026-11-01', '02:00'), '2026-11-01T09:00:00.000Z');
  for (const [date, time] of [['2026-02-30', '09:00'], ['2026-09-22', '24:00'], ['2026-9-22', '09:00'], ['', ''], ['2026-09-22', '9:00']]) assert.equal(api.localToIso(date, time), null, `${date} ${time}`);
});

test('Denver dates use the injected instant, not the device clock or time zone', () => {
  const { api } = kit();
  assert.equal(api.today(new Date('2026-09-23T03:30:00.000Z')), '2026-09-22', 'still Monday evening in Denver');
  assert.equal(api.today(new Date('2026-09-23T06:30:00.000Z')), '2026-09-23');
  assert.equal(api.today(), '2026-09-22', 'defaults to the page clock');
  assert.equal(api.addDays('2026-03-07', 1), '2026-03-08');
  assert.equal(api.addDays('2026-11-01', -1), '2026-10-31');
  assert.equal(api.addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(api.addDays('2026-02-30', 1), null);
  assert.equal(api.addDays('2026-09-22', 1.5), null);
});

test('validDate, addDays and localToIso return false or null for impossible dates instead of throwing', () => {
  const { api } = kit();
  for (const date of ['2026-13-01', '2026-09-32', '2026-00-10', '2026-09-00', '2026-02-30', '2026-02-29', '2026-04-31', '9999-99-99', '0000-00-00', '2026-9-22', ' 2026-09-22', '2026-09-22T00:00', '', null, undefined, 20260922, {}]) {
    assert.equal(api.validDate(date), false, JSON.stringify(date));
    assert.equal(api.addDays(date, 1), null, JSON.stringify(date));
    assert.equal(api.localToIso(date, '09:00'), null, JSON.stringify(date));
  }
  for (const date of ['2026-09-22', '2024-02-29', '2026-12-31', '2026-01-01']) assert.equal(api.validDate(date), true, date);
  assert.equal(api.addDays('2024-02-28', 1), '2024-02-29');
  assert.equal(api.addDays('2026-02-28', 1), '2026-03-01');
  assert.equal(api.localToIso('2024-02-29', '09:00'), '2024-02-29T16:00:00.000Z');
});

test('csvCell neutralises spreadsheet formulas and quotes every cell', () => {
  const { api } = kit();
  assert.equal(api.csvCell('=HYPERLINK("https://example.invalid","x")'), `"'=HYPERLINK(""https://example.invalid"",""x"")"`);
  for (const value of ['+1', '-2', '@SUM(A1)', '\tcmd', '\rcmd']) assert.equal(api.csvCell(value), `"'${value}"`, JSON.stringify(value));
  assert.equal(api.csvCell('Synthetic "Customer"'), '"Synthetic ""Customer"""');
  assert.equal(api.csvCell(null), '""');
  assert.equal(api.csvCell(12.5), '"12.5"');
  assert.equal(api.csvText([['Name', 'Amount'], ['=cmd', '10.00']]), '"Name","Amount"\r\n"\'=cmd","10.00"');
});

test('requestJSON times out after 30 seconds as a retryable 503 with the screen prefix', async () => {
  const { api, timers } = kit();
  let aborted = false;
  const fetcher = (url, init) => new Promise((resolve, reject) => init.signal.addEventListener('abort', () => { aborted = true; reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); }));
  const request = api.requestJSON('/api/timesheets?week=2026-09-21', { fetcher, prefix: 'timesheets' });
  assert.equal(timers[0].delay, 30000);
  timers[0].callback();
  const error = await request.then(() => null, problem => problem);
  assert.equal(aborted, true);
  assert.equal(error.code, 'timesheets_timeout');
  assert.equal(error.status, 503);
  assert.equal(api.retryable(error), true);
});

test('requestJSON accepts only a same-origin API path and a strict {ok:true} envelope', async () => {
  const { api, timers } = kit();
  let calls = 0, reply = json({ ok: true, rows: [] });
  const fetcher = async (url, init) => { calls++; assert.equal(init.cache, 'no-store'); assert.equal(init.credentials, 'same-origin'); return reply; };
  assert.deepEqual({ ...(await api.requestJSON('/api/timesheets', { fetcher })) }, { ok: true, rows: [] });
  assert.equal(timers[0].cleared, true, 'the timeout is cleared after a response');
  for (const path of ['https://example.invalid/api/timesheets', '//example.invalid/api/x', '/employee', 'javascript:alert(1)']) await assert.rejects(api.requestJSON(path, { fetcher }), error => error.code === 'hub_invalid_request');
  assert.equal(calls, 1);
  const cases = [
    [json({ ok: false, code: 'invoice_revision_conflict', error: 'This invoice changed. Refresh and retry.' }, 409), 'invoice_revision_conflict', 409, false],
    [json({ ok: false, error: 'Synthetic storage unavailable, retry shortly.' }, 503), 'hub_failed', 503, true],
    [json({ error: 'operations_unavailable' }, 503), 'operations_unavailable', 503, true],
    [json({ ok: true }, 200), null, 0, false],
    [json({ rows: [] }, 200), 'hub_unverified', 503, true],
    [json([1, 2], 200), 'hub_unverified', 503, true],
    [{ ok: true, status: 200, json: async () => { throw new SyntaxError('not json'); } }, 'hub_unverified', 503, true],
    [json({ ok: false, error: 'Signed out' }, 401), 'hub_failed', 401, true],
    [json({ ok: false, error: 'Wrong shape of input.' }, 400), 'hub_failed', 400, false],
  ];
  for (const [response, code, status, retry] of cases) {
    reply = response;
    const outcome = await api.requestJSON('/api/timesheets', { fetcher }).then(() => null, error => error);
    if (!code) { assert.equal(outcome, null); continue; }
    assert.equal(outcome.code, code); assert.equal(outcome.status, status); assert.equal(api.retryable(outcome), retry, code);
  }
  reply = json({ ok: true, rows: 'not rows' });
  await assert.rejects(api.requestJSON('/api/timesheets', { fetcher, validate: body => Array.isArray(body.rows) }), error => error.code === 'hub_unverified' && error.status === 503);
  const network = async () => { throw new TypeError('Failed to fetch'); };
  await assert.rejects(api.requestJSON('/api/timesheets', { fetcher: network, prefix: 'timesheets' }), error => error.code === 'timesheets_unavailable' && error.status === 503);
});

test('the pending store persists before sending and replays the exact request with the same requestId', async () => {
  const { api, session } = kit();
  const sent = [];
  let fail = true;
  const fetcher = async (url, init) => { sent.push({ url, method: init.method, body: JSON.parse(init.body) }); return fail ? json({ ok: false, error: 'Synthetic outage, retry the same request.' }, 503) : json({ ok: true, invoice: { id: 'invoice-1' } }); };
  const store = api.pending('invoices', 'Synthetic.Crew', { now: () => new Date('2026-09-22T18:00:00.000Z') });
  const first = await store.submit('/api/invoices', { action: 'invoice.save', changes: { memo: 'Synthetic memo' } }, { fetcher }).then(() => null, error => error);
  assert.equal(first.status, 503);
  const saved = store.get();
  assert.match(saved.requestId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(saved.savedAt, '2026-09-22T18:00:00.000Z');
  assert.equal(first.pending.requestId, saved.requestId);
  assert.equal(JSON.parse(session.getItem(store.key)).body.requestId, saved.requestId, 'persisted before the response');
  await assert.rejects(store.submit('/api/invoices', { action: 'invoice.save', changes: { memo: 'Second draft' } }, { fetcher }), error => error.code === 'hub_pending_exists' && error.status === 409);
  assert.equal(sent.length, 1, 'a second request is refused while one is unresolved');
  fail = false;
  const replayed = await store.replay({ fetcher });
  assert.equal(replayed.invoice.id, 'invoice-1');
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[1], sent[0], 'the replay is the identical request');
  assert.equal(sent[1].body.requestId, saved.requestId);
  assert.equal(store.get(), null, 'a confirmed request is cleared');
  await assert.rejects(store.replay({ fetcher }), error => error.code === 'hub_pending_missing');
});

test('the pending store discards rejected requests, isolates viewers and clears on sign-out', async () => {
  const { api, session, events } = kit();
  const conflict = async () => json({ ok: false, code: 'invoice_revision_conflict', error: 'This invoice changed. Refresh and retry.' }, 409);
  const alice = api.pending('invoices', 'Alice'), bob = api.pending('invoices', 'Bob'), timeout = api.pending('timesheets', 'Alice');
  assert.notEqual(alice.key, bob.key);
  await assert.rejects(alice.submit('/api/invoices', { action: 'invoice.save' }, { fetcher: conflict }), error => error.code === 'invoice_revision_conflict');
  assert.equal(alice.get(), null, 'a definite rejection is not retried');
  const lost = async () => { throw new TypeError('Failed to fetch'); };
  await assert.rejects(alice.submit('/api/invoices', { action: 'invoice.save' }, { fetcher: lost }));
  await assert.rejects(timeout.submit('/api/timesheets', { action: 'timesheet.approve' }, { fetcher: lost }));
  assert.ok(alice.get());
  assert.equal(bob.get(), null, 'another viewer never sees the saved request');
  session.setItem('egc_u', 'Alice');
  session.setItem('egc.dispatch.pending.v1.alice', 'kept by its own module');
  events['egc:signout'].forEach(listener => listener());
  assert.equal(alice.get(), null);
  assert.equal(timeout.get(), null);
  assert.equal(session.getItem('egc_u'), 'Alice');
  assert.equal(session.getItem('egc.dispatch.pending.v1.alice'), 'kept by its own module');
  assert.throws(() => api.pending('Bad Screen', 'Alice'), error => error.code === 'hub_pending_invalid');
  session.setItem(api.pending('invoices', 'Carol').key, JSON.stringify({ path: '/api/invoices', method: 'POST', requestId: 'not-a-uuid', body: { requestId: 'not-a-uuid' } }));
  assert.equal(api.pending('invoices', 'Carol').get(), null, 'a malformed saved request is ignored, not replayed');
});

test('money stays in integer cents and unknown amounts stay null', () => {
  const { api } = kit();
  assert.equal(api.cents('12.34'), 1234);
  assert.equal(api.cents('$1,234.50'), 123450);
  assert.equal(api.cents('7'), 700);
  assert.equal(api.cents('-5.10'), -510);
  assert.equal(api.cents(0.1 + 0.2), 30);
  assert.equal(api.cents(19.99), 1999);
  for (const value of ['12.345', 'abc', '', null, undefined, NaN, Infinity, 1.005, '1,23']) assert.equal(api.cents(value), null, String(value));
  assert.equal(api.money(123450), '$1,234.50');
  assert.equal(api.money(-510), '-$5.10');
  assert.equal(api.money(null), '—');
  assert.equal(api.money(12.5), '—', 'fractional cents are not money');
});

test('h(), button() and field() build labelled mobile controls without executable URLs', () => {
  const { api } = kit();
  const phone = api.field({ label: 'Customer phone', name: 'phone', type: 'tel', autocomplete: 'tel', help: 'Mobile preferred' });
  const input = phone.querySelector('input');
  assert.equal(phone.className, 'hub-field');
  assert.equal(phone.getAttribute('for'), input.id);
  assert.equal(input.getAttribute('type'), 'tel');
  assert.equal(input.getAttribute('inputmode'), 'tel');
  assert.equal(input.getAttribute('aria-describedby'), phone.querySelector('small').id);
  assert.equal(api.field({ label: 'Amount', name: 'amount', type: 'number', step: '0.01' }).querySelector('input').getAttribute('inputmode'), 'decimal');
  const select = api.field({ label: 'Status', name: 'status', type: 'select', value: 'paused', options: [{ value: 'active', label: 'Active' }, { value: 'paused', label: 'Paused' }] }).querySelector('select');
  assert.deepEqual(select.querySelectorAll('option').map(option => [option.value, Boolean(option.selected || option.hasAttribute('selected'))]), [['active', false], ['paused', true]]);
  const done = api.button('Save', () => {}, 'primary');
  assert.equal(done.className, 'hub-btn primary');
  assert.equal(done.type, 'button');
  assert.equal(api.h('a', { href: 'javascript:alert(1)' }, 'x').getAttribute('href'), null);
  assert.equal(api.h('a', { href: '/employee?view=today' }, 'x').href, '/employee?view=today');
  assert.equal(api.h('p', {}, '<b>not markup</b>').textContent, '<b>not markup</b>');
});

test('h() resolves every URL the way the browser will and keeps only http, https, mailto, tel and same-origin links', () => {
  const { api, context } = kit();
  context.location = { href: 'https://easygaragecleaning.com/employee?view=today' };
  const refused = [
    'javascript:alert(1)', 'JaVaScRiPt:alert(1)', ' javascript:alert(1)', 'java\tscript:alert(1)', 'java\nscript:alert(1)', 'java\rscript:alert(1)',
    'jav\u0009ascript:alert(1)', '\u0001javascript:alert(1)', '\u0000javascript:alert(1)', '\u001fjavascript:alert(1)', '\u0020\u0010javascript:alert(1)',
    'vbscript:msgbox(1)', 'data:text/html,<script>alert(1)</script>', 'DATA:image/svg+xml,<svg onload=alert(1)>', 'blob:https://easygaragecleaning.com/1', 'file:///etc/passwd',
    'ftp://example.invalid/x', 'about:blank', 'http://[bad', 'https://',
  ];
  for (const url of refused) {
    for (const key of ['href', 'src', 'action', 'formaction', 'poster', 'HREF']) assert.equal(api.h('a', { [key]: url }).getAttribute(key.toLowerCase()), null, `${key}=${JSON.stringify(url)}`);
  }
  const kept = ['https://easygaragecleaning.com/projects', 'http://example.invalid/page', 'mailto:synthetic@example.invalid', 'tel:+19705550100', '/employee?view=customers', '?view=finance', '#ops-main', 'crew/', '//example.invalid/x'];
  for (const url of kept) assert.equal(api.h('a', { href: url }).getAttribute('href'), url, url);
  assert.equal(api.h('img', { src: '/logo.png' }).getAttribute('src'), '/logo.png');
  const inert = api.h('div', { innerHTML: '<img src=x onerror=alert(1)>', outerHTML: '<script>x</script>', srcdoc: '<script>x</script>', INNERHTML: '<b>x</b>', onclick: 'alert(1)', onMouseOver: 'alert(1)' }, 'plain');
  assert.equal(inert.textContent, 'plain');
  assert.equal(inert.childNodes.length, 1);
  for (const name of ['innerHTML', 'outerHTML', 'srcdoc', 'INNERHTML', 'onclick', 'onMouseOver', 'onmouseover']) assert.equal(inert.getAttribute(name), null, name);
  assert.equal(inert.innerHTML, '', 'markup props never reach the node');
  let clicks = 0;
  api.h('button', { onClick: () => { clicks++; } }).click();
  assert.equal(clicks, 1, 'function handlers are still attached');
  delete context.location;
  assert.equal(api.h('a', { href: 'java\tscript:alert(1)' }).getAttribute('href'), null, 'no page location still parses against a placeholder origin');
  assert.equal(api.h('a', { href: '/employee' }).getAttribute('href'), '/employee');
});

test('errorText explains retry, conflict and access outcomes without inventing success', () => {
  const { api } = kit();
  assert.match(api.errorText({ code: 'invoices_timeout', status: 503 }), /retry the original request/);
  assert.match(api.errorText({ code: 'invoice_revision_conflict', status: 409 }), /draft is kept/);
  assert.match(api.errorText({ code: 'invoice_outcome_unknown', status: 503 }), /do not create another/);
  assert.match(api.errorText({ status: 401 }), /Sign in again/);
  assert.match(api.errorText({ status: 403 }), /does not have access/);
  assert.equal(api.errorText({ code: 'invoice_paid' }, { invoice_paid: 'This invoice is already paid.' }), 'This invoice is already paid.');
  assert.equal(api.errorText({ code: 'toString' }, {}), 'The Hub is unavailable. Retry the original request.');
});
