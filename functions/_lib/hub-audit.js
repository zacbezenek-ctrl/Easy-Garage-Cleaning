import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { firestoreFetch } from './firebase-service-account.js';
import { decodeFirestoreFields } from './firestore-job.js';
import { hasBusinessAccess } from './hub-session.js';
import { localInstant } from './operations-portal-records.js';
import { validDate } from './dispatch-time.js';

// SEC-02: a server-only, append-only audit trail. auditWrite() returns one
// create-only write that callers add to the SAME commit as the business change,
// so an audit entry exists exactly when the change does.
export const HUB_AUDIT_COLLECTION = 'hub_audit';
const ROOT = 'projects/egcw-1ec83/databases/(default)/documents';
const BASE = `https://firestore.googleapis.com/v1/${ROOT}`;
const VIA = new Set(['hub', 'mcp', 'bridge', 'portal', 'b2b', 'cron']);
// 'owner' entries (payroll, pay rates, account approval, Gusto) keep their
// snapshots and reason from managers; they still see who changed which keys.
const VISIBILITY = new Set(['business', 'owner']);
const KINDS = new Set(['human', 'integration', 'customer', 'business', 'system']);
const ACTION = /^[a-z][a-z0-9_.:-]{0,79}$/, ACTOR = /^[a-z0-9][a-z0-9_.@:+-]{0,119}$/, ROLE = /^[a-z][a-z_]{0,39}$/;
const COLLECTION = /^[A-Za-z][A-Za-z0-9_]{0,63}$/, ENTITY_ID = /^[A-Za-z0-9_.:-]{1,180}$/, AUDIT_ID = /^[A-Za-z0-9_-]{1,180}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
// Twelve hex digits of inverted milliseconds make document-id order newest first,
// so every list and date filter needs only automatic single-field indexes.
const MAX_TIME = 0xffffffffffff;
const MIN_DATE = '2000-01-01';
const LIMIT = { text: 2000, array: 50, keys: 100, depth: 6, snapshot: 16000, reason: 500, changed: 50, page: 100 };
const SECRET_WORDS = ['password', 'passwd', 'passcode', 'passphrase', 'secret', 'token', 'credential', 'apikey', 'privatekey', 'authorization', 'cookie', 'bearer', 'sealedpayload', 'cardnumber', 'cardno', 'cardnum', 'cvc', 'cvv', 'cvn', 'securitycode', 'accountnumber', 'routingnumber', 'iban', 'bankaccount', 'signingkey', 'ssn', 'socialsecurity', 'taxid', 'signature', 'wallet', 'sessionid', 'sessionkey', 'encryptionkey', 'verificationcode', 'logincode', 'authcode', 'accesscode', 'resetcode', 'magiclink'];
const SECRET_TOKENS = new Set(['pin', 'pan', 'otp', 'hash', 'nonce', 'envelope', 'exp', 'pwd', 'jwt']);
// Text values under these final key words are credentials (portal `access`,
// business `invite`, `hubSession`); booleans such as businessAccess stay readable.
const SECRET_TEXT_TOKENS = new Set(['access', 'invite', 'session']);
const SECRET_PARAMS = /([?&#](?:access_token|refresh_token|id_token|client_secret|api_key|apikey|token|access|invite|magic|session|state|auth|jwt|password|passwd|pwd|secret|key|sig|signature|code|t)=)[^&#\s]+/gi;
// Portal access and session tokens, Hub sessions and action states are
// base64url JSON ("eyJ…") plus an HMAC; confirmation tokens add an ect1 prefix.
const SIGNED_TOKEN = /(?:ect1\.)?eyJ[A-Za-z0-9_-]{6,}(?:\.[A-Za-z0-9_-]{8,}){1,2}/g;
const BUSINESS_INVITE = /\b[a-f0-9]{32}\.[a-f0-9]{32}\.[a-f0-9]{64}\b/gi;
const fail = (code, message, status = 400) => Object.assign(new Error(message), { code, status });
const encoder = new TextEncoder();

const keyTokens = key => String(key).replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

function secretKey(key, value) {
  const tokens = keyTokens(key), joined = tokens.join('');
  return tokens.some(token => SECRET_TOKENS.has(token)) || SECRET_WORDS.some(word => joined.includes(word)) || typeof value === 'string' && SECRET_TEXT_TOKENS.has(tokens.at(-1));
}

function luhn(digits) {
  let sum = 0;
  for (let index = 0; index < digits.length; index += 1) {
    let digit = Number(digits[digits.length - 1 - index]);
    if (index % 2) { digit *= 2; if (digit > 9) digit -= 9; }
    sum += digit;
  }
  return sum % 10 === 0;
}

function safeText(value, state) {
  if (/^data:[^,]{0,120},/i.test(value)) { state.truncated = true; return '[data omitted]'; }
  if (/^bearer\s/i.test(value) || /^ey[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}$/.test(value)) return '[redacted]';
  let text = value.replace(/\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{6,}|\bwhsec_[A-Za-z0-9]{6,}|\bAIza[A-Za-z0-9_-]{30,}/g, '[redacted]')
    .replace(SECRET_PARAMS, '$1[redacted]').replace(SIGNED_TOKEN, '[redacted]').replace(BUSINESS_INVITE, '[redacted]')
    .replace(/\b(bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [redacted]')
    .replace(/\b\d(?:[ -]?\d){12,18}\b/g, match => { const digits = match.replace(/\D/g, ''); return digits.length >= 13 && digits.length <= 19 && luhn(digits) ? '[redacted-card]' : match; });
  if (text.length > LIMIT.text) { state.truncated = true; text = `${text.slice(0, LIMIT.text)}…[truncated]`; }
  return text;
}

function bounded(value, state, depth = 0) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return safeText(value, state);
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'object') return null;
  if (depth >= LIMIT.depth) { state.truncated = true; return '[depth limit]'; }
  if (Array.isArray(value)) {
    if (value.length > LIMIT.array) state.truncated = true;
    return value.slice(0, LIMIT.array).map(item => bounded(item, state, depth + 1));
  }
  const entries = Object.entries(value);
  if (entries.length > LIMIT.keys) state.truncated = true;
  return Object.fromEntries(entries.slice(0, LIMIT.keys).map(([key, item]) => [key.slice(0, 100), secretKey(key, item) ? '[redacted]' : bounded(item, state, depth + 1)]));
}

/** Redacts credential and payment-card data and bounds a snapshot for storage. */
export function auditSnapshot(value, state = { truncated: false }) {
  if (value === undefined || value === null) return null;
  let safe;
  try { safe = bounded(JSON.parse(JSON.stringify(value)), state); } catch { state.truncated = true; return { _unserializable: true }; }
  if (encoder.encode(JSON.stringify(safe)).byteLength <= LIMIT.snapshot) return safe;
  state.truncated = true;
  return safe && typeof safe === 'object' && !Array.isArray(safe) ? { _truncated: true, keys: Object.keys(safe).slice(0, LIMIT.changed) } : { _truncated: true };
}

const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : value && typeof value === 'object' ? `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}` : JSON.stringify(value);

// Key names come from the unredacted values so a changed secret is still listed
// by name; its value is never stored.
function changedKeys(before, after) {
  const plain = value => { try { const json = JSON.parse(JSON.stringify(value ?? null)); return json && typeof json === 'object' && !Array.isArray(json) ? json : {}; } catch { return {}; } };
  const left = plain(before), right = plain(after);
  return [...new Set([...Object.keys(left), ...Object.keys(right)])].filter(key => canonical(left[key] ?? null) !== canonical(right[key] ?? null)).map(key => key.slice(0, 100)).sort().slice(0, LIMIT.changed);
}

function instantMs(now) {
  const value = now instanceof Date ? now.toISOString() : now;
  const ms = typeof value === 'string' && ISO.test(value) ? Date.parse(value) : NaN;
  if (!Number.isFinite(ms) || ms < 0 || ms > MAX_TIME) throw fail('hub_audit_invalid', 'The audit entry needs a valid server time.', 503);
  return ms;
}

const prefix = ms => (MAX_TIME - ms).toString(16).padStart(12, '0');

function required(value, pattern, label) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!pattern.test(text)) throw fail('hub_audit_invalid', `The audit entry needs a valid ${label}. Nothing was saved.`, 503);
  return text;
}

