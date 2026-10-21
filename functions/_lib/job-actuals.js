/** Job actuals (owner): billed versus actual man-hours and an estimated margin for every completed job.
 *
 * Every money figure is integer cents and every division rounds half up (toward +infinity at exactly half a cent),
 * in BigInt so no product of hours, rates and basis points is ever a float. Hours are carried as milli-hours.
 *
 * Billed man-hours: the Labor line the job was sold with (owner decision D12), stored on the job
 *   as jobInstructions.laborManHours (walkthrough-handoff.js), else the signed builder quote's priced labor
 *   (compositeQuote.breakdown.labor.manHours). A junk-only quote ($1,000 per truck) has no Labor line: billed is null.
 * Actual man-hours, best signal first:
 *   1. 'timecards': hours employees clocked onto this job (timecard jobTracking.segments, computeJobLaborCost in
 *      job-labor-cost.js, approved plus pending timecards). On-site work hours are compared with billed; work plus
 *      travel is the paid time the labor cost uses. Open shifts, timecards needing review and legacy job links leave
 *      hours out, so then the row says 'timecards_incomplete' and its margin is only an upper bound.
 *   2. 'crew_lead': the crew lead's "people × hours per person on site", whole job, confirmed at Complete
 *      (fieldExecution.completion.crewOnSite). Used when no timecard hours were tagged, and also when it is more than
 *      the timecard work hours (a crew member who never clocked onto the job): 'crew_lead_exceeds_timecards'.
 *   Neither: null ('not_recorded'), and the job has no margin rather than a guessed one.
 * Costs: labor at the owner's wage per man-hour × (1 + workers' comp % + payroll tax %) plus other burden per man-hour,
 *   all owner-entered (pay figures never live in the code); goods at their retail basis (the estimate's product split, Home Depot retail before
 *   the 1.30 markup) plus the owner's goods purchase tax %; dump fee per truck load (the crew lead's count at Complete,
 *   else the quoted loads); truck cost per job. Commission on revenue by channel: estimator 7%, setter 13% + estimator
 *   7%, door sale 25%, junk-only 0%.
 * Revenue with a refund, an unbilled approved change or an incomplete money record has no margin ('revenue_unreconciled').
 * Unreadable timecards, incomplete timecards and truck loads nobody recorded (quoted, or none) leave it an upper bound.
 * The wage has no stand-in: until the owner enters it, no job has a margin ('wage_unset'). Any other blank owner cost
 * counts as $0, so the margin is an upper bound until all of them are entered. */
import { estimateTotals, builderJunkOnly, included } from './quote-model.js';
import { CHANGE_ORDER_UNBILLED, customerMoneyTotals, refundsRecorded } from './money-core.js';
import { hubRecordEligibility } from './funnel-definitions.js';
import { addDays } from './dispatch-time.js';

export const JOB_ACTUALS_DAYS = 90;
export const JOB_ACTUALS_SHORT_DAYS = 30;
export const COST_SETTING_KEYS = Object.freeze(['wageCentsPerManHour', 'workersCompBp', 'payrollTaxBp', 'burdenCentsPerManHour', 'dumpFeeCentsPerLoad', 'truckCentsPerJob', 'goodsTaxBp']);
// Inclusive upper bounds; every setting is a whole number from 0, or null while the owner has not entered it.
export const COST_SETTING_LIMITS = Object.freeze({ wageCentsPerManHour: 20000, workersCompBp: 5000, payrollTaxBp: 5000, burdenCentsPerManHour: 10000, dumpFeeCentsPerLoad: 500000, truckCentsPerJob: 500000, goodsTaxBp: 2500 });
export const COMMISSION_BP = Object.freeze({ estimator: 700, setter: 1300, door: 2500 });
export const CHANNELS = Object.freeze(['direct_estimator', 'appointment_setter', 'door_sale', 'junk_only', 'none']);
const COMPLETED = new Set(['completed', 'paid', 'closed', 'review_requested', 'invoiced']);
const WORK_TYPES = new Set(['job', 'cleanout', 'reorg']);
// Hours on site are per person for the whole job (every day of a multi-day job), in quarter hours.
export const MAX_PEOPLE = 20, MAX_SITE_HOURS = 200, MAX_LOADS = 20;
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const big = value => BigInt(value);

