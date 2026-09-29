// FUN-15 owner Ad spend screen (employee-ad-spend.js) on the real UI kit in a vm with a small DOM:
// the operations bridge requests it makes, unknown never shown as $0, the frozen-request retry for
// owner ledger writes, corrections and voids, and who can open it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createDocument, storage, FixedDate, hubPage } from './helpers/hub-dom.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const AS_OF = '2026-09-22T18:00:00.000Z', PENDING = 'egc.hub.pending.v1.ad_spend.zacb';
const DISCLOSURES = ['non_api_channels_count_only_owner_entries', 'manual_spend_allocated_evenly_per_day', 'ad_platform_restatements_after_settlement_not_reflected'];
const PERIOD = { from: '2026-09-01', to: '2026-09-23', requestedTo: '2026-10-01', timeZone: 'America/Denver', inProgress: true };
const source = (name, status, extra = {}) => ({ source: name, status, active: status !== 'not_connected', blockers: status === 'not_connected' ? ['flag_off'] : [], accountIds: [],
  lastAttemptAt: null, lastSuccessAt: null, lastFailure: null, lastRun: null, configurationPublishedAt: AS_OF, ...extra });
const unknownDay = date => ({ date, value: null, status: 'unknown', reasons: ['platform_not_connected'] });
const NOT_CONNECTED = {
  ok: true, authority: 'egc_platform_ad_spend', timeZone: 'America/Denver', asOf: AS_OF, period: PERIOD,
  metric: { key: 'ad_spend', label: 'Ad spend', value: null, unit: 'cents', currency: 'USD', status: 'unknown', asOf: AS_OF, clockSources: [],
    coverage: { included: [], excluded: [{ channel: 'meta_ads', reasons: ['platform_not_connected'] }, { channel: 'google_ads', reasons: ['platform_not_connected'] }], reasons: ['platform_not_connected'], disclosures: DISCLOSURES },
    gaps: [], gapsTruncated: false },
  channels: ['meta_ads', 'google_ads'].map(channel => ({ channel, kind: 'api', clockSource: 'provider', value: null, status: 'unknown', reasons: ['platform_not_connected'], days: [unknownDay('2026-09-01')], accounts: [], blockers: ['flag_off'] })),
  days: [unknownDay('2026-09-01')],
  leadgen: { key: 'meta_leadgen_count', label: 'Meta lead-form leads', unit: 'count', value: null, status: 'unknown', reasons: ['platform_not_connected'], asOf: AS_OF, pages: [], forms: [], days: [] },
  sources: [source('meta_ads', 'not_connected'), source('google_ads', 'not_connected'), source('meta_leadgen', 'not_connected')],
};
const CONNECTED = {
  ...NOT_CONNECTED,
  metric: { ...NOT_CONNECTED.metric, value: 19351, status: 'partial', clockSources: ['attested', 'provider'],
    coverage: { included: ['meta_ads', 'google_ads', 'yard_signs'], excluded: [], reasons: ['owner_attested', 'restatement_window'], disclosures: DISCLOSURES },
    gaps: [{ channel: 'meta_ads', accountId: '1234567890', date: '2026-09-02', reason: 'day_not_pulled' }], gapsTruncated: false },
  channels: [
    { channel: 'meta_ads', kind: 'api', clockSource: 'provider', value: 15351, status: 'partial', reasons: ['day_not_pulled', 'restatement_window'], days: [], accounts: [] },
    { channel: 'google_ads', kind: 'api', clockSource: 'provider', value: 0, status: 'complete', reasons: [], days: [], accounts: [] },
    { channel: 'yard_signs', kind: 'manual', clockSource: 'attested', value: 4000, status: 'complete', reasons: ['owner_attested'], days: [], entryIds: ['44444444-4444-4444-8444-444444444444'] },
  ],
  leadgen: { ...NOT_CONNECTED.leadgen, value: 3, status: 'partial', reasons: ['restatement_window'], forms: [{ formId: '900000000000001', formName: 'Synthetic garage form', pageId: '555000111', count: 3, days: [] }] },
  sources: [source('meta_ads', 'healthy', { lastSuccessAt: AS_OF }), source('google_ads', 'healthy', { lastSuccessAt: AS_OF }),
    source('meta_leadgen', 'failing', { lastSuccessAt: '2026-09-22T10:00:00.000Z', lastFailure: { at: '2026-09-22T17:00:00.000Z', code: 'meta_rate_limited', accountId: '555000111' } })],
};
const ENTRY = { id: '44444444-4444-4444-8444-444444444444', channel: 'yard_signs', description: 'Synthetic yard sign order', amountCents: 30000, currency: 'USD', firstDate: '2026-09-01', lastDate: '2026-09-30',
  receiptReference: 'INV-SYN-2001', clockSource: 'attested', enteredBy: 'zacb', attestedAt: AS_OF, status: 'active', revision: 2, supersedesId: null, closedAt: null, closedBy: null, closeReason: null };
