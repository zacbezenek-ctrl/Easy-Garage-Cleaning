/* KNOCK-BRIDGE (owner decisions D8, D2, D4, D6b and D9b, 2026-10-17): door-to-door work joins the one Hub schedule.
   Behind EGC_KNOCK_JOB_BRIDGE (exactly "true"); with it off nothing here runs and Knock behaves as before.

   A door sale (knock_sales) becomes a Hub customer (customer-resolution.js resolveCustomer, the canonical upsert) and a
   crew job (dispatch-service.js mutateDispatch, under the server actor BRIDGE_ACTOR), idempotent on the sale's id: the
   phone's sale event id is the request id of both the customer resolution and the dispatch save, so any retry replays
   the first answer and never makes a second job. With EGC_DISPATCH_CREW_AUTO_ASSIGN on, the server picks the crew
   inside the dispatch guard (options.autoCrew): first the time the rep picked (any eligible crew free then, Crew 1
   first), else the nearest other start that day, else the nearest day within a week, else the asked-for time with no
   crew (soldNeedsCrew, "Sold: needs crew"). A valid sale is never refused or lost because of scheduling: a booking
   that cannot be made now is kept on the sale as pending (retried) or review (the office books it by hand).

   A walkthrough set at the door (knock_walkthroughs) becomes an estimator walkthrough assigned to one estimator: staff
   with the walkthrough_estimating skill (EGC_STAFF_DIRECTORY_ENABLED), else staff whose role is sales, never the rep who
   set it. The server re-checks the picked slot: that estimator, else another estimator free then, else the nearest free
   slot, else an undated walkthrough in Dispatch's To schedule list. The same request records the setter attribution
   (knock_setters: 13% setter plus 7% estimator, D6b), keyed by the Hub walkthrough id.

   HighLevel: this lane sends nothing to HighLevel. Each Knock-made job carries plain D2D attribution the schedule mirror
   (EGC_GHL_SCHEDULE_MIRROR, another lane) reads: source 'door_to_door', d2d {kind, repKey, saleId | setterEventId,
   houseId, contactSource 'Door to door', at} and ghlTags (egc-d2d-sale | egc-d2d-walkthrough: tags the mirror is
   meant to send; registering them is the mirror's job). A customer this bridge creates carries acquisition {...}.

   Reps only ever see dates, times, a crew's label and an estimator's first name: never a roster, employee ids,
   another customer or a crew member's name. */
import { knockFailure, write } from './knock-store.js';
import { mutateDispatch } from './dispatch-service.js';
import { dispatchOpenings } from './dispatch-openings.js';
import { resolveCustomer } from './customer-resolution.js';
import { crewAutoAssignEnabled } from './dispatch-crew-assign.js';
import { qualified, takesFieldWork } from './dispatch-rules.js';
import { staffDirectoryEnabled } from './staff-directory.js';
import { addDays, denverToday, validDate } from './dispatch-time.js';
import { setterPolicy } from './knock-setters.js';
import { repWalkthroughView } from './knock-walkthroughs.js';
import { PACKAGES } from '../../crew/knock-settings.js';
import { JOB_DAY_END, JOB_START_MINIMUM, cancellationWindow, jobMinutes } from '../../crew/knock-sale-rules.js';
import { titleStreet } from '../../crew/knock-doors.js';

export const knockJobBridgeEnabled = env => env?.EGC_KNOCK_JOB_BRIDGE === 'true';

// The dispatch and customer writes this bridge makes are recorded as this server actor (createdBy, receipts, events).
export const BRIDGE_ACTOR = Object.freeze({ user: 'knock-bridge', displayName: 'EGC Knock (door to door)', role: 'system', businessAccess: false });
// The bridge is the only caller that passes this authorize; reps never reach dispatch or customer data directly.
const bridgeAuthorize = () => ({ dispatcher: false });

