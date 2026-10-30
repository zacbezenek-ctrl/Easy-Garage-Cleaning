// Minimum pickup (owner decision 2026-10-21: "minimum pickup should be 250, unless they are booking when a truck is
// nearby"): functions/_lib/pickup-minimum.js. Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { menuPrices, priceCompositeQuote } from '../functions/_lib/composite-quote.js';
import { estimateTotals } from '../functions/_lib/quote-model.js';
import { previewQuoteSend, saveQuoteDraft, sendQuoteDraft } from '../functions/_lib/quote-draft.js';
import { saveWalkthroughHandoff } from '../functions/_lib/walkthrough-handoff.js';
import { SENT_25_75 } from '../functions/_lib/quote-payment-policy.js';
import { PICKUP_MINIMUM_CENTS, PICKUP_MINIMUM_LINE_ID, nearbyJob, pickupFloorCents, pickupWaiverProblem, serviceZip } from '../functions/_lib/pickup-minimum.js';
import { mutateMoney } from '../functions/_lib/money-service.js';
import { mutateDispatch } from '../functions/_lib/dispatch-service.js';
import { mutateJobOperation } from '../functions/_lib/job-operations.js';
import { mutateScheduledVisit } from '../functions/_lib/operations-scheduling.js';
import { WINTER_SALE_DEFAULTS, WINTER_SALE_LINE_ID, winterSaleDecision } from '../functions/_lib/winter-sale.js';
import { HUB_AUDIT_COLLECTION } from '../functions/_lib/hub-audit.js';
import { builderState, client, estimator, fixture, menuItem, owner, selection, signedPlan } from './helpers/estimator-fixture.mjs';
import { env as portalEnv, portalCookie, portalHandlers, portalPost, portalStore, portalView } from './helpers/portal-fixture.mjs';

const ON = { HUB_SESSION_SECRET: 'synthetic-minimum-pickup-secret-0123456789', EGC_STAFF_ROLE_PERMISSIONS: 'true', EGC_QUOTE_BUILDER_ENABLED: 'true', EGC_WINTER_SALE: 'true' };
const NOW = '2026-10-17T15:00:00.000Z', DAY = '2026-12-14', ZIP_ADDRESS = '100 Fixture Lane, Fort Collins, CO 80521';
const allApproved = (extra = {}) => { const prices = {}; for (const [id, price] of menuPrices(builderState())) if (price.unitCents !== null) prices[id] = price.unitCents; return builderState({ ...prices, ...extra }); };
const id = name => menuItem(name).id;
// The menu with one owner-approved price changed (synthetic), as the owner sets it on Hub Menu prices.
const cheaper = (name, cents) => { const state = allApproved(), menu = structuredClone(state.menu); Object.assign(menu.services.find(item => item.name === name), { status: 'approved', approvedPriceCents: cents }); return { ...state, menu }; };
// A single sofa ($70) is a pickup: special handling with no truck load, so it keeps its Labor line (D-JUNK).
const SOFA = (extra = {}) => ({ ...selection({ removal: [{ id: id('Sofa / loveseat'), quantity: 1 }], shelving: [], storage: [], labor: { manHours: null, fullness: 'medium' } }), ...extra });
const NEARBY = { reason: 'Crew on a job two streets over that morning' };
const sum = lines => lines.reduce((total, line) => total + line.totalCents, 0);
// The sale's readers with synthetic costs and a synthetic margin floor (winter-sale.js).
const saleReaders = { settings: async () => ({ revision: null, ...WINTER_SALE_DEFAULTS, marginFloorBp: 1234, junkManHoursPerLoad: 1 }), costs: async () => ({ wageCentsPerManHour: 2000, workersCompBp: 0, payrollTaxBp: 0, burdenCentsPerManHour: 0, dumpFeeCentsPerLoad: 0, truckCentsPerJob: 0, goodsTaxBp: 0 }), setter: async () => false };
// The jobs one day holds (pickup-minimum.js pickupReaders): another job in the same ZIP code, or none.
const nearby = (jobs = []) => ({ nearby: async (env, date) => jobs.filter(job => job.date === date) });
const NEIGHBOUR = { id: 'job_neighbour', type: 'job', date: DAY, status: 'scheduled', address: '9 Other Street, Fort Collins, CO 80521' };

function quote(sel, state = allApproved()) {
  const priced = priceCompositeQuote(state, sel, { complete: true });
  return { priced, state, draft: extra => ({ client: client(1), title: 'Pickup', scope: 'Pickup.', line_items: priced.lineItems, valid_until: '2026-10-30', catalog_version: priced.menuVersion, crew_size: 2, estimated_duration_min: 60, composite_pricing: priced.compositePricing, ...extra }) };
}
async function save(f, actor, q, { extra = {}, jobId = null, pickup = nearby(), now = NOW } = {}) {
  const job = jobId ? f.job(jobId) : null;
  return saveQuoteDraft(f.store, actor, { requestId: randomUUID(), customerId: 'c1', sourceWalkthroughId: 'w1', ...(job ? { jobId, expectedRevision: job.revision } : { sourceRevision: f.rows.get('jobs/w1').revision }), draft: q.draft(extra) }, now,
    { env: ON, compositeState: async () => q.state, winterSale: saleReaders, pickup, newQuotePaymentPolicy: SENT_25_75 });
}
const preview = (f, q, jobId, actor = estimator, pickup = nearby()) => previewQuoteSend(f.store, actor, { jobId, expectedRevision: f.job(jobId).revision }, NOW, { env: ON, compositeState: async () => q.state, winterSale: saleReaders, pickup });

test('a single $70 sofa quotes at the $250 minimum: a visible Minimum pickup line, Labor kept, never junk-only', () => {
  const { priced } = quote(SOFA());
  const sofa = priced.lineItems.find(line => line.id === 'removal-special'), labor = priced.lineItems.find(line => line.kind === 'labor'), minimum = priced.lineItems.find(line => line.id === PICKUP_MINIMUM_LINE_ID);
  assert.equal(sofa.totalCents, 7000);
  // Special items without a truck keep their Labor line (D-JUNK): the minimum raises sofa and Labor together to $250.
  assert.ok(labor, 'the Labor line stays');
  assert.deepEqual([minimum.name, minimum.kind, minimum.totalCents], ['Minimum pickup', 'fee', PICKUP_MINIMUM_CENTS - 7000 - labor.totalCents]);
  assert.equal(priced.totalCents, PICKUP_MINIMUM_CENTS);
  assert.equal(estimateTotals(priced.lineItems).totalCents, PICKUP_MINIMUM_CENTS);
  assert.equal(priced.lineItems.at(-1).kind, 'labor', 'Labor stays the last line');
  assert.deepEqual([priced.junkOnly, priced.pickup.haulingOnly, priced.breakdown.pickup.minimumCents], [false, true, minimum.totalCents]);
  assert.equal(priced.breakdown.lines.some(line => line.id === PICKUP_MINIMUM_LINE_ID), false, 'not a menu line: junkOnly and the approvals read only the menu lines');
});

