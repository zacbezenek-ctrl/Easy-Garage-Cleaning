// Estimator end to end (owner decisions D2-D5, D9b, D11; WP5, WP14): walkthrough -> quote builder (removal, then
// shelving, then extra storage) -> saved quote -> signed handoff with a crew opening -> a dated job staffed by the server
// (Crew 1, else Crew 2; Crew 3 on weekends) with its breakdown and buy list -> the office purchase list -> the crew's grab
// list -> the HighLevel schedule mirror. Synthetic data only; one in-memory store (tests/helpers/estimator-fixture.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import vm from './helpers/vm-realm.mjs';
import { saveQuoteDraft } from '../functions/_lib/quote-draft.js';
import { quoteDraftHandlers } from '../functions/api/quote-draft.js';
import { handoffCrewOpenings, prepareHandoff, releaseHandoffPrices, releaseHeldHandoffs, saveWalkthroughHandoff, savedHandoffPayload } from '../functions/_lib/walkthrough-handoff.js';
import { heldJobIds, heldJobsQuery } from '../functions/_lib/handoff-price-holds.js';
import { catalogHandlers } from '../functions/api/catalog.js';
import { handoffHandlers } from '../functions/api/walkthrough-handoff.js';
import { purchaseListHandlers } from '../functions/api/purchase-list.js';
import { priceCompositeQuote } from '../functions/_lib/composite-quote.js';
import { fieldJobProjection, fieldMaterials } from '../functions/_lib/field-execution.js';
import { GHL_SCHEDULE_MIRROR } from '../functions/_lib/ghl-schedule-mirror.js';
import { normalizeLineItems, unsentQuoteDraft } from '../functions/_lib/quote-model.js';
import { MESSAGE_POLICIES } from '../functions/_lib/message-policies.js';
import { quoteApproved } from '../functions/_lib/portal-invitation.js';
import { projectReleased } from '../functions/_lib/business-hub-core.js';
import { payable } from '../functions/_lib/customer-payments.js';
import { moneyDocumentKinds } from '../functions/_lib/money-document.js';
import { BASE_ENV, LABOR_CENTS, MON, NOW, LATER, ON_ENV, SAT, SHELF, TOTES, TUE, builderState, client, estimator, fixture, menuItem, owner, selection, signedPlan } from './helpers/estimator-fixture.mjs';
import { walkthroughCrewBrief } from '../functions/_lib/walkthrough-crew-brief.js';
import { scheduleMirrorNote } from '../functions/_lib/ghl-schedule-mirror.js';

const MONEY = /\$\s?\d|Cents|retailPerPack|markup|split/;
// An employee id (c1a ... c3b), the sales login or a roster name. A real leak is a quoted value or a word in a sentence;
// the lookbehind keeps it from matching the tail of a hex id (a request UUID group or a dispatch_ job id ending in
// c3a, about 1 run in 40 before, 2026-10-17 CI). See 'the employee-leak check' test below.
const EMPLOYEES = /(?<![0-9a-f])c[123][ab]\b|sales\.person|Synthetic c/;
// Fixed, unique, valid v4 request ids for the answers that check is applied to, so they are the same bytes every run.
let requestSeq = 0;
const fixedRequestId = () => `00000000-0000-4000-8000-${String(++requestSeq).padStart(12, '0')}`;
// What each customer surface does with a signed job: the portal withholds its estimate and payment (unsentQuoteDraft,
// also the checkout and customer documents), the deposit reminder, the portal invitation's approval check (every
// sender) and the business-hub / customer-account release rule.
const checkout = job => { try { payable(job); return 'open'; } catch (error) { return error.code || 'refused'; } };
const heldEverywhere = job => ({ portalWithheld: unsentQuoteDraft(job), checkout: checkout(job), documents: moneyDocumentKinds(job, NOW), depositReminder: MESSAGE_POLICIES.deposit_reminder.eligible({ job, today: '2026-10-17' }), invitable: quoteApproved(job), listed: projectReleased(job) });
const HELD = { portalWithheld: true, checkout: 'CUSTOMER_PORTAL_ESTIMATE_NOT_APPROVABLE', documents: [], depositReminder: { eligible: false, reason: 'prices_pending_approval' }, invitable: false, listed: false };
const RELEASED = { portalWithheld: false, checkout: 'open', documents: ['estimate'], depositReminder: { eligible: true }, invitable: true, listed: true };
// The estimator's builder quote, saved as a quote draft for walkthrough w1 (crew/quote-draft.js compositeDraft).
async function builderDraft(f, state, chosen = selection()) {
  const priced = priceCompositeQuote(state, chosen, { complete: true });
  const input = { requestId: fixedRequestId(), customerId: 'c1', sourceWalkthroughId: 'w1', sourceRevision: 'w1r', draft: { client: client(1), title: 'Garage reset', scope: 'Removal, then shelving, then extra storage.', line_items: priced.lineItems, valid_until: '2026-10-30', catalog_version: priced.menuVersion, crew_size: 2, estimated_duration_min: 180, composite_pricing: chosen } };
  const saved = await saveQuoteDraft(f.store, estimator, input, NOW, { env: ON_ENV, compositeState: async () => state });
  return { priced, draft: saved.job };
}
// The signed handoff of that draft, as crew/gameplan-handoff.js sends it: the builder's total, lines and selection.
function signInput(f, priced, draftJob, { crewId = 'crew_one', date = MON, start = '09:30', end = '12:30', total = priced.totalCents / 100, quote = {}, actor = estimator } = {}) {
  const job = f.job(draftJob.id);
  const plan = signedPlan(1, { total, date, start, end, quote: { composite_pricing: priced.compositePricing, line_items: priced.lineItems.map(line => ({ id: line.id, kind: line.kind, name: line.name, description: line.description, quantity: line.quantity, unitCents: line.unitCents, totalCents: line.totalCents })), catalog_version: priced.menuVersion, ...quote }, logistics: crewId ? { crew_id: crewId } : {} });
  return { actorId: actor.user, requestId: fixedRequestId(), customerId: 'c1', sourceWalkthroughId: 'w1', sourceRevision: f.rows.get('jobs/w1').revision, jobId: job.id, expectedRevision: job.revision, plan };
}
const sign = (f, input, state, actor = estimator, env = ON_ENV) => saveWalkthroughHandoff(f.store, actor, input, NOW, { env, compositeState: async () => state });
const signDraft = (f, priced, draftJob, state, options = {}) => sign(f, signInput(f, priced, draftJob, options), state, options.actor, options.env);
// A plain (walkthrough-priced) signed handoff for walkthrough wN, creating a new job.
const signNew = (f, n, options = {}, crewId = null, actor = estimator, env = ON_ENV) => saveWalkthroughHandoff(f.store, actor, { requestId: fixedRequestId(), customerId: `c${n}`, sourceWalkthroughId: `w${n}`, sourceRevision: f.rows.get(`jobs/w${n}`).revision, plan: signedPlan(n, { ...options, logistics: crewId ? { crew_id: crewId } : {} }) }, NOW, { env, compositeState: async () => { throw new Error('a walkthrough-priced handoff reads no builder state'); } });
// The crew job page's Materials card (crew/job.js), run as the page runs it.
function crewPage() {
  const source = readFileSync(new URL('../crew/job.js', import.meta.url), 'utf8'), lineOf = prefix => source.split(/\r?\n/).find(row => row.startsWith(prefix));
  const context = vm.createContext({});
  vm.runInContext([lineOf('  const esc = '), lineOf('  const label = '), source.slice(source.indexOf('  // The Materials card:'), source.indexOf('  function renderJob() {'))].join('\n') + '\nthis.api = { materialsCard };', context);
  return context.api;
}

