import { canonicalJson, definitionsHash, definitionsPath, funnelDefinitions, funnelEligibility, funnelHubId, sha256Hex } from './funnel-definitions.js';
import { denverDate, denverDayStart, instantMs } from './funnel-calendar.js';
import { addDays, validDate } from './dispatch-time.js';

// FUN-01: the server-only, append-only Hub funnel event ledger
// (funnelEvents/{eventId}). funnelEventWrite() validates one event against the
// shared definitions and returns ONE create-only write ({collection, id, patch}
// with no revision, i.e. currentDocument.exists=false) that the caller adds to
// the SAME commit as the business change, like SEC-B auditWrite(), so an event
// exists exactly when its change does. The id is derived from type, entity and
// idempotency key, so a re-sent commit can never add a second row.

export const FUNNEL_EVENTS_COLLECTION = 'funnelEvents';
// Composite indexes for the §4.1 reads (mirrored in firestore.indexes.json).
// The (recordedAt, id) feed cursor needs only the automatic single-field index;
// the FUN-37 feed's types[] filter (type in [...] order by recordedAt) needs
// (type, recordedAt).
export const FUNNEL_EVENT_INDEXES = Object.freeze([
  Object.freeze(['type', 'denverDate']),
  Object.freeze(['projectId', 'occurredAt']),
  Object.freeze(['jobId', 'occurredAt']),
  Object.freeze(['type', 'recordedAt']),
]);

const MINUTE = 60000;
const ACTOR = /^[a-z0-9][a-z0-9_.@:+-]{0,119}$/, ROLE = /^[a-z][a-z_]{0,39}$/;
const COLLECTION = /^[A-Za-z][A-Za-z0-9_]{0,63}$/, SOURCE_ID = /^[A-Za-z0-9_.:-]{1,180}$/, PROVIDER_ID = /^[A-Za-z0-9_-]{1,120}$/;
const SLUG = /^[a-z][a-z0-9_]{0,39}$/, SHA256 = /^[0-9a-f]{64}$/;
const INPUT_KEYS = new Set(['type', 'idempotencyKey', 'occurredAt', 'clockSource', 'deviceAt', 'deviceBounds', 'actor', 'via', 'data', 'source', 'eligibility']);
const fail = (code, message, status = 503) => Object.assign(new Error(message), { code, status });
const invalid = message => fail('funnel_event_invalid', `${message} Nothing was saved.`);
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const iso = value => { const ms = typeof value === 'string' || value instanceof Date ? instantMs(value) : null; return ms === null ? null : new Date(ms).toISOString(); };

function serverNow(clock) {
  let value;
  try { value = typeof clock === 'function' ? clock() : clock; } catch { value = null; }
  const ms = instantMs(value);
  if (ms === null || ms < 0) throw fail('funnel_event_invalid', 'The funnel event needs a valid server time. Nothing was saved.');
  return new Date(ms).toISOString();
}

/** The event document id: 'fe_' + the first 40 hex of sha256(type|entityField=entityValue|kind:value). */
export function funnelEventId(type, entity, idempotencyKey) {
  const rules = funnelDefinitions().eventIntegrity.eventId;
  return rules.prefix + sha256Hex(`${type}|${entity.field}=${entity.value}|${idempotencyKey}`).slice(0, rules.hexLength);
}

/**
 * The C17 device-time rule. A device time is `device_validated` only when it
 * is <= now + 5 min and >= max(startedAt - 1 h, Denver midnight of
 * scheduledDate - 1 day); anything else is `attested` (counted, but excluded
 * from timing metrics). An out-of-bounds device time is never used as
 * occurredAt, so a skewed or reset phone clock cannot move a fact (or a sale's
 * revenue) into another Denver day or period, and cannot fail the commit: a time
 * before the bounds is dated at the lower bound (the server time when that bound
 * is later), and a future or unbounded one (no startedAt or scheduledDate) at the
 * server time. The lower bound is never before eventIntegrity.earliestOccurredAt,
 * so occurredAt always lands in [earliestOccurredAt, now + 5 min]. The device
 * time itself is kept as deviceAt, with the reasons, for review.
 */