/**
 * Builds the create-only audit write. The result carries both `patch`
 * (dispatchStorage/schedulingStorage) and `data` (businessStore) so it can join
 * any existing commit without an adapter. With a requestId the id is derived
 * from it, so re-sending the same prepared commit cannot add a second entry.
 * Owner-only records (payroll, pay rates, account approval, Gusto) must pass
 * visibility:'owner' so managers never read their snapshots or reason.
 */
export function auditWrite({ actor, via, action, entity, before = null, after = null, requestId = null, reason = null, visibility = 'business', now = new Date().toISOString() } = {}) {
  const ms = instantMs(now), at = new Date(ms).toISOString();
  const actorId = required(String(actor?.id ?? '').toLowerCase(), ACTOR, 'actor');
  const kind = required(actor?.kind, /^[a-z]+$/, 'actor kind');
  if (!KINDS.has(kind)) throw fail('hub_audit_invalid', 'The audit entry needs a valid actor kind. Nothing was saved.', 503);
  const role = actor?.role === undefined || actor?.role === null || actor?.role === '' ? null : required(String(actor.role).toLowerCase(), ROLE, 'actor role');
  if (!VIA.has(via)) throw fail('hub_audit_invalid', 'The audit entry needs a valid source. Nothing was saved.', 503);
  const name = required(action, ACTION, 'action');
  const collection = required(entity?.collection, COLLECTION, 'record type'), entityId = required(entity?.id, ENTITY_ID, 'record');
  if (requestId !== null && (typeof requestId !== 'string' || !UUID.test(requestId))) throw fail('hub_audit_invalid', 'The audit entry needs a valid request ID. Nothing was saved.', 503);
  if (reason !== null && typeof reason !== 'string') throw fail('hub_audit_invalid', 'The audit reason must be text. Nothing was saved.', 503);
  if (!VISIBILITY.has(visibility)) throw fail('hub_audit_invalid', 'The audit entry needs a valid visibility. Nothing was saved.', 503);
  const state = { truncated: false };
  const safeBefore = auditSnapshot(before, state), safeAfter = auditSnapshot(after, state);
  let note = reason === null ? null : safeText(reason.trim(), state);
  if (note && note.length > LIMIT.reason) { note = note.slice(0, LIMIT.reason); state.truncated = true; }
  const request = requestId && requestId.toLowerCase();
  const seed = request ? canonical({ request, actorId, via, action: name, entity: `${collection}/${entityId}` }) : null;
  const suffix = seed ? bytesToHex(sha256(encoder.encode(seed))).slice(0, 28) : bytesToHex(crypto.getRandomValues(new Uint8Array(14)));
  const doc = {
    v: 1, at, actor: { id: actorId, kind, role }, via, action: name,
    entity: { collection, id: entityId }, entityKey: `${collection}/${entityId}`,
    requestId: request || null, reason: note || null,
    before: safeBefore === null ? null : JSON.stringify(safeBefore),
    after: safeAfter === null ? null : JSON.stringify(safeAfter),
    changedKeys: changedKeys(before, after), truncated: state.truncated, visibility,
  };
  return { collection: HUB_AUDIT_COLLECTION, id: prefix(ms) + suffix, patch: doc, data: doc };
}

