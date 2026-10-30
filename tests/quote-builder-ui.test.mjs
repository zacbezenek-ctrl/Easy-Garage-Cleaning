import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { createDocument, storage as memoryStorage } from './helpers/hub-dom.mjs';
import { builderMenu, compositeApproval, menuItemIdentity, priceCompositeQuote } from '../functions/_lib/composite-quote.js';
import { walkthroughPricing, walkthroughServiceItems } from '../functions/_lib/pricing-config.js';
import { junkOnlyGarageWork } from '../functions/_lib/quote-model.js';

// The estimator's walkthrough quote dialog (crew/quote-draft.js) driven through its real DOM code against a fake Hub
// that prices with the server's composite-quote module.
const source = readFileSync(new URL('../crew/quote-draft.js', import.meta.url), 'utf8');
const readJson = path => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const menuDoc = readJson('../functions/_data/pricing-menu.json'), settings = readJson('../functions/_data/pricing-settings.defaults.json');
const baseState = () => ({ menu: menuDoc, settings: structuredClone(settings), walkthrough: walkthroughPricing(walkthroughServiceItems()), approvals: { items: {}, revision: null } });
const shelf = menuDoc.products.find(item => item.id === 'hd-100006678'), mattress = menuDoc.services.find(item => item.name === 'Mattress');
const plan = () => ({ client: { name: 'Synthetic Customer', phone: '+19705550100', email: 'test@example.invalid', address: '100 Fixture Lane', highlevel_contact_id: '' },
  quote: { title: 'EGC Garage Service', estimated_duration_min: 240, line_items: [{ id: 'cleanout', kind: 'service', name: 'Garage cleanout and reset', quantity: 1, unitCents: 90000, totalCents: 90000 }] },
  scope: { garages: '2', loads: '1', special_items: ['Mattress'], access: [], finish: ['cleanout', 'shelving'], hazards: [], finish_details: { shelf_type: 'metal', shelf_qty: 3, tote_qty: 0 } }, raw: {}, logistics: { crew_size: 2 } });
const flush = async () => { for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve)); };
// The estimator's crew on the review step (owner decision 2026-10-30): people x hours on site for the whole crew, priced
// on the server. The Labor input is open until the crew is entered; Adjust opens it again.
const enterCrew = async (h, people, hours) => {
  if (!h.dialog().querySelector('#qb-labor-hours')) h.button('Adjust').click();
  h.dialog().querySelector('#qb-labor-people').dispatchEvent({ type: 'change', target: { value: String(people) } });
  h.dialog().querySelector('#qb-labor-hours').dispatchEvent({ type: 'input', target: { value: String(hours) } });
  h.button('Apply crew and hours').click(); await flush();
};

// hub: {builder} is the Hub's EGC_QUOTE_BUILDER_ENABLED; hint is what the walkthrough's /api/pricing-config answer said.
// walkthroughId is the walkthrough's Hub walkthrough id ('' for a manual walkthrough). datesPending: the send preview is refused
// until the job has a date and a source walkthrough, as the server's 25/75 payment dates are (quote_draft_payment_dates_pending).
function harness({ builder = true, hint = builder, stale = false, stall = false, hub = null, walkthrough = plan, walkthroughId = 'walk-1', datesPending = false, goods = undefined, onGoods = undefined } = {}) {
  const document = createDocument(), calls = [], timers = [];
  const server = hub || { state: baseState(), jobs: new Map(), sent: [] };
  // The 15-second builder timer is held so a test can let it run out.
  const timer = (fn, ms) => { if (ms === 15000) { timers.push(fn); return timers.length; } return setTimeout(fn, ms); };
  const context = { document, Node: document.Node, URLSearchParams, AbortController, setTimeout: timer, clearTimeout, Intl, Date, crypto, console, addEventListener() {}, removeEventListener() {},
    EGCWalkthroughPricing: { quoteBuilder: () => hint } };
  context.window = context;
  vm.runInNewContext(source, context);
  const reply = (body, status = 200) => ({ ok: status < 300, status, json: async () => structuredClone(body) });
  const view = job => ({ id: job.id, revision: job.revision, customerId: 'customer-1', sourceWalkthroughId: job.sourceWalkthroughId || '', estimate: { number: 'EST-JOB1', revision: job.estimateRevision, status: job.status, amountCents: job.priced.totalCents, depositRequiredCents: null, validUntil: '2026-10-31', lineItems: job.priced.lineItems },
    ...(job.priced.compositePricing ? { compositePricing: job.priced.compositePricing, breakdown: job.priced.breakdown } : {}) });
  const fetch = async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ url, body });
    if (url === '/api/quote-draft?view=builder') {
      if (stall) return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted'))));
      return builder ? reply({ ok: true, enabled: true, ...builderMenu(server.state) }) : reply({ ok: false, code: 'quote_draft_invalid_request', error: 'The quote lookup is invalid.' }, 400);
    }
    if (url.startsWith('/api/quote-draft?jobId=')) { const job = server.jobs.get(new URLSearchParams(url.split('?')[1]).get('jobId')); return job ? reply({ ok: true, job: view(job), captureSyncEnabled: false }) : reply({ ok: false, code: 'quote_draft_job_not_found', error: 'Not found.' }, 404); }
    if (url.startsWith('/api/walkthrough-handoff?')) return reply({ ok: true, viewer: { id: 'sales.person' }, sourceRevision: 'w1r', customerId: 'customer-1', jobId: '', expectedRevision: '' });
    if (url === '/api/quote-draft' && body.action === 'composite_preview' && stale) { stale = false; return reply({ ok: false, code: 'quote_draft_composite_version_changed', error: 'Prices changed since the builder opened. Reload the builder and review the current prices before saving.' }, 409); }
    if (url === '/api/quote-draft' && body.action === 'composite_preview') {
      try { const { storedLineItems, ...priced } = priceCompositeQuote(server.state, body.compositePricing); return reply({ ok: true, ...priced }); }
      catch (error) { return reply({ ok: false, code: error.code, error: error.message }, error.status); }
    }
    if (url === '/api/quote-draft' && body.action === 'save' && !body.draft.composite_pricing) {
      // A walkthrough-priced draft: saved as before (the gate is at send).
      const job = { id: 'job-1', revision: 'r1', estimateRevision: 1, status: 'draft', sourceWalkthroughId: body.sourceWalkthroughId, priced: { totalCents: body.draft.line_items.reduce((sum, line) => sum + line.totalCents, 0), lineItems: body.draft.line_items } };
      server.jobs.set(job.id, job);
      return reply({ ok: true, requestId: body.requestId, job: view(job), warnings: [] });
    }
    if (url === '/api/quote-draft' && body.action === 'save') {
      const { storedLineItems, ...priced } = priceCompositeQuote(server.state, body.draft.composite_pricing, { complete: true });
      assert.deepEqual(body.draft.line_items, structuredClone(priced.lineItems), 'the saved lines are the server preview');
      const job = { id: 'job-1', revision: 'r1', estimateRevision: 1, status: 'draft', sourceWalkthroughId: body.sourceWalkthroughId, priced, capture: body.draft.walkthrough_capture };
      server.jobs.set(job.id, job);
      return reply({ ok: true, requestId: body.requestId, job: view(job), warnings: [] });
    }
    if (url === '/api/quote-draft' && body.action === 'send_preview') {
      const job = server.jobs.get(body.jobId);
      if (body.expectedRevision !== job.revision) return reply({ ok: false, code: 'quote_draft_revision_conflict', error: 'This quote changed.' }, 409);
      if (!job.priced.compositePricing && builder) return reply({ ok: false, code: 'quote_draft_builder_required', error: 'With the quote builder on, a walkthrough quote is sent only after it is built in the quote builder.',
        details: { unapproved: [{ id: null, name: 'Walkthrough-priced quote', unitCents: null, reason: 'Its lines were priced from the walkthrough tables, which the owner has not approved for the quote builder.' }] } }, 409);
      // D-JUNK: the server's rule on the saved walkthrough capture (quote-draft.js compositeSendable), before the approvals.
      const work = job.priced.compositePricing ? junkOnlyGarageWork({ quoteDraft: { breakdown: job.priced.breakdown }, jobInstructions: job.capture }) : [];
      if (work.length) return reply({ ok: false, code: 'quote_draft_junk_only_garage_work', error: `This junk-only quote prices the hauling only, but the walkthrough records garage work: ${work.join(', ')}. It stays saved as a draft and was not sent.`, details: { garageWork: work } }, 409);
      const approval = job.priced.compositePricing ? compositeApproval(job.priced.breakdown, server.state) : { ready: true };
      if (!approval.ready) return reply({ ok: false, code: 'quote_draft_composite_prices_unapproved', error: 'This quote has prices the owner has not approved.', details: { unapproved: approval.blocked } }, 409);
      if (datesPending && !(job.date && job.sourceWalkthroughId)) return reply({ ok: false, code: 'quote_draft_payment_dates_pending', error: 'Verified walkthrough/job dates are needed to resolve payment dates.' }, 409);
      return reply({ ok: true, job: view(job), summary: `Send EST-JOB1 revision 1 to Synthetic Customer`, delivery: { mode: 'off' }, confirmToken: 'token-1' });
    }
    if (url === '/api/quote-draft' && body.action === 'send') {
      const job = server.jobs.get(body.jobId);
      if (body.confirmToken !== 'token-1') return reply({ ok: false, code: 'confirm_token_invalid', error: 'Preview again.' }, 409);
      job.status = 'sent'; server.sent.push(body);
      return reply({ ok: true, requestId: body.requestId, job: view(job), delivery: { status: 'messaging_disabled' } });
    }
    return reply({ ok: false, code: 'unexpected', error: `unexpected ${url}` }, 500);
  };
  const dialog = () => document.body.querySelector('dialog');
  const text = () => dialog()?.textContent || '';
  const button = label => dialog().querySelectorAll('button').find(node => node.textContent === label || node.getAttribute('aria-label') === label);
  let savedJobId = '';
  const open = (store = memoryStorage()) => context.EGCQuoteDraft.open({ storage: store, fetch, actor: async () => 'sales.person', uuid: () => crypto.randomUUID(), plan: walkthrough, source: () => walkthroughId, savedJobId: () => savedJobId, draftId: () => 'draft-1', accept: result => { savedJobId = result.job.id; }, now: () => Date.parse('2026-10-17T18:00:00Z'), ...(goods ? { goods } : {}), ...(onGoods ? { onGoods } : {}) });
  const footer = () => dialog().querySelector('.qd-foot').querySelectorAll('button').map(node => node.textContent);
  return { context, document, calls, timers, server, dialog, text, button, footer, open };
}

