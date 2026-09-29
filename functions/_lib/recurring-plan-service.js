/** Server-owned recurring plans. recurringPlans/{planId} holds the cadence and
 * the occurrence index; each generated visit is an ordinary dispatch job made by
 * mutateDispatch schedule.create (sourceTemplateJobId = plan.templateJobId).
 * Occurrence request IDs are derived from sha256(planId:date), and the plan's
 * occurrence index is committed atomically with the job, so reruns replay or
 * skip rather than duplicate. A date whose visit was moved to another date has
 * spent its request, so it takes a new generation (plan.reissued[date]) before
 * it can be booked again. Manager receipts live in recurringPlanOperations.
 * A priced plan (pricePerVisitCents + lineItems) gives each generated visit its
 * price through money-service estimate.save, only while server money writes
 * are on (MONEY_API_ENABLED; otherwise the price waits, pending); an update
 * with applyToBooked moves and re-prices booked visits that have not started
 * (entry.apply / entry.price, carried out by the same bounded horizon runs). */
import { mutateDispatch, requireDispatcher, projectDispatchJob } from './dispatch-service.js';
import { moneyApiEnabled, mutateMoney } from './money-service.js';
import { assignmentKey } from './job-assignment.js';
import { validDate, addDays, denverToday, scheduleInterval } from './dispatch-time.js';
import { DISPATCH_TIME_ZONE } from './dispatch-contract.js';
import { dispatchStorage } from './dispatch-storage.js';
import { segmented } from './dispatch-segments.js';
import { cadenceLabel, horizonRange, nextOccurrences, normalizeRecurringSchedule, occurrenceDates, occurrenceSchedule } from './recurring-plans.js';
import { normalizePlanPrice, planPriced, priceKey, visitEstimateInput, visitPriceBlocker } from './recurring-plan-price.js';

export const RECURRING_PLAN_ACTIONS = Object.freeze(['create','update','pause','resume','end','extend']);
export const RECURRING_EXTEND_LIMIT = 10;
export const recurringPlansEnabled = env => env?.EGC_RECURRING_PLANS_ENABLED === 'true';
const PLANS = 'recurringPlans', OPERATIONS = 'recurringPlanOperations';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const SCHEDULE_FIELDS = ['cadence','startDate','time','endTime','spanDays','endsOn','count','skipDates','horizonDays'];
const PRICE_FIELDS = ['pricePerVisitCents','lineItems'];
const IN_FIELD = ['dispatched','arrived','in_progress','paused','waiting'];
const notifyFlag = value => { if (value !== undefined && typeof value !== 'boolean') throw fail('field_invalid', 'Customer reminders must be turned on or off.'); return value === true; };
const PER_DATE = new Set(['dispatch_conflict','dispatch_time_invalid']);
const REVISION = new Set(['money_revision_conflict','dispatch_revision_conflict']);
// A plan whose last run was blocked or failed; a later complete run clears it.
const STOPPED = new Set(['blocked','error']);
/** lastRun after one step succeeds. A failure recorded for another step stays
 * until that step succeeds or a run completes cleanly; any visit saved clears a
 * failed save, since saves go in date order and the failed date no longer holds
 * the rest back. */
const ranOk = (plan, stage, date, now, runId) => plan?.lastRun?.status === 'error' && (plan.lastRun.stage !== stage || stage !== 'create' && plan.lastRun.date !== date) ? plan.lastRun : { at: now, status: 'ok', runId };
// A create request that already saved a visit which is no longer this date's.
const SPENT = new Set(['dispatch_idempotency_conflict','dispatch_changed_since_operation','dispatch_saved_record_missing']);
const TERMINAL = new Set(['cancelled','canceled','completed','invoiced','paid','review_requested','closed','noshow','no_show','no-show']);
const CANCELLED = new Set(['cancelled','canceled','noshow','no_show','no-show']);
const LIVE_STATES = ['scheduled','conflict','existing','template'];
const PRICE_WAITS = Object.freeze({ code: 'price_waits_for_money_api', message: 'Server money actions are turned off (MONEY_API_ENABLED), so visits are booked without this price for now. Each upcoming visit gets it once they are turned on.' });
const SLOT_TAKEN = Object.freeze({ code: 'recurring_slot_taken', message: 'A cancelled or moved booking still holds this time. Restore it or choose a new time in Dispatch.', conflicts: [] });
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const safeId = id => typeof id === 'string' && /^[A-Za-z0-9_-]{1,180}$/.test(id) && !/^(secure_|_egc_)/.test(id);
const fail = (code, message, status = 400, details) => Object.assign(new Error(message), { code: `recurring_${code}`, status, ...(details ? { details } : {}) });
const keys = (value, allowed, label) => { if (!object(value) || Object.keys(value).some(key => !allowed.includes(key))) throw fail('field_invalid', `${label} contains unsupported fields. Refresh the form and try again.`); };
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : object(value) ? `{${Object.entries(value).sort(([a],[b]) => a.localeCompare(b)).map(([key,item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}` : JSON.stringify(value);
const sha256 = async text => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map(byte => byte.toString(16).padStart(2,'0')).join('');
const digest = value => sha256(canonical(value));
const clip = (value, max) => String(value ?? '').slice(0, max);
const validPlan = plan => Boolean(plan && safeId(plan.id) && plan.recordType === 'recurring_plan' && validDate(plan.startDate) && object(plan.cadence));
const occurrences = plan => object(plan?.occurrences) ? plan.occurrences : {};
const warn = (plan, warning) => [...(Array.isArray(plan.warnings) ? plan.warnings : []), warning].slice(-50);
const jobState = job => job.pipelineStatus || job.status || 'unscheduled';
const liveVisit = job => Boolean(job && safeId(job.id) && !job.recordType && ['job','cleanout','reorg'].includes(job.type) && !TERMINAL.has(jobState(job)));
const onSeries = (plan, date) => occurrenceDates(plan, { startDate: date, endDate: addDays(date, 1) }).length > 0;
const plural = (count, one, many) => count === 1 ? one : many;
const unstarted = job => liveVisit(job) && !job.fieldLastActionAt && !job.startedAt && !job.fieldExecution?.activity && !IN_FIELD.includes(jobState(job));
const slotOf = job => ({ date: job.date || '', time: job.time || '', endDate: job.endDate || job.date || '', endTime: job.endTime || '' });
const sameSlot = (a, b) => ['date','time','endDate','endTime'].every(key => (a?.[key] || '') === (b?.[key] || ''));
const crewOf = value => ({ assignedCrew: [...new Set((Array.isArray(value?.assignedCrew) ? value.assignedCrew : []).map(item => assignmentKey(object(item) ? item.username || item.user || item.id : item)))].sort(), crewLead: value?.crewLead ? assignmentKey(value.crewLead) : null });
const sameCrew = (a, b) => canonical(crewOf(a)) === canonical(crewOf(b)) && (a?.crewId || null) === (b?.crewId || null) && (a?.vehicleId || null) === (b?.vehicleId || null);
const periodDays = cadence => ({ weekly:7, biweekly:14, every_n_weeks:7 * (cadence?.intervalWeeks || 1), monthly:30, quarterly:91 })[cadence?.frequency] || 7;
const pendingPrice = entry => entry?.price?.status === 'pending' && Boolean(entry.jobId);
const generation = (plan, date) => { const n = object(plan?.reissued) ? plan.reissued[date] : 0; return Number.isSafeInteger(n) && n > 0 ? n : 0; };
const reissuedFrom = (plan, today) => Object.fromEntries(Object.keys(object(plan?.reissued) ? plan.reissued : {}).filter(date => validDate(date) && date >= today && generation(plan, date)).map(date => [date, generation(plan, date)]));
/** The id schedule.create gives a booking at this customer, date and start time (dispatch-service bookingKey). */
const slotKey = async (customerId, date, time) => `visit_${(await digest({ customerId, kind: 'job', date, time, timeZone: DISPATCH_TIME_ZONE })).slice(0, 40)}`;
/** Ids of the bookings holding this customer's date and start time: a live
 * visit there, or any record under the slot's create id. schedule.create
 * refuses a second booking for either (dispatch_job_already_exists), and a plan
 * edit never moves a booked visit onto one. `jobs` is a complete jobs scan. */
async function slotHolders(jobs, customerId, { date, time }) {
  const key = await slotKey(customerId, date, time);
  return jobs.filter(row => row?.id === key || liveVisit(row) && row.customerId === customerId && row.date === date && row.time === time).map(row => row.id);
}
/** A booked visit's change moves its start onto a slot another booking holds. */
const slotTaken = async (jobs, customerId, job, to) => Boolean(to && (to.date !== job.date || to.time !== job.time) && (await slotHolders(jobs, customerId, to)).some(id => id !== job.id));