test('loads at or above $250 and any garage work are unchanged; a junk-only pickup below it stays junk-only', () => {
  const half = quote(selection({ removal: [{ id: id('Half load'), quantity: 1 }], shelving: [], storage: [] })).priced;
  assert.deepEqual([half.totalCents, half.junkOnly, half.lineItems.some(line => line.id === PICKUP_MINIMUM_LINE_ID)], [50000, true, false]);
  const quarter = quote(selection({ removal: [{ id: id('Quarter load'), quantity: 1 }], shelving: [], storage: [] })).priced;
  assert.deepEqual([quarter.totalCents, quarter.lineItems.some(line => line.id === PICKUP_MINIMUM_LINE_ID)], [25000, false], 'exactly $250 needs no line');
  const full = quote(selection({ removal: [{ id: id('Full truck load'), quantity: 1 }], shelving: [], storage: [] })).priced;
  assert.equal(full.totalCents, 100000);
  // A sofa with a garage cleaning base is garage work: no minimum, whatever the total.
  const garage = quote(selection({ removal: [{ id: id('Two-car garage base'), quantity: 1 }, { id: id('Sofa / loveseat'), quantity: 1 }], shelving: [], storage: [], labor: { manHours: 0.5, fullness: 'light' } })).priced;
  assert.equal(garage.lineItems.some(line => line.id === PICKUP_MINIMUM_LINE_ID), false);
  // A junk-only quote the owner priced below $250 (synthetic quarter-load price): topped up, still junk-only, no Labor.
  const cheap = quote(selection({ removal: [{ id: id('Quarter load'), quantity: 1 }], shelving: [], storage: [] }), cheaper('Quarter load', 20000)).priced;
  assert.deepEqual([cheap.junkOnly, cheap.labor, cheap.lineItems.some(line => line.kind === 'labor'), cheap.totalCents, cheap.lineItems.find(line => line.id === PICKUP_MINIMUM_LINE_ID)?.totalCents], [true, null, false, 25000, 5000]);
});

test('the truck-nearby waiver drops the line and needs a reason; the browser can never add, drop or price the line', async () => {
  const waived = quote(SOFA({ nearbyTruck: NEARBY })).priced;
  assert.equal(waived.lineItems.some(line => line.id === PICKUP_MINIMUM_LINE_ID), false);
  assert.equal(waived.totalCents, sum(waived.lineItems), 'the price is what the lines add up to');
  assert.ok(waived.totalCents < PICKUP_MINIMUM_CENTS);
  assert.deepEqual([waived.pickup.waived, waived.pickup.waivedCents], [true, PICKUP_MINIMUM_CENTS - waived.totalCents]);
  for (const nearbyTruck of [{ reason: '' }, { reason: 'ok' }, {}, { reason: NEARBY.reason, job: 'x' }, 'yes']) assert.throws(() => quote(SOFA({ nearbyTruck })), { code: 'quote_draft_composite_invalid_selection' }, JSON.stringify(nearbyTruck));
  // A save whose lines drop, change or add the line is refused.
  const q = quote(SOFA()), lines = q.priced.lineItems;
  for (const tampered of [lines.filter(line => line.id !== PICKUP_MINIMUM_LINE_ID), lines.map(line => line.id === PICKUP_MINIMUM_LINE_ID ? { ...line, unitCents: 100, totalCents: 100 } : line)]) {
    await assert.rejects(save(fixture(ON), estimator, q, { extra: { line_items: tampered } }), { code: 'quote_draft_composite_price_changed' });
  }
  const h = quote(selection({ removal: [{ id: id('Half load'), quantity: 1 }], shelving: [], storage: [] }));
  await assert.rejects(save(fixture(ON), estimator, h, { extra: { line_items: [...h.priced.lineItems, { id: PICKUP_MINIMUM_LINE_ID, kind: 'fee', name: 'Minimum pickup', quantity: 1, unitCents: 100, totalCents: 100 }] } }), { code: 'quote_draft_composite_price_changed' });
});

test('the 25% deposit is worked out on the topped-up total', async () => {
  const f = fixture(ON), saved = await save(f, estimator, quote(SOFA())), estimate = f.job(saved.job.id).estimate;
  assert.deepEqual([estimate.amountCents, estimate.depositRequiredCents], [25000, 6250]);
});

test('the winter sale runs first on the pickup total and never takes it below $250; a pickup at the minimum gets none', async () => {
  // The decision itself: the sale is capped at the total less the minimum, override or not.
  const cap = { known: true, capCents: 40000 };
  assert.equal(winterSaleDecision({ beforeCents: 31600, today: '2026-10-17', cap, minimumCents: 25000 }).amountCents, 6600);
  assert.equal(winterSaleDecision({ beforeCents: 31600, today: '2026-10-17', cap: { known: true, capCents: 0 }, override: { reason: 'Owner call' }, ownerOverride: true, minimumCents: 25000 }).amountCents, 6600);
  assert.deepEqual(winterSaleDecision({ beforeCents: 25000, today: '2026-10-17', cap, minimumCents: 25000 }), { eligible: false, code: 'at_minimum', reason: 'Not eligible: a pickup never goes below the $250 minimum pickup.', overridden: false, amountCents: 0 });
  // A sofa quote at the minimum: the Minimum pickup line, no sale line.
  const f = fixture(ON), atMinimum = await save(f, estimator, quote(SOFA()), { extra: { winter_sale: { apply: true } } }), lines = f.job(atMinimum.job.id).estimate.lineItems;
  assert.deepEqual([lines.some(line => line.id === PICKUP_MINIMUM_LINE_ID), lines.some(line => line.id === WINTER_SALE_LINE_ID), atMinimum.job.winterSale.code], [true, false, 'at_minimum']);
  // Three single items (above $250 with their Labor): the sale takes it down to exactly $250, never below.
  const three = quote(selection({ removal: [{ id: id('Sofa / loveseat'), quantity: 1 }, { id: id('Mattress'), quantity: 1 }, { id: id('Recliner'), quantity: 1 }], shelving: [], storage: [], labor: { manHours: null, fullness: 'medium' } }));
  assert.ok(three.priced.totalCents > PICKUP_MINIMUM_CENTS && three.priced.totalCents - PICKUP_MINIMUM_CENTS < 40000, String(three.priced.totalCents));
  const g = fixture(ON), sold = await save(g, estimator, three, { extra: { winter_sale: { apply: true } } }), estimate = g.job(sold.job.id).estimate;
  assert.equal(estimate.amountCents, PICKUP_MINIMUM_CENTS, 'net $250 with the sale');
  assert.equal(estimate.lineItems.find(line => line.id === WINTER_SALE_LINE_ID).totalCents, PICKUP_MINIMUM_CENTS - three.priced.totalCents);
  assert.equal(estimate.lineItems.some(line => line.id === PICKUP_MINIMUM_LINE_ID), false, 'the two lines never show together');
});