/** n / d rounded half up (toward +infinity on an exact half), for integers n and d > 0. */
export function divRoundHalfUp(numerator, denominator) {
  const n = big(numerator), d = big(denominator);
  if (d <= 0n) throw new RangeError('divRoundHalfUp needs a positive denominator');
  const twice = 2n * n + d, den = 2n * d;
  let q = twice / den;
  if (twice % den !== 0n && twice < 0n) q -= 1n; // BigInt division truncates toward zero; floor it.
  return Number(q);
}
/** Hours (a number) as integer milli-hours, half up. */
export const milliHours = hours => typeof hours === 'number' && Number.isFinite(hours) && hours >= 0 ? divRoundHalfUp(Math.round(hours * 1e6), 1000) : null;
/** cents × basis points, half up. */
export const percentOf = (cents, bp) => divRoundHalfUp(big(cents) * big(bp), 10000);

/** The loaded labor cost of paid milli-hours: wage × (1 + workers' comp + payroll tax) + burden per man-hour, from the
 * owner's settings; null while the wage is blank (never a guessed wage). */
export function laborCostCents(paidMilliHours, { wageCentsPerManHour = null, workersCompBp = null, payrollTaxBp = null, burdenCentsPerManHour = null } = {}) {
  if (!Number.isSafeInteger(wageCentsPerManHour)) return null;
  const perHourTimes10k = big(wageCentsPerManHour) * big(10000 + (workersCompBp ?? 0) + (payrollTaxBp ?? 0)) + big(burdenCentsPerManHour ?? 0) * 10000n;
  return divRoundHalfUp(big(paidMilliHours) * perHourTimes10k, 1000n * 10000n);
}

/** Commission shares on revenue: [{role, bp, cents}] and their total, rounded half up per share. */
export function commissionFor(revenueCents, channel) {
  const shares = channel === 'appointment_setter' ? [['setter', COMMISSION_BP.setter], ['estimator', COMMISSION_BP.estimator]]
    : channel === 'direct_estimator' ? [['estimator', COMMISSION_BP.estimator]] : channel === 'door_sale' ? [['door', COMMISSION_BP.door]] : [];
  const lines = shares.map(([role, bp]) => ({ role, bp, cents: revenueCents > 0 ? percentOf(revenueCents, bp) : 0 }));
  return { channel, lines, totalCents: lines.reduce((sum, line) => sum + line.cents, 0) };
}

export function validCostSetting(key, value) {
  return value === null || Number.isSafeInteger(value) && value >= 0 && value <= COST_SETTING_LIMITS[key];
}
/** The owner's cost settings, every key present (null when blank), and whether all of them are entered. */
export function normalizeCostSettings(input = {}) {
  const settings = Object.fromEntries(COST_SETTING_KEYS.map(key => [key, validCostSetting(key, input?.[key] ?? null) ? input?.[key] ?? null : null]));
  return { ...settings, complete: COST_SETTING_KEYS.every(key => settings[key] !== null), missing: COST_SETTING_KEYS.filter(key => settings[key] === null) };
}

export const completedJob = job => Boolean(job?.completedAt || job?.postJobChecklist?.completedAt) || COMPLETED.has(String(job?.pipelineStatus || job?.status || '').toLowerCase());
export const workJob = job => plain(job) && WORK_TYPES.has(job.type) && hubRecordEligibility(job).eligible && !['cancelled', 'canceled', 'no_show'].includes(String(job.status || '').toLowerCase());
// A builder quote sent and accepted online keeps its priced breakdown on the quote draft (quote-draft.js), not as
// compositeQuote (a walkthrough-signed one): read either.
const sentBreakdown = job => job?.quoteDraft?.breakdown?.source === 'composite' ? job.quoteDraft.breakdown : null;
export const junkOnlyJob = job => job?.serviceType === 'Junk removal' || builderJunkOnly(job?.compositeQuote?.breakdown?.lines) || builderJunkOnly(sentBreakdown(job)?.lines);