export function resolveDeviceClock({ deviceAt, now, startedAt = null, scheduledDate = null } = {}) {
  const integrity = funnelDefinitions().eventIntegrity, rules = integrity.deviceClock, at = iso(deviceAt), current = iso(now);
  if (!at || !current) throw invalid('The device time must be an ISO instant.');
  const bounds = [];
  if (startedAt !== null && startedAt !== undefined) { const started = iso(startedAt); if (!started) throw invalid('The walkthrough start must be an ISO instant.'); bounds.push(Date.parse(started) - rules.notBeforeStartedAtMinutes * MINUTE); }
  if (scheduledDate !== null && scheduledDate !== undefined) { if (!validDate(scheduledDate)) throw invalid('The scheduled date must be YYYY-MM-DD.'); bounds.push(Date.parse(denverDayStart(addDays(scheduledDate, -rules.notBeforeScheduledDateDays)))); }
  const ms = Date.parse(at), nowMs = Date.parse(current), floor = bounds.length ? Math.max(Date.parse(integrity.earliestOccurredAt), ...bounds) : null, reasons = [];
  if (ms > nowMs + rules.maxFutureMinutes * MINUTE) reasons.push('device_time_in_future');
  if (floor === null) reasons.push('device_time_unbounded');
  else if (ms < floor) reasons.push('device_time_before_bounds');
  const occurredAt = !reasons.length ? at : reasons.includes('device_time_before_bounds') ? new Date(Math.min(floor, nowMs)).toISOString() : current;
  return { occurredAt, clockSource: reasons.length ? rules.outOfBoundsAs : rules.acceptedAs, reasons };
}

function dataValue(definitions, spec, name, value, reasonList) {
  const bad = () => invalid(`The funnel event field ${name} is invalid.`);
  if (spec.type === 'cents') { if (!Number.isSafeInteger(value) || value < 0 || value > 100000000) throw bad(); return value; }
  if (spec.type === 'integer') { if (!Number.isInteger(value) || value < spec.min || value > spec.max) throw bad(); return value; }
  if (spec.type === 'boolean') { if (typeof value !== 'boolean') throw bad(); return value; }
  if (spec.type === 'slug') { if (typeof value !== 'string' || !SLUG.test(value)) throw bad(); return value; }
  if (spec.type === 'sha256') { if (typeof value !== 'string' || !SHA256.test(value)) throw bad(); return value; }
  const values = spec.type === 'reasonCode' ? definitions.reasonCodes[reasonList] : definitionsPath(definitions, spec.values);
  if (!Array.isArray(values) || !values.includes(value)) throw bad();
  return value;
}

function entityValue(field, kind, value) {
  if (value === undefined || value === null || value === '') return null;
  if (kind === 'hub' ? !funnelHubId(value) : typeof value !== 'string' || !PROVIDER_ID.test(value)) throw invalid(`The funnel event ${field} is not a valid record id.`);
  return value;
}

function idempotency(definitions, key, source, via, clockSource) {
  const specs = definitions.eventIntegrity.idempotencyKeys;
  if (!plain(key) || Object.keys(key).some(name => !['kind', 'value'].includes(name)) || !Object.hasOwn(specs, key.kind) || typeof key.value !== 'string') throw invalid('The funnel event needs an idempotency key {kind, value}.');
  const spec = specs[key.kind], value = spec.lowercase ? key.value.toLowerCase() : key.value;
  if (!new RegExp(spec.pattern, spec.flags || '').test(value)) throw invalid(`The ${key.kind} idempotency key is malformed.`);
  // FUN-04 imports use via backfill with the backfill key; their time is the backfill clock, or attested/provider when the source says so.
  // A source document that yields several events of one type names each sub-record in source.id: '<docId>:<field>:<subId>'.
  const backfill = via === 'backfill', clocks = definitions.eventIntegrity.backfillClockSources;
  if (backfill !== (key.kind === 'backfill') || (backfill ? !clocks.includes(clockSource) || value !== `${source.collection}/${source.id}` : clockSource === 'backfill')) throw invalid('Backfill events use via backfill, a backfill, attested or provider clock and the key source.collection/source.id.');
  if (key.kind === 'derived' && clockSource !== 'system') throw invalid('Derived idempotency keys are for system events only.');
  return `${key.kind}:${value}`;
}

