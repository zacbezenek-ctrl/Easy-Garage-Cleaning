// LEGACY-SEND review: the sales follow-up exit finds other jobs of the same
// customer by normalized phone/email keys that this dry-run-by-default backfill
// writes on jobs. Synthetic data only; the store is in memory.
import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeFirestoreFields } from '../functions/_lib/firestore-job.js';
import { jobContactKeysPatch } from '../functions/_lib/customer-identity.js';
import { backfillStorage } from '../scripts/backfill-customer-identity.mjs';
import { planJobContactKeys, runJobContactKeysBackfill } from '../scripts/backfill-job-contact-keys.mjs';

const NOW = '2026-09-22T12:00:00.000Z';
const rows = () => [
  { id: 'job-a', type: 'job', phone: '970/555/0123', revision: 'r-a' },
  { id: 'job-b', type: 'walkthrough', phone: 9705550124, email: ' Synthetic@Example.INVALID ', revision: 'r-b' },
  { id: 'job-c', type: 'job', phone: '+1 970 555 0125', phoneE164: '+19705550125', emailLower: '', revision: 'r-c' },
  { id: 'job-d', type: 'cleanout', revision: 'r-d' },
  { id: 'job-e', type: 'job', phone: '555', email: 'not-an-email', revision: 'r-e' },
  { id: 'job-f', type: 'reorg', phone: '(970)-555-0126 ', phoneE164: '+19705550199', revision: 'r-f' },
  { id: '_egc_schedule_lock_2026-09-22', type: 'job', phone: '9705550127', revision: 'r-g' },
  { id: 'secure_vault', type: 'job', phone: '9705550128', revision: 'r-h' },
  { id: 'receipt-1', type: 'job', recordType: 'quo_message_receipt', phone: '9705550129', revision: 'r-i' },
  { id: 'block-1', type: 'blocked', phone: '9705550130', revision: 'r-j' },
];

// In-memory jobs with Firestore-style revision preconditions.
function memoryStore(initial = rows()) {
  const docs = new Map(initial.map(row => [row.id, structuredClone(row)])), commits = [], requested = [];
  let revision = 0;
  return {
    docs, commits, requested, failOn: new Set(),
    async jobs(fields) { requested.push(fields); return [...docs.values()].map(row => structuredClone(row)); },
    async commit(writes) {
      commits.push(writes.map(write => write.id));
      assert.equal(new Set(writes.map(write => write.id)).size, writes.length, 'one write per job per commit');
      for (const write of writes) {
        if (this.failOn.has(write.id)) throw Object.assign(new Error('Synthetic outage'), { code: 'dispatch_storage_unavailable', status: 503 });
        if (!write.revision || docs.get(write.id)?.revision !== write.revision) throw Object.assign(new Error('Synthetic conflict'), { code: 'dispatch_revision_conflict', status: 409 });
      }
      for (const write of writes) docs.set(write.id, { ...docs.get(write.id), ...write.patch, revision: `r-${++revision}` });
    },
  };
}

test('the plan writes normalized keys only on operational jobs whose keys are missing or stale', () => {
  const { writes, report } = planJobContactKeys(rows(), NOW);
  assert.deepEqual(writes.map(write => [write.id, write.revision, write.patch]), [
    ['job-a', 'r-a', { phoneE164: '+19705550123', emailLower: '', contactKeysNormalizedAt: NOW }],
    ['job-b', 'r-b', { phoneE164: '+19705550124', emailLower: 'synthetic@example.invalid', contactKeysNormalizedAt: NOW }],
    ['job-f', 'r-f', { phoneE164: '+19705550126', emailLower: '', contactKeysNormalizedAt: NOW }],
  ]);
  assert.ok(writes.every(write => write.collection === 'jobs' && Object.keys(write.patch).length === 3), 'nothing but the keys and their timestamp');
  assert.deepEqual(report.jobs, { scanned: 10, operational: 6, needsKeys: 3, unusablePhone: ['job-e'], unusableEmail: ['job-e'] });
  assert.equal(JSON.stringify(report).includes('555'), false, 'the report never holds a phone number');
  assert.equal(JSON.stringify(report).toLowerCase().includes('example.invalid'), false, 'or an email');
  assert.equal(jobContactKeysPatch({ phone: '', email: '' }, NOW), null, 'a job without contact details needs no keys');
  assert.deepEqual(jobContactKeysPatch({ phone: '', phoneE164: '+19705550123' }, NOW), { phoneE164: '', emailLower: '', contactKeysNormalizedAt: NOW }, 'a removed phone clears its key');
});

