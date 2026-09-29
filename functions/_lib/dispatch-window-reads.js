import { validDate, addDays, denverToday } from './dispatch-time.js';
import { jobSegments, lockEntryOwner } from './dispatch-segments.js';
import { customerSearchTerms, customerMatchesSearch, customerPhoneDigits, SEARCH_KEYS_VERSION } from './customer-identity.js';

/** Windowed dispatch reads and indexed customer search (P1-DS-14).
 * EGC_DISPATCH_WINDOWED_READS, read into dispatchStorage().windowedReads:
 *   unset/other: 'full'     every dispatch read scans the complete jobs and
 *                           customers collections, exactly as before.
 *   'shadow':    'shadow'   answers still come from the complete scans; the
 *                           windowed, save and indexed reads also run and any
 *                           difference is logged (dispatch_window_shadow,
 *                           dispatch_save_query_shadow,
 *                           dispatch_customer_search_shadow: counts and masked
 *                           ids only). Run this first.
 *   'true':      'windowed' the board, job view, save conflict evidence,
 *                           openings and drive-time routes read only
 *                           jobsNear(); dispatch saves and open-shift claims
 *                           read only what each check needs (saveJobReads);
 *                           customer search uses searchKeys (array-contains)
 *                           while every customer carries current keys, else
 *                           it scans as before.
 * The walkthrough handoff lookup uses saveJobReads too. Other readers
 * (full-history search, recurring plans, crew time off, crew pages, money)
 * keep their complete scans in every mode, so each still fails closed past
 * its scan limit (10,000 jobs).
 * jobsNear(startDate,endDate) returns every jobs row a Denver window can depend
 * on: rows ending (endDate) or starting (legacy rows without a string endDate)
 * on or after startDate - WINDOW_MARGIN_DAYS, the undated backlog (date '' or
 * null) and every availability row whatever its dates. Queries have no upper
 * bound, so later work is always included. Each query is fully paginated and
 * fails closed like the complete scan. A job spans at most 31 days (32 calendar
 * days across a spring-forward change) and conflict evidence reaches one more
 * day for travel buffers and drive windows, so 35 days includes every row that
 * could overlap. Rows the queries cannot find (a malformed date string that
 * sorts before the floor, a non-string date or endDate, no date field at all)
 * are conservative evidence in the complete scan only. That is an accepted
 * residual risk of 'true': shadow mode reports such rows before the switch,
 * and scripts/dispatch-window-audit.mjs (read only) reports them afterwards,
 * including rows written later through the browser SDK or an import. */
export const WINDOW_MARGIN_DAYS = 35;
const PAGE = 500;
const fail = (code, message, status = 503) => Object.assign(new Error(message), { code, status });
const PRIVATE = /^(_egc_|secure_)/;
const OPERATIONAL = new Set(['job','walkthrough','cleanout','reorg','blocked']);
const unavailable = row => row?.type === 'availability' || ['availability','crew_availability'].includes(row?.recordType);

export function dispatchReadMode(env) {
  const value = String(env?.EGC_DISPATCH_WINDOWED_READS ?? '').trim().toLowerCase();
  return value === 'true' ? 'windowed' : value === 'shadow' ? 'shadow' : 'full';
}
export const windowFloor = startDate => addDays(startDate, -WINDOW_MARGIN_DAYS);
export const dayWindow = date => ({ startDate: date, endDate: addDays(date, 1) });

export function windowQueries(startDate) {
  const floor = windowFloor(startDate);
  return [
    { field: 'endDate', op: 'GREATER_THAN_OR_EQUAL', value: floor },
    { field: 'date', op: 'GREATER_THAN_OR_EQUAL', value: floor },
    { field: 'date', op: 'EQUAL', value: '' },
    { field: 'date', op: 'IS_NULL' },
    { field: 'type', op: 'EQUAL', value: 'availability' },
    { field: 'recordType', op: 'IN', value: ['availability','crew_availability'] },
  ];
}

// Range filters only match values of their own type, as on Firestore.
function matches(row, { field, op, value }) {
  const found = row[field];
  if (op === 'GREATER_THAN_OR_EQUAL') return typeof found === 'string' && found >= value;
  if (op === 'EQUAL') return found === value;
  if (op === 'IS_NULL') return found === null;
  if (op === 'IN') return value.includes(found);
  if (op === 'ARRAY_CONTAINS') return Array.isArray(found) && found.includes(value);
  return false;
}