export const D2D_CONTACT_SOURCE = 'Door to door';
export const D2D_GHL_TAGS = Object.freeze({ sale: 'egc-d2d-sale', walkthrough: 'egc-d2d-walkthrough' });
// Estimator walkthroughs: an hour, inside 9:00 to 5:00 (walkthroughs keep the 9:00 start, D5), over the next 10 days.
export const WALKTHROUGH_MINUTES = 60;
export const WALKTHROUGH_DAY = Object.freeze({ start: '09:00', end: '17:00' });
export const WALKTHROUGH_SLOT_DAYS = 10;
export const ESTIMATOR_SKILL = 'walkthrough_estimating';
// How far the server looks for another crew or estimator time before it saves the booking without one.
const SEARCH_DAYS = 7;
const CREW_SLOT_DAYS = 7, CREW_SLOT_MAX_DAYS = 14, SLOT_LIMIT = 60, STEPS_PER_GAP = 4, WALKTHROUGH_STEPS_PER_GAP = 8;

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const minutesOf = time => (TIME.test(String(time || '')) ? Number(time.slice(0, 2)) * 60 + Number(time.slice(3)) : NaN);
const hhmm = minutes => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
const WALL = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Denver', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
function wall(iso) {
  const parts = Object.fromEntries(WALL.formatToParts(new Date(iso)).map(part => [part.type, part.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, minutes: Number(parts.hour) * 60 + Number(parts.minute) };
}
const dayNumber = date => Date.parse(`${date}T12:00:00Z`) / 86400000;

// "Mon Oct 20" and "9:30 am": how the phone and the admin screens name a booked time.
export const dayLabel = date => (validDate(date) ? new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' }).replace(',', '') : '');
export function clockLabel(time) {
  const minutes = minutesOf(time);
  if (!Number.isFinite(minutes)) return '';
  const hour = Math.floor(minutes / 60);
  return `${hour % 12 || 12}:${String(minutes % 60).padStart(2, '0')} ${hour < 12 ? 'am' : 'pm'}`;
}
const firstName = name => String(name || '').trim().split(/\s+/)[0] || 'the estimator';

/* ---------- picking a start from openings (pure) ---------- */

// The starts a dispatch-openings.js candidate can take: from its first start to the latest start that still ends
// inside the gap it was cut from and inside the day.
function startWindow(row, minutes, dayEnd) {
  const lo = minutesOf(row?.time);
  if (!Number.isFinite(lo) || !validDate(row?.date) || typeof row?.gapEndAt !== 'string') return null;
  const end = wall(row.gapEndAt), gapEnd = end.date === row.date ? end.minutes : 1440;
  const hi = Math.min(gapEnd, minutesOf(dayEnd)) - minutes;
  return hi >= lo ? { lo, hi } : null;
}

/* The candidate start nearest the asked-for date and time: the asked day first (the time itself when any row covers
   it, else the nearest other start that day), then the nearest day; ties go to a preferred row (the estimator the rep
   picked), then crew priority, then the earlier time. => {row, date, time, exact} or null. */
export function nearestStart(rows, { date, time, minutes, dayEnd = JOB_DAY_END, prefer = () => false }) {
  const wanted = minutesOf(time);
  let best = null;
  for (const row of Array.isArray(rows) ? rows : []) {
    const window = startWindow(row, minutes, dayEnd);
    if (!window || !Number.isFinite(wanted)) continue;
    const start = Math.min(Math.max(wanted, window.lo), window.hi);
    const score = [row.date === date ? 0 : 1, Math.abs(dayNumber(row.date) - dayNumber(date)), Math.abs(start - wanted), prefer(row) ? 0 : 1,
      Number.isInteger(row.priority) ? row.priority : 99, row.date < date ? 0 : 1, start];
    if (!best || compare(score, best.score) < 0) best = { row, start, score };
  }
  return best ? { row: best.row, date: best.row.date, time: hhmm(best.start), exact: best.row.date === date && best.start === wanted } : null;
}
function compare(left, right) {
  for (let index = 0; index < left.length; index++) if (left[index] !== right[index]) return left[index] < right[index] ? -1 : 1;
  return 0;
}

// Up to `steps` starts an hour apart in each candidate's window, from its first half hour (11:00, not 11:01 or
// 11:20): what a rep can pick from.
function expand(rows, minutes, dayEnd, steps) {
  const out = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const window = startWindow(row, minutes, dayEnd);
    if (!window) continue;
    const first = Math.ceil(window.lo / 30) * 30 <= window.hi ? Math.ceil(window.lo / 30) * 30 : window.lo;
    for (let start = first, count = 0; start <= window.hi && count < steps; start += 60, count++) out.push({ row, date: row.date, time: hhmm(start), endTime: hhmm(start + minutes) });
  }
  return out;
}

/* Rep-safe crew slots from crew-mode openings: one row per date and start, the first crew in priority order, as
   {date, time, endTime, crewLabel, priority} and nothing else (no crew id, roster, employee or customer). */
export function repCrewSlots(candidates, { minutes, limit = SLOT_LIMIT } = {}) {
  const byStart = new Map();
  for (const slot of expand(candidates, minutes, JOB_DAY_END, STEPS_PER_GAP)) {
    const priority = Number.isInteger(slot.row.priority) ? slot.row.priority : 99, key = `${slot.date} ${slot.time}`, held = byStart.get(key);
    if (!held || priority < held.priority) byStart.set(key, { date: slot.date, time: slot.time, endTime: slot.endTime, crewLabel: String(slot.row.crewName || '').slice(0, 100) || 'Crew', priority });
  }
  return [...byStart.values()].sort((a, b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time)).slice(0, limit);
}

/* ---------- estimators ---------- */

/** Who estimates walkthroughs: staff with the walkthrough_estimating skill at a qualified level when the staff
 * directory is on (it holds skills), else staff whose role is sales; office-only owners and managers and the rep who
 * set the walkthrough never. Roster ids, in roster order. */
export function estimatorIds(roster, env, excludeKey = '') {
  const directory = staffDirectoryEnabled(env), exclude = String(excludeKey || '').toLowerCase();
  return (Array.isArray(roster) ? roster : []).filter(person => typeof person?.id === 'string' && person.id !== exclude && takesFieldWork(person)
    && (directory ? qualified(person, ESTIMATOR_SKILL) : person.role === 'sales' || (Array.isArray(person.staffRoles) && person.staffRoles.includes('sales')))).map(person => person.id);
}

// An opaque, stable handle for an estimator, so a picked slot can name them without sending their staff key.
export async function estimatorRef(id) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`egc-knock-estimator:${id}`));
  return [...new Uint8Array(bytes)].slice(0, 8).map(byte => byte.toString(16).padStart(2, '0')).join('');
}

