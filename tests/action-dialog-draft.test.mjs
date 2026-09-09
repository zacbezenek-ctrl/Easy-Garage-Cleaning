import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const response = body => ({ ok: true, json: async () => body });
const collections = () => Object.fromEntries(
  ['profiles', 'timeEntries', 'announcements', 'requests', 'incidents', 'equipment', 'training', 'teamMessages', 'jobMessages', 'messageReads']
    .map(name => [name, []]),
);
const decode = text => String(text).replace(/&(amp|lt|gt|quot|#39);/g, (_, entity) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" }[entity]));

// Model the destructive effect of innerHTML on form nodes, values, and focus.
// Requests stay in memory; none of these tests post a real team announcement.
function suite() {
  const stored = new Map(Object.entries({ egc_u: 'ZacB', egc_business_access: 'true', egc_role: 'owner' }));
  const storage = { getItem: key => stored.get(key) || null, setItem: (key, value) => stored.set(key, String(value)), removeItem: key => stored.delete(key) };
  const timers = [], writes = [], server = collections();
  const document = { readyState: 'loading', activeElement: null, addEventListener() {}, querySelectorAll: () => [] };
  const chromeNode = () => ({ textContent: '', className: '', disabled: false, classList: { toggle() {} }, setAttribute() {} });
  const clock = chromeNode(), syncDot = chromeNode(), syncLabel = chromeNode();
  const main = {
    html: '', form: null, replacements: 0,
    get innerHTML() { return this.html; },
    set innerHTML(html) {
      if (this.form) {
        this.form.isConnected = false;
        if (this.form.fields.includes(document.activeElement)) document.activeElement = null;
      }
      this.html = html;
      this.replacements++;
      this.form = null;
      const markup = html.match(/<form\b[^>]*class="[^"]*\bops-action-dialog\b[^"]*"[^>]*>([\s\S]*?)<\/form>/)?.[1];
      if (!markup) return;
      const form = { fields: [], isConnected: true };
      for (const match of markup.matchAll(/<input\b([^>]*?)>|<textarea\b([^>]*?)>([\s\S]*?)<\/textarea>/g)) {
        const tag = match[1] === undefined ? 'textarea' : 'input';
        const attributes = match[1] ?? match[2], content = match[3];
        const attr = name => decode(attributes.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1] || '');
        const field = {
          name: attr('name'), tagName: tag.toUpperCase(), value: tag === 'textarea' ? decode(content || '') : attr('value'),
          selectionStart: 0, selectionEnd: 0,
          focus() { document.activeElement = this; },
          closest(selector) { return selector.split(',').some(part => part.trim() === '.ops-action-dialog') ? form : null; },
          setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; },
        };
        form.fields.push(field);
      }
      this.form = form;
    },
    querySelector(selector) { return selector === '.ops-action-dialog' ? this.form : null; },
  };
  document.querySelector = selector => {
    const fixed = { '#ops-main': main, '#ops-quick-clock': clock, '#ops-sync-dot': syncDot, '#ops-sync-label': syncLabel };
    if (fixed[selector]) return fixed[selector];
    if (selector === '.ops-action-dialog') return main.form;
    if (selector.startsWith('.ops-action-dialog ')) {
      const tags = selector.split(',').map(part => part.trim().split(' ').at(-1).toUpperCase());
      return main.form?.fields.find(field => tags.includes(field.tagName)) || null;
    }
    return null;
  };
  let legacyRefreshes = 0;
  const context = {
    console, URLSearchParams, Date, Intl, Promise, Set, Map, Error,
    me: 'ZacB', jobsCache: [], sessionStorage: storage, localStorage: storage,
    navigator: {}, location: { pathname: '/employee', search: '' }, document,
    setInterval: () => 1, clearInterval() {}, setTimeout: callback => timers.push(callback), clearTimeout() {}, addEventListener() {},
    refresh() { legacyRefreshes++; },
    FormData: class {
      constructor(form) { this.entries = form.fields.map(field => [field.name, field.value]); }
      forEach(callback) { this.entries.forEach(([key, value]) => callback(value, key)); }
    },
    hubFetch: async (url, options = {}) => {
      if (options.method === 'POST') {
        assert.equal(url, '/api/employee-hub');
        const body = JSON.parse(options.body);
        writes.push(body);
        server[body.collection].push(body.data);
        return response({ ok: true, record: body.data });
      }
      if (url.includes('employee-accounts')) return response({ ok: true, accounts: [] });
      assert.equal(url, '/api/employee-hub');
      return response({ ok: true, collections: structuredClone(server) });
    },
  };
  context.window = context;
  const source = readFileSync(new URL('../employee-suite.js', import.meta.url), 'utf8')
    .replace(/\}\)\(\);\s*$/, 'globalThis.ui={S,askAction,refreshPeople,render};})();');
  vm.runInNewContext(source, context);
  const api = context.ui;
  api.S.active = 'people';
  api.S.peopleState.loaded = true;
  api.S.accountState.loaded = true;
  api.render();
  return {
    context, api, main, document, clock, syncLabel, server, writes,
    field: name => main.form?.fields.find(field => field.name === name),
    flushTimers() { while (timers.length) timers.shift()(); },
    legacyRefreshes: () => legacyRefreshes,
    submit(form = main.form) { context.opsActionSubmit({ preventDefault() {}, currentTarget: form }); },
  };
}