export function structuredQuery(collection, spec, fields, after = null) {
  const field = { fieldPath: spec.field }, range = spec.op === 'GREATER_THAN_OR_EQUAL';
  const where = spec.op === 'IS_NULL' ? { unaryFilter: { op: 'IS_NULL', field } }
    : { fieldFilter: { field, op: spec.op, value: spec.op === 'IN' ? { arrayValue: { values: spec.value.map(stringValue => ({ stringValue })) } } : { stringValue: spec.value } } };
  return { from: [{ collectionId: collection }], select: { fields: fields.map(fieldPath => ({ fieldPath })) }, where,
    orderBy: [...(range ? [{ field, direction: 'ASCENDING' }] : []), { field: { fieldPath: '__name__' }, direction: 'ASCENDING' }], limit: PAGE,
    ...(after ? { startAt: { values: [...(range ? [{ stringValue: after.value }] : []), { referenceValue: after.name }], before: false } } : {}) };
}

/** Complete runQuery pagination (cursor after the last document). `post(body)`
 * returns the parsed JSON response and `decode(document)` verifies identity and
 * revision. A malformed page, a row outside the filter, a repeated row or more
 * than `limit` rows fails closed; a partial result is never returned. */
export async function pagedQuery({ post, decode, collection, spec, fields, limit = 10000 }) {
  const rows = [], ids = new Set();
  let after = null;
  for (let page = 0; page <= Math.ceil(limit / PAGE); page++) {
    const results = await post({ structuredQuery: structuredQuery(collection, spec, fields, after) });
    // runQuery always answers with at least a readTime; an empty array is not an empty result.
    if (!Array.isArray(results) || results.some(result => !result || typeof result !== 'object' || Array.isArray(result)) || !results.some(result => result.document !== undefined || typeof result.readTime === 'string' && result.readTime)) throw fail('dispatch_storage_incomplete', 'Dispatch received an incomplete schedule query. Retry before scheduling.');
    const documents = results.filter(result => result.document !== undefined).map(result => result.document);
    for (const document of documents) {
      const row = decode(document);
      if (ids.has(row.id) || rows.length >= limit || !matches(row, spec)) throw fail('dispatch_storage_incomplete', 'Dispatch could not verify the complete schedule query. Retry before scheduling.');
      ids.add(row.id); rows.push(row);
    }
    if (documents.length < PAGE) return rows;
    after = { name: documents.at(-1).name, value: rows.at(-1)[spec.field] };
  }
  throw fail('dispatch_storage_incomplete', 'Dispatch query pagination did not finish. Retry before scheduling.');
}

