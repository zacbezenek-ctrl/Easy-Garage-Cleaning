import { mutateDispatch } from './dispatch-service.js';
import { saveJobReads } from './dispatch-window-reads.js';
import { requireQuoteAuthor } from './quote-permissions.js';
import { authorCustomer, fullCustomerAccess, walkthroughVisible, jobCustomerAccess, jobRef, maskedCustomer, refPatch, restrictedAuthor, shownCustomerId } from './estimator-customer-access.js';
import { assignmentKey, jobCrewNames } from './job-assignment.js';
import { localInstant } from './operations-portal-records.js';
import { customerIdentityPatch } from './customer-identity.js';
import { suggestedDurationMinutes } from './quote-duration.js';
import { depositCents as depositOf, estimateTotals, included, normalizeLineItems, toWalkthroughLineItem, validateSelection, walkthroughGarageWork, withoutPurchaseFields } from './quote-model.js';
import { funnelEventWrite } from './funnel-events.js';
import { saleWrites } from './job-funnel-events.js';
import { funnelHubId } from './funnel-definitions.js';
import { instantMs } from './funnel-calendar.js';
import { validDate } from './dispatch-time.js';
import { eventActor } from './dispatch-funnel.js';
import { pendingProjectDimensions } from './funnel-dimensions.js';
import { stripCrewMoney, stripCrewMoneyDeep } from './crew-money.js';
import { staffRoleAccessEnabled } from './staff-roles.js';
import { bringList, bringListMaterials, breakdownMaterials, handoffEquipment, handoffJobMaterials, jobMaterialsEnabled, quoteLineMaterials, savedBringList, soldMaterials } from './job-materials.js';
import { breakdownLines, jobBreakdown } from './job-breakdown.js';
import { crewAutoAssignEnabled, projectCrewOpenings } from './dispatch-crew-assign.js';
import { dispatchOpenings } from './dispatch-openings.js';
import { catalogStorage, quoteBuilderEnabled, readCompositeState, requireCatalogOwner } from './catalog-store.js';
import { GARAGE_SIZES, approvalRefusal, compositeApproval, compositeScope, fullnessOf, priceCompositeQuote } from './composite-quote.js';
import { customerMoneyTotals } from './money-core.js';
import { hasWinterSaleLine, signedWinterSale, winterSaleReaders } from './winter-sale.js';
import { confirmNearbyTruck, pickupReaders, savedOwnerWaiver, waiverAudit, waiverRecord } from './pickup-minimum.js';
import { auditWrite } from './hub-audit.js';
import { PAYMENT_TIME_ZONE, SIGNED_25_75, businessPaymentDate, quotePaymentDates, quotePaymentSchedule } from './quote-payment-policy.js';

// FIX-CREW-PRICE-LEAK: every crew-visible copy of the brief is written without currency amounts.
export { stripCrewMoney };

const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const safeId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,180}$/.test(value) && !/^(secure_|_egc_)/.test(value);
const requestId = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const fail = (code, message, status = 409) => Object.assign(new Error(message), { code: `handoff_${code}`, status });
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : plain(value) ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value);
const hash = async value => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical(value))))].map(byte => byte.toString(16).padStart(2, '0')).join('');
const phone = value => String(value || '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
const email = value => String(value || '').trim().toLowerCase();
const state = job => String(job?.pipelineStatus || job?.status || '').toLowerCase();
const operational = job => job && !job.recordType && ['job', 'cleanout', 'reorg'].includes(job.type);
// Service addresses compare by their words, ignoring case, spacing and punctuation.
const addressKey = value => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const sameAddress = (next, saved) => addressKey(next) === addressKey(saved);
const customerProjection = row => row ? Object.fromEntries(['id', 'name', 'phone', 'email', 'address', 'highlevelContactId'].map(key => [key, row[key] || ''])) : null;
// The jobs a quote author who is not a dispatcher may open or revise (P2-12): a
// quote draft, the job of the walkthrough being handed off, or a job they
// created. Every other job stays with Dispatch. An estimator (restricted:
// estimator-customer-access.js) opens only a quote draft they started or saved, and
// reaches a job through its walkthrough only when that walkthrough is theirs
// (sourceOk: assigned to them or started by them).
const ownDraft = (job, actor) => assignmentKey(job.quoteDraft.createdBy) === assignmentKey(actor.user) && Boolean(assignmentKey(actor.user)) || Boolean(jobRef(job, actor));
const authorsJob = (job, source, actor, restricted = false, sourceOk = false) => plain(job?.quoteDraft) && (!restricted || ownDraft(job, actor)) || Boolean(source) && job.sourceWalkthroughId === source.id && (!restricted || sourceOk) || Boolean(job?.createdBy) && job.createdBy === actor.user;
// DISPATCH-RULES: a quote author who is not a dispatcher never sees the roster
// (prepareHandoff), so the Dispatch rows of a save (its warnings, replayed or
// fresh, and a refusal's details.conflicts) reach them as a code and a message
// that names no employee and shows no other job, time off or workload. A row
// whose message is fixed text keeps it; the per-employee rules get name-free
// text; any other row gets a generic line. Dispatchers keep the full rows.
const AUTHOR_TEXT = {
  outside_working_hours: row => `An assigned employee does not work at this time${validDate(row.date) ? ` (${row.date})` : ''}.`,
  employee_daily_capacity: row => `An assigned employee would pass the owner's daily limit${validDate(row.date) ? ` on ${row.date}` : ''}.`,
  travel_buffer_short: () => 'An assigned employee may not have enough travel time between this job and other work.',
};
// The crew auto-assign rows (EGC_DISPATCH_CREW_AUTO_ASSIGN) name a crew and a date, never an employee, and the
// builder's pending-price row names menu items only.
const AUTHOR_FIXED = new Set(['crew_size_short', 'skill_missing', 'schedule_overlap', 'employee_unavailable', 'unverifiable_assignment', 'legacy_blocked_day', 'unassigned', 'missing_crew_lead', 'segment_unassigned', 'inactive_assignment', 'vehicle_unavailable', 'missing_address', 'missing_customer_link', 'missing_scope', 'invalid_schedule', 'unscheduled', 'segments_invalid', 'provider_sync_pending', 'customer_memory_not_inherited', 'arrival_window_reset', 'checkout_needs_review', 'crew_assignment_ignored', 'sold_needs_crew',
  'no_crew_available', 'crew_choice_unavailable', 'crew_off_day', 'prices_pending_approval']);
export function authorRuleRows(rows) {
  return (Array.isArray(rows) ? rows : []).filter(plain).map(row => {
    const code = typeof row.code === 'string' ? row.code : '';
    const message = Object.hasOwn(AUTHOR_TEXT, code) ? AUTHOR_TEXT[code](row) : AUTHOR_FIXED.has(code) && typeof row.message === 'string' ? row.message : 'Dispatch will review this job.';
    return { code, message };
  });
}

function text(value, label, max = 4000, required = false) {
  if (typeof value !== 'string' || value.length > max || required && !value.trim()) throw fail('invalid_plan', `${label} is missing or too long.`, 400);
  return value.trim();
}
function cents(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1000000 || Math.abs(value * 100 - Math.round(value * 100)) > 0.00001) throw fail('invalid_amount', `${label} must be an agreed amount in dollars and cents.`, 400);
  return Math.round(value * 100);
}
function descriptiveData(value, depth = 0) {
  if (depth > 6) throw fail('invalid_plan', 'The scope is too deeply nested.', 400);
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') return text(value, 'Scope text', 10000);
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value) && value.length <= 100) return value.map(item => descriptiveData(item, depth + 1));
  if (plain(value) && Object.keys(value).length <= 80 && !Object.keys(value).some(key => ['__proto__', 'constructor', 'prototype'].includes(key))) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, descriptiveData(item, depth + 1)]));
  throw fail('invalid_plan', 'The scope contains an unsupported value.', 400);
}
function checks(value) {
  if (!plain(value)) throw fail('invalid_checklist', 'The customer-specific crew checklist is required.', 400);
  const output = { version: '2026-09-client-v1' };
  for (const key of ['preJob', 'postJob']) {
    if (!Array.isArray(value[key]) || value[key].length > 80) throw fail('invalid_checklist', 'The crew checklist could not be verified.', 400);
    const ids = new Set();
    output[key] = value[key].map(item => {
      if (!plain(item) || typeof item.id !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(item.id) || ['__proto__', 'constructor', 'prototype'].includes(item.id) || ids.has(item.id)) throw fail('invalid_checklist', 'Every crew check needs its own valid identity.', 400);
      ids.add(item.id);
      return { id: item.id, label: stripCrewMoney(text(item.label, 'Checklist label', 500, true)), detail: stripCrewMoney(text(item.detail || '', 'Checklist detail', 1000)), critical: item.critical === true, required: true };
    });
  }
  return output;
}
const dollars = cents => Number.isSafeInteger(cents) ? `${cents < 0 ? '-' : ''}$${(Math.abs(cents) / 100).toFixed(2)}` : 'an unknown amount';
// A plan without line items keeps today's single signed line. An itemized plan
// is read strictly through the canonical quote model and its selected lines
// must equal the signed total; a manual price change is an explicit line.
// A builder quote (EGC_QUOTE_BUILDER_ENABLED) is signed with the server's own
// priced lines and pricing-menu version (builder: priceCompositeQuote's result).
// purchase (EGC_JOB_MATERIALS or EGC_QUOTE_BUILDER_ENABLED): a line may carry the
// purchase fields (quote-model.js PURCHASE_LINE_FIELDS), read strictly; they say
// what the crew buys (the job's materials) and the signed estimate stores the
// lines without them. Off, they are unknown fields exactly as before.
function itemizedQuote(quote, totalCents, crewSize, minutes, builder = null, purchase = false) {
  if (builder) quote = { ...quote, line_items: builder.lineItems, catalog_version: builder.menuVersion };
  if (quote.line_items === undefined || quote.line_items === null) return null;
  if (!Array.isArray(quote.line_items) || !quote.line_items.length) throw fail('invalid_line_items', 'An itemized quote needs at least one line item.', 400);
  let lineItems;
  try { ({ lineItems } = normalizeLineItems(quote.line_items, { strict: true, purchase })); }
  catch (error) { if (/^quote_/.test(error?.code || '')) throw fail('invalid_line_items', `The itemized quote is invalid: ${error.message}`, 400); throw error; }
  if (lineItems.some(line => line.kind === 'tip')) throw fail('invalid_line_items', 'A signed quote cannot include a tip line.', 400);
  const adjustment = lineItems.find(line => line.id === 'adjustment');
  if (adjustment && (!['fee', 'discount'].includes(adjustment.kind) || adjustment.optional || adjustment.group || adjustment.quantity !== 1 || adjustment.description.length < 3)) throw fail('invalid_adjustment', 'A manual price change must be one required adjustment line (a fee or discount, quantity 1) that states the reason the customer approved.', 400);
  const selection = validateSelection(lineItems);
  if (!selection.ok) throw fail('invalid_line_items', `The itemized quote is invalid: ${selection.issues[0].message}`, 400);
  const totals = estimateTotals(lineItems);
  if (!totals.complete || totals.totalCents !== totalCents) throw fail('invalid_amount', `The selected line items come to ${dollars(totals.totalCents)}, but the signed total is ${dollars(totalCents)}. Record any manual price change as an adjustment line with its reason.`, 400);
  const version = quote.catalog_version ?? '';
  if (version !== '' && !(builder && version === builder.menuVersion) && !(Number.isSafeInteger(version) && version >= 1) && !(typeof version === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(version))) throw fail('invalid_plan', 'The catalog version is invalid.', 400);
  const suggestion = suggestedDurationMinutes(lineItems, { crewSize, job: { estimatedDurationMin: minutes } }), reason = text(quote.duration_override_reason ?? '', 'Duration override reason', 500);
  const overridden = suggestion.source === 'line_items' && suggestion.minutes !== minutes;
  if (overridden && !reason) throw fail('invalid_duration', `The selected line items suggest ${suggestion.minutes} minutes on site. Use that estimate or record the manager's reason for overriding it.`, 400);
  const sold = lineItems.filter(included);
  return { line_items: sold.map(toWalkthroughLineItem), line_items_count: sold.length, itemized: true, catalog_version: version === '' ? null : version, estimate_line_items: purchase ? lineItems.map(withoutPurchaseFields) : lineItems,
    duration_suggestion: { minutes: suggestion.minutes, source: suggestion.source }, duration_override_reason: overridden ? reason : '' };
}
const LABELS = { cleanout: 'Garage cleanout and reset', deep_clean: 'Deep clean', pressure_wash: 'One-car garage pressure wash', mouse_trapping: 'Non-toxic mouse trapping' };
/** Customer-facing estimate scope built only from the sold finish options;
 * internal notes, discovery and crew instructions never reach it. */
