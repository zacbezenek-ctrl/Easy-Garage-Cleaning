import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from './helpers/vm-realm.mjs';
const source = readFileSync(new URL('../business-hub-billing.js', import.meta.url), 'utf8');
const prepared = () => ({ id: 'ref', totalCents: 1200, recipient: { memberId: 'payer', version: 1, name: 'Payer', email: 'test@example.invalid' },
  invoices: [{ jobId: 'north', propertyId: 'p', invoiceNumber: 'I', totalCents: 1200, amountCents: 1200 }] });
function ui(api) {
  let hook, click, reset, current, count = 0, reloads = 0;
  class Element {
    constructor() { this.innerHTML = ''; this.children = []; }
    insertAdjacentHTML(_, html) { this.innerHTML += html; }
    setAttribute() {}
    append(child) { this.children.push(child); }
  }
  const document = { createElement: () => new Element(), addEventListener: (kind, fn) => { if (kind === 'click') click = fn; } };
  const hub = { registerRenderHook: fn => { hook = fn; }, registerSessionResetHook: fn => { reset = fn; }, api, esc: value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;'),
    money: value => '$' + value, propName: id => id, newId: () => String(++count).padStart(32, '0'), exportUrl: kind => '/api/business-hub?export=' + kind, data: () => current, reload: async () => { reloads++; }, toast: () => {} };
  vm.runInNewContext(source, { window: { EGCBusinessHub: hub }, document });
  const render = data => { current = data; const out = new Element(); hook(out, data, 'billing'); return out; };
  const data = id => ({ account: { id }, viewer: { permissions: { pay: true } }, projects: [{ jobId: 'north', propertyId: 'p', invoiceNumber: 'I', balance: 12, total: 12, status: 'completed' }],
    billing: { canManage: false, candidates: [], routes: [{ propertyId: 'p', recipient: { memberId: 'payer', version: 1, name: 'Payer', email: 'test@example.invalid' } }] } });
  function button(kind) { return { disabled: false, dataset: {}, hasAttribute: name => name === `data-billing-${kind}`,
    closest: () => ({ querySelectorAll: () => [{ dataset: { billingJob: 'north' } }] }) }; }
  return { render, data, button, reset: () => reset(), reloads: () => reloads, click: b => click({ target: { closest: () => b } }) };
}
test('billing UI suppresses concurrent double clicks and retains request id after a lost response', async () => {
  let release, calls = [];
  const h = ui(payload => { calls.push(payload); return new Promise((_, reject) => { release = () => reject(new Error('Synthetic connection interruption')); }); });
  h.render(h.data('one'));
  const button = h.button('prepare'), first = h.click(button);
  await h.click(button); assert.equal(calls.length, 1);
  release(); await first;
  const second = h.click(button); assert.equal(calls.length, 2);
  assert.equal(calls[0].requestId, calls[1].requestId);
  release(); await second;
});
test('billing UI clears the prior account review and renders recipient text escaped', async () => {
  const h = ui(async () => ({ preparation: { id: 'ref', totalCents: 1200, recipient: { memberId: 'payer', version: 1, name: '<script>', email: 'test@example.invalid' }, invoices: [{ jobId: 'north', propertyId: 'p', invoiceNumber: '<invoice>', amountCents: 1200, totalCents: 1200 }] } }));
  const data = h.data('one'); data.projects[0].invoiceNumber = '<invoice>'; data.billing.routes[0].recipient.name = '<script>';
  h.render(data); await h.click(h.button('prepare'));
  const before = h.render(data).children[0].children[0].innerHTML;
  assert.match(before, /&lt;script>/); assert.doesNotMatch(before, /<script>/);
  assert.match(before, /href="\/api\/business-hub\?export=billing_review&amp;review=ref" download/);
  assert.equal(h.render(h.data('two')).children[0].children.length, 0);
});

