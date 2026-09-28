import test from 'node:test';
import assert from 'node:assert/strict';
import { createHubSessionCookie } from '../functions/_lib/hub-session.js';
import { decodeFirestoreFields } from '../functions/_lib/firestore-job.js';
import { fieldChecklist, fieldRequestId } from '../functions/_lib/field-execution.js';
import { storage } from './helpers/field-fixture.mjs';
import { FIELD_EXPENSE_KINDS, createFieldExpenseStore, fieldExpenseChange, fieldExpenseCloseout, fieldExpenseCloseoutMissing, fieldExpenseCloseoutStatus, fieldExpenseCosts, fieldExpenseJobCosts, fieldExpenseRange, fieldExpenseShareId, fieldExpenseShareParts, fieldExpenseValues, splitSharedCents, sumFieldExpenses, summarizeFieldExpenses } from '../functions/_lib/field-expenses.js';
import { fieldExpenseHandlers } from '../functions/api/field-expenses.js';
import * as fieldJobs from '../functions/api/field-jobs.js';

const NOW = '2026-09-22T18:00:00.000Z';
const users = { ZacB: { passwordHash: 'test', role: 'owner', displayName: 'Owner' }, 'Crew.One': { passwordHash: 'test', role: 'crew', displayName: 'Crew One' }, 'Crew.Two': { passwordHash: 'test', role: 'crew', displayName: 'Crew Two' } };
const env = { HUB_SESSION_SECRET: 'field-closeout-test-secret', FIREBASE_API_KEY: 'firebase-test-field-closeout', HUB_AUTH_USERS_JSON: JSON.stringify(users), GOOGLE_CLIENT_ID: 'test', GOOGLE_CLIENT_SECRET: 'test', GOOGLE_REFRESH_TOKEN: 'test', FIELD_EXPENSES_ENABLED: 'true' };
const required = { ...env, FIELD_EXPENSE_CLOSEOUT_REQUIRED: 'true' };
const cookies = new Map(await Promise.all(Object.keys(users).map(async user => [user, (await createHubSessionCookie(env, user)).split(';')[0]])));
const uuid = () => crypto.randomUUID();
const DAMAGE = '0f0f0f0f-1111-4222-8333-444455556666', BEFORE = '0e0e0e0e-1111-4222-8333-444455556666';
const picture = `data:image/jpeg;base64,${Buffer.from([255, 216, 255, 224, 0, 16, 74, 70, 73, 70, 0, 1, 255, 217]).toString('base64')}`;
const photo = (id, category) => ({ id, fileId: `image-${category}`, category, caption: `Synthetic ${category}`, verified: true, createdAt: NOW });
const job = (id, overrides = {}) => ({ id, type: 'job', customer: `Synthetic Customer ${id}`, address: '123 Synthetic Street', date: '2026-09-22', time: '08:00', endTime: '11:00', assignedCrew: ['Crew.One', 'Crew.Two'], status: 'in_progress', pipelineStatus: 'in_progress', fieldExecution: { photos: [photo(BEFORE, 'before'), photo(DAMAGE, 'damage')] }, ...overrides });
const url = 'https://easygaragecleaning.com/api/field-expenses';
function api({ now = NOW, environment = env } = {}) {
  const handlers = fieldExpenseHandlers({ now: () => new Date(now) });
  return {
    get: (user, search = '') => handlers.get({ env: environment, request: new Request(`${url}${search}`, { headers: { Cookie: cookies.get(user) || '' } }) }),
    post: (user, body) => handlers.post({ env: environment, request: new Request(url, { method: 'POST', headers: { Cookie: cookies.get(user) || '', Origin: 'https://easygaragecleaning.com', 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) }),
  };
}
const entry = (overrides = {}) => ({ jobId: 'job-1', requestId: uuid(), kind: 'dump_fee', amountCents: 6000, vendor: 'Synthetic County Landfill', note: '', payer: 'company_card', ...overrides });
const rows = (fixture, jobId) => [...fixture.documents.keys()].filter(key => key.startsWith(`jobs/${jobId}/fieldExpenses/`)).map(key => fixture.get(key));
function setup(t, extra = {}) {
  const fixture = storage(t);
  fixture.put('jobs/job-1', job('job-1')); fixture.put('jobs/job-2', job('job-2', { assignedCrew: ['Crew.One'], time: '13:00' }));
  fixture.put('jobs/job-3', job('job-3', { assignedCrew: ['Crew.Two'] })); fixture.put('jobs/job-4', job('job-4', { assignedCrew: ['Crew.One'], status: 'cancelled', pipelineStatus: 'cancelled' }));
  fixture.put('jobs/job-5', job('job-5', { assignedCrew: ['Crew.One'], date: '2026-09-23' }));
  for (const [path, value] of Object.entries(extra)) fixture.put(path, value);
  return fixture;
}
// Firestore read-write transactions and batchGet over the shared fixture: a
// transactional commit aborts (409) when a job read inside it changed.
function transactions(t, fixture) {
  const provider = globalThis.fetch, open = new Map(), log = { committed: 0, aborted: 0, reads: [] }, key = name => name.split('/documents/')[1];
  t.mock.method(globalThis, 'fetch', async (input, options = {}) => {
    const target = new URL(input), path = target.hostname === 'firestore.googleapis.com' ? target.pathname.split('/documents')[1] : '';
    if (path === ':beginTransaction') { const id = `synthetic-transaction-${open.size + log.committed + log.aborted + 1}`; open.set(id, new Map()); return Response.json({ transaction: id }); }
    if (path === ':rollback') { open.delete(JSON.parse(options.body).transaction); return Response.json({}); }
    if (path === ':batchGet') {
      const body = JSON.parse(options.body), reads = body.transaction ? open.get(body.transaction) : null; log.reads.push(body);
      return Response.json(body.documents.map(name => { const document = fixture.documents.get(key(name)); reads?.set(key(name), document?.updateTime || null); return document ? { found: document } : { missing: name }; }));
    }
    if (path === ':commit' && JSON.parse(options.body).transaction) {
      const body = JSON.parse(options.body), reads = open.get(body.transaction); open.delete(body.transaction);
      if ([...reads].some(([name, time]) => (fixture.documents.get(name)?.updateTime || null) !== time)) { log.aborted++; return Response.json({ error: { status: 'ABORTED' } }, { status: 409 }); }
      const response = await provider(input, { ...options, body: JSON.stringify({ writes: body.writes }) }); if (response.ok) log.committed++; return response;
    }
    return provider(input, options);
  });
  return log;
}

test('shared loads split in integer cents by the largest-remainder rule and always sum to the total', () => {
  const parts = weights => weights.map(weight => ({ weight }));
  assert.deepEqual(splitSharedCents(100, parts([1, 1, 1])), [34, 33, 33], 'a tie gives the leftover cent to the recording job first');
  assert.deepEqual(splitSharedCents(1000, parts([2, 1])), [667, 333]);
  assert.deepEqual(splitSharedCents(10, parts([3, 4])), [4, 6], 'the largest remainder (40 mod 7 = 5) beats order');
  assert.deepEqual(splitSharedCents(7, parts([1, 1, 2])), [2, 2, 3]);
  assert.deepEqual(splitSharedCents(6001, parts([1, 1])), [3001, 3000]);
  assert.throws(() => splitSharedCents(2, parts([1, 1, 1])), error => error.code === 'FIELD_EXPENSE_SHARE_INVALID', 'a part of zero cents is refused');
  let seed = 7; const next = limit => (seed = (seed * 1103515245 + 12345) % 2147483648) % limit;
  for (let round = 0; round < 500; round++) {
    const weights = Array.from({ length: 2 + next(5) }, () => 1 + next(100)), total = weights.length + next(500000 - weights.length), cents = splitSharedCents(total, parts(weights)), sum = weights.reduce((a, b) => a + b, 0);
    assert.equal(cents.reduce((a, b) => a + b, 0), total);
    cents.forEach((value, index) => assert.ok(Math.abs(value - total * weights[index] / sum) < 1, `${total} ${weights}`));
  }
});

test('share parts put the recording job first, validate the jobs and weights, and never split a damage claim', () => {
  assert.deepEqual(fieldExpenseShareParts('job-1', 'dump_fee', 9000, [{ jobId: 'job-9', weight: 1 }, { jobId: 'job-1', weight: 1 }, { jobId: 'job-2', weight: 1 }]), [{ jobId: 'job-1', weight: 1, amountCents: 3000 }, { jobId: 'job-2', weight: 1, amountCents: 3000 }, { jobId: 'job-9', weight: 1, amountCents: 3000 }]);
  const bad = shares => assert.throws(() => fieldExpenseShareParts('job-1', 'dump_fee', 9000, shares), error => error.code === 'FIELD_EXPENSE_SHARE_INVALID', JSON.stringify(shares));
  bad([{ jobId: 'job-1', weight: 1 }]); bad([{ jobId: 'job-2', weight: 1 }, { jobId: 'job-3', weight: 1 }]); bad([{ jobId: 'job-1', weight: 1 }, { jobId: 'job-1', weight: 2 }]);
  bad([{ jobId: 'job-1', weight: 0 }, { jobId: 'job-2', weight: 1 }]); bad([{ jobId: 'job-1', weight: 1.5 }, { jobId: 'job-2', weight: 1 }]); bad([{ jobId: 'job-1', weight: 101 }, { jobId: 'job-2', weight: 1 }]);
  bad([{ jobId: 'job-1', weight: 1 }, { jobId: '_egc_lock', weight: 1 }]); bad([{ jobId: 'job-1', weight: 1 }, { jobId: 'job-2', weight: 1, amountCents: 5 }]);
  bad(Array.from({ length: 7 }, (_, index) => ({ jobId: `job-${index + 1}`, weight: 1 })));
  assert.throws(() => fieldExpenseShareParts('job-1', 'damage_claim', 9000, [{ jobId: 'job-1', weight: 1 }, { jobId: 'job-2', weight: 1 }]), error => error.code === 'FIELD_EXPENSE_SHARE_INVALID');
  const id = fieldExpenseShareId('AAAAAAAA-1111-4222-8333-444455556666', 'job-2');
  assert.ok(fieldRequestId(id)); assert.equal(id, fieldExpenseShareId('aaaaaaaa-1111-4222-8333-444455556666', 'job-2'), 'derived IDs are stable and case-insensitive');
  assert.notEqual(id, fieldExpenseShareId('aaaaaaaa-1111-4222-8333-444455556666', 'job-3'));
});

test('new kinds, payer and recovery income: income is subtracted and costs are totalled by who paid', async t => {
  const fixture = setup(t), client = api();
  for (const body of [entry({ kind: 'subcontractor', amountCents: 12000, vendor: 'Synthetic Helper LLC', payer: 'account_billed' }), entry({ kind: 'fuel', amountCents: 4550, vendor: 'Synthetic Fuel Stop', payer: 'crew_reimbursable' }), entry({ kind: 'material', amountCents: 2000, vendor: 'Synthetic Hardware' }), entry({ kind: 'recovery_income', amountCents: 3000, vendor: 'Synthetic Scrap Yard', payer: undefined })]) {
    const response = await client.post('Crew.One', body); assert.equal(response.status, 200, await response.clone().text());
  }
  const manager = await (await client.get('ZacB', '?jobId=job-1')).json();
  assert.deepEqual({ totalCents: manager.totals.totalCents, costCents: manager.totals.costCents, recoveryIncomeCents: manager.totals.recoveryIncomeCents }, { totalCents: 15550, costCents: 18550, recoveryIncomeCents: 3000 });
  assert.deepEqual(manager.totals.byPayer, { company_card: 2000, crew_reimbursable: 4550, account_billed: 12000, unspecified: 0 });
  assert.deepEqual(manager.limits.kinds, FIELD_EXPENSE_KINDS); assert.deepEqual(manager.limits.payers, ['company_card', 'crew_reimbursable', 'account_billed']);
  const income = manager.entries.find(item => item.kind === 'recovery_income');
  assert.equal(income.income, true); assert.equal(income.payer, null); assert.equal(fixture.get(`jobs/job-1/fieldExpenses/${income.id}`).payer, null);
  for (const [body, code] of [[entry({ kind: 'recovery_income', payer: 'company_card' }), 'FIELD_EXPENSE_PAYER_INVALID'], [entry({ payer: 'petty_cash' }), 'FIELD_EXPENSE_PAYER_INVALID'], [entry({ kind: 'damage_claim', note: 'Dented door', damagePhotoIds: [] }), 'FIELD_EXPENSE_DAMAGE_PHOTOS_REQUIRED']]) {
    const response = await client.post('Crew.One', body); assert.equal(response.status, 400); assert.equal((await response.json()).code, code);
  }
  const legacy = await client.post('Crew.One', entry({ payer: undefined })); assert.equal(legacy.status, 200, 'an older client without a payer still records, as unspecified');
  assert.equal((await sumFieldExpenses(env, 'job-1')).byPayer.unspecified, 6000);
});

test('a damage claim must link verified damage photos saved on the same job', async t => {
  const fixture = setup(t), client = api();
  const other = uuid();
  for (const [ids, code] of [[[BEFORE], 'FIELD_EXPENSE_DAMAGE_PHOTOS_INVALID'], [[other], 'FIELD_EXPENSE_DAMAGE_PHOTOS_INVALID'], [['not-a-photo'], 'FIELD_EXPENSE_DAMAGE_PHOTOS_INVALID'], [[DAMAGE, DAMAGE], 'FIELD_EXPENSE_DAMAGE_PHOTOS_INVALID']]) {
    const response = await client.post('Crew.One', entry({ kind: 'damage_claim', note: 'Scratched customer car', damagePhotoIds: ids })); assert.equal((await response.json()).code, code, JSON.stringify(ids));
  }
  assert.equal((await (await client.post('Crew.One', entry({ kind: 'damage_claim', note: '', damagePhotoIds: [DAMAGE] }))).json()).code, 'FIELD_EXPENSE_NOTE_INVALID', 'a claim needs a description');
  assert.equal((await (await client.post('Crew.One', entry({ kind: 'material', damagePhotoIds: [DAMAGE] }))).json()).code, 'FIELD_EXPENSE_DAMAGE_PHOTOS_INVALID', 'only claims link damage photos');
  const input = entry({ kind: 'damage_claim', amountCents: 25000, vendor: 'Synthetic Customer', note: 'Paid for a scratched car door', damagePhotoIds: [DAMAGE.toUpperCase()] });
  const saved = await (await client.post('Crew.One', input)).json();
  assert.equal(saved.ok, true); assert.deepEqual(saved.entries[0].damagePhotoIds, [DAMAGE]); assert.deepEqual(saved.damagePhotos.map(item => item.id), [DAMAGE]);
  assert.deepEqual(fixture.get(`jobs/job-1/fieldExpenses/${input.requestId}`).damagePhotoIds, [DAMAGE]);
  assert.equal(saved.totals.byKind.damage_claim, 25000);
  assert.equal((await client.post('Crew.One', entry({ kind: 'damage_claim', note: 'Split claim', damagePhotoIds: [DAMAGE], shares: [{ jobId: 'job-1', weight: 1 }, { jobId: 'job-2', weight: 1 }] }))).status, 400, 'a claim is never split');
});

test('a replay reports the saved cost even after the damage photo it cites is gone, with or without a receipt', async t => {
  const fixture = setup(t), client = api(), input = entry({ kind: 'damage_claim', amountCents: 25000, vendor: 'Synthetic Customer', note: 'Paid for a scratched car door', damagePhotoIds: [DAMAGE] });
  assert.equal((await client.post('Crew.One', input)).status, 200);
  fixture.put('jobs/job-1', job('job-1', { fieldExecution: { photos: [photo(BEFORE, 'before')] } }));
  const replay = await client.post('Crew.One', input);
  assert.equal(replay.status, 200, 'a lost response is not turned into a final 400 that clears the crew retry'); assert.equal((await replay.json()).alreadyApplied, true);
  assert.equal((await (await client.post('Crew.One', { ...input, requestId: uuid() })).json()).code, 'FIELD_EXPENSE_DAMAGE_PHOTOS_INVALID', 'a new claim is still checked against the current photos');
  fixture.put('jobs/job-1', job('job-1')); transactions(t, fixture);
  const provider = globalThis.fetch; let failUpload = true;
  t.mock.method(globalThis, 'fetch', async (url, options) => { if (failUpload && new URL(url).pathname.startsWith('/upload/')) { failUpload = false; return Response.json({}, { status: 503 }); } return provider(url, options); });
  const receipt = entry({ kind: 'damage_claim', amountCents: 9000, vendor: 'Synthetic Customer', note: 'Replaced a cracked tote lid', damagePhotoIds: [DAMAGE], receiptDataUrl: picture });
  assert.equal((await client.post('Crew.One', receipt)).status, 503, 'the upload failed after the pending entry was saved');
  assert.equal(fixture.get(`jobs/job-1/fieldExpenses/${receipt.requestId}`).state, 'pending');
  fixture.put('jobs/job-1', job('job-1', { fieldExecution: { photos: [photo(BEFORE, 'before')] } }));
  const retried = await (await client.post('Crew.One', receipt)).json();
  assert.equal(retried.ok, true, JSON.stringify(retried)); assert.equal(fixture.get(`jobs/job-1/fieldExpenses/${receipt.requestId}`).state, 'applied', 'the saved entry is finished, not re-validated as a new one');
});

test('crew split a dump load across their jobs: one row per job, parts sum to the receipt and no job is counted twice', async t => {
  const fixture = setup(t); const client = api(), input = entry({ amountCents: 10001, shares: [{ jobId: 'job-2', weight: 1 }, { jobId: 'job-1', weight: 1 }] });
  const response = await client.post('Crew.One', input); assert.equal(response.status, 200, await response.clone().text());
  const data = await response.json(); assert.equal(data.entries.length, 1); assert.equal(data.entries[0].amountCents, 5001);
  assert.deepEqual(data.entries[0].share, { primary: true, primaryJobId: 'job-1', totalCents: 10001, parts: [{ jobId: 'job-1', weight: 1, amountCents: 5001 }, { jobId: 'job-2', weight: 1, amountCents: 5000 }] });
  const [second] = rows(fixture, 'job-2'); assert.equal(second.id, fieldExpenseShareId(input.requestId, 'job-2')); assert.equal(second.amountCents, 5000); assert.equal(second.jobDate, '2026-09-22'); assert.equal(second.actorId, 'Crew.One');
  assert.equal(fixture.calls.commits, 1, 'both rows are written in one commit');
  assert.equal((await sumFieldExpenses(env, 'job-1')).totalCents, 5001); assert.equal((await sumFieldExpenses(env, 'job-2')).totalCents, 5000);
  const store = { listRange: async () => [...rows(fixture, 'job-1'), ...rows(fixture, 'job-2')] };
  assert.equal((await fieldExpenseRange(env, { start: '2026-09-01', end: '2026-09-30' }, { store })).totals.totalCents, 10001, 'the date-range total is the receipt, not double');
  const own = await (await client.get('Crew.One', '?jobId=job-2')).json(); assert.equal(own.entries[0].share.primary, false); assert.equal(own.entries[0].amountCents, 5000);
  assert.equal((await (await client.post('Crew.One', input)).json()).alreadyApplied, true); assert.equal(fixture.calls.commits, 1);
  const commits = fixture.calls.commits;
  for (const [shares, status, code] of [[[{ jobId: 'job-1', weight: 1 }, { jobId: 'job-3', weight: 1 }], 403, 'FIELD_EXPENSE_SHARE_JOB_UNAVAILABLE'], [[{ jobId: 'job-1', weight: 1 }, { jobId: 'job-404', weight: 1 }], 404, 'FIELD_EXPENSE_SHARE_JOB_UNAVAILABLE'], [[{ jobId: 'job-1', weight: 1 }, { jobId: 'job-4', weight: 1 }], 409, 'FIELD_JOB_CLOSED']]) {
    const refused = await client.post('Crew.One', entry({ shares })); assert.equal(refused.status, status); assert.equal((await refused.json()).code, code);
  }
  assert.equal(fixture.calls.commits, commits, 'a refused split writes nothing');
  assert.equal((await client.post('ZacB', entry({ shares: [{ jobId: 'job-1', weight: 2 }, { jobId: 'job-3', weight: 1 }] }))).status, 200, 'managers may split with any job');
  assert.equal(rows(fixture, 'job-3')[0].amountCents, 2000);
});

test('crew may split a load only with their jobs on this job’s days, the ones the share picker offers', async t => {
  const fixture = setup(t, { 'jobs/job-7': job('job-7', { assignedCrew: ['Crew.One'], date: '2026-11-20' }), 'jobs/job-8': job('job-8', { assignedCrew: ['Crew.One'], date: '2026-09-15', status: 'invoiced', pipelineStatus: 'invoiced' }), 'jobs/job-6': job('job-6', { assignedCrew: ['Crew.One'], date: '2026-09-21', endDate: '2026-09-22' }), 'jobs/job-9': job('job-9', { assignedCrew: ['Crew.One'], date: '2026-09-21', endDate: '2026-09-22', endTime: '00:00' }) });
  const client = api(), offered = (await (await client.get('Crew.One', '?jobId=job-1&view=share_jobs')).json()).jobs.map(item => item.jobId);
  assert.deepEqual(offered.sort(), ['job-2', 'job-6']);
  for (const other of ['job-7', 'job-8', 'job-5', 'job-9']) {
    const refused = await client.post('Crew.One', entry({ shares: [{ jobId: 'job-1', weight: 1 }, { jobId: other, weight: 1 }] }));
    assert.equal(refused.status, 403, other); assert.equal((await refused.json()).code, 'FIELD_EXPENSE_SHARE_JOB_UNAVAILABLE', other);
  }
  assert.equal(fixture.calls.commits, 0, 'nothing is moved onto an unrelated job');
  assert.equal((await client.post('Crew.One', entry({ shares: [{ jobId: 'job-1', weight: 1 }, { jobId: 'job-6', weight: 1 }] }))).status, 200, 'a multi-day job on this job’s day is offered and accepted');
  assert.equal((await client.post('ZacB', entry({ shares: [{ jobId: 'job-1', weight: 1 }, { jobId: 'job-7', weight: 1 }] }))).status, 200, 'managers may split with any job');
  fixture.put('jobs/job-1', job('job-1', { date: '' }));
  assert.equal((await (await client.post('Crew.One', entry({ shares: [{ jobId: 'job-1', weight: 1 }, { jobId: 'job-2', weight: 1 }] }))).json()).code, 'FIELD_EXPENSE_SHARE_JOB_UNAVAILABLE', 'an unscheduled job offers no share days');
});

test('a shared load with a receipt stays pending on every job until one fenced commit applies them all', async t => {
  const fixture = setup(t), fence = transactions(t, fixture), client = api(), input = entry({ amountCents: 9000, receiptDataUrl: picture, shares: [{ jobId: 'job-1', weight: 2 }, { jobId: 'job-2', weight: 1 }] });
  const data = await (await client.post('Crew.One', input)).json();
  assert.equal(data.ok, true, JSON.stringify(data)); assert.equal(data.entries[0].receiptVerified, true);
  assert.deepEqual(rows(fixture, 'job-2').map(row => [row.state, row.amountCents, row.receipt]), [['applied', 3000, null]], 'the receipt lives on the recording job only');
  assert.equal(fence.committed, 1);
  const read = fence.reads.find(body => body.transaction); assert.deepEqual(read.documents.map(name => name.split('/').pop()).sort(), ['job-1', 'job-2'], 'both job revisions fence the apply');
  assert.equal(fixture.calls.uploads, 1);
});

test('managers correct a shared load total once: every row is re-split and audited; a void voids the whole load', async t => {
  const fixture = setup(t), client = api({ now: '2026-09-23T15:00:00.000Z' }), input = entry({ amountCents: 6000, shares: [{ jobId: 'job-1', weight: 1 }, { jobId: 'job-2', weight: 2 }] });
  await client.post('Crew.One', input);
  const listed = await (await client.get('ZacB', '?jobId=job-2')).json(), linked = listed.entries[0];
  assert.equal(linked.amountCents, 4000);
  const edit = { action: 'edit', jobId: 'job-2', requestId: uuid(), expenseId: linked.id, expectedRevision: linked.expectedRevision, amountCents: 7501, payer: 'crew_reimbursable', reason: 'Receipt shows $75.01' };
  const edited = await (await client.post('ZacB', edit)).json(); assert.equal(edited.ok, true, JSON.stringify(edited));
  const [one] = rows(fixture, 'job-1'), [two] = rows(fixture, 'job-2');
  assert.deepEqual([one.amountCents, two.amountCents, one.share.totalCents, two.share.totalCents], [2500, 5001, 7501, 7501], 'weights 1:2 of $75.01: remainders 1 and 2 of 3, so the odd cent goes to job-2');
  assert.deepEqual([one.payer, two.payer], ['crew_reimbursable', 'crew_reimbursable']);
  assert.deepEqual(two.audit[0].before, { amountCents: 4000, payer: 'company_card', loadTotalCents: 6000 }); assert.deepEqual(one.audit[0].after, { amountCents: 2500, payer: 'crew_reimbursable', loadTotalCents: 7501 });
  assert.equal(fixture.get(`jobs/job-2/fieldExpenseRequests/${edit.requestId}`).action, 'edit');
  assert.equal((await (await client.post('ZacB', edit)).json()).alreadyApplied, true);
  const kind = await client.post('ZacB', { ...edit, requestId: uuid(), expectedRevision: (await (await client.get('ZacB', '?jobId=job-2')).json()).entries[0].expectedRevision, amountCents: undefined, payer: undefined, kind: 'damage_claim', damagePhotoIds: [DAMAGE], note: 'Claim' });
  assert.equal((await kind.json()).code, 'FIELD_EXPENSE_SHARE_INVALID');
  const current = (await (await client.get('ZacB', '?jobId=job-1')).json()).entries[0];
  const voided = await (await client.post('ZacB', { action: 'void', jobId: 'job-1', requestId: uuid(), expenseId: current.id, expectedRevision: current.expectedRevision, reason: 'Duplicate load' })).json();
  assert.equal(voided.ok, true);
  assert.deepEqual([rows(fixture, 'job-1')[0].status, rows(fixture, 'job-2')[0].status], ['void', 'void']);
  assert.equal((await sumFieldExpenses(env, 'job-2')).totalCents, 0);
});

test('a damaged shared-load row can still be voided (with the linked rows that verify) but never corrected', async t => {
  const fixture = setup(t), client = api(), current = async jobId => (await (await client.get('ZacB', `?jobId=${jobId}`)).json()).entries[0];
  const first = entry({ amountCents: 6000, shares: [{ jobId: 'job-1', weight: 1 }, { jobId: 'job-2', weight: 1 }] });
  await client.post('Crew.One', first);
  const damaged = fixture.get(`jobs/job-1/fieldExpenses/${first.requestId}`);
  fixture.put(`jobs/job-1/fieldExpenses/${first.requestId}`, { ...damaged, share: { ...damaged.share, totalCents: 7000 } });
  let row = await current('job-1');
  assert.equal(row.needsReview, true); assert.equal((await (await client.get('ZacB', '?jobId=job-1')).json()).costs.coverage.invalidCount, 1);
  const edit = await client.post('ZacB', { action: 'edit', jobId: 'job-1', requestId: uuid(), expenseId: row.id, expectedRevision: row.expectedRevision, amountCents: 6100, reason: 'Receipt shows $61' });
  assert.equal(edit.status, 409); assert.equal((await edit.json()).code, 'FIELD_EXPENSE_SHARE_INCOMPLETE', 'edits keep the strict check');
  const voided = await (await client.post('ZacB', { action: 'void', jobId: 'job-1', requestId: uuid(), expenseId: row.id, expectedRevision: row.expectedRevision, reason: 'Damaged duplicate load' })).json();
  assert.equal(voided.ok, true, JSON.stringify(voided));
  assert.deepEqual([rows(fixture, 'job-1')[0].status, rows(fixture, 'job-2')[0].status], ['void', 'void'], 'the linked row still verifies by load ID and fingerprint, so it is voided too');
  assert.deepEqual([voided.totals.invalidCount, voided.costs.coverage.invalidCount], [0, 0], 'the voided row no longer keeps the job partial');
  const second = entry({ amountCents: 4000, shares: [{ jobId: 'job-1', weight: 1 }, { jobId: 'job-2', weight: 1 }, { jobId: 'job-6', weight: 1 }] });
  fixture.put('jobs/job-6', job('job-6', { assignedCrew: ['Crew.One'] }));
  await client.post('Crew.One', second);
  fixture.documents.delete(`jobs/job-2/fieldExpenses/${fieldExpenseShareId(second.requestId, 'job-2')}`);
  row = (await (await client.get('ZacB', '?jobId=job-1')).json()).entries.find(item => item.id === second.requestId);
  const partial = await client.post('ZacB', { action: 'void', jobId: 'job-1', requestId: uuid(), expenseId: row.id, expectedRevision: row.expectedRevision, reason: 'Load record is missing a job' });
  assert.equal(partial.status, 200, await partial.clone().text());
  assert.deepEqual([fixture.get(`jobs/job-1/fieldExpenses/${second.requestId}`).status, fixture.get(`jobs/job-6/fieldExpenses/${fieldExpenseShareId(second.requestId, 'job-6')}`).status], ['void', 'void'], 'a missing row is skipped; the rows that verify are voided together');
  const third = entry({ amountCents: 3000, shares: [{ jobId: 'job-1', weight: 1 }, { jobId: 'job-2', weight: 1 }] });
  await client.post('Crew.One', third);
  const broken = fixture.get(`jobs/job-2/fieldExpenses/${fieldExpenseShareId(third.requestId, 'job-2')}`);
  fixture.put(`jobs/job-2/fieldExpenses/${broken.id || fieldExpenseShareId(third.requestId, 'job-2')}`, { ...broken, share: { loadId: 'not-a-load', parts: 'x' } });
  row = (await (await client.get('ZacB', '?jobId=job-2')).json()).entries.find(item => item.id === fieldExpenseShareId(third.requestId, 'job-2'));
  assert.equal((await (await client.post('ZacB', { action: 'void', jobId: 'job-2', requestId: uuid(), expenseId: row.id, expectedRevision: row.expectedRevision, reason: 'Unreadable share' })).json()).ok, true);
  assert.deepEqual([fixture.get(`jobs/job-2/fieldExpenses/${row.id}`).status, fixture.get(`jobs/job-1/fieldExpenses/${third.requestId}`).status], ['void', 'recorded'], 'with no readable load ID only this row is voided');
});

test('manager corrections keep payer and kind rules: income clears the payer, a claim needs photos', () => {
  const manager = { user: 'ZacB', displayName: 'Owner', manager: true }, expense = { id: uuid(), jobId: 'job-1', kind: 'material', amountCents: 1000, vendor: 'Synthetic', note: '', payer: 'company_card', state: 'applied', status: 'recorded', audit: [] };
  const income = fieldExpenseChange(expense, manager, { action: 'edit', requestId: uuid(), kind: 'recovery_income', reason: 'This was scrap sold' }, 'f', NOW);
  assert.deepEqual(income.audit[0], { ...income.audit[0], before: { kind: 'material', payer: 'company_card' }, after: { kind: 'recovery_income', payer: null } });
  assert.throws(() => fieldExpenseChange(expense, manager, { action: 'edit', requestId: uuid(), kind: 'damage_claim', note: 'Claim paid', reason: 'Reclassify' }, 'f', NOW, { damagePhotos: [DAMAGE] }), error => error.code === 'FIELD_EXPENSE_DAMAGE_PHOTOS_REQUIRED');
  const claim = fieldExpenseChange(expense, manager, { action: 'edit', requestId: uuid(), kind: 'damage_claim', note: 'Claim paid', damagePhotoIds: [DAMAGE], reason: 'Reclassify' }, 'f', NOW, { damagePhotos: [DAMAGE] });
  assert.deepEqual(claim.damagePhotoIds, [DAMAGE]);
  const back = fieldExpenseChange({ ...expense, ...claim, audit: [] }, manager, { action: 'edit', requestId: uuid(), kind: 'material', reason: 'Not a claim' }, 'f', NOW);
  assert.deepEqual(back.damagePhotoIds, [], 'leaving damage_claim unlinks its photos');
  assert.throws(() => fieldExpenseChange(expense, manager, { action: 'edit', requestId: uuid(), payer: 'company_card', reason: 'Same payer' }, 'f', NOW), error => error.code === 'FIELD_EXPENSE_NO_CHANGE');
  assert.deepEqual(fieldExpenseChange({ ...expense, payer: undefined }, manager, { action: 'edit', requestId: uuid(), payer: 'account_billed', reason: 'Landfill account' }, 'f', NOW).audit[0].before, { payer: null }, 'a legacy row without a payer is unspecified');
  assert.deepEqual(fieldExpenseValues({ kind: 'fuel', amountCents: 100, vendor: 'Synthetic Fuel', payer: undefined }), { kind: 'fuel', amountCents: 100, vendor: 'Synthetic Fuel', note: '', payer: null });
});

test('closeout: "None" per group is create-only, entries win over it, voids fall back, and crew never see who else attested', async t => {
  const fixture = setup(t), client = api();
  let data = await (await client.get('Crew.One', '?jobId=job-1')).json();
  assert.deepEqual(data.closeout.groups.map(group => [group.id, group.required, group.state]), [['material', true, 'missing'], ['dump_fee', true, 'missing'], ['other_costs', false, 'missing']]);
  assert.deepEqual([data.closeout.required, data.closeout.complete, data.closeout.confirmed, data.closeout.missing], [false, false, false, ['material', 'dump_fee']]);
  assert.equal(data.costs, undefined, 'crew never receive the job-costing view');
  const none = { action: 'attest', jobId: 'job-1', requestId: uuid(), group: 'dump_fee', expectedUser: 'Crew.One' };
  data = await (await client.post('Crew.One', none)).json();
  assert.equal(data.alreadyApplied, false); assert.deepEqual(data.closeout.groups[1], { id: 'dump_fee', required: true, state: 'none', confirmed: true, openKinds: [], entryCount: 0, pendingCount: 0, attestedAt: NOW, attestedByYou: true });
  assert.deepEqual(fixture.get('jobs/job-1/fieldExpenseCloseout/dump_fee'), { kind: 'dump_fee', group: 'dump_fee', attestation: 'none', requestId: none.requestId, fingerprint: fixture.get('jobs/job-1/fieldExpenseCloseout/dump_fee').fingerprint, actorId: 'Crew.One', actorName: 'Crew One', at: NOW });
  assert.equal((await (await client.post('Crew.One', none)).json()).alreadyApplied, true, 'a replay is recognized');
  assert.equal((await (await client.post('Crew.One', { ...none, group: 'material' })).json()).code, 'FIELD_IDEMPOTENCY_CONFLICT');
  const two = await (await client.post('Crew.Two', { action: 'attest', jobId: 'job-1', requestId: uuid(), group: 'dump_fee' })).json();
  assert.equal(two.alreadyApplied, true); assert.equal(two.closeout.groups[1].attestedByYou, false);
  assert.equal(JSON.stringify(two.closeout).includes('Crew'), false, 'crew see no attester names');
  const manager = await (await client.get('ZacB', '?jobId=job-1')).json(); assert.deepEqual(manager.closeout.groups[1].attestedBy, { id: 'Crew.One', name: 'Crew One' });
  assert.equal(fixture.get('jobs/job-1/fieldExpenseCloseout/dump_fee').requestId, none.requestId, 'the first attestation is never overwritten');
  const material = entry({ kind: 'material', amountCents: 1500 }); await client.post('Crew.Two', material);
  const refused = await client.post('Crew.One', { action: 'attest', jobId: 'job-1', requestId: uuid(), group: 'material' });
  assert.equal(refused.status, 409); assert.equal((await refused.json()).code, 'FIELD_EXPENSE_CLOSEOUT_ENTERED');
  data = await (await client.get('Crew.One', '?jobId=job-1')).json();
  assert.deepEqual([data.closeout.groups[0].state, data.closeout.groups[0].entryCount, data.closeout.complete], ['entered', 1, true], 'a colleague entry counts without showing its amount');
  assert.equal(JSON.stringify(data).includes('1500'), false);
  const dump = entry({ amountCents: 900 }); await client.post('Crew.One', dump);
  let status = await fieldExpenseCloseoutStatus(env, 'job-1'); assert.equal(status.groups[1].state, 'entered', 'an entry wins over an earlier None');
  const current = (await (await client.get('ZacB', '?jobId=job-1')).json()).entries.find(item => item.id === dump.requestId);
  await client.post('ZacB', { action: 'void', jobId: 'job-1', requestId: uuid(), expenseId: dump.requestId, expectedRevision: current.expectedRevision, reason: 'Duplicate' });
  status = await fieldExpenseCloseoutStatus(env, 'job-1'); assert.deepEqual([status.groups[1].state, status.groups[1].attestedBy, status.complete], ['none', 'Crew.One', true], 'a void falls back to the None');
  assert.equal((await client.post('Crew.One', { action: 'attest', jobId: 'job-1', requestId: uuid(), group: 'tips' })).status, 400);
  assert.equal((await client.post('Crew.One', { action: 'attest', jobId: 'job-4', requestId: uuid(), group: 'material' })).status, 409, 'cancelled jobs refuse crew closeout');
  assert.equal((await client.post('Crew.Two', { action: 'attest', jobId: 'job-2', requestId: uuid(), group: 'material' })).status, 403);
});

test('other costs are confirmed per kind: a fuel entry leaves helpers, claims and other open until "None of the rest"', async t => {
  const fixture = setup(t), client = api(), closeoutDocs = () => [...fixture.documents.keys()].filter(key => key.startsWith('jobs/job-1/fieldExpenseCloseout/')).map(key => key.split('/').pop()).sort();
  for (const group of ['material', 'dump_fee']) await client.post('Crew.One', { action: 'attest', jobId: 'job-1', requestId: uuid(), group });
  const fuel = entry({ kind: 'fuel', amountCents: 4550, vendor: 'Synthetic Fuel Stop', payer: 'crew_reimbursable' });
  let data = await (await client.post('Crew.One', fuel)).json();
  assert.deepEqual(data.closeout.groups[2], { id: 'other_costs', required: false, state: 'entered', confirmed: false, openKinds: ['subcontractor', 'damage_claim', 'other'], entryCount: 1, pendingCount: 0, attestedAt: null, attestedByYou: false });
  assert.deepEqual([data.closeout.complete, data.closeout.confirmed], [true, false]);
  let manager = await (await client.get('ZacB', '?jobId=job-1')).json();
  assert.deepEqual([manager.costs.status, manager.costs.netCostCents, manager.costs.missing, manager.costs.components.subcontract.cents, manager.costs.components.fuel.cents], ['unknown', null, ['other_costs'], null, 4550], 'nobody said there were no helpers, so they are unknown, not $0');
  const rest = { action: 'attest', jobId: 'job-1', requestId: uuid(), group: 'other_costs' };
  data = await (await client.post('Crew.One', rest)).json();
  assert.equal(data.alreadyApplied, false); assert.deepEqual(closeoutDocs(), ['damage_claim', 'dump_fee', 'material', 'other', 'subcontractor'], 'None is written for the unrecorded kinds only');
  assert.deepEqual(fixture.get('jobs/job-1/fieldExpenseCloseout/subcontractor'), { kind: 'subcontractor', group: 'other_costs', attestation: 'none', requestId: rest.requestId, fingerprint: fixture.get('jobs/job-1/fieldExpenseCloseout/subcontractor').fingerprint, actorId: 'Crew.One', actorName: 'Crew One', at: NOW });
  assert.deepEqual([data.closeout.groups[2].state, data.closeout.groups[2].confirmed, data.closeout.confirmed], ['entered', true, true]);
  manager = await (await client.get('ZacB', '?jobId=job-1')).json();
  assert.deepEqual([manager.costs.status, manager.costs.netCostCents, manager.costs.components.subcontract], ['complete', 4550, { cents: 0, status: 'complete', basis: 'attested_none', group: 'other_costs', openCount: 0 }]);
  assert.equal((await (await client.post('Crew.Two', { action: 'attest', jobId: 'job-1', requestId: uuid(), group: 'other_costs' })).json()).alreadyApplied, true);
  const recorded = manager.entries.find(item => item.id === fuel.requestId);
  await client.post('ZacB', { action: 'void', jobId: 'job-1', requestId: uuid(), expenseId: recorded.id, expectedRevision: recorded.expectedRevision, reason: 'Fuel was for another job' });
  const status = await fieldExpenseCloseoutStatus(env, 'job-1');
  assert.deepEqual([status.kinds.fuel, status.groups[2].state, status.groups[2].openKinds, status.confirmed], ['missing', 'missing', ['fuel'], false], 'voiding the fuel does not turn it into a None nobody gave');
  assert.equal((await fieldExpenseJobCosts(env, 'job-1')).components.fuel.cents, null);
  await client.post('Crew.One', { action: 'attest', jobId: 'job-1', requestId: uuid(), group: 'other_costs' });
  assert.deepEqual(closeoutDocs(), ['damage_claim', 'dump_fee', 'fuel', 'material', 'other', 'subcontractor']);
  assert.equal((await fieldExpenseJobCosts(env, 'job-1')).status, 'complete');
  fixture.put('jobs/job-2', job('job-2', { assignedCrew: ['Crew.One'] }));
  for (const body of [entry({ jobId: 'job-2', kind: 'subcontractor', vendor: 'Synthetic Helper LLC' }), entry({ jobId: 'job-2', kind: 'fuel' }), entry({ jobId: 'job-2', kind: 'damage_claim', note: 'Dented door', damagePhotoIds: [DAMAGE] }), entry({ jobId: 'job-2', kind: 'other', note: 'Parking fee' })]) assert.equal((await client.post('Crew.One', body)).status, 200);
  const refused = await client.post('Crew.One', { action: 'attest', jobId: 'job-2', requestId: uuid(), group: 'other_costs' });
  assert.equal(refused.status, 409); assert.equal((await refused.json()).code, 'FIELD_EXPENSE_CLOSEOUT_ENTERED', 'None does not apply once every kind is recorded');
});

test('pure closeout derivation and the FUN-21 status read', async () => {
  const row = (kind, overrides = {}) => ({ kind, amountCents: 100, state: 'applied', status: 'recorded', ...overrides });
  const derived = fieldExpenseCloseout([row('fuel'), row('material', { state: 'pending' })], [{ kind: 'dump_fee', attestation: 'none', actorId: 'crew.one', at: NOW }]);
  assert.deepEqual(derived.groups.map(group => [group.id, group.state, group.confirmed, group.openKinds, group.pendingCount]), [['material', 'entered', true, [], 1], ['dump_fee', 'none', true, [], 0], ['other_costs', 'entered', false, ['subcontractor', 'damage_claim', 'other'], 0]], 'a fuel entry confirms fuel only, never helpers, damage claims or other');
  assert.deepEqual(derived.kinds, { material: 'entered', dump_fee: 'none', subcontractor: 'missing', fuel: 'entered', damage_claim: 'missing', other: 'missing' });
  assert.deepEqual([derived.complete, derived.confirmed, derived.missing], [true, false, []]);
  assert.deepEqual(fieldExpenseCloseout([row('recovery_income'), row('material', { status: 'void' })]).missing, ['material', 'dump_fee'], 'income and void rows do not close a group');
  const store = { listExpenses: async () => [row('dump_fee')], listAttestations: async () => [{ kind: 'material', attestation: 'none', actorId: 'crew.one', at: NOW }, { kind: 'fuel', attestation: 'none', actorId: 'crew.one', at: NOW }] };
  assert.deepEqual(await fieldExpenseCloseoutStatus({}, 'job-1', { store }), { jobId: 'job-1', complete: true, confirmed: false, missing: [], kinds: { material: 'none', dump_fee: 'entered', subcontractor: 'missing', fuel: 'none', damage_claim: 'missing', other: 'missing' }, groups: [{ id: 'material', required: true, state: 'none', confirmed: true, openKinds: [], entryCount: 0, pendingCount: 0, attestedAt: NOW, attestedBy: 'crew.one' }, { id: 'dump_fee', required: true, state: 'entered', confirmed: true, openKinds: [], entryCount: 1, pendingCount: 0, attestedAt: null, attestedBy: null }, { id: 'other_costs', required: false, state: 'missing', confirmed: false, openKinds: ['subcontractor', 'damage_claim', 'other'], entryCount: 0, pendingCount: 0, attestedAt: null, attestedBy: null }] });
  const failing = { listExpenses: async () => { throw Object.assign(new Error('x'), { code: 'FIELD_STORAGE_UNAVAILABLE', status: 503 }); }, listAttestations: async () => [] };
  assert.deepEqual(await fieldExpenseCloseoutMissing(env, 'job-1', { store: failing }), [], 'flag off: no reads, nothing required');
  await assert.rejects(fieldExpenseCloseoutMissing(required, 'job-1', { store: failing }), error => error.status === 503, 'the completion gate fails closed');
  assert.equal((await fieldExpenseCloseoutMissing(required, 'job-1', { store: failing, safe: true })).length, 1);
  assert.deepEqual(await fieldExpenseCloseoutMissing({ ...required, FIELD_EXPENSES_ENABLED: 'false' }, 'job-1', { store: failing }), [], 'no gate without job costs');
  assert.equal(summarizeFieldExpenses([row('material', { payer: 'petty_cash' })]).invalidCount, 1, 'an unreadable payer is never counted');
});

function completable(id = 'job-1') {
  const value = job(id, { assignedCrew: ['Crew.One'] });
  value.fieldExecution = { checks: Object.fromEntries(fieldChecklist(value).map(item => [item.id, { completed: true }])), photos: [photo(BEFORE, 'before'), photo(uuid(), 'after')] };
  return value;
}
const fieldRequest = (user, environment, data, search = '') => fieldJobs[data ? 'onRequestPost' : 'onRequestGet']({ env: environment, request: new Request(`https://easygaragecleaning.com/api/field-jobs${search}`, { method: data ? 'POST' : 'GET', headers: { Cookie: cookies.get(user), Origin: 'https://easygaragecleaning.com', 'Content-Type': 'application/json' }, ...(data ? { body: JSON.stringify(data) } : {}) }) });
const complete = (fixture, environment, notes = 'Garage cleared and swept; customer walkthrough done.') => fieldRequest('Crew.One', environment, { action: 'complete', jobId: 'job-1', requestId: uuid(), expectedRevision: fixture.revision('job-1'), notes, hasIssues: false });

test('completion is only prompted by default; FIELD_EXPENSE_CLOSEOUT_REQUIRED=true blocks it until materials and dump fees are entered or None', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date(NOW) });
  let fixture = storage(t); fixture.put('jobs/job-1', completable());
  for (const flag of [undefined, 'false', 'TRUE', '1']) {
    const detail = await (await fieldRequest('Crew.One', { ...env, FIELD_EXPENSE_CLOSEOUT_REQUIRED: flag }, null, '?jobId=job-1')).json();
    assert.deepEqual(detail.job.completionMissing, ['Add completion notes describing the work performed (at least 10 characters).'], String(flag));
  }
  assert.equal(fixture.calls.queries.some(query => ['fieldExpenses', 'fieldExpenseCloseout'].includes(query.from?.[0]?.collectionId)), false, 'the record-only default reads no cost data');
  assert.equal((await complete(fixture, env)).status, 200, 'record-only: completion is not blocked');
  fixture = storage(t); fixture.put('jobs/job-1', completable());
  const detail = await (await fieldRequest('Crew.One', required, null, '?jobId=job-1')).json();
  assert.deepEqual(detail.job.completionMissing, ['Add completion notes describing the work performed (at least 10 characters).', 'Job costs: record the materials bought for this job, or tap “No materials” in Job costs.', 'Job costs: record dump or disposal fees, or tap “No dump fees” in Job costs.']);
  let blocked = await complete(fixture, required, 'short');
  assert.equal(blocked.status, 409); let body = await blocked.json();
  assert.equal(body.code, 'FIELD_COMPLETION_INCOMPLETE'); assert.equal(body.missing.length, 3, 'cost items are listed with the other closeout items'); assert.match(body.missing[0], /completion notes/);
  const client = api({ environment: required });
  await client.post('Crew.One', { action: 'attest', jobId: 'job-1', requestId: uuid(), group: 'material' });
  blocked = await complete(fixture, required); body = await blocked.json();
  assert.deepEqual(body.missing, ['Job costs: record dump or disposal fees, or tap “No dump fees” in Job costs.']);
  assert.equal(fixture.get('jobs/job-1').status, 'in_progress');
  await client.post('Crew.One', entry({ kind: 'dump_fee', amountCents: 4200 }));
  const done = await complete(fixture, required); assert.equal(done.status, 200, await done.clone().text());
  assert.equal(fixture.get('jobs/job-1').status, 'completed');
  const text = JSON.stringify(await done.json()); for (const secret of ['4200', 'amountCents', 'fieldExpenses', 'Synthetic County Landfill']) assert.equal(text.includes(secret), false, secret);
  fixture.put('jobs/job-1', { ...completable(), status: 'completed', pipelineStatus: 'completed' });
  const closed = await complete(fixture, required); assert.equal((await closed.json()).code, 'FIELD_JOB_CLOSED', 'a closed job is not re-gated on costs');
  fixture.put('jobs/job-1', completable());
  const provider = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (input, options) => new URL(input).pathname.endsWith(':runQuery') && JSON.parse(options.body).structuredQuery.from[0].collectionId === 'fieldExpenseCloseout' ? Response.json({}, { status: 503 }) : provider(input, options));
  const unreadable = await fieldRequest('Crew.One', required, null, '?jobId=job-1');
  assert.equal(unreadable.status, 200, 'the job page still opens'); assert.deepEqual((await unreadable.json()).job.completionMissing.at(-1), 'Job costs could not be checked. Refresh the job before completing it.');
  assert.equal((await complete(fixture, required)).status, 503, 'the gate fails closed when costs cannot be read');
});

