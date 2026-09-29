import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import DEFINITIONS_JSON from './funnel-definitions.data.js';

// FUN-01: the one set of funnel definitions (eligibility, vocabularies, reason
// codes, calendar, cycle and event-integrity rules) shared with egc-platform.
// The canonical file is functions/_data/funnel-definitions.data.json; the
// generated funnel-definitions.data.js carries its exact text because Pages
// Functions bundles cannot rely on JSON import attributes. Loading is lazy and
// never throws at import: a broken file fails only the callers that need it
// (funnel_definitions_invalid), never the whole Functions bundle.
// definitionsHash() is sha256 over canonical JSON (keys sorted by UTF-16 code
// unit, no whitespace), so formatting never changes it and the platform package
// computes the same value with node:crypto.

const fail = (code, message, status = 503) => Object.assign(new Error(message), { code, status });
const encoder = new TextEncoder();
const SLUG = /^[a-z][a-z0-9_]{0,63}$/, TAG = /^(?=.{1,64}$)[a-z0-9]+(?:-[a-z0-9]+)*$/, FLAG = /^[A-Za-z][A-Za-z0-9_]{0,39}$/, TIME = /^([01]\d|2[0-3]):[0-5]\d$/, DATE = /^\d{4}-\d{2}-\d{2}$/;
const EVENT_TYPE = /^[a-z][a-z_]{0,31}\.[a-z][a-z_]{0,39}$/, HUB_ID = /^[A-Za-z0-9_-]{1,180}$/;
const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const DATA_TYPES = new Set(['cents', 'integer', 'slug', 'reasonCode', 'enum', 'boolean', 'sha256', 'instant']);
const SERVICE_LINE_SOURCES = ['explicit', 'visitPurpose', 'businessAccount', 'catalogCategory', 'relatedProject', 'ghlGarageHelpRequested', 'salesExitService', 'legacyJobType'];
const FUNNEL_PATH_SOURCES = ['explicit', 'visitPurpose', 'bookingChannel', 'recurringSeries', 'businessAccount', 'walkthrough', 'repeat'];
const CLASSES = new Set(['never', 'test', 'internal', 'excluded']);
const UNITS = ['day', 'week', 'month', 'quarter', 'year', 'custom'];
const JOBBER_SURFACES = ['booking', 'billing', 'messaging'];
const JOBBER_FINDINGS = ['jobber_request_after_cutover', 'jobber_job_after_cutover', 'jobber_visit_after_cutover', 'jobber_invoice_after_cutover', 'jobber_payment_after_cutover', 'jobber_imported_balance_changed', 'ghl_contact_from_jobber', 'ghl_opportunity_from_jobber'];
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Canonical JSON: object keys sorted by UTF-16 code unit, arrays in order, no whitespace. */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (plain(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

export const sha256Hex = text => bytesToHex(sha256(encoder.encode(text)));

function deepFreeze(value) {
  if (value && typeof value === 'object') { for (const item of Object.values(value)) deepFreeze(item); Object.freeze(value); }
  return value;
}

/** Resolves 'vocabularies.x' / 'reasonCodes.y' references inside the definitions. */
export function definitionsPath(definitions, path) {
  return String(path).split('.').reduce((node, key) => plain(node) && Object.hasOwn(node, key) ? node[key] : undefined, definitions);
}

/** Structural problems in a parsed definitions object (empty when valid). The sync script refuses to write invalid definitions. */
export function validateFunnelDefinitions(d) {
  const problems = [], problem = text => problems.push(text);
  const list = (value, pattern, label) => {
    if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || !pattern.test(item)) || new Set(value).size !== value.length) { problem(`${label} must be a list of unique codes`); return []; }
    return value;
  };
  const positive = (value, label) => { if (!Number.isInteger(value) || value < 1) problem(`${label} must be a positive integer`); };
  if (!plain(d)) return ['definitions must be an object'];
  if (d.schemaVersion !== 1) problem('schemaVersion must be 1');
  if (typeof d.definitionsVersion !== 'string' || !/^\d{4}-\d{2}-\d{2}\.\d{1,3}$/.test(d.definitionsVersion)) problem('definitionsVersion must look like YYYY-MM-DD.N');
  if (d.timeZone !== 'America/Denver' || d.calendar?.timeZone !== 'America/Denver') problem('the Hub calendar is America/Denver');
  const eligibility = d.eligibility || {}, hub = eligibility.hub || {}, ghl = eligibility.ghl || {}, stripe = eligibility.stripe || {};
  const classes = plain(eligibility.exclusionClasses) ? eligibility.exclusionClasses : (problem('eligibility.exclusionClasses is required'), {});
  for (const [code, value] of Object.entries(classes)) if (!SLUG.test(code) || !CLASSES.has(value)) problem(`exclusion class ${code} is invalid`);
  for (const code of ['private_record', 'test', 'internal', 'stripe_test_mode', 'synthetic_source', 'hiring_calendar']) if (!Object.hasOwn(classes, code)) problem(`exclusion class ${code} is missing`);
  list(hub.privateIdPrefixes, /^[A-Za-z0-9_]{1,20}$/, 'eligibility.hub.privateIdPrefixes');
  list(hub.testFlags, /^[A-Za-z][A-Za-z0-9]{0,39}$/, 'eligibility.hub.testFlags');
  list(hub.internalReasons, SLUG, 'eligibility.hub.internalReasons');
  if (hub.privateWhenRecordType !== true) problem('eligibility.hub.privateWhenRecordType must be true');
  for (const key of ['internalFlag', 'internalReasonField']) if (typeof hub[key] !== 'string' || !/^[A-Za-z][A-Za-z0-9]{0,39}$/.test(hub[key])) problem(`eligibility.hub.${key} is invalid`);
  if (ghl.tagFolding !== 'lowercase_fold_separators_to_hyphen') problem('eligibility.ghl.tagFolding is fixed');
  if (!plain(ghl.exclusionTags) || !Object.keys(ghl.exclusionTags).length) problem('eligibility.ghl.exclusionTags is required');
  else for (const [tag, code] of Object.entries(ghl.exclusionTags)) if (!TAG.test(tag) || !Object.hasOwn(classes, code) || classes[code] === 'never') problem(`GHL exclusion tag ${tag} is invalid (tags are folded: lowercase, one hyphen between words)`);
  if (!plain(ghl.exclusionFlags)) problem('eligibility.ghl.exclusionFlags is required');
  else for (const [flag, code] of Object.entries(ghl.exclusionFlags)) if (!FLAG.test(flag) || !Object.hasOwn(classes, code) || classes[code] === 'never') problem(`GHL exclusion flag ${flag} is invalid`);
  if (!Array.isArray(ghl.syntheticSources) || ghl.syntheticSources.some(item => typeof item !== 'string' || !item.trim())) problem('eligibility.ghl.syntheticSources is invalid');
  list(ghl.hiringCalendarIds, /^[A-Za-z0-9_-]{1,120}$/, 'eligibility.ghl.hiringCalendarIds');
  if (stripe.requireLivemode !== true) problem('eligibility.stripe.requireLivemode must be true');
  list(stripe.testIdPrefixes, /^[a-z]{2,6}_test_$/, 'eligibility.stripe.testIdPrefixes');
  const vocabularies = plain(d.vocabularies) ? d.vocabularies : (problem('vocabularies is required'), {});
  for (const [name, values] of Object.entries(vocabularies)) list(values, SLUG, `vocabularies.${name}`);
  for (const name of ['actorKinds', 'via', 'clockSources', 'timingClockSources', 'visitPurposes', 'serviceLines', 'funnelPaths', 'inquiryOrigins', 'bookingChannels', 'selfReportedChannels', 'initiatedBy', 'recordingStatuses', 'paymentKinds', 'paymentMethods', 'creditClasses', 'metricStatuses']) if (!Array.isArray(vocabularies[name])) problem(`vocabularies.${name} is missing`);
  if (Array.isArray(vocabularies.timingClockSources) && vocabularies.timingClockSources.some(item => !vocabularies.clockSources?.includes(item))) problem('timingClockSources must be clock sources');
  const reasons = plain(d.reasonCodes) ? d.reasonCodes : (problem('reasonCodes is required'), {});
  for (const [name, values] of Object.entries(reasons)) list(values, SLUG, `reasonCodes.${name}`);
  for (const name of ['walkthroughOutcome', 'lost', 'cancel', 'reschedule', 'noShow']) if (!Array.isArray(reasons[name])) problem(`reasonCodes.${name} is missing`);
  const sources = d.serviceLineSources || {};
  const lines = vocabularies.serviceLines || [];
  if (!Array.isArray(sources.precedence) || !sources.precedence.length || sources.precedence.some(source => !SERVICE_LINE_SOURCES.includes(source)) || new Set(sources.precedence).size !== sources.precedence.length) problem('serviceLineSources.precedence must list known sources once');
  for (const [name, map] of [['visitPurpose', sources.visitPurpose], ['catalogCategory', sources.catalogCategory], ['ghlGarageHelpRequested', sources.ghlGarageHelpRequested?.values], ['salesExitService', sources.salesExitService], ['legacyJobType', sources.legacyJobType]]) {
    if (!plain(map)) problem(`serviceLineSources.${name} is required`);
    else for (const line of Object.values(map)) if (!lines.includes(line) || line === d.metricDimensions?.serviceLine?.missingBucket) problem(`serviceLineSources.${name} maps to an unknown service line`);
  }
  if (!lines.includes(sources.businessAccount)) problem('serviceLineSources.businessAccount must be a service line');
  if (sources.relatedProject !== 'inherit') problem('serviceLineSources.relatedProject must be inherit');
  // FUN-29: the funnel path a booking pre-fills, with the same precedence model. There is no unknown path: undecided is null.
  const pathSources = d.funnelPathSources || {}, paths = vocabularies.funnelPaths || [];
  if (!Array.isArray(pathSources.precedence) || !pathSources.precedence.length || pathSources.precedence.some(source => !FUNNEL_PATH_SOURCES.includes(source)) || new Set(pathSources.precedence).size !== pathSources.precedence.length) problem('funnelPathSources.precedence must list known sources once');
  for (const [name, map, keys] of [['visitPurpose', pathSources.visitPurpose, vocabularies.visitPurposes], ['bookingChannel', pathSources.bookingChannel, vocabularies.bookingChannels]]) {
    if (!plain(map)) problem(`funnelPathSources.${name} is required`);
    else for (const [key, path] of Object.entries(map)) if (!keys?.includes(key) || !paths.includes(path)) problem(`funnelPathSources.${name} maps an unknown value or to an unknown path`);
  }
  for (const name of ['recurringSeries', 'businessAccount', 'walkthrough', 'repeat']) if (!paths.includes(pathSources[name])) problem(`funnelPathSources.${name} must be a funnel path`);
  if (!Number.isInteger(d.dimensionRulesVersion) || d.dimensionRulesVersion < 1) problem('dimensionRulesVersion must be a positive integer');
  const calendar = d.calendar || {}, hours = calendar.businessHours || {};
  if (calendar.weekStartsOn !== 'monday') problem('weeks start on Monday');
  if (!plain(hours) || Object.keys(hours).length !== 7 || DAYS.some(day => !Array.isArray(hours[day]))) problem('calendar.businessHours needs all seven days');
  else for (const day of DAYS) {
    let previous = '';
    for (const interval of hours[day]) {
      if (!Array.isArray(interval) || interval.length !== 2 || !TIME.test(interval[0]) || !TIME.test(interval[1]) || interval[0] >= interval[1] || interval[0] < previous) problem(`calendar.businessHours.${day} has an invalid interval`);
      else previous = interval[1];
    }
  }
  const holidays = calendar.holidays || {};
  if (!['actual_date'].includes(holidays.observance) || !Array.isArray(holidays.rules)) problem('calendar.holidays is invalid');
  else for (const rule of holidays.rules) {
    const fixed = Number.isInteger(rule?.day) && rule.weekday === undefined, floating = DAYS.includes(rule?.weekday) && [1, 2, 3, 4, -1].includes(rule?.nth) && rule.day === undefined;
    if (!plain(rule) || !SLUG.test(rule.id || '') || !Number.isInteger(rule.month) || rule.month < 1 || rule.month > 12 || !(fixed && rule.day >= 1 && rule.day <= 31 || floating)) problem(`holiday rule ${rule?.id} is invalid`);
  }
  const lead = calendar.webLeadTiming || {};
  if (lead.inHours !== 'in-hours' || lead.outOfHours !== 'out-of-hours' || typeof lead.applyHolidays !== 'boolean' || lead.onError !== 'in-hours') problem('calendar.webLeadTiming is invalid');
  const periods = calendar.periods || {};
  if (!Array.isArray(periods.inProgress) || !Array.isArray(periods.closed) || !Array.isArray(periods.comparisons) || periods.custom?.endDate !== 'exclusive' || !Number.isInteger(periods.custom?.maxDays)) problem('calendar.periods is invalid');
  const alignment = periods.sameLastYearAlignment;
  if (!plain(alignment) || Object.keys(alignment).length !== UNITS.length || UNITS.some(unit => !['same_weekday', 'same_date'].includes(alignment[unit]))) problem('calendar.periods.sameLastYearAlignment needs same_weekday or same_date for every unit');
  if (!Number.isInteger(periods.weekdayAlignedShiftDays) || periods.weekdayAlignedShiftDays < 357 || periods.weekdayAlignedShiftDays > 371 || periods.weekdayAlignedShiftDays % 7) problem('calendar.periods.weekdayAlignedShiftDays must be whole weeks, about a year');
  const dimensions = plain(d.metricDimensions) ? d.metricDimensions : (problem('metricDimensions is required'), {});
  for (const name of ['serviceLine', 'funnelPath']) if (!Array.isArray(definitionsPath(d, dimensions[name]?.values)) || typeof dimensions[name]?.missingBucket !== 'string' || !SLUG.test(dimensions[name].missingBucket)) problem(`metricDimensions.${name} is invalid`);
  if (!lines.includes(dimensions.serviceLine?.missingBucket)) problem('the service-line missing bucket must be a service line, so an undecided booking can record it');
  const cycles = d.cycles || {}, windows = d.metricWindows || {};
  for (const key of ['repeatWindowDays', 'openCyclesPerContact', 'expiredAfterDaysWithoutEvent', 'stalledAfterDaysWithoutEvent']) positive(cycles[key], `cycles.${key}`);
  for (const [key, value] of Object.entries(windows)) positive(value, `metricWindows.${key}`);
  const integrity = d.eventIntegrity || {}, clock = integrity.deviceClock || {};
  if (!/^[a-z][A-Za-z]{1,40}$/.test(integrity.collection || '') || integrity.eventSchemaVersion !== 1) problem('eventIntegrity.collection/eventSchemaVersion is invalid');
  if (integrity.eventId?.prefix !== 'fe_' || integrity.eventId?.hexLength !== 40) problem('eventIntegrity.eventId must be fe_ + 40 hex');
  if (integrity.cutoverDate !== null && !(typeof integrity.cutoverDate === 'string' && DATE.test(integrity.cutoverDate))) problem('eventIntegrity.cutoverDate must be null or YYYY-MM-DD');
  if (typeof integrity.earliestOccurredAt !== 'string' || !Number.isFinite(Date.parse(integrity.earliestOccurredAt))) problem('eventIntegrity.earliestOccurredAt is invalid');
  for (const key of ['maxFutureMinutes']) positive(integrity[key], `eventIntegrity.${key}`);
  const backfillClocks = list(integrity.backfillClockSources, SLUG, 'eventIntegrity.backfillClockSources');
  if (!backfillClocks.includes('backfill') || backfillClocks.some(item => !vocabularies.clockSources?.includes(item) || ['server', 'device_validated', 'system'].includes(item))) problem('eventIntegrity.backfillClockSources must include backfill and never a live clock');
  for (const key of ['maxFutureMinutes', 'notBeforeStartedAtMinutes', 'notBeforeScheduledDateDays']) positive(clock[key], `eventIntegrity.deviceClock.${key}`);
  if (clock.acceptedAs !== 'device_validated' || clock.outOfBoundsAs !== 'attested' || clock.outOfBoundsOccurredAt !== 'lower_bound_or_server_time') problem('eventIntegrity.deviceClock outcomes are fixed');
  const keys = plain(integrity.idempotencyKeys) ? integrity.idempotencyKeys : (problem('eventIntegrity.idempotencyKeys is required'), {});
  for (const [kind, spec] of Object.entries(keys)) {
    try { if (!/^[a-z][A-Za-z]{1,30}$/.test(kind) || typeof spec?.pattern !== 'string' || !spec.pattern.startsWith('^') || !spec.pattern.endsWith('$')) throw new Error(); new RegExp(spec.pattern, spec.flags || ''); }
    catch { problem(`idempotency key ${kind} is invalid`); }
  }
  for (const kind of ['requestId', 'stripeEvent', 'stripeSession', 'ghlAdoption', 'portalRequest', 'backfill', 'derived']) if (!Object.hasOwn(keys, kind)) problem(`idempotency key ${kind} is missing`);
  const entities = plain(d.entityFields) ? d.entityFields : (problem('entityFields is required'), {});
  for (const [field, kind] of Object.entries(entities)) if (!/^[a-z][A-Za-z]{1,40}Id$/.test(field) || !['hub', 'provider'].includes(kind)) problem(`entity field ${field} is invalid`);
  const fields = plain(d.dataFields) ? d.dataFields : (problem('dataFields is required'), {});
  for (const [name, spec] of Object.entries(fields)) {
    if (!/^[a-z][A-Za-z]{1,40}$/.test(name) || !plain(spec) || !DATA_TYPES.has(spec.type)) { problem(`data field ${name} is invalid`); continue; }
    if (spec.type === 'enum' && !Array.isArray(definitionsPath(d, spec.values))) problem(`data field ${name} references an unknown list`);
    if (spec.type === 'integer' && (!Number.isInteger(spec.min) || !Number.isInteger(spec.max) || spec.min > spec.max)) problem(`data field ${name} needs integer bounds`);
  }
  const groups = list(d.eventGroups, SLUG, 'eventGroups');
  const types = plain(d.eventTypes) ? d.eventTypes : (problem('eventTypes is required'), {});
  for (const [type, spec] of Object.entries(types)) {
    if (!EVENT_TYPE.test(type) || !plain(spec)) { problem(`event type ${type} is invalid`); continue; }
    if (!groups.includes(spec.group)) problem(`event type ${type} has an unknown group`);
    if (!Array.isArray(spec.entity) || !spec.entity.length || spec.entity.some(field => !Object.hasOwn(entities, field))) problem(`event type ${type} needs entity fields`);
    const required = Array.isArray(spec.required) ? spec.required : [], optional = Array.isArray(spec.optional) ? spec.optional : [];
    if (!Array.isArray(spec.required) || !Array.isArray(spec.optional) || [...required, ...optional].some(field => !Object.hasOwn(fields, field)) || new Set([...required, ...optional]).size !== required.length + optional.length) problem(`event type ${type} has invalid data fields`);
    const reasoned = [...required, ...optional].includes('reasonCode');
    if (reasoned !== (spec.reasons !== undefined) || reasoned && !Array.isArray(reasons[spec.reasons])) problem(`event type ${type} must name its reason list exactly when it takes a reasonCode`);
  }
  // FUN-32: the Jobber cutover day and the coexistence guard's findings.
  const jobber = plain(d.jobber) ? d.jobber : (problem('jobber is required'), {});
  if (jobber.cutoverDate !== null && !(typeof jobber.cutoverDate === 'string' && DATE.test(jobber.cutoverDate) && new Date(`${jobber.cutoverDate}T12:00:00Z`).toISOString().startsWith(jobber.cutoverDate))) problem('jobber.cutoverDate must be null or a real YYYY-MM-DD date');
  const surfaces = list(jobber.guardSurfaces, SLUG, 'jobber.guardSurfaces');
  for (const surface of JOBBER_SURFACES) if (!surfaces.includes(surface)) problem(`jobber.guardSurfaces needs ${surface}`);
  const findings = plain(jobber.findings) ? jobber.findings : (problem('jobber.findings is required'), {});
  for (const [code, spec] of Object.entries(findings)) if (!SLUG.test(code) || !plain(spec) || !Array.isArray(spec.surfaces) || !spec.surfaces.length || spec.surfaces.some(surface => !surfaces.includes(surface)) || new Set(spec.surfaces).size !== spec.surfaces.length || !['customer', 'job'].includes(spec.scope)) problem(`jobber finding ${code} is invalid`);
  for (const code of JOBBER_FINDINGS) if (!Object.hasOwn(findings, code)) problem(`jobber finding ${code} is missing`);
  const markers = plain(jobber.ghlAppMarkers) ? jobber.ghlAppMarkers : {};
  const marked = [list(markers.sources, TAG, 'jobber.ghlAppMarkers.sources'), list(markers.tags, TAG, 'jobber.ghlAppMarkers.tags'), list(markers.createdBySourceIds, /^[A-Za-z0-9_-]{1,120}$/, 'jobber.ghlAppMarkers.createdBySourceIds')];
  if (!marked.some(values => values.length)) problem('jobber.ghlAppMarkers needs at least one marker');
  return problems;
}

