import { HUB_FUNNEL_CASE_CURSOR_PATTERN, HUB_FUNNEL_FEED_CURSOR_PATTERN, HUB_FUNNEL_MAX_TYPES, HUB_FUNNEL_PAGE_LIMIT } from '../../egc-platform/services/operations/src/hub-command-policy.ts';
import { firestoreFetch } from './firebase-service-account.js';
import { decodeFirestoreFields } from './firestore-job.js';
import { cutoverCoverageReasons, definitionsHash, funnelDefinitions, funnelHubId, funnelReasonCodes, sha256Hex } from './funnel-definitions.js';
import { denverDate, instantMs } from './funnel-calendar.js';
import { FUNNEL_EVENTS_COLLECTION } from './funnel-events.js';
import { WALKTHROUGH_VISIT_OPERATIONS } from './walkthrough-visit.js';

// FUN-37: the bridge funnel event feed (§4.3). Three read-only hub.* registry
// commands over the server-only funnelEvents ledger, for owners, managers and
// their delegated platform workers (FUN-09 reconciler, FUN-14 cycles, FUN-31 CAPI):
//  - hub.funnel.events {sinceCursor, types[], limit}: a keyset page ordered by
//    (recordedAt, id), never an offset. Only events recorded at least
//    FUNNEL_FEED_SETTLE_MS before now are served, so an event whose commit landed
//    after a later-stamped one is still delivered before the cursor passes it.
//    Writers therefore stamp recordedAt at most that long before their commit.
//  - hub.walkthrough.outcomes {sinceCursor, limit}: the same feed over the events
//    that record a walkthrough outcome, joined to the visit's walkthroughOutcome
//    (current or archived occurrence) for the reason, start and occurrence.
//  - hub.funnel.case {projectId|jobId|highlevelContactId, cursor, limit}: the
//    case's events by (occurredAt, id), every page (its records and its events)
//    read at the first page's Firestore readTime. A jobId resolves to its
//    project; a project case also reads its source walkthrough's and source
//    job's events, which can predate their project link.
// The consumer keeps a cursor, never a copy it treats as the source. Every
// projection is an allowlist and drops any cost, pay, fee or margin field.

