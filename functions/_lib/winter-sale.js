/** Early-bird winter sale (owner decisions 2026-10-21, EGC_WINTER_SALE exactly "true"): up to $400 off any quote, shown to
 * the customer as its own discount line, "Early-bird winter sale", with the amount actually given, never folded into
 * Labor or an item price (D-LABOR-TEXT).
 *
 * A quote gets it only when the server decides (winterSaleDecision); the browser can only ask:
 *   - it is accepted on or before signBy (2027-01-31, America/Denver): a sale quote's expiry is held at that day, and an
 *     estimate past its expiry is never approved (customer portal, Hub Record approval);
 *   - the job is done jobFrom..jobTo inclusive (2026-12-01..2027-02-28). A draft with no job date yet may carry the line;
 *     its send needs the booked date inside the window, and the customer portal refuses an approval once the job moved
 *     outside it;
 *   - the amount is capped (winterSaleCap) so the job's estimated margin after it stays at least marginFloorBp (30%):
 *     min(amountCents, the most that keeps the margin at the floor, in whole dollars, below the quote total). The
 *     margin costs the quote's own man-hours, goods, truck loads and commission channel with the owner's Job actuals
 *     cost settings (job-actuals.js, the same functions the completed-job report uses). A cap of $0 adds no line. Until
 *     every cost setting is entered the margin is unknown and the sale is not applied. A junk-only quote has no Labor
 *     line: its crew time is the owner's junkManHoursPerLoad x its truck loads, and without that setting its margin is
 *     unknown too. The owner may give the full amount anyway (margin rule only), with a reason
 *     that is audited; the date rules are the sale's own terms.
 * Estimators and crew only ever see "eligible" or a plain reason (winterSalePublic); never a margin, a cost or pay.
 *
 * Settings: server-only winterSaleSettings/current {schemaVersion:1, amountCents, signBy, jobFrom, jobTo,
 * marginFloorBp, junkManHoursPerLoad, updatedAt, updatedBy, requestId}; absent means WINTER_SALE_DEFAULTS. Only the owner writes them
 * (mutateWinterSaleSettings: receipt in winterSaleSettingsOperations and an owner-visibility hub_audit entry in the same
 * commit, under the stored revision), through POST /api/job-actuals. */
import { auditWrite } from './hub-audit.js';
import { isHubOwner } from './hub-session.js';
import { standardCostStorage } from './standard-costs.js';
import { estimateTotals, included } from './quote-model.js';
import { commissionFor, divRoundHalfUp, laborCostCents, milliHours, normalizeCostSettings, percentOf, truckLoads } from './job-actuals.js';
import { requireJobActualsOwner } from './job-actuals-settings.js';