test('the walkthrough quote opens the guided builder: removal, shelving, extra storage, review; each step is priced by the server in order', async () => {
  const h = harness();
  h.open();
  assert.match(h.text(), /Loading the quote builder/);
  await flush();
  assert.match(h.text(), /Build the itemized quote/);
  assert.match(h.text(), /1 Removal \/ cleanout2 Shelving3 Extra storage4 Review/);
  assert.match(h.text(), /Garage cleaning base/);
  assert.match(h.text(), /historical full-service base, which already included hauling/);
  assert.match(h.text(), /Running total\$1,070\.00/, 'pre-filled from the walkthrough: one truck and one mattress ($1,070.00; no base with truck loads)');
  // D-JUNK: a truck load and its special item are junk-only: $1,000 per truck covers the crew's time, so no Labor line.
  assert.match(h.text(), /No Labor line: junk only/);
  assert.doesNotMatch(h.text(), /man-hours/);
  assert.ok(h.dialog().querySelectorAll('input[type="radio"]').some(input => input.checked && input.parentNode.textContent.startsWith('No cleaning base')));
  assert.doesNotMatch(h.text(), /itemized quote instead/, 'no way around the builder while it is on');
  h.button('Continue to shelving').click(); await flush();
  assert.deepEqual(h.calls.at(-1).body.compositePricing.steps, ['removal'], 'the server prices the finished removal step only');
  assert.match(h.text(), /Shelving units/);
  assert.match(h.text(), /Walkthrough note: 3 metal shelving units\./, 'the walkthrough count is a reminder, not a guessed product');
  assert.match(h.text(), /Installing them is billed through the Labor line on the review step\./);
  h.button(`Add ${shelf.name}`).click();
  // Shelving is garage work: the Labor line comes back, priced once the estimator enters the crew on the review step
  // (owner decision 2026-10-30: people x hours on site); the builder shows no time estimate.
  assert.match(h.text(), /Running total\$1,185\.70/, 'the shelving unit, before its labor');
  assert.match(h.text(), /· Labor: set on the review step/);
  h.button('Continue to extra storage').click(); await flush();
  assert.deepEqual(h.calls.at(-1).body.compositePricing.steps, ['removal', 'shelving']);
  assert.match(h.text(), /All storage groups/);
  h.button('Review quote').click(); await flush();
  assert.deepEqual(h.calls.at(-1).body.compositePricing.steps, ['removal', 'shelving', 'storage']);
  assert.match(h.text(), /Removal \/ cleanout · \$1,070\.00/);
  // The Labor input: the crew, people x hours on site; until it is entered the quote is priced without labor and cannot
  // be saved. No time estimate is shown or sent.
  assert.equal('labor' in h.calls.at(-1).body.compositePricing, false);
  assert.match(h.text(), /Labor · enter the crew and hours/);
  assert.match(h.text(), /Quote total before Labor \$1,185\.70/);
  assert.doesNotMatch(h.text(), /Estimate:|crew time|Pre-filled/);
  assert.ok(h.button('Save draft').hasAttribute('disabled'), 'no Labor line yet: nothing to save');
  assert.equal(h.dialog().querySelector('#qb-labor-people').querySelectorAll('option').find(option => option.hasAttribute('selected')).value, '2', 'the people start at the walkthrough crew');
  assert.equal(h.dialog().querySelector('#qb-labor-people').querySelectorAll('option').length, 6, 'one to six people');
  // 3 people x 1 hour on site: 3 man-hours x the owner's rate. The estimator sees the crew, the man-hours and the rate
  // (staff) in Estimator detail; the customer's line reads "Labor" and its amount.
  await enterCrew(h, 3, 1);
  assert.deepEqual(h.calls.at(-1).body.compositePricing.labor, { manHours: 3, adjusted: true, fullness: null, people: 3, hours: 1 });
  assert.match(h.text(), /Labor · \$159\.00/);
  assert.match(h.text(), /3 people × 1 hour on site = 3 man-hours × \$53\.00 = \$159\.00 Approved rate/);
  assert.ok(h.button('Adjust'));
  assert.match(h.text(), /Quote total \$1,344\.70/);
  assert.match(h.text(), /cannot be sent until the owner approves these 2 draft prices/);
  assert.match(h.text(), /Mattress: draft price \$70\.00, not yet approved by the owner\./);
  assert.doesNotMatch(h.text(), /installation is not priced/, 'installation is billed through labor, so it never blocks the send');
  assert.match(h.text(), /What to buy or grab \(1 products\)/);
  h.button('Save draft').click(); await flush();
  const save = h.calls.find(call => call.body?.action === 'save');
  assert.ok(save.body.draft.composite_pricing, 'the builder selection is saved with the lines');
  assert.match(save.body.draft.scope, /^Removal \/ cleanout: Full truck load; Mattress\. Shelving: HDX plastic shelving/);
  assert.deepEqual(save.body.draft.line_items.map(line => line.id), ['removal-junk-full', 'removal-special', 'shelving-goods', 'labor']);
  assert.deepEqual(save.body.draft.composite_pricing.labor, { manHours: 3, adjusted: true, fullness: null, people: 3, hours: 1 }, 'the saved selection keeps the crew and its man-hours');
  // D-LABOR-TEXT: the customer's scope and Labor line name no man-hours, rate or hourly billing.
  assert.match(save.body.draft.scope, /\. Labor\.$/);
  assert.deepEqual([save.body.draft.line_items.at(-1).name, save.body.draft.line_items.at(-1).description, save.body.draft.line_items.at(-1).totalCents], ['Labor', 'Includes installing the shelving and storage.', 15900]);
  assert.doesNotMatch(JSON.stringify([save.body.draft.scope, save.body.draft.line_items]), /man-hour|per hour|hourly|\$40\.00|\$53\.00/i);
  // Saved, then the send preview is refused for the draft prices: the dialog says why and keeps the draft.
  assert.match(h.text(), /Draft EST-JOB1 revision 1 saved\./);
  assert.match(h.text(), /Sending is blocked until the owner approves these 2 prices/);
  assert.match(h.text(), /choose Send saved quote once they are approved/);
  assert.ok(h.button('Done'));
});

test('a held quote is sent after the owner approves it, from a reopened dialog that lost its device state', async () => {
  const h = harness();
  h.open(); await flush();
  h.button('Continue to shelving').click(); await flush();
  h.button(`Add ${shelf.name}`).click();
  h.button('Continue to extra storage').click(); await flush();
  h.button('Review quote').click(); await flush();
  await enterCrew(h, 3, 1);
  h.button('Save draft').click(); await flush();
  assert.match(h.text(), /Sending is blocked/);
  h.button('Done').click();
  // The owner approves the draft prices (no installation answer is needed: labor bills it); the phone dropped the tab
  // (sessionStorage is gone).
  const state = h.server.state;
  state.approvals = { revision: 'a1', items: { [mattress.id]: { unitCents: 7000, identity: menuItemIdentity(mattress) }, [shelf.id]: { unitCents: 11570, identity: menuItemIdentity(shelf) } } };
  const before = h.calls.length;
  h.open(memoryStorage()); await flush();
  assert.ok(h.calls.slice(before).some(call => call.url === '/api/quote-draft?jobId=job-1'), 'the saved quote job is read once');
  assert.match(h.text(), /Quote EST-JOB1 revision 1 is saved as a draft and has not been sent\./);
  assert.match(h.text(), /Shelving · \$115\.70/);
  assert.match(h.text(), /Labor · \$159\.00Includes installing the shelving and storage\.Estimator detail3 people × 1 hour on site = 3 man-hours × \$53\.00 = \$159\.00/, 'the saved quote shows its Labor row');
  assert.match(h.text(), /Quote total \$1,344\.70/);
  h.button('Send saved quote').click(); await flush();
  assert.equal(h.calls.at(-1).body.action, 'send_preview');
  assert.deepEqual([h.calls.at(-1).body.jobId, h.calls.at(-1).body.expectedRevision], ['job-1', 'r1']);
  assert.match(h.text(), /Send EST-JOB1 revision 1 to Synthetic Customer/);
  h.button('Mark as sent').click(); await flush();
  assert.equal(h.server.sent.length, 1);
  assert.match(h.text(), /EST-JOB1 revision 1 is marked sent/);
});

test('editing a saved builder quote starts from its saved selection, not the walkthrough capture', async () => {
  const h = harness();
  h.open(); await flush();
  h.button('Continue to shelving').click(); await flush();
  h.button(`Add ${shelf.name}`).click();
  h.button('Continue to extra storage').click(); await flush();
  h.button('Review quote').click(); await flush();
  await enterCrew(h, 3, 1);
  h.button('Save draft').click(); await flush();
  h.button('Done').click();
  h.open(memoryStorage()); await flush();
  h.button('Edit quote').click();
  assert.match(h.text(), /Running total\$1,344\.70/, 'the saved shelving and crew are part of the selection again');
  assert.ok(h.button('Saved quote'), 'the saved quote stays one step back');
});

