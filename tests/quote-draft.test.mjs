import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { QUOTE_DRAFT_RECEIPTS, expireStaleCheckout, normalizeQuoteDraft, previewQuoteSend, readQuoteDraft, saveQuoteDraft, sendQuoteDraft } from '../functions/_lib/quote-draft.js';
import { quoteDraftHandlers } from '../functions/api/quote-draft.js';
import { createEstimateReadyDelivery, estimateReadySendKey, ESTIMATE_READY_TAG } from '../functions/_lib/estimate-ready.js';
import { prepareHandoff, saveWalkthroughHandoff } from '../functions/_lib/walkthrough-handoff.js';
import { handoffHandlers } from '../functions/api/walkthrough-handoff.js';
import { projectReleased } from '../functions/_lib/business-hub-core.js';
import { checkoutFingerprint } from '../functions/_lib/customer-payments.js';
import { MESSAGE_SENDS, ledgerId } from '../functions/_lib/message-send-store.js';
import { createGhlMessenger } from '../functions/_lib/ghl-messenger.js';
import { CONFIRM_TOKEN_COLLECTION } from '../functions/_lib/confirm-token.js';
import { readFileSync } from 'node:fs';
import { priceCatalogQuote } from '../functions/_lib/catalog-quote.js';

const NOW = '2026-09-22T18:00:00.000Z';
const LATER = '2026-09-22T18:02:00.000Z';
const owner = { user: 'zacb', role: 'owner', businessAccess: true, displayName: 'Synthetic Owner' };
const sales = { user: 'sales.person', role: 'sales', businessAccess: false, displayName: 'Synthetic Sales', staffRoles: ['sales'] };
const crew = { user: 'crew.person', role: 'crew', businessAccess: false, displayName: 'Synthetic Crew', staffRoles: ['crew'] };
const ENV = { HUB_SESSION_SECRET: 'synthetic-quote-draft-session-secret-0123456789' };
const ROLES = { ...ENV, EGC_STAFF_ROLE_PERMISSIONS: 'true' };
const MESSAGING = { ...ENV, EGC_MESSAGING_ENABLED: 'true', EGC_MESSAGING_DRY_RUN: 'false', HIGHLEVEL_API_KEY: 'synthetic-ghl-token', HIGHLEVEL_LOCATION_ID: 'location-1' };
const CATALOG_ENV = { ...ENV, CATALOG_QUOTES_ENABLED: 'true' };
const CATALOG_NOW = '2026-09-30T18:00:00.000Z';
const catalogState = () => {
  const catalog = JSON.parse(readFileSync(new URL('../functions/_data/garage-catalog.json', import.meta.url), 'utf8'));
  const settings = JSON.parse(readFileSync(new URL('../functions/_data/pricing-settings.defaults.json', import.meta.url), 'utf8'));
  Object.assign(settings, { mustSetBeforeCustomerUse: false, depositPct: 30 });
  return { catalog, publication: { version: catalog.catalogVersion }, settings };
};
const catalogSelection = state => ({ catalogVersion: state.catalog.catalogVersion, settingsVersion: state.settings.settingsVersion,
  items: [{ id: 'catalog-1', itemId: 'overhead-rack-fleximounts-gr48-classic-4x8', quantity: 1, customerSupplied: false }] });

const shelf = { id: 'shelving', label: 'Shelving', selection: 'single', required: true };
// Good/better/best shelving with "better" pre-selected, plus a declined optional add-on.
const lines = () => [
  { id: 'cleanout', kind: 'service', name: 'Garage cleanout and reset', description: 'Sorting, hauling and disposal', quantity: 1, unitCents: 90000, totalCents: 90000 },
  { id: 'shelf-good', kind: 'product', name: 'Plastic shelving unit', quantity: 2, unitCents: 34900, totalCents: 69800, group: shelf, tier: 'good', selected: false },
  { id: 'shelf-better', kind: 'product', name: 'Wood shelving unit', quantity: 2, unitCents: 44900, totalCents: 89800, group: shelf, tier: 'better', selected: true },
  { id: 'shelf-best', kind: 'product', name: 'Metal shelving unit', quantity: 2, unitCents: 49900, totalCents: 99800, group: shelf, tier: 'best', selected: false },
  { id: 'totes', kind: 'product', name: 'Storage tote', quantity: 6, unitCents: 2150, totalCents: 12900, optional: true, selected: false },
];
const client = () => ({ name: 'Synthetic Customer', phone: '9705550100', email: 'test@example.invalid', address: '100 Fixture Lane', highlevel_contact_id: 'provider1' });
const draft = (change = () => {}) => { const value = { client: client(), title: 'Garage reset options', scope: 'Cleanout plus your choice of shelving.', line_items: lines(), valid_until: '2026-10-06', catalog_version: '2026-09-22.1', crew_size: 2, estimated_duration_min: 240 }; change(value); return value; };

function fixture() {
  const rows = new Map([
    ['customers/c1', { id: 'c1', revision: 'c1r', name: 'Synthetic Customer', phone: '9705550100', email: 'test@example.invalid', address: '100 Fixture Lane', highlevelContactId: 'provider1' }],
    ['customers/c2', { id: 'c2', revision: 'c2r', name: 'Synthetic Other', phone: '9705550199', email: 'other@example.invalid', address: '200 Fixture Lane', highlevelContactId: 'provider2' }],
    ['jobs/w1', { id: 'w1', revision: 'w1r', type: 'walkthrough', status: 'completed', pipelineStatus: 'completed', completedAt: '2026-09-22T17:00:00.000Z', customerId: 'c1', customer: 'Synthetic Customer', highlevelContactId: 'provider1', highlevelAppointmentId: 'walk-provider', date: '2026-09-22', time: '11:00', endTime: '12:00', projectId: 'p1', payment: { verified: true, amount: 90 } }],
    ['jobs/w2', { id: 'w2', revision: 'w2r', type: 'walkthrough', status: 'scheduled', pipelineStatus: 'scheduled', customerId: 'c2', customer: 'Synthetic Other', date: '2026-09-22', time: '13:00', endTime: '14:00' }],
    ['projects/p1', { id: 'p1', revision: 'p1r', customerId: 'c1', sourceRecordId: 'w1', sourceWalkthroughId: 'w1' }],
  ]);
  let n = 0, before = () => {}, after = () => {};
  const calls = [], delivered = [];
  const roster = [{ id: 'zacb', name: 'Synthetic Owner', role: 'owner' }, { id: 'crew1', name: 'Crew One', role: 'crew' }];
  const list = prefix => [...rows].filter(([key]) => key.startsWith(prefix)).map(([, value]) => structuredClone(value));
  const store = {
    read: async (collection, id) => structuredClone(rows.get(`${collection}/${id}`) || null),
    jobs: async () => list('jobs/'), resources: async () => [], customers: async () => list('customers/'), roster: async () => structuredClone(roster),
    commit: async writes => {
      before(writes);
      const keys = new Set();
      for (const write of writes) {
        const key = `${write.collection}/${write.id}`, old = rows.get(key);
        assert.ok(!keys.has(key), `one write per document: ${key}`); keys.add(key);
        if (write.revision ? old?.revision !== write.revision : Boolean(old)) throw Object.assign(new Error('Conflict'), { code: 'dispatch_revision_conflict', status: 409 });
      }
      calls.push(structuredClone(writes));
      for (const write of writes) if (!write.verify) { const key = `${write.collection}/${write.id}`; rows.set(key, { ...rows.get(key), ...structuredClone(write.patch), id: write.id, revision: `r${++n}` }); }
      after(writes);
    },
  };
  const deliver = async (jobId, context) => { delivered.push({ jobId, ...context }); return { status: 'submitted', attempts: 1 }; };
  const input = (change = {}) => ({ requestId: randomUUID(), customerId: 'c1', sourceWalkthroughId: 'w1', sourceRevision: rows.get('jobs/w1').revision, draft: draft(), ...change });
  return { rows, store, calls, delivered, deliver, input, before: fn => { before = fn; }, after: fn => { after = fn; }, job: id => rows.get(`jobs/${id}`), writesTo: collection => calls.flat().filter(write => write.collection === collection) };
}
const save = (f, value, actor = owner, env = ENV, at = NOW, options = {}) => saveQuoteDraft(f.store, actor, value, at, { env, ...options });
const revise = (f, jobId, change = () => {}, extra = {}) => ({ requestId: randomUUID(), customerId: 'c1', sourceWalkthroughId: 'w1', jobId, expectedRevision: f.job(jobId).revision, draft: draft(change), ...extra });
async function sendFlow(f, jobId, { actor = owner, env = ENV, deliver = f.deliver } = {}) {
  const preview = await previewQuoteSend(f.store, actor, { jobId, expectedRevision: f.job(jobId).revision }, NOW, { env });
  const body = { requestId: randomUUID(), jobId, expectedRevision: f.job(jobId).revision, confirmToken: preview.confirmToken };
  return { preview, body, result: await sendQuoteDraft(f.store, actor, body, LATER, { env, deliver }) };
}

