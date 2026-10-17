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
function harness({ builder = true, hint = builder, stale = false, stall = false, hub = null } = {}) {
  const document = createDocument(), calls = [], timers = [];
  const server = hub || { state: baseState(), jobs: new Map(), sent: [] };
  // The 15-second builder timer is held so a test can let it run out.
  const timer = (fn, ms) => { if (ms === 15000) { timers.push(fn); return timers.length; } return setTimeout(fn, ms); };
  const context = { document, Node: document.Node, URLSearchParams, AbortController, setTimeout: timer, clearTimeout, Intl, Date, crypto, console, addEventListener() {}, removeEventListener() {},
    EGCWalkthroughPricing: { quoteBuilder: () => hint } };
  context.window = context;
  vm.runInNewContext(source, context);
  const reply = (body, status = 200) => ({ ok: status < 300, status, json: async () => structuredClone(body) });
  const view = job => ({ id: job.id, revision: job.revision, customerId: 'customer-1', estimate: { number: 'EST-JOB1', revision: job.estimateRevision, status: job.status, amountCents: job.priced.totalCents, depositRequiredCents: null, validUntil: '2026-10-31', lineItems: job.priced.lineItems },
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
      const job = { id: 'job-1', revision: 'r1', estimateRevision: 1, status: 'draft', priced: { totalCents: body.draft.line_items.reduce((sum, line) => sum + line.totalCents, 0), lineItems: body.draft.line_items } };
      server.jobs.set(job.id, job);
      return reply({ ok: true, requestId: body.requestId, job: view(job), warnings: [] });
    }
    if (url === '/api/quote-draft' && body.action === 'save') {
      const { storedLineItems, ...priced } = priceCompositeQuote(server.state, body.draft.composite_pricing, { complete: true });
      assert.deepEqual(body.draft.line_items, structuredClone(priced.lineItems), 'the saved lines are the server preview');
      const job = { id: 'job-1', revision: 'r1', estimateRevision: 1, status: 'draft', priced };
      server.jobs.set(job.id, job);
      return reply({ ok: true, requestId: body.requestId, job: view(job), warnings: [] });
    }
    if (url === '/api/quote-draft' && body.action === 'send_preview') {
      const job = server.jobs.get(body.jobId);
      if (body.expectedRevision !== job.revision) return reply({ ok: false, code: 'quote_draft_revision_conflict', error: 'This quote changed.' }, 409);
      if (!job.priced.compositePricing && builder) return reply({ ok: false, code: 'quote_draft_builder_required', error: 'With the quote builder on, a walkthrough quote is sent only after it is built in the quote builder.',
        details: { unapproved: [{ id: null, name: 'Walkthrough-priced quote', unitCents: null, reason: 'Its lines were priced from the walkthrough tables, which the owner has not approved for the quote builder.' }] } }, 409);
      const approval = compositeApproval(job.priced.breakdown, server.state);
      if (!approval.ready) return reply({ ok: false, code: 'quote_draft_composite_prices_unapproved', error: 'This quote has prices the owner has not approved.', details: { unapproved: approval.blocked } }, 409);
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
  const open = (store = memoryStorage()) => context.EGCQuoteDraft.open({ storage: store, fetch, actor: async () => 'sales.person', uuid: () => crypto.randomUUID(), plan, source: () => 'walk-1', savedJobId: () => savedJobId, draftId: () => 'draft-1', accept: result => { savedJobId = result.job.id; }, now: () => Date.parse('2026-10-17T18:00:00Z') });
  return { document, calls, timers, server, dialog, text, button, open };
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
  assert.match(h.text(), /Running total\$820\.00/, 'pre-filled from the walkthrough: one truck and one mattress; no base with truck loads');
  assert.ok(h.dialog().querySelectorAll('input[type="radio"]').some(input => input.checked && input.parentNode.textContent.startsWith('No cleaning base')));
  assert.doesNotMatch(h.text(), /itemized quote instead/, 'no way around the builder while it is on');
  h.button('Continue to shelving').click(); await flush();
  assert.deepEqual(h.calls.at(-1).body.compositePricing.steps, ['removal'], 'the server prices the finished removal step only');
  assert.match(h.text(), /Shelving units/);
  assert.match(h.text(), /Walkthrough note: 3 metal shelving units\./, 'the walkthrough count is a reminder, not a guessed product');
  assert.match(h.text(), /without installation/);
  h.button(`Add ${shelf.name}`).click();
  assert.match(h.text(), /Running total\$935\.70/);
  h.button('Continue to extra storage').click(); await flush();
  assert.deepEqual(h.calls.at(-1).body.compositePricing.steps, ['removal', 'shelving']);
  assert.match(h.text(), /All storage groups/);
  h.button('Review quote').click(); await flush();
  assert.deepEqual(h.calls.at(-1).body.compositePricing.steps, ['removal', 'shelving', 'storage']);
  assert.match(h.text(), /Removal \/ cleanout · \$820\.00/);
  assert.match(h.text(), /Quote total \$935\.70/);
  assert.match(h.text(), /cannot be sent until the owner approves these 3 draft prices/);
  assert.match(h.text(), /Mattress: draft price \$70\.00, not yet approved by the owner\./);
  assert.match(h.text(), /Shelving and storage installation is not priced/);
  assert.match(h.text(), /What to buy or grab \(1 products\)/);
  h.button('Save draft').click(); await flush();
  const save = h.calls.find(call => call.body?.action === 'save');
  assert.ok(save.body.draft.composite_pricing, 'the builder selection is saved with the lines');
  assert.match(save.body.draft.scope, /^Removal \/ cleanout: Full truck load; Mattress\. Shelving: HDX plastic shelving/);
  assert.deepEqual(save.body.draft.line_items.map(line => line.id), ['removal-junk-full', 'removal-special', 'shelving-goods']);
  // Saved, then the send preview is refused for the draft prices: the dialog says why and keeps the draft.
  assert.match(h.text(), /Draft EST-JOB1 revision 1 saved\./);
  assert.match(h.text(), /Sending is blocked until the owner approves these 3 prices/);
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
  // The owner approves the draft prices and confirms installation; the phone dropped the tab (sessionStorage is gone).
  const state = h.server.state;
  state.approvals = { revision: 'a1', items: { [mattress.id]: { unitCents: 7000, identity: menuItemIdentity(mattress) }, [shelf.id]: { unitCents: 11570, identity: menuItemIdentity(shelf) } } };
  state.settings.goodsInstallationIncluded = true;
  const before = h.calls.length;
  h.open(memoryStorage()); await flush();
  assert.ok(h.calls.slice(before).some(call => call.url === '/api/quote-draft?jobId=job-1'), 'the saved quote job is read once');
  assert.match(h.text(), /Quote EST-JOB1 revision 1 is saved as a draft and has not been sent\./);
  assert.match(h.text(), /Shelving · \$115\.70/);
  assert.match(h.text(), /Quote total \$935\.70/);
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
  assert.match(h.text(), /Running total\$935\.70/, 'the saved shelving is part of the selection again');
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
  assert.match(h.text(), /Running total\$2,095\.00/);
  assert.equal(h.dialog().querySelectorAll('input[type="radio"]').filter(input => input.checked && input.name === 'qb-base').length, 1);
  h.button('Continue to shelving').click(); await flush();
  assert.match(h.text(), /Garage cleaning base/, 'still on the removal step');
  assert.match(h.text(), /Prices changed since the builder opened/);
  h.button('Reload current prices').click(); await flush();
  assert.equal(h.calls.filter(call => call.url === '/api/quote-draft?view=builder').length, 2);
  assert.doesNotMatch(h.text(), /Prices changed/);
  assert.match(h.text(), /Running total\$2,095\.00/, 'the selection survives the reload');
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
  assert.match(h.text(), /Running total\$820\.00/, 'built from the walkthrough capture');
});
