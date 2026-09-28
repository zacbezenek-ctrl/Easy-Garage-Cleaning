import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';
import { customerScopeSummary, normalizeHandoffPlan, saveWalkthroughHandoff, savedHandoffPayload } from '../functions/_lib/walkthrough-handoff.js';
import { estimateTotals, legacyLineItems } from '../functions/_lib/quote-model.js';

const owner = { user: 'zacb', role: 'owner', businessAccess: true, displayName: 'Owner' };
const NOW = '2026-09-22T18:00:00.000Z';
const read = path => fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const sourceLine = (source, prefix) => { const found = source.split(/\r?\n/).find(row => row.startsWith(prefix)); assert.ok(found, prefix); return found; };

// Synthetic signed plan; the signature fixture is a placeholder PNG header only.
const plan = () => ({ client: { name: 'Synthetic Customer', phone: '9705550100', email: 'test@example.invalid', address: '100 Fixture Lane', highlevel_contact_id: 'provider1' }, quote: { title: 'Garage reset', total: 1400, deposit: 700, job_date: '2026-09-24', start_time: '09:00', end_time: '12:00', estimated_duration_min: 180 }, acceptance: { accepted_at: '2026-09-22T17:45:00.000Z', accepted_by: 'Synthetic Customer', signature_captured: true, method: 'in_person_signature', terms_version: '2026-09-deposit50' }, signature: 'data:image/png;base64,iVBORw0KGgo=', terms_version: '2026-09-deposit50', terms_accepted: true, photos: { before: 3 }, scope: { keep_items: 'Blue bicycle', remove_items: 'Empty cartons', exclusions: 'Locked cabinet', finish: ['cleanout', 'shelving'], finish_details: { shelf_type: 'metal', shelf_qty: 1 }, hazard_details: { pest_waste: { amount: 200 } } }, discovery: { success: 'Park a vehicle' }, logistics: { crew_size: 2, assigned_to: 'Crew of 2', notes: 'Use side gate' }, internal_notes: 'SYNTHETIC-INTERNAL-BRIEF gate code 4321. Keep blue bicycle.', notes: 'SYNTHETIC-CUSTOMER-NOTE call before arrival', client_checklists: { preJob: [{ id: 'keep-bike', label: 'Protect blue bicycle', detail: 'Move to safe area', critical: true }], postJob: [{ id: 'scope-review', label: 'Review with customer', detail: 'Confirm agreed scope' }] } });
// Canonical lines: $700 + $499 + $200 + $1 adjustment = $1,400; the totes are
// an optional line the homeowner declined, so they are stored but not charged.
const lines = () => [
  { id: 'cleanout', kind: 'service', name: 'Garage cleanout and reset', description: 'Sorting, hauling and disposal', quantity: 1, unitCents: 70000, totalCents: 70000 },
  { id: 'shelving', kind: 'product', name: 'Metal shelving unit', description: '', quantity: 1, unitCents: 49900, totalCents: 49900, split: { productCents: 30000, laborCents: 9900, markupCents: 10000, disposalCents: 0 }, catalog: { itemId: 'shelf-metal', version: 3 } },
  { id: 'pest-waste', kind: 'service', name: 'Pest-waste cleanup', description: '', quantity: 1, unitCents: 20000, totalCents: 20000 },
  { id: 'totes', kind: 'product', name: 'Storage tote', description: '', quantity: 4, unitCents: 2150, totalCents: 8600, optional: true, selected: false },
  { id: 'adjustment', kind: 'fee', name: 'Price adjustment', description: 'Longer carry agreed on site', quantity: 1, unitCents: 100, totalCents: 100 },
];
const itemized = (change = () => {}) => { const p = plan(); p.quote.line_items = lines(); p.quote.catalog_version = '2026-09-pest200-traps250'; change(p); return p; };

function fixture(planInput = itemized()) {
  const rows = new Map([
    ['customers/c1', { id: 'c1', revision: 'c1r', name: 'Synthetic Customer', phone: '9705550100', email: 'test@example.invalid', address: '100 Fixture Lane', highlevelContactId: 'provider1' }],
    ['jobs/w1', { id: 'w1', revision: 'w1r', type: 'walkthrough', status: 'scheduled', pipelineStatus: 'scheduled', customerId: 'c1', customer: 'Synthetic Customer', highlevelContactId: 'provider1', highlevelAppointmentId: 'walk-provider', date: '2026-09-22', time: '11:00', endTime: '12:00', projectId: 'p1' }],
    ['projects/p1', { id: 'p1', revision: 'p1r', customerId: 'c1', sourceRecordId: 'w1', sourceWalkthroughId: 'w1' }],
  ]);
  let n = 0; const calls = [];
  const roster = [{ id: 'zacb', name: 'Owner', role: 'owner' }, { id: 'crew1', name: 'Crew One', role: 'crew' }];
  const store = { read: async (c, id) => structuredClone(rows.get(`${c}/${id}`) || null), jobs: async () => [...rows].filter(([k]) => k.startsWith('jobs/')).map(([, v]) => structuredClone(v)), resources: async () => [], roster: async () => structuredClone(roster),
    commit: async writes => { const keys = new Set(); for (const w of writes) { const k = `${w.collection}/${w.id}`, old = rows.get(k); assert(!keys.has(k), 'unique writes'); keys.add(k); if (w.revision ? old?.revision !== w.revision : !!old) throw Object.assign(new Error('Conflict'), { code: 'dispatch_revision_conflict', status: 409 }); } calls.push(structuredClone(writes)); for (const w of writes) if (!w.verify) { const k = `${w.collection}/${w.id}`; rows.set(k, { ...rows.get(k), ...structuredClone(w.patch), id: w.id, revision: `r${++n}` }); } } };
  const input = { requestId: randomUUID(), customerId: 'c1', sourceWalkthroughId: 'w1', sourceRevision: 'w1r', plan: planInput };
  const revise = (nextPlan, jobId) => ({ ...input, requestId: randomUUID(), sourceRevision: rows.get('jobs/w1').revision, jobId, expectedRevision: rows.get(`jobs/${jobId}`).revision, plan: nextPlan });
  return { rows, store, input, calls, revise, run: (value = input) => saveWalkthroughHandoff(store, owner, value, NOW) };
}