/* The dispatch store as the openings search sees it for estimators: only the estimators hold the walkthrough skill,
   so the "any qualified" search (dispatch-openings.js) is one search over all of them. `roster` is the roster the
   caller already read (else it is read once here); the booking itself re-reads it inside the dispatch guard. */
function estimatorStore(store, ids, roster = null) {
  let marked = roster ? roster.map(person => ({ ...person, skills: ids.includes(person.id) ? [{ id: ESTIMATOR_SKILL, level: 'proficient' }] : [] })) : null;
  const read = async () => (marked ||= (await store.roster()).map(person => ({ ...person, skills: ids.includes(person.id) ? [{ id: ESTIMATOR_SKILL, level: 'proficient' }] : [] })));
  return { ...store, roster: async () => structuredClone(await read()) };
}

const estimatorQuery = (startDate, days) => ({ requiredSkills: ESTIMATOR_SKILL, kind: 'walkthrough', startDate, endDate: addDays(startDate, days),
  durationMinutes: String(WALKTHROUGH_MINUTES), workdayStart: WALKTHROUGH_DAY.start, workdayEnd: WALKTHROUGH_DAY.end });

/* ---------- rep-facing searches ---------- */

/* GET /api/knock-crew-openings: crew starts on and after the sale's earliest job date (the day after the right to
   cancel ends), for the package's length. query: from (YYYY-MM-DD), package, days (1-14, default 7). */
export async function crewSlotsForRep(store, settings, query = {}, now = new Date()) {
  const today = denverToday(now);
  const earliest = cancellationWindow(today, { businessDays: settings.sale.cancelBusinessDays, extraHolidays: settings.sale.extraHolidays }).earliestJobDate;
  const from = validDate(query.from) && query.from > earliest ? query.from : earliest;
  const days = Math.min(CREW_SLOT_MAX_DAYS, Math.max(1, Number.parseInt(query.days, 10) || CREW_SLOT_DAYS));
  const pkg = PACKAGES.includes(query.package) ? query.package : null, minutes = jobMinutes(pkg);
  const found = await dispatchOpenings(store, BRIDGE_ACTOR, { crews: 'auto', kind: 'job', startDate: from, endDate: addDays(from, days), durationMinutes: String(minutes) }, now, { authorize: bridgeAuthorize, booker: true });
  return { earliestJobDate: earliest, from, days, minutes, slots: repCrewSlots(found.candidates, { minutes }) };
}

/* GET /api/knock-walkthrough-slots: estimator hours over the next 10 days, as {date, time, endTime, estimator (first
   name), ref (opaque estimator handle)}. */
export async function walkthroughSlotsForRep(store, env, rep, now = new Date()) {
  const today = denverToday(now), roster = await store.roster(), ids = estimatorIds(roster, env, rep?.repKey);
  if (!ids.length) return { from: today, days: WALKTHROUGH_SLOT_DAYS, minutes: WALKTHROUGH_MINUTES, slots: [] };
  const found = await dispatchOpenings(estimatorStore(store, ids, roster), BRIDGE_ACTOR, estimatorQuery(today, WALKTHROUGH_SLOT_DAYS), now, { authorize: bridgeAuthorize, booker: true });
  const names = new Map(roster.map(person => [person.id, firstName(person.name)])), refs = new Map(await Promise.all(ids.map(async id => [id, await estimatorRef(id)])));
  const seen = new Set(), slots = [];
  for (const slot of expand(found.candidates, WALKTHROUGH_MINUTES, WALKTHROUGH_DAY.end, WALKTHROUGH_STEPS_PER_GAP)) {
    const id = slot.row.employeeIds?.[0], key = `${slot.date} ${slot.time} ${id}`;
    if (!ids.includes(id) || seen.has(key)) continue;
    seen.add(key);
    slots.push({ date: slot.date, time: slot.time, endTime: slot.endTime, estimator: names.get(id) || 'Estimator', ref: refs.get(id) });
  }
  slots.sort((a, b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time) || a.estimator.localeCompare(b.estimator));
  return { from: today, days: WALKTHROUGH_SLOT_DAYS, minutes: WALKTHROUGH_MINUTES, slots: slots.slice(0, SLOT_LIMIT) };
}

