import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { catalogHandlers } from '../functions/api/catalog.js';
import { catalogStorage, MAX_CATALOG_BYTES, mutateCatalog, projectCatalogOverview, readCatalogState, seedCatalog, seedPricingSettings } from '../functions/_lib/catalog-store.js';
import { catalogLine } from '../functions/_lib/catalog.js';
import { decodeFirestoreFields, encodeFirestoreFields } from '../functions/_lib/firestore-job.js';
import { createHubSessionToken, readCookie, verifyHubSessionToken } from '../functions/_lib/hub-session.js';
import { expectedSeedModule, MODULE } from '../scripts/catalog-seed.mjs';

const NOW = '2026-09-28T18:00:00.000Z';
const ORIGIN = 'https://easygaragecleaning.com', ENDPOINT = `${ORIGIN}/api/catalog`;
const ENV = { CATALOG_QUOTES_ENABLED: 'true' };
const ROOT = 'projects/egcw-1ec83/databases/(default)/documents/';
const owner = { user: 'zacb', role: 'owner', businessAccess: true, displayName: 'Synthetic Owner' };
const manager = { user: 'tylerg', role: 'manager', businessAccess: true, displayName: 'Synthetic Manager' };
const crew = { user: 'crew1', role: 'crew', businessAccess: false, displayName: 'Synthetic Crew' };
const readJson = path => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const shipped = readJson('../functions/_data/garage-catalog.json');
const defaults = readJson('../functions/_data/pricing-settings.defaults.json');
const activeProduct = shipped.items.find(item => item.kind === 'product' && item.availability === 'active');
const verifiedItem = shipped.items.find(item => item.priceVerifiedAt === '2026-09-27');
const neverVerified = shipped.items.find(item => item.priceVerifiedAt === null);

// Firestore REST emulation with the real precondition answers: a create over an existing document is
// 409 ALREADY_EXISTS, a stale updateTime is 400 FAILED_PRECONDITION and a missing document is a 404 naming
// it. updateTime comes from a counter. cache is the fixture's isolate: its verified catalogs.
function firestore() {
  const docs = new Map(), calls = { reads: [], commits: [] }, hooks = {}, cache = new Map();
  let tick = 0;
  const time = () => `2026-09-28T18:00:00.${String(++tick).padStart(6, '0')}Z`;
  const error = (status, code, message) => Response.json({ error: { code, status, ...(message ? { message } : {}) } }, { status: code });
  async function fetcher(_env, url, options = {}) {
    const target = new URL(url);
    assert.equal(target.hostname, 'firestore.googleapis.com', 'only Firestore is reachable');
    const path = decodeURIComponent(target.pathname.split('/documents')[1] || '');
    if (options.method === 'POST' && path === ':commit') {
      const { writes } = JSON.parse(options.body);
      const keys = writes.map(write => write.update.name.slice(ROOT.length));
      calls.commits.push(keys);
      if (hooks.before) await hooks.before(keys);
      if (hooks.respond) { const answer = await hooks.respond(keys); if (answer) return answer; }
      assert.equal(new Set(keys).size, keys.length, 'one write per document in a commit');
      for (const [index, write] of writes.entries()) {
        const current = docs.get(keys[index]);
        if (write.currentDocument?.exists === false && current) return error('ALREADY_EXISTS', 409);
        if (write.currentDocument?.updateTime && current?.updateTime !== write.currentDocument.updateTime) return error('FAILED_PRECONDITION', 400);
      }
      const at = time();
      for (const [index, write] of writes.entries()) {
        const fields = { ...(docs.get(keys[index])?.fields || {}) };
        for (const field of write.updateMask.fieldPaths) if (Object.hasOwn(write.update.fields, field)) fields[field] = write.update.fields[field]; else delete fields[field];
        assert.ok(JSON.stringify(fields).length < 1048576, `${keys[index]} fits in one Firestore document`);
        docs.set(keys[index], { fields, updateTime: at });
      }
      if (hooks.after) await hooks.after(keys);
      return Response.json({ writeResults: writes.map(() => ({ updateTime: at })), commitTime: at });
    }
    assert.ok(!options.method || options.method === 'GET', `unexpected ${options.method} ${path}`);
    const key = path.slice(1);
    calls.reads.push(key);
    if (hooks.read) { const answer = await hooks.read(key); if (answer) return answer; }
    const doc = docs.get(key);
    return doc ? Response.json({ name: ROOT + key, fields: doc.fields, updateTime: doc.updateTime }) : error('NOT_FOUND', 404, `Document "${ROOT}${key}" not found.`);
  }
  return {
    docs, calls, hooks, fetcher, cache,
    get: key => docs.has(key) ? decodeFirestoreFields(docs.get(key).fields) : null,
    revision: key => docs.get(key)?.updateTime ?? null,
    // Another writer (the Firestore console, another tab): new content, new updateTime.
    put: (key, data) => docs.set(key, { fields: encodeFirestoreFields(data), updateTime: time() }),
    patch: (key, data) => docs.set(key, { fields: { ...docs.get(key).fields, ...encodeFirestoreFields(data) }, updateTime: time() }),
    writes: () => calls.commits.length,
  };
}

