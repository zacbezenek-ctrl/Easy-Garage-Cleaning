/* Fixed-window and rolling rate limits for public, unauthenticated endpoints.
   A counter lives at rate_limits/{hmac(bucket|key|window)} (a rolling limit
   uses the window name "rolling" and keeps its attempt times): the key (an IP
   address, a normalized phone/email or a customer id) is never stored, only
   its purpose-keyed digest.
   Increments are compare-and-set commits (exists:false or the observed
   updateTime) retried on conflict; contention or a malformed counter fails
   closed. A caller may give back one rolling attempt it learns did nothing
   (releaseRollingLimit); a release that cannot be confirmed leaves the count.
   Expired records are removed by a bounded cleanup. */
import { firestoreFetch } from './firebase-service-account.js';
import { PURPOSES, purposeSign } from './purpose-keys.js';

export const RATE_LIMITS = 'rate_limits';
const ROOT = 'projects/egcw-1ec83/databases/(default)/documents';
const BASE = `https://firestore.googleapis.com/v1/${ROOT}`;
const BUCKET = /^[a-z][a-z0-9_]{0,39}$/;
const MAX_WINDOW_MS = 7 * 86400000;
const ROLLING_MAX = 50;
// Server-only collections whose records carry an ISO `expiresAt` and may be deleted once it passes.
const EXPIRING = new Set([RATE_LIMITS, 'customer_login_links', 'customer_sessions']);
const fail = (code, message, status = 503) => Object.assign(new Error(message), { code, status });
// Firestore reports a stale precondition as 409/412 or 400 FAILED_PRECONDITION;
// the dispatch adapter maps a lost commit response to outcome_unknown. A retry
// re-reads the counter, so a lost increment can only over-count (fail closed).
const retryable = error => ['dispatch_revision_conflict', 'dispatch_outcome_unknown', 'rate_limit_conflict'].includes(error?.code) || [400, 409, 412].includes(error?.status);
// A rolling record that can be read as a list of attempt times for this bucket.
const rollingRecord = (row, bucket) => Array.isArray(row?.hits) && row.hits.length <= ROLLING_MAX && row.bucket === bucket && Boolean(row.revision) && row.hits.every(hit => typeof hit === 'string' && Number.isFinite(Date.parse(hit)));

// Eight 16-bit groups of an IPv6 address (with :: and a trailing dotted IPv4), or null.
function ipv6Groups(text) {
  if (!/^[0-9a-f:.]{2,45}$/.test(text) || !text.includes(':')) return null;
  let head = text, tail = [];
  const v4 = /^(.*:)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (v4) {
    const bytes = v4.slice(2).map(Number);
    if (bytes.some(byte => byte > 255)) return null;
    head = `${v4[1]}0:0`; tail = [(bytes[0] << 8) | bytes[1], (bytes[2] << 8) | bytes[3]];
  }
  const halves = head.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [], right = halves[1] ? halves[1].split(':') : [], missing = 8 - left.length - right.length;
  if ([...left, ...right].some(group => !/^[0-9a-f]{1,4}$/.test(group)) || (halves.length === 2 ? missing < 1 : missing !== 0)) return null;
  const groups = [...left, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...right].map(group => parseInt(group, 16));
  if (tail.length) groups.splice(6, 2, ...tail);
  return groups;
}

/** The rate-limit key for a client address: an IPv4 address as is, an IPv6
 * address as its /64 (one client can rotate through the rest of it), an
 * IPv4-mapped IPv6 address as its IPv4 address, anything else one shared key. */
export function clientAddressKey(ip) {
  const text = typeof ip === 'string' ? ip.trim().toLowerCase().replace(/%.*$/, '') : '';
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (v4) return v4.slice(1).every(part => Number(part) <= 255) ? `ip:${v4.slice(1).map(Number).join('.')}` : 'ip:unknown';
  const groups = ipv6Groups(text);
  if (!groups) return 'ip:unknown';
  if (groups.slice(0, 5).every(group => group === 0) && groups[5] === 0xffff) return `ip:${groups[6] >> 8}.${groups[6] & 255}.${groups[7] >> 8}.${groups[7] & 255}`;
  return `ip:${groups.slice(0, 4).map(group => group.toString(16)).join(':')}::/64`;
}