test('a plan without line items still produces exactly the single signed line and no itemized estimate', async () => {
  const normalized = normalizeHandoffPlan(plan(), NOW);
  assert.deepEqual(normalized.quote.line_items, [{ name: 'Garage cleanout and reset', qty: 1, total: 1400 }]);
  assert.equal(normalized.quote.line_items_count, 1);
  for (const key of ['itemized', 'estimate_line_items', 'catalog_version', 'duration_suggestion']) assert.equal(key in normalized.quote, false, key);
  const f = fixture(plan()), saved = await f.run(), job = f.rows.get(`jobs/${saved.job.id}`);
  assert.equal(job.estimate.lineItems, undefined); assert.equal(job.estimate.catalogVersion, undefined);
  assert.equal(job.durationOverride, undefined); assert.equal(job.materials, undefined); assert.equal('materials' in job.jobInstructions, false);
  assert.deepEqual(job.acceptedHandoffPayload.quote.line_items, [{ name: 'Garage cleanout and reset', qty: 1, total: 1400 }]);
  // The portal still reads one synthesized line for the signed total.
  assert.deepEqual(legacyLineItems(job).lineItems.map(line => line.totalCents), [140000]);
});

test('an itemized signed plan writes canonical estimate lines, catalog version, crew materials and itemized provider lines', async () => {
  const f = fixture(), saved = await f.run(), job = f.rows.get(`jobs/${saved.job.id}`);
  assert.deepEqual(job.estimate.lineItems.map(line => [line.id, line.selected, line.totalCents]), [['cleanout', true, 70000], ['shelving', true, 49900], ['pest-waste', true, 20000], ['totes', false, 8600], ['adjustment', true, 100]]);
  assert.deepEqual(job.estimate.lineItems[1].split, { productCents: 30000, laborCents: 9900, markupCents: 10000, disposalCents: 0, laborMinutes: 0 });
  assert.deepEqual(job.estimate.lineItems[1].catalog, { itemId: 'shelf-metal', version: 3 });
  assert.equal(job.estimate.catalogVersion, '2026-09-pest200-traps250');
  assert.equal(estimateTotals(job.estimate.lineItems).totalCents, 140000); assert.equal(job.estimate.amount, 1400); assert.equal(job.estimate.depositRequired, 700);
  assert.deepEqual(job.materials, [{ id: 'quote-shelving', name: 'Metal shelving unit', quantity: 1 }], 'the declined totes are not loaded');
  assert.deepEqual(job.jobInstructions.materials, job.materials);
  assert.equal(job.durationOverride, null);
  assert.deepEqual(job.acceptedHandoffPayload.quote.line_items, [{ name: 'Garage cleanout and reset', qty: 1, total: 700 }, { name: 'Metal shelving unit', qty: 1, total: 499 }, { name: 'Pest-waste cleanup', qty: 1, total: 200 }, { name: 'Price adjustment', qty: 1, total: 1 }]);
  assert.equal(job.acceptedHandoffPayload.quote.line_items_count, 4);
  assert.equal(f.rows.get(`walkthroughHandoffs/${f.input.requestId}`).plan.quote.itemized, true);
  const synced = savedHandoffPayload(job, f.input.requestId);
  assert.deepEqual(synced.quote.line_items, job.acceptedHandoffPayload.quote.line_items, 'the provider payload carries the itemized lines');
});

test('selected lines that do not add up to the signed total are rejected before any write', async () => {
  const f = fixture(itemized(p => { p.quote.line_items[0].unitCents = p.quote.line_items[0].totalCents = 69000; }));
  await assert.rejects(f.run(), e => e.code === 'handoff_invalid_amount' && e.status === 400 && /\$1,?390\.00|\$1390\.00/.test(e.message));
  assert.equal(f.calls.length, 0);
  // Selecting the declined optional totes also breaks the signed total.
  assert.throws(() => normalizeHandoffPlan(itemized(p => { p.quote.line_items[3].selected = true; }), NOW), e => e.code === 'handoff_invalid_amount');
});

