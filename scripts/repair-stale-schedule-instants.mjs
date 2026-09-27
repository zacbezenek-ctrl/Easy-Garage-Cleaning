/** Repair schedule-derived fields left stale by the pre-P1-01 operations bridge.
 *
 * Before P1-01, mutateScheduledVisit (operations-scheduling.js) changed a visit's
 * Denver wall clock (date/time/endTime) without rewriting endDate, startAt, endAt
 * or timeZone. A visit moved to a later day was left with endDate before date
 * (no valid interval, so conflict checks could not see it); one moved to an
 * earlier day looked like multi-day work that blocked future bridge updates. Its
 * schedule-lock entry could also claim the day until 24:00.
 *
 * Wall-clock fields are authoritative. This recomputes the derived fields with
 * the dispatch-time helpers for rows where they disagree. An endDate after date
 * is collapsed only when the latest bridge receipt wrote the current wall clock
 * (the bridge only produces single-day visits); otherwise endDate is kept.
 *
 * Dry run by default (read-only, masked scan):
 *   FIREBASE_SERVICE_ACCOUNT_JSON='{...}' node scripts/repair-stale-schedule-instants.mjs
 * Write the listed repairs:
 *   FIREBASE_SERVICE_ACCOUNT_JSON='{...}' node scripts/repair-stale-schedule-instants.mjs --apply
 * Add --json for a machine-readable result. With --apply, each row is written in
 * its own commit with its scan updateTime as the precondition, together with its
 * schedule-lock entries (lock updateTime preconditions) and a dispatchState/revision
 * bump, so a concurrent dispatch save gets a revision conflict instead of racing.
 * A row that changed since the scan is skipped. The report prints ids and
 * schedule fields only, never customer data. */
import { pathToFileURL } from 'node:url';
import { dispatchStorage } from '../functions/_lib/dispatch-storage.js';
import { firebaseServiceAccountConfigured } from '../functions/_lib/firebase-service-account.js';
import { DISPATCH_TIME_ZONE } from '../functions/_lib/dispatch-contract.js';
import { validDate, scheduleInterval, occupiedDays } from '../functions/_lib/dispatch-time.js';
import { localInstant } from '../functions/_lib/operations-portal-records.js';

/** The scan reads schedule fields plus bridge receipt evidence, nothing else. */
export const REPAIR_SCAN_FIELDS = Object.freeze(['type','recordType','status','pipelineStatus','date','time','endDate','endTime','startAt','endAt','timeZone','allDay','portalVisitId','after','createdAt']);
const HHMM = /^\d{2}:\d{2}$/;
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d{1,9})?)?(?:Z|[+-]\d\d:\d\d)$/;
const present = value => value !== undefined && value !== null && value !== '';
const sameInstant = (stored, expected) => typeof stored === 'string' && ISO.test(stored) && Date.parse(stored) === Date.parse(expected);
const repairFailure = (code, message) => Object.assign(new Error(message), { code });

/** The latest operations-bridge receipt per visit, keyed by visit id. */
export function bridgeEvidence(rows) {
  const latest = new Map();
  for (const row of rows || []) {
    if (row?.recordType !== 'schedule_operation' || typeof row.portalVisitId !== 'string' || !row.after || typeof row.after !== 'object') continue;
    const seen = latest.get(row.portalVisitId);
    if (!seen || String(row.createdAt || '') > String(seen.createdAt || '')) latest.set(row.portalVisitId, { date: row.after.date, time: row.after.time, endTime: row.after.endTime, createdAt: row.createdAt || '' });
  }
  return latest;
}

/** Pure detection and recompute for one decoded jobs row. Returns null when the
 * row is out of scope or consistent (missing derived fields are not stale; every
 * reader derives them from the wall clock), {action:'repair', patch} when the
 * derived fields can be recomputed, or {action:'review', reason} otherwise. */