const list = (items = []) => ({ ok: true, items, total: items.length, offset: 0, nextOffset: null });
const reply = (body, status = 200) => ({ ok: status < 400, status, json: async () => structuredClone(body) });
const flush = async (rounds = 40) => { for (let index = 0; index < rounds; index++) await Promise.resolve(); };

function screen({ coverage = () => reply(NOT_CONNECTED), entries = () => reply(list()), write = () => reply({ ok: false, error: 'operations_unavailable', retryable: true }, 503), ask = async () => null } = {}) {
  const document = createDocument(), events = {}, calls = [], toasts = [], session = storage({ egc_u: 'ZacB' });
  const hubFetch = async (url, init = {}) => {
    const body = JSON.parse(init.body);
    calls.push({ url, method: init.method, body, pending: session.getItem(PENDING) });
    const command = body.body.command;
    return command === 'spend.coverage' ? coverage(body) : command === 'spend.entries' ? entries(body) : write(body);
  };
  const context = {
    console, URL, URLSearchParams, Intl, Promise, Map, Set, Error, JSON, Object, Array, Math, AbortController, crypto, structuredClone,
    Date: FixedDate, Node: document.Node, document, sessionStorage: session,
    setTimeout: () => 0, clearTimeout() {},
    addEventListener: (name, listener) => { (events[name] ||= []).push(listener); },
    FormData: class {
      constructor(form) { this.entries = form.querySelectorAll('input,textarea,select').filter(field => field.name).map(field => [field.name, field.value]); }
      get(key) { return this.entries.find(([name]) => name === key)?.[1] ?? null; }
    },
  };
  context.window = context;
  vm.createContext(context);
  for (const file of ['employee-ui-kit.js', 'employee-ad-spend.js']) vm.runInContext(readFileSync(new URL('../' + file, import.meta.url), 'utf8'), context, { filename: file });
  const host = document.createElement('main');
  document.body.append(host);
  const ctx = Object.freeze({ identity: 'ZacB', role: 'owner', capabilities: ['crew', 'business', 'owner'], hubFetch, toast: text => toasts.push(String(text)), askAction: ask, go() {}, screen: 'ad_spend' });
  const mounted = context.EGCAdSpend.mount(host, ctx);
  const root = () => host.querySelector('.egc-ad-spend');
  const text = () => root()?.textContent || '';
  const button = label => { const found = root().querySelectorAll('button').find(node => node.textContent === label); assert.ok(found, 'button ' + label); return found; };
  const form = () => root().querySelector('.as-form');
  const fill = values => { for (const [name, value] of Object.entries(values)) form().querySelector(`[name="${name}"]`).value = value; form().dispatchEvent({ type: 'input' }); };
  const submit = node => node.dispatchEvent({ type: 'submit', preventDefault() {} });
  const writes = () => calls.filter(call => !['spend.coverage', 'spend.entries'].includes(call.body.body.command));
  return { context, host, mounted, calls, writes, toasts, session, events, root, text, button, form, fill, submit, module: context.EGCAdSpend };
}