test('estimator end to end: builder quote, crew opening, signed job on Crew 1 with breakdown and buy list, purchase list, crew grab list and HighLevel mirror', async () => {
  const f = fixture(), state = builderState();
  // The walkthrough's quote builder (/api/quote-draft, as crew/quote-draft.js drives it): the estimator's menu has no
  // cost, each step is priced by the server in order (removal, then shelving, then extra storage), then the quote is saved.
  const quotes = quoteDraftHandlers({ session: async () => estimator, storage: () => f.store, now: () => new Date(NOW), compositeState: async () => state, stripe: () => null, delivery: () => ({ deliver: async () => ({ status: 'not_requested' }) }) });
  const post = async body => { const response = await quotes.post({ request: new Request('https://easygaragecleaning.com/api/quote-draft', { method: 'POST', headers: { Origin: 'https://easygaragecleaning.com', 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), env: ON_ENV }); return { status: response.status, body: await response.json() }; };
  const menuView = await (await quotes.get({ request: new Request('https://easygaragecleaning.com/api/quote-draft?view=builder'), env: ON_ENV })).json();
  assert.deepEqual([menuView.enabled, menuView.steps], [true, ['removal', 'shelving', 'storage']]);
  assert.doesNotMatch(JSON.stringify(menuView), /retailPerPackCents|goodsMarkup|"internal":\{/, 'an estimator sees sell prices only');
  assert.equal(menuView.viewer.internal, false);
  // The labor rate on the estimator's menu: the owner's $40.00 per man-hour, approved (D12).
  assert.deepEqual([menuView.labor.rateCents, menuView.labor.approved, menuView.installation], [4000, true, { included: true, billedAs: 'labor' }]);
  // As the builder sends them: a step preview carries no labor; the whole quote carries the estimator's man-hours.
  const chosen = selection(), { labor: _labor, ...items } = chosen, through = steps => ({ ...items, steps, ...Object.fromEntries(['removal', 'shelving', 'storage'].filter(step => !steps.includes(step)).map(step => [step, []])) });
  const removal = await post({ action: 'composite_preview', compositePricing: through(['removal']) });
  const shelving = await post({ action: 'composite_preview', compositePricing: through(['removal', 'shelving']) });
  const preview = await post({ action: 'composite_preview', compositePricing: chosen });
  assert.deepEqual([removal.status, shelving.status, preview.status], [200, 200, 200]);
  assert.deepEqual(preview.body.steps.map(step => [step.id, step.runningTotalCents]), [['removal', removal.body.totalCents], ['shelving', shelving.body.totalCents], ['storage', preview.body.totalCents - LABOR_CENTS], ['labor', preview.body.totalCents]], 'a running total per step, then the labor');
  assert.deepEqual(preview.body.labor, { manHours: 6, rateCents: 4000, rateSource: 'default', totalCents: LABOR_CENTS, prefilledManHours: 6, adjusted: false, estimate: { crewSize: 2, onSiteMinutes: 180 } });
  assert.deepEqual(preview.body.lineItems.at(-1), { id: 'labor', kind: 'labor', name: 'Labor: 6 man-hours × $40.00', description: 'Crew time on site, billed per man-hour, including installing the shelving and storage.', quantity: 1, unitCents: LABOR_CENTS, totalCents: LABOR_CENTS, amount: 240, optional: false, selected: true, group: null, tier: null, package: null, catalog: null, customerSupplied: false, taxable: false });
  const outOfOrder = await post({ action: 'composite_preview', compositePricing: { ...chosen, steps: ['shelving', 'removal', 'storage'] } });
  assert.deepEqual([outOfOrder.status, outOfOrder.body.code], [400, 'quote_draft_composite_order']);
  const saved = await post({ action: 'save', requestId: fixedRequestId(), customerId: 'c1', sourceWalkthroughId: 'w1', sourceRevision: 'w1r', draft: { client: client(1), title: 'Garage reset', scope: 'Removal, then shelving, then extra storage.', line_items: preview.body.lineItems, valid_until: '2026-10-30', catalog_version: preview.body.menuVersion, crew_size: 2, estimated_duration_min: 180, composite_pricing: chosen } });
  assert.equal(saved.status, 200);
  const draft = saved.body.job, priced = priceCompositeQuote(state, chosen, { complete: true });
  assert.deepEqual([draft.estimate.amountCents, draft.breakdown], [priced.totalCents, priced.breakdown]);
  assert.deepEqual(priced.breakdown.sections.map(section => section.id), ['removal', 'shelving', 'storage'], 'built in order: removal, then shelving, then extra storage');
  assert.deepEqual([f.job(draft.id).status, f.job(draft.id).date, f.job(draft.id).quoteDraft.compositePricing.steps], ['unscheduled', '', ['removal', 'shelving', 'storage']]);

  // The estimator's crew openings: Crew 1 and Crew 2 at 9:30 on Monday, no roster, no employee, no other customer.
  const prepared = await prepareHandoff(f.store, estimator, { sourceWalkthroughId: 'w1', jobId: draft.id }, { env: ON_ENV });
  assert.deepEqual([prepared.crewAutoAssign, prepared.roster], [true, []]);
  const openings = await handoffCrewOpenings(f.store, estimator, { view: 'crew_openings', startDate: MON, durationMinutes: '180', travelBufferMinutes: '20' }, new Date(NOW), { env: ON_ENV });
  assert.deepEqual(openings.openings.slice(0, 2), [{ date: MON, time: '09:30', endTime: '12:30', crewId: 'crew_one', crewLabel: 'Crew 1', priority: 1 }, { date: MON, time: '09:30', endTime: '12:30', crewId: 'crew_two', crewLabel: 'Crew 2', priority: 2 }]);
  assert.doesNotMatch(JSON.stringify(openings), EMPLOYEES);
  assert.doesNotMatch(JSON.stringify(openings), /Synthetic Customer|Fixture Lane|employeeIds|roster/);

  // Signed with the Crew 1 opening: the server prices the selection again, books Monday 9:30 and staffs Crew 1.
  const input = signInput(f, priced, draft), signed = await sign(f, input, state);
  const job = f.job(signed.job.id);
  assert.equal(signed.job.id, draft.id, 'the builder draft becomes the signed job');
  assert.deepEqual([job.date, job.time, job.endTime, job.status, job.crewId, job.assignedCrew, job.crewLead], [MON, '09:30', '12:30', 'scheduled', 'crew_one', ['c1a', 'c1b'], 'c1a']);
  assert.deepEqual(signed.crew, { status: 'assigned', crewName: 'Crew 1', priority: 1, date: MON, time: '09:30', endTime: '12:30' }, 'the estimator sees Crew 1 and the time');
  assert.deepEqual(signed.job.assignedCrew, [], 'a quote author still sees no employee');
  assert.doesNotMatch(JSON.stringify(signed), EMPLOYEES);
  assert.equal(job.soldNeedsCrew, undefined, 'a staffed sale is not Sold: needs crew');
  assert.equal(job.crewAutoAssigned.crewId, 'crew_one');

  // The estimate is the server's builder lines and total; the selection and its cost-free breakdown are on the job.
  // The stored estimate keeps the builder's internal goods split (manager-only, as a saved builder draft does); the signed
  // snapshot the CRM sync reads, the estimator's answer and the crew never carry it.
  assert.deepEqual(job.estimate.lineItems, priced.storedLineItems);
  assert.deepEqual(job.estimate.lineItems.filter(line => line.split).map(line => line.id), ['shelving-goods', 'storage-goods']);
  // D12 end to end: the customer's estimate carries the Labor line, the total, the deposit and the deal value (job.total,
  // the HighLevel opportunity's monetaryValue) include it, and the crew sees the man-hours, never the rate or the amount.
  assert.deepEqual(job.estimate.lineItems.at(-1).name, 'Labor: 6 man-hours × $40.00');
  assert.deepEqual(job.acceptedHandoffPayload.quote.line_items.at(-1), { name: 'Labor: 6 man-hours × $40.00', qty: 1, total: 240 });
  assert.deepEqual([job.total, job.priceQuoted, job.estimate.depositRequired], [priced.totalCents / 100, priced.totalCents / 100, Math.round(priced.totalCents / 2) / 100]);
  assert.ok(priced.totalCents - LABOR_CENTS === priced.breakdown.sections.reduce((sum, section) => sum + section.subtotalCents, 0), 'the menu steps plus the labor are the total');
  assert.deepEqual(job.compositeQuote.breakdown.labor, priced.labor);
  assert.deepEqual(job.jobBreakdown.sections.at(-1), { id: 'labor', title: 'Labor', items: ['6 man-hours (about 3 hours on site for a crew of 2)'] });
  assert.equal(job.jobInstructions.laborManHours, 6);
  assert.deepEqual(walkthroughCrewBrief(job.jobInstructions).filter(row => ['Man-hours sold', 'Job breakdown'].includes(row.label)).map(row => [row.label, row.text.split('\n').at(-1)]), [['Man-hours sold', '6 man-hours'], ['Job breakdown', 'Labor: 6 man-hours (about 3 hours on site for a crew of 2)']]);
  const crewView = fieldJobProjection(job, [], { purchaseDetails: true });
  assert.match(JSON.stringify(crewView), /6 man-hours/);
  assert.doesNotMatch(JSON.stringify([crewView, job.jobBreakdown, job.jobInstructions]), /\$\s?\d|rateCents|"totalCents"|Labor: 6 man-hours ×/, 'the crew never sees the labor rate or amount');
  assert.match(scheduleMirrorNote({ kind: 'scheduled', job }).body, /\nLabor: 6 man-hours \(about 3 hours on site for a crew of 2\)\n/);
  assert.deepEqual(job.acceptedHandoffPayload.quote.estimate_line_items, normalizeLineItems(priced.lineItems, { strict: true }).lineItems);
  assert.doesNotMatch(JSON.stringify([signed, job.acceptedHandoffPayload, job.jobInstructions]), /markupCents|productCents|"split":\{/);
  assert.deepEqual([job.estimate.amount, job.estimate.depositRequired, job.estimate.status, job.estimate.catalogVersion, job.estimate.pricingSettingsVersion], [priced.totalCents / 100, Math.round(priced.totalCents / 2) / 100, 'accepted', priced.menuVersion, priced.settingsVersion]);
  assert.deepEqual(job.compositeQuote.compositePricing, priced.compositePricing);
  assert.deepEqual(job.compositeQuote.breakdown, priced.breakdown);
  assert.deepEqual(job.quoteDraft.breakdown, priced.breakdown, 'the saved draft takes the signed selection');
  assert.equal(savedHandoffPayload(job, signed.requestId).quote.total, priced.totalCents / 100, 'the CRM sync reads the signed builder snapshot');
  // Draft prices book the job but hold the estimate and deposit request (no portal invitation) until the owner approves them.
  assert.deepEqual(job.pricesPendingApproval.items.map(item => item.name), ['Two-car garage base', SHELF.name, TOTES.name], 'installation is billed through labor, so it is not held for');
  assert.deepEqual([job.pricesPendingApproval.status, job.pricesPendingApproval.reason], ['pending', 'draft_prices']);
  assert.equal(job.customerPortalInvitationRequestedAt, undefined);
  // Every customer surface holds it too: the portal withholds the estimate and payment, no deposit reminder, no
  // portal invitation from any sender, and no business-hub or account quote view.
  assert.deepEqual(heldEverywhere(job), HELD);
  assert.deepEqual(signed.pricing, { source: 'builder', ready: false, pending: ['Two-car garage base', SHELF.name, TOTES.name] });
  assert.ok(signed.warnings.some(row => row.code === 'prices_pending_approval' && /not sent to the customer until the owner approves/.test(row.message)));

  // The job breakdown and the buy list come from the builder's products: packs, units, SKU, store and product page.
  assert.deepEqual(job.jobBreakdown.sections.find(section => section.id === 'shelving').items, [`${SHELF.name} × 2 packs`]);
  assert.deepEqual(job.jobBreakdown.sections.find(section => section.id === 'storage').items, [`${TOTES.name} × 2 packs of 4`]);
  const buy = job.materials.filter(item => item.source === 'buy');
  assert.deepEqual(buy.map(item => [item.id, item.name, item.quantity, item.packs, item.unitsPerPack, item.sku, item.store, item.productUrl, item.category, item.purchaseState]), [
    ['quote-hd-100006678', SHELF.name, 2, 2, 1, SHELF.sku, 'The Home Depot', SHELF.productUrl, 'shelving', 'to_buy'],
    ['quote-hd-341048322', TOTES.name, 8, 2, 4, TOTES.sku, 'The Home Depot', TOTES.productUrl, 'storage', 'to_buy'],
  ]);
  assert.deepEqual(job.materials.filter(item => item.source === 'stock').map(item => item.id), ['kit-hand-truck-dolly', 'kit-contractor-bags']);
  assert.doesNotMatch(JSON.stringify([job.materials, job.jobBreakdown]), MONEY);

  // The office purchase list (GET /api/purchase-list) groups them by store with packs to buy and the product page.
  const office = await (await purchaseListHandlers({ session: async () => owner, storage: () => f.purchaseStore, now: () => new Date(NOW) }).get({ request: new Request(`https://easygaragecleaning.com/api/purchase-list?start=${MON}&end=${MON}`), env: ON_ENV })).json();
  assert.equal(office.ok, true);
  assert.deepEqual(office.stores.map(row => row.store), ['The Home Depot']);
  assert.deepEqual(office.stores[0].products.map(row => [row.name, row.sku, row.quantity, row.unitsPerPack, row.packsToBuy, row.productUrl, row.jobs.map(entry => [entry.jobId, entry.packs, entry.date, entry.time])]), [
    [TOTES.name, TOTES.sku, 8, 4, 2, TOTES.productUrl, [[job.id, 2, MON, '09:30']]],
    [SHELF.name, SHELF.sku, 2, 1, 2, SHELF.productUrl, [[job.id, 2, MON, '09:30']]],
  ]);
  assert.doesNotMatch(JSON.stringify(office), MONEY);

  // The crew grab list (GET /api/field-jobs projection, then the crew job page) shows the same products, never a price.
  // purchaseDetails is what /api/field-jobs passes while EGC_JOB_MATERIALS is on; without it the projection is as before.
  const crew = fieldJobProjection(job, [], { purchaseDetails: true });
  assert.deepEqual(crew.materials.filter(item => item.source === 'buy').map(item => [item.name, item.quantity, item.packs, item.unitsPerPack, item.store, item.sku, item.productUrl, item.purchaseState]), [
    [SHELF.name, 2, 2, 1, 'The Home Depot', SHELF.sku, SHELF.productUrl, 'to_buy'], [TOTES.name, 8, 2, 4, 'The Home Depot', TOTES.sku, TOTES.productUrl, 'to_buy']]);
  assert.deepEqual(crew.materials, fieldMaterials(job, { purchaseDetails: true }));
  assert.doesNotMatch(JSON.stringify(crew.materials), MONEY);
  assert.ok(fieldJobProjection(job).materials.every(item => !('store' in item) && !('sku' in item) && !('productUrl' in item)), 'flag off: no store, SKU or link');
  const bought = { ...job, materials: job.materials.map(item => item.source === 'buy' ? { ...item, purchaseState: 'purchased' } : item) };
  const card = crewPage().materialsCard({ canEdit: true, requiredEquipment: [], materials: fieldMaterials(bought, { purchaseDetails: true }).map(item => ({ ...item })) }, false);
  assert.match(card, new RegExp(`data-grab="quote-hd-341048322"  ><span class="check-label">${TOTES.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}<small>Qty 8 · 2 packs of 4 · Bought by the office</small><small class="shop">The Home Depot · SKU ${TOTES.sku} · <a class="product-link" href="${TOTES.productUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}" target="_blank" rel="noopener noreferrer">Product page</a></small>`));
  assert.doesNotMatch(card, /\$\s?\d/);

  // The HighLevel schedule mirror entry is queued in the same commit (EGC_GHL_SCHEDULE_MIRROR).
  const mirror = f.writesTo(GHL_SCHEDULE_MIRROR).filter(write => write.patch.jobId === job.id);
  assert.equal(mirror.length, 1);
  assert.deepEqual([mirror[0].patch.kind, mirror[0].patch.stage, mirror[0].patch.status, mirror[0].patch.expect.startAt], ['scheduled', 'job_scheduled', 'pending', '2026-10-19T15:30:00.000Z']);
  assert.match(mirror[0].patch.note.body, /Crew: Crew 1/);
  assert.match(mirror[0].patch.note.body, new RegExp(`${TOTES.name} x 8`));

  // A retry of the same request (a lost response) replays the saved job with the same crew outcome and pricing.
  const commits = f.calls.length, replay = await sign(f, input, state);
  assert.deepEqual([replay.replayed, replay.job.id, replay.crew, replay.pricing], [true, job.id, { status: 'assigned', crewName: 'Crew 1', priority: 1, date: MON, time: '09:30', endTime: '12:30' }, signed.pricing]);
  assert.equal(f.calls.length, commits, 'nothing is saved twice');

  // The owner approves the prices after the sale; only then does the builder's send gate release the estimate and deposit request.
  const release = (actorState, requestId = randomUUID()) => handoffHandlers({ session: async () => estimator, storage: () => f.store, now: () => new Date(LATER), compositeState: async () => actorState }).post({ request: new Request('https://easygaragecleaning.com/api/walkthrough-handoff', { method: 'POST', headers: { Origin: 'https://easygaragecleaning.com', 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'prices.release', requestId, jobId: job.id, expectedRevision: f.job(job.id).revision }) }), env: ON_ENV });
  const held = await release(state);
  const refused = await held.json();
  assert.deepEqual([held.status, refused.code], [409, 'quote_draft_composite_prices_unapproved']);
  assert.deepEqual(refused.details.unapproved.map(row => row.name), ['Two-car garage base', SHELF.name, TOTES.name]);
  assert.equal(f.job(job.id).customerPortalInvitationRequestedAt, undefined);
  const approved = builderState(Object.fromEntries(priced.breakdown.lines.filter(line => !line.approved).map(line => [line.id, line.unitCents])));
  const requestId = randomUUID(), released = await (await release(approved, requestId)).json();
  assert.deepEqual([released.ok, released.released, released.pricing], [true, true, { source: 'builder', ready: true, pending: [] }]);
  assert.deepEqual([f.job(job.id).pricesPendingApproval, f.job(job.id).customerPortalInvitationRequestedAt, f.job(job.id).compositeQuote.approval], [null, LATER, { ready: true, pending: [] }]);
  assert.deepEqual(f.job(job.id).pricesRelease, { at: LATER, by: estimator.user, source: 'prices.release', requestId, gate: 'approved_prices' });
  assert.deepEqual(heldEverywhere(f.job(job.id)), RELEASED, 'released: the customer surfaces show it again');
  const again = await releaseHandoffPrices(f.store, estimator, { action: 'prices.release', requestId, jobId: job.id, expectedRevision: 'stale' }, LATER, { env: ON_ENV, compositeState: async () => approved });
  assert.deepEqual([again.replayed, again.released], [true, true], 'a retried release replays');
});

test('crew auto-assign on a signed walkthrough: Crew 1 busy goes to Crew 2, a weekend to Crew 3, and no free crew keeps the sale as Sold: needs crew with alternatives', async () => {
  const f = fixture();
  const first = await signNew(f, 1, {}, 'crew_one');
  assert.deepEqual([first.crew.status, first.crew.crewName, f.job(first.job.id).crewId], ['assigned', 'Crew 1', 'crew_one']);
  assert.deepEqual(first.pricing, { source: 'walkthrough', ready: false, pending: ['Walkthrough-priced quote'] }, 'builder on: a walkthrough-priced sale is staffed and held for the owner');
  // The page still offered Crew 1 (an older opening): Dispatch gives the next free crew and says so, naming no employee.
  const second = await signNew(f, 2, {}, 'crew_one');
  assert.deepEqual([second.crew.status, second.crew.crewName, second.crew.priority, f.job(second.job.id).crewId, f.job(second.job.id).assignedCrew], ['assigned', 'Crew 2', 2, 'crew_two', ['c2a', 'c2b']]);
  assert.ok(second.warnings.some(row => row.code === 'crew_choice_unavailable' && /Crew 2 was assigned instead/.test(row.message)));
  assert.doesNotMatch(JSON.stringify(second), EMPLOYEES);
  // A Saturday job goes to the weekend crew, with no crew chosen.
  const weekend = await signNew(f, 3, { date: SAT });
  assert.deepEqual([weekend.crew.status, weekend.crew.crewName, f.job(weekend.job.id).crewId], ['assigned', 'Crew 3', 'crew_three']);
  // Both weekday crews are booked Monday 9:30: the sale is saved on its date without a crew and lists the open crew times.
  const full = await signNew(f, 4);
  const saved = f.job(full.job.id);
  assert.deepEqual([full.crew.status, saved.date, saved.time, saved.assignedCrew, saved.crewId ?? null], ['unassigned', MON, '09:30', [], null]);
  assert.deepEqual([saved.soldNeedsCrew.reason, saved.soldNeedsCrew.by], ['no_crew_free', estimator.user]);
  assert.ok(full.warnings.some(row => row.code === 'no_crew_available' && /Sold: needs crew/.test(row.message)));
  assert.ok(full.crew.alternatives.length > 0 && full.crew.alternatives.every(row => Object.keys(row).sort().join() === 'crewId,crewLabel,date,endTime,priority,time'));
  assert.deepEqual(full.crew.alternatives[0], { date: MON, time: '12:50', endTime: '15:50', crewId: 'crew_one', crewLabel: 'Crew 1', priority: 1 }, 'the next opening that day, after the owner\'s travel buffer');
  assert.doesNotMatch(JSON.stringify(full), EMPLOYEES);
  // A crew that cannot take the visit (inactive) never costs the sale: Dispatch picks without it.
  const g = fixture();
  g.rows.set('dispatchResources/crew_one', { ...g.rows.get('dispatchResources/crew_one'), status: 'inactive' });
  const fallback = await signNew(g, 1, {}, 'crew_one');
  assert.deepEqual([fallback.crew.crewName, g.job(fallback.job.id).crewId], ['Crew 2', 'crew_two']);
  assert.ok(fallback.warnings.some(row => row.code === 'crew_choice_unavailable' && /can no longer take this visit/.test(row.message)));
  // A manager who names the crew keeps it; the server does not re-pick a hand-staffed job.
  const h = fixture(), manual = await saveWalkthroughHandoff(h.store, owner, { requestId: randomUUID(), customerId: 'c1', sourceWalkthroughId: 'w1', sourceRevision: 'w1r', plan: signedPlan(1, { logistics: { assigned_to: 'c2a, c2b' } }) }, NOW, { env: ON_ENV });
  assert.deepEqual([h.job(manual.job.id).assignedCrew, manual.crew, manual.job.assignedCrew], [['c2a', 'c2b'], undefined, ['c2a', 'c2b']]);
});

test('builder prices come from the server: a changed total, line or version is refused with a clear code and nothing is saved', async () => {
  const f = fixture(), state = builderState(), { priced, draft } = await builderDraft(f, state), commits = f.calls.length;
  const mismatch = error => error.code === 'handoff_builder_price_mismatch' && error.status === 409 && error.details.totalCents === priced.totalCents && /quote builder's prices on the server/.test(error.message);
  await assert.rejects(signDraft(f, priced, draft, state, { total: priced.totalCents / 100 - 100 }), mismatch, 'a lower signed total');
  const lines = priced.lineItems.map(line => ({ id: line.id, kind: line.kind, name: line.name, quantity: line.quantity, unitCents: line.unitCents, totalCents: line.totalCents }));
  lines[0] = { ...lines[0], unitCents: lines[0].unitCents - 100, totalCents: lines[0].totalCents - 100 }; lines[1] = { ...lines[1], unitCents: lines[1].unitCents + 100, totalCents: lines[1].totalCents + 100 };
  await assert.rejects(signDraft(f, priced, draft, state, { quote: { line_items: lines } }), mismatch, 'browser line prices that still add up to the total');
  await assert.rejects(signDraft(f, priced, draft, state, { quote: { catalog_version: '2026-01-01.1' } }), mismatch, 'another menu version');
  await assert.rejects(signDraft(f, priced, draft, state, { quote: { composite_pricing: { ...priced.compositePricing, menuVersion: '2026-01-01.1' } } }), error => error.code === 'quote_draft_composite_version_changed');
  // A walkthrough-priced signature over the saved builder quote (an older page) is refused too.
  const job = f.job(draft.id);
  await assert.rejects(saveWalkthroughHandoff(f.store, estimator, { requestId: randomUUID(), customerId: 'c1', sourceWalkthroughId: 'w1', sourceRevision: 'w1r', jobId: job.id, expectedRevision: job.revision, plan: signedPlan(1, { total: 1400 }) }, NOW, { env: ON_ENV, compositeState: async () => state }), mismatch);
  assert.equal(f.calls.length, commits, 'nothing was saved');
  // Through the API the refusal says what the server priced.
  const api = handoffHandlers({ session: async () => estimator, storage: () => f.store, now: () => new Date(NOW), compositeState: async () => state, stripe: () => null });
  const plan = signedPlan(1, { total: 1400, quote: { composite_pricing: priced.compositePricing } });
  const response = await api.post({ request: new Request('https://easygaragecleaning.com/api/walkthrough-handoff', { method: 'POST', headers: { Origin: 'https://easygaragecleaning.com', 'Content-Type': 'application/json' }, body: JSON.stringify({ requestId: randomUUID(), customerId: 'c1', sourceWalkthroughId: 'w1', sourceRevision: 'w1r', jobId: job.id, expectedRevision: job.revision, plan }) }), env: ON_ENV });
  assert.deepEqual([response.status, await response.json()], [409, { ok: false, code: 'handoff_builder_price_mismatch', error: `The signed quote does not match the quote builder's prices on the server: this selection comes to $${(priced.totalCents / 100).toFixed(2)}. Review the quote in the builder, then have the customer sign that total.`, details: { totalCents: priced.totalCents, menuVersion: priced.menuVersion } }]);
  // Approved prices (the $750 full truck only): the job is ready at once and its portal invitation is asked for.
  const g = fixture(), truck = selection({ removal: [{ id: menuItem('Full truck load').id, quantity: 2 }], shelving: [], storage: [] }), quick = await builderDraft(g, state, truck);
  const ready = await signDraft(g, quick.priced, quick.draft, state);
  assert.deepEqual([ready.pricing, g.job(ready.job.id).pricesPendingApproval, g.job(ready.job.id).customerPortalInvitationRequestedAt], [{ source: 'builder', ready: true, pending: [] }, undefined, NOW]);
  assert.deepEqual(g.job(ready.job.id).materials.filter(item => item.source === 'buy'), [], 'removal only: nothing to buy');
});

test('purchase fields on a signed line (EGC_JOB_MATERIALS or the builder): strictly checked, they become its buy material and the estimate stores the line without them; flags off they are refused as before', async () => {
  const MAT_ENV = { ...BASE_ENV, EGC_JOB_MATERIALS: 'true' }, PURCHASE = ['category', 'sku', 'unitsPerPack', 'unit', 'productUrl', 'store', 'source'];
  const f = fixture(), product = { id: 'tote-pack', kind: 'product', name: 'Storage totes (4-pack)', quantity: 2, unitCents: 6000, totalCents: 12000, category: 'storage', sku: '341048322', unitsPerPack: 4, unit: 'pack', productUrl: TOTES.productUrl, store: 'The Home Depot', source: 'buy' };
  const lines = [{ id: 'cleanout', kind: 'service', name: 'Garage cleanout and reset', quantity: 1, unitCents: 128000, totalCents: 128000, category: 'removal' }, product];
  const bare = line => Object.fromEntries(Object.entries(line).filter(([key]) => !PURCHASE.includes(key)));
  const signed = await signNew(f, 1, { quote: { line_items: lines } }, null, owner, MAT_ENV);
  const job = f.job(signed.job.id);
  assert.deepEqual(job.estimate.lineItems, normalizeLineItems(lines.map(bare), { strict: true }).lineItems, 'the signed estimate stores no purchase field');
  assert.deepEqual(job.acceptedHandoffPayload.quote.estimate_line_items, job.estimate.lineItems);
  assert.deepEqual(job.materials.find(item => item.id === 'quote-tote-pack'), { id: 'quote-tote-pack', name: 'Storage totes (4-pack)', quantity: 2, sku: '341048322', unit: 'pack', unitsPerPack: 4, packs: 1, source: 'buy', purchaseState: 'to_buy', productUrl: TOTES.productUrl, category: 'storage', store: 'The Home Depot' });
  assert.deepEqual(job.jobBreakdown.sections.find(section => section.id === 'storage').items, ['2 × Storage totes (4-pack)'], 'the breakdown reads the line\'s step');
  assert.equal(savedHandoffPayload(job, signed.requestId).quote.total, 1400);
  for (const [key, value, message] of [['sku', 'bad sku', /SKU/], ['productUrl', 'http://www.homedepot.com/p/1', /https/], ['unitsPerPack', 0, /Units per pack/], ['category', 'tools', /category/], ['source', 'borrow', /buy or stock/], ['store', 'x'.repeat(81), /store/], ['unit', 'Pack!', /unit/]]) {
    await assert.rejects(signNew(fixture(), 1, { quote: { line_items: [lines[0], { ...product, [key]: value }] } }, null, owner, MAT_ENV), error => error.code === 'handoff_invalid_line_items' && error.status === 400 && message.test(error.message), key);
  }
  await assert.rejects(signNew(fixture(), 1, { quote: { line_items: [{ ...lines[0], sku: '1' }, product] } }, null, owner, MAT_ENV), error => error.code === 'handoff_invalid_line_items' && /product line/.test(error.message), 'a SKU belongs to a product line');
  // Every flag off: refused exactly as before the estimator integration.
  await assert.rejects(signNew(fixture(), 1, { quote: { line_items: lines } }, null, owner, BASE_ENV), error => error.code === 'handoff_invalid_line_items' && error.status === 400 && error.message === 'The itemized quote is invalid: Unsupported line item field: category.');
});

test('a builder selection must be a selection: false, 0, \'\', [] and other values are refused and never book a client-priced job; null falls back to the saved selection', async () => {
  const f = fixture(), state = builderState(), { priced, draft } = await builderDraft(f, state), commits = f.calls.length;
  const resign = (job, value) => ({ actorId: estimator.user, requestId: randomUUID(), customerId: 'c1', sourceWalkthroughId: 'w1', sourceRevision: f.rows.get('jobs/w1').revision, jobId: job.id, expectedRevision: f.job(job.id).revision, plan: signedPlan(1, { total: 100, quote: { composite_pricing: value } }) });
  const invalid = error => error.code === 'handoff_invalid_plan' && error.status === 400 && /quote builder selection is invalid/.test(error.message);
  for (const value of [false, 0, '', [], 'removal', 7, true]) await assert.rejects(sign(f, resign(draft, value), state), invalid, JSON.stringify(value));
  assert.equal(f.calls.length, commits, 'nothing was saved');
  // null (no selection sent): the saved builder draft is priced on the server and the client's total is refused.
  await assert.rejects(sign(f, resign(draft, null), state), error => error.code === 'handoff_builder_price_mismatch' && error.details.totalCents === priced.totalCents);
  // A job booked with pending prices cannot be re-signed around its hold either.
  const booked = await signDraft(f, priced, draft, state, { crewId: null }), held = f.calls.length;
  for (const value of [false, 0, '', []]) await assert.rejects(sign(f, resign(f.job(booked.job.id), value), state), invalid, JSON.stringify(value));
  await assert.rejects(sign(f, resign(f.job(booked.job.id), null), state), error => error.code === 'handoff_builder_price_mismatch');
  assert.equal(f.calls.length, held);
  assert.deepEqual([f.job(booked.job.id).estimate.amount, f.job(booked.job.id).pricesPendingApproval.status, f.job(booked.job.id).customerPortalInvitationRequestedAt], [priced.totalCents / 100, 'pending', undefined]);
  // Through the API: a 400 with the code.
  const response = await handoffHandlers({ session: async () => estimator, storage: () => f.store, now: () => new Date(NOW), compositeState: async () => state, stripe: () => null }).post({ request: new Request('https://easygaragecleaning.com/api/walkthrough-handoff', { method: 'POST', headers: { Origin: 'https://easygaragecleaning.com', 'Content-Type': 'application/json' }, body: JSON.stringify(resign(f.job(booked.job.id), false)) }), env: ON_ENV });
  assert.deepEqual([response.status, (await response.json()).code], [400, 'handoff_invalid_plan']);
  // Flag off the value is not read at all, as before.
  const g = fixture(BASE_ENV), plain = await signNew(g, 1, { quote: { composite_pricing: false } }, null, estimator, BASE_ENV);
  assert.equal(g.job(plain.job.id).estimate.amount, 1400);
});

test('builder on: a walkthrough-priced signature books the job but holds it; the send gate refuses it like an unbuilt quote draft and only the owner may release it', async () => {
  const f = fixture(), manager = { user: 'tylerg', role: 'manager', businessAccess: true, displayName: 'Synthetic Manager' };
  const signed = await signNew(f, 1), job = f.job(signed.job.id);
  assert.deepEqual([job.status, job.date, job.estimate.amount, job.crewId], ['scheduled', MON, 1400, 'crew_one'], 'the sale is booked and staffed');
  assert.deepEqual(job.pricesPendingApproval, { status: 'pending', reason: 'walkthrough_priced', at: NOW, by: estimator.user, requestId: signed.requestId, items: [{ id: null, name: 'Walkthrough-priced quote' }] });
  assert.equal(job.customerPortalInvitationRequestedAt, undefined);
  assert.deepEqual(signed.pricing, { source: 'walkthrough', ready: false, pending: ['Walkthrough-priced quote'] });
  assert.ok(signed.warnings.some(row => row.code === 'prices_pending_approval' && /quote builder did not price/.test(row.message)));
  assert.deepEqual(heldEverywhere(job), HELD);
  // The send gate refuses the estimator and a manager as it refuses sending an unbuilt quote draft.
  const release = actor => releaseHandoffPrices(f.store, actor, { action: 'prices.release', requestId: randomUUID(), jobId: job.id, expectedRevision: f.job(job.id).revision }, LATER, { env: ON_ENV, compositeState: async () => { throw new Error('a walkthrough-priced job reads no builder state'); } });
  for (const actor of [estimator, manager]) await assert.rejects(release(actor), error => error.code === 'quote_draft_builder_required' && error.status === 409 && error.details.unapproved[0].name === 'Walkthrough-priced quote', actor.user);
  const response = await handoffHandlers({ session: async () => estimator, storage: () => f.store, now: () => new Date(LATER) }).post({ request: new Request('https://easygaragecleaning.com/api/walkthrough-handoff', { method: 'POST', headers: { Origin: 'https://easygaragecleaning.com', 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'prices.release', requestId: randomUUID(), jobId: job.id, expectedRevision: f.job(job.id).revision }) }), env: ON_ENV });
  const body = await response.json();
  assert.deepEqual([response.status, body.code, body.details.unapproved.map(row => [row.id, row.name, row.unitCents])], [409, 'quote_draft_builder_required', [[null, 'Walkthrough-priced quote', null]]]);
  assert.deepEqual(heldEverywhere(f.job(job.id)), HELD);
  // The owner approves this signed price: released, and the invitation is asked for.
  const done = await release(owner);
  assert.deepEqual([done.released, done.pricing], [true, { source: 'walkthrough', ready: true, pending: [] }]);
  assert.deepEqual([f.job(job.id).pricesPendingApproval, f.job(job.id).customerPortalInvitationRequestedAt, f.job(job.id).pricesRelease.gate], [null, LATER, 'owner_release']);
  assert.deepEqual(heldEverywhere(f.job(job.id)), RELEASED);
  // A Hub catalog quote draft signed exactly as the server priced it keeps the catalog's own approval; a changed line is held.
  const catalogLines = [{ id: 'catalog-shelf', kind: 'product', name: 'Metal shelving unit', quantity: 2, unitCents: 20000, totalCents: 40000 }, { id: 'cleanout', kind: 'service', name: 'Garage cleanout and reset', quantity: 1, unitCents: 100000, totalCents: 100000 }];
  for (const [lines, heldAs] of [[catalogLines, undefined], [[{ ...catalogLines[0], unitCents: 25000, totalCents: 50000 }, { ...catalogLines[1], unitCents: 90000, totalCents: 90000 }], 'walkthrough_priced']]) {
    const g = fixture();
    g.rows.set('jobs/cq1', { id: 'cq1', revision: 'cq1r', type: 'job', status: 'unscheduled', pipelineStatus: 'unscheduled', customerId: 'c2', sourceWalkthroughId: 'w2', customer: client(2).name, date: '', time: '', createdBy: estimator.user,
      quoteDraft: { catalogPricing: { catalogVersion: '2026-10-01' } }, estimate: { status: 'draft', source: 'quote_draft', amount: 1400, lineItems: normalizeLineItems(catalogLines, { strict: true }).lineItems } });
    const catalogSigned = await saveWalkthroughHandoff(g.store, estimator, { requestId: randomUUID(), customerId: 'c2', sourceWalkthroughId: 'w2', sourceRevision: 'w2r', jobId: 'cq1', expectedRevision: 'cq1r', plan: signedPlan(2, { quote: { line_items: lines } }) }, NOW, { env: ON_ENV, compositeState: async () => { throw new Error('no builder state'); } });
    assert.equal(g.job(catalogSigned.job.id).pricesPendingApproval?.reason, heldAs);
    assert.equal(g.job(catalogSigned.job.id).customerPortalInvitationRequestedAt, heldAs ? undefined : NOW);
  }
  // The owner, who approves prices, signing a walkthrough price in person is that approval: not held.
  const o = fixture(), ownerSigned = await signNew(o, 3, {}, null, owner);
  assert.deepEqual([o.job(ownerSigned.job.id).pricesPendingApproval, o.job(ownerSigned.job.id).customerPortalInvitationRequestedAt, 'pricing' in ownerSigned], [undefined, NOW, false]);
  // Flag off: the same signature asks for the invitation at once, exactly as before.
  const h = fixture(BASE_ENV), plain = await signNew(h, 1, {}, null, estimator, BASE_ENV);
  assert.deepEqual([h.job(plain.job.id).pricesPendingApproval, h.job(plain.job.id).customerPortalInvitationRequestedAt, 'pricing' in plain], [undefined, NOW, false]);
});

test('the owner\'s menu approval releases the held builder jobs it now covers (bounded); walkthrough-priced and still-unapproved jobs keep waiting', async () => {
  const f = fixture(), state = builderState();
  const base = menuItem('Two-car garage base'), truck = menuItem('Full truck load');
  // A: removal only, waiting for the garage base price. C: with goods, waiting for those prices and the installation decision.
  const removalOnly = selection({ removal: [{ id: base.id, quantity: 1 }, { id: truck.id, quantity: 1 }], shelving: [], storage: [] });
  const a = await builderDraft(f, state, removalOnly), signedA = await signDraft(f, a.priced, a.draft, state, { crewId: null });
  // B: a walkthrough-priced sale on w2.
  const signedB = await signNew(f, 2);
  const ids = [signedA.job.id, signedB.job.id];
  assert.deepEqual(ids.map(id => f.job(id).pricesPendingApproval.reason), ['draft_prices', 'walkthrough_priced']);
  const reads = [], held = () => ({ ...f.store, heldJobIds: async limit => { reads.push(limit); return [...f.rows.values()].filter(row => row.pricesPendingApproval?.status === 'pending').map(row => row.id).slice(0, limit); } });
  // POST /api/catalog menu.approve as the Hub sends it, over an in-memory catalog store.
  const catalogRows = new Map();
  let tick = 0;
  const catalogStore = { read: async (collection, id) => structuredClone(catalogRows.get(`${collection}/${id}`) || null), commit: async writes => { const at = `rev-${++tick}`; for (const write of writes) catalogRows.set(`${write.collection}/${write.id}`, { ...structuredClone(write.patch), id: write.id, revision: at }); return { writeResults: writes.map(() => ({ updateTime: at })) }; } };
  const pricing = async () => { const saved = catalogRows.get('pricingMenuApprovals/current'); return saved ? { ...state, approvals: { items: saved.approvals, revision: saved.revision } } : state; };
  const approvalId = randomUUID(), approve = (items, expectedRevision = null) => catalogHandlers({ session: async () => owner, storage: () => catalogStore, now: () => new Date(LATER), compositeState: pricing, held }).post({ request: new Request('https://easygaragecleaning.com/api/catalog', { method: 'POST', headers: { Origin: 'https://easygaragecleaning.com', 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'menu.approve', requestId: approvalId, expectedRevision, menuVersion: state.menu.menuVersion, settingsVersion: state.settings.settingsVersion, approve: items, revoke: [] }) }), env: ON_ENV });
  const response = await approve([{ id: base.id, unitCents: a.priced.breakdown.lines.find(line => line.id === base.id).unitCents }]), result = await response.json();
  assert.equal(response.status, 200, JSON.stringify(result));
  assert.deepEqual(result.heldJobs, { released: [signedA.job.id], waiting: 1, more: false }, 'A is covered now; the walkthrough-priced B keeps waiting');
  assert.deepEqual(reads, [26], 'one bounded query');
  const releasedA = f.job(signedA.job.id);
  assert.deepEqual([releasedA.pricesPendingApproval, releasedA.customerPortalInvitationRequestedAt, releasedA.pricesRelease, releasedA.compositeQuote.approval], [null, LATER, { at: LATER, by: owner.user, source: 'menu.approve', requestId: approvalId, gate: 'approved_prices' }, { ready: true, pending: [] }]);
  // A retried approval (a lost response) replays and runs nothing again.
  const replayed = await (await approve([{ id: base.id, unitCents: a.priced.breakdown.lines.find(line => line.id === base.id).unitCents }])).json();
  assert.deepEqual([replayed.replayed, 'heldJobs' in replayed, reads.length], [true, false, 1]);
  assert.deepEqual(heldEverywhere(releasedA), RELEASED);
  assert.deepEqual([f.job(signedB.job.id).pricesPendingApproval.reason, f.job(signedB.job.id).customerPortalInvitationRequestedAt], ['walkthrough_priced', undefined]);
  // A builder job still waiting for some prices (the totes) is not released by a partial approval; the rest releases it
  // (installation is billed through its Labor line, so no installation answer is needed).
  const g = fixture(), goods = await builderDraft(g, state), signedG = await signDraft(g, goods.priced, goods.draft, state, { crewId: null });
  const partial = builderState({ [base.id]: goods.priced.breakdown.lines.find(line => line.id === base.id).unitCents, [SHELF.id]: goods.priced.breakdown.lines.find(line => line.id === SHELF.id).unitCents });
  const gHeld = { ...g.store, heldJobIds: async () => [signedG.job.id] };
  assert.deepEqual(await releaseHeldHandoffs(gHeld, owner, LATER, { env: ON_ENV, compositeState: async () => partial }), { released: [], waiting: 1, more: false });
  assert.equal(g.job(signedG.job.id).pricesPendingApproval.status, 'pending');
  const all = builderState({ ...Object.fromEntries(goods.priced.breakdown.lines.filter(line => !line.approved).map(line => [line.id, line.unitCents])) });
  assert.deepEqual(await releaseHeldHandoffs(gHeld, owner, LATER, { env: ON_ENV, compositeState: async () => all, limit: 1 }), { released: [signedG.job.id], waiting: 0, more: false });
  // Bounded: limit + 1 ids are read and the rest wait for the next save (more).
  const many = { ...g.store, heldJobIds: async limit => ['missing-1', 'missing-2', 'missing-3'].slice(0, limit) };
  assert.deepEqual(await releaseHeldHandoffs(many, owner, LATER, { env: ON_ENV, compositeState: async () => all, limit: 2 }), { released: [], waiting: 0, more: true });
  // A failed lookup never undoes the approval: the answer says the held jobs were deferred.
  const broken = catalogHandlers({ session: async () => owner, storage: () => catalogStore, now: () => new Date(LATER), compositeState: pricing, held: () => ({ heldJobIds: async () => { throw new Error('down'); } }) });
  const saved = await broken.post({ request: new Request('https://easygaragecleaning.com/api/catalog', { method: 'POST', headers: { Origin: 'https://easygaragecleaning.com', 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'menu.approve', requestId: randomUUID(), expectedRevision: catalogRows.get('pricingMenuApprovals/current').revision, menuVersion: state.menu.menuVersion, settingsVersion: state.settings.settingsVersion, approve: [], revoke: [base.id] }) }), env: ON_ENV });
  const savedBody = await saved.json();
  assert.deepEqual([saved.status, savedBody.ok, savedBody.heldJobs], [200, true, { status: 'deferred' }]);
  // Flag off the hook never runs (and the library answers null).
  assert.equal(await releaseHeldHandoffs(gHeld, owner, LATER, { env: BASE_ENV }), null);
});