export async function rateLimitId(env, bucket, key, windowStart) {
  return `rl_${await purposeSign(env, PURPOSES.rateLimit, `${bucket}|${key}|${windowStart}`)}`;
}

function rule({ bucket, key, limit, windowMs }) {
  if (typeof bucket !== 'string' || !BUCKET.test(bucket)) throw fail('rate_limit_invalid', 'A rate limit needs a valid bucket name.', 500);
  if (typeof key !== 'string' || !key || key.length > 512) throw fail('rate_limit_invalid', 'A rate limit needs a key.', 500);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100000) throw fail('rate_limit_invalid', 'A rate limit needs a positive limit.', 500);
  if (!Number.isSafeInteger(windowMs) || windowMs < 1000 || windowMs > MAX_WINDOW_MS) throw fail('rate_limit_invalid', 'A rate limit window must be between one second and seven days.', 500);
}

/** Counts one attempt against a fixed window. Returns {allowed, count, limit,
 * remaining, windowStart, resetAt}; a denied attempt writes nothing. */
export async function consumeRateLimit(store, env, options, now = new Date().toISOString(), { attempts = 4 } = {}) {
  rule(options);
  const { bucket, key, limit, windowMs } = options, ms = Date.parse(now);
  if (!Number.isFinite(ms)) throw fail('rate_limit_invalid', 'A rate limit needs a valid clock.', 500);
  const start = Math.floor(ms / windowMs) * windowMs, windowStart = new Date(start).toISOString(), resetAt = new Date(start + windowMs).toISOString();
  const id = await rateLimitId(env, bucket, key, start), result = (allowed, count, extra = {}) => ({ allowed, count, limit, remaining: Math.max(0, limit - count), windowStart, resetAt, ...extra });
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const row = await store.read(RATE_LIMITS, id);
    const count = row ? row.count : 0;
    // A counter that cannot be read as a count never grants more attempts.
    if (row && (!Number.isSafeInteger(count) || count < 0 || row.bucket !== bucket || !row.revision)) return result(false, limit, { reason: 'counter_invalid' });
    if (count >= limit) return result(false, count);
    const patch = row ? { count: count + 1, updatedAt: now } : { bucket, count: 1, windowStart, expiresAt: resetAt, createdAt: now, updatedAt: now };
    try {
      await store.commit([{ collection: RATE_LIMITS, id, ...(row ? { revision: row.revision } : {}), patch }]);
      return result(true, count + 1);
    } catch (error) { if (!retryable(error)) throw error; }
  }
  return result(false, limit, { reason: 'contended' });
}

/** Counts one attempt against a rolling window: the record keeps the times of
 * the attempts still inside the window (at most `limit` of them), so no burst
 * that straddles a fixed-window edge ever gets more than `limit` in any
 * `windowMs`. Same compare-and-set and fail-closed rules as consumeRateLimit;
 * a time in the future still counts. A denied attempt writes nothing. */
export async function consumeRollingLimit(store, env, options, now = new Date().toISOString(), { attempts = 4 } = {}) {
  rule(options);
  const { bucket, key, limit, windowMs } = options, ms = Date.parse(now);
  if (limit > ROLLING_MAX) throw fail('rate_limit_invalid', `A rolling limit keeps at most ${ROLLING_MAX} attempts.`, 500);
  if (!Number.isFinite(ms)) throw fail('rate_limit_invalid', 'A rate limit needs a valid clock.', 500);
  const id = await rateLimitId(env, bucket, key, 'rolling'), windowStart = new Date(ms - windowMs).toISOString();
  const result = (allowed, hits, extra = {}) => ({ allowed, count: hits.length, limit, remaining: Math.max(0, limit - hits.length), windowStart, resetAt: hits.length ? new Date(Date.parse(hits[0]) + windowMs).toISOString() : new Date(ms + windowMs).toISOString(), ...extra });
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const row = await store.read(RATE_LIMITS, id);
    // A record that cannot be read as a list of attempt times never grants more attempts.
    if (row && !rollingRecord(row, bucket)) return result(false, Array(limit).fill(now), { reason: 'counter_invalid' });
    const live = (row ? row.hits : []).filter(hit => Date.parse(hit) > ms - windowMs).sort((a, b) => Date.parse(a) - Date.parse(b));
    if (live.length >= limit) return result(false, live.slice(-limit));
    const hits = [...live, new Date(ms).toISOString()].sort((a, b) => Date.parse(a) - Date.parse(b));
    const expiresAt = new Date(Date.parse(hits.at(-1)) + windowMs).toISOString();
    const patch = row ? { hits, updatedAt: now, expiresAt } : { bucket, hits, windowMs, createdAt: now, updatedAt: now, expiresAt };
    try {
      await store.commit([{ collection: RATE_LIMITS, id, ...(row ? { revision: row.revision } : {}), patch }]);
      return result(true, hits);
    } catch (error) { if (!retryable(error)) throw error; }
  }
  return result(false, Array(limit).fill(now), { reason: 'contended' });
}

