import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { customerResolveHandler } from '../functions/api/customer-resolve.js';
import { quoteDraftHandlers } from '../functions/api/quote-draft.js';
import { handoffHandlers } from '../functions/api/walkthrough-handoff.js';
import { customerRef, isCustomerRef, restrictedAuthor } from '../functions/_lib/estimator-customer-access.js';
import { requireCustomerResolver } from '../functions/_lib/quote-permissions.js';

// An estimator (staffRoles ['sales'] with EGC_STAFF_ROLE_PERMISSIONS on, the launch default, and no booking right)
// sees a stored customer's contact details only for their own customer, an assigned walkthrough's or an assigned job's.
// Every other customer reaches them masked and by a reference to their own customer-resolve request; attaching one to a
// quote needs the name to agree. Owners, managers, dispatchers and bookers are unchanged. Synthetic data only.
const NOW = '2026-09-22T18:00:00.000Z';
const SITE = 'https://easygaragecleaning.com';
const ROLES = { HUB_SESSION_SECRET: 'synthetic-estimator-access-session-secret-0123456789', EGC_STAFF_ROLE_PERMISSIONS: 'true' };
const owner = { user: 'zacb', role: 'owner', businessAccess: true, displayName: 'Synthetic Owner' };
const manager = { user: 'tylerg', role: 'manager', businessAccess: true, displayName: 'Synthetic Manager' };
const sales = { user: 'sales.person', role: 'sales', businessAccess: false, displayName: 'Synthetic Sales', source: 'employee-account', staffRoles: ['sales'] };
const otherSales = { ...sales, user: 'sales.other', displayName: 'Synthetic Sales Two' };
const phoneRole = { ...sales, user: 'phone.person', staffRoles: ['phone'] };

// A stored customer whose record id embeds its CRM contact, as provider-created customers' ids do.
const STORED = { id: 'ghl_provider7', revision: 's1', name: 'Jordan Example', phone: '9705550142', email: 'stored@example.invalid', address: '742 Synthetic Way', highlevelContactId: 'provider7', createdBy: 'zacb' };
const SECRETS = ['ghl_provider7', 'provider7', 'stored@example.invalid', '742 Synthetic Way', '9705550142'];
const leaks = text => SECRETS.filter(secret => text.includes(secret));

function fixture() {
  const rows = new Map([
    ['customers/ghl_provider7', structuredClone(STORED)],
    // The stored customer's walkthrough, assigned to the estimator (their own visit).
    ['jobs/w1', { id: 'w1', revision: 'w1r', type: 'walkthrough', status: 'scheduled', pipelineStatus: 'scheduled', customerId: 'ghl_provider7', customer: 'Jordan Example', date: '2026-09-22', time: '11:00', endTime: '12:00', assignedCrew: [] }],
  ]);
  let n = 0;
  const list = prefix => [...rows].filter(([key]) => key.startsWith(prefix)).map(([, value]) => structuredClone(value));
  const store = {
    read: async (collection, id) => structuredClone(rows.get(`${collection}/${id}`) || null),
    jobs: async () => list('jobs/'), customers: async () => list('customers/'), resources: async () => [],
    roster: async () => [{ id: 'zacb', name: 'Synthetic Owner', role: 'owner' }, { id: 'crew1', name: 'Crew One', role: 'crew' }],
    commit: async writes => {
      for (const write of writes) { const old = rows.get(`${write.collection}/${write.id}`); if (write.revision ? old?.revision !== write.revision : Boolean(old)) throw Object.assign(new Error('Conflict'), { code: 'dispatch_revision_conflict', status: 409 }); }
      for (const write of writes) if (!write.verify) rows.set(`${write.collection}/${write.id}`, { ...rows.get(`${write.collection}/${write.id}`), ...structuredClone(write.patch), id: write.id, revision: `r${++n}` });
    },
  };
  return { rows, store, job: id => rows.get(`jobs/${id}`) };
}