test('mounts on the Denver month of the injected clock and shows unknown spend as Unknown, never $0', async () => {
  const ui = screen();
  await ui.mounted; await flush();
  assert.deepEqual(ui.calls.map(call => [call.url, call.method, call.body.body]), [
    ['/api/operations', 'POST', { command: 'spend.coverage', from: '2026-09-01', to: '2026-10-01' }],
    ['/api/operations', 'POST', { command: 'spend.entries', from: '2026-09-01', to: '2026-10-01', status: 'active', limit: 200 }]]);
  for (const call of ui.calls) assert.match(call.body.requestId, UUID);
  assert.notEqual(ui.calls[0].body.requestId, ui.calls[1].body.requestId);
  assert.equal(ui.root().querySelector('[data-as-total]').textContent, 'Unknown');
  assert.equal(ui.root().querySelector('[data-as-leads]').textContent, 'Unknown');
  assert.doesNotMatch(ui.root().querySelector('.as-stack').textContent, /\$\d/, 'nothing unrecorded is shown as a dollar amount, least of all $0.00');
  assert.match(ui.text(), /Total ad spend · Sep 1 – Sep 22 \(in progress\)/);
  assert.match(ui.text(), /Not connected yet/);
  assert.match(ui.text(), /Lead-form counts are not connected yet\./);
  assert.deepEqual(ui.root().querySelectorAll('[data-as-channel]').map(row => [row.getAttribute('data-as-channel'), row.querySelector('.as-row-value strong').textContent]),
    [['meta_ads', 'Unknown'], ['google_ads', 'Unknown']]);
  assert.equal(ui.root().querySelector('.as-status').textContent, 'Showing Sep 1 – Sep 22');
  assert.equal(ui.module.canLeave(), true);
});

test('known totals, a pulled zero, owner-entered channels, lead forms and connection health are labelled with their status', async () => {
  const ui = screen({ coverage: () => reply(CONNECTED), entries: () => reply(list([ENTRY])) });
  await ui.mounted; await flush();
  assert.equal(ui.root().querySelector('[data-as-total]').textContent, '$193.51');
  const rows = ui.root().querySelectorAll('[data-as-channel]').map(row => [row.getAttribute('data-as-channel'), row.querySelector('.as-row-value strong').textContent, row.querySelector('.as-badge').textContent]);
  assert.deepEqual(rows, [['meta_ads', '$153.51', 'Partial'], ['google_ads', '$0.00', 'Complete'], ['yard_signs', '$40.00', 'Complete']]);
  assert.match(ui.root().querySelector('[data-as-channel="yard_signs"]').textContent, /Owner-entered/);
  assert.match(ui.text(), /The last 3 days can still change at the platform/);
  assert.equal(ui.root().querySelector('[data-as-leads]').textContent, '3');
  assert.match(ui.text(), /Synthetic garage form/);
  assert.deepEqual(ui.root().querySelectorAll('[data-as-source]').map(row => [row.getAttribute('data-as-source'), row.querySelector('.as-badge').textContent]),
    [['meta_ads', 'Up to date'], ['google_ads', 'Up to date'], ['meta_leadgen', 'Failing']]);
  assert.match(ui.root().querySelector('[data-as-source="meta_leadgen"]').textContent, /Last problem: meta rate limited/);
  assert.match(ui.root().querySelector('.as-gaps summary').textContent, /Missing days \(1\)/);
  assert.match(ui.root().querySelector(`[data-as-entry="${ENTRY.id}"]`).textContent, /Yard signs · \$300\.00.*Receipt: INV-SYN-2001/);
});

test('a failed or unverifiable load shows unavailable with Retry and no stale numbers', async () => {
  let mode = 'ok';
  const ui = screen({ coverage: () => mode === 'ok' ? reply(CONNECTED) : mode === 'down' ? reply({ error: 'operations_unavailable', retryable: true }, 503) : reply({ ...CONNECTED, metric: { ...CONNECTED.metric, coverage: undefined } }) });
  await ui.mounted; await flush();
  assert.equal(ui.root().querySelector('[data-as-total]').textContent, '$193.51');
  for (const failure of ['down', 'malformed']) {
    mode = failure;
    ui.button('Last month').click(); await flush();
    const alert = ui.root().querySelector('.hub-notice.error');
    assert.equal(alert.getAttribute('role'), 'alert');
    assert.match(alert.textContent, /Ad spend is unavailable\..*Nothing here is shown as current\./);
    assert.equal(ui.root().querySelector('[data-as-total]'), null, failure);
    assert.equal(ui.root().querySelector('.as-body'), null, failure);
  }
  assert.deepEqual(ui.calls.at(-2).body.body, { command: 'spend.coverage', from: '2026-08-01', to: '2026-09-01' });
  mode = 'ok';
  ui.button('Retry').click(); await flush();
  assert.equal(ui.root().querySelector('.hub-notice.error'), null);
  assert.equal(ui.root().querySelector('[data-as-total]').textContent, '$193.51');
});