let cache;
function load() {
  if (cache) return cache;
  try {
    const parsed = JSON.parse(DEFINITIONS_JSON), problems = validateFunnelDefinitions(parsed);
    cache = { definitions: deepFreeze(parsed), hash: sha256Hex(canonicalJson(parsed)), problems };
  } catch { cache = { definitions: null, hash: null, problems: ['definitions are not valid JSON'] }; }
  return cache;
}

/** Problems with the shipped definitions (empty when valid). Tests and the drift check assert it is empty. */
export const definitionsProblems = () => [...load().problems];

/** The deep-frozen definitions. Throws funnel_definitions_invalid (503) rather than using a broken file. */
export function funnelDefinitions() {
  const { definitions, problems } = load();
  if (problems.length) throw fail('funnel_definitions_invalid', 'The funnel definitions are invalid. Nothing was counted or saved.');
  return definitions;
}

/** sha256 hex of the canonical definitions; the Hub and the platform must report the same value. */
export function definitionsHash() { funnelDefinitions(); return load().hash; }

/** A named vocabulary ('serviceLines', 'bookingChannels', ...) as a frozen list. */
export function funnelVocabulary(name) {
  const values = funnelDefinitions().vocabularies[name];
  if (!Array.isArray(values)) throw fail('funnel_definitions_unknown', `There is no funnel vocabulary named ${name}.`, 500);
  return values;
}

