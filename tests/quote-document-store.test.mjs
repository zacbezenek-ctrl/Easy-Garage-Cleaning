import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { approveQuoteDocument, readQuoteDocument, quoteDocumentSnapshotId, QUOTE_DOCUMENT_COLLECTIONS as C } from '../functions/_lib/quote-document-store.js';
import { quoteDocumentHandlers } from '../functions/api/quote-document.js';
import { estimateFingerprint, normalizeLineItems } from '../functions/_lib/quote-model.js';
import { FINAL_25_75 } from '../functions/_lib/quote-payment-policy.js';

const NOW = '2026-10-15T20:00:00.000Z';
const ENV = { EGC_STAFF_ROLE_PERMISSIONS: 'true' };
const owner = { user: 'zacb', role: 'owner', businessAccess: true };
const rep = { user: 'rep1', role: 'sales', staffRoles: ['sales'], businessAccess: false };
const clone = value => structuredClone(value);
function fixture() {
  const job = { id: 'job1', revision: 'j1', type: 'job', status: 'unscheduled', customerId: 'customer1', propertyId: 'property1', sourceWalkthroughId: 'walk1',
    customer: 'Synthetic Customer', phone: '9705550100', email: 'customer@example.invalid', address: '100 Fixture Lane', highlevelContactId: 'contact1', title: 'Garage reset', date: '2026-10-24', quoteDraft: { createdBy: 'rep1' },
    estimate: { number: 'EST-001', revision: 1, status: 'draft', amountCents: 100001, amount: 1000.01, depositRequiredCents: 25000, depositRequired: 250, depositPct: 25, currency: 'USD', scope: 'Clean and organize the garage.', termsVersion: 'terms1', commercialPolicy: { ...FINAL_25_75 }, lineItems: normalizeLineItems([{ id: 'service1', kind: 'service', name: 'Garage reset', quantity: 1, unitCents: 100001 }], { strict: true }).lineItems },
    payment: { verified: true, amount: 800 }, internalNotes: 'PRIVATE_NOTES', signature: 'PRIVATE_SIGNATURE',
  };
  const context = { id: 'job1', revision: 'ctx1', status: 'reviewed', evidenceId: 'reviewed-context-1', reviewedBy: 'owner1', reviewedAt: NOW, jobId: 'job1', customerId: 'customer1', propertyId: 'property1', estimateRevision: 1, estimateFingerprint: estimateFingerprint(job.estimate), locationId: 'location1', scopeExclusions: ['Hazardous materials'],
    tax: { status: 'verified', amountCents: 0, treatment: 'not_applicable', summary: 'Reviewed synthetic tax treatment', evidenceId: 'tax1' },
    legal: { termsVersion: 'terms1', templateVersion: 'template1', textDigest: 'a'.repeat(64), evidenceId: 'legal1', refundTerms: 'Approved fixture reference' }, policyException: null,
    signerRoles: [{ role: 'customer', partyId: 'customer1', name: 'Synthetic Customer', email: 'customer@example.invalid', authorityEvidenceId: 'signer1' }, { role: 'company', partyId: 'company1', name: 'Representative', email: 'company@example.invalid', authorityEvidenceId: 'signer2' }],
  };
  const rows = new Map([
    ['jobs/job1', job], ['customers/customer1', { id: 'customer1', revision: 'c1', highlevelContactId: 'contact1', name: 'Synthetic Customer' }],
    ['properties/property1', { id: 'property1', revision: 'p1', customerId: 'customer1', address: '100 Fixture Lane' }],
    ['jobs/walk1', { id: 'walk1', revision: 'w1', type: 'walkthrough', customerId: 'customer1', date: '2026-10-10', assignedCrew: ['rep1'] }], [`${C.contexts}/job1`, context],
  ]);
  let n = 0, before = async () => {}, after = async () => {};
  const writes = [], reads = [];
  const store = {
    read: async (collection, id) => { reads.push(`${collection}/${id}`); return clone(rows.get(`${collection}/${id}`) || null); },
    commit: async batch => {
      await before(batch);
      const seen = new Set();
      for (const write of batch) {
        const key = `${write.collection}/${write.id}`, previous = rows.get(key);
        assert.equal(seen.has(key), false, 'one write/verify per record'); seen.add(key);
        if (write.revision ? previous?.revision !== write.revision : Boolean(previous)) throw Object.assign(new Error('CAS conflict'), { code: 'dispatch_revision_conflict' });
      }
      writes.push(clone(batch));
      for (const write of batch) if (!write.verify) rows.set(`${write.collection}/${write.id}`, { ...clone(write.patch), id: write.id, revision: `saved-${++n}` });
      await after(batch);
    },
  };
  return { rows, job, context, store, writes, reads, before: fn => { before = fn; }, after: fn => { after = fn; } };
}
const query = (jobId = 'job1') => ({ jobId, documentKind: 'service_agreement' });
const preview = (f, actor = owner, q = query()) => readQuoteDocument(f.store, actor, q, NOW, { env: ENV, enabled: true });
async function input(f, actor = owner, q = query()) {
  const p = await preview(f, actor, q);
  return { ...q, requestId: randomUUID(), expectedJobRevision: p.binding.jobRevision, expectedEstimateRevision: p.binding.estimateRevision, expectedEstimateFingerprint: p.binding.estimateFingerprint, expectedContextRevision: p.contextRevision, expectedContextDigest: p.binding.contextDigest };
}
const save = (f, body, actor = owner) => approveQuoteDocument(f.store, actor, body, NOW, { env: ENV, enabled: true });
const rejects = (promise, code) => assert.rejects(promise, e => e.code === `quote_document_${code}`);