/* ---------- shared booking pieces ---------- */

export function addressText(address) {
  const street = [address?.number, titleStreet(address?.street || '')].filter(Boolean).join(' ') + (address?.unit ? ` #${address.unit}` : '');
  return [street, address?.city, [address?.state || 'CO', address?.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ').slice(0, 500);
}

// The Hub customer for a sale or walkthrough (the canonical upsert, keyed on the record id). A customer created here
// records where they came from; an existing customer is linked, never changed.
async function bridgeCustomer(store, record, kind, nowIso) {
  const acquisition = { channel: 'door_to_door', kind, repKey: record.repKey, ...(kind === 'sale' ? { saleId: record.id } : { setterEventId: record.id }), houseId: record.houseId || '', contactSource: D2D_CONTACT_SOURCE, at: nowIso };
  const adapter = { ...store, commit: writes => {
    for (const item of writes) if (item.collection === 'customers' && !item.revision) Object.assign(item.patch, { acquisition });
    return store.commit(writes);
  } };
  const customer = { name: String(record.customer?.name || '').trim(), phone: record.customer?.phone || '', email: record.customer?.email || '', address: addressText(record.address) };
  const result = await resolveCustomer(adapter, BRIDGE_ACTOR, { requestId: record.id, customer }, { authorize: bridgeAuthorize, now: nowIso });
  return result.customer.id;
}

// Adds the D2D attribution (and anything else in `extra`) to the job this save creates, in the same commit.
function attributedStore(store, requestId, extra) {
  return { ...store, commit: writes => {
    const target = writes.find(item => item.collection === 'jobs' && item.patch?.dispatchRequestId === requestId && !item.revision);
    if (target) Object.assign(target.patch, extra(target.patch));
    return store.commit(writes);
  } };
}

// A dispatch or customer refusal the office must look at; anything else (storage, a lost answer) is retried.
const REVIEW = /^(customer_resolve_|dispatch_(job_already_exists|customer_|conflict|lock_unavailable|time_invalid|job_start_too_early|handoff|lineage|project_|contact_link|booking_|crew_|skills_|invalid_field|patch_not_allowed|idempotency_conflict|changed_since_operation))/;
function failure(error) {
  const code = typeof error?.code === 'string' ? error.code.slice(0, 80) : '';
  return REVIEW.test(code) ? { status: 'review', code, error: String(error?.message || '').slice(0, 300) } : { status: 'retry', code: code || 'bridge_unavailable', error: 'The Hub could not be reached. It is retried on the next sync.' };
}

/* ---------- door sale -> crew job ---------- */

function saleMessage(job) {
  if (job.status === 'created') {
    const when = [dayLabel(job.date), clockLabel(job.time)].filter(Boolean).join(', ');
    return job.assignment === 'assigned' ? `Booked: ${job.crewLabel || 'crew assigned'}, ${when}` : 'Booked: office will confirm the crew';
  }
  return job.status === 'review' ? 'Saved. The office will book the job.' : 'Saved. Booking it with the office…';
}

/** What a rep sees of a sale's Hub job: status booked | needs_crew | pending | review, the booked day and time, the
 * crew's label and the message. Null for a sale made without the bridge. */
export function saleJobView(sale) {
  const job = sale?.handoff?.job;
  if (!job || job.mode !== 'hub') return null;
  const status = job.status === 'created' ? (job.assignment === 'assigned' ? 'booked' : 'needs_crew') : job.status === 'review' ? 'review' : 'pending';
  return { kind: 'sale', id: sale.id, status, date: job.date || '', time: job.time || '', endTime: job.endTime || '', crewLabel: status === 'booked' ? job.crewLabel || '' : '',
    moved: job.moved === true, message: job.message || saleMessage(job) };
}

const latestStart = minutes => minutesOf(JOB_DAY_END) - minutes;
// A start inside the 9:30 to 5:00 job day for this length (the asked-for time when it already is).
function clampStart(time, minutes) {
  const wanted = minutesOf(time), floor = minutesOf(JOB_START_MINIMUM), last = Math.max(floor, latestStart(minutes));
  return hhmm(Math.min(Math.max(Number.isFinite(wanted) ? wanted : floor, floor), last));
}

function bookedSale(job, autoCrew, customerId, requested) {
  const assigned = autoCrew?.status === 'assigned' || !autoCrew && Array.isArray(job.assignedCrew) && job.assignedCrew.length > 0;
  const crewLabel = autoCrew?.status === 'assigned' ? String(autoCrew.crewName || '') : '';
  const out = { status: 'created', ref: job.id, customerId: customerId || job.customerId || '', date: job.date || '', time: job.time || '', endTime: job.endTime || '',
    crewId: assigned ? job.crewId || null : null, crewLabel, assignment: assigned ? 'assigned' : 'unassigned', requested, moved: job.date !== requested.date || job.time !== requested.time, code: '', error: '' };
  return { ...out, message: saleMessage(out) };
}

async function bookSaleJob(store, kstore, sale, { env, now }) {
  const nowIso = now.toISOString(), requestId = sale.id;
  const requested = { date: sale.schedule?.date || sale.jobDate, time: sale.schedule?.time || sale.jobStartTime };
  // A receipt means this sale's job was saved, perhaps by a call whose answer was lost: answer from it.
  const prior = await store.read('dispatchOperations', requestId.toLowerCase());
  if (prior) {
    const saved = await store.read(prior.collection, prior.targetId);
    if (!saved) throw Object.assign(new Error('The saved job could not be read back.'), { code: 'dispatch_outcome_unknown' });
    return bookedSale(saved, prior.metadata?.crewAutoAssigned || null, saved.customerId, requested);
  }
  const customerId = await bridgeCustomer(store, sale, 'sale', nowIso);
  const minutes = jobMinutes(sale.package), auto = crewAutoAssignEnabled(env);
  // Never before the day after the right to cancel ends, nor before tomorrow; the start inside the 9:30-5:00 day.
  const floorDate = [sale.earliestJobDate, addDays(denverToday(now), 1)].filter(validDate).sort().at(-1);
  let date = validDate(requested.date) && requested.date >= floorDate ? requested.date : floorDate, time = clampStart(requested.time, minutes);
  if (auto) {
    // Where a crew is free: the asked-for time when any crew is, else the nearest other start (dispatch re-checks).
    const found = await dispatchOpenings(store, BRIDGE_ACTOR, { crews: 'auto', kind: 'job', startDate: date, endDate: addDays(date, SEARCH_DAYS), durationMinutes: String(minutes) }, now, { authorize: bridgeAuthorize, booker: true }).catch(() => null);
    const pick = found ? nearestStart(found.candidates, { date, time, minutes }) : null;
    if (pick) ({ date, time } = pick);
  }
  // The rep may switch a house from a walkthrough to a sale: the office is told to cancel the walkthrough it no longer needs.
  const walkthroughs = (await kstore.query('knock_walkthroughs', { where: [['houseId', '==', sale.houseId]], limit: 5 }).catch(() => []))
    .filter(row => row.repKey === sale.repKey && row.booking?.jobId);
  const moved = date !== requested.date || time !== requested.time;
  const opsNotes = [`Door-to-door sale (Knock sale ${sale.id}) by rep ${sale.repKey}. Price, deposit and the signed contract are on the Knock sale.`,
    `The rep asked for ${dayLabel(requested.date)} ${clockLabel(requested.time)}${moved ? `; booked ${dayLabel(date)} ${clockLabel(time)} instead because no crew was free then. Confirm the day with the customer.` : '.'}`,
    ...walkthroughs.map(row => `This customer also has a door-to-door walkthrough (Hub visit ${row.booking.jobId}). Cancel it if this sale replaces it.`)].join('\n');
  const input = { action: 'schedule.create', requestId, customerId, kind: 'job', booking: { channel: 'hub_in_person', crmLinkReason: 'crm_sync_pending' },
    changes: { date, time, endTime: hhmm(minutesOf(time) + minutes), title: `${sale.package} (door-to-door sale)`.slice(0, 500), address: addressText(sale.address),
      serviceType: String(sale.package || '').slice(0, 500), jobInstructions: [`Sold at the door: ${sale.package}.`, sale.note ? `Rep note: ${sale.note}` : ''].filter(Boolean).join('\n'),
      opsNotes, estimatedDurationMin: minutes } };
  const attribution = () => ({ source: 'door_to_door', knockSaleId: sale.id, ghlTags: [D2D_GHL_TAGS.sale],
    d2d: { kind: 'sale', repKey: sale.repKey, saleId: sale.id, houseId: sale.houseId || '', contactSource: D2D_CONTACT_SOURCE, at: nowIso },
    // With crew auto-assign off the job waits for a manager, flagged as a sale that needs a crew.
    ...(auto ? {} : { soldNeedsCrew: { at: nowIso, by: BRIDGE_ACTOR.user, requestId, reason: 'auto_assign_off' } }) });
  const result = await mutateDispatch(attributedStore(store, requestId, attribution), BRIDGE_ACTOR, input, nowIso,
    { authorize: bridgeAuthorize, ...(auto ? { autoCrew: true } : {}), enforce: warning => warning.code !== 'crew_size_short' });
  for (const row of walkthroughs) {
    await kstore.commit([write.patch('knock_walkthroughs', row.id, { supersededBySaleId: sale.id, updatedAt: nowIso })]).catch(() => null);
  }
  return bookedSale(result.job, result.autoCrew || null, customerId, requested);
}

// Saves the outcome on the sale (handoff.job), re-reading when an admin changed the sale meanwhile. A job a person
// recorded by hand is never replaced.
async function saveSaleJob(kstore, saleId, outcome, nowIso) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const sale = await kstore.get('knock_sales', saleId);
    if (!sale) throw knockFailure('That sale was not found.', 404, 'knock_sale_missing');
    const prior = sale.handoff?.job || {};
    if (prior.status === 'created' && outcome.status !== 'created') return sale;
    const job = { ...prior, mode: 'hub', ...outcome, at: nowIso, by: BRIDGE_ACTOR.user, attempts: Number(prior.attempts || 0) + 1 };
    if (!job.message) job.message = saleMessage(job);
    const handoff = { ...(sale.handoff || {}), job };
    try {
      await kstore.commit([write.patch('knock_sales', saleId, { handoff, updatedAt: nowIso }, sale.__updateTime)]);
      return { ...sale, handoff, updatedAt: nowIso };
    } catch (error) { if (error.code !== 'knock_conflict') throw error; }
  }
  throw knockFailure('The sale is busy. Retry in a moment.', 409, 'knock_retry');
}

