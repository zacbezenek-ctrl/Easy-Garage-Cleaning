// CATALOG-ADMIN: the owner catalog & pricing Hub screen (employee-catalog.js). The pure model is checked against
// the server's own validators (functions/_lib/catalog.js), and the screen runs in a vm DOM against the REAL
// /api/catalog handler over an in-memory Firestore REST emulation, with the clock injected everywhere.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createDocument, storage, hubPage } from './helpers/hub-dom.mjs';
import { catalogHandlers } from '../functions/api/catalog.js';
import { catalogStorage, mutateCatalog, seedCatalog, seedPricingSettings } from '../functions/_lib/catalog-store.js';
import { validateCatalog, validatePricingSettings } from '../functions/_lib/catalog.js';
import { decodeFirestoreFields } from '../functions/_lib/firestore-job.js';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const SOURCE = read('../employee-catalog.js'), KIT = read('../employee-ui-kit.js');
const shipped = JSON.parse(read('../functions/_data/garage-catalog.json')), defaults = JSON.parse(read('../functions/_data/pricing-settings.defaults.json'));
const copy = value => JSON.parse(JSON.stringify(value));
const ORIGIN = 'https://easygaragecleaning.com', ENV = { CATALOG_QUOTES_ENABLED: 'true' }, DOCS = 'projects/egcw-1ec83/databases/(default)/documents/';
const NOW = '2026-09-28T05:30:00.000Z'; // 11:30 PM Sept 27 in Denver
const TODAY = '2026-09-27';
const OWNER = { user: 'zacb', role: 'owner', businessAccess: true, displayName: 'Synthetic Owner' };
const MANAGER = { user: 'tylerg', role: 'manager', businessAccess: true, displayName: 'Synthetic Manager' };
const verified = shipped.items.filter(item => item.priceVerified), unverifiedProducts = shipped.items.filter(item => !item.priceVerified && item.kind === 'product');
const LAST_CHECK = verified.map(item => item.priceVerifiedAt).sort().at(-1);

function model() {
  const context = { console, Intl, URL, addEventListener() {}, sessionStorage: storage() };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(SOURCE, context, { filename: 'employee-catalog.js' });
  return context.EGCCatalog.model;
}
const M = model();
const withItem = (item, catalog = shipped) => ({ ...copy(catalog), items: catalog.items.map(entry => entry.id === item.id ? copy(item) : entry) });
const publishable = (catalog, version = '2026-09-27.2') => validateCatalog({ ...copy(catalog), catalogVersion: version, generatedOn: version.slice(0, 10) });
const verifyInput = (overrides = {}) => ({ retailer: 'Synthetic Hardware', url: 'https://synthetic.example.com/p/1', evidence: 'product_page', low: '49.98', high: '', checkedOn: TODAY, note: '', ...overrides });

// Firestore REST with the real precondition answers, like tests/catalog-api.test.mjs.
function firestore() {
  const docs = new Map(), posts = [];
  let tick = 0;
  const error = (status, code) => Response.json({ error: { code, status } }, { status: code });
  async function fetcher(_env, url, options = {}) {
    const target = new URL(url);
    assert.equal(target.hostname, 'firestore.googleapis.com', 'only Firestore is reachable');
    const path = decodeURIComponent(target.pathname.split('/documents')[1] || '');
    if (options.method === 'POST' && path === ':commit') {
      const { writes } = JSON.parse(options.body), keys = writes.map(write => write.update.name.slice(DOCS.length));
      for (const [index, write] of writes.entries()) {
        const current = docs.get(keys[index]);
        if (write.currentDocument?.exists === false && current) return error('ALREADY_EXISTS', 409);
        if (write.currentDocument?.updateTime && current?.updateTime !== write.currentDocument.updateTime) return error('FAILED_PRECONDITION', 400);
      }
      const at = `2026-09-28T18:00:00.${String(++tick).padStart(6, '0')}Z`;
      for (const [index, write] of writes.entries()) docs.set(keys[index], { fields: { ...(docs.get(keys[index])?.fields || {}), ...write.update.fields }, updateTime: at });
      return Response.json({ writeResults: writes.map(() => ({ updateTime: at })), commitTime: at });
    }
    const key = path.slice(1), doc = docs.get(key);
    return doc ? Response.json({ name: DOCS + key, fields: doc.fields, updateTime: doc.updateTime }) : Response.json({ error: { code: 404, status: 'NOT_FOUND', message: `Document "${DOCS}${key}" not found.` } }, { status: 404 });
  }
  return { docs, posts, fetcher, get: key => docs.has(key) ? decodeFirestoreFields(docs.get(key).fields) : null, count: prefix => [...docs.keys()].filter(key => key.startsWith(prefix)).length };
}

// The screen mounted in a vm DOM. hubFetch reaches the real handler; `tamper` may rewrite a GET body, `lose`
// may drop a POST response after the server applied it and `hold` keeps each POST in flight until release().
// `unlocked` removes the edit lock, standing in for an edit that lands while a save is unanswered: the answer must
// still settle only what was sent.
const LOCK = 'const locked=()=>S.busy||Boolean(S.retry||pendingBody());';
function screen({ now = NOW, who = OWNER, env = ENV, fs = firestore(), tamper, lose = 0, fail, hold = false, unlocked = false } = {}) {
  const clock = { now }, cache = new Map(), document = createDocument(), events = {}, session = storage({ egc_u: who.user });
  const handler = catalogHandlers({ session: async () => who, storage: e => catalogStorage(e, fs.fetcher), now: () => new Date(clock.now), cache });
  let lost = 0;
  const held = [];
  async function hubFetch(url, init = {}) {
    if (fail) { const answer = fail(url, init); if (answer) return answer; }
    const method = init.method || 'GET', request = new Request(ORIGIN + url, { method, headers: { ...(init.headers || {}), Origin: ORIGIN }, body: init.body });
    if (method === 'POST' && hold) await new Promise(resolve => held.push(resolve));
    if (method === 'POST') fs.posts.push(init.body);
    const response = method === 'POST' ? await handler.post({ request, env }) : await handler.get({ request, env });
    if (method === 'POST' && lost < lose) { lost++; throw new TypeError('Failed to fetch'); }
    if (method === 'GET' && tamper) { const body = await response.json(); tamper(body); return Response.json(body, { status: response.status }); }
    return response;
  }
  const context = { console, Intl, URL, Promise, AbortController, crypto, setTimeout, clearTimeout, queueMicrotask, Blob: globalThis.Blob, document, Node: document.Node, sessionStorage: session,
    location: { href: ORIGIN + '/employee.html' }, addEventListener(name, listener) { (events[name] ||= []).push(listener); }, removeEventListener() {} };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(KIT, context, { filename: 'employee-ui-kit.js' });
  assert.ok(!unlocked || SOURCE.includes(LOCK), 'the edit lock this fixture removes');
  vm.runInContext(unlocked ? SOURCE.replace(LOCK, 'const locked=()=>false;') : SOURCE, context, { filename: 'employee-catalog.js' });
  const host = document.createElement('main');
  document.body.append(host);
  const went = [];
  context.EGCCatalog.mount(host, { identity: who.user, hubFetch, now: () => Date.parse(clock.now), go: view => went.push(view) });
  const root = () => host.querySelector('.egc-catalog');
  // Fast rounds first, then short timer waits so thread-pool work (the handler's SHA-256) can finish on a loaded machine.
  const settle = async (check, what) => { for (let round = 0; round < 1400; round++) { if (check()) return; await new Promise(resolve => round < 400 ? setImmediate(resolve) : setTimeout(resolve, 5)); } assert.fail(`timed out waiting for ${what}`); };
  const buttons = (scope = document.body) => scope.querySelectorAll('button');
  const button = (label, scope = document.body) => { const found = buttons(scope).filter(node => node.textContent === label); assert.ok(found.length, `no button "${label}"`); return found[0]; };
  const control = (label, scope = document.body) => { const field = scope.querySelectorAll('label').find(node => node.querySelector('span')?.textContent === label); assert.ok(field, `no field "${label}"`); return field.querySelector('input,select,textarea'); };
  const fill = (label, value, scope) => { const node = control(label, scope); if (node.type === 'checkbox') { node.checked = value; node.dispatchEvent({ type: 'change' }); } else { node.value = value; node.dispatchEvent({ type: node.tagName === 'SELECT' ? 'change' : 'input' }); } };
  const dialog = () => document.body.querySelector('dialog');
  const loaded = () => settle(() => root()?.querySelector('.cat-tabs') && !root().textContent.includes('Loading…'), 'the catalog');
  const row = id => root().querySelector(`tr[data-item="${id}"]`);
  const signout = () => (events['egc:signout'] || []).forEach(listener => listener({ type: 'egc:signout' }));
  const release = () => held.splice(0).forEach(resolve => resolve());
  return { context, document, host, root, fs, clock, session, settle, button, buttons, control, fill, dialog, loaded, row, went, signout, held, release, api: context.EGCCatalog };
}
// A control is off when the page disabled it (property in a browser, attribute when the kit set it on this DOM).
const off = node => node.disabled === true || node.hasAttribute('disabled');
const draftOf = ui => JSON.parse(ui.session.getItem('egc.hub.draft.v1.catalog.zacb') || 'null');
// "Another tab": the owner saves settings or publishes a version outside the screen under test, through the real store.
async function otherSettingsSave(fs, change) {
  const current = fs.get('pricingSettings/current'), revision = fs.docs.get('pricingSettings/current')?.updateTime ?? null;
  const settings = { ...copy(current?.settings || seedPricingSettings()), ...change };
  return mutateCatalog(catalogStorage(ENV, fs.fetcher), OWNER, { action: 'settings.update', requestId: crypto.randomUUID(), expectedRevision: revision, settings }, NOW);
}
async function otherPublish(fs, version, change) {
  const pointer = fs.get('catalogVersions/current'), base = pointer ? JSON.parse(fs.get(`catalogVersions/${pointer.version}`).catalogJson) : copy(seedCatalog());
  const catalog = { ...copy(base), catalogVersion: version, generatedOn: version.slice(0, 10) };
  catalog.items.forEach(change);
  return mutateCatalog(catalogStorage(ENV, fs.fetcher), OWNER, { action: 'catalog.publish', requestId: crypto.randomUUID(), basedOnVersion: pointer?.version ?? base.catalogVersion, catalog }, NOW);
}
const search = async (ui, text) => { ui.fill('Search', text, ui.root()); };