test('the owner\'s installation decision (settings.update) releases a builder job signed before the Labor line that waited only for it', async () => {
  const f = fixture(), defaults = JSON.parse(readFileSync(new URL('../functions/_data/pricing-settings.defaults.json', import.meta.url), 'utf8'));
  const draftPrices = priceCompositeQuote(builderState(), selection(), { complete: true }), approvals = Object.fromEntries(draftPrices.breakdown.lines.filter(line => !line.approved).map(line => [line.id, line.unitCents]));
  // Every menu price on the quote is approved: a quote with labor is not held at all.
  const state = builderState(approvals), { priced, draft } = await builderDraft(f, state), signed = await signDraft(f, priced, draft, state, { crewId: null });
  assert.deepEqual(signed.pricing, { source: 'builder', ready: true, pending: [] });
  // The same job as one signed before builder quotes had a Labor line: held only for the installation decision.
  const legacy = structuredClone(f.job(signed.job.id));
  delete legacy.compositeQuote.breakdown.labor;
  Object.assign(legacy, { pricesPendingApproval: { status: 'pending', reason: 'draft_prices', at: NOW, by: estimator.user, requestId: signed.requestId, items: [{ id: 'goods-installation', name: 'Shelving and storage installation' }] }, compositeQuote: { ...legacy.compositeQuote, approval: { ready: false, pending: [{ id: 'goods-installation', name: 'Shelving and storage installation' }] } } });
  delete legacy.customerPortalInvitationRequestedAt;
  f.rows.set(`jobs/${signed.job.id}`, legacy);
  const catalogRows = new Map();
  let tick = 0;
  const catalogStore = { read: async (collection, id) => structuredClone(catalogRows.get(`${collection}/${id}`) || null), commit: async writes => { const at = `rev-${++tick}`; for (const write of writes) catalogRows.set(`${write.collection}/${write.id}`, { ...structuredClone(write.patch), id: write.id, revision: at }); return { writeResults: writes.map(() => ({ updateTime: at })) }; } };
  const pricing = async () => { const saved = catalogRows.get('pricingSettings/current'); return saved ? { ...state, settings: saved.settings } : state; };
  const env = { ...ON_ENV, CATALOG_QUOTES_ENABLED: 'true' };
  const held = () => ({ ...f.store, heldJobIds: async limit => [...f.rows.values()].filter(row => row.pricesPendingApproval?.status === 'pending').map(row => row.id).slice(0, limit) });
  const response = await catalogHandlers({ session: async () => owner, storage: () => catalogStore, now: () => new Date(LATER), compositeState: pricing, held }).post({ request: new Request('https://easygaragecleaning.com/api/catalog', { method: 'POST', headers: { Origin: 'https://easygaragecleaning.com', 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'settings.update', requestId: randomUUID(), expectedRevision: null, settings: { ...defaults, settingsVersion: 'owner-2026-10-17', goodsInstallationIncluded: true } }) }), env });
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.deepEqual(body.heldJobs, { released: [signed.job.id], waiting: 0, more: false });
  assert.deepEqual([f.job(signed.job.id).pricesPendingApproval, f.job(signed.job.id).customerPortalInvitationRequestedAt, f.job(signed.job.id).pricesRelease.source], [null, LATER, 'settings.update']);
});