const positiveHours = value => typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 1000 ? value : null;
/** Billed man-hours as {milli, source}; milli null on a junk-only or legacy quote. */
export function billedManHours(job) {
  if (junkOnlyJob(job)) return { milli: null, source: 'junk_only' };
  const sold = positiveHours(job?.jobInstructions?.laborManHours) ?? positiveHours(job?.compositeQuote?.breakdown?.labor?.manHours) ?? positiveHours(sentBreakdown(job)?.labor?.manHours);
  return sold === null ? { milli: null, source: 'no_labor_line' } : { milli: milliHours(sold), source: 'labor_line' };
}

/** The crew lead's confirmation at Complete: {people, hours} → people × hours, or null. */
export function crewLeadManHours(job) {
  const value = job?.fieldExecution?.completion?.crewOnSite;
  if (!plain(value) || !validCrewOnSite(value)) return null;
  return { people: value.people, hours: value.hours, milli: value.people * milliHours(value.hours) };
}
export const validCrewOnSite = value => plain(value) && Object.keys(value).every(key => ['people', 'hours'].includes(key)) && Number.isSafeInteger(value.people) && value.people >= 1 && value.people <= MAX_PEOPLE
  && typeof value.hours === 'number' && Number.isFinite(value.hours) && value.hours > 0 && value.hours <= MAX_SITE_HOURS && Number.isInteger(value.hours * 4);
export const validTruckLoads = value => Number.isSafeInteger(value) && value >= 0 && value <= MAX_LOADS;

/** Truck loads: the crew lead's count at Complete, else the quote's full plus partial junk loads; {count, source}. */
export function truckLoads(job) {
  const actual = job?.fieldExecution?.completion?.truckLoads;
  if (validTruckLoads(actual)) return { count: actual, source: 'crew_lead' };
  const lines = Array.isArray(job?.estimate?.lineItems) ? job.estimate.lineItems : [];
  const quoted = lines.filter(line => plain(line) && /^removal-junk-(?:full|partial)$/.test(String(line.id || '')) && included(line))
    .reduce((sum, line) => sum + (Number.isSafeInteger(Number(line.quantity)) && Number(line.quantity) > 0 ? Number(line.quantity) : 0), 0);
  return quoted > 0 ? { count: quoted, source: 'quote' } : { count: 0, source: 'none' };
}

/** Goods at their retail basis (the product split before markup), in cents: 0 only when the estimate has line items and
 * none is a good; null when there are no line items or they cannot say. */
export function goodsRetailCents(job) {
  const lines = job?.estimate?.lineItems;
  if (!Array.isArray(lines) || !lines.length) return null;
  const totals = estimateTotals(lines);
  return Number.isSafeInteger(totals.productCents) ? totals.productCents : null;
}

/** Commission channel: junk-only earns nothing; a door-to-door setter's walkthrough pays setter + estimator; a door
 * sale linked to the job pays 25%; any other signed walkthrough pays the estimator 7%; anything else (no walkthrough) none. */
export function channelOf(job, { setterWalkthroughs = new Set(), doorSaleJobs = new Set() } = {}) {
  if (junkOnlyJob(job)) return 'junk_only';
  if (job?.sourceWalkthroughId && setterWalkthroughs.has(job.sourceWalkthroughId)) return 'appointment_setter';
  if (doorSaleJobs.has(job?.id)) return 'door_sale';
  if (typeof job?.sourceWalkthroughId === 'string' && job.sourceWalkthroughId) return 'direct_estimator';
  return 'none';
}

const hours = milli => milli === null ? null : milli / 1000;

const count = value => Number.isSafeInteger(value) && value > 0 ? value : 0;
/** The job's computeJobLaborCost row as {workHours, travelHours, incomplete}: projected hours, and whether open shifts,
 * timecards needing review or legacy-only job links leave hours out. */
export function timecardLabor(row) {
  if (!plain(row) || !plain(row.projected)) return null;
  return { workHours: row.projected.workHours, travelHours: row.projected.travelHours, incomplete: count(row.openShifts) + count(row.needsReviewCount) + count(row.legacyAssociationOnlyCount) > 0 };
}

/** One completed job's actuals. labor is timecardLabor(row) for the job, or null. */
// Reasons that leave a margin only an upper bound (costs may be missing); the others withhold it (known is false).
const UPPER_BOUND = new Set(['cost_settings_incomplete', 'timecards_incomplete', 'timecards_unavailable', 'loads_quoted', 'loads_unknown']);
/** One completed job's actuals. labor is timecardLabor(row) for the job, or null; timecardsAvailable false says the
 * timecards could not be read, so a crew-lead or missing figure may be short of the hours they hold. */