test('a walkthrough quote with good/better/best options is saved as a draft on an unscheduled job; the walkthrough and customer are untouched and nothing is sent', async () => {
  const f = fixture(), walkthrough = structuredClone(f.rows.get('jobs/w1')), value = f.input(), result = await save(f, value);
  const job = f.job(result.job.id);
  assert.equal(result.replayed, false);
  assert.deepEqual([job.type, job.status, job.pipelineStatus, job.date, job.time, job.customerId, job.projectId, job.sourceWalkthroughId, job.scheduleSource], ['job', 'unscheduled', 'unscheduled', '', '', 'c1', 'p1', 'w1', 'egc_hub']);
  assert.deepEqual([job.estimate.status, job.estimate.revision, job.estimate.amount, job.estimate.amountCents, job.estimate.depositRequiredCents, job.estimate.source, job.quoteStatus, job.total], ['draft', 1, 1798, 179800, 89900, 'quote_draft', 'draft', 1798]);
  assert.equal(job.estimate.number, `EST-${job.id.slice(-6).toUpperCase()}`);
  assert.deepEqual(job.estimate.lineItems.map(line => [line.id, line.selected, line.tier]), [['cleanout', true, null], ['shelf-good', false, 'good'], ['shelf-better', true, 'better'], ['shelf-best', false, 'best'], ['totes', false, null]]);
  assert.deepEqual([job.crewNeeded, job.estimatedDurationMin, job.title, job.address], [2, 240, 'Garage reset options', '100 Fixture Lane']);
  assert.deepEqual(result.job.estimate.options, [{ groupId: 'shelving', label: 'Shelving', selection: 'single', required: true, tiers: { good: 69800, better: 89800, best: 99800 }, selectedTier: 'better' }]);
  // Nothing customer-facing: no provider sync, no portal invitation, no message, no send.
  assert.equal(job.syncStatus, 'not_needed');
  for (const key of ['customerPortalInvitationRequestedAt', 'acceptance', 'customerApproval', 'estimateReady']) assert.equal(job[key], undefined, key);
  assert.equal(projectReleased(job), false);
  assert.equal(f.delivered.length, 0); assert.equal(f.writesTo(MESSAGE_SENDS).length, 0);
  // The source walkthrough keeps its completed status, completion time and money exactly.
  assert.deepEqual(f.rows.get('jobs/w1'), walkthrough);
  assert.deepEqual(f.rows.get('customers/c1').revision, 'c1r');
  const commit = f.calls[0];
  assert.deepEqual(commit.filter(write => write.verify).map(write => `${write.collection}/${write.id}`).sort(), ['customers/c1', 'jobs/w1']);
  // FUN-29 (merge): the source project is written at its read revision with only its service line and funnel path.
  const project = commit.find(write => write.collection === 'projects' && write.id === 'p1');
  assert.equal(project.revision, 'p1r');
  assert.deepEqual(Object.keys(project.patch).sort(), ['dimensionRulesVersion', 'dimensionsUpdatedAt', 'dimensionsUpdatedBy', 'funnelPath', 'funnelPathSource', 'serviceLine', 'serviceLineSource', 'updatedAt']);
  assert.deepEqual([project.patch.funnelPath, project.patch.serviceLine], ['walkthrough', 'garage_transformation']);
  assert.deepEqual(commit.map(write => write.collection).filter(collection => !['jobs', 'customers', 'projects'].includes(collection)).sort(), ['dispatchOperations', 'dispatchState', 'hub_audit', QUOTE_DRAFT_RECEIPTS].sort());
  const audit = commit.find(write => write.collection === 'hub_audit').patch;
  assert.deepEqual([audit.action, audit.actor.id, audit.entity.id, audit.requestId], ['quote.draft.save', 'zacb', job.id, value.requestId.toLowerCase()]);
  assert.equal(f.rows.get(`${QUOTE_DRAFT_RECEIPTS}/${value.requestId.toLowerCase()}`).jobId, job.id);
});

test('a catalog quote saves only server-computed products, once-only minimum, configured deposit and frozen version provenance', async () => {
  const f = fixture(), state = catalogState(), descriptor = catalogSelection(state);
  const preview = priceCatalogQuote(state, descriptor, CATALOG_NOW);
  const value = f.input({ sourceWalkthroughId: undefined, sourceRevision: undefined, draft: {
    ...draft(), title: 'Catalog product installation', scope: 'Supply and install an overhead rack.',
    line_items: preview.lineItems, catalog_version: preview.catalogVersion, catalog_pricing: descriptor, valid_until: '2026-10-15',
  } });
  let current = state;
  const options = { catalogState: async () => current };
  const saved = await save(f, value, owner, CATALOG_ENV, CATALOG_NOW, options);
  const job = f.job(saved.job.id);
  assert.deepEqual([job.estimate.amountCents, job.estimate.depositRequiredCents, job.estimate.depositPct, job.estimate.pricingSettingsVersion], [45000, 13500, 30, state.settings.settingsVersion]);
  assert.deepEqual(job.estimate.lineItems.map(line => [line.id, line.totalCents]), [['catalog-1', 39399], ['catalog-minimum', 5601]]);
  assert.equal(job.estimate.lineItems[0].split.productCents, 19499);
  assert.equal(saved.job.estimate.lineItems[0].split, undefined, 'quote author DTO does not disclose product cost');
  assert.equal(saved.job.estimate.lineItems[0].customerSupplied, false, 'quote author DTO identifies EGC-supplied products');
  assert.deepEqual(job.quoteDraft.catalogPricing, descriptor);
  assert.equal(f.delivered.length, 0);
  current = { ...state, settings: { ...state.settings, settingsVersion: 'next-release' } };
  assert.equal((await save(f, value, owner, CATALOG_ENV, CATALOG_NOW, options)).replayed, true, 'a lost-response retry replays before current pricing is rechecked');
  const changed = { ...value, requestId: randomUUID() };
  await assert.rejects(save(f, changed, owner, CATALOG_ENV, CATALOG_NOW, options), { code: 'quote_draft_catalog_version_changed' });
  current = state;
  await assert.rejects(save(f, { ...value, requestId: randomUUID(), draft: { ...value.draft, line_items: value.draft.line_items.map(line => line.id === 'catalog-1' ? { ...line, totalCents: 1 } : line) } }, owner, CATALOG_ENV, CATALOG_NOW, options), { code: 'quote_draft_catalog_price_changed' });
  await assert.rejects(previewQuoteSend(f.store, owner, { jobId: job.id, expectedRevision: job.revision }, CATALOG_NOW, { env: ENV }), { code: 'quote_draft_catalog_disabled' });
  const sendPreview = await previewQuoteSend(f.store, owner, { jobId: job.id, expectedRevision: job.revision }, CATALOG_NOW, { env: CATALOG_ENV });
  assert.match(sendPreview.summary, /\$450\.00/);
  assert.equal(sendPreview.job.estimate.depositRequiredCents, 13500);
  const sendInput = { requestId: randomUUID(), jobId: job.id, expectedRevision: job.revision, confirmToken: sendPreview.confirmToken };
  const sent = await sendQuoteDraft(f.store, owner, sendInput, CATALOG_NOW, { env: CATALOG_ENV });
  assert.equal(sent.job.estimate.status, 'sent');
  let deliveredAfterRollback = 0;
  const replayedSend = await sendQuoteDraft(f.store, owner, sendInput, CATALOG_NOW, { env: ENV, deliver: async () => { deliveredAfterRollback++; return { status: 'submitted' }; } });
  assert.equal(replayedSend.replayed, true);
  assert.equal(replayedSend.job.estimate.status, 'sent', 'the original send remains recorded after rollback');
  assert.equal(deliveredAfterRollback, 0, 'rollback never starts a new provider delivery');
});

test('quote author DTO identifies a customer-supplied catalog product without exposing its cost split', async () => {
  const f = fixture(), state = catalogState(), descriptor = catalogSelection(state);
  descriptor.items[0].customerSupplied = true;
  const preview = priceCatalogQuote(state, descriptor, CATALOG_NOW);
  const value = f.input({ sourceWalkthroughId: undefined, sourceRevision: undefined, draft: {
    ...draft(), line_items: preview.lineItems, catalog_version: preview.catalogVersion,
    catalog_pricing: descriptor, valid_until: '2026-10-15',
  } });
  const saved = await save(f, value, owner, CATALOG_ENV, CATALOG_NOW, { catalogState: async () => state });
  assert.equal(f.job(saved.job.id).estimate.lineItems[0].split.productCents, 0);
  assert.equal(saved.job.estimate.lineItems[0].customerSupplied, true);
  assert.equal(saved.job.estimate.lineItems[0].split, undefined);
});

test('a new catalog settings version with identical cents retires the sent quote and approval', async () => {
  const f = fixture(), state = catalogState(), first = catalogSelection(state);
  const firstPrice = priceCatalogQuote(state, first, CATALOG_NOW);
  const quote = (priced, selection) => ({ ...draft(), title: 'Catalog product installation', scope: 'Supply and install an overhead rack.',
    line_items: priced.lineItems, catalog_version: priced.catalogVersion, catalog_pricing: selection, valid_until: '2026-10-15' });
  const initial = await save(f, f.input({ sourceWalkthroughId: undefined, sourceRevision: undefined, draft: quote(firstPrice, first) }), owner, CATALOG_ENV, CATALOG_NOW, { catalogState: async () => state });
  const id = initial.job.id;
  const sendPreview = await previewQuoteSend(f.store, owner, { jobId: id, expectedRevision: f.job(id).revision }, CATALOG_NOW, { env: CATALOG_ENV });
  await sendQuoteDraft(f.store, owner, { requestId: randomUUID(), jobId: id, expectedRevision: f.job(id).revision, confirmToken: sendPreview.confirmToken }, CATALOG_NOW, { env: CATALOG_ENV });
  f.rows.get(`jobs/${id}`).customerApproval = { status: 'approved', approvedAt: CATALOG_NOW, amount: 450 };
  const nextState = { ...state, settings: { ...state.settings, settingsVersion: 'approved-identical-cents-v2' } };
  const second = catalogSelection(nextState), secondPrice = priceCatalogQuote(nextState, second, CATALOG_NOW);
  assert.deepEqual(secondPrice.lineItems, firstPrice.lineItems, 'the customer-visible prices and lines are identical');
  const changed = await save(f, { requestId: randomUUID(), customerId: 'c1', sourceWalkthroughId: '', jobId: id, expectedRevision: f.job(id).revision,
    draft: quote(secondPrice, second) }, owner, CATALOG_ENV, CATALOG_NOW, { catalogState: async () => nextState });
  const job = f.job(id);
  assert.deepEqual([job.estimate.amountCents, job.estimate.revision, job.estimate.status, job.quoteStatus, job.customerApproval.status], [45000, 2, 'draft', 'draft', 'superseded']);
  assert.deepEqual([job.estimate.sentRevision, job.estimate.pricingSettingsVersion, job.quoteDraft.catalogPricing.settingsVersion], [1, second.settingsVersion, second.settingsVersion]);
  assert.equal(projectReleased(job), false, 'the earlier send and approval cannot release new provenance');
  assert.deepEqual(changed.warnings.map(warning => warning.code), ['approval_superseded']);
  assert.equal(f.calls.at(-1).find(write => write.collection === QUOTE_DRAFT_RECEIPTS).patch.material, true);
});

