import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { createDocument, storage as memoryStorage } from './helpers/hub-dom.mjs';
import { builderMenu, compositeApproval, menuItemIdentity, priceCompositeQuote } from '../functions/_lib/composite-quote.js';
import { walkthroughPricing, walkthroughServiceItems } from '../functions/_lib/pricing-config.js';

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

// hub: {builder} is the Hub's EGC_QUOTE_BUILDER_ENABLED; hint is what the walkthrough's /api/pricing-config answer said.
// walkthroughId is the walkthrough's Hub walkthrough id ('' for a manual walkthrough). datesPending: the send preview is refused
// until the job has a date and a source walkthrough, as the server's 25/75 payment dates are (quote_draft_payment_dates_pending).
function harness({ builder = true, hint = builder, stale = false, stall = false, hub = null, walkthrough = plan, walkthroughId = 'walk-1', datesPending = false } = {}) {
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
      const job = { id: 'job-1', revision: 'r1', estimateRevision: 1, status: 'draft', sourceWalkthroughId: body.sourceWalkthroughId, priced };
      server.jobs.set(job.id, job);
      return reply({ ok: true, requestId: body.requestId, job: view(job), warnings: [] });
    }
    if (url === '/api/quote-draft' && body.action === 'send_preview') {
      const job = server.jobs.get(body.jobId);
      if (body.expectedRevision !== job.revision) return reply({ ok: false, code: 'quote_draft_revision_conflict', error: 'This quote changed.' }, 409);
      if (!job.priced.compositePricing && builder) return reply({ ok: false, code: 'quote_draft_builder_required', error: 'With the quote builder on, a walkthrough quote is sent only after it is built in the quote builder.',
        details: { unapproved: [{ id: null, name: 'Walkthrough-priced quote', unitCents: null, reason: 'Its lines were priced from the walkthrough tables, which the owner has not approved for the quote builder.' }] } }, 409);
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
  const open = (store = memoryStorage()) => context.EGCQuoteDraft.open({ storage: store, fetch, actor: async () => 'sales.person', uuid: () => crypto.randomUUID(), plan: walkthrough, source: () => walkthroughId, savedJobId: () => savedJobId, draftId: () => 'draft-1', accept: result => { savedJobId = result.job.id; }, now: () => Date.parse('2026-10-17T18:00:00Z') });
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
  assert.match(h.text(), /Running total\$1,080\.00/, 'pre-filled from the walkthrough: one truck and one mattress ($820.00; no base with truck loads) and the estimated labor');
  // The server's time model in person-minutes: 2 x (60 base + 90 for the load + 30 default fullness + 15 for the mattress).
  assert.match(h.text(), /Labor \$260\.00 \(6\.5 man-hours\)/, 'the labor is the server\'s estimate of the selection, whatever the crew size');
  assert.ok(h.dialog().querySelectorAll('input[type="radio"]').some(input => input.checked && input.parentNode.textContent.startsWith('No cleaning base')));
  assert.doesNotMatch(h.text(), /itemized quote instead/, 'no way around the builder while it is on');
  h.button('Continue to shelving').click(); await flush();
  assert.deepEqual(h.calls.at(-1).body.compositePricing.steps, ['removal'], 'the server prices the finished removal step only');
  assert.match(h.text(), /Shelving units/);
  assert.match(h.text(), /Walkthrough note: 3 metal shelving units\./, 'the walkthrough count is a reminder, not a guessed product');
  assert.match(h.text(), /Installing them is billed through the Labor line \(man-hours × \$40\.00\) on the review step\./);
  h.button(`Add ${shelf.name}`).click();
  assert.match(h.text(), /Running total\$1,235\.70/, 'the shelving unit adds its install time (an hour) to the estimate');
  h.button('Continue to extra storage').click(); await flush();
  assert.deepEqual(h.calls.at(-1).body.compositePricing.steps, ['removal', 'shelving']);
  assert.match(h.text(), /All storage groups/);
  h.button('Review quote').click(); await flush();
  assert.deepEqual(h.calls.at(-1).body.compositePricing.steps, ['removal', 'shelving', 'storage']);
  assert.match(h.text(), /Removal \/ cleanout · \$820\.00/);
  // The Labor row: the pre-filled man-hours × the owner's rate, where they came from, Adjust and the approved rate.
  assert.match(h.text(), /Labor · \$300\.00/);
  assert.match(h.text(), /7\.5 man-hours × \$40\.00 = \$300\.00 Approved rate/);
  assert.match(h.text(), /Estimate: 7\.5 man-hours of crew time \(removal and cleaning 6\.5 man-hours, installing shelving and storage 1 man-hour\), whatever the crew size\. Pre-filled from the estimate\. Installing the shelving and storage is billed through this line\./);
  assert.ok(h.button('Adjust'));
  assert.equal(h.button('Reset to estimate (7.5 man-hours)'), undefined, 'nothing to reset while the pre-fill is kept');
  assert.match(h.text(), /Quote total \$1,235\.70/);
  assert.match(h.text(), /cannot be sent until the owner approves these 2 draft prices/);
  assert.match(h.text(), /Mattress: draft price \$70\.00, not yet approved by the owner\./);
  assert.doesNotMatch(h.text(), /installation is not priced/, 'installation is billed through labor, so it never blocks the send');
  assert.match(h.text(), /What to buy or grab \(1 products\)/);
  h.button('Save draft').click(); await flush();
  const save = h.calls.find(call => call.body?.action === 'save');
  assert.ok(save.body.draft.composite_pricing, 'the builder selection is saved with the lines');
  assert.match(save.body.draft.scope, /^Removal \/ cleanout: Full truck load; Mattress\. Shelving: HDX plastic shelving/);
  assert.deepEqual(save.body.draft.line_items.map(line => line.id), ['removal-junk-full', 'removal-special', 'shelving-goods', 'labor']);
  assert.deepEqual(save.body.draft.composite_pricing.labor, { manHours: 7.5, adjusted: false, fullness: null }, 'the saved selection keeps the man-hours priced');
  assert.match(save.body.draft.scope, /\. Labor: 7\.5 man-hours\.$/);
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
  assert.match(h.text(), /Labor · \$300\.007\.5 man-hours × \$40\.00 = \$300\.00/, 'the saved quote shows its Labor row');
  assert.match(h.text(), /Quote total \$1,235\.70/);
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
  h.button('Save draft').click(); await flush();
  h.button('Done').click();
  h.open(memoryStorage()); await flush();
  h.button('Edit quote').click();
  assert.match(h.text(), /Running total\$1,235\.70/, 'the saved shelving and labor are part of the selection again');
  assert.ok(h.button('Saved quote'), 'the saved quote stays one step back');
});