test('nextVersion is the next release of the Denver day, never earlier than the published version', () => {
  assert.equal(M.nextVersion('2026-09-27.1', '2026-09-28'), '2026-09-28.1');
  assert.equal(M.nextVersion('2026-09-27.1', '2026-09-27'), '2026-09-27.2');
  assert.equal(M.nextVersion('2026-09-27.9', '2026-09-26'), '2026-09-27.10', 'a day behind the published version still publishes later');
  assert.equal(M.nextVersion('2026-09-27.999', '2026-09-27'), null);
  assert.equal(M.nextVersion('seed', '2026-09-27'), null);
  assert.equal(M.nextVersion('2026-09-27.1', '2026-02-30'), null);
  assert.equal(M.denverDay(Date.parse(NOW)), TODAY, '05:30 UTC is still the previous day in Denver');
});

test('the Stale badge is the server flag for a published price; a draft re-check is judged by its own date', () => {
  const item = verified.find(entry => entry.kind === 'product');
  const at = (days, flag) => copy(M.priceStatus(item, item, { stale: flag }, new Date(Date.parse(`${LAST_CHECK}T12:00:00Z`) + days * 86400000).toISOString().slice(0, 10)));
  assert.deepEqual(at(91, true), { state: 'stale', age: 91, draft: false });
  assert.deepEqual(at(91, false), { state: 'verified', age: 91, draft: false }, 'the server, not the device clock, decides staleness');
  assert.deepEqual(at(4, true), { state: 'stale', age: 4, draft: false });
  const never = unverifiedProducts[0];
  assert.deepEqual(copy(M.priceStatus(never, never, { stale: true }, TODAY)), { state: 'unverified', age: null, draft: false });
  const rechecked = M.verifyItem(never, verifyInput(), TODAY).item;
  assert.deepEqual(copy(M.priceStatus(rechecked, never, { stale: true }, TODAY)), { state: 'verified', age: 0, draft: true });
  const added = { ...copy(item), id: 'synthetic-new' };
  assert.deepEqual(copy(M.priceStatus(added, null, null, '2027-06-01')), { state: 'verified', age: M.dayCount(LAST_CHECK, '2027-06-01'), draft: true });
});

test('filters cover tier, brand, dimensions, price range, category and price status', () => {
  const rows = shipped.items.map(item => ({ item, draft: false, status: { state: item.priceVerified ? 'verified' : 'unverified' } }));
  const pick = filters => rows.filter(row => M.matchesFilters(row, filters)).map(row => row.item.id);
  const everbilt = pick({ q: 'everbilt' });
  assert.ok(everbilt.length && everbilt.every(id => shipped.items.find(item => item.id === id).brand === 'Everbilt'));
  const sized = shipped.items.find(item => item.kind === 'product' && /\d+\s*x\s*\d+/i.test(item.dimensions || ''));
  assert.ok(pick({ q: sized.dimensions.split(/\s+/).slice(0, 3).join(' ') }).includes(sized.id), 'dimensions are searchable');
  const best = pick({ tier: 'best' });
  assert.ok(best.length && best.every(id => shipped.items.find(item => item.id === id).tier === 'best'));
  const band = pick({ min: 10000, max: 20000 });
  assert.ok(band.length && band.every(id => { const item = shipped.items.find(entry => entry.id === id), [low, high] = item.kind === 'service' ? [item.fixedPriceCents, item.fixedPriceCents] : [item.retailPriceLowCents, item.retailPriceHighCents]; return high >= 10000 && low <= 20000; }));
  assert.equal(pick({ status: 'unverified' }).length, shipped.items.length - verified.length);
  assert.equal(pick({ status: 'attention' }).length, shipped.items.length - verified.length);
  assert.deepEqual(pick({ category: 'services' }), shipped.items.filter(item => item.category === 'services').map(item => item.id));
  assert.equal(pick({ q: 'everbilt zzzz-no-such-word' }).length, 0, 'every word must match');
});

test('verifyItem records a store source the server accepts, and refuses what the server would refuse', () => {
  const item = unverifiedProducts[0];
  const { item: next, errors } = M.verifyItem(item, verifyInput({ high: '59.00', note: 'Synthetic note' }), TODAY);
  assert.equal(errors, undefined);
  assert.deepEqual(copy({ ...next, sources: next.sources.at(-1) }), { ...copy(item), retailPriceLowCents: 4998, retailPriceHighCents: 5900, priceVerified: true, priceVerifiedAt: TODAY, priceEvidence: 'product_page', verificationNote: 'Synthetic note',
    sources: { url: 'https://synthetic.example.com/p/1', retailer: 'Synthetic Hardware', observedPrice: '$49.98 to $59.00 on the product page (checked in the Hub)', checkedOn: TODAY },
    auditActions: [...item.auditActions, `price verified in the Hub on ${TODAY} from Synthetic Hardware`] });
  assert.doesNotThrow(() => publishable(withItem(next)));
  const again = M.verifyItem(next, verifyInput({ low: '51.00', checkedOn: TODAY }), TODAY).item;
  assert.equal(again.sources.filter(source => source.url === 'https://synthetic.example.com/p/1').length, 1, 'the same link replaces its earlier check');
  const full = { ...copy(item), sources: Array.from({ length: 12 }, (_, index) => ({ url: `https://synthetic.example.com/old/${index}`, retailer: 'Synthetic Old', observedPrice: 'price not observed', checkedOn: `2026-09-${String(10 + index).padStart(2, '0')}` })) };
  const capped = M.verifyItem(full, verifyInput(), TODAY).item;
  assert.equal(capped.sources.length, 12);
  assert.ok(!capped.sources.some(source => source.url.endsWith('/old/0')), 'the oldest check makes room');
  assert.doesNotThrow(() => publishable(withItem(capped)));
  const refused = [
    [{ url: 'http://synthetic.example.com/p/1' }, 'url'], [{ url: 'https://synthetic.example.com/p/1.jpg' }, 'url'], [{ url: 'https://user:pw@synthetic.example.com/p' }, 'url'],
    [{ retailer: '' }, 'retailer'], [{ low: '0' }, 'low'], [{ low: '-5' }, 'low'], [{ low: '12.345' }, 'low'], [{ low: '20', high: '19.99' }, 'high'],
    [{ evidence: 'estimate' }, 'evidence'], [{ checkedOn: '2026-09-28' }, 'checkedOn'], [{ checkedOn: '2026-02-30' }, 'checkedOn'],
  ];
  for (const [change, field] of refused) assert.ok(M.verifyItem(item, verifyInput(change), TODAY).errors?.[field], JSON.stringify(change));
  const service = shipped.items.find(entry => entry.kind === 'service');
  const confirmed = M.verifyItem(service, { checkedOn: TODAY, note: '' }, TODAY).item;
  assert.equal(confirmed.priceVerifiedAt, TODAY);
  assert.equal(confirmed.fixedPriceCents, service.fixedPriceCents, 'confirming an EGC service never changes its price');
  assert.doesNotThrow(() => publishable(withItem(confirmed)));
});