/** RFC 9562 version-8 UUID shape so every dispatch request-ID guard accepts it. */
export async function occurrenceRequestId(planId, date, variant = '') {
  const hex = await sha256(`${planId}:${date}${variant ? `:${variant}` : ''}`);
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-8${hex.slice(13,16)}-${((parseInt(hex[16],16) & 3) | 8).toString(16)}${hex.slice(17,20)}-${hex.slice(20,32)}`;
}
/** The schedule.create request for one date; generation 0 keeps the original IDs. */
const createRequestId = (plan, date, conflict) => occurrenceRequestId(plan.id, date, [conflict ? 'unscheduled' : '', generation(plan, date) ? `regen:${generation(plan, date)}` : ''].filter(Boolean).join(':'));
/** A visit's estimate.save request, keyed by the visit (its job), never its
 * date: a visit a plan edit moves keeps its chain, and a new visit booked on a
 * date another visit left never reuses that visit's request. Chained to the
 * plan price saved before it, so a price that changes back (A, B, A) never
 * reuses an earlier request. */
const priceRequestId = (planId, jobId, key, previousRequestId) => occurrenceRequestId(planId, `job:${jobId}`, `price:${key}${previousRequestId ? `:${previousRequestId}` : ''}`);
/** A visit's pending plan price that already saved but was never recorded
 * (a lost confirmation), under any of these plan price keys: its request id,
 * else null. The jobs scan is masked to dispatch fields, so the visit is read. */
async function landedPrice(store, planId, entry, priceKeys) {
  const ids = await Promise.all([...new Set(priceKeys.filter(Boolean))].map(key => priceRequestId(planId, entry.jobId, key, entry.price?.previousRequestId)));
  if (!ids.length) return null;
  const found = (await store.read('jobs', entry.jobId))?.moneyRequestId;
  return ids.includes(found) ? found : null;
}
/** Where the plan's entry for this visit is now: its own date, else the date a plan edit moved it to. */
const entryDate = (index, date, jobId) => index[date]?.jobId === jobId ? date : Object.keys(index).find(day => index[day]?.jobId === jobId) || null;

function integer(value, label, min, max) {
  if (value === undefined || value === null) return undefined;
  if (!Number.isInteger(value) || value < min || value > max) throw fail('field_invalid', `${label} must be a whole number from ${min} to ${max}.`);
  return value;
}
function normalizeAssignment(input, roster, resources) {
  keys(input, ['assignedCrew','crewLead','crewId','vehicleId','crewNeeded','travelBufferMinutes'], 'The crew assignment');
  const crew = input.assignedCrew ?? [];
  if (!Array.isArray(crew) || crew.length > 20 || crew.some(value => typeof value !== 'string')) throw fail('crew_invalid', 'Choose up to 20 active employees.');
  const assignedCrew = crew.map(assignmentKey);
  if (assignedCrew.some(id => !roster.some(person => person.id === id))) throw fail('employee_inactive', 'An assigned employee is no longer active. Refresh the employee list.');
  if (new Set(assignedCrew).size !== assignedCrew.length) throw fail('crew_duplicate', 'Each employee can only be assigned once.');
  const crewLead = input.crewLead ? assignmentKey(input.crewLead) : null;
  if (crewLead && !assignedCrew.includes(crewLead)) throw fail('lead_not_assigned', 'The crew lead must be one of the assigned employees.');
  const crewId = input.crewId || null, vehicleId = input.vehicleId || null;
  if (crewId && !resources.some(row => row.recordType === 'crew' && row.id === crewId && row.status === 'active')) throw fail('crew_inactive', 'Choose an active crew.');
  if (vehicleId && !resources.some(row => row.recordType === 'vehicle' && row.id === vehicleId && row.status === 'available')) throw fail('vehicle_unavailable', 'This vehicle is unavailable. Choose an available vehicle or remove it.');
  const crewNeeded = integer(input.crewNeeded, 'Crew size', 1, 20), travelBufferMinutes = integer(input.travelBufferMinutes, 'Travel time', 0, 180);
  return { assignedCrew, crewLead, crewId, vehicleId, ...(crewNeeded !== undefined ? { crewNeeded } : {}), ...(travelBufferMinutes !== undefined ? { travelBufferMinutes } : {}) };
}
function templateAssignment(template, roster) {
  const assigned = (Array.isArray(template.assignedCrew) ? template.assignedCrew : []).map(value => assignmentKey(object(value) ? value.username || value.user || value.id : value));
  const assignedCrew = [...new Set(assigned.filter(id => roster.some(person => person.id === id)))];
  const lead = assignmentKey(template.crewLead || '');
  return { assignedCrew, crewLead: assignedCrew.includes(lead) ? lead : null, crewId: template.crewId || null, vehicleId: template.vehicleId || null };
}
function templateSchedule(template) {
  const interval = scheduleInterval(template);
  return interval ? { startDate: interval.date, time: interval.time, endTime: interval.endTime, spanDays: Math.round((Date.parse(interval.endDate + 'T12:00:00Z') - Date.parse(interval.date + 'T12:00:00Z')) / 86400000) } : {};
}

/** Dispatch jobs indexed for reconciliation: by id, and the dates each
 * customer has a live (not cancelled or closed) visit. */
export function recurringJobIndex(jobs) {
  const byId = new Map(), served = new Map();
  for (const job of jobs) {
    if (!safeId(job?.id) || job.recordType) continue;
    byId.set(job.id, job);
    if (liveVisit(job) && validDate(job.date)) served.set(job.customerId, (served.get(job.customerId) || new Set()).add(job.date));
  }
  return { byId, served };
}

/** The occurrence index records what the plan created. With a job index each
 * row is reconciled with its Dispatch job, so a visit later cancelled, moved,
 * completed or deleted there is shown as such (`covered` when the customer has
 * another live visit that day), and a live visit on a date the series no
 * longer includes is `off_pattern`. */
function reconcile(date, entry, dispatch, planned, customerId) {
  const row = { date, jobId: entry?.jobId || null, state: entry?.state || 'scheduled', ...(entry?.code ? { code: entry.code } : {}), ...(object(entry?.price) ? { price: entry.price.status } : {}) };
  // A booked visit the plan is still moving onto this date (applyToBooked).
  if (object(entry?.apply)) return { ...row, state: 'updating', recorded: row.state, ...(entry.apply.from?.date !== date ? { movedFrom: entry.apply.from?.date || null } : {}) };
  if (!dispatch || !row.jobId) return row;
  const job = dispatch.byId.get(row.jobId), status = job ? jobState(job) : '', covered = dispatch.served.get(customerId)?.has(date) === true;
  const changed = (state, extra = {}) => ({ ...row, state, recorded: row.state, ...extra });
  if (!job || CANCELLED.has(status)) return changed(covered ? 'covered' : job ? 'cancelled' : 'missing');
  if (TERMINAL.has(status)) return changed('completed');
  if (!planned) return changed('off_pattern');
  if (row.state === 'conflict') return job.date ? changed('rescheduled', { movedTo: job.date }) : row;
  if ((job.date || '') === date) return row;
  return job.date || !covered ? changed('moved', { movedTo: job.date || null }) : changed('covered');
}

export function projectRecurringPlan(plan, now = new Date(), dispatch = null) {
  const today = denverToday(now), index = occurrences(plan), ended = plan.status === 'ended';
  const dates = Object.keys(index).filter(date => validDate(date)).sort(), last = dates[dates.length - 1];
  const planned = new Set(last && last >= today ? occurrenceDates(plan, { startDate: today, endDate: addDays(last, 1) }) : []);
  const rows = dates.map(date => reconcile(date, index[date], dispatch, date < today || planned.has(date), plan.customerId)), byDate = new Map(rows.map(row => [row.date, row]));
  const upcoming = ended ? [] : nextOccurrences(plan, { now, limit: 6 }).map(date => { const row = byDate.get(date); return { date, state: row?.state || 'not_generated', jobId: row?.jobId || null, ...(row && 'movedTo' in row ? { movedTo: row.movedTo } : {}) }; });
  // Future dates that leave the customer without a planned visit, or with one the plan no longer includes.
  const attention = rows.filter(row => row.date >= today && (row.state === 'conflict' || !ended && (row.state === 'off_pattern' || planned.has(row.date) && (['cancelled','missing'].includes(row.state) || row.state === 'moved' && !row.movedTo))));
  return { id: plan.id, revision: plan.revision, status: plan.status, customerId: plan.customerId, customer: plan.customer || '', address: plan.address || '', templateJobId: plan.templateJobId,
    cadence: plan.cadence, cadenceLabel: cadenceLabel(plan.cadence), startDate: plan.startDate, time: plan.time, endTime: plan.endTime, spanDays: plan.spanDays || 0,
    endsOn: plan.endsOn || null, count: Number.isInteger(plan.count) ? plan.count : null, skipDates: Array.isArray(plan.skipDates) ? plan.skipDates : [], horizonDays: plan.horizonDays,
    pricePerVisitCents: planPriced(plan) ? plan.pricePerVisitCents : null, lineItems: planPriced(plan) ? plan.lineItems : [],
    assignment: object(plan.assignment) ? plan.assignment : { assignedCrew: [] }, notifyCustomer: plan.notifyCustomer === true, occurrences: rows.filter(row => row.date >= addDays(today, -60)),
    upcoming, attention, reconciled: Boolean(dispatch), finished: !ended && !upcoming.length,
    generatedThrough: last || null, warnings: (Array.isArray(plan.warnings) ? plan.warnings : []).slice(-10), lastRun: plan.lastRun || null,
    timeZone: DISPATCH_TIME_ZONE, createdAt: plan.createdAt, createdBy: plan.createdBy, updatedAt: plan.updatedAt, updatedBy: plan.updatedBy };
}

export async function recurringPlansOverview(store, session, query = {}, now = new Date(), { enabled = false } = {}) {
  requireDispatcher(session);
  keys(query, ['view','planId'], 'The recurring plan lookup');
  if (query.view === 'status') return { ok: true, enabled };
  if (query.view !== undefined && query.view !== 'plans') throw fail('request_invalid', 'Choose a supported recurring plan view.');
  if (query.planId !== undefined && !safeId(query.planId)) throw fail('plan_not_found', 'Choose a valid recurring plan.', 404);
  const [plans, roster, resources, jobs] = await Promise.all([query.planId ? store.read(PLANS, query.planId).then(row => row ? [row] : []) : store.recurringPlans(), store.roster(), store.resources(), store.jobs()]);
  if (query.planId && !validPlan(plans[0])) throw fail('plan_not_found', 'This recurring plan could not be found.', 404);
  const dispatch = recurringJobIndex(jobs);
  return { ok: true, enabled, timeZone: DISPATCH_TIME_ZONE, plans: plans.filter(validPlan).map(plan => projectRecurringPlan(plan, now, dispatch)).sort((a, b) => ({ active:0, paused:1, ended:2 }[a.status] ?? 3) - ({ active:0, paused:1, ended:2 }[b.status] ?? 3) || a.customer.localeCompare(b.customer) || a.id.localeCompare(b.id)),
    roster, crews: resources.filter(row => row.recordType === 'crew'), vehicles: resources.filter(row => row.recordType === 'vehicle'), coverage: { complete: true, asOf: now.toISOString() } };
}

async function commitWithReceipt(store, writes, receiptId, fingerprint) {
  try { await store.commit(writes); }
  catch (error) {
    const receipt = await store.read(OPERATIONS, receiptId).catch(() => null);
    if (receipt?.fingerprint === fingerprint) return;
    if (error.code === 'dispatch_revision_conflict') throw fail('revision_conflict', 'This recurring plan changed while you were editing. Refresh and review its latest details.', 409);
    if (error.code === 'dispatch_outcome_unknown' || !error.status || error.status >= 500) throw fail('outcome_unknown', 'The save could not be verified. Retry the same request.', 503);
    throw error;
  }
}

/** Booked-visit changes still waiting to run are replaced by a later edit (or
 * dropped when the plan ends): each entry returns to the date its job is on. */
function settleApplies(source) {
  const index = { ...source }, back = [];
  for (const [date, entry] of Object.entries(source)) if (object(entry?.apply)) { const { apply, ...rest } = entry; delete index[date]; back.push([validDate(apply.from?.date) ? apply.from.date : date, date, rest]); }
  for (const [from, date, rest] of back) index[index[from] ? date : from] = rest;
  return { index, reverted: back.length };
}

/** applyToBooked: booked visits the plan generated that have not started and
 * still sit at the slot the plan gave them follow the edit. A date the new
 * series keeps changes time and crew in place; a date it drops moves to the
 * nearest new series date within half a cadence period (never one already
 * indexed), re-keyed now so the horizon cannot book that date twice. The moves
 * and re-pricing run later, bounded, through mutateDispatch and estimate.save.
 * Crew changes only visits whose crew still matches the old plan. A vacated
 * date's create request is spent, so the date moves to its next generation.
 * A visit never moves onto a date and start time another booking of the
 * customer holds (slotHolders); it keeps its time and is reported instead. */
async function bookedChanges(store, current, next, { now, today, requestId, crew, price }) {
  const index = { ...occurrences(current) }, jobs = await store.jobs(), byId = new Map(jobs.filter(job => safeId(job?.id)).map(job => [job.id, job])), changed = [], kept = [];
  const reissued = reissuedFrom(current, today), currentKey = price ? await priceKey(current) : null, nextKey = price ? await priceKey(next) : null;
  const instant = Date.parse(now), range = horizonRange(new Date(now), next.horizonDays), tolerance = Math.max(1, Math.floor(periodDays(next.cadence) / 2));
  const future = schedule => { const interval = scheduleInterval(schedule); return Boolean(interval && interval.start > instant); };
  const timeChanged = next.time !== current.time || next.endTime !== current.endTime || (next.spanDays || 0) !== (current.spanDays || 0);
  const pool = occurrenceDates(next, range).filter(date => !index[date] && future(occurrenceSchedule(next, date))), used = new Set();
  const holders = new Map(await Promise.all(pool.map(async day => [day, await slotHolders(jobs, current.customerId, { date: day, time: next.time })])));
  // `any` also returns a date another booking holds, to say why a visit did not move.
  const nearest = (date, jobId, any = false) => pool.filter(day => !used.has(day) && (any || holders.get(day).every(id => id === jobId))).map(day => [day, (Date.parse(day + 'T12:00:00Z') - Date.parse(date + 'T12:00:00Z')) / 86400000]).filter(([, diff]) => Math.abs(diff) <= tolerance).sort(([a, x], [b, y]) => Math.abs(x) - Math.abs(y) || y - x || a.localeCompare(b))[0]?.[0] || null;
  for (const date of Object.keys(index).filter(day => validDate(day) && day >= today).sort()) {
    const entry = index[date], job = byId.get(entry?.jobId);
    if (!['scheduled','conflict'].includes(entry?.state) || entry.apply || !unstarted(job)) { if (entry?.state === 'scheduled' && liveVisit(job) && onSeries(next, date) && (timeChanged || crew)) kept.push({ date, jobId: entry.jobId, reason: 'started' }); continue; }
    let target = date, apply = null;
    if (entry.state === 'scheduled') {
      const onNext = onSeries(next, date), atSlot = sameSlot(slotOf(job), entry.slot || slotOf({ ...occurrenceSchedule(current, date) })) && future(slotOf(job));
      const crewMove = crew && sameCrew(job, current.assignment);
      if (!onNext || timeChanged || crewMove) {
        const taken = onNext && atSlot && await slotTaken(jobs, current.customerId, job, occurrenceSchedule(next, date));
        if (atSlot && !taken && (target = onNext ? date : nearest(date, job.id))) {
          used.add(target);
          const to = target !== date || timeChanged ? slotOf(occurrenceSchedule(next, target)) : null;
          if (to || crewMove) apply = { requestId, from: slotOf(job), ...(to ? { to } : {}), ...(crewMove ? { crew: true, crewFrom: { ...crewOf(job), crewId: job.crewId || null, vehicleId: job.vehicleId || null } } : {}), at: now };
        } else if (atSlot && (taken || nearest(date, job.id, true))) kept.push({ date, jobId: entry.jobId, reason: 'slot_taken', to: taken ? date : nearest(date, job.id, true) });
        else if (onNext) kept.push({ date, jobId: entry.jobId, reason: 'changed_in_dispatch' });
        target ||= date;
      }
      if (crew && !crewMove && !apply && onNext && !kept.some(row => row.date === date)) kept.push({ date, jobId: entry.jobId, reason: 'crew_changed_in_dispatch' });
    }
    let reprice = null;
    if (price) {
      // The plan price now on the visit: the last applied save, or a pending one
      // that saved but was not yet recorded (under the plan price it was queued
      // with, or the plan's current one). A save still running is chained by
      // priceVisit when it lands, wherever this edit moves the entry.
      const prior = object(entry.price) ? entry.price : {}, applied = prior.status === 'applied' && prior.requestId ? prior.requestId : null;
      const saved = prior.status === 'pending' ? await landedPrice(store, current.id, entry, [prior.key, currentKey]) : null;
      const previousRequestId = saved || applied || prior.previousRequestId || null;
      reprice = { key: nextKey, status: 'pending', ...(previousRequestId ? { previousRequestId } : {}), at: now };
    }
    if (!apply && !reprice) continue;
    const moved = { ...entry, ...(apply ? { apply } : {}), ...(reprice ? { price: reprice } : {}) };
    if (target !== date) { delete index[date]; reissued[date] = (reissued[date] || 0) + 1; }
    index[target] = moved;
    changed.push({ date: target, from: date, jobId: entry.jobId });
  }
  return { index, changed, kept, jobs, reissued: changed.some(row => row.date !== row.from) ? reissued : null };
}

export async function mutateRecurringPlan(store, session, input, now = new Date().toISOString(), { enabled = false, pricing = false } = {}) {
  requireDispatcher(session);
  keys(input, ['action','requestId','planId','expectedRevision','plan','limit','applyToBooked'], 'The recurring plan request');
  if (!RECURRING_PLAN_ACTIONS.includes(input.action) || !UUID.test(input.requestId || '')) throw fail('request_invalid', 'Use a supported recurring plan action with a unique request ID.');
  if (input.action === 'create' ? 'planId' in input || 'expectedRevision' in input : !safeId(input.planId) || typeof input.expectedRevision !== 'string' || !input.expectedRevision) throw fail('request_invalid', input.action === 'create' ? 'A new plan cannot name an existing plan.' : 'Choose a recurring plan and the revision you reviewed.');
  if ('plan' in input !== ['create','update'].includes(input.action) || 'limit' in input && input.action !== 'extend' || 'applyToBooked' in input && (input.action !== 'update' || typeof input.applyToBooked !== 'boolean')) throw fail('request_invalid', 'This recurring plan action has unsupported fields.');
  const fingerprint = await digest({ actor: session.user, input }), receiptId = input.requestId.toLowerCase();
  // A saved request still replays after the flag is turned off, so its outcome can be verified.
  const prior = await store.read(OPERATIONS, receiptId);
  if (!prior && !enabled && !['pause','end'].includes(input.action)) throw fail('disabled', 'Recurring plans are turned off for this Hub. Existing plans can still be paused or ended.', 404);
  const roster = await store.roster();
  if (prior) return replay(store, session, input, prior, fingerprint, roster, now);
  if (input.action === 'extend') return extendRequest(store, session, input, fingerprint, roster, now, pricing);
  const resources = await store.resources();
  let planId, current = null, patch, warnings = [];
  if (input.action === 'create') {
    keys(input.plan, ['templateJobId', ...SCHEDULE_FIELDS, ...PRICE_FIELDS, 'assignment', 'notifyCustomer'], 'The recurring plan');
    if (!safeId(input.plan.templateJobId)) throw fail('template_invalid', 'Choose an existing job to repeat.');
    const template = await store.read('jobs', input.plan.templateJobId);
    if (!template || template.recordType || !['job','cleanout','reorg'].includes(template.type) || !safeId(template.customerId)) throw fail('template_invalid', 'The recurring template must be an operational job linked to a Hub customer.', 409);
    // A plan repeats one time window and crew; a split job's hull would reserve every crew for the whole span.
    if (segmented(template)) throw fail('template_segmented', 'A job split into crew segments cannot be repeated. Repeat a job with one time and crew, or remove its segments first.', 409);
    const customer = await store.read('customers', template.customerId);
    if (!customer) throw fail('customer_not_found', 'The template customer no longer exists. Review the job before repeating it.', 409);
    const schedule = normalizeRecurringSchedule({ ...templateSchedule(template), ...Object.fromEntries(SCHEDULE_FIELDS.filter(key => key in input.plan).map(key => [key, input.plan[key]])) });
    const price = normalizePlanPrice(input.plan, { serviceName: template.serviceType });
    const fallback = templateAssignment(template, roster);
    if (!('assignment' in input.plan) && fallback.assignedCrew.length < (Array.isArray(template.assignedCrew) ? template.assignedCrew.length : 0)) warnings.push({ code: 'template_crew_inactive', message: 'Some employees on the template job are no longer active and were not added to the plan.' });
    planId = `plan_${receiptId.replaceAll('-','')}`;
    const seeded = validDate(template.date) && occurrenceDates(schedule, { startDate: template.date, endDate: addDays(template.date, 1) }).length ? { [template.date]: { jobId: template.id, state: 'template', createdAt: now } } : {};
    patch = { id: planId, recordType: 'recurring_plan', version: 1, status: 'active', customerId: customer.id, customer: clip(customer.name || [customer.firstName, customer.lastName].filter(Boolean).join(' ') || template.customer, 200), address: clip(template.address || customer.address, 1000),
      templateJobId: template.id, ...schedule, ...(price?.lineItems ? price : {}), assignment: normalizeAssignment(input.plan.assignment ?? fallback, roster, resources), notifyCustomer: notifyFlag(input.plan.notifyCustomer), occurrences: seeded, warnings: [], lastRun: null, createdAt: now, createdBy: session.user };
    if (price?.lineItems && !pricing) warnings.push({ ...PRICE_WAITS });
  } else {
    planId = input.planId;
    current = await store.read(PLANS, planId);
    if (!validPlan(current)) throw fail('plan_not_found', 'This recurring plan could not be found.', 404);
    if (current.revision !== input.expectedRevision) throw fail('revision_conflict', 'This recurring plan changed while you were editing. Refresh and review its latest details.', 409);
    const allowed = { update: ['active','paused'], pause: ['active'], resume: ['paused'], end: ['active','paused'] }[input.action];
    if (!allowed.includes(current.status)) throw fail('state_invalid', current.status === 'ended' ? 'This recurring plan has ended. Create a new plan to repeat the work again.' : `This plan is already ${current.status}.`, 409);
    if (input.action === 'update') {
      keys(input.plan, [...SCHEDULE_FIELDS, ...PRICE_FIELDS, 'assignment', 'notifyCustomer'], 'The recurring plan changes');
      const schedule = normalizeRecurringSchedule({ ...Object.fromEntries(SCHEDULE_FIELDS.map(key => [key, current[key]]).filter(([, value]) => value !== undefined)), ...Object.fromEntries(SCHEDULE_FIELDS.filter(key => key in input.plan).map(key => [key, input.plan[key]])) });
      const price = PRICE_FIELDS.some(key => key in input.plan) ? normalizePlanPrice(input.plan, { serviceName: (await store.read('jobs', current.templateJobId))?.serviceType }) : undefined;
      patch = { ...schedule, ...(price || {}), ...('assignment' in input.plan ? { assignment: normalizeAssignment(input.plan.assignment, roster, resources) } : {}), ...('notifyCustomer' in input.plan ? { notifyCustomer: notifyFlag(input.plan.notifyCustomer) } : {}) };
      // Visits already booked on dates the new series no longer includes are
      // never cancelled here; name each one so the customer is not double-booked.
      const today = denverToday(new Date(now)), next = { ...current, ...patch }, repriced = price !== undefined && await priceKey(next) !== await priceKey(current);
      const settled = settleApplies(occurrences(current));
      const booked = input.applyToBooked === true ? await bookedChanges(store, { ...current, occurrences: settled.index }, next, { now, today, requestId: input.requestId, crew: 'assignment' in input.plan && !sameCrew(current.assignment, next.assignment), price: repriced && planPriced(next) }) : null;
      const index = booked ? booked.index : settled.index;
      if (booked?.changed.length || settled.reverted) patch.occurrences = index;
      if (booked?.reissued) patch.reissued = booked.reissued;
      if (settled.reverted && !booked) warnings.push({ code: 'booked_visits_update_cancelled', message: `${settled.reverted} booked ${plural(settled.reverted, 'visit was', 'visits were')} still waiting to follow the previous edit and now ${plural(settled.reverted, 'keeps its', 'keep their')} current date, time and crew.` });
      const stale = Object.keys(index).filter(date => validDate(date) && date >= today && index[date]?.jobId && LIVE_STATES.includes(index[date].state) && !index[date].apply && !onSeries(next, date)).sort();
      const live = stale.length ? new Set((booked?.jobs || await store.jobs()).filter(liveVisit).map(job => job.id)) : new Set();
      const kept = stale.filter(date => live.has(index[date].jobId)).map(date => ({ date, jobId: index[date].jobId })), off = kept.filter(row => !schedule.skipDates.includes(row.date));
      for (const { date, jobId } of kept.filter(row => schedule.skipDates.includes(row.date))) warnings.push({ code: 'skip_date_already_scheduled', date, jobId, message: `The ${date} visit is already on the schedule. Cancel it in Dispatch if the customer should be skipped.` });
      if (off.length) warnings.push({ code: 'generated_visits_off_pattern', visits: off, message: `${off.length} ${plural(off.length, 'visit', 'visits')} already on the schedule no longer ${plural(off.length, 'matches', 'match')} this plan and ${plural(off.length, 'was', 'were')} NOT removed: ${off.map(row => row.date).join(', ')}. Cancel ${plural(off.length, 'it', 'them')} in Dispatch, or the customer keeps ${plural(off.length, 'that visit', 'those visits')} as well as the new pattern.` });
      if (booked?.changed.length) { const n = booked.changed.length; warnings.push({ code: 'booked_visits_updating', visits: booked.changed, message: `${n} booked ${plural(n, 'visit that has', 'visits that have')} not started ${plural(n, 'is', 'are')} being updated to match this plan${booked.changed.some(row => row.date !== row.from) ? ' (new dates: ' + booked.changed.filter(row => row.date !== row.from).map(row => `${row.from} → ${row.date}`).join(', ') + ')' : ''}.` }); }
      const keptAsIs = booked?.kept.filter(row => row.reason !== 'slot_taken') || [], held = booked?.kept.filter(row => row.reason === 'slot_taken') || [];
      if (keptAsIs.length) { const n = keptAsIs.length; warnings.push({ code: 'booked_visits_kept', visits: keptAsIs, message: `${n} booked ${plural(n, 'visit was', 'visits were')} left as ${plural(n, 'it is', 'they are')} because ${plural(n, 'it has', 'they have')} started or ${plural(n, 'was', 'were')} changed in Dispatch: ${keptAsIs.map(row => row.date).join(', ')}. Edit ${plural(n, 'it', 'them')} in Dispatch if needed.` }); }
      if (held.length) { const n = held.length; warnings.push({ code: 'booked_visits_slot_taken', visits: held, message: `${n} booked ${plural(n, 'visit was', 'visits were')} NOT moved because the customer already has another booking at the new time (${held.map(row => `${row.date} → ${row.to} ${next.time}`).join(', ')}), and ${plural(n, 'keeps its', 'keep their')} current time. Review ${plural(n, 'it', 'them')} in Dispatch so the customer is not booked twice.` }); }
      if (!booked && Object.keys(index).some(date => date >= today)) warnings.push({ code: 'generated_visits_unchanged', message: `Visits already on the schedule keep their current time${repriced ? ', crew and price' : ' and crew'}. Edit them in Dispatch if they should change too.` });
      if (price !== undefined && planPriced(next) && !pricing) warnings.push({ ...PRICE_WAITS });
    } else {
      patch = { pause: { status: 'paused', pausedAt: now, pausedBy: session.user }, resume: { status: 'active', resumedAt: now, resumedBy: session.user }, end: { status: 'ended', endedAt: now, endedBy: session.user } }[input.action];
      const settled = input.action === 'end' ? settleApplies(occurrences(current)) : { reverted: 0 };
      if (settled.reverted) patch.occurrences = settled.index;
    }
    if (input.action === 'pause' || input.action === 'end') warnings.push({ code: 'generated_visits_unchanged', message: 'Visits already on the schedule were not cancelled. Cancel them in Dispatch if the customer should not be visited.' });
  }
  Object.assign(patch, { updatedAt: now, updatedBy: session.user, planRequestId: input.requestId });
  const before = current ? Object.fromEntries(['status', ...SCHEDULE_FIELDS, ...PRICE_FIELDS, 'assignment', 'notifyCustomer'].filter(key => current[key] !== undefined).map(key => [key, current[key]])) : null;
  await commitWithReceipt(store, [{ collection: PLANS, id: planId, revision: current?.revision, patch }, { collection: OPERATIONS, id: receiptId, patch: { fingerprint, actorId: session.user, action: input.action, planId, requestId: input.requestId, createdAt: now, before, warnings } }], receiptId, fingerprint);
  const saved = await store.read(PLANS, planId);
  if (!saved) throw fail('outcome_unknown', 'The saved plan could not be verified. Retry the same request.', 503);
  if (saved.planRequestId !== input.requestId) throw fail('changed_since_operation', 'That request saved, but the plan has changed since. Refresh to see its current state.', 409);
  return { ok: true, requestId: input.requestId, plan: projectRecurringPlan(saved, new Date(now)), warnings };
}

async function replay(store, session, input, prior, fingerprint, roster, now) {
  if (prior.fingerprint !== fingerprint) throw fail('idempotency_conflict', 'This request ID was already used for different changes. Refresh before saving.', 409);
  const saved = await store.read(PLANS, prior.planId);
  if (!saved) throw fail('saved_record_missing', 'The previously saved plan is no longer available. Refresh and review.', 409);
  if (input.action === 'extend') return { ok: true, requestId: input.requestId, replayed: true, plan: projectRecurringPlan(saved, new Date(now)), ...await extendSummary(store, prior.result || {}, roster) };
  if (saved.planRequestId !== input.requestId) throw fail('changed_since_operation', 'That request saved, but the plan has changed since. Refresh to see its current state.', 409);
  return { ok: true, requestId: input.requestId, replayed: true, plan: projectRecurringPlan(saved, new Date(now)), warnings: prior.warnings || [] };
}

async function extendSummary(store, result, roster) {
  const jobs = (await Promise.all((result.createdJobIds || []).map(id => store.read('jobs', id)))).filter(Boolean);
  return { created: jobs.map(job => projectDispatchJob(job, roster)), conflicts: result.conflicts || [], updated: result.updated || [], kept: result.kept || [], priced: result.priced || [], blocked: result.blocked || null, complete: result.complete === true, retryable: result.retryable === true };
}

/** Any returned extend result, including a partial one (complete:false,
 * retryable:true), is final for its requestId and replays unchanged. Continue
 * with a NEW requestId and the returned plan.revision. Only a run that threw
 * (503, outcome unknown) continues under the same requestId. */
async function extendRequest(store, session, input, fingerprint, roster, now, pricing) {
  const limit = integer(input.limit, 'Visits per request', 1, 20) ?? 4, receiptId = input.requestId.toLowerCase();
  const plan = await store.read(PLANS, input.planId);
  if (!validPlan(plan)) throw fail('plan_not_found', 'This recurring plan could not be found.', 404);
  // A partial run of this same request may already have advanced the revision.
  if (plan.revision !== input.expectedRevision && plan.lastRun?.runId !== input.requestId) throw fail('revision_conflict', 'This recurring plan changed while you were editing. Refresh and review its latest details.', 409);
  if (plan.status !== 'active') throw fail('state_invalid', 'Only an active plan can add visits. Resume it first.', 409);
  const mine = row => Object.entries(occurrences(row)).filter(([, entry]) => entry?.runId === input.requestId && entry.jobId && ['scheduled','conflict'].includes(entry.state)).sort(([a], [b]) => a.localeCompare(b));
  const run = await extendHorizon(store, session, { now, planId: plan.id, limit: Math.max(0, limit - mine(plan).length), runId: input.requestId, pricing });
  const outcome = run.plans[0], saved = await store.read(PLANS, plan.id) || plan, entries = mine(saved);
  // Report everything this request created, including a partial earlier attempt.
  const raw = await Promise.all(entries.map(([, entry]) => store.read('jobs', entry.jobId)));
  const conflicts = entries.filter(([, entry]) => entry.state === 'conflict').map(([date, entry]) => ({ date, jobId: entry.jobId, code: entry.code || 'dispatch_conflict', message: clip(raw.find(job => job?.id === entry.jobId)?.recurrenceConflict?.message, 600) }));
  const result = { createdJobIds: raw.filter(Boolean).map(job => job.id), conflicts, updated: outcome.updated, kept: outcome.kept, priced: outcome.priced, blocked: outcome.blocked, complete: outcome.complete, retryable: outcome.retryable === true };
  await commitWithReceipt(store, [{ collection: OPERATIONS, id: receiptId, patch: { fingerprint, actorId: session.user, action: 'extend', planId: plan.id, requestId: input.requestId, createdAt: now, result } }], receiptId, fingerprint);
  return { ok: true, requestId: input.requestId, plan: projectRecurringPlan(saved, new Date(now)), created: raw.filter(Boolean).map(job => projectDispatchJob(job, roster)), conflicts, updated: outcome.updated, kept: outcome.kept, priced: outcome.priced, blocked: outcome.blocked, complete: outcome.complete, retryable: outcome.retryable === true, warnings: [] };
}

function occurrenceInput(plan, template, date, requestId, conflict) {
  const assignment = object(plan.assignment) ? plan.assignment : {};
  // Customer reminders for generated visits are an explicit per-plan choice.
  const changes = { recurrence: 'none', notify: plan.notifyCustomer === true, assignedCrew: Array.isArray(assignment.assignedCrew) ? assignment.assignedCrew : [], crewLead: assignment.crewLead || null,
    ...(assignment.crewId ? { crewId: assignment.crewId } : {}), ...(assignment.vehicleId ? { vehicleId: assignment.vehicleId } : {}),
    ...(Number.isInteger(assignment.crewNeeded) ? { crewNeeded: assignment.crewNeeded } : {}), ...(Number.isInteger(assignment.travelBufferMinutes) ? { travelBufferMinutes: assignment.travelBufferMinutes } : {}) };
  const schedule = occurrenceSchedule(plan, date);
  if (!conflict) Object.assign(changes, schedule);
  else changes.opsNotes = clip([`Recurring visit for ${date} ${plan.time}–${plan.endTime} (Mountain Time) could not be scheduled: ${conflict.message}`, template?.opsNotes].filter(value => typeof value === 'string' && value.trim()).join('\n\n'), 8000);
  return { action: 'schedule.create', requestId, customerId: plan.customerId, kind: 'job', sourceTemplateJobId: plan.templateJobId, booking: { channel: 'recurring_plan' }, changes };
}

async function createOccurrence(store, actor, plan, template, date, { now, runId, conflict = null }) {
  const requestId = await createRequestId(plan, date, conflict), state = conflict ? 'conflict' : 'scheduled', key = await priceKey(plan);
  // CREW-NOTIFY: the visits one run creates are one crew text per employee.
  const adapter = { ...store, crewNoticeBatch: `recurring:${plan.id}:${runId || now}`,
    commit: async writes => {
      const target = writes.find(write => write.collection === 'jobs' && write.patch?.dispatchRequestId === requestId);
      if (!target) throw fail('commit_incomplete', 'The recurring visit could not be prepared.', 503);
      Object.assign(target.patch, { recurringPlanId: plan.id, occurrenceDate: date, ...(conflict ? { recurrenceConflict: { ...occurrenceSchedule(plan, date), code: conflict.code, message: clip(conflict.message, 600), conflicts: conflict.conflicts, detectedAt: now } } : {}) });
      // The slot lets a later plan edit tell an untouched visit from one moved in
      // Dispatch; a priced plan's visit waits for its estimate.save (price pending).
      writes.push({ collection: PLANS, id: plan.id, revision: plan.revision, patch: { occurrences: { ...occurrences(plan), [date]: { jobId: target.id, state, requestId, createdAt: now, ...(runId ? { runId } : {}), ...(conflict ? { code: conflict.code } : { slot: slotOf(target.patch) }), ...(key ? { price: { key, status: 'pending', at: now } } : {}) } },
        lastRun: ranOk(plan, 'create', date, now, runId), lastGeneratedAt: now, ...(conflict ? { warnings: warn(plan, { code: 'recurrence_conflict', reason: conflict.code, date, jobId: target.id, message: conflict.code === SLOT_TAKEN.code ? `The ${date} visit was saved unscheduled because a cancelled or moved booking still holds that time. Restore that booking or choose a new time in Dispatch.` : `The ${date} visit conflicts with other work and was saved unscheduled. Choose a new time in Dispatch.`, at: now }) } : {}) } });
      return store.commit(writes);
    } };
  return mutateDispatch(adapter, actor, occurrenceInput(plan, template, date, requestId, conflict), now);
}

async function recordPlan(store, planId, update) {
  const plan = await store.read(PLANS, planId);
  if (!plan) return null;
  const patch = update(plan);
  if (!patch) return plan;
  await store.commit([{ collection: PLANS, id: planId, revision: plan.revision, patch }]);
  return store.read(PLANS, planId);
}

function conflictDetails(error) {
  const rows = Array.isArray(error.details?.conflicts) ? error.details.conflicts : [];
  return { code: error.code, message: clip(error.message, 600), conflicts: rows.slice(0, 10).map(row => Object.fromEntries(['code','otherJobId','availabilityId','vehicleId','employeeId'].filter(key => typeof row?.[key] === 'string').map(key => [key, clip(row[key], 180)]).concat(Array.isArray(row?.employeeIds) ? [['employeeIds', row.employeeIds.filter(id => typeof id === 'string').slice(0, 20)]] : []))) };
}

const upcomingDate = (plan, date, instant, range) => { const interval = scheduleInterval(occurrenceSchedule(plan, date)); return interval ? interval.start > instant : date > range.startDate; };

/** True when a horizon run has work for this plan now: a missing date inside
 * its horizon, a booked visit waiting to follow an edit, (with pricing on) a
 * visit waiting for its price, or a recorded failure a clean run would clear.
 * An unreadable schedule counts as work so the run reports it. */
export function planHasWork(plan, now, { pricing = false } = {}) {
  if (!validPlan(plan) || plan.status !== 'active') return false;
  if (plan.lastRun?.status === 'error') return true;
  try {
    const index = occurrences(plan), today = denverToday(new Date(now)), instant = Date.parse(now), range = horizonRange(new Date(now), plan.horizonDays);
    if (Object.entries(index).some(([date, entry]) => object(entry?.apply) || pricing && pendingPrice(entry) && date >= today)) return true;
    return occurrenceDates(plan, range).some(date => !index[date] && upcomingDate(plan, date, instant, range));
  } catch { return true; }
}

/** Gives one generated visit the plan's current price through money-service
 * estimate.save. Its requestId is derived from plan, visit, price and the plan
 * price saved before it, so a retry replays; money someone else put on the
 * visit is never overwritten. The outcome is recorded only on the pending
 * price it started from, on the visit's entry wherever a plan edit moved it
 * meanwhile; a newer price such an edit put there stays pending and, once this
 * save lands, is chained to it. */
async function priceVisit(store, actor, planId, template, date, { now, today, runId }) {
  const plan = await store.read(PLANS, planId), entry = occurrences(plan)[date];
  if (!validPlan(plan) || !pendingPrice(entry)) return null;
  const record = (price, warning) => recordPlan(store, planId, row => {
    const index = occurrences(row), at = entryDate(index, date, entry.jobId), current = at ? index[at] : null;
    if (!pendingPrice(current)) return null;
    if (canonical(current.price) === canonical(entry.price)) return { occurrences: { ...index, [at]: { ...current, price } }, lastRun: ranOk(row, 'price', date, now, runId), ...(warning ? { warnings: warn(row, { ...warning, date, jobId: entry.jobId, at: now }) } : {}) };
    // An edit re-priced the visit from the same starting price while this save ran: the newer price follows this save.
    return price.status === 'applied' && (current.price.previousRequestId || null) === (entry.price.previousRequestId || null) ? { occurrences: { ...index, [at]: { ...current, price: { ...current.price, previousRequestId: price.requestId } } } } : null;
  }).catch(() => null);
  const key = await priceKey(plan), job = await store.read('jobs', entry.jobId), chain = entry.price.previousRequestId ? { previousRequestId: entry.price.previousRequestId } : {};
  const skip = async (reason, message) => { await record({ ...(key ? { key } : {}), status: 'skipped', reason, ...chain, at: now }, message ? { code: 'price_not_applied', reason, message } : null); return { date, jobId: entry.jobId, status: 'skipped', reason }; };
  if (!key) return skip('plan_unpriced');
  if (!liveVisit(job) || job.recurringPlanId !== plan.id) return skip('visit_closed');
  const requestId = await priceRequestId(plan.id, job.id, key, entry.price.previousRequestId);
  const applied = async (savedId = requestId, savedKey = key) => { await record({ key: savedKey, status: 'applied', requestId: savedId, at: now }); return { date, jobId: job.id, status: 'applied', requestId: savedId }; };
  if (job.moneyRequestId === requestId) return applied();
  // This pending price already saved under the plan price it was queued with,
  // and the plan price changed since without applyToBooked: it is the visit's.
  const queuedKey = entry.price.key && entry.price.key !== key ? entry.price.key : null, queued = queuedKey ? await priceRequestId(plan.id, job.id, queuedKey, entry.price.previousRequestId) : null;
  if (queued && job.moneyRequestId === queued) return applied(queued, queuedKey);
  // A re-price (replacing a plan price already on the visit) follows only visits
  // that have not started, as the edit that queued it did; a first price is kept.
  if (entry.price.previousRequestId && !unstarted(job)) return skip('started', `The ${date} visit kept its price because it has started. Update it on the job if it should match the plan.`);
  const kept = reason => skip(reason, `The ${date} visit kept its own price because ${reason === 'price_locked' ? 'it is already approved, invoiced or paid' : 'its estimate was changed in the Hub'}. Update it on the job if it should match the plan.`);
  const blocker = visitPriceBlocker(job, entry.price.previousRequestId || null);
  if (blocker) return kept(blocker);
  try { await mutateMoney(store, actor, visitEstimateInput(plan, job, { requestId, date, today, serviceName: template?.serviceType, cadence: cadenceLabel(plan.cadence) }), now); }
  catch (error) {
    // Another run (a manual extend beside the scheduled one) may have saved this same price first.
    if (['money_idempotency_conflict','money_changed_since_operation'].includes(error.code)) return (await store.read('jobs', job.id).catch(() => null))?.moneyRequestId === requestId ? applied() : kept('price_changed_in_hub');
    if (REVISION.has(error.code) || !error.status || error.status >= 500) return { date, jobId: job.id, status: 'retry', code: error.code || 'recurring_unavailable' };
    await record({ key, status: 'failed', code: clip(error.code, 80), ...chain, at: now }, { code: 'price_not_applied', reason: error.code, message: `The ${date} visit was not priced: ${clip(error.message, 300)}` });
    return { date, jobId: job.id, status: 'failed', code: error.code };
  }
  return applied();
}

/** Moves one booked visit onto the plan's edited date, time or crew with
 * mutateDispatch schedule.update, committing the job and its plan entry
 * together. A visit that started or was changed in Dispatch meanwhile, that the
 * new slot conflicts with, or whose new date and start time another booking of
 * the customer now holds, keeps its time and returns to its own date ('kept'). */
async function applyBooked(store, actor, planId, date, { now, runId }) {
  const plan = await store.read(PLANS, planId), entry = occurrences(plan)[date];
  if (!validPlan(plan) || !object(entry?.apply)) return null;
  const apply = entry.apply, job = await store.read('jobs', entry.jobId), from = apply.from?.date || date;
  // Only a drop the plan recorded (or another run already settled) is reported; otherwise the entry is retried.
  const drop = async (reason, message) => {
    const recorded = await recordPlan(store, planId, row => {
      const index = { ...occurrences(row) }, current = index[date];
      if (current?.jobId !== entry.jobId || !object(current.apply)) return null;
      const { apply: _pending, ...rest } = current, back = validDate(from) && from !== date && !index[from] ? from : date;
      delete index[date]; index[back] = rest;
      return { occurrences: index, ...(message ? { warnings: warn(row, { code: 'booked_visit_not_updated', reason, date: back, jobId: entry.jobId, message, at: now }) } : {}) };
    }).catch(() => null);
    return recorded ? { date, jobId: entry.jobId, status: 'kept', from, reason } : null;
  };
  if (!liveVisit(job)) return drop('visit_closed');
  if (!unstarted(job)) return drop('started', `The ${from} visit has started, so it kept its time and crew.`);
  if (!sameSlot(slotOf(job), apply.from)) return drop('changed_in_dispatch', `The ${from} visit was changed in Dispatch, so it was not moved to follow the plan.`);
  const to = object(apply.to) ? apply.to : null, crew = apply.crew === true && sameCrew(job, apply.crewFrom), assignment = object(plan.assignment) ? plan.assignment : {};
  const interval = to && scheduleInterval(to);
  if (to && !(interval && interval.start > Date.parse(now))) return drop('time_passed', `The new time for the ${from} visit has already passed, so it kept its time.`);
  const changes = { ...(to ? { date: to.date, time: to.time, endDate: to.endDate, endTime: to.endTime } : {}), ...(crew ? { assignedCrew: Array.isArray(assignment.assignedCrew) ? assignment.assignedCrew : [], crewLead: assignment.crewLead || null, crewId: assignment.crewId || null, vehicleId: assignment.vehicleId || null } : {}) };
  if (!Object.keys(changes).length) return drop('crew_changed_in_dispatch', `The ${from} visit's crew was changed in Dispatch, so it kept that crew.`);
  const requestId = await occurrenceRequestId(plan.id, date, `apply:${apply.requestId}`);
  let scanned = null;
  const adapter = { ...store,
    jobs: async () => (scanned = await store.jobs()),
    commit: async writes => {
      const target = writes.find(write => write.collection === 'jobs' && write.id === job.id && write.patch?.dispatchRequestId === requestId);
      if (!target) throw fail('commit_incomplete', 'The booked visit change could not be prepared.', 503);
      // Checked on the schedule this mutation just read, under its dispatchState
      // guard, so a booking made since the edit is never double-booked.
      if (!Array.isArray(scanned)) throw fail('commit_incomplete', 'The booked visit change could not be verified.', 503);
      if (await slotTaken(scanned, plan.customerId, job, to)) throw fail('slot_taken', 'The customer already has another booking at the new time.', 409);
      target.patch.occurrenceDate = date;
      const { apply: _pending, ...rest } = entry;
      writes.push({ collection: PLANS, id: plan.id, revision: plan.revision, patch: { occurrences: { ...occurrences(plan), [date]: { ...rest, slot: slotOf({ ...job, ...target.patch }), updatedAt: now } }, lastRun: ranOk(plan, 'apply', from, now, runId) } });
      return store.commit(writes);
    } };
  try {
    const result = await mutateDispatch(adapter, actor, { action: 'schedule.update', requestId, jobId: job.id, expectedRevision: job.revision, changes }, now);
    return { date, jobId: job.id, status: 'updated', from, job: result.job };
  } catch (error) {
    const fresh = occurrences(await store.read(PLANS, planId))[date];
    if (fresh?.jobId === entry.jobId && !object(fresh.apply)) return null;
    if (error.code === SLOT_TAKEN.code) return drop('slot_taken', `The ${from} visit was not moved to ${to.date} ${to.time} because the customer already has another booking at that time. It kept its original time; review both bookings in Dispatch.`);
    if (PER_DATE.has(error.code) || error.status >= 400 && error.status < 500 && !['dispatch_revision_conflict','dispatch_idempotency_conflict','dispatch_changed_since_operation'].includes(error.code)) return drop(error.code || 'dispatch_refused', `The ${from} visit could not follow the plan: ${clip(error.message, 300)} It kept its original time.`);
    throw error;
  }
}