test('catalog preview endpoint is read-only, uses quote-author permissions and never exposes cost split', async () => {
  const f = fixture(), state = catalogState(), descriptor = catalogSelection(state);
  let actor = owner;
  const handler = quoteDraftHandlers({ session: async () => actor, storage: () => f.store, now: () => new Date(CATALOG_NOW), catalogState: async () => state });
  const post = (env, body) => handler.post({ request: request('POST', body), env });
  assert.equal((await post(ENV, { action: 'catalog_preview', catalogPricing: descriptor })).status, 404);
  const preview = await post(CATALOG_ENV, { action: 'catalog_preview', catalogPricing: descriptor });
  assert.equal(preview.status, 200);
  const body = await preview.json();
  assert.deepEqual([body.totalCents, body.depositCents, body.lineItems.length], [45000, 13500, 2]);
  assert.equal(JSON.stringify(body).includes('productCents'), false);
  assert.equal(f.calls.length, 0);
  actor = crew;
  assert.equal((await post(CATALOG_ENV, { action: 'catalog_preview', catalogPricing: descriptor })).status, 403);
});

test('draft creation is idempotent: a replay, concurrent copies and a lost response all resolve to one job; changed content under the same id is refused', async () => {
  const f = fixture(), value = f.input();
  const results = await Promise.all(Array.from({ length: 4 }, () => save(f, value)));
  assert.equal(new Set(results.map(result => result.job.id)).size, 1); assert.equal(f.calls.length, 1);
  const again = await save(f, value);
  assert.equal(again.replayed, true); assert.equal(again.job.id, results[0].job.id); assert.equal(f.calls.length, 1);
  await assert.rejects(save(f, { ...value, draft: draft(d => { d.scope = 'Changed scope'; }) }), error => error.code === 'quote_draft_idempotency_conflict');
  await assert.rejects(save(f, f.input()), error => error.code === 'quote_draft_existing_job');
  const g = fixture(), lost = g.input(); g.after(() => { throw new Error('response lost'); });
  const first = await save(g, lost); g.after(() => {});
  assert.equal((await save(g, lost)).job.id, first.job.id); assert.equal(g.calls.length, 1);
});

test('a revision needs the exact revision, bumps the quote revision only for a material change and never changes schedule, crew or the walkthrough', async () => {
  const f = fixture(), created = await save(f, f.input()), id = created.job.id, walkthrough = structuredClone(f.rows.get('jobs/w1'));
  await assert.rejects(save(f, { ...revise(f, id), expectedRevision: 'stale' }), error => error.code === 'quote_draft_revision_conflict');
  const dateOnly = await save(f, revise(f, id, d => { d.valid_until = '2026-10-10'; }));
  assert.deepEqual([f.job(id).estimate.revision, f.job(id).estimate.validUntil, dateOnly.job.estimate.revision], [1, '2026-10-10', 1]);
  const best = await save(f, revise(f, id, d => { d.line_items = lines().map(line => line.group ? { ...line, selected: line.tier === 'best' } : line); }));
  const job = f.job(id);
  assert.deepEqual([job.estimate.revision, job.estimate.status, job.estimate.amountCents, job.estimate.depositRequiredCents, best.job.estimate.options[0].selectedTier], [2, 'draft', 189800, 94900, 'best']);
  assert.deepEqual([job.status, job.date, job.crewNeeded, job.assignedCrew], ['unscheduled', '', 2, []]);
  assert.deepEqual(f.rows.get('jobs/w1'), walkthrough);
  const receipt = f.calls.at(-1).find(write => write.collection === QUOTE_DRAFT_RECEIPTS).patch;
  assert.deepEqual([receipt.action, receipt.material, receipt.estimateRevision], ['save', true, 2]);
  const replay = revise(f, id), once = await save(f, replay), commits = f.calls.length;
  assert.equal((await save(f, replay)).replayed, true); assert.equal(f.calls.length, commits); assert.equal(once.job.id, id);
});

test('cross-customer quotes are refused: client details, walkthrough and job must all belong to the selected customer', async () => {
  const f = fixture();
  await assert.rejects(save(f, f.input({ draft: draft(d => { d.client.phone = '9705550999'; d.client.email = ''; d.client.highlevel_contact_id = ''; }) })), error => error.code === 'quote_draft_customer_mismatch');
  await assert.rejects(save(f, f.input({ sourceWalkthroughId: 'w2', sourceRevision: 'w2r' })), error => error.code === 'quote_draft_source_mismatch');
  const created = await save(f, f.input());
  const other = { requestId: randomUUID(), customerId: 'c2', sourceWalkthroughId: 'w1', jobId: created.job.id, expectedRevision: f.job(created.job.id).revision, draft: draft(d => { d.client = { name: 'Synthetic Other', phone: '9705550199', email: 'other@example.invalid', address: '200 Fixture Lane', highlevel_contact_id: 'provider2' }; }) };
  await assert.rejects(save(f, other), error => error.code === 'quote_draft_job_mismatch');
  await assert.rejects(save(f, { ...revise(f, created.job.id), sourceWalkthroughId: '' }), error => error.code === 'quote_draft_job_mismatch');
  assert.equal(f.calls.length, 1);
});

test('draft validation: a complete default choice, no tips, at most 12 charged lines and a Denver expiry date', () => {
  assert.throws(() => normalizeQuoteDraft(draft(d => { d.line_items = lines().map(line => line.group ? { ...line, selected: false } : line); }), NOW), error => error.code === 'quote_draft_invalid_selection');
  assert.throws(() => normalizeQuoteDraft(draft(d => { d.line_items = lines().map(line => line.group ? { ...line, selected: true } : line); }), NOW), error => error.code === 'quote_draft_invalid_line_items');
  assert.throws(() => normalizeQuoteDraft(draft(d => { d.line_items.push({ id: 'tip', kind: 'tip', name: 'Tip', quantity: 1, unitCents: 500, totalCents: 500 }); }), NOW), error => error.code === 'quote_draft_invalid_line_items');
  assert.throws(() => normalizeQuoteDraft(draft(d => { d.line_items = Array.from({ length: 13 }, (_, index) => ({ id: `line-${index}`, kind: 'service', name: `Line ${index}`, quantity: 1, unitCents: 100, totalCents: 100 })); }), NOW), error => error.code === 'quote_draft_invalid_line_items');
  for (const date of ['2026-09-21', '2026-12-22', '2026-02-30']) assert.throws(() => normalizeQuoteDraft(draft(d => { d.valid_until = date; }), NOW), error => error.code === 'quote_draft_invalid_valid_until');
  // 23:30 in Denver on the 21st is already the 22nd in UTC: the Denver date decides.
  assert.equal(normalizeQuoteDraft(draft(d => { d.valid_until = '2026-09-21'; }), '2026-09-22T05:30:00.000Z').validUntil, '2026-09-21');
  assert.throws(() => normalizeQuoteDraft({ ...draft(), price: 1 }, NOW), error => error.code === 'quote_draft_invalid_request');
  const valid = normalizeQuoteDraft(draft(), NOW);
  assert.deepEqual([valid.totalCents, valid.depositCents, valid.catalogVersion], [179800, 89900, '2026-09-22.1']);
});

test('only an explicit, confirmed send records sentAt and asks HighLevel to notify the customer, exactly once', async () => {
  const f = fixture(), created = await save(f, f.input()), id = created.job.id;
  await save(f, revise(f, id, d => { d.scope = 'Cleanout plus shelving options.'; }));
  assert.equal(f.delivered.length, 0, 'saving and revising never send');
  await assert.rejects(sendQuoteDraft(f.store, owner, { requestId: randomUUID(), jobId: id, expectedRevision: f.job(id).revision }, NOW, { env: ENV, deliver: f.deliver }), error => error.code === 'quote_draft_invalid_request');
  await assert.rejects(sendQuoteDraft(f.store, owner, { requestId: randomUUID(), jobId: id, expectedRevision: f.job(id).revision, confirmToken: 'ect1.forged.token' }, NOW, { env: ENV, deliver: f.deliver }), error => error.code === 'confirm_token_invalid');
  assert.equal(f.job(id).estimate.status, 'draft'); assert.equal(f.delivered.length, 0);
  const { preview, body, result } = await sendFlow(f, id);
  assert.deepEqual([preview.delivery.mode, preview.delivery.recipient.masked, preview.job.estimate.revision], ['off', '(•••) •••-0100', 2]);
  const job = f.job(id);
  assert.deepEqual([job.estimate.status, job.estimate.sentAt, job.estimate.sentBy, job.estimate.sentRevision, job.quoteStatus, job.estimateReady.status], ['sent', LATER, 'zacb', 2, 'sent', 'messaging_disabled']);
  assert.equal(projectReleased(job), true, 'the business hub now releases the sent quote');
  assert.deepEqual(result.warnings.map(warning => warning.code), ['messaging_disabled']);
  assert.equal(f.delivered.length, 0, 'with messaging off HighLevel is not asked');
  assert.equal(f.writesTo(CONFIRM_TOKEN_COLLECTION).length, 1);
  const audit = f.calls.at(-1).find(write => write.collection === 'hub_audit').patch;
  assert.deepEqual([audit.action, audit.reason], ['quote.send', 'delivery:off']);
  // The same request replays the recorded send; the token cannot be reused for another request.
  const commits = f.calls.length;
  assert.equal((await sendQuoteDraft(f.store, owner, body, LATER, { env: ENV, deliver: f.deliver })).replayed, true);
  await assert.rejects(sendQuoteDraft(f.store, owner, { ...body, requestId: randomUUID() }, LATER, { env: ENV, deliver: f.deliver }), error => ['quote_draft_revision_conflict', 'confirm_token_used'].includes(error.code));
  assert.equal(f.calls.length, commits);
  await assert.rejects(previewQuoteSend(f.store, owner, { jobId: id, expectedRevision: f.job(id).revision }, NOW, { env: ENV }), error => error.code === 'quote_draft_already_sent');
});