export function requireAuditReader(session) {
  if (!session) throw fail('hub_audit_sign_in_required', 'Sign in to the Employee Hub to review the audit log.', 401);
  if (!hasBusinessAccess(session) || !['owner', 'manager'].includes(session.role)) throw fail('hub_audit_forbidden', 'Only an operations manager or owner can review the audit log.', 403);
}

function parseSnapshot(value, flags) {
  if (value === null || value === undefined) return null;
  try { return auditSnapshot(JSON.parse(value)); } catch { flags.unreadable = true; return null; }
}

// The same owner test as Gusto: zacb, signed in with the owner role and business access.
const ownerReader = session => session?.role === 'owner' && hasBusinessAccess(session) && String(session.user || '').trim().toLowerCase() === 'zacb';

function projectEntry(row, owner) {
  const flags = { unreadable: false };
  const str = (value, pattern) => typeof value === 'string' && pattern.test(value) ? value : null;
  // Rows from before visibility existed are business rows; anything unexpected is owner-only.
  const restricted = row.visibility !== undefined && row.visibility !== null && row.visibility !== 'business', withheld = restricted && !owner;
  const entry = {
    id: row.id, at: str(row.at, ISO), via: VIA.has(row.via) ? row.via : null, action: str(row.action, ACTION),
    actor: { id: str(row.actor?.id, ACTOR), kind: KINDS.has(row.actor?.kind) ? row.actor.kind : null, role: str(row.actor?.role, ROLE) },
    entity: { collection: str(row.entity?.collection, COLLECTION), id: str(row.entity?.id, ENTITY_ID) },
    requestId: str(row.requestId, UUID), reason: !withheld && typeof row.reason === 'string' ? safeText(row.reason, flags).slice(0, LIMIT.reason) : null,
    before: withheld ? null : parseSnapshot(row.before, flags), after: withheld ? null : parseSnapshot(row.after, flags),
    changedKeys: Array.isArray(row.changedKeys) ? row.changedKeys.filter(key => typeof key === 'string').slice(0, LIMIT.changed) : [],
    truncated: row.truncated === true, visibility: restricted ? 'owner' : 'business',
  };
  if (withheld) entry.withheld = true;
  if (flags.unreadable) entry.unreadable = true;
  return entry;
}

