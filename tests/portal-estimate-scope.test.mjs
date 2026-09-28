import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';
import { saveWalkthroughHandoff } from '../functions/_lib/walkthrough-handoff.js';
import { invoiceLineItems } from '../functions/_lib/money-core.js';
import { CUSTOMER_LINE_FIELDS, normalizeLineItems } from '../functions/_lib/quote-model.js';
import { portalStore, portalCookie, portalHandlers, portalView, portalPost } from './helpers/portal-fixture.mjs';

class FixedDate extends Date { constructor(...args) { super(...(args.length ? args : ['2026-09-22T18:00:00.000Z'])); } static now() { return Date.parse('2026-09-22T18:00:00.000Z'); } }

const owner = { user: 'zacb', role: 'owner', businessAccess: true, displayName: 'Owner' };
const NOW = '2026-09-22T18:00:00.000Z';
const SECRETS = ['SYNTHETIC-INTERNAL-BRIEF', 'gate code 4321', 'SYNTHETIC-CUSTOMER-NOTE', 'Blue bicycle', 'Park a vehicle', 'Use side gate', 'Locked cabinet'];
// Synthetic signed plan; the signature fixture is a placeholder PNG header only.
const plan = () => ({ client: { name: 'Synthetic Customer', phone: '9705550100', email: 'test@example.invalid', address: '100 Fixture Lane', highlevel_contact_id: 'provider1' }, quote: { title: 'Garage reset', total: 1400, deposit: 700, job_date: '2026-09-24', start_time: '09:00', end_time: '12:00', estimated_duration_min: 180 }, acceptance: { accepted_at: '2026-09-22T17:45:00.000Z', accepted_by: 'Synthetic Customer', signature_captured: true, method: 'in_person_signature', terms_version: '2026-09-deposit50' }, signature: 'data:image/png;base64,iVBORw0KGgo=', terms_version: '2026-09-deposit50', terms_accepted: true, photos: { before: 3 }, scope: { keep_items: 'Blue bicycle', remove_items: 'Empty cartons', exclusions: 'Locked cabinet', finish: ['cleanout', 'shelving'], finish_details: { shelf_type: 'metal', shelf_qty: 1 } }, discovery: { success: 'Park a vehicle' }, logistics: { crew_size: 2, assigned_to: 'Crew of 2', notes: 'Use side gate' }, internal_notes: 'SYNTHETIC-INTERNAL-BRIEF gate code 4321. Keep blue bicycle.', notes: 'SYNTHETIC-CUSTOMER-NOTE call before arrival', client_checklists: { preJob: [], postJob: [] } });
const itemized = () => { const p = plan(); p.quote.line_items = [{ id: 'cleanout', kind: 'service', name: 'Garage cleanout and reset', description: 'Sorting, hauling and disposal', quantity: 1, unitCents: 90100, totalCents: 90100 }, { id: 'shelving', kind: 'product', name: 'Metal shelving unit', description: '', quantity: 1, unitCents: 49900, totalCents: 49900 }]; p.quote.catalog_version = '2026-09-pest200-traps250'; return p; };

async function signedJob(planInput) {
  const rows = new Map([
    ['customers/c1', { id: 'c1', revision: 'c1r', name: 'Synthetic Customer', phone: '9705550100', email: 'test@example.invalid', address: '100 Fixture Lane', highlevelContactId: 'provider1' }],
    ['jobs/w1', { id: 'w1', revision: 'w1r', type: 'walkthrough', status: 'scheduled', pipelineStatus: 'scheduled', customerId: 'c1', customer: 'Synthetic Customer', date: '2026-09-22', time: '11:00', endTime: '12:00' }],
  ]);
  let n = 0;
  const store = { read: async (c, id) => structuredClone(rows.get(`${c}/${id}`) || null), jobs: async () => [...rows].filter(([k]) => k.startsWith('jobs/')).map(([, v]) => structuredClone(v)), resources: async () => [], roster: async () => [{ id: 'zacb', name: 'Owner', role: 'owner' }],
    commit: async writes => { for (const w of writes) { const old = rows.get(`${w.collection}/${w.id}`); if (w.revision ? old?.revision !== w.revision : !!old) throw Object.assign(new Error('Conflict'), { code: 'dispatch_revision_conflict', status: 409 }); } for (const w of writes) if (!w.verify) rows.set(`${w.collection}/${w.id}`, { ...rows.get(`${w.collection}/${w.id}`), ...structuredClone(w.patch), id: w.id, revision: `r${++n}` }); } };
  const saved = await saveWalkthroughHandoff(store, owner, { requestId: randomUUID(), customerId: 'c1', sourceWalkthroughId: 'w1', sourceRevision: 'w1r', plan: planInput }, NOW);
  const { id, revision, ...job } = rows.get(`jobs/${saved.job.id}`);
  return { id, job };
}