// The time estimate is gone from the builder (owner decision 2026-10-30): whatever the garage work, the review asks for the
// crew (people x hours on site) and names no estimate, and a junk-only quote still asks for none (D-JUNK).
test('the review asks for the crew whatever the garage work and names no time estimate; a junk-only quote asks for none', async () => {
  const tote = menuDoc.products.find(item => item.group === 'bins-totes' && item.section === 'storage');
  const review = async ({ pick = [], shelving = [], storage = [] } = {}) => {
    const h = harness();
    h.open(); await flush();
    for (const name of pick) h.dialog().querySelectorAll('label').find(node => node.textContent.startsWith(name)).querySelector('input').dispatchEvent({ type: 'change', target: { checked: true } });
    h.button('Continue to shelving').click(); await flush();
    for (const item of shelving) h.button(`Add ${item.name}`).click();
    h.button('Continue to extra storage').click(); await flush();
    for (const item of storage) h.button(`Add ${item.name}`).click();
    h.button('Review quote').click(); await flush();
    const row = h.dialog().querySelector('.qb-labor');
    return [row.getAttribute('data-labor'), Boolean(row.querySelector('#qb-labor-hours')), /Estimate|crew time|set-up|Pre-filled/.test(row.textContent)];
  };
  assert.deepEqual(await review({ shelving: [shelf] }), ['needed', true, false]);
  assert.deepEqual(await review({ pick: ['Two-car garage base'] }), ['needed', true, false]);
  assert.deepEqual(await review({ pick: ['Two-car garage base', 'Deep clean'], shelving: [shelf], storage: [tote] }), ['needed', true, false]);
  assert.deepEqual(await review({ pick: ['Mouse trapping'], storage: [tote] }), ['needed', true, false]);
  assert.deepEqual(await review(), ['none', false, false], 'the truck load and the mattress: junk only');
});

test('a refused step stays put with the server reason; rules the server enforces are also shown on the step', async () => {
  const h = harness({ stale: true });
  h.open(); await flush();
  // A pressure wash needs a one-car garage: on this two-car walkthrough with no base the checkbox is disabled.
  const wash = h.dialog().querySelectorAll('label').find(node => node.textContent.startsWith('Pressure washing, one-car'));
  assert.ok(wash.querySelector('input').hasAttribute('disabled'));
  assert.match(wash.textContent, /One-car garage only\./);
  // Choosing a base keeps one base selected and re-totals.
  h.dialog().querySelectorAll('label').find(node => node.textContent.startsWith('Three-car garage base')).querySelector('input').dispatchEvent({ type: 'change', target: { checked: true } });
  assert.match(h.text(), /Running total\$2,345\.00/, 'a cleaning base is garage work: its labor is priced once the crew is entered');
  assert.equal(h.dialog().querySelectorAll('input[type="radio"]').filter(input => input.checked && input.name === 'qb-base').length, 1);
  h.button('Continue to shelving').click(); await flush();
  assert.match(h.text(), /Garage cleaning base/, 'still on the removal step');
  assert.match(h.text(), /Prices changed since the builder opened/);
  h.button('Reload current prices').click(); await flush();
  assert.equal(h.calls.filter(call => call.url === '/api/quote-draft?view=builder').length, 2);
  assert.doesNotMatch(h.text(), /Prices changed/);
  assert.match(h.text(), /Running total\$2,345\.00/, 'the selection survives the reload');
  h.button('Continue to shelving').click(); await flush();
  assert.match(h.text(), /Shelving units/);
});

test('a one-car walkthrough with truck loads keeps its pressure wash and deep clean, sized by the walkthrough garage', async () => {
  const oneCar = () => { const p = plan(); p.scope = { ...p.scope, garages: '1', special_items: [], finish: ['cleanout', 'pressure_wash', 'deep_clean'], finish_details: {} }; return p; };
  const h = harness({ walkthrough: oneCar });
  h.open(); await flush();
  const label = name => h.dialog().querySelectorAll('label').find(node => node.textContent.startsWith(name));
  const wash = () => label('Pressure washing, one-car'), deep = () => label('Deep clean');
  assert.ok(wash().querySelector('input').checked, 'the Finish step\'s pressure wash is carried over with the truck load');
  assert.equal(wash().querySelector('input').hasAttribute('disabled'), false);
  assert.ok(deep().querySelector('input').checked);
  assert.equal(deep().querySelector('input').hasAttribute('disabled'), false, 'the deep clean can be unchecked without a base');
  assert.match(deep().textContent, /Sized to the walkthrough’s 1-car garage\./);
  assert.match(deep().textContent, /\$190\.00/, 'the one-car deep clean');
  h.button('Continue to shelving').click(); await flush();
  const step = h.calls.at(-1).body.compositePricing;
  assert.equal(step.garageSize, '1', 'the step names the walkthrough garage');
  assert.deepEqual(step.removal.map(row => row.id).sort(), ['egc-006', 'egc-007', 'egc-026']);
  assert.match(h.text(), /Shelving units/, 'the server accepted the one-car pressure wash with a truck load');
  h.button('Back').click();
  // A two-car base sizes the add-ons instead: the wash is dropped and the deep clean follows the base.
  label('Two-car garage base').querySelector('input').dispatchEvent({ type: 'change', target: { checked: true } });
  assert.equal(wash().querySelector('input').checked, false);
  assert.ok(wash().querySelector('input').hasAttribute('disabled'));
  assert.match(deep().textContent, /Sized to the garage cleaning base\.[\s\S]*\$330\.00/);
  // No base again: the deep clean goes back to the walkthrough's garage size.
  label('No cleaning base').querySelector('input').dispatchEvent({ type: 'change', target: { checked: true } });
  assert.match(deep().textContent, /Sized to the walkthrough’s 1-car garage\.[\s\S]*\$190\.00/);
  wash().querySelector('input').dispatchEvent({ type: 'change', target: { checked: true } });
  assert.ok(wash().querySelector('input').checked);
});

test('a quote built before the walkthrough garage size changed opens with its add-ons sized to the walkthrough garage', async () => {
  // LANE catalog review: a two-car walkthrough whose device still holds a quote built for a one-car garage with a truck load
  // (one-car pressure wash and deep clean): the server would refuse both for the signed two-car garage, so the builder
  // opens with the two-car deep clean and without the wash, and the labor follows the estimate.
  const store = memoryStorage(), h = harness();
  store.setItem('egc-quote-builder-v1:sales.person:walk-1', JSON.stringify({ selection: { removal: { 'egc-026': 1, 'egc-006': 1, 'egc-007': 1 }, shelving: [], storage: [], labor: { manHours: 4, adjusted: false } } }));
  h.open(store); await flush();
  const label = name => h.dialog().querySelectorAll('label').find(node => node.textContent.startsWith(name));
  assert.equal(label('Pressure washing, one-car').querySelector('input').checked, false);
  assert.ok(label('Pressure washing, one-car').querySelector('input').hasAttribute('disabled'), 'not on a two-car garage');
  assert.ok(label('Deep clean').querySelector('input').checked);
  assert.match(label('Deep clean').textContent, /Sized to the walkthrough’s 2-car garage\.[\s\S]*\$330\.00/);
  h.button('Continue to shelving').click(); await flush();
  const step = h.calls.at(-1).body.compositePricing;
  assert.deepEqual([step.garageSize, step.removal.map(row => row.id).sort(), step.labor], ['2', ['egc-008', 'egc-026'], undefined]);
  assert.match(h.text(), /Shelving units/, 'the server accepts it');
  // A selection with a cleaning base is sized by the base, as the server checks it; no known size changes nothing.
  const { fitGarage } = h.context.EGCQuoteDraft.builder, menu = builderMenu(baseState());
  const based = { removal: { 'egc-002': 1, 'egc-006': 1, 'egc-007': 1 } };
  assert.equal(fitGarage(menu, based, '3'), false);
  assert.deepEqual(Object.keys(based.removal), ['egc-002', 'egc-006', 'egc-007']);
  const loads = { removal: { 'egc-026': 1, 'egc-008': 1 } };
  assert.equal(fitGarage(menu, loads, null), false);
  assert.equal(fitGarage(menu, loads, 'other'), true);
  assert.deepEqual(Object.keys(loads.removal), ['egc-026', 'egc-010']);
  assert.equal(fitGarage(menu, loads, 'other'), false, 'already sized');
});

test('product rows show their size inline, their fit notes one tap away, and never link out to the retailer', async () => {
  const h = harness();
  h.open(); await flush();
  h.button('Continue to shelving').click(); await flush();
  const rows = () => h.dialog().querySelectorAll('li').filter(node => node.className.startsWith('qb-product'));
  assert.ok(rows().length >= 10);
  assert.equal(h.dialog().querySelectorAll('a').length, 0, 'no product page link, no new tab');
  assert.doesNotMatch(h.text(), /Product page|homedepot\.com|Fit and sourcing notes/);
  const row = rows().find(node => node.textContent.includes(shelf.name));
  // LANE catalog review: the size is in the row; the fit notes are in a closed disclosure, not read out on every row.
  assert.equal(row.querySelector('.qb-size').textContent, '36 W × 72 H × 24 D in', 'the size is in the row');
  const notes = row.querySelector('details.qb-fit');
  assert.equal(notes.hasAttribute('open'), false);
  assert.equal(notes.querySelector('summary').textContent, 'Fit notes');
  assert.match(notes.querySelector('p').textContent, /36 W × 72 H × 24 D in; 14\.86 in fixed shelf spacing/);
  assert.match(row.textContent, /\$115\.70 per pack/, 'EGC\'s price only');
  // Sourcing remarks about the retailer's price stay out of the row.
  const { fitText } = h.context.EGCQuoteDraft.builder;
  assert.equal(fitText('Price from Home Depot listing checked 2026-10-16. Hardware included. 6.3 W × 8.66 H in'), 'Hardware included. 6.3 W × 8.66 H in');
  assert.equal(fitText('One kit services ONE 48-in rail. Do not divide kit price by 15 to price rail installations.'), 'One kit services ONE 48-in rail.');
  assert.equal(fitText('Public retail estimate only, not EGC invoice cost or verified local price/stock. No bulk discount assumed. Site/mounting review required.'), 'Site/mounting review required.');
  assert.equal(fitText(''), '');
  // Long notes end at a sentence within 600 characters, never mid-sentence.
  const long = Array.from({ length: 30 }, (_, i) => `Fit note number ${i} is about the bracket spacing.`).join(' ');
  assert.ok(fitText(long).length <= 600 && fitText(long).endsWith('spacing.'), fitText(long).slice(-40));
  assert.equal(fitText('x'.repeat(700)), `${'x'.repeat(599)}\u2026`, 'one sentence longer than that is cut with an ellipsis');
  h.button('Continue to extra storage').click(); await flush();
  assert.equal(h.dialog().querySelectorAll('a').length, 0);
});