test('an answer for an earlier range never replaces the range the owner chose last', async () => {
  const held = [];
  const ui = screen({ coverage: body => new Promise(resolve => held.push({ body, resolve })) });
  await flush();
  ui.button('Last 30 days').click(); await flush();
  assert.deepEqual(held.map(item => [item.body.body.from, item.body.body.to]), [['2026-09-01', '2026-10-01'], ['2026-08-24', '2026-09-23']]);
  held[1].resolve(reply({ ...CONNECTED, period: { ...PERIOD, from: '2026-08-24' } })); await flush();
  held[0].resolve(reply(NOT_CONNECTED)); await flush(); await ui.mounted;
  assert.equal(ui.root().querySelector('[data-as-total]').textContent, '$193.51');
  assert.match(ui.text(), /Aug 24 – Sep 22/);
  assert.equal(ui.root().querySelector('[aria-pressed="true"]').textContent, 'Last 30 days');
});

test('a custom range is sent as an exclusive Denver end date and a reversed range is refused locally', async () => {
  const ui = screen();
  await ui.mounted; await flush();
  const range = ui.root().querySelector('.as-range'), before = ui.calls.length;
  range.querySelector('[name="from"]').value = '2026-07-04'; range.querySelector('[name="through"]').value = '2026-07-31';
  ui.submit(range); await flush();
  assert.deepEqual(ui.calls[before].body.body, { command: 'spend.coverage', from: '2026-07-04', to: '2026-08-01' });
  const again = ui.root().querySelector('.as-range'), count = ui.calls.length;
  again.querySelector('[name="from"]').value = '2026-07-31'; again.querySelector('[name="through"]').value = '2026-07-04';
  ui.submit(again); await flush();
  assert.equal(ui.calls.length, count, 'no request for a reversed range');
  assert.match(ui.text(), /Choose a first and last day, with the last day on or after the first\./);
});

test('recording spend sends integer cents, freezes the request first and retries it unchanged after an unknown outcome', async () => {
  let outcome = 'unknown';
  const saved = { ok: true, entry: { ...ENTRY, id: '55555555-5555-4555-8555-555555555555', revision: 1, amountCents: 125050 }, superseded: null };
  const ui = screen({ write: () => outcome === 'unknown' ? reply({ error: 'operations_unavailable', retryable: true, message: 'The outcome may be unknown. Retry the same request ID; do not create a new copy.' }, 503) : reply(saved) });
  await ui.mounted; await flush();
  ui.fill({ channel: 'yard_signs', amount: '$1,250.50', firstDate: '2026-09-01', lastDate: '2026-09-30', description: 'Synthetic yard sign order', receiptReference: 'INV-SYN-3001' });
  assert.equal(ui.module.canLeave(), false, 'a typed draft blocks leaving');
  ui.submit(ui.form()); await flush();
  const [first] = ui.writes();
  assert.deepEqual(first.body.body, { command: 'spend.entry.record', entry: { channel: 'yard_signs', description: 'Synthetic yard sign order', amountCents: 125050, firstDate: '2026-09-01', lastDate: '2026-09-30', receiptReference: 'INV-SYN-3001' } });
  assert.match(first.body.requestId, UUID);
  assert.equal(JSON.parse(first.pending).requestId, first.body.requestId, 'the request is saved before it is sent');
  assert.match(ui.text(), /A spend change is waiting to be confirmed\./);
  assert.match(ui.form().querySelector('[role="alert"]').textContent, /outcome may be unknown/);
  outcome = 'saved';
  ui.button('Retry original save').click(); await flush();
  const second = ui.writes()[1];
  assert.deepEqual(second.body, first.body, 'the retry carries the same requestId and body');
  assert.equal(ui.session.getItem(PENDING), null);
  assert.deepEqual(ui.toasts, ['Saved']);
  assert.ok(!ui.text().includes('waiting to be confirmed'));
  assert.equal(ui.form().querySelector('[name="amount"]').value, '', 'the saved draft is cleared');
  assert.equal(ui.module.canLeave(), true);
  assert.equal(ui.calls.filter(call => call.body.body.command === 'spend.coverage').length, 2, 'the totals reload after the save');
});