test('GET prepares review from server records without approving, saving, exposing secrets or inferring collection', async () => {
  const f = fixture(), p = await preview(f);
  assert.equal(p.reviewState, 'awaiting_internal_approval'); assert.deepEqual(p.blockers, []);
  assert.equal(p.quote.amountCents, 100001); assert.equal(p.deliveryStatus, 'unsent_draft_only');
  assert.equal(p.review.state, 'unapproved_internal_review');
  assert.equal(p.review.serviceItems[0].totalCents, 100001);
  assert.equal(p.review.paymentSchedule.depositDueDate, '2026-10-17');
  assert.equal(p.review.paymentSchedule.remainderCents, 75001);
  assert.equal('canonicalApproval' in p.review, false);
  assert.equal(f.writes.length, 0);
  for (const value of ['PRIVATE_NOTES', 'PRIVATE_SIGNATURE', 'verified', 'payment', 'split', 'catalog']) assert.equal(JSON.stringify(p).includes(`"${value}"`), false);
});

test('explicit approval atomically saves immutable snapshot, approval, index, request receipt and audit; source jobs stay unchanged', async () => {
  const f = fixture(), source = clone([...f.rows]), body = await input(f), result = await save(f, body);
  assert.equal(result.replayed, false); assert.equal(result.snapshot.state, 'unsent_draft_only');
  assert.equal(result.snapshot.draft.payload.paymentCollected.status, 'unknown');
  assert.equal(result.snapshot.draft.payload.acceptance.status, 'unverified');
  assert.equal(result.snapshot.draft.payload.paymentSchedule.remainderCents, 75001);
  assert.equal(result.snapshot.draft.payload.provenance.review.approvedBy, 'zacb');
  assert.equal(f.writes.length, 1);
  const current = await preview(f);
  assert.equal(current.reviewState, 'already_snapshotted');
  assert.equal(current.currentSnapshot.matchesCurrentQuote, true);
  assert.equal(current.currentSnapshot.state, 'unsent_draft_only');
  const mutations = f.writes[0].filter(w => !w.verify);
  assert.deepEqual(new Set(mutations.map(w => w.collection)), new Set([C.snapshots, C.approvals, C.heads, C.receipts, 'hub_audit']));
  assert.ok(mutations.every(w => !w.revision), 'first write is create-only');
  assert.deepEqual(f.writes[0].filter(w => w.verify).map(w => w.collection).sort(), [C.contexts, 'customers', 'jobs', 'jobs', 'properties'].sort());
  for (const [key, row] of source) assert.deepEqual(f.rows.get(key), row, key);
});