// Writers stamp recordedAt at most this long before their commit lands (FUNNEL-METRICS.md,
// FUN-37). It also delays every delivery by as much: an outcome reaches FUN-09 about 5
// minutes after its Finish. Kept at 5 because the recurring horizon loop stamps several
// sequential commits with one clock.
export const FUNNEL_FEED_SETTLE_MS = 5 * 60000;
export const FUNNEL_FEED_DEFAULT_LIMIT = 100;
// Firestore reads at a pinned readTime only within the last hour.
export const FUNNEL_CASE_CURSOR_MAX_AGE_MS = 50 * 60000;
export const WALKTHROUGH_OUTCOME_EVENT_TYPES = Object.freeze(['deal.sold', 'walkthrough.completed', 'walkthrough.no_show']);
const ROOT = 'projects/egcw-1ec83/databases/(default)/documents';
const BASE = `https://firestore.googleapis.com/v1/${ROOT}`;
const ISO_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, READ_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
const PROVIDER_ID = /^[A-Za-z0-9_-]{1,120}$/, ACTOR = /^[a-z0-9][a-z0-9_.@:+-]{0,119}$/, SLUG = /^[a-z][a-z0-9_]{0,63}$/, SOURCE_ID = /^[A-Za-z0-9_.:-]{1,180}$/, COLLECTION = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const CASE_KEYS = ['projectId', 'jobId', 'highlevelContactId'];
const REBOOKABLE = new Set(['customer_no_show', 'rescheduled']);
const VISIT_FIELDS = ['type', 'recordType', 'walkthroughOutcome', 'walkthroughVisit', 'walkthroughOccurrences'];
const JOB_FIELDS = ['type', 'recordType', 'projectId'];
const PROJECT_FIELDS = ['customerId', 'highlevelContactId', 'sourceWalkthroughId', 'sourceRecordId', 'previousProjectId', 'createdAt'];
// Words that mark a cost, pay, fee or margin figure; a data field named with any of them never leaves the Hub.
const PRIVATE_WORDS = new Set(['cost', 'costs', 'fee', 'fees', 'margin', 'margins', 'pay', 'payroll', 'wage', 'wages', 'salary', 'rate', 'rates', 'hourly', 'labor', 'labour', 'burden', 'contribution', 'profit', 'commission', 'tip', 'tips', 'overtime', 'bonus']);
const fail = (code, status = 400) => Object.assign(new Error(code), { code, status });
const invalid = () => fail('hub_command_invalid');
const incomplete = details => Object.assign(fail('hub_funnel_storage_incomplete', 503), details ? { details } : {});
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isoExact = value => typeof value === 'string' && ISO_MS.test(value) && Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)).toISOString() === value;
const hubId = value => funnelHubId(value) ? value : null;
const providerId = value => typeof value === 'string' && PROVIDER_ID.test(value) ? value : null;
const text = (value, pattern) => typeof value === 'string' && pattern.test(value) ? value : null;
const eventIdPattern = () => { const rules = funnelDefinitions().eventIntegrity.eventId; return new RegExp(`^${rules.prefix}[0-9a-f]{${rules.hexLength}}$`); };
function only(input, keys) { if (!plain(input) || Object.keys(input).some(key => !keys.includes(key))) throw invalid(); return input; }
function nowMs(now) { const ms = now instanceof Date ? now.getTime() : Date.parse(now); if (!Number.isFinite(ms)) throw fail('hub_funnel_clock_invalid', 503); return ms; }
function pageLimit(value) {
  if (value === undefined) return FUNNEL_FEED_DEFAULT_LIMIT;
  if (!Number.isInteger(value) || value < 1 || value > HUB_FUNNEL_PAGE_LIMIT) throw invalid();
  return value;
}

/** True when a data field name carries a cost, pay, fee or margin figure (camelCase words). */
export function privateFieldName(name) {
  return typeof name !== 'string' || name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).some(word => PRIVATE_WORDS.has(word));
}
/** The event data fields the feed may carry: the defined ones, minus any private figure. */
export const feedDataFields = () => Object.keys(funnelDefinitions().dataFields).filter(name => !privateFieldName(name));

export const feedCursor = row => `f1~${row.recordedAt}~${row.id}`;
function readFeedCursor(value) {
  if (value === undefined || value === null) return null;
  const match = typeof value === 'string' ? HUB_FUNNEL_FEED_CURSOR_PATTERN.exec(value) : null;
  if (!match || !isoExact(match[1]) || !eventIdPattern().test(match[2])) throw fail('hub_funnel_cursor_invalid');
  return value;
}
/* A case cursor: the pinned readTime, the case query and the (occurredAt, id) position, then
 * a digest of all of them with the key. The digest only catches a cursor edited or pasted to
 * another key; what binds a cursor to its case is that every page derives the query from the
 * key again at the cursor's readTime, so a cursor naming another case is refused. */
const caseDigest = (key, body) => sha256Hex(`funnel-case|${key.field}=${key.value}|${body}`).slice(0, 16);
function caseCursor(key, readTime, query, last) { const body = `c1~${readTime}~${query.field}~${query.value}~${last.occurredAt}~${last.id}`; return `${body}~${caseDigest(key, body)}`; }
function readCaseCursor(value) {
  if (value === undefined || value === null) return null;
  const match = typeof value === 'string' ? HUB_FUNNEL_CASE_CURSOR_PATTERN.exec(value) : null;
  if (!match || !Number.isFinite(Date.parse(match[1])) || !isoExact(match[4]) || !eventIdPattern().test(match[5]) || !(match[2] === 'highlevelContactId' ? providerId(match[3]) : hubId(match[3]))) throw fail('hub_funnel_cursor_invalid');
  return value;
}
const parseCaseCursor = value => { const [, readTime, field, queryValue, at, id, digest] = HUB_FUNNEL_CASE_CURSOR_PATTERN.exec(value); return { readTime, query: { field, value: queryValue }, after: { at, id }, digest, body: value.slice(0, value.lastIndexOf('~')) }; };