test('the share picker lists the viewer’s other current jobs on the job’s days', async t => {
  const fixture = setup(t), client = api();
  fixture.put('jobs/job-6', job('job-6', { assignedCrew: ['Crew.One'], date: '2026-09-21', endDate: '2026-09-22' }));
  const crew = await (await client.get('Crew.One', '?jobId=job-1&view=share_jobs')).json();
  assert.equal(crew.ok, true); assert.equal(crew.jobId, 'job-1'); assert.equal(crew.maxJobs, 6);
  assert.deepEqual(crew.jobs.map(item => item.jobId), ['job-6', 'job-2'], 'own same-day jobs only: not self, not unassigned job-3, not cancelled job-4, not next-day job-5');
  assert.deepEqual(crew.jobs[1], { jobId: 'job-2', customer: 'Synthetic Customer job-2', date: '2026-09-22', time: '13:00' });
  const manager = await (await client.get('ZacB', '?jobId=job-1&view=share_jobs')).json(); assert.deepEqual(manager.jobs.map(item => item.jobId), ['job-6', 'job-3', 'job-2']);
  assert.equal((await client.get('Crew.One', '?jobId=job-3&view=share_jobs')).status, 403);
  assert.equal((await client.get('Crew.One', `?jobId=job-1&view=share_jobs&expenseId=${uuid()}`)).status, 400);
});

