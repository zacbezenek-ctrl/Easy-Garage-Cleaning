import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from './helpers/vm-realm.mjs';
import { hubPage } from './helpers/hub-dom.mjs';
import { servedPricing } from './helpers/walkthrough-pricing.mjs';
import { ownerEconomics, phoneQuotePricing } from '../functions/_lib/pricing-config.js';

// PRICE-SCRUB browser side: the walkthrough caches its fetched tables per signed-in user and
// config version (and drops them on sign-out), prices nothing it has not loaded, and the Hub
// shows the owner's numbers only to the owner.
const read = name => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');
const NOW = Date.parse('2026-09-22T15:00:00.000Z');
class FixedDate extends Date { constructor(...args) { super(...(args.length ? args : [NOW])); } static now() { return NOW; } }
const plain = value => JSON.parse(JSON.stringify(value));
function webStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return { values, get length() { return values.size; }, key: index => [...values.keys()][index] ?? null, getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key) };
}
const served = (version = 'pc_1111111111111111', pricing = servedPricing()) => ({ ok: true, status: 200, json: async () => ({ ok: true, authority: 'employee_hub', version, parts: { walkthrough: pricing } }) });
const OFFLINE = 'Pricing unavailable offline — connect once to load prices';

function loader(local = webStorage()) {
  const listeners = {}, context = { localStorage: local, Date: FixedDate, AbortController, setTimeout: () => 1, clearTimeout() {}, addEventListener: (name, listener) => { (listeners[name] ||= []).push(listener); } };
  context.window = context;
  vm.runInContext(read('crew/walkthrough-pricing.js'), vm.createContext(context));
  return { api: context.EGCWalkthroughPricing, local, fire: name => (listeners[name] || []).forEach(listener => listener()) };
}

test('walkthrough prices are cached per signed-in user and config version, and a new version replaces the old copy', async () => {
  const { api, local } = loader(), requests = [];
  const first = await api.load(' Tyler.G ', { fetcher: async (url, init) => { requests.push([url, init.cache]); return served(); } });
  assert.deepEqual([first.source, first.version], ['network', 'pc_1111111111111111']);
  assert.deepEqual(plain(first.pricing), servedPricing());
  assert.deepEqual(requests, [['/api/pricing-config?parts=walkthrough', 'no-store']]);
  assert.deepEqual([...local.values.keys()], ['egc_walkthrough_pricing.v1.tyler.g.pc_1111111111111111']);
  const repriced = servedPricing(); repriced.perLoad = 1100;
  await api.load('Tyler.G', { fetcher: async () => served('pc_2222222222222222', repriced) });
  assert.deepEqual([...local.values.keys()], ['egc_walkthrough_pricing.v1.tyler.g.pc_2222222222222222'], 'one copy per user: the old version is gone');
  const offline = await api.load('tyler.g', { fetcher: async () => { throw new TypeError('Failed to fetch'); } });
  assert.deepEqual([offline.source, offline.version, offline.pricing.perLoad], ['cache', 'pc_2222222222222222', 1100]);
});

test('offline without a saved copy for this user the walkthrough gets no prices, never another user\'s', async () => {
  const { api } = loader();
  await api.load('zacb', { fetcher: async () => served() });
  const other = await api.load('alexk', { fetcher: async () => { throw new TypeError('offline'); } });
  assert.deepEqual(plain(other), { pricing: null, source: 'none', error: OFFLINE });
  assert.equal(api.cached('alexk'), null);
  assert.deepEqual(plain(await api.load('', { fetcher: async () => served() })), { pricing: null, source: 'none', error: OFFLINE });
});

test('a malformed or unavailable response is never cached and falls back to the saved copy', async () => {
  const { api, local } = loader();
  await api.load('zacb', { fetcher: async () => served() });
  const before = [...local.values.entries()];
  for (const body of [{ ok: true, version: 'pc_3333333333333333', parts: { walkthrough: { ...servedPricing(), perLoad: 'lots' } } }, { ok: true, version: 'bad version', parts: { walkthrough: servedPricing() } }, { ok: false, code: 'pricing_config_unavailable' }]) {
    const result = await api.load('zacb', { fetcher: async () => ({ ok: body.ok, status: body.ok ? 200 : 503, json: async () => body }) });
    assert.equal(result.source, 'cache');
  }
  const missingMinutes = servedPricing(); delete missingMinutes.minutes;
  assert.equal(api.valid(missingMinutes), false);
  assert.deepEqual([...local.values.entries()], before);
});

test('a login that loses access, an expired session, sign-out and the signout event all drop the saved tables', async () => {
  const { api, local, fire } = loader();
  await api.load('zacb', { fetcher: async () => served() });
  await api.load('tylerg', { fetcher: async () => served() });
  const denied = await api.load('tylerg', { fetcher: async () => ({ ok: false, status: 403, json: async () => ({ ok: false, code: 'pricing_config_forbidden' }) }) });
  assert.equal(denied.pricing, null);
  assert.deepEqual([...local.values.keys()], ['egc_walkthrough_pricing.v1.zacb.pc_1111111111111111']);
  const expired = await api.load('zacb', { fetcher: async () => { throw Object.assign(new Error('expired'), { code: 'HUB_AUTH_REQUIRED' }); } });
  assert.equal(expired.pricing, null);
  assert.equal(local.length, 0);
  await api.load('zacb', { fetcher: async () => served() });
  fire('egc:signout');
  assert.equal(local.length, 0);
  local.setItem('unrelated', 'kept');
  await api.load('zacb', { fetcher: async () => served() });
  api.clear();
  assert.deepEqual([...local.values.keys()], ['unrelated']);
});