test('a manual price change must be an explicit adjustment line that states its reason', () => {
  assert.throws(() => normalizeHandoffPlan(itemized(p => { p.quote.line_items[4].description = ''; }), NOW), e => e.code === 'handoff_invalid_adjustment');
  assert.throws(() => normalizeHandoffPlan(itemized(p => { Object.assign(p.quote.line_items[4], { optional: true, selected: true }); }), NOW), e => e.code === 'handoff_invalid_adjustment');
  assert.throws(() => normalizeHandoffPlan(itemized(p => { Object.assign(p.quote.line_items[4], { kind: 'service' }); }), NOW), e => e.code === 'handoff_invalid_adjustment');
  // Without the adjustment the lines no longer reach the manually locked total.
  assert.throws(() => normalizeHandoffPlan(itemized(p => { p.quote.line_items.pop(); }), NOW), e => e.code === 'handoff_invalid_amount');
  const discounted = normalizeHandoffPlan(itemized(p => { p.quote.total = 1350; p.quote.deposit = 675; p.quote.line_items[4] = { id: 'adjustment', kind: 'discount', name: 'Price adjustment', description: 'Repeat customer courtesy', quantity: 1, unitCents: -4900, totalCents: -4900 }; }), NOW);
  assert.deepEqual(discounted.quote.line_items.at(-1), { name: 'Price adjustment', qty: 1, total: -49 });
});

test('line items are validated strictly through the canonical quote model', () => {
  for (const [change, code] of [
    [p => { p.quote.line_items = []; }, 'handoff_invalid_line_items'],
    [p => { p.quote.line_items = 'one line'; }, 'handoff_invalid_line_items'],
    [p => { p.quote.line_items[0].totalCents = 69999; }, 'handoff_invalid_line_items'],
    [p => { p.quote.line_items[0].surprise = true; }, 'handoff_invalid_line_items'],
    [p => { p.quote.line_items[1].id = 'cleanout'; }, 'handoff_invalid_line_items'],
    [p => { p.quote.line_items[1].split.markupCents = 1; }, 'handoff_invalid_line_items'],
    [p => { p.quote.line_items.push({ id: 'tip', kind: 'tip', name: 'Crew tip', quantity: 1, unitCents: 500, totalCents: 500 }); }, 'handoff_invalid_line_items'],
    [p => { p.quote.catalog_version = 'bad version!'; }, 'handoff_invalid_plan'],
  ]) assert.throws(() => normalizeHandoffPlan(itemized(change), NOW), e => e.code === code && e.status === 400, String(change));
  // A required option group needs one of its options chosen.
  const group = { id: 'floor', label: 'Floor finish', selection: 'single', required: true };
  assert.throws(() => normalizeHandoffPlan(itemized(p => { p.quote.line_items[3] = { id: 'epoxy', kind: 'service', name: 'Epoxy floor', quantity: 1, unitCents: 90000, totalCents: 90000, group, selected: false }; }), NOW), e => e.code === 'handoff_invalid_line_items' && /Floor finish/.test(e.message));
  const chosen = normalizeHandoffPlan(itemized(p => { p.quote.total = 2300; p.quote.deposit = 1150; p.quote.line_items[3] = { id: 'epoxy', kind: 'service', name: 'Epoxy floor', quantity: 1, unitCents: 90000, totalCents: 90000, group, selected: true }; }), NOW);
  assert.equal(chosen.quote.line_items_count, 5);
});

test('the estimated duration is checked against line-item minutes and needs a manager reason to override', async () => {
  const timed = p => { p.quote.line_items[0].durationMinutes = 120; };
  // 120 person-minutes for a crew of two suggests 60 minutes on site; the plan says 180.
  assert.throws(() => normalizeHandoffPlan(itemized(timed), NOW), e => e.code === 'handoff_invalid_duration' && /60 minutes/.test(e.message));
  const matching = normalizeHandoffPlan(itemized(p => { timed(p); p.quote.estimated_duration_min = 60; }), NOW);
  assert.deepEqual([matching.quote.duration_suggestion, matching.quote.duration_override_reason], [{ minutes: 60, source: 'line_items' }, '']);
  const f = fixture(itemized(p => { timed(p); p.quote.duration_override_reason = 'Tight alley access adds carry time'; })), saved = await f.run(), job = f.rows.get(`jobs/${saved.job.id}`);
  assert.equal(job.estimatedDurationMin, 180);
  assert.deepEqual(job.durationOverride, { suggestedMinutes: 60, minutes: 180, reason: 'Tight alley access adds carry time', recordedBy: 'zacb', recordedAt: NOW });
  // Lines without minutes keep the walkthrough estimate as the suggestion.
  assert.deepEqual(normalizeHandoffPlan(itemized(), NOW).quote.duration_suggestion, { minutes: 180, source: 'estimated_duration' });
});

