// Signed jobs held for the owner's prices are released when the pricing-menu file itself approves them (a new menu
// version, e.g. the truck loads approved on 2026-10-21): the first time an owner or manager opens Catalog & pricing or the
// Hub home after the deploy, POST /api/held-jobs {action:'sweep'} releases every held job the menu now covers, page by
// page, and records the menu version only after a complete run. Synthetic data only (tests/helpers/estimator-fixture.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { compositeApproval, priceCompositeQuote } from '../functions/_lib/composite-quote.js';
import { HELD_SUBREQUEST_BUDGET, releaseAllHeldHandoffs, saveWalkthroughHandoff } from '../functions/_lib/walkthrough-handoff.js';
import { readCompositeState } from '../functions/_lib/catalog-store.js';
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

// Cloudflare caps an invocation's subrequests (50 on the Free plan): a run stops cleanly at its budget, records where,
// and the next open continues from there; the menu version is recorded only after the pass that checked every job.
test('the sweep pages past the 25-job read limit and stops at its subrequest budget, so the next open continues and jobs that keep waiting never starve the rest', async () => {
  const f = fixture(), half = await signHalfLoad(f);
  // 30 held jobs ahead of it in id order that never pass (walkthrough-priced quotes the owner releases from the job).
  const waiting = { ...structuredClone(half), compositeQuote: undefined, pricesPendingApproval: { ...half.pricesPendingApproval, reason: 'walkthrough_priced' } };
  for (let i = 0; i < 30; i++) f.rows.set(`jobs/a-held-${String(i).padStart(2, '0')}`, { ...structuredClone(waiting), id: `a-held-${String(i).padStart(2, '0')}`, revision: `ar${i}` });
  f.rows.set('jobs/z-half', { ...structuredClone(half), id: 'z-half', revision: 'zr' });
  f.rows.delete(`jobs/${half.id}`);
  const reads = [], store = heldStore(f, reads), version = builderState().menu.menuVersion;
  // The library on its own, with room for both pages (26 + 7 storage calls and the release): the 31st job is released.
  const all = await releaseAllHeldHandoffs(store, owner, LATER, { env: ON_ENV, compositeState: async () => builderState(), source: 'menu.version', budget: 40 });
  assert.deepEqual([all.released, all.waiting, all.complete, reads], [['z-half'], 30, true, [[26, ''], [26, 'a-held-24']]]);
  f.rows.set('jobs/z-half', { ...structuredClone(half), id: 'z-half', revision: 'zr2' });
  // Through the API with a budget of 20: the first open checks 18 jobs (the query and 18 reads), stops and records where.
  const catalog = catalogStore(), handlers = heldJobsHandlers({ session: async () => owner, storage: () => catalog, held: () => store, compositeState: async () => builderState(), budget: 20, now: () => new Date(LATER) });
  reads.length = 0;
  const first = await (await post(handlers, { action: 'sweep' })).json();
  const marker = () => catalog.rows.get(`pricingMenuApprovals/${HELD_RELEASE_MARKER}`);
  assert.deepEqual([first.ran, first.released, first.held, first.more, marker().menuVersion, marker().sweepVersion, marker().sweepAfter], [true, [], 18, true, undefined, version, 'a-held-17']);
  // The next open continues after the 18th job, releases the half-load job and records the version.
  const second = await (await post(handlers, { action: 'sweep' })).json();
  assert.deepEqual([second.ran, second.released, second.held, second.more, marker().menuVersion, marker().sweepAfter], [true, ['z-half'], 30, false, version, '']);
  assert.deepEqual(reads.slice(0, 2), [[26, ''], [26, 'a-held-17']], 'the second open starts after the 18th id');
  assert.equal(f.job('z-half').pricesPendingApproval, null);
  // After that, opens only count.
  const third = await (await post(handlers, { action: 'sweep' })).json();
  assert.deepEqual([third.ran, third.held], [false, 30]);
  assert.deepEqual(await countHeldJobs(store), { count: 30, more: false });
});

// Every storage call one open makes, counted (Cloudflare Free allows 50 subrequests per invocation): the marker read,
// the owner's two pricing documents, the release run (at most HELD_SUBREQUEST_BUDGET), the marker write and, on the open
// that finishes a pass begun mid-way, the count of the jobs still held (one query per 100, at most 10). The worst case is
// that last open with a full run: 1,025 held jobs that never pass and one that does, last in id order, so the last open
// checks 26 jobs and releases the 27th (30 run calls) and then counts (10 queries): 44.
test('one open of the sweep stays within Cloudflare\'s 50 subrequests: at most 44, on the last open of a long pass', async () => {
  const f = fixture(), half = await signHalfLoad(f);
  const waiting = { ...structuredClone(half), compositeQuote: undefined, pricesPendingApproval: { ...half.pricesPendingApproval, reason: 'walkthrough_priced' } };
  for (let i = 0; i < 1025; i++) f.rows.set(`jobs/a-held-${String(i).padStart(4, '0')}`, { ...structuredClone(waiting), id: `a-held-${String(i).padStart(4, '0')}`, revision: `ar${i}` });
  f.rows.set('jobs/z-half', { ...structuredClone(half), id: 'z-half', revision: 'zr' });
  f.rows.delete(`jobs/${half.id}`);
  let calls = 0;
  const count = fn => async (...args) => { calls++; return fn(...args); };
  const base = heldStore(f), jobs = { ...base, heldJobIds: count(base.heldJobIds), read: count(base.read), commit: count(base.commit) };
  const rows = catalogStore(), catalog = { ...rows, read: count(rows.read), commit: count(rows.commit) };
  const handlers = heldJobsHandlers({ session: async () => owner, storage: () => catalog, held: () => jobs, compositeState: () => readCompositeState(catalog), now: () => new Date(LATER) });
  const marker = () => rows.rows.get(`pricingMenuApprovals/${HELD_RELEASE_MARKER}`), perOpen = [];
  let answer;
  do { calls = 0; answer = await (await post(handlers, { action: 'sweep' })).json(); perOpen.push(calls); } while (!marker()?.menuVersion && perOpen.length < 100);
  assert.equal(HELD_SUBREQUEST_BUDGET, 30);
  assert.deepEqual([perOpen.length, answer.released, answer.held, answer.more, f.job('z-half').pricesPendingApproval], [38, ['z-half'], 1000, true, null], 'the count stops at 1,000 and says there are more');
  assert.equal(Math.max(...perOpen), 44, `storage calls per open: ${perOpen.join(', ')}`);
  assert.deepEqual([perOpen.at(-1), new Set(perOpen.slice(0, -1))], [44, new Set([33])], 'a stopped open: the marker, the pricing, 29 run calls and the marker write');
  calls = 0; await post(handlers, { action: 'sweep' });
  assert.equal(calls, 11, 'later opens only count: the marker and 10 name queries');
});