test('editItem turns a typed price into an owner estimate and keeps the rules the server enforces', () => {
  const item = verified.find(entry => entry.kind === 'product' && entry.availability === 'active' && !entry.installRequirements.includes('two-person-lift'));
  const base = { name: item.name, low: (item.retailPriceLowCents / 100).toFixed(2), high: (item.retailPriceHighCents / 100).toFixed(2), verificationNote: item.verificationNote || '', verificationNoteBefore: item.verificationNote || '' };
  const renamed = M.editItem(item, { ...base, name: 'Synthetic renamed item' }, TODAY).item;
  assert.equal(renamed.priceVerified, true, 'a detail edit keeps the verified price');
  const repriced = M.editItem(item, { ...base, low: '99.00', high: '' }, TODAY).item;
  assert.deepEqual(copy([repriced.retailPriceLowCents, repriced.retailPriceHighCents, repriced.priceVerified, repriced.priceVerifiedAt, repriced.priceEvidence]), [9900, 9900, false, null, 'estimate']);
  assert.match(repriced.verificationNote, /^Owner estimate entered in the Hub on 2026-09-27/);
  assert.doesNotThrow(() => publishable(withItem(repriced)));
  const explained = M.editItem(item, { ...base, low: '99.00', high: '', verificationNote: 'Synthetic quote from a supplier call' }, TODAY).item;
  assert.equal(explained.verificationNote, 'Synthetic quote from a supplier call');
  const unverified = unverifiedProducts[0];
  assert.ok(M.editItem(unverified, { verificationNote: '' }, TODAY).errors.verificationNote, 'an unverified price needs its note');
  const referral = M.editItem(item, { availability: 'referral_only' }, TODAY).item;
  assert.deepEqual([referral.installMinutes, referral.haulAwayApplicable], [0, false]);
  const heavy = shipped.items.find(entry => entry.kind === 'product' && entry.installRequirements.includes('two-person-lift'));
  assert.ok(M.editItem(heavy, { crewSize: '1' }, TODAY).errors.crewSize);
  const overhead = shipped.items.find(entry => entry.kind === 'product' && entry.installRequirements.includes('ceiling-joists'));
  assert.ok(M.editItem(overhead, { safetyNotes: 'Short but longer than forty characters of safety text.' }, TODAY).errors.safetyNotes);
  assert.ok(M.editItem(item, { priceUnit: 'each (estimate)' }, TODAY).errors.priceUnit);
  for (const next of [renamed, referral]) assert.doesNotThrow(() => publishable(withItem(next)));
});

test('newProduct builds a full product the server accepts and a draft recomputes need coverage', () => {
  const need = shipped.needs.find(entry => entry.id === 'bike-horizontal-wall');
  assert.equal(need.coverage, 'limited', 'fixture: a need with two active options across good and better');
  const input = { name: 'Synthetic Horizontal Bike Rack', category: 'bikes', subcategory: 'horizontal wall racks', needs: [need.id], zones: ['walls', 'bikes'], brand: 'Synthetic Brand', model: '', genericSpec: 'A synthetic steel horizontal bike rack.', dimensions: '24 x 8 in', weightCapacity: '', requires: '',
    installRequirements: ['wall-studs'], tier: 'best', availability: 'active', priceUnit: 'each', installMinutes: '30', crewSize: '1', haulAwayApplicable: false, low: '129.00', high: '', bestFor: 'Synthetic testing only',
    safetyNotes: 'Lag both brackets into the center of a wall stud; never mount into drywall alone.', installNotes: '', retailer: 'Synthetic Store', url: 'https://store.example.com/p/rack', evidence: 'search_snippet', checkedOn: TODAY, verificationNote: '' };
  const { item } = M.newProduct(input, shipped, TODAY);
  assert.equal(item.id, 'synthetic-horizontal-bike-rack');
  assert.deepEqual(copy([item.priceVerified, item.priceVerifiedAt, item.priceEvidence, item.retailPriceHighCents, item.auditStatus]), [true, TODAY, 'search_snippet', 12900, 'self_reviewed_no_findings']);
  const built = M.draftCatalog(shipped, { items: { [item.id]: item }, added: [item.id] }, TODAY);
  assert.equal(built.version, '2026-09-27.2');
  assert.deepEqual(copy(built.coverage), [{ id: need.id, label: need.label, before: 'limited', after: 'full' }]);
  assert.equal(built.catalog.needs.find(entry => entry.id === need.id).coverageNote, null);
  assert.equal(built.catalog.auditLog.publishedItems, shipped.items.length + 1);
  assert.doesNotThrow(() => validateCatalog(built.catalog), 'the server accepts the recomputed coverage and item count');
  assert.equal(shipped.needs.find(entry => entry.id === need.id).coverage, 'limited', 'the published base is never mutated');
  assert.ok(M.newProduct({ ...input, retailer: '', url: '' }, shipped, TODAY).errors.verificationNote, 'an estimate needs a note');
  const estimate = M.newProduct({ ...input, retailer: '', url: '', verificationNote: 'Synthetic estimate from a catalog page' }, shipped, TODAY).item;
  assert.deepEqual(copy([estimate.priceVerified, estimate.priceEvidence]), [false, 'estimate']);
  assert.doesNotThrow(() => validateCatalog(M.draftCatalog(shipped, { items: { [estimate.id]: estimate }, added: [estimate.id] }, TODAY).catalog));
  const removed = shipped.auditLog.removedItems[0].id;
  assert.notEqual(M.uniqueId(removed, shipped), removed, 'a removed item id is never reused');
  assert.equal(M.uniqueId(shipped.items[0].id, shipped), `${shipped.items[0].id}-2`);
  const errors = M.newProduct({ ...input, category: 'services', needs: ['no-such-need'], zones: [], safetyNotes: 'short' }, shipped, TODAY).errors;
  for (const field of ['category', 'needs', 'zones', 'safetyNotes']) assert.ok(errors[field], field);
});

test('catalogDiff lists new items and only the fields and list entries that changed', () => {
  const item = unverifiedProducts[0], next = M.verifyItem(item, verifyInput(), TODAY).item;
  const built = M.draftCatalog(shipped, { items: { [item.id]: next }, added: [] }, TODAY), diff = copy(M.catalogDiff(shipped, built.catalog));
  assert.deepEqual([diff.from, diff.to, diff.added], ['2026-09-27.1', '2026-09-27.2', []]);
  const fields = Object.fromEntries(diff.changed[0].fields.map(entry => [entry.field, entry]));
  assert.deepEqual(Object.keys(fields).sort(), ['auditActions', 'priceEvidence', 'priceVerified', 'priceVerifiedAt', 'retailPriceHighCents', 'retailPriceLowCents', 'sources', 'verificationNote'].filter(key => !same(item[key], next[key])).sort());
  assert.deepEqual(fields.sources.before, []);
  assert.equal(fields.sources.after.length, 1, 'unchanged sources are not repeated');
  assert.deepEqual(fields.auditActions.after, [`price verified in the Hub on ${TODAY} from Synthetic Hardware`]);
  assert.equal(M.formatValue('retailPriceLowCents', 4998), '$49.98');
  assert.equal(M.formatValue('priceVerifiedAt', TODAY), 'Sep 27, 2026');
  assert.equal(M.formatValue('verificationNote', null), '—');
});
function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