export function customerScopeSummary(scope) {
  const finish = Array.isArray(scope?.finish) ? scope.finish : [], details = plain(scope?.finish_details) ? scope.finish_details : {};
  const count = (qty, label, fallback) => Number.isInteger(qty) && qty > 0 ? `${qty} ${label}${qty === 1 ? '' : 's'}` : fallback;
  const shelf = ['metal', 'wood', 'plastic'].includes(details.shelf_type) ? `${details.shelf_type} ` : '';
  const items = [...new Set(finish)].map(id => id === 'shelving' ? count(details.shelf_qty, `${shelf}shelving unit`, 'Shelving') : id === 'totes' ? count(details.tote_qty, 'storage tote', 'Storage totes') : LABELS[id] || '').filter(Boolean);
  if (plain(scope?.hazard_details?.pest_waste)) items.push('Pest-waste cleanup');
  return `Included: ${(items.length ? items : [LABELS.cleanout]).join('; ')}.`;
}
/**
 * D-JUNK: the garage work a signed walkthrough records beyond junk removal (quote-model.js walkthroughGarageWork, with
 * its rule). A junk-only builder quote ($1,000 per truck, no Labor line) prices none of it, so it is signed only on a
 * walkthrough that records none of it (saveWalkthroughHandoff, handoff_builder_junk_only_garage_work), and sent only on
 * one whose saved capture records none (quote-draft.js). The walkthrough page (crew/gameplan.html walkthroughGarageWork)
 * applies the same rule before the homeowner signs.
 */
export { walkthroughGarageWork };
/** Dispatch materials the crew loads for the sold product lines. A builder quote's products are its breakdown's packs
 * (job-materials.js breakdownMaterials), by product and in units, rather than one rolled-up goods line per step. */
export function handoffMaterials(plan, builder = null) {
  const built = builder ? breakdownMaterials(builder.breakdown).map(item => ({ id: item.id, name: item.name, quantity: item.quantity })) : [];
  if (built.length) return built;
  return plan.quote.itemized ? plan.quote.estimate_line_items.filter(line => included(line) && line.kind === 'product' && !line.customerSupplied).map(line => ({ id: `quote-${line.id}`, name: line.name, quantity: line.quantity })) : [];
}
// Materials added in Dispatch survive a signed revision; quote-derived ones are
// replaced (and removed when the new plan is not itemized). A list Dispatch
// could not re-validate is left untouched rather than failing the handoff; the
// checks mirror dispatch-service's materials rules.
const material = item => plain(item) && safeId(item.id) && typeof item.name === 'string' && item.name.length <= 200 && item.name.trim() && typeof item.quantity === 'number' && Number.isFinite(item.quantity) && item.quantity > 0 && item.quantity <= 100000;
function materialChanges(plan, existing, builder = null) {
  const list = Array.isArray(existing) ? existing : [], kept = list.filter(item => !String(item?.id || '').startsWith('quote-')), quoted = handoffMaterials(plan, builder);
  if (!quoted.length && kept.length === list.length) return {};
  const materials = [...kept.map(item => plain(item) ? { id: item.id, name: item.name, quantity: item.quantity } : item), ...quoted];
  return materials.length <= 100 && materials.every(material) && new Set(materials.map(item => item.id)).size === materials.length ? { materials } : {};
}
// EGC_JOB_MATERIALS: the sold products become buy/stock materials with their purchase state, and the bring list
// becomes stock materials (kit-) the crew grabs; both are regenerated on a revision, Dispatch's own entries are kept
// as they are, and a purchase the office recorded stays with the same product (job-materials.js handoffJobMaterials).
// A plan without a bring list (equipment null: a gameplan page from before it was sent) keeps the grab list saved earlier.
// A builder quote's products come from its priced breakdown (packs, SKU, store and product page per product).
function structuredMaterialChanges(plan, existing, equipment, builder = null) {
  const list = Array.isArray(existing) ? existing : [], quoted = builder ? soldMaterials(plan.quote.estimate_line_items, builder.breakdown) : plan.quote.itemized ? quoteLineMaterials(plan.quote.estimate_line_items) : [];
  const kit = equipment === null ? list.filter(item => /^kit-/.test(String(item?.id || ''))) : bringListMaterials(equipment);
  if (!quoted.length && !kit.length && !list.some(item => /^(?:quote|kit)-/.test(String(item?.id || '')))) return {};
  const materials = handoffJobMaterials({ previous: list, quoted, kit });
  return materials ? { materials } : {};
}
// EGC_JOB_MATERIALS off: the bring list every current gameplan page sends is dropped before the plan is read, so the
// job, its accepted payload and the handoff receipt store exactly the plan they stored before the page sent it.
const withoutBringList = input => plain(input) && plain(input.logistics) && Object.hasOwn(input.logistics, 'bring_list') ? { ...input, logistics: Object.fromEntries(Object.entries(input.logistics).filter(([key]) => key !== 'bring_list')) } : input;
// EGC_DISPATCH_CREW_AUTO_ASSIGN: logistics.crew_id is the crew the estimator chose from the crew openings. It is a
// request to Dispatch (options.crewChoice), not part of the signed scope, so it is read and removed before the plan is.
const withoutCrewChoice = input => plain(input) && plain(input.logistics) && Object.hasOwn(input.logistics, 'crew_id') ? { ...input, logistics: Object.fromEntries(Object.entries(input.logistics).filter(([key]) => key !== 'crew_id')) } : input;
// Dispatch's refusals of a chosen crew (dispatch-service.js schedulePatch and autoCrewPlan).
const CHOICE_REFUSALS = new Set(['dispatch_crew_not_eligible', 'dispatch_crew_inactive', 'dispatch_employee_inactive', 'dispatch_lead_not_assigned', 'dispatch_resource_invalid']);
function requestedCrew(input) {
  const value = plain(input?.logistics) ? input.logistics.crew_id : undefined;
  if (value === undefined || value === null || value === '') return null;
  if (!safeId(value)) throw fail('invalid_plan', 'The chosen crew is invalid. Choose a crew opening again or leave the crew to Dispatch.', 400);
  return value;
}
// EGC_QUOTE_BUILDER_ENABLED: a builder quote's lines and menu version are the server's, so the browser's are set
// aside before the rest of the plan is read and compared with the server's prices afterwards (builderMismatch).
const withoutQuoteLines = input => plain(input) && plain(input.quote) ? { ...input, quote: Object.fromEntries(Object.entries(input.quote).filter(([key]) => !['line_items', 'catalog_version', 'composite_pricing'].includes(key))) } : input;
// What a builder line shows the customer; the browser's copy must equal the server's on each.
const SIGNED_LINE = ['id', 'kind', 'name', 'quantity', 'unitCents', 'totalCents'];
const signedLines = lines => lines.filter(included).map(line => SIGNED_LINE.map(key => line[key]));
function builderMismatch(quote, priced, signedCents) {
  const refusal = () => Object.assign(fail('builder_price_mismatch', `The signed quote does not match the quote builder's prices on the server: this selection comes to ${dollars(priced.totalCents)}. Review the quote in the builder, then have the customer sign that total.`, 409), { details: { totalCents: priced.totalCents, menuVersion: priced.menuVersion } });
  if (signedCents !== priced.totalCents) return refusal();
  const version = quote?.catalog_version;
  if (version !== undefined && version !== null && version !== '' && version !== priced.menuVersion) return refusal();
  if (quote?.line_items !== undefined && quote.line_items !== null) {
    let lines = null;
    try { ({ lineItems: lines } = normalizeLineItems(quote.line_items, { strict: true, purchase: true })); } catch { lines = null; }
    if (!lines || canonical(signedLines(lines)) !== canonical(signedLines(priced.lineItems))) return refusal();
  }
  return null;
}
// The builder selection a revision is priced from when its plan sends none: the signed job's, else its saved draft's.
const savedSelection = job => plain(job?.compositeQuote?.compositePricing) ? job.compositeQuote.compositePricing : plain(job?.quoteDraft?.compositePricing) ? job.quoteDraft.compositePricing : null;
// A job the customer signed before builder quotes had a Labor line, revised with that same selection (re-sent unchanged
// or not sent at all): it is priced by the earlier rules, without labor, so its signed total stands. Any other selection
// (a new or changed one, or an unsigned draft's) with garage work needs its Labor line; a junk-only one has none (D-JUNK).
function signedWithoutLabor(previous, selection) {
  const signed = plain(previous?.compositeQuote?.compositePricing) ? previous.compositeQuote.compositePricing : null;
  return Boolean(signed && signed.labor === undefined && plain(selection) && selection.labor === undefined && canonical(selection) === canonical(signed));
}
// The labor time estimate reads the walkthrough's garage fullness; a signed quote's is the signed plan's own
// (scope.fullness), whatever the selection carried, so its recorded estimate is the server's for the signed scope.
const withSignedFullness = (selection, plan) => plain(selection) && plain(selection.labor) ? { ...selection, labor: { ...selection.labor, fullness: fullnessOf(plan.scope?.fullness) } } : selection;
// A selection that names the walkthrough's garage size (composite-quote.js garageSize: without a cleaning base it sizes the
// deep clean and allows the one-car pressure wash) is priced with the signed plan's own (scope.garages), whatever it
// carried; a plan without a known size drops it. A selection that names none is priced as it is.
function withSignedGarage(selection, plan) {
  if (!plain(selection) || selection.garageSize === undefined) return selection;
  const { garageSize, ...rest } = selection, size = String(plan.scope?.garages ?? '');
  return GARAGE_SIZES.includes(size) ? { ...rest, garageSize: size } : rest;
}
// A Hub catalog quote draft (quoteDraft.catalogPricing, priced on the server by catalog-quote.js) signed with exactly the
// lines the server saved for it: it keeps the catalog's own approval, as its send does.
function catalogSigned(previous, plan) {
  if (!plain(previous?.quoteDraft?.catalogPricing) || !plan.quote.itemized || !Array.isArray(previous.estimate?.lineItems)) return false;
  const { lineItems: saved } = normalizeLineItems(previous.estimate.lineItems);
  return saved.length > 0 && canonical(signedLines(saved)) === canonical(signedLines(plan.quote.estimate_line_items));
}
// The human job breakdown with a builder quote's shelving and storage as the packs sold, product by product, and its
// Labor line as the man-hours sold (D12), never the rate or the amount: the crew and the HighLevel note read it. The
// man-hours are the time sold, not a time on site (the job's on-site time is its estimated minutes, which book the crew):
// man-hours that differ from the server's estimate say so, for the owner and Dispatch.
const manHoursText = hours => `${Number(hours.toFixed(2))} man-hour${hours === 1 ? '' : 's'}`;
export function laborBreakdownItem(labor) {
  if (!plain(labor) || typeof labor.manHours !== 'number' || !(labor.manHours > 0)) return '';
  const estimate = typeof labor.prefilledManHours === 'number' && labor.prefilledManHours > 0 && labor.prefilledManHours !== labor.manHours ? labor.prefilledManHours : null;
  return `${manHoursText(labor.manHours)} sold${estimate === null ? '' : ` (${labor.manHours < estimate ? 'below' : 'above'} the estimate of ${manHoursText(estimate)})`}`;
}
// A builder quote's goods for one step (shelving, storage), product by product in packs: names and counts, never a price.
const builderGoods = (builder, id) => (Array.isArray(builder?.breakdown?.lines) ? builder.breakdown.lines.filter(plain) : []).filter(line => line.section === id && line.sku)
  .map(line => stripCrewMoney(`${line.name} × ${line.qty} pack${line.qty === 1 ? '' : 's'}${line.unitsPerPack > 1 ? ` of ${line.unitsPerPack}` : ''}`).slice(0, 300)).slice(0, 20);