test('with messaging on, the confirmed send triggers the estimate-ready automation once and a retry of the request never records a second send', async () => {
  const f = fixture(), created = await save(f, f.input()), id = created.job.id;
  const { preview, body, result } = await sendFlow(f, id, { env: MESSAGING });
  assert.equal(preview.delivery.mode, 'automation');
  assert.equal(f.delivered.length, 1);
  assert.deepEqual([f.delivered[0].jobId, f.delivered[0].requestId, f.delivered[0].actorId], [id, body.requestId, 'zacb']);
  assert.equal(result.delivery.status, 'submitted');
  assert.equal(f.job(id).estimateReady.status, 'pending', 'the fake deliverer does not mirror');
  f.rows.get(`jobs/${id}`).estimateReady.status = 'submitted';
  const commits = f.calls.length;
  await sendQuoteDraft(f.store, owner, body, LATER, { env: MESSAGING, deliver: f.deliver });
  assert.equal(f.delivered.length, 1); assert.equal(f.calls.length, commits);
});

test('the confirmation is bound to the exact revision and delivery the person reviewed', async () => {
  const f = fixture(), created = await save(f, f.input()), id = created.job.id;
  const preview = await previewQuoteSend(f.store, owner, { jobId: id, expectedRevision: f.job(id).revision }, NOW, { env: ENV });
  await save(f, revise(f, id, d => { d.scope = 'Edited after the preview.'; }));
  await assert.rejects(sendQuoteDraft(f.store, owner, { requestId: randomUUID(), jobId: id, expectedRevision: f.job(id).revision, confirmToken: preview.confirmToken }, LATER, { env: ENV, deliver: f.deliver }), error => error.code === 'confirm_token_mismatch');
  const fresh = await previewQuoteSend(f.store, owner, { jobId: id, expectedRevision: f.job(id).revision }, NOW, { env: ENV });
  // Turning messaging on after the preview changes what the send would do.
  await assert.rejects(sendQuoteDraft(f.store, owner, { requestId: randomUUID(), jobId: id, expectedRevision: f.job(id).revision, confirmToken: fresh.confirmToken }, LATER, { env: MESSAGING, deliver: f.deliver }), error => error.code === 'confirm_token_mismatch');
  await assert.rejects(sendQuoteDraft(f.store, { ...owner, user: 'tylerg', role: 'manager' }, { requestId: randomUUID(), jobId: id, expectedRevision: f.job(id).revision, confirmToken: fresh.confirmToken }, LATER, { env: ENV, deliver: f.deliver }), error => error.code === 'confirm_token_mismatch');
  assert.equal(f.job(id).estimate.status, 'draft'); assert.equal(f.delivered.length, 0);
  await assert.rejects(sendQuoteDraft(f.store, owner, { requestId: randomUUID(), jobId: id, expectedRevision: f.job(id).revision, confirmToken: fresh.confirmToken }, '2026-09-22T18:10:00.000Z', { env: ENV, deliver: f.deliver }), error => error.code === 'confirm_token_expired');
});

test('revising a sent and approved quote bumps the revision, retires the approval and invoice, keeps payments and expires the open card checkout', async () => {
  const f = fixture(), created = await save(f, f.input()), id = created.job.id;
  await sendFlow(f, id);
  // The customer approved in the portal, paid part of the deposit and has a checkout open for the rest.
  Object.assign(f.rows.get(`jobs/${id}`), { customerApproval: { status: 'approved', approvedAt: LATER, approvedBy: 'Synthetic Customer', amount: 1798 }, deposit: { ...f.job(id).deposit, paidAmount: 100, verified: true, reference: 'receipt-1' }, payment: { verified: true, amount: 100, stripeSessions: [{ sessionId: 'cs_test_paid' }] }, invoice: { number: 'INV-1', amount: 1798, status: 'issued' } });
  const approvedJob = f.job(id);
  f.rows.set(`customer_payment_checkouts/${id}`, { id, revision: 'k1', status: 'open', sessionId: 'cs_test_open', amountCents: 89800, fingerprint: checkoutFingerprint(approvedJob) });
  const stripeCalls = [], stripe = async (path, options) => { stripeCalls.push({ path, options }); return { id: 'cs_test_open', status: 'expired' }; };
  const checkouts = job => expireStaleCheckout({ store: f.store, job, stripe, now: LATER });
  // A change that is not material (the expiry date) leaves the approval and checkout alone.
  await save(f, revise(f, id, d => { d.valid_until = '2026-10-12'; }), owner, ENV, NOW, { checkouts });
  assert.deepEqual([f.job(id).estimate.revision, f.job(id).customerApproval.status, stripeCalls.length], [1, 'approved', 0]);
  const result = await save(f, revise(f, id, d => { d.line_items = lines().map(line => line.group ? { ...line, selected: line.tier === 'good' } : line); }), owner, ENV, NOW, { checkouts });
  const job = f.job(id);
  assert.deepEqual([job.estimate.revision, job.estimate.status, job.quoteStatus, job.customerApproval.status, job.invoice.status], [2, 'draft', 'draft', 'superseded', 'superseded']);
  assert.deepEqual([job.estimate.sentRevision, job.estimate.sentAt], [1, LATER], 'the earlier send stays in history');
  assert.equal(projectReleased(job), false, 'a drafted revision is not released by an earlier send');
  assert.deepEqual([job.deposit.paidAmount, job.deposit.reference, job.deposit.status, job.payment.amount, job.payment.stripeSessions.length], [100, 'receipt-1', 'partial', 100, 1]);
  assert.notEqual(checkoutFingerprint(job), checkoutFingerprint(approvedJob));
  assert.deepEqual(stripeCalls.map(call => [call.path, call.options.method]), [['checkout/sessions/cs_test_open/expire', 'POST']]);
  assert.equal(f.rows.get(`customer_payment_checkouts/${id}`).status, 'expired');
  assert.equal(result.checkout.status, 'expired');
  assert.deepEqual(result.warnings.map(warning => warning.code).sort(), ['approval_superseded', 'invoice_superseded']);
  // The revision can be sent again; the old checkout is not re-opened by it.
  await sendFlow(f, id);
  assert.deepEqual([f.job(id).estimate.status, f.job(id).estimate.sentRevision, stripeCalls.length], ['sent', 2, 1]);
});

// QUOTE-DRAFT x FUN-03 (merge): a material quote draft revision ends the live sale a portal approval recorded, in the
// revision's own commit, exactly as the Hub estimate editor does (money-service saveEstimate).
test('a material quote draft revision retires the live portal sale with deal.approval_superseded and clears funnelSale', async () => {
  const f = fixture(), created = await save(f, f.input()), id = created.job.id;
  await sendFlow(f, id);
  const soldCents = f.job(id).estimate.amountCents, sale = { jobId: id, cents: soldCents, estimateRevision: 1, key: 'portalRequest:synthetic-approval-1', eventId: 'synthetic-sold-event', soldAt: LATER };
  Object.assign(f.rows.get(`jobs/${id}`), { customerApproval: { status: 'approved', approvedAt: LATER, approvedBy: 'Synthetic Customer', amount: soldCents / 100 }, funnelSale: sale });
  // A change that is not material (the expiry date) keeps the sale live and writes no event.
  await save(f, revise(f, id, d => { d.valid_until = '2026-10-12'; }));
  assert.deepEqual([f.job(id).funnelSale, f.writesTo('funnelEvents').length], [sale, 0]);
  const input = revise(f, id, d => { d.line_items = lines().map(line => line.group ? { ...line, selected: line.tier === 'good' } : line); });
  await save(f, input);
  const events = f.writesTo('funnelEvents');
  assert.equal(events.length, 1);
  const [event] = events, receipt = input.requestId.toLowerCase();
  assert.deepEqual([event.patch.type, event.patch.data, event.patch.via, event.patch.source, event.patch.idempotencyKey, event.patch.jobId, event.patch.occurredAt],
    ['deal.approval_superseded', { amountCents: soldCents, estimateRevision: 1 }, 'hub', { collection: QUOTE_DRAFT_RECEIPTS, id: receipt }, `requestId:${receipt}`, id, NOW]);
  assert.ok(f.calls.at(-1).some(write => write.collection === QUOTE_DRAFT_RECEIPTS && write.id === receipt), 'in the same commit as the revision receipt');
  assert.deepEqual([f.job(id).funnelSale, f.job(id).customerApproval.status], [null, 'superseded']);
  // With no live sale left, a later material revision writes no second event.
  await save(f, revise(f, id, d => { d.scope = 'Cleanout plus the good shelving option.'; }));
  assert.equal(f.writesTo('funnelEvents').length, 1);
});

