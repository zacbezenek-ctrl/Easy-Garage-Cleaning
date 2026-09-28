import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { hubPage, createDocument } from './helpers/hub-dom.mjs';

const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
const collections = () => Object.fromEntries(['profiles', 'timeEntries', 'announcements', 'requests', 'incidents', 'equipment', 'training', 'teamMessages', 'jobMessages', 'messageReads'].map(name => [name, []]));
const hubApi = url => {
  if (url.startsWith('/api/highlevel?view=command')) return json({ ok: true, pipelines: [], opportunities: [] });
  if (url.startsWith('/api/highlevel?view=walkthroughs')) return json({ ok: true, events: [] });
  if (url.startsWith('/api/employee-hub')) return json({ ok: true, collections: collections(), accounts: [] });
  if (url.startsWith('/api/integration-status')) return json({ ok: true, status: { highlevel: true } });
  return json({ ok: false, error: 'Synthetic service unavailable' }, 503);
};
function loaded(options = {}) {
  const page = hubPage({ fetcher: hubApi, ...options });
  page.api.S.peopleState.loaded = true;
  page.api.S.accountState.loaded = true;
  return page;
}

test('a focused crew chat draft keeps its node, and an unsent draft is restored while new messages still appear', async () => {
  const page = loaded();
  page.context.jobsCache = [{ id: 'job-room', type: 'job', customer: 'Synthetic Room', date: '2026-09-22', time: '09:00', status: 'scheduled' }];
  page.api.install();
  await page.flush();
  page.api.go('crew_chat');
  const main = page.main(), before = main.replacements;
  const draft = main.querySelector('.ops-chat-compose textarea');
  assert.match(draft.getAttribute('oninput'), /^opsChatDraft\(this\.value\)$/, 'typing keeps the draft in Hub state');
  draft.value = 'Running 10 minutes late to the synthetic job';
  page.context.opsChatDraft(draft.value);
  draft.focus();
  await page.api.loadGhl();
  page.context.refresh();
  page.api.render();
  assert.equal(main.replacements, before, 'background renders keep the field being typed in');
  assert.equal(main.querySelector('.ops-chat-compose textarea'), draft);
  assert.equal(draft.isConnected, true);

  draft.blur();
  page.api.S.people.teamMessages.push({ id: 'message-office', body: 'Synthetic office update', sender: 'AlexK', senderName: 'Synthetic Alex', createdAt: '2026-09-22T17:59:00.000Z', status: 'active' });
  await page.api.loadGhl();
  assert.equal(main.replacements, before + 1, 'an unsent draft no longer holds back incoming messages once focus leaves');
  assert.match(main.querySelector('.ops-chat-messages').textContent, /Synthetic office update/);
  assert.equal(main.querySelector('.ops-chat-compose textarea').value, 'Running 10 minutes late to the synthetic job', 'the unsent draft is restored');

  page.context.opsSelectChat('job:job-room');
  assert.equal(main.querySelector('.ops-chat-compose textarea').value, '', 'each room keeps its own draft');
  page.context.opsChatDraft('Synthetic room note');
  page.context.opsSelectChat('team');
  assert.equal(main.querySelector('.ops-chat-compose textarea').value, 'Running 10 minutes late to the synthetic job');
  page.context.opsSelectChat('job:job-room');
  assert.equal(main.querySelector('.ops-chat-compose textarea').value, 'Synthetic room note');

  const sent = [];
  page.context.hubFetch = async (url, init = {}) => { if (init.method === 'POST') { sent.push(JSON.parse(init.body)); return json({ ok: true, record: JSON.parse(init.body).data }); } return hubApi(url); };
  const form = main.querySelector('.ops-chat-compose');
  await page.context.opsSendChat({ preventDefault() {}, currentTarget: Object.assign(form, { reset() { form.querySelector('textarea').value = ''; } }) });
  assert.equal(sent[0].data.body, 'Synthetic room note');
  assert.equal(main.querySelector('.ops-chat-compose textarea').value, '', 'a sent message clears its draft');
  page.context.opsSelectChat('team');
  assert.equal(main.querySelector('.ops-chat-compose textarea').value, 'Running 10 minutes late to the synthetic job', 'other rooms keep theirs');
  page.fire('egc:signout');
  assert.deepEqual({ ...page.api.S.chatDrafts }, {}, 'sign-out discards unsent drafts');
});

