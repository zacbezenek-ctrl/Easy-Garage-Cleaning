import test from 'node:test';
import assert from 'node:assert/strict';
import vm from './helpers/vm-realm.mjs';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const source = readFileSync(new URL('../crew/quote-draft.js', import.meta.url), 'utf8');
const context = vm.createContext({ window: {}, URLSearchParams, AbortController, setTimeout, clearTimeout, Intl, Date });
vm.runInContext(source, context);
const { createClient, draftFromWalkthrough, missing, scopeText } = context.window.EGCQuoteDraft;
const reply = (data, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => structuredClone(data) });
const plain = value => JSON.parse(JSON.stringify(value));

// The walkthrough's itemized quote as crew/gameplan.html payload() builds it.
const payload = () => ({ client: { name: 'Synthetic Customer', phone: '+19705550100', email: 'test@example.invalid', address: '100 Fixture Lane', highlevel_contact_id: 'contact-1' }, quote: { title: 'EGC Garage Service — 100 Fixture Lane', total: 1400, estimated_duration_min: 240, catalog_version: '2026-09-pest200-traps250', line_items: [
  { id: 'cleanout', kind: 'service', name: 'Garage cleanout and reset', description: 'Sorting, hauling and disposal', quantity: 1, unitCents: 90000, totalCents: 90000 },
  { id: 'totes', kind: 'product', name: 'Storage tote', description: '', quantity: 4, unitCents: 2150, totalCents: 8600 },
  { id: 'adjustment', kind: 'fee', name: 'Price adjustment', description: 'Long carry agreed', quantity: 1, unitCents: 41400, totalCents: 41400 },
] }, logistics: { crew_size: 2 }, signature: 'data:image/png;base64,UNUSED', raw: { secret: 'never sent' } });