const draft = { title: 'Tomorrow’s crew plan', body: 'Meet at the shop at 7.\nBring gloves and water.' };

for (const focused of [true, false]) {
  test(`announcement draft survives all refresh paths while ${focused ? 'focused' : 'blurred'}`, async () => {
    const env = suite();
    const posting = env.context.opsNewAnnouncement();
    env.flushTimers();
    const form = env.main.form;
    const title = env.field('title'), body = env.field('body');
    title.value = draft.title;
    body.value = draft.body;
    body.setSelectionRange(5, 12);
    if (focused) body.focus(); else env.document.activeElement = null;
    env.server.profiles.push({ id: 'new.crew', username: 'new.crew', displayName: 'Newly approved crew', status: 'active' });
    env.server.timeEntries.push({ id: 'active-clock', employee: 'ZacB', status: 'active' });

    for (const [name, refresh] of [
      ['employee polling', () => env.api.refreshPeople()],
      ['direct rendering', () => env.api.render()],
      ['legacy data refresh', () => env.context.refresh()],
    ]) {
      await refresh();
      assert.equal(env.main.form, form, `${name} must keep the mounted form`);
      assert.equal(env.field('title'), title, name);
      assert.equal(env.field('body'), body, name);
      assert.equal(title.value, draft.title, name);
      assert.equal(body.value, draft.body, name);
      assert.equal(body.selectionStart, 5, name);
      assert.equal(body.selectionEnd, 12, name);
      assert.equal(env.document.activeElement, focused ? body : null, name);
    }
    assert.equal(env.legacyRefreshes(), 1);
    assert.equal(env.api.S.people.profiles[0].displayName, 'Newly approved crew', 'background data still updates');
    assert.equal(env.clock.textContent, 'Clock out', 'the topbar clock still updates');
    env.api.S.ghl.loading = false;
    env.api.render();
    assert.equal(env.syncLabel.textContent, 'HighLevel connected', 'the topbar sync status still updates');
    assert.doesNotMatch(env.main.innerHTML, /Newly approved crew/, 'the page beneath the draft is deferred');

    env.context.opsActionClose();
    await posting;
    assert.equal(env.main.form, null);
    assert.match(env.main.innerHTML, /Newly approved crew/, 'closing renders the latest background data');
    const reopened = env.context.opsNewAnnouncement();
    assert.notEqual(env.main.form, form);
    assert.equal(env.field('title').value, '');
    assert.equal(env.field('body').value, '');
    assert.equal(env.field('priority').value, 'normal');
    env.context.opsActionClose();
    await reopened;
    assert.equal(env.writes.length, 0, 'cancelled drafts do not publish announcements');
  });
}

test('opening a replacement action dialog cancels the previous request and renders its new fields', async () => {
  const env = suite();
  const previous = env.api.askAction({ title: 'Previous action', fields: [{ name: 'old', label: 'Old input' }] });
  env.field('old').value = 'Discard this draft';
  const oldForm = env.main.form;
  const replacement = env.api.askAction({ title: 'Replacement action', fields: [{ name: 'details', label: 'Details', type: 'textarea', value: 'New initial value' }] });
  assert.equal(await previous, null);
  assert.notEqual(env.main.form, oldForm);
  assert.equal(env.field('old'), undefined);
  assert.equal(env.field('details').value, 'New initial value');
  env.flushTimers();
  assert.equal(env.document.activeElement, env.field('details'), 'textarea-only dialogs receive initial focus');
  env.context.opsActionClose();
  assert.equal(await replacement, null);
  assert.equal(env.writes.length, 0);
});

test('announcement submission keeps multiline text and publishes the draft once after a refresh', async () => {
  const env = suite();
  const posting = env.context.opsNewAnnouncement();
  assert.equal(env.field('body').tagName, 'TEXTAREA', 'the message editor accepts multiple lines');
  env.field('title').value = draft.title;
  env.field('body').value = draft.body;
  env.field('priority').value = 'urgent';
  await env.api.refreshPeople();
  const form = env.main.form;
  env.submit(form);
  env.submit(form);
  await posting;
  assert.equal(env.writes.length, 1, 'one user draft creates one announcement record');
  assert.equal(env.writes[0].collection, 'announcements');
  assert.equal(env.writes[0].data.title, draft.title);
  assert.equal(env.writes[0].data.body, draft.body);
  assert.equal(env.writes[0].data.priority, 'urgent');
  assert.equal(env.main.form, null);
  assert.match(env.main.innerHTML, /Tomorrow’s crew plan/);
});