/**
 * Pages newest-first. `store.auditPage({entityKey, actorId, fromId, beforeId,
 * after, limit})` must return rows ordered by id ascending; anything else fails
 * closed so a partial page is never presented as the whole trail. `reader` is
 * the verified session; only the owner sees owner-only snapshots.
 */
export async function listAudit(store, query = {}, reader = null) {
  const invalid = message => fail('hub_audit_query_invalid', message);
  const owner = ownerReader(reader);
  const limit = query.limit === undefined || query.limit === '' ? 50 : Number(query.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > LIMIT.page) throw invalid(`Choose between 1 and ${LIMIT.page} audit entries per page.`);
  let entityKey = null, actorId = null, fromId = null, beforeId = null, after = null;
  if (query.entity !== undefined && query.entity !== '') {
    const [collection, id, extra] = String(query.entity).split('/');
    if (extra !== undefined || !COLLECTION.test(collection || '') || !ENTITY_ID.test(id || '')) throw invalid('Filter by a record as collection/id.');
    entityKey = `${collection}/${id}`;
  }
  if (query.actor !== undefined && query.actor !== '') {
    actorId = String(query.actor).trim().toLowerCase();
    if (!ACTOR.test(actorId)) throw invalid('Filter by a valid staff or integration ID.');
  }
  // Denver midnight is never inside a DST transition, so localInstant is exact here.
  // Dates it cannot place (years below 100) or before 2000 would produce id
  // bounds no entry can match, so they are refused rather than shown as empty.
  const bound = date => {
    const instant = validDate(date) && date >= MIN_DATE ? localInstant(date, '00:00') : null, ms = instant ? Date.parse(instant) : NaN;
    if (!Number.isFinite(ms) || ms < 1 || ms > MAX_TIME) throw invalid(`Dates must be YYYY-MM-DD from ${MIN_DATE} on. The end date is exclusive.`);
    return prefix(ms - 1);
  };
  for (const key of ['startDate', 'endDate']) if (query[key] !== undefined && query[key] !== '') bound(query[key]);
  if (query.startDate && query.endDate && query.endDate <= query.startDate) throw invalid('The end date must be after the start date. The end date is exclusive.');
  if (query.startDate) beforeId = bound(query.startDate);
  if (query.endDate) fromId = bound(query.endDate);
  if (query.cursor !== undefined && query.cursor !== '') {
    if (!AUDIT_ID.test(String(query.cursor))) throw invalid('The audit page cursor is invalid. Reload the first page.');
    after = String(query.cursor);
  }
  const rows = await store.auditPage({ entityKey, actorId, fromId, beforeId, after, limit: limit + 1 });
  if (!Array.isArray(rows) || rows.length > limit + 1) throw fail('hub_audit_storage_incomplete', 'The audit log returned an incomplete page. Retry.', 503);
  let previous = after;
  for (const row of rows) {
    const id = row?.id;
    if (typeof id !== 'string' || !AUDIT_ID.test(id) || previous !== null && id <= previous || fromId && id < fromId || beforeId && id >= beforeId ||
        entityKey && row.entityKey !== entityKey || actorId && row.actor?.id !== actorId) throw fail('hub_audit_storage_incomplete', 'The audit log returned records outside the requested filter. Retry.', 503);
    previous = id;
  }
  const entries = rows.slice(0, limit).map(row => projectEntry(row, owner));
  return { entries, nextCursor: rows.length > limit ? entries[limit - 1].id : null, limit, filters: { entity: entityKey, actor: actorId, startDate: query.startDate || null, endDate: query.endDate || null } };
}