test('API channels, bad amounts and missing receipts are refused before any request', async () => {
  const ui = screen();
  await ui.mounted; await flush();
  const valid = { channel: 'yard_signs', amount: '125.00', firstDate: '2026-09-01', lastDate: '2026-09-30', description: 'Synthetic flyer run', receiptReference: 'INV-SYN-4001' };
  for (const [change, message] of [[{ channel: 'meta_ads' }, /cannot be typed in/], [{ channel: 'facebook_ads' }, /cannot be typed in/], [{ channel: 'instagram' }, /cannot be typed in/], [{ channel: 'google_lsa' }, /cannot be typed in/],
    [{ channel: 'fb_boosts' }, /cannot be typed in/], [{ channel: 'youtube_preroll' }, /cannot be typed in/], [{ channel: 'Yard Signs' }, /lowercase letters/], [{ amount: '12.345' }, /dollars and cents/], [{ amount: '-5' }, /dollars and cents/],
    [{ lastDate: '2026-08-31' }, /first and last day/], [{ description: '' }, /what the spend was for/], [{ receiptReference: '' }, /receipt or invoice reference/]]) {
    ui.fill({ ...valid, ...change });
    ui.submit(ui.form()); await flush();
    assert.match(ui.form().querySelector('[role="alert"]').textContent, message, JSON.stringify(change));
  }
  assert.deepEqual(ui.writes(), []);
  assert.equal(ui.session.getItem(PENDING), null);
});

test('a correction supersedes the exact revision; a revision conflict keeps the draft and drops the frozen request', async () => {
  const ui = screen({ entries: () => reply(list([ENTRY])), write: () => reply({ error: 'spend_entry_revision_conflict', currentRevision: 3 }, 409) });
  await ui.mounted; await flush();
  ui.button('Correct').click();
  assert.equal(ui.form().querySelector('h2').textContent, 'Correct an entry');
  assert.equal(ui.form().querySelector('[name="amount"]').value, '300.00');
  ui.fill({ amount: '315.00' });
  ui.submit(ui.form()); await flush();
  assert.deepEqual(ui.writes()[0].body.body, { command: 'spend.entry.record', entry: { channel: 'yard_signs', description: ENTRY.description, amountCents: 31500, firstDate: ENTRY.firstDate, lastDate: ENTRY.lastDate, receiptReference: ENTRY.receiptReference },
    supersedes: { entryId: ENTRY.id, revision: 2 } });
  assert.match(ui.form().querySelector('[role="alert"]').textContent, /changed while you were editing/);
  assert.equal(ui.session.getItem(PENDING), null, 'a definite refusal is not kept for retry');
  assert.equal(ui.form().querySelector('[name="amount"]').value, '315.00');
  assert.equal(ui.module.canLeave(), false);
  ui.button('Cancel correction').click();
  assert.equal(ui.form().querySelector('h2').textContent, 'Record spend');
  assert.equal(ui.module.canLeave(), true);
});

test('the screen refuses the same Meta and Google aliases as the platform ledger', () => {
  const alias = source => /API_(?:CHANNEL_)?ALIAS\s*=\s*\/(.+)\/;/.exec(source)?.[1];
  const screenPattern = alias(readFileSync(new URL('../employee-ad-spend.js', import.meta.url), 'utf8'));
  assert.ok(screenPattern);
  assert.equal(screenPattern, alias(readFileSync(new URL('../egc-platform/services/ad-spend/src/ledger.ts', import.meta.url), 'utf8')));
});