test('a job read that fails waits and the run goes on; a release that does not commit is tried again before the version is recorded', async () => {
  const f = fixture(), half = await signHalfLoad(f), version = builderState().menu.menuVersion;
  f.rows.set('jobs/a-broken', { ...structuredClone(half), id: 'a-broken', revision: 'br' });
  let commitFails = true;
  const base = heldStore(f), store = { ...base,
    read: async (collection, id) => { if (id === 'a-broken') throw Object.assign(new Error('incomplete'), { code: 'dispatch_storage_incomplete' }); return base.read(collection, id); },
    commit: async writes => { if (commitFails && writes.some(write => write.id === half.id)) throw new Error('unavailable'); return base.commit(writes); } };
  const catalog = catalogStore(), handlers = heldJobsHandlers({ session: async () => owner, storage: () => catalog, held: () => store, compositeState: async () => builderState(), now: () => new Date(LATER) });
  const marker = () => catalog.rows.get(`pricingMenuApprovals/${HELD_RELEASE_MARKER}`);
  const first = await (await post(handlers, { action: 'sweep' })).json();
  assert.deepEqual([first.ran, first.released, first.held, marker().menuVersion, marker().sweepVersion, marker().sweepAfter], [true, [], 2, undefined, version, ''], 'the unreadable job waits; the failed release keeps the version open');
  commitFails = false;
  const second = await (await post(handlers, { action: 'sweep' })).json();
  assert.deepEqual([second.released, second.held, marker().menuVersion], [[half.id], 1, version]);
});

// The customer keeps the price signed but is never charged more than the owner approved (owner decision 2026-10-21).
test('a signed draft price above the amount the owner approves stays held, and the sweep does not release it', async () => {
  const f = fixture(), mattress = menuItem('Mattress');
  const state = builderState(), priced = priceCompositeQuote(state, selection({ removal: [pick('Full truck load'), pick('Mattress')], shelving: [], storage: [], labor: { manHours: null, fullness: 'medium' } }), { complete: true });
  const quote = { composite_pricing: priced.compositePricing, line_items: signedLines(priced), catalog_version: priced.menuVersion, total: priced.totalCents / 100 };
  const saved = await saveWalkthroughHandoff(f.store, owner, { actorId: owner.user, requestId: randomUUID(), customerId: 'c1', sourceWalkthroughId: 'w1', sourceRevision: 'w1r', plan: signedPlan(1, { quote, total: quote.total }) }, NOW, { env: ON_ENV, compositeState: async () => state });
  const job = f.job(saved.job.id);
  assert.equal(job.compositeQuote.breakdown.lines.find(line => line.id === mattress.id).unitCents, 7000, 'signed at the $70 draft price');
  // The owner approves the mattress at $60: the job stays held, with the reason, and is never told to save again.
  const lower = builderState({ [mattress.id]: 6000 });
  const approval = compositeApproval(job.compositeQuote.breakdown, lower, { signed: true });
  assert.deepEqual(approval.blocked.map(row => [row.id, row.resave ?? null]), [[mattress.id, null]]);
  assert.match(approval.blocked[0].reason, /^The owner approved \$60\.00 for Mattress, less than the \$70\.00 the customer signed\. The customer is never charged more than the approved price: rebuild the quote and have the customer sign it again\.$/);
  assert.doesNotMatch(approval.blocked[0].reason, /no owner approval is needed|Save the quote again/);
  const catalog = catalogStore(), handlers = heldJobsHandlers({ session: async () => owner, storage: () => catalog, held: () => heldStore(f), compositeState: async () => lower, now: () => new Date(LATER) });
  const swept = await (await post(handlers, { action: 'sweep' })).json();
  assert.deepEqual([swept.released, swept.held, f.job(job.id).pricesPendingApproval.status, f.job(job.id).customerPortalInvitationRequestedAt], [[], 1, 'pending', undefined]);
  // Approved at $70 or more, it releases at the $70 signed.
  const button = await (await heldJobsHandlers({ session: async () => owner, storage: () => catalog, held: () => heldStore(f), compositeState: async () => builderState({ [mattress.id]: 8000 }), now: () => new Date(LATER) }).post({ request: new Request('https://easygaragecleaning.com/api/held-jobs', { method: 'POST', headers: { Origin: 'https://easygaragecleaning.com', 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'release' }) }), env: ON_ENV })).json();
  assert.deepEqual([button.released, f.job(job.id).total], [[job.id], 1070]);
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