// QUOTE-DRAFT x FUN-33 (merge): with the payment events on, a material quote draft revision records the paid-in-full
// crossing it causes in the revision's own commit, as the Hub estimate editor does (money-service estimate.save).
test('with FUN-33 payment events on, a material quote draft revision reopens a paid-in-full balance in its own commit, and pays it off again', async () => {
  const EVENTS = { ...ENV, FUNNEL_PAYMENT_EVENTS_ENABLED: 'true', MONEY_API_ENABLED: 'true' };
  const choose = tier => d => { d.line_items = lines().map(line => line.group ? { ...line, selected: line.tier === tier } : line); };
  async function prepaid(env) {
    const f = fixture(), created = await save(f, f.input(), owner, env), id = created.job.id;
    await sendFlow(f, id, { env });
    // The customer approved revision 1 ($1,798) and paid it in full by check before the work started.
    Object.assign(f.rows.get(`jobs/${id}`), { customerApproval: { status: 'approved', approvedAt: LATER, approvedBy: 'Synthetic Customer', amount: 1798 }, deposit: { ...f.job(id).deposit, paidAmount: 899, verified: true },
      payment: { amount: 1798, verified: true, method: 'check', reference: 'CHK-1', lastAmount: 1798, lastReceivedAt: LATER, recordedBy: 'zacb' }, paidInFullAt: LATER, paidInFullRevision: 1 });
    return { f, id };
  }
  const { f, id } = await prepaid(EVENTS), raised = revise(f, id, choose('best'));
  await save(f, raised, owner, EVENTS);
  const receipt = raised.requestId.toLowerCase(), commit = f.calls.at(-1), [reopened] = commit.filter(write => write.collection === 'funnelEvents').map(write => write.patch);
  assert.ok(commit.some(write => write.collection === QUOTE_DRAFT_RECEIPTS && write.id === receipt), 'in the same commit as the revision receipt');
  assert.deepEqual([reopened.type, reopened.data, reopened.via, reopened.source, reopened.idempotencyKey, reopened.occurredAt, reopened.actor],
    ['job.balance_reopened', { amountCents: 10000, estimateRevision: 2, reasonCode: 'estimate_revised' }, 'hub', { collection: QUOTE_DRAFT_RECEIPTS, id: receipt }, `requestId:${receipt}`, NOW, { id: 'zacb', kind: 'human', role: 'owner' }]);
  assert.deepEqual([f.job(id).paidInFullAt, f.job(id).paidInFullRevision, f.job(id).balanceReopenedAt, f.job(id).balanceReopenedReason], [null, null, NOW, 'estimate_revised']);
  // A change that is not material writes no crossing; a revision below what was paid pays the job off again at its revision.
  await save(f, revise(f, id, d => { choose('best')(d); d.valid_until = '2026-10-12'; }), owner, EVENTS);
  assert.equal(f.calls.at(-1).some(write => write.collection === 'funnelEvents'), false);
  await save(f, revise(f, id, choose('good')), owner, EVENTS, LATER);
  const [paid] = f.calls.at(-1).filter(write => write.collection === 'funnelEvents').map(write => write.patch);
  assert.deepEqual([paid.type, paid.data, paid.occurredAt], ['job.paid_in_full', { amountCents: 159800, estimateRevision: 3 }, LATER]);
  assert.deepEqual([f.job(id).paidInFullAt, f.job(id).paidInFullRevision, f.job(id).payment.amount], [LATER, 3, 1798], 'payments are never touched');
  // Flag off: the same revisions commit exactly as before, with no crossing and no crossing fields.
  const off = await prepaid(ENV);
  await save(off.f, revise(off.f, off.id, choose('best')));
  assert.deepEqual([off.f.writesTo('funnelEvents').length, off.f.job(off.id).paidInFullAt, 'balanceReopenedAt' in off.f.job(off.id)], [0, LATER, false]);
  assert.deepEqual(off.f.calls.at(-1).map(write => write.collection), ['jobs', 'customers', QUOTE_DRAFT_RECEIPTS, 'hub_audit']);
});

test('checkout expiry only touches an open session for other terms and reports what it could not close', async () => {
  const f = fixture(), job = { id: 'j1', estimate: { amount: 100, revision: 2 }, customerApproval: { status: 'approved' } };
  const calls = [], stripe = async path => { calls.push(path); return { status: 'expired' }; };
  assert.deepEqual(await expireStaleCheckout({ store: f.store, job, stripe }), { status: 'none' });
  f.rows.set('customer_payment_checkouts/j1', { id: 'j1', revision: 'k1', status: 'open', sessionId: 'cs_test_1', fingerprint: checkoutFingerprint(job) });
  assert.deepEqual(await expireStaleCheckout({ store: f.store, job, stripe }), { status: 'current' });
  f.rows.get('customer_payment_checkouts/j1').status = 'settled';
  assert.deepEqual(await expireStaleCheckout({ store: f.store, job: { ...job, estimate: { amount: 90, revision: 3 } }, stripe }), { status: 'none' });
  f.rows.get('customer_payment_checkouts/j1').status = 'open';
  assert.deepEqual(await expireStaleCheckout({ store: f.store, job: { ...job, estimate: { amount: 90, revision: 3 } }, stripe: null }), { status: 'needs_review', reason: 'stripe_not_configured' });
  assert.deepEqual(await expireStaleCheckout({ store: f.store, job: { ...job, estimate: { amount: 90, revision: 3 } }, stripe: async () => { throw new Error('502'); } }), { status: 'needs_review', reason: 'stripe_unconfirmed' });
  assert.equal(calls.length, 0);
});

test('a draft becomes the signed job: the in-person handoff revises the same job instead of creating another', async () => {
  const f = fixture(), created = await save(f, f.input()), id = created.job.id, walkthrough = f.rows.get('jobs/w1');
  const plan = { client: client(), quote: { title: 'Garage reset', total: 1400, deposit: 700, job_date: '2026-09-24', start_time: '09:00', end_time: '12:00', estimated_duration_min: 180 }, acceptance: { accepted_at: '2026-09-22T17:45:00.000Z', accepted_by: 'Synthetic Customer', signature_captured: true, method: 'in_person_signature', terms_version: '2026-09-deposit50' }, signature: 'data:image/png;base64,iVBORw0KGgo=', terms_version: '2026-09-deposit50', terms_accepted: true, photos: { before: 3 }, scope: { keep_items: 'Blue bicycle' }, discovery: {}, logistics: { crew_size: 2 }, internal_notes: 'Synthetic brief', client_checklists: { preJob: [], postJob: [] }, notes: '' };
  const signed = await saveWalkthroughHandoff(f.store, owner, { requestId: randomUUID(), customerId: 'c1', sourceWalkthroughId: 'w1', sourceRevision: walkthrough.revision, jobId: id, expectedRevision: f.job(id).revision, plan }, NOW);
  assert.equal(signed.job.id, id);
  assert.deepEqual([f.job(id).estimate.status, f.job(id).estimate.revision, f.job(id).estimate.number, f.job(id).status], ['accepted', 2, created.job.estimate.number, 'scheduled']);
  await assert.rejects(previewQuoteSend(f.store, owner, { jobId: id, expectedRevision: f.job(id).revision }, NOW, { env: ENV }), error => error.code === 'quote_draft_already_approved');
  // The draft screen cannot quietly retire the in-person signature.
  await assert.rejects(save(f, revise(f, id, d => { d.scope = 'Changed after signing.'; })), error => error.code === 'quote_draft_signed');
  assert.equal(f.job(id).estimate.status, 'accepted');
});

test('a retry of a committed save returns it even after the Denver date passed the quote\'s expiry', async () => {
  // 23:50 and 00:10 in Denver (MDT): the draft expires on the 22nd, the retry arrives on the 23rd.
  const LATE = '2026-09-23T05:50:00.000Z', PAST_MIDNIGHT = '2026-09-23T06:10:00.000Z';
  const f = fixture(), value = f.input({ draft: draft(d => { d.valid_until = '2026-09-22'; }) });
  const first = await save(f, value, owner, ENV, LATE);
  const again = await save(f, value, owner, ENV, PAST_MIDNIGHT);
  assert.deepEqual([again.replayed, again.job.id, again.job.estimate.validUntil], [true, first.job.id, '2026-09-22']);
  assert.equal(f.calls.length, 1);
  // New content, or a new request with the same content, is validated on the new Denver date.
  await assert.rejects(save(f, { ...value, requestId: randomUUID() }, owner, ENV, PAST_MIDNIGHT), error => error.code === 'quote_draft_invalid_valid_until');
  await assert.rejects(save(f, { ...value, draft: draft(d => { d.valid_until = '2026-09-21'; }) }, owner, ENV, PAST_MIDNIGHT), error => error.code === 'quote_draft_idempotency_conflict');
  // Through the API, the browser's kept request gets the saved job rather than a 400 it would discard.
  const g = fixture(), kept = { action: 'save', ...g.input({ draft: draft(d => { d.valid_until = '2026-09-22'; }) }) };
  const api = at => quoteDraftHandlers({ session: async () => owner, storage: () => g.store, now: () => new Date(at), delivery: () => ({ deliver: g.deliver }), stripe: () => null });
  const saved = await (await api(LATE).post({ request: request('POST', kept), env: ENV })).json();
  const retried = await api(PAST_MIDNIGHT).post({ request: request('POST', kept), env: ENV });
  assert.equal(retried.status, 200);
  assert.deepEqual([(await retried.json()).job.id, g.calls.length], [saved.job.id, 1]);
});

test('a revision below the recorded payments keeps them and warns, as the Hub estimate editor does', async () => {
  const f = fixture(), created = await save(f, f.input()), id = created.job.id;
  Object.assign(f.rows.get(`jobs/${id}`), { payment: { amount: 1700 }, deposit: { ...f.job(id).deposit, paidAmount: 899 } });
  const kept = await save(f, revise(f, id, d => { d.valid_until = '2026-10-10'; }));
  assert.deepEqual(kept.warnings, [], 'payments within the total');
  const lowered = await save(f, revise(f, id, d => { d.line_items = lines().map(line => line.group ? { ...line, selected: line.tier === 'good' } : line); }));
  assert.equal(f.job(id).estimate.amountCents, 159800);
  assert.deepEqual(lowered.warnings.map(warning => warning.code), ['payments_exceed_total']);
  assert.deepEqual([f.job(id).payment.amount, f.job(id).deposit.paidAmount, f.job(id).deposit.status], [1700, 899, 'paid']);
});