test('the customer search filter is not a draft: background renders and explicit actions render and restore it', async () => {
  const page = loaded({ fetcher: async (url, init = {}) => url === '/api/customer-portal-invitation' && init.method === 'POST' ? json({ ok: true, portalInvitation: { status: 'submitted', channel: 'SMS' } }) : hubApi(url) });
  page.context.jobsCache = [
    { id: 'job-1', type: 'job', customer: 'Synthetic Customer', phone: '9705550100', date: '2026-09-22', status: 'scheduled' },
    { id: 'job-2', type: 'job', customer: 'Other Person', phone: '9705550101', date: '2026-09-21', status: 'scheduled' },
  ];
  page.api.install();
  page.api.go('customers');
  const main = page.main(), search = main.querySelector('.ops-customer-tools input'), count = main.replacements;
  assert.equal(search.getAttribute('data-ops-filter'), 'customers');
  search.value = 'synthetic';
  page.context.opsFilterCustomers(search.value);
  search.focus();
  search.setSelectionRange(4, 4);
  await page.api.loadGhl();
  assert.ok(main.replacements > count, 'a typed or focused filter does not block background renders');
  const background = main.replacements;
  const next = main.querySelector('.ops-customer-tools input');
  assert.equal(next.value, 'synthetic');
  assert.equal(page.document.activeElement, next, 'focus returns to the filter');
  assert.deepEqual([next.selectionStart, next.selectionEnd], [4, 4]);
  const visible = () => main.querySelectorAll('.ops-customer-list>article').filter(card => !card.hidden).map(card => card.getAttribute('data-customer-search'));
  assert.equal(visible().length, 1, 'the filter is re-applied');
  assert.match(visible()[0], /synthetic customer/);
  assert.match(main.querySelector('#ops-customer-count').textContent, /1 customer shown/);

  next.blur();
  await page.context.opsRetryPortalInvitation('job-1');
  assert.equal(main.replacements, background + 1, 'an explicit action renders its result even with a filter typed');
  assert.equal(page.context.jobsCache.find(job => job.id === 'job-1').customerPortalInvitation.status, 'submitted');
  assert.equal(main.querySelector('.ops-customer-tools input').value, 'synthetic');
  assert.equal(visible().length, 1);
  page.fire('egc:signout');
  assert.equal(page.api.S.customerQuery, '');
});

test('scorecard entries are DOM-only drafts that survive background renders until the user saves', async () => {
  const page = loaded();
  page.api.install();
  page.api.go('scorecard');
  const main = page.main(), count = main.replacements;
  const spend = main.querySelector('input[name="spend"]');
  spend.value = '125.50';
  await page.api.loadGhl();
  assert.equal(main.querySelector('input[name="spend"]'), spend);
  assert.equal(main.replacements, count);
  page.context.opsSaveScorecard();
  assert.equal(JSON.parse(page.context.localStorage.getItem('egc_scorecard')).spend, 125.5);
  assert.notEqual(main.querySelector('input[name="spend"]'), spend, 'saving re-renders with the saved values');
  assert.equal(main.querySelector('input[name="spend"]').value, '125.5');
});

test('my day keeps one field-today node, so the field agenda mounts and fetches once across renders', async () => {
  let fieldReads = 0;
  const page = loaded({
    before(context) {
      context.fetch = async url => { assert.match(String(url), /^\/api\/field-jobs\?/); fieldReads++; return json({ ok: true, jobs: [], generatedAt: '2026-09-22T18:00:00.000Z' }); };
    },
  });
  vm.runInContext(readFileSync(new URL('../employee-field-today.js', import.meta.url), 'utf8'), page.context, { filename: 'employee-field-today.js' });
  const real = page.context.EGCFieldToday, hosts = [];
  page.context.EGCFieldToday = { ...real, mount(node) { hosts.push(node); return real.mount(node); } };
  page.api.install();
  page.api.go('my_day');
  await page.flush();
  const main = page.main(), rendersBefore = main.replacements;
  page.api.render();
  page.api.render(true);
  page.context.refresh();
  await page.api.loadGhl();
  await page.flush();
  assert.ok(main.replacements > rendersBefore, 'the surrounding widgets did re-render');
  assert.ok(hosts.length >= 4);
  assert.equal(new Set(hosts).size, 1, 'every render reuses the same #ops-field-today node');
  assert.equal(hosts[0].isConnected, true);
  assert.equal(main.querySelectorAll('#ops-field-today').length, 1);
  assert.equal(fieldReads, 1, 'the field agenda is not refetched on every render');
  assert.match(hosts[0].textContent, /No jobs assigned today/);
  page.api.go('earnings');
  page.api.go('my_day');
  await page.flush();
  assert.equal(new Set(hosts).size, 1);
  assert.equal(fieldReads, 2, 'returning to My day loads the agenda again');
  page.fire('egc:signout');
  assert.equal(page.api.S.fieldToday, null);
});