/** The reason codes for 'cancel', 'reschedule', 'lost', 'noShow' or 'walkthroughOutcome'. */
export function funnelReasonCodes(kind) {
  const values = funnelDefinitions().reasonCodes[kind];
  if (!Array.isArray(values)) throw fail('funnel_definitions_unknown', `There is no reason-code list named ${kind}.`, 500);
  return values;
}

export const isFunnelReasonCode = (kind, code) => funnelReasonCodes(kind).includes(code);

/**
 * The grouping bucket of a metric dimension ('serviceLine' or 'funnelPath'):
 * the value when it is in the dimension's vocabulary, otherwise the missing
 * bucket, so a record without the dimension still counts in grouped totals.
 */
export function funnelDimensionValue(dimension, value) {
  const definitions = funnelDefinitions(), spec = Object.hasOwn(definitions.metricDimensions, dimension) ? definitions.metricDimensions[dimension] : null;
  if (!spec) throw fail('funnel_definitions_unknown', `There is no metric dimension named ${dimension}.`, 500);
  return definitionsPath(definitions, spec.values).includes(value) ? value : spec.missingBucket;
}

const lookupKey = value => typeof value === 'string' ? value.trim().toLowerCase() : '';
const lookup = (map, value) => { const wanted = lookupKey(value); const match = wanted && Object.keys(map).find(name => name.toLowerCase() === wanted); return match ? map[match] : null; };
// One value, or a list that decides only when every value the map knows gives the same answer (values it does not know are neutral).
const agreed = (map, values) => {
  const found = [...new Set((Array.isArray(values) ? values : [values]).map(value => lookup(map, value)).filter(Boolean))];
  return found.length === 1 ? found[0] : null;
};