test('same request and a second request replay one immutable snapshot; request IDs cannot change content', async () => {
  const f = fixture(), body = await input(f), first = await save(f, body), again = await save(f, body);
  assert.equal(again.replayed, true); assert.equal(f.writes.length, 1);
  const secondRequest = { ...body, requestId: randomUUID() }, second = await save(f, secondRequest);
  assert.equal(second.replayed, true); assert.equal(second.snapshot.snapshotId, first.snapshot.snapshotId);
  assert.deepEqual(f.writes[1].filter(w => !w.verify).map(w => w.collection), [C.receipts]);
  await rejects(save(f, { ...secondRequest, documentKind: 'proposal' }), 'request_conflict');
});

test('concurrent requests and concurrent copies claim exactly one snapshot and approval', async () => {
  for (const sameRequest of [true, false]) {
    const f = fixture(), a = await input(f), b = sameRequest ? clone(a) : { ...a, requestId: randomUUID() };
    const results = await Promise.all([save(f, a), save(f, b)]);
    assert.equal(new Set(results.map(r => r.snapshot.snapshotId)).size, 1);
    const created = collection => f.writes.flat().filter(w => !w.verify && w.collection === collection).length;
    assert.equal(created(C.snapshots), 1); assert.equal(created(C.approvals), 1);
    assert.equal(created(C.receipts), sameRequest ? 1 : 2);
  }
});

test('lost response returns committed outcome; unknown outcome without receipt does not claim success', async () => {
  const f = fixture(), body = await input(f);
  f.after(async () => { throw new Error('response lost'); });
  assert.equal((await save(f, body)).replayed, true); assert.equal(f.writes.length, 1);
  const g = fixture(), other = await input(g);
  g.before(async () => { throw new Error('unavailable'); });
  await rejects(save(g, other), 'outcome_unknown'); assert.equal(g.writes.length, 0);
});

test('stale client versions, changing source records and conflicting content at one revision are rejected', async () => {
  for (const field of ['expectedJobRevision', 'expectedContextRevision', 'expectedContextDigest', 'expectedEstimateFingerprint', 'expectedEstimateRevision']) {
    const f = fixture(), body = await input(f);
    body[field] = field === 'expectedEstimateRevision' ? 2 : /Digest|Fingerprint/.test(field) ? 'b'.repeat(64) : 'stale';
    await rejects(save(f, body), 'revision_conflict'); assert.equal(f.writes.length, 0);
  }
  const f = fixture(), body = await input(f); await save(f, body);
  f.job.revision = 'j2'; f.job.estimate.scope = 'Different scope'; f.context.estimateFingerprint = estimateFingerprint(f.job.estimate); f.context.revision = 'ctx2';
  await rejects(save(f, await input(f)), 'revision_conflict');
  const g = fixture(), before = await input(g); let changed = false;
  g.before(async () => { if (!changed) { changed = true; g.job.revision = 'j-raced'; } });
  await rejects(save(g, before), 'revision_conflict'); assert.equal(g.writes.length, 0);
});

test('new estimate revision makes a new snapshot and never overwrites the earlier one', async () => {
  const f = fixture(), first = await save(f, await input(f)), stored = clone(f.rows.get(`${C.snapshots}/${first.snapshot.snapshotId}`));
  f.job.estimate.revision = 2; f.job.revision = 'j2'; f.context.estimateRevision = 2; f.context.revision = 'ctx2';
  const second = await save(f, await input(f));
  assert.notEqual(second.snapshot.snapshotId, first.snapshot.snapshotId);
  assert.deepEqual(f.rows.get(`${C.snapshots}/${first.snapshot.snapshotId}`), stored);
  f.job.estimate.revision = 1; f.job.revision = 'j1'; f.context.estimateRevision = 1; f.context.revision = 'ctx1';
  await rejects(save(f, await input(f)), 'revision_stale');
});