/** hub.funnel.events input: {sinceCursor?, types?, limit?}. */
export function funnelEventsInput(input) {
  only(input, ['sinceCursor', 'types', 'limit']);
  let types = null;
  if (input.types !== undefined) {
    const defined = funnelDefinitions().eventTypes;
    if (!Array.isArray(input.types) || !input.types.length || input.types.length > HUB_FUNNEL_MAX_TYPES || new Set(input.types).size !== input.types.length || input.types.some(type => typeof type !== 'string' || !Object.hasOwn(defined, type))) throw invalid();
    types = [...input.types].sort();
  }
  return { sinceCursor: readFeedCursor(input.sinceCursor), types, limit: pageLimit(input.limit) };
}
/** hub.walkthrough.outcomes input: {sinceCursor?, limit?}. */
export function walkthroughOutcomesInput(input) {
  only(input, ['sinceCursor', 'limit']);
  return { sinceCursor: readFeedCursor(input.sinceCursor), limit: pageLimit(input.limit) };
}
/** hub.funnel.case input: exactly one of {projectId, jobId, highlevelContactId}, plus cursor? and limit?. */
export function funnelCaseInput(input) {
  only(input, [...CASE_KEYS, 'cursor', 'limit']);
  const keys = CASE_KEYS.filter(key => input[key] !== undefined);
  if (keys.length !== 1) throw invalid();
  const [field] = keys, value = input[field];
  if (!(field === 'highlevelContactId' ? providerId(value) : hubId(value))) throw invalid();
  return { [field]: value, cursor: readCaseCursor(input.cursor), limit: pageLimit(input.limit) };
}

// The source record's id, unless it is a private record (an _egc_ receipt, a secure_ record) or
// carries the event's idempotency key (a request receipt is stored under its requestId).
function sourceView(source, idempotencyKey) {
  if (!plain(source)) return null;
  const id = text(source.id, SOURCE_ID), key = typeof idempotencyKey === 'string' && idempotencyKey.includes(':') ? idempotencyKey.slice(idempotencyKey.indexOf(':') + 1).toLowerCase() : '';
  const shown = id && key && !funnelDefinitions().eligibility.hub.privateIdPrefixes.some(prefix => id.startsWith(prefix)) && !id.toLowerCase().includes(key);
  return { collection: text(source.collection, COLLECTION), id: shown ? id : null };
}

/** One funnelEvents row as the bridge may show it: identity, timing, entities, actor, allowlisted data and eligibility. */
export function projectFunnelEvent(row, dataFields = feedDataFields()) {
  const entities = funnelDefinitions().entityFields, data = plain(row.data) ? row.data : {};
  return {
    id: row.id, type: row.type, group: text(row.group, SLUG), schemaVersion: Number.isInteger(row.schemaVersion) ? row.schemaVersion : null,
    definitionsVersion: typeof row.definitionsVersion === 'string' ? row.definitionsVersion : null, definitionsHash: text(row.definitionsHash, /^[0-9a-f]{64}$/),
    occurredAt: row.occurredAt, recordedAt: row.recordedAt, denverDate: text(row.denverDate, /^\d{4}-\d{2}-\d{2}$/), clockSource: text(row.clockSource, SLUG),
    clockReasons: Array.isArray(row.clockReasons) ? row.clockReasons.filter(reason => typeof reason === 'string' && SLUG.test(reason)) : [], deviceAt: isoExact(row.deviceAt) ? row.deviceAt : null,
    entityKey: typeof row.entityKey === 'string' && row.entityKey.length <= 220 ? row.entityKey : null,
    ...Object.fromEntries(Object.keys(entities).map(field => [field, entities[field] === 'hub' ? hubId(row[field]) : providerId(row[field])])),
    actor: plain(row.actor) ? { id: text(row.actor.id, ACTOR), kind: text(row.actor.kind, SLUG), role: text(row.actor.role, SLUG) } : null, via: text(row.via, SLUG),
    data: Object.fromEntries(Object.keys(data).filter(name => dataFields.includes(name) && ['string', 'number', 'boolean'].includes(typeof data[name])).sort().map(name => [name, data[name]])),
    source: sourceView(row.source, row.idempotencyKey),
    eligible: !row.exclusion, exclusion: text(row.exclusion, SLUG), isTest: row.isTest === true, isInternal: row.isInternal === true, internalReason: text(row.internalReason, SLUG),
  };
}

