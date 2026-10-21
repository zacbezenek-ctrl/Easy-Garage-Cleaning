// The owner's targets and baselines (functions/_lib/owner-economics.js, /api/owner-economics): owner-entered settings
// that replaced the figures once hardcoded in pricing-config.js. Only the owner reads or writes them; blanks stay null;
// the crew wage is the Job actuals wage. Synthetic values only ($10.00 an hour and so on), never real pay or targets.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CURRENT, OWNER_ECONOMICS_KEYS, OWNER_ECONOMICS_SETTINGS, OWNER_ECONOMICS_SETTINGS_OPERATIONS, mutateOwnerEconomicsSettings, ownerEconomics, ownerEconomicsStorage, readOwnerEconomics, readOwnerEconomicsSettings } from '../functions/_lib/owner-economics.js';
import { JOB_ACTUALS_SETTINGS } from '../functions/_lib/job-actuals-settings.js';
import { ownerEconomicsHandlers } from '../functions/api/owner-economics.js';

const OWNER = { user: 'ZacB', role: 'owner', businessAccess: true, owner: true };
const MANAGER = { user: 'AlexK', role: 'manager', businessAccess: true, owner: false };
const CREW = { user: 'Synthetic.Crew', role: 'crew', businessAccess: false };
const BLANK = Object.fromEntries(OWNER_ECONOMICS_KEYS.map(key => [key, null]));
const SYNTHETIC = { laborCostCentsPerCrewHour: 1000, leadWageCentsPerHour: 1200, truckRentalLowCentsPerJob: 5000, truckRentalHighCentsPerJob: 7500, averageTicketTargetCents: 100000, walkthroughSetRateTargetBp: 4000, qualifiedCloseRateTargetBp: 6000 };
const body = (settings = {}, extra = {}) => ({ action: 'owner_economics.settings.set', requestId: crypto.randomUUID(), expectedRevision: null, settings: { ...BLANK, ...settings }, ...extra });

function memoryStore() {
  const docs = new Map(); let tick = 0;
  return { docs, async read(collection, id) { const row = docs.get(`${collection}/${id}`); return row ? structuredClone(row) : null; },
    async commit(writes) {
      for (const write of writes) { const current = docs.get(`${write.collection}/${write.id}`); if (write.revision ? current?.revision !== write.revision : current) throw Object.assign(new Error('conflict'), { code: 'owner_economics_revision_conflict', status: 409 }); }
      for (const write of writes) { const current = docs.get(`${write.collection}/${write.id}`) || {}; docs.set(`${write.collection}/${write.id}`, { ...current, ...structuredClone(write.patch), id: write.id, revision: `rev-${++tick}` }); }
    } };
}

