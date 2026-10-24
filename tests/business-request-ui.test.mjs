import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from './helpers/vm-realm.mjs';
import { createDocument } from './helpers/hub-dom.mjs';
const source = readFileSync(new URL('../business-hub-requests.js', import.meta.url), 'utf8');
function ui(api, search = async () => ({ ok: true, json: async () => ({ ok: true, customers: [{ id: 'customer', name: 'Customer' }] }) })) {
  const document = createDocument(), create = document.createElement.bind(document); let actions, reset, next = 0;
  document.createElement = tag => { const node = create(tag); if (tag === 'dialog') { node.showModal = () => { node.open = true; }; node.close = () => { node.open = false; }; } return node; };
  const data = { account: { id: 'account' }, viewer: { permissions: { staff: true, link: true } }, businessRequestRevision: 'v1',
    requests: [{ id: 'request', propertyId: 'property', service: 'Cleanout', status: 'submitted' }], messages: [] };
  const hub = { api, esc: value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;'),
    registerRequestActions: fn => { actions = fn; }, registerSessionResetHook: fn => { reset = fn; }, registerRenderHook() {},
    newId: () => String(++next).padStart(32, '0'), data: () => data, propName: () => 'Property', toast() {}, reload: async () => {} };
  vm.runInNewContext(source, { window: { EGCBusinessHub: hub }, document, fetch: search, AbortController, setTimeout, clearTimeout });
  function open(kind) { const button = document.createElement('button'); button.dataset[kind === 'convert' ? 'businessConvert' : 'businessReply'] = 'request'; document.dispatch({ type: 'click', target: button }); return document.querySelector('dialog'); }
  async function submit(form) { form.elements = Object.fromEntries(form.querySelectorAll('input,textarea,select').map(node => [node.name, node])); for (const fn of form.listeners.submit || []) await fn({ preventDefault() {}, stopPropagation() {} }); }
  async function click(button) { for (const fn of button.listeners.click || []) await fn({}); }
  return { document, data, open, submit, click, reset: () => reset(), actions: () => actions(data.requests[0], data) };
}
const preview = { previewToken: 'a'.repeat(64), customer: { id: 'customer', name: '<script>Customer', email: 'customer@example.invalid', phone: '' },
  request: { scope: 'Boxes', payer: 'Company' }, property: { name: 'North', address: '12 Example Way' } };

test('conversion chooses an existing customer through the authorized search instead of exposing a raw ID input', async () => {
  let url;
  const h = ui(async () => preview, async path => { url = path; return { ok: true, json: async () => ({ ok: true, customers: [{ id: 'customer', name: '<b>Customer', email: 'test@example.invalid' }] }) }; });
  const dialog = h.open('convert'), form = dialog.querySelector('form');
  form.elements = Object.fromEntries(form.querySelectorAll('input,select').map(node => [node.name, node]));
  form.elements.customerQuery.value = 'Customer & Co';
  await h.click(form.querySelector('[data-customer-search]'));
  assert.equal(url, '/api/dispatch?view=customers&q=Customer%20%26%20Co');
  assert.match(form.elements.customerId.innerHTML, /&lt;b>/);
  assert.equal(form.querySelector('input[name="customerId"]'), null);
});
test('conversion preview escapes customer data and requires explicit authorization', async () => {
  const calls = [], h = ui(async payload => { calls.push(payload); return preview; });
  const dialog = h.open('convert'), form = dialog.querySelector('form'); form.querySelector('select').value = 'customer';
  await h.submit(form);
  assert.equal(dialog.querySelector('script'), null); assert.match(dialog.textContent, /<script>Customer/);
  await h.click(dialog.querySelector('[data-conversion-save]'));
  assert.equal(calls.length, 1); assert.match(dialog.querySelector('[data-request-error]').textContent, /Confirm/);
  dialog.querySelector('[data-conversion-confirm]').checked = true;
  await h.click(dialog.querySelector('[data-conversion-save]'));
  assert.equal(calls[1].action, 'convert_business_request'); assert.equal(calls[1].sharingAuthorized, true);
});
test('lost conversion response retries the exact operation and duplicate clicks do not overlap', async () => {
  const calls = []; let reject;
  const h = ui(async payload => { calls.push(payload); if (payload.action.startsWith('preview')) return preview; return new Promise((_, no) => { reject = no; }); });
  const dialog = h.open('convert'), form = dialog.querySelector('form'); form.querySelector('select').value = 'customer'; await h.submit(form);
  dialog.querySelector('[data-conversion-confirm]').checked = true; const save = dialog.querySelector('[data-conversion-save]');
  const first = h.click(save); await h.click(save); assert.equal(calls.length, 2);
  reject(new Error('Synthetic lost response')); await first;
  const retry = h.click(save); assert.equal(calls.length, 3); assert.equal(calls[1].requestId, calls[2].requestId);
  reject(new Error('Synthetic lost response')); await retry;
});
test('account access reset drops a late conversion preview', async () => {
  let resolve; const h = ui(() => new Promise(done => { resolve = done; }));
  const dialog = h.open('convert'), form = dialog.querySelector('form'); form.querySelector('select').value = 'customer';
  const waiting = h.submit(form); h.reset(); resolve(preview); await waiting;
  assert.equal(h.document.querySelector('dialog'), null);
});
test('request conversations use the existing scoped message action and retain message id on retry', async () => {
  const calls = [], h = ui(async payload => { calls.push(payload); throw new Error('Synthetic connection interruption'); });
  const form = h.open('reply').querySelector('form'); form.querySelector('textarea').value = 'Please review the access note';
  await h.submit(form); await h.submit(form);
  assert.equal(calls[0].action, 'message'); assert.equal(calls[0].requestId, 'request'); assert.equal(calls[0].messageId, calls[1].messageId);
  h.data.viewer.permissions = { view: true };
  assert.equal(h.actions(), '');
});
