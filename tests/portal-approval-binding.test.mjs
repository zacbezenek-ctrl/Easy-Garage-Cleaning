import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { readJob } from '../functions/_lib/firestore-job.js';
import { NOW, env, portalStore, portalCookie, portalHandlers, portalView, portalPost, portalScript, fakeDom } from './helpers/portal-fixture.mjs';
import { CUSTOMER_PORTAL_TERMS_VERSION } from '../functions/_lib/customer-portal-content.js';

const html = readFileSync(new URL('../customer-portal.html', import.meta.url), 'utf8');
const job = (estimate = {}) => ({ type: 'job', customer: 'Synthetic Customer', customerId: 'customer-1', address: '100 Synthetic Street', serviceType: 'Garage Turnaround', total: 800, status: 'scheduled', estimate: { number: 'EST-1', status: 'sent', amount: 800, revision: 2, validUntil: '2026-10-01', ...estimate } });
const approve = (shown, extra = {}) => ({ action: 'approve_estimate', signed_name: 'Synthetic Customer', confirmed: true, estimate_revision: shown.revision, amount_cents: Math.round(shown.amount * 100), estimate_fingerprint: shown.fingerprint, ...extra });
// Staff revise the estimate right after this request reads the job.
const racingRead = (f, patch) => async (testEnv, id) => { const row = await readJob(testEnv, id); f.edit('job-1', patch); return row; };

test('an approval bound to the displayed revision and total is recorded', async t => {
  const f = portalStore(t, { 'job-1': job() }), handlers = portalHandlers(), cookie = await portalCookie();
  const shown = (await portalView(handlers, cookie)).body.estimate;
  assert.deepEqual([shown.revision, shown.amount, shown.approvable], [2, 800, true]);
  const approved = await portalPost(handlers, cookie, approve(shown));
  assert.equal(approved.status, 200);
  assert.deepEqual([f.job('job-1').customerApproval.status, f.job('job-1').customerApproval.amount, f.job('job-1').estimate.status, f.job('job-1').estimate.revision], ['approved', 800, 'approved', 2]);
});

test('a page that loaded an older revision or total cannot approve the current estimate', async t => {
  const f = portalStore(t, { 'job-1': job() }), handlers = portalHandlers(), cookie = await portalCookie();
  const shown = (await portalView(handlers, cookie)).body.estimate;
  f.edit('job-1', { estimate: { ...f.job('job-1').estimate, revision: 3 } });
  const staleRevision = await portalPost(handlers, cookie, approve(shown));
  assert.equal(staleRevision.status, 409);
  assert.equal(staleRevision.body.code, 'CUSTOMER_PORTAL_ESTIMATE_CHANGED');
  assert.match(staleRevision.body.error, /Refresh/);
  f.edit('job-1', { estimate: { ...f.job('job-1').estimate, revision: 2, amount: 950 }, total: 950 });
  const changedTotal = await portalPost(handlers, cookie, approve(shown));
  assert.equal(changedTotal.status, 409);
  assert.equal(changedTotal.body.code, 'CUSTOMER_PORTAL_ESTIMATE_CHANGED');
  assert.equal(f.writes.length, 0, 'nothing is approved at a price the customer did not see');
  const fresh = (await portalView(handlers, cookie)).body.estimate;
  assert.equal((await portalPost(handlers, cookie, approve(fresh))).status, 200);
  assert.equal(f.job('job-1').customerApproval.amount, 950);
});

test('an old portal page that omits the binding gets a clear refresh error, never a silent approval', async t => {
  const f = portalStore(t, { 'job-1': job() }), handlers = portalHandlers(), cookie = await portalCookie();
  const shown = (await portalView(handlers, cookie)).body.estimate;
  assert.match(shown.fingerprint, /^[0-9a-f]{64}$/);
  for (const body of [
    { action: 'approve_estimate', signed_name: 'Synthetic Customer', confirmed: true },
    approve(shown, { estimate_revision: '2' }),
    approve(shown, { amount_cents: 80000.5 }),
    approve(shown, { amount_cents: null }),
    approve(shown, { estimate_fingerprint: undefined }),
    approve(shown, { estimate_fingerprint: 42 }),
  ]) {
    const refused = await portalPost(handlers, cookie, body);
    assert.equal(refused.status, 409, JSON.stringify(body));
    assert.equal(refused.body.code, 'CUSTOMER_PORTAL_ESTIMATE_CHANGED');
    assert.match(refused.body.error, /out of date\. Refresh/);
  }
  assert.equal(f.writes.length, 0);
});

