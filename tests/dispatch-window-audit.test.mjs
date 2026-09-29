import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dispatchStorage } from '../functions/_lib/dispatch-storage.js';
import { runDispatchWindowAudit, AUDIT_FIELDS } from '../scripts/dispatch-window-audit.mjs';
import { firestoreRest } from './helpers/firestore-rest-queries.mjs';

const NOW = new Date('2026-09-22T12:00:00.000Z');
const job = (date, endDate, extra = {}) => ({ type: 'job', status: 'scheduled', time: '08:00', endTime: '10:00', assignedCrew: ['crew1'], date, ...(endDate === undefined ? {} : { endDate }), ...extra });
const seed = () => ({
  'jobs/current': job('2026-09-23', '2026-09-23'), 'jobs/history': job('2026-01-10', '2026-01-10'), 'jobs/backlog': job('', ''),
  'jobs/availability': { type: 'availability', employee: 'crew1', date: '2025-01-05', allDay: true, status: 'active' },
  'jobs/_egc_schedule_lock_2026-09-23': { recordType: 'schedule_lock', date: '2026-09-23', entries: [] },
});
const audit = fs => {
  const scan = dispatchStorage({}, fs.fetcher), windowed = dispatchStorage({ EGC_DISPATCH_WINDOWED_READS: 'true' }, fs.fetcher);
  return runDispatchWindowAudit({ jobs: () => scan.jobRecords(AUDIT_FIELDS), jobsNear: windowed.jobsNear }, { now: NOW, runId: 'synthetic-run' });
};

test('the window audit is read only and clean when every conflict-evidence row is windowed', async () => {
  const fs = firestoreRest(seed()), report = await audit(fs);
  assert.deepEqual(report, { mode: 'read_only', runId: 'synthetic-run', generatedAt: NOW.toISOString(), startDate: '2026-09-22', floor: '2026-08-18', jobs: { scanned: 5, windowed: 4 }, missing: { count: 0, byReason: {}, jobIds: [] } });
  assert.ok(fs.calls.every(call => call.method === 'GET' || call.path === ':runQuery'), 'no commit, transaction or other write');
  assert.deepEqual(new URLSearchParams(fs.scans('jobs')[0].query).getAll('mask.fieldPaths'), AUDIT_FIELDS, 'the scan never loads job bodies');
});

test('the window audit reports rows written after the switch that the windowed reads cannot find', async () => {
  const fs = firestoreRest({ ...seed(), 'jobs/us-format': job('09/21/2026', '09/21/2026'), 'jobs/numeric': job(20260923, 20260923), 'jobs/no-date': (({ date, ...row }) => row)(job('', '')),
    'jobs/egc_9705550100': job('1/5/2026', '') });
  const report = await audit(fs);
  assert.equal(report.missing.count, 4);
  assert.deepEqual(report.missing.byReason, { unverifiable_date: 3, undated: 1 });
  assert.deepEqual(report.missing.jobIds, ['egc_…0100', 'no-date', 'numeric', 'us-format'], 'ids that embed a phone are masked');
  assert.ok(!JSON.stringify(report).includes('9705550100'));
});

test('the audit command refuses to run without credentials or with unknown arguments', () => {
  const script = fileURLToPath(new URL('../scripts/dispatch-window-audit.mjs', import.meta.url));
  const run = args => spawnSync(process.execPath, [script, ...args], { env: {}, encoding: 'utf8' });
  assert.equal(run([]).status, 2); assert.match(run([]).stderr, /FIREBASE_SERVICE_ACCOUNT_JSON is required/);
  assert.equal(run(['--apply']).status, 2, 'there is nothing to apply: the audit never writes');
  assert.equal(run(['--help']).status, 0);
});