async function extendPlan(store, baseActor, planId, { now, horizonDays, meter, runId, roster, actorFor = null, pricing = false }) {
  const outcome = { planId, created: [], conflicts: [], adopted: [], updated: [], kept: [], priced: [], blocked: null, attempts: 0, complete: true, retryable: false };
  let plan = await store.read(PLANS, planId);
  if (!validPlan(plan) || plan.status !== 'active') return { ...outcome, skipped: plan ? plan.status : 'missing' };
  const instant = Date.parse(now), today = denverToday(new Date(now)), range = horizonRange(new Date(now), horizonDays ?? plan.horizonDays);
  const upcoming = (row, date) => upcomingDate(row, date, instant, range);
  const due = row => occurrenceDates(row, range).filter(date => !occurrences(row)[date] && upcoming(row, date));
  // A plan blocked for the same reason is not rewritten on every scheduled run.
  const block = async (error, date) => {
    outcome.blocked = { code: error.code || 'recurring_unavailable', message: clip(error.message, 600), ...(date ? { date } : {}) };
    await recordPlan(store, planId, row => row.lastRun?.status === 'blocked' && row.lastRun.code === outcome.blocked.code && row.lastRun.message === outcome.blocked.message && (row.lastRun.date || null) === (date || null) ? null : ({ lastRun: { at: now, status: 'blocked', runId, ...outcome.blocked }, warnings: warn(row, { ...outcome.blocked, code: 'plan_blocked', reason: outcome.blocked.code, at: now }) })).catch(() => null);
  };
  // A status-less or 5xx failure on one date or visit is recorded on the plan
  // (once per stage, code and date, like block), so its card says the plan
  // stopped instead of the scheduled run standing still unnoticed.
  const stalled = async (error, date, stage) => {
    const code = clip(error.code || 'recurring_unavailable', 80), day = validDate(date) ? date : null;
    const message = { create: `The ${day} visit could not be saved (${code}). Each run retries it, and later visits wait for it. If this continues, add ${day} as a skipped date so later visits are added.`,
      apply: `The ${day} visit could not be moved to follow the plan (${code}). Each run retries it, and new visits wait for it. To cancel this move, save the plan again without "Also move booked visits" (the visit keeps its current time and crew), or give the visit a new date or time yourself in Dispatch.`, price: `The ${day} visit could not be priced (${code}). Each run retries it.` }[stage];
    await recordPlan(store, planId, row => row.lastRun?.status === 'error' && row.lastRun.code === code && row.lastRun.stage === stage && (row.lastRun.date || null) === day ? null
      : { lastRun: { at: now, status: 'error', runId, code, stage, date: day, message }, warnings: warn(row, { code: 'plan_run_failed', reason: code, stage, date: day, message, at: now }) }).catch(() => null);
  };
  const spend = () => { if (meter.left <= 0) { outcome.complete = false; return false; } meter.left--; outcome.attempts++; return true; };
  const retry = () => { outcome.complete = false; outcome.retryable = true; };
  let actor = baseActor;
  if (actorFor) try { actor = await actorFor(plan); } catch (error) { await block(error); outcome.complete = false; return outcome; }
  const template = await store.read('jobs', plan.templateJobId);
  if (!template) { await block(fail('template_missing', 'The template job for this plan no longer exists. End this plan and create a new one from a current job.', 409)); outcome.complete = false; return outcome; }
  const price = async date => {
    const priced = await priceVisit(store, actor, planId, template, date, { now, today, runId }).catch(error => ({ date, status: 'retry', code: error.code || 'recurring_unavailable' }));
    if (priced && priced.status !== 'retry') outcome.priced.push({ date, jobId: priced.jobId, status: priced.status, ...(priced.reason || priced.code ? { reason: priced.reason || priced.code } : {}) });
    else if (priced && !REVISION.has(priced.code)) await stalled(priced, date, 'price');
    return priced?.status !== 'retry';
  };
  // Booked visits following an edit go first, so their new dates stay reserved.
  for (const date of Object.keys(occurrences(plan)).filter(day => object(occurrences(plan)[day]?.apply)).sort()) {
    if (!spend()) break;
    let done;
    try { done = await applyBooked(store, actor, planId, date, { now, runId }); }
    catch (error) { retry(); if (error.status >= 500 || !error.status) { await stalled(error, occurrences(plan)[date]?.apply?.from?.date || date, 'apply'); throw error; } break; }
    if (done?.status === 'updated') outcome.updated.push({ date, jobId: done.jobId, from: done.from });
    // A change dropped because the visit started, moved or its new slot is taken is settled work too.
    else if (done?.status === 'kept') outcome.kept.push({ date: done.from, jobId: done.jobId, reason: done.reason });
  }
  // A dropped move frees the date it was holding; this run books it too.
  if (outcome.attempts && outcome.complete) { const fresh = await store.read(PLANS, planId); if (validPlan(fresh)) plan = fresh; }
  for (const date of outcome.complete ? due(plan) : []) {
    plan = await store.read(PLANS, planId);
    if (!validPlan(plan) || plan.status !== 'active') { outcome.complete = false; break; }
    // An update that lands mid-run (skip date, earlier end, new cadence or time) applies to the rest of it.
    if (occurrences(plan)[date] || !onSeries(plan, date) || !upcoming(plan, date)) continue;
    if (!spend()) break;
    let result, error = null;
    try { result = await createOccurrence(store, actor, plan, template, date, { now, runId }); } catch (caught) { error = caught; }
    // This date's create request already saved a visit that was later moved to
    // another date: never replay it; the date takes its next generation.
    if (error && SPENT.has(error.code)) {
      const fresh = await recordPlan(store, planId, row => occurrences(row)[date] ? null : { reissued: { ...reissuedFrom(row, today), [date]: generation(row, date) + 1 } }).catch(() => null);
      if (!fresh) { retry(); break; }
      if (occurrences(fresh)[date]) continue;
      plan = fresh; error = null;
      try { result = await createOccurrence(store, actor, plan, template, date, { now, runId }); } catch (caught) { error = caught; }
    }
    if (error) {
      let conflict = PER_DATE.has(error.code) ? conflictDetails(error) : null;
      if (error.code === 'dispatch_job_already_exists') {
        if (occurrences(await store.read(PLANS, planId))[date]) continue;
        // Only a live visit at exactly this customer/date/time stands in for the
        // occurrence. A cancelled or moved booking can still hold the slot's
        // deterministic id; that date is saved unscheduled for review instead.
        const existing = (await store.jobs()).find(job => liveVisit(job) && job.customerId === plan.customerId && job.date === date && job.time === plan.time);
        if (existing) {
          const recorded = await recordPlan(store, planId, row => occurrences(row)[date] ? null : { occurrences: { ...occurrences(row), [date]: { jobId: existing.id, state: 'existing', createdAt: now } }, lastRun: ranOk(row, 'create', date, now, runId) }).catch(() => null);
          if (!recorded) { outcome.complete = false; outcome.retryable = true; break; }
          outcome.adopted.push({ date, jobId: existing.id });
          continue;
        }
        conflict = { ...SLOT_TAKEN };
      }
      if (conflict) {
        try {
          result = await createOccurrence(store, actor, plan, template, date, { now, runId, conflict });
          outcome.conflicts.push({ date, jobId: result.job.id, code: conflict.code, message: conflict.message });
        } catch (second) { error = second; }
      }
      if (!result) {
        const fresh = await store.read(PLANS, planId);
        if (occurrences(fresh)[date]) continue;
        if (error.code === 'dispatch_revision_conflict' || !error.status || error.status >= 500) { outcome.complete = false; outcome.retryable = true; if (error.status >= 500 || !error.status) { await stalled(error, date, 'create'); throw error; } break; }
        await block(error, date); outcome.complete = false; break;
      }
    }
    if (result.job && !outcome.created.some(job => job.id === result.job.id)) outcome.created.push(result.job);
    // The new visit's price is part of the same attempt; a failure leaves it pending for the next run.
    // With server money writes off the price stays pending until they are turned on.
    if (result.job && planPriced(plan) && !pricing) outcome.priced.push({ date, jobId: result.job.id, status: 'waiting', reason: 'money_api_disabled' });
    else if (result.job && planPriced(plan) && !await price(date)) { retry(); break; }
  }
  // Visits still waiting for a price (a lost save, or re-pricing after an edit).
  // One visit that keeps failing does not hold back the prices after it.
  if (pricing && outcome.complete && !outcome.blocked) {
    const pending = occurrences(await store.read(PLANS, planId) || plan);
    for (const date of Object.keys(pending).filter(day => day >= today && pendingPrice(pending[day])).sort()) {
      if (!spend()) break;
      if (!await price(date)) retry();
    }
  }
  if (!outcome.blocked && outcome.complete && STOPPED.has(plan.lastRun?.status)) await recordPlan(store, planId, row => STOPPED.has(row.lastRun?.status) ? { lastRun: { at: now, status: 'ok', runId } } : null).catch(() => null);
  outcome.created = outcome.created.map(job => projectDispatchJob(job, roster));
  return outcome;
}