const json = (path, body) => new Request(`${SITE}${path}`, { method: 'POST', headers: { Origin: SITE, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const call = async promise => { const response = await promise, text = await response.text(); return { status: response.status, text, body: JSON.parse(text) }; };
const resolve = (f, actor, customer, requestId = randomUUID(), env = ROLES) => call(customerResolveHandler({ session: async () => actor, storage: () => f.store, verifyContact: async () => { throw new Error('not used'); } })({ request: json('/api/customer-resolve', { requestId, customer }), env }));
const drafts = (f, actor) => quoteDraftHandlers({ session: async () => actor, storage: () => f.store, now: () => new Date(NOW), stripe: () => null });
const saveDraft = (f, actor, body) => call(drafts(f, actor).post({ request: json('/api/quote-draft', { action: 'save', ...body }), env: ROLES }));
const readDraft = (f, actor, jobId) => call(drafts(f, actor).get({ request: new Request(`${SITE}/api/quote-draft?jobId=${jobId}`), env: ROLES }));
const handoff = (f, actor) => handoffHandlers({ session: async () => actor, storage: () => f.store, now: () => new Date(NOW) });
const prepare = (f, actor, query) => call(handoff(f, actor).get({ request: new Request(`${SITE}/api/walkthrough-handoff?${new URLSearchParams(query)}`), env: ROLES }));
const sign = (f, actor, body) => call(handoff(f, actor).post({ request: json('/api/walkthrough-handoff', body), env: ROLES }));

// What an estimator at a garage types: the phone, and the name they were given.
const typed = (name = 'Jordan Example') => ({ name, phone: '(970) 555-0142', email: '', address: '', highlevelContactId: '' });
const draft = (name = 'Jordan Example') => ({ client: { name, phone: '9705550142', email: '', address: '1 Typed Street', highlevel_contact_id: '' }, title: 'Garage reset', scope: 'Cleanout and reset.', valid_until: '2026-10-06', catalog_version: '2026-09-22.1', crew_size: 2,
  line_items: [{ id: 'cleanout', kind: 'service', name: 'Garage cleanout and reset', description: 'Sorting, hauling and disposal', quantity: 1, unitCents: 90000, totalCents: 90000 }] });
const plan = (name = 'Jordan Example') => ({ client: { name, phone: '9705550142', email: '', address: '1 Typed Street', highlevel_contact_id: '' }, quote: { title: 'Garage reset', total: 1400, deposit: 350, job_date: '2026-09-24', start_time: '09:00', end_time: '12:00', estimated_duration_min: 180 },
  acceptance: { accepted_at: '2026-09-22T17:45:00.000Z', accepted_by: name, signature_captured: true, method: 'in_person_signature', terms_version: '2026-10-deposit25' }, signature: 'data:image/png;base64,iVBORw0KGgo=', terms_version: '2026-10-deposit25', terms_accepted: true,
  photos: { before: 2 }, scope: { keep_items: 'Blue bicycle' }, discovery: { success: 'Park the car' }, logistics: { crew_size: 2 }, internal_notes: 'Synthetic brief', client_checklists: { preJob: [], postJob: [] }, notes: '' });

test('only an estimator is restricted: dispatchers, bookers and anyone with role permissions off are not', () => {
  for (const [actor, env, restricted] of [[sales, ROLES, true], [otherSales, ROLES, true], [owner, ROLES, false], [manager, ROLES, false], [owner, {}, false],
    [{ ...manager, staffRoles: ['sales'] }, ROLES, true], [phoneRole, { ...ROLES, EGC_STAFF_ROLE_ACCESS: 'true' }, false], [sales, { ...ROLES, EGC_STAFF_ROLE_ACCESS: 'true' }, false]]) {
    assert.equal(restrictedAuthor(actor, requireCustomerResolver(actor, env), env), restricted, `${actor.user} ${JSON.stringify(env)}`);
  }
  const ref = customerRef('0B6F6C52-5A0D-4D2E-9A51-7D0E1C2A0008');
  assert.equal(ref, 'cref_0b6f6c525a0d4d2e9a517d0e1c2a0008');
  assert.deepEqual([isCustomerRef(ref), isCustomerRef('ghl_provider7'), isCustomerRef('cref_' + 'g'.repeat(32))], [true, false, false]);
});

test('a phone number alone no longer reveals or attaches a stored customer (resolve, save, open)', async () => {
  const f = fixture(), seen = [];
  // 1. customer-resolve with only the phone and some name: left for the office, nothing recorded.
  const resolved = await resolve(f, sales, typed('Anyone At All')); seen.push(resolved.text);
  assert.deepEqual([resolved.status, resolved.body.code], [409, 'customer_resolve_identity_review']);
  assert.equal([...f.rows.keys()].some(key => key.startsWith('customerOperations/')), false);
  // 2. A quote saved with the raw record id (learned elsewhere) or someone else's reference is refused.
  const raw = await saveDraft(f, sales, { requestId: randomUUID(), customerId: 'ghl_provider7', draft: draft('Anyone At All') }); seen.push(raw.text);
  assert.deepEqual([raw.status, raw.body.code], [403, 'quote_draft_customer_ref_required']);
  const theirs = await resolve(f, otherSales, typed()); seen.push(theirs.text);
  const borrowed = await saveDraft(f, sales, { requestId: randomUUID(), customerId: theirs.body.customer.id, draft: draft() }); seen.push(borrowed.text);
  assert.deepEqual([borrowed.status, borrowed.body.code], [403, 'quote_draft_customer_ref_invalid']);
  const signedRaw = await sign(f, sales, { requestId: randomUUID(), customerId: 'ghl_provider7', plan: plan('Anyone At All') }); seen.push(signedRaw.text);
  assert.deepEqual([signedRaw.status, signedRaw.body.code], [403, 'handoff_customer_ref_required']);
  // 3. No job was made, so there is nothing to open.
  assert.equal([...f.rows.keys()].some(key => key.startsWith('jobs/') && key !== 'jobs/w1'), false);
  assert.deepEqual(leaks(seen.join('\n')), []);
  assert.deepEqual(f.rows.get('customers/ghl_provider7'), STORED, 'the stored customer is untouched');
});

test('the name is checked again at save: a reference under an agreeing name cannot carry a different name onto the quote', async () => {
  const f = fixture(), resolved = await resolve(f, sales, typed('jordan example'));
  assert.equal(resolved.status, 200);
  for (const name of ['Anyone At All', 'Another Person']) {
    const saved = await saveDraft(f, sales, { requestId: randomUUID(), customerId: resolved.body.customer.id, draft: draft(name) });
    assert.deepEqual([saved.status, saved.body.code], [409, 'quote_draft_customer_review_required'], name);
    const signed = await sign(f, sales, { requestId: randomUUID(), customerId: resolved.body.customer.id, plan: plan(name) });
    assert.deepEqual([signed.status, signed.body.code], [409, 'handoff_customer_review_required'], name);
    assert.deepEqual(leaks(saved.text + signed.text), []);
  }
  assert.equal([...f.rows.keys()].some(key => key.startsWith('jobs/') && key !== 'jobs/w1'), false);
});

test('under the right name the quote attaches, and every answer stays masked: no email, address, CRM link or record id', async () => {
  const f = fixture(), resolveId = randomUUID(), seen = [];
  const resolved = await resolve(f, sales, typed(), resolveId); seen.push(resolved.text);
  assert.equal(resolved.status, 200);
  const ref = resolved.body.customer.id;
  assert.deepEqual(resolved.body.customer, { id: customerRef(resolveId), revision: 's1', phone: '(•••) •••-0142', email: 's•••@example.invalid', contactDetails: 'masked' });
  const requestId = randomUUID(), body = { requestId, customerId: ref, draft: draft() };
  const saved = await saveDraft(f, sales, body); seen.push(saved.text);
  assert.equal(saved.status, 200, saved.text);
  const id = saved.body.job.id;
  assert.deepEqual([saved.body.job.customerId, f.job(id).customerId, f.job(id).authorCustomerRef], [ref, 'ghl_provider7', { ref, by: 'sales.person', name: 'Jordan Example', phone: '9705550142', address: '1 Typed Street' }]);
  const read = await readDraft(f, sales, id); seen.push(read.text);
  assert.deepEqual([read.status, read.body.job.customerId], [200, ref]);
  const prepared = await prepare(f, sales, { jobId: id }); seen.push(prepared.text);
  assert.deepEqual([prepared.status, prepared.body.customerId, prepared.body.customer], [200, ref, { id: ref, revision: 's1', phone: '(•••) •••-0142', email: 's•••@example.invalid', contactDetails: 'masked' }]);
  // A revision with the reference saves; signing it books the job with the customer still masked.
  const revised = await saveDraft(f, sales, { requestId: randomUUID(), customerId: prepared.body.customerId, jobId: id, expectedRevision: prepared.body.expectedRevision, draft: { ...draft(), title: 'Garage reset, revised' } }); seen.push(revised.text);
  assert.deepEqual([revised.status, revised.body.job.customerId], [200, ref], revised.text);
  const signed = await sign(f, sales, { requestId: randomUUID(), customerId: ref, jobId: id, expectedRevision: f.job(id).revision, plan: plan() }); seen.push(signed.text);
  assert.deepEqual([signed.status, signed.body.job.customerId, signed.body.job.highlevelContactId], [200, ref, ''], signed.text);
  assert.deepEqual(leaks(seen.join('\n')), []);
  // Another estimator cannot open this draft at all.
  const other = await readDraft(f, otherSales, id);
  assert.deepEqual([other.status, other.body.code], [403, 'quote_draft_job_forbidden']);
  const otherPrepare = await prepare(f, otherSales, { jobId: id });
  assert.deepEqual([otherPrepare.status, otherPrepare.body.code], [403, 'handoff_job_forbidden']);
  // The office still sees the whole customer on the same job.
  const office = await prepare(f, owner, { jobId: id });
  assert.deepEqual([office.body.customerId, office.body.customer.email, office.body.customer.highlevelContactId], ['ghl_provider7', 'stored@example.invalid', 'provider7']);
});

test('an estimator keeps full details for their assigned walkthrough and for a customer they created themselves', async () => {
  const f = fixture();
  // Not assigned: the walkthrough's customer is withheld.
  const unassigned = await prepare(f, sales, { sourceWalkthroughId: 'w1' });
  assert.deepEqual([unassigned.status, unassigned.body.customerId], [200, '']);
  f.rows.get('jobs/w1').assignedCrew = [sales.user];
  const prepared = await prepare(f, sales, { sourceWalkthroughId: 'w1' });
  assert.equal(prepared.body.customerId, 'ghl_provider7');
  const saved = await saveDraft(f, sales, { requestId: randomUUID(), customerId: 'ghl_provider7', sourceWalkthroughId: 'w1', sourceRevision: 'w1r', draft: draft('A Different Name') });
  assert.deepEqual([saved.status, saved.body.job.customerId], [200, 'ghl_provider7'], 'their own visit: no name check, the record id as before');
  const opened = await prepare(f, sales, { jobId: saved.body.job.id });
  assert.deepEqual([opened.body.customer.email, opened.body.customer.address, opened.body.customer.highlevelContactId], ['stored@example.invalid', '742 Synthetic Way', 'provider7']);
  // A new customer they add themselves is theirs in full.
  const added = await resolve(f, sales, { name: 'New Homeowner', phone: '9705550177', email: 'new@example.invalid', address: '5 New Road', highlevelContactId: '' });
  assert.deepEqual([added.status, added.body.created, isCustomerRef(added.body.customer.id)], [200, true, true]);
  const own = await saveDraft(f, sales, { requestId: randomUUID(), customerId: added.body.customer.id, draft: { ...draft('New Homeowner'), client: { name: 'New Homeowner', phone: '9705550177', email: 'new@example.invalid', address: '5 New Road', highlevel_contact_id: '' } } });
  assert.equal(own.status, 200, own.text);
  const ownView = await prepare(f, sales, { jobId: own.body.job.id });
  assert.deepEqual([ownView.body.customerId, ownView.body.customer.email, ownView.body.customer.address], [added.body.customer.id, 'new@example.invalid', '5 New Road']);
});

test('owners, managers, dispatchers and bookers are unchanged', async () => {
  for (const actor of [owner, manager]) {
    const f = fixture();
    const resolved = await resolve(f, actor, typed('Anyone At All'));
    assert.deepEqual([resolved.status, resolved.body.customer.id, resolved.body.customer.email, resolved.body.customer.highlevelContactId], [200, 'ghl_provider7', 'stored@example.invalid', 'provider7'], actor.user);
    const saved = await saveDraft(f, actor, { requestId: randomUUID(), customerId: 'ghl_provider7', draft: draft('Anyone At All') });
    assert.deepEqual([saved.status, saved.body.job.customerId], [200, 'ghl_provider7'], actor.user);
    const prepared = await prepare(f, actor, { jobId: saved.body.job.id });
    assert.deepEqual([prepared.body.customerId, prepared.body.customer.address], ['ghl_provider7', '742 Synthetic Way']);
  }
  // A booker (EGC_STAFF_ROLE_ACCESS) keeps the masked answer with the record id the booking screen books with.
  const f = fixture(), booker = await resolve(f, phoneRole, typed('Anyone At All'), randomUUID(), { ...ROLES, EGC_STAFF_ROLE_ACCESS: 'true' });
  assert.deepEqual([booker.status, booker.body.customer.id, booker.body.customer.contactDetails], [200, 'ghl_provider7', 'masked']);
});

test('replays and idempotency are unchanged: the same request answers the same way, a changed one is refused', async () => {
  const f = fixture(), resolveId = randomUUID();
  const first = await resolve(f, sales, typed(), resolveId), again = await resolve(f, sales, typed(), resolveId);
  assert.deepEqual([again.status, again.body.replayed, again.body.customer], [200, true, first.body.customer]);
  const conflict = await resolve(f, sales, typed('Jordan Q. Example'), resolveId);
  assert.deepEqual([conflict.status, conflict.body.code], [409, 'customer_resolve_idempotency_conflict']);
  const body = { requestId: randomUUID(), customerId: first.body.customer.id, draft: draft() };
  const saved = await saveDraft(f, sales, body), replayed = await saveDraft(f, sales, body);
  assert.deepEqual([replayed.status, replayed.body.replayed, replayed.body.job], [200, true, saved.body.job]);
  assert.equal(leaks(replayed.text).length, 0);
  const changed = await saveDraft(f, sales, { ...body, draft: { ...draft(), title: 'Something else' } });
  assert.deepEqual([changed.status, changed.body.code], [409, 'quote_draft_idempotency_conflict']);
  // A signed handoff replays masked too.
  const signBody = { requestId: randomUUID(), customerId: first.body.customer.id, jobId: saved.body.job.id, expectedRevision: f.job(saved.body.job.id).revision, plan: plan() };
  const signed = await sign(f, sales, signBody), resigned = await sign(f, sales, signBody);
  assert.deepEqual([resigned.status, resigned.body.replayed, resigned.body.job.customerId, resigned.body.job.highlevelContactId], [200, true, first.body.customer.id, '']);
  assert.deepEqual(leaks(signed.text + resigned.text), []);
});

test('a phone and part of the name never reveal the stored name: the estimator is shown only the name they typed', async () => {
  const f = fixture(), seen = [];
  // One word, or a full name whose last word is not the stored surname, goes to the office; each refusal is audited.
  for (const name of ['Jordan', 'Example', 'Jordan Smith']) {
    const refused = await resolve(f, sales, typed(name)); seen.push(refused.text);
    assert.deepEqual([refused.status, refused.body.code], [409, 'customer_resolve_identity_review'], name);
  }
  const audits = [...f.rows].filter(([key]) => key.startsWith('hub_audit/')).map(([, row]) => row);
  assert.deepEqual([audits.length, audits.every(row => row.action === 'customer.identity_review' && row.actor.id === 'sales.person' && row.entity.id === 'ghl_provider7')], [3, true]);
  // A household member's full name (same surname) attaches, but every answer names the customer as typed.
  const resolved = await resolve(f, sales, typed('Casey Example')); seen.push(resolved.text);
  assert.equal(resolved.status, 200);
  const saved = await saveDraft(f, sales, { requestId: randomUUID(), customerId: resolved.body.customer.id, sourceWalkthroughId: 'w1', sourceRevision: 'w1r', draft: draft('Casey Example') }); seen.push(saved.text);
  assert.deepEqual([saved.status, saved.body.job.customer], [200, 'Casey Example'], saved.text);
  const id = saved.body.job.id;
  const read = await readDraft(f, sales, id); seen.push(read.text);
  assert.equal(read.body.job.customer, 'Casey Example');
  f.job(id).date = '2026-10-02';
  const preview = await call(drafts(f, sales).post({ request: json('/api/quote-draft', { action: 'send_preview', jobId: id, expectedRevision: f.job(id).revision }), env: ROLES })); seen.push(preview.text);
  assert.equal(preview.status, 200, preview.text);
  assert.match(preview.body.summary, /to Casey Example/);
  const prepared = await prepare(f, sales, { jobId: id }); seen.push(prepared.text);
  assert.equal(prepared.status, 200);
  const all = seen.join('\n');
  assert.equal(/Jordan/i.test(all), false, 'the stored first name reaches no answer');
  assert.deepEqual(leaks(all), []);
  // The office still sees the stored customer.
  assert.equal((await readDraft(f, owner, id)).body.job.customer, 'Jordan Example');
});

test('a stored name with no name words attaches under no typed name, and a CRM contact an estimator adds is not theirs in full', async () => {
  const f = fixture();
  f.rows.get('customers/ghl_provider7').name = 'The Homeowner Family';
  for (const name of ['The Homeowner Family', 'Casey Example']) {
    const refused = await resolve(f, sales, typed(name));
    assert.deepEqual([refused.status, refused.body.code], [409, 'customer_resolve_identity_review'], name);
  }
  // A customer created from a CRM contact the estimator picked keeps the CRM's details masked from them.
  const g = fixture();
  g.rows.set('customers/crm_made', { id: 'crm_made', revision: 'm1', name: 'Riley Sample', phone: '9705550188', email: 'crm@example.invalid', address: '9 CRM Road', highlevelContactId: 'provider9', createdBy: 'sales.person', source: 'verified_provider_contact' });
  g.rows.set('customers/typed_made', { id: 'typed_made', revision: 't1', name: 'Avery Sample', phone: '9705550189', email: 'own@example.invalid', address: '10 Own Road', createdBy: 'sales.person', source: 'manager_intake' });
  const { fullCustomerAccess } = await import('../functions/_lib/estimator-customer-access.js');
  assert.deepEqual([await fullCustomerAccess(g.rows.get('customers/crm_made'), sales, { env: ROLES }), await fullCustomerAccess(g.rows.get('customers/typed_made'), sales, { env: ROLES })], [false, true]);
});

test('the walkthrough capture never confirms a guessed stored name: an estimator who may not see the customer is compared with the name they typed', async () => {
  const { walkthroughCaptureHandlers } = await import('../functions/api/walkthrough-capture.js');
  const f = fixture(), resolved = await resolve(f, sales, typed('Casey Example'));
  const saved = await saveDraft(f, sales, { requestId: randomUUID(), customerId: resolved.body.customer.id, draft: draft('Casey Example') });
  assert.equal(saved.status, 200, saved.text);
  const id = saved.body.job.id, capture = actor => walkthroughCaptureHandlers({ session: async () => actor, storage: () => f.store, now: () => new Date(NOW) });
  const nameGap = async (actor, customerName) => {
    const response = await call(capture(actor).post({ request: json('/api/walkthrough-capture', { action: 'save', jobId: id, requestId: randomUUID(), expectedRevision: f.job(id).walkthroughReview?.revision ?? 0, data: { customerName } }), env: ROLES }));
    assert.equal(response.status, 200, response.text);
    assert.deepEqual(leaks(response.text), []);
    return response.body.gaps.some(gap => gap.field === 'customerName' && /differs/.test(gap.message));
  };
  // The stored first name and a wrong guess look the same; only the name the estimator typed matches.
  assert.deepEqual([await nameGap(sales, 'Jordan Example'), await nameGap(sales, 'Riley Example'), await nameGap(sales, 'Casey Example')], [true, true, false]);
  // The office compares with the stored record, as before.
  assert.deepEqual([await nameGap(owner, 'Casey Example'), await nameGap(owner, 'Jordan Example')], [true, false]);
});

test('another estimator\'s job is not reachable through a walkthrough that is not theirs', async () => {
  const f = fixture();
  f.rows.get('jobs/w1').assignedCrew = [otherSales.user];
  // Estimator A (assigned) drafts the walkthrough's quote.
  const own = await saveDraft(f, otherSales, { requestId: randomUUID(), customerId: 'ghl_provider7', sourceWalkthroughId: 'w1', sourceRevision: 'w1r', draft: draft() });
  assert.equal(own.status, 200, own.text);
  const id = own.body.job.id;
  // Estimator B names A's walkthrough: the job is not opened, revised or signed.
  const opened = await prepare(f, sales, { sourceWalkthroughId: 'w1' });
  assert.deepEqual([opened.status, opened.body.code], [403, 'handoff_job_forbidden']);
  const resolved = await resolve(f, sales, typed());
  const signed = await sign(f, sales, { requestId: randomUUID(), customerId: resolved.body.customer.id, sourceWalkthroughId: 'w1', sourceRevision: f.rows.get('jobs/w1').revision, jobId: id, expectedRevision: f.job(id).revision, plan: plan() });
  assert.deepEqual([signed.status, signed.body.code], [403, 'handoff_revision_forbidden']);
  assert.equal(f.job(id).acceptance, undefined, 'nothing was signed');
  // Once the office reassigns the walkthrough to B, B may take it over.
  f.rows.get('jobs/w1').assignedCrew = [sales.user];
  const reassigned = await prepare(f, sales, { sourceWalkthroughId: 'w1' });
  assert.deepEqual([reassigned.status, reassigned.body.jobId], [200, id]);
  // A scheduled job's address refusal does not print the stored address.
  const placed = f.job(id);
  Object.assign(placed, { status: 'scheduled', pipelineStatus: 'scheduled', date: '2026-09-24', endDate: '2026-09-24', time: '09:00', endTime: '12:00', address: '742 Synthetic Way', crewNeeded: 2 });
  const moved = await sign(f, sales, { requestId: randomUUID(), customerId: 'ghl_provider7', sourceWalkthroughId: 'w1', sourceRevision: f.rows.get('jobs/w1').revision, jobId: id, expectedRevision: placed.revision, plan: plan() });
  assert.deepEqual([moved.status, moved.body.code], [403, 'handoff_schedule_change_forbidden'], moved.text);
  assert.deepEqual(leaks(moved.text), []);
});

test('a placeholder stored name ("Customer", "Unknown", "Test Lead") names nobody, so no typed name attaches to it', async () => {
  const { estimatorNamesAgree } = await import('../functions/_lib/estimator-customer-access.js');
  for (const stored of ['Customer', 'Unknown Customer', 'Test Lead', 'Web Lead', 'New Client', 'TBD', 'Guest']) {
    for (const name of ['Casey Example', 'Unknown Customer', 'Test Lead', 'New Client']) assert.equal(estimatorNamesAgree(stored, name), false, `${stored} / ${name}`);
    const f = fixture();
    f.rows.get('customers/ghl_provider7').name = stored;
    const refused = await resolve(f, sales, typed('Casey Customer'));
    assert.deepEqual([refused.status, refused.body.code], [409, 'customer_resolve_identity_review'], stored);
  }
  assert.equal(estimatorNamesAgree('Jordan Example', 'Casey Example'), true, 'a real shared surname still agrees');
});

test('a capture the office filled in reads back to the estimator with only the details they typed, and their resave keeps the office\'s', async () => {
  const { walkthroughCaptureHandlers } = await import('../functions/api/walkthrough-capture.js');
  const f = fixture(), resolved = await resolve(f, sales, typed('Casey Example'));
  const saved = await saveDraft(f, sales, { requestId: randomUUID(), customerId: resolved.body.customer.id, draft: draft('Casey Example') });
  const id = saved.body.job.id, capture = actor => walkthroughCaptureHandlers({ session: async () => actor, storage: () => f.store, now: () => new Date(NOW) });
  const post = (actor, data) => call(capture(actor).post({ request: json('/api/walkthrough-capture', { action: 'save', jobId: id, requestId: randomUUID(), expectedRevision: f.job(id).walkthroughReview?.revision ?? 0, data }), env: ROLES }));
  const get = actor => call(capture(actor).get({ request: new Request(`${SITE}/api/walkthrough-capture?jobId=${id}`), env: ROLES }));
  // The owner records the stored name and address on the estimator's capture.
  const office = await post(owner, { customerName: 'Jordan Example', address: '742 Synthetic Way', phone: '9705550142', scopeSummary: 'Shelving wall' });
  assert.equal(office.status, 200, office.text);
  const read = await get(sales);
  assert.equal(read.status, 200, read.text);
  assert.deepEqual([read.body.review.draft.customerName, read.body.review.draft.address, read.body.review.draft.phone, read.body.review.draft.scopeSummary], ['Casey Example', '', '9705550142', 'Shelving wall'], 'their own typed phone is theirs to see');
  assert.equal(/Jordan|742 Synthetic Way|stored@example/.test(read.text), false);
  // Resaving what they were shown changes only what they edit; the office still reads its own entries.
  const resave = await post(sales, { ...read.body.review.draft, scopeSummary: 'Shelving wall and bins' });
  assert.equal(resave.status, 200, resave.text);
  assert.equal(/Jordan|742 Synthetic Way/.test(resave.text), false);
  const stored = f.job(id).walkthroughReview.draft;
  assert.deepEqual([stored.customerName, stored.address, stored.scopeSummary], ['Jordan Example', '742 Synthetic Way', 'Shelving wall and bins']);
  assert.equal((await get(owner)).body.review.draft.customerName, 'Jordan Example');
});

test('an estimator who created the customer record still cannot take over another estimator\'s draft, or its commission, unless the office gives it to them', async () => {
  const f = fixture();
  // Estimator B adds a customer; estimator A later quotes the same customer under the same name.
  const added = await resolve(f, sales, { name: 'Pat Sample', phone: '9705550177', email: '', address: '5 New Road', highlevelContactId: '' });
  assert.deepEqual([added.status, added.body.created], [200, true]);
  const theirs = await resolve(f, otherSales, { name: 'Pat Sample', phone: '9705550177', email: '', address: '', highlevelContactId: '' });
  const clientA = { name: 'Pat Sample', phone: '9705550177', email: '', address: '5 New Road', highlevel_contact_id: '' };
  const drafted = await saveDraft(f, otherSales, { requestId: randomUUID(), customerId: theirs.body.customer.id, draft: { ...draft(), client: clientA } });
  assert.equal(drafted.status, 200, drafted.text);
  const id = drafted.body.job.id, before = structuredClone(f.job(id));
  // B, who owns the customer record, is refused on every route into A's draft.
  const read = await readDraft(f, sales, id);
  assert.deepEqual([read.status, read.body.code], [403, 'quote_draft_job_forbidden']);
  const revised = await saveDraft(f, sales, { requestId: randomUUID(), customerId: added.body.customer.id, jobId: id, expectedRevision: f.job(id).revision, draft: { ...draft(), client: clientA, title: 'Taken over' } });
  assert.deepEqual([revised.status, revised.body.code], [403, 'quote_draft_job_forbidden']);
  const opened = await prepare(f, sales, { jobId: id });
  assert.deepEqual([opened.status, opened.body.code], [403, 'handoff_job_forbidden']);
  const signed = await sign(f, sales, { requestId: randomUUID(), customerId: added.body.customer.id, jobId: id, expectedRevision: f.job(id).revision, plan: { ...plan('Pat Sample'), client: clientA } });
  assert.deepEqual([signed.status, signed.body.code], [403, 'handoff_revision_forbidden']);
  assert.deepEqual(f.job(id), before, 'A\'s draft is untouched and unsigned');
  // A reference B stamped on the job earlier gives no way in either.
  f.job(id).authorCustomerRef = { ref: added.body.customer.id, by: sales.user, name: 'Pat Sample' };
  assert.equal((await prepare(f, sales, { jobId: id })).status, 403);
  delete f.job(id).authorCustomerRef;
  // Once the office assigns the job to B, B may revise and sign it.
  f.job(id).assignedCrew = [sales.user];
  const taken = await saveDraft(f, sales, { requestId: randomUUID(), customerId: added.body.customer.id, jobId: id, expectedRevision: f.job(id).revision, draft: { ...draft(), client: clientA, title: 'Reassigned' } });
  assert.equal(taken.status, 200, taken.text);
});