test('superseded, void and withdrawn estimates are never approvable', async t => {
  for (const status of ['superseded', 'void', 'withdrawn']) {
    const f = portalStore(t, { 'job-1': job({ status }) }), handlers = portalHandlers(), cookie = await portalCookie();
    const shown = (await portalView(handlers, cookie)).body.estimate;
    assert.equal(shown.approvable, false, status);
    const refused = await portalPost(handlers, cookie, approve(shown));
    assert.equal(refused.status, 409, status);
    assert.equal(refused.body.code, 'CUSTOMER_PORTAL_ESTIMATE_NOT_APPROVABLE');
    assert.equal(f.writes.length, 0);
  }
});

test('draft estimates are refused only when CUSTOMER_PORTAL_REJECT_DRAFT_ESTIMATES is true', async t => {
  // Hub estimate saves still release customer-facing estimates as 'draft', so today's default keeps them approvable.
  const strict = { ...env, CUSTOMER_PORTAL_REJECT_DRAFT_ESTIMATES: 'true' };
  const f = portalStore(t, { 'job-1': job({ status: 'draft' }) }), handlers = portalHandlers(), cookie = await portalCookie();
  const shown = (await portalView(handlers, cookie, strict)).body.estimate;
  assert.equal(shown.approvable, false);
  const refused = await portalPost(handlers, cookie, approve(shown), strict);
  assert.equal(refused.status, 409);
  assert.equal(refused.body.code, 'CUSTOMER_PORTAL_ESTIMATE_NOT_APPROVABLE');
  assert.equal(f.writes.length, 0);
  for (const value of [undefined, 'false', 'TRUE', '1']) {
    const testEnv = value === undefined ? env : { ...env, CUSTOMER_PORTAL_REJECT_DRAFT_ESTIMATES: value };
    assert.equal((await portalView(handlers, cookie, testEnv)).body.estimate.approvable, true, String(value));
  }
  assert.equal((await portalPost(handlers, cookie, approve(shown))).status, 200);
  assert.equal(f.job('job-1').estimate.status, 'approved');
});

test('an estimate revised during the approval is a revision conflict for every Firestore precondition status', async t => {
  for (const conflictStatus of [400, 409, 412]) {
    await t.test(`HTTP ${conflictStatus}`, async st => {
      const f = portalStore(st, { 'job-1': job() }, { conflictStatus }), cookie = await portalCookie();
      const shown = (await portalView(portalHandlers(), cookie)).body.estimate;
      const raced = await portalPost(portalHandlers(NOW, { read: racingRead(f, { estimate: { ...job().estimate, scope: 'Staff edit' } }) }), cookie, approve(shown));
      assert.equal(raced.status, 409);
      assert.equal(raced.body.code, 'CUSTOMER_PORTAL_REVISION_CONFLICT');
      assert.equal(f.writes.length, 0);
      assert.equal(f.job('job-1').estimate.scope, 'Staff edit', 'the staff revision is preserved');
    });
  }
  const f = portalStore(t, { 'job-1': job() }), cookie = await portalCookie(), handlers = portalHandlers();
  const shown = (await portalView(handlers, cookie)).body.estimate;
  f.failNextWrite();
  const outage = await portalPost(handlers, cookie, approve(shown));
  assert.equal(outage.status, 503);
  assert.equal(outage.body.code, 'CUSTOMER_PORTAL_STORAGE_UNAVAILABLE');
});

test('an itemized estimate shows only the chosen lines, keeps discounts negative and adds up to the approved total', async t => {
  const lineItems = [
    { id: 'cleanout', kind: 'service', name: 'Garage cleanout and reset', description: 'Sorting and hauling', quantity: 1, unitCents: 70000, totalCents: 70000, amount: 700, optional: false, selected: true, split: { productCents: 0, laborCents: 50000, markupCents: 20000, disposalCents: 0, laborMinutes: 0 }, catalog: { itemId: 'cleanout', version: 3 } },
    { id: 'totes', kind: 'product', name: 'Storage tote', description: '', quantity: 4, unitCents: 2150, totalCents: 8600, amount: 86, optional: true, selected: false },
    { id: 'shelving', kind: 'product', name: 'Metal shelving unit', description: '', quantity: 1, unitCents: 14900, totalCents: 14900, amount: 149, optional: true, selected: true },
    { id: 'adjustment', kind: 'discount', name: 'Price adjustment', description: 'Repeat customer courtesy', quantity: 1, unitCents: -4900, totalCents: -4900, amount: -49 },
  ];
  portalStore(t, { 'job-1': job({ amount: 800, lineItems }) });
  const view = (await portalView(portalHandlers(), await portalCookie())).body;
  assert.deepEqual(view.estimate.lineItems.map(line => [line.name, line.quantity, line.amount]), [['Garage cleanout and reset', 1, 700], ['Metal shelving unit', 1, 149], ['Price adjustment', 1, -49]]);
  assert.equal(view.estimate.lineItems.reduce((sum, line) => sum + Math.round(line.amount * 100), 0), Math.round(view.estimate.amount * 100));
  assert.doesNotMatch(JSON.stringify(view), /markupCents|laborCents|catalog|Storage tote/, 'internal cost splits and declined options stay private');
});

