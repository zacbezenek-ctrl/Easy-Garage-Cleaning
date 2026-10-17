import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { createDocument, storage as memoryStorage } from './helpers/hub-dom.mjs';
import { builderMenu, priceCompositeQuote } from '../functions/_lib/composite-quote.js';
import { walkthroughPricing, walkthroughServiceItems } from '../functions/_lib/pricing-config.js';

// The estimator's walkthrough quote dialog (crew/quote-draft.js) driven through its real DOM code against a fake Hub
// that prices with the server's composite-quote module.
const source = readFileSync(new URL('../crew/quote-draft.js', import.meta.url), 'utf8');
const readJson = path => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const menuDoc = readJson('../functions/_data/pricing-menu.json'), settings = readJson('../functions/_data/pricing-settings.defaults.json');
const state = { menu: menuDoc, settings, walkthrough: walkthroughPricing(walkthroughServiceItems()), approvals: { items: {}, revision: null } };
const shelf = menuDoc.products.find(item => item.id === 'hd-100006678');
const plan = () => ({ client: { name: 'Synthetic Customer', phone: '+19705550100', email: 'test@example.invalid', address: '100 Fixture Lane', highlevel_contact_id: '' },
  quote: { title: 'EGC Garage Service', estimated_duration_min: 240, line_items: [{ id: 'cleanout', kind: 'service', name: 'Garage cleanout and reset', quantity: 1, unitCents: 90000, totalCents: 90000 }] },
  scope: { garages: '2', loads: '1', special_items: ['Mattress'], access: [], finish: ['cleanout', 'shelving'], hazards: [], finish_details: { shelf_type: 'metal', shelf_qty: 3, tote_qty: 0 } }, raw: {}, logistics: { crew_size: 2 } });
const flush = async () => { for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve)); };

function harness({ builder = true, stale = false } = {}) {
  const document = createDocument(), calls = [];
  const context = { document, Node: document.Node, URLSearchParams, AbortController, setTimeout, clearTimeout, Intl, Date, crypto, console, addEventListener() {}, removeEventListener() {} };
  context.window = context;
  vm.runInNewContext(source, context);
  const reply = (body, status = 200) => ({ ok: status < 300, status, json: async () => structuredClone(body) });
  const fetch = async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ url, body });
    if (url === '/api/quote-draft?view=builder') return builder ? reply({ ok: true, enabled: true, ...builderMenu(state) }) : reply({ ok: false, code: 'quote_draft_invalid_request', error: 'The quote lookup is invalid.' }, 400);
    if (url.startsWith('/api/walkthrough-handoff?')) return reply({ ok: true, viewer: { id: 'sales.person' }, sourceRevision: 'w1r', customerId: 'customer-1', jobId: '', expectedRevision: '' });
    if (url === '/api/quote-draft' && body.action === 'composite_preview' && stale) { stale = false; return reply({ ok: false, code: 'quote_draft_composite_version_changed', error: 'Prices changed since the builder opened. Reload the builder and review the current prices before saving.' }, 409); }
    if (url === '/api/quote-draft' && body.action === 'composite_preview') {
      try { const { storedLineItems, ...priced } = priceCompositeQuote(state, body.compositePricing); return reply({ ok: true, ...priced }); }
      catch (error) { return reply({ ok: false, code: error.code, error: error.message }, error.status); }
    }
    if (url === '/api/quote-draft' && body.action === 'save') {
      const priced = priceCompositeQuote(state, body.draft.composite_pricing, { complete: true });
      assert.deepEqual(body.draft.line_items, structuredClone(priced.lineItems), 'the saved lines are the server preview');
      return reply({ ok: true, requestId: body.requestId, job: { id: 'job-1', revision: 'r1', customerId: 'customer-1', estimate: { number: 'EST-JOB1', revision: 1, amountCents: priced.totalCents, lineItems: [] } }, warnings: [] });
    }
    if (url === '/api/quote-draft' && body.action === 'send_preview') return reply({ ok: false, code: 'quote_draft_composite_prices_unapproved', error: 'This quote has 2 draft prices the owner has not approved: Two-car garage base, Mattress.',
      details: { unapproved: [{ id: 'egc-003', name: 'Two-car garage base', reason: 'Two-car garage base: draft price $975.00, not yet approved by the owner.' }, { id: 'egc-027', name: 'Mattress', reason: 'Mattress: draft price $70.00, not yet approved by the owner.' }] } }, 409);
    return reply({ ok: false, code: 'unexpected', error: `unexpected ${url}` }, 500);
  };
  const dialog = () => document.body.querySelector('dialog');
  const text = () => dialog()?.textContent || '';
  const button = label => dialog().querySelectorAll('button').find(node => node.textContent === label || node.getAttribute('aria-label') === label);
  const open = () => context.EGCQuoteDraft.open({ storage: memoryStorage(), fetch, actor: async () => 'sales.person', uuid: () => crypto.randomUUID(), plan, source: () => 'walk-1', savedJobId: () => '', draftId: () => 'draft-1', now: () => Date.parse('2026-10-17T18:00:00Z') });
  return { document, calls, dialog, text, button, open };
}

