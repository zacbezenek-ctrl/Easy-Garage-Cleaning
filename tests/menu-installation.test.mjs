// The owner's controls for the quote builder on Hub > Catalog & pricing > Menu prices (POST /api/catalog menu.approve),
// which the builder flag alone opens while CATALOG_QUOTES_ENABLED is off.
//
// D12 (owner, 2026-10-18): every builder quote carries a Labor line, the estimated man-hours x $40.00 per man-hour, and
// shelving and storage installation is billed through it. So a goods quote no longer waits for the installation question;
// the owner sets the labor rate on Menu prices instead (laborRatePerManHourCents), recorded like every approval.
//
// Regression kept (found by tests/e2e-estimator-crew-day.test.mjs): with the owner's flags the installation question
// could not be answered at all, because the answer lived only in the pricing settings, which are closed while catalog
// pricing is off. The owner answers it with the menu approvals (goodsInstallationIncluded); either answer counts. It now
// matters only for a builder quote saved or signed before the Labor line existed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { catalogHandlers } from '../functions/api/catalog.js';
import { quoteDraftHandlers } from '../functions/api/quote-draft.js';
import { CATALOG_OPERATIONS, LABOR_RATE_ID, MENU_APPROVALS, MAX_MENU_CHANGES, readCompositeState } from '../functions/_lib/catalog-store.js';
import { DEFAULT_LABOR_RATE_CENTS, INSTALLATION_ID, LABOR_ID, builderMenu, compositeApproval, laborRate, priceCompositeQuote, validateMenuApprovals } from '../functions/_lib/composite-quote.js';
import { saveQuoteDraft } from '../functions/_lib/quote-draft.js';
import { saveWalkthroughHandoff } from '../functions/_lib/walkthrough-handoff.js';
import { LABOR_CENTS, LATER, NOW, ON_ENV, builderState, client, estimator, fixture, menu, owner, selection, signedPlan } from './helpers/estimator-fixture.mjs';