// A builder quote's brief (the crew's and the staff HighLevel note's) names the goods it sold, its shelving and storage
// packs, on the MATERIALS line: the page writes that line from the walkthrough Finish step's shelf and tote counts, which
// the builder never reads or writes (crew/gameplan.html buildInternalNotes).
const soldGoodsBrief = (brief, builder) => brief.replace(/^MATERIALS: .*$/m, () => `MATERIALS: ${[...builderGoods(builder, 'shelving'), ...builderGoods(builder, 'storage')].join(' · ').slice(0, 1500) || 'None sold'}`).slice(0, 4900);
function builderBreakdown(summary, builder) {
  const goods = id => builderGoods(builder, id);
  const labor = laborBreakdownItem(builder?.labor);
  const sections = [...summary.sections.map(section => ['shelving', 'storage'].includes(section.id) && goods(section.id).length ? { ...section, items: goods(section.id) } : section),
    ...(labor ? [{ id: 'labor', title: 'Labor', items: [stripCrewMoney(labor)] }] : [])];
  return { ...summary, sections, summary: breakdownLines({ sections }).join('\n').slice(0, 2000) };
}
const listNames = names => names.slice(0, 8).join(', ') + (names.length > 8 ? ` and ${names.length - 8} more` : '');
// The in-person terms a signed walkthrough names (terms_version) and the deposit percent each one takes (D-DEPOSIT). New
// signatures are on the current terms (SIGNED_25_75: 25% when the homeowner signs, 75% on the job day). The earlier 50%
// terms (2026-09-deposit50: 50% upfront, the rest on completion) are read only to replay a save made on them
// (saveWalkthroughHandoff refuses a new one: handoff_terms_outdated); jobs signed on them keep them.
export const CURRENT_SIGNED_TERMS = SIGNED_25_75.version, LEGACY_SIGNED_TERMS = '2026-09-deposit50';
const SIGNED_TERMS = Object.freeze({ [CURRENT_SIGNED_TERMS]: SIGNED_25_75.depositPct, [LEGACY_SIGNED_TERMS]: 50 });
export function normalizeHandoffPlan(input, now = new Date().toISOString(), { builder = null, purchase = false } = {}) {
  if (!plain(input) || !plain(input.client) || !plain(input.quote) || !plain(input.acceptance)) throw fail('invalid_plan', 'Review the complete walkthrough before saving.', 400);
  const quote = input.quote, acceptance = input.acceptance;
  const terms = text(input.terms_version, 'Terms version', 100, true);
  if (!Object.hasOwn(SIGNED_TERMS, terms)) throw fail('acceptance_required', 'The accepted terms are not the current walkthrough terms. Reload the walkthrough and have the homeowner review and sign it again.', 400);
  const totalCents = cents(quote.total, 'Locked total'), depositCents = cents(quote.deposit, 'Deposit'), pct = SIGNED_TERMS[terms];
  if (totalCents <= 0 || depositCents !== depositOf(totalCents, pct)) throw fail('invalid_amount', `The signed walkthrough must include the locked total and its ${pct}% deposit.`, 400);
  const signature = text(input.signature, 'Homeowner signature', 250000, true);
  if (input.terms_accepted !== true || acceptance.signature_captured !== true || acceptance.method !== 'in_person_signature' || !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(signature)) throw fail('acceptance_required', 'The homeowner must approve the scope and sign before an accepted job can be saved.', 400);
  const acceptedAt = text(acceptance.accepted_at, 'Original acceptance time', 40, true);
  if (!/(?:Z|[+-]\d{2}:\d{2})$/.test(acceptedAt) || !Number.isFinite(Date.parse(acceptedAt)) || Date.parse(acceptedAt) > Date.parse(now) + 300000) throw fail('acceptance_required', 'The original signature time could not be verified. Review and sign the scope again.', 400);
  if (acceptance.terms_version !== terms) throw fail('acceptance_required', 'The accepted terms do not match this walkthrough.', 400);
  const date = text(quote.job_date, 'Job date', 10, true), start = text(quote.start_time, 'Start time', 5, true), end = text(quote.end_time, 'End time', 5, true);
  const startAt = localInstant(date, start), endAt = localInstant(date, end);
  if (!startAt || !endAt || endAt <= startAt) throw fail('invalid_schedule', 'Choose valid Denver start and end times. Missing or repeated daylight-saving hours require another time.', 400);
  const client = { name: text(input.client.name, 'Customer name', 200, true), phone: text(input.client.phone || '', 'Phone', 40), email: text(input.client.email || '', 'Email', 254), address: text(input.client.address, 'Service address', 500, true), highlevel_contact_id: text(input.client.highlevel_contact_id || '', 'Contact link', 180) };
  if (!phone(client.phone) && !email(client.email)) throw fail('customer_required', 'A customer phone or email is required.', 400);
  const logistics = descriptiveData(input.logistics || {}), scope = descriptiveData(input.scope || {}), discovery = descriptiveData(input.discovery || {});
  if (!plain(logistics) || !plain(scope) || !plain(discovery) || !Number.isInteger(logistics.crew_size) || logistics.crew_size < 1 || logistics.crew_size > 20) throw fail('invalid_plan', 'Choose the required crew size.', 400);
  const minutes = quote.estimated_duration_min;
  if (!Number.isInteger(minutes) || minutes < 15 || minutes > 1440) throw fail('invalid_plan', 'The estimated job duration is invalid.', 400);
  const before = input.photos?.before;
  if (!Number.isInteger(before) || before < 0 || before > 1000) throw fail('invalid_plan', 'The walkthrough photo count is invalid.', 400);
  const lines = itemizedQuote(quote, totalCents, logistics.crew_size, minutes, builder, purchase) || { line_items: [{ name: 'Garage cleanout and reset', qty: 1, total: totalCents / 100 }], line_items_count: 1 };
  // The priced internal_notes stay manager-only; crew get crew_brief (older pages send none: it is the internal brief without amounts).
  const internalNotes = text(input.internal_notes, 'Job brief', 4900, true), crewBrief = input.crew_brief === undefined || input.crew_brief === null || input.crew_brief === '' ? internalNotes : text(input.crew_brief, 'Crew brief', 4900, true);
  return { client, quote: { title: text(quote.title || 'EGC Garage Service', 'Job title', 500, true), total: totalCents / 100, deposit: depositCents / 100, job_date: date, start_time: start, end_time: end, start_at: startAt, end_at: endAt, estimated_duration_min: minutes, expected_shift_hours: (minutes + 90) / 60, ...lines }, discovery, scope, logistics, internal_notes: builder ? soldGoodsBrief(internalNotes, builder) : internalNotes, crew_brief: stripCrewMoney(builder ? soldGoodsBrief(crewBrief, builder) : crewBrief), client_checklists: checks(input.client_checklists), signature, acceptance: { accepted_at: new Date(acceptedAt).toISOString(), accepted_by: text(acceptance.accepted_by, 'Signer name', 200, true), method: 'in_person_signature', terms_version: terms, signature_captured: true }, terms_version: terms, terms_accepted: true, photos: { before }, notes: text(input.notes || '', 'Customer notes', 8000) };
}
export function identityMatches(left, right) {
  const a = phone(left.phone), b = phone(right.phone), c = email(left.email), d = email(right.email);
  const p = left.highlevelContactId || left.highlevel_contact_id, q = right.highlevelContactId || right.highlevel_contact_id;
  if (a && b && a !== b || c && d && c !== d || p && q && p !== q) return false;
  return Boolean(p && p === q || a && a === b || c && c === d);
}
function requireRevision(row) {
  if (!safeId(row?.id) || typeof row.revision !== 'string' || !row.revision) throw fail('source_unavailable', 'A required customer or source record has no verifiable revision. Keep the form and retry.', 503);
}
// A builder quote's crew instructions also name the man-hours sold (laborManHours, D12), never the labor rate or amount.
// parkingPlan: the vehicles the customer parks after the job and the walkthrough's fit check (crew/gameplan-vehicles.js),
// written on the device as scope.parking_plan; a walkthrough without vehicles sends none and gets none.
export function handoffInstructions(plan, sourceId = '', builder = null) {
  const s = plan.scope, l = plan.logistics, f = s.finish_details || {};
  return { customerGoal: String(plan.discovery.success || ''), whyNow: String(plan.discovery.why_now || ''), sortMethod: String(s.sort_method || ''), keepItems: String(s.keep_items || ''), removeItems: String(s.remove_items || ''), exclusions: String(s.exclusions || ''), hazards: Array.isArray(s.hazards) ? s.hazards : [], access: Array.isArray(s.access) ? s.access : [], accessNotes: String(l.notes || ''), truckPlacement: String(l.truck_placement || s.truck_placement || ''), specialItems: Array.isArray(s.special_items) ? s.special_items : [], finish: Array.isArray(s.finish) ? s.finish : [], shelving: { type: String(f.shelf_type || ''), qty: Number(f.shelf_qty || 0) }, totes: { qty: Number(f.tote_qty || 0) }, customerNotes: plan.notes, crewSize: l.crew_size, arrivalWindow: `${plan.quote.start_time}–${plan.quote.end_time}`, estimatedJobMinutes: plan.quote.estimated_duration_min, estimatedJobHours: plan.quote.estimated_duration_min / 60, expectedShiftHours: plan.quote.expected_shift_hours, photoCount: plan.photos.before, sourceWalkthroughId: sourceId, ...(plan.quote.itemized ? { materials: handoffMaterials(plan, builder) } : {}),
    ...(typeof builder?.labor?.manHours === 'number' ? { laborManHours: builder.labor.manHours } : {}),
    ...(typeof s.parking_plan === 'string' && s.parking_plan.trim() ? { parkingPlan: s.parking_plan.trim().slice(0, 1000) } : {}) };
}
// D-DEPOSIT: a signature on the current terms saves its payment terms on the estimate as a sent quote's are saved
// (commercialPolicy SIGNED_25_75 and paymentSchedule): the 25% deposit due the day the homeowner signed (Denver) and the
// 75% remainder on the signed job day, in cents. The customer portal, the estimate document and the deposit checkout
// (estimate.depositRequired) read them, and the Hub's legacy estimate editor leaves them alone (money-service.js), as it
// does a sent quote's. A save replayed on the earlier 50% terms writes none of this, exactly as it did.
// paidCents: what the customer already paid toward the job being signed again (a revision). Money paid is never asked for
// twice: when it is more than the new 25% deposit (a job first signed on the 50% terms with its deposit paid), the
// deposit is what was paid (up to the total) and the remainder the rest, so the schedule, the estimate's deposit and the
// balance agree (the documents name the split: quote-payment-policy.js scheduleSplit).
export function signedPaymentTerms(plan, paidCents = 0) {
  if (plan.terms_version !== CURRENT_SIGNED_TERMS) return {};
  const totalCents = Math.round(plan.quote.total * 100), amounts = quotePaymentSchedule(totalCents, SIGNED_25_75), jobDay = plan.quote.job_date, signedDay = businessPaymentDate(plan.acceptance.accepted_at);
  const depositCents = Math.min(totalCents, Math.max(amounts.depositCents, Number.isSafeInteger(paidCents) && paidCents > 0 ? paidCents : 0));
  // A job dated before the signature (a dispatcher's back-dated save) has its deposit due on the job day too.
  const dates = quotePaymentDates(SIGNED_25_75, { walkthroughDate: signedDay > jobDay ? jobDay : signedDay, jobDate: jobDay });
  return { amountCents: totalCents, depositRequiredCents: depositCents, depositPct: SIGNED_25_75.depositPct, commercialPolicy: amounts.policy,
    paymentSchedule: { depositCents, remainderCents: totalCents - depositCents, depositDueDate: dates.depositDueDate, remainderDueDate: dates.remainderDueDate, timeZone: PAYMENT_TIME_ZONE, policyVersion: SIGNED_25_75.version } };
}
// What the customer paid toward a job before it is signed again (payments less tips), in cents; 0 for a new job.
function appliedCents(previous) {
  if (!previous) return 0;
  const applied = customerMoneyTotals(previous).appliedCents, deposit = Number(previous.deposit?.paidAmount);
  return Number.isSafeInteger(applied) ? applied : Number.isFinite(deposit) && deposit > 0 ? Math.round(deposit * 100) : 0;
}
function financePatch(plan, previous, jobId, actor, now, builder = null) {
  const terms = signedPaymentTerms(plan, appliedCents(previous));
  const total = plan.quote.total, amount = terms.depositRequiredCents === undefined ? plan.quote.deposit : terms.depositRequiredCents / 100, prior = plain(previous?.deposit) ? previous.deposit : {};
  const paid = typeof prior.paidAmount === 'number' && Number.isFinite(prior.paidAmount) ? Math.max(0, prior.paidAmount) : 0;
  const patch = { total, priceQuoted: total, quoteStatus: 'approved', termsVersion: plan.terms_version,
    acceptance: { acceptedAt: plan.acceptance.accepted_at, acceptedBy: plan.acceptance.accepted_by, method: 'in_person_signature', termsVersion: plan.terms_version, signatureCaptured: true, signatureData: plan.signature, recordedBy: actor.user, recordedAt: now },
    customerApproval: { status: 'approved', approvedAt: plan.acceptance.accepted_at, approvedBy: plan.acceptance.accepted_by, amount: total, source: 'in_person_signature' },
    estimate: { number: previous?.estimate?.number || `EST-${jobId.slice(-6).toUpperCase()}`, revision: Number.isInteger(previous?.estimate?.revision) ? previous.estimate.revision + 1 : 1, status: 'accepted', amount: total, depositRequired: amount, acceptedAt: plan.acceptance.accepted_at, acceptedBy: plan.acceptance.accepted_by, acceptanceMethod: 'in_person_signature', termsVersion: plan.terms_version, createdAt: previous?.estimate?.createdAt || now, source: 'walkthrough',
      // A builder quote's scope is its priced lines (compositeScope, as a sent builder quote's): the homeowner never
      // signs work its price leaves out (a junk-only quote reads "Junk removal only"). Any other quote: the Finish step.
      scope: builder ? compositeScope(builder) : customerScopeSummary(plan.scope),
      // A builder quote stores the builder's lines with their internal goods split (manager-only, never fingerprinted or
      // shown to a customer or the crew), as a saved builder draft does; the signed snapshot keeps the lines without it.
      ...(plan.quote.itemized ? { lineItems: structuredClone(builder ? builder.storedLineItems : plan.quote.estimate_line_items), catalogVersion: plan.quote.catalog_version } : {}), ...(builder ? { pricingSettingsVersion: builder.settingsVersion } : {}), ...terms },
    deposit: { ...prior, amount, paidAmount: paid, status: paid >= amount ? 'paid' : paid > 0 ? 'partial' : 'due' },
    ...(plan.quote.itemized || previous?.durationOverride ? { durationOverride: plan.quote.duration_override_reason ? { suggestedMinutes: plan.quote.duration_suggestion.minutes, minutes: plan.quote.estimated_duration_min, reason: plan.quote.duration_override_reason, recordedBy: actor.user, recordedAt: now } : null } : {}) };
  // Any change to what the customer signed (price, deposit, scope or, when
  // either side is itemized, the lines) retires an issued invoice; recorded
  // payments stay intact. A single bundled Hub line is not an itemized quote.
  const itemized = plan.quote.itemized || previous?.acceptedHandoffPayload?.quote?.itemized === true || Array.isArray(previous?.estimate?.lineItems) && previous.estimate.lineItems.length > 1;
  const changed = previous && (previous.estimate?.amount !== total || previous.estimate?.depositRequired !== amount || canonical(previous.scope || {}) !== canonical(plan.scope) || itemized && canonical(previous.estimate?.lineItems ?? null) !== canonical(patch.estimate.lineItems ?? null));
  if (changed && previous.invoice?.amount && !['void', 'superseded'].includes(previous.invoice.status)) patch.invoice = { ...previous.invoice, status: 'superseded', supersededAt: now, supersededReason: 'walkthrough_revised' };
  return patch;
}
// FUN-02: the sale this signature records, in the handoff commit. The signed
// time is the iPad's clock, accepted only inside the two-sided bounds (now + 5
// min, and walkthrough start - 1 h / scheduled date - 1 day); otherwise the sale
// is attested and dated at the bound or server time. A revision first retires
// the job's live sale (FUN-03 funnelSale: a portal or handoff sale, even one a
// legacy browser revision already superseded; never a staff-recorded approval,
// which has no sale), so the net of deal.sold minus deal.approval_superseded
// is always the current signed contract. {writes, funnelSale}: the commit
// saves funnelSale on the job with the events. The sale records the project's
// service line and funnel path after this commit (FUN-29 dimensions).
async function saleEvents({ plan, source, job, actor, requestId, receiptId, now, dimensions = {} }) {
  const base = { idempotencyKey: { kind: 'requestId', value: requestId }, projectId: funnelHubId(job.projectId) ? job.projectId : undefined, jobId: job.id, walkthroughId: funnelHubId(source?.id) ? source.id : undefined, customerId: funnelHubId(job.customerId) ? job.customerId : undefined,
    highlevelContactId: /^[A-Za-z0-9_-]{1,120}$/.test(job.highlevelContactId || '') ? job.highlevelContactId : undefined, actor: eventActor({ id: actor.user, kind: 'human', role: actor.role }), via: 'hub', source: { collection: 'walkthroughHandoffs', id: receiptId }, eligibility: { hub: job } };
  const startedAt = source?.walkthroughVisit?.startedAt;
  const signed = { deviceAt: plan.acceptance.accepted_at, deviceBounds: { startedAt: instantMs(startedAt) === null ? null : startedAt, scheduledDate: validDate(source?.date) ? source.date : null } };
  return saleWrites(job, { soldData: { amountCents: Math.round(plan.quote.total * 100), estimateRevision: job.estimate.revision, ...dimensions } },
    (type, data) => funnelEventWrite(null, now, { ...base, type, data, ...(type === 'deal.sold' ? signed : {}) }));
}
// The walkthrough's sold_on_site outcome in FUN-05's walkthroughOutcome shape, dated like
// its deal.sold. Its occurrence is FUN-05's {number, date, time, startAt, scheduleOccurrence}.
function soldOutcome(source, sold, actor, requestId, deviceAt) {
  const date = validDate(source.date) ? source.date : null, time = typeof source.time === 'string' && /^\d\d:\d\d$/.test(source.time) ? source.time : null;
  const counter = Number.isInteger(source.scheduleOccurrence) && source.scheduleOccurrence >= 1 && source.scheduleOccurrence <= 1000 ? source.scheduleOccurrence : null;
  return { outcome: 'sold_on_site', reasonCode: null, finishedAt: sold.occurredAt, performedBy: assignmentKey(actor.user), recordingStatus: null, requestId: requestId.toLowerCase(), clockSource: sold.clockSource, deviceAt,
    occurrence: { number: counter ?? 1, date, time, startAt: date && time ? localInstant(date, time) : null, scheduleOccurrence: counter }, repTime: { status: 'not_started', segmentId: null }, source: 'walkthrough_handoff' };
}