test('only the owner saves the targets; blanks stay null, a replay is idempotent, a stale revision and an inverted range are refused', async () => {
  const store = memoryStore();
  assert.deepEqual(await readOwnerEconomicsSettings(store), { revision: null, updatedAt: null, updatedBy: null, ...BLANK });
  for (const [actor, code] of [[MANAGER, 'owner_economics_owner_required'], [CREW, 'owner_economics_owner_required'], [null, 'owner_economics_sign_in_required']])
    await assert.rejects(mutateOwnerEconomicsSettings(store, actor, body({ leadWageCentsPerHour: 1200 })), { code });
  await assert.rejects(mutateOwnerEconomicsSettings(store, OWNER, body({ leadWageCentsPerHour: 12.5 })), { code: 'owner_economics_amount_invalid' });
  await assert.rejects(mutateOwnerEconomicsSettings(store, OWNER, body({ walkthroughSetRateTargetBp: 10001 })), { code: 'owner_economics_amount_invalid' });
  await assert.rejects(mutateOwnerEconomicsSettings(store, OWNER, body({ truckRentalLowCentsPerJob: 8000, truckRentalHighCentsPerJob: 7500 })), { code: 'owner_economics_amount_invalid' });
  await assert.rejects(mutateOwnerEconomicsSettings(store, OWNER, { ...body(), settings: { leadWageCentsPerHour: 1 } }), { code: 'owner_economics_request_invalid' });
  await assert.rejects(mutateOwnerEconomicsSettings(store, OWNER, { ...body(), extra: 1 }), { code: 'owner_economics_request_invalid' });
  const first = body({ ...SYNTHETIC, truckRentalLowCentsPerJob: null, walkthroughSetRateTargetBp: 0 });
  const saved = await mutateOwnerEconomicsSettings(store, OWNER, first, '2026-10-21T18:00:00.000Z');
  assert.equal(saved.replayed, false);
  assert.equal(saved.settings.truckRentalLowCentsPerJob, null, 'a blank stays blank');
  assert.equal(saved.settings.walkthroughSetRateTargetBp, 0, 'an entered 0 is kept, unlike a blank');
  const audit = [...store.docs.entries()].find(([key]) => key.startsWith('hub_audit/'))?.[1];
  assert.equal(audit.visibility, 'owner'); assert.equal(audit.action, 'owner_economics.settings.set');
  assert.ok(store.docs.has(`${OWNER_ECONOMICS_SETTINGS_OPERATIONS}/${first.requestId}`));
  assert.equal((await mutateOwnerEconomicsSettings(store, OWNER, first)).replayed, true);
  await assert.rejects(mutateOwnerEconomicsSettings(store, OWNER, { ...first, settings: { ...first.settings, leadWageCentsPerHour: 1300 } }), { code: 'owner_economics_idempotency_conflict', status: 409 });
  await assert.rejects(mutateOwnerEconomicsSettings(store, OWNER, body({ leadWageCentsPerHour: 1300 })), { code: 'owner_economics_revision_conflict', status: 409 });
  const { revision } = await readOwnerEconomicsSettings(store);
  await assert.rejects(mutateOwnerEconomicsSettings(store, OWNER, { ...first, requestId: crypto.randomUUID(), expectedRevision: revision }), { code: 'owner_economics_no_change' });
  store.docs.set(`${OWNER_ECONOMICS_SETTINGS}/${CURRENT}`, { ...store.docs.get(`${OWNER_ECONOMICS_SETTINGS}/${CURRENT}`), leadWageCentsPerHour: 'lots' });
  await assert.rejects(readOwnerEconomicsSettings(store), { code: 'owner_economics_settings_invalid', status: 503 }, 'a damaged record fails closed');
});

test('the served owner part is dollars and whole percents, null where blank, with the crew wage from Job actuals', async () => {
  assert.deepEqual(ownerEconomics(SYNTHETIC, 1000), { laborCostPerCrewHour: 10, wages: { crew: 10, lead: 12 }, truckRentalPerJob: { low: 50, high: 75 }, targets: { averageTicket: 1000, walkthroughSetRatePct: 40, qualifiedCloseRatePct: 60 } });
  assert.deepEqual(ownerEconomics({}, null), { laborCostPerCrewHour: null, wages: { crew: null, lead: null }, truckRentalPerJob: { low: null, high: null }, targets: { averageTicket: null, walkthroughSetRatePct: null, qualifiedCloseRatePct: null } });
  const store = memoryStore(), jobActuals = memoryStore();
  jobActuals.docs.set(`${JOB_ACTUALS_SETTINGS}/current`, { schemaVersion: 1, wageCentsPerManHour: 1000, revision: 'rev-pay' });
  store.docs.set(`${OWNER_ECONOMICS_SETTINGS}/${CURRENT}`, { schemaVersion: 1, ...BLANK, leadWageCentsPerHour: 1200, revision: 'rev-1' });
  assert.deepEqual((await readOwnerEconomics({}, { store, jobActuals })).wages, { crew: 10, lead: 12 }, 'one crew wage: the Job actuals one');
  jobActuals.read = async () => { throw Object.assign(new Error('down'), { code: 'job_actuals_unavailable', status: 503 }); };
  await assert.rejects(readOwnerEconomics({}, { store, jobActuals }), { code: 'job_actuals_unavailable' }, 'a failed read is never a guessed number');
});