test('a refused step stays put with the server reason; rules the server enforces are also shown on the step', async () => {
  const h = harness({ stale: true });
  h.open(); await flush();
  // A pressure wash needs a one-car base: the checkbox is disabled while no one-car base is chosen.
  const wash = h.dialog().querySelectorAll('label').find(node => node.textContent.startsWith('Pressure washing, one-car'));
  assert.ok(wash.querySelector('input').hasAttribute('disabled'));
  assert.match(wash.textContent, /One-car garage base only\./);
  // Choosing a base keeps one base selected and re-totals.
  h.dialog().querySelectorAll('label').find(node => node.textContent.startsWith('Three-car garage base')).querySelector('input').dispatchEvent({ type: 'change', target: { checked: true } });
  assert.match(h.text(), /Running total\$2,355\.00/);
  assert.equal(h.dialog().querySelectorAll('input[type="radio"]').filter(input => input.checked && input.name === 'qb-base').length, 1);
  h.button('Continue to shelving').click(); await flush();
  assert.match(h.text(), /Garage cleaning base/, 'still on the removal step');
  assert.match(h.text(), /Prices changed since the builder opened/);
  h.button('Reload current prices').click(); await flush();
  assert.equal(h.calls.filter(call => call.url === '/api/quote-draft?view=builder').length, 2);
  assert.doesNotMatch(h.text(), /Prices changed/);
  assert.match(h.text(), /Running total\$2,355\.00/, 'the selection survives the reload');
  h.button('Continue to shelving').click(); await flush();
  assert.match(h.text(), /Shelving units/);
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
  assert.match(h.text(), /Running total\$1,080\.00/, 'built from the walkthrough capture, with the estimated labor');
});

// D12: the Labor row on the review step: pre-filled man-hours × the owner's rate, Adjust (total man-hours or people ×
// hours), Reset to estimate, every change priced by the server, and the estimator's value kept on the saved draft.
const toReview = async h => {
  h.open(); await flush();
  h.button('Continue to shelving').click(); await flush();
  h.button(`Add ${shelf.name}`).click();
  h.button('Continue to extra storage').click(); await flush();
  h.button('Review quote').click(); await flush();
};
const typeInto = (h, id, value) => h.dialog().querySelector(`#${id}`).dispatchEvent({ type: 'input', target: { value } });
const previews = h => h.calls.filter(call => call.body?.action === 'composite_preview');