/* A ledger row the feed cannot verify stops it (fail closed), and the cursor cannot pass it
 * until an owner repairs or quarantines the row (FUNNEL-METRICS.md, FUN-37). The Hub log and
 * the error details name it; event ids are fe_ + hex and carry nothing private. */
function unverifiable(row, why) {
  const eventId = eventIdPattern().test(row?.id || '') ? row.id : null;
  console.warn(`hub_funnel_storage_incomplete: funnelEvents row ${eventId || JSON.stringify(String(row?.id ?? '').slice(0, 180))} ${why}; the feed stops before it until the row is repaired or quarantined.`);
  return incomplete({ eventId });
}

/* One page of the ledger from the store, verified: ordered strictly after the cursor,
 * inside the filter and horizon, never more than asked. limit+1 rows tell hasMore. */
async function eventsPage(store, query) {
  const result = await store.funnelEventsPage({ ...query, limit: query.limit + 1 });
  if (!plain(result) || !Array.isArray(result.rows) || result.rows.length > query.limit + 1 || typeof result.readTime !== 'string' || !READ_TIME.test(result.readTime) || query.readTime && result.readTime !== query.readTime) throw incomplete();
  const ids = eventIdPattern(), types = funnelDefinitions().eventTypes;
  let previous = query.after;
  for (const row of result.rows) {
    const at = row?.[query.order], id = row?.id;
    if (!ids.test(id || '') || !isoExact(at) || !isoExact(row.occurredAt) || !isoExact(row.recordedAt) || typeof row.type !== 'string') throw unverifiable(row, 'is malformed');
    if (!Object.hasOwn(types, row.type)) throw unverifiable(row, `has the type ${JSON.stringify(row.type.slice(0, 80))}, which these funnel definitions do not define`);
    if (previous && (at < previous.at || at === previous.at && id <= previous.id) || query.through && at > query.through ||
        query.types && !query.types.includes(row.type) || query.anyOf && !query.anyOf.some(match => row[match.field] === match.value)) throw unverifiable(row, 'came back out of order or outside the query');
    previous = { at, id };
  }
  return { rows: result.rows.slice(0, query.limit), hasMore: result.rows.length > query.limit, readTime: result.readTime };
}

// Masked record reads at one Firestore readTime (the current one when none is pinned),
// verified: only the asked ids, each once, at the asked time.
async function recordsAt(store, collection, ids, fields, readTime) {
  const result = await store.funnelRecords(collection, ids, fields, readTime);
  if (!plain(result) || !Array.isArray(result.rows) || typeof result.readTime !== 'string' || !READ_TIME.test(result.readTime) || readTime && result.readTime !== readTime ||
      result.rows.some(row => !plain(row) || !ids.includes(row.id)) || new Set(result.rows.map(row => row.id)).size !== result.rows.length) throw incomplete();
  return result;
}

async function feedPage(store, { sinceCursor, types, limit }, now) {
  const through = new Date(nowMs(now) - FUNNEL_FEED_SETTLE_MS).toISOString(), match = sinceCursor ? HUB_FUNNEL_FEED_CURSOR_PATTERN.exec(sinceCursor) : null;
  const page = await eventsPage(store, { order: 'recordedAt', types, anyOf: null, through, after: match ? { at: match[1], id: match[2] } : null, limit, readTime: null });
  return { ...page, through, next: page.rows.length ? feedCursor(page.rows.at(-1)) : sinceCursor };
}