test('a send confirmed as a dry run never becomes a live HighLevel call after messaging goes live', async () => {
  const f = fixture(), created = await save(f, f.input()), id = created.job.id, DRY = { ...MESSAGING, EGC_MESSAGING_DRY_RUN: 'true' };
  // The dry-run send is recorded, but its delivery answer (and display mirror) is lost.
  const { preview, body, result } = await sendFlow(f, id, { env: DRY, deliver: async () => { throw new Error('lost'); } });
  assert.deepEqual([preview.delivery.mode, result.delivery.status, f.job(id).estimateReady.status, f.job(id).estimateReady.mode, result.job.delivery.mode], ['dry_run', 'uncertain', 'pending', 'dry_run', 'dry_run']);
  const posts = [], lookups = [];
  const messenger = { resolveRecipient: async input => { lookups.push(input); return { status: 'ready', contactId: 'provider1', channel: 'SMS', masked: '(•••) •••-0100', toNumber: '+19705550100' }; }, addTags: async input => { posts.push(input); return { status: 'submitted' }; } };
  const live = createEstimateReadyDelivery({ store: f.store, env: MESSAGING, messenger, clock: () => new Date(LATER) });
  // The kept send request is retried once EGC_MESSAGING_DRY_RUN is false.
  const replayed = await sendQuoteDraft(f.store, owner, body, LATER, { env: MESSAGING, deliver: live.deliver });
  assert.deepEqual([replayed.replayed, replayed.delivery.status, f.job(id).estimateReady.status], [true, 'dry_run', 'dry_run']);
  assert.deepEqual([posts.length, lookups.length, f.writesTo(MESSAGE_SENDS).length], [0, 0, 0]);
  let asked = 0;
  await sendQuoteDraft(f.store, owner, body, LATER, { env: MESSAGING, deliver: async () => { asked += 1; return { status: 'submitted' }; } });
  assert.equal(asked, 0, 'a settled dry run is not delivered again');
  // The deliverer also refuses a caller whose mode differs from the recorded one, and an unrecorded mode.
  assert.deepEqual(await live.deliver(id, { requestId: body.requestId, mode: 'automation' }), { status: 'changed', reason: 'delivery_mode_changed' });
  delete f.rows.get(`jobs/${id}`).estimateReady.mode;
  assert.equal((await live.deliver(id, { requestId: body.requestId })).status, 'needs_review');
  assert.equal(posts.length, 0);
});

test('a sales author signs their unplaced quote draft into a scheduled job but cannot move it afterwards', async () => {
  const f = fixture(), value = f.input({ sourceWalkthroughId: '', sourceRevision: '' }), created = await save(f, value, sales, ROLES), id = created.job.id;
  // Without a walkthrough the draft is still the author's to open.
  const prepared = await prepareHandoff(f.store, sales, { jobId: id }, { env: ROLES });
  assert.deepEqual([prepared.jobId, prepared.customerId, prepared.customer.id], [id, 'c1', 'c1']);
  const plan = (date, start, end) => ({ client: client(), quote: { title: 'Garage reset', total: 1400, deposit: 700, job_date: date, start_time: start, end_time: end, estimated_duration_min: 180 }, acceptance: { accepted_at: '2026-09-22T17:45:00.000Z', accepted_by: 'Synthetic Customer', signature_captured: true, method: 'in_person_signature', terms_version: '2026-09-deposit50' }, signature: 'data:image/png;base64,iVBORw0KGgo=', terms_version: '2026-09-deposit50', terms_accepted: true, photos: { before: 3 }, scope: { keep_items: 'Blue bicycle' }, discovery: {}, logistics: { crew_size: 2 }, internal_notes: 'Synthetic brief', client_checklists: { preJob: [], postJob: [] }, notes: '' });
  const sign = (date, start, end) => saveWalkthroughHandoff(f.store, sales, { requestId: randomUUID(), customerId: 'c1', jobId: id, expectedRevision: f.job(id).revision, plan: plan(date, start, end) }, NOW, { env: ROLES });
  const signed = await sign('2026-09-24', '09:00', '12:00');
  assert.deepEqual([signed.job.id, f.job(id).status, f.job(id).date, f.job(id).estimate.status], [id, 'scheduled', '2026-09-24', 'accepted']);
  await assert.rejects(sign('2026-09-25', '09:00', '12:00'), error => error.code === 'handoff_schedule_change_forbidden');
  // Another author's job that is neither a quote draft nor from this walkthrough stays with Dispatch.
  f.rows.set('jobs/other', { id: 'other', revision: 'or', type: 'job', status: 'unscheduled', pipelineStatus: 'unscheduled', customerId: 'c1', date: '', time: '', createdBy: 'tylerg' });
  await assert.rejects(prepareHandoff(f.store, sales, { jobId: 'other' }, { env: ROLES }), error => error.code === 'handoff_job_forbidden');
  assert.equal((await prepareHandoff(f.store, owner, { jobId: 'other' })).customer.id, 'c1');
});

test('with role permissions on, a manager lowered to sales drafts quotes as an author, not a dispatcher; with them off, as a dispatcher', async () => {
  const lowered = { user: 'tylerg', role: 'manager', businessAccess: true, displayName: 'Synthetic Manager', staffRoles: ['sales'] };
  const f = fixture(), open = (actor, query, env) => handoffHandlers({ session: async () => actor, storage: () => f.store }).get({ request: new Request(`https://easygaragecleaning.com/api/walkthrough-handoff?${query}`), env });
  const drafts = actor => quoteDraftHandlers({ session: async () => actor, storage: () => f.store, now: () => new Date(NOW), delivery: () => ({ deliver: f.deliver }), stripe: () => null });
  const saved = await drafts(lowered).post({ request: request('POST', { action: 'save', ...f.input() }), env: ROLES }), id = (await saved.json()).job.id;
  assert.equal(saved.status, 200, 'a quote author');
  const own = await (await open(lowered, `jobId=${id}`, ROLES)).json();
  assert.deepEqual([own.jobId, own.customer.id, own.roster], [id, 'c1', []], 'its own draft, without the roster');
  f.rows.set('jobs/other', { id: 'other', revision: 'or', type: 'job', status: 'unscheduled', pipelineStatus: 'unscheduled', customerId: 'c1', date: '', time: '', createdBy: 'zacb' });
  const other = await open(lowered, 'jobId=other', ROLES);
  assert.deepEqual([other.status, (await other.json()).code], [403, 'handoff_job_forbidden'], 'other jobs stay with Dispatch');
  const legacy = await (await open(lowered, 'jobId=other', ENV)).json();
  assert.deepEqual([legacy.jobId, legacy.roster.length], ['other', 2], 'flag off: a dispatcher, as today');
  const crewOnly = await drafts({ ...lowered, staffRoles: ['crew'] }).post({ request: request('POST', { action: 'save', ...f.input() }), env: ROLES });
  assert.deepEqual([crewOnly.status, (await crewOnly.json()).code], [403, 'quote_forbidden'], 'lowered to crew: no quote access');
});

test('drafting stops once work has started or the job is closed', async () => {
  const f = fixture(), created = await save(f, f.input()), id = created.job.id;
  f.rows.get(`jobs/${id}`).fieldLastActionAt = NOW;
  await assert.rejects(save(f, revise(f, id)), error => error.code === 'quote_draft_work_started');
  await assert.rejects(previewQuoteSend(f.store, owner, { jobId: id, expectedRevision: f.job(id).revision }, NOW, { env: ENV }), error => error.code === 'quote_draft_work_started');
  delete f.rows.get(`jobs/${id}`).fieldLastActionAt; Object.assign(f.rows.get(`jobs/${id}`), { status: 'cancelled', pipelineStatus: 'cancelled' });
  await assert.rejects(save(f, revise(f, id)), error => error.code === 'quote_draft_job_closed');
  f.rows.set('jobs/legacy', { id: 'legacy', revision: 'lr', type: 'job', customerId: 'c1', status: 'scheduled', estimate: { number: 'EST-LEGACY', amount: 500 } });
  await assert.rejects(readQuoteDraft(f.store, owner, { jobId: 'legacy' }), error => error.code === 'quote_draft_not_a_draft');
});