/** Create every missing occurrence inside the horizon for one plan (planId),
 * the listed plans (planIds) or all active plans, after moving booked visits
 * that follow a plan edit, and (pricing: server money writes are on) price
 * every generated visit of a priced plan. `now` is injected (ISO string);
 * horizonDays overrides each plan's own horizon; limit bounds dispatch and
 * money writes per call, a plan that fails part-way included, so a request or
 * scheduled run stays inside platform subrequest limits. Deterministic request
 * IDs make every rerun replay instead of duplicating. actorFor(plan) supplies a
 * per-plan dispatcher (the scheduled bridge command); a plan whose actor cannot
 * be resolved is blocked and recorded, never run as someone else. */
export async function extendHorizon(store, actor, { now = new Date().toISOString(), horizonDays, planId, planIds, limit = RECURRING_EXTEND_LIMIT, runId = null, actorFor = null, pricing = false } = {}) {
  if (!actorFor) requireDispatcher(actor);
  if (typeof now !== 'string' || !Number.isFinite(Date.parse(now))) throw fail('clock_invalid', 'A valid current time is required.');
  if (planId !== undefined && !safeId(planId)) throw fail('plan_not_found', 'Choose a valid recurring plan.', 404);
  if (planIds !== undefined && (!Array.isArray(planIds) || planIds.some(id => !safeId(id)))) throw fail('plan_not_found', 'Choose valid recurring plans.', 404);
  const ids = planId ? [planId] : planIds ? [...new Set(planIds)] : (await store.recurringPlans()).filter(plan => validPlan(plan) && plan.status === 'active').map(plan => plan.id).sort();
  const roster = await store.roster(), plans = [], meter = { left: Math.max(0, limit) };
  for (const id of ids) {
    const left = meter.left;
    try { plans.push(await extendPlan(store, actor, id, { now, horizonDays, meter, runId, roster, actorFor, pricing })); }
    catch (error) {
      if (planId) throw error;
      plans.push({ planId: id, created: [], conflicts: [], adopted: [], updated: [], kept: [], priced: [], blocked: null, attempts: left - meter.left, complete: false, retryable: true, error: { code: error.code || 'recurring_unavailable', message: clip(error.message, 600) } });
    }
  }
  return { ok: true, asOf: now, plans, complete: plans.every(outcome => outcome.complete) };
}

/** Flag-gated entry point: a no-op unless EGC_RECURRING_PLANS_ENABLED=true;
 * visits are priced only while MONEY_API_ENABLED=true. The caller supplies a
 * dispatcher actor or a per-plan actorFor. */
export async function runRecurringHorizon(env, { actor, now = new Date().toISOString(), storage = dispatchStorage, horizonDays, limit, planIds, runId, actorFor } = {}) {
  if (!recurringPlansEnabled(env)) return { ok: true, enabled: false, plans: [], complete: true };
  return { enabled: true, ...await extendHorizon(storage(env), actor, { now, horizonDays, limit, planIds, runId, actorFor, pricing: moneyApiEnabled(env) }) };
}