test('a signed walkthrough job shows the customer a sold-scope summary and none of its internal notes', async t => {
  for (const [label, planInput, lines] of [['legacy', plan(), [['Garage transformation', 'Included: Garage cleanout and reset; 1 metal shelving unit.', 1400]]], ['itemized', itemized(), [['Garage cleanout and reset', 'Sorting, hauling and disposal', 901], ['Metal shelving unit', '', 499]]]]) {
    await t.test(label, async st => {
      const { id, job } = await signedJob(planInput);
      assert.match(JSON.stringify(job), /SYNTHETIC-INTERNAL-BRIEF/, 'the saved job does hold the internal brief');
      portalStore(st, { [id]: job });
      const view = await portalView(portalHandlers(NOW), await portalCookie(id));
      assert.equal(view.status, 200);
      assert.equal(view.body.estimate.scope, 'Included: Garage cleanout and reset; 1 metal shelving unit.');
      assert.deepEqual(view.body.estimate.lineItems.map(line => [line.name, line.description, line.amount]), lines);
      assert.deepEqual([view.body.estimate.status, view.body.estimate.amount, view.body.estimate.revision], ['approved', 1400, 1]);
      const dto = JSON.stringify(view.body);
      for (const secret of SECRETS) assert.equal(dto.includes(secret), false, `${label}: ${secret}`);
    });
  }
});

test('an estimate valid through a Denver day can still be approved at 11:30 PM that night', async t => {
  const f = portalStore(t, { 'job-1': { type: 'job', customer: 'Synthetic Customer', customerId: 'customer-1', serviceType: 'Garage Turnaround', total: 800, status: 'scheduled', estimate: { number: 'EST-1', status: 'sent', amount: 800, revision: 1, validUntil: '2026-09-22' } } });
  const lateEvening = '2026-09-23T05:30:00.000Z', handlers = portalHandlers(lateEvening), cookie = await portalCookie('job-1', {}, Date.parse(lateEvening));
  const shown = (await portalView(handlers, cookie)).body.estimate;
  assert.equal(shown.status, 'sent', 'UTC has rolled over but Denver is still on the valid-through day');
  const approved = await portalPost(handlers, cookie, { action: 'approve_estimate', signed_name: 'Synthetic Customer', confirmed: true, estimate_revision: shown.revision, amount_cents: Math.round(shown.amount * 100), estimate_fingerprint: shown.fingerprint });
  assert.equal(approved.status, 200);
  assert.equal(f.job('job-1').customerApproval.approvedAt, lateEvening);
  const nextDay = '2026-09-23T06:30:00.000Z';
  f.edit('job-1', { customerApproval: null, estimate: { number: 'EST-1', status: 'sent', amount: 800, revision: 1, validUntil: '2026-09-22' } });
  assert.equal((await portalView(portalHandlers(nextDay), await portalCookie('job-1', {}, Date.parse(nextDay)))).body.estimate.status, 'expired');
});

// The Hub estimate dialog lives in employee-suite.js; only this finance slice is loaded.
const suite = fs.readFileSync(new URL('../employee-suite.js', import.meta.url), 'utf8');
function financeHarness(job, input = null) {
  const captured = {};
  const context = vm.createContext({ Date: FixedDate, jobStage: row => row.pipelineStatus || row.status || 'scheduled', window: {}, jobs: () => [job], financeDatePlus: () => '2026-10-06', money: String, askAction: async options => { captured.form = options; return input; }, patchJob: async (id, update) => { captured.update = JSON.parse(JSON.stringify(update)); }, syncCustomerCommunication: async () => true, render: () => {}, employeeIdentity: () => 'ZacB' });
  vm.runInContext(suite.slice(suite.indexOf('window.opsFinanceAction='), suite.indexOf('function addCalendarMonths')), context);
  return { context, captured };
}