test('a hung price request gives up and uses the saved copy', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const local = webStorage(), context = { localStorage: local, Date: FixedDate, AbortController, setTimeout, clearTimeout, addEventListener() {} };
  context.window = context;
  vm.runInContext(read('crew/walkthrough-pricing.js'), vm.createContext(context));
  await context.EGCWalkthroughPricing.load('zacb', { fetcher: async () => served() });
  const pending = context.EGCWalkthroughPricing.load('zacb', { timeoutMs: 15000, fetcher: (url, init) => new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted')))) });
  t.mock.timers.tick(15000);
  assert.equal((await pending).source, 'cache');
});

test('both sign-out paths remove the walkthrough price tables from this device', async () => {
  const saved = () => webStorage({ 'egc_walkthrough_pricing.v1.zacb.pc_1111111111111111': '{}', 'egc_walkthrough_pricing.v1.tylerg.pc_1111111111111111': '{}', 'egc-field:signed-out-at': '1' });
  const crewLocal = saved(), crew = { console, Date: FixedDate, Promise, Error, Set, Map, sessionStorage: webStorage(), localStorage: crewLocal, addEventListener() {},
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }), document: { readyState: 'complete', getElementById: () => null, querySelector: () => null, addEventListener() {} } };
  crew.window = crew;
  vm.runInNewContext(read('crew/hub-auth.js'), crew);
  await crew.EGCHubAuth.signOut();
  assert.deepEqual([...crewLocal.values.keys()], ['egc-field:signed-out-at']);
  const hubLocal = saved(), hub = {
    console, URLSearchParams, Date: FixedDate, Intl, Promise, Set, Map, Error, Event, sessionStorage: webStorage(), localStorage: hubLocal, navigator: {},
    location: { pathname: '/employee', search: '' }, setInterval: () => 1, clearInterval() {}, setTimeout: () => 1, clearTimeout() {}, addEventListener() {}, dispatchEvent() {},
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }), firebase: { auth: () => ({ signOut: async () => {} }) },
    _dataGeneration: 0, _dataUnsubscribers: [], _listenersStarted: false, _leadsTimer: null, jobsCache: [], custsCache: [], leadsCache: [], blockedDays: new Set(), blockedSlots: new Set(),
    document: { body: { classList: { remove() {} } }, getElementById: () => ({ style: {}, classList: { remove() {} }, value: '' }), querySelector: () => null, querySelectorAll: () => [], addEventListener() {} },
  };
  hub.window = hub;
  const page = read('employee.html');
  vm.runInNewContext(page.slice(page.indexOf('// Business access comes from the signed server profile'), page.indexOf('async function sendBookingConfirmation')) + '\nglobalThis.logout=doLogout;', hub);
  await hub.logout();
  assert.deepEqual([...hubLocal.values.keys()], ['egc-field:signed-out-at']);
});

// crew/gameplan.html with and without loaded tables.
const gameplan = read('crew/gameplan.html');
const line = prefix => gameplan.split(/\r?\n/).find(row => row.startsWith(prefix)) || assert.fail(prefix);
const PAGE_LINES = ['const $=id=>', 'const money=', 'const addOn=', 'const hazardLabel=', 'const pricingNote=', 'function input(', 'function area(', 'function quoteLinesMarkup(', 'function depositSummary(', 'function durationText(',
  'function reviewScreen(', 'function scheduleScreen(', 'function slotResults(', 'function recommend(', 'function estimatedJobMinutes(', 'function signedLines(', 'function readyToSend(', 'function slotSignature(', 'async function findNearestSlots(',
  'function applyPricingVersion(', 'async function loadPricing('];
function walkthroughPage({ pricing = null, error = OFFLINE, state = {}, load } = {}) {
  const calls = { openings: 0, renders: 0, saves: 0 };
  const context = vm.createContext({
    PRICING: pricing, PRICING_ERROR: pricing ? '' : error, walkthroughReady: true, SLOT_LOADING: false, SLOT_ERROR: '', SLOT_OPTIONS: [], SLOT_SIGNATURE: '',
    document: { getElementById: () => null }, validateStep: () => [], render: () => { calls.renders++; }, save: () => { calls.saves++; },
    buildJobInstructions: () => ({}), buildClientChecklists: () => ({ preJob: [], postJob: [] }), PHOTO_COUNT: 3,
    EGCHubAuth: { profile: () => ({ user: 'zacb' }) },
    window: { EGCWalkthroughHandoff: { openings: async () => { calls.openings++; } }, EGCWalkthroughPricing: { load: load || (async () => ({ pricing: null, error: OFFLINE })), OFFLINE } },
  });
  vm.runInContext(line('const freshState='), context);
  context.S = Object.assign(vm.runInContext('freshState()', context), { name: 'Synthetic Customer', garageSize: '1', fill: 'medium', loads: '1', jobDate: '2026-10-01', startTime: '08:00', endTime: '13:00' }, state);
  vm.runInContext(PAGE_LINES.map(line).join('\n'), context);
  return { context, calls };
}

test('offline with no saved tables the walkthrough says so instead of guessing a price, time or opening', async () => {
  const { context, calls } = walkthroughPage();
  assert.equal(context.recommend(), null);
  assert.deepEqual(plain(context.recommend(true)), []);
  assert.equal(context.estimatedJobMinutes(), null);
  const review = context.reviewScreen();
  assert.match(review, /Pricing unavailable offline — connect once to load prices/);
  assert.match(review, /Retry loading prices/);
  assert.doesNotMatch(review, /id="signature"|id="approved"|id="locked-price"|\$\d/, 'no approval, signature or price without loaded tables');
  assert.equal(context.S.lockedPrice, '', 'nothing is locked in');
  assert.match(context.scheduleScreen(), /<h2>Unavailable<\/h2><p role="status">Pricing unavailable offline/);
  assert.ok(Array.from(context.readyToSend()).includes('walkthrough prices (connect once to load prices)'));
  await context.findNearestSlots(true);
  assert.equal(calls.openings, 0);
  assert.equal(context.SLOT_ERROR, OFFLINE);
  assert.equal(context.SLOT_SIGNATURE, context.slotSignature(), 'the schedule screen does not keep re-requesting openings');
});