test('the crew split preview uses exactly the server rule', async () => {
  const { readFileSync } = await import('node:fs'), vm = await import('node:vm');
  const context = { addEventListener() {}, Intl, Number, String, Object, Array, JSON, Math }; context.window = context;
  vm.createContext(context); vm.runInContext(readFileSync(new URL('../crew/field-expenses.js', import.meta.url), 'utf8'), context);
  const { splitCents } = context.EGCFieldExpenses;
  let seed = 11; const next = limit => (seed = (seed * 1103515245 + 12345) % 2147483648) % limit;
  for (let round = 0; round < 300; round++) {
    const weights = Array.from({ length: 2 + next(5) }, () => 1 + next(100)), total = 1 + next(500000);
    let server = null; try { server = splitSharedCents(total, weights.map(weight => ({ weight }))); } catch { server = null; }
    assert.deepEqual(splitCents(total, weights) ?? null, server, `${total} ${weights}`);
  }
});

// The crew card running in a small DOM against the real handler and storage fixture.
async function crewCard(user) {
  const { createDocument, storage: sessionStore } = await import('./helpers/hub-dom.mjs'), { readFileSync } = await import('node:fs'), vm = await import('node:vm');
  const document = createDocument(), handlers = fieldExpenseHandlers({ now: () => new Date(NOW) }), posts = [];
  const fetch = async (path, options = {}) => {
    const request = new Request(new URL(path, 'https://easygaragecleaning.com'), { method: options.method || 'GET', headers: { ...options.headers, Cookie: cookies.get(user) }, body: options.body });
    if (options.body) posts.push(JSON.parse(options.body));
    return handlers[request.method === 'POST' ? 'post' : 'get']({ env, request });
  };
  const context = { document, Node: document.Node, fetch, sessionStorage: sessionStore(), crypto, AbortSignal, Intl, Date, Number, String, Object, Array, JSON, Math, Map, Set, Promise, Error, TypeError, URL, console, addEventListener() {} };
  context.window = context; vm.createContext(context);
  vm.runInContext(readFileSync(new URL('../crew/field-expenses.js', import.meta.url), 'utf8'), context);
  const host = document.createElement('section'); document.body.append(host);
  const until = async (check, what) => { for (let tick = 0; tick < 2000 && !check(); tick++) await new Promise(resolve => setImmediate(resolve)); assert.ok(check(), what); };
  const type = (selector, value, event = 'input') => { const node = host.querySelector(selector); node.value = value; node.dispatchEvent({ type: event }); };
  return { host, posts, until, type, mount: jobId => context.EGCFieldExpenses.mount(host, { jobId, user }) };
}