test('bootDashboard loads Hub data once on entry and still refreshes on a later re-entry', async () => {
  let legacyBoots = 0;
  const page = hubPage({ fetcher: hubApi, before(context) { context.bootDashboard = () => { legacyBoots++; }; } });
  page.context.bootDashboard();
  await page.flush();
  const reads = path => page.calls.filter(call => call.url.split('?')[0] === path && call.method === 'GET').length;
  assert.equal(legacyBoots, 1);
  assert.equal(reads('/api/integration-status'), 1, 'one integration check per boot');
  assert.equal(page.calls.filter(call => call.url.startsWith('/api/highlevel?view=command')).length, 1, 'one HighLevel command read per boot');
  assert.equal(page.calls.filter(call => call.url.startsWith('/api/highlevel?view=walkthroughs')).length, 1);
  page.context.bootDashboard();
  await page.flush();
  assert.equal(reads('/api/integration-status'), 2, 're-entering from the mode screen refreshes as before');
});

test('Hub navigation writes ?view= history and the back gesture returns to the previous view', async () => {
  const page = loaded();
  page.api.install();
  assert.deepEqual(page.history.map(entry => [entry.method, entry.url]), [['replace', '/employee?view=today']], 'the first view replaces the entry URL');
  page.api.go('customers');
  page.api.go('customers');
  page.api.go('finance');
  assert.deepEqual(page.history.slice(1).map(entry => [entry.method, entry.url, entry.state.egcView]), [['push', '/employee?view=customers', 'customers'], ['push', '/employee?view=finance', 'finance']]);
  page.location.search = '?view=customers';
  page.location.href = 'https://easygaragecleaning.com/employee?view=customers';
  page.fire('popstate');
  assert.equal(page.api.S.active, 'customers');
  assert.equal(page.document.querySelector('#ops-title').textContent, 'Customers');
  assert.equal(page.history.length, 3, 'a back gesture does not push another entry');
  page.api.S.booking = { nativeBusy: true };
  page.location.search = '?view=finance';
  page.location.href = 'https://easygaragecleaning.com/employee?view=finance';
  page.fire('popstate');
  assert.equal(page.api.S.active, 'customers', 'a busy booking blocks the back gesture');
  assert.deepEqual([page.history.at(-1).method, page.history.at(-1).url], ['replace', '/employee?view=customers']);
  page.fire('egc:signout');
  page.fire('popstate');
  assert.equal(page.api.S.installed, false);
});

test('a crew member following a business ?view= link lands on My day with a corrected URL', () => {
  const page = loaded({ user: 'Synthetic.Crew', business: false, role: 'crew', search: '?view=finance' });
  page.api.install();
  assert.equal(page.api.S.active, 'my_day');
  assert.deepEqual([page.history[0].method, page.history[0].url], ['replace', '/employee?view=my_day']);
});