test('a line-items-only revision supersedes the approval and invoice but keeps payment receipts and manual materials', async () => {
  const f = fixture(), first = await f.run(), id = first.job.id, job = f.rows.get(`jobs/${id}`);
  Object.assign(job, { deposit: { ...job.deposit, paidAmount: 700, status: 'paid', providerReceiptId: 'receipt-1' }, payment: { verified: true, amount: 700, receiptId: 'receipt-1' }, invoice: { amount: 1400, status: 'open', number: 'INV-1', lineItems: job.estimate.lineItems }, materials: [...job.materials, { id: 'material-0-drop-cloth', name: 'Drop cloth', quantity: 2 }] });
  // Same total, deposit and scope: the homeowner re-signs with the adjustment folded into the cleanout line.
  const moved = itemized(p => { p.quote.line_items.pop(); p.quote.line_items[0] = { ...p.quote.line_items[0], unitCents: 70100, totalCents: 70100 }; p.acceptance.accepted_at = '2026-09-22T17:55:00.000Z'; });
  const change = f.revise(moved, id), revised = await saveWalkthroughHandoff(f.store, owner, change, NOW), current = f.rows.get(`jobs/${revised.job.id}`);
  assert.equal(revised.job.id, id);
  assert.equal(current.invoice.status, 'superseded'); assert.equal(current.invoice.supersededReason, 'walkthrough_revised');
  assert.equal(current.estimate.revision, 2); assert.equal(current.estimate.amount, 1400);
  assert.deepEqual(current.estimate.lineItems.map(line => line.id), ['cleanout', 'shelving', 'pest-waste', 'totes']);
  assert.equal(current.customerApproval.approvedAt, '2026-09-22T17:55:00.000Z'); assert.equal(current.acceptance.acceptedAt, '2026-09-22T17:55:00.000Z');
  assert.equal(current.deposit.paidAmount, 700); assert.equal(current.deposit.providerReceiptId, 'receipt-1'); assert.equal(current.deposit.status, 'paid');
  assert.deepEqual(current.payment, { verified: true, amount: 700, receiptId: 'receipt-1' });
  const receipt = f.rows.get(`walkthroughHandoffs/${change.requestId}`);
  assert.equal(receipt.priorEstimate.lineItems.at(-1).id, 'adjustment'); assert.equal(receipt.priorAcceptance.acceptedAt, '2026-09-22T17:45:00.000Z');
  assert.deepEqual(current.materials, [{ id: 'material-0-drop-cloth', name: 'Drop cloth', quantity: 2 }, { id: 'quote-shelving', name: 'Metal shelving unit', quantity: 1 }]);
});

test('an unitemized revision of itemized work drops the quote lines, quote materials and duration override and retires the invoice', async () => {
  const timed = p => { p.quote.line_items[0].durationMinutes = 120; p.quote.duration_override_reason = 'Tight alley access adds carry time'; };
  const f = fixture(itemized(timed)), first = await f.run(), id = first.job.id, job = f.rows.get(`jobs/${id}`);
  Object.assign(job, { invoice: { amount: 1400, status: 'open', number: 'INV-1' }, materials: [...job.materials, { id: 'material-0-drop-cloth', name: 'Drop cloth', quantity: 2 }] });
  assert.equal(job.durationOverride.reason, 'Tight alley access adds carry time');
  await saveWalkthroughHandoff(f.store, owner, f.revise(plan(), id), NOW);
  const current = f.rows.get(`jobs/${id}`);
  assert.equal(current.estimate.lineItems, undefined); assert.equal(current.estimate.catalogVersion, undefined); assert.equal(current.estimate.revision, 2);
  assert.equal(current.durationOverride, null); assert.equal('materials' in current.jobInstructions, false);
  assert.deepEqual(current.materials, [{ id: 'material-0-drop-cloth', name: 'Drop cloth', quantity: 2 }]);
  assert.equal(current.invoice.status, 'superseded');
  assert.deepEqual(legacyLineItems(current).lineItems.map(line => line.totalCents), [140000]);
});

test('a materials list Dispatch could not re-validate is left untouched instead of failing the signed save', async () => {
  const f = fixture();
  f.rows.get('jobs/w1').materials = ['Legacy tarp', { id: 'm1', name: 'Rope', quantity: 1 }];
  const saved = await f.run(), job = f.rows.get(`jobs/${saved.job.id}`);
  assert.deepEqual(job.materials, ['Legacy tarp', { id: 'm1', name: 'Rope', quantity: 1 }], 'the walkthrough list is copied as before');
  assert.deepEqual(job.jobInstructions.materials, [{ id: 'quote-shelving', name: 'Metal shelving unit', quantity: 1 }], 'the crew brief still lists the sold products');
  const g = fixture();
  g.rows.get('jobs/w1').materials = [{ id: 'm1', name: 'Rope', quantity: 1 }];
  const merged = await g.run();
  assert.deepEqual(g.rows.get(`jobs/${merged.job.id}`).materials, [{ id: 'm1', name: 'Rope', quantity: 1 }, { id: 'quote-shelving', name: 'Metal shelving unit', quantity: 1 }]);
  // Items that pass a loose check but break Dispatch's own rules (name length,
  // quantity cap, unique ids, list size) also leave the list alone.
  for (const materials of [
    [{ id: 'm1', name: 'R'.repeat(201), quantity: 1 }],
    [{ id: 'm1', name: 'Rope', quantity: 100001 }],
    [{ id: 'm1', name: 'Rope', quantity: 1 }, { id: 'm1', name: 'Tarp', quantity: 1 }],
    Array.from({ length: 100 }, (_, i) => ({ id: `m${i}`, name: `Item ${i}`, quantity: 1 })),
  ]) {
    const h = fixture();
    h.rows.get('jobs/w1').materials = materials;
    const saved = await h.run(), job = h.rows.get(`jobs/${saved.job.id}`);
    assert.deepEqual(job.materials, materials, `${materials.length} materials, first ${materials[0].name.slice(0, 12)}`);
    assert.equal(job.estimate.lineItems.length, 5, 'the itemized signed save still succeeds');
  }
  // A 200-character name is still within Dispatch's limit and merges.
  const k = fixture(), long = [{ id: 'm1', name: 'R'.repeat(200), quantity: 100000 }];
  k.rows.get('jobs/w1').materials = long;
  const kept = await k.run();
  assert.deepEqual(k.rows.get(`jobs/${kept.job.id}`).materials, [...long, { id: 'quote-shelving', name: 'Metal shelving unit', quantity: 1 }]);
});

