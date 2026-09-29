import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createHubSessionCookie } from '../functions/_lib/hub-session.js';
import { decodeFirestoreFields } from '../functions/_lib/firestore-job.js';
import { storage } from './helpers/field-fixture.mjs';
import { fieldJobProjection } from '../functions/_lib/field-execution.js';
import { crewJobProjection } from '../functions/_lib/crew-job-projection.js';
import { FIELD_EXPENSE_STORED_LIMIT, createFieldExpenseStore, fieldExpenseCapacity, fieldExpenseChange, fieldExpenseRange, summarizeFieldExpenses, sumFieldExpenses } from '../functions/_lib/field-expenses.js';
import { fieldExpenseHandlers } from '../functions/api/field-expenses.js';
import * as fieldJobs from '../functions/api/field-jobs.js';

const NOW = '2026-09-22T18:00:00.000Z';
const users = { ZacB: { passwordHash: 'test', role: 'owner', displayName: 'Owner' }, 'Crew.One': { passwordHash: 'test', role: 'crew', displayName: 'Crew One' }, 'Crew.Two': { passwordHash: 'test', role: 'crew', displayName: 'Crew Two' }, 'Crew-One': { passwordHash: 'test', role: 'crew', displayName: 'Crew Other' } };
const env = { HUB_SESSION_SECRET: 'field-expense-test-secret', FIREBASE_API_KEY: 'firebase-test-field-expenses', HUB_AUTH_USERS_JSON: JSON.stringify(users), GOOGLE_CLIENT_ID: 'test', GOOGLE_CLIENT_SECRET: 'test', GOOGLE_REFRESH_TOKEN: 'test', FIELD_EXPENSES_ENABLED: 'true' };
const cookies = new Map(await Promise.all(Object.keys(users).map(async user => [user, (await createHubSessionCookie(env, user)).split(';')[0]])));
const uuid = () => crypto.randomUUID();
const picture = `data:image/jpeg;base64,${Buffer.from([255, 216, 255, 224, 0, 16, 74, 70, 73, 70, 0, 1, 255, 217]).toString('base64')}`;
const baseline = () => ({ id: 'job-1', type: 'job', customer: 'Synthetic Customer', address: '123 Synthetic Street', phone: '9705550100', date: '2026-09-22', time: '08:00', endTime: '11:00', assignedCrew: ['Crew.One', 'Crew.Two'], crewLead: 'Crew.One', status: 'in_progress', pipelineStatus: 'in_progress', total: 1500, payment: { amount: 100 } });
const url = 'https://easygaragecleaning.com/api/field-expenses';