test('the contact lookup keeps its query, results and focus through render(true)', async () => {
  let contacts = [{ id: 'contact-1', name: 'Synthetic Customer', phone: '9705550100' }];
  const page = loaded({ fetcher: async url => url.startsWith('/api/highlevel?view=contacts') ? json({ ok: true, contacts }) : hubApi(url) });
  page.api.install();
  await page.flush();
  page.timers.length = 0;
  page.context.opsOpenBooking('2026-09-22');
  const input = page.document.querySelector('#ops-contact-find');
  input.value = 'synth';
  input.focus();
  input.setSelectionRange(5, 5);
  page.context.opsLookupContacts('synth');
  assert.equal(page.api.S.booking.contactQuery, 'synth');
  await page.runTimers();
  const next = page.document.querySelector('#ops-contact-find');
  assert.notEqual(next, input, 'the modal re-rendered');
  assert.equal(next.value, 'synth');
  assert.equal(page.document.activeElement, next);
  assert.deepEqual([next.selectionStart, next.selectionEnd], [5, 5]);
  assert.match(page.document.querySelector('.ops-contact-results').textContent, /Synthetic Customer/);
  const phone = page.document.querySelector('input[name="phone"]'), email = page.document.querySelector('input[name="email"]');
  assert.deepEqual([phone.getAttribute('type'), phone.getAttribute('inputmode'), phone.getAttribute('autocomplete')], ['tel', 'tel', 'tel']);
  assert.equal(email.getAttribute('autocomplete'), 'email');
  contacts = [{ id: 'contact-2', name: 'Stale Result', phone: '9705550199' }];
  page.context.opsLookupContacts('synthetic c');
  const stale = page.timers.shift();
  page.context.opsLookupContacts('synthetic cu');
  stale.callback();
  await page.flush();
  assert.doesNotMatch(page.document.querySelector('.ops-contact-results').textContent, /Stale Result/, 'a response for an older query is ignored');
});

test('askAction fields carry mobile keyboards and fixed choices render as selects', async () => {
  const page = loaded();
  page.api.install();
  page.api.go('customers');
  const pending = page.api.askAction({ title: 'Synthetic fields', fields: [
    { name: 'phone', label: 'Phone', type: 'tel', autocomplete: 'tel' }, { name: 'site', label: 'Site', type: 'url' },
    { name: 'amount', label: 'Amount', type: 'number', step: '.01' }, { name: 'visits', label: 'Visits', type: 'number', step: '1' },
    { name: 'code', label: 'Code', inputmode: 'numeric', autocomplete: 'one-time-code' }, { name: 'email', label: 'Email', type: 'email' },
  ] });
  const field = name => page.document.querySelector(`.ops-action-dialog [name="${name}"]`);
  const mode = name => [field(name).getAttribute('type'), field(name).getAttribute('inputmode'), field(name).getAttribute('autocomplete')];
  assert.deepEqual(mode('phone'), ['tel', 'tel', 'tel']);
  assert.deepEqual(mode('site'), ['url', 'url', null]);
  assert.deepEqual(mode('amount'), ['number', 'decimal', null]);
  assert.deepEqual(mode('visits'), ['number', 'numeric', null]);
  assert.deepEqual(mode('code'), ['text', 'numeric', 'one-time-code']);
  assert.deepEqual(mode('email'), ['email', 'email', null]);
  page.context.opsActionClose();
  assert.equal(await pending, null);
  const announcement = page.context.opsNewAnnouncement();
  const priority = field('priority');
  assert.equal(priority.tagName, 'SELECT');
  assert.deepEqual([...priority.querySelectorAll('option').map(option => option.getAttribute('value'))], ['normal', 'urgent']);
  assert.equal(priority.value, 'normal');
  page.context.opsActionClose();
  await announcement;
  page.context.jobsCache = [{ id: 'job-guard', type: 'job', customer: 'Synthetic Member', garageGuard: { plan: 'Black', status: 'paused' } }];
  const membership = page.context.opsSetCustomerMembership('job-guard');
  assert.equal(field('plan').tagName, 'SELECT');
  assert.equal(field('plan').value, 'black', 'saved plans are matched case-insensitively');
  assert.equal(field('status').value, 'paused');
  assert.deepEqual([...field('status').querySelectorAll('option').map(option => option.getAttribute('value'))], ['active', 'past_due', 'paused', 'cancelled']);
  page.context.opsActionClose();
  await membership;
});

test('submitting a dialog from a focused field closes it instead of being held by the draft guard', async () => {
  const page = loaded();
  page.api.install();
  page.api.go('customers');
  const pending = page.api.askAction({ title: 'Synthetic note', fields: [{ name: 'note', label: 'Note' }] });
  const input = page.document.querySelector('.ops-action-dialog input');
  input.value = 'Synthetic value';
  input.focus();
  page.context.opsActionSubmit({ preventDefault() {}, currentTarget: page.document.querySelector('.ops-action-dialog') });
  assert.equal(page.document.querySelector('.ops-action-dialog'), null);
  assert.deepEqual({ ...(await pending) }, { note: 'Synthetic value' });
});