test('an unchanged itemized revision keeps an open invoice; a legacy revision of legacy work is unchanged', async () => {
  const f = fixture(), first = await f.run(), id = first.job.id;
  f.rows.get(`jobs/${id}`).invoice = { amount: 1400, status: 'open', number: 'INV-1' };
  await saveWalkthroughHandoff(f.store, owner, f.revise(itemized(), id), NOW);
  assert.equal(f.rows.get(`jobs/${id}`).invoice.status, 'open');
  const g = fixture(plan()), legacy = await g.run();
  g.rows.get(`jobs/${legacy.job.id}`).invoice = { amount: 1400, status: 'open', number: 'INV-2' };
  await saveWalkthroughHandoff(g.store, owner, g.revise(plan(), legacy.job.id), NOW);
  assert.equal(g.rows.get(`jobs/${legacy.job.id}`).invoice.status, 'open');
  // An estimate last saved from the Hub dialog carries one bundled line; a
  // legacy re-handoff with the same price, deposit and scope keeps its invoice.
  const hubLine = [{ name: 'Garage transformation', description: 'Garage reset', quantity: 1, amount: 1400 }];
  Object.assign(g.rows.get(`jobs/${legacy.job.id}`), { estimate: { ...g.rows.get(`jobs/${legacy.job.id}`).estimate, lineItems: hubLine, source: 'egc_hub' } });
  await saveWalkthroughHandoff(g.store, owner, g.revise(plan(), legacy.job.id), NOW);
  assert.equal(g.rows.get(`jobs/${legacy.job.id}`).invoice.status, 'open');
  // A multi-line estimate from any writer is itemized, so dropping its lines retires the invoice.
  Object.assign(g.rows.get(`jobs/${legacy.job.id}`), { estimate: { ...g.rows.get(`jobs/${legacy.job.id}`).estimate, lineItems: [{ ...hubLine[0], amount: 900 }, { name: 'Shelving', quantity: 1, amount: 500 }] } });
  await saveWalkthroughHandoff(g.store, owner, g.revise(plan(), legacy.job.id), NOW);
  assert.equal(g.rows.get(`jobs/${legacy.job.id}`).invoice.status, 'superseded');
});

test('replaying a request identity with changed line items is an idempotency conflict', async () => {
  const f = fixture(), saved = await f.run();
  assert.equal((await f.run()).job.id, saved.job.id); assert.equal(f.calls.length, 1);
  f.input.plan.quote.line_items[0].description = 'Sorting and hauling only';
  await assert.rejects(f.run(), e => e.code === 'handoff_idempotency_conflict');
  f.input.plan = itemized(p => { p.quote.line_items[3].selected = true; p.quote.line_items[4] = { id: 'adjustment', kind: 'discount', name: 'Price adjustment', description: 'Totes included at no charge', quantity: 1, unitCents: -8500, totalCents: -8500 }; });
  await assert.rejects(f.run(), e => e.code === 'handoff_idempotency_conflict');
  assert.equal(f.calls.length, 1);
});

test('provider synchronization detects drift in the saved estimate lines', async () => {
  const f = fixture(), saved = await f.run(), job = f.rows.get(`jobs/${saved.job.id}`);
  assert.equal(savedHandoffPayload(job, f.input.requestId).quote.total, 1400);
  const drifted = structuredClone(job); drifted.estimate.lineItems[0].name = 'Garage cleanout';
  assert.throws(() => savedHandoffPayload(drifted, f.input.requestId), e => e.code === 'handoff_sync_snapshot_changed');
  const removed = structuredClone(job); delete removed.estimate.lineItems;
  assert.throws(() => savedHandoffPayload(removed, f.input.requestId), e => e.code === 'handoff_sync_snapshot_changed');
  const reselected = structuredClone(job); reselected.estimate.lineItems[3].selected = true;
  assert.throws(() => savedHandoffPayload(reselected, f.input.requestId), e => e.code === 'handoff_sync_snapshot_changed');
  // A legacy snapshot is still checked exactly as before.
  const g = fixture(plan()), legacy = await g.run(), legacyJob = g.rows.get(`jobs/${legacy.job.id}`);
  assert.equal(savedHandoffPayload(legacyJob, g.input.requestId).quote.line_items_count, 1);
});