/**
 * The service line a booking pre-fills (A1), from the first source in
 * serviceLineSources.precedence that decides it: {explicit, visitPurpose,
 * businessAccountId, catalogCategories (the catalog categories of the sold
 * lines; they decide only when they map to one line), relatedProjectServiceLine
 * (the recorded line of the project a repeat continues), ghlGarageHelpRequested
 * (the GHL field value), salesExitService ('garage' | 'junk',
 * sales-followup-exit.js), legacyJobType}. salesExitService and legacyJobType
 * may be lists (a legacy project's visits), deciding only when they agree.
 * Returns {serviceLine, source}; nothing decisive gives the missing bucket
 * ('unknown') with source null, and the booking asks for one tap.
 */
export function funnelServiceLine(inputs = {}) {
  const definitions = funnelDefinitions(), sources = definitions.serviceLineSources, lines = definitions.vocabularies.serviceLines;
  const missing = definitions.metricDimensions.serviceLine.missingBucket, given = plain(inputs) ? inputs : {};
  const decided = value => lines.includes(value) && value !== missing ? value : null;
  const decide = {
    explicit: () => decided(given.explicit),
    visitPurpose: () => lookup(sources.visitPurpose, given.visitPurpose),
    businessAccount: () => funnelHubId(given.businessAccountId) ? sources.businessAccount : null,
    catalogCategory: () => agreed(sources.catalogCategory, given.catalogCategories),
    relatedProject: () => decided(given.relatedProjectServiceLine),
    ghlGarageHelpRequested: () => lookup(sources.ghlGarageHelpRequested.values, given.ghlGarageHelpRequested),
    salesExitService: () => agreed(sources.salesExitService, given.salesExitService),
    legacyJobType: () => agreed(sources.legacyJobType, given.legacyJobType),
  };
  for (const source of sources.precedence) { const serviceLine = decide[source](); if (serviceLine) return { serviceLine, source }; }
  return { serviceLine: missing, source: null };
}