// LANE catalog: the walkthrough's Finish step picks the builder's own shelving and storage (crew/gameplan-catalog.js); the
// builder opens with them already chosen and writes back what it saves, so nothing is picked twice. Changes not saved stay
// in the builder: the walkthrough (and the homeowner's signature) keeps the quote it has (review finding).
test('the builder opens with the shelving and storage picked on the walkthrough and writes back only what it saves', async () => {
  const tote = menuDoc.products.find(item => item.group === 'bins-totes'), mirrored = [];
  let picks = { shelving: [{ id: shelf.id, quantity: 2 }], storage: [{ id: tote.id, quantity: 1 }, { id: 'hd-unknown', quantity: 3 }] };
  const h = harness({ goods: () => picks, onGoods: goods => mirrored.push(structuredClone(goods)) });
  h.open(); await flush();
  // Two shelving units (2 hours to install) and a tote pack on top of the truck and mattress, priced from the open.
  assert.match(h.text(), /Shelving \$231\.40 · Storage \$51\.90/);
  assert.deepEqual(mirrored, [], 'opening writes nothing back');
  h.button('Continue to shelving').click(); await flush();
  assert.match(h.text(), /In this quote \(1\)/);
  assert.equal(h.dialog().querySelectorAll('output').find(node => node.parentNode.getAttribute('aria-label') === `${shelf.name} quantity`).textContent, '2');
  h.button(`One more: ${shelf.name}`).click();
  h.button(`One fewer: ${shelf.name}`).click();
  h.button(`One more: ${shelf.name}`).click();
  assert.deepEqual(mirrored, [], 'a change not saved is not written back');
  h.button('Continue to extra storage').click(); await flush();
  assert.match(h.text(), /In this quote \(1\)/);
  h.button('Review quote').click(); await flush();
  assert.deepEqual(mirrored, []);
  await enterCrew(h, 2, 2);
  h.button('Save draft').click(); await flush();
  const saved = h.calls.find(call => call.body?.action === 'save').body.draft.composite_pricing;
  assert.deepEqual([saved.shelving, saved.storage], [[{ id: shelf.id, quantity: 3 }], [{ id: tote.id, quantity: 1 }]]);
  assert.deepEqual(mirrored, [{ shelving: [{ id: shelf.id, quantity: 3, group: 'shelving', name: shelf.name, installPersonMinutes: 60 }], storage: [{ id: tote.id, quantity: 1, group: 'bins-totes', name: tote.name, installPersonMinutes: 32 }] }], 'the saved goods go back once, an unknown product dropped');
  h.button('Done').click();
  // Finish changed again after the save: the saved quote says so, and Edit quote opens with the new picks.
  picks = { shelving: [{ id: shelf.id, quantity: 1 }], storage: [] };
  h.open(memoryStorage()); await flush();
  assert.match(h.text(), /The shelving, totes and storage chosen on the walkthrough’s Finish step are not the ones in this saved quote\./);
  h.button('Edit quote').click();
  assert.match(h.text(), /Shelving \$115\.70 · Storage \$0\.00/);
  h.button('Continue to shelving').click(); await flush();
  assert.equal(h.dialog().querySelectorAll('output').find(node => node.parentNode.getAttribute('aria-label') === `${shelf.name} quantity`).textContent, '1');
  // Changes made in the builder and not saved are the builder's, not Finish's: reopened, the saved quote blames no Finish pick.
  for (const label of ['Back', 'Saved quote', 'Close']) h.button(label).click();
  picks = null;
  const kept = memoryStorage();
  kept.setItem('egc-quote-builder-v1:sales.person:walk-1', JSON.stringify({ selection: { removal: Object.fromEntries(saved.removal.map(row => [row.id, row.quantity])), shelving: [{ id: shelf.id, quantity: 5 }], storage: [], labor: { manHours: null, adjusted: false } } }));
  h.open(kept); await flush();
  assert.match(h.text(), /is saved as a draft and has not been sent\./);
  assert.doesNotMatch(h.text(), /Finish step/);
  assert.equal(mirrored.length, 1, 'still only the one save written back');
});

test('without Finish picks the builder keeps its own selection and tells the walkthrough what it saves', async () => {
  const mirrored = [];
  const h = harness({ goods: () => null, onGoods: goods => mirrored.push(structuredClone(goods)) });
  h.open(); await flush();
  assert.deepEqual(mirrored, []);
  assert.match(h.text(), /Shelving \$0\.00 · Storage \$0\.00/);
  h.button('Continue to shelving').click(); await flush();
  assert.match(h.text(), /Walkthrough note: 3 metal shelving units\./);
  h.button(`Add ${shelf.name}`).click();
  assert.deepEqual(mirrored, []);
  for (const label of ['Continue to extra storage', 'Review quote']) { h.button(label).click(); await flush(); }
  await enterCrew(h, 2, 1.5);
  h.button('Save draft').click(); await flush();
  assert.deepEqual(mirrored.at(-1).shelving.map(row => [row.id, row.quantity, row.group]), [[shelf.id, 1, 'shelving']]);
  // A walkthrough whose goods hook throws keeps the builder working.
  const broken = harness({ goods: () => { throw new Error('unreadable'); } });
  broken.open(); await flush();
  assert.match(broken.text(), /Running total\$1,070\.00/);
});

test('with the builder off the walkthrough quote is reviewed exactly as before, with no builder request', async () => {
  const h = harness({ builder: false });
  h.open(); await flush();
  assert.match(h.text(), /Send options for review/);
  assert.match(h.text(), /Save this quote as an unsigned draft on the Hub job/);
  assert.match(h.text(), /Garage cleanout and reset\$900\.00/);
  assert.doesNotMatch(h.text(), /Removal \/ cleanout|Loading the quote builder/);
  assert.deepEqual(h.calls.map(call => call.url), [], 'the dialog renders at once and asks the Hub nothing until the person saves');
  // A device whose saved hint is stale (the flag was turned off since) asks once, gets "off" and reviews as before.
  const stale = harness({ builder: false, hint: true });
  stale.open(); await flush();
  assert.match(stale.text(), /Save this quote as an unsigned draft on the Hub job/);
  assert.deepEqual(stale.calls.map(call => call.url), ['/api/quote-draft?view=builder']);
});

test('a stalled builder request gives up after its time limit with a retry, and never hides an unconfirmed save', async () => {
  const h = harness({ stall: true });
  h.open(); await flush();
  assert.match(h.text(), /Loading the quote builder/);
  assert.equal(h.timers.length, 1, 'the builder request has its own short time limit');
  h.timers.shift()(); await flush();
  assert.match(h.text(), /The quote builder could not load\. The server did not answer/);
  assert.doesNotMatch(h.text(), /Save this quote as an unsigned draft/, 'no walkthrough-priced quote while the builder is on');
  assert.ok(h.button('Retry'));
  // An earlier save whose answer was lost is shown at once, even while the builder request is stalled.
  const frozen = harness({ stall: true }), store = memoryStorage();
  const draft = { client: { name: 'Synthetic Customer', phone: '+19705550100', email: '', address: '100 Fixture Lane', highlevel_contact_id: '' }, title: 'EGC Garage Service', scope: 'Included: x.',
    line_items: [{ id: 'removal-junk-full', kind: 'service', name: 'Junk removal: full truck load', quantity: 1, unitCents: 75000, totalCents: 75000 }], valid_until: '2026-10-31' };
  store.setItem('egc-quote-draft-v1:sales.person:walk-1', JSON.stringify({ actor: 'sales.person', source: 'walk-1', requestId: crypto.randomUUID(), resolveRequestId: crypto.randomUUID(), draft, body: { action: 'save', draft }, result: null }));
  frozen.open(store); await flush();
  assert.match(frozen.text(), /An earlier save of this quote was not confirmed/);
  assert.ok(frozen.button('Retry original save'));
});

test('a walkthrough-priced draft saved while the builder is on is held, and the dialog opens the builder for it', async () => {
  // This page loaded its prices before the builder was turned on (no hint): the walkthrough's own quote is saved.
  const h = harness({ hint: false });
  h.open(); await flush();
  assert.match(h.text(), /Save this quote as an unsigned draft/);
  h.button('Save draft').click(); await flush();
  assert.equal(h.calls.find(call => call.body?.action === 'save').body.draft.composite_pricing, undefined);
  assert.match(h.text(), /Sending is blocked: with the quote builder on, this quote must be built in the builder before it is sent\./);
  assert.match(h.text(), /priced from the walkthrough tables/);
  h.button('Open the quote builder').click(); await flush();
  assert.match(h.text(), /Build the itemized quote/);
  assert.match(h.text(), /1 Removal \/ cleanout/);
  assert.match(h.text(), /Running total\$1,070\.00/, 'built from the walkthrough capture: junk only, no Labor line');
});

