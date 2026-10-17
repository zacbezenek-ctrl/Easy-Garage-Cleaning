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
   houseId, contactSource 'Door to door', at} and ghlTags (egc-d2d-sale | egc-d2d-walkthrough: the mirror adds them
   only with EGC_GHL_D2D_TAGS, where they are registered). A customer this bridge creates carries acquisition {...}.

   Reps only ever see dates, times, a crew's label and an estimator's first name: never a roster, employee ids,
   another customer or a crew member's name.

   Retries: only a fault that clears by itself (TRANSIENT: storage, a racing save, a lost answer) is retried, with a
   growing wait (retryAfter, 1 minute doubling to an hour) the server enforces whatever the phone does; any other
   refusal, and a booking still failing after MAX_ATTEMPTS tries, waits for the office (review). Admin > Sales lists
   every sale and every door walkthrough that is not in the Hub yet, with its reason and a Book in Hub button.

   After booking, an admin's Knock changes follow the sale to its Hub job: a cancelled sale cancels the job (never
   held up by the Hub; a failure is saved and shown), a reinstated one restores it, and a new job date moves it (or is
   refused when the Hub cannot take that time). */
import { knockFailure, write } from './knock-store.js';
import { mutateDispatch } from './dispatch-service.js';
import { dispatchOpenings } from './dispatch-openings.js';
import { resolveCustomer } from './customer-resolution.js';
import { crewAutoAssignEnabled } from './dispatch-crew-assign.js';
import { qualified, takesFieldWork } from './dispatch-rules.js';
import { customerSearchTerms } from './customer-identity.js';
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

/* An opaque, stable handle for an estimator, so a picked slot can name them without sending their staff key: the
   first 16 hex characters of an HMAC-SHA256 of the key under a secret derived from HUB_SESSION_SECRET, so a rep cannot
   test guessed usernames against it. */