test('the Labor row: Adjust by total man-hours or by people × hours, each priced on the server, then Reset to estimate', async () => {
  const h = harness();
  await toReview(h);
  assert.deepEqual(previews(h).at(-1).body.compositePricing.labor, { manHours: null, adjusted: false, fullness: null }, 'the review asks the server for its own estimate');
  assert.doesNotMatch(JSON.stringify(previews(h).at(-1).body), /rateCents|crewSize|onSiteMinutes/, 'neither the rate nor a time estimate is ever sent');
  h.button('Adjust').click();
  assert.equal(h.dialog().querySelector('#qb-labor-hours').value, '7.5', 'the editor starts at the man-hours on the quote');
  assert.ok(h.button('Save draft').hasAttribute('disabled'), 'nothing is saved while a labor change is open');
  // Total man-hours: a value outside 0.5 to 200 quarter hours is refused in the row; nothing is priced.
  const before = previews(h).length;
  typeInto(h, 'qb-labor-hours', '6.1');
  assert.match(h.dialog().querySelector('.qb-labor-result').textContent, /Enter 0\.5 to 200 man-hours in quarter hours\./);
  h.button('Apply man-hours').click(); await flush();
  assert.match(h.text(), /Enter 0\.5 to 200 man-hours in quarter hours \(like 6 or 6\.25\)\./);
  assert.equal(previews(h).length, before);
  typeInto(h, 'qb-labor-hours', '10.5');
  assert.equal(h.dialog().querySelector('.qb-labor-result').textContent, '= 10.5 man-hours × $40.00 = $420.00');
  h.button('Apply man-hours').click(); await flush();
  assert.deepEqual(previews(h).at(-1).body.compositePricing.labor, { manHours: 10.5, adjusted: true, fullness: null });
  assert.match(h.text(), /Labor · \$420\.0010\.5 man-hours × \$40\.00 = \$420\.00/);
  assert.match(h.text(), /Adjusted by hand from the estimate of 7\.5 man-hours\./);
  assert.match(h.text(), /Quote total \$1,355\.70/);
  assert.equal(h.button('Save draft').hasAttribute('disabled'), false);
  // People × hours: 3 people × 2.5 hours each = 7.5 man-hours.
  h.button('Adjust').click();
  h.dialog().querySelectorAll('input[type="radio"]').find(input => input.parentNode.textContent.includes('By people × hours')).dispatchEvent({ type: 'change', target: { checked: true } });
  h.dialog().querySelector('#qb-labor-people').dispatchEvent({ type: 'change', target: { value: '3' } });
  typeInto(h, 'qb-labor-each', '2.5');
  assert.equal(h.dialog().querySelector('.qb-labor-result').textContent, '= 7.5 man-hours × $40.00 = $300.00');
  h.button('Apply man-hours').click(); await flush();
  assert.equal(previews(h).at(-1).body.compositePricing.labor.manHours, 7.5);
  assert.match(h.text(), /7\.5 man-hours × \$40\.00 = \$300\.00/);
  // 7.5 by hand is the estimate's number but still the estimator's own choice.
  assert.match(h.text(), /Adjusted by hand from the estimate of 7\.5 man-hours\./);
  // Below the estimate, the job shows the owner the estimate (money-1: the owner sees labor cut under the estimate).
  h.button('Adjust').click();
  typeInto(h, 'qb-labor-hours', '4');
  h.button('Apply man-hours').click(); await flush();
  assert.match(h.text(), /Below the estimate: the job shows the owner the estimate of 7\.5 man-hours\./);
  // Reset to the estimate: the pre-fill again.
  h.button('Reset to estimate (7.5 man-hours)').click(); await flush();
  assert.deepEqual(previews(h).at(-1).body.compositePricing.labor, { manHours: null, adjusted: false, fullness: null });
  assert.match(h.text(), /7\.5 man-hours × \$40\.00 = \$300\.00/);
  assert.match(h.text(), /Pre-filled from the estimate\./);
  assert.equal(h.button('Reset to estimate (7.5 man-hours)'), undefined);
  // Cancel leaves the priced labor as it was.
  h.button('Adjust').click();
  typeInto(h, 'qb-labor-hours', '99');
  h.button('Cancel').click();
  assert.match(h.text(), /Labor · \$300\.00/);
});