test('a conflicted correction offers Discard draft and load latest, which drops the stale draft and reloads', async () => {
  let listed = 0;
  const ui = screen({ entries: () => reply(list([{ ...ENTRY, revision: 2 + listed++ }])), write: () => reply({ error: 'spend_entry_revision_conflict', details: { currentRevision: 3 } }, 409) });
  await ui.mounted; await flush();
  ui.button('Correct').click();
  ui.fill({ amount: '315.00' });
  ui.submit(ui.form()); await flush();
  assert.match(ui.form().querySelector('[role="alert"]').textContent, /changed while you were editing/);
  assert.equal(ui.form().querySelector('[name="amount"]').value, '315.00', 'the draft is kept until the owner discards it');
  const coverage = () => ui.calls.filter(call => call.body.body.command === 'spend.coverage').length, before = coverage();
  ui.button('Discard draft and load latest').click(); await flush();
  assert.equal(coverage(), before + 1, 'the latest totals and list are loaded');
  assert.equal(ui.form().querySelector('h2').textContent, 'Record spend');
  assert.equal(ui.form().querySelector('[name="amount"]').value, '');
  assert.equal(ui.form().querySelector('[role="alert"]'), null);
  assert.equal(ui.module.canLeave(), true);
  ui.button('Correct').click();
  ui.submit(ui.form()); await flush();
  assert.deepEqual(ui.writes()[1].body.body.supersedes, { entryId: ENTRY.id, revision: 3 }, 'a new correction names the latest revision');
});

test('a refused void offers Load latest and keeps an unrelated draft', async () => {
  const ui = screen({ entries: () => reply(list([ENTRY])), ask: async () => ({ reason: 'Duplicate of the vendor invoice' }), write: () => reply({ error: 'spend_entry_closed', details: { status: 'voided', currentRevision: 3 } }, 409) });
  await ui.mounted; await flush();
  ui.fill({ channel: 'nextdoor', amount: '80.00' });
  ui.button('Void').click(); await flush();
  assert.match(ui.form().querySelector('[role="alert"]').textContent, /already voided or corrected/);
  assert.equal(ui.form().querySelectorAll('button').filter(node => node.textContent === 'Discard draft and load latest').length, 0);
  const before = ui.calls.length;
  ui.button('Load latest').click(); await flush();
  assert.deepEqual(ui.calls.slice(before).map(call => call.body.body.command), ['spend.coverage', 'spend.entries']);
  assert.equal(ui.form().querySelector('[name="channel"]').value, 'nextdoor');
  assert.equal(ui.form().querySelector('[role="alert"]'), null);
  assert.equal(ui.module.canLeave(), false, 'the typed draft still blocks leaving');
});

test('more than one page of entries says how many are shown and loads the rest on Show more', async () => {
  const entry = (n, extra = {}) => ({ ...ENTRY, id: `44444444-4444-4444-8444-44444444444${n}`, description: 'Synthetic entry ' + n, ...extra });
  const ui = screen({ entries: body => reply(body.body.offset === 2 ? { ok: true, items: [entry(2), entry(3)], total: 4, offset: 2, nextOffset: null } : { ok: true, items: [entry(1), entry(2)], total: 3, offset: 0, nextOffset: 2 }) });
  await ui.mounted; await flush();
  assert.equal(ui.root().querySelectorAll('[data-as-entry]').length, 2);
  assert.equal(ui.root().querySelector('[data-as-entries-count]').textContent, 'Showing 2 of 3 entries.');
  ui.button('Show more').click(); await flush();
  assert.deepEqual(ui.calls.at(-1).body.body, { command: 'spend.entries', from: '2026-09-01', to: '2026-10-01', status: 'active', offset: 2, limit: 200 });
  assert.deepEqual(ui.root().querySelectorAll('[data-as-entry]').map(node => node.getAttribute('data-as-entry')), [entry(1).id, entry(2).id, entry(3).id], 'an entry that moved between pages is shown once');
  assert.equal(ui.root().querySelector('[data-as-entries-count]').textContent, 'Showing 3 of 4 entries.');
  assert.equal(ui.root().querySelectorAll('button').filter(node => node.textContent === 'Show more').length, 0);
});