test('with the fetched tables the review screen shows the rates from the config, and never the owner\'s targets', () => {
  const { context } = walkthroughPage({ pricing: servedPricing(), state: { hazards: ['Pest waste'], finish: ['cleanout', 'pressure_wash', 'mouse_trapping'] } });
  const review = context.reviewScreen();
  assert.match(review, /<div class="price">\$1,850<\/div>/);
  assert.match(review, /Truckload pricing uses \$1,000 per full load, plus selected extras\. One-car pressure washing adds \$400; pest waste adds \$200; non-toxic mouse trapping adds \$250 when selected\./);
  assert.match(review, /Pest waste \(\+\$200\)/);
  assert.match(review, /One-car pressure wash \(\+\$400\)/);
  assert.match(review, /id="signature"/);
  assert.doesNotMatch(review, /target|2,250/i);
  assert.equal(context.S.lockedPrice, '1850');
  assert.match(context.scheduleScreen(), /<h2>4 hours<\/h2>/, '60 + 90 per load + 30 medium fill + 60 one-car wash');
  const priced = walkthroughPage({ pricing: { ...servedPricing(), perLoad: 1200 } }).context;
  assert.equal(priced.recommend(), 1200, 'the page prices with whatever the server serves');
});

test('prices that arrive after a draft opens re-price only unsigned automatic totals, as a pricing update always has', async () => {
  const drafts = [
    [{ lockedPrice: '900', pricingVersion: '2026-09-older' }, ''],
    [{ lockedPrice: '900', pricingVersion: '2026-09-older', priceManuallySet: true }, '900'],
    [{ lockedPrice: '900', pricingVersion: '2026-09-older', approved: true, signature: 'data:image/png;base64,c2lnbmVk' }, '900'],
    [{ lockedPrice: '900', pricingVersion: '2026-09-pest200-traps250' }, '900'],
  ];
  for (const [state, lockedPrice] of drafts) {
    const { context, calls } = walkthroughPage({ state, load: async user => ({ pricing: user === 'zacb' ? servedPricing() : null, source: 'cache' }) });
    await context.loadPricing();
    assert.equal(context.S.lockedPrice, lockedPrice, JSON.stringify(state));
    assert.equal(context.S.pricingVersion, '2026-09-pest200-traps250');
    assert.equal(context.PRICING_ERROR, '');
    assert.deepEqual([calls.saves, calls.renders], [1, 1]);
  }
  const failing = walkthroughPage({ pricing: null, load: async () => { throw new Error('boom'); } });
  await failing.context.loadPricing();
  assert.deepEqual([failing.context.PRICING, failing.context.PRICING_ERROR], [null, OFFLINE]);
});

test('the walkthrough page loads its tables after sign-in and ships none of its own', () => {
  assert.match(gameplan, /<script src="\/crew\/walkthrough-pricing\.js\?v=\d{8}price"><\/script>\n<script>/, 'the loader precedes the page script');
  assert.match(line('async function openApp()'), /const pricing=loadPricing\(\);.*await Promise\.all\(\[pricing,loadAppointments\(\)\]\)/);
  assert.match(line('const freshState='), /pricingVersion:'',/);
});

// A phone reload of an appointment walkthrough: the page restores the draft before prices load.
function devicePage(device, { pricing = null } = {}) {
  const context = vm.createContext({
    PRICING: pricing, PRICING_ERROR: pricing ? '' : 'Loading prices…', walkthroughReady: false, SLOT_LOADING: false, SLOT_ERROR: '', SLOT_OPTIONS: [], SLOT_SIGNATURE: '',
    SAVE: 'egc_walkthrough_v3', FLOW: '2026-09-simple', REQUESTED_WALKTHROUGH_ID: '', index: 0, error: '', sections: ['Customer', 'Photos', 'Scope', 'Finish', 'Schedule', 'Review'],
    Date: FixedDate, localStorage: device, document: { getElementById: () => ({ textContent: '', style: {} }) }, validateStep: () => [], render: () => {},
    buildJobInstructions: () => ({}), buildClientChecklists: () => ({ preJob: [], postJob: [] }), PHOTO_COUNT: 3, EGCHubAuth: { profile: () => ({ user: 'zacb' }) },
    window: { EGCWalkthroughHandoff: { openings: async () => {} }, EGCWalkthroughPricing: { load: async () => ({ pricing: servedPricing(), source: 'cache' }), OFFLINE } },
  });
  vm.runInContext(line('const freshState='), context);
  context.S = vm.runInContext('freshState()', context);
  vm.runInContext([...PAGE_LINES, 'const draftKey=', 'function save(){', 'function restore(', 'function resetForWalkthrough(', 'function setApproval('].map(line).join('\n'), context);
  return context;
}
const APPROVED = { approved: true, acceptanceAt: '2026-09-22T15:00:00.000Z', acceptanceBy: 'Synthetic Customer', lockedPrice: '1650', priceManuallySet: false };

test('an appointment walkthrough approved before a reload keeps its approval and automatic price once prices load again', async () => {
  for (const pricesFirst of [true, false]) {
    const device = webStorage(), first = devicePage(device, { pricing: pricesFirst ? servedPricing() : null });
    first.resetForWalkthrough('walkthrough-9');
    Object.assign(first.S, { name: 'Synthetic Customer', garageSize: '1', fill: 'medium', loads: '1', jobDate: '2026-10-01', startTime: '08:00', endTime: '13:00' });
    first.walkthroughReady = true;
    if (!pricesFirst) await first.loadPricing();
    first.reviewScreen();
    first.setApproval(true);
    assert.equal(first.S.pricingVersion, '2026-09-pest200-traps250', `stamped (${pricesFirst ? 'prices first' : 'prices after'})`);
    const saved = JSON.parse(device.getItem('egc_walkthrough_v3:walkthrough-9')).S;
    assert.deepEqual([saved.lockedPrice, saved.approved, saved.acceptanceAt, saved.pricingVersion], ['1000', true, '2026-09-22T15:00:00.000Z', '2026-09-pest200-traps250']);

    const reload = devicePage(device);
    reload.resetForWalkthrough('walkthrough-9'); reload.restore('walkthrough-9'); reload.walkthroughReady = true;
    await reload.loadPricing();
    assert.deepEqual([reload.S.lockedPrice, reload.S.approved, reload.S.acceptanceAt, reload.S.acceptanceBy, reload.S.pricingVersion], ['1000', true, '2026-09-22T15:00:00.000Z', 'Synthetic Customer', '2026-09-pest200-traps250']);
  }
});