test('storage errors are renamed owner_economics_* with this card\'s own wording', async () => {
  const failing = ownerEconomicsStorage({}, { read: async () => { throw Object.assign(new Error('Standard costs could not be loaded. Retry.'), { code: 'standard_cost_unavailable', status: 503 }); },
    commit: async () => { throw Object.assign(new Error('Standard-cost storage refused this change.'), { code: 'standard_cost_storage_rejected', status: 503 }); } });
  await assert.rejects(failing.read(OWNER_ECONOMICS_SETTINGS, CURRENT), { code: 'owner_economics_unavailable', message: 'Owner targets could not be loaded. Retry.' });
  await assert.rejects(failing.commit([]), error => error.code === 'owner_economics_storage_rejected' && !/standard/i.test(error.message));
});

function api(actor = OWNER, store = memoryStore(), jobActuals = memoryStore()) {
  return { handlers: ownerEconomicsHandlers({ session: async () => actor, store: () => store, jobActuals: () => jobActuals }), store, jobActuals };
}
const get = (handlers, path = '/api/owner-economics') => handlers.get({ request: new Request(`https://easygaragecleaning.com${path}`), env: {} });
const post = (handlers, input, headers = {}) => handlers.post({ request: new Request('https://easygaragecleaning.com/api/owner-economics', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://easygaragecleaning.com', ...headers }, body: JSON.stringify(input) }), env: {} });

test('/api/owner-economics: the owner reads and saves; managers, crew and signed-out visitors get no figures', async () => {
  const { handlers, store, jobActuals } = api();
  jobActuals.docs.set(`${JOB_ACTUALS_SETTINGS}/current`, { schemaVersion: 1, wageCentsPerManHour: 1000, revision: 'rev-pay' });
  const saved = await post(handlers, body(SYNTHETIC));
  assert.equal(saved.status, 200); assert.equal((await saved.json()).settings.leadWageCentsPerHour, 1200);
  const read = await get(handlers), answer = await read.json();
  assert.equal(read.status, 200); assert.equal(read.headers.get('Cache-Control'), 'private, no-store');
  assert.deepEqual([answer.settings.averageTicketTargetCents, answer.crewWageCentsPerManHour], [100000, 1000]);
  for (const [actor, status, code] of [[MANAGER, 403, 'owner_economics_owner_required'], [CREW, 403, 'owner_economics_owner_required'], [null, 401, 'owner_economics_sign_in_required']]) {
    for (const response of [await get(api(actor, store, jobActuals).handlers), await post(api(actor, store, jobActuals).handlers, body({ leadWageCentsPerHour: 1 }))]) {
      const reply = await response.json();
      assert.deepEqual([response.status, reply.code], [status, code]);
      assert.doesNotMatch(JSON.stringify(reply), /1200|100000|Cents/, 'no figure reaches a non-owner');
    }
  }
  assert.equal((await get(handlers, '/api/owner-economics?x=1')).status, 400);
  assert.equal((await post(handlers, body({ leadWageCentsPerHour: 1300 }), { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await handlers.post({ request: new Request('https://easygaragecleaning.com/api/owner-economics', { method: 'POST', headers: { Origin: 'https://easygaragecleaning.com' }, body: 'x' }), env: {} })).status, 415);
  // The crew wage is display-only: when Job actuals cannot be read the owner's own settings still load.
  jobActuals.read = async () => { throw new Error('down'); };
  const partial = await (await get(handlers)).json();
  assert.equal(partial.crewWageCentsPerManHour, null); assert.equal(partial.settings.leadWageCentsPerHour, 1200);
});

test('the owner settings are server-only in firestore.rules, and pricing-config.js holds no owner figure', () => {
  const rules = readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8');
  for (const collection of [OWNER_ECONOMICS_SETTINGS, OWNER_ECONOMICS_SETTINGS_OPERATIONS]) assert.match(rules, new RegExp(`match /${collection}/\\{documentId\\} \\{\\s*allow read, write: if false;\\s*\\}`));
  const source = readFileSync(new URL('../functions/_lib/pricing-config.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /OWNER_ECONOMICS|laborCostPerCrewHour|truckRentalPerJob|averageTicket|wages\s*:/, 'the owner\'s numbers are settings, not code');
});