/** Resolve an already-saved handoff without changing history, customer identity,
 * money, or visit completion. Managers can safely resume after a lost response.
 * Quote authors (options.env, P2-12) use it too for the jobs they may revise
 * (authorsJob); only dispatchers see the roster or any other job. */
export async function prepareHandoff(store, actor, query = {}, { env = {} } = {}) {
  const access = requireQuoteAuthor(actor, env);
  if (Object.keys(query).some(key => !['sourceWalkthroughId', 'jobId'].includes(key))) throw fail('invalid_request', 'The walkthrough lookup is invalid.', 400);
  for (const id of [query.sourceWalkthroughId, query.jobId].filter(Boolean)) if (!safeId(id)) throw fail('invalid_request', 'Choose a valid saved walkthrough or job.', 400);
  const source = query.sourceWalkthroughId ? await store.read('jobs', query.sourceWalkthroughId) : null;
  if (query.sourceWalkthroughId && (!source || source.type !== 'walkthrough' || source.recordType)) throw fail('source_missing', 'The source walkthrough could not be found.', 404);
  let job = query.jobId ? await store.read('jobs', query.jobId) : null;
  if (query.jobId && !job) throw fail('job_missing', 'The selected job no longer exists. Review its history rather than creating a replacement.', 404);
  if (job && !operational(job)) throw fail('job_mismatch', 'The selected record is not an operational job.');
  if (source) {
    const matches = (await saveJobReads(store).where('sourceWalkthroughId', source.id)).filter(row => operational(row) && row.sourceWalkthroughId === source.id);
    const ids = [...new Set([...matches.map(row => row.id), source.convertedJobId, job?.id].filter(Boolean))];
    if (ids.length > 1) throw fail('existing_jobs_ambiguous', 'More than one job is linked to this walkthrough. Review the existing jobs in Dispatch.');
    if (!job && ids.length) job = await store.read('jobs', ids[0]);
    if (ids.length && !job) throw fail('job_missing', 'The linked job cannot be verified. Review its history before creating more work.');
    if (job && (!operational(job) || job.sourceWalkthroughId !== source.id || source.customerId && job.customerId !== source.customerId)) throw fail('job_mismatch', 'The existing job and walkthrough do not share the same customer and source.');
  }
  const restricted = restrictedAuthor(actor, access, env);
  if (job && !access.dispatcher && !authorsJob(job, source, actor, restricted, restricted && await walkthroughVisible(source, actor, env))) throw fail('job_forbidden', 'Only an operations manager or owner can open this job. Start from its walkthrough or quote draft.', 403);
  const customerId = job?.customerId || source?.customerId || '';
  const customer = customerId ? await store.read('customers', customerId) : null;
  if (customerId && !customer) throw fail('customer_missing', 'The linked customer is unavailable. Repair the customer link before saving.');
  // A quote author sees the customer's contact details only through a job they may revise. An estimator sees them
  // only for their own customer, an assigned walkthrough's or an assigned job's; any other customer is masked and
  // named by their own customer reference, or not at all (estimator-customer-access.js).
  const seen = !restricted ? { full: true, ref: '' } : job ? await jobCustomerAccess(store, actor, access, job, { env }) : { full: await fullCustomerAccess(customer, actor, { env, source }), ref: '' };
  const shown = customer && (access.dispatcher || job) ? seen.full ? customerProjection(customer) : maskedCustomer(customer, seen.ref) : null;
  // crewAutoAssign (EGC_DISPATCH_CREW_AUTO_ASSIGN only): the page offers crew openings (handoffCrewOpenings) and Dispatch staffs the sold job.
  return { ok: true, authority: 'employee_hub', sourceWalkthroughId: source?.id || '', sourceRevision: source?.revision || '', jobId: job?.id || '', expectedRevision: job?.revision || '', customerId: shownCustomerId(customer?.id, seen), customer: shown, roster: access.dispatcher ? await store.roster() : [], ...(crewAutoAssignEnabled(env) ? { crewAutoAssign: true } : {}) };
}

/** EGC_DISPATCH_CREW_AUTO_ASSIGN: the crew openings a quote author may offer the customer (GET
 * /api/walkthrough-handoff?view=crew_openings[&startDate&durationMinutes&travelBufferMinutes]): crew-mode openings for
 * a job (dispatch-openings.js, crews=auto, kind=job: Crew 1 and Crew 2 on weekdays, Crew 3 on weekends, from 9:30),
 * projected to {date, time, endTime, crewId, crewLabel, priority} (projectCrewOpenings): never the roster, an employee or
 * another customer. Advisory: the signed handoff names the chosen crew and Dispatch decides when the job is saved. */
export const CREW_OPENING_LIMIT = 12;
const CREW_OPENING_KEYS = ['startDate', 'durationMinutes', 'travelBufferMinutes'];
export async function handoffCrewOpenings(store, actor, query = {}, now = new Date(), { env = {} } = {}) {
  requireQuoteAuthor(actor, env);
  if (!crewAutoAssignEnabled(env)) throw fail('crew_openings_disabled', 'Crew openings are not switched on. Choose a time; a manager assigns the crew in Dispatch.', 404);
  if (!plain(query) || Object.keys(query).some(key => !['view', ...CREW_OPENING_KEYS].includes(key)) || query.view !== undefined && query.view !== 'crew_openings') throw fail('invalid_request', 'The crew openings request is invalid.', 400);
  const ask = { crews: 'auto', kind: 'job', ...Object.fromEntries(CREW_OPENING_KEYS.filter(key => query[key] !== undefined).map(key => [key, query[key]])) };
  const found = await dispatchOpenings(store, actor, ask, now, { authorize: session => requireQuoteAuthor(session, env), booker: true });
  return { ok: true, authority: 'employee_hub', openings: projectCrewOpenings(found, CREW_OPENING_LIMIT) };
}

const compositeStateDefault = env => readCompositeState(catalogStorage(env));
const CLOSED_STATES = ['cancelled', 'canceled', 'noshow', 'no_show', 'completed', 'closed'];
const isOwner = actor => { try { requireCatalogOwner(actor); return true; } catch { return false; } };
// A held job's prices as its author sees them: ready, or what still waits for the owner (menu item names, or the
// walkthrough-priced quote). source 'builder' for a builder quote, 'walkthrough' for one the builder did not price.
function pricingView(job) {
  const pending = plain(job?.pricesPendingApproval) && Array.isArray(job.pricesPendingApproval.items) ? job.pricesPendingApproval.items.map(item => String(item?.name || '').slice(0, 160)).filter(Boolean) : [];
  return { source: plain(job?.compositeQuote) ? 'builder' : 'walkthrough', ready: !plain(job?.pricesPendingApproval), pending };
}
// EGC_QUOTE_BUILDER_ENABLED: what a signed builder quote saves on its job. compositeQuote keeps the priced selection
// and its cost-free breakdown (sections, products, purchase list); prices the owner has not approved flag the job
// pricesPendingApproval (reason draft_prices: menu item ids and names, no amount). A saved builder draft being signed
// takes the signed selection, so the draft and the job never disagree.
function builderPatch(builder, previous, actor, requestId, now) {
  const pending = builder.approval.ready ? [] : builder.approval.blocked.map(({ id, name }) => ({ id, name }));
  return {
    compositeQuote: { version: 1, requestId, compositePricing: structuredClone(builder.compositePricing), breakdown: structuredClone(builder.breakdown), menuVersion: builder.menuVersion, settingsVersion: builder.settingsVersion, approval: { ready: builder.approval.ready, pending }, pricedAt: now },
    ...(pending.length ? { pricesPendingApproval: { status: 'pending', reason: 'draft_prices', at: now, by: actor.user, requestId, items: pending } } : plain(previous?.pricesPendingApproval) ? { pricesPendingApproval: null } : {}),
    ...(plain(previous?.quoteDraft) && plain(previous.quoteDraft.compositePricing) ? { quoteDraft: { ...previous.quoteDraft, compositePricing: structuredClone(builder.compositePricing), breakdown: structuredClone(builder.breakdown) } } : {}),
  };
}
// EGC_QUOTE_BUILDER_ENABLED: a signed quote the builder did not price (the walkthrough's own lines or its single
// signed total) is held like a draft-priced one (reason walkthrough_priced); a builder job re-signed this way loses its
// builder prices.
const WALKTHROUGH_PRICED = { id: null, name: 'Walkthrough-priced quote' };
function walkthroughHold(previous, actor, requestId, now) {
  return { pricesPendingApproval: { status: 'pending', reason: 'walkthrough_priced', at: now, by: actor.user, requestId, items: [WALKTHROUGH_PRICED] }, ...(plain(previous?.compositeQuote) ? { compositeQuote: null } : {}) };
}
// The quote-draft send gate's refusal of a walkthrough-priced quote (quote-draft.js compositeSendable), for a signed job.
const builderRequired = () => Object.assign(new Error('With the quote builder on, a walkthrough-priced quote is sent only after it is built in the quote builder from the owner\'s pricing menu. The job stays booked: build the quote in the builder and have the customer sign it, or ask the owner to release these prices.'),
  { code: 'quote_draft_builder_required', status: 409, details: { unapproved: [{ ...WALKTHROUGH_PRICED, unitCents: null, reason: 'Its lines were priced from the walkthrough tables, which the owner has not approved for the quote builder. Rebuild it in the quote builder (removal, then shelving, then extra storage) and sign that quote, or the owner releases this signed price.' }] } });