test('a draft saved before any prices loaded adopts the loaded version, while an older or unversioned draft still re-prices', async () => {
  const cases = [[{ pricingVersion: '' }, '1650', true], [{ pricingVersion: '2026-09-older' }, '', false], [{}, '', false]];
  for (const [version, lockedPrice, approved] of cases) {
    const device = webStorage({ 'egc_walkthrough_v3:walkthrough-9': JSON.stringify({ flow: '2026-09-simple', index: 5, S: { sourceWalkthroughId: 'walkthrough-9', termsVersion: '2026-09-deposit50', ...APPROVED, ...version } }) });
    const page = devicePage(device);
    page.restore('walkthrough-9'); page.walkthroughReady = true;
    await page.loadPricing();
    assert.deepEqual([page.S.lockedPrice, page.S.approved, page.S.pricingVersion], [lockedPrice, approved, '2026-09-pest200-traps250'], JSON.stringify(version));
    assert.equal(JSON.parse(device.getItem('egc_walkthrough_v3:walkthrough-9')).S.pricingVersion, '2026-09-pest200-traps250');
  }
});

// Employee Hub: in-memory phone and owner tables.
function hubPricing(fetcher) {
  const listeners = {}, calls = [], context = { hubFetch: async (url, init) => { calls.push(url); return fetcher(url, init); }, addEventListener: (name, listener) => { (listeners[name] ||= []).push(listener); } };
  context.window = context;
  vm.runInContext(read('employee-pricing.js'), vm.createContext(context));
  return { api: context.EGCPricingConfig, calls, fire: name => (listeners[name] || []).forEach(listener => listener()) };
}
const partResponse = (part, body) => ({ ok: true, status: 200, json: async () => ({ ok: true, version: 'pc_4444444444444444', parts: { [part]: body } }) });

test('the Hub keeps phone and owner pricing in memory for the session only, validates it, and drops it on sign-out', async () => {
  const hub = hubPricing(async url => url.endsWith('owner') ? partResponse('owner', plain(ownerEconomics())) : partResponse('phone', plain(phoneQuotePricing())));
  const [first, second] = await Promise.all([hub.api.load('owner'), hub.api.load('owner')]);
  assert.equal(first, second);
  assert.equal(Object.isFrozen(first.wages), true);
  assert.deepEqual(hub.calls, ['/api/pricing-config?parts=owner'], 'one request per part');
  assert.equal((await hub.api.load('phone')).baseFee, 150);
  assert.equal(hub.api.owner().laborCostPerCrewHour, 20);
  assert.equal(await hub.api.load('walkthrough'), null, 'the Hub never asks for the walkthrough tables');
  hub.fire('egc:signout');
  assert.deepEqual([hub.api.owner(), hub.api.phone()], [null, null]);
  let release;
  const slow = hubPricing(() => new Promise(resolve => { release = () => resolve(partResponse('owner', plain(ownerEconomics()))); }));
  const pending = slow.api.load('owner');
  slow.api.clear(); release();
  assert.equal(await pending, null, 'a reply that lands after sign-out is dropped');
  assert.equal(slow.api.owner(), null);
  for (const body of [{ ...plain(ownerEconomics()), laborCostPerCrewHour: '20' }, { ...plain(ownerEconomics()), targets: null }]) {
    const bad = hubPricing(async () => partResponse('owner', body));
    assert.equal(await bad.api.load('owner'), null);
  }
  const denied = hubPricing(async () => ({ ok: false, status: 403, json: async () => ({ ok: false, code: 'pricing_config_forbidden' }) }));
  assert.equal(await denied.api.load('phone'), null);
});

const job = { id: 'job-1', type: 'job', customer: 'Synthetic Customer', date: '2026-09-22', time: '09:00', status: 'completed', pipelineStatus: 'completed', priceQuoted: 1000, hoursOnSite: 3, crewSize: 2 };
// JOB-COST-PRIVACY: labor dollars are owner-only and live in the server-only jobLaborCosts record, which the Hub reads
// and saves through /api/job-labor-costs (employee-labor-costs.js). This stands in for that server: the owner gets the
// records and saves them, and a manager is answered "hidden" with no figures, as functions/api/job-labor-costs.js does.
function laborServer(owner, records = {}) {
  const saves = [];
  const handle = async (url, init = {}) => {
    if ((init.method || 'GET') === 'GET') return { ok: true, status: 200, json: async () => owner ? { ok: true, laborCostHidden: false, complete: true, jobs: Object.values(records) } : { ok: true, laborCostHidden: true, jobs: null } };
    const body = JSON.parse(init.body);
    saves.push(body);
    records[body.jobId] = { jobId: body.jobId, laborCents: body.laborCents, revision: `l${saves.length}`, recordedAt: '2026-09-22T18:00:00.000Z', recordedBy: 'zacb' };
    return { ok: true, status: 200, json: async () => ({ ok: true, labor: records[body.jobId] }) };
  };
  return { handle, saves, records };
}
async function suite({ owner, before, jobRow = job, pricing = true, records = {} }) {
  const labor = laborServer(owner, records);
  const page = hubPage({ user: owner ? 'ZacB' : 'TylerG', role: owner ? 'owner' : 'manager', before, fetcher: async (url, init) => url === '/api/pricing-config?parts=owner' && pricing ? partResponse('owner', plain(ownerEconomics())) : url === '/api/job-labor-costs' ? labor.handle(url, init) : { ok: false, status: 503, json: async () => ({ ok: false, error: 'Synthetic service unavailable' }) } });
  vm.runInContext(read('employee-pricing.js'), page.context);
  vm.runInContext(read('employee-labor-costs.js'), page.context);
  page.context.jobsCache = [structuredClone(jobRow)];
  page.api.install();
  await page.api.loadAll();
  await page.context.EGCLaborCosts.load();
  await page.flush();
  const view = name => { page.api.go(name); return page.main().textContent; };
  return { page, view, labor };
}