/** Book (or answer the booking of) a door sale's Hub job. `rep` limits it to that rep's own sale (null: an admin).
 * Never throws for a scheduling problem: it answers {sale, view} with the job pending, booked or for review. */
export async function bookSale(kstore, store, saleId, { env = {}, now = new Date(), rep = null } = {}) {
  const sale = await kstore.get('knock_sales', String(saleId || ''));
  if (!sale || rep && sale.repKey !== rep.repKey) throw knockFailure('That sale was not found.', 404, 'knock_sale_missing');
  const job = sale.handoff?.job || {};
  // A sale made without the bridge (manual hand-off) is the office's to book; a rep never books it from the phone.
  if (rep && job.mode !== 'hub') throw knockFailure('This sale is booked by the office.', 409, 'knock_bridge_manual');
  if (job.status === 'created') return { sale, view: saleJobView(sale) };
  if (sale.status === 'cancelled') throw knockFailure('That sale is cancelled.', 409, 'knock_sale_cancelled');
  let outcome;
  try { outcome = await bookSaleJob(store, kstore, sale, { env, now }); }
  catch (error) { if (typeof error?.code === 'string' && error.code.startsWith('knock_')) throw error; outcome = failure(error); }
  const saved = await saveSaleJob(kstore, sale.id, outcome, now.toISOString());
  return { sale: saved, view: saleJobView(saved) };
}