// D12 with the owner decision of 2026-10-30: the Labor input on the review step is the crew, people (1 to 6) x hours on
// site for the whole crew, priced by the server at the owner's rate; Adjust changes it, and the saved draft keeps it.
// toReview enters a crew of 3 for an hour (3 man-hours, $159.00), the quote most tests build.
const toReview = async (h, crew = [3, 1]) => {
  h.open(); await flush();
  h.button('Continue to shelving').click(); await flush();
  h.button(`Add ${shelf.name}`).click();
  h.button('Continue to extra storage').click(); await flush();
  h.button('Review quote').click(); await flush();
  if (crew) await enterCrew(h, ...crew);
};
const typeInto = (h, id, value) => h.dialog().querySelector(`#${id}`).dispatchEvent({ type: 'input', target: { value } });
const previews = h => h.calls.filter(call => call.body?.action === 'composite_preview');

test('the Labor input: people × hours on site for the whole crew, priced on the server; Adjust changes it and Cancel keeps it', async () => {
  const h = harness();
  await toReview(h, null);
  assert.equal('labor' in previews(h).at(-1).body.compositePricing, false, 'no crew yet: priced without labor');
  assert.doesNotMatch(JSON.stringify(previews(h).at(-1).body), /rateCents|crewSize|onSiteMinutes/, 'neither the rate nor a time estimate is ever sent');
  assert.ok(h.button('Save draft').hasAttribute('disabled'), 'nothing is saved before the crew is entered');
  assert.equal(h.button('Cancel'), undefined, 'the input stays open until the crew is entered');
  // Hours that are not quarter hours are refused in the row; nothing is priced.
  const before = previews(h).length;
  typeInto(h, 'qb-labor-hours', '2.1');
  assert.match(h.dialog().querySelector('.qb-labor-result').textContent, /Enter the hours on site in quarter hours \(people × hours: 0\.5 to 200 man-hours\)\./);
  h.button('Apply crew and hours').click(); await flush();
  assert.match(h.text(), /Enter the hours on site in quarter hours \(like 3 or 3\.25\); people × hours must come to 0\.5 to 200 man-hours\./);
  assert.equal(previews(h).length, before);
  // 3 people x 3.5 hours on site = 10.5 man-hours x $53.00 = $556.50.
  h.dialog().querySelector('#qb-labor-people').dispatchEvent({ type: 'change', target: { value: '3' } });
  typeInto(h, 'qb-labor-hours', '3.5');
  assert.equal(h.dialog().querySelector('.qb-labor-result').textContent, '= 10.5 man-hours × $53.00 = $556.50');
  h.button('Apply crew and hours').click(); await flush();
  assert.deepEqual(previews(h).at(-1).body.compositePricing.labor, { manHours: 10.5, adjusted: true, fullness: null, people: 3, hours: 3.5 });
  assert.match(h.text(), /Labor · \$556\.50Includes installing the shelving and storage\.Estimator detail3 people × 3\.5 hours on site = 10\.5 man-hours × \$53\.00 = \$556\.50/);
  assert.match(h.text(), /Quote total \$1,742\.20/);
  assert.equal(h.button('Save draft').hasAttribute('disabled'), false);
  // Adjust: 6 people (the most) x 1.25 hours = 7.5 man-hours; the input opens at the crew on the quote.
  h.button('Adjust').click();
  assert.equal(h.dialog().querySelector('#qb-labor-hours').value, '3.5', 'the input starts at the crew on the quote');
  assert.ok(h.button('Save draft').hasAttribute('disabled'), 'nothing is saved while a labor change is open');
  await enterCrew(h, 6, 1.25);
  assert.equal(previews(h).at(-1).body.compositePricing.labor.manHours, 7.5);
  assert.match(h.text(), /6 people × 1\.25 hours on site = 7\.5 man-hours × \$53\.00 = \$397\.50/);
  // Cancel leaves the priced labor as it was.
  h.button('Adjust').click();
  typeInto(h, 'qb-labor-hours', '99');
  h.button('Cancel').click();
  assert.match(h.text(), /Labor · \$397\.50/);
});

test('a saved draft keeps the estimator\'s crew: the saved view shows it in Estimator detail and Edit quote reopens it', async () => {
  const h = harness();
  await toReview(h, [2, 4.75]);
  h.button('Save draft').click(); await flush();
  const save = h.calls.find(call => call.body?.action === 'save');
  assert.deepEqual(save.body.draft.composite_pricing.labor, { manHours: 9.5, adjusted: true, fullness: null, people: 2, hours: 4.75 });
  // The customer's line is one amount (D-LABOR-TEXT); the estimator's crew and man-hours stay in the selection and the views below.
  assert.deepEqual(save.body.draft.line_items.at(-1), { id: 'labor', kind: 'labor', name: 'Labor', description: 'Includes installing the shelving and storage.', quantity: 1, unitCents: 50350, totalCents: 50350, amount: 503.5, optional: false, selected: true, group: null, tier: null, package: null, catalog: null, customerSupplied: false, taxable: false });
  h.button('Done').click();
  h.open(memoryStorage()); await flush();
  assert.match(h.text(), /Labor · \$503\.50Includes installing the shelving and storage\.Estimator detail2 people × 4\.75 hours on site = 9\.5 man-hours × \$53\.00 = \$503\.50/);
  h.button('Edit quote').click();
  assert.match(h.text(), /· Labor \$503\.50/, 'the running total keeps the saved crew');
  // A scope change keeps the crew: it is the estimator's own entry.
  h.button('One more: Mattress').click();
  assert.match(h.text(), /· Labor \$503\.50/);
  h.button('Continue to shelving').click(); await flush();
  h.button('Continue to extra storage').click(); await flush();
  h.button('Review quote').click(); await flush();
  assert.deepEqual(previews(h).at(-1).body.compositePricing.labor, { manHours: 9.5, adjusted: true, fullness: null, people: 2, hours: 4.75 }, 'the reopened quote prices the saved crew');
  assert.ok(h.button('Adjust'));
});

test('without the server\'s time model the estimator enters the crew the same way before the quote can be saved', async () => {
  // A Hub whose walkthrough time model is unavailable: the menu carries no time model and the server no estimate.
  const state = baseState(), untimed = { ...state, walkthrough: { ...state.walkthrough, minutes: undefined } };
  const h = harness({ hub: { state: untimed, jobs: new Map(), sent: [] } });
  h.open(); await flush();
  assert.match(h.text(), /Running total\$1,070\.00/);
  assert.match(h.text(), /No Labor line: junk only/);
  h.button('Continue to shelving').click(); await flush();
  h.button(`Add ${shelf.name}`).click();
  assert.match(h.text(), /Labor: set on the review step/);
  h.button('Continue to extra storage').click(); await flush();
  h.button('Review quote').click(); await flush();
  assert.equal('labor' in previews(h).at(-1).body.compositePricing, false);
  assert.match(h.text(), /Labor · enter the crew and hours/);
  assert.match(h.text(), /cannot be sent until the owner approves these 2 draft prices:Mattress: draft price/, 'the owner notice lists the menu prices only');
  assert.doesNotMatch(h.text(), /owner approves[^:]*:[^.]*(man-hours|crew)/, 'the missing crew is the estimator\'s to enter, not the owner\'s to approve');
  assert.ok(h.button('Save draft').hasAttribute('disabled'));
  await enterCrew(h, 1, 5);
  assert.deepEqual(previews(h).at(-1).body.compositePricing.labor, { manHours: 5, adjusted: true, fullness: null, people: 1, hours: 5 });
  assert.match(h.text(), /1 person × 5 hours on site = 5 man-hours × \$53\.00 = \$265\.00/);
  assert.match(h.text(), /Quote total \$1,450\.70/);
  assert.equal(h.button('Save draft').hasAttribute('disabled'), false);
  h.button('Save draft').click(); await flush();
  assert.equal(h.calls.find(call => call.body?.action === 'save').body.draft.composite_pricing.labor.manHours, 5);
});

const closeDialog = h => h.dialog().dispatchEvent({ type: 'cancel', preventDefault() {} });
const approveAll = (state, items, extra = {}) => { state.approvals = { revision: 'a1', ...extra, items: Object.fromEntries(items.map(([item, unitCents]) => [item.id, { unitCents, identity: menuItemIdentity(item) }])) }; };

// flow-7: the crew of a saved quote is what was saved, on the device that saved it and on any other; the walkthrough's
// fullness changing later never moves it (there is no estimate to follow).
test('a saved quote reopens at its saved crew on this device and any other, whatever the walkthrough says later', async () => {
  let fullness = null;
  const walkthrough = () => { const p = plan(); if (fullness) p.scope.fullness = fullness; return p; };
  const h = harness({ walkthrough }), device = memoryStorage();
  const chooseTwoCar = () => h.dialog().querySelectorAll('label').find(node => node.textContent.startsWith('Two-car garage base')).querySelector('input').dispatchEvent({ type: 'change', target: { checked: true } });
  h.open(device); await flush();
  chooseTwoCar();
  h.button('Continue to shelving').click(); await flush();
  h.button(`Add ${shelf.name}`).click();
  h.button('Continue to extra storage').click(); await flush();
  h.button('Review quote').click(); await flush();
  await enterCrew(h, 2, 2);
  h.button('Save draft').click(); await flush();
  assert.deepEqual(h.calls.find(call => call.body?.action === 'save').body.draft.composite_pricing.labor, { manHours: 4, adjusted: true, fullness: null, people: 2, hours: 2 });
  h.button('Done').click();
  // The walkthrough now says the garage is packed: the crew stays the estimator's.
  fullness = 'Packed';
  for (const [store, label] of [[device, 'the saving device'], [memoryStorage(), 'another device']]) {
    h.open(store); await flush();
    assert.match(h.text(), /Labor · \$212\.00Includes installing the shelving and storage\.Estimator detail2 people × 2 hours on site = 4 man-hours × \$53\.00 = \$212\.00/, label);
    h.button('Edit quote').click();
    assert.match(h.text(), /· Labor \$212\.00/, `${label}: the running total keeps the saved crew`);
    h.button('Continue to shelving').click(); await flush();
    h.button('Continue to extra storage').click(); await flush();
    h.button('Review quote').click(); await flush();
    assert.deepEqual(previews(h).at(-1).body.compositePricing.labor, { manHours: 4, adjusted: true, fullness: 'packed', people: 2, hours: 2 }, `${label}: the saved crew`);
    assert.doesNotMatch(h.text(), /estimate/i, `${label}: no estimate is named`);
    closeDialog(h);
  }
});