/**
 * The funnel path a booking pre-fills (FUN-29), from the first source in
 * funnelPathSources.precedence that decides it: {explicit, visitPurpose,
 * bookingChannel (one channel, or a list that decides only when the channels
 * that map give one path), recurringSeries (a recurring plan or a legacy visit
 * cadence), businessAccountId, walkthrough (the project was scoped or
 * sold on an on-site walkthrough), repeat (it continues an earlier project:
 * a repeat template, rebook request or previous project)}. Returns
 * {funnelPath, source}; nothing decisive gives {funnelPath: null, source: null}
 * (there is no unknown path; metrics bucket it with funnelDimensionValue) and the
 * booking asks for one tap.
 */
export function funnelPathFor(inputs = {}) {
  const definitions = funnelDefinitions(), sources = definitions.funnelPathSources, paths = definitions.vocabularies.funnelPaths, given = plain(inputs) ? inputs : {};
  const decide = {
    explicit: () => paths.includes(given.explicit) ? given.explicit : null,
    visitPurpose: () => lookup(sources.visitPurpose, given.visitPurpose),
    bookingChannel: () => agreed(sources.bookingChannel, given.bookingChannel),
    recurringSeries: () => given.recurringSeries === true ? sources.recurringSeries : null,
    businessAccount: () => funnelHubId(given.businessAccountId) ? sources.businessAccount : null,
    walkthrough: () => given.walkthrough === true ? sources.walkthrough : null,
    repeat: () => given.repeat === true ? sources.repeat : null,
  };
  for (const source of sources.precedence) { const funnelPath = decide[source](); if (funnelPath) return { funnelPath, source }; }
  return { funnelPath: null, source: null };
}