test('a price check cannot be dated before the latest recorded check, so the verified date matches the price in force', () => {
  const item = { ...copy(unverifiedProducts[0]), sources: [{ url: 'https://synthetic.example.com/p/old', retailer: 'Synthetic Old', observedPrice: '$20.00 (search snippet)', checkedOn: '2026-09-20' }, { url: 'https://synthetic.example.com/p/note', retailer: 'Synthetic Note', observedPrice: 'price not shown', checkedOn: '2026-09-24' }] };
  assert.equal(M.verifyItem(item, verifyInput({ checkedOn: '2026-09-19' }), TODAY).errors.checkedOn, 'Your check must be on or after Sep 20, 2026, the latest recorded price check.');
  for (const checkedOn of ['2026-09-20', '2026-09-22']) {
    const next = M.verifyItem(item, verifyInput({ checkedOn }), TODAY).item;
    assert.deepEqual([next.priceVerifiedAt, next.retailPriceLowCents], [checkedOn, 4998], 'the verified date is the check that saw the price');
    assert.doesNotThrow(() => publishable(withItem(next)));
  }
  const rechecked = M.verifyItem(M.verifyItem(item, verifyInput({ checkedOn: '2026-09-25' }), TODAY).item, verifyInput({ url: 'https://synthetic.example.com/p/2', checkedOn: '2026-09-23' }), TODAY);
  assert.match(rechecked.errors.checkedOn, /on or after Sep 25, 2026/, 'a check recorded in this draft counts too');
  const service = { ...copy(shipped.items.find(entry => entry.kind === 'service')), sources: shipped.items.find(entry => entry.kind === 'service').sources.map(source => ({ ...source, checkedOn: '2026-09-21' })), priceVerifiedAt: '2026-09-21' };
  assert.ok(M.verifyItem(service, { checkedOn: '2026-09-20', note: '' }, TODAY).errors.checkedOn);
  assert.equal(M.verifyItem(service, { checkedOn: '2026-09-21', note: '' }, TODAY).item.priceVerifiedAt, '2026-09-21');
});

test('rebaseSettingsForm keeps the fields the owner changed and takes every other field from the latest save', () => {
  const before = copy(defaults), latest = { ...copy(defaults), settingsVersion: 'synthetic-other-tab', depositPct: 25, markupPct: { ...copy(defaults.markupPct), default: 30 } };
  const form = { ...M.settingsForm(before, 'owner-2026-09-27-2330'), laborRateCents: '80', 'markup.default': '25' };
  const next = copy(M.rebaseSettingsForm(form, before, latest, 'owner-2026-09-27-2331'));
  assert.deepEqual([next.laborRateCents, next.depositPct, next['markup.default'], next.settingsVersion], ['80', '25', '25', 'owner-2026-09-27-2330'], 'owner edits stay, the other save shows, and both-changed keeps the owner value');
  assert.equal(M.rebaseSettingsForm({ ...form, settingsVersion: 'synthetic-other-tab' }, before, latest, 'owner-2026-09-27-2331').settingsVersion, 'owner-2026-09-27-2331', 'a label the other save used is replaced');
  const rows = copy(M.settingsChanges(latest, M.parseSettings(next, latest).settings)).map(row => row.label);
  assert.deepEqual(rows, ['Labor rate per technician-hour', 'Default markup', 'Version label'], 'the review lists only the owner edits, not "Deposit 25% → 50%"');
  // After a save: a form that still produces what was sent resets; later edits move onto the saved values.
  const sent = M.parseSettings(form, before).settings, saved = { ...copy(sent), depositPct: sent.depositPct };
  assert.equal(M.settingsAfterSave(form, before, sent, saved, 'owner-next'), null);
  const kept = copy(M.settingsAfterSave({ ...form, depositPct: '40' }, before, sent, saved, 'owner-next'));
  assert.deepEqual([kept.depositPct, kept.laborRateCents, kept.settingsVersion], ['40', '80.00', 'owner-next'], 'the later deposit edit stays, the sent rate shows as saved, and the saved label is not reused');
  assert.deepEqual(copy(M.settingsChanges(saved, M.parseSettings(kept, saved).settings)).map(row => row.label), ['Deposit', 'Version label']);
  // Later edits are measured against what was sent: putting the sent labor rate back is an edit, not "unchanged".
  const reverted = copy(M.settingsAfterSave({ ...form, laborRateCents: '75.00' }, before, sent, saved, 'owner-next'));
  assert.deepEqual([reverted.laborRateCents, reverted['markup.default']], ['75.00', '25']);
  assert.deepEqual(copy(M.settingsChanges(saved, M.parseSettings(reverted, saved).settings)).map(row => row.label), ['Labor rate per technician-hour', 'Version label']);
});

test('a draft moves onto a newer version field by field, and a price moves with its sources and dates', () => {
  const item = unverifiedProducts[0], mine = copy(M.verifyItem(item, verifyInput(), TODAY).item);
  const draft = { baseVersion: '2026-09-27.1', items: { [item.id]: mine }, bases: { [item.id]: copy(item) }, added: [], rebasedFrom: null };
  const renamed = { ...copy(item), name: 'Synthetic name from another tab', safetyNotes: item.safetyNotes + ' Synthetic extra safety sentence.', auditActions: [...item.auditActions, 'renamed in another tab'] };
  const latest = { ...withItem(renamed), catalogVersion: '2026-09-27.2', generatedOn: TODAY };
  const next = copy(M.rebaseDraft(draft, latest, '2026-09-27.2')), moved = next.items[item.id];
  assert.deepEqual([moved.name, moved.safetyNotes], [renamed.name, renamed.safetyNotes], 'fields only the other publish changed keep its values');
  for (const key of ['retailPriceLowCents', 'retailPriceHighCents', 'priceVerified', 'priceVerifiedAt', 'priceEvidence', 'verificationNote', 'sources']) assert.deepEqual(moved[key], mine[key], key);
  assert.deepEqual(moved.auditActions, [...item.auditActions, 'renamed in another tab', `price verified in the Hub on ${TODAY} from Synthetic Hardware`]);
  assert.deepEqual([next.baseVersion, next.rebasedFrom, next.bases[item.id]], ['2026-09-27.2', '2026-09-27.1', renamed]);
  const built = M.draftCatalog(latest, next, TODAY);
  assert.doesNotThrow(() => validateCatalog(built.catalog));
  assert.ok(!M.catalogDiff(latest, built.catalog).changed[0].fields.some(entry => ['name', 'safetyNotes'].includes(entry.field)), 'the review never undoes the other publish');
  // Both checked the price: the draft's whole price group wins, so the verified date always matches its sources.
  const theirs = M.verifyItem(item, verifyInput({ url: 'https://synthetic.example.com/p/other', retailer: 'Synthetic Other', low: '60.00' }), TODAY).item;
  const both = copy(M.rebaseDraft(draft, { ...withItem(theirs), catalogVersion: '2026-09-27.2', generatedOn: TODAY }, '2026-09-27.2')).items[item.id];
  assert.deepEqual([both.sources, both.retailPriceLowCents, both.priceVerifiedAt], [mine.sources, 4998, TODAY]);
  assert.doesNotThrow(() => publishable(withItem(both)));
  // A draft whose changes the latest version already has is empty.
  assert.deepEqual(copy(M.rebaseDraft(draft, { ...withItem(mine), catalogVersion: '2026-09-27.2', generatedOn: TODAY }, '2026-09-27.2')), { baseVersion: null, items: {}, bases: {}, added: [], rebasedFrom: null });
});

test('after a publish the draft keeps exactly what the request did not carry', () => {
  const [a, b] = unverifiedProducts, sentA = copy(M.verifyItem(a, verifyInput(), TODAY).item);
  const draft = { baseVersion: '2026-09-27.1', items: { [a.id]: sentA }, bases: { [a.id]: copy(a) }, added: [], rebasedFrom: null };
  const built = M.draftCatalog(shipped, draft, TODAY);
  assert.deepEqual(copy(M.publishedDraft(draft, built.catalog, built.version)), { baseVersion: null, items: {}, bases: {}, added: [], rebasedFrom: null });
  // Edits that landed while the publish was in flight: a renamed again, b verified.
  const laterA = copy(M.editItem(sentA, { name: 'Synthetic later name' }, TODAY).item), laterB = copy(M.verifyItem(b, verifyInput({ low: '20.00' }), TODAY).item);
  const during = { ...copy(draft), items: { [a.id]: laterA, [b.id]: laterB }, bases: { [a.id]: copy(a), [b.id]: copy(b) } };
  const left = copy(M.publishedDraft(during, built.catalog, built.version));
  assert.deepEqual(Object.keys(left.items).sort(), [a.id, b.id].sort());
  assert.deepEqual([left.bases[a.id], left.bases[b.id], left.baseVersion], [copy(sentA), copy(b), built.version], 'the published copy is the base of what stays');
  const again = M.draftCatalog(built.catalog, M.rebaseDraft(left, built.catalog, built.version), TODAY), diff = copy(M.catalogDiff(built.catalog, again.catalog));
  assert.deepEqual(diff.changed.map(entry => [entry.id, entry.fields.map(field => field.field).includes('name')]).sort(), [[a.id, true], [b.id, false]].sort());
  assert.deepEqual(diff.changed.find(entry => entry.id === a.id).fields.map(field => field.field), ['name'], 'only the later rename is left to publish for a');
  // A product added before the send is published; one added after it is still new.
  const added = { ...copy(sentA), id: 'synthetic-added-later', name: 'Synthetic added later' };
  const withAdded = M.publishedDraft({ ...copy(during), items: { ...during.items, [added.id]: added }, bases: { ...during.bases, [added.id]: null }, added: [added.id] }, built.catalog, built.version);
  assert.deepEqual(copy(withAdded.added), [added.id]);
});

