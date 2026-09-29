import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const enabled = process.env.EGC_FIREBASE_EMULATOR_TEST === '1';

test('windowed dispatch queries, searchKeys lookups and coverage counts hold on real Firestore', { skip: !enabled, timeout: 600000 }, async t => {
  const host = process.env.FIRESTORE_EMULATOR_HOST || '';
  assert.match(host, /^(?:127\.0\.0\.1|localhost):\d{2,5}$/, 'This test may only connect to a loopback Firestore emulator.');
  const run = randomUUID().slice(0, 8), projectId = `demo-egc-window-${run}`, [hostname] = host.split(':');
  const { dispatchStorage } = await import('../functions/_lib/dispatch-storage.js');
  const { customerSearchFields } = await import('../functions/_lib/customer-identity.js');
  const { runCustomerSearchKeysBackfill } = await import('../scripts/backfill-customer-search-keys.mjs');
  // A cold emulator JVM can take longer than dispatchStorage's 20-second request
  // timeout, which this test is not about: each request gets 90 seconds instead.
  const fetcher = async (_env, url, { signal, ...options } = {}) => {
    const target = new URL(url); target.protocol = 'http:'; target.host = host; target.pathname = target.pathname.replace('/projects/egcw-1ec83/', `/projects/${projectId}/`);
    assert.equal(target.hostname, hostname);
    return fetch(target, { ...options, signal: AbortSignal.timeout(90000), ...(options.body ? { body: options.body.replaceAll('projects/egcw-1ec83/', `projects/${projectId}/`) } : {}), headers: { ...options.headers, Authorization: 'Bearer owner' } });
  };
  const store = dispatchStorage({ EGC_DISPATCH_WINDOWED_READS: 'true' }, fetcher);
  // Warm the read and write paths before the seed commit; a lost warm-up write is harmless.
  for (let attempt = 0; ; attempt++) {
    try { await store.read('jobs', 'warmup'); await store.commit([{ collection: 'dispatchWarmup', id: `w${attempt}`, patch: { attempt } }]); break; }
    catch (error) { if (attempt >= 5) throw error; await new Promise(resolve => setTimeout(resolve, 2000)); }
  }
  const job = (date, endDate, extra = {}) => ({ type: 'job', status: 'scheduled', time: '08:00', endTime: '10:00', assignedCrew: ['crew1'], operationalScope: { text: 'Synthetic scope', updatedBy: 'zacb' }, payment: { amount: 1 }, date, ...(endDate === undefined ? {} : { endDate }), ...extra });
  const rows = {
    'prior-multi': job('2026-09-19', '2026-09-23'), 'legacy-no-end': job('2026-09-24'), 'legacy-empty-end': job('2026-09-25', ''), 'legacy-null-end': job('2026-09-26', null),
    'numeric-end': job('2026-08-01', 20260930), 'backlog-empty': job('', ''), 'backlog-null': job(null, null),
    'old-availability': { type: 'availability', recordType: 'crew_availability', employee: 'crew1', date: '2025-01-05', endDate: '2025-01-05', allDay: true, status: 'active' },
    'legacy-availability': { type: 'availability', employee: 'Crew Two', status: 'active' }, 'resource-style': { recordType: 'availability', employeeId: 'crew2', status: 'active' },
    'history': job('2026-08-10', '2026-08-12', { customerId: 'c-john', sourceWalkthroughId: 'walk-1' }), 'future': job('2027-10-01', '2027-10-01', { customerId: 'c-john' }),
  };
  await store.commit(Object.entries(rows).map(([id, patch]) => ({ collection: 'jobs', id, patch })));

  await t.test('the union finds prior-day, legacy, undated and availability rows, masked, and skips history', async () => {
    const found = await store.jobsNear('2026-09-22', '2026-09-29'), ids = found.map(row => row.id);
    assert.deepEqual(ids, ['backlog-empty', 'backlog-null', 'future', 'legacy-availability', 'legacy-empty-end', 'legacy-no-end', 'legacy-null-end', 'old-availability', 'prior-multi', 'resource-style']);
    assert.ok(!ids.includes('history') && !ids.includes('numeric-end'), 'range filters only match strings, as the fake assumes');
    const prior = found.find(row => row.id === 'prior-multi');
    assert.equal(prior.payment, undefined, 'the select mask keeps payment evidence out');
    assert.deepEqual(prior.operationalScope, { text: 'Synthetic scope' }, 'dotted mask paths select only the nested field');
    assert.equal(prior.revision, (await store.read('jobs', 'prior-multi')).revision);
  });

  await t.test('save equality queries find every job of a customer or walkthrough whatever its date', async () => {
    assert.deepEqual((await store.jobsWhere('customerId', 'c-john')).map(row => row.id), ['future', 'history']);
    assert.deepEqual((await store.jobsWhere('sourceWalkthroughId', 'walk-1')).map(row => row.id), ['history']);
    assert.deepEqual(await store.jobsWhere('customerId', 'c-nobody'), [], 'an empty result is a readTime-only answer, not []');
    const masked = await store.readMany('jobs', ['prior-multi', 'missing-job'], ['type']);
    assert.deepEqual(masked.map(row => [row.id, Object.keys(row).sort()]), [['prior-multi', ['id', 'revision', 'type']]]);
  });

  await t.test('cursor pagination walks past 500 tied rows exactly once', async () => {
    const tied = Array.from({ length: 1030 }, (_, index) => ({ collection: 'jobs', id: `tie-${String(index).padStart(4, '0')}`, patch: job('2026-10-02', '2026-10-02') }));
    for (let start = 0; start < tied.length; start += 400) await store.commit(tied.slice(start, start + 400));
    const found = (await store.jobsNear('2026-10-01', '2026-10-08')).filter(row => row.id.startsWith('tie-'));
    assert.equal(found.length, 1030); assert.equal(new Set(found.map(row => row.id)).size, 1030);
  });

  await t.test('searchKeys array-contains lookups and the keyed and total coverage counts', async () => {
    await store.commit([
      { collection: 'customers', id: 'c-john', patch: { name: 'Synthetic John Smith', phone: '(970) 555-0100', ...customerSearchFields({ name: 'Synthetic John Smith', phone: '(970) 555-0100' }) } },
      { collection: 'customers', id: 'c-unkeyed', patch: { name: 'Johnny Unkeyed', phone: '9705550177' } },
    ]);
    assert.deepEqual((await store.customersByKey('john')).map(row => row.id), ['c-john']);
    assert.deepEqual((await store.customersByKey('0100')).map(row => row.id), ['c-john']);
    assert.deepEqual(await store.customerKeyCoverage(), { total: 2, keyed: 1, complete: false }, 'the total is counted at the keyed count\'s readTime');
    const report = await runCustomerSearchKeysBackfill(store, { apply: true, now: '2026-09-22T12:00:00.000Z' });
    assert.deepEqual(report.writes, { planned: 1, committed: 1, changedDuringRun: [] });
    assert.deepEqual(await store.customerKeyCoverage(), { total: 2, keyed: 2, complete: true });
    assert.deepEqual((await store.customersByKey('john')).map(row => row.id), ['c-john', 'c-unkeyed']);
  });
});