/* ---------- door walkthrough -> estimator walkthrough ---------- */

function walkthroughMessage(booking) {
  if (booking.status === 'booked') return `Walkthrough booked: ${dayLabel(booking.date)}, ${clockLabel(booking.time)} with ${booking.estimator || 'the estimator'}`;
  if (booking.status === 'requested') return 'Walkthrough request sent: the office will set the time';
  return booking.status === 'review' ? 'Saved. The office will book the walkthrough.' : 'Saved. Booking it with the office…';
}

function bookedWalkthrough(job, roster, customerId, requested) {
  const estimatorKey = job.date && Array.isArray(job.assignedCrew) && typeof job.assignedCrew[0] === 'string' ? job.assignedCrew[0] : '';
  const person = estimatorKey ? roster.find(row => row.id === estimatorKey) : null;
  const out = { status: job.date ? 'booked' : 'requested', jobId: job.id, revision: job.revision || '', customerId: customerId || job.customerId || '', date: job.date || '', time: job.time || '',
    endTime: job.endTime || '', estimator: person ? firstName(person.name) : '', estimatorKey, requested, code: '', error: '' };
  return { ...out, message: walkthroughMessage(out) };
}

async function bookWalkthroughVisit(store, record, { env, now }) {
  const nowIso = now.toISOString(), requestId = record.id, requested = record.requested || {};
  const prior = await store.read('dispatchOperations', requestId.toLowerCase());
  if (prior) {
    const [saved, roster] = await Promise.all([store.read(prior.collection, prior.targetId), store.roster()]);
    if (!saved) throw Object.assign(new Error('The saved walkthrough could not be read back.'), { code: 'dispatch_outcome_unknown' });
    return bookedWalkthrough(saved, roster, saved.customerId, requested);
  }
  const customerId = await bridgeCustomer(store, record, 'walkthrough', nowIso);
  const roster = await store.roster(), ids = estimatorIds(roster, env, record.repKey);
  const today = denverToday(now), date = validDate(requested.date) && requested.date >= today ? requested.date : today;
  const time = TIME.test(String(requested.time || '')) ? requested.time : requested.part === 'pm' ? '13:00' : WALKTHROUGH_DAY.start;
  const refs = new Map(await Promise.all(ids.map(async id => [await estimatorRef(id), id])));
  const wanted = refs.get(requested.estimatorRef) || null;
  const common = { title: 'Door-to-door walkthrough', address: addressText(record.address),
    jobInstructions: [`Walkthrough set at the door (Knock rep ${record.repKey}).`, record.note ? `Rep note: ${record.note}` : ''].filter(Boolean).join('\n') };
  const attribution = () => ({ source: 'door_to_door', knockWalkthroughId: record.id, ghlTags: [D2D_GHL_TAGS.walkthrough],
    d2d: { kind: 'walkthrough', repKey: record.repKey, setterEventId: record.id, houseId: record.houseId || '', contactSource: D2D_CONTACT_SOURCE, at: nowIso } });
  const save = changes => mutateDispatch(attributedStore(store, requestId, attribution), BRIDGE_ACTOR,
    { action: 'schedule.create', requestId, customerId, kind: 'walkthrough', booking: { channel: 'hub_in_person', crmLinkReason: 'crm_sync_pending' }, changes }, nowIso, { authorize: bridgeAuthorize });
  // The picked estimator at the picked time, else another estimator then, else the nearest free hour (re-checked by
  // dispatch; one more search when a racing booking took it).
  for (let attempt = 0; ids.length && attempt < 2; attempt++) {
    const found = await dispatchOpenings(estimatorStore(store, ids, attempt ? null : roster), BRIDGE_ACTOR, estimatorQuery(date, SEARCH_DAYS), now, { authorize: bridgeAuthorize, booker: true }).catch(() => null);
    const pick = found ? nearestStart(found.candidates, { date, time, minutes: WALKTHROUGH_MINUTES, dayEnd: WALKTHROUGH_DAY.end, prefer: row => row.employeeIds?.[0] === wanted }) : null;
    const estimator = pick?.row.employeeIds?.[0];
    if (!pick || !ids.includes(estimator)) break;
    try {
      const result = await save({ ...common, date: pick.date, time: pick.time, endTime: hhmm(minutesOf(pick.time) + WALKTHROUGH_MINUTES), assignedCrew: [estimator] });
      return bookedWalkthrough(result.job, roster, customerId, requested);
    } catch (error) { if (error?.code !== 'dispatch_conflict') throw error; }
  }
  // Nobody can take it: an undated walkthrough waits in Dispatch's To schedule list with what the customer asked for.
  const result = await save({ ...common, opsNotes: `Door-to-door walkthrough request: the customer asked for ${dayLabel(requested.date)} ${requested.time ? clockLabel(requested.time) : requested.part === 'pm' ? 'afternoon' : 'morning'}. No estimator was free; book it and call the customer.` });
  return bookedWalkthrough(result.job, roster, customerId, requested);
}

