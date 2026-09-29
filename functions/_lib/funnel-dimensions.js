import { funnelDefinitions, funnelServiceLine, funnelPathFor, funnelDimensionValue, funnelHubId, dimensionRulesVersion } from './funnel-definitions.js';
import { salesExitService } from './sales-followup-exit.js';
import { included, normalizeLineItems } from './quote-model.js';
import { scheduleInterval } from './dispatch-time.js';
import { SEED_CATALOG_JSON } from '../_data/catalog-seed.js';

// FUN-29: the service line and funnel path of every project (§2.5). Both are
// set on projects/{projectId} when a booking creates the project, and refined
// when later evidence is better (a staff pick, a signed handoff, a B2B link).
// The rules are the shared funnel definitions (serviceLineSources,
// funnelPathSources, dimensionRulesVersion); this module only gathers their
// inputs from Hub records and writes the result:
//   serviceLine / funnelPath           the value, or null while undecided (never guessed);
//                                      serviceLine 'unknown' is a staff "Not sure yet"
//   serviceLineSource / funnelPathSource  the rule source that decided it ('explicit' = staff pick)
//   dimensionRulesVersion              the rules version that derived it
//   dimensionsUpdatedAt / dimensionsUpdatedBy
// Metrics group by the project's current values (projectDimensionBuckets, with
// the unknown bucket); booking and sale events carry the value at that moment.

export const DIMENSION_FIELDS = Object.freeze(['serviceLine', 'serviceLineSource', 'funnelPath', 'funnelPathSource', 'dimensionRulesVersion', 'dimensionsUpdatedAt', 'dimensionsUpdatedBy']);
const OPERATIONAL = new Set(['job', 'cleanout', 'reorg']);
// A legacy visit cadence (employee-suite booking wizard) is a recurring series.
const CADENCES = new Set(['weekly', 'biweekly', 'monthly', 'quarterly']);
const DIMENSIONS = [['serviceLine', 'serviceLineSource', 'serviceLines', 'serviceLineSources'], ['funnelPath', 'funnelPathSource', 'funnelPaths', 'funnelPathSources']];
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const missingLine = () => funnelDefinitions().metricDimensions.serviceLine.missingBucket;
const known = (list, value) => typeof value === 'string' && funnelDefinitions().vocabularies[list].includes(value);

let seedCategories = null;
/** The catalog category of a catalog item id in the bundled seed catalog; null for an item it does not list. */
export function seedCatalogCategory(itemId) {
  if (typeof itemId !== 'string' || !itemId) return null;
  if (!seedCategories) {
    try { seedCategories = new Map(JSON.parse(SEED_CATALOG_JSON).items.map(item => [item.id, item.category])); } catch { seedCategories = new Map(); }
  }
  return seedCategories.get(itemId) || null;
}

/** The catalog categories of the included lines that name a catalog item (P2-05 line items), sorted and unique. */
export function lineItemCatalogCategories(lineItems, categoryOf = seedCatalogCategory) {
  if (!Array.isArray(lineItems) || !lineItems.length) return [];
  const lines = normalizeLineItems(lineItems).lineItems.filter(line => included(line) && line.catalog?.itemId);
  return [...new Set(lines.map(line => categoryOf(line.catalog.itemId)).filter(value => typeof value === 'string' && value))].sort();
}

// The lead-form answer that gives a service line (serviceLineSources.ghlGarageHelpRequested.values), or null.
const ghlAnswer = line => typeof line === 'string' && Object.entries(funnelDefinitions().serviceLineSources.ghlGarageHelpRequested.values).find(([, value]) => value === line)?.[0] || null;

/**
 * The one-tap picks a booking may carry: {serviceLine, funnelPath}, each null
 * when not given. A serviceLine sent with serviceLineSuggested:true is the
 * Facebook lead-form suggestion the staff member left untouched, not their pick:
 * it is returned as serviceLineSuggestion and ranks as the
 * ghlGarageHelpRequested rule, so sold evidence can still refine it.
 * `fail(reason, message)` builds the caller's error.
 */