test('the owner sees the labor baseline, wages and targets from the config; a manager sees the same screens without numbers', async () => {
  const owner = await suite({ owner: true });
  assert.ok(owner.page.calls.some(call => call.url === '/api/pricing-config?parts=owner'));
  const playbook = owner.view('playbook');
  assert.match(playbook, /\$20\/hr crew; \$23\/hr lead baseline\. Lead owns communication/);
  assert.match(playbook, /\$2,250\+ target average ticket; smaller jobs remain available/);
  assert.match(playbook, /roughly \$150–\$200 rental cost\/job/);
  const score = owner.view('scorecard');
  assert.match(score, /Target: 50%/); assert.match(score, /Target: \$2,250\+/); assert.match(score, /Target: ~70% at a better price/);
  const finance = owner.view('finance');
  assert.match(finance, /Estimated labor uses the \$20\/crew-hour baseline/);
  assert.match(finance, /6\.0 crew-hrs · \$120 direct cost/);
  assert.match(finance, /\$880 contribution/);
  // An older labor copy on the job is the owner's figure until it moves to the private record.
  owner.page.context.jobsCache = [{ ...structuredClone(job), costs: { labor: 150, disposal: 40, recordedAt: '2026-09-22T20:00:00.000Z' } }];
  assert.match(owner.view('finance'), /\$190 direct cost/);
  assert.match(owner.view('finance'), /\$810 contribution/);

  const manager = await suite({ owner: false });
  assert.equal(manager.page.calls.some(call => call.url.startsWith('/api/pricing-config')), false, 'a manager never asks for the owner part');
  // Even with the owner's numbers somehow in memory, a manager's screens stay number-free.
  manager.page.context.EGCPricingConfig = { load: async () => ownerEconomics(), owner: () => ownerEconomics(), phone: () => null, clear() {} };
  for (const name of ['playbook', 'scorecard', 'finance']) {
    const text = manager.view(name);
    assert.doesNotMatch(text, /\$20|\$23|2,250|\$150–|Target: \d|Target: ~/, name);
  }
  assert.match(manager.view('playbook'), /Lead owns communication, scope, payment, and closeout/);
  const finance2 = manager.view('finance');
  assert.match(finance2, /Labor dollars, and the contribution and margin that include them, are for the owner only/);
  assert.match(finance2, /6\.0 crew-hrs · Labor \$ hidden/);
  assert.doesNotMatch(finance2, /direct cost ·|contribution ·|Labor cost unknown/, 'no labor-based figure, and no hint about the owner\'s labor');
  // The same older labor copy: a manager gets the hours and the non-labor cost, never labor, direct cost or contribution.
  manager.page.context.jobsCache = [{ ...structuredClone(job), costs: { labor: 150, disposal: 40, recordedAt: '2026-09-22T20:00:00.000Z' } }];
  const finance3 = manager.view('finance');
  assert.match(finance3, /6\.0 crew-hrs · Labor \$ hidden/);
  assert.match(finance3, /\$40 non-labor cost/);
  assert.doesNotMatch(finance3, /\$190|\$810|\$150|direct cost|contribution ·/);
});

// Job costing: a blank labor field means unknown, never a recorded $0 (the form used to pre-fill crew-hours x $20), and
// only the owner enters or blanks labor (JOB-COST-PRIVACY): the figure goes to the private record, never onto the job.
async function costForm({ owner, jobRow = job, pricing = true, records = {} }) {
  const writes = [];
  const db = { collection: name => ({ doc: id => ({ set: async (update, options) => { writes.push({ name, id, update: structuredClone(update), options: { ...options } }); } }) }) };
  const { page, view, labor } = await suite({ owner, before: context => { context.db = db; }, jobRow, pricing, records });
  const saving = page.context.opsFinanceAction('job-1', 'cost');
  await page.flush();
  const form = page.document.querySelector('.ops-action-dialog'), field = name => form.querySelector(`input[name="${name}"]`);
  return { page, view, writes, labor, field, submit: async values => { for (const [name, value] of Object.entries(values)) field(name).value = value; page.context.opsActionSubmit({ preventDefault() {}, currentTarget: form }); await saving; await page.flush(); } };
}