/* The setter attribution for a walkthrough the bridge booked: knock_setters/<Hub walkthrough id>, the same record
   Admin > Setters writes (knock-setters.js), create-only with its knock_receipts claim, recorded by the bridge.
   Rates are the owner's D6b split; nothing is earned until the walkthrough converts and is collected. */
export async function recordD2dSetter(kstore, record, booking, nowIso) {
  if (!booking?.jobId) return null;
  const receiptId = `setter_${record.id}`;
  const [receipt, existing] = await Promise.all([kstore.get('knock_receipts', receiptId), kstore.get('knock_setters', booking.jobId)]);
  if (receipt || existing) return existing;
  const estimatorKey = booking.estimatorKey || '';
  const payload = { walkthroughId: booking.jobId, setterKey: record.repKey, serviceClassification: 'unverified', classificationReference: '',
    estimatorKey, estimatorReference: estimatorKey ? `knock-walkthrough:${record.id}` : '' };
  const row = { ...payload, channel: 'appointment_setter', requestId: record.id, recordedBy: BRIDGE_ACTOR.user, recordedAt: nowIso, sourceRevision: booking.revision || '',
    source: 'knock_walkthrough', knockWalkthroughId: record.id, rates: { setter: setterPolicy.rate, estimator: setterPolicy.estimatorRate, total: setterPolicy.totalRate } };
  try { await kstore.commit([write.create('knock_receipts', receiptId, payload), write.create('knock_setters', booking.jobId, row)]); }
  catch (error) { if (error.code !== 'knock_exists') throw error; return kstore.get('knock_setters', booking.jobId); }
  return { id: booking.jobId, ...row };
}