test('a business ?view= link skips the mode screen on entry but not when returning from a call', () => {
  const page = readFileSync(new URL('../employee.html', import.meta.url), 'utf8');
  const source = page.slice(page.indexOf('function showModeSelect()'), page.indexOf('function selectMode('));
  for (const [search, installed, expected] of [['?view=schedule', false, 'dashboard'], ['', false, 'mode'], ['?view=schedule', true, 'mode'], ['?other=1', false, 'mode']]) {
    const document = createDocument(), shown = [];
    for (const id of ['login-screen', 'dashboard', 'mode-screen', 'mode-user-lbl', 'oncall-overlay']) document.body.append(Object.assign(document.createElement('div'), { id }));
    if (installed) document.getElementById('dashboard').classList.add('ops-installed');
    const context = { document, location: { search }, URLSearchParams, me: 'ZacB', canRunBusiness: () => true, bootDashboard: () => shown.push('dashboard'), startListeners() {}, fetchSheetCustomers() {} };
    vm.runInNewContext(source + '\nshowModeSelect();', context);
    assert.equal(shown[0] || (document.getElementById('mode-screen').style.display === 'flex' ? 'mode' : 'none'), expected, `${search} installed=${installed}`);
  }
});

test('onboarding answers live in Hub state, so background renders and Test location show fresh state without losing them', async () => {
  const profiles = [{ id: 'synthetic.crew', username: 'Synthetic.Crew', displayName: 'Synthetic Crew', role: 'crew', status: 'active' }], posts = [];
  const fetcher = async (url, init = {}) => {
    if (url.startsWith('/api/employee-hub') && init.method === 'POST') {
      const body = JSON.parse(init.body); posts.push(body);
      const row = { ...(profiles.find(profile => profile.id === body.id) || {}), ...body.data, id: body.id };
      profiles.splice(0, profiles.length, ...profiles.filter(profile => profile.id !== body.id), row);
      return json({ ok: true, record: row });
    }
    if (url.startsWith('/api/employee-hub')) return json({ ok: true, collections: { ...collections(), profiles: structuredClone(profiles) }, accounts: [] });
    return hubApi(url);
  };
  const page = loaded({ user: 'Synthetic.Crew', business: false, role: 'crew', fetcher, before(context) { context.navigator = { geolocation: { getCurrentPosition: resolve => resolve({ coords: { accuracy: 12.4 } }) } }; } });
  page.api.install();
  await page.flush();
  page.api.go('onboarding');
  const main = page.main(), form = main.querySelector('.ops-onboarding'), name = form.querySelector('input[name="preferredName"]');
  assert.equal(main.querySelector('.ops-location-test strong').textContent, 'Test this phone before your first shift');
  name.value = 'Synthetic Sam';
  form.querySelector('input[name="phone"]').value = '970-555-0142';
  page.context.opsOnboardingDraft({ currentTarget: form });
  name.focus();
  const typing = main.replacements;
  page.api.render();
  assert.equal(main.replacements, typing, 'the field being typed in is never replaced');
  name.blur();
  page.api.render();
  assert.equal(main.replacements, typing + 1, 'an unsent onboarding answer does not hold back background renders');
  assert.equal(main.querySelector('input[name="preferredName"]').value, 'Synthetic Sam', 'the answer is restored from Hub state');
  assert.equal(main.querySelector('input[name="phone"]').value, '970-555-0142');
  await page.context.opsVerifyLocation();
  await page.flush();
  assert.equal(posts.at(-1).data.locationVerificationAccuracy, 12);
  assert.equal(main.querySelector('.ops-location-test strong').textContent, 'Location verified', 'Test location shows its result');
  assert.equal(main.querySelector('.ops-location-test button').textContent, 'Test again');
  assert.ok(main.querySelectorAll('.ops-readiness span.done').some(step => /Location tested/.test(step.textContent)));
  assert.equal(main.querySelector('input[name="preferredName"]').value, 'Synthetic Sam', 'the explicit render keeps the typed answers');
});