test('a concurrent newer head prevents an old revision from claiming a snapshot', async () => {
  const f = fixture(), body = await input(f); let changed = false;
  f.before(async writes => {
    if (changed) return; changed = true;
    const head = writes.find(w => w.collection === C.heads);
    f.rows.set(`${C.heads}/${head.id}`, { ...head.patch, id: head.id, revision: 'head-raced', estimateRevision: 2 });
  });
  await rejects(save(f, body), 'revision_stale');
  assert.equal(f.writes.length, 0);
});

test('customer, property, context and walkthrough races fail without persisting any approval', async () => {
  for (const mutate of [
    f => { f.context.revision = 'ctx-raced'; },
    f => { f.rows.get('properties/property1').revision = 'p-raced'; f.rows.get('properties/property1').address = 'Changed site'; },
    f => { f.rows.get('customers/customer1').revision = 'c-raced'; f.rows.get('customers/customer1').highlevelContactId = 'foreign'; },
    f => { f.rows.get('jobs/walk1').revision = 'w-raced'; f.rows.get('jobs/walk1').date = '2026-10-20'; },
  ]) {
    const f = fixture(), body = await input(f); let changed = false;
    f.before(async () => { if (!changed) { changed = true; mutate(f); } });
    await assert.rejects(save(f, body), e => /^quote_document_(revision_conflict|lineage_mismatch)$/.test(e.code));
    assert.equal(f.writes.length, 0);
  }
});

test('two jobs for one contact keep independent immutable snapshots and revision indexes', async () => {
  const f = fixture(), other = clone(f.job), context = clone(f.context);
  Object.assign(other, { id: 'job2', revision: 'j2', propertyId: 'property2', address: '200 Fixture Lane' }); other.estimate.number = 'EST-002';
  Object.assign(context, { id: 'job2', jobId: 'job2', propertyId: 'property2', estimateFingerprint: estimateFingerprint(other.estimate) });
  f.rows.set('jobs/job2', other); f.rows.set(`${C.contexts}/job2`, context);
  f.rows.set('properties/property2', { id: 'property2', revision: 'p2', customerId: 'customer1', address: other.address });
  const one = await save(f, await input(f)), two = await save(f, await input(f, owner, query('job2')));
  assert.notEqual(one.snapshot.snapshotId, two.snapshot.snapshotId);
  assert.equal(one.snapshot.draft.payload.contact.contactId, two.snapshot.draft.payload.contact.contactId);
  assert.equal(one.snapshot.draft.payload.jobsite.address, '100 Fixture Lane');
  assert.equal(two.snapshot.draft.payload.jobsite.address, '200 Fixture Lane');
});

test('historical issued snapshot reads its frozen values while current quote has another revision', async () => {
  const f = fixture(), result = await save(f, await input(f)), key = result.snapshot.snapshotId;
  f.rows.set(`${C.issues}/${key}`, { snapshotId: key, jobId: 'job1', contentDigest: result.snapshot.draft.contentDigest, issuedAt: NOW });
  f.job.revision = 'j2'; f.job.estimate.revision = 2; f.job.estimate.amountCents = 200000;
  const historical = await readQuoteDocument(f.store, owner, { ...query(), estimateRevision: 1 }, NOW, { env: ENV, enabled: true });
  assert.equal(historical.snapshot.state, 'issued'); assert.equal(historical.snapshot.matchesCurrentQuote, false);
  assert.equal(historical.snapshot.draft.payload.totals.totalCents, 100001);
  assert.equal(f.writes.length, 1, 'history reads do not rewrite anything');
  f.rows.get(`${C.issues}/${key}`).contentDigest = 'b'.repeat(64);
  await rejects(readQuoteDocument(f.store, owner, { ...query(), estimateRevision: 1 }, NOW, { env: ENV, enabled: true }), 'issuance_unverified');
});