// The approve button is one inline listener in customer-portal.html.
function approveButton(portalData, failure) {
  const dom = fakeDom(), calls = [], loads = [], toasts = [];
  for (const [id, value] of [['approval-name', 'Synthetic Customer']]) dom.node(id).value = value;
  dom.node('approval-confirm').checked = true;
  dom.node('pay-button').classList.add('hidden');
  const context = { $: dom.node, portalData, toast: (message, error) => toasts.push({ message, error: Boolean(error) }), load: async quiet => { loads.push(quiet === true); }, api: async body => { calls.push(body); if (failure) throw Object.assign(new Error(failure.message), { code: failure.code }); return { ok: true }; } };
  vm.runInNewContext(portalScript(html, ["$('approve-button').addEventListener("]), context);
  return { click: () => dom.node('approve-button').listeners.click(), calls, loads, toasts, button: dom.node('approve-button') };
}

test('the portal page approves exactly the revision and total it displayed and reloads after a binding conflict', async () => {
  // P4-09: the page also sends the terms version it displayed.
  const shown = { estimate: { revision: 4, amount: 1234.56, fingerprint: 'synthetic-fingerprint-4', termsVersion: CUSTOMER_PORTAL_TERMS_VERSION } };
  const ok = approveButton(shown);
  await ok.click();
  assert.deepEqual({ ...ok.calls[0] }, { action: 'approve_estimate', signed_name: 'Synthetic Customer', confirmed: true, terms_version: CUSTOMER_PORTAL_TERMS_VERSION, estimate_revision: 4, amount_cents: 123456, estimate_fingerprint: 'synthetic-fingerprint-4' });
  assert.deepEqual(ok.loads, [false]);
  for (const code of ['CUSTOMER_PORTAL_ESTIMATE_CHANGED', 'CUSTOMER_PORTAL_REVISION_CONFLICT', 'CUSTOMER_PORTAL_ESTIMATE_NOT_APPROVABLE']) {
    const conflict = approveButton(shown, { code, message: 'The estimate changed after this page loaded. Refresh and review the current estimate before approving.' });
    await conflict.click();
    assert.deepEqual(conflict.loads, [true], code);
    assert.equal(conflict.toasts[0].error, true);
    assert.equal(conflict.button.disabled, false);
  }
  const other = approveButton(shown, { code: 'CUSTOMER_PORTAL_STORAGE_UNAVAILABLE', message: 'Try again shortly.' });
  await other.click();
  assert.deepEqual(other.loads, [], 'an outage keeps the page as displayed');
});

test('a scope or line edit that keeps the revision and total still needs a fresh review', async t => {
  // An older estimate with no stored revision reads as revision 1 before and after the edit.
  const legacy = job({ revision: undefined, scope: 'Cleanout and sweep' });
  const f = portalStore(t, { 'job-1': legacy }), handlers = portalHandlers(), cookie = await portalCookie();
  const shown = (await portalView(handlers, cookie)).body.estimate;
  f.edit('job-1', { estimate: { ...f.job('job-1').estimate, scope: 'Cleanout, sweep and epoxy floor' } });
  const fresh = (await portalView(handlers, cookie)).body.estimate;
  assert.deepEqual([fresh.revision, fresh.amount], [shown.revision, shown.amount]);
  assert.notEqual(fresh.fingerprint, shown.fingerprint);
  const stale = await portalPost(handlers, cookie, approve(shown));
  assert.deepEqual([stale.status, stale.body.code], [409, 'CUSTOMER_PORTAL_ESTIMATE_CHANGED']);
  // A line edit at the same total is bound the same way.
  const lineItems = [{ id: 'a', kind: 'service', name: 'Cleanout', description: '', quantity: 1, unitCents: 50000, totalCents: 50000 }, { id: 'b', kind: 'product', name: 'Shelf', description: '', quantity: 2, unitCents: 15000, totalCents: 30000 }];
  f.edit('job-1', { estimate: { ...f.job('job-1').estimate, lineItems } });
  const itemized = (await portalView(handlers, cookie)).body.estimate;
  f.edit('job-1', { estimate: { ...f.job('job-1').estimate, lineItems: [lineItems[0], { ...lineItems[1], name: 'Premium shelf' }] } });
  assert.equal((await portalPost(handlers, cookie, approve(itemized))).body.code, 'CUSTOMER_PORTAL_ESTIMATE_CHANGED');
  assert.equal(f.writes.length, 0);
  const current = (await portalView(handlers, cookie)).body.estimate;
  assert.equal((await portalPost(handlers, cookie, approve(current))).status, 200);
});

