/** Server-owned recurring plans. recurringPlans/{planId} holds the cadence and
 * the occurrence index; each generated visit is an ordinary dispatch job made by
 * mutateDispatch schedule.create (sourceTemplateJobId = plan.templateJobId).
 * Occurrence request IDs are derived from sha256(planId:date), and the plan's
 * occurrence index is committed atomically with the job, so reruns replay or
 * skip rather than duplicate. Manager receipts live in recurringPlanOperations. */
import { mutateDispatch, requireDispatcher, projectDispatchJob } from './dispatch-service.js';
import { assignmentKey } from './job-assignment.js';
import { validDate, addDays, denverToday, scheduleInterval } from './dispatch-time.js';
import { DISPATCH_TIME_ZONE } from './dispatch-contract.js';
import { dispatchStorage } from './dispatch-storage.js';
import { segmented } from './dispatch-segments.js';
import { cadenceLabel, horizonRange, nextOccurrences, normalizeRecurringSchedule, occurrenceDates, occurrenceSchedule } from './recurring-plans.js';

export const RECURRING_PLAN_ACTIONS = Object.freeze(['create','update','pause','resume','end','extend']);
export const RECURRING_EXTEND_LIMIT = 10;
export const recurringPlansEnabled = env => env?.EGC_RECURRING_PLANS_ENABLED === 'true';
const PLANS = 'recurringPlans', OPERATIONS = 'recurringPlanOperations';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const SCHEDULE_FIELDS = ['cadence','startDate','time','endTime','spanDays','endsOn','count','skipDates','horizonDays'];
const notifyFlag = value => { if (value !== undefined && typeof value !== 'boolean') throw fail('field_invalid', 'Customer reminders must be turned on or off.'); return value === true; };
const PER_DATE = new Set(['dispatch_conflict','dispatch_time_invalid']);
const TERMINAL = new Set(['cancelled','canceled','completed','invoiced','paid','review_requested','closed','noshow','no_show','no-show']);
const CANCELLED = new Set(['cancelled','canceled','noshow','no_show','no-show']);
const LIVE_STATES = ['scheduled','conflict','existing','template'];
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