test('reapproving a current issued snapshot only records the new request receipt and preserves the issue', async () => {
  const f = fixture(), first = await save(f, await input(f)), key = first.snapshot.snapshotId;
  const issued = { snapshotId: key, jobId: 'job1', contentDigest: first.snapshot.draft.contentDigest, issuedAt: NOW };
  f.rows.set(`${C.issues}/${key}`, issued);
  const before = clone(f.rows.get(`${C.snapshots}/${key}`));
  const result = await save(f, await input(f));
  assert.equal(result.snapshot.state, 'issued');
  assert.deepEqual(f.rows.get(`${C.snapshots}/${key}`), before);
  assert.deepEqual(f.rows.get(`${C.issues}/${key}`), issued);
  assert.deepEqual(f.writes[1].filter(w => !w.verify).map(w => w.collection), [C.receipts]);
});

test('reviewed legacy payment terms survive authenticated approval and historical storage', async () => {
  const f = fixture(); delete f.job.estimate.commercialPolicy;
  Object.assign(f.job.estimate, { depositRequired: 500.01, depositRequiredCents: 50001, depositPct: 50,
    paymentSchedule: { depositCents: 50001, remainderCents: 50000, depositDueDate: '2026-10-15', remainderDueDate: '2026-10-26', timeZone: 'America/Denver', policyVersion: 'legacy-50' } });
  f.context.policyException = { kind: 'legacy_terms', status: 'approved', approvedBy: 'zacb', approvedAt: NOW, evidenceId: 'legacy-review', reason: 'Preserve signed customer terms', paymentPolicy: { version: 'legacy-50', depositPct: 50, remainderPct: 50, depositDueRule: 'signed_due_date', remainderDueRule: 'signed_due_date' } };
  f.context.estimateFingerprint = estimateFingerprint(f.job.estimate);
  const original = clone(f.job), result = await save(f, await input(f));
  assert.equal(result.snapshot.draft.payload.paymentPolicy.depositPct, 50);
  assert.equal(result.snapshot.draft.payload.paymentSchedule.remainderDueDate, '2026-10-26');
  assert.equal(result.snapshot.draft.payload.policyException.kind, 'legacy_terms');
  assert.deepEqual(f.job, original);
});

test('foreign reps, display-name assignment, crew, unauthenticated and disabled access cannot save', async () => {
  const f = fixture(), body = await input(f);
  assert.equal((await save(f, body, rep)).snapshot.approvedBy, 'rep1');
  const foreign = { ...rep, user: 'rep2' };
  f.job.assignedCrew = [{ name: 'rep2' }];
  await rejects(save(f, { ...body, requestId: randomUUID() }, foreign), 'forbidden');
  for (const actor of [null, { user: 'crew1', role: 'crew' }]) await assert.rejects(save(f, body, actor), e => /^quote_(sign_in_required|forbidden)$/.test(e.code));
  await rejects(approveQuoteDocument(f.store, owner, body, NOW, { env: {} }), 'disabled');
  assert.equal(f.writes.length, 1);
});

test('ownership is rechecked even for a previously committed request', async () => {
  const f = fixture(), body = await input(f, rep); await save(f, body, rep);
  f.job.quoteDraft.createdBy = 'rep2'; f.rows.get('jobs/walk1').assignedCrew = ['rep2'];
  await rejects(save(f, body, rep), 'forbidden'); assert.equal(f.writes.length, 1);
});