test('the estimate scope is a customer-facing summary of sold finishes, never internal notes', async () => {
  const f = fixture(), saved = await f.run(), job = f.rows.get(`jobs/${saved.job.id}`);
  assert.equal(job.estimate.scope, 'Included: Garage cleanout and reset; 1 metal shelving unit; Pest-waste cleanup.');
  assert.doesNotMatch(JSON.stringify(job.estimate), /SYNTHETIC-INTERNAL-BRIEF|SYNTHETIC-CUSTOMER-NOTE|gate code|Blue bicycle/);
  assert.equal(customerScopeSummary({ finish: ['cleanout', 'deep_clean', 'pressure_wash', 'mouse_trapping', 'shelving', 'totes', 'secret internal finish'], finish_details: { shelf_type: 'wood', shelf_qty: 3, tote_qty: 1 } }), 'Included: Garage cleanout and reset; Deep clean; One-car garage pressure wash; Non-toxic mouse trapping; 3 wood shelving units; 1 storage tote.');
  assert.equal(customerScopeSummary({}), 'Included: Garage cleanout and reset.');
  assert.equal(customerScopeSummary({ finish: ['shelving', 'totes'], finish_details: { shelf_type: '<b>', shelf_qty: 0 } }), 'Included: Shelving; Storage totes.');
});

// The walkthrough page builds the lines from its own price list (recommend), so
// every pricing fixture must itemize to exactly the locked total the server checks.
const walkthrough = read('crew/gameplan.html');
function gameplan(overrides = {}) {
  const context = vm.createContext({ save() {}, render() {}, invalidateAcceptance() {}, validateStep: () => [], PHOTO_COUNT: 3, uid: () => 'synthetic-job', normPhone: value => value, buildInternalNotes: () => 'Synthetic brief', buildClientChecklists: () => ({ version: '2026-09-client-v1', preJob: [], postJob: [] }) });
  vm.runInContext(sourceLine(walkthrough, 'const freshState='), context);
  context.S = vm.runInContext('freshState()', context);
  Object.assign(context.S, { garageSize: '1', fill: 'medium', loads: '1', jobDate: '2026-10-01', startTime: '08:00', endTime: '13:00' }, overrides);
  for (const prefix of ['function recommend(', 'function estimatedJobMinutes(', 'function readyToSend(', 'function buildJobInstructions(', 'function signedLines(', 'function payload(']) vm.runInContext(sourceLine(walkthrough, prefix), context);
  return context;
}
const PRICING_FIXTURES = [
  ...['0.5', '1', '1.5', '2'].map(loads => ({ loads })), { loads: '', fill: 'light' }, { garageSize: '2', fill: 'packed' },
  { finish: ['cleanout', 'pressure_wash'] }, { finish: ['cleanout', 'deep_clean'] }, { finish: ['cleanout', 'deep_clean', 'pressure_wash'] },
  { garageSize: '2', loads: '1.5', finish: ['cleanout', 'deep_clean', 'shelving', 'totes'], shelfQty: 1, toteQty: 4 }, { finish: ['cleanout', 'pressure_wash', 'shelving'], shelfQty: 2 },
  { hazards: ['Mold / moisture', 'Sharp material'] }, { hazards: ['Pest waste', 'Mold / moisture'] }, { hazards: ['Pest waste', 'Pest waste'] }, { fill: 'light', loads: '0.25' },
  ...['1', '2', '3', 'other'].map(garageSize => ({ garageSize })), { special: ['Refrigerator / freezer', 'Tires', 'Paint / chemicals', 'Electronics', 'Appliances', 'Very heavy items'], access: ['Stairs'] }, { fill: 'light', loads: '0.25', hazards: ['Pest waste'] },
  { fill: 'light', loads: '0.25', finish: ['cleanout', 'mouse_trapping'] }, { fill: 'light', loads: '0.25', hazards: ['Pest waste'], finish: ['cleanout', 'mouse_trapping'] },
  ...['1', '2', '3', 'other'].map(garageSize => ({ garageSize, finish: ['cleanout', 'mouse_trapping'] })), { hazards: ['Pest waste'], finish: ['cleanout', 'pressure_wash', 'mouse_trapping'] },
  { fill: 'full', loads: '', special: ['Mattress', 'Piano / safe', 'Unlisted item'], access: ['Long carry', 'Stairs'], finish: ['cleanout', 'totes'], toteQty: 3, shelfType: 'plastic' },
  { fill: 'light', loads: '0.25', finish: ['cleanout', 'totes'], toteQty: 5 }, { garageSize: 'other', fill: 'packed', finish: ['cleanout', 'shelving'], shelfType: 'wood', shelfQty: 3 },
];