const refKeys = new Map();
function refKey(env) {
  const secret = String(env?.HUB_SESSION_SECRET || '');
  if (!secret) throw knockFailure('Walkthrough times are not available right now.', 503, 'knock_bridge_unavailable');
  if (!refKeys.has(secret)) refKeys.set(secret, crypto.subtle.importKey('raw', new TextEncoder().encode(`egc-knock-estimator-ref:${secret}`), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']));
  return refKeys.get(secret);
}
export async function estimatorRef(id, env) {
  const bytes = await crypto.subtle.sign('HMAC', await refKey(env), new TextEncoder().encode(String(id)));
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
  const names = new Map(roster.map(person => [person.id, firstName(person.name)])), refs = new Map(await Promise.all(ids.map(async id => [id, await estimatorRef(id, env)])));
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

/* The customers a door's phone or email could match, read through the customer search index (searchKeys, P1-DS-14):
   one exact-key query for the phone's digits and one for the email's longest local word. Only while dispatch reads
   are windowed (EGC_DISPATCH_WINDOWED_READS=true) and every customer holds current keys; otherwise null, and
   resolveCustomer scans every customer as before. resolveCustomer still matches exactly on what it is given, and every
   customer whose phone or email equals this one holds one of these keys, so the narrower read never changes who
   matches. */
export async function candidateCustomers(store, customer) {
  if (store.windowedReads !== 'windowed' || typeof store.customersByKey !== 'function' || typeof store.customerKeyCoverage !== 'function') return null;
  const phone = customer.phone ? customerSearchTerms(customer.phone) : null, email = customer.email ? customerSearchTerms(customer.email) : null;
  // A phone or email the index cannot key (too short, one-letter words) could still match exactly: scan instead.
  if (customer.phone && !phone?.any || customer.email && !email?.query?.length || !phone && !email) return null;
  const keys = [...new Set([...(phone?.query || []), ...(email?.query || [])])];
  const coverage = await store.customerKeyCoverage().catch(() => null);
  if (!coverage?.complete) return null;
  const rows = new Map();
  for (const row of (await Promise.all(keys.map(key => store.customersByKey(key)))).flat()) rows.set(row.id, row);
  return [...rows.values()];
}

// The Hub customer for a sale or walkthrough (the canonical upsert, keyed on the record id). A customer created here
// records where they came from; an existing customer is linked, never changed.
async function bridgeCustomer(store, record, kind, nowIso) {
  const acquisition = { channel: 'door_to_door', kind, repKey: record.repKey, ...(kind === 'sale' ? { saleId: record.id } : { setterEventId: record.id }), houseId: record.houseId || '', contactSource: D2D_CONTACT_SOURCE, at: nowIso };
  const customer = { name: String(record.customer?.name || '').trim(), phone: record.customer?.phone || '', email: record.customer?.email || '', address: addressText(record.address) };
  const adapter = { ...store,
    // Called after resolveCustomer's identity guard, where its own full read would be.
    customers: async () => (await candidateCustomers(store, customer)) || store.customers(),
    commit: writes => {
      for (const item of writes) if (item.collection === 'customers' && !item.revision) Object.assign(item.patch, { acquisition });
      return store.commit(writes);
    } };
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

/* Faults that clear by themselves: storage, a save that raced another, an answer that was lost. These are retried after
   a growing wait (1, 2, 4 ... minutes, at most an hour). Every other refusal (a customer the Hub cannot match safely,
   a booking dispatch refuses, records that need review, a bug) waits for the office, as does a booking still failing
   after MAX_ATTEMPTS tries. */
export const TRANSIENT = new Set(['dispatch_storage_unavailable', 'dispatch_snapshot_changed', 'dispatch_revision_conflict', 'dispatch_outcome_unknown',
  'customer_resolve_outcome_unknown', 'customer_resolve_customer_changed']);
export const MAX_ATTEMPTS = 8;
const RETRY_MAX_MINUTES = 60;
export const retryDelayMs = attempts => Math.min(RETRY_MAX_MINUTES, 2 ** Math.max(0, attempts - 1)) * 60000;
function failure(error, attempts, nowMs) {
  const code = typeof error?.code === 'string' && error.code ? error.code.slice(0, 80) : 'bridge_error';
  if (TRANSIENT.has(code) && attempts < MAX_ATTEMPTS) {
    return { status: 'retry', code, error: 'The Hub could not be reached. It is tried again shortly.', retryAfter: new Date(nowMs + retryDelayMs(attempts)).toISOString() };
  }
  const why = TRANSIENT.has(code) ? `The Hub could not take this booking after ${attempts} tries.` : String(error?.message || 'The Hub refused this booking.');
  return { status: 'review', code, error: why.slice(0, 300), retryAfter: null };
}
// A rep's phone asking again before the wait is over, or for a booking the office must look at, is answered from the
// record with no dispatch read; an admin always tries again.
const waiting = (state, rep, nowMs) => Boolean(rep) && (state?.status === 'review' || state?.status === 'retry' && Date.parse(state.retryAfter || '') > nowMs);

/* ---------- door sale -> crew job ---------- */

function saleMessage(job) {
  if (job.status === 'created') {
    const when = [dayLabel(job.date), clockLabel(job.time)].filter(Boolean).join(', ');
    return job.assignment === 'assigned' ? `Booked: ${job.crewLabel || 'crew assigned'}, ${when}` : 'Booked: office will confirm the crew';
  }
  return job.status === 'review' ? 'Saved. The office will book the job.' : 'Saved. Booking it with the office…';
}

/** What a rep sees of a sale's Hub job: status booked | needs_crew | pending | review | cancelled, the booked day and
 * time, the crew's label and the message (and, while a retry waits, retryAt: when the server tries again). Null for a
 * sale made without the bridge. */
export function saleJobView(sale) {
  const job = sale?.handoff?.job;
  if (!job || job.mode !== 'hub') return null;
  const status = job.status === 'created' ? (job.hubCancelled ? 'cancelled' : job.assignment === 'assigned' ? 'booked' : 'needs_crew') : job.status === 'review' ? 'review' : 'pending';
  return { kind: 'sale', id: sale.id, status, date: job.date || '', time: job.time || '', endTime: job.endTime || '', crewLabel: status === 'booked' ? job.crewLabel || '' : '',
    moved: job.moved === true, message: status === 'cancelled' ? 'The Hub job is cancelled.' : job.message || saleMessage(job), ...(status === 'pending' && job.retryAfter ? { retryAt: job.retryAfter } : {}) };
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
    // A failed search is not "no crew": it is thrown, retried when it is a passing fault, never booked blind.
    const found = await dispatchOpenings(store, BRIDGE_ACTOR, { crews: 'auto', kind: 'job', startDate: date, endDate: addDays(date, SEARCH_DAYS), durationMinutes: String(minutes) }, now, { authorize: bridgeAuthorize, booker: true });
    const pick = nearestStart(found.candidates, { date, time, minutes });
    if (pick) ({ date, time } = pick);
  }
  // A house switched from a walkthrough to a sale: a booked walkthrough is named in the job's notes for the office to
  // cancel; one not booked yet is withdrawn so it never books (supersedeWalkthroughs, after the save).
  const walkthroughs = (await kstore.query('knock_walkthroughs', { where: [['houseId', '==', sale.houseId]], limit: 10 }).catch(() => []))
    .filter(row => !row.supersededBySaleId && row.status !== 'superseded');
  const booked = walkthroughs.filter(row => row.booking?.jobId);
  const moved = date !== requested.date || time !== requested.time;
  const opsNotes = [`Door-to-door sale (Knock sale ${sale.id}) by rep ${sale.repKey}. Price, deposit and the signed contract are on the Knock sale.`,
    `The rep asked for ${dayLabel(requested.date)} ${clockLabel(requested.time)}${moved ? `; booked ${dayLabel(date)} ${clockLabel(time)} instead because no crew was free then. Confirm the day with the customer.` : '.'}`,
    ...booked.map(row => `This customer also has a door-to-door walkthrough (Hub visit ${row.booking.jobId}). Cancel it if this sale replaces it.`)].join('\n');
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
  await supersedeWalkthroughs(kstore, walkthroughs, sale.id, nowIso);
  return bookedSale(result.job, result.autoCrew || null, customerId, requested);
}

// Each walkthrough on a house that became a sale: marked supersededBySaleId; one not booked yet also becomes
// 'superseded' (never booked, off the office's list). A booked one stays for the office to cancel in the Hub.
async function supersedeWalkthroughs(kstore, rows, saleId, nowIso) {
  for (const row of rows) {
    const patch = { supersededBySaleId: saleId, updatedAt: nowIso, ...(row.booking?.jobId ? {} : { status: 'superseded',
      booking: { ...(row.booking || {}), status: 'superseded', message: 'Replaced by the sale at this house.', at: nowIso, by: BRIDGE_ACTOR.user } }) };
    await kstore.commit([write.patch('knock_walkthroughs', row.id, patch, row.booking?.jobId ? '' : row.__updateTime)]).catch(() => null);
  }
}

/* Saves the outcome on the sale (handoff.job), re-reading when an admin changed the sale meanwhile. A job a person
   recorded by hand is never replaced. A job booked on another day or start than the sale's (no crew was free then)
   moves the sale's jobDate and jobStartTime with it, so the customer text, the refund cutoff and every list name the
   booked time; what the rep asked for stays in schedule and handoff.job.requested, and the history says why. */
async function saveSaleJob(kstore, saleId, outcome, nowIso) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const sale = await kstore.get('knock_sales', saleId);
    if (!sale) throw knockFailure('That sale was not found.', 404, 'knock_sale_missing');
    const prior = sale.handoff?.job || {};
    if (prior.status === 'created' && outcome.status !== 'created') return sale;
    const job = { ...prior, mode: 'hub', ...outcome, at: nowIso, by: BRIDGE_ACTOR.user, attempts: Number(prior.attempts || 0) + 1 };
    job.message = outcome.message || saleMessage(job);
    const handoff = { ...(sale.handoff || {}), job };
    const patch = { handoff, updatedAt: nowIso };
    if (job.status === 'created' && validDate(job.date) && TIME.test(job.time || '') && job.date >= (sale.earliestJobDate || '') && (job.date !== sale.jobDate || job.time !== sale.jobStartTime)) {
      Object.assign(patch, { jobDate: job.date, jobStartTime: job.time, statusHistory: [...(sale.statusHistory || []), { status: sale.status, at: nowIso, by: BRIDGE_ACTOR.user,
        note: `Booked in the Hub for ${dayLabel(job.date)} ${clockLabel(job.time)} (asked for ${dayLabel(sale.jobDate)} ${clockLabel(sale.jobStartTime)}): no crew was free then. Confirm the day with the customer.` }] });
    }
    try {
      await kstore.commit([write.patch('knock_sales', saleId, patch, sale.__updateTime)]);
      return { ...sale, ...patch };
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
  if (waiting(job, rep, now.getTime())) return { sale, view: saleJobView(sale) };
  let outcome;
  try { outcome = await bookSaleJob(store, kstore, sale, { env, now }); }
  catch (error) { if (typeof error?.code === 'string' && error.code.startsWith('knock_')) throw error; outcome = failure(error, Number(job.attempts || 0) + 1, now.getTime()); }
  const saved = await saveSaleJob(kstore, sale.id, outcome, now.toISOString());
  return { sale: saved, view: saleJobView(saved) };
}

/* ---------- door walkthrough -> estimator walkthrough ---------- */

function walkthroughMessage(booking) {
  if (booking.status === 'booked') return `Walkthrough booked: ${dayLabel(booking.date)}, ${clockLabel(booking.time)} with ${booking.estimator || 'the estimator'}`;
  if (booking.status === 'requested') return 'Walkthrough request sent: the office will set the time';
  if (booking.status === 'superseded') return 'Replaced by the sale at this house.';
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
  const refs = new Map(await Promise.all(ids.map(async id => [await estimatorRef(id, env), id])));
  const wanted = refs.get(requested.estimatorRef) || null;
  const common = { title: 'Door-to-door walkthrough', address: addressText(record.address),
    jobInstructions: [`Walkthrough set at the door (Knock rep ${record.repKey}).`, record.note ? `Rep note: ${record.note}` : ''].filter(Boolean).join('\n') };
  const attribution = () => ({ source: 'door_to_door', knockWalkthroughId: record.id, ghlTags: [D2D_GHL_TAGS.walkthrough],
    d2d: { kind: 'walkthrough', repKey: record.repKey, setterEventId: record.id, houseId: record.houseId || '', contactSource: D2D_CONTACT_SOURCE, at: nowIso } });
  const save = changes => mutateDispatch(attributedStore(store, requestId, attribution), BRIDGE_ACTOR,
    { action: 'schedule.create', requestId, customerId, kind: 'walkthrough', booking: { channel: 'hub_in_person', crmLinkReason: 'crm_sync_pending' }, changes }, nowIso, { authorize: bridgeAuthorize });
  // The picked estimator at the picked time, else another estimator then, else the nearest free hour (re-checked by
  // dispatch; one more search when a racing booking took it). A failed search is thrown (a passing fault is retried
  // later), never read as "nobody free", so the rep's pick is not given up for a storage hiccup.
  let refused = null;
  for (let attempt = 0; ids.length && attempt < 2; attempt++) {
    const found = await dispatchOpenings(estimatorStore(store, ids, attempt ? null : roster), BRIDGE_ACTOR, estimatorQuery(date, SEARCH_DAYS), now, { authorize: bridgeAuthorize, booker: true });
    const pick = nearestStart(found.candidates, { date, time, minutes: WALKTHROUGH_MINUTES, dayEnd: WALKTHROUGH_DAY.end, prefer: row => row.employeeIds?.[0] === wanted });
    const estimator = pick?.row.employeeIds?.[0];
    if (!pick || !ids.includes(estimator)) break;
    try {
      const result = await save({ ...common, date: pick.date, time: pick.time, endTime: hhmm(minutesOf(pick.time) + WALKTHROUGH_MINUTES), assignedCrew: [estimator] });
      return bookedWalkthrough(result.job, roster, customerId, requested);
    } catch (error) {
      if (error?.code === 'dispatch_conflict') continue;
      if (TRANSIENT.has(error?.code)) throw error;
      // Any other refusal of the dated booking: the request still reaches Dispatch (below), with the reason.
      refused = { error, when: `${dayLabel(pick.date)} ${clockLabel(pick.time)}` };
      break;
    }
  }
  // Nobody can take it (or the Hub refused the dated booking): an undated walkthrough waits in Dispatch's To schedule
  // list with what the customer asked for, so a walkthrough promised at the door always reaches the office.
  const asked = `${dayLabel(requested.date)} ${requested.time ? clockLabel(requested.time) : requested.part === 'pm' ? 'afternoon' : 'morning'}`;
  const why = refused ? `The Hub refused the ${refused.when} booking: ${String(refused.error?.message || 'no reason given').slice(0, 300)} (${String(refused.error?.code || 'unknown').slice(0, 80)})` : 'No estimator was free';
  const result = await save({ ...common, opsNotes: `Door-to-door walkthrough request: the customer asked for ${asked}. ${why}; book it and call the customer.` });
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
    if (['booked', 'requested', 'superseded'].includes(prior.status) && !['booked', 'requested'].includes(outcome.status)) return record;
    const booking = { ...prior, ...outcome, at: nowIso, by: BRIDGE_ACTOR.user, attempts: Number(prior.attempts || 0) + 1 };
    // The rep's message is the outcome's; a refusal's reason stays in code and error for the office.
    booking.message = walkthroughMessage(booking);
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
  // A walkthrough replaced by a sale at the house before it was booked never books.
  if (record.status === 'superseded' || record.booking?.status === 'superseded') return { walkthrough: record, view: walkthroughView(record) };
  let saved = record;
  if (!['booked', 'requested'].includes(record.booking?.status) || !record.booking?.jobId) {
    if (waiting(record.booking, rep, now.getTime())) return { walkthrough: record, view: walkthroughView(record) };
    let outcome;
    try { outcome = await bookWalkthroughVisit(store, record, { env, now }); }
    catch (error) { if (typeof error?.code === 'string' && error.code.startsWith('knock_')) throw error; outcome = failure(error, Number(record.booking?.attempts || 0) + 1, now.getTime()); }
    saved = await saveWalkthroughBooking(kstore, record.id, outcome, nowIso);
  }
  if (['booked', 'requested'].includes(saved.booking?.status)) await recordD2dSetter(kstore, saved, saved.booking, nowIso);
  return { walkthrough: saved, view: walkthroughView(saved) };
}

/** What a rep sees of a walkthrough's booking: status booked | requested | review | superseded | pending (and retryAt
 * while a retry waits), the day, time, the estimator's first name and the message. */
export function walkthroughView(record) {
  const booking = record.booking || {}, status = ['booked', 'requested', 'review', 'superseded'].includes(booking.status) ? booking.status : record.status === 'superseded' ? 'superseded' : 'pending';
  return { kind: 'walkthrough', id: record.id, ...repWalkthroughView(record).booking, status, ...(status === 'pending' && booking.retryAfter ? { retryAt: booking.retryAfter } : {}) };
}

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

/* ---------- Knock admin changes that follow a booked sale into its Hub job ---------- */

const CLOSED = new Set(['cancelled', 'canceled', 'completed', 'invoiced', 'paid', 'review_requested', 'closed', 'noshow', 'no_show', 'no-show']);
const CANCELLED = new Set(['cancelled', 'canceled']);
const jobState = job => String(job?.pipelineStatus || job?.status || '');
const hubLinked = sale => sale?.handoff?.job?.mode === 'hub' && sale.handoff.job.status === 'created' && /^[A-Za-z0-9_-]{1,180}$/.test(String(sale.handoff.job.ref || ''));

// One request id per change to a sale's Hub job: a repeat of the same change on the same job revision replays it.
async function changeRequestId(...parts) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(['egc-knock-sale-change', ...parts].join('|')));
  const hex = [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

// Merges fields into a sale's handoff.job, re-reading when the sale changed meanwhile.
async function patchSaleJob(kstore, saleId, fields, nowIso) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const sale = await kstore.get('knock_sales', saleId);
    if (!sale) throw knockFailure('That sale was not found.', 404, 'knock_sale_missing');
    const handoff = { ...(sale.handoff || {}), job: { ...(sale.handoff?.job || {}), ...fields } };
    try {
      await kstore.commit([write.patch('knock_sales', saleId, { handoff, updatedAt: nowIso }, sale.__updateTime)]);
      return { ...sale, handoff, updatedAt: nowIso };
    } catch (error) { if (error.code !== 'knock_conflict') throw error; }
  }
  throw knockFailure('The sale is busy. Retry in a moment.', 409, 'knock_retry');
}

/** After an admin cancels or reinstates a sale in Knock (setSaleStatus has saved it), its Hub job follows: a cancelled
 * sale cancels the job (reason customer_changed_plans), a reinstated one restores the job the bridge cancelled. The
 * sale's change never waits on the Hub: a Hub failure is saved on handoff.job.hubChange and answered for the office
 * to finish in Dispatch (running the same change again retries it). handoff.job.hubCancelled says whether the Hub job
 * is cancelled. Answers {sale, hub: {action, status: 'done' | 'failed', code, message, at}}, or null when the sale has no
 * Hub job or nothing to follow. */
export async function followSaleStatus(kstore, store, sale, { now = new Date() } = {}) {
  if (!hubLinked(sale)) return null;
  const job = sale.handoff.job, cancel = sale.status === 'cancelled';
  if (cancel === Boolean(job.hubCancelled)) return null;
  const nowIso = now.toISOString(), action = cancel ? 'cancel' : 'restore';
  let failed = null;
  try {
    const current = await store.read('jobs', job.ref);
    if (!current) failed = { code: 'dispatch_job_not_found', message: 'The Hub job was not found.' };
    else if (cancel ? !CANCELLED.has(jobState(current)) : CANCELLED.has(jobState(current))) {
      if (cancel && CLOSED.has(jobState(current))) failed = { code: 'dispatch_terminal_job', message: `The Hub job is already ${jobState(current).replaceAll('_', ' ')}.` };
      else {
        const requestId = await changeRequestId(sale.id, action, current.revision || '');
        await mutateDispatch(store, BRIDGE_ACTOR, cancel
          ? { action: 'schedule.cancel', requestId, jobId: current.id, expectedRevision: current.revision, cancellationReason: 'The door-to-door sale was cancelled in Knock.', reasonCode: 'customer_changed_plans' }
          : { action: 'schedule.restore', requestId, jobId: current.id, expectedRevision: current.revision }, nowIso, { authorize: bridgeAuthorize });
      }
    }
  } catch (error) {
    failed = { code: String(error?.code || 'bridge_error').slice(0, 80), message: String(error?.message || 'The Hub refused it.').slice(0, 300) };
  }
  const hub = { action, status: failed ? 'failed' : 'done', code: failed?.code || '', at: nowIso,
    message: failed ? `The Hub job could not be ${cancel ? 'cancelled' : 'restored'}: ${failed.message} ${cancel ? 'Cancel' : 'Rebook'} it in Dispatch.`
      : cancel ? 'Its Hub job was cancelled too.' : 'Its Hub job was restored.' };
  const saved = await patchSaleJob(kstore, sale.id, { hubCancelled: cancel ? !failed : Boolean(failed), hubChange: hub }, nowIso);
  return { sale: saved, hub };
}

/** An admin's new job date (and start) for a sale whose job the bridge booked: the Hub job moves first, keeping its
 * length, through mutateDispatch (the crew is picked again when EGC_DISPATCH_CREW_AUTO_ASSIGN is on). When the Hub
 * cannot take that time the change is refused (409 knock_hub_move_refused), so the sale and its job never disagree.
 * Answers the handoff.job fields to save with the sale ({date, time, endTime, crewId, crewLabel, assignment, ...}), or
 * null for a sale without an open Hub job. */
export async function moveSaleJob(store, sale, { jobDate, jobStartTime = null }, { env = {}, now = new Date() } = {}) {
  if (!hubLinked(sale) || sale.handoff.job.hubCancelled) return null;
  const job = sale.handoff.job, nowIso = now.toISOString();
  let current, autoCrew = null;
  try { current = await store.read('jobs', job.ref); }
  catch { throw knockFailure('The Hub could not be reached. Try again in a moment.', 503, 'knock_bridge_unavailable'); }
  if (!current || CLOSED.has(jobState(current))) throw knockFailure('This sale\'s Hub job is not open. Change it in Dispatch.', 409, 'knock_hub_job_closed');
  const time = jobStartTime || current.time || sale.jobStartTime || JOB_START_MINIMUM;
  const length = !current.endDate || current.endDate === current.date ? minutesOf(current.endTime) - minutesOf(current.time) : NaN;
  const minutes = Number.isFinite(length) && length > 0 ? length : jobMinutes(sale.package), end = minutesOf(time) + minutes;
  if (!TIME.test(time) || !(end <= 1440)) throw knockFailure('That start leaves no room for the job that day. Pick an earlier start.', 400, 'knock_sale_job_time');
  if (current.date !== jobDate || current.time !== time) {
    const requestId = await changeRequestId(sale.id, 'move', jobDate, time, current.revision || '');
    try {
      const result = await mutateDispatch(store, BRIDGE_ACTOR, { action: 'schedule.update', requestId, jobId: current.id, expectedRevision: current.revision,
        changes: { date: jobDate, time, endDate: jobDate, endTime: hhmm(end) } }, nowIso,
      { authorize: bridgeAuthorize, ...(crewAutoAssignEnabled(env) ? { autoCrew: true } : {}), enforce: warning => warning.code !== 'crew_size_short' });
      current = { ...current, ...result.job };
      autoCrew = result.autoCrew || null;
    } catch (error) {
      if (TRANSIENT.has(error?.code)) throw knockFailure('The Hub could not be reached. Try again in a moment.', 503, 'knock_bridge_unavailable');
      throw knockFailure(`The Hub job could not move to ${dayLabel(jobDate)} ${clockLabel(time)}: ${String(error?.message || 'the Hub refused it.')} Pick another day or time, or move it in Dispatch.`, 409, 'knock_hub_move_refused');
    }
  }
  const assigned = Array.isArray(current.assignedCrew) && current.assignedCrew.length > 0, crewId = assigned ? current.crewId || null : null;
  const crewLabel = !assigned ? '' : autoCrew?.status === 'assigned' ? String(autoCrew.crewName || '') : crewId && crewId === job.crewId ? job.crewLabel || '' : 'Crew assigned';
  const fields = { date: current.date || jobDate, time: current.time || time, endTime: current.endTime || hhmm(end), crewId, crewLabel, assignment: assigned ? 'assigned' : 'unassigned', moved: false, at: nowIso };
  return { ...fields, message: saleMessage({ status: 'created', ...fields }) };
}