test('the lead-form note follows why days are unknown, and a read the platform does not know is not a refused entry', async () => {
  const lead = (status, reasons, value = null) => ({ ...NOT_CONNECTED, leadgen: { ...NOT_CONNECTED.leadgen, value, status, reasons } });
  for (const [report, note] of [
    [lead('unknown', ['platform_not_connected']), 'Lead-form counts are not connected yet.'],
    [lead('unknown', ['day_not_pulled']), 'Lead-form counts for this range have not been pulled yet.'],
    [lead('unknown', ['meta_lead_retention_exceeded']), 'Meta only keeps lead-form leads for 90 days, so these days cannot be counted.'],
    [lead('partial', ['day_not_pulled', 'restatement_window'], 0), 'No lead-form leads on the days that were pulled. Some days were not pulled.'],
    [lead('partial', ['restatement_window'], 0), 'No lead-form leads in this range so far. The last 3 days can still change at the platform.'],
    [lead('complete', [], 0), 'No lead-form leads in this range.']]) {
    const ui = screen({ coverage: () => reply(report) });
    await ui.mounted; await flush();
    assert.equal(ui.root().querySelector('[data-as-leads-note]').textContent, note, JSON.stringify(report.leadgen.reasons));
  }
  const skew = screen({ coverage: () => reply({ error: 'invalid_command', details: { issues: [] } }, 400) });
  await skew.mounted; await flush();
  assert.match(skew.root().querySelector('.hub-notice.error').textContent, /The operations service does not support ad spend yet\./);
  assert.doesNotMatch(skew.text(), /refused this entry/);
});

test('voiding needs a confirmed reason and names the exact entry revision', async () => {
  const answers = [null, { reason: 'no' }, { reason: 'Duplicate of the vendor invoice' }], dialogs = [];
  const ui = screen({ entries: () => reply(list([ENTRY])), ask: async dialog => { dialogs.push(dialog); return answers.shift(); },
    write: () => reply({ ok: true, entry: { ...ENTRY, status: 'voided', revision: 3, closeReason: 'Duplicate of the vendor invoice' } }) });
  await ui.mounted; await flush();
  for (let index = 0; index < 3; index++) { ui.button('Void').click(); await flush(); }
  assert.equal(dialogs[0].title, 'Void this spend entry?');
  assert.deepEqual([...dialogs[0].fields.map(field => field.name)], ['reason']);
  assert.deepEqual(ui.writes().map(call => call.body.body), [{ command: 'spend.entry.void', entryId: ENTRY.id, revision: 2, reason: 'Duplicate of the vendor invoice' }]);
  assert.deepEqual(ui.toasts, ['Give a short reason to void the entry.', 'Entry voided']);
});

test('a refused owner check is explained and sign-out unmounts the screen and clears the frozen request', async () => {
  const ui = screen({ coverage: () => reply({ error: 'spend_owner_required' }, 403) });
  await ui.mounted; await flush();
  assert.match(ui.text(), /Only the owner can see or change ad spend\./);
  ui.session.setItem(PENDING, JSON.stringify({ path: '/api/operations', method: 'POST', requestId: '66666666-6666-4666-8666-666666666666', body: { requestId: '66666666-6666-4666-8666-666666666666', body: {} } }));
  for (const listener of ui.events['egc:signout'] || []) listener({ type: 'egc:signout' });
  assert.equal(ui.root(), null);
  assert.equal(ui.session.getItem(PENDING), null);
  assert.equal(ui.module.canLeave(), true);
});

test('the Ad spend screen is registered for the owner only, under GROW THE ENGINE', () => {
  for (const [who, expected] of [[{}, true], [{ user: 'AlexK', business: true, role: 'manager' }, false], [{ user: 'Synthetic.Crew', business: false, role: 'crew' }, false]]) {
    const page = hubPage(who), entry = page.context.EGCHubScreens.get('ad_spend');
    assert.equal(entry.capability, 'owner');
    assert.equal(entry.crewVisible, false);
    assert.deepEqual({ ...entry.load }, { js: 'employee-ad-spend.js', css: 'employee-ad-spend.css', v: '20260928adspend' });
    const nav = page.api.visibleNav(), at = nav.findIndex(item => item[1] === 'ad_spend');
    assert.equal(at >= 0, expected, JSON.stringify(who));
    assert.equal(page.api.canView('ad_spend'), expected);
    if (expected) assert.deepEqual([...nav[at]], ['GROW THE ENGINE', 'ad_spend', 'Ad spend']);
  }
});
