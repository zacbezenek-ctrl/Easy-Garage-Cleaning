import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { encodeFirestoreFields, decodeFirestoreFields } from '../functions/_lib/firestore-job.js';
import { STOCK_CATALOG_VERSION, STOCK_ITEMS } from '../functions/_data/catalog-stock-items.js';
import { expectedStockItemsModule } from '../scripts/catalog-stock-items.mjs';
import { STANDARD_COSTS, STANDARD_COST_OPERATIONS, mutateStandardCosts, readStandardCosts, standardCostLine, standardCostOverview, standardCostStorage } from '../functions/_lib/standard-costs.js';
import { standardCostHandlers } from '../functions/api/standard-costs.js';

const NOW = '2026-09-22T12:00:00.000Z';
const owner = { user: 'zacb', role: 'owner', businessAccess: true, displayName: 'Owner' };
const manager = { user: 'tylerg', role: 'manager', businessAccess: true, displayName: 'Manager' };
const crew = { user: 'crew.one', role: 'crew', businessAccess: false, displayName: 'Crew One' };
const catalog = JSON.parse(readFileSync(new URL('../functions/_data/garage-catalog.json', import.meta.url), 'utf8'));
const shelf = 'shelving-husky-n3r482478w5b-48x24x78-5tier', rack = 'overhead-rack-fleximounts-gr48-classic-4x8';
const uuid = () => crypto.randomUUID();

// In-memory revisioned store: reads are copies, a write with a revision must
// match it, one without is create-only, and a commit applies all or nothing.
function memoryStore() {
  const rows = new Map(); let revision = 0; const log = { commits: [] };
  return {
    rows, log,
    async read(collection, id) { const row = rows.get(`${collection}/${id}`); return row ? structuredClone(row) : null; },
    async commit(writes) {
      const keys = writes.map(write => `${write.collection}/${write.id}`);
      assert.equal(new Set(keys).size, keys.length, 'no duplicate targets in one commit');
      for (const [index, write] of writes.entries()) { const current = rows.get(keys[index]); if (write.revision ? current?.revision !== write.revision : current) throw Object.assign(new Error('conflict'), { code: 'standard_cost_revision_conflict', status: 409 }); }
      writes.forEach((write, index) => rows.set(keys[index], { ...(write.revision ? rows.get(keys[index]) : {}), ...structuredClone(write.patch), revision: `rev-${++revision}` }));
      log.commits.push(writes);
    },
  };
}
const save = (changes, overrides = {}) => ({ action: 'standard_costs.set', requestId: uuid(), expectedRevision: null, changes, ...overrides });

test('the stocked-item module is generated from the catalog JSON and carries no prices', () => {
  assert.equal(readFileSync(new URL('../functions/_data/catalog-stock-items.js', import.meta.url), 'utf8'), expectedStockItemsModule(), 'run node scripts/catalog-stock-items.mjs --write');
  const active = catalog.items.filter(item => item.kind === 'product' && item.availability === 'active');
  assert.equal(STOCK_ITEMS.length, active.length); assert.equal(STOCK_CATALOG_VERSION, catalog.catalogVersion);
  assert.ok(STOCK_ITEMS.every(item => item.length === 4 && item.every(value => typeof value === 'string')));
  assert.ok(!STOCK_ITEMS.some(([id]) => catalog.items.find(item => item.id === id).kind !== 'product'), 'no service items');
  const text = readFileSync(new URL('../functions/_data/catalog-stock-items.js', import.meta.url), 'utf8');
  assert.equal(String(catalog.items.find(item => item.id === rack).retailPriceHighCents), '19499'); assert.equal(text.includes('19499'), false, 'retail prices are not copied');
});