test('the owner with no labor baseline who leaves labor blank records the other costs and labor stays unknown; a manager has no labor field', async () => {
  const form = await costForm({ owner: true, pricing: false });
  assert.equal(form.field('labor').value, '', 'no guessed labor is pre-filled');
  assert.equal(form.field('labor').hasAttribute('required'), false, 'labor can be left blank');
  assert.equal(form.field('labor').getAttribute('inputmode'), 'decimal');
  assert.equal(form.field('disposal').hasAttribute('required'), true);
  await form.submit({ disposal: '40' });
  assert.equal(form.writes.length, 1);
  const { name, id, update, options } = form.writes[0];
  assert.deepEqual([name, id, options], ['jobs', 'job-1', { merge: true }]);
  // Nothing was saved anywhere, so no record is made: the job's blank costs.labor (a null reveals nothing) says unknown.
  assert.deepEqual(plain(update.costs), { labor: null, disposal: 40, materials: 0, fuel: 0, processing: 0, other: 0, recordedAt: '2026-09-22T18:00:00.000Z', recordedBy: 'ZacB', source: 'egc_hub' });
  assert.deepEqual(form.labor.saves, []);
  const finance = form.view('finance');
  assert.match(finance, /Labor cost unknown until actual costs are entered/);
  assert.doesNotMatch(finance, /direct cost ·|contribution ·/, 'no contribution from an unknown labor cost');
  // Reopening the form still shows labor blank, and an entered figure (even $0) is then recorded as known, in the record.
  const again = await costForm({ owner: true, pricing: false, jobRow: { ...structuredClone(job), costs: plain(update.costs) } });
  assert.equal(again.field('labor').value, '');
  assert.equal(again.field('disposal').value, '40');
  await again.submit({ labor: '0' });
  assert.deepEqual(again.labor.saves.map(body => [body.jobId, body.laborCents, body.expectedRevision]), [['job-1', 0, null]]);
  assert.equal('labor' in again.writes[0].update.costs, false, 'labor never goes onto the job');
  assert.match(again.view('finance'), /\$40 direct cost/);

  // A manager: the form has no labor field, the save carries no labor key, and nothing is sent to the labor record.
  const manager = await costForm({ owner: false });
  assert.equal(manager.field('labor'), null);
  await manager.submit({ disposal: '40' });
  assert.deepEqual(plain(manager.writes[0].update.costs), { disposal: 40, materials: 0, fuel: 0, processing: 0, other: 0, recordedAt: '2026-09-22T18:00:00.000Z', recordedBy: 'TylerG', source: 'egc_hub' });
  assert.equal(manager.page.calls.some(call => call.url === '/api/job-labor-costs' && call.method === 'POST'), false);
  assert.match(manager.view('finance'), /Labor \$ hidden/);
});

test('blanking a recorded labor cost clears it, and the owner\'s baseline estimate applies again; only the owner can blank it', async () => {
  const recorded = { ...structuredClone(job), costs: { disposal: 10, materials: 0, fuel: 0, processing: 0, other: 0, recordedAt: '2026-09-21T20:00:00.000Z' } };
  const records = { 'job-1': { jobId: 'job-1', laborCents: 30000, revision: 'l0', recordedAt: '2026-09-21T20:00:00.000Z', recordedBy: 'zacb' } };
  // A manager cannot see or blank the owner's figure: no labor field, and the record is untouched.
  const manager = await costForm({ owner: false, jobRow: recorded, records: structuredClone(records) });
  assert.equal(manager.field('labor'), null);
  assert.doesNotMatch(manager.page.document.querySelector('.ops-action-dialog').textContent, /300/);
  await manager.submit({ disposal: '10' });
  assert.deepEqual([manager.labor.saves, manager.labor.records['job-1'].laborCents, 'labor' in manager.writes[0].update.costs], [[], 30000, false]);

  const owner = await costForm({ owner: true, jobRow: recorded, records: structuredClone(records) });
  assert.equal(owner.field('labor').value, '300');
  await owner.submit({ labor: '' });
  assert.deepEqual(owner.labor.saves.map(body => [body.laborCents, body.expectedRevision]), [[null, 'l0']], 'the record is blanked (unknown), not deleted or zeroed');
  assert.equal('labor' in owner.writes[0].update.costs, false, 'the job carries no labor key');
  const reopened = await costForm({ owner: true, jobRow: { ...recorded, costs: plain(owner.writes[0].update.costs) }, records: owner.labor.records });
  assert.equal(reopened.field('labor').value, '120', 'the owner sees the 6 crew-hour x $20 baseline estimate');
  reopened.page.context.opsActionClose();
  assert.match(reopened.view('finance'), /6\.0 crew-hrs · \$130 direct cost/);
  assert.equal(reopened.writes.length, 0);
  // An older copy left on the job, with no record yet: the owner's blank goes through the record too, which moves it off.
  const legacy = await costForm({ owner: true, jobRow: { ...recorded, costs: { ...recorded.costs, labor: 300 } } });
  assert.equal(legacy.field('labor').value, '300');
  await legacy.submit({ labor: '' });
  assert.deepEqual([legacy.labor.saves.map(body => [body.laborCents, body.expectedRevision]), 'labor' in legacy.writes[0].update.costs], [[[null, null]], false]);
});

test('with no crew hours logged a blank labor cost stays unknown for the owner instead of a silent $0; a manager sees Labor $ hidden', async () => {
  const noHours = { ...structuredClone(job), hoursOnSite: 0 };
  const form = await costForm({ owner: true, jobRow: noHours });
  assert.equal(form.field('labor').value, '', 'no crew hours means no labor figure to suggest, not $0');
  await form.submit({ labor: '', disposal: '40' });
  assert.equal(form.writes[0].update.costs.labor, null);
  const finance = form.view('finance');
  assert.match(finance, /Labor cost unknown until actual costs are entered/);
  assert.doesNotMatch(finance, /direct cost ·|contribution ·/);
  const manager = await costForm({ owner: false, jobRow: noHours });
  assert.equal(manager.field('labor'), null);
  await manager.submit({ disposal: '40' });
  assert.equal('labor' in manager.writes[0].update.costs, false);
  const hidden = manager.view('finance');
  assert.match(hidden, /Labor \$ hidden/);
  assert.doesNotMatch(hidden, /Labor cost unknown|direct cost ·|contribution ·/);
  // Before any costs are saved a job with no hours shows nothing to cost, as before.
  for (const owner of [true, false]) {
    const untouched = await suite({ owner, jobRow: noHours });
    assert.doesNotMatch(untouched.view('finance'), /Labor cost unknown|direct cost ·|crew-hrs/, owner ? 'owner' : 'manager');
  }
});