test('pricing settings build the document the server validates and agree with it on every range', () => {
  const form = M.settingsForm(defaults, 'owner-2026-09-27-2330');
  assert.deepEqual(copy(form).laborRateCents, '75.00');
  Object.assign(form, { laborRateCents: '$80', 'markup.overhead': '35', 'markup.bikes': '', ready: true });
  const { settings, errors } = M.parseSettings(form, defaults);
  assert.deepEqual(copy(errors), {});
  assert.doesNotThrow(() => validatePricingSettings(settings));
  assert.deepEqual(copy([settings.laborRateCents, settings.markupPct.byCategory.overhead, settings.mustSetBeforeCustomerUse, settings.settingsVersion]), [8000, 35, false, 'owner-2026-09-27-2330']);
  assert.equal(Object.hasOwn(settings.markupPct.byCategory, 'bikes'), false, 'a blank category falls back to the default markup');
  assert.deepEqual(Object.keys(settings.comments).filter(key => ['laborRateCents', 'markupPct', 'mustSetBeforeCustomerUse'].includes(key)), [], 'comments that described a changed value are dropped');
  assert.equal(settings.comments.minimumJobCents, defaults.comments.minimumJobCents, 'the rest are kept');
  const rows = copy(M.settingsChanges(defaults, settings, { overhead: 'Overhead storage' }));
  assert.deepEqual(rows.map(row => row.label), ['Labor rate per technician-hour', 'Markup: bikes', 'Markup: Overhead storage', 'Ready for customer quotes', 'Version label']);
  assert.deepEqual(rows[0], { label: 'Labor rate per technician-hour', before: '$75.00', after: '$80.00' });
  // [form key, text, server field path, server value]: the client refuses exactly what validatePricingSettings refuses.
  const cases = [
    ['laborRateCents', '0.01', 'laborRateCents', 1], ['laborRateCents', '0', 'laborRateCents', 0], ['laborRateCents', '1000', 'laborRateCents', 100000], ['laborRateCents', '1000.01', 'laborRateCents', 100001],
    ['minimumJobCents', '0', 'minimumJobCents', 0], ['minimumJobCents', '100000', 'minimumJobCents', 10000000], ['minimumJobCents', '100000.01', 'minimumJobCents', 10000001],
    ['disposalCentsPerItem', '1000', 'disposalCentsPerItem', 100000], ['disposalCentsPerItem', '1000.01', 'disposalCentsPerItem', 100001],
    ['depositPct', '100', 'depositPct', 100], ['depositPct', '100.01', 'depositPct', 100.01], ['depositPct', '0', 'depositPct', 0],
    ['markup.default', '500', 'markupPct.default', 500], ['markup.default', '500.01', 'markupPct.default', 500.01], ['markup.default', '12.345', 'markupPct.default', 12.345],
    ['markup.shelving', '0', 'markupPct.byCategory.shelving', 0], ['markup.shelving', '501', 'markupPct.byCategory.shelving', 501],
  ];
  for (const [key, text, path, value] of cases) {
    const client = !M.parseSettings({ ...M.settingsForm(defaults, 'owner-range-check'), [key]: text }, defaults).errors[key];
    const doc = { ...copy(defaults), settingsVersion: 'owner-range-check' }, parts = path.split('.');
    parts.slice(0, -1).reduce((node, part) => node[part], doc)[parts.at(-1)] = value;
    let server = true; try { validatePricingSettings(doc); } catch { server = false; }
    assert.equal(client, server, `${key}=${text}: client ${client ? 'accepts' : 'refuses'} but the server ${server ? 'accepts' : 'refuses'}`);
  }
  for (const text of ['lots', '-1', '1,00.00', '$']) assert.ok(M.parseSettings({ ...M.settingsForm(defaults, 'x1'), laborRateCents: text }, defaults).errors.laborRateCents, text);
  assert.ok(M.parseSettings(M.settingsForm(defaults), defaults).errors.settingsVersion, 'the saved label cannot be reused');
  assert.ok(M.parseSettings(M.settingsForm(defaults, '...'), defaults).errors.settingsVersion, 'a label needs a letter or digit');
  assert.ok(M.parseSettings(M.settingsForm(defaults, 'has space'), defaults).errors.settingsVersion);
});

test('the Stale badge in the item table follows the server flag, not the device clock', async () => {
  const product = verified.find(entry => entry.kind === 'product'), other = verified.find(entry => entry.kind === 'product' && entry.id !== product.id);
  // 91 Denver days after the last check: the server says stale; a server answer of not-stale is shown as verified.
  const late = screen({ now: '2026-12-27T19:00:00.000Z', tamper: body => { body.prices[product.id].stale = false; } });
  await late.loaded();
  assert.match(late.root().querySelector('.hub-head p').textContent, new RegExp(`${shipped.items.length - verified.length} unverified · ${verified.length - 1} stale \\(older than 90 days\\)`));
  late.button('Items', late.root()).click();
  await search(late, product.name);
  let cell = late.row(product.id).querySelector('[data-state]');
  assert.equal(cell.getAttribute('data-state'), 'verified');
  assert.match(cell.textContent, /^Verified.*91 days ago$/);
  await search(late, other.name);
  cell = late.row(other.id).querySelector('[data-state]');
  assert.equal(cell.getAttribute('data-state'), 'stale');
  assert.match(cell.textContent, /^Stale.*Checked Sep 27, 2026 · 91 days ago$/);
  // Four days after the check the server flag still wins when it says stale.
  const early = screen({ now: '2026-10-01T18:00:00.000Z', tamper: body => { body.prices[other.id].stale = true; } });
  await early.loaded();
  early.button('Items', early.root()).click();
  await search(early, other.name);
  cell = early.row(other.id).querySelector('[data-state]');
  assert.equal(cell.getAttribute('data-state'), 'stale');
  assert.match(cell.textContent, /4 days ago$/);
});

async function verifyFirstUnverified(ui, price = '49.98') {
  ui.button('Items', ui.root()).click();
  ui.button(`Needs a check (${shipped.items.length - verified.length})`, ui.root()).click();
  const first = ui.root().querySelector('.cat-table tbody tr'), id = first.getAttribute('data-item');
  ui.buttons(first).find(node => node.textContent === 'Verify price').click();
  const dialog = ui.dialog();
  assert.equal(ui.control('Checked on', dialog).value, TODAY, 'the Denver date');
  ui.fill('Store', 'Synthetic Hardware', dialog); ui.fill('Product page link', 'https://synthetic.example.com/p/1', dialog); ui.fill('Price seen ($)', price, dialog);
  ui.button('Save to draft', dialog).click();
  assert.equal(ui.dialog(), null);
  return id;
}