test('the estimate-ready deliverer follows the approved-send core: flags, verified recipient, one ledger claim, uncertain is never resent', async () => {
  const f = fixture(), created = await save(f, f.input()), id = created.job.id;
  const recorded = await sendFlow(f, id, { env: MESSAGING, deliver: async () => ({ status: 'pending' }) });
  const requestId = recorded.body.requestId, job = f.job(id);
  const sendKey = estimateReadySendKey(job), ledger = await ledgerId(sendKey);
  assert.equal(sendKey, `estimate_ready:${id}:${job.estimate.number}:r1`);
  const lookups = [], posts = [];
  let reply = () => new Response('{}', { status: 200 });
  const fetcher = async (url, options) => { posts.push({ url, options }); return reply(); };
  const clock = () => new Date(LATER);
  // The approved-send messenger makes the real HighLevel tag request; only the lookup is faked.
  const messenger = { resolveRecipient: async input => { lookups.push(input); return { status: 'ready', contactId: 'provider1', channel: 'SMS', masked: '(•••) •••-0100', toNumber: '+19705550100' }; }, addTags: createGhlMessenger({ env: MESSAGING, fetcher, clock }).addTags };
  const make = env => createEstimateReadyDelivery({ store: f.store, env, messenger, clock }).deliver;
  // Messaging off or a dry run never reaches HighLevel.
  assert.equal((await make(ENV)(id, { requestId })).status, 'messaging_disabled');
  assert.equal((await make({ ...MESSAGING, EGC_MESSAGING_DRY_RUN: 'true' })(id, { requestId, actorId: 'zacb' })).status, 'dry_run');
  assert.equal(lookups.at(-1).upsert, false, 'a dry run creates no CRM contact');
  assert.equal(posts.length, 0); assert.equal(f.rows.get(`${MESSAGE_SENDS}/${ledger}`).status, 'dry_run');
  f.rows.delete(`${MESSAGE_SENDS}/${ledger}`);
  const deliver = make(MESSAGING), first = await deliver(id, { requestId, actorId: 'zacb', actorRole: 'owner' });
  assert.deepEqual([first.status, first.attempts], ['submitted', 1]);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].url, 'https://services.leadconnectorhq.com/contacts/provider1/tags');
  assert.deepEqual(JSON.parse(posts[0].options.body), { tags: [ESTIMATE_READY_TAG] });
  assert.deepEqual([posts[0].options.method, posts[0].options.headers.Authorization, posts[0].options.headers.Version, posts[0].options.headers['Idempotency-Key']], ['POST', 'Bearer synthetic-ghl-token', 'v3', `egc-estimate-ready-${ledger.slice(0, 40)}-1`]);
  assert.ok(posts[0].options.signal, 'the provider call has a timeout');
  assert.deepEqual(lookups.at(-1), { contactId: 'provider1', phone: '9705550100', email: 'test@example.invalid', name: 'Synthetic Customer', preferred: 'SMS', upsert: true });
  const saved = f.rows.get(`${MESSAGE_SENDS}/${ledger}`);
  assert.deepEqual([saved.status, saved.kind, saved.targetId, saved.approval, saved.actorId, saved.requestId], ['submitted', 'estimate_ready', id, 'preview_confirm', 'zacb', requestId]);
  const mirrored = f.job(id);
  // A 2xx proves only that the tag was applied, not that the HighLevel workflow ran.
  assert.deepEqual([mirrored.estimateReady.status, mirrored.communicationLastEvent, mirrored.communicationLastStatus, mirrored.communicationLog.at(-1).trigger], ['submitted', 'estimate-ready', 'tag_applied', ESTIMATE_READY_TAG]);
  assert.deepEqual(await deliver(id, { requestId }), { status: 'already_sent', attempts: 1, alreadyRecorded: true });
  assert.equal(posts.length, 1);
  // An ambiguous provider answer is recorded as uncertain and is never sent again.
  f.rows.delete(`${MESSAGE_SENDS}/${ledger}`); reply = () => new Response('{}', { status: 502 });
  assert.equal((await deliver(id, { requestId })).status, 'uncertain');
  assert.equal((await deliver(id, { requestId })).status, 'uncertain');
  assert.equal(posts.length, 2);
  // A definite refusal may be retried by the same send, at most three times.
  f.rows.delete(`${MESSAGE_SENDS}/${ledger}`); reply = () => new Response('{}', { status: 422 });
  for (const expected of ['failed', 'failed', 'failed', 'attempts_exhausted']) assert.equal((await deliver(id, { requestId })).status, expected);
  assert.equal(posts.length, 5);
  // Notifications off, a different request or a revised quote never send.
  f.rows.delete(`${MESSAGE_SENDS}/${ledger}`);
  assert.equal((await deliver(id, { requestId: randomUUID() })).status, 'superseded');
  f.rows.get(`jobs/${id}`).notify = false;
  assert.equal((await deliver(id, { requestId })).status, 'suppressed');
  assert.equal(posts.length, 5);
});

test('the deliverer refuses a contact HighLevel cannot verify and a job that changed during the lookup', async () => {
  const f = fixture(), created = await save(f, f.input()), id = created.job.id;
  const { body } = await sendFlow(f, id, { env: MESSAGING, deliver: async () => ({ status: 'pending' }) });
  const posts = [], addTags = async input => { posts.push(input); return { status: 'submitted' }; };
  const mismatch = { resolveRecipient: async () => ({ status: 'contact_mismatch', reason: 'contact_identity_mismatch', masked: '(•••) •••-0100' }), addTags };
  assert.equal((await createEstimateReadyDelivery({ store: f.store, env: MESSAGING, messenger: mismatch, clock: () => new Date(LATER) }).deliver(id, { requestId: body.requestId })).status, 'contact_mismatch');
  assert.equal(f.job(id).estimateReady.status, 'contact_mismatch'); assert.equal(f.job(id).communicationLastStatus, 'needs_attention');
  const moving = { resolveRecipient: async () => { f.rows.get(`jobs/${id}`).phone = '9705550111'; return { status: 'ready', contactId: 'provider1', channel: 'SMS', masked: 'x', toNumber: '+19705550100' }; }, addTags };
  assert.equal((await createEstimateReadyDelivery({ store: f.store, env: MESSAGING, messenger: moving, clock: () => new Date(LATER) }).deliver(id, { requestId: body.requestId })).status, 'changed');
  assert.equal(posts.length, 0);
  // A retry of the original send request asks the deliverer again once the contact is fixed.
  f.rows.get(`jobs/${id}`).phone = '9705550100';
  let asked = 0;
  await sendQuoteDraft(f.store, owner, body, LATER, { env: MESSAGING, deliver: async () => { asked += 1; return { status: 'submitted' }; } });
  assert.equal(asked, 1);
});

const request = (method, body, headers = {}, query = '') => new Request(`https://easygaragecleaning.com/api/quote-draft${query}`, { method, headers: { Origin: 'https://easygaragecleaning.com', ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) });

