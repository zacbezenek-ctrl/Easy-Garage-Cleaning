import { can } from './staff-roles.js';
import { addDays, denverToday, validDate } from './dispatch-time.js';
import { firestoreFetch } from './firebase-service-account.js';
import { decodeFirestoreFields, encodeFirestoreValue } from './firestore-job.js';
import { mergeSettings } from '../../crew/knock-settings.js';
import { shiftTiming } from '../../crew/knock-stats.js';
import { zonedInstant } from '../../crew/knock-time.js';

/** D2D-BOARD (owner 2026-10-17: "the hub needs the weekend crew, the two weekday teams, all of the door-to-door, and the
 * estimator schedules"): the door-to-door day on the Hub schedule board, read only.
 * GET /api/d2d-day?date=YYYY-MM-DD (a Denver date, D2D_DAY_HISTORY_DAYS back to D2D_DAY_AHEAD_DAYS ahead of today).
 * Who: schedule.view (staff-roles.js: business access, or the owner, manager or team_lead role; no flag). Sales,
 * Phone, crew leads, crew and Knock reps get 403 d2d_day_forbidden.
 * What: the reps who were on shift that day (knock_shifts.day), plus any rep with a door sale that day or a D2D job
 * made that day (a walkthrough set from a phone that synced after its shift still counts, on the day it reached the
 * Hub); for each, the
 * shift times, the areas they hold (active knock_assignments: self-claimed or admin) and worked that day, the doors,
 * answers and looks of the day (knock_days), the door sales of the day (knock_sales.saleDate, never cancelled ones in
 * the count) and the walkthroughs they set; and the Hub jobs the door-to-door bridge created (jobs.source
 * 'door_to_door', jobs.d2d {repKey, saleId|setterEventId, kind 'sale'|'walkthrough'}) that day or that are booked on
 * that day, as links. No customer name, phone, email, street address, ticket, deposit, commission or money of any
 * kind leaves here; a job is its id, type, date, time and status, and the Hub job page shows the rest to whoever may
 * see it.
 * Reads (all bounded by the date and the day's reps, never a whole-collection scan): the Knock settings document; one
 * equality query on knock_shifts.day and one on knock_sales.saleDate (masked, no customer fields); on jobs: date ==
 * day AND source == 'door_to_door' (equality only), source == 'door_to_door' AND createdAt inside the Denver day
 * (the jobs/source+createdAt composite index in firestore.indexes.json), and d2d.saleId IN the day's sales that
 * neither found (chunks of 30); then, for the reps who worked that day only, one batchGet each for the reps and
 * their knock_days summaries and knock_assignments where repKey IN those reps (chunks of 30) AND active == true
 * (equality filters only); and one batchGet of the named neighborhoods. Every query is capped (D2D_DAY_LIMIT); a
 * capped answer says so in coverage.truncated, and Hub jobs or held areas that could not be read (a missing index
 * included) are named in coverage.missing ('jobs', 'areas'; the Knock day still shows); either way
 * coverage.complete is false.
 * EGC_D2D_BOARD exactly "false" turns this off: 404 d2d_day_disabled before any read. */
export const D2D_DAY_HISTORY_DAYS = 62;
export const D2D_DAY_AHEAD_DAYS = 31;
export const D2D_DAY_LIMIT = 200;
export const d2dBoardEnabled = env => env?.EGC_D2D_BOARD !== 'false';
// The job fields the D2D day reads: identity and schedule only.
export const D2D_JOB_FIELDS = Object.freeze(['type', 'recordType', 'date', 'time', 'endDate', 'endTime', 'status', 'pipelineStatus', 'source', 'd2d', 'createdAt']);
// The sale fields: no customer, ticket, deposit, address or commission.
export const D2D_SALE_FIELDS = Object.freeze(['repKey', 'saleDate', 'soldAt', 'status', 'package', 'jobDate', 'jobStartTime', 'neighborhoodId']);
const SHIFT_FIELDS = ['repKey', 'day', 'startedAt', 'endedAt', 'endReason', 'breaks', 'lastDoorAt', 'lastNeighborhoodId', 'doors'];
const ROOT = 'projects/egcw-1ec83/databases/(default)/documents';
const BASE = `https://firestore.googleapis.com/v1/${ROOT}`;
const JOB_ID = /^[A-Za-z0-9_-]{1,180}$/, KEY = /^[A-Za-z0-9_.-]{1,150}$/;
const KINDS = new Set(['sale', 'walkthrough']);
const CANCELLED = new Set(['cancelled', 'canceled']);