test('owner saves standard costs with a receipt and an owner audit entry in one commit; managers read; others cannot', async () => {
  const store = memoryStore();
  const empty = await standardCostOverview(store, manager, new Date(NOW));
  assert.deepEqual([empty.revision, empty.coverage.set, empty.canEdit, empty.basis], [null, 0, false, 'standard_unit_cost']);
  assert.equal(empty.items.find(item => item.id === rack).standardUnitCostCents, null, 'no cost is ever derived from the retail price');
  await assert.rejects(standardCostOverview(store, crew), error => error.code === 'standard_cost_forbidden' && error.status === 403);
  await assert.rejects(standardCostOverview(store, null), error => error.status === 401);
  await assert.rejects(mutateStandardCosts(store, manager, save([{ itemId: shelf, standardUnitCostCents: 12000 }]), NOW), error => error.code === 'standard_cost_owner_required');
  await assert.rejects(mutateStandardCosts(store, { ...owner, businessAccess: false }, save([{ itemId: shelf, standardUnitCostCents: 12000 }]), NOW), error => error.status === 403);
  assert.equal(store.log.commits.length, 0);
  const input = save([{ itemId: shelf, standardUnitCostCents: 12000 }, { itemId: rack, standardUnitCostCents: 16550 }], { reason: 'Supplier invoice 2026-09' });
  const saved = await mutateStandardCosts(store, owner, input, NOW);
  assert.equal(saved.replayed, false); assert.equal(saved.canEdit, true); assert.deepEqual(saved.coverage, { set: 2, total: STOCK_ITEMS.length });
  assert.deepEqual(saved.items.find(item => item.id === shelf), { id: shelf, name: STOCK_ITEMS.find(item => item[0] === shelf)[1], category: 'shelving', priceUnit: STOCK_ITEMS.find(item => item[0] === shelf)[3], standardUnitCostCents: 12000, updatedAt: NOW, updatedBy: 'zacb' });
  assert.equal(store.log.commits.length, 1); const [costs, receipt, audit] = store.log.commits[0];
  assert.deepEqual([costs.collection, costs.id, costs.revision], [STANDARD_COSTS, 'current', null]);
  assert.deepEqual(costs.patch.items.map(item => item.itemId), [rack, shelf], 'stored sorted by item');
  assert.deepEqual({ ...receipt.patch, fingerprint: undefined }, { action: 'standard_costs.set', requestId: input.requestId, fingerprint: undefined, actorId: 'zacb', at: NOW, changedItemIds: [shelf, rack] });
  assert.equal(receipt.collection, STANDARD_COST_OPERATIONS); assert.equal(audit.collection, 'hub_audit');
  assert.deepEqual([audit.patch.action, audit.patch.visibility, audit.patch.actor.id, audit.patch.reason], ['catalog.standard_costs.set', 'owner', 'zacb', 'Supplier invoice 2026-09']);
  assert.deepEqual(JSON.parse(audit.patch.after), { [shelf]: 12000, [rack]: 16550 });
  const read = await readStandardCosts({}, { store });
  assert.deepEqual(standardCostLine(read, shelf, 3), { itemId: shelf, quantity: 3, standardUnitCostCents: 12000, totalCents: 36000, status: 'provisional', reason: 'standard_cost', source: 'standard_cost' });
  assert.deepEqual(standardCostLine(read, 'bike-hook-everbilt-screw-in-25lb', 2), { itemId: 'bike-hook-everbilt-screw-in-25lb', quantity: 2, standardUnitCostCents: null, totalCents: null, status: 'unknown', reason: 'standard_cost_unset', source: 'standard_cost' });
  assert.equal(standardCostLine(null, rack).status, 'unknown'); assert.throws(() => standardCostLine(read, shelf, 0), error => error.status === 400);
});

test('saves are idempotent by request ID, revision-checked, and clearing a cost makes it unknown again', async () => {
  const store = memoryStore(), first = save([{ itemId: shelf, standardUnitCostCents: 12000 }]);
  const saved = await mutateStandardCosts(store, owner, first, NOW);
  const replay = await mutateStandardCosts(store, owner, { ...first, requestId: first.requestId.toUpperCase() }, NOW);
  assert.equal(replay.replayed, true); assert.equal(store.log.commits.length, 1);
  await assert.rejects(mutateStandardCosts(store, owner, { ...first, changes: [{ itemId: shelf, standardUnitCostCents: 13000 }] }, NOW), error => error.code === 'standard_cost_idempotency_conflict' && error.status === 409);
  await assert.rejects(mutateStandardCosts(store, owner, save([{ itemId: rack, standardUnitCostCents: 100 }]), NOW), error => error.code === 'standard_cost_revision_conflict', 'a save from an older view is refused');
  await assert.rejects(mutateStandardCosts(store, owner, save([{ itemId: shelf, standardUnitCostCents: 12000 }], { expectedRevision: saved.revision }), NOW), error => error.code === 'standard_cost_no_change');
  const cleared = await mutateStandardCosts(store, owner, save([{ itemId: shelf, standardUnitCostCents: null }], { expectedRevision: saved.revision }), NOW);
  assert.equal(cleared.items.find(item => item.id === shelf).standardUnitCostCents, null); assert.equal(cleared.coverage.set, 0);
  assert.equal(standardCostLine(await readStandardCosts({}, { store }), shelf).totalCents, null);
});