test('same-account changes discard a displayed review without sending or reallocating money', async () => {
  for (const change of [
    data => { data.projects[0].balance = 10; },
    data => { data.projects[0].total = 20; },
    data => { data.projects[0].invoiceNumber = 'new_invoice'; },
    data => { data.projects[0].paymentNeedsReview = true; },
    data => { data.projects[0].status = 'cancelled'; },
    data => { data.billing.routes[0].recipient = null; },
    data => { data.billing.routes[0].recipient.version = 2; },
    data => { data.billing.routes[0].recipient.email = 'changed@example.invalid'; },
    data => { data.viewer.permissions.pay = false; },
  ]) {
    let calls = 0;
    const h = ui(async () => { calls++; return { preparation: { id: 'ref', totalCents: 1200,
      recipient: { memberId: 'payer', version: 1, name: 'Payer', email: 'test@example.invalid' },
      invoices: [{ jobId: 'north', propertyId: 'p', invoiceNumber: 'I', totalCents: 1200, amountCents: 1200 }] } }; });
    const data = h.data('one'); h.render(data); await h.click(h.button('prepare'));
    assert.equal(h.render(data).children[0].children.length, 1, 'unchanged review remains visible');
    change(data); assert.equal(h.render(data).children[0].children.length, 0, 'stale review is discarded');
    assert.equal(calls, 1, 'rendering never creates a new payment action');
  }
});
test('a narrower project scope drops a saved review before rendering it', async () => {
  const h = ui(async () => ({ preparation: prepared() }));
  h.render(h.data('one')); await h.click(h.button('prepare'));
  assert.equal(h.render(h.data('one')).children[0].children.length, 1);
  const restricted = h.data('one'); restricted.projects = [];
  assert.equal(h.render(restricted).children[0].children.length, 0);
});
test('sign-out clears the review even when another member reopens the same account', async () => {
  const h = ui(async () => ({ preparation: prepared() }));
  h.render(h.data('one')); await h.click(h.button('prepare'));
  assert.equal(h.render(h.data('one')).children[0].children.length, 1);
  await h.click({ id: 'logout' });
  assert.equal(h.render(h.data('one')).children[0].children.length, 0);
});
test('an auth reset drops a late preparation response and pending request ids belong to an account', async () => {
  let done, calls = [];
  const h = ui(payload => { calls.push(payload); return new Promise(resolve => { done = resolve; }); });
  h.render(h.data('one')); const first = h.click(h.button('prepare'));
  h.reset();
  done({ preparation: { ...prepared(), id: 'old' } }); await first;
  assert.equal(h.render(h.data('one')).children[0].children.length, 0);
  h.render(h.data('two')); const second = h.click(h.button('prepare'));
  assert.notEqual(calls[0].requestId, calls[1].requestId);
  done({ preparation: { ...prepared(), id: 'new' } }); await second;
  assert.equal(h.render(h.data('two')).children[0].children.length, 1);
});
test('a partial recipient save refreshes server truth instead of retaining stale choices', async () => {
  let calls = 0;
  const h = ui(async () => { if (++calls === 2) throw new Error('Synthetic conflict'); return { ok: true }; });
  h.render(h.data('one'));
  const b = h.button('save'); b.closest = () => ({ querySelectorAll: () => [
    { dataset: { billingContact: '' }, value: 'a' }, { dataset: { billingContact: 'p' }, value: 'b' },
  ] });
  await h.click(b); assert.equal(calls, 2); assert.equal(h.reloads(), 1);
});
test('core notifies extensions on expired access, logout and account switch', async () => {
  const core = readFileSync(new URL('../business-hub.js', import.meta.url), 'utf8');
  const functions = core.slice(core.indexOf('async function api('), core.indexOf('const attrs ='));
  const reset = core.match(/function resetExtensions\(\)\{[^\n]+/)[0];
  const state = { resets: 0, status: 200 };
  const api = vm.runInNewContext(`let account='one'; const staff=true, ext={resets:[()=>state.resets++]}; ${reset}\n${functions}\n({api,setAccount})`, {
    state, URLSearchParams, endpoint: () => '/api/business-hub', fetch: async () => ({ ok: state.status === 200, status: state.status, json: async () => ({}) }),
    history: { replaceState() {} }, location: { pathname: '/business-hub' },
  });
  for (const status of [401, 403]) { state.status = status; await assert.rejects(api.api()); }
  state.status = 200; await api.api({ action: 'logout' }); api.setAccount('two'); api.setAccount('two');
  assert.equal(state.resets, 4);
});