/**
 * hub.funnel.events: the settled events after sinceCursor (all types, or types[]),
 * oldest recordedAt first. nextCursor is the last event delivered (the given cursor
 * when none were); hasMore asks for the next page now. Settled means recorded at or
 * before settledThrough = now - FUNNEL_FEED_SETTLE_MS.
 */
export async function funnelEventsFeed(store, input, now) {
  const page = await feedPage(store, input, now), dataFields = feedDataFields();
  return { events: page.rows.map(row => ({ ...projectFunnelEvent(row, dataFields), cursor: feedCursor(row) })), nextCursor: page.next, hasMore: page.hasMore,
    settledThrough: page.through, asOf: page.readTime, definitionsHash: definitionsHash(), coverage: { complete: !page.hasMore, asOf: page.readTime, through: page.through } };
}

// A visit's outcomes with the start of the same occurrence: archived ones first, then the current one.
function outcomeRecords(visit) {
  const records = [], number = value => Number.isInteger(value?.occurrence?.number) ? value.occurrence.number : null;
  for (const entry of Array.isArray(visit.walkthroughOccurrences) ? visit.walkthroughOccurrences : []) if (plain(entry?.walkthroughOutcome)) records.push({ outcome: entry.walkthroughOutcome, start: plain(entry.walkthroughVisit) ? entry.walkthroughVisit : null });
  if (plain(visit.walkthroughOutcome)) records.push({ outcome: visit.walkthroughOutcome, start: plain(visit.walkthroughVisit) ? visit.walkthroughVisit : null });
  return records.map(record => ({ ...record, start: record.start && isoExact(record.start.startedAt) && (number(record.start) === null || number(record.outcome) === null || number(record.start) === number(record.outcome)) ? record.start : null }));
}
const occurrenceView = value => plain(value) && Number.isInteger(value.number) ? { number: value.number, date: text(value.date, /^\d{4}-\d{2}-\d{2}$/), time: text(value.time, /^\d{2}:\d{2}$/), startAt: isoExact(value.startAt) ? value.startAt : null } : null;

const handoffSale = row => row.type === 'deal.sold' && plain(row.source) && row.source.collection === 'walkthroughHandoffs' && Boolean(hubId(row.walkthroughId));
const usableVisit = visit => plain(visit) && visit.type === 'walkthrough' && !visit.recordType;

/* The outcome one event records, or null for a sale that did not set the walkthrough's
 * outcome (a revision, or a visit the rep Started, whose Finish records it). Only the visit
 * record proves a sale set it, so the feed reports a handoff sale without one as unverified.
 * A Finish or No-show whose visit record cannot be matched is still delivered, from the event alone. */