test('only active catalog products take a cost, in whole cents within limits', async () => {
  const store = memoryStore();
  const service = catalog.items.find(item => item.kind === 'service').id, hidden = catalog.items.find(item => item.availability === 'hidden').id, referral = catalog.items.find(item => item.availability === 'referral_only').id;
  for (const [changes, code] of [
    [[{ itemId: service, standardUnitCostCents: 100 }], 'standard_cost_item_invalid'], [[{ itemId: hidden, standardUnitCostCents: 100 }], 'standard_cost_item_invalid'], [[{ itemId: referral, standardUnitCostCents: 100 }], 'standard_cost_item_invalid'],
    [[{ itemId: 'not-a-catalog-item', standardUnitCostCents: 100 }], 'standard_cost_item_invalid'], [[{ itemId: shelf, standardUnitCostCents: 1 }, { itemId: shelf, standardUnitCostCents: 2 }], 'standard_cost_item_invalid'],
    ...[0, -5, 12.5, '1200', 10000001, true].map(standardUnitCostCents => [[{ itemId: shelf, standardUnitCostCents }], 'standard_cost_amount_invalid']),
    [[{ itemId: shelf }], 'standard_cost_request_invalid'], [[{ itemId: shelf, standardUnitCostCents: 5, retailPriceHighCents: 1 }], 'standard_cost_request_invalid'], [[], 'standard_cost_request_invalid'],
    [STOCK_ITEMS.slice(0, 101).map(([itemId]) => ({ itemId, standardUnitCostCents: 100 })), 'standard_cost_request_invalid'],
  ]) await assert.rejects(mutateStandardCosts(store, owner, save(changes), NOW), error => error.code === code && error.status === 400, JSON.stringify(changes).slice(0, 120));
  for (const input of [{ ...save([{ itemId: shelf, standardUnitCostCents: 1 }]), actorId: 'zacb' }, save([{ itemId: shelf, standardUnitCostCents: 1 }], { action: 'catalog.publish' }), save([{ itemId: shelf, standardUnitCostCents: 1 }], { requestId: 'nope' }), save([{ itemId: shelf, standardUnitCostCents: 1 }], { expectedRevision: 7 })]) {
    await assert.rejects(mutateStandardCosts(store, owner, input, NOW), error => error.code === 'standard_cost_request_invalid');
  }
  assert.equal(store.log.commits.length, 0);
  const max = await mutateStandardCosts(store, owner, save([{ itemId: shelf, standardUnitCostCents: 10000000 }]), NOW); assert.equal(max.coverage.set, 1, 'the $100,000 ceiling itself is accepted');
});