// flow-6: a send refused only for the Labor line is the estimator's to fix (save it again), not a wait for the owner.
test('a saved quote held only for its labor rate says to edit and save it again, opens the builder, and sends at the new rate', async () => {
  const h = harness();
  await toReview(h);
  h.button('Save draft').click(); await flush();
  assert.match(h.text(), /Sending is blocked until the owner approves these 2 prices/);
  h.button('Done').click();
  // The owner approves both draft prices and sets the labor rate to $45.00.
  approveAll(h.server.state, [[mattress, 7000], [shelf, 11570]], { laborRatePerManHourCents: 4500 });
  h.open(memoryStorage()); await flush();
  assert.match(h.text(), /The labor rate is now \$45\.00 per man-hour, but this quote has \$53\.00\. Edit the quote and save it again before sending it\./, 'the saved view warns before Send');
  h.button('Send saved quote').click(); await flush();
  assert.match(h.text(), /Sending is blocked until you edit this quote and save it again:/);
  assert.match(h.text(), /The labor rate is now \$45\.00 per man-hour, but this quote has \$53\.00\./);
  assert.match(h.text(), /no owner approval is needed for this/);
  assert.doesNotMatch(h.text(), /Sending is blocked until the owner approves/);
  assert.ok(h.button('Done'));
  h.button('Edit quote').click();
  assert.match(h.text(), /· Labor \$135\.00/, 'the builder prices the saved 3 man-hours at the new rate');
  h.button('Continue to shelving').click(); await flush();
  h.button('Continue to extra storage').click(); await flush();
  h.button('Review quote').click(); await flush();
  assert.match(h.text(), /3 man-hours × \$45\.00 = \$135\.00/);
  assert.match(h.text(), /Every price on this quote is owner-approved/);
  h.button('Save draft').click(); await flush();
  assert.match(h.text(), /Send EST-JOB1 revision 1 to Synthetic Customer/, 'saved at the new rate, it goes to the send confirmation');
});

// Owner decision 2026-10-21: the full truck went from $750 to $1,000. A draft saved at $750 and not sent is held at send
// as the estimator's to fix (save it again at the approved price), never as a wait for the owner, whose price it is.
test('a draft saved under the $750 truck and sent under the $1,000 truck says to edit and save it again, then sends at $1,000', async () => {
  const h = harness(), menuAt750 = structuredClone(menuDoc);
  menuAt750.services.find(item => item.basis?.kind === 'junk' && item.basis.fraction === 1).approvedPriceCents = 75000;
  h.server.state.menu = menuAt750;
  approveAll(h.server.state, [[mattress, 7000], [shelf, 11570]]);
  await toReview(h);
  assert.match(h.text(), /Every price on this quote is owner-approved/);
  h.button('Save draft').click(); await flush();
  assert.equal(h.calls.find(call => call.body?.action === 'save').body.draft.line_items.find(line => line.id === 'removal-junk-full').unitCents, 75000);
  assert.match(h.text(), /Send EST-JOB1 revision 1 to Synthetic Customer/);
  closeDialog(h);
  // The owner's menu now has the $1,000 truck: the saved $750 draft is not sent.
  h.server.state.menu = menuDoc;
  h.open(memoryStorage()); await flush();
  h.button('Send saved quote').click(); await flush();
  assert.match(h.text(), /Sending is blocked until you edit this quote and save it again:/);
  assert.match(h.text(), /The owner approved \$1,000\.00 for Full truck load, but this quote has \$750\.00\. Save the quote again to use the approved price\./);
  assert.match(h.text(), /no owner approval is needed for this/);
  assert.doesNotMatch(h.text(), /Sending is blocked until the owner approves/);
  assert.equal(h.server.sent.length, 0);
  assert.deepEqual(h.footer(), ['Done', 'Edit quote']);
  h.button('Edit quote').click();
  h.button('Continue to shelving').click(); await flush();
  h.button('Continue to extra storage').click(); await flush();
  h.button('Review quote').click(); await flush();
  assert.match(h.text(), /Every price on this quote is owner-approved/);
  h.button('Save draft').click(); await flush();
  assert.equal(h.calls.filter(call => call.body?.action === 'save').at(-1).body.draft.line_items.find(line => line.id === 'removal-junk-full').unitCents, 100000);
  assert.match(h.text(), /Send EST-JOB1 revision 1 to Synthetic Customer/, 'saved at $1,000, it goes to the send confirmation');
});

// A held quote with both kinds: the owner's draft price waits for the owner, the changed truck price is the estimator's.
test('a $750 draft that also has a draft price says the owner approves the draft price and the estimator re-saves the changed truck price', async () => {
  const h = harness(), menuAt750 = structuredClone(menuDoc);
  menuAt750.services.find(item => item.basis?.kind === 'junk' && item.basis.fraction === 1).approvedPriceCents = 75000;
  h.server.state.menu = menuAt750;
  approveAll(h.server.state, [[shelf, 11570]]);
  await toReview(h);
  h.button('Save draft').click(); await flush();
  assert.match(h.text(), /Sending is blocked until the owner approves this price/, 'only the mattress waits at $750');
  h.button('Done').click();
  h.server.state.menu = menuDoc;
  h.open(memoryStorage()); await flush();
  h.button('Send saved quote').click(); await flush();
  assert.match(h.text(), /Sending is blocked until the owner approves the draft prices below and you save the quote again:/);
  assert.match(h.text(), /The owner approved \$1,000\.00 for Full truck load, but this quote has \$750\.00\./);
  assert.match(h.text(), /A price the owner changed since this quote was saved \(and any Labor or installation reason\) is yours to fix, with no owner approval needed: choose Edit quote/);
  assert.deepEqual(h.footer(), ['Done', 'Edit quote']);
});

// money-1 / flow-2 with the crew entry (owner decision 2026-10-30): the server's estimate has no install time for most
// storage goods, but the crew the estimator enters by hand covers installing them, so a new quote with them is sent once
// its prices are approved. A quote saved earlier with man-hours pre-filled from the estimate leaves their installation
// out: it is held until the estimator edits it and enters the crew.
test('goods with no install time: the crew entered by hand covers them; a quote saved with pre-filled man-hours is held until the crew is entered', async () => {
  const h = harness(), state = h.server.state, escaped = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rack = menuDoc.products.find(item => item.group === 'overhead'), rackCents = builderMenu(baseState()).products.find(item => item.id === rack.id).unitCents;
  approveAll(state, [[mattress, 7000], [shelf, 11570], [rack, rackCents]]);
  h.open(); await flush();
  h.button('Continue to shelving').click(); await flush();
  h.button(`Add ${shelf.name}`).click();
  h.button('Continue to extra storage').click(); await flush();
  h.dialog().querySelector('select').dispatchEvent({ type: 'change', target: { value: 'overhead' } });
  h.button(`Add ${rack.name}`).click();
  h.button('Review quote').click(); await flush();
  await enterCrew(h, 2, 3);
  assert.doesNotMatch(h.text(), /install time|leave out installing/);
  assert.match(h.text(), /Every price on this quote is owner-approved/);
  h.button('Save draft').click(); await flush();
  assert.match(h.text(), /Send EST-JOB1 revision 1 to Synthetic Customer/, 'the crew covers installing the rack');
  closeDialog(h);
  // The same quote as it was saved before the crew entry: man-hours pre-filled from the estimate, which has no install
  // time for the rack.
  const job = h.server.jobs.get('job-1'), { storedLineItems, ...earlier } = priceCompositeQuote(state, { ...job.priced.compositePricing, labor: { manHours: null, adjusted: false, fullness: null } }, { complete: true });
  job.priced = earlier;
  h.open(memoryStorage()); await flush();
  assert.match(h.text(), new RegExp(`The saved man-hours leave out installing ${escaped(rack.name)}\\. Edit the quote and enter the crew and hours before sending it\\.`));
  h.button('Send saved quote').click(); await flush();
  assert.match(h.text(), /Sending is blocked until you edit this quote and save it again:/);
  assert.match(h.text(), /the pre-filled man-hours do not include installing it/);
  h.button('Edit quote').click();
  h.button('Continue to shelving').click(); await flush();
  h.button('Continue to extra storage').click(); await flush();
  h.button('Review quote').click(); await flush();
  assert.match(h.text(), new RegExp(`The saved man-hours leave out installing: ${escaped(rack.name)}\\.Choose Adjust and enter the crew and hours, installation included\\. Until you do, this quote can be saved but not sent\\.`));
  assert.doesNotMatch(h.text(), /cannot be sent until the owner approves/, 'nothing waits for the owner: the crew is the estimator\'s');
  await enterCrew(h, 2, 3);
  assert.deepEqual(previews(h).at(-1).body.compositePricing.labor, { manHours: 6, adjusted: true, fullness: null, people: 2, hours: 3 });
  assert.doesNotMatch(h.text(), /leave out installing/);
  assert.match(h.text(), /Every price on this quote is owner-approved/);
  h.button('Save draft').click(); await flush();
  assert.match(h.text(), /Send EST-JOB1 revision 1 to Synthetic Customer/);
});