test('the Hub estimate dialog never pre-fills the customer scope from internal job notes', async () => {
  for (const [job, expected] of [
    [{ id: 'job', total: 800, notes: 'SYNTHETIC gate code 4321', serviceType: 'Garage Turnaround' }, 'Garage Turnaround'],
    [{ id: 'job', total: 800, notes: 'SYNTHETIC gate code 4321' }, 'Garage service'],
    [{ id: 'job', total: 800, notes: 'SYNTHETIC gate code 4321', scopeSummary: 'Synthetic customer-facing scope' }, 'Synthetic customer-facing scope'],
    [{ id: 'job', total: 800, notes: 'SYNTHETIC gate code 4321', estimate: { number: 'EST-1', amount: 800, scope: 'Saved scope' } }, 'Saved scope'],
  ]) {
    const h = financeHarness(job);
    await h.context.window.opsFinanceAction('job', 'estimate');
    assert.equal(h.captured.form.fields.find(field => field.name === 'scope').value, expected);
    assert.doesNotMatch(JSON.stringify(h.captured.form), /4321/);
  }
});

test('re-saving an unchanged itemized estimate from the Hub keeps its signed lines; a price change bundles and re-requests approval', async () => {
  const lineItems = [{ id: 'cleanout', kind: 'service', name: 'Garage cleanout and reset', description: '', quantity: 1, unitCents: 90100, totalCents: 90100, amount: 901, optional: false, selected: true }, { id: 'shelving', kind: 'product', name: 'Metal shelving unit', description: '', quantity: 1, unitCents: 49900, totalCents: 49900, amount: 499, optional: false, selected: true }];
  const job = () => ({ id: 'job', customer: 'Synthetic Customer', total: 1400, serviceType: 'Garage transformation', estimate: { number: 'EST-1', revision: 1, status: 'accepted', amount: 1400, depositRequired: 700, scope: 'Included: Garage cleanout and reset; 1 metal shelving unit.', lineItems }, customerApproval: { status: 'approved', amount: 1400 }, deposit: { amount: 700, paidAmount: 700, status: 'paid' } });
  const same = financeHarness(job(), { amount: '1400', scope: 'Included: Garage cleanout and reset; 1 metal shelving unit.', deposit: '700', validUntil: '2026-10-06' });
  await same.context.window.opsFinanceAction('job', 'estimate');
  assert.deepEqual(same.captured.update.estimate.lineItems, lineItems);
  assert.deepEqual([same.captured.update.estimate.status, same.captured.update.estimate.revision, same.captured.update.customerApproval], ['accepted', 1, undefined]);
  const raised = financeHarness(job(), { amount: '1500', scope: 'Included: Garage cleanout and reset; 1 metal shelving unit.', deposit: '750', validUntil: '2026-10-06' });
  await raised.context.window.opsFinanceAction('job', 'estimate');
  assert.deepEqual(raised.captured.update.estimate.lineItems, [{ name: 'Garage transformation', description: 'Included: Garage cleanout and reset; 1 metal shelving unit.', quantity: 1, amount: 1500 }]);
  assert.deepEqual([raised.captured.update.estimate.status, raised.captured.update.estimate.revision, raised.captured.update.customerApproval.status], ['draft', 2, 'superseded']);
  assert.equal(raised.captured.update.deposit.paidAmount, 700);
});