test('a DOM-only answer holds background renders, while explicit actions and navigation always render', async () => {
  const ready = { id: 'synthetic.crew', username: 'Synthetic.Crew', displayName: 'Synthetic Crew', role: 'crew', status: 'active', onboardingCompletedAt: '2026-09-01T15:00:00.000Z', onboardingVersion: '2026-09-location-v2' };
  const page = loaded({ user: 'Synthetic.Crew', business: false, role: 'crew', fetcher: async url => url.startsWith('/api/employee-hub') ? json({ ok: true, collections: { ...collections(), profiles: [ready] }, accounts: [] }) : hubApi(url) });
  page.api.install();
  await page.flush();
  page.api.go('training');
  page.context.opsOpenTraining('welcome');
  const main = page.main(), choice = main.querySelector('.ops-training-lesson input[type="radio"]'), before = main.replacements;
  choice.checked = true;
  await page.api.loadGhl();
  page.api.render();
  assert.equal(main.replacements, before, 'a picked knowledge-check answer survives background renders');
  assert.equal(main.querySelector('.ops-training-lesson input[type="radio"]'), choice);
  page.context.opsCloseTraining();
  assert.equal(main.replacements, before + 1, 'Back to modules is an explicit action');
  assert.equal(main.querySelector('.ops-training-lesson'), null);
  page.context.opsOpenTraining('welcome');
  main.querySelector('.ops-training-lesson input[type="radio"]').checked = true;
  const lesson = main.replacements;
  page.api.go('my_day');
  assert.equal(main.replacements, lesson + 1);
  assert.equal(main.querySelector('.ops-training-lesson'), null, 'navigation always renders');
  assert.ok(main.querySelector('#ops-field-today'), 'My day is shown');
});

test('Garage Guard keeps an unknown saved plan or status selected instead of silently picking the first choice', async () => {
  const writes = [];
  const page = loaded({ before(context) { context.db = { collection: name => ({ doc: id => ({ set: async (update, options) => { writes.push({ name, id, update: structuredClone(update), options: { ...options } }); } }) }) }; } });
  page.api.install();
  page.api.go('customers');
  page.context.jobsCache = [
    { id: 'job-legacy', type: 'job', customer: 'Synthetic Legacy Member', garageGuard: { plan: 'Platinum', status: 'trialing', visitsIncluded: 6, visitsRemaining: 5 } },
    { id: 'job-new', type: 'job', customer: 'Synthetic New Member' },
  ];
  const field = name => page.document.querySelector(`.ops-action-dialog [name="${name}"]`);
  const submit = () => page.context.opsActionSubmit({ preventDefault() {}, currentTarget: page.document.querySelector('.ops-action-dialog') });
  const options = name => field(name).querySelectorAll('option').map(option => [option.getAttribute('value'), option.hasAttribute('selected'), option.textContent]);
  let pending = page.context.opsSetCustomerMembership('job-legacy');
  assert.deepEqual(options('plan'), [['Platinum', true, 'Platinum (current, not a standard choice)'], ['lite', false, 'Lite'], ['guard', false, 'Guard'], ['black', false, 'Black']]);
  assert.equal(field('plan').value, 'Platinum');
  assert.equal(field('status').value, 'trialing');
  assert.equal(options('status')[0][1], true);
  field('visitsRemaining').value = '4';
  submit();
  await pending;
  assert.deepEqual(writes.map(write => [write.name, write.id, write.options]), [['jobs', 'job-legacy', { merge: true }]]);
  const saved = writes[0].update.garageGuard;
  assert.deepEqual([saved.plan, saved.status, saved.visitsIncluded, saved.visitsRemaining], ['Platinum', 'trialing', 6, 4], 'saving the visit count leaves the plan and status as they were');
  assert.equal(saved.updatedAt, '2026-09-22T18:00:00.000Z');

  pending = page.context.opsSetCustomerMembership('job-legacy');
  field('plan').value = 'black';
  field('status').value = 'active';
  submit();
  await pending;
  assert.deepEqual([writes[1].update.garageGuard.plan, writes[1].update.garageGuard.status], ['black', 'active'], 'a manager can still move to a standard choice');

  pending = page.context.opsSetCustomerMembership('job-new');
  assert.deepEqual(options('plan').map(option => option[0]), ['lite', 'guard', 'black'], 'no extra choice without a saved value');
  assert.equal(field('plan').value, 'guard');
  assert.equal(field('status').value, 'active');
  field('plan').value = 'Diamond';
  submit();
  await pending;
  assert.equal(writes.length, 2, 'a value that is neither saved nor standard is refused');
  assert.match(page.toasts.at(-1), /valid Garage Guard plan and status/);
});