function api({ now = NOW, environment = env } = {}) {
  const handlers = fieldExpenseHandlers({ now: () => new Date(now) });
  return {
    get: (user, search = '') => handlers.get({ env: environment, request: new Request(`${url}${search}`, { headers: { Cookie: cookies.get(user) || '' } }) }),
    post: (user, body, headers = {}) => handlers.post({ env: environment, request: new Request(url, { method: 'POST', headers: { Cookie: cookies.get(user) || '', Origin: 'https://easygaragecleaning.com', 'Content-Type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) }) }),
  };
}
const entry = (overrides = {}) => ({ jobId: 'job-1', requestId: uuid(), kind: 'dump_fee', amountCents: 8450, vendor: 'Synthetic County Landfill', note: 'Two loads', ...overrides });
const expenses = fixture => [...fixture.documents.keys()].filter(key => key.startsWith('jobs/job-1/fieldExpenses/'));

// The shared fixture emulates single-collection queries; this adds the
// collection-group range query used by the job-costing date-range read.
function collectionGroups(t, fixture, { indexed = true } = {}) {
  const provider = globalThis.fetch, seen = [];
  t.mock.method(globalThis, 'fetch', async (input, options = {}) => {
    const target = new URL(input);
    if (target.hostname === 'firestore.googleapis.com' && target.pathname.endsWith('/documents:runQuery')) {
      const spec = JSON.parse(options.body).structuredQuery;
      if (spec.from[0].allDescendants) {
        seen.push(spec);
        if (!indexed) return Response.json([{ error: { code: 400, status: 'FAILED_PRECONDITION', message: 'The query requires an index. Synthetic console link.' } }], { status: 400 });
        const filters = spec.where.compositeFilter.filters.map(item => item.fieldFilter);
        const rows = [...fixture.documents.entries()].filter(([key]) => key.split('/').at(-2) === spec.from[0].collectionId).map(([, document]) => document)
          .filter(document => { const row = decodeFirestoreFields(document.fields); return filters.every(item => item.op === 'GREATER_THAN_OR_EQUAL' ? row[item.field.fieldPath] >= item.value.stringValue : row[item.field.fieldPath] <= item.value.stringValue); });
        return Response.json([...rows.slice(0, spec.limit).map(document => ({ document, readTime: NOW })), ...(rows.length ? [] : [{ readTime: NOW }])]);
      }
    }
    return provider(input, options);
  });
  return seen;
}

// Firestore read-write transactions and batchGet on top of the shared fixture.
// As in Firestore, a transactional commit aborts (409 ABORTED) when a document
// read inside the transaction changed before the commit.
function transactions(t, fixture) {
  const provider = globalThis.fetch, open = new Map(), log = { begun: 0, committed: 0, aborted: 0, rolledBack: 0, reads: [] };
  const key = name => name.split('/documents/')[1];
  t.mock.method(globalThis, 'fetch', async (input, options = {}) => {
    const target = new URL(input), path = target.hostname === 'firestore.googleapis.com' ? target.pathname.split('/documents')[1] : '';
    if (path === ':beginTransaction') { const id = `synthetic-transaction-${++log.begun}`; open.set(id, new Map()); return Response.json({ transaction: id }); }
    if (path === ':rollback') { log.rolledBack++; open.delete(JSON.parse(options.body).transaction); return Response.json({}); }
    if (path === ':batchGet') {
      const body = JSON.parse(options.body), reads = body.transaction ? open.get(body.transaction) : null;
      if (body.transaction && !reads) return Response.json({}, { status: 400 });
      log.reads.push(body);
      return Response.json(body.documents.map(name => { const document = fixture.documents.get(key(name)); reads?.set(key(name), document?.updateTime || null); return document ? { found: document, readTime: NOW } : { missing: name, readTime: NOW }; }));
    }
    if (path === ':commit') {
      const body = JSON.parse(options.body);
      if (body.transaction) {
        const reads = open.get(body.transaction); open.delete(body.transaction);
        if (!reads) return Response.json({}, { status: 400 });
        if ([...reads].some(([name, time]) => (fixture.documents.get(name)?.updateTime || null) !== time)) { log.aborted++; return Response.json({ error: { status: 'ABORTED' } }, { status: 409 }); }
        const response = await provider(input, { ...options, body: JSON.stringify({ writes: body.writes }) });
        if (response.ok) log.committed++;
        return response;
      }
    }
    return provider(input, options);
  });
  return log;
}
const seed = (fixture, count, overrides = {}) => { for (let index = 0; index < count; index++) { const id = uuid(); fixture.put(`jobs/job-1/fieldExpenses/${id}`, { id, jobId: 'job-1', kind: 'material', amountCents: 1, vendor: 'Synthetic', state: 'applied', status: 'recorded', actorId: 'Crew.One', createdAt: NOW, ...overrides }); } };

test('capture is off unless FIELD_EXPENSES_ENABLED is exactly true and makes no storage calls', async t => {
  const fixture = storage(t); fixture.put('jobs/job-1', baseline());
  for (const flag of [undefined, 'false', '1', 'TRUE']) {
    const client = api({ environment: { ...env, FIELD_EXPENSES_ENABLED: flag } });
    for (const response of [await client.get('Crew.One', '?jobId=job-1'), await client.post('Crew.One', entry())]) {
      assert.equal(response.status, 404); assert.equal((await response.json()).code, 'FIELD_EXPENSES_DISABLED');
    }
  }
  assert.equal(fixture.calls.commits, 0); assert.equal(fixture.calls.queries.length, 0);
});

test('assigned crew records a dump fee in the job subcollection without touching the job document', async t => {
  const fixture = storage(t); fixture.put('jobs/job-1', baseline()); const revision = fixture.revision('job-1'), client = api();
  const input = entry();
  const response = await client.post('Crew.One', input); assert.equal(response.status, 200, await response.clone().text());
  assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
  const data = await response.json();
  assert.equal(data.alreadyApplied, false); assert.equal(data.scope, 'own'); assert.equal(data.entries.length, 1);
  assert.deepEqual({ kind: data.entries[0].kind, amountCents: data.entries[0].amountCents, vendor: data.entries[0].vendor, status: data.entries[0].status, state: data.entries[0].state, incurredOn: data.entries[0].incurredOn }, { kind: 'dump_fee', amountCents: 8450, vendor: 'Synthetic County Landfill', status: 'recorded', state: 'applied', incurredOn: '2026-09-22' });
  assert.equal(data.totals.totalCents, 8450); assert.equal(data.totals.byKind.dump_fee, 8450); assert.equal(data.totals.complete, true);
  const saved = fixture.get(`jobs/job-1/fieldExpenses/${input.requestId}`);
  assert.equal(saved.amountCents, 8450); assert.equal(saved.actorId, 'Crew.One'); assert.equal(saved.jobDate, '2026-09-22'); assert.equal(saved.createdAt, NOW);
  assert.equal(fixture.revision('job-1'), revision, 'the job document must not change');
  assert.deepEqual(fixture.get('jobs/job-1'), baseline());
});

test('idempotent replay returns the saved entry, conflicts on changed content and recovers a lost commit response', async t => {
  const fixture = storage(t); fixture.put('jobs/job-1', baseline()); const client = api(), input = entry({ requestId: uuid().toUpperCase() });
  assert.equal((await client.post('Crew.One', input)).status, 200);
  const replay = await (await client.post('Crew.One', input)).json();
  assert.equal(replay.alreadyApplied, true); assert.equal(replay.entries.length, 1); assert.equal(fixture.calls.commits, 1);
  assert.equal(expenses(fixture)[0], `jobs/job-1/fieldExpenses/${input.requestId.toLowerCase()}`);
  const lower = await (await client.post('Crew.One', { ...input, requestId: input.requestId.toLowerCase() })).json();
  assert.equal(lower.alreadyApplied, true, 'request IDs are case-insensitive');
  const changed = await client.post('Crew.One', { ...input, amountCents: 9999 }); assert.equal(changed.status, 409); assert.equal((await changed.json()).code, 'FIELD_IDEMPOTENCY_CONFLICT');
  assert.equal((await client.post('Crew.Two', input)).status, 409, 'another employee cannot replay a colleague entry');
  const provider = globalThis.fetch; let interrupt = true;
  t.mock.method(globalThis, 'fetch', async (target, options) => {
    const result = await provider(target, options);
    if (interrupt && new URL(target).pathname.endsWith('/documents:commit')) { interrupt = false; return Response.json({}, { status: 503 }); }
    return result;
  });
  const lost = await (await client.post('Crew.One', entry())).json();
  assert.equal(lost.ok, true); assert.equal(lost.alreadyApplied, true); assert.equal(lost.entries.length, 2); assert.equal(fixture.calls.commits, 2);
});

test('negative, zero, fractional, string and huge amounts and invalid details are rejected before any write', async t => {
  const fixture = storage(t); fixture.put('jobs/job-1', baseline()); const client = api();
  for (const amountCents of [-500, 0, 12.5, '8450', 500001, 1e20, null, true]) {
    const response = await client.post('Crew.One', entry({ amountCents }));
    assert.equal(response.status, 400, String(amountCents)); assert.equal((await response.json()).code, 'FIELD_EXPENSE_AMOUNT_INVALID');
  }
  assert.equal((await client.post('Crew.One', `{"jobId":"job-1","requestId":"${uuid()}","kind":"material","amountCents":1e400,"vendor":"Synthetic"}`)).status, 400, 'JSON overflow to Infinity');
  // FUN-19 made fuel a supported kind, so an unsupported kind is now e.g. lunch.
  for (const [overrides, code] of [[{ kind: 'lunch' }, 'FIELD_EXPENSE_KIND_INVALID'], [{ kind: 'fuel', payer: 'petty_cash' }, 'FIELD_EXPENSE_PAYER_INVALID'], [{ vendor: ' ' }, 'FIELD_EXPENSE_VENDOR_INVALID'], [{ vendor: 'x'.repeat(121) }, 'FIELD_EXPENSE_VENDOR_INVALID'], [{ kind: 'other', note: '' }, 'FIELD_EXPENSE_NOTE_INVALID'], [{ note: 'x'.repeat(1001) }, 'FIELD_EXPENSE_NOTE_INVALID']]) {
    assert.equal((await (await client.post('Crew.One', entry(overrides))).json()).code, code);
  }
  assert.equal((await client.post('Crew.One', { ...entry(), jobTotal: 1 })).status, 400, 'unknown keys are refused');
  assert.equal((await client.post('Crew.One', { ...entry(), action: 'delete' })).status, 400);
  assert.equal((await client.post('Crew.One', { ...entry(), requestId: 'not-a-uuid' })).status, 400);
  assert.equal((await client.post('Crew.One', { ...entry(), note: 'x'.repeat(17000) })).status, 413, 'entries without a receipt stay small');
  assert.equal(fixture.calls.commits, 0);
  assert.equal((await client.post('Crew.One', entry({ amountCents: 500000, kind: 'material' }))).status, 200, 'the $5,000 ceiling itself is accepted');
});

test('crew see only their own amounts; unassigned employees and customers-facing projections see none', async t => {
  const fixture = storage(t); fixture.put('jobs/job-1', baseline()); const client = api();
  await client.post('Crew.One', entry({ amountCents: 77123, vendor: 'Synthetic Canary Hardware', kind: 'material' }));
  await client.post('Crew.Two', entry({ amountCents: 1500, vendor: 'Synthetic Transfer Station' }));
  const two = await (await client.get('Crew.Two', '?jobId=job-1')).json();
  assert.equal(two.scope, 'own'); assert.deepEqual(two.entries.map(item => item.amountCents), [1500]); assert.equal(two.totals.totalCents, 1500);
  const text = JSON.stringify(two);
  for (const secret of ['77123', 'Synthetic Canary Hardware', 'Crew.One', 'Crew One', '78623', 'fingerprint', 'file-']) assert.equal(text.includes(secret), false, secret);
  assert.equal(two.entries[0].recordedBy, undefined); assert.equal(two.entries[0].audit, undefined); assert.equal(two.entries[0].receiptUrl, undefined);
  const outsider = await client.get('Crew-One', '?jobId=job-1'); assert.equal(outsider.status, 403);
  assert.equal(JSON.stringify(await outsider.json()).includes('77123'), false);
  assert.equal((await client.post('Crew-One', entry())).status, 403);
  assert.equal((await client.get('nobody', '?jobId=job-1')).status, 401);
  const manager = await (await client.get('ZacB', '?jobId=job-1')).json();
  assert.equal(manager.scope, 'job'); assert.equal(manager.entries.length, 2); assert.equal(manager.totals.totalCents, 78623);
  assert.deepEqual(manager.totals.byKind, { material: 77123, dump_fee: 1500, subcontractor: 0, fuel: 0, damage_claim: 0, other: 0, recovery_income: 0 });
  assert.deepEqual(manager.entries.map(item => item.recordedBy.id).sort(), ['Crew.One', 'Crew.Two']);
  fixture.put('jobs/job-1', { ...fixture.get('jobs/job-1'), assignedCrew: ['Crew.Two'] });
  assert.equal((await client.get('Crew.One', '?jobId=job-1')).status, 403, 'a reassigned recorder loses access to the job costs');
});

test('canary: field and crew job projections still carry no money after costs are recorded', async t => {
  const fixture = storage(t); fixture.put('jobs/job-1', baseline()); transactions(t, fixture); const client = api();
  assert.equal((await client.post('Crew.One', entry({ amountCents: 43219, vendor: 'Synthetic Canary Dump', receiptDataUrl: picture }))).status, 200);
  await client.post('ZacB', entry({ amountCents: 43219, kind: 'other', note: 'Synthetic canary rental', vendor: 'Synthetic Canary Rental' }));
  for (const user of ['Crew.One', 'Crew.Two', 'ZacB']) {
    const detail = JSON.stringify(await (await fieldJobs.onRequestGet({ env, request: new Request('https://easygaragecleaning.com/api/field-jobs?jobId=job-1', { headers: { Cookie: cookies.get(user) } }) })).json());
    for (const secret of ['43219', '86438', 'Synthetic Canary', 'fieldExpenses', 'amountCents', 'receipt']) assert.equal(detail.includes(secret), false, `${user}: ${secret}`);
  }
  const job = await createFieldExpenseStore(env).readJob('job-1');
  for (const projection of [fieldJobProjection(job, [], { manager: true }), crewJobProjection(job)]) assert.equal(/43219|86438|Canary|amountCents|fieldExpense/.test(JSON.stringify(projection)), false);
  assert.equal(Object.keys(fixture.get('jobs/job-1')).some(name => /expense|receipt|cost/i.test(name)), false);
  assert.equal(fixture.get('jobs/job-1').fieldExecution, undefined, 'receipts are never added to crew-visible job photos');
});

test('receipt photos follow the private verified photo protocol and only managers can open them', async t => {
  const fixture = storage(t); fixture.put('jobs/job-1', baseline()); const fence = transactions(t, fixture), client = api(), input = entry({ receiptDataUrl: picture });
  const response = await client.post('Crew.One', input); assert.equal(response.status, 200, await response.clone().text());
  const data = await response.json();
  assert.equal(data.entries[0].receiptVerified, true); assert.equal(data.entries[0].state, 'applied');
  assert.equal(fixture.calls.uploads, 1); assert.equal(fixture.calls.generated, 1);
  const file = fixture.drive.get('file-1');
  assert.deepEqual(file.appProperties, { egcJobId: 'job-1', egcFieldRequestId: input.requestId });
  assert.match(file.name, /^EGC-job-1-receipt-/);
  assert.equal(JSON.stringify(data).includes('file-1'), false, 'Drive file IDs are never returned');
  assert.equal(fixture.get(`jobs/job-1/fieldExpenses/${input.requestId}`).receipt.verified, true);
  assert.equal(fence.committed, 1, 'the verification write is fenced by a job-reading transaction');
  assert.equal((await (await client.post('Crew.One', input)).json()).alreadyApplied, true); assert.equal(fixture.calls.uploads, 1); assert.equal(fixture.calls.generated, 1);
  const manager = await (await client.get('ZacB', '?jobId=job-1')).json();
  const receiptUrl = manager.entries[0].receiptUrl; assert.equal(receiptUrl, `/api/field-expenses?jobId=job-1&expenseId=${input.requestId}&view=receipt`);
  const image = await client.get('ZacB', receiptUrl.slice('/api/field-expenses'.length));
  assert.equal(image.status, 200); assert.equal(image.headers.get('Cache-Control'), 'private, no-store'); assert.equal(image.headers.get('Content-Security-Policy'), "default-src 'none'");
  assert.equal((await client.get('Crew.One', receiptUrl.slice('/api/field-expenses'.length))).status, 403, 'receipts are management records');
  assert.equal((await client.get('ZacB', `?jobId=job-1&expenseId=${uuid()}&view=receipt`)).status, 404);
  assert.equal((await client.get('ZacB', '?jobId=job-1&jobId=job-2')).status, 400, 'duplicate parameters are refused');
});

test('spoofed or non-image receipts are refused before storage is allocated', async t => {
  const fixture = storage(t); fixture.put('jobs/job-1', baseline()); const client = api();
  for (const receiptDataUrl of ['data:image/svg+xml;base64,PHN2Zz4=', picture.replace('image/jpeg', 'image/png'), 'https://example.invalid/receipt.jpg', 'data:image/jpeg;base64,SGVsbG8gd29ybGQ=']) assert.equal((await client.post('Crew.One', entry({ receiptDataUrl }))).status, 400);
  assert.equal(fixture.calls.generated, 0); assert.equal(fixture.calls.commits, 0);
});

test('an unverified receipt keeps a resumable pending entry that is excluded from totals until retried', async t => {
  const fixture = storage(t); fixture.put('jobs/job-1', baseline()); transactions(t, fixture); const client = api(), provider = globalThis.fetch; let interrupt = true;
  t.mock.method(globalThis, 'fetch', async (target, options) => {
    const address = new URL(target);
    if (interrupt && address.hostname === 'www.googleapis.com' && address.pathname.endsWith('/file-1') && fixture.calls.uploads === 1) return Response.json({}, { status: 503 });
    return provider(target, options);
  });
  const input = entry({ amountCents: 2500, receiptDataUrl: picture });
  const failed = await client.post('Crew.One', input); assert.equal(failed.status, 503); assert.equal((await failed.json()).code, 'FIELD_PHOTO_VERIFY_FAILED');
  assert.equal(fixture.get(`jobs/job-1/fieldExpenses/${input.requestId}`).state, 'pending');
  const manager = await (await client.get('ZacB', '?jobId=job-1')).json();
  assert.equal(manager.totals.totalCents, 0); assert.equal(manager.totals.pendingCount, 1); assert.equal(manager.totals.complete, false);
  assert.equal(manager.entries[0].receiptUrl, null); assert.equal(manager.entries[0].canEdit, false);
  assert.equal((await client.post('Crew.One', { ...input, amountCents: 2600 })).status, 409, 'a pending entry cannot be repurposed');
  assert.equal((await client.post('ZacB', { action: 'edit', jobId: 'job-1', requestId: uuid(), expenseId: input.requestId, expectedRevision: manager.entries[0].expectedRevision, amountCents: 2400, reason: 'Adjust' })).status, 409, 'unverified costs cannot be corrected');
  interrupt = false;
  const retried = await (await client.post('Crew.One', input)).json();
  assert.equal(retried.ok, true); assert.equal(retried.totals.totalCents, 2500); assert.equal(retried.entries[0].receiptVerified, true);
  assert.equal(fixture.calls.uploads, 1); assert.equal(fixture.calls.generated, 1);
});

test('an abandoned unverified receipt can be voided so job totals become complete again', async t => {
  const fixture = storage(t); fixture.put('jobs/job-1', baseline()); const client = api(), id = uuid();
  fixture.put(`jobs/job-1/fieldExpenses/${id}`, { id, jobId: 'job-1', kind: 'material', amountCents: 3000, vendor: 'Synthetic', state: 'pending', status: 'recorded', actorId: 'Crew.One', createdAt: NOW, receipt: { fileId: 'file-9', verified: false } });
  const before = await (await client.get('ZacB', '?jobId=job-1')).json(); assert.equal(before.totals.complete, false); assert.equal(before.entries[0].canVoid, true);
  const after = await (await client.post('ZacB', { action: 'void', jobId: 'job-1', requestId: uuid(), expenseId: id, expectedRevision: before.entries[0].expectedRevision, reason: 'Receipt upload abandoned' })).json();
  assert.deepEqual({ complete: after.totals.complete, pendingCount: after.totals.pendingCount, voidCount: after.totals.voidCount, totalCents: after.totals.totalCents }, { complete: true, pendingCount: 0, voidCount: 1, totalCents: 0 });
  for (const action of ['constructor', '__proto__', 'toString']) assert.equal((await client.post('ZacB', { action, jobId: 'job-1', requestId: uuid() })).status, 400, action);
});

test('assignment is checked again after the receipt upload and before the amount counts', async t => {
  const fixture = storage(t); fixture.put('jobs/job-1', baseline()); transactions(t, fixture); const client = api(), provider = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (target, options) => {
    const result = await provider(target, options);
    if (new URL(target).pathname.startsWith('/upload/')) fixture.put('jobs/job-1', { ...fixture.get('jobs/job-1'), assignedCrew: ['Crew.Two'] });
    return result;
  });
  const input = entry({ receiptDataUrl: picture });
  assert.equal((await client.post('Crew.One', input)).status, 403);
  assert.equal(fixture.get(`jobs/job-1/fieldExpenses/${input.requestId}`).state, 'pending');
  assert.equal((await sumFieldExpenses(env, 'job-1')).totalCents, 0);
});

test('cancelled jobs refuse new crew costs, managers may still record, and the per-job limit holds', async t => {
  const fixture = storage(t); fixture.put('jobs/job-1', { ...baseline(), status: 'cancelled', pipelineStatus: 'cancelled' }); const client = api();
  const refused = await client.post('Crew.One', entry()); assert.equal(refused.status, 409); assert.equal((await refused.json()).code, 'FIELD_JOB_CLOSED');
  assert.equal((await (await client.get('Crew.One', '?jobId=job-1')).json()).canRecord, false);
  assert.equal((await client.post('ZacB', entry())).status, 200);
  fixture.put('jobs/job-1', baseline());
  for (let index = 1; index < 100; index++) { const id = uuid(); fixture.put(`jobs/job-1/fieldExpenses/${id}`, { id, jobId: 'job-1', kind: 'material', amountCents: 100, vendor: 'Synthetic', state: 'applied', status: 'recorded', actorId: 'Crew.One', createdAt: NOW }); }
  const limited = await client.post('Crew.One', entry()); assert.equal(limited.status, 409); assert.equal((await limited.json()).code, 'FIELD_EXPENSE_LIMIT');
});

test('managers correct and void costs with an audit trail; crew cannot and replays do not duplicate audits', async t => {
  const fixture = storage(t); fixture.put('jobs/job-1', baseline()); const client = api({ now: '2026-09-23T15:00:00.000Z' }), input = entry({ amountCents: 8450 });
  await client.post('Crew.One', input);
  let current = (await (await client.get('ZacB', '?jobId=job-1')).json()).entries[0];
  const correction = { action: 'edit', jobId: 'job-1', requestId: uuid(), expenseId: input.requestId, expectedRevision: current.expectedRevision, amountCents: 8045, reason: 'Receipt shows $80.45' };
  const crew = await client.post('Crew.One', correction); assert.equal(crew.status, 403); assert.equal((await crew.json()).code, 'FIELD_EXPENSE_MANAGER_REQUIRED');
  assert.equal((await client.post('ZacB', { ...correction, reason: '' })).status, 400);
  assert.equal((await client.post('ZacB', { ...correction, requestId: uuid(), amountCents: -1 })).status, 400);
  assert.equal((await client.post('ZacB', { ...correction, requestId: uuid(), amountCents: 8450 })).status, 400, 'a correction must change something');
  const edited = await (await client.post('ZacB', correction)).json();
  assert.equal(edited.ok, true); assert.equal(edited.totals.totalCents, 8045);
  current = edited.entries[0];
  assert.equal(current.edited, true); assert.equal(current.audit.length, 1);
  assert.deepEqual({ action: current.audit[0].action, before: current.audit[0].before, after: current.audit[0].after, reason: current.audit[0].reason, by: current.audit[0].by.id, at: current.audit[0].at }, { action: 'edit', before: { amountCents: 8450 }, after: { amountCents: 8045 }, reason: 'Receipt shows $80.45', by: 'ZacB', at: '2026-09-23T15:00:00.000Z' });
  const replay = await (await client.post('ZacB', correction)).json(); assert.equal(replay.alreadyApplied, true); assert.equal(replay.entries[0].audit.length, 1);
  assert.equal((await client.post('ZacB', { ...correction, amountCents: 8000 })).status, 409, 'the same correction ID cannot carry different values');
  const stale = await client.post('ZacB', { ...correction, requestId: uuid(), amountCents: 8100 }); assert.equal(stale.status, 409); assert.equal((await stale.json()).code, 'FIELD_EXPENSE_REVISION_CONFLICT');
  const dated = await (await client.post('ZacB', { action: 'edit', jobId: 'job-1', requestId: uuid(), expenseId: input.requestId, expectedRevision: current.expectedRevision, incurredOn: '2026-09-21', reason: 'Dump run was the day before' })).json();
  assert.equal(dated.entries[0].incurredOn, '2026-09-21'); current = dated.entries[0];
  assert.equal((await client.post('ZacB', { action: 'edit', jobId: 'job-1', requestId: uuid(), expenseId: input.requestId, expectedRevision: current.expectedRevision, incurredOn: '2026-09-24', reason: 'Future date' })).status, 400);
  const voided = await (await client.post('ZacB', { action: 'void', jobId: 'job-1', requestId: uuid(), expenseId: input.requestId, expectedRevision: current.expectedRevision, reason: 'Duplicate of the office entry' })).json();
  assert.equal(voided.totals.totalCents, 0); assert.equal(voided.totals.voidCount, 1); assert.equal(voided.entries[0].status, 'void');
  assert.equal(voided.entries[0].voided.reason, 'Duplicate of the office entry'); assert.equal(voided.entries[0].audit.length, 3);
  const again = await client.post('ZacB', { action: 'edit', jobId: 'job-1', requestId: uuid(), expenseId: input.requestId, expectedRevision: voided.entries[0].expectedRevision, amountCents: 100, reason: 'Late change' });
  assert.equal(again.status, 409); assert.equal((await again.json()).code, 'FIELD_EXPENSE_VOID');
  const own = await (await client.get('Crew.One', '?jobId=job-1')).json();
  assert.equal(own.entries[0].status, 'void'); assert.equal(own.entries[0].edited, true);
  assert.equal(/Duplicate of the office|Receipt shows|audit|ZacB/.test(JSON.stringify(own)), false, 'manager reasons stay management-only');
  const saved = fixture.get(`jobs/job-1/fieldExpenses/${input.requestId}`);
  assert.equal(saved.amountCents, 8045); assert.equal(saved.actorId, 'Crew.One', 'corrections keep the original recorder');
  assert.equal((await client.post('ZacB', { action: 'void', jobId: 'job-1', requestId: uuid(), expenseId: uuid(), expectedRevision: 'x', reason: 'Missing' })).status, 404);
});

test('pure correction rules reject non-managers, missing reasons and full audit trails', () => {
  const expense = { id: 'e', kind: 'material', amountCents: 100, vendor: 'Synthetic', note: '', state: 'applied', status: 'recorded', audit: [] };
  const manager = { user: 'ZacB', displayName: 'Owner', manager: true };
  assert.throws(() => fieldExpenseChange(expense, { ...manager, manager: false }, { action: 'void', requestId: uuid(), reason: 'Duplicate' }, 'f', NOW), error => error.status === 403);
  assert.throws(() => fieldExpenseChange(expense, manager, { action: 'void', requestId: uuid(), reason: ' ' }, 'f', NOW), error => error.code === 'FIELD_EXPENSE_REASON_INVALID');
  assert.throws(() => fieldExpenseChange({ ...expense, audit: Array.from({ length: 50 }, () => ({})) }, manager, { action: 'void', requestId: uuid(), reason: 'Duplicate' }, 'f', NOW), error => error.code === 'FIELD_EXPENSE_AUDIT_FULL');
  assert.throws(() => fieldExpenseChange(expense, manager, { action: 'edit', requestId: uuid(), kind: 'other', reason: 'Reclassify' }, 'f', NOW), error => error.code === 'FIELD_EXPENSE_NOTE_INVALID', 'reclassifying as other requires a description');
  const patch = fieldExpenseChange(expense, manager, { action: 'edit', requestId: uuid(), kind: 'other', note: 'Tarp rental', reason: 'Reclassify' }, 'f', NOW);
  assert.deepEqual(patch.audit[0].after, { kind: 'other', note: 'Tarp rental' });
});

test('sumFieldExpenses totals verified, non-void costs and flags unreadable rows as incomplete', async t => {
  const fixture = storage(t); fixture.put('jobs/job-1', baseline());
  const row = (overrides = {}) => { const id = uuid(); fixture.put(`jobs/job-1/fieldExpenses/${id}`, { id, jobId: 'forged-job', kind: 'material', amountCents: 1000, vendor: 'Synthetic', state: 'applied', status: 'recorded', actorId: 'Crew.One', createdAt: NOW, ...overrides }); };
  row(); row({ kind: 'dump_fee', amountCents: 6500, receipt: { fileId: 'file-x', verified: true } }); row({ status: 'void', amountCents: 99999 }); row({ state: 'pending', amountCents: 4000 });
  let summary = await sumFieldExpenses(env, 'job-1');
  // FUN-19 widened the summary: every kind, net of recovery income, and costs by payer (legacy rows are unspecified).
  assert.deepEqual(summary, { jobId: 'job-1', currency: 'USD', totalCents: 7500, costCents: 7500, recoveryIncomeCents: 0, byKind: { material: 1000, dump_fee: 6500, subcontractor: 0, fuel: 0, damage_claim: 0, other: 0, recovery_income: 0 }, byPayer: { company_card: 0, crew_reimbursable: 0, account_billed: 0, unspecified: 7500 }, count: 2, voidCount: 1, pendingCount: 1, invalidCount: 0, receiptCount: 1, sharedCount: 0, complete: false });
  row({ amountCents: '12.50' });
  summary = await sumFieldExpenses(env, 'job-1'); assert.equal(summary.invalidCount, 1); assert.equal(summary.totalCents, 7500);
  const listed = await createFieldExpenseStore(env).listExpenses('job-1'); assert.ok(listed.every(item => item.jobId === 'job-1'), 'the storage path, not stored data, identifies the job');
  assert.deepEqual(summarizeFieldExpenses([]), { currency: 'USD', totalCents: 0, costCents: 0, recoveryIncomeCents: 0, byKind: { material: 0, dump_fee: 0, subcontractor: 0, fuel: 0, damage_claim: 0, other: 0, recovery_income: 0 }, byPayer: { company_card: 0, crew_reimbursable: 0, account_billed: 0, unspecified: 0 }, count: 0, voidCount: 0, pendingCount: 0, invalidCount: 0, receiptCount: 0, sharedCount: 0, complete: true });
  await assert.rejects(sumFieldExpenses(env, '_egc_schedule_lock_2026-09-22'), error => error.status === 400);
});

test('managers read per-job totals for a Mountain date range; crew cannot; missing index fails closed', async t => {
  const fixture = storage(t); fixture.put('jobs/job-1', baseline()); fixture.put('jobs/job-2', { ...baseline(), id: 'job-2', date: '2026-09-25' });
  const seen = collectionGroups(t, fixture);
  const late = api({ now: '2026-09-23T03:30:00.000Z' });
  await late.post('Crew.One', entry({ amountCents: 1200 }));
  await api().post('Crew.One', entry({ amountCents: 3300, kind: 'material' }));
  await api({ now: '2026-09-25T16:00:00.000Z' }).post('Crew.One', { ...entry({ amountCents: 900 }), jobId: 'job-2' });
  await api({ now: '2026-10-05T16:00:00.000Z' }).post('Crew.One', entry({ amountCents: 5000 }));
  fixture.put(`archive/old/fieldExpenses/${uuid()}`, { kind: 'material', amountCents: 777777, incurredOn: '2026-09-22', state: 'applied', status: 'recorded' });
  const client = api();
  const range = await (await client.get('ZacB', '?start=2026-09-22&end=2026-09-30')).json();
  assert.equal(range.ok, true); assert.equal(range.basis, 'incurredOn'); assert.equal(range.timezone, 'America/Denver');
  assert.deepEqual(range.jobs.map(job => [job.jobId, job.totalCents, job.count]), [['job-1', 4500, 2], ['job-2', 900, 1]]);
  assert.deepEqual(range.jobs[0].jobDates, ['2026-09-22']);
  assert.equal(range.totals.totalCents, 5400, 'Mountain dates put a 9:30 PM MDT purchase on its local day; rows outside jobs are ignored');
  assert.equal(seen[0].from[0].allDescendants, true);
  assert.equal((await client.get('Crew.One', '?start=2026-09-22&end=2026-09-30')).status, 403);
  for (const search of ['?start=2026-09-30&end=2026-09-22', '?start=2026-01-01&end=2026-12-31', '?start=2026-02-30&end=2026-03-01', '?start=2026-09-22', '?start=2026-09-22&end=2026-09-23&jobId=job-1']) assert.equal((await client.get('ZacB', search)).status, 400, search);
  const direct = await fieldExpenseRange(env, { start: '2026-10-01', end: '2026-10-31' }); assert.equal(direct.totals.totalCents, 5000);
  const empty = await fieldExpenseRange(env, { start: '2025-01-01', end: '2025-01-31' }); assert.deepEqual(empty.jobs, []); assert.equal(empty.totals.complete, true);
});

test('a missing collection-group index is reported as setup work, never as zero cost', async t => {
  const fixture = storage(t); fixture.put('jobs/job-1', baseline()); collectionGroups(t, fixture, { indexed: false });
  const response = await api().get('ZacB', '?start=2026-09-01&end=2026-09-30');
  assert.equal(response.status, 503); const body = await response.json();
  assert.equal(body.code, 'FIELD_EXPENSE_INDEX_REQUIRED'); assert.equal(body.error.includes('Synthetic console link'), false);
});

test('mutations enforce same-origin JSON, bounded bodies and the signed-in account', async t => {
  const fixture = storage(t); fixture.put('jobs/job-1', baseline()); const client = api();
  assert.equal((await client.post('Crew.One', entry(), { Origin: 'https://attacker.example' })).status, 403);
  assert.equal((await client.post('Crew.One', entry(), { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await client.post('Crew.One', entry(), { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await client.post('Crew.One', '{')).status, 400);
  assert.equal((await client.post('Crew.One', '[]')).status, 400);
  assert.equal((await client.post('Crew.One', { ...entry(), expectedUser: 'Crew.Two' })).status, 401);
  assert.equal((await client.post('Crew.One', entry({ receiptDataUrl: `data:image/jpeg;base64,${'A'.repeat(9 * 1024 * 1024)}` }))).status, 413);
  assert.equal((await client.post('nobody', entry())).status, 401);
  assert.equal(fixture.calls.commits, 0);
});

test('the Firestore rules keep field costs server-only', () => {
  const rules = readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8');
  assert.doesNotMatch(rules, /fieldExpenses/);
  assert.doesNotMatch(rules, /fieldExpenseRequests/);
  assert.match(rules, /match \/jobs\/\{documentId\} \{/, 'the jobs grant must not be recursive');
  assert.doesNotMatch(rules, /match \/jobs\/\{[^}]*=\*\*\}/);
  assert.match(rules, /match \/\{document=\*\*\} \{\s*allow read, write: if false;/);
});

test('the crew form parses dollar text into exact integer cents', () => {
  const context = { addEventListener() {}, Intl, Number, String, Object, Array, JSON };
  context.window = context;
  vm.createContext(context); vm.runInContext(readFileSync(new URL('../crew/field-expenses.js', import.meta.url), 'utf8'), context);
  const { parseCents } = context.EGCFieldExpenses;
  for (const [text, cents] of [['42', 4200], ['42.5', 4250], ['42.50', 4250], ['$1,234.56', 123456], [' 0.07 ', 7], ['19.99', 1999], ['0.29', 29], ['1.005', null], ['-5', null], ['1e3', null], ['', null], ['12,34', null], ['abc', null], ['.5', null]]) assert.equal(parseCents(text), cents, text);
});

test('a replay after the job is cancelled still reports the saved cost instead of refusing it', async t => {
  const fixture = storage(t); fixture.put('jobs/job-1', baseline()); transactions(t, fixture); const client = api(), input = entry(), receipt = entry({ amountCents: 1900, receiptDataUrl: picture });
  assert.equal((await client.post('Crew.One', input)).status, 200); assert.equal((await client.post('Crew.One', receipt)).status, 200);
  fixture.put('jobs/job-1', { ...fixture.get('jobs/job-1'), status: 'cancelled', pipelineStatus: 'cancelled' });
  for (const body of [input, receipt]) {
    const replay = await client.post('Crew.One', body); assert.equal(replay.status, 200, await replay.clone().text());
    const data = await replay.json();
    assert.equal(data.alreadyApplied, true); assert.equal(data.entryStatus, 'recorded'); assert.equal(data.entries.length, 2); assert.equal(data.canRecord, false);
  }
  assert.equal(fixture.calls.uploads, 1, 'the replay did not upload the receipt again');
  const conflict = await client.post('Crew.One', { ...input, amountCents: 1 }); assert.equal((await conflict.json()).code, 'FIELD_IDEMPOTENCY_CONFLICT', 'a reused ID is still a conflict on a closed job');
  const fresh = await client.post('Crew.One', entry()); assert.equal(fresh.status, 409); assert.equal((await fresh.json()).code, 'FIELD_JOB_CLOSED');
});

test('the receipt verification write is fenced to the job revision whose assignment was re-checked', async t => {
  const fixture = storage(t); fixture.put('jobs/job-1', baseline()); const fence = transactions(t, fixture), provider = globalThis.fetch, client = api(); let change = null;
  // Applies a job change after the fenced read and before the commit.
  t.mock.method(globalThis, 'fetch', async (target, options = {}) => {
    const response = await provider(target, options);
    if (change && new URL(target).pathname.endsWith('/documents:batchGet') && JSON.parse(options.body).transaction) { const apply = change; change = null; apply(); }
    return response;
  });
  change = () => fixture.put('jobs/job-1', { ...fixture.get('jobs/job-1'), fieldLastActionAt: NOW });
  const first = entry({ amountCents: 2100, receiptDataUrl: picture }), saved = await (await client.post('Crew.One', first)).json();
  assert.equal(saved.ok, true); assert.equal(saved.alreadyApplied, false); assert.equal(saved.entries[0].state, 'applied');
  assert.deepEqual({ aborted: fence.aborted, committed: fence.committed }, { aborted: 1, committed: 1 }, 'a concurrent job edit aborts the commit and the re-check applies it');
  change = () => fixture.put('jobs/job-1', { ...fixture.get('jobs/job-1'), status: 'cancelled', pipelineStatus: 'cancelled' });
  const second = entry({ amountCents: 3300, receiptDataUrl: picture }), refused = await client.post('Crew.One', second);
  assert.equal(refused.status, 409); assert.equal((await refused.json()).code, 'FIELD_JOB_CLOSED');
  assert.equal(fence.aborted, 2); assert.equal(fixture.get(`jobs/job-1/fieldExpenses/${second.requestId}`).state, 'pending', 'a cancellation between the check and the commit is never counted');
  assert.equal((await sumFieldExpenses(env, 'job-1')).totalCents, 2100);
  fixture.put('jobs/job-1', { ...baseline(), assignedCrew: ['Crew.Two'] });
  change = () => fixture.put('jobs/job-1', { ...fixture.get('jobs/job-1'), assignedCrew: ['Crew.One'] });
  assert.equal((await client.post('ZacB', entry({ amountCents: 700, receiptDataUrl: picture }))).status, 200, 'managers are fenced too and retry after a benign change');
  assert.equal(Object.keys(fixture.get('jobs/job-1')).some(name => /expense|receipt|cost/i.test(name)), false, 'the fence never writes the job document');
});

test('a pending receipt voided by operations is reported as void on retry, never as saved', async t => {
  const fixture = storage(t); fixture.put('jobs/job-1', baseline()); transactions(t, fixture); const client = api(), provider = globalThis.fetch; let interrupt = true;
  t.mock.method(globalThis, 'fetch', async (target, options) => {
    const address = new URL(target);
    if (interrupt && address.hostname === 'www.googleapis.com' && address.pathname.endsWith('/file-1') && fixture.calls.uploads === 1) return Response.json({}, { status: 503 });
    return provider(target, options);
  });
  const input = entry({ amountCents: 2500, receiptDataUrl: picture });
  assert.equal((await client.post('Crew.One', input)).status, 503);
  const manager = await (await client.get('ZacB', '?jobId=job-1')).json();
  assert.equal((await client.post('ZacB', { action: 'void', jobId: 'job-1', requestId: uuid(), expenseId: input.requestId, expectedRevision: manager.entries[0].expectedRevision, reason: 'Receipt never arrived' })).status, 200);
  interrupt = false;
  const retried = await client.post('Crew.One', input); assert.equal(retried.status, 409);
  const body = await retried.json(); assert.equal(body.code, 'FIELD_EXPENSE_VOID'); assert.match(body.error, /voided/); assert.doesNotMatch(body.error, /saved/i);
  assert.equal(fixture.calls.uploads, 1, 'a voided entry does not upload again');
  const after = await (await client.get('ZacB', '?jobId=job-1')).json();
  assert.deepEqual({ total: after.totals.totalCents, void: after.totals.voidCount, pending: after.totals.pendingCount }, { total: 0, void: 1, pending: 0 });
  // Voided while the receipt was uploading.
  const during = entry({ amountCents: 4100, receiptDataUrl: picture }), path = `jobs/job-1/fieldExpenses/${during.requestId}`;
  t.mock.method(globalThis, 'fetch', async (target, options) => {
    const response = await provider(target, options);
    if (new URL(target).pathname.startsWith('/upload/') && fixture.documents.has(path)) fixture.put(path, { ...fixture.get(path), status: 'void', voidedAt: NOW, voidedBy: 'ZacB' });
    return response;
  });
  const racing = await client.post('Crew.One', during); assert.equal(racing.status, 409); assert.equal((await racing.json()).code, 'FIELD_EXPENSE_VOID');
  assert.equal(fixture.get(path).state, 'pending');
  // An applied cost voided later replays as applied but reports its void status.
  const plain = entry({ amountCents: 900 }); await client.post('Crew.One', plain);
  const current = (await (await client.get('ZacB', '?jobId=job-1')).json()).entries.find(item => item.id === plain.requestId);
  await client.post('ZacB', { action: 'void', jobId: 'job-1', requestId: uuid(), expenseId: plain.requestId, expectedRevision: current.expectedRevision, reason: 'Office duplicate' });
  const replay = await (await client.post('Crew.One', plain)).json();
  assert.equal(replay.ok, true); assert.equal(replay.alreadyApplied, true); assert.equal(replay.entryStatus, 'void');
});

test('correction request IDs are idempotent across every cost on the job', async t => {
  const fixture = storage(t); fixture.put('jobs/job-1', baseline()); const client = api({ now: '2026-09-23T15:00:00.000Z' });
  const a = entry(), b = entry({ amountCents: 1200 });
  await client.post('Crew.One', a); await client.post('Crew.One', b);
  const listed = await (await client.get('ZacB', '?jobId=job-1')).json(), revision = id => listed.entries.find(item => item.id === id).expectedRevision;
  const requestId = uuid(), voidA = { action: 'void', jobId: 'job-1', requestId, expenseId: a.requestId, expectedRevision: revision(a.requestId), reason: 'Duplicate entry' };
  const first = await client.post('ZacB', voidA); assert.equal(first.status, 200); assert.equal((await first.json()).alreadyApplied, false);
  const replay = await (await client.post('ZacB', voidA)).json(); assert.equal(replay.alreadyApplied, true, 'a replay with the now-stale revision is still recognized');
  const reused = await client.post('ZacB', { ...voidA, expenseId: b.requestId, expectedRevision: revision(b.requestId) });
  assert.equal(reused.status, 409); assert.equal((await reused.json()).code, 'FIELD_IDEMPOTENCY_CONFLICT');
  assert.equal(fixture.get(`jobs/job-1/fieldExpenses/${b.requestId}`).status, 'recorded', 'the second expense was not voided');
  assert.deepEqual((({ action, expenseId, actorId, at, state }) => ({ action, expenseId, actorId, at, state }))(fixture.get(`jobs/job-1/fieldExpenseRequests/${requestId}`)), { action: 'void', expenseId: a.requestId, actorId: 'ZacB', at: '2026-09-23T15:00:00.000Z', state: 'applied' });
  const recordId = await client.post('ZacB', { action: 'edit', jobId: 'job-1', requestId: b.requestId, expenseId: b.requestId, expectedRevision: revision(b.requestId), amountCents: 1300, reason: 'Receipt shows $13' });
  assert.equal(recordId.status, 409, 'an ID used to record a cost cannot also correct one');
  const reusedForCreate = await client.post('ZacB', entry({ requestId })); assert.equal(reusedForCreate.status, 409); assert.equal((await reusedForCreate.json()).code, 'FIELD_IDEMPOTENCY_CONFLICT');
  const provider = globalThis.fetch; let interrupt = true;
  t.mock.method(globalThis, 'fetch', async (target, options) => {
    const result = await provider(target, options);
    if (interrupt && new URL(target).pathname.endsWith('/documents:commit')) { interrupt = false; return Response.json({}, { status: 503 }); }
    return result;
  });
  const edit = { action: 'edit', jobId: 'job-1', requestId: uuid(), expenseId: b.requestId, expectedRevision: revision(b.requestId), amountCents: 1300, reason: 'Receipt shows $13' };
  const lost = await (await client.post('ZacB', edit)).json();
  assert.equal(lost.ok, true); assert.equal(lost.alreadyApplied, true, 'a lost correction response is recovered from its receipt');
  assert.equal(lost.entries.find(item => item.id === b.requestId).audit.length, 1);
  const crew = JSON.stringify(await (await client.get('Crew.One', '?jobId=job-1')).json());
  assert.equal(crew.includes(requestId), false, 'correction receipts stay management-only');
});

test('capacity counts active entries, gives managers more room and caps unconfirmed receipts per person', async t => {
  const fixture = storage(t); fixture.put('jobs/job-1', baseline()); transactions(t, fixture); const client = api();
  seed(fixture, 100, { status: 'void' });
  assert.equal((await client.post('Crew.Two', entry())).status, 200, 'voided rows do not block crew');
  seed(fixture, 99);
  const crew = await client.post('Crew.Two', entry()); assert.equal(crew.status, 409); assert.equal((await crew.json()).code, 'FIELD_EXPENSE_LIMIT');
  assert.equal((await client.post('ZacB', entry())).status, 200, 'managers keep a higher allowance');
  seed(fixture, 49, { state: 'pending', actorId: 'Crew.Two', receipt: { fileId: 'file-seeded', verified: false } });
  const manager = await client.post('ZacB', entry()); assert.equal(manager.status, 409, 'pending entries count toward the active limit');
  assert.match((await manager.json()).error, /150 active/);
  const other = storage(t); other.put('jobs/job-1', baseline()); transactions(t, other);
  seed(other, 5, { state: 'pending', actorId: 'crew.one', receipt: { fileId: 'file-seeded', verified: false } });
  const capped = await client.post('Crew.One', entry({ receiptDataUrl: picture })); assert.equal(capped.status, 409);
  assert.equal((await capped.json()).code, 'FIELD_EXPENSE_PENDING_LIMIT'); assert.equal(other.calls.generated, 0, 'no Drive file is allocated past the cap');
  assert.equal((await client.post('Crew.One', entry())).status, 200, 'a cost without a receipt never becomes pending');
  assert.equal((await client.post('Crew.Two', entry({ receiptDataUrl: picture }))).status, 200, 'the cap is per person');
  const full = storage(t); full.put('jobs/job-1', baseline()); seed(full, FIELD_EXPENSE_STORED_LIMIT, { status: 'void' });
  const stored = await client.post('ZacB', entry()); assert.equal(stored.status, 409); assert.match((await stored.json()).error, /stored cost-record limit/);
});

test('pure capacity rules', () => {
  const rows = (count, overrides = {}) => Array.from({ length: count }, () => ({ status: 'recorded', state: 'applied', actorId: 'Crew.One', ...overrides }));
  const code = expected => error => error.code === expected;
  assert.doesNotThrow(() => fieldExpenseCapacity(rows(FIELD_EXPENSE_STORED_LIMIT - 1, { status: 'void' }), { user: 'Crew.Two' }));
  assert.throws(() => fieldExpenseCapacity(rows(FIELD_EXPENSE_STORED_LIMIT, { status: 'void' }), { manager: true, user: 'ZacB' }), code('FIELD_EXPENSE_LIMIT'));
  assert.throws(() => fieldExpenseCapacity([...rows(99), ...rows(1, { state: 'pending' })], { user: 'Crew.Two' }), code('FIELD_EXPENSE_LIMIT'));
  assert.doesNotThrow(() => fieldExpenseCapacity(rows(149), { manager: true, user: 'ZacB' }));
  assert.throws(() => fieldExpenseCapacity(rows(150), { manager: true, user: 'ZacB' }), code('FIELD_EXPENSE_LIMIT'));
  const pending = rows(5, { state: 'pending', actorId: 'crew.one' });
  assert.throws(() => fieldExpenseCapacity(pending, { user: 'Crew.One', receipt: true }), code('FIELD_EXPENSE_PENDING_LIMIT'));
  assert.doesNotThrow(() => fieldExpenseCapacity(pending, { user: 'Crew.One' }));
  assert.doesNotThrow(() => fieldExpenseCapacity(pending, { user: 'Crew.Two', receipt: true }));
  assert.doesNotThrow(() => fieldExpenseCapacity([...rows(4, { state: 'pending' }), ...rows(1, { state: 'pending', status: 'void' })], { user: 'Crew.One', receipt: true }), 'a voided upload frees its slot');
});

test('date ranges include both ends up to 92 days and report current job dates', async t => {
  const fixture = storage(t); fixture.put('jobs/job-1', baseline()); fixture.put('jobs/job-2', { ...baseline(), id: 'job-2' }); fixture.put('jobs/job-3', { ...baseline(), id: 'job-3' });
  collectionGroups(t, fixture); const batch = transactions(t, fixture), client = api();
  await client.post('Crew.One', entry({ amountCents: 1000 }));
  for (const jobId of ['job-2', 'job-3']) await client.post('Crew.One', { ...entry({ amountCents: 500 }), jobId });
  fixture.put('jobs/job-1', { ...fixture.get('jobs/job-1'), date: '2026-09-24', endDate: '2026-09-25' });
  fixture.put('jobs/job-3', { ...fixture.get('jobs/job-3'), date: '2026-09-20' });
  fixture.documents.delete('jobs/job-2');
  const range = await (await client.get('ZacB', '?start=2026-07-01&end=2026-09-30')).json();
  assert.equal(range.ok, true, '92 days with both ends included');
  assert.deepEqual(range.jobs.map(job => [job.jobId, job.jobDates, job.jobDatesBasis, job.totalCents]), [['job-3', ['2026-09-20'], 'current', 500], ['job-2', ['2026-09-22'], 'recorded', 500], ['job-1', ['2026-09-24', '2026-09-25'], 'current', 1000]]);
  assert.equal(batch.reads.filter(read => !read.transaction).length, 1, 'current schedules are read in one batch');
  const long = await client.get('ZacB', '?start=2026-07-01&end=2026-10-01'); assert.equal(long.status, 400);
  assert.equal((await long.json()).error, 'Choose a start and end date covering at most 92 days, both dates included.');
  const store = { listRange: async () => [{ id: uuid(), jobId: 'job-1', jobDate: '2026-09-22', kind: 'material', amountCents: 100, state: 'applied', status: 'recorded' }], jobSchedules: async () => { throw new Error('Synthetic outage'); } };
  const fallback = await fieldExpenseRange(env, { start: '2026-09-01', end: '2026-09-30' }, { store });
  assert.deepEqual([fallback.jobs[0].jobDates, fallback.jobs[0].jobDatesBasis, fallback.totals.totalCents], [['2026-09-22'], 'recorded', 100], 'a schedule outage keeps totals and labels dates as recorded');
});

test('the job page payload reports whether job costs are on, without any cost data', async t => {
  const fixture = storage(t); fixture.put('jobs/job-1', baseline());
  for (const [flag, expected] of [[undefined, false], ['false', false], ['1', false], ['true', true]]) {
    const detail = await (await fieldJobs.onRequestGet({ env: { ...env, FIELD_EXPENSES_ENABLED: flag }, request: new Request('https://easygaragecleaning.com/api/field-jobs?jobId=job-1', { headers: { Cookie: cookies.get('Crew.One') } }) })).json();
    assert.equal(detail.ok, true); assert.deepEqual(detail.features, { jobCosts: expected, fieldPay: false, fieldPayReview: false }, String(flag));
  }
  assert.equal(fixture.calls.queries.some(query => query.from?.[0]?.collectionId === 'fieldExpenses'), false, 'the flag never reads cost data');
});

test('sumFieldExpenses takes env first and accepts an injected store', async () => {
  await assert.rejects(sumFieldExpenses('job-1'), TypeError, 'the spec shorthand sumFieldExpenses(jobId) fails loudly');
  const store = { listExpenses: async jobId => [{ id: uuid(), jobId, kind: 'dump_fee', amountCents: 2550, state: 'applied', status: 'recorded' }] };
  assert.deepEqual(await sumFieldExpenses({}, 'job-1', { store }), { jobId: 'job-1', currency: 'USD', totalCents: 2550, costCents: 2550, recoveryIncomeCents: 0, byKind: { material: 0, dump_fee: 2550, subcontractor: 0, fuel: 0, damage_claim: 0, other: 0, recovery_income: 0 }, byPayer: { company_card: 0, crew_reimbursable: 0, account_billed: 0, unspecified: 2550 }, count: 1, voidCount: 0, pendingCount: 0, invalidCount: 0, receiptCount: 0, sharedCount: 0, complete: true });
});