test('a Hub scope edit of an older estimate with no stored revision moves it past the revision the portal showed', async t => {
  const legacy = { id: 'job-1', type: 'job', customer: 'Synthetic Customer', customerId: 'customer-1', serviceType: 'Garage Turnaround', total: 800, status: 'scheduled', estimate: { number: 'EST-1', status: 'draft', amount: 800, depositRequired: 400, scope: 'Cleanout and sweep', validUntil: '2026-10-01' } };
  const f = portalStore(t, { 'job-1': legacy }), handlers = portalHandlers(NOW), cookie = await portalCookie();
  const shown = (await portalView(handlers, cookie)).body.estimate;
  assert.equal(shown.revision, 1);
  const hub = financeHarness(f.job('job-1'), { amount: '800', scope: 'Cleanout, sweep and epoxy floor', deposit: '400', validUntil: '2026-10-01' });
  await hub.context.window.opsFinanceAction('job-1', 'estimate');
  assert.equal(hub.captured.update.estimate.revision, 2);
  f.edit('job-1', hub.captured.update);
  const stale = await portalPost(handlers, cookie, { action: 'approve_estimate', signed_name: 'Synthetic Customer', confirmed: true, estimate_revision: shown.revision, amount_cents: Math.round(shown.amount * 100), estimate_fingerprint: shown.fingerprint });
  assert.deepEqual([stale.status, stale.body.code], [409, 'CUSTOMER_PORTAL_ESTIMATE_CHANGED']);
  assert.equal(f.writes.length, 0);
  assert.equal((await portalView(handlers, cookie)).body.estimate.revision, 2);
  // Creating a first estimate and re-saving it unchanged keep today's numbering.
  const created = financeHarness({ id: 'job-2', total: 500, serviceType: 'Garage Turnaround' }, { amount: '500', scope: 'Garage Turnaround', deposit: '250', validUntil: '2026-10-06' });
  await created.context.window.opsFinanceAction('job-2', 'estimate');
  assert.equal(created.captured.update.estimate.revision, 1);
  const unchanged = financeHarness({ ...legacy, estimate: { ...legacy.estimate, revision: 3 } }, { amount: '800', scope: 'Cleanout and sweep', deposit: '400', validUntil: '2026-10-01' });
  await unchanged.context.window.opsFinanceAction('job-1', 'estimate');
  assert.equal(unchanged.captured.update.estimate.revision, 3);
});

test('the Hub Issue invoice action copies only sold lines in their customer-facing shape', async () => {
  const { lineItems } = normalizeLineItems([
    { id: 'cleanout', kind: 'service', name: 'Garage cleanout and reset', description: 'Sorting and hauling', quantity: 1, unitCents: 90100, totalCents: 90100, durationMinutes: 240, split: { productCents: 0, laborCents: 60000, markupCents: 30100, disposalCents: 0, laborMinutes: 240 } },
    { id: 'shelving', kind: 'product', name: 'Metal shelving unit', description: '', quantity: 1, unitCents: 49900, totalCents: 49900, catalog: { itemId: 'shelf-metal', version: 3 } },
    { id: 'totes', kind: 'product', name: 'Storage tote', description: '', quantity: 4, unitCents: 2150, totalCents: 8600, optional: true, selected: false },
  ], { strict: true });
  const job = { id: 'job-1', customer: 'Synthetic Customer', serviceType: 'Garage transformation', total: 1400, status: 'completed', estimate: { number: 'EST-1', status: 'accepted', amount: 1400, depositRequired: 700, scope: 'Included: Garage cleanout and reset; 1 metal shelving unit.', lineItems }, payment: { amount: 700, verified: true } };
  const hub = financeHarness(job, { dueDate: '2026-09-29', customerReference: '' });
  await hub.context.window.opsFinanceAction('job-1', 'invoice');
  const lines = hub.captured.update.invoice.lineItems;
  assert.deepEqual(lines.map(line => line.id), ['cleanout', 'shelving'], 'the declined totes are not invoiced');
  for (const line of lines) assert.deepEqual(Object.keys(line), [...CUSTOMER_LINE_FIELDS], line.id);
  assert.doesNotMatch(JSON.stringify(hub.captured.update.invoice), /markupCents|laborCents|catalog|shelf-metal|durationMinutes/);
  assert.deepEqual(lines, JSON.parse(JSON.stringify(invoiceLineItems(job).lineItems)), 'the Hub and the server invoice builder agree');
  // A legacy single Hub line keeps exactly its saved shape.
  const legacyLine = { name: 'Garage transformation', description: 'Garage reset', quantity: 1, amount: 1400 };
  const legacy = financeHarness({ ...job, estimate: { ...job.estimate, lineItems: [legacyLine] } }, { dueDate: '2026-09-29', customerReference: '' });
  await legacy.context.window.opsFinanceAction('job-1', 'invoice');
  assert.deepEqual(legacy.captured.update.invoice.lineItems, [legacyLine]);
});