test('the nearby rule: another scheduled job the same day in the same 5-digit ZIP code', () => {
  assert.deepEqual([serviceZip('1 Main St, Fort Collins, CO 80521'), serviceZip('1 Main St, Loveland CO 80538-1234'), serviceZip('12 Elm Court'), serviceZip('')], ['80521', '80538', '', '']);
  const jobs = [NEIGHBOUR, { ...NEIGHBOUR, id: 'cancelled', status: 'cancelled' }, { ...NEIGHBOUR, id: 'walk', type: 'walkthrough' }, { ...NEIGHBOUR, id: 'self' }, { ...NEIGHBOUR, id: 'far', address: '9 Way, Loveland, CO 80538' }];
  assert.equal(nearbyJob(jobs, { jobId: 'self', date: DAY, zip: '80521' }).id, 'job_neighbour');
  assert.equal(nearbyJob(jobs.slice(1), { jobId: 'self', date: DAY, zip: '80521' }), null, 'cancelled, walkthrough, this job itself and another ZIP code never count');
  assert.equal(nearbyJob(jobs, { jobId: 'self', date: '2026-12-15', zip: '80521' }), null, 'another day never counts');
});

test('a waiver on a booked job: refused with no nearby job, accepted with one (audited with its id), or the owner overrides', async () => {
  const q = quote(SOFA({ nearbyTruck: NEARBY }));
  const booked = async () => { const f = fixture(ON), first = await save(f, estimator, quote(SOFA())); Object.assign(f.job(first.job.id), { date: DAY, address: ZIP_ADDRESS }); return { f, jobId: first.job.id }; };
  const none = await booked();
  await assert.rejects(save(none.f, estimator, q, { jobId: none.jobId }), { code: 'quote_draft_pickup_waiver_unconfirmed', status: 409, message: `No other job is booked on ${DAY} in this job's ZIP code, so the truck-nearby waiver can't apply. Remove the waiver (the $250 minimum pickup applies) or ask the owner.` });
  const yes = await booked();
  await save(yes.f, estimator, q, { jobId: yes.jobId, pickup: nearby([NEIGHBOUR]) });
  const job = yes.f.job(yes.jobId);
  assert.deepEqual([job.estimate.amountCents, job.quoteDraft.minimumWaiver.nearbyJobId, job.quoteDraft.minimumWaiver.reason, job.quoteDraft.minimumWaiver.by], [q.priced.totalCents, 'job_neighbour', NEARBY.reason, estimator.user]);
  const audit = yes.f.writesTo(HUB_AUDIT_COLLECTION).find(write => write.patch.action === 'quote.minimum_pickup.waive');
  assert.deepEqual([JSON.parse(audit.patch.after).nearbyJobId, audit.patch.reason, audit.patch.actor.id], ['job_neighbour', NEARBY.reason, estimator.user]);
  assert.equal(JSON.stringify(job.estimate).includes('job_neighbour'), false, 'the nearby job never reaches the customer\'s estimate');
  const own = await booked();
  await save(own.f, owner, q, { jobId: own.jobId });
  assert.deepEqual([own.f.job(own.jobId).quoteDraft.minimumWaiver.ownerOverride, own.f.job(own.jobId).quoteDraft.minimumWaiver.nearbyJobId], [true, null]);
});

test('a waiver saved before the job is booked is confirmed at send (recorded and audited there)', async () => {
  const q = quote(SOFA({ nearbyTruck: NEARBY })), f = fixture(ON), saved = await save(f, estimator, q), jobId = saved.job.id;
  assert.equal(f.job(jobId).quoteDraft.minimumWaiver.pending, true);
  await assert.rejects(preview(f, q, jobId), { code: 'quote_draft_pickup_waiver_unconfirmed', message: /Book the job date first/ });
  Object.assign(f.job(jobId), { date: DAY, address: ZIP_ADDRESS });
  await assert.rejects(preview(f, q, jobId), { code: 'quote_draft_pickup_waiver_unconfirmed' });
  const ok = await preview(f, q, jobId, estimator, nearby([NEIGHBOUR]));
  await sendQuoteDraft(f.store, estimator, { requestId: randomUUID(), jobId, expectedRevision: f.job(jobId).revision, confirmToken: ok.confirmToken }, NOW, { env: ON, compositeState: async () => q.state, winterSale: saleReaders, pickup: nearby([NEIGHBOUR]) });
  assert.deepEqual([f.job(jobId).estimate.status, f.job(jobId).quoteDraft.minimumWaiver.nearbyJobId, f.job(jobId).quoteDraft.minimumWaiver.pending], ['sent', 'job_neighbour', false]);
  assert.ok(f.writesTo(HUB_AUDIT_COLLECTION).some(write => write.patch.action === 'quote.minimum_pickup.waive' && JSON.parse(write.patch.after).nearbyJobId === 'job_neighbour'));
});

test('signed in person: the waiver is checked for the booked day and the signed address', async () => {
  const q = quote(SOFA({ nearbyTruck: NEARBY })), f = fixture(ON), saved = await save(f, estimator, q), draft = f.job(saved.job.id);
  const sign = pickup => {
    const job = f.job(draft.id), plan = signedPlan(1, { total: job.estimate.amountCents / 100, date: DAY, quote: { composite_pricing: q.priced.compositePricing, catalog_version: q.priced.menuVersion, line_items: job.estimate.lineItems.map(({ id, kind, name, description, quantity, unitCents, totalCents }) => ({ id, kind, name, description, quantity, unitCents, totalCents })) } });
    plan.client.address = ZIP_ADDRESS;
    return saveWalkthroughHandoff(f.store, estimator, { actorId: estimator.user, requestId: randomUUID(), customerId: 'c1', sourceWalkthroughId: 'w1', sourceRevision: f.rows.get('jobs/w1').revision, jobId: job.id, expectedRevision: job.revision, plan }, NOW, { env: ON, compositeState: async () => q.state, winterSale: saleReaders, pickup });
  };
  await assert.rejects(sign(nearby()), { code: 'handoff_pickup_waiver_unconfirmed', status: 409 });
  const signed = await sign(nearby([NEIGHBOUR]));
  const job = f.job(signed.job.id);
  assert.deepEqual([job.estimate.status, job.estimate.amountCents, job.minimumWaiver.nearbyJobId], ['accepted', q.priced.totalCents, 'job_neighbour']);
  assert.ok(f.writesTo(HUB_AUDIT_COLLECTION).some(write => write.patch.action === 'quote.minimum_pickup.waive' && write.patch.entity.id === job.id));
  // The signing page releases this refusal (nothing was saved): crew/gameplan-handoff.js.
  const client = readFileSync(new URL('../crew/gameplan-handoff.js', import.meta.url), 'utf8');
  assert.ok(client.slice(client.indexOf('const RELEASED'), client.indexOf(']);', client.indexOf('const RELEASED'))).includes("'handoff_pickup_waiver_unconfirmed'"));
});