export function inspectScheduleInstants(row, bridgeAfter = null) {
  if (!row?.id || /^(_egc_|secure_)/.test(row.id) || row.recordType || row.type === 'availability' || row.allDay === true) return null;
  if (!validDate(row.date) || !HHMM.test(row.time || '') || !HHMM.test(row.endTime || '')) return null;
  const summary = { id: row.id, revision: row.revision || '', status: String(row.pipelineStatus || row.status || ''), wall: { date: row.date, time: row.time, endTime: row.endTime },
    before: { endDate: row.endDate ?? null, startAt: row.startAt ?? null, endAt: row.endAt ?? null, timeZone: row.timeZone ?? null } };
  const reasons = [];
  let endDate = row.date;
  if (present(row.endDate)) {
    if (!validDate(row.endDate)) return { action: 'review', ...summary, reason: 'end_date_invalid' };
    if (row.endDate < row.date) reasons.push('end_date_before_date');
    else if (row.endDate > row.date) {
      const start = localInstant(row.date, row.time), startStale = present(row.startAt) && (!start || !sameInstant(row.startAt, start));
      const bridgeWroteWallClock = bridgeAfter && bridgeAfter.date === row.date && bridgeAfter.time === row.time && bridgeAfter.endTime === row.endTime;
      if (startStale && bridgeWroteWallClock) reasons.push('bridge_reschedule_kept_old_end_date');
      else endDate = row.endDate;
    }
  }
  const interval = scheduleInterval({ date: row.date, time: row.time, endDate, endTime: row.endTime });
  if (!interval) return reasons.length || present(row.startAt) || present(row.endAt) ? { action: 'review', ...summary, reason: 'wall_time_invalid' } : null;
  if (present(row.startAt) && !sameInstant(row.startAt, interval.startAt)) reasons.push('start_at_stale');
  if (present(row.endAt) && !sameInstant(row.endAt, interval.endAt)) reasons.push('end_at_stale');
  if (present(row.timeZone) && row.timeZone !== DISPATCH_TIME_ZONE) reasons.push('time_zone_mismatch');
  if (!reasons.length) return null;
  return { action: 'repair', ...summary, reasons, patch: { endDate, startAt: interval.startAt, endAt: interval.endAt, timeZone: DISPATCH_TIME_ZONE } };
}

export function planScheduleInstantRepairs(rows) {
  const evidence = bridgeEvidence(rows), repairs = [], review = [];
  for (const row of rows || []) {
    const result = inspectScheduleInstants(row, evidence.get(row?.id) || null);
    if (result?.action === 'repair') repairs.push(result);
    else if (result?.action === 'review') review.push(result);
  }
  return { scanned: (rows || []).length, repairs, review };
}

/** This row's entries in one day lock, rewritten from the repaired row. Other
 * entries are untouched. Returns null when nothing changes; a malformed lock is
 * never overwritten. */
export function repairedLockEntries(lock, row, date) {
  if (!lock) return null;
  if (lock.recordType !== 'schedule_lock' || !Array.isArray(lock.entries)) throw repairFailure('repair_lock_unavailable', `Schedule lock ${date} needs review; it was not changed.`);
  const days = occupiedDays(row), entries = [];
  let changed = false;
  for (const entry of lock.entries) {
    if (entry?.id !== row.id) { entries.push(entry); continue; }
    if (!days.includes(date)) { changed = true; continue; }
    const start = date === row.date ? row.time : '00:00', end = date === (row.endDate || row.date) ? row.endTime : '24:00';
    if (entry.start === start && entry.end === end) entries.push(entry);
    else { changed = true; entries.push({ ...entry, start, end }); }
  }
  return changed ? entries : null;
}