export function jobActualsRow(job, { labor = null, settings: raw = {}, channel = 'none', timecardsAvailable = true } = {}) {
  const settings = normalizeCostSettings(raw), reasons = [];
  const money = customerMoneyTotals(job, { unified: true });
  const revenueCents = Number.isSafeInteger(money.totalCents) ? money.totalCents : null;
  if (revenueCents === null) reasons.push('revenue_unknown');
  // A refund, an approved change not yet billed or an incomplete money record: the revenue is not final, so no margin.
  const revenueUnreconciled = revenueCents !== null && (refundsRecorded(job) || money.issues.includes(CHANGE_ORDER_UNBILLED) || money.complete !== true);
  if (revenueUnreconciled) reasons.push('revenue_unreconciled');
  if (!timecardsAvailable) reasons.push('timecards_unavailable');
  const billed = billedManHours(job), lead = crewLeadManHours(job);
  const workMilli = labor ? milliHours(labor.workHours) : null, travelMilli = labor ? milliHours(labor.travelHours) : null;
  let actual = null;
  const timecardHours = workMilli !== null && workMilli + travelMilli > 0, incomplete = timecardHours && labor?.incomplete === true;
  if (timecardHours && lead && lead.milli > workMilli) { actual = { source: 'crew_lead', milli: lead.milli, paidMilli: lead.milli + travelMilli }; reasons.push('crew_lead_exceeds_timecards'); }
  else if (timecardHours) actual = { source: 'timecards', milli: workMilli, paidMilli: workMilli + travelMilli };
  else if (lead) actual = { source: 'crew_lead', milli: lead.milli, paidMilli: lead.milli };
  // Incomplete cards stay flagged even when the lead's count wins: their travel hours are still short.
  if (incomplete) reasons.push('timecards_incomplete');
  if (!actual) reasons.push('actual_hours_missing');
  const loads = truckLoads(job), goodsRetail = goodsRetailCents(job);
  // Loads nobody recorded are never a firm count: quoted loads or none at all leave the dump cost an estimate, which
  // matters once the owner has a dump fee (a blank fee is already cost_settings_incomplete).
  if (loads.source !== 'crew_lead' && settings.dumpFeeCentsPerLoad > 0) reasons.push(loads.source === 'quote' ? 'loads_quoted' : 'loads_unknown');
  if (goodsRetail === null) reasons.push('goods_unknown');
  const commission = commissionFor(revenueCents ?? 0, channel);
  if (settings.wageCentsPerManHour === null) reasons.push('wage_unset');
  if (!settings.complete) reasons.push('cost_settings_incomplete');
  const goodsCostCents = goodsRetail === null ? null : goodsRetail + percentOf(goodsRetail, settings.goodsTaxBp ?? 0);
  const laborCents = actual ? laborCostCents(actual.paidMilli, settings) : null;
  const dumpCents = loads.count * (settings.dumpFeeCentsPerLoad ?? 0), truckCents = settings.truckCentsPerJob ?? 0;
  const known = revenueCents !== null && !revenueUnreconciled && laborCents !== null && goodsCostCents !== null;
  const directCostCents = known ? laborCents + goodsCostCents + dumpCents + truckCents : null;
  const grossMarginCents = known ? revenueCents - directCostCents : null;
  return {
    jobId: job.id, date: job.date || null, completedAt: job.completedAt || job.postJobChecklist?.completedAt || null, customer: String(job.customer || '').slice(0, 180), serviceType: String(job.serviceType || '').slice(0, 120),
    revenueCents, billed: { manHours: hours(billed.milli), source: billed.source },
    actual: actual ? { manHours: hours(actual.milli), paidManHours: hours(actual.paidMilli), source: actual.source } : { manHours: null, paidManHours: null, source: 'not_recorded' },
    crewLead: lead ? { people: lead.people, hours: lead.hours, manHours: hours(lead.milli) } : null,
    varianceManHours: actual && billed.milli !== null ? hours(actual.milli - billed.milli) : null,
    variancePercent: actual && billed.milli ? divRoundHalfUp(big(actual.milli - billed.milli) * 1000n, billed.milli) / 10 : null,
    truckLoads: loads, goodsRetailCents: goodsRetail, goodsCostCents, laborCents, dumpCents, truckCents,
    commission, directCostCents, grossMarginCents, grossMarginPercent: known && revenueCents > 0 ? divRoundHalfUp(big(grossMarginCents) * 1000n, revenueCents) / 10 : null,
    contributionCents: known ? grossMarginCents - commission.totalCents : null,
    upperBound: known && reasons.some(reason => UPPER_BOUND.has(reason)), reasons,
  };
}