test('the crew split preview matches the stored parts when jobs are tapped out of ID order with tied remainders', async t => {
  const fixture = setup(t, { 'jobs/job-z': job('job-z', { assignedCrew: ['Crew.One'] }), 'jobs/job-a': job('job-a', { assignedCrew: ['Crew.One'] }) });
  const card = await crewCard('Crew.One'), { host } = card;
  await card.mount('job-1');
  host.querySelector('#expense-split').click();
  const shareButton = id => host.querySelectorAll('.expense-share-row button').find(node => node.textContent.includes(`Synthetic Customer ${id}`));
  await card.until(() => shareButton('job-z') && shareButton('job-a'), 'the viewer’s other jobs load');
  shareButton('job-z').click(); shareButton('job-a').click();
  card.type('#expense-amount', '1.01');
  const preview = Object.fromEntries(host.querySelectorAll('[data-share-preview]').map(node => [node.getAttribute('data-share-preview'), node.textContent]));
  assert.deepEqual(preview, { 'job-1': '$0.34', 'job-a': '$0.34', 'job-z': '$0.33' }, '101 cents in three equal shares: the tied leftover cents go to this job and then the lowest job ID');
  card.type('#expense-vendor', 'Synthetic County Landfill'); card.type('#expense-payer', 'company_card', 'change');
  host.querySelector('form.expense-form').dispatchEvent({ type: 'submit', preventDefault() {} });
  await card.until(() => host.textContent.includes('Shared load saved across 3 jobs.'), 'the shared load is saved');
  assert.deepEqual(card.posts[0].shares.map(share => share.jobId), ['job-1', 'job-a', 'job-z'], 'sent in the order the server stores');
  const money = cents => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
  const stored = Object.fromEntries(['job-1', 'job-a', 'job-z'].map(jobId => [jobId, money(rows(fixture, jobId)[0].amountCents)]));
  assert.deepEqual(stored, preview, 'every job is charged exactly what the crew member saw');
});