const handlers = (who, fs, now = NOW, cache = fs.cache) => catalogHandlers({ session: async () => who, storage: env => catalogStorage(env, fs.fetcher), now: () => new Date(now), cache });
const get = (h, query = '', env = ENV) => h.get({ request: new Request(ENDPOINT + query), env });
const post = (h, body, { headers = {}, env = ENV, raw } = {}) => h.post({ request: new Request(ENDPOINT, { method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json', ...headers }, body: raw ?? JSON.stringify(body) }), env });
const json = async response => ({ status: response.status, body: await response.json(), headers: response.headers });
const settings = (changes = {}) => ({ ...structuredClone(defaults), settingsVersion: 'owner-2026-09-28', ...changes });
const settingsUpdate = (changes = {}, extra = {}) => ({ action: 'settings.update', requestId: randomUUID(), expectedRevision: null, settings: settings(changes), ...extra });
function nextCatalog(version = '2026-09-28.1', change = 1000) {
  const catalog = { ...structuredClone(shipped), catalogVersion: version, generatedOn: version.slice(0, 10) };
  const item = catalog.items.find(entry => entry.id === activeProduct.id);
  item.retailPriceHighCents += change;
  return catalog;
}
const publishRequest = (catalog = nextCatalog(), extra = {}) => ({ action: 'catalog.publish', requestId: randomUUID(), basedOnVersion: '2026-09-27.1', catalog, ...extra });
const auditRows = fs => [...fs.docs.keys()].filter(key => key.startsWith('hub_audit/')).map(key => fs.get(key));
const DETAIL_ITEM_FIELDS = ['sources', 'verificationNote', 'auditStatus', 'auditActions'];
const summaryOf = catalog => { const { auditLog, ...rest } = catalog; return { ...rest, items: catalog.items.map(item => Object.fromEntries(Object.entries(item).filter(([key]) => !DETAIL_ITEM_FIELDS.includes(key)))) }; };

test('the bundled seed module is exactly the catalog and settings JSON (regenerate with scripts/catalog-seed.mjs --write)', () => {
  assert.equal(readFileSync(new URL(`../${MODULE}`, import.meta.url), 'utf8'), expectedSeedModule(), `${MODULE} is stale; run node scripts/catalog-seed.mjs --write`);
  assert.deepEqual(seedCatalog(), shipped);
  assert.deepEqual(seedPricingSettings(), defaults);
  assert.ok(Object.isFrozen(seedCatalog().items[0].sources) && Object.isFrozen(seedPricingSettings().markupPct), 'the shared seed cannot be mutated by a caller');
});

test('catalog versions, pricing settings, settings versions and catalog receipts are explicitly server-only in firestore.rules', () => {
  const rules = readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8');
  for (const collection of ['catalogVersions', 'pricingSettings', 'pricingSettingsVersions', 'catalogOperations']) assert.match(rules, new RegExp(`match /${collection}/\\{documentId\\} \\{\\s*allow read, write: if false;\\s*\\}`), collection);
});

test('with CATALOG_QUOTES_ENABLED unset GET reports enabled:false with no catalog data and writes are 404', async () => {
  for (const env of [{}, { CATALOG_QUOTES_ENABLED: '1' }, { CATALOG_QUOTES_ENABLED: 'TRUE' }]) {
    const fs = firestore();
    for (const query of ['', '?view=status']) {
      const { status, body } = await json(await get(handlers(owner, fs), query, env));
      assert.equal(status, 200);
      assert.deepEqual(body, { ok: true, authority: 'employee_hub', enabled: false });
    }
    for (const body of [settingsUpdate(), publishRequest()]) {
      const response = await json(await post(handlers(owner, fs), body, { env }));
      assert.deepEqual([response.status, response.body.code], [404, 'catalog_disabled']);
    }
    assert.deepEqual([fs.calls.reads, fs.writes()], [[], 0], 'a disabled catalog never touches Firestore');
  }
  const status = await json(await get(handlers(manager, firestore()), '?view=status'));
  assert.deepEqual(status.body, { ok: true, authority: 'employee_hub', enabled: true });
});

test('owner and manager GET the seed catalog priced with the placeholder defaults while Firestore is empty', async () => {
  for (const who of [owner, manager]) {
    const fs = firestore();
    const { status, body, headers } = await json(await get(handlers(who, fs)));
    assert.equal(status, 200);
    assert.equal(headers.get('Cache-Control'), 'no-store'); assert.equal(headers.get('X-Content-Type-Options'), 'nosniff');
    assert.deepEqual([body.ok, body.authority, body.enabled, body.asOf, body.view], [true, 'employee_hub', true, NOW, 'summary']);
    assert.deepEqual(body.publication, { source: 'seed', version: '2026-09-27.1', revision: null, basedOnVersion: null, sha256: null, itemCount: 250, publishedAt: null, publishedBy: null });
    assert.deepEqual(body.catalog, summaryOf(shipped), 'the default view has product costs but no audit log, sources or verification and audit notes');
    const full = (await json(await get(handlers(who, fs), '?view=full'))).body;
    assert.deepEqual([full.view, full.prices, full.stale], ['full', body.prices, body.stale]);
    assert.deepEqual(full.catalog, shipped, 'view=full is the complete publishable catalog document');
    assert.ok(JSON.stringify(body).length < 0.8 * JSON.stringify(full).length);
    assert.deepEqual({ ...body.settings, values: undefined }, { revision: null, source: 'defaults', settingsVersion: defaults.settingsVersion, readyForCustomers: false, updatedAt: null, updatedBy: null, values: undefined });
    assert.deepEqual(body.settings.values, defaults);
    assert.equal(Object.keys(body.prices).length, shipped.items.length);
    const line = catalogLine(activeProduct, defaults);
    assert.deepEqual(body.prices[activeProduct.id], { quotable: true, stale: false, quantity: 1, unitCents: line.unitCents, totalCents: line.totalCents, customerSupplied: false, durationMinutes: line.durationMinutes, split: line.split });
    const service = shipped.items.find(item => item.kind === 'service' && item.availability === 'active');
    assert.deepEqual([body.prices[service.id].unitCents, body.prices[service.id].split], [service.fixedPriceCents, null]);
    for (const item of shipped.items.filter(entry => entry.availability !== 'active')) assert.deepEqual({ ...body.prices[item.id], stale: undefined }, { quotable: false, reason: item.availability, stale: undefined });
    assert.deepEqual(body.viewer, { id: who.user, role: who.role, internal: true, canEditSettings: who === owner, canPublish: who === owner });
    assert.deepEqual(fs.calls.reads.sort(), ['catalogVersions/current', 'catalogVersions/current', 'pricingSettings/current', 'pricingSettings/current']);
    assert.equal(fs.writes(), 0, 'reading never seeds Firestore');
  }
});

test('crew, signed-out, spoofed and sales sessions cannot read the catalog or its prices', async () => {
  const cases = [[null, 401, 'catalog_sign_in_required'], [crew, 403, 'catalog_forbidden'],
    [{ user: 'mallory', role: 'owner', businessAccess: true }, 403, 'catalog_forbidden'],
    [{ user: 'tylerg', role: 'crew', businessAccess: true }, 403, 'catalog_forbidden'],
    [{ user: 'alexk', role: 'manager', businessAccess: false }, 403, 'catalog_forbidden'],
    [{ user: 'zoe.zoll', role: 'sales', businessAccess: false }, 403, 'catalog_forbidden']];
  for (const [who, code, name] of cases) {
    const fs = firestore();
    for (const query of ['', '?view=status']) {
      const { status, body } = await json(await get(handlers(who, fs), query));
      assert.deepEqual([status, body.ok, body.code], [code, false, name]);
      assert.equal(body.prices, undefined);
    }
    assert.deepEqual(fs.calls.reads, []);
  }
  const fs = firestore();
  for (const query of ['?view=status&view=full', '?view=everything', '?item=bikes']) assert.equal((await json(await get(handlers(owner, fs), query))).body.code, 'catalog_request_invalid');
});

test('stale flags follow the injected clock in Denver calendar days (90 days after the last verified price)', async () => {
  const fs = firestore();
  // 06:00Z on Dec 27 is still Dec 26 in Denver: 90 days after 2026-09-27, so verified prices are current.
  const before = (await json(await get(handlers(manager, fs, '2026-12-27T06:59:59.000Z')))).body;
  const neverVerifiedCount = shipped.items.filter(item => !item.priceVerifiedAt).length;
  assert.deepEqual([before.stale.afterDays, before.stale.count], [90, neverVerifiedCount]);
  assert.deepEqual([before.prices[verifiedItem.id].stale, before.prices[neverVerified.id].stale], [false, true]);
  assert.equal(before.stale.items.find(entry => entry.id === neverVerified.id).reason, 'never_verified');
  const after = (await json(await get(handlers(manager, fs, '2026-12-27T07:00:00.000Z')))).body;
  assert.equal(after.stale.count, shipped.items.length);
  assert.equal(after.prices[verifiedItem.id].stale, true);
  assert.deepEqual((({ reason, ageDays }) => ({ reason, ageDays }))(after.stale.items.find(entry => entry.id === verifiedItem.id)), { reason: 'older_than_window', ageDays: 91 });
});

test('only the owner changes settings or publishes: managers, crew and look-alike owners are 403 and nothing is written', async () => {
  const cases = [[manager, 'catalog_owner_required'], [crew, 'catalog_owner_required'], [{ ...manager, role: 'owner' }, 'catalog_owner_required'],
    [{ ...owner, role: 'manager' }, 'catalog_owner_required'], [{ ...owner, businessAccess: false }, 'catalog_owner_required'], [null, 'catalog_sign_in_required']];
  for (const [who, code] of cases) {
    const fs = firestore();
    for (const body of [settingsUpdate(), publishRequest()]) {
      const response = await json(await post(handlers(who, fs), body));
      assert.deepEqual([response.status, response.body.code], [who ? 403 : 401, code]);
    }
    assert.deepEqual([fs.calls.reads, fs.writes()], [[], 0]);
    await assert.rejects(mutateCatalog(catalogStorage({}, fs.fetcher), who, settingsUpdate(), NOW), error => error.code === code);
  }
});

test('writes enforce same origin, JSON content type, size limits and a parseable body before touching Firestore', async () => {
  const fs = firestore(), h = handlers(owner, fs);
  const expect = async (options, status, code, body = settingsUpdate()) => { const response = await json(await post(h, body, options)); assert.deepEqual([response.status, response.body.code], [status, code]); };
  await expect({ headers: { 'Sec-Fetch-Site': 'cross-site' } }, 403, 'catalog_origin_forbidden');
  await expect({ headers: { Origin: 'https://evil.example.invalid' } }, 403, 'catalog_origin_forbidden');
  await expect({ headers: { Origin: '', Referer: 'https://evil.example.invalid/page' } }, 403, 'catalog_origin_forbidden');
  await expect({ headers: { Origin: 'null' } }, 403, 'catalog_origin_forbidden');
  await expect({ headers: { 'Content-Type': 'text/plain' } }, 415, 'catalog_json_required');
  await expect({ headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }, 415, 'catalog_json_required');
  await expect({ headers: { 'Content-Length': '1000001' } }, 413, 'catalog_request_too_large');
  await expect({ raw: JSON.stringify({ ...publishRequest(), padding: 'x'.repeat(1000000) }) }, 413, 'catalog_request_too_large');
  await expect({ raw: JSON.stringify({ ...settingsUpdate(), padding: 'x'.repeat(40000) }) }, 413, 'catalog_request_too_large');
  await expect({ raw: '{"action":"settings.update",' }, 400, 'catalog_json_invalid');
  await expect({}, 400, 'catalog_action_invalid', { ...settingsUpdate(), action: 'settings.delete' });
  await expect({}, 400, 'catalog_request_invalid', { ...settingsUpdate(), requestId: 'not-a-uuid' });
  await expect({}, 400, 'catalog_request_invalid', ['settings.update']);
  assert.deepEqual([fs.calls.reads, fs.writes()], [[], 0]);
  // With no Origin or Referer the SameSite=Strict session cookie is the only proof, as in every Hub API.
  const response = await json(await post(h, settingsUpdate(), { headers: { Origin: '' } }));
  assert.equal(response.status, 200);
});

test('settings.update saves under its revision with a version record, a receipt and an owner-only audit entry in the same commit', async () => {
  const fs = firestore(), h = handlers(owner, fs), request = settingsUpdate({ laborRateCents: 9000, comments: undefined });
  delete request.settings.comments;
  const { status, body } = await json(await post(h, request));
  assert.equal(status, 200);
  assert.deepEqual([body.ok, body.authority, body.action, body.requestId, body.replayed], [true, 'employee_hub', 'settings.update', request.requestId, false]);
  assert.deepEqual(body.settings, { revision: fs.revision('pricingSettings/current'), current: true, source: 'firestore', settingsVersion: 'owner-2026-09-28', readyForCustomers: false, updatedAt: NOW, updatedBy: 'zacb', values: request.settings });
  assert.deepEqual(fs.calls.reads, [`catalogOperations/${request.requestId}`, 'pricingSettings/current', 'pricingSettingsVersions/owner-2026-09-28'], 'the revision comes from the commit, not a read-back');
  assert.equal(fs.calls.commits.length, 1);
  const [keys] = fs.calls.commits;
  assert.deepEqual(keys.slice(0, 3), ['pricingSettings/current', 'pricingSettingsVersions/owner-2026-09-28', `catalogOperations/${request.requestId}`]);
  assert.match(keys[3], /^hub_audit\/[0-9a-f]{40}$/);
  assert.deepEqual(fs.get('pricingSettings/current'), { settings: request.settings, settingsVersion: 'owner-2026-09-28', readyForCustomers: false, updatedAt: NOW, updatedBy: 'zacb', requestId: request.requestId });
  assert.deepEqual(fs.get('pricingSettingsVersions/owner-2026-09-28'), { settingsVersion: 'owner-2026-09-28', settings: request.settings, readyForCustomers: false, savedAt: NOW, savedBy: 'zacb', requestId: request.requestId }, 'the label resolves to these values for good');
  const receipt = fs.get(`catalogOperations/${request.requestId}`);
  assert.deepEqual([receipt.action, receipt.actorId, receipt.at, receipt.result], ['settings.update', 'zacb', NOW, { settingsVersion: 'owner-2026-09-28', readyForCustomers: false }]);
  assert.match(receipt.fingerprint, /^[0-9a-f]{64}$/);
  const [audit] = auditRows(fs);
  assert.deepEqual([audit.action, audit.visibility, audit.entityKey, audit.actor, audit.requestId, audit.via, audit.at], ['pricing_settings.update', 'owner', 'pricingSettings/current', { id: 'zacb', kind: 'human', role: 'owner' }, request.requestId, 'hub', NOW]);
  assert.deepEqual(audit.changedKeys, ['comments', 'laborRateCents', 'settingsVersion']);
  assert.equal(JSON.parse(audit.before).laborRateCents, 7500); assert.equal(JSON.parse(audit.after).laborRateCents, 9000);
  const read = (await json(await get(handlers(manager, fs)))).body;
  assert.deepEqual([read.settings.source, read.settings.revision, read.settings.settingsVersion], ['firestore', body.settings.revision, 'owner-2026-09-28']);
  const line = catalogLine(activeProduct, request.settings);
  assert.deepEqual([read.prices[activeProduct.id].unitCents, read.prices[activeProduct.id].split.laborCents], [line.unitCents, line.split.laborCents]);
  assert.notEqual(line.unitCents, catalogLine(activeProduct, defaults).unitCents, 'the new labor rate re-prices the catalog');
});

test('a stale expectedRevision is 409 and a writer that lost the Firestore race saves nothing', async () => {
  const fs = firestore(), h = handlers(owner, fs);
  const first = (await json(await post(h, settingsUpdate()))).body;
  const stale = await json(await post(h, settingsUpdate({ settingsVersion: 'owner-2' })));
  assert.deepEqual([stale.status, stale.body.code, stale.body.details], [409, 'catalog_revision_conflict', { currentRevision: first.settings.revision }]);
  const wrong = await json(await post(h, settingsUpdate({ settingsVersion: 'owner-2' }, { expectedRevision: '2026-09-01T00:00:00.000000Z' })));
  assert.deepEqual([wrong.status, wrong.body.code], [409, 'catalog_revision_conflict']);
  // Another tab saves between our read and our commit: Firestore answers 400 FAILED_PRECONDITION.
  fs.hooks.before = () => { fs.hooks.before = null; fs.patch('pricingSettings/current', { updatedBy: 'zacb' }); };
  const raced = settingsUpdate({ settingsVersion: 'owner-3' }, { expectedRevision: first.settings.revision });
  const lost = await json(await post(h, raced));
  assert.deepEqual([lost.status, lost.body.code], [409, 'catalog_revision_conflict']);
  assert.equal(fs.get(`catalogOperations/${raced.requestId}`), null);
  assert.equal(auditRows(fs).length, 1, 'a rejected commit leaves no audit entry');
  assert.equal(fs.get('pricingSettings/current').settingsVersion, 'owner-2026-09-28');
  fs.hooks.respond = () => { fs.hooks.respond = null; return new Response('', { status: 412 }); };
  const precondition = await json(await post(h, settingsUpdate({ settingsVersion: 'owner-412' }, { expectedRevision: fs.revision('pricingSettings/current') })));
  assert.deepEqual([precondition.status, precondition.body.code], [409, 'catalog_revision_conflict']);
  // ABORTED (contention) applied nothing and is not an editing conflict: the owner retries the same request.
  const contended = settingsUpdate({ settingsVersion: 'owner-aborted' }, { expectedRevision: fs.revision('pricingSettings/current') });
  fs.hooks.respond = () => { fs.hooks.respond = null; return Response.json({ error: { code: 409, status: 'ABORTED', message: 'Too much contention on these documents. Please try again.' } }, { status: 409 }); };
  const aborted = await json(await post(h, contended));
  assert.deepEqual([aborted.status, aborted.body.code], [503, 'catalog_outcome_unknown']);
  const retried = await json(await post(h, contended));
  assert.deepEqual([retried.status, retried.body.replayed, retried.body.settings.settingsVersion], [200, false, 'owner-aborted']);
});

test('turning mustSetBeforeCustomerUse off takes the owner\'s explicit confirmation', async () => {
  const fs = firestore(), h = handlers(owner, fs);
  const refused = await json(await post(h, settingsUpdate({ mustSetBeforeCustomerUse: false })));
  assert.deepEqual([refused.status, refused.body.code], [400, 'catalog_customer_use_unconfirmed']);
  assert.equal((await json(await post(h, settingsUpdate({ mustSetBeforeCustomerUse: false }, { confirmCustomerUse: false })))).body.code, 'catalog_customer_use_unconfirmed');
  assert.equal((await json(await post(h, settingsUpdate({ mustSetBeforeCustomerUse: false }, { confirmCustomerUse: 'yes' })))).body.code, 'catalog_request_invalid');
  assert.equal(fs.writes(), 0);
  const released = await json(await post(h, settingsUpdate({ mustSetBeforeCustomerUse: false }, { confirmCustomerUse: true })));
  assert.deepEqual([released.status, released.body.settings.readyForCustomers], [200, true]);
  assert.equal((await json(await get(handlers(manager, fs)))).body.settings.readyForCustomers, true);
  const kept = await json(await post(h, settingsUpdate({ mustSetBeforeCustomerUse: false, settingsVersion: 'owner-2', laborRateCents: 8000 }, { expectedRevision: released.body.settings.revision })));
  assert.deepEqual([kept.status, kept.body.settings.readyForCustomers], [200, true], 'already released settings keep customer use without a new confirmation');
  const blocked = await json(await post(h, settingsUpdate({ mustSetBeforeCustomerUse: true, settingsVersion: 'owner-3' }, { expectedRevision: kept.body.settings.revision })));
  assert.deepEqual([blocked.status, blocked.body.settings.readyForCustomers], [200, false], 'blocking customer use again needs no confirmation');
  const again = await json(await post(h, settingsUpdate({ mustSetBeforeCustomerUse: false, settingsVersion: 'owner-4' }, { expectedRevision: blocked.body.settings.revision })));
  assert.equal(again.body.code, 'catalog_customer_use_unconfirmed', 'every release from placeholder status is confirmed');
});

test('settings are validated, need a revision field and a new version label', async () => {
  const fs = firestore(), h = handlers(owner, fs);
  const invalid = await json(await post(h, settingsUpdate({ laborRateCents: 0 })));
  assert.deepEqual([invalid.status, invalid.body.code, invalid.body.details.path], [400, 'catalog_settings_invalid', 'settings.laborRateCents']);
  assert.equal((await json(await post(h, settingsUpdate({ markupPct: { default: 20, byCategory: { services: 10 } } })))).body.code, 'catalog_settings_invalid');
  assert.equal((await json(await post(h, settingsUpdate({ currency: 'CAD' })))).body.code, 'catalog_settings_invalid');
  assert.equal((await json(await post(h, settingsUpdate({}, { actorId: 'zacb' })))).body.code, 'catalog_request_invalid');
  const missing = settingsUpdate(); delete missing.expectedRevision;
  assert.equal((await json(await post(h, missing))).body.code, 'catalog_request_invalid');
  const same = await json(await post(h, settingsUpdate({ settingsVersion: defaults.settingsVersion, laborRateCents: 8000 })));
  assert.deepEqual([same.status, same.body.code], [400, 'catalog_settings_version_unchanged']);
  for (const label of ['.', '..', '-:.']) {
    const response = await json(await post(h, settingsUpdate({ settingsVersion: label })));
    assert.deepEqual([response.status, response.body.code, response.body.details?.path], [400, 'catalog_settings_invalid', 'settings.settingsVersion'], label);
  }
  assert.equal(fs.writes(), 0);
});

test('a settings version label is never reused, so the settingsVersion a quote records names one set of values', async () => {
  const fs = firestore(), h = handlers(owner, fs);
  const save = async (settingsVersion, laborRateCents) => json(await post(h, settingsUpdate({ settingsVersion, laborRateCents }, { expectedRevision: fs.revision('pricingSettings/current') })));
  assert.equal((await save('v1', 8000)).status, 200);
  assert.equal((await save('v2', 9000)).status, 200);
  const reused = await save('v1', 12000);
  assert.deepEqual([reused.status, reused.body.code, reused.body.details], [409, 'catalog_settings_version_used', { settingsVersion: 'v1' }]);
  const placeholder = await save(defaults.settingsVersion, 12000);
  assert.deepEqual([placeholder.status, placeholder.body.code], [409, 'catalog_settings_version_used'], 'the placeholder label always names the defaults');
  assert.equal((await save('v2', 12000)).body.code, 'catalog_settings_version_unchanged');
  assert.deepEqual([fs.writes(), fs.get('pricingSettings/current').settingsVersion], [2, 'v2']);
  assert.deepEqual(['v1', 'v2'].map(label => fs.get(`pricingSettingsVersions/${label}`).settings.laborRateCents), [8000, 9000]);
  // Labels are case-sensitive ids; the create-only record also stops a label two tabs pick at once.
  assert.equal((await save('V1', 12000)).status, 200);
  const raced = settingsUpdate({ settingsVersion: 'v3' }, { expectedRevision: fs.revision('pricingSettings/current') });
  fs.hooks.before = () => { fs.hooks.before = null; fs.put('pricingSettingsVersions/v3', { settingsVersion: 'v3' }); };
  const lost = await json(await post(h, raced));
  assert.deepEqual([lost.status, lost.body.code, fs.get('pricingSettings/current').settingsVersion], [409, 'catalog_revision_conflict', 'V1']);
});

test('a confirmed settings commit reports its own revision even when another tab saves right after it', async () => {
  const fs = firestore(), h = handlers(owner, fs), request = settingsUpdate();
  fs.hooks.after = () => { fs.hooks.after = null; fs.patch('pricingSettings/current', { requestId: 'another-tab' }); };
  const { status, body } = await json(await post(h, request));
  assert.deepEqual([status, body.replayed, body.settings.current, body.settings.settingsVersion, body.settings.updatedBy], [200, false, true, 'owner-2026-09-28', 'zacb']);
  assert.equal(body.settings.revision, fs.docs.get(`catalogOperations/${request.requestId}`).updateTime, 'the revision is the commit write result');
  assert.notEqual(body.settings.revision, fs.revision('pricingSettings/current'));
  // A commit answer without write results falls back to reading the settings back.
  const base = catalogStorage({}, fs.fetcher), quiet = { read: base.read, commit: async writes => { await base.commit(writes); return {}; } };
  const next = await mutateCatalog(quiet, owner, settingsUpdate({ settingsVersion: 'owner-2' }, { expectedRevision: fs.revision('pricingSettings/current') }), NOW);
  assert.deepEqual([next.replayed, next.settings.current, next.settings.revision], [false, true, fs.revision('pricingSettings/current')]);
  const busy = { read: base.read, commit: async writes => { await base.commit(writes); fs.patch('pricingSettings/current', { requestId: 'another-tab' }); return {}; } };
  const late = await mutateCatalog(busy, owner, settingsUpdate({ settingsVersion: 'owner-3' }, { expectedRevision: fs.revision('pricingSettings/current') }), NOW);
  assert.deepEqual([late.replayed, late.settings.current, late.settings.revision, late.settings.settingsVersion], [false, false, null, 'owner-3'], 'saved, but no longer the settings in force');
});

test('a settings replay returns the saved result; the same requestId with another body or after a newer save conflicts', async () => {
  const fs = firestore(), h = handlers(owner, fs), request = settingsUpdate({ laborRateCents: 8200 });
  const first = (await json(await post(h, request))).body;
  const replay = await json(await post(h, request));
  assert.deepEqual([replay.status, replay.body.replayed, replay.body.settings], [200, true, first.settings]);
  assert.equal(fs.writes(), 1, 'a replay writes nothing');
  const changed = await json(await post(h, { ...request, settings: settings({ laborRateCents: 8300 }) }));
  assert.deepEqual([changed.status, changed.body.code], [409, 'catalog_idempotency_conflict']);
  await json(await post(h, settingsUpdate({ settingsVersion: 'owner-2' }, { expectedRevision: first.settings.revision })));
  const late = await json(await post(h, request));
  assert.deepEqual([late.status, late.body.code], [409, 'catalog_changed_since_operation']);
  // A lost commit response is recovered from the receipt instead of being reported as a failure.
  const lost = settingsUpdate({ settingsVersion: 'owner-3' }, { expectedRevision: fs.revision('pricingSettings/current') });
  fs.hooks.after = () => { fs.hooks.after = null; throw new Error('connection reset'); };
  const recovered = await json(await post(h, lost));
  assert.deepEqual([recovered.status, recovered.body.replayed, recovered.body.settings.settingsVersion], [200, true, 'owner-3']);
  assert.equal(auditRows(fs).length, 3);
});

test('catalog.publish stores an immutable version, moves the pointer and audits it in one commit', async () => {
  const fs = firestore(), h = handlers(owner, fs), request = publishRequest();
  const { status, body } = await json(await post(h, request));
  assert.equal(status, 200);
  const catalogJson = JSON.stringify(request.catalog), sha256 = createHash('sha256').update(catalogJson).digest('hex');
  assert.deepEqual(body, { ok: true, authority: 'employee_hub', action: 'catalog.publish', requestId: request.requestId, replayed: false,
    publication: { source: 'firestore', version: '2026-09-28.1', basedOnVersion: '2026-09-27.1', sha256, itemCount: 250, publishedAt: NOW, publishedBy: 'zacb', revision: fs.revision('catalogVersions/current'), current: true } });
  assert.deepEqual(fs.calls.reads, [`catalogOperations/${request.requestId}`, 'catalogVersions/current', 'catalogVersions/2026-09-28.1']);
  assert.equal(fs.calls.commits.length, 1);
  const [keys] = fs.calls.commits;
  assert.deepEqual(keys.slice(0, 3), ['catalogVersions/current', 'catalogVersions/2026-09-28.1', `catalogOperations/${request.requestId}`]);
  assert.match(keys[3], /^hub_audit\//);
  const snapshot = fs.get('catalogVersions/2026-09-28.1');
  assert.deepEqual({ ...snapshot, catalogJson: undefined }, { catalogVersion: '2026-09-28.1', basedOnVersion: '2026-09-27.1', catalogJson: undefined, sha256, itemCount: 250, generatedOn: '2026-09-28', schemaVersion: 1, publishedAt: NOW, publishedBy: 'zacb', requestId: request.requestId });
  assert.equal(snapshot.catalogJson, catalogJson);
  assert.deepEqual(fs.get('catalogVersions/current'), { version: '2026-09-28.1', basedOnVersion: '2026-09-27.1', sha256, itemCount: 250, publishedAt: NOW, publishedBy: 'zacb', requestId: request.requestId });
  const [audit] = auditRows(fs);
  assert.deepEqual([audit.action, audit.visibility, audit.entityKey, audit.requestId], ['catalog.publish', 'business', 'catalogVersions/2026-09-28.1', request.requestId]);
  assert.deepEqual(JSON.parse(audit.before), { version: '2026-09-27.1', source: 'seed' });
  assert.deepEqual(JSON.parse(audit.after), { version: '2026-09-28.1', generatedOn: '2026-09-28', itemCount: 250, sha256 });
  const read = (await json(await get(handlers(manager, fs)))).body;
  assert.deepEqual([read.publication.source, read.publication.version, read.publication.revision], ['firestore', '2026-09-28.1', body.publication.revision]);
  assert.deepEqual(read.catalog, summaryOf(request.catalog));
  assert.deepEqual((await json(await get(handlers(manager, fs), '?view=full'))).body.catalog, request.catalog);
  const priced = request.catalog.items.find(item => item.id === activeProduct.id);
  assert.equal(read.prices[activeProduct.id].unitCents, catalogLine(priced, defaults).unitCents);
  assert.equal(read.prices[activeProduct.id].split.productCents, activeProduct.retailPriceHighCents + 1000, 'the published cost is what prices the item');
  // The next publish must build on the new version.
  const next = await json(await post(h, publishRequest(nextCatalog('2026-09-28.2'), { basedOnVersion: '2026-09-28.1' })));
  assert.deepEqual([next.status, next.body.publication.basedOnVersion], [200, '2026-09-28.1']);
  assert.equal(fs.get('catalogVersions/2026-09-28.1').catalogJson, catalogJson, 'published versions are never rewritten');
  assert.equal(JSON.parse(auditRows(fs).find(row => row.entityKey === 'catalogVersions/2026-09-28.2').before).source, 'firestore');
});

test('a publish replay is idempotent, a changed fingerprint conflicts and a lost response is recovered', async () => {
  const fs = firestore(), h = handlers(owner, fs), request = publishRequest();
  const first = (await json(await post(h, request))).body;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const replay = await json(await post(h, request));
    assert.deepEqual([replay.status, replay.body.replayed, replay.body.publication], [200, true, first.publication]);
  }
  assert.equal(fs.writes(), 1);
  const changed = await json(await post(h, { ...request, catalog: nextCatalog('2026-09-28.1', 2000) }));
  assert.deepEqual([changed.status, changed.body.code], [409, 'catalog_idempotency_conflict']);
  const rebased = await json(await post(h, { ...request, basedOnVersion: '2026-09-28.1' }));
  assert.equal(rebased.body.code, 'catalog_idempotency_conflict');
  const otherActor = await mutateCatalog(catalogStorage({}, fs.fetcher), { ...owner, user: 'ZacB ' }, request, NOW);
  assert.equal(otherActor.replayed, true, 'the actor is the normalized owner username');
  // Once superseded the replay still answers with its own version and says it is no longer current.
  await json(await post(h, publishRequest(nextCatalog('2026-09-28.2'), { basedOnVersion: '2026-09-28.1' })));
  const old = (await json(await post(h, request))).body;
  assert.deepEqual([old.replayed, old.publication.version, old.publication.current, old.publication.revision], [true, '2026-09-28.1', false, null]);
  const lost = publishRequest(nextCatalog('2026-09-28.3'), { basedOnVersion: '2026-09-28.2' });
  fs.hooks.after = () => { fs.hooks.after = null; throw new Error('response lost'); };
  const recovered = await json(await post(h, lost));
  assert.deepEqual([recovered.status, recovered.body.replayed, recovered.body.publication.current], [200, true, true]);
  assert.equal(auditRows(fs).length, 3, 'each published version has exactly one audit entry');
});

test('publish preconditions: basedOnVersion, a newer and unused version, a valid catalog dated today or earlier, and size', async () => {
  const fs = firestore(), h = handlers(owner, fs);
  const expect = async (body, status, code) => { const response = await json(await post(h, body)); assert.deepEqual([response.status, response.body.code], [status, code]); return response.body; };
  const stale = await expect(publishRequest(undefined, { basedOnVersion: '2026-09-26.1' }), 409, 'catalog_version_conflict');
  assert.deepEqual(stale.details, { currentVersion: '2026-09-27.1' });
  await expect(publishRequest(nextCatalog('2026-09-27.1')), 400, 'catalog_version_not_newer');
  await expect(publishRequest(undefined, { basedOnVersion: 'latest' }), 400, 'catalog_request_invalid');
  const invalid = nextCatalog(); invalid.items[0].retailPriceHighCents = invalid.items[0].retailPriceLowCents - 1;
  assert.equal((await expect(publishRequest(invalid), 400, 'catalog_invalid')).details.path, 'catalog.items[0].retailPriceHighCents');
  const imaged = nextCatalog(); imaged.items[0].pros = ['https://m.media-amazon.com/images/I/synthetic.jpg'];
  await expect(publishRequest(imaged), 400, 'catalog_invalid');
  // NOW is noon on 2026-09-28 in Denver; a catalog dated tomorrow is refused.
  await expect(publishRequest(nextCatalog('2026-09-29.1')), 400, 'catalog_version_future');
  const large = nextCatalog();
  for (const item of large.items) item.auditActions = [...item.auditActions, ...Array.from({ length: 3 }, (_, index) => `Synthetic audit note ${index} `.padEnd(500, 'x'))];
  const bytes = Buffer.byteLength(JSON.stringify(large));
  assert.ok(bytes > MAX_CATALOG_BYTES && bytes < 999000, `test catalog is ${bytes} bytes`);
  await expect(publishRequest(large), 413, 'catalog_too_large');
  fs.put('catalogVersions/2026-09-28.1', { catalogVersion: '2026-09-28.1', catalogJson: '{}' });
  await expect(publishRequest(), 409, 'catalog_version_exists');
  assert.equal(fs.writes(), 0);
  // Release numbers compare as numbers: .10 is later than .9.
  assert.equal((await json(await post(h, publishRequest(nextCatalog('2026-09-27.9'))))).status, 200);
  assert.equal((await json(await post(h, publishRequest(nextCatalog('2026-09-27.10'), { basedOnVersion: '2026-09-27.9' })))).status, 200);
  await expect(publishRequest(nextCatalog('2026-09-27.2'), { basedOnVersion: '2026-09-27.10' }), 400, 'catalog_version_not_newer');
});

test('two concurrent publishes over the same version leave exactly one on top', async () => {
  const fs = firestore(), h = handlers(owner, fs);
  const requests = [publishRequest(nextCatalog('2026-09-28.1')), publishRequest(nextCatalog('2026-09-28.2', 3000))];
  const results = await Promise.all(requests.map(async request => json(await post(h, request))));
  const winners = results.filter(result => result.status === 200), losers = results.filter(result => result.status !== 200);
  assert.equal(winners.length, 1);
  assert.deepEqual([losers[0].status, ['catalog_revision_conflict', 'catalog_version_conflict'].includes(losers[0].body.code)], [409, true]);
  const winner = winners[0].body.publication.version, loser = requests.find(request => request.catalog.catalogVersion !== winner);
  assert.equal(fs.get('catalogVersions/current').version, winner);
  assert.deepEqual([fs.get(`catalogVersions/${loser.catalog.catalogVersion}`), fs.get(`catalogOperations/${loser.requestId}`)], [null, null]);
  assert.equal(auditRows(fs).length, 1);
});

test('a stored version or settings record that fails verification fails closed and never falls back to the seed', async () => {
  const fs = firestore(), h = handlers(owner, fs);
  assert.equal((await json(await post(h, publishRequest()))).status, 200);
  // Each check is a new isolate (an empty verified-catalog cache), which verifies the stored snapshot again.
  const expectBroken = async details => { const { status, body } = await json(await get(handlers(manager, fs, NOW, new Map()))); assert.deepEqual([status, body.code, body.details, body.catalog], [503, 'catalog_storage_invalid', details, undefined]); };
  const original = fs.get('catalogVersions/2026-09-28.1'), sha = text => createHash('sha256').update(text).digest('hex');
  const tampered = JSON.parse(original.catalogJson); tampered.items.find(item => item.id === activeProduct.id).retailPriceHighCents = 1;
  fs.put('catalogVersions/2026-09-28.1', { ...original, catalogJson: JSON.stringify(tampered) });
  await expectBroken({ currentVersion: '2026-09-28.1' });
  // Re-signed by hand (snapshot and pointer hashes both match) into something that is not the published catalog.
  const resign = catalogJson => { fs.put('catalogVersions/2026-09-28.1', { ...original, catalogJson, sha256: sha(catalogJson) }); fs.patch('catalogVersions/current', { sha256: sha(catalogJson) }); };
  resign(JSON.stringify(tampered).replace('"schemaVersion":1', '"schemaVersion":2'));
  await expectBroken({ currentVersion: '2026-09-28.1' });
  resign(JSON.stringify({ ...tampered, items: tampered.items.slice(1) }));
  await expectBroken({ currentVersion: '2026-09-28.1' });
  resign('{"catalogVersion":"2026-09-28.1"');
  await expectBroken({ currentVersion: '2026-09-28.1' });
  fs.docs.delete('catalogVersions/2026-09-28.1');
  await expectBroken({ currentVersion: '2026-09-28.1' });
  fs.patch('catalogVersions/current', { sha256: 'not-a-hash' });
  await expectBroken({ currentVersion: '2026-09-28.1' });
  // The owner repairs a broken catalog by publishing over the pointer's version (details.currentVersion).
  const repaired = await json(await post(h, publishRequest(nextCatalog('2026-09-28.2'), { basedOnVersion: '2026-09-28.1' })));
  assert.equal(repaired.status, 200);
  assert.equal((await json(await get(handlers(manager, fs, NOW, new Map())))).status, 200);
  fs.put('pricingSettings/current', { settings: { ...defaults, laborRateCents: -5 }, settingsVersion: defaults.settingsVersion, requestId: 'console-edit' });
  await expectBroken({ currentRevision: fs.revision('pricingSettings/current') });
  // The owner replaces unreadable settings at their revision; releasing them still needs confirmation.
  const repair = settingsUpdate({ mustSetBeforeCustomerUse: false }, { expectedRevision: fs.revision('pricingSettings/current') });
  assert.equal((await json(await post(h, repair))).body.code, 'catalog_customer_use_unconfirmed');
  assert.equal((await json(await post(h, { ...repair, requestId: randomUUID(), confirmCustomerUse: true }))).status, 200);
  assert.equal((await json(await get(handlers(manager, fs)))).body.settings.readyForCustomers, true);
});

test('an unreadable published pointer is replaced through the API by publishing over basedOnVersion null', async () => {
  const fs = firestore(), h = handlers(owner, fs);
  const expect = async (body, status, code, details) => { const response = await json(await post(h, body)); assert.deepEqual([response.status, response.body.code, response.body.details], [status, code, details]); };
  // null only replaces an unreadable pointer: over the seed or a readable pointer it is a version conflict.
  await expect(publishRequest(undefined, { basedOnVersion: null }), 409, 'catalog_version_conflict', { currentVersion: '2026-09-27.1' });
  assert.equal((await json(await post(h, publishRequest()))).status, 200);
  await expect(publishRequest(nextCatalog('2026-09-28.2'), { basedOnVersion: null }), 409, 'catalog_version_conflict', { currentVersion: '2026-09-28.1' });
  fs.patch('catalogVersions/current', { version: 'latest' });
  const broken = await json(await get(handlers(manager, fs)));
  assert.deepEqual([broken.status, broken.body.code, broken.body.details], [503, 'catalog_storage_invalid', { currentVersion: null }]);
  await expect(publishRequest(nextCatalog('2026-09-28.2'), { basedOnVersion: '2026-09-28.1' }), 409, 'catalog_version_conflict', { currentVersion: null });
  await expect(publishRequest(nextCatalog('2026-09-28.2'), { basedOnVersion: 'latest' }), 400, 'catalog_request_invalid', undefined);
  await expect(publishRequest(nextCatalog('2026-09-27.1'), { basedOnVersion: null }), 400, 'catalog_version_not_newer', { currentVersion: null });
  await expect(publishRequest(nextCatalog('2026-09-28.1'), { basedOnVersion: null }), 409, 'catalog_version_exists', undefined);
  const managerTry = await json(await post(handlers(manager, fs), publishRequest(nextCatalog('2026-09-28.2'), { basedOnVersion: null })));
  assert.deepEqual([managerTry.status, managerTry.body.code], [403, 'catalog_owner_required']);
  assert.equal(fs.writes(), 1);
  const request = publishRequest(nextCatalog('2026-09-28.2'), { basedOnVersion: null });
  const repaired = await json(await post(h, request));
  assert.deepEqual([repaired.status, repaired.body.publication.version, repaired.body.publication.basedOnVersion, repaired.body.publication.current], [200, '2026-09-28.2', null, true]);
  assert.equal(fs.get('catalogVersions/2026-09-28.2').basedOnVersion, null);
  assert.deepEqual(JSON.parse(auditRows(fs).find(row => row.entityKey === 'catalogVersions/2026-09-28.2').before), { version: null, source: 'firestore', pointer: 'unreadable' }, 'the repair is audited');
  const read = await json(await get(handlers(manager, fs)));
  assert.deepEqual([read.status, read.body.publication.version, read.body.publication.basedOnVersion], [200, '2026-09-28.2', null]);
  assert.equal((await json(await post(h, request))).body.replayed, true);
  await expect(publishRequest(nextCatalog('2026-09-28.3'), { basedOnVersion: null }), 409, 'catalog_version_conflict', { currentVersion: '2026-09-28.2' });
});

test('a warm isolate reads only the pointer and the settings; a cold one verifies the snapshot against the pointer hash', async () => {
  const fs = firestore(), h = handlers(owner, fs);
  assert.equal((await json(await post(h, publishRequest(nextCatalog('2026-09-28.1', 4321))))).status, 200);
  const read = async (query = '', cache = fs.cache) => { fs.calls.reads.length = 0; const response = await json(await get(handlers(manager, fs, NOW, cache), query)); return { ...response, reads: [...fs.calls.reads].sort() }; };
  const cold = await read();
  assert.deepEqual([cold.status, cold.reads], [200, ['catalogVersions/2026-09-28.1', 'catalogVersions/current', 'pricingSettings/current']]);
  const warm = await read();
  assert.deepEqual([warm.status, warm.reads], [200, ['catalogVersions/current', 'pricingSettings/current']]);
  assert.deepEqual([warm.body.catalog, warm.body.prices, warm.body.stale, warm.body.publication], [cold.body.catalog, cold.body.prices, cold.body.stale, cold.body.publication]);
  assert.deepEqual((await read('?view=full')).reads, ['catalogVersions/current', 'pricingSettings/current']);
  // Snapshots are create-only and server-only: a warm isolate keeps the copy it verified, and a new isolate
  // checks the stored JSON against the pointer's hash again.
  const snapshot = fs.get('catalogVersions/2026-09-28.1');
  fs.put('catalogVersions/2026-09-28.1', { ...snapshot, catalogJson: snapshot.catalogJson.replace('"schemaVersion":1', '"schemaVersion":1 ') });
  assert.equal((await read()).status, 200);
  assert.equal((await read('', new Map())).body.code, 'catalog_storage_invalid');
  fs.put('catalogVersions/2026-09-28.1', snapshot);
  // New settings re-price the cached catalog without fetching it again.
  const saved = (await json(await post(h, settingsUpdate({ laborRateCents: 9100 })))).body;
  const repriced = await read();
  assert.deepEqual([repriced.reads, repriced.body.settings.revision], [['catalogVersions/current', 'pricingSettings/current'], saved.settings.revision]);
  const published = JSON.parse(snapshot.catalogJson).items.find(item => item.id === activeProduct.id);
  assert.deepEqual([repriced.body.prices[activeProduct.id].unitCents, warm.body.prices[activeProduct.id].unitCents], [catalogLine(published, saved.settings.values).unitCents, catalogLine(published, defaults).unitCents]);
  // A new publish moves the pointer: the next read verifies the new snapshot once.
  assert.equal((await json(await post(h, publishRequest(nextCatalog('2026-09-28.2', 4321), { basedOnVersion: '2026-09-28.1' })))).status, 200);
  assert.deepEqual((await read()).reads, ['catalogVersions/2026-09-28.2', 'catalogVersions/current', 'pricingSettings/current']);
  assert.deepEqual((await read()).reads, ['catalogVersions/current', 'pricingSettings/current']);
  const state = await readCatalogState(catalogStorage({}, fs.fetcher), { cache: fs.cache });
  assert.ok(Object.isFrozen(state.catalog.items[0].sources), 'the shared verified catalog cannot be mutated by a caller');
});

test('Firestore REST failures map to unavailable, conflict, rejected and unknown outcomes', async () => {
  const fs = firestore(), h = handlers(owner, fs);
  fs.hooks.read = () => new Response('upstream', { status: 500 });
  const unavailable = await json(await get(h));
  assert.deepEqual([unavailable.status, unavailable.body.code, unavailable.body.catalog], [503, 'catalog_storage_unavailable', undefined]);
  fs.hooks.read = key => key === 'catalogVersions/current' ? Response.json({ name: `${ROOT}catalogVersions/other`, fields: {}, updateTime: '2026-09-28T00:00:00Z' }) : null;
  assert.equal((await json(await get(h))).body.code, 'catalog_storage_incomplete');
  fs.hooks.read = key => key === 'pricingSettings/current' ? Response.json({ name: `${ROOT}pricingSettings/current`, fields: {} }) : null;
  assert.equal((await json(await get(h))).body.code, 'catalog_storage_incomplete');
  // A 404 is a missing document only when Firestore names that document; a missing database fails closed.
  const notFound = message => Response.json({ error: { code: 404, message, status: 'NOT_FOUND' } }, { status: 404 });
  for (const answer of [() => notFound('The database (default) does not exist for project egcw-1ec83 Please visit https://console.cloud.google.com/datastore/setup?project=egcw-1ec83 to add a Cloud Datastore or Cloud Firestore database.'),
    key => notFound(`Document "${ROOT}${key}/other" not found.`), key => notFound(`Document "${ROOT}x${key}" not found.`), key => notFound(`Document (${ROOT}${key}x) not found.`), () => new Response('', { status: 404 })]) {
    fs.hooks.read = answer;
    const missing = await json(await get(h));
    assert.deepEqual([missing.status, missing.body.code, missing.body.catalog], [503, 'catalog_storage_unavailable', undefined]);
  }
  // The emulator names the missing document in parentheses.
  fs.hooks.read = key => notFound(`Document (projects/demo-egc-field-rules/databases/(default)/documents/${key}) not found.`);
  assert.deepEqual([(await json(await get(h))).status, (await json(await get(h))).body.publication.source], [200, 'seed']);
  fs.hooks.read = null;
  const store = catalogStorage({}, fs.fetcher), write = [{ collection: 'pricingSettings', id: 'current', patch: { settingsVersion: 'x' } }];
  const answers = [[Response.json({ error: { code: 400, status: 'FAILED_PRECONDITION' } }, { status: 400 }), 'catalog_revision_conflict', 409],
    [Response.json({ error: { code: 409, status: 'ALREADY_EXISTS' } }, { status: 409 }), 'catalog_revision_conflict', 409],
    [new Response('', { status: 412 }), 'catalog_revision_conflict', 409],
    [notFound('The database (default) does not exist for project egcw-1ec83.'), 'catalog_storage_rejected', 503],
    [Response.json({ error: { code: 409, status: 'ABORTED', message: 'Too much contention on these documents. Please try again.' } }, { status: 409 }), 'catalog_outcome_unknown', 503],
    [new Response('conflict', { status: 409 }), 'catalog_outcome_unknown', 503],
    [Response.json({ error: { code: 400, status: 'INVALID_ARGUMENT' } }, { status: 400 }), 'catalog_storage_rejected', 503],
    [Response.json({ error: { code: 403, status: 'PERMISSION_DENIED' } }, { status: 403 }), 'catalog_storage_rejected', 503],
    [Response.json({ error: { code: 429, status: 'RESOURCE_EXHAUSTED' } }, { status: 429 }), 'catalog_outcome_unknown', 503],
    [new Response('bad gateway', { status: 502 }), 'catalog_outcome_unknown', 503]];
  for (const [answer, code, status] of answers) {
    fs.hooks.respond = () => answer;
    await assert.rejects(store.commit(write), error => error.code === code && error.status === status);
  }
  fs.hooks.respond = () => { throw new TypeError('network down'); };
  await assert.rejects(store.commit(write), error => error.code === 'catalog_outcome_unknown');
  // An unknown outcome with no receipt tells the owner to retry the same request.
  const response = await json(await post(h, settingsUpdate()));
  assert.deepEqual([response.status, response.body.code], [503, 'catalog_outcome_unknown']);
  fs.hooks.respond = null;
  assert.equal(fs.get('pricingSettings/current'), null);
  const unexpected = catalogHandlers({ session: async () => owner, storage: () => ({ read: async () => { throw new Error('private upstream detail'); } }), now: () => new Date(NOW) });
  const hidden = await json(await get(unexpected));
  assert.deepEqual([hidden.status, hidden.body.code], [503, 'catalog_unavailable']);
  assert.ok(!JSON.stringify(hidden.body).includes('private upstream detail'));
});

test('the non-internal projection (for the future sales role) carries no costs, sources, audit notes or hidden items', async () => {
  const state = await readCatalogState(catalogStorage({}, firestore().fetcher));
  const view = projectCatalogOverview(state, { internal: false, now: new Date(NOW) });
  const keys = new Set(), walk = value => { if (Array.isArray(value)) value.forEach(walk); else if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) { keys.add(key); walk(item); } };
  walk(view);
  for (const key of ['retailPriceLowCents', 'retailPriceHighCents', 'fixedPriceCents', 'sources', 'observedPrice', 'verificationNote', 'priceEvidence', 'auditLog', 'auditActions', 'auditStatus', 'legacy', 'priceBasis', 'installMinutes', 'split', 'productCents', 'laborCents', 'markupCents', 'durationMinutes', 'values', 'laborRateCents', 'markupPct', 'sha256', 'publishedBy']) assert.ok(!keys.has(key), `${key} must not reach a non-internal viewer`);
  const hidden = shipped.items.filter(item => item.availability === 'hidden').map(item => item.id);
  assert.ok(hidden.length > 0);
  for (const id of hidden) { assert.equal(view.prices[id], undefined); assert.ok(!view.catalog.items.some(item => item.id === id)); assert.ok(!view.stale.items.some(item => item.id === id)); }
  assert.deepEqual(view.prices[activeProduct.id], { quotable: true, stale: false, quantity: 1, unitCents: catalogLine(activeProduct, defaults).unitCents, totalCents: catalogLine(activeProduct, defaults).unitCents, customerSupplied: false });
  assert.deepEqual(view.settings, { revision: null, source: 'defaults', settingsVersion: defaults.settingsVersion, readyForCustomers: false });
});

test('real signed Hub sessions: the owner reads and writes, a manager reads only and crew is refused', async () => {
  const env = { ...ENV, HUB_SESSION_SECRET: 'synthetic-catalog-hub-session-secret-0123456789', HUB_AUTH_USERS_JSON: JSON.stringify({
    zacb: { passwordHash: 'synthetic', displayName: 'Synthetic Owner', role: 'owner' }, tylerg: { passwordHash: 'synthetic', displayName: 'Synthetic Manager', role: 'manager' }, crew1: { passwordHash: 'synthetic', displayName: 'Synthetic Crew', role: 'crew' } }) };
  // The cookie is issued and verified at NOW, exactly as getHubSession verifies it at the real clock.
  const at = Date.parse(NOW), session = (request, sessionEnv) => verifyHubSessionToken(sessionEnv, readCookie(request), at);
  const fs = firestore(), h = catalogHandlers({ session, storage: () => catalogStorage(env, fs.fetcher), now: () => new Date(NOW), cache: fs.cache });
  const cookie = async (user, issuedAt = at) => `egc_hub_session=${await createHubSessionToken(env, user, issuedAt)}`;
  const request = async (user, body) => json(await h[body ? 'post' : 'get']({ env, request: new Request(ENDPOINT, body ? { method: 'POST', headers: { Cookie: await cookie(user), Origin: ORIGIN, 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : { headers: { Cookie: await cookie(user) } }) }));
  assert.equal((await request('zacb')).status, 200);
  assert.equal((await request('tylerg')).body.viewer.canPublish, false);
  assert.equal((await request('crew1')).status, 403);
  assert.equal((await request('tylerg', settingsUpdate())).body.code, 'catalog_owner_required');
  assert.equal((await request('crew1', publishRequest())).status, 403);
  assert.equal((await request('zacb', settingsUpdate())).status, 200);
  assert.equal((await json(await h.get({ env, request: new Request(ENDPOINT, { headers: { Cookie: 'egc_hub_session=forged.token' } }) }))).status, 401);
  const expired = await json(await h.get({ env, request: new Request(ENDPOINT, { headers: { Cookie: await cookie('zacb', at - 12 * 60 * 60 * 1000) } }) }));
  assert.deepEqual([expired.status, expired.body.code], [401, 'catalog_sign_in_required'], 'a session issued 12 hours before NOW has expired');
});