// The builder's send gate for a held job: a builder quote passes when every price on its signed breakdown is
// owner-approved now, each line at the amount the customer signed whatever amount the owner approved (compositeApproval
// signed, else approvalRefusal: 409
// quote_draft_composite_prices_unapproved); a walkthrough-priced one never passes it (409 quote_draft_builder_required)
// unless the owner, who approves prices, releases it (owner).
// The labor on a signed breakdown keeps the rate the customer signed (approved then: the owner's own rate), so a rate
// change never strands a held job (signed). A job the customer signed before builder quotes had a Labor line keeps the
// earlier rules: its signed total has no labor, and goods in it still wait for the owner's installation answer.
function releaseGate(job, pricing, { owner = false } = {}) {
  if (plain(job.compositeQuote)) {
    const approval = compositeApproval(job.compositeQuote.breakdown, pricing, { signed: true });
    if (!approval.ready) throw approvalRefusal(approval);
    return 'approved_prices';
  }
  if (owner) return 'owner_release';
  throw builderRequired();
}
// A release clears the hold, records it and asks for the portal invitation (customerPortalInvitationRequestedAt), which
// the Hub's provider sync sends: the estimate and deposit request reach the customer only now.
function releasePatch(job, actor, now, release) {
  return { pricesPendingApproval: null, pricesRelease: { at: now, by: actor.user, ...release },
    ...(plain(job.compositeQuote) ? { compositeQuote: { ...job.compositeQuote, approval: { ready: true, pending: [] }, releasedAt: now, releasedBy: actor.user } } : {}),
    customerPortalInvitationRequestedAt: job.customerPortalInvitationRequestedAt || now, updatedAt: now };
}

/** EGC_QUOTE_BUILDER_ENABLED: a job booked with prices the owner had not approved (pricesPendingApproval) gets its
 * customer-facing estimate and deposit request only through the builder's send gate (releaseGate): a builder quote's
 * saved breakdown is re-checked against today's menu, settings and approvals and anything still unapproved is refused
 * (409 quote_draft_composite_prices_unapproved, every reason in details.unapproved); a walkthrough-priced quote is
 * refused like an unbuilt quote draft (409 quote_draft_builder_required) unless the owner releases it. Once released,
 * the job asks for its portal invitation. The owner's menu approvals also release covered jobs on their own
 * (releaseHeldHandoffs).
 *   POST /api/walkthrough-handoff {action:'prices.release', requestId, jobId, expectedRevision, actorId?}
 *   => {ok, authority, requestId, replayed, released, job:{id, revision}, pricing:{source, ready, pending}} */
export async function releaseHandoffPrices(store, actor, input, now = new Date().toISOString(), { env = {}, compositeState = compositeStateDefault } = {}) {
  const access = requireQuoteAuthor(actor, env);
  if (!quoteBuilderEnabled(env)) throw fail('builder_disabled', 'The quote builder is turned off. Keep this job for review.', 404);
  if (!plain(input) || Object.keys(input).some(key => !['action', 'requestId', 'jobId', 'expectedRevision', 'actorId'].includes(key)) || input.action !== 'prices.release' || !requestId(input.requestId) || !safeId(input.jobId) || typeof input.expectedRevision !== 'string' || !input.expectedRevision) throw fail('invalid_request', 'Choose the saved job whose estimate should be released.', 400);
  if (input.actorId && input.actorId !== actor.user) throw fail('actor_changed', 'The signed-in employee changed. Reopen the original account to recover this request.', 403);
  const receiptId = input.requestId.toLowerCase(), view = (job, replayed, released) => ({ ok: true, authority: 'employee_hub', requestId: input.requestId, replayed, released, job: { id: job.id, revision: job.revision }, pricing: pricingView(job) });
  const prior = await store.read('walkthroughHandoffs', receiptId);
  if (prior) {
    if (prior.kind !== 'prices_release' || prior.actorId !== actor.user || prior.jobId !== input.jobId) throw fail('idempotency_conflict', 'This request identity belongs to a different save. Start the release again.');
    const saved = await store.read('jobs', input.jobId);
    if (!saved) throw fail('job_missing', 'The released job no longer exists. Review its history.', 404);
    return view(saved, true, true);
  }
  const job = await store.read('jobs', input.jobId);
  if (!job) throw fail('job_missing', 'The selected job no longer exists.', 404);
  requireRevision(job);
  if (!operational(job) || !plain(job.compositeQuote) && !plain(job.pricesPendingApproval)) throw fail('not_builder_quote', 'This job was not priced in the quote builder, so it has no builder prices to release.');
  if (CLOSED_STATES.includes(state(job))) throw fail('job_closed', 'This job is cancelled or finished, so its estimate is not sent.');
  if (!access.dispatcher && !authorsJob(job, null, actor, restrictedAuthor(actor, access, env))) throw fail('job_forbidden', 'Only an operations manager or owner can release this job. Start from its walkthrough or quote draft.', 403);
  if (job.revision !== input.expectedRevision) throw fail('job_changed', 'This job changed. Reload it before releasing its estimate.');
  if (!plain(job.pricesPendingApproval)) return view(job, false, false);
  const gate = releaseGate(job, plain(job.compositeQuote) ? await compositeState(env) : null, { owner: isOwner(actor) });
  const patch = releasePatch(job, actor, now, { source: 'prices.release', requestId: input.requestId, gate });
  await store.commit([{ collection: 'jobs', id: job.id, revision: job.revision, patch }, { collection: 'walkthroughHandoffs', id: receiptId, patch: { kind: 'prices_release', actorId: actor.user, jobId: job.id, gate, approvedItems: job.pricesPendingApproval.items || [], createdAt: now } }]);
  const saved = await store.read('jobs', job.id);
  if (!saved) throw fail('outcome_unknown', 'The release could not be read back. Retry the identical request.', 503);
  return view(saved, false, true);
}

/** EGC_QUOTE_BUILDER_ENABLED: after the owner approves pricing-menu prices or saves the pricing settings (POST
 * /api/catalog menu.approve or settings.update), the held builder jobs those approvals now cover are released (the
 * builder's send gate, releaseGate, on each), so the customer gets the estimate and deposit request without anyone
 * posting prices.release by hand. Bounded: store.heldJobIds(limit + 1) (handoff-price-holds.js: one equality query on
 * pricesPendingApproval.status) and at most `limit` job reads. A walkthrough-priced or still-unapproved job, a closed
 * one and one that changed meanwhile keep waiting. Each release commits on its own, under the job's revision.
 * => {released:[jobId], waiting:int, more:boolean} (more: further held jobs than this run read). */
export const HELD_RELEASE_LIMIT = 25;
export async function releaseHeldHandoffs(store, actor, now = new Date().toISOString(), { env = {}, compositeState = compositeStateDefault, source = 'menu.approve', requestId: approvalRequest = '', limit = HELD_RELEASE_LIMIT } = {}) {
  if (!quoteBuilderEnabled(env)) return null;
  const { released, waiting, more } = await releaseHeldPage(store, actor, now, await compositeState(env), { source, requestId: approvalRequest, limit });
  return { released, waiting, more };
}
// One bounded page of held jobs after the id `after` (store.heldJobIds(limit + 1, after), in id order). A job whose read
// fails waits, like one still unapproved; failed: the ids of jobs that passed the gate but whose release did not commit;
// closed: held jobs that are cancelled or finished (they wait for nothing and leave the count); signedAbove: jobs held
// because the customer signed more than the owner approved (the owner's to have signed again, not an approval to wait for).
// budget (optional, {left}): the storage calls this page may still make (Cloudflare caps an invocation's subrequests):
// the query costs one, each job a read and, when it passes, a commit; the page stops before a job that might not fit
// (stopped). next: the last id this page finished, where the following page starts.
async function releaseHeldPage(store, actor, now, pricing, { source, requestId: approvalRequest = '', limit = HELD_RELEASE_LIMIT, after = '', budget = null }) {
  const spend = cost => { if (budget) budget.left -= cost; };
  const released = [], failed = [], closed = [], signedAbove = [], seen = [];
  let waiting = 0, next = after;
  const done = (more, stopped) => ({ released, failed, closed, signedAbove, seen, waiting, more, next, stopped });
  if (budget && budget.left < 3) return done(true, true);
  spend(1);
  const ids = [...new Set(await store.heldJobIds(limit + 1, after))], page = ids.slice(0, limit);
  for (const id of page) {
    if (budget && budget.left < 2) return done(true, true);
    spend(1);
    let job = null;
    try { job = safeId(id) ? await store.read('jobs', id) : null; } catch { job = undefined; }
    next = id; seen.push(id);
    if (job === undefined) { waiting++; continue; }
    if (!job || !plain(job.pricesPendingApproval)) continue;
    if (CLOSED_STATES.includes(state(job))) { closed.push(job.id); continue; }
    if (!operational(job) || !plain(job.compositeQuote) || typeof job.revision !== 'string' || !job.revision) { waiting++; continue; }
    try { releaseGate(job, pricing); }
    catch (error) { waiting++; if (error?.details?.unapproved?.some?.(row => row?.signedAbove === true)) signedAbove.push(job.id); continue; }
    spend(1);
    try { await store.commit([{ collection: 'jobs', id: job.id, revision: job.revision, patch: releasePatch(job, actor, now, { source, requestId: approvalRequest, gate: 'approved_prices' }) }]); released.push(job.id); }
    catch { waiting++; failed.push(job.id); }
  }
  return done(ids.length > limit, false);
}

/** EGC_QUOTE_BUILDER_ENABLED: the held jobs after the id `after`, page by page (HELD_RELEASE_LIMIT each, in id order), so
 * jobs that keep waiting never starve the ones after them. Used after a pricing-menu change, when no owner approval is
 * saved (POST /api/held-jobs: the menu file's own approvals, e.g. the truck loads of 2026-10-21) and by the owner's
 * Release held jobs button. budget: the storage calls the run may make (HELD_SUBREQUEST_BUDGET: with the route's own
 * reads and its count, at most 44 per open, measured in tests/held-jobs.test.mjs, under Cloudflare's 50 per invocation);
 * a run that reaches it stops cleanly and answers where to continue (next).
 * complete: every held job after `after` was checked; closed, signedAbove: as releaseHeldPage; seen: every held job id
 * this run read; failed: jobs that passed
 * the gate but did not commit (they stay
 * held). => {released:[jobId], failed:[jobId], waiting:int, complete:boolean, next} or null with the builder off. */
export const HELD_SUBREQUEST_BUDGET = 30;
export async function releaseAllHeldHandoffs(store, actor, now = new Date().toISOString(), { env = {}, compositeState = compositeStateDefault, source = 'menu.version', requestId = '', limit = HELD_RELEASE_LIMIT, after = '', budget = HELD_SUBREQUEST_BUDGET } = {}) {
  if (!quoteBuilderEnabled(env)) return null;
  const pricing = await compositeState(env), left = { left: budget }, released = [], failed = [], closed = [], signedAbove = [], seen = [];
  let waiting = 0, cursor = after;
  for (;;) {
    const page = await releaseHeldPage(store, actor, now, pricing, { source, requestId, limit, after: cursor, budget: left });
    released.push(...page.released); failed.push(...page.failed); closed.push(...page.closed); signedAbove.push(...page.signedAbove); seen.push(...page.seen); waiting += page.waiting;
    if (page.stopped) return { released, failed, closed, signedAbove, seen, waiting, complete: false, next: page.next };
    if (!page.more || !page.next || page.next === cursor) return { released, failed, closed, signedAbove, seen, waiting, complete: true, next: '' };
    cursor = page.next;
  }
}