test('current and historical access never derive ownership from a non-walkthrough source', async () => {
  for (const mutate of [
    f => { f.rows.get('jobs/walk1').type = 'job'; },
    f => { f.rows.get('jobs/walk1').customerId = 'other-customer'; },
    f => { f.rows.get('jobs/walk1').recordType = 'template'; },
    f => { f.rows.delete('jobs/walk1'); },
  ]) {
    const f = fixture(); await save(f, await input(f));
    f.job.quoteDraft.createdBy = 'rep2';
    mutate(f);
    await rejects(preview(f, rep), 'lineage_mismatch');
    await rejects(readQuoteDocument(f.store, rep, { ...query(), estimateRevision: 1 }, NOW, { env: ENV, enabled: true }), 'lineage_mismatch');
    assert.equal(f.writes.length, 1);
  }
});

test('missing or corrupted revision heads block receipts and duplicate approvals without repair', async () => {
  for (const corrupt of ['missing', 'behind', 'digest', 'missing-target']) {
    const f = fixture(), body = await input(f); await save(f, body);
    const key = [...f.rows.keys()].find(key => key.startsWith(C.heads + '/'));
    if (corrupt === 'missing') f.rows.delete(key);
    else if (corrupt === 'behind') f.rows.get(key).estimateRevision = 0;
    else if (corrupt === 'digest') f.rows.get(key).contentDigest = 'b'.repeat(64);
    else { f.rows.get(key).estimateRevision = 2; f.rows.get(key).snapshotId = quoteDocumentSnapshotId('job1', 'service_agreement', 2); }
    await rejects(save(f, body), 'snapshot_invalid');
    await rejects(save(f, { ...body, requestId: randomUUID() }), 'snapshot_invalid');
    await rejects(readQuoteDocument(f.store, owner, { ...query(), estimateRevision: 1 }, NOW, { env: ENV, enabled: true }), 'snapshot_invalid');
    assert.equal(f.writes.length, 1, 'reconciliation must not silently reconstruct a head');
  }
});

test('negative/invalid canonical money and saved installments block before any writes', async () => {
  for (const mutate of [
    f => { f.job.estimate.amountCents = -1; f.job.estimate.amount = -0.01; },
    f => { f.job.estimate.lineItems[0].unitCents = -100; },
    f => { f.job.estimate.paymentSchedule = { depositCents: -1, remainderCents: 100002, depositDueDate: '2026-10-17', remainderDueDate: '2026-10-24', timeZone: 'America/Denver', policyVersion: FINAL_25_75.version }; },
  ]) {
    const f = fixture(); mutate(f); f.context.estimateFingerprint = estimateFingerprint(f.job.estimate);
    const p = await preview(f); assert.equal(p.reviewState, 'blocked');
    await rejects(save(f, await input(f)), 'blocked'); assert.equal(f.writes.length, 0);
  }
});

test('reviewed contexts and canonical lineage are mandatory; form prices, approval and bindings are rejected', async () => {
  for (const [mutate, code] of [
    [f => { f.rows.delete(`${C.contexts}/job1`); }, 'context_missing'],
    [f => { f.context.status = 'draft'; }, 'context_stale'],
    [f => { f.context.estimateFingerprint = 'b'.repeat(64); }, 'context_stale'],
    [f => { f.rows.get('properties/property1').customerId = 'customer2'; }, 'lineage_mismatch'],
    [f => { f.rows.get('customers/customer1').highlevelContactId = 'foreign'; }, 'lineage_mismatch'],
  ]) { const f = fixture(); mutate(f); await rejects(preview(f), code); assert.equal(f.writes.length, 0); }
  const f = fixture(), body = await input(f);
  for (const field of ['price', 'canonicalApproval', 'tax', 'nativeBinding', 'actorId', 'paymentCollected']) await rejects(save(f, { ...body, [field]: 'tampered' }), 'invalid_request');
  assert.equal(f.writes.length, 0);
});