/** RFC 9562 version-8 UUID shape so every dispatch request-ID guard accepts it. */
export async function occurrenceRequestId(planId, date, variant = '') {
  const hex = await sha256(`${planId}:${date}${variant ? `:${variant}` : ''}`);
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-8${hex.slice(13,16)}-${((parseInt(hex[16],16) & 3) | 8).toString(16)}${hex.slice(17,20)}-${hex.slice(20,32)}`;
}

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
  const row = { date, jobId: entry?.jobId || null, state: entry?.state || 'scheduled', ...(entry?.code ? { code: entry.code } : {}) };
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

export async function mutateRecurringPlan(store, session, input, now = new Date().toISOString(), { enabled = false } = {}) {
  requireDispatcher(session);
  keys(input, ['action','requestId','planId','expectedRevision','plan','limit'], 'The recurring plan request');
  if (!RECURRING_PLAN_ACTIONS.includes(input.action) || !UUID.test(input.requestId || '')) throw fail('request_invalid', 'Use a supported recurring plan action with a unique request ID.');
  if (input.action === 'create' ? 'planId' in input || 'expectedRevision' in input : !safeId(input.planId) || typeof input.expectedRevision !== 'string' || !input.expectedRevision) throw fail('request_invalid', input.action === 'create' ? 'A new plan cannot name an existing plan.' : 'Choose a recurring plan and the revision you reviewed.');
  if ('plan' in input !== ['create','update'].includes(input.action) || 'limit' in input && input.action !== 'extend') throw fail('request_invalid', 'This recurring plan action has unsupported fields.');
  const fingerprint = await digest({ actor: session.user, input }), receiptId = input.requestId.toLowerCase();
  // A saved request still replays after the flag is turned off, so its outcome can be verified.
  const prior = await store.read(OPERATIONS, receiptId);
  if (!prior && !enabled && !['pause','end'].includes(input.action)) throw fail('disabled', 'Recurring plans are turned off for this Hub. Existing plans can still be paused or ended.', 404);
  const roster = await store.roster();
  if (prior) return replay(store, session, input, prior, fingerprint, roster, now);
  if (input.action === 'extend') return extendRequest(store, session, input, fingerprint, roster, now);
  const resources = await store.resources();
  let planId, current = null, patch, warnings = [];
  if (input.action === 'create') {
    keys(input.plan, ['templateJobId', ...SCHEDULE_FIELDS, 'assignment', 'notifyCustomer'], 'The recurring plan');
    if (!safeId(input.plan.templateJobId)) throw fail('template_invalid', 'Choose an existing job to repeat.');
    const template = await store.read('jobs', input.plan.templateJobId);
    if (!template || template.recordType || !['job','cleanout','reorg'].includes(template.type) || !safeId(template.customerId)) throw fail('template_invalid', 'The recurring template must be an operational job linked to a Hub customer.', 409);
    // A plan repeats one time window and crew; a split job's hull would reserve every crew for the whole span.
    if (segmented(template)) throw fail('template_segmented', 'A job split into crew segments cannot be repeated. Repeat a job with one time and crew, or remove its segments first.', 409);
    const customer = await store.read('customers', template.customerId);
    if (!customer) throw fail('customer_not_found', 'The template customer no longer exists. Review the job before repeating it.', 409);
    const schedule = normalizeRecurringSchedule({ ...templateSchedule(template), ...Object.fromEntries(SCHEDULE_FIELDS.filter(key => key in input.plan).map(key => [key, input.plan[key]])) });
    const fallback = templateAssignment(template, roster);
    if (!('assignment' in input.plan) && fallback.assignedCrew.length < (Array.isArray(template.assignedCrew) ? template.assignedCrew.length : 0)) warnings.push({ code: 'template_crew_inactive', message: 'Some employees on the template job are no longer active and were not added to the plan.' });
    planId = `plan_${receiptId.replaceAll('-','')}`;
    const seeded = validDate(template.date) && occurrenceDates(schedule, { startDate: template.date, endDate: addDays(template.date, 1) }).length ? { [template.date]: { jobId: template.id, state: 'template', createdAt: now } } : {};
    patch = { id: planId, recordType: 'recurring_plan', version: 1, status: 'active', customerId: customer.id, customer: clip(customer.name || [customer.firstName, customer.lastName].filter(Boolean).join(' ') || template.customer, 200), address: clip(template.address || customer.address, 1000),
      templateJobId: template.id, ...schedule, assignment: normalizeAssignment(input.plan.assignment ?? fallback, roster, resources), notifyCustomer: notifyFlag(input.plan.notifyCustomer), occurrences: seeded, warnings: [], lastRun: null, createdAt: now, createdBy: session.user };
  } else {
    planId = input.planId;
    current = await store.read(PLANS, planId);
    if (!validPlan(current)) throw fail('plan_not_found', 'This recurring plan could not be found.', 404);
    if (current.revision !== input.expectedRevision) throw fail('revision_conflict', 'This recurring plan changed while you were editing. Refresh and review its latest details.', 409);
    const allowed = { update: ['active','paused'], pause: ['active'], resume: ['paused'], end: ['active','paused'] }[input.action];
    if (!allowed.includes(current.status)) throw fail('state_invalid', current.status === 'ended' ? 'This recurring plan has ended. Create a new plan to repeat the work again.' : `This plan is already ${current.status}.`, 409);
    if (input.action === 'update') {
      keys(input.plan, [...SCHEDULE_FIELDS, 'assignment', 'notifyCustomer'], 'The recurring plan changes');
      const schedule = normalizeRecurringSchedule({ ...Object.fromEntries(SCHEDULE_FIELDS.map(key => [key, current[key]]).filter(([, value]) => value !== undefined)), ...Object.fromEntries(SCHEDULE_FIELDS.filter(key => key in input.plan).map(key => [key, input.plan[key]])) });
      patch = { ...schedule, ...('assignment' in input.plan ? { assignment: normalizeAssignment(input.plan.assignment, roster, resources) } : {}), ...('notifyCustomer' in input.plan ? { notifyCustomer: notifyFlag(input.plan.notifyCustomer) } : {}) };
      // Visits already booked on dates the new series no longer includes are
      // never cancelled here; name each one so the customer is not double-booked.
      const today = denverToday(new Date(now)), index = occurrences(current), next = { ...current, ...schedule };
      const stale = Object.keys(index).filter(date => validDate(date) && date >= today && index[date]?.jobId && LIVE_STATES.includes(index[date].state) && !onSeries(next, date)).sort();
      const live = stale.length ? new Set((await store.jobs()).filter(liveVisit).map(job => job.id)) : new Set();
      const kept = stale.filter(date => live.has(index[date].jobId)).map(date => ({ date, jobId: index[date].jobId })), off = kept.filter(row => !schedule.skipDates.includes(row.date));
      for (const { date, jobId } of kept.filter(row => schedule.skipDates.includes(row.date))) warnings.push({ code: 'skip_date_already_scheduled', date, jobId, message: `The ${date} visit is already on the schedule. Cancel it in Dispatch if the customer should be skipped.` });
      if (off.length) warnings.push({ code: 'generated_visits_off_pattern', visits: off, message: `${off.length} ${plural(off.length, 'visit', 'visits')} already on the schedule no longer ${plural(off.length, 'matches', 'match')} this plan and ${plural(off.length, 'was', 'were')} NOT removed: ${off.map(row => row.date).join(', ')}. Cancel ${plural(off.length, 'it', 'them')} in Dispatch, or the customer keeps ${plural(off.length, 'that visit', 'those visits')} as well as the new pattern.` });
      if (Object.keys(index).some(date => date >= today)) warnings.push({ code: 'generated_visits_unchanged', message: 'Visits already on the schedule keep their current time and crew. Edit them in Dispatch if they should change too.' });
    } else patch = { pause: { status: 'paused', pausedAt: now, pausedBy: session.user }, resume: { status: 'active', resumedAt: now, resumedBy: session.user }, end: { status: 'ended', endedAt: now, endedBy: session.user } }[input.action];
    if (input.action === 'pause' || input.action === 'end') warnings.push({ code: 'generated_visits_unchanged', message: 'Visits already on the schedule were not cancelled. Cancel them in Dispatch if the customer should not be visited.' });
  }
  Object.assign(patch, { updatedAt: now, updatedBy: session.user, planRequestId: input.requestId });
  const before = current ? Object.fromEntries(['status', ...SCHEDULE_FIELDS, 'assignment', 'notifyCustomer'].filter(key => current[key] !== undefined).map(key => [key, current[key]])) : null;
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
  return { created: jobs.map(job => projectDispatchJob(job, roster)), conflicts: result.conflicts || [], blocked: result.blocked || null, complete: result.complete === true, retryable: result.retryable === true };
}

/** Any returned extend result, including a partial one (complete:false,
 * retryable:true), is final for its requestId and replays unchanged. Continue
 * with a NEW requestId and the returned plan.revision. Only a run that threw
 * (503, outcome unknown) continues under the same requestId. */
async function extendRequest(store, session, input, fingerprint, roster, now) {
  const limit = integer(input.limit, 'Visits per request', 1, 20) ?? 4, receiptId = input.requestId.toLowerCase();
  const plan = await store.read(PLANS, input.planId);
  if (!validPlan(plan)) throw fail('plan_not_found', 'This recurring plan could not be found.', 404);
  // A partial run of this same request may already have advanced the revision.
  if (plan.revision !== input.expectedRevision && plan.lastRun?.runId !== input.requestId) throw fail('revision_conflict', 'This recurring plan changed while you were editing. Refresh and review its latest details.', 409);
  if (plan.status !== 'active') throw fail('state_invalid', 'Only an active plan can add visits. Resume it first.', 409);
  const mine = row => Object.entries(occurrences(row)).filter(([, entry]) => entry?.runId === input.requestId && entry.jobId && ['scheduled','conflict'].includes(entry.state)).sort(([a], [b]) => a.localeCompare(b));
  const run = await extendHorizon(store, session, { now, planId: plan.id, limit: Math.max(0, limit - mine(plan).length), runId: input.requestId });
  const outcome = run.plans[0], saved = await store.read(PLANS, plan.id) || plan, entries = mine(saved);
  // Report everything this request created, including a partial earlier attempt.
  const raw = await Promise.all(entries.map(([, entry]) => store.read('jobs', entry.jobId)));
  const conflicts = entries.filter(([, entry]) => entry.state === 'conflict').map(([date, entry]) => ({ date, jobId: entry.jobId, code: entry.code || 'dispatch_conflict', message: clip(raw.find(job => job?.id === entry.jobId)?.recurrenceConflict?.message, 600) }));
  const result = { createdJobIds: raw.filter(Boolean).map(job => job.id), conflicts, blocked: outcome.blocked, complete: outcome.complete, retryable: outcome.retryable === true };
  await commitWithReceipt(store, [{ collection: OPERATIONS, id: receiptId, patch: { fingerprint, actorId: session.user, action: 'extend', planId: plan.id, requestId: input.requestId, createdAt: now, result } }], receiptId, fingerprint);
  return { ok: true, requestId: input.requestId, plan: projectRecurringPlan(saved, new Date(now)), created: raw.filter(Boolean).map(job => projectDispatchJob(job, roster)), conflicts, blocked: outcome.blocked, complete: outcome.complete, retryable: outcome.retryable === true, warnings: [] };
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
  return { action: 'schedule.create', requestId, customerId: plan.customerId, kind: 'job', sourceTemplateJobId: plan.templateJobId, changes };
}

async function createOccurrence(store, actor, plan, template, date, { now, runId, conflict = null }) {
  const requestId = await occurrenceRequestId(plan.id, date, conflict ? 'unscheduled' : ''), state = conflict ? 'conflict' : 'scheduled';
  const adapter = { ...store,
    commit: async writes => {
      const target = writes.find(write => write.collection === 'jobs' && write.patch?.dispatchRequestId === requestId);
      if (!target) throw fail('commit_incomplete', 'The recurring visit could not be prepared.', 503);
      Object.assign(target.patch, { recurringPlanId: plan.id, occurrenceDate: date, ...(conflict ? { recurrenceConflict: { ...occurrenceSchedule(plan, date), code: conflict.code, message: clip(conflict.message, 600), conflicts: conflict.conflicts, detectedAt: now } } : {}) });
      writes.push({ collection: PLANS, id: plan.id, revision: plan.revision, patch: { occurrences: { ...occurrences(plan), [date]: { jobId: target.id, state, requestId, createdAt: now, ...(runId ? { runId } : {}), ...(conflict ? { code: conflict.code } : {}) } },
        lastRun: { at: now, status: 'ok', runId }, lastGeneratedAt: now, ...(conflict ? { warnings: warn(plan, { code: 'recurrence_conflict', reason: conflict.code, date, jobId: target.id, message: conflict.code === SLOT_TAKEN.code ? `The ${date} visit was saved unscheduled because a cancelled or moved booking still holds that time. Restore that booking or choose a new time in Dispatch.` : `The ${date} visit conflicts with other work and was saved unscheduled. Choose a new time in Dispatch.`, at: now }) } : {}) } });
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

async function extendPlan(store, actor, planId, { now, horizonDays, budget, runId, roster }) {
  const outcome = { planId, created: [], conflicts: [], adopted: [], blocked: null, attempts: 0, complete: true, retryable: false };
  let plan = await store.read(PLANS, planId);
  if (!validPlan(plan) || plan.status !== 'active') return { ...outcome, skipped: plan ? plan.status : 'missing' };
  const instant = Date.parse(now), range = horizonRange(new Date(now), horizonDays ?? plan.horizonDays);
  const upcoming = (row, date) => { const interval = scheduleInterval(occurrenceSchedule(row, date)); return interval ? interval.start > instant : date > range.startDate; };
  const due = row => occurrenceDates(row, range).filter(date => !occurrences(row)[date] && upcoming(row, date));
  const block = async (error, date) => {
    outcome.blocked = { code: error.code || 'recurring_unavailable', message: clip(error.message, 600), ...(date ? { date } : {}) };
    await recordPlan(store, planId, row => ({ lastRun: { at: now, status: 'blocked', runId, ...outcome.blocked }, warnings: warn(row, { ...outcome.blocked, code: 'plan_blocked', reason: outcome.blocked.code, at: now }) })).catch(() => null);
  };
  const template = await store.read('jobs', plan.templateJobId);
  if (!template) { await block(fail('template_missing', 'The template job for this plan no longer exists. End this plan and create a new one from a current job.', 409)); outcome.complete = false; return outcome; }
  for (const date of due(plan)) {
    plan = await store.read(PLANS, planId);
    if (!validPlan(plan) || plan.status !== 'active') { outcome.complete = false; break; }
    // An update that lands mid-run (skip date, earlier end, new cadence or time) applies to the rest of it.
    if (occurrences(plan)[date] || !onSeries(plan, date) || !upcoming(plan, date)) continue;
    if (outcome.attempts >= budget) { outcome.complete = false; break; }
    outcome.attempts++;
    let result;
    try { result = await createOccurrence(store, actor, plan, template, date, { now, runId }); }
    catch (error) {
      let conflict = PER_DATE.has(error.code) ? conflictDetails(error) : null;
      if (error.code === 'dispatch_job_already_exists') {
        if (occurrences(await store.read(PLANS, planId))[date]) continue;
        // Only a live visit at exactly this customer/date/time stands in for the
        // occurrence. A cancelled or moved booking can still hold the slot's
        // deterministic id; that date is saved unscheduled for review instead.
        const existing = (await store.jobs()).find(job => liveVisit(job) && job.customerId === plan.customerId && job.date === date && job.time === plan.time);
        if (existing) {
          const recorded = await recordPlan(store, planId, row => occurrences(row)[date] ? null : { occurrences: { ...occurrences(row), [date]: { jobId: existing.id, state: 'existing', createdAt: now } }, lastRun: { at: now, status: 'ok', runId } }).catch(() => null);
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
        if (error.code === 'dispatch_revision_conflict' || !error.status || error.status >= 500) { outcome.complete = false; outcome.retryable = true; if (error.status >= 500 || !error.status) throw error; break; }
        await block(error, date); outcome.complete = false; break;
      }
    }
    if (result.job && !outcome.created.some(job => job.id === result.job.id)) outcome.created.push(result.job);
  }
  if (!outcome.blocked && outcome.complete && plan.lastRun?.status === 'blocked') await recordPlan(store, planId, row => row.lastRun?.status === 'blocked' ? { lastRun: { at: now, status: 'ok', runId } } : null).catch(() => null);
  outcome.created = outcome.created.map(job => projectDispatchJob(job, roster));
  return outcome;
}

/** Create every missing occurrence inside the horizon for one plan (planId) or
 * all active plans. `now` is injected (ISO string); horizonDays overrides each
 * plan's own horizon; limit bounds dispatch creates per call so a request or
 * scheduled run stays inside platform subrequest limits. Deterministic request
 * IDs make every rerun replay instead of duplicating. The scheduled command
 * (P1-DS-11) calls runRecurringHorizon, which wraps this. */
export async function extendHorizon(store, actor, { now = new Date().toISOString(), horizonDays, planId, limit = RECURRING_EXTEND_LIMIT, runId = null } = {}) {
  requireDispatcher(actor);
  if (typeof now !== 'string' || !Number.isFinite(Date.parse(now))) throw fail('clock_invalid', 'A valid current time is required.');
  if (planId !== undefined && !safeId(planId)) throw fail('plan_not_found', 'Choose a valid recurring plan.', 404);
  const ids = planId ? [planId] : (await store.recurringPlans()).filter(plan => validPlan(plan) && plan.status === 'active').map(plan => plan.id).sort();
  const roster = await store.roster(), plans = [];
  let budget = limit;
  for (const id of ids) {
    try {
      const outcome = await extendPlan(store, actor, id, { now, horizonDays, budget: Math.max(0, budget), runId, roster });
      budget -= outcome.attempts; plans.push(outcome);
    } catch (error) {
      if (planId) throw error;
      plans.push({ planId: id, created: [], conflicts: [], adopted: [], blocked: null, attempts: 0, complete: false, retryable: true, error: { code: error.code || 'recurring_unavailable', message: clip(error.message, 600) } });
    }
  }
  return { ok: true, asOf: now, plans, complete: plans.every(outcome => outcome.complete) };
}

/** Entry point for the later scheduled command. It is a no-op unless
 * EGC_RECURRING_PLANS_ENABLED=true; the caller supplies a dispatcher actor. */
export async function runRecurringHorizon(env, { actor, now = new Date().toISOString(), storage = dispatchStorage, horizonDays, limit } = {}) {
  if (!recurringPlansEnabled(env)) return { ok: true, enabled: false, plans: [], complete: true };
  return { enabled: true, ...await extendHorizon(storage(env), actor, { now, horizonDays, limit }) };
}