/** The version of the service-line and funnel-path derivation rules; projects record the version that derived their values. */
export const dimensionRulesVersion = () => funnelDefinitions().dimensionRulesVersion;

/** Coverage reasons for a period starting on a Denver date: pre_cutover_history until the cutover date is set and reached. */
export function cutoverCoverageReasons(fromDate) {
  if (typeof fromDate !== 'string' || !DATE.test(fromDate)) throw fail('funnel_definitions_invalid_date', 'Use a YYYY-MM-DD date.', 400);
  const cutover = funnelDefinitions().eventIntegrity.cutoverDate;
  return cutover !== null && fromDate >= cutover ? [] : ['pre_cutover_history'];
}

function result(exclusion, extra = {}) {
  const classes = funnelDefinitions().eligibility.exclusionClasses, kind = exclusion ? classes[exclusion] : null;
  return { eligible: !exclusion, exclusion: exclusion || null, isTest: kind === 'test', isInternal: kind === 'internal', ...extra };
}

/**
 * Hub record eligibility (jobs, walkthroughs, customers). Private records
 * (any recordType, or _egc_/secure_ ids) come first, then test flags, then
 * internal records with their reason. `internalReason` is null when the
 * record is internal without a recognised reason, which FUN-25 lists.
 */
export function hubRecordEligibility(record) {
  const rules = funnelDefinitions().eligibility.hub;
  if (!plain(record)) return result('private_record', { internalReason: null });
  const id = typeof record.id === 'string' ? record.id : '';
  if (record.recordType || rules.privateIdPrefixes.some(prefix => id.startsWith(prefix))) return result('private_record', { internalReason: null });
  if (rules.testFlags.some(flag => record[flag] === true)) return result('test', { internalReason: null });
  if (record[rules.internalFlag] === true) {
    const reason = record[rules.internalReasonField];
    return result('internal', { internalReason: rules.internalReasons.includes(reason) ? reason : null });
  }
  return result(null, { internalReason: null });
}