test('quotes already sent keep their saved prices; an unsent pickup saved before the rule is saved again first', async t => {
  // A sofa pickup sent before the minimum existed: its saved lines have no Minimum pickup line.
  const q = quote(SOFA()), f = fixture(ON), saved = await save(f, estimator, q), jobId = saved.job.id, job = f.job(jobId);
  const before = job.estimate.lineItems.filter(line => line.id !== PICKUP_MINIMUM_LINE_ID), oldTotal = sum(before);
  Object.assign(job.estimate, { lineItems: before, amountCents: oldTotal, amount: oldTotal / 100 });
  delete job.quoteDraft.breakdown.pickup;
  // Unsent: the send asks for a save again (the save prices the minimum).
  await assert.rejects(preview(f, q, jobId), { code: 'quote_draft_pickup_minimum_resave', status: 409 });
  // Already sent: the customer portal approves it at its saved price, never re-priced.
  const sent = { ...structuredClone(job), date: DAY, estimate: { ...structuredClone(job.estimate), status: 'sent', sentAt: NOW, sentRevision: job.estimate.revision, depositRequiredCents: Math.round(oldTotal * 0.25), depositRequired: Math.round(oldTotal * 0.25) / 100 } };
  portalStore(t, { [jobId]: sent });
  const handlers = portalHandlers(NOW), cookie = await portalCookie(jobId, {}, Date.parse(NOW)), view = await portalView(handlers, cookie, portalEnv);
  assert.equal(view.status, 200, JSON.stringify(view.body));
  const shown = view.body.estimate;
  assert.equal(Math.round(shown.amount * 100), oldTotal, 'the saved price, below the minimum');
  assert.equal(shown.lineItems.some(line => line.name === 'Minimum pickup'), false);
  const approved = await portalPost(handlers, cookie, { action: 'approve_estimate', signed_name: 'Synthetic Customer', confirmed: true, estimate_revision: shown.revision, amount_cents: oldTotal, estimate_fingerprint: shown.fingerprint, terms_version: shown.termsVersion, request_id: randomUUID() }, portalEnv);
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
});

// Owner decision 2026-10-30: the $139 curbside price is retired. Curbside pickup, like every junk or item pickup,
// starts from $250, the $250 minimum to come out; garage cleanouts keep "from $675".
test('the public curbside copy starts from $250, the $250 minimum to come out, and names no $139 price', () => {
  const page = readFileSync(new URL('../flat-rate-junk-removal-fort-collins-co.html', import.meta.url), 'utf8'), home = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const text = html => html.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  assert.match(text(page), /Curbside pickup starts from \$250 , our \$250 minimum to come out, and we can price it from your photos\./);
  assert.match(text(page), /Published starting price From \$250 for items staged at the curb, driveway, or open garage, our \$250 minimum to come out\. No walkthrough needed: we can price it from your photos\./);
  assert.match(text(page), /Curbside pickup starts from \$250, our \$250 minimum to come out, as long as items are at the curb or driveway\./);
  assert.match(text(home), /Set a small load at the curb and we haul it — from \$250, our \$250 minimum to come out\./);
  assert.match(text(home), /Garage cleanouts and turnarounds start from \$675/);
  // Plain and honest: no "was" price and no urgency.
  for (const html of [page, home]) assert.doesNotMatch(text(html), /\bwas \$|limited time|act now|hurry/i);
  // The generator's own copy (every service page), regenerated from it.
  const generator = readFileSync(new URL('../_generate_site.py', import.meta.url), 'utf8');
  assert.match(generator, /Junk removal and item pickups start from \$250, our \$250 minimum to come out, whether you set items at the curb or our crew carries them out\./);
  assert.doesNotMatch(generator, /CURBSIDE_OR_CARRY_OUT|"price": "139"/);
});