test('job costs stay unknown (null, never $0) until every closeout group is confirmed, and partial while receipts are pending', () => {
  const row = (kind, amountCents, overrides = {}) => ({ id: uuid(), kind, amountCents, payer: kind === 'recovery_income' ? null : 'company_card', state: 'applied', status: 'recorded', ...overrides });
  const none = kind => ({ kind, attestation: 'none', actorId: 'crew.one', at: NOW }), OTHER = ['subcontractor', 'fuel', 'damage_claim', 'other'];
  let costs = fieldExpenseCosts([]);
  assert.deepEqual([costs.status, costs.netCostCents, costs.knownCostCents, costs.missing], ['unknown', null, 0, ['material', 'dump_fee', 'other_costs']], 'no entries and no None is unknown, not a $0 job');
  assert.deepEqual(costs.components.materials, { cents: null, status: 'unknown', basis: 'closeout_unconfirmed', group: 'material' });
  assert.deepEqual(costs.components.recoveryIncome, { cents: 0, status: 'complete', basis: 'recorded', group: null, openCount: 0 }, 'income needs no attestation');
  assert.deepEqual(costs.coverage, { knownComponents: 1, totalComponents: 7, pendingCount: 0, invalidCount: 0, closeoutConfirmed: false });
  const materials = row('material', 1000);
  costs = fieldExpenseCosts([materials], [none('dump_fee')]);
  assert.deepEqual([costs.status, costs.netCostCents, costs.knownCostCents, costs.missing], ['unknown', null, 1000, ['other_costs']], 'the completion gate can pass while job costs are still unknown');
  assert.deepEqual(costs.components.disposal, { cents: 0, status: 'complete', basis: 'attested_none', group: 'dump_fee', openCount: 0 }, 'None is a known zero');
  assert.deepEqual([costs.components.subcontract.cents, costs.components.fuel.status], [null, 'unknown']);
  const income = row('recovery_income', 300), fuel = row('fuel', 4550, { payer: 'crew_reimbursable' });
  costs = fieldExpenseCosts([materials, income, fuel, row('fuel', 99999, { status: 'void' })], [none('dump_fee')]);
  assert.deepEqual([costs.status, costs.netCostCents, costs.knownCostCents, costs.missing], ['unknown', null, 5550, ['other_costs']], 'a fuel entry confirms fuel only: nobody said there were no helpers, claims or other costs');
  assert.deepEqual([costs.components.fuel, costs.components.subcontract, costs.components.damageClaims.cents, costs.components.other.basis], [{ cents: 4550, status: 'complete', basis: 'recorded', group: 'other_costs', openCount: 0 }, { cents: null, status: 'unknown', basis: 'closeout_unconfirmed', group: 'other_costs' }, null, 'closeout_unconfirmed']);
  const rest = [none('dump_fee'), none('subcontractor'), none('damage_claim'), none('other')];
  costs = fieldExpenseCosts([materials, income, fuel, row('fuel', 99999, { status: 'void' })], rest);
  assert.deepEqual([costs.status, costs.netCostCents, costs.knownCostCents, costs.recoveryIncomeCents, costs.reimbursableCents, costs.missing], ['complete', 5250, 5550, 300, 4550, []], 'fuel recorded and None for the rest; income is subtracted; void rows never count');
  assert.deepEqual(costs.components.subcontract, { cents: 0, status: 'complete', basis: 'attested_none', group: 'other_costs', openCount: 0 });
  assert.deepEqual(costs.byPayer, { company_card: 1000, crew_reimbursable: 4550, account_billed: 0, unspecified: 0 });
  costs = fieldExpenseCosts([materials, income, fuel, row('dump_fee', 7000, { state: 'pending' })], rest);
  assert.deepEqual([costs.status, costs.netCostCents, costs.components.disposal], ['partial', 5250, { cents: 0, status: 'partial', basis: 'recorded', group: 'dump_fee', openCount: 1 }], 'a pending receipt replaces the None but its amount is not yet counted');
  costs = fieldExpenseCosts([materials, fuel, row('lunch', 1200)], rest);
  assert.deepEqual([costs.status, costs.coverage.invalidCount, costs.netCostCents], ['partial', 1, 5550], 'an unreadable row keeps the whole job partial');
  const shared = row('dump_fee', 5001, { share: { loadId: uuid(), primaryJobId: 'job-1', totalCents: 10001, parts: [] } });
  shared.share.parts = [{ jobId: 'job-1', expenseId: shared.share.loadId, weight: 1, amountCents: 5001 }, { jobId: 'job-2', expenseId: uuid(), weight: 1, amountCents: 5000 }]; shared.id = shared.share.loadId;
  assert.equal(fieldExpenseCosts([shared], [none('material'), ...OTHER.map(none)]).components.disposal.cents, 5001, 'a shared load counts only this job’s part');
});