test('a saved draft keeps the estimator\'s man-hours: the saved view shows them and Edit quote reopens them', async () => {
  const h = harness();
  await toReview(h);
  h.button('Adjust').click();
  typeInto(h, 'qb-labor-hours', '9.25');
  h.button('Apply man-hours').click(); await flush();
  h.button('Save draft').click(); await flush();
  const save = h.calls.find(call => call.body?.action === 'save');
  assert.deepEqual(save.body.draft.composite_pricing.labor, { manHours: 9.25, adjusted: true, fullness: null });
  assert.deepEqual(save.body.draft.line_items.at(-1), { id: 'labor', kind: 'labor', name: 'Labor: 9.25 man-hours × $40.00', description: 'Crew time on site, billed per man-hour, including installing the shelving and storage.', quantity: 1, unitCents: 37000, totalCents: 37000, amount: 370, optional: false, selected: true, group: null, tier: null, package: null, catalog: null, customerSupplied: false, taxable: false });
  h.button('Done').click();
  h.open(memoryStorage()); await flush();
  assert.match(h.text(), /Labor · \$370\.009\.25 man-hours × \$40\.00 = \$370\.00Adjusted by hand from the estimate of 7\.5 man-hours\./);
  h.button('Edit quote').click();
  assert.match(h.text(), /Labor \$370\.00 \(9\.25 man-hours\)/, 'the running total keeps the saved man-hours');
  h.button('Continue to shelving').click(); await flush();
  h.button('Continue to extra storage').click(); await flush();
  h.button('Review quote').click(); await flush();
  assert.equal(previews(h).at(-1).body.compositePricing.labor.manHours, 9.25, 'the reopened quote prices the saved man-hours, not the estimate');
  assert.ok(h.button('Reset to estimate (7.5 man-hours)'));
});

test('no time estimate: the estimator enters the man-hours before the quote can be saved', async () => {
  // A Hub whose walkthrough time model is unavailable: the menu carries no time model and the server no estimate.
  const state = baseState(), untimed = { ...state, walkthrough: { ...state.walkthrough, minutes: undefined } };
  const h = harness({ hub: { state: untimed, jobs: new Map(), sent: [] } });
  h.open(); await flush();
  assert.match(h.text(), /Running total\$820\.00/);
  assert.match(h.text(), /Labor: man-hours on the review step/);
  h.button('Continue to shelving').click(); await flush();
  h.button('Continue to extra storage').click(); await flush();
  h.button('Review quote').click(); await flush();
  assert.deepEqual(previews(h).at(-1).body.compositePricing.labor, { manHours: null, adjusted: false, fullness: null });
  assert.match(h.text(), /Labor · man-hours needed/);
  assert.match(h.text(), /No time estimate is available, so the man-hours are entered by hand\. Enter the estimated man-hours before saving/);
  assert.match(h.text(), /cannot be sent until the owner approves this draft price:Mattress: draft price/, 'the owner notice lists the menu prices only');
  assert.doesNotMatch(h.text(), /owner approves[^:]*:[^.]*man-hours/, 'the missing man-hours are the estimator\'s to enter, not the owner\'s to approve');
  assert.ok(h.button('Save draft').hasAttribute('disabled'));
  assert.equal(h.button('Cancel'), undefined, 'the editor stays open until the man-hours are entered');
  typeInto(h, 'qb-labor-hours', '5');
  h.button('Apply man-hours').click(); await flush();
  assert.deepEqual(previews(h).at(-1).body.compositePricing.labor, { manHours: 5, adjusted: true, fullness: null });
  assert.match(h.text(), /5 man-hours × \$40\.00 = \$200\.00/);
  assert.match(h.text(), /Quote total \$1,020\.00/);
  assert.equal(h.button('Save draft').hasAttribute('disabled'), false);
  h.button('Save draft').click(); await flush();
  assert.equal(h.calls.find(call => call.body?.action === 'save').body.draft.composite_pricing.labor.manHours, 5);
});

const closeDialog = h => h.dialog().dispatchEvent({ type: 'cancel', preventDefault() {} });
const approveAll = (state, items, extra = {}) => { state.approvals = { revision: 'a1', ...extra, items: Object.fromEntries(items.map(([item, unitCents]) => [item.id, { unitCents, identity: menuItemIdentity(item) }])) }; };