const fail = (code, message, status) => Object.assign(new Error(message), { code, status });
const text = (value, max = 120) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const iso = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(Date.parse(value)).toISOString() : null;
const count = value => Number.isFinite(Number(value)) && Number(value) > 0 ? Math.round(Number(value)) : 0;

/** Whether this session may read the door-to-door day: schedule.view, which needs no flag. */
export function canViewD2dDay(session, env = {}) {
  return Boolean(session?.user) && can(session, 'schedule.view', env);
}

/** The Denver date a request names; 400 d2d_day_date_invalid otherwise. */
export function d2dDayDate(params, now = new Date()) {
  const today = denverToday(now), date = params.get('date') || today;
  if ([...params.keys()].some(key => key !== 'date') || !validDate(date) || date < addDays(today, -D2D_DAY_HISTORY_DAYS) || date > addDays(today, D2D_DAY_AHEAD_DAYS))
    throw fail('d2d_day_date_invalid', `Choose a Mountain date from ${D2D_DAY_HISTORY_DAYS} days ago to ${D2D_DAY_AHEAD_DAYS} days ahead.`, 400);
  return date;
}

/** A Hub job's door-to-door marker ({repKey, kind}) or null. A job without the bridge's d2d record is never D2D. */
export function d2dMarker(job) {
  const marker = job?.d2d;
  if (!marker || typeof marker !== 'object' || Array.isArray(marker)) return null;
  const repKey = text(marker.repKey, 150);
  if (!KEY.test(repKey)) return null;
  const kind = KINDS.has(marker.kind) ? marker.kind : job.type === 'walkthrough' ? 'walkthrough' : 'sale';
  return { repKey, kind, saleId: KEY.test(text(marker.saleId, 150)) ? text(marker.saleId, 150) : '' };
}

/** Hub jobs reads for the day, through the service account (functions/_lib/firebase-service-account.js). */
export function d2dJobReader(env, fetcher = firestoreFetch) {
  const field = fieldPath => ({ fieldPath });
  const filter = (path, op, value) => ({ fieldFilter: { field: field(path), op, value: encodeFirestoreValue(value) } });
  async function run(where, orderBy = null) {
    let response;
    const structuredQuery = { from: [{ collectionId: 'jobs' }], select: { fields: D2D_JOB_FIELDS.map(field) }, where, ...(orderBy ? { orderBy } : {}), limit: D2D_DAY_LIMIT + 1 };
    try { response = await fetcher(env, `${BASE}:runQuery`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ structuredQuery }), signal: AbortSignal.timeout(20000) }); }
    catch { throw fail('d2d_day_storage_unavailable', 'The schedule could not be read. Retry.', 503); }
    if (!response.ok) throw fail('d2d_day_storage_unavailable', 'The schedule could not be read. Retry.', 503);
    const results = await response.json().catch(() => null);
    // runQuery always answers with at least a readTime; an empty array is not an empty result.
    if (!Array.isArray(results) || !results.some(row => row?.document || typeof row?.readTime === 'string')) throw fail('d2d_day_storage_unavailable', 'The schedule answer was incomplete. Retry.', 503);
    const rows = [];
    for (const { document } of results) {
      if (!document) continue;
      const id = typeof document.name === 'string' ? document.name.split('/').pop() : '';
      if (!JOB_ID.test(id)) continue;
      rows.push({ ...decodeFirestoreFields(document.fields || {}), id });
    }
    return { rows: rows.slice(0, D2D_DAY_LIMIT), truncated: rows.length > D2D_DAY_LIMIT };
  }
  const and = filters => ({ compositeFilter: { op: 'AND', filters } });
  return {
    // Equality on two fields is served by Firestore's single-field indexes (no composite index).
    bookedOn: date => run(and([filter('date', 'EQUAL', date), filter('source', 'EQUAL', 'door_to_door')])),
    // Only the door-to-door jobs made that day (firestore.indexes.json: jobs source ASC, createdAt ASC), never the
    // whole day's jobs and receipts.
    createdBetween: (from, to) => run(and([filter('source', 'EQUAL', 'door_to_door'), filter('createdAt', 'GREATER_THAN_OR_EQUAL', from), filter('createdAt', 'LESS_THAN', to)]), [{ field: field('createdAt'), direction: 'ASCENDING' }, { field: field('__name__'), direction: 'ASCENDING' }]),
    async forSales(ids) {
      const out = { rows: [], truncated: false };
      for (let index = 0; index < ids.length; index += 30) {
        const part = await run(filter('d2d.saleId', 'IN', ids.slice(index, index + 30)));
        out.rows.push(...part.rows); out.truncated ||= part.truncated;
      }
      return out;
    },
  };
}