test('managers get the job-costing view with the listing and fieldExpenseJobCosts reads the same answer', async t => {
  setup(t); const client = api();
  for (const group of ['material', 'other_costs']) await client.post('Crew.One', { action: 'attest', jobId: 'job-1', requestId: uuid(), group });
  let manager = await (await client.get('ZacB', '?jobId=job-1')).json();
  assert.deepEqual([manager.costs.status, manager.costs.netCostCents, manager.costs.missing, manager.closeout.confirmed], ['unknown', null, ['dump_fee'], false]);
  await client.post('Crew.Two', entry({ amountCents: 6500 }));
  manager = await (await client.get('ZacB', '?jobId=job-1')).json();
  assert.deepEqual([manager.costs.status, manager.costs.netCostCents, manager.closeout.confirmed], ['complete', 6500, true]);
  const { jobId, ...costs } = await fieldExpenseJobCosts(env, 'job-1');
  assert.equal(jobId, 'job-1'); assert.deepEqual(costs, manager.costs);
  const crew = await (await client.get('Crew.One', '?jobId=job-1')).json();
  assert.equal(crew.costs, undefined); assert.equal(JSON.stringify(crew).includes('6500'), false, 'crew never see a colleague’s amount through the costing view');
  await assert.rejects(fieldExpenseJobCosts(env, '_egc_schedule_lock_2026-09-22'), error => error.status === 400);
});