/** options.checkouts(job) (the API passes quote-draft expireStaleCheckout): a
 * signed revision re-prices and re-approves an existing job, so an open portal
 * card checkout opened for the earlier terms is expired, or reported as
 * checkout_needs_review, exactly as a quote draft revision does. */
export async function saveWalkthroughHandoff(store, actor, input, now = new Date().toISOString(), { env = {}, checkouts = null, compositeState = compositeStateDefault, winterSale = winterSaleReaders, pickup = pickupReaders } = {}) {
  const access = requireQuoteAuthor(actor, env);
  if (!plain(input) || Object.keys(input).some(key => !['actorId', 'requestId', 'customerId', 'sourceWalkthroughId', 'sourceRevision', 'jobId', 'expectedRevision', 'plan'].includes(key)) || !requestId(input.requestId) || !safeId(input.customerId) || input.jobId && !safeId(input.jobId)) throw fail('invalid_request', 'The accepted walkthrough needs a stable request and customer identity.', 400);
  if (input.actorId && input.actorId !== actor.user) throw fail('actor_changed', 'The signed-in employee changed. Reopen the original account to recover this request.', 403);
  // EGC_DISPATCH_CREW_AUTO_ASSIGN: the crew the page chose (logistics.crew_id) is read apart from the signed plan.
  // EGC_QUOTE_BUILDER_ENABLED: a plan with a builder selection (quote.composite_pricing) is read without the browser's
  // lines; the server prices the selection below. Any sent value but a selection object (or null: none sent) is
  // refused, so a falsy one can never skip the server's pricing. EGC_JOB_MATERIALS or the builder: a line may carry
  // purchase fields (itemizedQuote). Every flag off: the plan is read exactly as before.
  const autoCrew = crewAutoAssignEnabled(env), builderOn = quoteBuilderEnabled(env), structured = jobMaterialsEnabled(env), purchase = structured || builderOn, planInput = structured ? input.plan : withoutBringList(input.plan);
  const crewChoice = autoCrew ? requestedCrew(planInput) : null, signedInput = autoCrew ? withoutCrewChoice(planInput) : planInput;
  const builderSent = builderOn && plain(signedInput?.quote) && signedInput.quote.composite_pricing !== undefined && signedInput.quote.composite_pricing !== null;
  if (builderSent && !plain(signedInput.quote.composite_pricing)) throw fail('invalid_plan', 'The quote builder selection is invalid. Reopen the quote builder, save the quote again and sign that quote.', 400);
  let plan = normalizeHandoffPlan(builderSent ? withoutQuoteLines(signedInput) : signedInput, now, { purchase });
  const fingerprint = await hash({ actor: actor.user, input }), receiptId = input.requestId.toLowerCase();
  async function replay() {
    const receipt = await store.read('walkthroughHandoffs', receiptId);
    if (!receipt) return null;
    if (receipt.fingerprint !== fingerprint || receipt.actorId !== actor.user) throw fail('idempotency_conflict', 'This save identity belongs to different walkthrough content. Recover the original request before changing it.');
    const saved = await store.read('jobs', receipt.jobId), customer = await store.read('customers', receipt.customerId);
    if (!saved || !customer || saved.customerId !== receipt.customerId || saved.sourceWalkthroughId !== receipt.sourceWalkthroughId || saved.handoffRequestId !== input.requestId || saved.handoffFingerprint !== fingerprint) throw fail('changed_since_save', 'The earlier save succeeded, but this job has since changed. Open its current record in Dispatch.');
    savedHandoffPayload(saved, input.requestId);
    const checkout = receipt.originalJobRevision && typeof checkouts === 'function' ? await checkouts(saved).catch(() => ({ status: 'needs_review', reason: 'checkout_unconfirmed' })) : null;
    const open = checkout && !['none', 'current', 'expired'].includes(checkout.status) ? [{ code: 'checkout_needs_review', message: 'An open card checkout for the earlier quote could not be closed. Review it in Stripe before the customer pays.' }] : [];
    return result(saved, true, [...(receipt.warnings || []), ...open], checkout, receipt.crewAuto, await jobCustomerAccess(store, actor, access, saved, { env }));
  }
  // A quote author who is not a dispatcher gets no crew identities (assignedCrew is
  // always []; the crew page does not read it): warnings say what staffing needs.
  // crew (EGC_DISPATCH_CREW_AUTO_ASSIGN): what Dispatch did with the sold job, {status, crewName?, priority?, date, time,
  // endTime} and, on the fresh answer, the crew openings when no crew was free; pricing: a builder quote's approval state.
  // seen (jobCustomerAccess): an estimator who may not see the customer gets their customer reference and no CRM contact.
  function result(saved, replayed, warnings, checkout = null, crew = null, seen = { full: true, ref: '' }) {
    return { ok: true, authority: 'employee_hub', requestId: input.requestId, replayed, ...(checkout ? { checkout } : {}), job: { id: saved.id, revision: saved.revision, customerId: shownCustomerId(saved.customerId, seen), projectId: saved.projectId, sourceWalkthroughId: saved.sourceWalkthroughId || '', date: saved.date, time: saved.time, endTime: saved.endTime, status: state(saved), assignedCrew: access.dispatcher ? saved.assignedCrew || [] : [], crewNeeded: saved.crewNeeded, highlevelContactId: seen.full ? saved.highlevelContactId || '' : '', highlevelAppointmentId: saved.highlevelAppointmentId || '', highlevelOpportunityId: saved.highlevelOpportunityId || '', syncStatus: saved.syncStatus || 'pending' }, warnings: access.dispatcher ? warnings : authorRuleRows(warnings), financialState: 'accepted_quote_not_payment', fieldJobUrl: `/crew/job.html?jobId=${encodeURIComponent(saved.id)}`,
      ...(plain(crew) ? { crew: { ...crew, date: saved.date || '', time: saved.time || '', endTime: saved.endTime || '' } } : {}), ...(plain(saved.compositeQuote) || plain(saved.pricesPendingApproval) ? { pricing: pricingView(saved) } : {}) };
  }
  const prior = await replay(); if (prior) return prior;
  // D-DEPOSIT: a new signature is on the current terms. A page still showing the earlier 50% terms (opened before they
  // changed) is refused, and nothing is saved; a save it made before is replayed above, on the terms it was signed on.
  if (plan.terms_version !== CURRENT_SIGNED_TERMS) throw fail('terms_outdated', 'This signature is on the earlier deposit terms (50% upfront). Nothing was saved. Reload the walkthrough so the homeowner reviews and signs the current terms: a 25% deposit now and the remaining 75% on the job day.');
  // An estimator names a customer they may not see only by their own customer-resolve reference, under an agreeing name.
  const named = await authorCustomer(store, actor, access, input.customerId, { env, clientName: plan.client.name, prefix: 'handoff_',
    source: input.sourceWalkthroughId && safeId(input.sourceWalkthroughId) ? await store.read('jobs', input.sourceWalkthroughId) : null, job: input.jobId ? await store.read('jobs', input.jobId) : null });
  const customer = named.customer; requireRevision(customer);
  if (!identityMatches(plan.client, customer)) throw fail('customer_mismatch', 'The signed customer details do not match the selected customer. Review the phone, email and CRM link.');
  let source = null;
  if (input.sourceWalkthroughId) {
    if (!safeId(input.sourceWalkthroughId)) throw fail('invalid_source', 'Choose a valid walkthrough.');
    source = await store.read('jobs', input.sourceWalkthroughId); requireRevision(source);
    if (source.type !== 'walkthrough' || source.recordType || source.revision !== input.sourceRevision || ['cancelled', 'canceled', 'noshow', 'no_show'].includes(state(source))) throw fail('source_changed', 'The walkthrough changed or was cancelled. Refresh and review it before saving.');
    if (source.customerId ? source.customerId !== customer.id : !identityMatches(source, customer)) throw fail('source_mismatch', 'The source walkthrough must belong to the exact same customer.');
    if (source.highlevelContactId && customer.highlevelContactId && source.highlevelContactId !== customer.highlevelContactId) throw fail('source_mismatch', 'The source and customer point to different CRM contacts.');
  }
  const sourceProject = source?.projectId ? await store.read('projects', source.projectId) : null;
  if (sourceProject) { requireRevision(sourceProject); if (sourceProject.customerId !== customer.id) throw fail('source_mismatch', 'The source project belongs to a different customer.'); }
  else if (source?.projectId) throw fail('source_unavailable', 'The source project is missing. Review the walkthrough linkage.', 503);
  const previous = input.jobId ? await store.read('jobs', input.jobId) : null;
  if (input.jobId) {
    requireRevision(previous);
    if (!operational(previous) || previous.customerId !== customer.id || (previous.sourceWalkthroughId || '') !== (source?.id || '') || previous.revision !== input.expectedRevision) throw fail('job_changed', 'The existing job changed or belongs to a different walkthrough. Open its current record before revising it.');
    if (!['scheduled', 'unscheduled', 'draft'].includes(state(previous)) || previous.fieldLastActionAt || previous.fieldExecution && (Object.keys(previous.fieldExecution).some(key=>key!=='photos') || (previous.fieldExecution.photos || []).some(photo=>photo.category!=='walkthrough'))) throw fail('work_started', 'This job has already entered the field workflow. Use the explicit scope and finance revision tools rather than replacing its signed handoff.');
  }
  // A quote author who is not a dispatcher places an unplaced job but never moves
  // one Dispatch has placed (P2-12: sales cannot change dispatch): its schedule,
  // service address and required crew size stay exactly as Dispatch saved them.
  let placedAddress = null;
  if (previous && !access.dispatcher) {
    const restricted = restrictedAuthor(actor, access, env);
    if (!authorsJob(previous, source, actor, restricted, restricted && await walkthroughVisible(source, actor, env))) throw fail('revision_forbidden', 'Only an operations manager or owner can revise this job. Start from its walkthrough or quote draft.', 403);
    const unplaced = state(previous) === 'unscheduled' && !previous.date && !previous.time;
    if (!unplaced && (plan.quote.job_date !== previous.date || (previous.endDate || previous.date) !== plan.quote.job_date || plan.quote.start_time !== previous.time || plan.quote.end_time !== previous.endTime)) throw fail('schedule_change_forbidden', `Only an operations manager or owner can move a scheduled job. Keep its saved schedule${previous.date ? ` (${previous.date} ${previous.time || ''}–${previous.endTime || ''})` : ''} or ask Dispatch to move it.`, 403);
    if (!unplaced && !sameAddress(plan.client.address, previous.address)) throw fail('schedule_change_forbidden', `Only an operations manager or owner can change the service address of a scheduled job. Keep its saved address or ask Dispatch to change it.`, 403);
    if (!unplaced) placedAddress = previous.address;
    const savedCrew = Number(previous.crewNeeded);
    if (!unplaced && savedCrew !== plan.logistics.crew_size) throw fail('schedule_change_forbidden', `Only an operations manager or owner can change the crew size of a scheduled job. Keep its saved crew size${Number.isInteger(savedCrew) && savedCrew > 0 ? ` (${savedCrew})` : ''} or ask Dispatch to change it.`, 403);
  }
  if (source?.convertedJobId && source.convertedJobId !== previous?.id) throw fail('existing_job', 'This walkthrough already has a saved job. Recover that job rather than creating another.');
  // EGC_QUOTE_BUILDER_ENABLED: a builder quote is priced here from the selection the plan sends, else the one the job
  // being signed was saved with (a builder draft or an earlier signed builder quote), and never from the browser's
  // amounts: the signed total, and any lines and menu version the page sends, must be exactly the server's (409
  // handoff_builder_price_mismatch). Prices the owner has not approved still book the job (pricesPendingApproval).
  // The labor estimate reads the signed plan's fullness. A job signed before the Labor line, revised with its own
  // selection, keeps its signed price by the earlier rules (signedWithoutLabor); any other selection with garage work
  // needs labor, and a junk-only one is $1,000 per truck with no Labor line (D-JUNK). The Labor line the customer signs is
  // the server's own, "Labor" and its amount (D-LABOR-TEXT): a page still showing the man-hours is refused like any
  // other line that differs (builderMismatch), so the quote is built again before the homeowner signs.
  const chosen = !builderOn ? null : builderSent ? signedInput.quote.composite_pricing : savedSelection(previous);
  const legacy = signedWithoutLabor(previous, chosen), selection = withSignedGarage(withSignedFullness(chosen, plan), plan);
  let builder = null, signedSale = null, pickupWaiver = null;
  if (selection) {
    builder = priceCompositeQuote(await compositeState(env), selection, { complete: true, requireLabor: !legacy });
    // EGC_WINTER_SALE: a saved sale quote signed in person gets the server's sale line for the signing day and the booked
    // day (winter-sale.js signedWinterSale), or is refused when it no longer qualifies (409 handoff_winter_sale_*: nothing
    // was saved, and the page releases the request so the quote is built again).
    try { ({ builder, record: signedSale } = await signedWinterSale(previous, builder, { quote: signedInput.quote, jobDate: plan.quote.job_date, now, env, readers: winterSale, sourceWalkthroughId: source?.id || '', actor: actor.user })); }
    // Only the sale's own refusals are final; anything else (settings that fail verification, a read outage) stays a
    // retryable 503 handoff_unavailable.
    catch (error) { if (['winter_sale_ineligible', 'winter_sale_disabled'].includes(error?.code)) throw Object.assign(error, { code: `handoff_${error.code}`, status: 409 }); throw error; }
    // Minimum pickup (pickup-minimum.js): a truck-nearby waiver is confirmed for the booked day and the signed address, or
    // refused (409 handoff_pickup_waiver_unconfirmed, nothing saved).
    // The owner's override saved for this very day (and reason) carries to anyone's signature.
    const owned = builder?.compositePricing?.nearbyTruck ? savedOwnerWaiver(previous?.minimumWaiver || previous?.quoteDraft?.minimumWaiver, { date: plan.quote.job_date || '', reason: builder.compositePricing.nearbyTruck.reason }) : null;
    const confirmed = owned || await confirmNearbyTruck({ priced: builder, owner: isOwner(actor), jobId: previous?.id || '', date: plan.quote.job_date || '', address: plan.client.address, nearbyJobs: date => pickup.nearby(env, date), prefix: 'handoff_' });
    if (confirmed) pickupWaiver = owned || waiverRecord(confirmed, { reason: builder.compositePricing.nearbyTruck.reason, by: actor.user, at: now });
    const mismatch = builderMismatch(signedInput.quote, builder, Math.round(plan.quote.total * 100));
    if (mismatch) throw mismatch;
    // D-JUNK: a junk-only quote is $1,000 per truck with no Labor line, so it prices no garage work; the walkthrough the
    // homeowner signs must record none (walkthroughGarageWork). Nothing is saved: the quote is built again or the
    // walkthrough corrected, and the homeowner signs that.
    const work = builder.junkOnly ? walkthroughGarageWork(plan.scope) : [];
    if (work.length) throw fail('builder_junk_only_garage_work', `This junk-only quote prices the hauling only (the truck price covers the crew's time; it has no Labor line), but the walkthrough records garage work: ${listNames(work)}. Nothing was saved. Add that work in the quote builder (a garage cleaning base for sorting and reset, cleaning, shelving or storage), or, if the homeowner wants junk removal only, choose Everything goes or Customer labels before arrival as the sorting plan and remove those finish options. Then have the homeowner sign again.`);
    plan = normalizeHandoffPlan(withoutQuoteLines(signedInput), now, { builder, purchase });
  }
  // EGC_QUOTE_BUILDER_ENABLED: a quote the builder did not price (no builder selection sent or saved) is held as well
  // (walkthroughHold: walkthrough_priced), like a quote draft priced outside the builder; a Hub catalog quote draft
  // signed exactly as the server priced it keeps the catalog's own approval, as its send does (quote-draft.js), and the
  // owner, who approves prices, signing it in person is that approval.
  const walkthroughPriced = builderOn && !builder && !catalogSigned(previous, plan) && !isOwner(actor);
  const pricesPending = Boolean(builder && !builder.approval.ready), held = pricesPending || walkthroughPriced;
  // The sold lines with their purchase fields (the stored estimate has none): what the crew buys and the breakdown.
  const purchaseLines = purchase && !builder && plan.quote.itemized ? normalizeLineItems(signedInput.quote.line_items, { strict: true, purchase: true }).lineItems : null;
  const soldPlan = purchaseLines ? { ...plan, quote: { ...plan.quote, estimate_line_items: purchaseLines } } : plan;
  const roster = await store.roster(), assignedText = text(plan.logistics.assigned_to || '', 'Crew assignment', 500);
  // A quote author who is not a dispatcher keeps the saved crew exactly. Any other
  // name, one on the roster or not, gets the same refusal, so it cannot be used to
  // learn who is on the roster.
  const forbidden = () => fail('crew_assignment_forbidden', 'Only an operations manager or owner can assign crew. Clear the crew names; Dispatch will staff the job.', 403);
  // AUTH-ROLES (EGC_STAFF_ROLE_ACCESS): their crew names are ignored instead, unread, and
  // a sale that lands without crew is flagged 'Sold: needs crew' for a manager (soldNeedsCrew).
  const roleAccess = !access.dispatcher && staffRoleAccessEnabled(env), crewIgnored = roleAccess && Boolean(assignedText) && !/^crew of \d+$/i.test(assignedText);
  let assignedCrew;
  if (roleAccess) assignedCrew = previous?.assignedCrew || [];
  else if (!assignedText || /^crew of \d+$/i.test(assignedText)) assignedCrew = previous?.assignedCrew || [];
  else assignedCrew = jobCrewNames({ assignedTo: assignedText }).map(name => {
    const key = assignmentKey(name), exact = roster.filter(person => person.id === key), aliases = exact.length ? exact : roster.filter(person => assignmentKey(person.name) === key);
    if (aliases.length !== 1) throw access.dispatcher ? fail('crew_unverified', 'A requested crew member is not a unique active employee. Use the exact employee name or leave assignment for Dispatch.') : forbidden();
    return aliases[0].id;
  });
  if (!access.dispatcher && !roleAccess) {
    if (canonical([...assignedCrew].sort()) !== canonical([...(previous?.assignedCrew || [])].sort())) throw forbidden();
    assignedCrew = previous?.assignedCrew || [];
  }
  // EGC_DISPATCH_CREW_AUTO_ASSIGN: Dispatch staffs the job itself (options.autoCrew: the first free crew in priority
  // order for the day, Crew 1 then Crew 2, Crew 3 on weekends) and flags Sold: needs crew only when no crew is free.
  // A crew chosen from the crew openings goes with the date and time it was offered for (options.crewChoice: eligible
  // crews only, tried first) on a job no one has staffed; any other choice is left to Dispatch.
  const soldNeedsCrew = !autoCrew && roleAccess && !assignedCrew.length;
  const placing = !previous || previous.date !== plan.quote.job_date || (previous.endDate || previous.date) !== plan.quote.job_date || previous.time !== plan.quote.start_time || previous.endTime !== plan.quote.end_time;
  const chosenCrew = autoCrew && crewChoice && placing && !assignedCrew.length ? crewChoice : null;
  let choiceDropped = false;
  // EGC_JOB_MATERIALS: the bring list goes in the crew brief, becomes the job's grab list and is merged into its required
  // equipment, and the sold scope is saved as the job breakdown (job.jobBreakdown, and its lines in the crew brief).
  // Off: none of these is read or written. The job (or, for a new job, its walkthrough) is what the handoff revises:
  // a revision swaps only what the earlier bring list put in the equipment (job-materials.js handoffEquipment), so
  // equipment added in Dispatch stays; a page that sends no bring list keeps the earlier list, equipment and grab list.
  const sent = structured && plan.logistics.bring_list !== undefined && plan.logistics.bring_list !== null;
  const equipment = sent ? bringList(plan.logistics.bring_list) : null;
  if (sent && equipment === null) throw fail('invalid_plan', 'The equipment list could not be verified. Review the walkthrough and save it again.', 400);
  const base = previous || source, earlierBring = structured ? savedBringList(base?.jobInstructions) : [], bring = equipment ?? earlierBring;
  const breakdown = structured ? builder ? builderBreakdown(jobBreakdown(plan), builder) : jobBreakdown(soldPlan) : null, materialsSource = previous ? previous.materials : source?.materials;
  const requiredEquipment = sent ? handoffEquipment({ current: base?.requiredEquipment, earlier: earlierBring, bring: equipment }) : null;
  const instructions = stripCrewMoneyDeep({ ...handoffInstructions(plan, source?.id || '', builder), ...(structured ? { ...(bring.length ? { bringList: bring } : {}), jobBreakdown: breakdownLines(breakdown) } : {}) }), crewNotes = stripCrewMoney(plan.notes);
  // The service every customer surface names (the portal, the money documents, Stripe): a junk-only builder quote is
  // 'Junk removal' (D-JUNK: its signed scope is junk removal only), any other signed walkthrough 'Garage transformation'.
  const changes = { date: plan.quote.job_date, endDate: plan.quote.job_date, time: plan.quote.start_time, endTime: plan.quote.end_time, title: plan.quote.title, address: placedAddress ?? plan.client.address, serviceType: builder?.junkOnly ? 'Junk removal' : 'Garage transformation', crewNeeded: plan.logistics.crew_size, assignedCrew, jobInstructions: stripCrewMoney(plan.crew_brief), accessInstructions: instructions.accessNotes, customerInstructions: crewNotes, notify: access.dispatcher || previous?.notify !== false,
    ...(structured ? { ...(requiredEquipment ? { requiredEquipment } : {}), ...structuredMaterialChanges(soldPlan, materialsSource, equipment, builder) } : materialChanges(plan, materialsSource, builder)) };
  const dispatchInput = previous ? { action: 'schedule.update', requestId: input.requestId, jobId: previous.id, expectedRevision: previous.revision, changes } : { action: 'schedule.create', requestId: input.requestId, customerId: customer.id, kind: 'job', ...(source ? { sourceWalkthroughId: source.id } : {}), booking: { channel: 'hub_in_person' }, changes };
  // The chosen crew replaces the (empty) people list: Dispatch copies the crew's members and lead, then picks.
  const choiceInput = chosenCrew ? { ...dispatchInput, changes: { ...Object.fromEntries(Object.entries(changes).filter(([key]) => key !== 'assignedCrew')), crewId: chosenCrew } } : null;
  const adapter = { ...store,
    // FUN-29: a job sold on a signed walkthrough plan came through the walkthrough path, and its signed lines are sold evidence.
    dimensionFacts: { walkthroughSale: true, lineItems: plan.quote.itemized ? plan.quote.estimate_line_items : null },
    // EGC_GHL_SCHEDULE_MIRROR (D9b): the HighLevel note Dispatch queues with this save reads what the commit below adds
    // after Dispatch's patch: the job breakdown (EGC_JOB_MATERIALS) and the estimated time on site (ghl-schedule-mirror.js).
    scheduleMirrorFacts: { estimatedDurationMin: plan.quote.estimated_duration_min, ...(breakdown ? { jobBreakdown: breakdown } : {}) },
    read: async (collection, id) => {
      const row = await store.read(collection, id);
      // An orphan legacy walkthrough can acquire only the exact verified
      // customer link; the original revision is fenced in the atomic commit.
      return collection === 'jobs' && source?.id === id && row?.revision === source.revision && !row.customerId ? { ...row, customerId: customer.id } : row;
    },
    commit: async writes => {
      const target = writes.find(write => write.collection === 'jobs' && write.patch?.dispatchRequestId === input.requestId);
      if (!target) throw fail('commit_incomplete', 'The complete dispatch handoff could not be prepared.', 503);
      // D-LABOR-TEXT: the customer's Labor line reads "Labor"; the HighLevel internal brief (api/highlevel.js quoteLines)
      // names the man-hours sold from labor_man_hours, for the staff only. The snapshot's deposit is the estimate's (a
      // revision already paid more than the new 25% keeps what was paid as its deposit: signedPaymentTerms).
      const finance = financePatch(plan, previous, target.id, actor, now, builder);
      const providerPayload = { ...plan, quote: { ...plan.quote, deposit: finance.estimate.depositRequired, ...(typeof builder?.labor?.manHours === 'number' ? { labor_man_hours: builder.labor.manHours } : {}) }, signature: undefined, tool: 'game_plan', job_id: target.id, walkthrough_id: source?.id || '', idempotency_key: `walkthrough-handoff:${input.requestId}`, sent_at: now };
      delete providerPayload.signature;
      // Prices the owner has not approved yet: no portal invitation (the estimate and deposit request) is asked for, and
      // one asked for earlier is withdrawn, until the builder's send gate releases the job (releaseHandoffPrices); every
      // customer surface withholds a held job (quote-model.js pricesPendingApproval).
      const invitation = !held ? { customerPortalInvitationRequestedAt: previous?.customerPortalInvitationRequestedAt || now } : previous?.customerPortalInvitationRequestedAt ? { customerPortalInvitationRequestedAt: null } : {};
      Object.assign(target.patch, finance, refPatch(named, actor, plan.client.name), { handoffVersion: 1, handoffRequestId: input.requestId, handoffFingerprint: fingerprint, acceptedHandoffPayload: providerPayload, sourceWalkthroughId: source?.id || '', customer: plan.client.name, phone: plan.client.phone, email: plan.client.email, scope: plan.scope, discovery: plan.discovery, logistics: plan.logistics, jobInstructions: instructions, internalNotes: plan.internal_notes, clientChecklists: plan.client_checklists, notes: plan.notes, customerNotesSummary: crewNotes || instructions.customerGoal, durationMin: (Date.parse(plan.quote.end_at) - Date.parse(plan.quote.start_at)) / 60000, estimatedDurationMin: plan.quote.estimated_duration_min, estimatedDurationHours: plan.quote.estimated_duration_min / 60, expectedShiftHours: plan.quote.expected_shift_hours, crewSize: plan.logistics.crew_size, photoCount: plan.photos.before, photoSyncStatus: previous?.photoSyncStatus || 'device_only', walkthroughSyncedAt: now, syncIdempotencyKey: providerPayload.idempotency_key, walkthroughAppointmentId: source?.highlevelAppointmentId || previous?.walkthroughAppointmentId || '', providerSyncOwner: 'operations', syncStatus: 'pending', ...invitation });
      if (typeof target.patch.operationalScope?.text === 'string') target.patch.operationalScope.text = stripCrewMoney(target.patch.operationalScope.text);
      if (soldNeedsCrew) target.patch.soldNeedsCrew = { at: now, by: actor.user, requestId: input.requestId };
      if (breakdown) target.patch.jobBreakdown = breakdown;
      if (builder) Object.assign(target.patch, builderPatch(builder, previous, actor, input.requestId, now));
      else if (walkthroughPriced) Object.assign(target.patch, walkthroughHold(previous, actor, input.requestId, now));
      // A walkthrough-priced revision (the builder switched off) or a catalog-priced one leaves no stale builder prices behind.
      else if (plain(previous?.compositeQuote) || plain(previous?.pricesPendingApproval)) Object.assign(target.patch, { compositeQuote: null, pricesPendingApproval: null });
      // The signed job's winter sale record: the one signed with it, else none once the signed estimate has no sale line.
      const saleRecord = signedSale || (hasWinterSaleLine(finance.estimate.lineItems) && previous?.quoteDraft?.winterSale) || null;
      if (plain(previous?.quoteDraft) && (saleRecord || plain(previous.quoteDraft.winterSale))) target.patch.quoteDraft = { ...(target.patch.quoteDraft || previous.quoteDraft), winterSale: saleRecord };
      // The confirmed truck-nearby waiver, on the job and its quote draft (audited below).
      // A signature without one clears an earlier revision's record, so it never holds the job to a day.
      if (pickupWaiver || plain(previous?.minimumWaiver) || plain(previous?.quoteDraft?.minimumWaiver)) {
        target.patch.minimumWaiver = pickupWaiver || null;
        if (plain(previous?.quoteDraft)) target.patch.quoteDraft = { ...(target.patch.quoteDraft || previous.quoteDraft), minimumWaiver: pickupWaiver || null };
      }
      const pendingNames = pricesPending ? builder.approval.blocked.map(row => row.name) : [];
      const roleWarnings = [...(crewIgnored ? [{ code: 'crew_assignment_ignored', jobId: target.id, message: 'Crew names were not saved. A manager assigns the crew in Dispatch.' }] : []), ...(soldNeedsCrew ? [{ code: 'sold_needs_crew', jobId: target.id, message: 'Sold: needs crew. A manager assigns the crew in Dispatch.' }] : []),
        ...(choiceDropped ? [{ code: 'crew_choice_unavailable', jobId: target.id, message: 'The chosen crew can no longer take this visit, so Dispatch assigned the first free crew instead.' }] : []),
        ...(pricesPending ? [{ code: 'prices_pending_approval', jobId: target.id, message: `Booked with ${pendingNames.length} price${pendingNames.length === 1 ? '' : 's'} the owner has not approved yet: ${listNames(pendingNames)}. The estimate and deposit request are not sent to the customer until the owner approves them in Hub > Catalog & pricing.` }] : []),
        ...(walkthroughPriced ? [{ code: 'prices_pending_approval', jobId: target.id, message: 'Booked with walkthrough prices, which the quote builder did not price. The estimate and deposit request are not sent to the customer until the quote is built in the quote builder and signed, or the owner releases these prices.' }] : [])];
      function fence(collection, row, patch) {
        requireRevision(row);
        const found = writes.find(write => write.collection === collection && write.id === row.id);
        if (found) {
          if (found.revision !== row.revision) throw fail('source_changed', 'Customer or source evidence changed during save. Refresh and retry.');
          if (patch) { found.verify = false; found.patch = { ...found.patch, ...patch }; }
        } else writes.push({ collection, id: row.id, revision: row.revision, ...(patch ? { patch } : { verify: true }) });
      }
      // Also brings a legacy customer's derived phone/email lookup keys current.
      fence('customers', customer, customerIdentityPatch(customer, now));
      if (sourceProject) fence('projects', sourceProject);
      // The job as it stands before this signature holds the live sale the signature retires.
      const saleJob = { ...previous, ...target.patch, id: target.id }, created = writes.some(write => write.collection === 'projects' && write.id === saleJob.projectId && !write.revision);
      const saleProject = !funnelHubId(saleJob.projectId) || created ? null : sourceProject?.id === saleJob.projectId ? sourceProject : await store.read('projects', saleJob.projectId);
      const sale = await saleEvents({ plan, source, job: saleJob, actor, requestId: input.requestId, receiptId, now, dimensions: pendingProjectDimensions(saleProject, writes, saleJob.projectId) });
      if (sale.funnelSale) target.patch.funnelSale = sale.funnelSale;
      // A signed handoff records the walkthrough's sold_on_site outcome (FUN-02). A walkthrough
      // the rep Started (FUN-05) gets its outcome, completion and event from its own Finish, and
      // an outcome the walkthrough visit already recorded is never overwritten.
      const ownOutcome = plain(source?.walkthroughOutcome) || plain(source?.walkthroughVisit) && instantMs(source.walkthroughVisit.startedAt) !== null;
      if (source) fence('jobs', source, { customerId: customer.id, convertedJobId: target.id, conversionStatus: 'job_scheduled', updatedAt: now, ...(ownOutcome ? {} : { walkthroughOutcome: soldOutcome(source, sale.writes.at(-1).patch, actor, input.requestId, plan.acceptance.accepted_at) }) });
      // Scheduling a sold job is not proof the source visit has completed.
      // Its original status, actual completion time, signature and money stay intact.
      writes.push(...sale.writes);
      const dispatchReceipt = writes.find(write => write.collection === 'dispatchOperations' && write.id === receiptId);
      // The crew outcome a quote author may see (dispatch-crew-assign.js: status, crew name and priority only).
      const auto = dispatchReceipt?.patch?.metadata?.crewAutoAssigned, crewAuto = plain(auto) ? { status: auto.status, ...(auto.status === 'assigned' ? { crewName: typeof auto.crewName === 'string' ? auto.crewName : null, priority: Number.isInteger(auto.priority) ? auto.priority : null } : {}) } : null;
      if (pickupWaiver) writes.push(waiverAudit(auditWrite, pickupWaiver, { actor, jobId: target.id, requestId: input.requestId, now }));
      writes.push({ collection: 'walkthroughHandoffs', id: receiptId, patch: { fingerprint, actorId: actor.user, customerId: customer.id, jobId: target.id, sourceWalkthroughId: source?.id || '', sourceRevision: source?.revision || '', originalJobRevision: previous?.revision || '', acceptedAt: plan.acceptance.accepted_at, amountCents: Math.round(plan.quote.total * 100), signature: plan.signature, plan: providerPayload, priorEstimate: previous?.estimate || null, priorAcceptance: previous?.acceptance || null, createdAt: now, warnings: [...(dispatchReceipt?.patch?.warnings || []), ...roleWarnings], ...(crewAuto ? { crewAuto } : {}) } });
      await store.commit(writes);
    },
  };
  // DISPATCH-RULES: a handoff that leaves staffing to Dispatch (no one assigned,
  // or a quote author who cannot assign crew) is saved with the crew-size
  // shortfall as a warning, since only Dispatch can fill it. Every other owner
  // block applies, and its refusal names the rule (details.conflicts).
  const staffingLeftToDispatch = !access.dispatcher || !assignedCrew.length;
  const enforce = warning => !(staffingLeftToDispatch && warning.code === 'crew_size_short');
  const options = { authorize: session => requireQuoteAuthor(session, env), enforce, saleChecked: true, ...(autoCrew ? { autoCrew: true } : {}) };
  let dispatched = null;
  try {
    try { dispatched = await mutateDispatch(adapter, actor, choiceInput || dispatchInput, now, choiceInput ? { ...options, crewChoice: true } : options); }
    catch (error) {
      // An offered crew that can no longer take the visit (made inactive or removed, a member who left, or a manager
      // staffed the job) never costs the sale: nothing was saved, so the same request goes again without the choice
      // and Dispatch picks the crew.
      if (!choiceInput || !CHOICE_REFUSALS.has(error?.code)) throw error;
      choiceDropped = true;
      dispatched = await mutateDispatch(adapter, actor, dispatchInput, now, options);
    }
  }
  catch (error) {
    const recovered = await replay(); if (recovered) return recovered;
    if (!access.dispatcher && Array.isArray(error?.details?.conflicts)) error.details = { conflicts: authorRuleRows(error.details.conflicts) };
    throw error;
  }
  const saved = await replay();
  if (!saved) throw fail('outcome_unknown', 'The save could not be read back. Retry the identical request; do not create a second job.', 503);
  // No crew free: the crew openings Dispatch found for the following week (rep-safe projectCrewOpenings rows).
  const alternatives = Array.isArray(dispatched?.autoCrew?.alternatives) ? dispatched.autoCrew.alternatives : null;
  return { ...saved, replayed: false, ...(saved.crew && alternatives ? { crew: { ...saved.crew, alternatives } } : {}) };
}