export async function applyScheduleInstantRepair(store, repair, now) {
  const guard = await store.read('dispatchState', 'revision');
  const current = await store.read('jobs', repair.id);
  if (!current || current.revision !== repair.revision) return { id: repair.id, outcome: 'changed_since_scan' };
  const fixed = { ...current, ...repair.patch };
  const dates = [...new Set([...occupiedDays(current), ...occupiedDays(fixed)])].sort();
  const writes = [{ collection: 'jobs', id: current.id, revision: current.revision, patch: { ...repair.patch, scheduleInstantsRepair: { at: now, reasons: repair.reasons, before: repair.before } } }];
  for (const date of dates) {
    const id = `_egc_schedule_lock_${date}`, lock = await store.read('jobs', id), entries = repairedLockEntries(lock, fixed, date);
    if (entries) writes.push({ collection: 'jobs', id, revision: lock.revision, patch: { recordType: 'schedule_lock', date, entries, updatedAt: now } });
  }
  writes.push({ collection: 'dispatchState', id: 'revision', revision: guard?.revision, patch: { updatedAt: now } });
  await store.commit(writes);
  return { id: repair.id, outcome: 'repaired', lockDays: writes.length - 2 };
}

const show = value => value ?? '(none)';
export function formatScheduleRepairReport(plan, { apply = false, applied = [] } = {}) {
  const lines = [apply ? 'Stale schedule instants: APPLY (writing the repairs below).' : 'Stale schedule instants: DRY RUN (no writes). Re-run with --apply to write the repairs below.',
    `Scanned ${plan.scanned} jobs rows: ${plan.repairs.length} repairable, ${plan.review.length} need manual review.`];
  for (const row of plan.repairs) {
    lines.push(`REPAIR ${row.id} [${row.status || 'unknown'}] ${row.wall.date} ${row.wall.time}-${row.wall.endTime} (${row.reasons.join(', ')})`);
    lines.push(`  ${['endDate', 'startAt', 'endAt', 'timeZone'].map(key => `${key} ${show(row.before[key])} -> ${row.patch[key]}`).join(' | ')}`);
  }
  for (const row of plan.review) lines.push(`REVIEW ${row.id} [${row.status || 'unknown'}] ${row.wall.date} ${row.wall.time}-${row.wall.endTime} (${row.reason}) endDate=${show(row.before.endDate)} startAt=${show(row.before.startAt)} endAt=${show(row.before.endAt)}`);
  for (const row of applied) lines.push(`${row.outcome.toUpperCase()} ${row.id}${row.lockDays ? ` (${row.lockDays} lock day${row.lockDays === 1 ? '' : 's'} rewritten)` : ''}${row.code ? ` ${row.code}` : ''}`);
  return lines;
}

export async function runScheduleInstantRepair({ store, apply = false, now = new Date().toISOString(), log = console.log }) {
  const plan = planScheduleInstantRepairs(await store.jobRecords(REPAIR_SCAN_FIELDS));
  const applied = [];
  if (apply) {
    for (const repair of plan.repairs) {
      try { applied.push(await applyScheduleInstantRepair(store, repair, now)); }
      catch (error) { applied.push({ id: repair.id, outcome: 'failed', code: typeof error?.code === 'string' ? error.code : 'repair_failed' }); }
    }
  }
  for (const line of formatScheduleRepairReport(plan, { apply, applied })) log(line);
  return { ...plan, apply, applied };
}

async function main(argv = process.argv.slice(2), env = process.env) {
  if (argv.some(arg => !['--apply', '--json'].includes(arg))) { console.error('Usage: node scripts/repair-stale-schedule-instants.mjs [--apply] [--json]'); process.exitCode = 2; return; }
  if (!firebaseServiceAccountConfigured(env)) { console.error('FIREBASE_SERVICE_ACCOUNT_JSON is required. The default run is read-only.'); process.exitCode = 2; return; }
  const json = argv.includes('--json');
  const result = await runScheduleInstantRepair({ store: dispatchStorage(env), apply: argv.includes('--apply'), now: new Date().toISOString(), log: json ? () => {} : console.log });
  if (json) console.log(JSON.stringify(result, null, 2));
  if (result.applied.some(row => row.outcome !== 'repaired')) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