/** Every record field hubRecordEligibility reads, so masked Firestore scans fetch them all (the id comes from the document name). */
export function hubEligibilityFields() {
  const rules = funnelDefinitions().eligibility.hub;
  return [...new Set(['recordType', ...rules.testFlags, rules.internalFlag, rules.internalReasonField])];
}

/** A GHL tag or source folded for matching (eligibility.ghl.tagFolding): lowercase, each run of spaces, underscores and hyphens one hyphen, none at the ends. */
export const ghlTagKey = value => typeof value === 'string' ? value.toLowerCase().replace(/[\s_-]+/g, '-').replace(/^-|-$/g, '') : '';

/**
 * GHL contact eligibility: exclusion tags (folded, so 'EGC Test', 'egc_test'
 * and 'egc-test' match alike), exclusion flags set to true on the contact
 * (dnd, doNotContact, isVendor, isInternal, isTest...), the synthetic routing
 * source, and hiring-calendar contacts. The first match wins, in that order.
 * Accepts the GHL contact {tags, source, calendarId?, calendarIds?, ...flags}.
 */
export function ghlContactEligibility(contact) {
  const rules = funnelDefinitions().eligibility.ghl;
  const tags = Array.isArray(contact?.tags) ? contact.tags.map(ghlTagKey).filter(Boolean) : [];
  for (const [tag, code] of Object.entries(rules.exclusionTags)) if (tags.includes(tag)) return result(code, { tag });
  if (plain(contact)) for (const [flag, code] of Object.entries(rules.exclusionFlags)) if (Object.hasOwn(contact, flag) && contact[flag] === true) return result(code, { flag });
  const source = ghlTagKey(contact?.source);
  if (source && rules.syntheticSources.some(item => ghlTagKey(item) === source)) return result('synthetic_source');
  const calendars = [contact?.calendarId, ...(Array.isArray(contact?.calendarIds) ? contact.calendarIds : [])].filter(Boolean);
  if (calendars.some(id => rules.hiringCalendarIds.includes(id))) return result('hiring_calendar');
  return result(null);
}