const ORIGIN = 'https://easygaragecleaning.com';
// An in-memory catalog store: the pricing settings, the menu approvals, receipts and the audit trail.
function catalogStore() {
  const rows = new Map();
  let tick = 0;
  return { rows, read: async (collection, id) => structuredClone(rows.get(`${collection}/${id}`) || null), commit: async writes => { const at = `rev-${++tick}`; for (const write of writes) rows.set(`${write.collection}/${write.id}`, { ...(rows.get(`${write.collection}/${write.id}`) || {}), ...structuredClone(write.patch), id: write.id, revision: at }); return { writeResults: writes.map(() => ({ updateTime: at })) }; } };
}
const post = (handlers, body, env = ON_ENV) => handlers.post({ request: new Request(`${ORIGIN}/api/catalog`, { method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), env });
const approve = (state, extra) => ({ action: 'menu.approve', requestId: randomUUID(), expectedRevision: state.approvals.revision, menuVersion: state.menu.menuVersion, settingsVersion: state.settings.settingsVersion, approve: [], revoke: [], ...extra });
const audits = store => [...store.rows.entries()].filter(([key]) => key.startsWith('hub_audit/')).map(([, row]) => row);

test('the owner sets the labor rate on Menu prices: approved at once, recorded with a receipt and an owner-only audit entry, and it prices every new builder quote', async () => {
  const store = catalogStore(), handlers = catalogHandlers({ session: async () => owner, storage: () => store, now: () => new Date(LATER), held: () => ({ heldJobIds: async () => [] }) });
  const state = () => readCompositeState(store);
  // Before any change: the owner's D12 decision, $40.00 per man-hour, approved.
  assert.equal(DEFAULT_LABOR_RATE_CENTS, 4000);
  assert.deepEqual(laborRate(await state()), { rateCents: 4000, source: 'default', reason: 'Owner decision (2026-10-18): $40.00 per man-hour.' });
  assert.deepEqual(builderMenu(await state()).labor, { rateCents: 4000, approved: true, source: 'default', reason: 'Owner decision (2026-10-18): $40.00 per man-hour.', minManHours: 0.5, maxManHours: 200, stepManHours: 0.25 });
  const before = priceCompositeQuote(await state(), selection(), { complete: true });
  assert.deepEqual([before.labor.rateCents, before.labor.totalCents], [4000, LABOR_CENTS]);
  // The rate alone is a valid request; it counts as one change, and the receipt and the audit entry record both amounts.
  const change = approve(await state(), { laborRatePerManHourCents: 4500 }), response = await post(handlers, change), body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.deepEqual([body.approvals.laborRatePerManHourCents, store.rows.get(`${MENU_APPROVALS}/current`).laborRatePerManHourCents], [4500, 4500]);
  assert.deepEqual(store.rows.get(`${CATALOG_OPERATIONS}/${change.requestId}`).result.laborRate, { rateCents: 4500, previous: 4000 });
  const audit = audits(store).find(row => row.requestId === change.requestId);
  assert.deepEqual([audit.action, audit.visibility], ['pricing_menu.approve', 'owner']);
  assert.match(JSON.stringify(audit.before), new RegExp(`${LABOR_RATE_ID}.*4000`));
  assert.match(JSON.stringify(audit.after), new RegExp(`${LABOR_RATE_ID}.*4500`));
  // A lost response retried with the same request replays the saved change and writes nothing more.
  const writes = store.rows.size, replay = await (await post(handlers, change)).json();
  assert.deepEqual([replay.replayed, replay.approvals.laborRatePerManHourCents, store.rows.size], [true, 4500, writes]);
  // New quotes price at the new rate; a quote priced at the old one waits until it is saved again.
  const now = await state();
  assert.deepEqual([builderMenu(now).labor.rateCents, builderMenu(now).labor.source], [4500, 'owner']);
  const after = priceCompositeQuote(now, selection(), { complete: true });
  assert.deepEqual([after.labor.totalCents, after.lineItems.at(-1).name, after.totalCents - before.totalCents], [27000, 'Labor: 6 man-hours × $45.00', 3000]);
  assert.deepEqual(compositeApproval(before.breakdown, now).blocked.filter(row => row.id === LABOR_ID).map(row => row.reason), ['The labor rate is now $45.00 per man-hour, but this quote has $40.00. Save the quote again to use the current rate.']);
  // A later price approval keeps the stored rate.
  const priceOnly = before.breakdown.lines.filter(line => !line.approved).slice(0, 1).map(line => ({ id: line.id, unitCents: line.unitCents }));
  assert.equal((await post(handlers, approve(await state(), { approve: priceOnly }))).status, 200);
  assert.equal(store.rows.get(`${MENU_APPROVALS}/current`).laborRatePerManHourCents, 4500);
});

test('with labor on the quote, goods no longer wait for the installation answer; the answer still counts for quotes saved before labor and can be taken back', async () => {
  const store = catalogStore(), handlers = catalogHandlers({ session: async () => owner, storage: () => store, now: () => new Date(LATER), held: () => ({ heldJobIds: async () => [] }) });
  const state = () => readCompositeState(store);
  const goods = priceCompositeQuote(builderState(), selection(), { complete: true }), approvals = goods.breakdown.lines.filter(line => !line.approved).map(line => ({ id: line.id, unitCents: line.unitCents }));
  assert.equal((await post(handlers, approve(await state(), { approve: approvals }))).status, 200);
  assert.deepEqual(compositeApproval(goods.breakdown, await state()), { ready: true, blocked: [] }, 'every goods price approved: the quote sends, installation is billed through labor');
  assert.deepEqual(builderMenu(await state()).installation, { included: true, billedAs: 'labor' });
  // The same quote saved before the Labor line existed: unsent, it must be saved again; signed, it keeps the earlier rule.
  const { labor, ...older } = goods.breakdown;
  assert.deepEqual(compositeApproval(older, await state()).blocked.map(row => row.id), [LABOR_ID, INSTALLATION_ID]);
  assert.deepEqual(compositeApproval(older, await state(), { requireLabor: false }).blocked.map(row => row.id), [INSTALLATION_ID]);
  // The earlier way to answer is closed while CATALOG_QUOTES_ENABLED is off; the menu answer works.
  const settings = await post(handlers, { action: 'settings.update', requestId: randomUUID(), expectedRevision: null, settings: { ...(await state()).settings, settingsVersion: 'owner-installation', goodsInstallationIncluded: true } });
  assert.deepEqual([settings.status, (await settings.json()).code], [404, 'catalog_disabled']);
  const answer = approve(await state(), { goodsInstallationIncluded: true }), response = await post(handlers, answer), body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.deepEqual([body.approvals.goodsInstallationIncluded, body.approvals.count, store.rows.get(`${MENU_APPROVALS}/current`).goodsInstallationIncluded], [true, approvals.length, true]);
  assert.deepEqual(store.rows.get(`${CATALOG_OPERATIONS}/${answer.requestId}`).result.installation, { included: true, previous: null });
  assert.match(JSON.stringify(audits(store).find(row => row.requestId === answer.requestId)), /goods-installation/);
  const answered = await state();
  assert.deepEqual([compositeApproval(older, answered, { requireLabor: false }), builderMenu(answered, { internal: true }).internal.installationConfirmed, builderMenu(answered, { internal: true }).internal.goodsInstallationIncluded], [{ ready: true, blocked: [] }, true, true]);
  // false takes it back for the older quote only; a quote with labor is unaffected.
  assert.equal((await post(handlers, approve(await state(), { goodsInstallationIncluded: false }))).status, 200);
  assert.ok(compositeApproval(older, await state(), { requireLabor: false }).blocked.some(row => row.id === INSTALLATION_ID));
  assert.deepEqual(compositeApproval(goods.breakdown, await state()), { ready: true, blocked: [] });
  // A saved pricing-settings answer (catalog pricing on) still counts on its own, as before.
  assert.equal(compositeApproval(older, { ...(await state()), settings: { ...(await state()).settings, goodsInstallationIncluded: true } }, { requireLabor: false }).ready, true);
});

test('the labor rate and the installation answer are checked: whole cents from $1 to $1,000 and a boolean, one change each, stored only when given, owner only, builder-flag only', async () => {
  const store = catalogStore(), handlers = catalogHandlers({ session: async () => owner, storage: () => store, now: () => new Date(LATER), held: () => ({ heldJobIds: async () => [] }) });
  const state = await readCompositeState(store);
  for (const value of ['yes', 1, null, {}]) {
    const response = await post(handlers, approve(state, { goodsInstallationIncluded: value }));
    assert.deepEqual([response.status, (await response.json()).code], [400, 'catalog_request_invalid'], JSON.stringify(value));
  }
  for (const value of ['4000', 40.5, 99, 100001, null, 0, -4000]) {
    const response = await post(handlers, approve(state, { laborRatePerManHourCents: value })), body = await response.json();
    assert.deepEqual([response.status, body.code], [400, 'catalog_request_invalid'], JSON.stringify(value));
    assert.match(body.error, /labor rate per man-hour in dollars and cents, from \$1\.00 to \$1,000\.00/);
  }
  const drafts = [...menu.products].filter(product => product.id.startsWith('hd-')).slice(0, MAX_MENU_CHANGES);
  const prices = new Map(builderMenu(builderState()).products.map(product => [product.id, product.unitCents]));
  const all = drafts.map(product => ({ id: product.id, unitCents: prices.get(product.id) }));
  for (const extra of [{ goodsInstallationIncluded: true }, { laborRatePerManHourCents: 4500 }]) {
    const full = await post(handlers, approve(state, { approve: all, ...extra }));
    assert.deepEqual([full.status, (await full.json()).code], [400, 'catalog_request_invalid'], `${MAX_MENU_CHANGES} prices and ${Object.keys(extra)[0]} are ${MAX_MENU_CHANGES + 1} changes`);
  }
  assert.equal(store.rows.size, 0, 'nothing was saved');
  // Without them nothing about installation or the labor rate is stored, exactly as before.
  const plain = await (await post(handlers, approve(state, { approve: [all[0]] }))).json();
  assert.deepEqual(['goodsInstallationIncluded' in plain.approvals, 'laborRatePerManHourCents' in plain.approvals], [false, false]);
  const saved = store.rows.get(`${MENU_APPROVALS}/current`);
  assert.deepEqual(['goodsInstallationIncluded' in saved, 'laborRatePerManHourCents' in saved], [false, false]);
  assert.equal('installationConfirmed' in builderMenu(await readCompositeState(store), { internal: true }).internal, false);
  assert.equal(laborRate(await readCompositeState(store)).rateCents, 4000);
  // A manager cannot change either; with the builder flag off menu.approve is not a catalog action at all.
  const manager = catalogHandlers({ session: async () => ({ user: 'tylerg', role: 'manager', businessAccess: true }), storage: () => store, now: () => new Date(LATER) });
  for (const extra of [{ goodsInstallationIncluded: true }, { laborRatePerManHourCents: 4500 }]) {
    assert.equal((await post(manager, approve(await readCompositeState(store), extra))).status, 403);
    assert.equal((await post(handlers, approve(await readCompositeState(store), extra), { ...ON_ENV, EGC_QUOTE_BUILDER_ENABLED: '' })).status, 404);
  }
  // A stored answer or rate that does not verify fails closed, like any other unverifiable approval.
  assert.throws(() => validateMenuApprovals({ items: {}, revision: 'r1', goodsInstallationIncluded: 'true' }), { code: 'quote_draft_composite_approvals_invalid' });
  for (const rate of ['4000', 40.5, 0, 100001]) assert.throws(() => validateMenuApprovals({ items: {}, revision: 'r1', laborRatePerManHourCents: rate }), { code: 'quote_draft_composite_approvals_invalid' }, String(rate));
});

test('held signed jobs: a job signed with labor is released by the owner\'s price approval alone; one signed before labor still waits for the installation answer', async () => {
  const f = fixture(), approvals = Object.fromEntries(priceCompositeQuote(builderState(), selection(), { complete: true }).breakdown.lines.filter(line => !line.approved).map(line => [line.id, line.unitCents]));
  const store = catalogStore();
  const state = () => readCompositeState(store);
  // The estimator's builder quote and its signed handoff (crew/quote-draft.js, crew/gameplan-handoff.js), all at draft prices.
  const sign = async n => {
    const priced = priceCompositeQuote(await state(), selection(), { complete: true });
    const saved = await saveQuoteDraft(f.store, estimator, { requestId: randomUUID(), customerId: `c${n}`, sourceWalkthroughId: `w${n}`, sourceRevision: `w${n}r`, draft: { client: client(n), title: 'Garage reset', scope: 'Shelving and storage.', line_items: priced.lineItems, valid_until: '2026-10-30', catalog_version: priced.menuVersion, crew_size: 2, estimated_duration_min: 180, composite_pricing: priced.compositePricing } }, NOW, { env: ON_ENV, compositeState: state });
    const job = f.job(saved.job.id), lines = priced.lineItems.map(line => ({ id: line.id, kind: line.kind, name: line.name, description: line.description, quantity: line.quantity, unitCents: line.unitCents, totalCents: line.totalCents }));
    return saveWalkthroughHandoff(f.store, estimator, { actorId: estimator.user, requestId: randomUUID(), customerId: `c${n}`, sourceWalkthroughId: `w${n}`, sourceRevision: f.rows.get(`jobs/w${n}`).revision, jobId: job.id, expectedRevision: job.revision,
      plan: signedPlan(n, { total: priced.totalCents / 100, quote: { composite_pricing: priced.compositePricing, line_items: lines, catalog_version: priced.menuVersion } }) }, NOW, { env: ON_ENV, compositeState: state });
  };
  const withLabor = await sign(1), olderJob = await sign(2);
  assert.deepEqual(withLabor.pricing.pending.length, 3, 'held for the draft prices only, never for installation');
  // The second job stands for one signed before builder quotes had a Labor line.
  const older = structuredClone(f.rows.get(`jobs/${olderJob.job.id}`));
  delete older.compositeQuote.breakdown.labor;
  f.rows.set(`jobs/${olderJob.job.id}`, older);
  const held = () => ({ ...f.store, heldJobIds: async limit => [...f.rows.values()].filter(row => row.pricesPendingApproval?.status === 'pending').map(row => row.id).slice(0, limit) });
  const handlers = catalogHandlers({ session: async () => owner, storage: () => store, now: () => new Date(LATER), held });
  const prices = await (await post(handlers, approve(await state(), { approve: Object.entries(approvals).map(([id, unitCents]) => ({ id, unitCents })) }))).json();
  assert.deepEqual(prices.heldJobs, { released: [withLabor.job.id], waiting: 1, more: false }, 'the job with labor is released; the older goods job waits for installation');
  assert.deepEqual([f.job(withLabor.job.id).pricesPendingApproval, f.job(withLabor.job.id).customerPortalInvitationRequestedAt, f.job(withLabor.job.id).pricesRelease.gate], [null, LATER, 'approved_prices']);
  const answered = await (await post(handlers, approve(await state(), { goodsInstallationIncluded: true }))).json();
  assert.deepEqual(answered.heldJobs, { released: [olderJob.job.id], waiting: 0, more: false });
  // The estimator's builder never warns about installation.
  const quotes = quoteDraftHandlers({ session: async () => estimator, storage: () => f.store, now: () => new Date(NOW), compositeState: state, stripe: () => null });
  const builder = await (await quotes.get({ request: new Request(`${ORIGIN}/api/quote-draft?view=builder`), env: ON_ENV })).json();
  assert.deepEqual([builder.installation, builder.labor.rateCents], [{ included: true, billedAs: 'labor' }, 4000]);
});

test('a held job signed at the old labor rate stays held when the owner changes the rate, until it is signed again at the new one', async () => {
  const f = fixture(), store = catalogStore(), state = () => readCompositeState(store);
  const priced = priceCompositeQuote(await state(), selection({ shelving: [], storage: [] }), { complete: true });
  const lines = priced.lineItems.map(line => ({ id: line.id, kind: line.kind, name: line.name, description: line.description, quantity: line.quantity, unitCents: line.unitCents, totalCents: line.totalCents }));
  const signed = await saveWalkthroughHandoff(f.store, estimator, { actorId: estimator.user, requestId: randomUUID(), customerId: 'c1', sourceWalkthroughId: 'w1', sourceRevision: 'w1r',
    plan: signedPlan(1, { total: priced.totalCents / 100, quote: { composite_pricing: priced.compositePricing, line_items: lines, catalog_version: priced.menuVersion } }) }, NOW, { env: ON_ENV, compositeState: state });
  assert.deepEqual(signed.pricing.pending, ['Two-car garage base']);
  const held = () => ({ ...f.store, heldJobIds: async limit => [...f.rows.values()].filter(row => row.pricesPendingApproval?.status === 'pending').map(row => row.id).slice(0, limit) });
  const handlers = catalogHandlers({ session: async () => owner, storage: () => store, now: () => new Date(LATER), held });
  const base = priced.breakdown.lines.find(line => !line.approved);
  const both = await (await post(handlers, approve(await state(), { approve: [{ id: base.id, unitCents: base.unitCents }], laborRatePerManHourCents: 4500 }))).json();
  assert.deepEqual(both.heldJobs, { released: [], waiting: 1, more: false }, 'the customer signed $40.00 labor; the owner\'s rate is now $45.00');
  assert.equal(f.job(signed.job.id).pricesPendingApproval.status, 'pending');
  const back = await (await post(handlers, approve(await state(), { laborRatePerManHourCents: 4000 }))).json();
  assert.deepEqual(back.heldJobs, { released: [signed.job.id], waiting: 0, more: false }, 'back at the signed rate the job is released');
});