test('a dry run writes nothing; --apply writes once and a rerun is a no-op', async () => {
  const store = memoryStore();
  const dry = await runJobContactKeysBackfill(store, { now: NOW, runId: 'run-1' });
  assert.equal(dry.mode, 'dry_run');
  assert.deepEqual(dry.writes, { planned: 3, committed: 0, changedDuringRun: [] });
  assert.deepEqual(store.commits, []);
  assert.deepEqual(store.requested[0], ['type', 'recordType', 'phone', 'email', 'phoneE164', 'emailLower'], 'only identity fields are read');
  const applied = await runJobContactKeysBackfill(store, { apply: true, now: NOW, runId: 'run-2' });
  assert.deepEqual([applied.mode, applied.generatedAt, applied.writes], ['apply', NOW, { planned: 3, committed: 3, changedDuringRun: [] }]);
  assert.equal(store.docs.get('job-a').phoneE164, '+19705550123');
  assert.equal(store.docs.get('job-a').phone, '970/555/0123', 'the saved spelling is untouched');
  assert.equal(store.docs.get('job-b').emailLower, 'synthetic@example.invalid');
  assert.equal(store.docs.get('_egc_schedule_lock_2026-09-22').phoneE164, undefined);
  assert.equal(store.docs.get('receipt-1').phoneE164, undefined);
  const again = await runJobContactKeysBackfill(store, { apply: true, now: '2026-09-23T12:00:00.000Z' });
  assert.deepEqual(again.writes, { planned: 0, committed: 0, changedDuringRun: [] });
  assert.equal(store.commits.length, 1);
});

test('a job edited during the run skips only itself, and an outage aborts with a rerun message', async () => {
  const store = memoryStore(), commit = store.commit.bind(store);
  store.commit = async writes => { if (writes.length > 1) store.docs.set('job-b', { ...store.docs.get('job-b'), revision: 'r-edited' }); return commit(writes); };
  const result = await runJobContactKeysBackfill(store, { apply: true, now: NOW, batchSize: 2 });
  assert.deepEqual(result.writes, { planned: 3, committed: 2, changedDuringRun: ['job-b'] });
  assert.deepEqual(store.commits, [['job-a', 'job-b'], ['job-a'], ['job-b'], ['job-f']], 'the conflicting batch is retried one job at a time');
  assert.equal(store.docs.get('job-b').phoneE164, undefined);
  const rerun = await runJobContactKeysBackfill(store, { apply: true, now: NOW });
  assert.deepEqual(rerun.writes, { planned: 1, committed: 1, changedDuringRun: [] }, 'a rerun picks up the edited job');

  const broken = memoryStore();
  broken.failOn.add('job-f');
  const aborted = await runJobContactKeysBackfill(broken, { apply: true, now: NOW, batchSize: 1 });
  assert.deepEqual(aborted.writes, { planned: 3, committed: 2, changedDuringRun: [] });
  assert.equal(aborted.aborted.code, 'dispatch_storage_unavailable');
  assert.match(aborted.aborted.message, /Rerun it/);
  await assert.rejects(runJobContactKeysBackfill({ jobs: async () => null }), error => error.code === 'job_contact_keys_backfill_storage_incomplete');
});

test('the scan reads jobs with only the requested field mask', async () => {
  const urls = [];
  const fetcher = async (env, url) => {
    urls.push(new URL(url));
    return Response.json({ documents: [{ name: 'projects/egcw-1ec83/databases/(default)/documents/jobs/job-a', updateTime: NOW, fields: encodeFirestoreFields({ type: 'job', phone: '970/555/0123' }) }] });
  };
  const found = await backfillStorage({ FIREBASE_API_KEY: 'firebase-test-job-keys' }, fetcher).jobs(['type', 'phone', 'phoneE164']);
  assert.deepEqual(found, [{ type: 'job', phone: '970/555/0123', id: 'job-a', revision: NOW }]);
  assert.deepEqual(urls[0].searchParams.getAll('mask.fieldPaths'), ['type', 'phone', 'phoneE164']);
});