test('quote draft API: quote authors only, same origin, bounded JSON and a projection without private job data', async () => {
  const f = fixture();
  let actor = owner;
  const handlers = quoteDraftHandlers({ session: async () => actor, storage: () => f.store, now: () => new Date(NOW), delivery: () => ({ deliver: f.deliver }), stripe: () => null });
  const post = (body, headers, env = ENV) => handlers.post({ request: request('POST', body, headers), env });
  const saved = await post({ action: 'save', ...f.input() }, {}, MESSAGING);
  assert.equal(saved.status, 200); assert.equal(saved.headers.get('Cache-Control'), 'no-store');
  assert.equal(f.delivered.length, 0, 'even with messaging on, a save never notifies the customer');
  const id = (await saved.json()).job.id;
  Object.assign(f.rows.get(`jobs/${id}`), { internalNotes: 'SYNTHETIC-PRIVATE-NOTE', signature: 'data:image/png;base64,SYNTHETICSIGNATURE', payment: { receiptUrl: 'https://pay.stripe.com/receipts/SYNTHETIC-RECEIPT' }, highlevelContactId: 'provider1' });
  const view = await handlers.get({ request: request('GET', null, {}, `?jobId=${id}`), env: ENV });
  const text = await view.text();
  assert.equal(view.status, 200);
  for (const secret of ['SYNTHETIC-PRIVATE-NOTE', 'SYNTHETICSIGNATURE', 'SYNTHETIC-RECEIPT', 'provider1', 'split', 'catalog']) assert.equal(text.includes(secret), false, secret);
  assert.equal(JSON.parse(text).job.estimate.options[0].selectedTier, 'better');
  assert.equal((await handlers.get({ request: request('GET', null, {}, `?jobId=${id}&jobId=${id}`), env: ENV })).status, 400);
  assert.equal((await post({ action: 'save', ...f.input() }, { Origin: 'https://other.invalid' })).status, 403);
  assert.equal((await post({ action: 'save', ...f.input() }, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await post({ action: 'save', ...f.input() }, { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await post({ action: 'save', ...f.input() }, { 'Content-Length': '70000' })).status, 413);
  assert.equal((await post({ action: 'publish' })).status, 400);
  const preview = await (await post({ action: 'send_preview', jobId: id, expectedRevision: f.job(id).revision })).json();
  assert.equal(typeof preview.confirmToken, 'string'); assert.equal(preview.delivery.mode, 'off');
  const sent = await post({ action: 'send', requestId: randomUUID(), jobId: id, expectedRevision: f.job(id).revision, confirmToken: preview.confirmToken });
  assert.equal(sent.status, 200); assert.equal(f.job(id).estimate.status, 'sent');
  for (const person of [null, crew, sales]) {
    actor = person;
    const response = await post({ action: 'save', ...f.input() });
    assert.equal(response.status, person ? 403 : 401);
    assert.match((await response.json()).code, /^quote_(sign_in_required|forbidden)$/);
  }
  actor = sales;
  assert.equal((await post({ action: 'save', ...f.input({ sourceWalkthroughId: 'w2', customerId: 'c2', sourceRevision: 'w2r', draft: draft(d => { d.client = { name: 'Synthetic Other', phone: '9705550199', email: 'other@example.invalid', address: '200 Fixture Lane', highlevel_contact_id: 'provider2' }; }) }) }, {}, ROLES)).status, 200, 'a sales author may draft with role permissions on');
});

test('a sales author drafts and sends through the same confirmed path; a crew account cannot', async () => {
  const f = fixture(), created = await save(f, f.input(), sales, ROLES), id = created.job.id;
  assert.equal(f.job(id).createdBy, 'sales.person'); assert.equal(f.job(id).quoteDraft.createdBy, 'sales.person');
  const { result } = await sendFlow(f, id, { actor: sales, env: ROLES });
  assert.equal(result.job.estimate.status, 'sent'); assert.equal(f.job(id).estimate.sentBy, 'sales.person');
  await assert.rejects(save(f, revise(f, id), sales, ENV), error => error.code === 'quote_draft_forbidden' || error.code === 'quote_forbidden');
  for (const actor of [crew, { ...owner, role: 'crew' }]) await assert.rejects(save(f, f.input(), actor, ROLES), error => error.code === 'quote_forbidden');
});

test('quote draft receipts and the other records it writes stay server-only', () => {
  const rules = readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8');
  for (const collection of [QUOTE_DRAFT_RECEIPTS, MESSAGE_SENDS, CONFIRM_TOKEN_COLLECTION, 'hub_audit']) assert.match(rules, new RegExp(`match /${collection}/\\{documentId\\} \\{\\s*allow read, write: if false;`), collection);
});

test('the approved-send messenger adds only well-formed tags to a well-formed contact and classifies the answer like a send', async () => {
  const calls = [], answers = [200, 422, 408, 503];
  const messenger = createGhlMessenger({ env: MESSAGING, clock: () => new Date(NOW), fetcher: async (url, options) => { calls.push({ url, body: JSON.parse(options.body) }); return new Response('{}', { status: answers.shift() }); } });
  assert.deepEqual((await messenger.addTags({ contactId: 'provider1', tags: [ESTIMATE_READY_TAG, ESTIMATE_READY_TAG, 'Bad Tag'] })).status, 'submitted');
  assert.deepEqual(calls[0], { url: 'https://services.leadconnectorhq.com/contacts/provider1/tags', body: { tags: [ESTIMATE_READY_TAG] } });
  for (const expected of ['failed', 'uncertain', 'uncertain']) assert.equal((await messenger.addTags({ contactId: 'provider1', tags: [ESTIMATE_READY_TAG] })).status, expected);
  assert.equal((await messenger.addTags({ contactId: '../x', tags: [ESTIMATE_READY_TAG] })).reason, 'invalid_tags');
  // (merge, FUN-30) The messenger writes only its registered tags (MESSENGER_TAG_WRITES); any other tag is refused unsent.
  assert.equal((await messenger.addTags({ contactId: 'provider1', tags: ['egc-job-scheduled', 'egc-no-sms-consent'] })).reason, 'invalid_tags');
  assert.equal((await messenger.removeTags({ contactId: 'provider1', tags: ['egc-review-ready'] })).reason, 'invalid_tags');
  assert.equal((await createGhlMessenger({ env: {}, clock: () => new Date(NOW) }).addTags({ contactId: 'provider1', tags: [ESTIMATE_READY_TAG] })).reason, 'not_configured');
  const thrown = createGhlMessenger({ env: MESSAGING, clock: () => new Date(NOW), fetcher: async () => { throw new Error('reset'); } });
  assert.equal((await thrown.addTags({ contactId: 'provider1', tags: [ESTIMATE_READY_TAG] })).status, 'uncertain');
  assert.equal(calls.length, 4);
});

// The in-person signed plan for this fixture's customer (P2-05 handoff).
const signedPlan = (total = 1400) => ({ client: client(), quote: { title: 'Garage reset', total, deposit: total / 2, job_date: '2026-09-24', start_time: '09:00', end_time: '12:00', estimated_duration_min: 180 }, acceptance: { accepted_at: '2026-09-22T17:45:00.000Z', accepted_by: 'Synthetic Customer', signature_captured: true, method: 'in_person_signature', terms_version: '2026-09-deposit50' }, signature: 'data:image/png;base64,iVBORw0KGgo=', terms_version: '2026-09-deposit50', terms_accepted: true, photos: { before: 3 }, scope: { keep_items: 'Blue bicycle' }, discovery: {}, logistics: { crew_size: 2 }, internal_notes: 'Synthetic brief', client_checklists: { preJob: [], postJob: [] }, notes: '' });

test('a signed handoff that revises a portal-approved quote expires its open card checkout, and reports one it cannot close', async () => {
  const f = fixture(), created = await save(f, f.input()), id = created.job.id;
  await sendFlow(f, id);
  // The customer approved revision 1 in the portal and opened a deposit checkout for it.
  Object.assign(f.rows.get(`jobs/${id}`), { customerApproval: { status: 'approved', approvedAt: LATER, approvedBy: 'Synthetic Customer', amount: 1798, source: 'customer_portal' }, estimate: { ...f.job(id).estimate, status: 'approved', acceptedAt: LATER, acceptedBy: 'Synthetic Customer' }, quoteStatus: 'approved' });
  const approvedJob = f.job(id);
  f.rows.set(`customer_payment_checkouts/${id}`, { id, revision: 'k1', status: 'open', sessionId: 'cs_test_open', amountCents: 89900, fingerprint: checkoutFingerprint(approvedJob) });
  const stripeCalls = [], stripe = async (path, options) => { stripeCalls.push([path, options.method]); return { id: 'cs_test_open', status: 'expired' }; };
  const handlers = handoffHandlers({ session: async () => owner, storage: () => f.store, now: () => new Date(LATER), stripe: () => stripe });
  const body = { requestId: randomUUID(), customerId: 'c1', sourceWalkthroughId: 'w1', sourceRevision: f.rows.get('jobs/w1').revision, jobId: id, expectedRevision: f.job(id).revision, plan: signedPlan(1400) };
  const post = async () => { const response = await handlers.post({ request: new Request('https://easygaragecleaning.com/api/walkthrough-handoff', { method: 'POST', headers: { Origin: 'https://easygaragecleaning.com', 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), env: ENV }); return { status: response.status, body: await response.json() }; };
  const signed = await post();
  assert.equal(signed.status, 200);
  assert.deepEqual([f.job(id).estimate.revision, f.job(id).estimate.amount, f.job(id).estimate.depositRequired, f.job(id).estimate.status], [2, 1400, 700, 'accepted']);
  assert.notEqual(checkoutFingerprint(f.job(id)), checkoutFingerprint(approvedJob));
  assert.deepEqual(stripeCalls, [['checkout/sessions/cs_test_open/expire', 'POST']]);
  assert.deepEqual([f.rows.get(`customer_payment_checkouts/${id}`).status, f.rows.get(`customer_payment_checkouts/${id}`).expiredReason, signed.body.checkout.status], ['expired', 'quote_revised', 'expired']);
  assert.equal(signed.body.warnings.some(warning => warning.code === 'checkout_needs_review'), false);
  // A retry of the same request finds nothing left to close.
  const again = await post();
  assert.deepEqual([again.body.replayed, again.body.checkout.status, stripeCalls.length], [true, 'none', 1]);
  // Without Stripe configured, a checkout still open for other terms is reported, never silently left payable.
  f.rows.set(`customer_payment_checkouts/${id}`, { id, revision: 'k2', status: 'open', sessionId: 'cs_test_second', fingerprint: checkoutFingerprint(approvedJob) });
  const revised = await saveWalkthroughHandoff(f.store, owner, { requestId: randomUUID(), customerId: 'c1', sourceWalkthroughId: 'w1', sourceRevision: f.rows.get('jobs/w1').revision, jobId: id, expectedRevision: f.job(id).revision, plan: signedPlan(1600) }, LATER, { env: ENV, checkouts: job => expireStaleCheckout({ store: f.store, job, stripe: null, now: LATER }) });
  assert.deepEqual([revised.checkout.status, revised.checkout.reason], ['needs_review', 'stripe_not_configured']);
  assert.ok(revised.warnings.some(warning => warning.code === 'checkout_needs_review' && /Review it in Stripe/.test(warning.message)));
  assert.equal(f.rows.get(`customer_payment_checkouts/${id}`).status, 'open');
  // A brand-new signed job has no earlier checkout to look for.
  const g = fixture(), fresh = await saveWalkthroughHandoff(g.store, owner, { requestId: randomUUID(), customerId: 'c1', sourceWalkthroughId: 'w1', sourceRevision: g.rows.get('jobs/w1').revision, plan: signedPlan() }, NOW, { env: ENV, checkouts: () => { throw new Error('not a revision'); } });
  assert.equal('checkout' in fresh, false);
});

test('the estimate-ready tag is cleared and applied again for each sent revision; the log says only that the tag was applied', async () => {
  const f = fixture(), created = await save(f, f.input()), id = created.job.id;
  const first = await sendFlow(f, id, { env: MESSAGING, deliver: async () => ({ status: 'pending' }) });
  const calls = [], answers = { DELETE: 200, POST: 200 };
  const fetcher = async (url, options) => { calls.push({ method: options.method, url, body: JSON.parse(options.body), key: options.headers['Idempotency-Key'] }); return new Response('{}', { status: answers[options.method] }); };
  const clock = () => new Date(LATER), real = createGhlMessenger({ env: MESSAGING, fetcher, clock });
  // Only the contact lookup is faked; both tag requests go through the approved-send messenger.
  const messenger = { resolveRecipient: async () => ({ status: 'ready', contactId: 'provider1', channel: 'SMS', masked: '(•••) •••-0100', toNumber: '+19705550100' }), addTags: real.addTags, removeTags: real.removeTags };
  const deliver = createEstimateReadyDelivery({ store: f.store, env: MESSAGING, messenger, clock }).deliver;
  const delivered = await deliver(id, { requestId: first.body.requestId, actorId: 'zacb', actorRole: 'owner' });
  assert.deepEqual([delivered.status, delivered.tagReset], ['submitted', 'removed']);
  const tags = 'https://services.leadconnectorhq.com/contacts/provider1/tags';
  assert.deepEqual(calls.map(call => [call.method, call.url, call.body]), [['DELETE', tags, { tags: [ESTIMATE_READY_TAG] }], ['POST', tags, { tags: [ESTIMATE_READY_TAG] }]]);
  assert.equal(calls[0].key, `${calls[1].key}-reset`);
  const job = f.job(id);
  assert.deepEqual([job.estimateReady.status, job.estimateReady.tagReset, job.communicationLastStatus, job.communicationLog.at(-1).status], ['submitted', 'removed', 'tag_applied', 'tag_applied']);
  // Revision 2 is sent later: the contact already has the tag, so it is cleared and applied again.
  await save(f, revise(f, id, d => { d.scope = 'Cleanout plus metal shelving.'; }));
  const second = await sendFlow(f, id, { env: MESSAGING, deliver: async () => ({ status: 'pending' }) });
  answers.DELETE = 503;
  const resent = await deliver(id, { requestId: second.body.requestId, actorId: 'zacb', actorRole: 'owner' });
  assert.deepEqual([resent.status, resent.tagReset], ['submitted', 'unconfirmed'], 'an unconfirmed removal is reported, the tag is still applied');
  assert.deepEqual(calls.slice(2).map(call => call.method), ['DELETE', 'POST']);
  assert.deepEqual([f.job(id).estimateReady.revision, f.job(id).estimateReady.tagReset, f.job(id).communicationLastStatus], [2, 'unconfirmed', 'tag_applied']);
  assert.equal(calls.length, 4);
  // The author is told only what is known.
  const page = readFileSync(new URL('../crew/quote-draft.js', import.meta.url), 'utf8');
  assert.match(page, /The estimate-ready tag was applied in HighLevel; its workflow notifies the customer if that workflow is on\./);
  assert.doesNotMatch(page, /HighLevel was asked to notify the customer/);
});