export function dimensionPicks(booking, fail) {
  const vocab = funnelDefinitions().vocabularies;
  const pick = (name, list, label) => {
    const value = booking?.[name];
    if (value === undefined || value === null || value === '') return null;
    if (typeof value !== 'string' || !list.includes(value)) throw fail('booking_invalid', `Choose a valid ${label}.`);
    return value;
  };
  const serviceLine = pick('serviceLine', vocab.serviceLines, 'service line'), funnelPath = pick('funnelPath', vocab.funnelPaths, 'funnel path'), suggested = booking?.serviceLineSuggested;
  if (![undefined, false, true].includes(suggested) || suggested === true && !ghlAnswer(serviceLine)) throw fail('booking_invalid', 'The suggested service line is not one the lead form gives. Choose the service line.');
  return suggested === true ? { serviceLine: null, funnelPath, serviceLineSuggestion: serviceLine } : { serviceLine, funnelPath };
}

/**
 * The rule inputs one visit gives. `relatedProject` is the project a repeat
 * continues (a recurring or repeat template's project); `walkthroughSale` marks a
 * job sold on a signed walkthrough handoff; `lineItems` are sold lines not yet
 * on the visit (a handoff's signed lines).
 */
export function visitDimensionFacts(visit, { relatedProject = null, walkthroughSale = false, lineItems = null, categoryOf = seedCatalogCategory } = {}) {
  const row = plain(visit) ? visit : {}, kind = row.type === 'walkthrough' ? 'walkthrough' : OPERATIONAL.has(row.type) ? 'job' : null;
  return {
    visitPurpose: row.visitPurpose ?? null, bookingChannel: row.bookingChannel ?? null, businessAccountId: row.businessAccountId || null,
    catalogCategories: lineItemCatalogCategories(Array.isArray(lineItems) ? lineItems : row.estimate?.lineItems, categoryOf),
    relatedProjectServiceLine: relatedProject?.serviceLine ?? null,
    // A walkthrough's own service name ('Free garage walkthrough') names the visit, not the work sold.
    salesExitService: kind === 'job' ? salesExitService(row) : '',
    legacyJobType: typeof row.type === 'string' ? row.type : null,
    recurringSeries: funnelHubId(row.recurringPlanId) || CADENCES.has(row.recurrence),
    walkthrough: kind === 'walkthrough' || funnelHubId(row.sourceWalkthroughId) || walkthroughSale === true,
    repeat: funnelHubId(row.sourceTemplateJobId) || funnelHubId(row.sourceRebookingRequestId) || funnelHubId(relatedProject?.id),
  };
}

/**
 * The legacy mapping (FUN-04 and scripts/backfill-project-dimensions.mjs): the
 * rule inputs of a project saved before FUN-29, from its own fields and every
 * visit on it, under the same rules as a live booking. A fact the visits
 * disagree on (two service names, two business accounts) decides nothing.
 * `related` is the project named by previousProjectId. The GHL field is not a
 * Hub record, so the legacy mapping never uses it.
 */
export function legacyDimensionFacts(project, visits = [], { related = null, categoryOf = seedCatalogCategory } = {}) {
  const rows = (Array.isArray(visits) ? visits : []).filter(plain), facts = rows.map(row => visitDimensionFacts(row, { categoryOf }));
  const accounts = [...new Set(facts.map(fact => fact.businessAccountId).filter(Boolean))];
  return {
    visitPurpose: facts.some(fact => fact.visitPurpose === 'member_visit') ? 'member_visit' : null,
    bookingChannel: facts.map(fact => fact.bookingChannel).filter(Boolean),
    businessAccountId: accounts.length === 1 ? accounts[0] : null,
    catalogCategories: [...new Set(facts.flatMap(fact => fact.catalogCategories))].sort(),
    relatedProjectServiceLine: related?.serviceLine ?? null,
    salesExitService: facts.map(fact => fact.salesExitService).filter(Boolean),
    legacyJobType: rows.map(row => row.type).filter(type => typeof type === 'string'),
    recurringSeries: facts.some(fact => fact.recurringSeries),
    walkthrough: funnelHubId(project?.sourceWalkthroughId) || facts.some(fact => fact.walkthrough),
    repeat: funnelHubId(project?.previousProjectId) || facts.some(fact => fact.repeat),
  };
}