/** Gives back the one attempt that consumeRollingLimit counted at `at` (the
 * same instant it was given), for a caller that learned the attempt did not
 * do what the limit guards. Removes a single matching time with the same
 * compare-and-set, retried only on a definite conflict: a lost commit response
 * is not retried, since a retry could remove a second, identical time. A
 * missing or unreadable record, a time no longer there, an outage or
 * contention leaves the count as it is (fail closed). Returns true when an
 * attempt was given back; storage problems never throw. */
export async function releaseRollingLimit(store, env, options, at, now = at, { attempts = 4 } = {}) {
  rule(options);
  const { bucket, key } = options, ms = Date.parse(at);
  if (!Number.isFinite(ms)) return false;
  const hit = new Date(ms).toISOString();
  try {
    const id = await rateLimitId(env, bucket, key, 'rolling');
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const row = await store.read(RATE_LIMITS, id);
      if (!row || !rollingRecord(row, bucket)) return false;
      const index = row.hits.indexOf(hit);
      if (index < 0) return false;
      try {
        await store.commit([{ collection: RATE_LIMITS, id, revision: row.revision, patch: { hits: row.hits.filter((_, position) => position !== index), updatedAt: now } }]);
        return true;
      } catch (error) { if (error?.code === 'dispatch_outcome_unknown' || !retryable(error)) return false; }
    }
  } catch { return false; }
  return false;
}

/** Deletes at most `limit` records whose expiresAt passed more than `graceMs`
 * ago, each conditioned on the revision that was read. Best effort: returns
 * the number deleted and never throws. */
export async function cleanupExpiredRecords(env, collection, now = new Date().toISOString(), { fetcher = firestoreFetch, limit = 50, graceMs = 3600000 } = {}) {
  if (!EXPIRING.has(collection)) return 0;
  const before = new Date(Date.parse(now) - graceMs);
  if (!Number.isFinite(before.getTime())) return 0;
  try {
    const found = await fetcher(env, `${BASE}:runQuery`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(10000), body: JSON.stringify({ structuredQuery: {
      from: [{ collectionId: collection }], select: { fields: [{ fieldPath: 'expiresAt' }] },
      where: { fieldFilter: { field: { fieldPath: 'expiresAt' }, op: 'LESS_THAN', value: { stringValue: before.toISOString() } } },
      limit: Math.max(1, Math.min(100, limit)),
    } }) });
    if (!found.ok) return 0;
    const rows = await found.json();
    if (!Array.isArray(rows)) return 0;
    const docs = rows.map(row => row?.document).filter(doc => doc && typeof doc.name === 'string' && doc.name.startsWith(`${ROOT}/${collection}/`) && !doc.name.slice(ROOT.length + collection.length + 2).includes('/') && typeof doc.updateTime === 'string' && doc.updateTime);
    if (!docs.length) return 0;
    const deleted = await fetcher(env, `${BASE}:commit`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(10000), body: JSON.stringify({ writes: docs.map(doc => ({ delete: doc.name, currentDocument: { updateTime: doc.updateTime } })) }) });
    return deleted.ok ? docs.length : 0;
  } catch { return 0; }
}