// A capped knock query: one more than the cap is asked for, so a full page reads as truncated, never as complete.
async function capped(store, collection, options) {
  const rows = await store.query(collection, { ...options, limit: D2D_DAY_LIMIT + 1 });
  return { rows: rows.slice(0, D2D_DAY_LIMIT), truncated: rows.length > D2D_DAY_LIMIT };
}
// The areas the day's reps hold: their active assignments only (repKey IN, chunks of 30), never the whole territory's.
async function heldAreas(store, repKeys) {
  const out = { rows: [], truncated: false };
  for (let index = 0; index < repKeys.length; index += 30) {
    const part = await capped(store, 'knock_assignments', { where: [['repKey', 'in', repKeys.slice(index, index + 30)], ['active', '==', true]], select: ['repKey', 'neighborhoodId', 'active', 'source'] });
    out.rows.push(...part.rows); out.truncated ||= part.truncated;
  }
  return out;
}

/** Everything the day needs, read once (see the read list above). `store` is a Knock store (knock-store.js), `jobs` a
 * d2dJobReader. */
export async function loadD2dDay({ store, jobs, date }) {
  const truncated = [], missing = [];
  const note = (name, part) => { if (part.truncated) truncated.push(name); return part.rows; };
  // The Hub jobs are links on top of the Knock day: when they cannot be read the day still shows, marked incomplete.
  const soft = promise => promise.catch(() => { missing.push('jobs'); return { rows: [], truncated: false }; });
  const dayStart = zonedInstant(date), dayEnd = zonedInstant(addDays(date, 1));
  const [settingsDoc, shiftPart, salePart, bookedPart, createdPart] = await Promise.all([
    store.get('knock_settings', 'current'),
    capped(store, 'knock_shifts', { where: [['day', '==', date]], select: SHIFT_FIELDS }),
    capped(store, 'knock_sales', { where: [['saleDate', '==', date]], select: [...D2D_SALE_FIELDS] }),
    soft(jobs.bookedOn(date)),
    soft(jobs.createdBetween(new Date(dayStart).toISOString(), new Date(dayEnd).toISOString())),
  ]);
  const shifts = note('shifts', shiftPart), sales = note('sales', salePart);
  const found = [...note('jobs', bookedPart), ...note('jobs', createdPart).filter(row => d2dMarker(row) || row.source === 'door_to_door')];
  // A sale's job made on another day (a phone that synced later) is found by its sale id.
  const linked = new Set(found.map(row => d2dMarker(row)?.saleId).filter(Boolean));
  const unlinked = sales.map(sale => sale.id).filter(id => KEY.test(id) && !linked.has(id));
  if (unlinked.length && !missing.length) found.push(...note('jobs', await soft(jobs.forSales(unlinked))));
  // The reps who worked that day: a shift, a door sale or a D2D job made that day. Day summaries and areas only for
  // them; names also for the reps the day's other jobs name.
  const madeToday = row => { const at = Date.parse(row.createdAt); return Number.isFinite(at) && at >= dayStart && at < dayEnd; };
  const working = [...new Set([...shifts.map(row => row.repKey), ...sales.map(row => row.repKey), ...found.filter(madeToday).map(row => d2dMarker(row)?.repKey)].filter(key => KEY.test(key || '')))];
  const repKeys = [...new Set([...working, ...found.map(row => d2dMarker(row)?.repKey)].filter(key => KEY.test(key || '')))];
  const [reps, days, assignmentPart] = await Promise.all([
    repKeys.length ? store.getMany('knock_reps', repKeys) : new Map(),
    working.length ? store.getMany('knock_days', working.map(key => `${key}_${date}`).filter(id => KEY.test(id))) : new Map(),
    // Areas are context on top of the day: when they cannot be read the day still shows, marked incomplete.
    working.length ? heldAreas(store, working).catch(() => { missing.push('areas'); return { rows: [], truncated: false }; }) : { rows: [], truncated: false },
  ]);
  const held = note('assignments', assignmentPart).filter(row => row.active === true && working.includes(row.repKey));
  const areaIds = new Set([...held.map(row => row.neighborhoodId), ...shifts.map(row => row.lastNeighborhoodId), ...sales.map(row => row.neighborhoodId),
    ...[...days.values()].flatMap(day => Object.keys(day?.byNeighborhood || {}))].filter(id => KEY.test(id || '') && id !== 'unknown'));
  const neighborhoods = areaIds.size ? await store.getMany('knock_neighborhoods', [...areaIds]) : new Map();
  return { settings: mergeSettings(settingsDoc?.settings || {}), shifts, sales, assignments: held, jobs: found, reps, days, neighborhoods, truncated: [...new Set(truncated)], missing: [...new Set(missing)] };
}