// Every public page (the site root, blog/ and projects/) is free of the retired $139 price: visible text, links,
// meta tags and structured data. Hidden form routing labels (subject/source) are internal lead labels, not offers.
export function retiredCurbsidePrice(html) {
  const visible = html.replace(/<input\b[^>]*\btype="hidden"[^>]*>/g, ' ').replace(/<style[\s\S]*?<\/style>/g, ' ');
  return [...visible.matchAll(/.{0,60}(?:\$139\b|%24139|"price": "139").{0,60}/g)].map(match => match[0].replace(/\s+/g, ' ').trim());
}
test('no public page names the retired $139 curbside price', async () => {
  const { sourceFiles } = await import('./source-files.mjs');
  const { join, relative } = await import('node:path');
  const root = new URL('..', import.meta.url).pathname, pages = sourceFiles(root).map(entry => join(entry.parentPath, entry.name))
    .filter(path => path.endsWith('.html') && ['', 'blog', 'projects'].includes(relative(root, path).split('/').slice(0, -1).join('/')));
  assert.ok(pages.length > 40, String(pages.length));
  const found = pages.flatMap(path => retiredCurbsidePrice(readFileSync(path, 'utf8')).map(text => `${relative(root, path)}: ${text}`));
  assert.deepEqual(found, []);
  for (const file of ['llms.txt', 'ai.txt']) assert.doesNotMatch(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'), /\$139\b/, file);
  assert.equal(retiredCurbsidePrice('<p>Set it at the curb for a flat $139.</p>').length, 1, 'the check finds a visible price');
  assert.equal(retiredCurbsidePrice('<script type="application/ld+json">{"price": "139"}</script>').length, 1, 'the check finds a schema price');
  assert.equal(retiredCurbsidePrice('<input type="hidden" name="source" value="Website — Curbside $139">').length, 0, 'hidden routing labels are not offers');
});

test('a sale draft saved before the minimum is checked against it at send (no floor key: still a pickup)', async () => {
  assert.equal(pickupFloorCents({ lines: [{ section: 'removal', group: 'junk' }] }), PICKUP_MINIMUM_CENTS, 'all hauling, no pickup facts: a pickup');
  assert.equal(pickupFloorCents({ lines: [{ section: 'removal', group: 'cleaning-base' }] }), 0);
  // A $500 half load saved with $400 off before deploy: its breakdown has no pickup facts.
  const q = quote(selection({ removal: [{ id: id('Half load'), quantity: 1 }], shelving: [], storage: [] })), f = fixture(ON), saved = await save(f, estimator, q, { extra: { winter_sale: { apply: true } } }), jobId = saved.job.id, job = f.job(jobId);
  const old = [...job.estimate.lineItems.filter(line => line.id !== WINTER_SALE_LINE_ID), { ...job.estimate.lineItems.find(line => line.id === WINTER_SALE_LINE_ID), unitCents: -40000, totalCents: -40000, amount: -400 }];
  Object.assign(job.estimate, { lineItems: old, amountCents: 10000, amount: 100 });
  Object.assign(job.quoteDraft.winterSale, { amountCents: 40000 });
  delete job.quoteDraft.breakdown.pickup;
  job.date = DAY;
  await assert.rejects(preview(f, q, jobId), { code: 'quote_draft_winter_sale_ineligible', details: { code: 'amount_changed' } });
});

test('the owner\'s override, saved for the booked day, carries to an estimator\'s send and in-person signature', async () => {
  const q = quote(SOFA({ nearbyTruck: NEARBY }));
  const booked = async () => { const f = fixture(ON), first = await save(f, estimator, quote(SOFA())); Object.assign(f.job(first.job.id), { date: DAY, time: '09:30', endTime: '12:30', address: ZIP_ADDRESS }); await save(f, owner, q, { jobId: first.job.id }); return { f, jobId: first.job.id }; };
  // The send: no nearby job, the estimator sends on the owner's override.
  const sent = await booked();
  assert.equal(sent.f.job(sent.jobId).quoteDraft.minimumWaiver.ownerOverride, true);
  const ok = await preview(sent.f, q, sent.jobId);
  await sendQuoteDraft(sent.f.store, estimator, { requestId: randomUUID(), jobId: sent.jobId, expectedRevision: sent.f.job(sent.jobId).revision, confirmToken: ok.confirmToken }, NOW, { env: ON, compositeState: async () => q.state, winterSale: saleReaders, pickup: nearby() });
  assert.deepEqual([sent.f.job(sent.jobId).estimate.status, sent.f.job(sent.jobId).quoteDraft.minimumWaiver.ownerOverride], ['sent', true]);
  // Another day: the override is not that day's.
  const moved = await booked();
  moved.f.job(moved.jobId).date = '2026-12-15';
  await assert.rejects(preview(moved.f, q, moved.jobId), { code: 'quote_draft_pickup_waiver_unconfirmed' });
  // The signature: an estimator signs in person on the override's day.
  const signed = await booked(), job = signed.f.job(signed.jobId);
  const plan = signedPlan(1, { total: job.estimate.amountCents / 100, date: DAY, quote: { composite_pricing: q.priced.compositePricing, catalog_version: q.priced.menuVersion, line_items: job.estimate.lineItems.map(({ id, kind, name, description, quantity, unitCents, totalCents }) => ({ id, kind, name, description, quantity, unitCents, totalCents })) } });
  plan.client.address = ZIP_ADDRESS;
  const result = await saveWalkthroughHandoff(signed.f.store, estimator, { actorId: estimator.user, requestId: randomUUID(), customerId: 'c1', sourceWalkthroughId: 'w1', sourceRevision: signed.f.rows.get('jobs/w1').revision, jobId: job.id, expectedRevision: job.revision, plan }, NOW, { env: ON, compositeState: async () => q.state, winterSale: saleReaders, pickup: nearby() });
  assert.deepEqual([signed.f.job(result.job.id).estimate.status, signed.f.job(result.job.id).minimumWaiver.ownerOverride], ['accepted', true]);
});

test('the nearby rule reads operational job types, skips every closed stage and takes the ZIP only from the address end', () => {
  for (const type of ['job', 'cleanout', 'reorg']) assert.equal(nearbyJob([{ ...NEIGHBOUR, type }], { jobId: 'self', date: DAY, zip: '80521' })?.type, type);
  for (const type of ['walkthrough', 'blocked']) assert.equal(nearbyJob([{ ...NEIGHBOUR, type }], { jobId: 'self', date: DAY, zip: '80521' }), null, type);
  for (const stage of ['cancelled', 'canceled', 'superseded', 'lost', 'declined', 'no_show', 'noshow', 'no-show']) {
    assert.equal(nearbyJob([{ ...NEIGHBOUR, status: stage }], { jobId: 'self', date: DAY, zip: '80521' }), null, `status ${stage}`);
    assert.equal(nearbyJob([{ ...NEIGHBOUR, status: 'scheduled', pipelineStatus: stage }], { jobId: 'self', date: DAY, zip: '80521' }), null, `pipeline ${stage}`);
  }
  assert.equal(serviceZip('12345 Main Street'), '', 'a 5-digit house number is not a ZIP code');
  assert.equal(serviceZip('12345 Main Street, Fort Collins'), '');
  assert.equal(serviceZip('12345 Main Street, Fort Collins, CO 80521'), '80521');
  assert.equal(serviceZip('12345 Main Street, Fort Collins, CO 80521, USA'), '80521');
});

test('a waived job moved to another day is checked again: portal approval, Hub Record approval and a reschedule', async t => {
  const waiver = { by: estimator.user, at: NOW, reason: NEARBY.reason, nearbyJobId: 'job_neighbour', ownerOverride: false, date: DAY, pending: false }, WAIVED = { lines: [], pickup: { haulingOnly: true, minimumCents: 0, waived: true, waivedCents: 8000 } };
  const job = { id: 'job_self', date: DAY, address: ZIP_ADDRESS, estimate: { lineItems: [{ id: 'removal-special', totalCents: 7000 }] }, quoteDraft: { minimumWaiver: waiver, breakdown: WAIVED } };
  assert.equal(pickupWaiverProblem(job, []), null, 'on its own day');
  const moved = { ...job, date: '2026-12-16' };
  assert.match(pickupWaiverProblem(moved, []), /No other job is booked on 2026-12-16 in this job's ZIP code/);
  assert.equal(pickupWaiverProblem(moved, [{ ...NEIGHBOUR, date: '2026-12-16' }]), null, 'another job that day in the ZIP code still qualifies');
  assert.match(pickupWaiverProblem(moved, null), /Save the quote again for 2026-12-16/, 'unreadable: refused');
  assert.match(pickupWaiverProblem({ ...moved, quoteDraft: { minimumWaiver: { ...waiver, ownerOverride: true, nearbyJobId: null }, breakdown: WAIVED } }, [{ ...NEIGHBOUR, date: '2026-12-16' }]), /confirmed for 2026-12-14/, 'an owner override is for its own day only');
  assert.match(pickupWaiverProblem({ ...job, quoteDraft: { minimumWaiver: { ...waiver, pending: true, date: null }, breakdown: WAIVED } }, null, { approving: true }), /not been confirmed/);
  assert.equal(pickupWaiverProblem({ ...moved, estimate: { lineItems: [{ id: PICKUP_MINIMUM_LINE_ID, totalCents: 100 }] } }, []), null, 'priced at the minimum: nothing waived');
  assert.equal(pickupWaiverProblem({ ...moved, quoteDraft: { minimumWaiver: waiver, breakdown: { lines: [], pickup: { haulingOnly: true, minimumCents: 0, waived: false, waivedCents: 0 } } } }, []), null, 'a record left from an earlier waived revision is not live');
  // The flows: a sent waived sofa quote whose job then moved to a day with no nearby job.
  const q = quote(SOFA({ nearbyTruck: NEARBY })), f = fixture(ON), saved = await save(f, estimator, q), jobId = saved.job.id;
  Object.assign(f.job(jobId), { date: DAY, address: ZIP_ADDRESS });
  const ok = await preview(f, q, jobId, estimator, nearby([NEIGHBOUR]));
  await sendQuoteDraft(f.store, estimator, { requestId: randomUUID(), jobId, expectedRevision: f.job(jobId).revision, confirmToken: ok.confirmToken }, NOW, { env: ON, compositeState: async () => q.state, winterSale: saleReaders, pickup: nearby([NEIGHBOUR]) });
  // Dispatch refuses the move to a day without a nearby job.
  f.rows.set('jobs/job_neighbour', { ...NEIGHBOUR, revision: 'n1', customerId: 'c2', time: '13:00', endTime: '15:00' });
  await assert.rejects(mutateDispatch(f.store, owner, { action: 'schedule.update', requestId: randomUUID(), jobId, expectedRevision: f.job(jobId).revision, changes: { date: '2026-12-16', time: '09:30', endTime: '12:30' } }, NOW), { code: 'dispatch_pickup_waiver_moved', status: 409 });
  // Moved anyway (another path): Hub Record approval and the portal refuse it.
  f.job(jobId).date = '2026-12-16';
  await assert.rejects(mutateMoney(f.store, owner, { action: 'estimate.record_approval', requestId: randomUUID(), jobId, expectedRevision: f.job(jobId).revision, approvedBy: 'Synthetic Customer' }, NOW), { code: 'money_pickup_waiver_moved', status: 409 });
  portalStore(t, { [jobId]: structuredClone(f.job(jobId)) });
  const handlers = portalHandlers(NOW), cookie = await portalCookie(jobId, {}, Date.parse(NOW)), view = await portalView(handlers, cookie, portalEnv), shown = view.body.estimate;
  const refused = await portalPost(handlers, cookie, { action: 'approve_estimate', signed_name: 'Synthetic Customer', confirmed: true, estimate_revision: shown.revision, amount_cents: Math.round(shown.amount * 100), estimate_fingerprint: shown.fingerprint, terms_version: shown.termsVersion, request_id: randomUUID() }, portalEnv);
  assert.deepEqual([refused.status, refused.body.code], [409, 'CUSTOMER_PORTAL_PICKUP_DAY']);
  assert.doesNotMatch(refused.body.error, /ZIP|job_|nearby job/i, 'the customer gets a plain request, never the staff reason');
});

// A waived sofa job signed in person on DAY with the job next door (job_neighbour, same ZIP code, same day).
async function signedWaived() {
  const q = quote(SOFA({ nearbyTruck: NEARBY })), f = fixture(ON), saved = await save(f, estimator, q), draft = f.job(saved.job.id);
  f.rows.set('jobs/job_neighbour', { ...NEIGHBOUR, revision: 'n1', customerId: 'c2', time: '13:00', endTime: '15:00' });
  const sign = async (actor, priced, pickup = nearby([NEIGHBOUR])) => {
    const job = f.job(draft.id), plan = signedPlan(1, { total: priced.totalCents / 100, date: DAY, quote: { composite_pricing: priced.compositePricing, catalog_version: priced.menuVersion, line_items: priced.lineItems.map(({ id, kind, name, description, quantity, unitCents, totalCents }) => ({ id, kind, name, description, quantity, unitCents, totalCents })) } });
    plan.client.address = ZIP_ADDRESS;
    return saveWalkthroughHandoff(f.store, actor, { actorId: actor.user, requestId: randomUUID(), customerId: 'c1', sourceWalkthroughId: 'w1', sourceRevision: f.rows.get('jobs/w1').revision, jobId: job.id, expectedRevision: job.revision, plan }, NOW, { env: ON, compositeState: async () => q.state, winterSale: saleReaders, pickup });
  };
  const signed = await sign(estimator, q.priced);
  const move = date => mutateDispatch(f.store, owner, { action: 'schedule.update', requestId: randomUUID(), jobId: signed.job.id, expectedRevision: f.job(signed.job.id).revision, changes: { date, time: '09:30', endTime: '12:30' } }, NOW);
  return { f, q, jobId: signed.job.id, sign, move };
}
const movedAudits = f => f.writesTo(HUB_AUDIT_COLLECTION).filter(write => write.patch.action === 'quote.minimum_pickup.waiver_moved');

test('a job re-signed without its waiver drops the old waiver record, so it moves like any other job', async () => {
  const { f, q, jobId, sign, move } = await signedWaived();
  assert.equal(f.job(jobId).minimumWaiver.nearbyJobId, 'job_neighbour');
  // The customer adds two items and signs again above $250, with no waiver.
  const three = quote(selection({ removal: [{ id: id('Sofa / loveseat'), quantity: 1 }, { id: id('Mattress'), quantity: 1 }, { id: id('Recliner'), quantity: 1 }], shelving: [], storage: [], labor: { manHours: null, fullness: 'medium' } }), q.state);
  await sign(owner, three.priced, nearby());
  const job = f.job(jobId);
  assert.deepEqual([job.minimumWaiver, job.quoteDraft.minimumWaiver, job.estimate.amountCents], [null, null, three.priced.totalCents]);
  await move('2026-12-16');
  assert.equal(f.job(jobId).date, '2026-12-16');
});

test('an approved or signed waived job keeps its waiver and price when it moves, with an audited note', async () => {
  // Signed in person: Dispatch moves it to a day with no nearby job.
  const signed = await signedWaived(), before = signed.f.job(signed.jobId).estimate.amountCents;
  await signed.move('2026-12-16');
  const job = signed.f.job(signed.jobId);
  assert.deepEqual([job.date, job.estimate.amountCents, job.minimumWaiver.date], ['2026-12-16', before, DAY]);
  assert.deepEqual(movedAudits(signed.f).map(write => [write.patch.reason, JSON.parse(write.patch.after).date]), [['moved after approval; waiver kept', '2026-12-16']]);
  // Approved in the portal (a sent quote the customer approved): the same.
  const q = quote(SOFA({ nearbyTruck: NEARBY })), f = fixture(ON), saved = await save(f, estimator, q), id = saved.job.id;
  Object.assign(f.job(id), { date: DAY, time: '09:30', endTime: '12:30', address: ZIP_ADDRESS });
  const ok = await preview(f, q, id, estimator, nearby([NEIGHBOUR]));
  await sendQuoteDraft(f.store, estimator, { requestId: randomUUID(), jobId: id, expectedRevision: f.job(id).revision, confirmToken: ok.confirmToken }, NOW, { env: ON, compositeState: async () => q.state, winterSale: saleReaders, pickup: nearby([NEIGHBOUR]) });
  Object.assign(f.job(id).estimate, { status: 'accepted', acceptedAt: NOW, acceptanceMethod: 'customer_portal' });
  f.job(id).customerApproval = { status: 'approved', approvedAt: NOW, source: 'customer_portal' };
  const price = f.job(id).estimate.amountCents;
  await mutateDispatch(f.store, owner, { action: 'schedule.update', requestId: randomUUID(), jobId: id, expectedRevision: f.job(id).revision, changes: { date: '2026-12-16', time: '09:30', endTime: '12:30' } }, NOW);
  assert.deepEqual([f.job(id).date, f.job(id).estimate.amountCents], ['2026-12-16', price]);
  assert.equal(movedAudits(f).length, 1);
});

test('an unapproved waived job moved to a day with another job in its ZIP code carries the waiver to that day', async t => {
  const q = quote(SOFA({ nearbyTruck: NEARBY })), f = fixture(ON), saved = await save(f, estimator, q), id = saved.job.id;
  Object.assign(f.job(id), { date: DAY, time: '09:30', endTime: '12:30', address: ZIP_ADDRESS });
  const ok = await preview(f, q, id, estimator, nearby([NEIGHBOUR]));
  await sendQuoteDraft(f.store, estimator, { requestId: randomUUID(), jobId: id, expectedRevision: f.job(id).revision, confirmToken: ok.confirmToken }, NOW, { env: ON, compositeState: async () => q.state, winterSale: saleReaders, pickup: nearby([NEIGHBOUR]) });
  // Another job is booked on the new day in the same ZIP code.
  f.rows.set('jobs/job_other', { ...NEIGHBOUR, id: 'job_other', date: '2026-12-16', revision: 'o1', customerId: 'c3', time: '13:00', endTime: '15:00', address: '7 Third Street, Fort Collins, CO 80521' });
  await mutateDispatch(f.store, owner, { action: 'schedule.update', requestId: randomUUID(), jobId: id, expectedRevision: f.job(id).revision, changes: { date: '2026-12-16', time: '09:30', endTime: '12:30' } }, NOW);
  assert.deepEqual([f.job(id).date, f.job(id).quoteDraft.minimumWaiver.date, f.job(id).quoteDraft.minimumWaiver.nearbyJobId], ['2026-12-16', '2026-12-16', 'job_other']);
  assert.equal(JSON.parse(movedAudits(f)[0].patch.after).nearbyJobId, 'job_other');
  assert.equal(JSON.parse(movedAudits(f)[0].patch.before).nearbyJobId, 'job_neighbour', 'before is the waiver as it was');
  // The portal now approves it on its new day.
  portalStore(t, { [id]: structuredClone(f.job(id)) });
  const handlers = portalHandlers(NOW), cookie = await portalCookie(id, {}, Date.parse(NOW)), view = await portalView(handlers, cookie, portalEnv), shown = view.body.estimate;
  const approved = await portalPost(handlers, cookie, { action: 'approve_estimate', signed_name: 'Synthetic Customer', confirmed: true, estimate_revision: shown.revision, amount_cents: Math.round(shown.amount * 100), estimate_fingerprint: shown.fingerprint, terms_version: shown.termsVersion, request_id: randomUUID() }, portalEnv);
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
});

test('the Business Hub rate card states the curbside condition too', () => {
  const source = readFileSync(new URL('../functions/_lib/pricing-config.js', import.meta.url), 'utf8');
  const sentences = [...source.matchAll(/'([^']*\$139[^']*)'/g)].map(match => match[1]);
  assert.ok(sentences.length >= 1);
  for (const text of sentences) assert.match(text, /when our truck is already in the area that day; otherwise the minimum pickup is \$250/);
});

// A waived sofa quote booked on DAY at ZIP_ADDRESS next to job_neighbour and sent (not approved).
async function sentWaived() {
  const q = quote(SOFA({ nearbyTruck: NEARBY })), f = fixture(ON), saved = await save(f, estimator, q), id = saved.job.id;
  Object.assign(f.job(id), { date: DAY, time: '09:30', endTime: '12:30', address: ZIP_ADDRESS });
  f.rows.set('jobs/job_neighbour', { ...NEIGHBOUR, revision: 'n1', customerId: 'c2', time: '13:00', endTime: '15:00' });
  const ok = await preview(f, q, id, estimator, nearby([NEIGHBOUR]));
  await sendQuoteDraft(f.store, estimator, { requestId: randomUUID(), jobId: id, expectedRevision: f.job(id).revision, confirmToken: ok.confirmToken }, NOW, { env: ON, compositeState: async () => q.state, winterSale: saleReaders, pickup: nearby([NEIGHBOUR]) });
  const update = (changes, actor = owner) => mutateDispatch(f.store, actor, { action: 'schedule.update', requestId: randomUUID(), jobId: id, expectedRevision: f.job(id).revision, changes }, NOW);
  const approveInPortal = async t => {
    portalStore(t, { [id]: structuredClone(f.job(id)) });
    const handlers = portalHandlers(NOW), cookie = await portalCookie(id, {}, Date.parse(NOW)), view = await portalView(handlers, cookie, portalEnv), shown = view.body.estimate;
    return portalPost(handlers, cookie, { action: 'approve_estimate', signed_name: 'Synthetic Customer', confirmed: true, estimate_revision: shown.revision, amount_cents: Math.round(shown.amount * 100), estimate_fingerprint: shown.fingerprint, terms_version: shown.termsVersion, request_id: randomUUID() }, portalEnv);
  };
  return { f, q, id, update, approveInPortal };
}

test('a waived job unscheduled after send is never approved until its day is booked again, and a no-truck day is refused', async t => {
  const { f, id, update, approveInPortal } = await sentWaived();
  assert.equal(f.job(id).quoteDraft.minimumWaiver.zip, '80521', 'the waiver records the ZIP code it was confirmed for');
  // "Keep unscheduled": the day is cleared.
  Object.assign(f.job(id), { date: '', time: '', endTime: '', status: 'unscheduled', pipelineStatus: 'unscheduled' });
  assert.match(pickupWaiverProblem(f.job(id), null, { approving: true }), /Book the job's day again before approving: the truck-nearby price was confirmed for 2026-12-14\./);
  const refused = await approveInPortal(t);
  assert.deepEqual([refused.status, refused.body.code], [409, 'CUSTOMER_PORTAL_PICKUP_DAY']);
  await assert.rejects(mutateMoney(f.store, owner, { action: 'estimate.record_approval', requestId: randomUUID(), jobId: id, expectedRevision: f.job(id).revision, approvedBy: 'Synthetic Customer' }, NOW), { code: 'money_pickup_waiver_moved' });
  // Booked again on a day with no truck nearby: refused (the job was never approved).
  await assert.rejects(update({ date: '2026-12-16', time: '09:30', endTime: '12:30' }), { code: 'dispatch_pickup_waiver_moved' });
});

test('a new service ZIP code on the same day is checked like a new day: Dispatch, the Team Lead path and portal approval', async t => {
  const other = '100 Fixture Lane, Fort Collins, CO 80525';
  // Dispatch: no job in the new ZIP code that day.
  const a = await sentWaived();
  await assert.rejects(a.update({ address: other }), { code: 'dispatch_pickup_waiver_moved', message: /confirmed for another ZIP code \(80521\)/ });
  // With a job in the new ZIP code that day, the waiver moves to it (zip and nearby job), audited.
  a.f.rows.set('jobs/job_south', { ...NEIGHBOUR, id: 'job_south', revision: 's1', customerId: 'c3', time: '13:00', endTime: '15:00', address: '3 South Road, Fort Collins, CO 80525' });
  await a.update({ address: other });
  assert.deepEqual([a.f.job(a.id).quoteDraft.minimumWaiver.zip, a.f.job(a.id).quoteDraft.minimumWaiver.nearbyJobId], ['80525', 'job_south']);
  // The Team Lead's job operations (#270) run the same Dispatch check.
  const b = await sentWaived(), teamLead = { user: 'c1a', role: 'crew', businessAccess: false, staffRoles: ['team_lead'], displayName: 'Synthetic Team Lead' };
  await assert.rejects(mutateJobOperation(b.f.store, teamLead, { action: 'schedule.update', requestId: randomUUID(), expectedUser: teamLead.user, jobId: b.id, expectedRevision: b.f.job(b.id).revision, changes: { address: other } }, NOW, { ...ON, EGC_TEAM_LEAD_JOB_OPERATIONS: 'true' }), { code: 'dispatch_pickup_waiver_moved' });
  // Moved some other way: the portal refuses the approval.
  const c = await sentWaived();
  c.f.job(c.id).address = other;
  const refused = await c.approveInPortal(t);
  assert.deepEqual([refused.status, refused.body.code], [409, 'CUSTOMER_PORTAL_PICKUP_DAY']);
  // A record from before the ZIP code was stored skips the ZIP comparison.
  const legacy = { ...c.f.job(c.id), quoteDraft: { ...c.f.job(c.id).quoteDraft, minimumWaiver: { ...c.f.job(c.id).quoteDraft.minimumWaiver, zip: null } } };
  assert.equal(pickupWaiverProblem(legacy, [], { approving: true }), null);
});

test('an approved waived job moved to another ZIP code gets one "waiver kept" note, and later unrelated edits add none', async () => {
  const { f, jobId } = await signedWaived();
  const edit = changes => mutateDispatch(f.store, owner, { action: 'schedule.update', requestId: randomUUID(), jobId, expectedRevision: f.job(jobId).revision, changes }, NOW);
  await edit({ address: '100 Fixture Lane, Fort Collins, CO 80525' });
  const kept = movedAudits(f);
  assert.equal(kept.length, 1);
  assert.deepEqual([JSON.parse(kept[0].patch.before).zip, JSON.parse(kept[0].patch.after).zip, kept[0].patch.reason], ['80521', '80525', 'moved after approval; waiver kept']);
  // Unrelated saves after it: a title, a new arrival time, the same address sent again.
  await edit({ title: 'Pickup: side gate' });
  await edit({ time: '10:00', endTime: '13:00' });
  await edit({ address: '100 Fixture Lane, Fort Collins, CO 80525' });
  assert.equal(movedAudits(f).length, 1, 'one note for the one move');
  assert.equal(f.job(jobId).minimumWaiver.zip, '80521', 'the signed waiver is kept as it was signed');
});

test('an owner override carries to an estimator\'s signature only in its own ZIP code', async () => {
  const q = quote(SOFA({ nearbyTruck: NEARBY })), f = fixture(ON), first = await save(f, estimator, quote(SOFA())), id = first.job.id;
  Object.assign(f.job(id), { date: DAY, time: '09:30', endTime: '12:30', address: ZIP_ADDRESS });
  await save(f, owner, q, { jobId: id });
  assert.deepEqual([f.job(id).quoteDraft.minimumWaiver.ownerOverride, f.job(id).quoteDraft.minimumWaiver.zip], [true, '80521']);
  // Unscheduled, the address moves to another ZIP code, then booked again on the same day.
  const other = '100 Fixture Lane, Fort Collins, CO 80525';
  Object.assign(f.job(id), { date: '', time: '', endTime: '' });
  Object.assign(f.job(id), { address: other, date: DAY, time: '09:30', endTime: '12:30' });
  const job = f.job(id), plan = signedPlan(1, { total: job.estimate.amountCents / 100, date: DAY, quote: { composite_pricing: q.priced.compositePricing, catalog_version: q.priced.menuVersion, line_items: job.estimate.lineItems.map(({ id, kind, name, description, quantity, unitCents, totalCents }) => ({ id, kind, name, description, quantity, unitCents, totalCents })) } });
  plan.client.address = other;
  await assert.rejects(saveWalkthroughHandoff(f.store, estimator, { actorId: estimator.user, requestId: randomUUID(), customerId: 'c1', sourceWalkthroughId: 'w1', sourceRevision: f.rows.get('jobs/w1').revision, jobId: job.id, expectedRevision: job.revision, plan }, NOW, { env: ON, compositeState: async () => q.state, winterSale: saleReaders, pickup: nearby() }), { code: 'handoff_pickup_waiver_unconfirmed', status: 409 });
  // The send checks it the same way: the override is for 80521, not 80525.
  await assert.rejects(preview(f, q, id), { code: 'quote_draft_pickup_waiver_unconfirmed' });
});

test('through the scheduling bridge, an approved waived job gets one "waiver kept" note for its ZIP move, none for a re-sent address', async () => {
  const actor = { id: 'verified-grant', kind: 'integration', role: 'integration', workspace: 'egc' }, at = '2026-10-17T15:00:00.000Z';
  const rows = new Map([['customers/customer-a', { id: 'customer-a', name: 'Synthetic customer', highlevelContactId: 'contact-a', revision: 'customer-r1' }]]);
  let revision = 0;
  const store = { read: async (c, id) => structuredClone(rows.get(`${c}/${id}`) || null), day: async date => [...rows.entries()].filter(([k, v]) => k.startsWith('jobs/') && v.date === date).map(([, v]) => structuredClone(v)),
    commit: async writes => {
      for (const w of writes) { const prior = rows.get(`${w.collection}/${w.id}`); if (w.revision ? prior?.revision !== w.revision : Boolean(prior)) throw Object.assign(new Error('schedule_revision_conflict'), { status: 409 }); }
      for (const w of writes) rows.set(`${w.collection}/${w.id}`, { ...rows.get(`${w.collection}/${w.id}`), ...structuredClone(w.patch), id: w.id, revision: `r${++revision}` });
      return {};
    } };
  const mutate = value => mutateScheduledVisit(store, actor, { requestId: randomUUID(), portalCustomerId: 'customer-a', ...value }, at);
  const created = await mutate({ mode: 'create', kind: 'job', changes: { date: DAY, time: '09:30', endTime: '12:30', address: ZIP_ADDRESS } });
  const visitId = created.visit?.id || created.id || [...rows.keys()].find(key => key.startsWith('jobs/visit_')).slice(5);
  // The visit is a signed waived pickup (approved), its waiver confirmed for 80521.
  const job = rows.get(`jobs/${visitId}`);
  Object.assign(job, { estimate: { status: 'accepted', acceptanceMethod: 'in_person_signature', lineItems: [{ id: 'removal-special', totalCents: 7000 }] },
    minimumWaiver: { by: estimator.user, at, reason: NEARBY.reason, nearbyJobId: 'job_neighbour', ownerOverride: false, date: DAY, zip: '80521', pending: false },
    compositeQuote: { breakdown: { lines: [], pickup: { haulingOnly: true, minimumCents: 0, waived: true, waivedCents: 8000 } } } });
  const update = changes => mutate({ mode: 'update', portalVisitId: visitId, expectedRevision: rows.get(`jobs/${visitId}`).revision, changes });
  const kept = () => [...rows.entries()].filter(([key, row]) => key.startsWith(`${HUB_AUDIT_COLLECTION}/`) && row.action === 'quote.minimum_pickup.waiver_moved').map(([, row]) => row);
  const other = '100 Fixture Lane, Fort Collins, CO 80525';
  await update({ address: other });
  assert.equal(kept().length, 1);
  assert.deepEqual([JSON.parse(kept()[0].before).zip, JSON.parse(kept()[0].after).zip, kept()[0].via], ['80521', '80525', 'bridge']);
  await update({ address: other });
  await update({ title: 'Pickup: side gate' });
  assert.equal(kept().length, 1, 'a re-sent address and an unrelated edit add no note');
});