test('a stale-revision commit (Firestore 400 FAILED_PRECONDITION) is a conflict, not an outage', async t => {
  const answers = [];
  const fetcher = async (_, url) => { assert.match(url, /:commit$/); const [status, body] = answers.shift(); return Response.json(body, { status }); };
  const store = createFieldExpenseStore(env, fetcher), expense = { id: uuid(), jobId: 'job-1', __updateTime: '2026-09-22T00:00:00.000000001Z' };
  answers.push([400, [{ error: { code: 400, status: 'FAILED_PRECONDITION' } }]]);
  await assert.rejects(store.update('job-1', expense, { note: 'x' }), error => error.code === 'FIELD_EXPENSE_REVISION_CONFLICT' && error.status === 409);
  answers.push([400, { error: { code: 400, status: 'FAILED_PRECONDITION' } }]);
  await assert.rejects(store.attest('job-1', [{ kind: 'material' }], { id: uuid() }), error => error.code === 'FIELD_EXPENSE_CLOSEOUT_CONFLICT');
  answers.push([409, { error: { status: 'ALREADY_EXISTS' } }]);
  await assert.rejects(store.createMany([{ id: uuid(), jobId: 'job-1' }]), error => error.code === 'FIELD_EXPENSE_CONFLICT');
  answers.push([400, { error: { code: 400, status: 'INVALID_ARGUMENT' } }]);
  await assert.rejects(store.update('job-1', expense, { note: 'x' }), error => error.code === 'FIELD_STORAGE_UNAVAILABLE' && error.status === 503, 'other 400s stay storage failures');
  const fixture = setup(t), client = api(), input = entry({ amountCents: 1200 });
  await client.post('Crew.One', input);
  const current = (await (await client.get('ZacB', '?jobId=job-1')).json()).entries[0], provider = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (url, options) => new URL(url).pathname.endsWith(':commit') ? Response.json({ error: { status: 'FAILED_PRECONDITION' } }, { status: 400 }) : provider(url, options));
  const response = await client.post('ZacB', { action: 'edit', jobId: 'job-1', requestId: uuid(), expenseId: current.id, expectedRevision: current.expectedRevision, amountCents: 1300, reason: 'Receipt shows $13' });
  assert.equal(response.status, 409); assert.equal((await response.json()).code, 'FIELD_EXPENSE_REVISION_CONFLICT');
  assert.equal(fixture.get(`jobs/job-1/fieldExpenses/${input.requestId}`).amountCents, 1200);
});

test('the closeout and new fields are server-only: no Firestore rule names them', async () => {
  const { readFileSync } = await import('node:fs');
  const rules = readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8');
  assert.doesNotMatch(rules, /fieldExpenseCloseout/);
  assert.match(rules, /match \/\{document=\*\*\} \{\s*allow read, write: if false;/);
  assert.equal(decodeFirestoreFields({}).share, undefined);
});