test('an existing snapshot with changed digest or mismatched identity fails closed', async () => {
  for (const field of ['contentDigest', 'customerId']) {
    const f = fixture(), first = await save(f, await input(f)), row = f.rows.get(`${C.snapshots}/${first.snapshot.snapshotId}`);
    row[field] = field === 'contentDigest' ? 'b'.repeat(64) : 'foreign';
    await rejects(readQuoteDocument(f.store, owner, { ...query(), estimateRevision: 1 }, NOW, { env: ENV, enabled: true }), 'snapshot_invalid');
  }
  const f = fixture(), first = await save(f, await input(f));
  f.rows.get(`${C.snapshots}/${first.snapshot.snapshotId}`).draft.display.total = '$0.01';
  await rejects(readQuoteDocument(f.store, owner, { ...query(), estimateRevision: 1 }, NOW, { env: ENV, enabled: true }), 'snapshot_invalid');
});

test('HTTP boundary enforces session, same-origin, JSON limits and a single explicit internal approval action', async () => {
  const f = fixture(); let actor = owner;
  const handlers = quoteDocumentHandlers({ session: async () => actor, storage: () => f.store, now: () => new Date(NOW), enabled: true });
  const request = (method, body, headers = {}, q = '') => new Request(`https://easygaragecleaning.com/api/quote-document${q}`, { method, headers: { Origin: 'https://easygaragecleaning.com', 'Content-Type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const get = await handlers.get({ request: request('GET', undefined, {}, '?jobId=job1&documentKind=proposal'), env: ENV });
  assert.equal(get.status, 200); assert.equal(get.headers.get('Cache-Control'), 'no-store');
  const body = { action: 'approve_and_snapshot', ...await input(f) };
  assert.equal((await handlers.post({ request: request('POST', body, { Origin: 'https://other.invalid' }), env: ENV })).status, 403);
  assert.equal((await handlers.post({ request: request('POST', body, { 'Content-Type': 'text/plain' }), env: ENV })).status, 415);
  assert.equal((await handlers.post({ request: request('POST', { ...body, junk: 'a'.repeat(5000) }), env: ENV })).status, 413);
  for (const action of ['send', 'sign', 'charge', 'issue', 'activate']) assert.equal((await handlers.post({ request: request('POST', { ...body, action }), env: ENV })).status, 400);
  actor = null; assert.equal((await handlers.post({ request: request('POST', body), env: ENV })).status, 401);
  actor = owner; assert.equal((await handlers.post({ request: request('POST', body), env: ENV })).status, 200);
  assert.equal((await handlers.get({ request: request('GET', undefined, {}, '?jobId=job1&jobId=job2&documentKind=proposal'), env: ENV })).status, 400);
  assert.equal((await handlers.get({ request: request('GET', undefined, {}, '?jobId=job1&documentKind=proposal&estimateRevision=1.5'), env: ENV })).status, 400);
});

test('new collections have no browser SDK access and the endpoint has no delivery or pricing dependencies', () => {
  const rules = readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8');
  assert.match(rules, /match \/\{document=\*\*\} \{\s*allow read, write: if false;/);
  for (const collection of Object.values(C)) assert.equal(rules.includes(`match /${collection}/`), false, `${collection} relies on existing default deny`);
  const service = readFileSync(new URL('../functions/_lib/quote-document-store.js', import.meta.url), 'utf8');
  assert.doesNotMatch(service, /from ['"].*(?:stripe|highlevel|messenger|money-service|catalog)/);
  assert.equal(quoteDocumentSnapshotId('job1', 'proposal', 1), quoteDocumentSnapshotId('job1', 'proposal', 1));
  assert.notEqual(quoteDocumentSnapshotId('job1', 'proposal', 1), quoteDocumentSnapshotId('job2', 'proposal', 1));
});

test('exported handler defaults remain disabled without any source reads or writes', async () => {
  const f = fixture();
  const handlers = quoteDocumentHandlers({ session: async () => owner, storage: () => f.store, now: () => new Date(NOW) });
  const response = await handlers.get({ request: new Request('https://easygaragecleaning.com/api/quote-document?jobId=job1&documentKind=proposal'), env: ENV });
  assert.equal(response.status, 404);
  assert.equal((await response.json()).code, 'quote_document_disabled');
  assert.equal(f.reads.length, 0); assert.equal(f.writes.length, 0);
});