/**
 * The service line and funnel path the shared rules give: a staff pick wins,
 * then the first deciding source. An undecided dimension is null. A staff pick of
 * 'unknown' ("Not sure yet") is recorded as the explicit unknown bucket when no
 * other source decides. An untouched lead-form suggestion
 * (picks.serviceLineSuggestion) is the ghlGarageHelpRequested fact.
 */
export function resolveDimensions(facts = {}, picks = {}) {
  const missing = missingLine(), given = plain(facts) ? facts : {}, answer = ghlAnswer(picks?.serviceLineSuggestion);
  const line = funnelServiceLine({ ...given, ...(answer ? { ghlGarageHelpRequested: answer } : {}), explicit: picks?.serviceLine }), path = funnelPathFor({ ...given, explicit: picks?.funnelPath });
  const unknownPick = !line.source && picks?.serviceLine === missing;
  return { serviceLine: line.source ? line.serviceLine : unknownPick ? missing : null, serviceLineSource: line.source || (unknownPick ? 'explicit' : null), funnelPath: path.funnelPath, funnelPathSource: path.source };
}

/**
 * The project fields for resolved dimensions. A new project (project null) gets
 * every field. An existing project changes only where the new evidence is better:
 * an undecided value (null, 'unknown' or a value the rules no longer know) takes
 * any decided one; a staff pick replaces a different value; a derived value
 * replaces a different derived value from a source lower in the precedence; only
 * a staff pick replaces a staff pick. 'unknown' never replaces a decided value.
 * Returns the patch, or null when nothing changes.
 */
export function projectDimensionPatch(project, resolved, { actor, now }) {
  const stamp = { dimensionRulesVersion: dimensionRulesVersion(), dimensionsUpdatedAt: now, dimensionsUpdatedBy: actor };
  if (!project) return { serviceLine: resolved.serviceLine ?? null, serviceLineSource: resolved.serviceLineSource ?? null, funnelPath: resolved.funnelPath ?? null, funnelPathSource: resolved.funnelPathSource ?? null, ...stamp };
  const definitions = funnelDefinitions(), missing = missingLine(), patch = {};
  for (const [field, sourceField, list, rules] of DIMENSIONS) {
    const value = resolved[field] ?? null, source = resolved[sourceField] ?? null, stored = project[field] ?? null, storedSource = project[sourceField] ?? null;
    if (value === null || value === stored) continue;
    const rank = name => { const index = definitions[rules].precedence.indexOf(name); return index < 0 ? Infinity : index; };
    const decided = known(list, stored) && stored !== missing;
    const replace = decided ? value !== missing && (source === 'explicit' || storedSource !== 'explicit' && rank(source) < rank(storedSource)) : value !== missing || stored === null;
    if (replace) Object.assign(patch, { [field]: value, [sourceField]: source });
  }
  return Object.keys(patch).length ? { ...patch, ...stamp } : null;
}

/** The dimensions a funnel event records from a project: only values the shared vocabularies know. */
export function eventDimensions(project) {
  return { ...(known('serviceLines', project?.serviceLine) ? { serviceLine: project.serviceLine } : {}), ...(known('funnelPaths', project?.funnelPath) ? { funnelPath: project.funnelPath } : {}) };
}

/** The metric buckets of a project: its values, or the unknown bucket, so every grouped total still adds up. */
export function projectDimensionBuckets(project) {
  return { serviceLine: funnelDimensionValue('serviceLine', project?.serviceLine), funnelPath: funnelDimensionValue('funnelPath', project?.funnelPath) };
}

/** The project dimensions after a commit that may carry a project write: the pending patch over the saved row. */
export function pendingProjectDimensions(project, writes, projectId) {
  const write = (Array.isArray(writes) ? writes : []).find(item => item.collection === 'projects' && item.id === projectId && !item.verify);
  return eventDimensions({ ...(project || {}), ...(write?.patch || {}) });
}