async function saveWalkthroughBooking(kstore, id, outcome, nowIso) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const record = await kstore.get('knock_walkthroughs', id);
    if (!record) throw knockFailure('That walkthrough was not found.', 404, 'knock_walkthrough_missing');
    const prior = record.booking || {};
    if (['booked', 'requested'].includes(prior.status) && !['booked', 'requested'].includes(outcome.status)) return record;
    const booking = { ...prior, ...outcome, at: nowIso, by: BRIDGE_ACTOR.user, attempts: Number(prior.attempts || 0) + 1 };
    if (!booking.message) booking.message = walkthroughMessage(booking);
    const status = booking.status === 'booked' ? 'booked' : booking.status === 'requested' ? 'requested' : record.status || 'set';
    try {
      await kstore.commit([write.patch('knock_walkthroughs', id, { booking, status, updatedAt: nowIso }, record.__updateTime)]);
      return { ...record, booking, status, updatedAt: nowIso };
    } catch (error) { if (error.code !== 'knock_conflict') throw error; }
  }
  throw knockFailure('The walkthrough is busy. Retry in a moment.', 409, 'knock_retry');
}

/** Book (or answer the booking of) a walkthrough set at the door, and record its setter attribution in the same
 * request. `rep` limits it to that rep's own walkthrough (null: an admin). Answers {walkthrough, view}. */
export async function bookWalkthrough(kstore, store, id, { env = {}, now = new Date(), rep = null } = {}) {
  const record = await kstore.get('knock_walkthroughs', String(id || ''));
  if (!record || rep && record.repKey !== rep.repKey) throw knockFailure('That walkthrough was not found.', 404, 'knock_walkthrough_missing');
  const nowIso = now.toISOString();
  let saved = record;
  if (!['booked', 'requested'].includes(record.booking?.status) || !record.booking?.jobId) {
    let outcome;
    try { outcome = await bookWalkthroughVisit(store, record, { env, now }); }
    catch (error) { if (typeof error?.code === 'string' && error.code.startsWith('knock_')) throw error; outcome = failure(error); }
    saved = await saveWalkthroughBooking(kstore, record.id, outcome, nowIso);
  }
  if (['booked', 'requested'].includes(saved.booking?.status)) await recordD2dSetter(kstore, saved, saved.booking, nowIso);
  return { walkthrough: saved, view: walkthroughView(saved) };
}

export const walkthroughView = record => ({ kind: 'walkthrough', id: record.id, ...repWalkthroughView(record).booking,
  status: ['booked', 'requested', 'review'].includes(record.booking?.status) ? record.booking.status : 'pending' });

/* ---------- My money: the Hub job behind each bridged sale ---------- */

/** {saleId -> {status, date, time, crewLabel}} read live from the Hub jobs of a rep's bridged sales (one masked read).
 * The crew is named only by its label; a crew a manager changed by hand reads "Crew assigned". */
export async function hubJobsForSales(store, sales) {
  const linked = sales.filter(sale => sale.handoff?.job?.mode === 'hub' && sale.handoff.job.status === 'created' && /^[A-Za-z0-9_-]{1,180}$/.test(String(sale.handoff.job.ref || '')));
  if (!linked.length) return new Map();
  const rows = await store.readMany('jobs', linked.map(sale => sale.handoff.job.ref), ['date', 'time', 'endTime', 'status', 'pipelineStatus', 'crewId', 'crewAutoAssigned']);
  const byId = new Map(rows.map(row => [row.id, row]));
  return new Map(linked.map(sale => {
    const stored = sale.handoff.job, job = byId.get(stored.ref);
    if (!job) return [sale.id, { status: 'unavailable', date: stored.date || '', time: stored.time || '', crewLabel: '' }];
    const auto = job.crewAutoAssigned && job.crewAutoAssigned.crewId === job.crewId ? job.crewAutoAssigned.crewName : '';
    const crewLabel = !job.crewId ? '' : auto || (job.crewId === stored.crewId ? stored.crewLabel : '') || 'Crew assigned';
    return [sale.id, { status: String(job.pipelineStatus || job.status || 'scheduled'), date: job.date || '', time: job.time || '', crewLabel: String(crewLabel).slice(0, 100) }];
  }));
}