test('held job lookup: one bounded runQuery on pricesPendingApproval.status, document names only, failing closed', async () => {
  const sent = [], root = 'projects/egcw-1ec83/databases/(default)/documents';
  const fetcher = answer => async (_env, url, options) => { sent.push({ url: String(url), body: JSON.parse(options.body) }); return typeof answer === 'function' ? answer() : Response.json(answer); };
  assert.deepEqual(await heldJobIds({}, 26, fetcher([{ document: { name: `${root}/jobs/job-a` } }, { document: { name: `${root}/jobs/job-b` } }, { readTime: '2026-10-17T15:00:00Z' }])), ['job-a', 'job-b']);
  assert.equal(sent[0].url, `https://firestore.googleapis.com/v1/${root}:runQuery`);
  assert.deepEqual(sent[0].body, heldJobsQuery(26));
  assert.deepEqual(heldJobsQuery(26).structuredQuery, { from: [{ collectionId: 'jobs' }], select: { fields: [{ fieldPath: '__name__' }] }, where: { fieldFilter: { field: { fieldPath: 'pricesPendingApproval.status' }, op: 'EQUAL', value: { stringValue: 'pending' } } }, limit: 26 });
  assert.deepEqual(await heldJobIds({}, 5, fetcher([{ readTime: '2026-10-17T15:00:00Z' }])), []);
  for (const answer of [{}, [null], [{ document: { name: `${root}/customers/c1` } }], () => new Response('{}', { status: 503 }), () => { throw new Error('offline'); }]) {
    await assert.rejects(heldJobIds({}, 5, fetcher(answer)), { code: 'handoff_held_jobs_unavailable' });
  }
  for (const limit of [0, 101, 2.5]) await assert.rejects(heldJobIds({}, limit, fetcher([])), { code: 'handoff_held_jobs_unavailable' });
});