function outcomeItem(row, visit) {
  const handoff = row.type === 'deal.sold', source = plain(row.source) ? row.source : {};
  if (handoff && !handoffSale(row)) return null;
  const usable = usableVisit(visit);
  const match = usable ? outcomeRecords(visit).find(record => record.outcome.requestId === source.id && (handoff ? record.outcome.source === 'walkthrough_handoff' : source.collection === WALKTHROUGH_VISIT_OPERATIONS)) : null;
  if (handoff && !match) return null;
  const data = plain(row.data) ? row.data : {}, outcomes = funnelReasonCodes('walkthroughOutcome');
  const named = handoff ? 'sold_on_site' : row.type === 'walkthrough.no_show' ? 'customer_no_show' : data.outcome, outcome = outcomes.includes(named) ? named : null;
  const record = match && match.outcome.outcome === outcome ? match : null;
  const occurrence = record ? occurrenceView(record.outcome.occurrence) : Number.isInteger(data.occurrence) ? { number: data.occurrence, date: null, time: null, startAt: null } : null;
  const reason = record ? record.outcome.reasonCode : data.reasonCode, recording = record ? record.outcome.recordingStatus : data.recordingStatus;
  return {
    eventId: row.id, cursor: feedCursor(row), type: row.type, recordedAt: row.recordedAt,
    visitId: hubId(row.walkthroughId), projectId: hubId(row.projectId), customerId: hubId(row.customerId), businessAccountId: hubId(row.businessAccountId),
    highlevelContactId: providerId(row.highlevelContactId), highlevelOpportunityId: providerId(row.highlevelOpportunityId),
    outcome, reasonCode: text(reason, SLUG), finishedAt: row.occurredAt, clockSource: text(row.clockSource, SLUG), performedBy: plain(row.actor) ? text(row.actor.id, ACTOR) : null,
    recordingStatus: text(recording, SLUG), startedAt: record?.start ? record.start.startedAt : null, startedBy: record?.start ? text(record.start.startedBy, ACTOR) : null,
    occurrence, outcomeRevision: occurrence ? occurrence.number : null, tookPlace: outcome === null ? null : !REBOOKABLE.has(outcome),
    source: handoff ? 'walkthrough_handoff' : 'walkthrough_visit', detail: record ? 'visit_record' : 'event_only',
    detailReason: record ? null : !usable ? 'visit_missing' : match ? 'outcome_mismatch' : 'outcome_not_found',
    eligible: !row.exclusion, exclusion: text(row.exclusion, SLUG), isTest: row.isTest === true, isInternal: row.isInternal === true,
  };
}

/**
 * hub.walkthrough.outcomes: every recorded walkthrough outcome after sinceCursor, in
 * feed order: a Finish or No-show (walkthrough.completed / walkthrough.no_show) and a
 * signed handoff that set sold_on_site (its deal.sold). The cursor advances over every
 * scanned event, so a page may hold fewer outcomes than events scanned. Visits are read
 * at the page's readTime. A handoff sale whose visit record is gone cannot be told from a
 * revision or a Started visit's sale, so it is listed in `unverified`, never as an outcome.
 */
export async function walkthroughOutcomesFeed(store, input, now) {
  const page = await feedPage(store, { ...input, types: [...WALKTHROUGH_OUTCOME_EVENT_TYPES] }, now);
  const ids = [...new Set(page.rows.filter(row => row.type !== 'deal.sold' || handoffSale(row)).map(row => hubId(row.walkthroughId)).filter(Boolean))], visits = new Map();
  for (let index = 0; index < ids.length; index += 100) for (const row of (await recordsAt(store, 'jobs', ids.slice(index, index + 100), VISIT_FIELDS, page.readTime)).rows) visits.set(row.id, row);
  const outcomes = [], unverified = [];
  for (const row of page.rows) {
    const visit = visits.get(row.walkthroughId);
    if (handoffSale(row) && !usableVisit(visit)) unverified.push({ eventId: row.id, cursor: feedCursor(row), type: row.type, visitId: row.walkthroughId, reason: 'visit_missing' });
    else { const item = outcomeItem(row, visit); if (item) outcomes.push(item); }
  }
  return { outcomes, unverified, scanned: page.rows.length, nextCursor: page.next, hasMore: page.hasMore, settledThrough: page.through, asOf: page.readTime, definitionsHash: definitionsHash(),
    coverage: { complete: !page.hasMore, asOf: page.readTime, through: page.through } };
}

const sameMatch = (a, b) => a.field === b.field && a.value === b.value;
/* The case a key names, read at one Firestore readTime (the current one on page one, which
 * pins every later page): a job is its project's case, and a job or walkthrough without a
 * project is read by its own id. The ledger query also matches the case's own records by
 * their ids: the key job, and the project's source walkthrough and source job. A walkthrough
 * or job gets its projectId only when a project is made from it (dispatch-service back-fills
 * the origin), so its earlier events carry just its own id. */