// D-JUNK (owner, 2026-10-18: the truck price covers the crew's time; $1,000 per truck since 2026-10-21): a junk-only quote has no Labor line at all.
test('a junk-only quote is reviewed, saved and reopened with no Labor line: the truck price covers the crew\'s time', async () => {
  const h = harness();
  h.open(); await flush();
  assert.match(h.text(), /Running total\$1,070\.00/);
  assert.match(h.text(), /No Labor line: junk only/);
  h.button('Continue to shelving').click(); await flush();
  h.button('Continue to extra storage').click(); await flush();
  h.button('Review quote').click(); await flush();
  assert.equal('labor' in previews(h).at(-1).body.compositePricing, false, 'a junk-only quote sends no labor');
  assert.match(h.text(), /Labor · noneJunk-only quote: the truck-load price covers the crew’s time to load, haul and dispose, so this quote has no Labor line\./);
  assert.match(h.text(), /Quote total \$1,070\.00/);
  assert.doesNotMatch(h.text(), /man-hour/);
  // The walkthrough sold three shelving units: a junk-only quote prices none of them, and the homeowner cannot sign it there.
  assert.match(h.text(), /The walkthrough records garage work this junk-only quote does not price: 3 shelving units\. The homeowner cannot sign it, and it cannot be sent, on that walkthrough\./);
  assert.equal(h.button('Save draft').hasAttribute('disabled'), false, 'no man-hours to apply: it can be saved');
  h.button('Save draft').click(); await flush();
  const save = h.calls.find(call => call.body?.action === 'save');
  assert.deepEqual([save.body.draft.line_items.map(line => line.id), 'labor' in save.body.draft.composite_pricing], [['removal-junk-full', 'removal-special'], false]);
  assert.doesNotMatch(save.body.draft.scope, /Labor/);
  assert.equal(save.body.draft.scope, 'Junk removal only: Full truck load; Mattress. Loading, hauling and disposal; no sorting, organizing or reset.');
  // The walkthrough's shelving holds it before the mattress's draft price does: that is the estimator's to fix now.
  assert.match(h.text(), /Sending is blocked until you edit this quote and save it again:.*the walkthrough records garage work: 3 shelving units\./);
  assert.match(h.text(), /The saved draft is kept; no owner approval is needed for this\./);
  assert.deepEqual(h.footer(), ['Done', 'Edit quote']);
  h.button('Done').click();
  h.open(memoryStorage()); await flush();
  assert.match(h.text(), /Junk-only quote: the truck-load price covers the crew’s time, so it has no Labor line\.The walkthrough records garage work this junk-only quote does not price: 3 shelving units\./);
  assert.doesNotMatch(h.text(), /no Labor line yet/);
  // Adding garage work brings the Labor line back: the review asks for the crew.
  h.button('Edit quote').click();
  h.button('Continue to shelving').click(); await flush();
  h.button(`Add ${shelf.name}`).click();
  assert.match(h.text(), /· Labor: set on the review step/);
});

// D-JUNK: a junk-only quote is never sent on a walkthrough that records garage work (the server refuses the send preview,
// quote_draft_junk_only_garage_work): the review says so, the saved draft is held for the estimator to fix, and once the
// walkthrough says junk removal only and the quote is saved again, it is sent.
test('a junk-only quote on a walkthrough that records crew sorting is saved but held; corrected and saved again, it is sent', async () => {
  let walkthrough = { ...plan(), scope: { ...plan().scope, loads: '2', special_items: [], sort_method: 'zones', finish: ['cleanout'], finish_details: { ...plan().scope.finish_details, shelf_qty: 0 } } };
  const h = harness({ walkthrough: () => walkthrough });
  h.open(); await flush();
  assert.match(h.text(), /Running total\$2,000\.00/);
  h.button('Continue to shelving').click(); await flush();
  h.button('Continue to extra storage').click(); await flush();
  h.button('Review quote').click(); await flush();
  assert.match(h.text(), /records garage work this junk-only quote does not price: sorting into keep \/ donate \/ haul zones and resetting what stays\. The homeowner cannot sign it, and it cannot be sent, on that walkthrough\./);
  assert.match(h.text(), /Every price on this quote is owner-approved, but it cannot be sent while the walkthrough records garage work it does not price \(see above\)\. You can save it as a draft\./);
  assert.doesNotMatch(h.text(), /so it can be sent after you save it/);
  h.button('Save draft').click(); await flush();
  const first = h.calls.find(call => call.body?.action === 'save');
  assert.deepEqual([first.body.draft.walkthrough_capture.sortMethod, first.body.draft.walkthrough_capture.shelfQty, first.body.draft.walkthrough_capture.toteQty], ['zones', 0, 0], 'the capture carries the sorting plan and the Finish counts');
  assert.match(h.text(), /Sending is blocked until you edit this quote and save it again:.*sorting into keep \/ donate \/ haul zones and resetting what stays/);
  assert.match(h.text(), /It stays saved as a draft and was not sent\.The saved draft is kept; no owner approval is needed for this\./);
  assert.doesNotMatch(h.text(), /check the Labor line/);
  assert.deepEqual(h.footer(), ['Done', 'Edit quote']);
  assert.equal(h.server.sent.length, 0);
  h.button('Done').click();
  // The homeowner wants junk removal only: the walkthrough says Everything goes. The saved draft still carries the old
  // capture, so Send saved quote is held the same way until the quote is saved again.
  walkthrough = { ...walkthrough, scope: { ...walkthrough.scope, sort_method: 'remove_all' } };
  h.open(memoryStorage()); await flush();
  assert.doesNotMatch(h.text(), /records garage work/);
  h.button('Send saved quote').click(); await flush();
  assert.match(h.text(), /Sending is blocked until you edit this quote and save it again:/);
  h.button('Edit quote').click();
  h.button('Continue to shelving').click(); await flush();
  h.button('Continue to extra storage').click(); await flush();
  h.button('Review quote').click(); await flush();
  assert.match(h.text(), /Every price on this quote is owner-approved, so it can be sent after you save it\./);
  h.button('Save draft').click(); await flush();
  assert.equal(h.calls.filter(call => call.body?.action === 'save').at(-1).body.draft.walkthrough_capture.sortMethod, 'remove_all');
  assert.match(h.text(), /Send EST-JOB1 revision 1 to Synthetic Customer/);
  h.button('Mark as sent').click(); await flush();
  assert.equal(h.server.sent.length, 1);
});