/**
 * Builds one funnel event write. Input:
 *   {type, idempotencyKey: {kind, value}, actor: {id, kind, role?}, via,
 *    source: {collection, id}, data?, the entity ids (projectId, jobId,
 *    walkthroughId, customerId, businessAccountId, inquiryId, membershipId,
 *    highlevelContactId, highlevelOpportunityId), eligibility?: {hub, ghl, stripe},
 *    and a clock: nothing (server time), clockSource 'provider' | 'attested' |
 *    'system' | 'backfill' with occurredAt, or deviceAt (+ deviceBounds
 *    {startedAt, scheduledDate}) for the device rule}.
 * `clock` is the server time: an ISO string, Date, epoch ms or a function
 * returning one; it is recordedAt. When the entity is a jobId or walkthroughId,
 * eligibility.hub must be that record so isTest/isInternal come from the single
 * eligibility function; Stripe-sourced events (via 'stripe') need
 * eligibility.stripe. `store.read(collection, id)` (optional; pass null when the
 * enclosing receipt already proves first application) lets a retry after a lost
 * response resolve to null when the identical event already exists, and a
 * different event under the same key fails funnel_event_idempotency_conflict.
 * Returns the write (with `patch` and `data`, like auditWrite) or null.
 */
export async function funnelEventWrite(store, clock, event) {
  const definitions = funnelDefinitions(), now = serverNow(clock), vocab = definitions.vocabularies, integrity = definitions.eventIntegrity;
  if (!plain(event)) throw invalid('The funnel event must be an object.');
  const entityFields = Object.keys(definitions.entityFields);
  for (const key of Object.keys(event)) if (!INPUT_KEYS.has(key) && !entityFields.includes(key)) throw invalid(`The funnel event has an unknown field ${key}.`);
  const spec = Object.hasOwn(definitions.eventTypes, event.type) ? definitions.eventTypes[event.type] : null;
  if (!spec) throw invalid('The funnel event type is not defined.');
  const entities = Object.fromEntries(entityFields.map(field => [field, entityValue(field, definitions.entityFields[field], event[field])]));
  const entityField = spec.entity.find(field => entities[field] !== null);
  if (!entityField) throw invalid(`A ${event.type} event needs one of ${spec.entity.join(', ')}.`);
  const actor = event.actor, actorId = typeof actor?.id === 'string' ? actor.id.trim().toLowerCase() : '';
  if (!plain(actor) || !ACTOR.test(actorId) || !vocab.actorKinds.includes(actor.kind) || actor.role !== undefined && actor.role !== null && !(typeof actor.role === 'string' && ROLE.test(actor.role.toLowerCase()))) throw invalid('The funnel event needs a valid actor.');
  if (!vocab.via.includes(event.via)) throw invalid('The funnel event needs a valid source system (via).');
  const source = event.source;
  if (!plain(source) || Object.keys(source).length !== 2 || !COLLECTION.test(source.collection || '') || !SOURCE_ID.test(source.id || '')) throw invalid('The funnel event must name the authoritative record it mirrors (source).');

  // Clock provenance: server time, a device time under the C17 bounds, or an explicit provider/attested/system/backfill time.
  let occurredAt = now, clockSource = event.clockSource ?? 'server', deviceAt = null, deviceBounds = null, clockReasons = [];
  if (!vocab.clockSources.includes(clockSource)) throw invalid('The funnel event clock source is not defined.');
  if (event.deviceAt !== undefined) {
    if (event.clockSource !== undefined || event.occurredAt !== undefined) throw invalid('A device time replaces clockSource and occurredAt.');
    const bounds = event.deviceBounds ?? {};
    if (!plain(bounds) || Object.keys(bounds).some(key => !['startedAt', 'scheduledDate'].includes(key))) throw invalid('Device bounds are {startedAt, scheduledDate}.');
    ({ occurredAt, clockSource, reasons: clockReasons } = resolveDeviceClock({ deviceAt: event.deviceAt, now, startedAt: bounds.startedAt ?? null, scheduledDate: bounds.scheduledDate ?? null }));
    deviceAt = iso(event.deviceAt); deviceBounds = { startedAt: bounds.startedAt ? iso(bounds.startedAt) : null, scheduledDate: bounds.scheduledDate ?? null };
  } else if (event.deviceBounds !== undefined || clockSource === 'device_validated') throw invalid('A device-validated time must come from deviceAt.');
  else if (clockSource === 'server') { if (event.occurredAt !== undefined) throw invalid('Server-clock events take the server time; send clockSource with an explicit occurredAt.'); }
  else if (event.occurredAt !== undefined || clockSource !== 'system') {
    occurredAt = iso(event.occurredAt);
    if (!occurredAt) throw invalid(`A ${clockSource} event needs an ISO occurredAt.`);
  }
  if (occurredAt < iso(integrity.earliestOccurredAt) || Date.parse(occurredAt) > Date.parse(now) + integrity.maxFutureMinutes * MINUTE) throw invalid('The funnel event time is outside the accepted range.');
  const key = idempotency(definitions, event.idempotencyKey, source, event.via, clockSource);

  const input = event.data ?? {};
  if (!plain(input)) throw invalid('The funnel event data must be an object.');
  const allowed = [...spec.required, ...spec.optional];
  for (const name of Object.keys(input)) if (!allowed.includes(name)) throw invalid(`A ${event.type} event does not take ${name}.`);
  for (const name of spec.required) if (input[name] === undefined || input[name] === null) throw invalid(`A ${event.type} event needs ${name}.`);
  const data = Object.fromEntries(Object.keys(input).filter(name => input[name] !== undefined && input[name] !== null).sort().map(name => [name, dataValue(definitions, definitions.dataFields[name], name, input[name], spec.reasons)]));

  // isTest/isInternal come only from the shared eligibility function.
  const records = event.eligibility ?? {};
  if (!plain(records) || Object.keys(records).some(name => !['hub', 'ghl', 'stripe'].includes(name))) throw invalid('Eligibility inputs are {hub, ghl, stripe}.');
  const hubIds = [entities.jobId, entities.walkthroughId].filter(Boolean);
  if (hubIds.length && !hubIds.includes(records.hub?.id)) throw invalid('An event about a job or walkthrough must pass that record as eligibility.hub.');
  const present = [entities.jobId, entities.walkthroughId, entities.projectId, entities.customerId, entities.businessAccountId].filter(Boolean);
  if (records.hub !== undefined && (typeof records.hub?.id !== 'string' || !present.includes(records.hub.id))) throw invalid('The eligibility record must be one of the event records.');
  if (event.via === 'stripe' && records.stripe === undefined) throw invalid('Stripe events must pass the Stripe object for eligibility.');
  const eligibility = funnelEligibility(records);
  if (eligibility.exclusions.includes('private_record')) throw fail('funnel_event_private_record', 'Funnel events are never written for private Hub records. Nothing was saved.');

  const entity = { field: entityField, value: entities[entityField] };
  const id = funnelEventId(event.type, entity, key);
  const clockInput = { source: event.clockSource ?? null, occurredAt: event.deviceAt === undefined && event.occurredAt !== undefined ? occurredAt : null, deviceAt, deviceBounds };
  const fingerprint = sha256Hex(canonicalJson({ v: integrity.eventSchemaVersion, type: event.type, entity, idempotencyKey: key, entities, actor: { id: actorId, kind: actor.kind, role: actor.role ? actor.role.toLowerCase() : null }, via: event.via, source, data, clock: clockInput }));
  const doc = {
    schemaVersion: integrity.eventSchemaVersion, definitionsVersion: definitions.definitionsVersion, definitionsHash: definitionsHash(),
    type: event.type, group: spec.group, entityKey: `${entity.field}:${entity.value}`,
    occurredAt, clockSource, clockReasons, recordedAt: now, denverDate: denverDate(occurredAt), deviceAt,
    ...entities,
    actor: { id: actorId, kind: actor.kind, role: actor.role ? actor.role.toLowerCase() : null }, via: event.via,
    data, source: { collection: source.collection, id: source.id }, idempotencyKey: key, fingerprint,
    isTest: eligibility.isTest, isInternal: eligibility.isInternal, internalReason: eligibility.internalReason, exclusion: eligibility.exclusion,
  };
  if (store) {
    const existing = await store.read(FUNNEL_EVENTS_COLLECTION, id);
    if (existing) {
      if (existing.fingerprint === fingerprint) return null;
      throw fail('funnel_event_idempotency_conflict', 'A different funnel event was already recorded under this idempotency key. Nothing was saved.', 409);
    }
  }
  return { collection: FUNNEL_EVENTS_COLLECTION, id, patch: doc, data: doc };
}