async function caseScope(store, key, readTime) {
  let query = key, own = null, pinned = readTime, project = null;
  if (key.field === 'jobId') {
    const read = await recordsAt(store, 'jobs', [key.value], JOB_FIELDS, pinned), [job] = read.rows;
    if (!job || job.recordType) throw fail('hub_funnel_case_not_found', 404);
    pinned = read.readTime; own = { field: job.type === 'walkthrough' ? 'walkthroughId' : 'jobId', value: key.value };
    query = hubId(job.projectId) ? { field: 'projectId', value: job.projectId } : own;
  }
  if (query.field === 'projectId') {
    const read = await recordsAt(store, 'projects', [query.value], PROJECT_FIELDS, pinned), [row] = read.rows;
    if (!row && key.field === 'projectId') throw fail('hub_funnel_case_not_found', 404);
    pinned = read.readTime;
    if (row) project = { id: query.value, customerId: hubId(row.customerId), highlevelContactId: providerId(row.highlevelContactId), sourceWalkthroughId: hubId(row.sourceWalkthroughId), sourceRecordId: hubId(row.sourceRecordId),
      previousProjectId: hubId(row.previousProjectId), createdAt: typeof row.createdAt === 'string' && instantMs(row.createdAt) !== null ? row.createdAt : null };
  }
  const sources = project ? [project.sourceWalkthroughId && { field: 'walkthroughId', value: project.sourceWalkthroughId }, project.sourceRecordId && project.sourceRecordId !== project.sourceWalkthroughId && { field: 'jobId', value: project.sourceRecordId }] : [];
  const matches = [query, own, ...sources].filter(Boolean).filter((match, index, all) => all.findIndex(other => sameMatch(other, match)) === index);
  return { query, matches, project, readTime: pinned };
}

/**
 * hub.funnel.case: the case's events by (occurredAt, id). Page one resolves the key and
 * reads at Firestore's current time; later pages resolve it again and read at that same
 * readTime, so the pages form one snapshot. A cursor continues only the case its key
 * resolves to at its readTime, and only while that readTime is in the last 50 minutes.
 */
export async function funnelCase(store, input, now) {
  const field = CASE_KEYS.find(name => input[name] !== undefined), key = { field, value: input[field] };
  let scope, after = null;
  if (input.cursor) {
    const cursor = parseCaseCursor(input.cursor), issued = Date.parse(cursor.readTime), current = nowMs(now);
    if (cursor.digest !== caseDigest(key, cursor.body) || issued > current) throw fail('hub_funnel_cursor_invalid');
    if (current - issued > FUNNEL_CASE_CURSOR_MAX_AGE_MS) throw fail('hub_funnel_cursor_expired', 409);
    scope = await caseScope(store, key, cursor.readTime);
    if (!sameMatch(scope.query, cursor.query)) throw fail('hub_funnel_cursor_invalid');
    after = cursor.after;
  } else scope = await caseScope(store, key, null);
  const page = await eventsPage(store, { order: 'occurredAt', types: null, anyOf: scope.matches, through: null, after, limit: input.limit, readTime: scope.readTime }), dataFields = feedDataFields();
  const last = page.rows.at(-1), earliest = [scope.project?.createdAt, page.rows[0]?.occurredAt, page.readTime].filter(Boolean).map(instantMs).sort((a, b) => a - b)[0];
  return {
    case: { key, query: scope.query, matches: scope.matches, project: scope.project }, events: page.rows.map(row => projectFunnelEvent(row, dataFields)),
    nextCursor: page.hasMore ? caseCursor(key, page.readTime, scope.query, last) : null, hasMore: page.hasMore,
    asOf: page.readTime, definitionsHash: definitionsHash(),
    coverage: { complete: !page.hasMore, asOf: page.readTime, reasons: cutoverCoverageReasons(denverDate(earliest)) },
  };
}