// Second review: an online device whose Hub answers without tables is told so, not that it is offline.
const UNAVAILABLE = 'Prices could not be loaded from the Hub. Retry shortly or tell the office.';
test('a Hub reply without usable tables says the Hub could not load prices; only a failed connection says offline', async t => {
  const { api } = loader();
  assert.equal(api.UNAVAILABLE, UNAVAILABLE);
  const replies = [
    { ok: false, status: 503, json: async () => ({ ok: false, code: 'pricing_config_unavailable' }) },
    { ok: false, status: 503, json: async () => ({ ok: false, code: 'pricing_config_catalog_mismatch' }) },
    { ok: false, status: 502, json: async () => { throw new SyntaxError('not JSON'); } },
    { ok: true, status: 200, json: async () => ({ ok: true, version: 'pc_3333333333333333', parts: { walkthrough: { ...servedPricing(), perLoad: 'lots' } } }) },
  ];
  for (const reply of replies) assert.deepEqual(plain(await api.load('zacb', { fetcher: async () => reply })), { pricing: null, source: 'none', error: UNAVAILABLE }, String(reply.status));
  assert.deepEqual(plain(await api.load('zacb', { fetcher: async () => { throw new TypeError('Failed to fetch'); } })), { pricing: null, source: 'none', error: OFFLINE });
  // The saved copy still prices the walkthrough when the Hub fails.
  await api.load('zacb', { fetcher: async () => served() });
  assert.equal((await api.load('zacb', { fetcher: async () => replies[0] })).source, 'cache');
  // A request or a reply body cut off by the timeout is a connection problem.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const context = { localStorage: webStorage(), Date: FixedDate, AbortController, setTimeout, clearTimeout, addEventListener() {} };
  context.window = context;
  vm.runInContext(read('crew/walkthrough-pricing.js'), vm.createContext(context));
  const hung = context.EGCWalkthroughPricing.load('zacb', { timeoutMs: 15000, fetcher: (url, init) => new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted')))) });
  t.mock.timers.tick(15000);
  assert.equal((await hung).error, OFFLINE);
  let bodyRequested;
  const bodyStarted = new Promise(resolve => { bodyRequested = resolve; });
  const slowBody = context.EGCWalkthroughPricing.load('zacb', { timeoutMs: 15000, fetcher: async (url, init) => ({ ok: true, status: 200, json: () => new Promise((resolve, reject) => { init.signal.addEventListener('abort', () => reject(new Error('aborted'))); bodyRequested(); }) }) });
  await bodyStarted;
  t.mock.timers.tick(15000);
  assert.equal((await slowBody).error, OFFLINE);
});

// Second review: the tables also leave when the device forgets the account without a sign-out.
function crewAuth(local, { hubAuth, user = 'zacb' } = {}) {
  const context = { console, Date: FixedDate, Promise, Error, Set, Map, JSON, sessionStorage: webStorage(), localStorage: local, addEventListener() {}, dispatchEvent() {}, Event: class { constructor(type) { this.type = type; } },
    firebase: { auth: () => ({ signInWithCustomToken: async () => ({}), signOut: async () => {} }) },
    fetch: async url => url === '/api/firebase-session' ? { ok: true, status: 200, json: async () => ({ ok: true, token: 'synthetic-token' }) }
      : url === '/api/hub-auth' ? (hubAuth ? hubAuth() : { ok: true, status: 200, json: async () => ({ ok: true, user, displayName: user, role: 'owner', businessAccess: true, owner: true }) })
      : { ok: false, status: 401, json: async () => ({ ok: false }) },
    document: { readyState: 'complete', getElementById: () => null, querySelector: () => null, addEventListener() {} } };
  context.window = context;
  vm.runInNewContext(read('crew/hub-auth.js'), context);
  return context.EGCHubAuth;
}
const tables = extra => webStorage({ 'egc_walkthrough_pricing.v1.zacb.pc_1111111111111111': '{}', unrelated: 'kept', ...extra });
const tableKeys = local => [...local.values.keys()].filter(key => key.startsWith('egc_walkthrough_pricing.'));

test('an expired or failed session check, a 401 reply and a different account signing in drop the saved tables; the same account keeps them', async () => {
  for (const [name, hubAuth] of [['401', () => ({ ok: false, status: 401, json: async () => ({ ok: false, error: 'Sign in required' }) })], ['503', () => ({ ok: false, status: 503, json: async () => ({ ok: false }) })], ['network', () => { throw new TypeError('Failed to fetch'); }]]) {
    const local = tables({ egc_u: 'zacb' });
    assert.equal(await crewAuth(local, { hubAuth }).session(), null, name);
    assert.deepEqual(tableKeys(local), [], name);
    assert.equal(local.getItem('unrelated'), 'kept');
  }
  const expired = tables({ egc_u: 'zacb' });
  await assert.rejects(crewAuth(expired).fetch('/api/pricing-config?parts=walkthrough'), { code: 'HUB_AUTH_REQUIRED' });
  assert.deepEqual(tableKeys(expired), []);
  const same = tables({ egc_u: 'ZacB' });
  assert.equal(await crewAuth(same, { user: 'zacb' }).session(), 'zacb');
  assert.deepEqual(tableKeys(same), ['egc_walkthrough_pricing.v1.zacb.pc_1111111111111111'], 'the same account keeps its tables');
  const other = tables({ egc_u: 'zacb' });
  assert.equal(await crewAuth(other, { user: 'tylerg' }).session(), 'tylerg');
  assert.deepEqual(tableKeys(other), [], 'another account does not inherit them');
  assert.equal(other.getItem('egc_u'), 'tylerg');
  const signedIn = tables({ egc_u: 'zacb' });
  await crewAuth(signedIn, { user: 'alexk' }).signIn('alexk', 'synthetic-password');
  assert.deepEqual(tableKeys(signedIn), []);
});

test('the Hub page drops the saved tables when its session check fails, not only on sign-out', async () => {
  for (const reply of [{ ok: false, status: 401, json: async () => ({ ok: false }) }, { ok: false, status: 503, json: async () => ({ ok: false, error: 'Synthetic outage' }) }]) {
    const local = tables(), hub = {
      console, URLSearchParams, Date: FixedDate, Intl, Promise, Set, Map, Error, Event, sessionStorage: webStorage(), localStorage: local, navigator: {},
      location: { pathname: '/employee', search: '' }, setInterval: () => 1, clearInterval() {}, setTimeout: () => 1, clearTimeout() {}, addEventListener() {}, dispatchEvent() {},
      fetch: async () => reply, firebase: { auth: () => ({ signOut: async () => {} }) },
      document: { body: { classList: { remove() {} } }, getElementById: () => ({ style: {}, classList: { remove() {} }, value: '' }), querySelector: () => null, querySelectorAll: () => [], addEventListener() {} },
    };
    hub.window = hub;
    const page = read('employee.html');
    vm.runInNewContext(page.slice(page.indexOf('// Business access comes from the signed server profile'), page.indexOf('async function sendBookingConfirmation')) + '\nglobalThis.restore=restoreHubSession;', hub);
    await hub.restore();
    assert.deepEqual(tableKeys(local), [], String(reply.status));
    assert.equal(local.getItem('unrelated'), 'kept');
  }
});

// Second review: a manager's timesheet no longer labels every other employee 'hourly'.
async function timesheets({ owner }) {
  const blobs = [];
  const own = { id: 'own-1', employee: 'TylerG', employeeName: 'Synthetic Manager', payType: 'salary', hourlyRate: 30, clockInAt: '2026-09-21T15:00:00.000Z', clockOutAt: '2026-09-21T19:00:00.000Z', status: 'submitted', approvalStatus: 'approved', jobLabel: 'Synthetic Customer', jobId: 'job-1', breaks: [] };
  // As /api/employee-hub sends another employee's shift: the owner gets the pay fields, a manager does not.
  // Each carries the jobTime /api/employee-hub derives from its job segments (CREW-TIME): the manager worked on job-1, the crew
  // member's shift was general company time.
  const crew = { id: 'crew-1', employee: 'Crew.One', employeeName: 'Crew One', clockInAt: '2026-09-22T15:00:00.000Z', clockOutAt: '2026-09-22T19:00:00.000Z', status: 'submitted', approvalStatus: 'pending', breaks: [], jobTime: { current: null, jobs: [], generalMs: 4 * 3600000, untrackedMs: 0, recorded: true, partialHistory: false, needsReview: false }, ...(owner ? { payType: 'salary', hourlyRate: 21 } : {}) };
  own.jobTime = { current: null, jobs: [{ jobId: 'job-1', jobLabel: 'Synthetic Customer', workMs: 4 * 3600000, travelMs: 0 }], generalMs: 0, untrackedMs: 0, recorded: true, partialHistory: false, needsReview: false };
  const collections = Object.fromEntries(['profiles', 'timeEntries', 'announcements', 'requests', 'incidents', 'equipment', 'training', 'teamMessages', 'jobMessages', 'messageReads'].map(name => [name, name === 'timeEntries' ? [own, crew] : []]));
  const page = hubPage({ user: owner ? 'ZacB' : 'TylerG', role: owner ? 'owner' : 'manager', before: context => {
    context.Blob = class { constructor(parts) { blobs.push(parts.join('')); } };
    context.URL = class extends URL { static createObjectURL() { return 'blob:synthetic'; } static revokeObjectURL() {} };
  }, fetcher: async url => url.startsWith('/api/employee-hub') ? { ok: true, status: 200, json: async () => ({ ok: true, collections: structuredClone(collections), payVisibility: owner ? 'all' : 'own', accounts: [] }) } : { ok: false, status: 503, json: async () => ({ ok: false, error: 'Synthetic service unavailable' }) } });
  page.api.install();
  await page.api.loadAll();
  await page.flush();
  page.api.S.timesheetAnchor = '2026-09-22';
  page.api.go('timesheets');
  await page.flush();
  const board = page.main().textContent;
  page.context.opsDownloadTimesheets();
  const csv = blobs.at(-1).split('\r\n');
  return { board, csv };
}

// PAY-TIMESHEETS: the Service column is the job's service for every viewer, never a pay type (job-1 is not in the job cache
// here, so it is blank), and an employee whose pay the server did not send reads "Pay hidden", never a $0 total.
test('the timesheet Service column is the job\'s service, never a pay type, and another employee\'s pay reads "Pay hidden" where it is not shown', async () => {
  const manager = await timesheets({ owner: false });
  // CREW-TIME: the third column lists the shift's job time from its segments (it was the clock-in job label, "Customer").
  assert.equal(manager.csv[0], '"Employee","Date","Job time","Service","Job ID","Hours","Started at","Completed at"');
  assert.equal(manager.csv.find(row => row.startsWith('"Crew One"')), '"Crew One","2026-09-22","General company time 4.00 h","","","4.00","2026-09-22T15:00:00.000Z","2026-09-22T19:00:00.000Z"');
  assert.match(manager.csv.find(row => row.startsWith('"Synthetic Manager"')), /^"Synthetic Manager","2026-09-21","Synthetic Customer: work 4.00 h","","job-1",/, 'the manager\'s own Service is the job\'s too');
  assert.doesNotMatch(manager.board, /hourly/);
  assert.doesNotMatch(manager.board, /salary/);
  assert.match(manager.board, /Crew One/);
  assert.match(manager.board, /job-1/);
  assert.match(manager.board, /Pay hidden/);
  assert.match(manager.board, /\$120/, 'the manager\'s own pay (4 hours at 30) stays');
  assert.doesNotMatch(manager.board, /\$84|\$0\b/, 'no figure, and no $0 stand-in, for the crew member');
  const owner = await timesheets({ owner: true });
  assert.match(owner.csv.find(row => row.startsWith('"Crew One"')), /^"Crew One","2026-09-22","General company time 4.00 h","","",/);
  assert.doesNotMatch(owner.board, /salary|Pay hidden/);
  assert.match(owner.board, /\$84/, 'the owner sees the crew member\'s pay (4 hours at 21)');
});