// D-JUNK / D-LABOR-TEXT: a quote saved under the morning's Labor rules (its estimate counted truck-load time, its line
// named the man-hours) says so before Send, and reopens on the new estimate unless its man-hours were set by hand.
test('a quote saved under the earlier Labor rules says so, is held for a re-save, and reopens without its pre-filled man-hours', async () => {
  const h = harness(), device = memoryStorage();
  approveAll(h.server.state, [[mattress, 7000], [shelf, 11570]]);
  h.open(device); await flush();
  h.button('Continue to shelving').click(); await flush();
  h.button(`Add ${shelf.name}`).click();
  h.button('Continue to extra storage').click(); await flush();
  h.button('Review quote').click(); await flush();
  await enterCrew(h, 3, 1);
  h.button('Save draft').click(); await flush();
  assert.match(h.text(), /Send EST-JOB1 revision 1 to Synthetic Customer/);
  closeDialog(h);
  // The same job as the morning's code saved it: 7.5 man-hours pre-filled from the estimate that counted the truck load
  // (not set by hand, no crew).
  const job = h.server.jobs.get('job-1'), labor = job.priced.breakdown.labor, line = job.priced.lineItems.at(-1);
  delete labor.version; delete labor.people; delete labor.hours;
  Object.assign(labor, { manHours: 7.5, prefilledManHours: 7.5, adjusted: false, rateCents: 4000, totalCents: 30000 });
  job.priced.compositePricing.labor = { manHours: 7.5, adjusted: false, fullness: null };
  Object.assign(line, { name: 'Labor: 7.5 man-hours × $40.00', description: 'Crew time on site, billed per man-hour, including installing the shelving and storage.', unitCents: 30000, totalCents: 30000, amount: 300 });
  job.priced.totalCents += 30000 - 15900;
  // The saving device still holds the crew the estimator entered (set by hand, kept); another device has only the
  // morning's pre-filled man-hours, which are dropped so the estimator enters the crew.
  for (const [store, running] of [[device, /· Labor \$159\.00/], [memoryStorage(), /· Labor: set on the review step/]]) {
    h.open(store); await flush();
    assert.match(h.text(), /This Labor line was priced before the owner’s Labor decisions of 2026-10-18 \(its estimate counted truck-load time, and the customer would see the man-hours\)\. Edit the quote and save it again before sending it\./);
    h.button('Send saved quote').click(); await flush();
    assert.match(h.text(), /Sending is blocked until you edit this quote and save it again:/);
    assert.match(h.text(), /saved before the owner's Labor decisions of 2026-10-18/);
    h.button('Edit quote').click();
    assert.match(h.text(), running, 'the morning\'s pre-filled man-hours never come back');
    closeDialog(h);
  }
});

// A sent quote's 25% deposit is due when the customer approves it and its 75% balance on the job day
// (quote-payment-policy.js SENT_25_75), and a new quote job has no date, so its send preview is refused
// (quote_draft_payment_dates_pending). The quote stays saved and the dialog says what happens next; saving it again never
// adds a date, so Save draft is never the next step.
// A junk-removal-only walkthrough (a truck load, no special items, no finish options): a junk-only quote is sent on it (D-JUNK).
const truckOnly = () => ({ ...plan(), scope: { ...plan().scope, special_items: [], finish: ['cleanout'], finish_details: { ...plan().scope.finish_details, shelf_qty: 0 } } });
const toSavedTruck = async h => {
  h.open(); await flush();
  h.button('Continue to shelving').click(); await flush();
  h.button('Continue to extra storage').click(); await flush();
  h.button('Review quote').click(); await flush();
  assert.match(h.text(), /Every price on this quote is owner-approved/, 'nothing waits for the owner: only the dates');
  h.button('Save draft').click(); await flush();
};
const waitsWithoutDeadEnd = h => {
  assert.deepEqual(h.footer(), ['Done'], 'one button: nothing to save or retry');
  assert.doesNotMatch(h.text(), /save it again|Verified walkthrough\/job dates/i, 'no re-save advice and no raw refusal');
  assert.equal(h.dialog().querySelector('.qd-error'), null, 'no red alert');
};

test('a quote from a Hub walkthrough is saved and waits for its job date; Send saved quote says the same until the office books the job', async () => {
  const h = harness({ walkthrough: truckOnly, datesPending: true });
  await toSavedTruck(h);
  assert.equal(h.calls.at(-1).body.action, 'send_preview');
  assert.match(h.text(), /Draft EST-JOB1 revision 1 saved\.Sending waits for the job date: the 25% deposit is due when the customer approves the quote, and the remaining 75% when the job is complete\.Ask the office to book this job in Team schedule \(To schedule\)\. Then reopen this quote from the walkthrough and choose Send saved quote\./);
  waitsWithoutDeadEnd(h);
  h.button('Done').click();
  // Reopened before the job is booked: Send saved quote shows the same wait, never the edit-and-save advice.
  h.open(memoryStorage()); await flush();
  h.button('Send saved quote').click(); await flush();
  assert.match(h.text(), /Quote EST-JOB1 revision 1 stays saved as a draft\.Sending waits for the job date/);
  waitsWithoutDeadEnd(h);
  h.button('Done').click();
  // The office books the job in Team schedule: the saved quote is previewed and sent as it is, never saved again.
  h.server.jobs.get('job-1').date = '2026-10-21';
  h.open(memoryStorage()); await flush();
  h.button('Send saved quote').click(); await flush();
  assert.match(h.text(), /Send EST-JOB1 revision 1 to Synthetic Customer/);
  h.button('Mark as sent').click(); await flush();
  assert.equal(h.server.sent.length, 1);
  assert.equal(h.calls.filter(call => call.body?.action === 'save').length, 1);
});

test('a quote from a manual walkthrough is saved but cannot be sent for review: the dialog points to the signature or a Hub-booked walkthrough', async () => {
  const h = harness({ walkthrough: truckOnly, datesPending: true, walkthroughId: '' });
  await toSavedTruck(h);
  assert.equal(h.calls.find(call => call.body?.action === 'save').body.sourceWalkthroughId, '', 'a manual walkthrough has no Hub walkthrough');
  assert.match(h.text(), /Draft EST-JOB1 revision 1 saved\.A quote from a manual walkthrough can’t be sent for review: a quote is sent only from a walkthrough booked in the Hub\.Get the homeowner’s signature on the walkthrough’s Review step and choose Save brief \+ schedule, or ask the office to book a walkthrough for this customer in the Hub and quote from that walkthrough\./);
  assert.doesNotMatch(h.text(), /Team schedule|Send saved quote/, 'booking this job does not make it a Hub walkthrough quote');
  waitsWithoutDeadEnd(h);
  h.button('Done').click();
  // Even with a job date it has no Hub walkthrough: Send saved quote says the same.
  h.server.jobs.get('job-1').date = '2026-10-21';
  h.open(memoryStorage()); await flush();
  h.button('Send saved quote').click(); await flush();
  assert.match(h.text(), /Quote EST-JOB1 revision 1 stays saved as a draft\.A quote from a manual walkthrough can’t be sent for review/);
  waitsWithoutDeadEnd(h);
  assert.equal(h.server.sent.length, 0);
});

test('with the builder off, a walkthrough quote waiting for its job date says to send it from the walkthrough once the job is booked', async () => {
  const h = harness({ builder: false, datesPending: true });
  h.open(); await flush();
  h.button('Save draft').click(); await flush();
  assert.match(h.text(), /Draft EST-JOB1 revision 1 saved\.Sending waits for the job date: the 25% deposit is due when the customer approves the quote, and the remaining 75% when the job is complete\.Ask the office to book this job in Team schedule \(To schedule\)\. Then open Send options for review on the walkthrough again to send it\./);
  waitsWithoutDeadEnd(h);
});

test('a catalog quote held for its payment dates says it needs a Hub-booked walkthrough, with no walkthrough step to follow', async () => {
  const h = harness({ builder: false });
  const job = { id: 'job-9', revision: 'r1', customerId: 'customer-1', sourceWalkthroughId: '', estimate: { number: 'EST-JOB9', revision: 1, status: 'draft', amountCents: 50000, lineItems: [] } };
  const client = { pendingSave: async () => null, pendingSend: async () => null, clear() {}, save: async draft => ({ result: { job, warnings: [] }, retrying: false, draft }),
    preview: async () => { throw Object.assign(new Error('Verified walkthrough/job dates are needed to resolve payment dates.'), { status: 409, code: 'quote_draft_payment_dates_pending' }); } };
  h.context.EGCQuoteDraft.open({ client, variant: 'catalog', title: 'Review catalog quote', kicker: 'Products & installation', now: () => Date.parse('2026-10-17T18:00:00Z'),
    draft: validUntil => ({ client: { name: 'Synthetic Customer', phone: '+19705550100', email: '', address: '100 Fixture Lane', highlevel_contact_id: '' }, title: 'Catalog quote', scope: 'Included: shelving.', line_items: [{ id: 'catalog-1', kind: 'product', name: 'Shelving unit', quantity: 1, unitCents: 50000, totalCents: 50000 }], valid_until: validUntil }) });
  await flush();
  h.button('Save draft').click(); await flush();
  assert.match(h.text(), /Draft EST-JOB9 revision 1 saved\.A catalog quote can’t be sent for review: a quote is sent only from a walkthrough booked in the Hub, once the job date is booked\.Quote this customer from a walkthrough booked in the Hub instead\./);
  assert.doesNotMatch(h.text(), /Save brief \+ schedule|Team schedule/);
  waitsWithoutDeadEnd(h);
});

// D-LABOR-TEXT on the estimator's own screens: the builder is worked at the customer's garage, often with the homeowner
// looking. What it shows without a tap reads Labor the way the customer's quote does, as one amount; the crew, the
// man-hours and the rate stay with the estimator in a closed "Estimator detail" (open only while this dialog is open).
// shown(): the text on screen without opening anything (a closed <details> shows its summary only).
const shown = node => node.nodeType === 3 ? node.textContent : node.tagName === 'DETAILS' && !node.hasAttribute('open') ? node.children.filter(child => child.tagName === 'SUMMARY').map(shown).join('') : node.childNodes.map(shown).join('');
const HOURLY = /man-hour|\$53\.00|per hour|hourly|\d hours?\b|\d people\b|\d person\b/i;
test('the builder shows Labor as one amount; the crew, the man-hours and the rate stay in a closed Estimator detail that is never kept open', async () => {
  const h = harness(), device = memoryStorage(), screen = () => shown(h.dialog());
  h.open(device); await flush();
  h.button('Continue to shelving').click(); await flush();
  assert.match(screen(), /Installing them is billed through the Labor line on the review step\./);
  h.button(`Add ${shelf.name}`).click();
  assert.match(screen(), /Running total\$1,185\.70Removal \$1,070\.00 · Shelving \$115\.70 · Storage \$0\.00 · Labor: set on the review step ·/);
  assert.doesNotMatch(screen(), HOURLY, 'the shelving step and its running total');
  h.button('Continue to extra storage').click(); await flush();
  assert.doesNotMatch(screen(), HOURLY, 'the storage step');
  h.button('Review quote').click(); await flush();
  await enterCrew(h, 3, 1);
  assert.match(screen(), /Labor · \$159\.00Includes installing the shelving and storage\.Estimator detail/);
  assert.doesNotMatch(screen(), HOURLY, 'the review step');
  assert.ok(h.button('Adjust'), 'the estimator keeps the crew control');
  assert.equal(h.button('Reset to estimate'), undefined, 'no time estimate to go back to');
  const detail = () => h.dialog().querySelector('details.qb-estimator');
  assert.equal(detail().hasAttribute('open'), false, 'closed by default');
  assert.match(detail().textContent, /^Estimator detail3 people × 1 hour on site = 3 man-hours × \$53\.00 = \$159\.00 Approved rate/);
  // Opened, it stays open while the estimator changes the crew; the result is priced on the server.
  detail().dispatchEvent({ type: 'toggle', target: { open: true } });
  await enterCrew(h, 4, 1);
  assert.equal(detail().hasAttribute('open'), true, 'kept open across the redraw');
  assert.match(screen(), /4 people × 1 hour on site = 4 man-hours × \$53\.00 = \$212\.00/);
  // Saved and opened again: the saved quote shows one amount, and Estimator detail is closed again (never kept open).
  h.button('Save draft').click(); await flush();
  h.button('Done').click();
  h.open(device); await flush();
  assert.match(screen(), /Labor · \$212\.00Includes installing the shelving and storage\.Estimator detail/);
  assert.doesNotMatch(screen(), HOURLY, 'the saved quote');
  assert.equal(detail().hasAttribute('open'), false);
  assert.match(detail().textContent, /4 people × 1 hour on site = 4 man-hours × \$53\.00 = \$212\.00/);
  h.button('Edit quote').click();
  assert.doesNotMatch(screen(), HOURLY, 'the reopened builder');
  closeDialog(h);
});

// The $250 minimum to come out (owner decision 2026-10-30, every quote): the running total shows the line the server adds,
// so the homeowner never watches one total and signs another; the review shows it once the Labor line is priced.
test('a quote under $250 shows the Minimum to come out in the running total and on the review, as the server prices it', async () => {
  const h = harness();
  h.open(); await flush();
  h.button('One fewer: full truck loads').click();
  assert.match(h.text(), /Running total\$250\.00Removal \$70\.00 · Shelving \$0\.00 · Storage \$0\.00 · Labor: set on the review step · Minimum to come out \$180\.00/);
  h.button('Continue to shelving').click(); await flush();
  h.button('Continue to extra storage').click(); await flush();
  h.button('Review quote').click(); await flush();
  assert.match(h.text(), /Quote total before Labor \$70\.00/);
  assert.doesNotMatch(h.text(), /Minimum to come out ·/, 'the minimum waits for the Labor line');
  await enterCrew(h, 1, 1);
  assert.match(h.text(), /Minimum to come out · \$127\.00Every quote has a \$250 minimum to come out\./);
  assert.match(h.text(), /Quote total \$250\.00/);
  closeDialog(h);
});