// flow-7: the man-hours of a saved quote are what was saved, on the device that saved it and on any other; a later
// estimate is shown next to them and never silently replaces them. A scope change follows the estimate again.
test('a saved pre-filled quote reopens at its saved man-hours on this device and any other, and says when the estimate has moved', async () => {
  let fullness = null;
  const walkthrough = () => { const p = plan(); if (fullness) p.scope.fullness = fullness; return p; };
  const h = harness({ walkthrough }), device = memoryStorage();
  h.open(device); await flush();
  h.button('Continue to shelving').click(); await flush();
  h.button(`Add ${shelf.name}`).click();
  h.button('Continue to extra storage').click(); await flush();
  h.button('Review quote').click(); await flush();
  h.button('Save draft').click(); await flush();
  assert.deepEqual(h.calls.find(call => call.body?.action === 'save').body.draft.composite_pricing.labor, { manHours: 7.5, adjusted: false, fullness: null });
  h.button('Done').click();
  // The walkthrough now says the garage is packed: the estimate grows by 2 x 90 person-minutes to 10.5 man-hours.
  fullness = 'Packed';
  for (const [store, label] of [[device, 'the saving device'], [memoryStorage(), 'another device']]) {
    h.open(store); await flush();
    assert.match(h.text(), /Labor · \$300\.007\.5 man-hours × \$40\.00 = \$300\.00/, label);
    h.button('Edit quote').click();
    assert.match(h.text(), /Labor \$300\.00 \(7\.5 man-hours\)/, `${label}: the running total keeps the saved man-hours`);
    h.button('Continue to shelving').click(); await flush();
    h.button('Continue to extra storage').click(); await flush();
    h.button('Review quote').click(); await flush();
    assert.deepEqual(previews(h).at(-1).body.compositePricing.labor, { manHours: 7.5, adjusted: false, fullness: 'packed' }, `${label}: the saved man-hours, not adjusted by anyone`);
    assert.match(h.text(), /Kept at the saved 7\.5 man-hours: the estimate is now 10\.5 man-hours\./, label);
    assert.doesNotMatch(h.text(), /Adjusted by hand/, `${label}: nobody adjusted them`);
    assert.ok(h.button('Reset to estimate (10.5 man-hours)'), label);
    closeDialog(h);
  }
  // A change to the scope follows the estimate again: one more mattress is 2 x 15 person-minutes more, 11 man-hours.
  h.open(memoryStorage()); await flush();
  h.button('Edit quote').click();
  h.button('One more: Mattress').click();
  assert.match(h.text(), /Labor \$440\.00 \(11 man-hours\)/);
  closeDialog(h);
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
  assert.match(h.text(), /The labor rate is now \$45\.00 per man-hour, but this quote has \$40\.00\. Edit the quote and save it again before sending it\./, 'the saved view warns before Send');
  h.button('Send saved quote').click(); await flush();
  assert.match(h.text(), /Sending is blocked until you edit this quote and save it again:/);
  assert.match(h.text(), /The labor rate is now \$45\.00 per man-hour, but this quote has \$40\.00\./);
  assert.match(h.text(), /no owner approval is needed for this/);
  assert.doesNotMatch(h.text(), /Sending is blocked until the owner approves/);
  assert.ok(h.button('Done'));
  h.button('Edit quote').click();
  assert.match(h.text(), /Labor \$337\.50 \(7\.5 man-hours\)/, 'the builder prices the saved man-hours at the new rate');
  h.button('Continue to shelving').click(); await flush();
  h.button('Continue to extra storage').click(); await flush();
  h.button('Review quote').click(); await flush();
  assert.match(h.text(), /7\.5 man-hours × \$45\.00 = \$337\.50/);
  assert.match(h.text(), /Every price on this quote is owner-approved/);
  h.button('Save draft').click(); await flush();
  assert.match(h.text(), /Send EST-JOB1 revision 1 to Synthetic Customer/, 'saved at the new rate, it goes to the send confirmation');
});