test('a malformed stored record fails closed; a retired item stays visible and can be cleared', async () => {
  const store = memoryStore();
  store.rows.set(`${STANDARD_COSTS}/current`, { schemaVersion: 1, items: [{ itemId: shelf, standardUnitCostCents: 0, updatedAt: NOW, updatedBy: 'zacb' }], revision: 'rev-bad' });
  await assert.rejects(standardCostOverview(store, owner), error => error.code === 'standard_cost_storage_invalid' && error.status === 503);
  await assert.rejects(readStandardCosts({}, { store }), error => error.code === 'standard_cost_storage_invalid');
  await assert.rejects(mutateStandardCosts(store, owner, save([{ itemId: shelf, standardUnitCostCents: 1 }], { expectedRevision: 'rev-bad' }), NOW), error => error.code === 'standard_cost_storage_invalid');
  store.rows.set(`${STANDARD_COSTS}/current`, { schemaVersion: 1, items: [{ itemId: 'retired-synthetic-rack', standardUnitCostCents: 5000, updatedAt: NOW, updatedBy: 'zacb' }], revision: 'rev-1' });
  const overview = await standardCostOverview(store, owner);
  assert.deepEqual(overview.retired, [{ id: 'retired-synthetic-rack', standardUnitCostCents: 5000, updatedAt: NOW, updatedBy: 'zacb' }]); assert.equal(overview.coverage.set, 0);
  await assert.rejects(mutateStandardCosts(store, owner, save([{ itemId: 'retired-synthetic-rack', standardUnitCostCents: 6000 }], { expectedRevision: 'rev-1' }), NOW), error => error.code === 'standard_cost_item_invalid', 'a retired item can only be cleared');
  const cleared = await mutateStandardCosts(store, owner, save([{ itemId: 'retired-synthetic-rack', standardUnitCostCents: null }], { expectedRevision: 'rev-1' }), NOW);
  assert.deepEqual(cleared.retired, []);
});