export const winterSaleEnabled = env => env?.EGC_WINTER_SALE === 'true';
export const WINTER_SALE_LINE_ID = 'winter-sale';
export const WINTER_SALE_LINE_NAME = 'Early-bird winter sale';
export const WINTER_SALE_SETTINGS = 'winterSaleSettings', WINTER_SALE_SETTINGS_OPERATIONS = 'winterSaleSettingsOperations', CURRENT = 'current';
export const WINTER_SALE_SETTINGS_ACTION = 'winter_sale.settings.set';
export const WINTER_SALE_DEFAULTS = Object.freeze({ amountCents: 40000, signBy: '2027-01-31', jobFrom: '2026-12-01', jobTo: '2027-02-28', marginFloorBp: 3000, junkManHoursPerLoad: null });
const SETTING_KEYS = Object.freeze(Object.keys(WINTER_SALE_DEFAULTS));
const CENTS_MAX = 10000000;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = (code, message, status = 400, details) => Object.assign(new Error(message), { code: `winter_sale_${code}`, status, ...(details ? { details } : {}) });
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : plain(value) ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value);
const digest = async value => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map(byte => byte.toString(16).padStart(2, '0')).join('');
const realDate = value => typeof value === 'string' && DATE.test(value) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const usd = cents => (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
const dayText = date => new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' });

/** Whether one setting value is valid on its own. */
export function validWinterSaleSetting(key, value) {
  if (key === 'amountCents') return Number.isSafeInteger(value) && value >= 1 && value <= CENTS_MAX;
  if (key === 'marginFloorBp') return Number.isSafeInteger(value) && value >= 0 && value <= 9000;
  // Junk-only quotes have no Labor line: the owner's man-hours per truck load cost their crew time (null: not entered).
  if (key === 'junkManHoursPerLoad') return value === null || typeof value === 'number' && value >= 0.25 && value <= 24 && Number.isInteger(value * 4);
  return ['signBy', 'jobFrom', 'jobTo'].includes(key) && realDate(value);
}
/** A complete, valid settings object or a coded error naming the first problem. */
export function normalizeWinterSaleSettings(input) {
  if (!plain(input) || Object.keys(input).length !== SETTING_KEYS.length || SETTING_KEYS.some(key => !Object.hasOwn(input, key))) throw fail('settings_invalid', 'Send every winter sale setting.');
  for (const key of SETTING_KEYS) if (!validWinterSaleSetting(key, input[key])) throw fail('settings_invalid', `The winter sale setting ${key} is invalid.`, 400, { key });
  if (input.jobFrom > input.jobTo) throw fail('settings_invalid', 'The sale\'s first job day must be on or before its last job day.', 400, { key: 'jobFrom' });
  return Object.fromEntries(SETTING_KEYS.map(key => [key, input[key]]));
}

/** The settings store: Firestore REST like the Job actuals cost settings (standard-costs.js storage). */
export const winterSaleSettingsStorage = (env, base = standardCostStorage(env)) => base;

// A stored record that fails verification fails closed: no sale is applied on settings nobody can verify.
function storedSettings(row) {
  if (!row) return { revision: null, updatedAt: null, updatedBy: null, ...WINTER_SALE_DEFAULTS };
  let settings;
  try { settings = row.schemaVersion === 1 ? normalizeWinterSaleSettings(Object.fromEntries(SETTING_KEYS.map(key => [key, row[key]]))) : null; } catch { settings = null; }
  if (!settings) throw fail('settings_unreadable', 'The winter sale settings failed verification. The owner must save them again.', 503);
  return { revision: row.revision, updatedAt: typeof row.updatedAt === 'string' ? row.updatedAt : null, updatedBy: typeof row.updatedBy === 'string' ? row.updatedBy : null, ...settings };
}
export async function readWinterSaleSettings(store) {
  return storedSettings(await store.read(WINTER_SALE_SETTINGS, CURRENT));
}

/** POST {action:'winter_sale.settings.set', requestId, expectedRevision, settings:{amountCents, signBy,
 * jobFrom, jobTo, marginFloorBp}} (owner). The same requestId replays; with a different body it is a 409. */
export async function mutateWinterSaleSettings(store, session, input, now = new Date().toISOString()) {
  requireJobActualsOwner(session);
  if (!plain(input) || Object.keys(input).some(key => !['action', 'requestId', 'expectedRevision', 'settings'].includes(key)) || input.action !== WINTER_SALE_SETTINGS_ACTION) throw fail('request_invalid', 'The winter sale request is invalid. Reload and try again.');
  if (typeof input.requestId !== 'string' || !UUID.test(input.requestId)) throw fail('request_invalid', 'A unique request ID is required. Reload and try again.');
  if (input.expectedRevision !== null && (typeof input.expectedRevision !== 'string' || !input.expectedRevision || input.expectedRevision.length > 80)) throw fail('request_invalid', 'The current winter sale settings version is required. Reload and try again.');
  const settings = normalizeWinterSaleSettings(input.settings);
  const requestId = input.requestId.toLowerCase(), fingerprint = await digest(canonical({ actor: String(session.user).toLowerCase(), input: { ...input, requestId } }));
  const receipt = await store.read(WINTER_SALE_SETTINGS_OPERATIONS, requestId);
  if (receipt) {
    if (receipt.fingerprint !== fingerprint) throw fail('idempotency_conflict', 'This request ID was already used for a different save. Reload before saving again.', 409);
    return { settings: await readWinterSaleSettings(store), requestId, replayed: true };
  }
  const current = storedSettings(await store.read(WINTER_SALE_SETTINGS, CURRENT));
  if (current.revision !== input.expectedRevision) throw fail('revision_conflict', 'The winter sale settings changed while you were editing. Load the latest and save again.', 409);
  const before = {}, after = {};
  for (const key of SETTING_KEYS) if (current[key] !== settings[key]) { before[key] = current[key]; after[key] = settings[key]; }
  if (!Object.keys(after).length) throw fail('no_change', 'These winter sale settings are already saved.');
  const audit = auditWrite({ actor: { id: session.user, kind: 'human', role: session.role }, via: 'hub', action: WINTER_SALE_SETTINGS_ACTION, entity: { collection: WINTER_SALE_SETTINGS, id: CURRENT }, before, after, requestId, visibility: 'owner', now });
  await store.commit([
    { collection: WINTER_SALE_SETTINGS, id: CURRENT, revision: current.revision, patch: { schemaVersion: 1, ...settings, updatedAt: now, updatedBy: session.user, requestId } },
    { collection: WINTER_SALE_SETTINGS_OPERATIONS, id: requestId, patch: { action: WINTER_SALE_SETTINGS_ACTION, requestId, fingerprint, actorId: session.user, at: now, changed: Object.keys(after) } },
    { collection: audit.collection, id: audit.id, patch: audit.patch },
  ]);
  return { settings: await readWinterSaleSettings(store), requestId, replayed: false };
}

/** The sale's own discount line (quote-model.js discount: stored negative) for amountCents (the amount given, at most
 * the settings' amount), with the work window in its description. */
export function winterSaleLine(settings = WINTER_SALE_DEFAULTS, amountCents = settings.amountCents) {
  const cents = -Math.abs(amountCents);
  return { id: WINTER_SALE_LINE_ID, kind: 'discount', name: WINTER_SALE_LINE_NAME, description: `For work done ${dayText(settings.jobFrom)} – ${dayText(settings.jobTo)}, accepted by ${dayText(settings.signBy)}.`,
    quantity: 1, unitCents: cents, totalCents: cents, amount: cents / 100, optional: false, selected: true, group: null, tier: null, package: null, catalog: null, customerSupplied: false, split: null, durationMinutes: null, taxable: false };
}
export const isWinterSaleLine = line => plain(line) && line.id === WINTER_SALE_LINE_ID;
export const hasWinterSaleLine = lines => Array.isArray(lines) && lines.some(line => isWinterSaleLine(line) && included(line));

/** The margin the owner's cost settings give a quote's lines (sale line included): revenue less labor at the quote's
 * man-hours (no travel), goods at their retail basis plus goods tax, the dump fee per quoted truck load, the truck cost
 * and the commission of its channel; {known, marginBp, reason}. Never returned to an estimator. */
export function estimatedSaleMargin({ lineItems, manHours, costs, channel = 'none' }) {
  const settings = normalizeCostSettings(costs);
  if (!settings.complete) return { known: false, reason: 'costs_missing' };
  const totals = estimateTotals(lineItems);
  if (!totals.complete || !Number.isSafeInteger(totals.totalCents) || totals.totalCents <= 0) return { known: false, reason: 'revenue_unknown' };
  if (!(typeof manHours === 'number' && Number.isFinite(manHours) && manHours > 0)) return { known: false, reason: 'labor_unknown' };
  const revenue = totals.totalCents, labor = laborCostCents(milliHours(manHours), settings);
  const goodsRetail = Number.isSafeInteger(totals.productCents) ? totals.productCents : 0;
  const goods = goodsRetail + percentOf(goodsRetail, settings.goodsTaxBp);
  const loads = truckLoads({ estimate: { lineItems } }).count;
  const cost = labor + goods + loads * settings.dumpFeeCentsPerLoad + settings.truckCentsPerJob + commissionFor(revenue, channel).totalCents;
  return { known: true, marginBp: divRoundHalfUp((BigInt(revenue) - BigInt(cost)) * 10000n, revenue) };
}

// The sale never takes a quote to $0: at most the whole dollars below its total.
const wholeDollarsBelow = cents => Number.isSafeInteger(cents) && cents > 100 ? Math.floor((cents - 1) / 100) * 100 : 0;
/**
 * The most of the sale a quote can take: {known:false, reason} when its margin cannot be estimated, else {known:true,
 * capCents}. capCents is the sale amount when the margin after it stays at the floor; otherwise the largest whole-dollar
 * amount that does (0: none). It is never the whole quote total. lineItems are the quote's own lines, without the sale.
 */
export function winterSaleCap({ lineItems, manHours: quoted, junkOnly = false, costs, channel = 'none', settings = WINTER_SALE_DEFAULTS }) {
  const before = estimateTotals(lineItems).totalCents, loads = truckLoads({ estimate: { lineItems } }).count;
  if (junkOnly && settings.junkManHoursPerLoad === null) return { known: false, reason: normalizeCostSettings(costs).complete ? 'junk_hours_missing' : 'costs_missing' };
  const manHours = junkOnly ? loads * settings.junkManHoursPerLoad : quoted;
  const marginAt = cents => estimatedSaleMargin({ lineItems: cents ? [...lineItems, winterSaleLine(settings, cents)] : lineItems, manHours, costs, channel });
  const base = marginAt(0);
  if (!base.known) return { known: false, reason: base.reason };
  const max = Math.min(settings.amountCents, wholeDollarsBelow(before)), ok = cents => { const margin = marginAt(cents); return margin.known && margin.marginBp >= settings.marginFloorBp; };
  if (max <= 0 || !ok(0)) return { known: true, capCents: 0 };
  if (ok(max)) return { known: true, capCents: max };
  // The margin falls as the discount grows: the largest whole-dollar amount still at the floor.
  let low = 0, high = Math.floor(max / 100);
  while (low < high) { const mid = Math.ceil((low + high) / 2); if (ok(mid * 100)) low = mid; else high = mid - 1; }
  return { known: true, capCents: low * 100 };
}

/**
 * The decision for one quote. beforeCents: its total without the sale; today: the Denver day the quote is saved, sent
 * or signed; jobDate: its booked day or null; requireJobDate: true at send and sign; cap: winterSaleCap for the quote;
 * override: the owner's {reason} to give the full amount past the margin rule, honored only when ownerOverride is true.
 * {eligible, code, reason, overridden, amountCents}: reason is the plain words an estimator sees, amountCents the
 * amount the sale line takes off.
 */
export function winterSaleDecision({ settings = WINTER_SALE_DEFAULTS, beforeCents, today, jobDate = null, requireJobDate = false, cap = null, override = null, ownerOverride = false }) {
  const no = (code, reason) => ({ eligible: false, code, reason, overridden: false, amountCents: 0 });
  if (!realDate(today) || today > settings.signBy) return no('sale_ended', `Not eligible: the sale ended ${dayText(settings.signBy)}.`);
  const window = `${dayText(settings.jobFrom)} – ${dayText(settings.jobTo)}`;
  if (jobDate !== null && jobDate !== undefined && jobDate !== '' && (!realDate(jobDate) || jobDate < settings.jobFrom || jobDate > settings.jobTo)) return no('job_date_outside', `Not eligible: the job date is outside ${window}.`);
  if (requireJobDate && !jobDate) return no('job_date_needed', `Book the job date (${window}) before sending a winter sale quote.`);
  const full = Number.isSafeInteger(beforeCents) ? Math.min(settings.amountCents, wholeDollarsBelow(beforeCents)) : 0;
  if (full <= 0) return no('nothing_to_discount', 'Not eligible: the quote has no total to take the sale off.');
  const overridden = ownerOverride && plain(override) && typeof override.reason === 'string' && override.reason.trim().length >= 3;
  const forced = { eligible: true, code: 'owner_override', reason: 'Eligible (owner override).', overridden: true, amountCents: full };
  if (!cap?.known) {
    if (overridden) return forced;
    return cap?.reason === 'costs_missing' ? no('costs_missing', 'Enter labor costs in Job actuals settings to use the winter sale.')
      : cap?.reason === 'junk_hours_missing' ? no('margin_unknown', 'Not eligible yet: junk-only quotes need the owner\'s man-hours per truck load in the winter sale settings. Ask Zac.')
      : cap?.reason === 'labor_unknown' ? no('margin_unknown', 'Not eligible: this quote has no Labor estimate to check the sale against. Ask Zac.')
        : no('margin_unknown', 'Not eligible: the sale could not be checked against this quote. Ask Zac.');
  }
  const amount = Math.min(full, cap.capCents);
  if (amount < full && overridden) return forced;
  if (amount <= 0) return no('below_floor', 'Not eligible: below the margin floor. Ask Zac.');
  if (amount < full) return { eligible: true, code: 'capped', reason: `Eligible for ${usd(amount)} off on this job (the sale is up to ${usd(settings.amountCents)}). Ask Zac for more.`, overridden: false, amountCents: amount };
  return { eligible: true, code: 'eligible', reason: 'Eligible.', overridden: false, amountCents: amount };
}

/** What an estimator sees of a saved decision: no margin, cost or pay. */
export const winterSalePublic = decision => plain(decision) ? { requested: decision.requested === true, applied: decision.applied === true, amountCents: Number.isSafeInteger(decision.amountCents) ? decision.amountCents : 0, code: String(decision.code || ''), reason: String(decision.reason || ''), overridden: decision.overridden === true } : null;

/** The owner override a request may carry: {reason} (3 to 500 characters), only from the owner. */
export function overrideFrom(request, actor) {
  if (request?.override === undefined || request.override === null) return null;
  if (!plain(request.override) || Object.keys(request.override).some(key => key !== 'reason') || typeof request.override.reason !== 'string' || request.override.reason.trim().length < 3 || request.override.reason.length > 500) throw fail('override_invalid', 'Give the reason for applying the winter sale anyway (3 to 500 characters).');
  if (!isHubOwner(actor)) throw fail('override_forbidden', 'Only the owner can apply the winter sale anyway.', 403);
  return { reason: request.override.reason.trim() };
}

/** The request field a draft may carry: {apply:true, override?:{reason}}; anything else is refused. */
export function saleRequest(value) {
  if (value === undefined || value === null) return null;
  if (!plain(value) || Object.keys(value).some(key => !['apply', 'override'].includes(key)) || typeof value.apply !== 'boolean') throw fail('request_invalid', 'The winter sale request is invalid. Reload and try again.');
  return value.apply ? value : null;
}