export function hubAuditStorage(env, fetcher = firestoreFetch) {
  const reference = id => ({ referenceValue: `${ROOT}/${HUB_AUDIT_COLLECTION}/${id}` });
  return {
    async auditPage({ entityKey, actorId, fromId, beforeId, after, limit }) {
      const filters = [];
      if (entityKey) filters.push({ fieldFilter: { field: { fieldPath: 'entityKey' }, op: 'EQUAL', value: { stringValue: entityKey } } });
      if (actorId) filters.push({ fieldFilter: { field: { fieldPath: 'actor.id' }, op: 'EQUAL', value: { stringValue: actorId } } });
      if (fromId) filters.push({ fieldFilter: { field: { fieldPath: '__name__' }, op: 'GREATER_THAN_OR_EQUAL', value: reference(fromId) } });
      if (beforeId) filters.push({ fieldFilter: { field: { fieldPath: '__name__' }, op: 'LESS_THAN', value: reference(beforeId) } });
      const structuredQuery = {
        from: [{ collectionId: HUB_AUDIT_COLLECTION }], orderBy: [{ field: { fieldPath: '__name__' }, direction: 'ASCENDING' }], limit,
        ...(filters.length === 1 ? { where: filters[0] } : filters.length ? { where: { compositeFilter: { op: 'AND', filters } } } : {}),
        ...(after ? { startAt: { values: [reference(after)], before: false } } : {}),
      };
      let response;
      try { response = await fetcher(env, `${BASE}:runQuery`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ structuredQuery }), signal: AbortSignal.timeout(15000) }); }
      catch { throw fail('hub_audit_unavailable', 'The audit log is unavailable. Retry.', 503); }
      if (!response.ok) throw fail('hub_audit_unavailable', 'The audit log could not be loaded. Retry.', 503);
      const results = await response.json().catch(() => null);
      if (!Array.isArray(results)) throw fail('hub_audit_storage_incomplete', 'The audit log returned an incomplete page. Retry.', 503);
      const name = `/documents/${HUB_AUDIT_COLLECTION}/`;
      return results.filter(result => result && result.document).map(({ document }) => {
        const path = typeof document.name === 'string' && document.name.includes(name) ? document.name.slice(document.name.indexOf(name) + name.length) : '';
        if (!AUDIT_ID.test(path) || typeof document.updateTime !== 'string' || document.fields !== undefined && (typeof document.fields !== 'object' || Array.isArray(document.fields))) throw fail('hub_audit_storage_incomplete', 'The audit log returned a record without a verifiable identity. Retry.', 503);
        return { ...decodeFirestoreFields(document.fields || {}), id: path, revision: document.updateTime };
      });
    },
  };
}