// A builder job's estimate keeps the internal goods split its signed snapshot leaves out (financePatch): the two are
// compared without it. Any other job compares its lines exactly, as before.
const INTERNAL_LINE = ['split', 'durationMinutes'];
const signedEstimateLines = (job, lines) => plain(job.compositeQuote) && Array.isArray(lines) ? lines.map(line => plain(line) ? Object.fromEntries(Object.entries(line).filter(([key]) => !INTERNAL_LINE.includes(key))) : line) : lines ?? null;
/** Provider synchronization reads the saved signed snapshot, never an incoming
 * browser price, provider appointment, or claim that work/payment completed. */
export function savedHandoffPayload(job, handoffRequestId) {
  const p = job?.acceptedHandoffPayload;
  if (job?.handoffVersion !== 1 || !p || job.handoffRequestId !== handoffRequestId || !['accepted', 'approved'].includes(job.estimate?.status) || job.estimate.amount !== p.quote.total || job.estimate.depositRequired !== p.quote.deposit || job.acceptance?.acceptedAt !== p.acceptance.accepted_at || canonical(job.scope || {}) !== canonical(p.scope || {}) || p.quote.itemized === true && canonical(signedEstimateLines(job, job.estimate.lineItems)) !== canonical(signedEstimateLines(job, p.quote.estimate_line_items)) || ['cancelled','canceled','completed','paid','invoiced','closed'].includes(state(job))) throw fail('sync_snapshot_changed', 'The signed handoff changed. Review the current saved job before synchronizing it.');
  const start = localInstant(job.date, job.time), end = localInstant(job.endDate || job.date, job.endTime);
  if (!start || !end || end <= start) throw fail('invalid_schedule', 'The current Hub schedule needs review before CRM synchronization.');
  // notify is the saved Dispatch choice: a job Dispatch marked silent never runs customer appointment automations.
  // idempotency_key is the job's current appointment request (Dispatch's after a move). The Job Brief belongs to the
  // signed handoff instead: handoff_brief keys it on the handoff's own request and writes it from the signed quote, so a
  // rebuild after a Dispatch move replays the first note (same key, same body) rather than adding a second one.
  return { ...p, job_id: job.id, idempotency_key: job.syncIdempotencyKey, handoff_brief: { idempotency_key: p.idempotency_key || `walkthrough-handoff:${handoffRequestId}`, quote: p.quote }, notify: job.notify !== false, opportunity_id: job.highlevelOpportunityId || '', client: { ...p.client, highlevel_contact_id: job.highlevelContactId || p.client.highlevel_contact_id || '', highlevel_job_appointment_id: job.highlevelAppointmentId || '', highlevel_appointment_id: job.walkthroughAppointmentId || '' }, quote: { ...p.quote, job_date: job.date, start_time: job.time, end_time: job.endTime, start_at: start, end_at: end }, walkthrough_id: job.sourceWalkthroughId || '' };
}