/* Firestore REST storage for the feed: one structured query per page (ordered by the
 * cursor field then the document name, resumed after the cursor, optionally at a pinned
 * readTime; a case matching several ids is one OR query, each branch on its own
 * (field, occurredAt) index) and masked batch reads, optionally at a pinned readTime, so
 * no money, signature or note field is fetched. */
export function funnelFeedStorage(env, fetcher = firestoreFetch) {
  async function send(url, body) {
    try { return await fetcher(env, url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) }); }
    catch { throw fail('hub_funnel_storage_unavailable', 503); }
  }
  async function json(response) {
    if (!response.ok) throw fail('hub_funnel_storage_unavailable', 503);
    try { return await response.json(); } catch { throw incomplete(); }
  }
  function decode(document, collection) {
    const prefix = `/documents/${collection}/`, name = document?.name;
    const path = typeof name === 'string' && name.includes(prefix) ? name.slice(name.indexOf(prefix) + prefix.length) : '';
    if (!path || path.includes('/') || typeof document.updateTime !== 'string' || document.fields !== undefined && !plain(document.fields)) throw incomplete();
    return { ...decodeFirestoreFields(document.fields || {}), id: path, revision: document.updateTime };
  }
  // The results of one read that carry a readTime all carry the same one, returned with the rows.
  function oneReadTime(results) {
    const times = new Set(results.map(result => result.readTime).filter(value => value !== undefined));
    if (times.size !== 1 || typeof [...times][0] !== 'string') throw incomplete();
    return [...times][0];
  }
  const where = (fieldPath, op, value) => ({ fieldFilter: { field: { fieldPath }, op, value } });
  return {
    async funnelEventsPage({ order, types, anyOf, through, after, limit, readTime }) {
      const filters = [];
      if (types) filters.push(types.length === 1 ? where('type', 'EQUAL', { stringValue: types[0] }) : where('type', 'IN', { arrayValue: { values: types.map(stringValue => ({ stringValue })) } }));
      if (anyOf) filters.push(anyOf.length === 1 ? where(anyOf[0].field, 'EQUAL', { stringValue: anyOf[0].value }) : { compositeFilter: { op: 'OR', filters: anyOf.map(match => where(match.field, 'EQUAL', { stringValue: match.value })) } });
      if (through) filters.push(where(order, 'LESS_THAN_OR_EQUAL', { stringValue: through }));
      const structuredQuery = {
        from: [{ collectionId: FUNNEL_EVENTS_COLLECTION }],
        ...(filters.length === 1 ? { where: filters[0] } : filters.length ? { where: { compositeFilter: { op: 'AND', filters } } } : {}),
        orderBy: [{ field: { fieldPath: order }, direction: 'ASCENDING' }, { field: { fieldPath: '__name__' }, direction: 'ASCENDING' }],
        ...(after ? { startAt: { values: [{ stringValue: after.at }, { referenceValue: `${ROOT}/${FUNNEL_EVENTS_COLLECTION}/${after.id}` }], before: false } } : {}),
        limit,
      };
      const results = await json(await send(`${BASE}:runQuery`, { structuredQuery, ...(readTime ? { readTime } : {}) }));
      if (!Array.isArray(results) || !results.length || results.some(result => !plain(result))) throw incomplete();
      return { rows: results.filter(result => result.document !== undefined).map(result => decode(result.document, FUNNEL_EVENTS_COLLECTION)), readTime: oneReadTime(results) };
    },
    async funnelRecords(collection, ids, fields, readTime = null) {
      if (!ids.length) return { rows: [], readTime };
      const results = await json(await send(`${BASE}:batchGet`, { documents: ids.map(id => `${ROOT}/${collection}/${id}`), mask: { fieldPaths: fields }, ...(readTime ? { readTime } : {}) }));
      if (!Array.isArray(results) || results.length !== ids.length || results.some(row => !plain(row) || row.found === undefined && typeof row.missing !== 'string')) throw incomplete();
      return { rows: results.filter(row => row.found !== undefined).map(row => decode(row.found, collection)), readTime: oneReadTime(results) };
    },
  };
}