/** Totals over rows: sums of known figures, with hours compared only on jobs that have both billed and actual. */
export function summarizeJobActuals(rows) {
  const sum = (list, pick) => list.reduce((total, row) => total + pick(row), 0);
  const withRevenue = rows.filter(row => row.revenueCents !== null), compared = rows.filter(row => row.varianceManHours !== null), margined = rows.filter(row => row.grossMarginCents !== null);
  const billedMilli = sum(compared, row => milliHours(row.billed.manHours)), actualMilli = sum(compared, row => milliHours(row.actual.manHours));
  const marginRevenue = sum(margined, row => row.revenueCents), gross = sum(margined, row => row.grossMarginCents);
  return {
    jobs: rows.length, revenueCents: sum(withRevenue, row => row.revenueCents), jobsWithActualHours: rows.filter(row => row.actual.source !== 'not_recorded').length,
    comparedJobs: compared.length, billedManHours: billedMilli / 1000, actualManHours: actualMilli / 1000, varianceManHours: (actualMilli - billedMilli) / 1000,
    variancePercent: billedMilli ? divRoundHalfUp(big(actualMilli - billedMilli) * 1000n, billedMilli) / 10 : null,
    truckLoads: sum(rows, row => row.truckLoads.count), goodsRetailCents: sum(rows.filter(row => row.goodsRetailCents !== null), row => row.goodsRetailCents),
    commissionCents: sum(rows, row => row.commission.totalCents), marginCommissionCents: sum(margined, row => row.commission.totalCents),
    marginJobs: margined.length, marginRevenueCents: marginRevenue, laborCents: sum(margined, row => row.laborCents), directCostCents: sum(margined, row => row.directCostCents),
    grossMarginCents: gross, grossMarginPercent: marginRevenue > 0 ? divRoundHalfUp(big(gross) * 1000n, marginRevenue) / 10 : null,
    contributionCents: sum(margined, row => row.contributionCents), upperBound: margined.some(row => row.upperBound),
  };
}

/** The report window: the last JOB_ACTUALS_DAYS Denver days through today (end exclusive), and the short window start. */
export function jobActualsWindow(today) {
  return { start: addDays(today, -(JOB_ACTUALS_DAYS - 1)), end: addDays(today, 1), shortStart: addDays(today, -(JOB_ACTUALS_SHORT_DAYS - 1)), today };
}

/** The report: completed work jobs dated in the window, newest first, with totals for the last 30 and 90 days. */
export function buildJobActuals({ jobs = [], labor = { jobs: [] }, settings = {}, setterWalkthroughs = new Set(), doorSaleJobs = new Set(), timecardsAvailable = true, today, asOf = new Date().toISOString() }) {
  const window = jobActualsWindow(today), byJob = new Map((labor?.jobs || []).map(row => [row.jobId, timecardLabor(row)]));
  const rows = jobs.filter(job => workJob(job) && completedJob(job) && typeof job.date === 'string' && job.date >= window.start && job.date < window.end)
    .map(job => jobActualsRow(job, { labor: byJob.get(job.id) || null, settings, timecardsAvailable, channel: channelOf(job, { setterWalkthroughs, doorSaleJobs }) }))
    .sort((a, b) => String(b.date).localeCompare(String(a.date)) || a.jobId.localeCompare(b.jobId));
  const normalized = normalizeCostSettings(settings);
  return {
    ok: true, authority: 'employee_hub', asOf, window, rates: { commissionBp: COMMISSION_BP },
    settingsComplete: normalized.complete, missingSettings: normalized.missing,
    totals: { last30: summarizeJobActuals(rows.filter(row => row.date >= window.shortStart)), last90: summarizeJobActuals(rows) },
    rows, laborCoverage: labor?.coverage || null,
  };
}