test('crew openings through the API: rep-safe rows for a quote author while the flag is on; refused as before while it is off', async () => {
  const f = fixture(), get = (env, query) => handoffHandlers({ session: async () => estimator, storage: () => f.store, now: () => new Date(NOW) }).get({ request: new Request(`https://easygaragecleaning.com/api/walkthrough-handoff?${query}`), env });
  const on = await get(ON_ENV, `view=crew_openings&startDate=${SAT}&durationMinutes=180`), body = await on.json();
  assert.equal(on.status, 200);
  assert.deepEqual(body.openings[0], { date: SAT, time: '09:30', endTime: '12:30', crewId: 'crew_three', crewLabel: 'Crew 3', priority: 3 }, 'Saturday: the weekend crew');
  assert.ok(body.openings.every(row => ['crew_one', 'crew_two'].includes(row.crewId) ? ![SAT, '2026-10-25'].includes(row.date) : [SAT, '2026-10-25'].includes(row.date)), 'weekday crews never on the weekend and the weekend crew never on a weekday');
  assert.deepEqual(Object.keys(body).sort(), ['authority', 'ok', 'openings', 'viewer']);
  assert.doesNotMatch(JSON.stringify(body.openings), EMPLOYEES);
  assert.deepEqual([(await get(ON_ENV, 'view=crew_openings&roster=1')).status, (await get(ON_ENV, 'view=crew_openings&crewIds=crew_one')).status], [400, 400], 'only the start date, duration and travel buffer can be asked for');
  const off = await get(BASE_ENV, `view=crew_openings&startDate=${MON}`);
  assert.deepEqual([off.status, (await off.json()).code], [400, 'handoff_invalid_request']);
  const prepared = await (await get(BASE_ENV, 'sourceWalkthroughId=w1')).json();
  assert.equal('crewAutoAssign' in prepared, false);
  assert.equal((await (await get(ON_ENV, 'sourceWalkthroughId=w1')).json()).crewAutoAssign, true);
  // A sales login with no crews set up yet gets an empty list, not an error.
  const g = fixture(ON_ENV, { crews: false });
  assert.deepEqual((await handoffCrewOpenings(g.store, estimator, { view: 'crew_openings', startDate: TUE }, new Date(NOW), { env: ON_ENV })).openings, []);
});