test('walkthrough line items add up to the locked total for every walkthrough-pricing fixture', () => {
  for (const overrides of PRICING_FIXTURES) {
    const h = gameplan(overrides), total = h.recommend(), items = h.recommend(true), quote = h.payload().quote;
    const label = JSON.stringify(overrides);
    assert.equal(quote.total, total, label);
    assert.equal(items.reduce((sum, line) => sum + line.totalCents, 0), Math.round(total * 100), label);
    assert.ok(items.every(line => line.totalCents > 0 && Number.isSafeInteger(line.totalCents)), label);
    assert.equal(items[0].id, 'cleanout', label);
    assert.equal(quote.line_items.some(line => line.id === 'adjustment'), false, label);
    assert.equal(quote.catalog_version, '2026-09-pest200-traps250');
    const normalized = normalizeHandoffPlan({ ...plan(), quote: { ...plan().quote, ...JSON.parse(JSON.stringify(quote)) }, scope: JSON.parse(JSON.stringify(h.payload().scope)) }, NOW);
    assert.equal(estimateTotals(normalized.quote.estimate_line_items).totalCents, Math.round(total * 100), label);
  }
  // One load ($1,000) plus $1,484 of add-ons rounds to $2,475, so the cleanout line carries $991 of it.
  const addOns = JSON.parse(JSON.stringify(gameplan({ hazards: ['Pest waste'], finish: ['cleanout', 'pressure_wash', 'mouse_trapping', 'shelving', 'totes'], shelfQty: 2, toteQty: 4 }).recommend(true)));
  assert.deepEqual(addOns.map(line => [line.id, line.quantity, line.unitCents]), [['cleanout', 1, 99100], ['pressure-wash', 1, 40000], ['shelving', 2, 49900], ['totes', 4, 2150], ['pest-waste', 1, 20000], ['mouse-trapping', 1, 25000]]);
});

test('a manually changed walkthrough rate sends an explicit adjustment line with the customer-facing reason', () => {
  const h = gameplan({ finish: ['cleanout', 'pressure_wash'], lockedPrice: '1500', priceManuallySet: true });
  assert.ok(Array.from(h.readyToSend()).includes('the customer-facing reason for the changed rate'));
  h.S.priceAdjustmentReason = 'Second haul trailer agreed on site';
  assert.equal(Array.from(h.readyToSend()).includes('the customer-facing reason for the changed rate'), false);
  const quote = h.payload().quote, adjustment = quote.line_items.at(-1);
  assert.deepEqual(JSON.parse(JSON.stringify(adjustment)), { id: 'adjustment', kind: 'fee', name: 'Price adjustment', description: 'Second haul trailer agreed on site', quantity: 1, unitCents: 10000, totalCents: 10000 });
  assert.equal(normalizeHandoffPlan({ ...plan(), quote: { ...plan().quote, ...JSON.parse(JSON.stringify(quote)) } }, NOW).quote.line_items.at(-1).total, 100);
  const lower = gameplan({ lockedPrice: '925.50', priceManuallySet: true, priceAdjustmentReason: 'Repeat customer courtesy' }).payload().quote;
  assert.deepEqual([lower.line_items.at(-1).kind, lower.line_items.at(-1).totalCents, lower.deposit], ['discount', -7450, 462.75]);
});

async function clientSave(planInput) {
  const source = read('crew/gameplan-handoff.js'), context = vm.createContext({ window: {}, URLSearchParams, AbortController, setTimeout, clearTimeout });
  vm.runInContext(source, context);
  const calls = [], records = new Map();
  const client = context.window.EGCWalkthroughHandoffClient({ actor: async () => 'zacb', storage: { getItem: k => records.get(k) || null, setItem: (k, v) => records.set(k, v), removeItem: k => records.delete(k) }, uuid: () => randomUUID(), plan: () => structuredClone(planInput), source: () => 'w1', savedJobId: () => '', photoDraftId: () => 'local-photos', accept() {},
    fetch: async (url, options = {}) => { const body = options.body ? JSON.parse(options.body) : null; calls.push({ url, body, raw: options.body }); return { ok: true, status: 200, json: async () => url.startsWith('/api/walkthrough-handoff?') ? { ok: true, viewer: { id: 'zacb' }, customerId: 'c1', sourceRevision: 'w1r', jobId: '' } : { ok: true, requestId: body.requestId, job: { id: 'job-1', customerId: 'c1' }, warnings: [] } }; } });
  await client.save();
  return calls.at(-1);
}

test('the signed handoff client forwards the itemized lines, catalog version and duration override reason', async () => {
  const sent = (await clientSave({ ...itemized(p => { p.quote.duration_override_reason = 'Tight alley access'; }), raw: { internal: 'not sent' } })).body.plan;
  assert.deepEqual(sent.quote.line_items, lines()); assert.equal(sent.quote.catalog_version, '2026-09-pest200-traps250');
  assert.equal(sent.quote.duration_override_reason, 'Tight alley access');
  assert.equal(sent.raw, undefined);
  // A legacy plan's frozen request body carries no itemized keys at all, so it still fingerprints as before.
  const legacy = await clientSave(plan());
  assert.doesNotMatch(legacy.raw, /line_items|catalog_version|duration_override_reason/);
  assert.equal(normalizeHandoffPlan(legacy.body.plan, NOW).quote.line_items_count, 1);
});