/**
 * FUN-29 for a dispatch schedule.create. The project the visit creates
 * (`projectWrite`, its create-only write) gets every field; a project the visit
 * joins (a walkthrough's or a reworked job's) is refined under a revision check
 * by one added write. `picks` are the staff one-tap picks; `facts` carries a
 * wrapping caller's extra evidence ({walkthroughSale, lineItems}; dispatch reads it
 * from store.dimensionFacts, as walkthrough-handoff.js sets it). Returns the project's
 * dimensions after the commit, for the booking event.
 */
export async function bookingDimensions(store, { picks = {}, visit, project = null, projectWrite = null, template = null, facts = {}, actor, now, writes }) {
  const related = template && funnelHubId(template.projectId) && template.projectId !== visit.projectId ? await store.read('projects', template.projectId) : null;
  const resolved = resolveDimensions(visitDimensionFacts(visit, { relatedProject: related, walkthroughSale: facts?.walkthroughSale === true, lineItems: facts?.lineItems ?? null }), picks || {});
  if (projectWrite) { Object.assign(projectWrite.patch, projectDimensionPatch(null, resolved, { actor, now })); return eventDimensions(projectWrite.patch); }
  if (!project) return {};
  const patch = projectDimensionPatch(project, resolved, { actor, now });
  if (patch) writes.push({ collection: 'projects', id: project.id, revision: project.revision, patch: { ...patch, updatedAt: now } });
  return eventDimensions({ ...project, ...patch });
}

/** The project dimensions for a visit an update places on the calendar for the first time (its booking event); null otherwise. */
export async function firstPlacementDimensions(store, before, after) {
  const placed = value => Boolean(value && scheduleInterval(value));
  if (!before || placed(before) || !placed(after) || Number.isInteger(before.scheduleOccurrence) && before.scheduleOccurrence > 0 || !funnelHubId(after.projectId)) return null;
  return eventDimensions(await store.read('projects', after.projectId));
}

/** The value of the GHL contact field "Facebook - Garage Help Requested" (serviceLineSources.ghlGarageHelpRequested.fieldId), or null. */
export function ghlGarageHelpRequested(contact) {
  const fieldId = funnelDefinitions().serviceLineSources.ghlGarageHelpRequested.fieldId;
  const field = (Array.isArray(contact?.customFields) ? contact.customFields : []).find(item => plain(item) && item.id === fieldId);
  const value = [field?.value, field?.fieldValue, field?.field_value].find(item => typeof item === 'string' && item.trim());
  return value ? value.trim().slice(0, 200) : null;
}

/**
 * Reads the GHL field for the booking pre-fill, only when
 * FUNNEL_GHL_SERVICE_LINE_PREFILL_ENABLED is exactly "true". A read-only
 * contact lookup verified against the connected location; any failure is
 * 'unavailable', never an error, because the pre-fill only suggests a pick.
 */
export async function ghlServiceLineSuggestion(env, contactId, fetcher = fetch) {
  if (env?.FUNNEL_GHL_SERVICE_LINE_PREFILL_ENABLED !== 'true') return { status: 'disabled', value: null };
  const token = env.HIGHLEVEL_API_KEY || env.GHL_API_KEY, locationId = env.HIGHLEVEL_LOCATION_ID || env.GHL_LOCATION_ID;
  if (!token || !locationId || typeof contactId !== 'string' || !/^[A-Za-z0-9_-]{1,120}$/.test(contactId)) return { status: 'unavailable', value: null };
  try {
    const response = await fetcher(`https://services.leadconnectorhq.com/contacts/${encodeURIComponent(contactId)}`, { headers: { Accept: 'application/json', Authorization: `Bearer ${token}`, Version: 'v3' }, signal: AbortSignal.timeout(5000) });
    if (!response.ok) return { status: 'unavailable', value: null };
    const contact = (await response.json().catch(() => ({})))?.contact;
    if (!contact || contact.id !== contactId || contact.locationId !== locationId) return { status: 'unavailable', value: null };
    const answer = ghlGarageHelpRequested(contact), decided = answer ? funnelServiceLine({ ghlGarageHelpRequested: answer }) : null;
    return { status: 'ok', value: decided?.source ? decided.serviceLine : null };
  } catch { return { status: 'unavailable', value: null }; }
}