const jobRow = (job, date, dayStart, dayEnd) => {
  const marker = d2dMarker(job), created = Date.parse(job.createdAt);
  return { id: job.id, kind: marker?.kind || (job.type === 'walkthrough' ? 'walkthrough' : 'sale'), repKey: marker?.repKey || '', type: text(job.type, 40) || 'job',
    date: validDate(job.date) ? job.date : '', time: /^\d{2}:\d{2}$/.test(job.time || '') ? job.time : '', status: text(job.status || job.pipelineStatus, 40) || 'scheduled',
    bookedToday: job.date === date, createdToday: Number.isFinite(created) && created >= dayStart && created < dayEnd, ...(marker?.saleId ? { saleId: marker.saleId } : {}) };
};

/** The answer body: pure, from loadD2dDay's records. */
export function d2dDaySummary({ date, settings, shifts = [], sales = [], assignments = [], jobs = [], reps = new Map(), days = new Map(), neighborhoods = new Map(), truncated = [], missing = [], now = new Date() }) {
  const nowMs = now.getTime(), idle = Number(settings?.shift?.idleAutoEndHours) || 4;
  const dayStart = zonedInstant(date), dayEnd = zonedInstant(addDays(date, 1));
  const areaName = id => text(neighborhoods.get(id)?.name, 100) || id;
  // One row per job id; a job found twice (booked today and made today) is one row.
  const byId = new Map();
  for (const job of jobs) if (job && JOB_ID.test(job.id || '') && !job.recordType && (d2dMarker(job) || job.source === 'door_to_door')) byId.set(job.id, jobRow(job, date, dayStart, dayEnd));
  const jobRows = [...byId.values()].sort((a, b) => `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`) || a.id.localeCompare(b.id));
  // A rep with a shift or a door sale that day, or a D2D job made that day (a walkthrough set with no shift that day).
  const repKeys = [...new Set([...shifts.map(row => row.repKey), ...sales.map(row => row.repKey), ...jobRows.filter(row => row.createdToday).map(row => row.repKey)].filter(key => KEY.test(key || '')))];
  const name = key => text(reps.get(key)?.displayName || reps.get(key)?.username, 80) || key;
  const rows = repKeys.map(repKey => {
    const own = shifts.filter(row => row.repKey === repKey).sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));
    const timings = own.map(shift => ({ shift, timing: shiftTiming(shift, nowMs, idle) })).filter(entry => entry.timing);
    const day = days.get(`${repKey}_${date}`) || null;
    const worked = new Set([...Object.keys(day?.byNeighborhood || {}), ...own.map(row => row.lastNeighborhoodId)].filter(id => KEY.test(id || '') && id !== 'unknown'));
    const areas = new Map();
    for (const row of assignments.filter(row => row.repKey === repKey)) if (KEY.test(row.neighborhoodId || '')) areas.set(row.neighborhoodId, { id: row.neighborhoodId, name: areaName(row.neighborhoodId), claim: row.source === 'self' ? 'self' : 'admin', worked: worked.has(row.neighborhoodId) });
    for (const id of worked) if (!areas.has(id)) areas.set(id, { id, name: areaName(id), claim: null, worked: true });
    const ownSales = sales.filter(row => row.repKey === repKey).sort((a, b) => String(a.soldAt).localeCompare(String(b.soldAt)));
    const ownJobs = jobRows.filter(row => row.repKey === repKey && row.createdToday);
    const saleJob = id => jobRows.find(row => row.saleId === id)?.id || null;
    return {
      repKey, name: name(repKey),
      onShift: timings.some(({ timing }) => !timing.ended), onBreak: timings.some(({ timing }) => timing.onBreak),
      shifts: timings.map(({ shift, timing }) => ({ startedAt: iso(shift.startedAt), endedAt: timing.ended ? new Date(timing.endAt).toISOString() : null, autoEnded: timing.autoEnded === true })),
      knockingMinutes: Math.round(timings.reduce((sum, { timing }) => sum + timing.knockingMs, 0) / 60000),
      areas: [...areas.values()].sort((a, b) => Number(b.worked) - Number(a.worked) || a.name.localeCompare(b.name)),
      doors: day ? count(day.doors) : own.reduce((sum, row) => sum + count(row.doors), 0), answers: count(day?.answers), looks: count(day?.looks),
      sales: ownSales.filter(row => !CANCELLED.has(row.status)).length,
      walkthroughsSet: ownJobs.filter(row => row.kind === 'walkthrough').length,
      saleList: ownSales.map(row => ({ id: row.id, status: text(row.status, 40) || 'booked', package: text(row.package, 60), jobDate: validDate(row.jobDate) ? row.jobDate : '',
        jobStartTime: /^\d{2}:\d{2}$/.test(row.jobStartTime || '') ? row.jobStartTime : '', jobId: saleJob(row.id) })),
      jobs: ownJobs.map(({ id, kind, type, date: jobDate, time, status }) => ({ id, kind, type, date: jobDate, time, status })),
    };
  }).sort((a, b) => Number(b.onShift) - Number(a.onShift) || a.name.localeCompare(b.name) || a.repKey.localeCompare(b.repKey));
  return {
    ok: true, authority: 'employee_hub', date, timeZone: 'America/Denver',
    reps: rows,
    totals: { reps: rows.length, onShift: rows.filter(row => row.onShift).length, doors: rows.reduce((sum, row) => sum + row.doors, 0), sales: rows.reduce((sum, row) => sum + row.sales, 0), walkthroughsSet: rows.reduce((sum, row) => sum + row.walkthroughsSet, 0) },
    jobs: jobRows.map(row => ({ ...row, repName: row.repKey ? name(row.repKey) : '' })),
    coverage: { complete: !truncated.length && !missing.length, truncated: [...truncated], missing: [...missing], asOf: now.toISOString() },
  };
}