// money-1 / flow-2: the estimate has no install time for most storage goods; the review says which, and the quote is
// sent only once the estimator set the man-hours by hand (or the owner says installation is in the goods price).
test('goods the estimate cannot time are named on the review step, and the quote is sent only after the man-hours are set by hand', async () => {
  const h = harness(), state = h.server.state;
  const rack = menuDoc.products.find(item => item.group === 'overhead'), rackCents = builderMenu(baseState()).products.find(item => item.id === rack.id).unitCents;
  approveAll(state, [[mattress, 7000], [shelf, 11570], [rack, rackCents]]);
  h.open(); await flush();
  h.button('Continue to shelving').click(); await flush();
  h.button(`Add ${shelf.name}`).click();
  h.button('Continue to extra storage').click(); await flush();
  h.dialog().querySelector('select').dispatchEvent({ type: 'change', target: { value: 'overhead' } });
  h.button(`Add ${rack.name}`).click();
  assert.match(h.text(), /Labor \$300\.00 \(7\.5 man-hours\)/, 'the rack adds no install time to the estimate');
  h.button('Review quote').click(); await flush();
  assert.match(h.text(), new RegExp(`The estimate has no install time for: ${rack.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.`));
  assert.match(h.text(), /Adjust the man-hours to include installing them\. Until you do, this quote can be saved but not sent\./);
  assert.doesNotMatch(h.text(), /Every price on this quote is owner-approved/);
  assert.doesNotMatch(h.text(), /cannot be sent until the owner approves/, 'nothing waits for the owner: the man-hours are the estimator\'s');
  h.button('Save draft').click(); await flush();
  assert.match(h.text(), /Sending is blocked until you edit this quote and save it again:/);
  assert.match(h.text(), /the pre-filled man-hours do not include installing it/);
  h.button('Edit quote').click();
  h.button('Continue to shelving').click(); await flush();
  h.button('Continue to extra storage').click(); await flush();
  h.button('Review quote').click(); await flush();
  h.button('Adjust').click();
  typeInto(h, 'qb-labor-hours', '11.5');
  h.button('Apply man-hours').click(); await flush();
  assert.deepEqual(previews(h).at(-1).body.compositePricing.labor, { manHours: 11.5, adjusted: true, fullness: null });
  assert.match(h.text(), /You set the man-hours by hand: make sure they include installing these\./);
  assert.match(h.text(), /Every price on this quote is owner-approved/);
  h.button('Save draft').click(); await flush();
  assert.match(h.text(), /Send EST-JOB1 revision 1 to Synthetic Customer/);
});

// A new quote's 25% deposit and 75% balance are due on dates worked out from its walkthrough date and its job date
// (quote-payment-policy.js FINAL_25_75), and a new quote job has no date, so its send preview is refused
// (quote_draft_payment_dates_pending). The quote stays saved and the dialog says what happens next; saving it again never
// adds a date, so Save draft is never the next step.
const truckOnly = () => ({ ...plan(), scope: { ...plan().scope, special_items: [] } });
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
  assert.match(h.text(), /Draft EST-JOB1 revision 1 saved\.Sending waits for the job date: the 25% deposit and 75% balance due dates come from the walkthrough date and the job date\.Ask the office to book this job in Team schedule \(To schedule\)\. Then reopen this quote from the walkthrough and choose Send saved quote\./);
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
  assert.match(h.text(), /Draft EST-JOB1 revision 1 saved\.A quote from a manual walkthrough can’t be sent for review: its 25% deposit and 75% balance due dates need a walkthrough booked in the Hub\.Get the homeowner’s signature on the walkthrough’s Review step and choose Save brief \+ schedule, or ask the office to book a walkthrough for this customer in the Hub and quote from that walkthrough\./);
  assert.doesNotMatch(h.text(), /Team schedule|Send saved quote/, 'booking this job gives it no walkthrough date');
  waitsWithoutDeadEnd(h);
  h.button('Done').click();
  // Even with a job date there is no walkthrough date: Send saved quote says the same.
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
  assert.match(h.text(), /Draft EST-JOB1 revision 1 saved\.Sending waits for the job date: the 25% deposit and 75% balance due dates come from the walkthrough date and the job date\.Ask the office to book this job in Team schedule \(To schedule\)\. Then open Send options for review on the walkthrough again to send it\./);
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
  assert.match(h.text(), /Draft EST-JOB9 revision 1 saved\.A catalog quote can’t be sent for review: its 25% deposit and 75% balance due dates need a walkthrough booked in the Hub and a job date\.Quote this customer from a walkthrough booked in the Hub instead\./);
  assert.doesNotMatch(h.text(), /Save brief \+ schedule|Team schedule/);
  waitsWithoutDeadEnd(h);
});