const PREFILL_KEYS = ['customerId', 'kind', 'visitPurpose', 'channel', 'reworkOfJobId', 'serviceType', 'suggest'];
/**
 * The pre-fill the Dispatch create form shows (GET /api/funnel-dimensions): what
 * a schedule.create with these facts records on the project without a staff
 * pick (the same facts and rules), and whether the one-tap pick is required
 * (nothing decides the value, or the project holds "Not sure yet"). A rework
 * shows the project it joins. `ghl(contactId)` may suggest a service line from
 * the GHL field when nothing on file decides it; the form sends a suggestion it
 * leaves untouched as booking.serviceLineSuggested, recorded under the
 * lead-form rule rather than as a staff pick. suggest=false skips the GHL read
 * (the form already holds this customer's answer): ghl is then 'skipped'.
 */
export async function bookingDimensionPrefill(store, query, { ghl = null, now } = {}) {
  const fail = (code, message, status = 400) => Object.assign(new Error(message), { code: `funnel_dimensions_${code}`, status });
  if (!plain(query) || Object.keys(query).some(key => !PREFILL_KEYS.includes(key)) || !funnelHubId(query.customerId) || !['job', 'walkthrough'].includes(query.kind) || ![undefined, 'false'].includes(query.suggest)) throw fail('query_invalid', 'Choose a customer and a work type.');
  const customer = await store.read('customers', query.customerId);
  if (!customer) throw fail('customer_not_found', 'This customer no longer exists. Search again.', 404);
  const vocab = funnelDefinitions().vocabularies, missing = missingLine();
  const visit = { type: query.kind, visitPurpose: query.kind === 'walkthrough' ? 'walkthrough' : vocab.visitPurposes.includes(query.visitPurpose) && query.visitPurpose !== 'walkthrough' ? query.visitPurpose : 'service',
    bookingChannel: vocab.bookingChannels.includes(query.channel) ? query.channel : null, serviceType: typeof query.serviceType === 'string' ? query.serviceType.slice(0, 200) : '' };
  let project = null;
  // A rework joins the project of the job it reworks, exactly as dispatch resolves it.
  if (visit.visitPurpose === 'rework' && funnelHubId(query.reworkOfJobId)) {
    const rework = await store.read('jobs', query.reworkOfJobId);
    const projectId = rework && OPERATIONAL.has(rework.type) && !rework.recordType && rework.customerId === customer.id ? rework.projectId || `project_${funnelHubId(rework.sourceWalkthroughId) ? rework.sourceWalkthroughId : rework.id}` : null;
    project = funnelHubId(projectId) ? await store.read('projects', projectId) : null;
    if (project?.customerId !== customer.id) project = null;
  }
  const resolved = resolveDimensions(visitDimensionFacts(visit), {});
  const effective = project ? { ...project, ...(projectDimensionPatch(project, resolved, { actor: 'prefill', now }) || {}) } : resolved;
  const line = known('serviceLines', effective.serviceLine) ? effective.serviceLine : null, path = known('funnelPaths', effective.funnelPath) ? effective.funnelPath : null;
  const lineRequired = line === null || line === missing;
  const suggestion = !lineRequired ? { status: 'not_needed', value: null } : query.suggest === 'false' ? { status: 'skipped', value: null } : typeof ghl === 'function' && customer.highlevelContactId ? await ghl(customer.highlevelContactId) : { status: 'not_needed', value: null };
  return { ok: true, customerId: customer.id, kind: query.kind, projectId: project?.id || null, rulesVersion: dimensionRulesVersion(),
    serviceLine: { value: line, source: line ? effective.serviceLineSource ?? null : null, required: lineRequired, suggestion: known('serviceLines', suggestion.value) && suggestion.value !== missing ? suggestion.value : null },
    funnelPath: { value: path, source: path ? effective.funnelPathSource ?? null : null, required: path === null }, ghl: suggestion.status };
}