test('the gameplan page: crew-mode slot choices, the builder quote it signs and the crew outcome it shows', async () => {
  const source = readFileSync(new URL('../crew/gameplan-handoff.js', import.meta.url), 'utf8'), html = readFileSync(new URL('../crew/gameplan.html', import.meta.url), 'utf8');
  const lineOf = prefix => html.split(/\r?\n/).find(row => row.startsWith(prefix)) || assert.fail(prefix);
  const context = vm.createContext({ window: {}, URLSearchParams, AbortController, setTimeout, clearTimeout });
  vm.runInContext(source, context);
  const { crewSlots, crewOutcome, builderQuoteOf } = context.window.EGCGameplanCrew;
  const rows = [{ date: MON, time: '09:30', endTime: '12:30', crewId: 'crew_one', crewLabel: 'Crew 1', priority: 1 }, { date: MON, time: '09:30', endTime: '12:30', crewId: 'crew_two', crewLabel: 'Crew 2', priority: 2 }, { date: SAT, time: '13:00', endTime: '16:00', crewId: 'crew_three', crewLabel: 'Crew 3', priority: 3 }, { date: MON, time: 'bad' }];
  assert.deepEqual(JSON.parse(JSON.stringify(crewSlots(rows))), [
    { date: MON, start: '09:30', end: '12:30', crewId: 'crew_one', label: 'Crew 1 · Mon 10/19 9:30am' }, { date: MON, start: '09:30', end: '12:30', crewId: 'crew_two', label: 'Crew 2 · Mon 10/19 9:30am' }, { date: SAT, start: '13:00', end: '16:00', crewId: 'crew_three', label: 'Crew 3 · Sat 10/24 1:00pm' }]);
  assert.equal(crewOutcome({ status: 'assigned', crewName: 'Crew 1', priority: 1, date: MON, time: '09:30' }), 'Crew 1 is booked for Mon 10/19 9:30am. ');
  assert.equal(crewOutcome({ status: 'unassigned', date: MON, time: '09:30', alternatives: rows.slice(1) }), 'No crew is free at that time, so the office will assign a crew. Open crew times: Crew 2 · Mon 10/19 9:30am, Crew 3 · Sat 10/24 1:00pm. ');
  assert.equal(crewOutcome(undefined), '');
  // The slot list marks only the chosen crew's opening (Crew 1 and Crew 2 share a time) and shows its times as the
  // label does; a slot without a crew (the flag off) is marked and shown as before.
  const slots = vm.createContext({ window: context.window, EGCGameplanCrew: context.window.EGCGameplanCrew, SLOT_LOADING: false, SLOT_ERROR: '', SLOT_OPTIONS: crewSlots(rows), S: { jobDate: MON, startTime: '09:30', requestedCrewId: 'crew_two' } });
  vm.runInContext(lineOf('const $=id=>'), slots);
  vm.runInContext(lineOf('function slotResults('), slots);
  const markup = vm.runInContext('slotResults()', slots);
  assert.deepEqual([...markup.matchAll(/class="slot ([a-z]*)"/g)].map(match => match[1]), ['', 'selected', '']);
  assert.match(markup, /Crew 2 · Mon 10\/19 9:30am<\/strong><span>9:30am–12:30pm<\/span>/);
  slots.SLOT_OPTIONS = [{ date: MON, start: '09:30', end: '12:30', label: MON }];
  slots.S = { jobDate: MON, startTime: '09:30', requestedCrewId: '' };
  assert.match(vm.runInContext('slotResults()', slots), /class="slot selected" onclick="chooseSlot\(0\)"><strong>2026-10-19<\/strong><span>09:30–12:30<\/span>/);
  // The page asks for crew openings only when the Hub says crews are auto-assigned; otherwise it searches the named crew as before.
  for (const auto of [true, false]) {
    const calls = [], page = vm.createContext({ window: {}, URLSearchParams, AbortController, setTimeout, clearTimeout, S: { assignedTo: 'Crew One', crewSize: '1' }, SLOT_LOADING: false, SLOT_SIGNATURE: '', SLOT_ERROR: '', SLOT_OPTIONS: [], sessionStorage: {}, localStorage: {},
      render: () => {}, slotSignature: () => 'sig', estimatedJobMinutes: () => 180, crypto: { randomUUID },
      EGCHubAuth: { fetch: async url => { calls.push(url); const body = url === '/api/walkthrough-handoff' ? { ok: true, roster: [{ id: 'crew1', name: 'Crew One' }], ...(auto ? { crewAutoAssign: true } : {}) } : url.startsWith('/api/walkthrough-handoff?') ? { ok: true, openings: rows } : { ok: true, candidates: [{ date: MON, time: '09:30', endTime: '12:30' }] }; return { ok: true, status: 200, json: async () => body }; }, session: async () => 'sales.person', canRunBusiness: () => false } });
    vm.runInContext(source, page);
    await page.window.EGCWalkthroughHandoff.openings(true);
    assert.deepEqual(calls, auto ? ['/api/walkthrough-handoff', '/api/walkthrough-handoff?view=crew_openings&durationMinutes=180&travelBufferMinutes=20'] : ['/api/walkthrough-handoff', '/api/dispatch-openings?employeeIds=crew1&durationMinutes=180&travelBufferMinutes=20']);
    assert.deepEqual(page.SLOT_OPTIONS.map(slot => slot.label), auto ? ['Crew 1 · Mon 10/19 9:30am', 'Crew 2 · Mon 10/19 9:30am', 'Crew 3 · Sat 10/24 1:00pm'] : [MON]);
  }
  // The builder quote a saved draft returned is what payload() signs: its total, lines, menu version and selection, plus the chosen crew.
  const state = builderState(), priced = priceCompositeQuote(state, selection(), { complete: true });
  const draftView = { id: 'job-1', compositePricing: priced.compositePricing, estimate: { amountCents: priced.totalCents, catalogVersion: priced.menuVersion, lineItems: priced.lineItems.map(line => ({ ...line, included: true })) } };
  const builder = JSON.parse(JSON.stringify(builderQuoteOf(draftView)));
  assert.deepEqual(builder, { compositePricing: priced.compositePricing, totalCents: priced.totalCents, menuVersion: priced.menuVersion, lineItems: priced.lineItems.map(line => ({ id: line.id, kind: line.kind, name: line.name, description: line.description, quantity: line.quantity, unitCents: line.unitCents, totalCents: line.totalCents })), jobId: 'job-1' });
  assert.equal(builderQuoteOf({ id: 'job-2', estimate: { amountCents: 140000, lineItems: [] } }), null, 'a walkthrough-priced draft is not a builder quote');
  const page = vm.createContext({ PRICING: null, save() {}, render() {}, invalidateAcceptance() {}, PHOTO_COUNT: 2, uid: () => 'local', normPhone: value => value, recommend: () => 1400, signedLines: () => [{ id: 'cleanout', kind: 'service', name: 'Garage cleanout and reset', quantity: 1, unitCents: 140000, totalCents: 140000 }], estimatedJobMinutes: () => 180,
    buildJobInstructions: () => ({ bringList: ['Hand truck / dolly'] }), buildInternalNotes: () => 'brief', buildCrewBrief: () => 'crew brief', buildClientChecklists: () => ({ preJob: [], postJob: [] }) });
  vm.runInContext(lineOf('const freshState='), page);
  vm.runInContext(lineOf('function payload('), page);
  page.S = Object.assign(vm.runInContext('freshState()', page), { name: 'Synthetic Customer 1', jobDate: MON, startTime: '09:30', endTime: '12:30', lockedPrice: '1400' });
  const plain = JSON.parse(JSON.stringify(page.payload()));
  assert.deepEqual([plain.quote.total, plain.quote.line_items.length, 'composite_pricing' in plain.quote, 'crew_id' in plain.logistics], [1400, 1, false, false], 'without a builder quote or a chosen crew the payload is as before');
  Object.assign(page.S, { builderQuote: builder, requestedCrewId: 'crew_one' });
  const sent = JSON.parse(JSON.stringify(page.payload()));
  assert.deepEqual([sent.quote.total, sent.quote.deposit, sent.quote.catalog_version, sent.quote.composite_pricing, sent.quote.line_items, sent.logistics.crew_id], [priced.totalCents / 100, Math.round(priced.totalCents / 2) / 100, priced.menuVersion, priced.compositePricing, builder.lineItems, 'crew_one']);
  assert.match(lineOf('function chooseSlot('), /S\.requestedCrewId=slot\.crewId\|\|''/);
  assert.match(lineOf('function updateField('), /if\(\['jobDate','startTime','endTime'\]\.includes\(key\)&&S\.requestedCrewId\)S\.requestedCrewId=''/, 'a time typed by hand drops the offered crew');
  assert.match(html, /\/crew\/gameplan-handoff\.js\?v=20261017crewbuild/);
});