function fixture() {
  let user = 'sales.person', lose = 0, refuse = null, n = 0, manual = 0, garble = [];
  // The server replays a committed save by its request id, like saveQuoteDraft's receipt.
  const records = new Map(), calls = [], accepted = [], owners = new Map(), committed = new Map();
  const storage = { getItem: key => records.get(key) ?? null, setItem: (key, value) => records.set(key, String(value)), removeItem: key => records.delete(key), get length() { return records.size; }, key: index => [...records.keys()][index] ?? null };
  const job = (revision, estimateRevision = 1, id = 'dispatch_job1', customerId = 'customer-1') => ({ id, revision, customerId, estimate: { number: `EST-${id.slice(-6).toUpperCase()}`, revision: estimateRevision, amountCents: 140000, validUntil: '2026-10-06', lineItems: [] } });
  const deps = {
    actor: async () => user, storage, uuid: () => randomUUID(), source: () => 'walk-1', savedJobId: () => '', accept: result => accepted.push(result),
    fetch: async (url, options = {}) => {
      const body = options.body ? JSON.parse(options.body) : null; calls.push({ url, body });
      // The server resolves the walkthrough's own job, or the job the client names.
      if (url.startsWith('/api/walkthrough-handoff?')) {
        const query = new URLSearchParams(url.split('?')[1]), source = query.get('sourceWalkthroughId'), jobId = query.get('jobId') || (source && accepted.length ? 'dispatch_job1' : '');
        return reply({ ok: true, viewer: { id: user }, sourceRevision: source ? 'w1r' : '', customerId: source ? 'customer-1' : owners.get(jobId) || '', jobId, expectedRevision: jobId ? `r${n}` : '', roster: [] });
      }
      if (url === '/api/customer-resolve') return reply({ ok: true, customer: { id: body.customer.phone === '+19705550100' ? 'customer-1' : 'customer-2' } });
      if (url === '/api/quote-draft') {
        if (lose > 0) { lose -= 1; throw new TypeError('network lost'); }
        if (refuse) { const { status, code } = refuse; refuse = null; return reply({ ok: false, code, error: 'Refused' }, status); }
        if (body.action === 'save' && committed.has(body.requestId)) return reply(committed.get(body.requestId));
        if (body.action === 'save') {
          const id = body.jobId || (body.sourceWalkthroughId ? 'dispatch_job1' : `manual_job${++manual}`); owners.set(id, body.customerId);
          const data = { ok: true, requestId: body.requestId, job: job(`r${++n}`, accepted.length + 1, id, body.customerId), warnings: [] };
          committed.set(body.requestId, data);
          // The save committed, but its 200 answer arrives truncated or without ok:true.
          const answer = garble.shift();
          if (answer === 'truncated') return { ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected end of JSON input'); } };
          if (answer === 'unexpected') return reply({ saved: true });
          return reply(data);
        }
        if (body.action === 'send_preview') return reply({ ok: true, confirmToken: 'ect1.synthetic', delivery: { mode: 'off' }, job: job(body.expectedRevision) });
        if (body.action === 'send') return reply({ ok: true, requestId: body.requestId, job: job('sent'), delivery: { status: 'messaging_disabled' } });
      }
      throw new Error(`Unexpected route ${url}`);
    },
  };
  return { deps, calls, records, accepted, client: createClient(deps), draft: () => draftFromWalkthrough(payload(), '2026-10-06'), lose: count => { lose = count; }, refuse: (status, code = 'quote_draft_invalid_draft') => { refuse = { status, code }; }, actor: value => { user = value; }, garble: (...answers) => { garble = answers; } };
}

test('the walkthrough quote maps to a draft of exactly its itemized lines, contact and expiry; private walkthrough data is never sent', () => {
  const draft = draftFromWalkthrough(payload(), '2026-10-06');
  assert.deepEqual(plain(draft.client), { name: 'Synthetic Customer', phone: '+19705550100', email: 'test@example.invalid', address: '100 Fixture Lane', highlevel_contact_id: 'contact-1' });
  assert.deepEqual(plain(draft.line_items).map(line => [line.id, line.totalCents]), [['cleanout', 90000], ['totes', 8600], ['adjustment', 41400]]);
  assert.deepEqual([draft.valid_until, draft.crew_size, draft.estimated_duration_min, draft.catalog_version], ['2026-10-06', 2, 240, '2026-09-pest200-traps250']);
  assert.equal(draft.scope, 'Included: Garage cleanout and reset; 4 × Storage tote. Price adjustment: Long carry agreed.');
  assert.equal(JSON.stringify(draft).includes('never sent'), false); assert.equal(JSON.stringify(draft).includes('image/png'), false);
  assert.deepEqual(plain(missing(draft)), []);
  const bare = draftFromWalkthrough({ client: { name: ' ' }, quote: { line_items: [{ id: 'adjustment', kind: 'fee', name: 'Price adjustment', description: '', quantity: 1, unitCents: 100, totalCents: 100 }] } }, '2026-10-06');
  assert.deepEqual(plain(missing(bare)), ['customer name', 'service address', 'a phone number or email', 'the customer-facing reason for the changed rate']);
  assert.equal(scopeText([{ id: 'a', name: 'Opt', quantity: 1, selected: false }, { id: 'b', name: 'Kept', quantity: 1 }]), 'Included: Kept.');
});

test('a draft save is persisted before the server call, resolves the canonical customer and records the saved job', async () => {
  const f = fixture(), { result, retrying } = await f.client.save(f.draft());
  assert.equal(retrying, false);
  assert.deepEqual(f.calls.map(call => call.url), ['/api/walkthrough-handoff?sourceWalkthroughId=walk-1', '/api/quote-draft']);
  const body = f.calls[1].body;
  assert.deepEqual([body.action, body.actorId, body.customerId, body.sourceWalkthroughId, body.sourceRevision, 'jobId' in body], ['save', 'sales.person', 'customer-1', 'walk-1', 'w1r', false]);
  assert.equal(body.draft.line_items.length, 3);
  assert.equal(result.job.id, 'dispatch_job1'); assert.equal(f.accepted.length, 1);
  // The next save of the same walkthrough is a revision of the saved job at its current revision.
  await f.client.save(f.draft());
  assert.deepEqual([f.calls.at(-1).body.jobId, f.calls.at(-1).body.expectedRevision], ['dispatch_job1', 'r1']);
  assert.notEqual(f.calls.at(-1).body.requestId, body.requestId);
});

test('a lost save response is retried byte-for-byte after a reload, even if the form changed meanwhile', async () => {
  const f = fixture(); f.lose(1);
  await assert.rejects(f.client.save(f.draft()), error => error.status === 0 && error.retrying === false);
  const original = f.calls.at(-1).body, changed = f.draft(); changed.valid_until = '2026-10-20';
  const reloaded = createClient(f.deps), again = await reloaded.save(changed);
  assert.equal(again.retrying, true);
  assert.deepEqual(f.calls.at(-1).body, original);
  assert.equal(f.calls.filter(call => call.url.includes('?')).length, 1, 'the request was prepared once');
});

test('a refused save is discarded, and an account switch stops before the mutation', async () => {
  const f = fixture(); f.refuse(400);
  await assert.rejects(f.client.save(f.draft()), error => error.status === 400);
  const first = f.calls.at(-1).body.requestId;
  await f.client.save(f.draft());
  assert.notEqual(f.calls.at(-1).body.requestId, first);
  const g = fixture(), fetch = g.deps.fetch;
  g.deps.fetch = async (...args) => { const response = await fetch(...args); g.actor('someone.else'); return response; };
  await assert.rejects(createClient(g.deps).save(g.draft()), /account changed/);
  assert.equal(g.calls.filter(call => call.url === '/api/quote-draft').length, 0);
  const h = fixture(); h.deps.storage.setItem = () => { throw new Error('storage blocked'); };
  await assert.rejects(createClient(h.deps).save(h.draft()), /storage blocked/); assert.equal(h.calls.length, 0);
});

test('the confirmed send is persisted per quote revision and a lost response retries the original send, never a new one', async () => {
  const f = fixture(), { result } = await f.client.save(f.draft()), preview = await f.client.preview(result.job);
  assert.deepEqual(f.calls.at(-1).body, { action: 'send_preview', jobId: 'dispatch_job1', expectedRevision: 'r1' });
  f.lose(1);
  await assert.rejects(f.client.send(result.job, preview), error => error.status === 0);
  const original = f.calls.at(-1).body;
  assert.deepEqual([original.action, original.confirmToken, original.expectedRevision], ['send', 'ect1.synthetic', 'r1']);
  assert.ok(await f.client.pendingSend(result.job));
  const sent = await createClient(f.deps).send(result.job, { confirmToken: 'ect1.other' });
  assert.deepEqual(f.calls.at(-1).body, original);
  assert.equal(sent.delivery.status, 'messaging_disabled');
  assert.equal(await f.client.pendingSend(result.job), null);
  // A definite refusal (for example an expired confirmation) is not kept for a blind retry.
  f.refuse(410);
  await assert.rejects(f.client.send(result.job, preview), error => error.status === 410);
  assert.equal(await f.client.pendingSend(result.job), null);
});

test('a refused confirmation is never kept for a retry: the person previews again', async () => {
  const f = fixture(), { result } = await f.client.save(f.draft()), preview = await f.client.preview(result.job);
  for (const [status, code] of [[403, 'confirm_token_mismatch'], [403, 'confirm_token_invalid'], [409, 'confirm_token_used'], [410, 'confirm_token_expired']]) {
    f.refuse(status, code);
    await assert.rejects(f.client.send(result.job, preview), error => error.status === status && error.code === code);
    assert.equal(await f.client.pendingSend(result.job), null, code);
  }
  // Any other refusal that may clear up (a changed account, a server outage) keeps the original send.
  for (const [status, code] of [[403, 'quote_draft_actor_changed'], [503, 'quote_draft_unavailable']]) {
    f.refuse(status, code);
    await assert.rejects(f.client.send(result.job, preview), error => error.status === status);
    const kept = await f.client.pendingSend(result.job);
    assert.equal(kept?.body.confirmToken, 'ect1.synthetic', code);
  }
});

test('manual walkthroughs never share a quote job or a kept request: each revises only the job it saved', async () => {
  const f = fixture();
  let walkthrough = 'local-a', saved = '';
  Object.assign(f.deps, { source: () => '', draftId: () => walkthrough, savedJobId: () => saved, accept: result => { saved = result.job.id; f.accepted.push(result); } });
  const client = createClient(f.deps), other = () => { const value = f.draft(); value.client = { ...value.client, name: 'Synthetic Other', phone: '+19705550199', email: 'other@example.invalid', highlevel_contact_id: '' }; return value; };
  assert.equal((await client.save(f.draft())).result.job.id, 'manual_job1');
  // The same person starts another manual walkthrough for a different customer.
  walkthrough = 'local-b'; saved = '';
  const second = await client.save(other());
  assert.deepEqual([second.result.job.id, second.result.job.customerId], ['manual_job2', 'customer-2']);
  assert.equal('jobId' in f.calls.at(-1).body, false, 'the earlier walkthrough\'s job is not revised');
  await client.save(other());
  assert.deepEqual([f.calls.at(-1).body.jobId, f.calls.at(-1).body.customerId], ['manual_job2', 'customer-2']);
  // An unconfirmed save of walkthrough A is retried by walkthrough A only.
  walkthrough = 'local-a'; saved = 'manual_job1'; f.lose(1);
  await assert.rejects(client.save(f.draft()), error => error.status === 0);
  const lost = f.calls.at(-1).body;
  walkthrough = 'local-b'; saved = 'manual_job2';
  const b = await client.save(other());
  assert.deepEqual([b.retrying, f.calls.at(-1).body.jobId], [false, 'manual_job2']);
  walkthrough = 'local-a'; saved = 'manual_job1';
  const a = await client.save(f.draft());
  assert.deepEqual([a.retrying, f.calls.at(-1).body], [true, lost]);
  assert.deepEqual(f.calls.filter(call => call.url.startsWith('/api/walkthrough-handoff?')).map(call => call.url), ['/api/walkthrough-handoff?', '/api/walkthrough-handoff?', '/api/walkthrough-handoff?jobId=manual_job2', '/api/walkthrough-handoff?jobId=manual_job1', '/api/walkthrough-handoff?jobId=manual_job2']);
});

test('sign-out clears only the quote draft requests', async () => {
  const f = fixture(); f.lose(1);
  await assert.rejects(f.client.save(f.draft()));
  f.records.set('egc_walkthrough_v3:walk-1', '{}');
  f.client.clear();
  assert.deepEqual([...f.records.keys()], ['egc_walkthrough_v3:walk-1']);
});

test('a committed save whose 200 answer cannot be read keeps its request: the retry reuses it and never creates a second quote job', async () => {
  for (const answer of ['truncated', 'unexpected']) {
    const f = fixture();
    let saved = '';
    Object.assign(f.deps, { source: () => '', draftId: () => 'local-a', savedJobId: () => saved, accept: result => { saved = result.job.id; f.accepted.push(result); } });
    const client = createClient(f.deps);
    f.garble(answer);
    await assert.rejects(client.save(f.draft()), error => error.status === 200 && error.unknown === true && /retry it unchanged/.test(error.message), answer);
    assert.ok(await client.pendingSave(), 'the frozen request is kept');
    const again = await client.save(f.draft());
    const saves = f.calls.filter(call => call.url === '/api/quote-draft').map(call => call.body);
    assert.equal(again.retrying, true, answer);
    assert.deepEqual([saves.length, saves[0].requestId === saves[1].requestId, 'jobId' in saves[1]], [2, true, false], answer);
    assert.equal(again.result.job.id, 'manual_job1', 'the server replays the first save');
    assert.equal(await client.pendingSave(), null);
    // The next save revises that one job.
    await client.save(f.draft());
    assert.deepEqual([f.calls.at(-1).body.jobId, new Set(f.accepted.map(result => result.job.id)).size], ['manual_job1', 1]);
  }
  // Only a definite refusal discards the frozen request; sign-in, permission, timeout, rate-limit and server errors keep it.
  for (const [status, kept] of [[400, false], [404, false], [409, false], [401, true], [403, true], [408, true], [429, true], [500, true], [503, true]]) {
    const f = fixture(); f.refuse(status, 'quote_draft_synthetic');
    await assert.rejects(f.client.save(f.draft()), error => error.status === status);
    assert.equal(Boolean(await f.client.pendingSave()), kept, String(status));
  }
});

test('after a lost save the client reports the frozen quote and returns what was actually saved, even when the walkthrough changed', async () => {
  const f = fixture(); f.lose(1);
  await assert.rejects(f.client.save(f.draft()), error => error.status === 0);
  const frozen = await createClient(f.deps).pendingSave();
  assert.deepEqual(plain(frozen.draft.line_items).map(line => line.totalCents), [90000, 8600, 41400]);
  // The author edits the walkthrough (the cleanout is now $555.55) and saves in a new dialog.
  const edited = f.draft(); edited.line_items[0] = { ...edited.line_items[0], unitCents: 55555, totalCents: 55555 };
  const retried = await createClient(f.deps).save(edited);
  assert.equal(retried.retrying, true);
  assert.deepEqual(plain(retried.draft.line_items).map(line => line.totalCents), [90000, 8600, 41400], 'the frozen quote is what was saved');
  assert.equal(f.calls.at(-1).body.draft.line_items[0].totalCents, 90000);
  assert.equal(await f.client.pendingSave(), null);
  // Saving again now sends the edited quote as a new request that revises the saved job.
  const next = await f.client.save(edited);
  assert.deepEqual([next.retrying, f.calls.at(-1).body.draft.line_items[0].totalCents, f.calls.at(-1).body.jobId], [false, 55555, 'dispatch_job1']);
});

// /api/customer-resolve as customer-resolution.js runs it: a receipt per request id,
// fingerprinted on the body, so the same id with other details is a 409.
function resolveServer() {
  const records = new Map(), receipts = new Map(), resolves = [];
  let lose = 0;
  const storage = { getItem: key => records.get(key) ?? null, setItem: (key, value) => records.set(key, String(value)), removeItem: key => records.delete(key), get length() { return records.size; }, key: index => [...records.keys()][index] ?? null };
  const deps = {
    actor: async () => 'sales.person', storage, uuid: () => randomUUID(), source: () => '', draftId: () => 'manual-1', savedJobId: () => '', accept() {},
    fetch: async (url, options = {}) => {
      const body = options.body ? JSON.parse(options.body) : null;
      if (url.startsWith('/api/walkthrough-handoff?')) return reply({ ok: true, viewer: { id: 'sales.person' }, sourceRevision: '', customerId: '', jobId: '', expectedRevision: '', roster: [] });
      if (url === '/api/customer-resolve') {
        const fingerprint = JSON.stringify(body.customer), prior = receipts.get(body.requestId);
        resolves.push({ requestId: body.requestId, phone: body.customer.phone, status: prior && prior.fingerprint !== fingerprint ? 409 : 200 });
        if (prior && prior.fingerprint !== fingerprint) return reply({ ok: false, code: 'customer_resolve_idempotency_conflict', error: 'This request ID was already used for another customer.' }, 409);
        const customer = prior?.customer || { id: `customer-${receipts.size + 1}` };
        receipts.set(body.requestId, { fingerprint, customer });
        // The resolve committed; its answer is lost on the way back.
        if (lose > 0) { lose -= 1; throw new TypeError('network lost'); }
        return reply({ ok: true, customer });
      }
      if (url === '/api/quote-draft') return reply({ ok: true, requestId: body.requestId, job: { id: 'manual_job1', revision: 'r1', customerId: body.customerId, estimate: { number: 'EST-JOB1', revision: 1 } }, warnings: [] });
      throw new Error(`Unexpected route ${url}`);
    },
  };
  const draft = phone => draftFromWalkthrough({ ...payload(), client: { ...payload().client, phone } }, '2026-10-06');
  return { client: createClient(deps), receipts, resolves, draft, lose: count => { lose = count; } };
}

test('a lost customer-resolve answer is retried with its id for the same details, and corrected details get a new id instead of a 409 dead end', async () => {
  const same = resolveServer();
  same.lose(1);
  await assert.rejects(same.client.save(same.draft('+19705550100')), error => error.status === 0);
  const again = await same.client.save(same.draft('+19705550100'));
  assert.equal(again.result.job.customerId, 'customer-1', 'the committed resolve is replayed, not repeated');
  assert.deepEqual(plain(same.resolves.map(call => call.requestId === same.resolves[0].requestId)), [true, true]);
  // The author corrects the phone number after the lost answer: every later save works.
  const corrected = resolveServer();
  corrected.lose(1);
  await assert.rejects(corrected.client.save(corrected.draft('+19705550100')), error => error.status === 0);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const saved = await corrected.client.save(corrected.draft('+19705550111'));
    assert.equal(saved.result.job.customerId, 'customer-2');
  }
  assert.deepEqual(plain(corrected.resolves.map(call => call.status)), [200, 200, 200, 200]);
  assert.notEqual(corrected.resolves[1].requestId, corrected.resolves[0].requestId);
  assert.equal(new Set(corrected.resolves.slice(1).map(call => call.requestId)).size, 1, 'the corrected details keep one resolve id');
});

test('a resolve id the server already holds for other details is dropped after its 409, so the next save resolves afresh', async () => {
  const f = resolveServer();
  f.lose(1);
  await assert.rejects(f.client.save(f.draft('+19705550100')), error => error.status === 0);
  // The kept id is already bound to other details on the server (for example by an earlier version of this page).
  const kept = f.resolves[0].requestId;
  f.receipts.set(kept, { fingerprint: 'other customer details', customer: { id: 'customer-9' } });
  await assert.rejects(f.client.save(f.draft('+19705550100')), error => error.code === 'customer_resolve_idempotency_conflict' && error.status === 409);
  const saved = await f.client.save(f.draft('+19705550100'));
  assert.equal(saved.result.job.customerId, 'customer-2');
  assert.deepEqual(plain(f.resolves.map(call => [call.requestId === kept, call.status])), [[true, 200], [true, 409], [false, 200]]);
});