test('the walkthrough quote opens the guided builder: removal, shelving, extra storage, review; each step is priced by the server in order', async () => {
  const h = harness();
  h.open();
  assert.match(h.text(), /Loading the quote builder/);
  await flush();
  assert.match(h.text(), /Build the itemized quote/);
  assert.match(h.text(), /1 Removal \/ cleanout2 Shelving3 Extra storage4 Review/);
  assert.match(h.text(), /Garage cleaning base/);
  assert.match(h.text(), /Running total\$1,795\.00/, 'pre-filled from the walkthrough: two-car base, one truck, one mattress');
  assert.ok(h.dialog().querySelectorAll('input[type="radio"]').some(input => input.checked && input.parentNode.textContent.startsWith('Two-car garage base')));
  h.button('Continue to shelving').click(); await flush();
  assert.deepEqual(h.calls.at(-1).body.compositePricing.steps, ['removal'], 'the server prices the finished removal step only');
  assert.match(h.text(), /Shelving units/);
  assert.match(h.text(), /Walkthrough note: 3 metal shelving units\./, 'the walkthrough count is a reminder, not a guessed product');
  h.button(`Add ${shelf.name}`).click();
  assert.match(h.text(), /Running total\$1,910\.70/);
  h.button('Continue to extra storage').click(); await flush();
  assert.deepEqual(h.calls.at(-1).body.compositePricing.steps, ['removal', 'shelving']);
  assert.match(h.text(), /All storage groups/);
  h.button('Review quote').click(); await flush();
  assert.deepEqual(h.calls.at(-1).body.compositePricing.steps, ['removal', 'shelving', 'storage']);
  assert.match(h.text(), /Removal \/ cleanout · \$1,795\.00/);
  assert.match(h.text(), /Quote total \$1,910\.70/);
  assert.match(h.text(), /cannot be sent until the owner approves these 3 draft prices/);
  assert.match(h.text(), /Two-car garage base: draft price \$975\.00, not yet approved by the owner\./);
  assert.match(h.text(), /What to buy or grab \(1 products\)/);
  h.button('Save draft').click(); await flush();
  const save = h.calls.find(call => call.body?.action === 'save');
  assert.ok(save.body.draft.composite_pricing, 'the builder selection is saved with the lines');
  assert.match(save.body.draft.scope, /^Removal \/ cleanout: Two-car garage base; Full truck load; Mattress\. Shelving: HDX plastic shelving/);
  // Saved, then the send preview is refused for the draft prices: the dialog says why and keeps the draft.
  assert.match(h.text(), /Draft EST-JOB1 revision 1 saved\./);
  assert.match(h.text(), /Sending is blocked until the owner approves these 2 draft prices/);
  assert.match(h.text(), /Mattress: draft price \$70\.00, not yet approved by the owner\./);
  assert.ok(h.button('Done'));
});

test('a refused step stays put with the server reason; rules the server enforces are also shown on the step', async () => {
  const h = harness({ stale: true });
  h.open(); await flush();
  // A pressure wash needs a one-car base: the checkbox is disabled for a two-car garage.
  const wash = h.dialog().querySelectorAll('label').find(node => node.textContent.startsWith('Pressure washing, one-car'));
  assert.ok(wash.querySelector('input').hasAttribute('disabled'));
  assert.match(wash.textContent, /One-car garage base only\./);
  // Changing the base keeps one base selected and re-totals.
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

test('with the builder off the walkthrough quote is reviewed exactly as before', async () => {
  const h = harness({ builder: false });
  h.open(); await flush();
  assert.match(h.text(), /Send options for review/);
  assert.match(h.text(), /Save this quote as an unsigned draft on the Hub job/);
  assert.match(h.text(), /Garage cleanout and reset\$900\.00/);
  assert.doesNotMatch(h.text(), /Removal \/ cleanout/);
  assert.deepEqual(h.calls.map(call => call.url), ['/api/quote-draft?view=builder'], 'one read-only probe, then the walkthrough flow');
});