test('the HighLevel job brief lists itemized lines and leaves a legacy single-line brief unchanged', () => {
  const source = read('functions/api/highlevel.js'), context = vm.createContext({});
  vm.runInContext(source.slice(source.indexOf('function finishSummary('), source.indexOf('function closeoutNote(')), context);
  const normalized = normalizeHandoffPlan(itemized(), NOW), legacy = normalizeHandoffPlan(plan(), NOW);
  const brief = context.noteBody({ ...normalized, sent_at: NOW });
  assert.match(brief, /Itemized quote:\n- Garage cleanout and reset: \$700\.00\n- Metal shelving unit: \$499\.00\n- Pest-waste cleanup: \$200\.00\n- Price adjustment: \$1\.00\n/);
  assert.doesNotMatch(brief, /Storage tote/, 'declined options are not listed as sold');
  assert.doesNotMatch(context.noteBody({ ...legacy, sent_at: NOW }), /Itemized quote/);
  const discounted = context.noteBody({ ...normalized, sent_at: NOW, quote: { ...normalized.quote, line_items: [{ name: 'Price adjustment', qty: 1, total: -49 }, { name: 'Storage tote', qty: 4, total: 86 }] } });
  assert.match(discounted, /- Price adjustment: -\$49\.00\n- Storage tote × 4: \$86\.00/);
});

test('the review screen shows the homeowner the itemized lines, including a price adjustment and its reason, above the signature', () => {
  const h = gameplan({ finish: ['cleanout', 'pressure_wash', 'totes'], toteQty: 4, lockedPrice: '1575', priceManuallySet: true, priceAdjustmentReason: 'Second haul <trailer> agreed on site' });
  vm.runInContext([sourceLine(walkthrough, 'const $=id=>'), sourceLine(walkthrough, 'const money='), sourceLine(walkthrough, 'function quoteLinesMarkup('), sourceLine(walkthrough, 'function depositSummary('), sourceLine(walkthrough, 'function durationText('), sourceLine(walkthrough, 'function reviewScreen(')].join('\n'), h);
  Object.assign(h, { buildJobInstructions: () => ({}), buildClientChecklists: () => ({ preJob: [], postJob: [] }) });
  const html = h.reviewScreen(), lines = html.slice(html.indexOf('id="quote-lines"'), html.indexOf('<div class="approve">'));
  assert.ok(html.indexOf('id="quote-lines"') > 0 && html.indexOf('id="quote-lines"') < html.indexOf('id="signature"'), 'the lines are shown before the homeowner signs');
  assert.match(lines, /Garage cleanout and reset<\/span><b>\$989\.00<\/b>/);
  assert.match(lines, /One-car garage pressure wash<\/span><b>\$400\.00<\/b>/);
  assert.match(lines, /Storage tote × 4<\/span><b>\$86\.00<\/b>/);
  assert.match(lines, /Price adjustment — Second haul &lt;trailer&gt; agreed on site<\/span><b>\$100\.00<\/b>/);
  assert.doesNotMatch(lines, /<trailer>/, 'the reason is escaped');
  // The list is exactly what the signed payload sends.
  const sent = h.payload().quote.line_items;
  assert.equal((lines.match(/class="quote-line"/g) || []).length, sent.length);
  assert.equal(sent.reduce((sum, line) => sum + line.totalCents, 0), 157500);
});

test('typing a new rate or reason refreshes the itemized lines shown for signature', () => {
  const nodes = { 'quote-lines': { innerHTML: '' }, 'deposit-summary': { textContent: '' } };
  const h = gameplan({ finish: ['cleanout'], priceManuallySet: true });
  vm.runInContext([sourceLine(walkthrough, 'const $=id=>'), sourceLine(walkthrough, 'function quoteLinesMarkup('), sourceLine(walkthrough, 'function depositSummary('), sourceLine(walkthrough, 'function updateField(')].join('\n'), h);
  h.document = { getElementById: id => nodes[id] };
  h.updateField('lockedPrice', '950');
  assert.match(nodes['quote-lines'].innerHTML, /Price adjustment<\/span><b>-\$50\.00<\/b>/);
  h.updateField('priceAdjustmentReason', 'Repeat customer courtesy');
  assert.match(nodes['quote-lines'].innerHTML, /Price adjustment — Repeat customer courtesy<\/span><b>-\$50\.00<\/b>/);
  h.updateField('lockedPrice', '1000');
  assert.doesNotMatch(nodes['quote-lines'].innerHTML, /Price adjustment/);
});

test('the signed deposit is half the total in cents, so odd-cent manual rates pass the server check', () => {
  for (const lockedPrice of ['263.03', '1000.01', '1425', '999.99', '2475.05']) {
    const h = gameplan({ lockedPrice, priceManuallySet: true, priceAdjustmentReason: 'Agreed on site' }), quote = JSON.parse(JSON.stringify(h.payload().quote));
    assert.equal(Math.round(quote.deposit * 100), Math.round(Math.round(Number(lockedPrice) * 100) / 2), lockedPrice);
    assert.equal(normalizeHandoffPlan({ ...plan(), quote: { ...plan().quote, ...quote } }, NOW).quote.deposit, quote.deposit, lockedPrice);
  }
  const w = vm.createContext({});
  vm.runInContext(sourceLine(walkthrough, 'function walkthroughDeposit('), w);
  assert.equal(w.walkthroughDeposit(263.03).amount, 131.52);
});
