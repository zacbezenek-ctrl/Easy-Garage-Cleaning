// Signed jobs held for the owner's prices are released when the pricing-menu file itself approves them (a new menu
// version, e.g. the truck loads approved on 2026-10-21): the first time an owner or manager opens Catalog & pricing or the
// Hub home after the deploy, POST /api/held-jobs {action:'sweep'} releases every held job the menu now covers, page by
// page, and records the menu version only after a complete run. Synthetic data only (tests/helpers/estimator-fixture.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { priceCompositeQuote } from '../functions/_lib/composite-quote.js';
import { releaseAllHeldHandoffs, saveWalkthroughHandoff } from '../functions/_lib/walkthrough-handoff.js';
import { HELD_QUERY_MAX, countHeldJobs, heldJobIds, heldJobsQuery } from '../functions/_lib/handoff-price-holds.js';
import { HELD_RELEASE_MARKER, heldJobsHandlers } from '../functions/api/held-jobs.js';
import { BASE_ENV, LATER, NOW, ON_ENV, builderState, fixture, menuItem, owner, selection, signedPlan } from './helpers/estimator-fixture.mjs';

const manager = { user: 'AlexK', role: 'manager', businessAccess: true };
const pick = (name, quantity = 1) => ({ id: menuItem(name).id, quantity });
// The menu before 2026-10-21: the full truck $750 and approved, the partial loads drafts.
function menuBefore() {
  const menu = structuredClone(builderState().menu);
  menu.menuVersion = '2026-10-16.1';
  for (const item of menu.services.filter(row => row.basis?.kind === 'junk')) {
    if (item.basis.fraction === 1) { item.approvedPriceCents = 75000; continue; }
    item.status = 'draft'; delete item.approvedPriceCents; delete item.approval;
  }
  return menu;
}
const before = () => ({ ...builderState(), menu: menuBefore() });
const signedLines = priced => priced.lineItems.map(line => ({ id: line.id, kind: line.kind, name: line.name, description: line.description, quantity: line.quantity, unitCents: line.unitCents, totalCents: line.totalCents }));
async function signHalfLoad(f, n = 1) {
  const state = before(), priced = priceCompositeQuote(state, { ...selection({ removal: [pick('Full truck load'), pick('Half load')], shelving: [], storage: [], labor: { manHours: null, fullness: 'medium' } }), menuVersion: state.menu.menuVersion }, { complete: true });
  const quote = { composite_pricing: priced.compositePricing, line_items: signedLines(priced), catalog_version: priced.menuVersion, total: priced.totalCents / 100 };
  const saved = await saveWalkthroughHandoff(f.store, owner, { actorId: owner.user, requestId: randomUUID(), customerId: `c${n}`, sourceWalkthroughId: `w${n}`, sourceRevision: `w${n}r`, plan: signedPlan(n, { quote, total: quote.total }) }, NOW, { env: ON_ENV, compositeState: async () => state });
  return f.job(saved.job.id);
}
// The held job names in id order after `after`, as the Firestore query answers (handoff-price-holds.js heldJobsQuery).
const heldStore = (f, reads = []) => ({ ...f.store, heldJobIds: async (limit, after = '') => { reads.push([limit, after]); return [...f.rows.values()].filter(row => row.pricesPendingApproval?.status === 'pending').map(row => row.id).sort().filter(id => !after || id > after).slice(0, limit); } });
function catalogStore() {
  const rows = new Map(); let tick = 0;
  return { rows, read: async (collection, id) => structuredClone(rows.get(`${collection}/${id}`) || null),
    commit: async writes => { for (const write of writes) { const key = `${write.collection}/${write.id}`, current = rows.get(key); if ((current?.revision || null) !== (write.revision || null)) throw Object.assign(new Error('conflict'), { code: 'catalog_revision_conflict' }); rows.set(key, { ...structuredClone(write.patch), id: write.id, revision: `rev-${++tick}` }); } return {}; } };
}
const post = (handlers, body, env = ON_ENV) => handlers.post({ request: new Request('https://easygaragecleaning.com/api/held-jobs', { method: 'POST', headers: { Origin: 'https://easygaragecleaning.com', 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), env });

test('a job held only on a half load is released after the deploy, with no owner action, the first time a manager opens the Hub', async () => {
  const f = fixture(), job = await signHalfLoad(f);
  assert.deepEqual([job.total, job.pricesPendingApproval.status, job.compositeQuote.approval.pending.map(row => row.id)], [1125, 'pending', [menuItem('Half load').id]], 'signed at $750 + $375 and held for the half load\'s draft price');
  // Deployed: the menu file approves the half load at $500. Nobody saves an approval, so menu.approve never runs.
  const catalog = catalogStore(), reads = [];
  const handlers = actor => heldJobsHandlers({ session: async () => actor, storage: () => catalog, held: () => heldStore(f, reads), compositeState: async () => builderState(), now: () => new Date(LATER) });
  const first = await (await post(handlers(manager), { action: 'sweep' })).json();
  assert.deepEqual(first, { ok: true, enabled: true, ran: true, menuVersion: builderState().menu.menuVersion, released: [job.id], held: 0, more: false });
  const released = f.job(job.id);
  assert.deepEqual([released.pricesPendingApproval, released.total, released.estimate.amountCents, released.customerPortalInvitationRequestedAt, released.pricesRelease],
    [null, 1125, 112500, LATER, { at: LATER, by: manager.user, source: 'menu.version', requestId: '', gate: 'approved_prices' }], 'released at the amounts signed');
  assert.deepEqual([catalog.rows.get(`pricingMenuApprovals/${HELD_RELEASE_MARKER}`).menuVersion, catalog.rows.get(`pricingMenuApprovals/${HELD_RELEASE_MARKER}`).released], [builderState().menu.menuVersion, 1]);
  // The next open (any device, the owner or a manager) only counts: the version was handled.
  const commits = f.calls.length, again = await (await post(handlers(owner), { action: 'sweep' })).json();
  assert.deepEqual([again.ran, again.held, again.released, f.calls.length], [false, 0, [], commits]);
});

test('the sweep pages past the 25-job read limit, so jobs that keep waiting never starve the rest, and records the version only after a complete run', async () => {
  const f = fixture(), half = await signHalfLoad(f);
  // 30 held jobs ahead of it in id order that never pass (walkthrough-priced quotes the owner releases from the job).
  const waiting = { ...structuredClone(half), compositeQuote: undefined, pricesPendingApproval: { ...half.pricesPendingApproval, reason: 'walkthrough_priced' } };
  for (let i = 0; i < 30; i++) f.rows.set(`jobs/a-held-${String(i).padStart(2, '0')}`, { ...structuredClone(waiting), id: `a-held-${String(i).padStart(2, '0')}`, revision: `ar${i}` });
  f.rows.set('jobs/z-half', { ...structuredClone(half), id: 'z-half', revision: 'zr' });
  f.rows.delete(`jobs/${half.id}`);
  const reads = [], store = heldStore(f, reads);
  // Cut short (one page), nothing after the first 25 is checked and the run is not complete.
  const short = await releaseAllHeldHandoffs(store, owner, LATER, { env: ON_ENV, compositeState: async () => builderState(), maxPages: 1 });
  assert.deepEqual(short, { released: [], waiting: 25, complete: false });
  // The sweep through the API reads every page: the half-load job, 31st in id order, is released.
  const catalog = catalogStore(), handlers = heldJobsHandlers({ session: async () => owner, storage: () => catalog, held: () => store, compositeState: async () => builderState(), now: () => new Date(LATER) });
  reads.length = 0;
  const swept = await (await post(handlers, { action: 'sweep' })).json();
  assert.deepEqual([swept.ran, swept.released, swept.held, swept.more], [true, ['z-half'], 30, false]);
  assert.deepEqual(reads, [[26, ''], [26, 'a-held-24']], 'a second page after the 25th id');
  assert.equal(f.job('z-half').pricesPendingApproval, null);
  // The count after: 30 still held.
  assert.deepEqual(await countHeldJobs(store), { count: 30, more: false });
});

test('a failed run records nothing, so the next open tries again; the owner\'s button runs it on demand; managers cannot press it; builder off answers nothing', async () => {
  const f = fixture(), job = await signHalfLoad(f), catalog = catalogStore();
  const down = { ...f.store, heldJobIds: async () => { throw new Error('down'); } };
  const handlers = (actor, held) => heldJobsHandlers({ session: async () => actor, storage: () => catalog, held: () => held, compositeState: async () => builderState(), now: () => new Date(LATER) });
  const failed = await post(handlers(owner, down), { action: 'sweep' });
  assert.deepEqual([failed.status, (await failed.json()).code, catalog.rows.size], [503, 'held_jobs_unavailable', 0]);
  const refused = await post(handlers(manager, heldStore(f)), { action: 'release' });
  assert.deepEqual([refused.status, (await refused.json()).code, f.job(job.id).pricesPendingApproval.status], [403, 'catalog_owner_required', 'pending']);
  const button = await (await post(handlers(owner, heldStore(f)), { action: 'release' })).json();
  assert.deepEqual([button.ran, button.released, button.held], [true, [job.id], 0]);
  assert.equal(f.job(job.id).pricesRelease.source, 'held.release');
  for (const [body, status] of [[{ action: 'other' }, 400], [{ action: 'sweep', extra: 1 }, 400]]) assert.equal((await post(handlers(owner, heldStore(f)), body)).status, status);
  const crew = await post(handlers({ user: 'synthetic.crew', role: 'crew', businessAccess: false }, heldStore(f)), { action: 'sweep' });
  assert.equal(crew.status, 403);
  assert.deepEqual(await (await post(handlers(owner, down), { action: 'sweep' }, BASE_ENV)).json(), { ok: true, enabled: false });
});

test('the held-jobs query pages in id order after a cursor, on the automatic single-field index', async () => {
  assert.deepEqual(heldJobsQuery(26, 'job-25').structuredQuery.orderBy, [{ field: { fieldPath: '__name__' }, direction: 'ASCENDING' }]);
  assert.deepEqual(heldJobsQuery(26, 'job-25').structuredQuery.startAt, { values: [{ referenceValue: 'projects/egcw-1ec83/databases/(default)/documents/jobs/job-25' }], before: false });
  assert.equal('startAt' in heldJobsQuery(26).structuredQuery, false);
  const bodies = [], fetcher = async (env, url, init) => { bodies.push(JSON.parse(init.body)); return { ok: true, json: async () => [] }; };
  assert.deepEqual(await heldJobIds({}, HELD_QUERY_MAX, fetcher, 'job-25'), []);
  assert.equal(bodies[0].structuredQuery.startAt.values[0].referenceValue.endsWith('/jobs/job-25'), true);
  await assert.rejects(heldJobIds({}, 10, fetcher, 'bad/id'), error => error.code === 'handoff_held_jobs_unavailable');
});