/** Stripe eligibility: livemode false, or a test-mode id (cs_test_...). Unknown livemode is not test mode. */
export function stripeEligibility(object) {
  const rules = funnelDefinitions().eligibility.stripe;
  if (rules.requireLivemode && object?.livemode === false) return result('stripe_test_mode');
  const ids = ['id', 'sessionId', 'checkoutSessionId'].map(key => object?.[key]).filter(value => typeof value === 'string');
  if (ids.some(id => rules.testIdPrefixes.some(prefix => id.startsWith(prefix)))) return result('stripe_test_mode');
  return result(null);
}

/**
 * Combines the systems an event or metric touches: {hub, ghl, stripe}. The first
 * exclusion wins for `exclusion`; isTest/isInternal are true when any system
 * says so. Private Hub records are never eligible.
 */
export function funnelEligibility({ hub, ghl, stripe } = {}) {
  const checks = [hub !== undefined && hubRecordEligibility(hub), ghl !== undefined && ghlContactEligibility(ghl), stripe !== undefined && stripeEligibility(stripe)].filter(Boolean);
  const first = checks.find(check => !check.eligible) || null;
  return {
    eligible: !first, exclusion: first ? first.exclusion : null,
    isTest: checks.some(check => check.isTest), isInternal: checks.some(check => check.isInternal),
    internalReason: checks.find(check => check.internalReason)?.internalReason || null,
    exclusions: checks.filter(check => !check.eligible).map(check => check.exclusion),
  };
}

export const funnelHubId = value => typeof value === 'string' && HUB_ID.test(value) && !funnelDefinitions().eligibility.hub.privateIdPrefixes.some(prefix => value.startsWith(prefix));