test('verify a price, review the diff and publish a new version through the real /api/catalog', async () => {
  const ui = screen();
  await ui.loaded();
  const id = await verifyFirstUnverified(ui);
  assert.ok(ui.session.getItem('egc.hub.draft.v1.catalog.zacb'), 'the draft is kept per viewer until published');
  ui.button('Draft (1)', ui.root()).click();
  ui.button('Review & publish', ui.root()).click();
  const dialog = ui.dialog();
  assert.equal(dialog.querySelector('h2').textContent, 'Publish version 2026-09-27.2');
  const verifiedRow = dialog.querySelectorAll('.cat-diff-row').find(node => node.querySelector('dt').textContent === 'Price verified');
  assert.deepEqual([verifiedRow.querySelector('del').textContent, verifiedRow.querySelector('ins').textContent], ['No', 'Yes']);
  ui.button('Publish version 2026-09-27.2', dialog).click();
  await ui.settle(() => ui.root().textContent.includes('Published catalog version 2026-09-27.2'), 'the publish');
  const post = JSON.parse(ui.fs.posts[0]);
  assert.deepEqual([post.action, post.basedOnVersion, post.catalog.catalogVersion, post.catalog.generatedOn], ['catalog.publish', '2026-09-27.1', '2026-09-27.2', TODAY]);
  assert.match(post.requestId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(ui.fs.get('catalogVersions/current').version, '2026-09-27.2');
  await ui.settle(() => ui.root().querySelector('.hub-head p')?.textContent.startsWith('Version 2026-09-27.2'), 'the reload');
  assert.match(ui.root().querySelector('.hub-head p').textContent, new RegExp(`${shipped.items.length - verified.length - 1} unverified · 0 stale`));
  assert.equal(ui.session.getItem('egc.hub.draft.v1.catalog.zacb'), null);
  const snapshot = JSON.parse(ui.fs.get('catalogVersions/2026-09-27.2').catalogJson);
  assert.equal(snapshot.items.find(item => item.id === id).priceVerifiedAt, TODAY);
});

test('a lost publish response is retried as the identical request and saved once', async () => {
  const ui = screen({ lose: 1 });
  await ui.loaded();
  const first = await verifyFirstUnverified(ui), second = unverifiedProducts.find(item => item.id !== first);
  ui.button('Draft (1)', ui.root()).click();
  ui.button('Review & publish', ui.root()).click();
  ui.button('Publish version 2026-09-27.2', ui.dialog()).click();
  await ui.settle(() => ui.root().querySelector('.cat-retry'), 'the retry notice');
  assert.match(ui.root().querySelector('.cat-retry').textContent, /^Not confirmed: Publish catalog version 2026-09-27\.2/);
  assert.equal(ui.fs.get('catalogVersions/current').version, '2026-09-27.2', 'the server applied it before the answer was lost');
  const pending = JSON.parse(ui.session.getItem('egc.hub.pending.v1.catalog.zacb'));
  assert.equal(pending.requestId, JSON.parse(ui.fs.posts[0]).requestId);
  // While the Retry waits, nothing can change what the saved request will settle.
  assert.match(ui.root().querySelector('.cat-retry').textContent, /Editing waits until you retry or discard it\./);
  ui.button('Items', ui.root()).click();
  await search(ui, second.name);
  const verify = ui.buttons(ui.row(second.id)).find(node => node.textContent === 'Verify price');
  assert.equal(off(verify), true);
  verify.click();
  assert.equal(ui.dialog(), null, 'a stray activation opens nothing');
  assert.equal(off(ui.button('Add product', ui.root())), true);
  ui.button('Pricing', ui.root()).click();
  assert.ok(ui.root().querySelectorAll('.cat-settings input, .cat-settings select').every(off), 'settings wait too');
  ui.button('Retry original request', ui.root()).click();
  await ui.settle(() => ui.root().textContent.includes('Published catalog version 2026-09-27.2'), 'the replay');
  assert.equal(ui.fs.posts.length, 2);
  assert.equal(ui.fs.posts[1], ui.fs.posts[0], 'byte-identical retry');
  assert.equal(ui.fs.count('catalogOperations/'), 1);
  assert.equal(ui.session.getItem('egc.hub.pending.v1.catalog.zacb'), null);
  assert.equal(draftOf(ui), null, 'the published check left the draft');
  // Editing resumes, and a check made now stays in the draft.
  await ui.settle(() => ui.root().querySelector('.hub-head p')?.textContent.startsWith('Version 2026-09-27.2'), 'the reload');
  await search(ui, second.name);
  const again = ui.buttons(ui.row(second.id)).find(node => node.textContent === 'Verify price');
  assert.equal(off(again), false);
  again.click();
  ui.fill('Store', 'Synthetic Hardware', ui.dialog()); ui.fill('Product page link', 'https://synthetic.example.com/p/2', ui.dialog()); ui.fill('Price seen ($)', '20.00', ui.dialog());
  ui.button('Save to draft', ui.dialog()).click();
  assert.deepEqual(Object.keys(draftOf(ui).items), [second.id]);
  assert.equal(draftOf(ui).baseVersion, '2026-09-27.2');
});

test('a publish in flight pauses every edit, and its answer clears only what it carried', async () => {
  const ui = screen({ hold: true });
  await ui.loaded();
  const first = await verifyFirstUnverified(ui);
  ui.button('Draft (1)', ui.root()).click();
  ui.button('Review & publish', ui.root()).click();
  ui.button('Publish version 2026-09-27.2', ui.dialog()).click();
  await ui.settle(() => ui.held.length === 1, 'the publish in flight');
  assert.match(ui.root().textContent, /Saving… keep this screen open until the Hub answers\./);
  assert.equal(ui.api.canLeave(), false);
  for (const label of ['Undo', 'Review & publish', 'Discard draft', 'Edit']) assert.equal(off(ui.button(label, ui.root())), true, label);
  ui.button('Undo', ui.root()).click();
  ui.button('Discard draft', ui.root()).click();
  assert.equal(ui.dialog(), null);
  assert.deepEqual(Object.keys(draftOf(ui).items), [first], 'the draft is untouched while the Hub has not answered');
  ui.button('Items', ui.root()).click();
  assert.equal(off(ui.button('Add product', ui.root())), true);
  const rowButtons = ui.buttons(ui.root().querySelector('.cat-table tbody')).filter(node => /^(Verify price|Confirm price|Edit)$/.test(node.textContent));
  assert.ok(rowButtons.length && rowButtons.every(off));
  rowButtons.find(node => node.textContent === 'Verify price').click();
  ui.button('Add product', ui.root()).click();
  assert.equal(ui.dialog(), null, 'no edit dialog opens');
  ui.button('Pricing', ui.root()).click();
  assert.ok(ui.root().querySelectorAll('.cat-settings input, .cat-settings select').every(off));
  assert.equal(off(ui.button('Undo my edits', ui.root())), true);
  ui.release();
  await ui.settle(() => ui.root().textContent.includes('Published catalog version 2026-09-27.2 with'), 'the publish');
  assert.doesNotMatch(ui.root().textContent, /unpublished change/);
  assert.equal(draftOf(ui), null);
  const snapshot = JSON.parse(ui.fs.get('catalogVersions/2026-09-27.2').catalogJson);
  assert.equal(snapshot.items.find(item => item.id === first).priceVerified, true);
  await ui.settle(() => ui.root().querySelector('.hub-head p')?.textContent.startsWith('Version 2026-09-27.2'), 'the reload');
  assert.ok(ui.buttons(ui.root().querySelector('.cat-table tbody')).filter(node => node.textContent === 'Verify price').every(node => !off(node)), 'editing resumes');
  assert.equal(ui.api.canLeave(), true);
});

test('an edit that lands while a publish is unanswered stays in the draft (held POST and lost answer + Retry)', async () => {
  for (const mode of ['held', 'lost']) {
    const ui = screen(mode === 'held' ? { hold: true, unlocked: true } : { lose: 1, unlocked: true });
    await ui.loaded();
    const first = await verifyFirstUnverified(ui), second = unverifiedProducts.find(item => item.id !== first);
    ui.button('Draft (1)', ui.root()).click();
    ui.button('Review & publish', ui.root()).click();
    ui.button('Publish version 2026-09-27.2', ui.dialog()).click();
    await ui.settle(() => mode === 'held' ? ui.held.length === 1 : ui.root().querySelector('.cat-retry'), 'the unanswered publish');
    ui.button('Items', ui.root()).click();
    await search(ui, second.name);
    ui.buttons(ui.row(second.id)).find(node => node.textContent === 'Verify price').click();
    ui.fill('Store', 'Synthetic Hardware', ui.dialog()); ui.fill('Product page link', 'https://synthetic.example.com/p/2', ui.dialog()); ui.fill('Price seen ($)', '20.00', ui.dialog());
    ui.button('Save to draft', ui.dialog()).click();
    if (mode === 'held') ui.release(); else ui.button('Retry original request', ui.root()).click();
    await ui.settle(() => ui.root().textContent.includes('Published catalog version 2026-09-27.2 with'), `the ${mode} publish`);
    assert.match(ui.root().textContent, /1 unpublished change stays in your draft\./, mode);
    assert.deepEqual(Object.keys(draftOf(ui).items), [second.id], mode);
    const published = JSON.parse(ui.fs.get('catalogVersions/2026-09-27.2').catalogJson).items;
    assert.deepEqual([published.find(item => item.id === first).priceVerified, published.find(item => item.id === second.id).priceVerified], [true, false], `${mode}: the later check was not in the request`);
    await ui.settle(() => ui.root().querySelector('.hub-head p')?.textContent.startsWith('Version 2026-09-27.2'), 'the reload');
    ui.button('Draft (1)', ui.root()).click();
    ui.button('Review & publish', ui.root()).click();
    assert.deepEqual(ui.dialog().querySelectorAll('.cat-diff-item h4').map(node => node.textContent), [second.name], `${mode}: only the later check is left to publish`);
  }
});

test('a settings edit that lands while a save is unanswered stays in the form (held POST and lost answer + Retry)', async () => {
  for (const mode of ['held', 'lost']) {
    const ui = screen(mode === 'held' ? { hold: true, unlocked: true } : { lose: 1, unlocked: true });
    await ui.loaded();
    ui.fill('Labor rate per technician-hour ($)', '80', ui.root());
    ui.button('Review changes', ui.root()).click();
    ui.button('Save settings', ui.dialog()).click();
    await ui.settle(() => mode === 'held' ? ui.held.length === 1 : ui.root().querySelector('.cat-retry'), 'the unanswered save');
    ui.fill('Deposit (% of the quote)', '40', ui.root());
    if (mode === 'held') ui.release(); else ui.button('Retry original request', ui.root()).click();
    await ui.settle(() => ui.root().textContent.includes('Pricing settings saved as owner-2026-09-27-2330'), `the ${mode} save`);
    assert.match(ui.root().textContent, /Your later edits are still in the form\./, mode);
    assert.equal(ui.fs.get('pricingSettings/current').settings.depositPct, 50, `${mode}: the later deposit was not in the request`);
    await ui.settle(() => ui.root().querySelector('.cat-settings'), 'the form');
    assert.deepEqual([ui.control('Deposit (% of the quote)', ui.root()).value, ui.control('Labor rate per technician-hour ($)', ui.root()).value], ['40', '80.00'], `${mode}: the later edit as typed, the sent rate as saved`);
    ui.button('Review changes', ui.root()).click();
    assert.deepEqual(ui.dialog().querySelectorAll('tbody th').map(node => node.textContent), ['Deposit', 'Version label'], `${mode}: the review compares with what was saved`);
    assert.equal(draftOf(ui).settings.form.depositPct, '40', `${mode}: the edit survives a reload`);
  }
});

test('a later settings edit moves onto the newer save that replaced the owner\'s, without re-proposing what was sent', async () => {
  // Another tab saves right after this screen's commit (putting the labor rate back and a 25% deposit), and the commit
  // answer carries no updateTime, so the handler reads back the other save and answers current:false.
  const fs = firestore(), real = fs.fetcher;
  let race = false;
  fs.fetcher = async (env, url, options = {}) => {
    const response = await real(env, url, options);
    if (!race || options.method !== 'POST' || !url.endsWith(':commit') || !JSON.parse(options.body).writes.some(write => write.update.name.endsWith('/pricingSettings/current'))) return response;
    race = false;
    await otherSettingsSave(fs, { settingsVersion: 'synthetic-other-tab', laborRateCents: 7500, depositPct: 25 });
    const body = await response.json();
    return Response.json({ ...body, writeResults: body.writeResults.map(() => ({})) });
  };
  const ui = screen({ fs, hold: true, unlocked: true });
  await ui.loaded();
  ui.fill('Labor rate per technician-hour ($)', '80', ui.root());
  ui.button('Review changes', ui.root()).click();
  ui.button('Save settings', ui.dialog()).click();
  await ui.settle(() => ui.held.length === 1, 'the save in flight');
  ui.fill('Minimum job ($)', '500', ui.root());
  race = true;
  ui.release();
  await ui.settle(() => ui.root().textContent.includes('Pricing settings saved as owner-2026-09-27-2330, for internal estimates only. A newer save replaced them since'), 'the replaced save');
  assert.equal(fs.get('pricingSettings/current').settingsVersion, 'synthetic-other-tab');
  await ui.settle(() => ui.root().textContent.includes('Fields you did not change now show the latest saved values'), 'the reload onto the newer save');
  const value = label => ui.control(label, ui.root()).value;
  assert.deepEqual([value('Labor rate per technician-hour ($)'), value('Deposit (% of the quote)'), value('Minimum job ($)')], ['75.00', '25', '500'], 'the newer save shows; only the later edit stays');
  assert.ok(!['owner-2026-09-27-2330', 'synthetic-other-tab'].includes(value('Version label for this save')), 'no used label is offered');
  ui.button('Review changes', ui.root()).click();
  assert.deepEqual(ui.dialog().querySelectorAll('tbody th').map(node => node.textContent), ['Minimum job', 'Version label']);
});

test('an unconfirmed settings save freezes the form until Retry, then shows what was saved', async () => {
  const ui = screen({ lose: 1 });
  await ui.loaded();
  ui.fill('Deposit (% of the quote)', '40', ui.root());
  ui.button('Review changes', ui.root()).click();
  ui.button('Save settings', ui.dialog()).click();
  await ui.settle(() => ui.root().querySelector('.cat-retry'), 'the retry notice');
  assert.equal(ui.fs.get('pricingSettings/current').settings.depositPct, 40, 'the server applied it before the answer was lost');
  const inputs = () => ui.root().querySelectorAll('.cat-settings input, .cat-settings select');
  assert.ok(inputs().every(off), 'the form waits for the Retry');
  for (const label of ['Review changes', 'Undo my edits']) assert.equal(off(ui.button(label, ui.root())), true, label);
  ui.button('Items', ui.root()).click();
  assert.equal(off(ui.button('Add product', ui.root())), true);
  ui.button('Pricing', ui.root()).click();
  ui.button('Retry original request', ui.root()).click();
  await ui.settle(() => ui.root().textContent.includes('Pricing settings saved as owner-2026-09-27-2330, for internal estimates only.'), 'the replay');
  assert.doesNotMatch(ui.root().textContent, /later edits/);
  assert.equal(ui.fs.posts[1], ui.fs.posts[0], 'byte-identical retry');
  assert.equal(ui.fs.count('pricingSettingsVersions/'), 1);
  await ui.settle(() => ui.root().querySelector('.cat-settings') && !inputs().some(off), 'the form to open again');
  assert.equal(ui.control('Deposit (% of the quote)', ui.root()).value, '40');
  assert.notEqual(ui.control('Version label for this save', ui.root()).value, 'owner-2026-09-27-2330', 'the next save needs a new label');
  assert.equal(draftOf(ui), null, 'nothing unsaved is left');
});

test('a settings conflict moves only the owner edits onto the other save', async () => {
  const ui = screen();
  await ui.loaded();
  // Another tab saves a 25% deposit after this form was built; the owner changes only the labor rate.
  await otherSettingsSave(ui.fs, { settingsVersion: 'synthetic-other-tab', depositPct: 25 });
  ui.fill('Labor rate per technician-hour ($)', '80', ui.root());
  ui.button('Review changes', ui.root()).click();
  ui.button('Save settings', ui.dialog()).click();
  await ui.settle(() => ui.root().textContent.includes('Pricing settings changed since you opened them. Your edits are kept'), 'the conflict');
  ui.button('Load latest settings', ui.root()).click();
  await ui.settle(() => ui.root().textContent.includes('Fields you did not change now show the latest saved values'), 'the rebase');
  assert.equal(ui.control('Deposit (% of the quote)', ui.root()).value, '25', 'the other save is shown, not undone');
  assert.equal(ui.control('Labor rate per technician-hour ($)', ui.root()).value, '80');
  ui.button('Review changes', ui.root()).click();
  assert.deepEqual(ui.dialog().querySelectorAll('tbody th').map(node => node.textContent), ['Labor rate per technician-hour', 'Version label']);
  ui.button('Save settings', ui.dialog()).click();
  await ui.settle(() => ui.root().textContent.includes('Pricing settings saved as owner-2026-09-27-2330'), 'the save');
  const saved = ui.fs.get('pricingSettings/current').settings;
  assert.deepEqual([saved.laborRateCents, saved.depositPct], [8000, 25]);
});

test('a catalog conflict moves the draft onto the other version without undoing its changes', async () => {
  const ui = screen();
  await ui.loaded();
  const id = await verifyFirstUnverified(ui, '12.00');
  await otherPublish(ui.fs, '2026-09-27.2', item => { if (item.id === id) { item.name = 'Synthetic name from another tab'; item.auditActions = [...item.auditActions, 'renamed in another tab']; } });
  ui.button('Draft (1)', ui.root()).click();
  ui.button('Review & publish', ui.root()).click();
  ui.button('Publish version 2026-09-27.2', ui.dialog()).click();
  await ui.settle(() => ui.root().textContent.includes('Another catalog version was published while you were editing'), 'the conflict');
  ui.button('Load latest catalog', ui.root()).click();
  await ui.settle(() => ui.root().querySelector('.hub-head p')?.textContent.startsWith('Version 2026-09-27.2'), 'the reload');
  assert.match(ui.root().querySelector('.cat-draft').textContent, /This draft started from version 2026-09-27\.1; version 2026-09-27\.2 is published now\. Your changes were moved onto 2026-09-27\.2/);
  ui.button('Review & publish', ui.root()).click();
  const fields = ui.dialog().querySelectorAll('.cat-diff-row dt').map(node => node.textContent);
  assert.ok(fields.includes('Low price') && fields.includes('Price verified'));
  assert.ok(!fields.includes('Name'), 'the other tab\'s rename is not undone');
  ui.button('Publish version 2026-09-27.3', ui.dialog()).click();
  await ui.settle(() => ui.root().textContent.includes('Published catalog version 2026-09-27.3'), 'the publish');
  const item = JSON.parse(ui.fs.get('catalogVersions/2026-09-27.3').catalogJson).items.find(entry => entry.id === id);
  assert.deepEqual([item.name, item.priceVerified, item.retailPriceLowCents], ['Synthetic name from another tab', true, 1200]);
  assert.deepEqual(item.auditActions.slice(-2), ['renamed in another tab', `price verified in the Hub on ${TODAY} from Synthetic Hardware`]);
});

test('settings are saved only after the diff review, with the revision edited and an explicit release', async () => {
  const ui = screen();
  await ui.loaded();
  const review = ui.button('Review changes', ui.root());
  assert.equal(review.disabled, true, 'nothing to review yet');
  ui.fill('Labor rate per technician-hour ($)', '80', ui.root());
  ui.fill('Reviewed: these values may price customer quotes', true, ui.root());
  assert.equal(review.disabled, false);
  assert.equal(ui.control('Labor rate per technician-hour ($)', ui.root()).getAttribute('inputmode'), 'decimal');
  review.click();
  const dialog = ui.dialog();
  ui.button('Save settings', dialog).click();
  assert.match(dialog.textContent, /Confirm the review to release these prices\./);
  assert.equal(ui.fs.posts.length, 0);
  ui.fill('I reviewed every value and these prices may be used for customer quotes', true, ui.dialog());
  ui.button('Save settings', ui.dialog()).click();
  await ui.settle(() => ui.root().textContent.includes('released for customer quotes.'), 'the save');
  const post = JSON.parse(ui.fs.posts[0]);
  assert.deepEqual([post.action, post.expectedRevision, post.confirmCustomerUse, post.settings.laborRateCents, post.settings.mustSetBeforeCustomerUse], ['settings.update', null, true, 8000, false]);
  assert.equal(ui.fs.get('pricingSettings/current').settings.laborRateCents, 8000);
  await ui.settle(() => ui.root().querySelectorAll('.cat-settings .hub-notice.success').some(node => node.textContent === 'These prices are released for customer quotes.'), 'the reload');
  // An out-of-range value is reported on the field and never sent.
  ui.fill('Deposit (% of the quote)', '101', ui.root());
  ui.button('Review changes', ui.root()).click();
  assert.equal(ui.dialog(), null);
  assert.equal(ui.control('Deposit (% of the quote)', ui.root()).getAttribute('aria-invalid'), 'true');
  assert.equal(ui.fs.posts.length, 1);
});

test('a manager sees a read-only catalog; disabled and failed loads never look like an empty catalog', async () => {
  const manager = screen({ who: MANAGER });
  await manager.loaded();
  assert.match(manager.root().textContent, /Only the owner can change pricing settings\./);
  assert.ok(manager.root().querySelectorAll('input').every(node => node.disabled === true));
  manager.button('Items', manager.root()).click();
  assert.equal(manager.buttons(manager.root()).filter(node => /^(Verify price|Edit|Add product)$/.test(node.textContent)).length, 0);
  assert.match(manager.root().querySelector('.cat-row-actions').textContent, /Read only/);
  const off = screen({ env: {} });
  await off.settle(() => off.root().textContent.includes('Catalog pricing is turned off'), 'the disabled notice');
  assert.equal(off.root().querySelector('.cat-tabs'), null);
  let broken = true;
  const failing = screen({ fail: () => broken ? Response.json({ ok: false, code: 'catalog_unavailable', error: 'The catalog could not complete this request.' }, { status: 503 }) : null });
  await failing.settle(() => failing.root().querySelector('[role="alert"]'), 'the unavailable notice');
  assert.match(failing.root().textContent, /The catalog is unavailable/);
  assert.equal(failing.root().querySelector('.cat-tabs'), null);
  broken = false;
  failing.button('Retry', failing.root()).click();
  await failing.loaded();
  const malformed = screen({ tamper: body => { delete body.prices; } });
  await malformed.settle(() => malformed.root().querySelector('[role="alert"]'), 'the unverified notice');
  assert.match(malformed.root().textContent, /could not be verified|was incomplete/);
  assert.equal(malformed.root().querySelector('.cat-tabs'), null);
});

test('operations defaults link to their own screens, and sign-out clears the draft', async () => {
  const ui = screen();
  await ui.loaded();
  ui.button('Open Team schedule', ui.root()).click();
  ui.button('Open Action Center', ui.root()).click();
  assert.deepEqual([...ui.went], ['schedule', 'action_center']);
  const templates = ui.root().querySelectorAll('a').find(node => node.textContent === 'Open message templates');
  assert.equal(templates.getAttribute('href'), '/message-templates.html', 'reminder wording is approved where the templates live');
  // The deposit and minimum price catalog quotes only; the owner is told the walkthrough values do not change here.
  const help = label => ui.control(label, ui.root()).parentNode.querySelector('small').textContent;
  assert.match(help('Deposit (% of the quote)'), /^Catalog quotes only\. The walkthrough deposit in use today \(50%, set by the deposit terms\) does not change here\.$/);
  assert.match(help('Minimum job ($)'), /^Catalog quotes only.*The \$450 walkthrough game plan minimum does not change here\.$/);
  await verifyFirstUnverified(ui);
  assert.ok(ui.session.getItem('egc.hub.draft.v1.catalog.zacb'));
  assert.equal(ui.api.canLeave(), true, 'a saved draft does not block navigation');
  ui.signout();
  assert.equal(ui.session.getItem('egc.hub.draft.v1.catalog.zacb'), null);
  assert.equal(ui.host.querySelector('.egc-catalog'), null);
});

test('sign-out clears Hub drafts even when the catalog screen never loaded on the page', () => {
  const page = hubPage();
  page.api.install();
  assert.equal(page.context.EGCCatalog, undefined, 'the lazily loaded screen is not on this page');
  page.session.setItem('egc.hub.draft.v1.catalog.zacb', JSON.stringify({ v: 1, baseVersion: '2026-09-27.1', items: { synthetic: { id: 'synthetic', name: 'Synthetic', sources: [], retailPriceHighCents: 1200 } }, added: [] }));
  page.session.setItem('egc.hub.draft.v1.catalog.tylerg', '{}');
  page.session.setItem('egc.dispatch.pending.v1.zacb', 'kept by its own module');
  page.fire('egc:signout');
  assert.deepEqual([...page.session.values.keys()].filter(key => key.startsWith('egc.hub.draft.v1.')), []);
  assert.equal(page.session.getItem('egc.dispatch.pending.v1.zacb'), 'kept by its own module');
});

test('the catalog screen is registered once, owner-only, and loads its own versioned assets', () => {
  const owner = hubPage(), entry = owner.context.EGCHubScreens.get('catalog');
  assert.deepEqual(copy({ ...entry, mount: undefined, unmount: undefined, canLeave: undefined, refresh: undefined, homeWidget: undefined }), {
    id: 'catalog', group: 'SYSTEM', label: 'Catalog & pricing', iconPath: entry.iconPath, capability: 'owner', crewVisible: false,
    load: { js: 'employee-catalog.js', css: 'employee-catalog.css', v: '20260928catalog' }, module: 'EGCCatalog' });
  assert.ok(owner.api.visibleNav().some(item => item[0] === 'SYSTEM' && item[1] === 'catalog' && item[2] === 'Catalog & pricing'));
  for (const who of [{ user: 'AlexK', business: true, role: 'manager' }, { user: 'Synthetic.Crew', business: false, role: 'crew' }]) {
    const page = hubPage(who);
    assert.ok(!page.api.visibleNav().some(item => item[1] === 'catalog'), who.role);
    page.api.install();
    page.api.go('catalog');
    assert.equal(page.api.S.active, 'my_day', `${who.role} cannot open the owner screen by name`);
  }
});

test('the screen builds DOM without markup strings or dynamic code (security invariant)', () => {
  for (const pattern of [/innerHTML/, /outerHTML/, /insertAdjacentHTML/, /document\.write/, /\beval\(/, /new Function/, /srcdoc/]) assert.doesNotMatch(SOURCE, pattern, String(pattern));
  assert.match(SOURCE, /window\.EGCCatalog=Object\.freeze\(\{mount,unmount,refresh:/);
});