const byId = (a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
const newer = (left, right) => {
  const a = Date.parse(left), b = Date.parse(right);
  return Number.isFinite(a) && Number.isFinite(b) && a !== b ? a > b : String(left) > String(right);
};
/** Union of windowQueries() through `query(spec)`, one row per id (the newest
 * revision when a row changed between queries), in document-id order like the
 * complete scan. */
export async function windowedJobs(query, startDate, endDate) {
  if (!validDate(startDate) || !validDate(endDate) || endDate <= startDate) throw fail('dispatch_range_invalid', 'Choose a valid date range. The end date is exclusive.', 400);
  const found = new Map();
  for (const row of (await Promise.all(windowQueries(startDate).map(query))).flat()) {
    if (!found.has(row.id) || newer(row.revision, found.get(row.id).revision)) found.set(row.id, row);
  }
  return [...found.values()].sort(byId);
}

/** Whether a complete-scan row can affect dispatch for a window starting on
 * startDate; windowed reads must contain every such row. */
export function windowRelevant(row, startDate) {
  if (unavailable(row)) return true;
  if (!row || PRIVATE.test(String(row.id)) || row.recordType || !OPERATIONAL.has(row.type)) return false;
  return windowReason(row, startDate) !== null;
}
function windowReason(row, startDate) {
  if (unavailable(row)) return 'availability';
  if (!row.date) return 'undated';
  const end = row.endDate || row.date;
  if (!validDate(row.date) || !validDate(end) || end < row.date) return 'unverifiable_date';
  return end >= windowFloor(startDate) ? 'dated' : null;
}

// Legacy ids can embed a phone number or an email; logs keep only a hint.
const maskId = value => { const id = String(value ?? ''); return /\d{7,}/.test(id) ? id.replace(/\d(?=\d{4})/g, '*') : id.includes('@') ? '*@' + id.split('@').pop() : id.slice(0, 80); };
function log(store, entry) {
  try { const out = store.log || console; (entry.match ? out.info : out.warn).call(out, JSON.stringify(entry)); } catch { /* logging never changes a dispatch answer */ }
}

/** Shadow comparison of one windowed read with the complete scan. */
export function windowDiff(full, near, startDate) {
  const seen = new Map(near.map(row => [row.id, row])), fullIds = new Set(full.map(row => row.id)), missing = [], changed = [];
  for (const row of full) {
    if (!windowRelevant(row, startDate)) continue;
    const other = seen.get(row.id);
    if (!other) missing.push({ id: row.id, reason: windowReason(row, startDate) });
    else if (other.revision !== row.revision) changed.push(row.id);
  }
  return { missing, changed, extra: near.filter(row => !fullIds.has(row.id)).map(row => row.id) };
}

/** Jobs rows for dispatch in a Denver window [startDate,endDate). `range` may be
 * an async function, called only when a window is read. `scan` is a complete
 * scan already started (a promise), used instead of a new one outside windowed
 * mode. Stores without jobsNear (tests, bridges) always scan everything. */
export async function jobsForWindow(store, range, label = 'dispatch', scan = null) {
  const mode = typeof store.jobsNear === 'function' ? store.windowedReads : 'full';
  if (mode !== 'windowed' && mode !== 'shadow') return scan ?? store.jobs();
  const { startDate, endDate } = await (typeof range === 'function' ? range() : range);
  if (mode === 'windowed') return store.jobsNear(startDate, endDate);
  const [full, near] = await Promise.all([scan ?? store.jobs(), store.jobsNear(startDate, endDate).then(rows => ({ rows }), error => ({ error }))]);
  const entry = { event: 'dispatch_window_shadow', label, startDate, endDate, fullRows: full.length };
  if (near.error) log(store, { ...entry, match: false, error: String(near.error.code || 'dispatch_window_read_failed') });
  else {
    const diff = windowDiff(full, near.rows, startDate), reasons = {};
    for (const { reason } of diff.missing) reasons[reason] = (reasons[reason] || 0) + 1;
    // A row edited between the two reads is still found; only a missing row is a mismatch.
    log(store, { ...entry, windowRows: near.rows.length, match: !diff.missing.length, missing: diff.missing.length, missingByReason: reasons, changed: diff.changed.length, extra: diff.extra.length,
      sample: [...diff.missing.map(row => row.id), ...diff.changed].slice(0, 20).map(maskId) });
  }
  return full;
}

/** Pre-validation jobs reads for one dispatch save, after the dispatchState
 * read. `all` is the complete scan, started at once outside windowed mode
 * exactly as before (null when windowed). `where(field,value)` gives every job
 * whose field equals value whatever its dates (equality query: duplicate
 * visits and lineage by customerId, handoffs by sourceWalkthroughId) and
 * `near(range,label)` the window around a save that locks no day (undated
 * work, time off, a vehicle). Outside windowed mode both answer from `all`;
 * shadow also runs the query and logs any row it misses. Callers still filter
 * the rows themselves. */
export function saveJobReads(store) {
  const mode = typeof store.jobsNear === 'function' && typeof store.jobsWhere === 'function' ? store.windowedReads : 'full';
  const all = mode === 'windowed' ? null : store.jobs(), queried = new Map();
  async function compare(field, value) {
    const [rows, found] = await Promise.all([all, store.jobsWhere(field, value).then(rows => ({ rows }), error => ({ error }))]);
    const entry = { event: 'dispatch_save_query_shadow', field, fullRows: rows.length };
    if (found.error) log(store, { ...entry, match: false, error: String(found.error.code || 'dispatch_save_query_failed') });
    else {
      const got = new Set(found.rows.map(row => row.id)), expected = rows.filter(row => row[field] === value).map(row => row.id), missing = expected.filter(id => !got.has(id));
      log(store, { ...entry, queryRows: found.rows.length, match: !missing.length, missing: missing.length, extra: found.rows.filter(row => !expected.includes(row.id)).length, sample: missing.slice(0, 20).map(maskId) });
    }
    return rows;
  }
  return {
    all,
    where(field, value) {
      if (mode !== 'windowed' && mode !== 'shadow') return all;
      const key = `${field}\n${value}`;
      if (!queried.has(key)) queried.set(key, mode === 'windowed' ? store.jobsWhere(field, value) : compare(field, value));
      return queried.get(key);
    },
    near: (range, label = 'save') => jobsForWindow(store, range, label, all),
  };
}

/** The Denver window covering a job, its segments and a replacement version:
 * earliest date to the day after the latest end. Undated or malformed rows have
 * no conflict evidence to read, so they use today. */
export function rowsWindow(rows, now = new Date()) {
  const dates = rows.filter(Boolean).flatMap(row => [row, ...jobSegments(row)]).flatMap(row => [row.date, row.endDate || row.date]).filter(validDate).sort();
  if (!dates.length) { const today = denverToday(now); return { startDate: today, endDate: addDays(today, 1) }; }
  return { startDate: dates[0], endDate: addDays(dates.at(-1), 1) };
}

/** Ids of saved jobs owning day-lock entries. The complete scan knows every job;
 * a windowed read confirms owners outside the window with one batch read, so an
 * old lock entry for a job moved far away is treated exactly as before. */
export async function lockOwnerIds(store, rows, locks) {
  const known = new Set(rows.map(row => row.id));
  if (store.windowedReads !== 'windowed' || typeof store.readMany !== 'function') return known;
  const wanted = [...new Set(locks.flatMap(lock => lock?.entries || []).flatMap(entry => [entry?.id, lockEntryOwner(entry)]))]
    .filter(id => typeof id === 'string' && /^[A-Za-z0-9_-]{1,180}$/.test(id) && !known.has(id));
  for (const row of wanted.length ? await store.readMany('jobs', wanted, ['type']) : []) known.add(row.id);
  return known;
}

// Why the complete scan found a customer the index did not. 'address' (only the
// address matched) and 'partial' (the text starts inside a word or a phone
// number, or only its digits matched a phone) are the documented differences;
// 'other' is a behaviour change to review before switching the index on.
export function scanOnlyReason(row, text) {
  const needle = String(text ?? '').trim().toLowerCase(), digits = needle.replace(/\D/g, ''), phoneText = /^[+\d().\s-]+$/.test(needle);
  const starts = value => { for (let at = value.indexOf(needle); at >= 0; at = value.indexOf(needle, at + 1)) if (!at || !/[\p{L}\p{N}]/u.test(value[at - 1])) return true; return false; };
  const fields = [row?.name, row?.firstName, row?.lastName, row?.email, ...(phoneText ? [] : [row?.phone])].map(value => String(value || '').toLowerCase()).filter(value => value.includes(needle));
  if (fields.length) return fields.some(starts) ? 'other' : 'partial';
  const phone = String(row?.phone || '');
  if (!(digits.length >= 3 && phone.replace(/\D/g, '').includes(digits) || phoneText && phone.toLowerCase().includes(needle))) return 'address';
  if (!phoneText) return 'partial';
  const number = customerPhoneDigits(phone);
  return [digits, ...(digits[0] === '1' ? [digits.slice(1)] : [])].some(value => value.length >= 3 && number.startsWith(value)) || [4, 7].includes(digits.length) && number.endsWith(digits) ? 'other' : 'partial';
}

/** Customer search rows. `scanMatch` is the complete-scan filter used before
 * P1-DS-14 and whenever the index cannot answer: full mode, text the index
 * cannot use, or any customer without current searchKeys (fewer keyed
 * customers than customers). Indexed candidates are re-checked against keys
 * derived from their saved fields, so a stale key never matches. Shadow also
 * compares the index with the scan the dispatcher gets today: scanOnly counts
 * scan matches the index misses by scanOnlyReason, and any 'other' is a
 * mismatch. */
export async function searchCustomers(store, text, scanMatch) {
  const mode = typeof store.customersByKey === 'function' && typeof store.customerKeyCoverage === 'function' ? store.windowedReads : 'full';
  const terms = mode === 'windowed' || mode === 'shadow' ? customerSearchTerms(text) : null;
  if (!terms) return (await store.customers()).filter(scanMatch);
  const indexed = async () => {
    const coverage = await store.customerKeyCoverage();
    if (!coverage.complete) return { coverage };
    const found = new Map();
    for (const row of (await Promise.all(terms.query.map(key => store.customersByKey(key)))).flat()) found.set(row.id, row);
    return { coverage, rows: [...found.values()].sort(byId).filter(row => customerMatchesSearch(row, terms)) };
  };
  if (mode === 'windowed') {
    const found = await indexed().catch(error => ({ error }));
    if (found.rows) return found.rows;
    log(store, { event: 'dispatch_customer_index_unavailable', match: false, ...(found.error ? { error: String(found.error.code || 'dispatch_customer_index_failed') } : { total: found.coverage.total, keyed: found.coverage.keyed }) });
    return (await store.customers()).filter(scanMatch);
  }
  const [all, found] = await Promise.all([store.customers(), indexed().catch(error => ({ error }))]);
  const scan = all.filter(scanMatch), entry = { event: 'dispatch_customer_search_shadow', keys: terms.query.length };
  if (found.error) log(store, { ...entry, match: false, error: String(found.error.code || 'dispatch_customer_index_failed') });
  else if (!found.rows) log(store, { ...entry, match: false, indexComplete: false, total: found.coverage.total, keyed: found.coverage.keyed });
  else {
    const expected = all.filter(row => customerMatchesSearch(row, terms)).map(row => row.id), got = found.rows.map(row => row.id), gotIds = new Set(got), scanIds = new Set(scan.map(row => row.id));
    const missing = expected.filter(id => !gotIds.has(id)), extra = got.filter(id => !expected.includes(id)), scanOnly = scan.filter(row => !gotIds.has(row.id)), reasons = {}, changed = [];
    for (const row of scanOnly) {
      const reason = scanOnlyReason(row, text);
      reasons[reason] = (reasons[reason] || 0) + 1;
      if (reason === 'other') changed.push(row.id);
    }
    log(store, { ...entry, match: !missing.length && !extra.length && expected.join() === got.join() && !changed.length, expected: expected.length, indexed: got.length, missing: missing.length, extra: extra.length,
      scanned: scan.length, scanOnly: scanOnly.length, scanOnlyByReason: reasons, unexpected: changed.length, indexOnly: got.filter(id => !scanIds.has(id)).length,
      sample: [...missing, ...extra, ...changed].slice(0, 20).map(maskId) });
  }
  return scan;
}

/** runAggregationQuery body counting customers, or only those whose keys have
 * the current version. Two plain counts: Firestore drops documents missing any
 * field that another aggregation in the same query names. */
export const coverageQuery = version => ({ structuredAggregationQuery: { structuredQuery: { from: [{ collectionId: 'customers' }],
  ...(version === undefined ? {} : { where: { fieldFilter: { field: { fieldPath: 'searchKeysVersion' }, op: 'EQUAL', value: { integerValue: String(version) } } } }) }, aggregations: [{ alias: 'count', count: {} }] } });
/** The count and the snapshot it was read at (microseconds, the precision a
 * readTime request accepts). */
export function aggregateCount(results) {
  const found = Array.isArray(results) ? results.filter(result => result?.result) : [], value = found.length === 1 ? found[0].result.aggregateFields?.count?.integerValue : undefined;
  const readTime = found.length === 1 && typeof found[0].readTime === 'string' ? found[0].readTime.replace(/(\.\d{6})\d+Z$/, '$1Z') : '';
  if (!/^\d{1,15}$/.test(String(value ?? '')) || !/^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(readTime)) throw fail('dispatch_storage_incomplete', 'Customer search coverage could not be verified.');
  return { count: Number(value), readTime };
}
/** Both counts read one snapshot: the total is counted at the keyed count's
 * readTime, so no create or delete between the two requests can make coverage
 * look complete. */
export async function customerCoverage(count, version = SEARCH_KEYS_VERSION) {
  const keyed = await count(coverageQuery(version)), total = await count({ ...coverageQuery(), readTime: keyed.readTime });
  return { total: total.count, keyed: keyed.count, complete: keyed.count === total.count };
}