test('the employee-leak check names employees, never the tail of a random request or job id', () => {
  // A random UUID group, or the dispatch_ job id made from a request UUID, can end in c1a ... c3b (6 in 4096 per group
  // end); the old check then failed a clean answer (requestId "a51db088-ac3a-…", 2026-10-17 CI). Every such id passes.
  const base = 'a51db088-4d2e-45c8-9d2e-6f0b1c7e4d29'.split('-');
  for (const suffix of ['c1a', 'c1b', 'c2a', 'c2b', 'c3a', 'c3b']) {
    for (let group = 0; group < base.length; group++) {
      const uuid = base.map((part, i) => i === group ? part.slice(0, -3) + suffix : part).join('-'), dispatchId = `dispatch_${uuid.replaceAll('-', '')}`;
      for (const answer of [{ requestId: uuid }, { job: { id: dispatchId, fieldJobUrl: `/crew/job.html?id=${dispatchId}` } }]) assert.doesNotMatch(JSON.stringify(answer), EMPLOYEES, uuid);
    }
  }
  assert.doesNotMatch(JSON.stringify({ requestId: 'a51db088-ac3a-45c8-9d2e-6f0b1c7e4d29' }), EMPLOYEES);
  // Every real leak is still caught: an id as a value, in a list, in a sentence or a roster name, and the sales login.
  for (const leak of [{ crewLead: 'c1a' }, { assignedCrew: ['c2a', 'c2b'] }, { assignedTo: 'c1b, c3a' }, { message: 'Assigned to c3b.' }, { name: 'Synthetic c2a' }, { crewId: 'crew_c1a' }, { by: 'sales.person' }]) {
    assert.match(JSON.stringify(leak), EMPLOYEES, JSON.stringify(leak));
  }
  assert.match('c1a', EMPLOYEES);
});