test('sign-out clears saved Hub requests even when no registered screen loaded the kit', () => {
  const page = loaded();
  page.api.install();
  assert.equal(page.context.EGCHubKit, undefined, 'the lazily loaded kit is not on this page');
  page.session.setItem('egc.hub.pending.v1.invoices.zacb', JSON.stringify({ body: { customer: 'Synthetic Customer', phone: '9705550100' } }));
  page.session.setItem('egc.hub.pending.v1.timesheets.anonymous', '{}');
  page.session.setItem('egc.dispatch.pending.v1.zacb', 'kept by its own module');
  page.fire('egc:signout');
  assert.deepEqual([...page.session.values.keys()].filter(key => key.startsWith('egc.hub.pending.v1.')), []);
  assert.equal(page.session.getItem('egc.dispatch.pending.v1.zacb'), 'kept by its own module');
});

test('the phone drawer returns focus to the menu button whenever it closes, and sign-in cycles add no duplicate listeners', () => {
  const observers = [], media = [], query = { matches: true, addEventListener: (type, listener) => media.push({ type, listener }) };
  const page = loaded({ before(context) {
    context.MutationObserver = class { constructor(callback) { this.callback = callback; this.on = false; observers.push(this); } observe() { this.on = true; } disconnect() { this.on = false; } };
    context.matchMedia = () => query;
  } });
  const notify = () => observers.filter(observer => observer.on).forEach(observer => observer.callback([]));
  const doc = page.document, counts = () => ['click', 'keydown', 'visibilitychange'].map(name => (doc.listeners[name] || []).length);
  const listeners = counts();
  for (let cycle = 0; cycle < 3; cycle++) {
    page.api.install();
    page.api.go('customers');
    notify();
    const rail = doc.querySelector('#ops-rail'), menu = doc.querySelector('.ops-menu'), scrim = doc.querySelector('.ops-scrim'), open = () => { menu.focus(); rail.classList.add('open'); notify(); };
    assert.equal(doc.querySelectorAll('.ops-scrim').length, 1);
    assert.equal(rail.hasAttribute('inert'), true);
    open();
    assert.equal(menu.getAttribute('aria-expanded'), 'true');
    assert.equal(doc.activeElement, rail.querySelector('.ops-nav button.active'), 'opening moves focus into the drawer');
    scrim.click();
    notify();
    assert.equal(doc.activeElement, menu, 'a scrim tap returns focus to the menu button');
    assert.equal(rail.hasAttribute('inert'), true);
    open();
    scrim.focus();
    scrim.click();
    notify();
    assert.equal(doc.activeElement, menu, 'even when the tap focused the scrim');
    open();
    rail.querySelector('[data-ops-tab="finance"]').focus();
    page.context.opsGo('finance');
    notify();
    assert.equal(page.api.S.active, 'finance');
    assert.equal(doc.activeElement, menu, 'choosing a view returns focus to the menu button');
    open();
    doc.dispatch({ type: 'keydown', key: 'Escape' });
    notify();
    assert.equal(doc.activeElement, menu, 'Escape returns focus to the menu button');
    open();
    doc.activeElement = null;
    rail.classList.remove('open');
    notify();
    assert.equal(doc.activeElement, menu, 'focus dropped to the page returns to the menu button');
    open();
    const elsewhere = doc.createElement('input');
    doc.body.append(elsewhere);
    elsewhere.focus();
    rail.classList.remove('open');
    notify();
    assert.equal(doc.activeElement, elsewhere, 'focus the viewer moved elsewhere is left alone');
    elsewhere.remove();
    query.matches = false;
    media[0].listener();
    assert.equal(rail.hasAttribute('inert'), false, 'the desktop rail is usable');
    open();
    rail.querySelector('[data-ops-tab="customers"]').focus();
    rail.classList.remove('open');
    notify();
    assert.notEqual(doc.activeElement, menu, 'the desktop rail is not a drawer, so focus stays put');
    query.matches = true;
    assert.deepEqual(counts(), listeners, `cycle ${cycle}: install adds no document listeners`);
    assert.equal(media.length, 1, `cycle ${cycle}: one media-query listener for the page`);
    assert.equal(observers.filter(observer => observer.on).length, 1, 'only the installed shell is observed');
    page.fire('egc:signout');
    assert.equal(observers.filter(observer => observer.on).length, 0, 'sign-out disconnects the drawer observer');
    media[0].listener();
  }
  assert.equal(observers.length, 3);
});