// The base render() in customer-portal.html with stubbed formatters and a fake DOM.
function portalRender() {
  const dom = fakeDom(), context = { $: dom.node, portalData: null, money: String, dateLabel: String, timeLabel: () => '', renderProgress() {}, renderPayment() {} };
  dom.node('approval-updated').classList.add('hidden');
  vm.runInNewContext(portalScript(html, ['function setText(', 'function render(data){', "$('approval-confirm').addEventListener("]), context);
  const data = estimate => ({ customer: { firstName: 'Synthetic' }, appointment: { service: 'Garage Turnaround', status: 'scheduled', date: '2026-09-24' }, estimate: { number: 'EST-1', status: 'sent', approvable: true, ...estimate }, payment: { total: estimate.amount, paid: 0, balance: estimate.amount }, photos: { customerUploadCount: 0 } });
  return { dom, render: estimate => context.render(data(estimate)) };
}

test('a poll that shows a revised estimate clears the approval checkbox and asks for a fresh review', () => {
  const p = portalRender(), A = { revision: 2, amount: 800, fingerprint: 'fp-a' };
  p.render(A);
  p.dom.node('approval-confirm').checked = true;
  p.render({ ...A });
  assert.equal(p.dom.node('approval-confirm').checked, true, 'an unchanged poll keeps the box ticked');
  assert.equal(p.dom.node('approval-updated').classList.contains('hidden'), true, 'no notice without a change');
  for (const B of [{ ...A, amount: 950 }, { ...A, revision: 3 }, { ...A, fingerprint: 'fp-b' }]) {
    const q = portalRender();
    q.render(A);
    q.dom.node('approval-confirm').checked = true;
    q.render(B);
    assert.equal(q.dom.node('approval-confirm').checked, false, JSON.stringify(B));
    assert.equal(q.dom.node('approval-updated').classList.contains('hidden'), false, JSON.stringify(B));
    assert.equal(q.dom.node('estimate-total').textContent, String(B.amount));
  }
  // Ticking the box again after reviewing the update dismisses the notice.
  const r = portalRender();
  r.render(A); r.render({ ...A, amount: 950 });
  r.dom.node('approval-confirm').checked = true;
  r.dom.node('approval-confirm').listeners.change();
  assert.equal(r.dom.node('approval-updated').classList.contains('hidden'), true);
});

test('the portal shows the quantity with each multi-quantity line total', () => {
  const made = [], document = { createElement: tag => { const node = { tag, className: '', textContent: '', children: [], append: (...nodes) => node.children.push(...nodes) }; made.push(node); return node; } };
  const context = { document };
  vm.runInNewContext(portalScript(html, ['const $=id=>document.getElementById(id),money=', 'const make=', 'function estimateLine(']), context);
  const text = row => row.children[0].children.map(node => node.textContent).concat(row.children[1].textContent);
  assert.deepEqual(text(context.estimateLine({ name: 'Storage tote', description: '', quantity: 4, amount: 86 })), ['Storage tote × 4', '$86.00']);
  assert.deepEqual(text(context.estimateLine({ name: 'Metal shelving unit', description: 'Installed', quantity: 2, amount: 998 })), ['Metal shelving unit × 2', 'Installed', '$998.00']);
  assert.deepEqual(text(context.estimateLine({ name: 'Garage cleanout and reset', description: '', quantity: 1, amount: 700 })), ['Garage cleanout and reset', '$700.00']);
  assert.deepEqual(text(context.estimateLine({ name: 'Price adjustment', description: 'Repeat customer courtesy', quantity: 1, amount: -49 })), ['Price adjustment', 'Repeat customer courtesy', '-$49.00']);
});