test('Firestore storage maps creates, updates, preconditions and lost responses', async () => {
  const docs = new Map(), calls = []; let revision = 0, lose = false, stale = false;
  const fetcher = async (env, url, options = {}) => {
    const path = decodeURIComponent(new URL(url).pathname.split('/documents')[1] || '').replace(/^\//, ''); calls.push({ path, options });
    if (path === ':commit') {
      if (lose) { lose = false; throw new TypeError('Synthetic lost response'); }
      if (stale) return Response.json({ error: { status: 'FAILED_PRECONDITION' } }, { status: 400 });
      for (const write of JSON.parse(options.body).writes) { const key = write.update.name.split('/documents/')[1]; docs.set(key, { name: write.update.name, fields: { ...(write.updateMask ? docs.get(key)?.fields : {}), ...write.update.fields }, updateTime: `2026-09-22T00:00:00.${String(++revision).padStart(6, '0')}Z` }); }
      return Response.json({ writeResults: [] });
    }
    return docs.has(path) ? Response.json(docs.get(path)) : Response.json({}, { status: 404 });
  };
  const store = standardCostStorage({}, fetcher), input = save([{ itemId: shelf, standardUnitCostCents: 12000 }]);
  await mutateStandardCosts(store, owner, input, NOW);
  const commit = JSON.parse(calls.find(call => call.path === ':commit').options.body);
  assert.deepEqual(commit.writes.map(write => [write.update.name.split('/documents/')[1].split('/')[0], write.currentDocument, Boolean(write.updateMask)]), [[STANDARD_COSTS, { exists: false }, false], [STANDARD_COST_OPERATIONS, { exists: false }, false], ['hub_audit', { exists: false }, false]]);
  const current = await store.read(STANDARD_COSTS, 'current'); assert.match(current.revision, /^2026-09-22T/); assert.equal(decodeFirestoreFields(encodeFirestoreFields(current)).items[0].standardUnitCostCents, 12000);
  const update = save([{ itemId: rack, standardUnitCostCents: 16550 }], { expectedRevision: current.revision }); lose = true;
  await assert.rejects(mutateStandardCosts(store, owner, update, NOW), error => error.code === 'standard_cost_outcome_unknown' && error.status === 503);
  const retried = await mutateStandardCosts(store, owner, update, NOW); assert.equal(retried.replayed, false, 'nothing was written, so the retry applies it once');
  assert.deepEqual(JSON.parse(calls.filter(call => call.path === ':commit').at(-1).options.body).writes[0].currentDocument, { updateTime: current.revision });
  stale = true;
  await assert.rejects(mutateStandardCosts(store, owner, save([{ itemId: shelf, standardUnitCostCents: 1 }], { expectedRevision: retried.revision }), NOW), error => error.code === 'standard_cost_revision_conflict', 'Firestore 400 FAILED_PRECONDITION is a revision conflict');
  const broken = standardCostStorage({}, async () => Response.json({ name: 'projects/x/databases/(default)/documents/other/current', fields: {}, updateTime: NOW }));
  await assert.rejects(broken.read(STANDARD_COSTS, 'current'), error => error.code === 'standard_cost_storage_incomplete');
});

test('the HTTP endpoint is same-origin JSON, owner-only for writes and never leaks internal errors', async () => {
  const store = memoryStore(), who = { current: owner };
  const handlers = standardCostHandlers({ session: async () => who.current, storage: () => store, now: () => new Date(NOW) });
  const request = (body, headers = {}, search = '') => new Request(`https://easygaragecleaning.com/api/standard-costs${search}`, body === undefined ? {} : { method: 'POST', headers: { Origin: 'https://easygaragecleaning.com', 'Content-Type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
  const get = await handlers.get({ request: request(), env: {} }); assert.equal(get.status, 200); assert.equal(get.headers.get('Cache-Control'), 'no-store');
  assert.equal((await get.json()).items.length, STOCK_ITEMS.length);
  assert.equal((await handlers.get({ request: request(undefined, {}, '?view=all'), env: {} })).status, 400);
  const body = save([{ itemId: shelf, standardUnitCostCents: 12000 }]);
  assert.equal((await handlers.post({ request: request(body, { Origin: 'https://attacker.example' }), env: {} })).status, 403);
  assert.equal((await handlers.post({ request: request(body, { 'Sec-Fetch-Site': 'cross-site' }), env: {} })).status, 403);
  assert.equal((await handlers.post({ request: request(body, { 'Content-Type': 'text/plain' }), env: {} })).status, 415);
  assert.equal((await handlers.post({ request: request('{'), env: {} })).status, 400);
  assert.equal((await handlers.post({ request: request({ ...body, reason: 'x'.repeat(33000) }), env: {} })).status, 413);
  who.current = manager; const refused = await handlers.post({ request: request(body), env: {} }); assert.equal(refused.status, 403); assert.equal((await refused.json()).code, 'standard_cost_owner_required');
  who.current = crew; assert.equal((await handlers.get({ request: request(), env: {} })).status, 403);
  who.current = owner; const saved = await handlers.post({ request: request(body), env: {} }); assert.equal(saved.status, 200); assert.equal((await saved.json()).coverage.set, 1);
  const failing = standardCostHandlers({ session: async () => owner, storage: () => ({ read: async () => { throw new Error('Synthetic internal detail'); } }) });
  const hidden = await failing.get({ request: request(), env: {} }); assert.equal(hidden.status, 503);
  const text = JSON.stringify(await hidden.json()); assert.equal(text.includes('Synthetic internal detail'), false); assert.match(text, /standard_cost_unavailable/);
});

// Managers read the costs (the API and the screen's read-only mode allow it); only the owner edits them.
test('the Stocked item costs screen opens for the owner and managers, not crew, and loads its own files', async () => {
  const { hubPage } = await import('./helpers/hub-dom.mjs');
  for (const [who, expected] of [[{}, true], [{ user: 'AlexK', role: 'manager' }, true], [{ user: 'Synthetic.Crew', business: false, role: 'crew' }, false]]) {
    const page = hubPage(who), screen = page.context.EGCHubScreens.get('stocked_costs');
    assert.deepEqual({ group: screen.group, label: screen.label, capability: screen.capability, module: screen.module, js: screen.load.js, css: screen.load.css }, { group: 'SYSTEM', label: 'Stocked item costs', capability: 'business', module: 'EGCStandardCosts', js: 'employee-standard-costs.js', css: 'employee-standard-costs.css' });
    assert.equal(page.api.canView('stocked_costs'), expected, JSON.stringify(who));
    assert.equal(page.api.visibleNav().some(item => item[1] === 'stocked_costs'), expected);
  }
});

test('the standard-cost collections are explicitly server-only in the Firestore rules', () => {
  const rules = readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8');
  for (const name of [STANDARD_COSTS, STANDARD_COST_OPERATIONS]) assert.match(rules, new RegExp(`match /${name}/\\{documentId\\} \\{\\s*allow read, write: if false;\\s*\\}`));
});
