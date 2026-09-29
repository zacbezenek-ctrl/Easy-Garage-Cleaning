/* GHL-TRACK-1: the durable HighLevel tag outbox. HighLevel owns every
   confirmation, reminder and follow-up; the Hub only tells it what happened,
   by adding tags and setting the appointment status. With EGC_GHL_TAG_OUTBOX
   on, a dispatch or bridge schedule change and a walkthrough outcome write one
   ghlTagOutbox entry in the SAME commit as the change (id derived from the job
   and its change key, created once), and point the job at it (ghlTagEntry).
   The API that saved it makes the first attempt (ctx.waitUntil); the Railway
   egc-worker's signed POST /api/ghl-tag-drain retries every 2 minutes with a
   1, 5, 15, 60 minute backoff and parks an entry after 8 attempts, for a
   manager's Retry. An attempt claims the entry first (compare-and-set), so two
   drains never both write, and it re-reads the visit: a change the visit has
   since moved past is closed without any request. A booking waits, without
   counting as a failure, until the visit's HighLevel appointment is written
   (the calendar mirror), so HighLevel sees the appointment before the tag, as
   it does today; a booking with no appointment and none coming, and a cancel or
   no-show for a booking HighLevel never heard of, are closed untold. Each signed
   drain tick records a check-in, and the stuck view counts parked entries and
   pending ones the drain is overdue on (a stopped worker), for the visit's
   current change only. Nothing here sends a message, and a contact is created
   only outside a messaging dry run. */
import { firestoreFetch } from './firebase-service-account.js';
import { decodeFirestoreFields } from './firestore-job.js';
import { dispatchStorage } from './dispatch-storage.js';
import { canDispatch } from './dispatch-permissions.js';
import { scheduleInterval } from './dispatch-time.js';
import { addContactNote, addTags, completeAppointment, ensureContact, ghlTagOutboxEnabled, highLevelConfig } from './highlevel-tags.js';

export { ghlTagOutboxEnabled };
// Server-only collection; firestore.rules denies every browser read and write.
export const GHL_TAG_OUTBOX = 'ghlTagOutbox';
export const GHL_TAG_BACKOFF_MINUTES = Object.freeze([1, 5, 15, 60]);
export const GHL_TAG_PARK_ATTEMPTS = 8;
// Checks while a booking waits for its appointment write. Waiting never parks: it ends when the visit starts.
export const GHL_TAG_WAIT_MINUTES = Object.freeze([1, 2, 5, 10, 15, 30, 60]);
// A claim that never finished (the Worker died mid-attempt) is picked up again after this.
export const GHL_TAG_CLAIM_MINUTES = 5;
// Entries one drain call attempts: each costs about 6-9 subrequests (Firestore and HighLevel).
export const GHL_TAG_DRAIN_LIMIT = 5;
export const GHL_TAG_SCAN_LIMIT = 500;
// A pending entry the drain has not attempted this long after it was due is stuck (the worker stopped or fell behind):
// the stuck view and the card count it, and a manager's Retry runs it at once.
export const GHL_TAG_OVERDUE_MINUTES = 15;
// Each signed drain tick that completes a pass records a check-in here (server-only). The worker ticks every 2 minutes.
export const GHL_TAG_DRAIN_STATE = 'ghlTagDrainState';
export const GHL_TAG_DRAIN_STATE_ID = 'worker';
export const GHL_TAG_DRAIN_STALE_MINUTES = 10;
// Entries a visit has moved past that one stuck view closes (each is a Firestore commit).
export const GHL_TAG_STUCK_CLOSE_LIMIT = 20;
export const GHL_TAG_STATUSES = Object.freeze(['pending', 'done', 'parked']);
export const GHL_TAG_OUTCOMES = Object.freeze({ customer_no_show: 'walkthrough_no_show', not_interested: 'walkthrough_lost', quote_to_follow: 'quote_to_follow' });
const ENTRY_ID = /^gto_[0-9a-f]{40}$/, UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CANCELLED = new Set(['cancelled', 'canceled']), NO_SHOW = new Set(['noshow', 'no_show', 'no-show']);
const FINISHED = new Set(['completed', 'invoiced', 'paid', 'review_requested', 'closed']);
// The visit's HighLevel appointment write is still to come (the page's sync or the schedule-sync worker).
const MIRRORING = new Set(['pending', 'syncing', 'error']);
const SCHEDULE_KINDS = new Set(['scheduled', 'rescheduled', 'restored']), RESCHEDULED = 'egc-visit-rescheduled';
const ROOT = 'projects/egcw-1ec83/databases/(default)/documents';
const BASE = `https://firestore.googleapis.com/v1/${ROOT}`;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const state = job => String(job?.pipelineStatus || job?.status || '').toLowerCase();
const visitKind = type => type === 'walkthrough' ? 'walkthrough' : ['job', 'cleanout', 'reorg'].includes(type) ? 'job' : null;
const startOf = job => job ? scheduleInterval(job)?.startAt || null : null;
const ms = value => { const at = Date.parse(typeof value === 'string' ? value : ''); return Number.isFinite(at) ? at : NaN; };
const iso = at => new Date(at).toISOString();
const safeId = id => typeof id === 'string' && /^[A-Za-z0-9_-]{1,180}$/.test(id) && !/^(_egc_|secure_)/.test(id);
const fail = (code, message, status = 400) => Object.assign(new Error(message), { code, status });
const hex = buffer => [...new Uint8Array(buffer)].map(byte => byte.toString(16).padStart(2, '0')).join('');

/** The entry id for one change: the same job and change key always name the same entry. */
export async function ghlTagEntryId(jobId, changeKey) {
  return `gto_${hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${jobId}|${changeKey}`))).slice(0, 40)}`;
}
export const ghlTagChangeKey = (source, requestId) => `${source}:${String(requestId || '').toLowerCase()}`;
export const ghlTagBackoffMinutes = attempts => GHL_TAG_BACKOFF_MINUTES[Math.min(Math.max(attempts, 1), GHL_TAG_BACKOFF_MINUTES.length) - 1];
export const ghlTagWaitMinutes = waits => GHL_TAG_WAIT_MINUTES[Math.min(Math.max(waits, 1), GHL_TAG_WAIT_MINUTES.length) - 1];
const count = value => Number.isSafeInteger(value) && value > 0 ? value : 0;

// The confirmation and reminder tags today's browser sync adds (highlevel.js tool=schedule); the reminder follows Notify customer.
// The type tag keeps the browser's mapping (event_type is the visit's type and only 'job' is a job), so a cleanout or reorg
// starts the same HighLevel workflow with the flag on as off. Correcting that is a separate change (docs/HIGHLEVEL-BOUNDARY.md).
function scheduledTags(job) {
  const days = Math.min(30, Math.max(1, Math.round(Number(job.reminderDays)) || 2));
  return ['egc-hub-scheduled', job.type === 'job' ? 'egc-job-scheduled' : 'egc-walkthrough-scheduled', ...(job.notify === false ? [] : [`egc-reminder-${days}d`])];
}

/** What a schedule change tells HighLevel, or null: placed (created, first timed, or a new end), moved,
 * restored, cancelled or marked a no-show. Blocks, unscheduled and finished visits tell it nothing. */
export function scheduleTagEvent(before, after, action) {
  if (!object(after) || !visitKind(after.type)) return null;
  const now = state(after), then = before ? state(before) : '';
  if (CANCELLED.has(now)) return CANCELLED.has(then) ? null : 'cancelled';
  if (NO_SHOW.has(now)) return NO_SHOW.has(then) ? null : 'no_show';
  const start = startOf(after);
  if (FINISHED.has(now) || !start) return null;
  if (action === 'schedule.restore') return 'restored';
  const previous = startOf(before);
  if (!previous || CANCELLED.has(then) || NO_SHOW.has(then)) return 'scheduled';
  if (previous !== start) return 'rescheduled';
  return scheduleInterval(before)?.endAt !== scheduleInterval(after)?.endAt ? 'scheduled' : null;
}

function entryWrite(id, jobId, changeKey, kind, fields, requestId, now, source, after, history = {}) {
  const entry = { id, jobId, changeKey, kind, addTags: fields.addTags, appointmentStatus: fields.appointmentStatus || null, opportunityStage: null, note: fields.note || null,
    expect: fields.expect, visitType: visitKind(after.type), source, requestId: String(requestId).toLowerCase(), createdAt: now, attempts: 0, nextAttemptAt: now, status: 'pending', ...history };
  return { write: { collection: GHL_TAG_OUTBOX, id, patch: entry }, pointer: { id, kind, startAt: startOf(after), requestId: entry.requestId, queuedAt: now } };
}

/** The outbox write for a schedule change (dispatch or the bridge) and the job's ghlTagEntry pointer, or null.
 * The caller commits the write with the change and sets patch.ghlTagEntry = pointer. */
export async function scheduleTagWrites({ jobId, before = null, after, action, requestId, now, source = 'dispatch' }) {
  const kind = scheduleTagEvent(before, after, action);
  if (!kind || !safeId(jobId)) return null;
  const changeKey = ghlTagChangeKey(source, requestId), id = await ghlTagEntryId(jobId, changeKey);
  const fields = kind === 'cancelled' ? { addTags: ['egc-visit-cancelled'], appointmentStatus: 'cancelled', expect: { state: 'cancelled' } }
    : kind === 'no_show' ? { addTags: ['egc-visit-no-show'], appointmentStatus: 'noshow', expect: { state: 'no_show' } }
    : { addTags: [...scheduledTags(after), ...(kind === 'rescheduled' ? [RESCHEDULED] : [])], expect: { state: 'active', startAt: startOf(after) } };
  // Whether HighLevel knew an earlier time is settled when the entry is told (earlierTimeTold): the previous entry, or,
  // before the visit's first entry, the appointment it already had from the browser sync.
  const previousEntryId = ENTRY_ID.test(before?.ghlTagEntry?.id || '') ? before.ghlTagEntry.id : null;
  return entryWrite(id, jobId, changeKey, kind, fields, requestId, now, source, after, { previousEntryId, previousTold: !previousEntryId && Boolean(before?.highlevelAppointmentId) });
}

/** The outbox write for a recorded walkthrough outcome (FUN-05/FUN-06), or null. A sale keeps the Game Plan's own tags
 * (highlevel.js tool=game_plan) and a reschedule waits for the Dispatch move. The lost reason goes in an internal note. */
export async function outcomeTagWrites({ visit, outcome, reasonCode = null, requestId, now }) {
  const kind = GHL_TAG_OUTCOMES[outcome];
  if (!kind || !object(visit) || visit.type !== 'walkthrough' || !safeId(visit.id)) return null;
  const changeKey = ghlTagChangeKey('walkthrough-outcome', requestId), id = await ghlTagEntryId(visit.id, changeKey), expect = { state: 'outcome', outcomeRequestId: String(requestId).toLowerCase() };
  const fields = kind === 'walkthrough_no_show' ? { addTags: ['egc-walkthrough-no-show'], appointmentStatus: 'noshow', expect }
    : kind === 'walkthrough_lost' ? { addTags: ['egc-walkthrough-lost'], note: `Walkthrough outcome: not interested. Reason code: ${reasonCode || 'not recorded'}.`, expect }
    : { addTags: ['egc-walkthrough-complete', 'egc-quote-to-follow'], expect };
  return entryWrite(id, visit.id, changeKey, kind, fields, requestId, now, 'walkthrough_visit', visit);
}

/** The flag is on and the visit's newest entry was written at its current time: that entry speaks for the scheduled tags. */
export function outboxOwnsScheduleTags(env, job) {
  const pointer = job?.ghlTagEntry;
  return ghlTagOutboxEnabled(env) && object(pointer) && ENTRY_ID.test(pointer.id || '') && typeof pointer.startAt === 'string' && pointer.startAt === startOf(job);
}

/** Who adds the scheduled tags for the browser sync (highlevel.js tool=schedule and a Game Plan's job date), so the
 * browser and the outbox never both add them and neither leaves them out. 'browser' (as with the flag off): no current
 * entry, or its entry was closed without telling HighLevel. 'outbox' with status 'done': already told. 'outbox' with
 * status 'queued': still to tell, waiting or parked; the sync hands it the attempt once it has linked the contact and
 * appointment (handOffScheduleTags). An unreadable entry stays the outbox's ('unknown'), never reported as told. */
export async function scheduleTagOwner(env, job, store = null) {
  if (!outboxOwnsScheduleTags(env, job)) return { owner: 'browser' };
  let entry;
  try { entry = await (store || ghlTagOutboxStorage(env)).read(GHL_TAG_OUTBOX, job.ghlTagEntry.id); }
  catch { return { owner: 'outbox', status: 'unknown' }; }
  if (!entry || entry.status === 'done' && entry.skipped) return { owner: 'browser' };
  if (entry.status === 'done') return { owner: 'outbox', status: 'done' };
  return { owner: 'outbox', status: 'queued', entryId: entry.id };
}

/** After the browser sync wrote the visit's appointment and linked its contact: the entry is due now (a parked one
 * gets a fresh budget, as a manager's Retry gives it) and gets one attempt that no longer waits for the mirror. An
 * entry another attempt holds, or one already told, is left alone. */
export async function handOffScheduleTags(env, id, { now = new Date().toISOString(), store = ghlTagOutboxStorage(env), fetcher = (...args) => fetch(...args) } = {}) {
  const entry = await store.read(GHL_TAG_OUTBOX, id);
  if (!entry || !['pending', 'parked'].includes(entry.status) || ms(entry.claimedUntil) > Date.parse(now)) return null;
  const fresh = entry.status === 'parked' ? { attempts: 0, waits: 0, lastError: '', retriedAt: now, retriedBy: 'browser_sync' } : {};
  await store.commit([{ collection: GHL_TAG_OUTBOX, id, revision: entry.revision, patch: { status: 'pending', nextAttemptAt: now, ...fresh } }]);
  return drainGhlTagOutbox(store, { env, now, ids: [id], fetcher, mirrored: [id] });
}

/** Pending, not backing off and not claimed by another attempt. `at` is ms. */
export function ghlTagDue(entry, at) {
  if (entry?.status !== 'pending') return false;
  const next = ms(entry.nextAttemptAt), claimed = ms(entry.claimedUntil);
  return !(next > at) && !(claimed > at);
}

/** Due for more than GHL_TAG_OVERDUE_MINUTES and still not attempted: the drain is not running (or is far behind). */
export function ghlTagOverdue(entry, at) {
  if (!ghlTagDue(entry, at)) return false;
  const next = ms(entry.nextAttemptAt), since = Number.isFinite(next) ? next : ms(entry.createdAt);
  return Number.isFinite(since) && at - since > GHL_TAG_OVERDUE_MINUTES * 60000;
}

// The change is still what the visit shows: the same start, still upcoming; still cancelled or a no-show; still this outcome.
function stillCurrent(entry, job, at) {
  const expect = object(entry.expect) ? entry.expect : {};
  if (expect.state === 'active') return !CANCELLED.has(state(job)) && !NO_SHOW.has(state(job)) && !FINISHED.has(state(job)) && startOf(job) === expect.startAt && ms(expect.startAt) > at;
  if (expect.state === 'cancelled') return CANCELLED.has(state(job));
  if (expect.state === 'no_show') return NO_SHOW.has(state(job));
  if (expect.state === 'outcome') return object(job.walkthroughOutcome) && job.walkthroughOutcome.requestId === expect.outcomeRequestId;
  return false;
}

// HighLevel's own refusals (ghl() throws a status and no code) are highlevel_<status>; a storage read that failed
// mid-attempt (dispatch_storage_*, schedule_source_*) keeps pointing at storage.
function failureCode(error) {
  const code = typeof error?.code === 'string' ? error.code : '';
  if (/^ghl_tag_[a-z_]+$/.test(code)) return code;
  if (/^[a-z]+_[a-z0-9_]+$/.test(code)) return 'ghl_tag_storage_unavailable';
  return Number.isInteger(error?.status) ? `highlevel_${error.status}` : 'highlevel_unreachable';
}

// Whether HighLevel was told an earlier time for this visit: the newest earlier schedule entry that was told, or, before
// the visit's first entry, an appointment it already had. A cancel, no-show or outcome in between starts afresh. null
// while an earlier schedule entry is being attempted right now (its claim is live): the answer is not settled yet.
async function earlierTimeTold(store, entry, at) {
  let row = entry;
  for (let hop = 0; hop < 5; hop++) {
    if (!ENTRY_ID.test(row.previousEntryId || '')) return row.previousTold !== false;
    row = await store.read(GHL_TAG_OUTBOX, row.previousEntryId);
    if (!row) return true;
    if (!SCHEDULE_KINDS.has(row.kind)) return false;
    if (row.status === 'done' && !row.skipped) return true;
    if (row.status === 'pending' && ms(row.claimedUntil) > at) return null;
  }
  return true;
}

async function settle(store, claimed, patch, outcome) {
  try { await store.commit([{ collection: GHL_TAG_OUTBOX, id: claimed.id, revision: claimed.revision, patch: { ...patch, claimId: '', claimedUntil: '' } }]); return outcome; }
  catch { return 'busy'; }
}

async function deliver(store, c, env, entry, now, claim, mirrored = false) {
  const at = Date.parse(now), attempts = count(entry.attempts), waits = count(entry.waits);
  if (attempts >= GHL_TAG_PARK_ATTEMPTS) return settle(store, entry, { status: 'parked', lastError: entry.lastError || 'ghl_tag_attempts_exhausted' }, 'parked');
  try { await store.commit([{ collection: GHL_TAG_OUTBOX, id: entry.id, revision: entry.revision, patch: { claimId: claim, claimedUntil: iso(at + GHL_TAG_CLAIM_MINUTES * 60000), attempts: attempts + 1, lastAttemptAt: now } }]); }
  catch { return 'busy'; }
  const claimed = await store.read(GHL_TAG_OUTBOX, entry.id).catch(() => null);
  if (claimed?.claimId !== claim) return 'busy';
  const steps = object(claimed.steps) ? { ...claimed.steps } : {};
  let contactId = typeof claimed.contactId === 'string' ? claimed.contactId : '';
  try {
    const job = await store.read('jobs', claimed.jobId);
    if (!job || !stillCurrent(claimed, job, at)) return settle(store, claimed, { status: 'done', doneAt: now, skipped: job ? 'superseded' : 'job_missing' }, 'skipped');
    if (!contactId) contactId = job.highlevelContactId || (safeId(job.customerId) ? (await store.read('customers', job.customerId))?.highlevelContactId : '') || '';
    // Waiting is not a failed attempt: the claim's count is given back and the next check follows the wait schedule.
    const wait = waitingFor => settle(store, claimed, { status: 'pending', attempts, waits: waits + 1, waitingFor, nextAttemptAt: iso(at + ghlTagWaitMinutes(waits + 1) * 60000), lastError: '', contactId, steps }, 'waiting');
    const close = skipped => settle(store, claimed, { status: 'done', doneAt: now, skipped, steps, waitingFor: '', lastError: '' }, 'skipped');
    // A visit the Hub never mirrors to HighLevel (dispatch's 'not_needed': no contact, no appointment) has nothing to
    // tell, as with the flag off; it is closed, not counted as stuck.
    if (!contactId && job.syncStatus === 'not_needed') return close('contact_not_linked');
    const expected = claimed.expect?.state;
    if (expected === 'active') {
      // A booking waits for its appointment write so HighLevel's booking and reminder workflows see the appointment before
      // the tag, as they do today. After the browser sync wrote it (handOffScheduleTags) only the link is checked.
      if (mirrored ? !job.highlevelAppointmentId : MIRRORING.has(String(job.syncStatus || ''))) return wait('appointment');
      // No HighLevel appointment and none coming (a 'not_needed' visit whose customer was linked later, a mirror that
      // answered without one): with the flag off these tags go only with an appointment, so nothing is told.
      if (!job.highlevelAppointmentId) return close('not_mirrored');
    }
    // A cancel or no-show for a booking HighLevel never heard of (no appointment, and no earlier time of the visit was
    // told) tells it nothing, so its workflow never tells a customer who got no confirmation that the visit was cancelled.
    if ((expected === 'cancelled' || expected === 'no_show') && !job.highlevelAppointmentId) {
      const told = await earlierTimeTold(store, claimed, at);
      if (told === null) return wait('earlier_change');
      if (!told) return close('never_told');
    }
    // A move before HighLevel ever heard the visit's time is its first booking, not a reschedule.
    let tags = Array.isArray(claimed.addTags) ? claimed.addTags : [];
    if (claimed.kind === 'rescheduled' && tags.includes(RESCHEDULED)) {
      const told = await earlierTimeTold(store, claimed, at);
      if (told === null) return wait('earlier_change');
      if (!told) tags = tags.filter(tag => tag !== RESCHEDULED);
    }
    if (!contactId) {
      // GHL-ALIGN: a messaging dry run (EGC_MESSAGING_DRY_RUN unless exactly "false") never creates a HighLevel contact.
      // Each attempt reads the links again, so a contact linked later (the browser sync, customer-resolve) is used.
      if (env.EGC_MESSAGING_DRY_RUN !== 'false') throw fail('ghl_tag_contact_not_linked', 'The visit has no linked HighLevel contact yet.', 409);
      contactId = await ensureContact(c, { name: job.customer || '', phone: job.phone || '', email: job.email || '', address: job.address || '' }, 'EGC Hub schedule');
      if (!contactId) throw fail('ghl_tag_contact_unresolved', 'HighLevel returned no contact.', 502);
    }
    if (claimed.note && !steps.note) { await addContactNote(c, contactId, { title: 'EGC walkthrough outcome', body: claimed.note, idempotencyKey: claimed.id }); steps.note = now; }
    if (claimed.appointmentStatus && !steps.appointment) {
      if (!job.highlevelAppointmentId) steps.appointment = 'not_linked';
      else if ((await completeAppointment(c, job.highlevelAppointmentId, claimed.appointmentStatus)).updated) steps.appointment = now;
      else throw fail('ghl_tag_appointment_update_failed', 'The HighLevel appointment status was not updated.', 502);
    }
    if (!steps.tags) { await addTags(c, contactId, tags); steps.tags = now; }
    return settle(store, claimed, { status: 'done', doneAt: now, contactId, steps, sentTags: tags, waitingFor: '', lastError: '' }, 'done');
  } catch (error) {
    const tries = attempts + 1, park = tries >= GHL_TAG_PARK_ATTEMPTS;
    return settle(store, claimed, { status: park ? 'parked' : 'pending', nextAttemptAt: iso(at + ghlTagBackoffMinutes(tries) * 60000), waitingFor: '', lastError: failureCode(error), contactId, steps }, park ? 'parked' : 'retrying');
  }
}

/** One drain pass: the named entries (a save's first attempt, a manager's retry) or the due queue, oldest first, at most
 * `limit`. Returns counts only. `now` is an ISO string; `fetcher` reaches HighLevel; `mirrored` names entries whose
 * appointment the caller has just written. */
export async function drainGhlTagOutbox(store, { env = {}, now = new Date().toISOString(), ids = null, limit = GHL_TAG_DRAIN_LIMIT, fetcher = fetch, claimId = () => crypto.randomUUID(), mirrored = [] } = {}) {
  const summary = { due: 0, attempted: 0, done: 0, waiting: 0, retrying: 0, parked: 0, skipped: 0, busy: 0, truncated: false };
  const c = highLevelConfig(env);
  if (!c.token || !c.locationId) return { ...summary, code: 'ghl_tag_highlevel_not_configured' };
  c.fetch = (url, init = {}) => fetcher(url, { ...init, signal: AbortSignal.timeout(15000) });
  let rows;
  if (Array.isArray(ids)) rows = (await Promise.all([...new Set(ids)].filter(id => ENTRY_ID.test(id)).map(id => store.read(GHL_TAG_OUTBOX, id)))).filter(Boolean);
  else { const due = await store.due(); rows = due.rows; summary.truncated = due.truncated === true; }
  const at = Date.parse(now), queue = rows.filter(entry => ghlTagDue(entry, at))
    .sort((a, b) => String(a.nextAttemptAt || '').localeCompare(String(b.nextAttemptAt || '')) || String(a.createdAt || '').localeCompare(String(b.createdAt || '')) || a.id.localeCompare(b.id));
  summary.due = queue.length;
  for (const entry of queue.slice(0, limit)) {
    const outcome = await deliver(store, c, env, entry, now, claimId(), mirrored.includes(entry.id));
    summary[outcome]++;
    if (outcome !== 'busy') summary.attempted++;
  }
  return summary;
}

/** The first attempt after a save, in the background (ctx.waitUntil), so the save's response never waits on
 * HighLevel. False when the flag is off or there is no waitUntil: the worker's next tick attempts it instead. */
export function firstGhlTagAttempt({ env, waitUntil } = {}, ids = [], now = new Date().toISOString(), storage = ghlTagOutboxStorage) {
  if (!ghlTagOutboxEnabled(env) || typeof waitUntil !== 'function' || !ids.length) return false;
  waitUntil(Promise.resolve().then(() => drainGhlTagOutbox(storage(env), { env, now, ids })).catch(() => null));
  return true;
}

/** A signed drain tick completed a pass: the stuck view's evidence that the worker runs. Best effort: a failed write
 * only makes the worker look stopped a little early. `now` is an ISO string. */
export async function recordGhlTagDrainCheckIn(store, now) {
  try {
    const beat = await store.read(GHL_TAG_DRAIN_STATE, GHL_TAG_DRAIN_STATE_ID);
    await store.commit([{ collection: GHL_TAG_DRAIN_STATE, id: GHL_TAG_DRAIN_STATE_ID, revision: beat?.revision, patch: { lastRunAt: now, workerId: 'ghl-tag-worker', updatedAt: now } }]);
    return true;
  } catch { return false; }
}

/** The worker's last check-in: stale when no signed tick completed a pass within GHL_TAG_DRAIN_STALE_MINUTES (or never,
 * or the check-in is future-dated). `at` is ms. */
export function ghlTagDrainView(beat, at) {
  const run = ms(beat?.lastRunAt), known = Number.isFinite(run);
  return { lastRunAt: known ? iso(run) : null, minutesSince: known ? Math.max(0, Math.floor((at - run) / 60000)) : null,
    stale: !known || run > at + 60000 || at - run >= GHL_TAG_DRAIN_STALE_MINUTES * 60000 };
}

// The job fields stillCurrent reads.
const CURRENT_JOB_FIELDS = ['type', 'status', 'pipelineStatus', 'date', 'time', 'endDate', 'endTime', 'walkthroughOutcome.requestId'];
async function jobsById(store, ids) {
  const found = new Map();
  if (typeof store.readMany === 'function') {
    for (let index = 0; index < ids.length; index += 100) for (const job of await store.readMany('jobs', ids.slice(index, index + 100), CURRENT_JOB_FIELDS)) found.set(job.id, job);
  } else (await Promise.all(ids.map(id => store.read('jobs', id)))).forEach((job, index) => { if (job) found.set(ids[index], job); });
  return found;
}

// Entries a person may need to act on: parked, or pending and overdue (the drain has not run them).
async function actionable(store, at) {
  const [parked, pending] = await Promise.all([store.parked(), store.due()]);
  return { rows: [...parked.rows.filter(row => row.status === 'parked'), ...pending.rows.filter(row => ghlTagOverdue(row, at))], truncated: parked.truncated === true || pending.truncated === true };
}

/** The Command center's 'HighLevel tags stuck for N visits': parked entries and pending ones the drain is overdue on,
 * counted by visit, and only while the entry is still what the visit shows (stillCurrent). An entry the visit has moved
 * past (cancelled and told since, moved, started) is closed as done without a request, at most
 * GHL_TAG_STUCK_CLOSE_LIMIT per view, and never counted. `drain` is the worker's check-in. `now` is an ISO string. */
export async function ghlTagStuck(store, now) {
  const at = Date.parse(now);
  const [{ rows, truncated }, beat] = await Promise.all([actionable(store, at), store.read(GHL_TAG_DRAIN_STATE, GHL_TAG_DRAIN_STATE_ID)]);
  const candidates = rows.filter(row => safeId(row.jobId)), jobs = await jobsById(store, [...new Set(candidates.map(row => row.jobId))]);
  const stuck = candidates.filter(row => jobs.has(row.jobId) && stillCurrent(row, jobs.get(row.jobId), at)), counted = new Set(stuck);
  for (const row of candidates.filter(row => !counted.has(row)).slice(0, GHL_TAG_STUCK_CLOSE_LIMIT)) {
    try { await store.commit([{ collection: GHL_TAG_OUTBOX, id: row.id, revision: row.revision, patch: { status: 'done', doneAt: now, skipped: jobs.has(row.jobId) ? 'superseded' : 'job_missing', waitingFor: '', claimId: '', claimedUntil: '' } }]); }
    catch { /* A drain or a Retry changed it first; it is not counted either way. */ }
  }
  const visits = [...new Set(stuck.map(row => row.jobId))];
  return { ok: true, enabled: true, visits: visits.length, entries: stuck.length, parked: stuck.filter(row => row.status === 'parked').length, overdue: stuck.filter(row => row.status === 'pending').length,
    jobIds: visits.slice(0, 50), drain: ghlTagDrainView(beat, at), asOf: now, coverage: { complete: !truncated, asOf: now } };
}

/** A manager's Retry: parked entries and pending ones the drain is overdue on (all, or one visit's) are due now with a
 * fresh budget of attempts; the caller gives them one attempt at once (waitUntil). */
export async function retryGhlTags(store, session, input, now, env) {
  if (!session) throw fail('ghl_tag_sign_in_required', 'Sign in to the Employee Hub to retry HighLevel tags.', 401);
  if (!canDispatch(session, env)) throw fail('ghl_tag_forbidden', 'Only an operations manager or owner can retry HighLevel tags.', 403);
  if (!object(input) || Object.keys(input).some(key => !['action', 'requestId', 'jobId'].includes(key)) || input.action !== 'retry' || !UUID.test(input.requestId || '') || (input.jobId !== undefined && !safeId(input.jobId))) throw fail('ghl_tag_request_invalid', 'Send retry with a unique request ID and, optionally, one visit.');
  const { rows } = await actionable(store, Date.parse(now)), ids = [];
  for (const row of rows.filter(row => !input.jobId || row.jobId === input.jobId).slice(0, 50)) {
    try {
      await store.commit([{ collection: GHL_TAG_OUTBOX, id: row.id, revision: row.revision, patch: { status: 'pending', attempts: 0, waits: 0, nextAttemptAt: now, lastError: '', claimId: '', claimedUntil: '', retriedAt: now, retriedBy: String(session.user || ''), retryRequestId: input.requestId.toLowerCase() } }]);
      ids.push(row.id);
    } catch (error) { if (error?.status !== 409) throw error; }
  }
  return { ok: true, requestId: input.requestId, requeued: ids.length, ids };
}

/** The dispatch card's view of an entry: never the tags, contact or error text beyond a code. With `at` (ms), overdue
 * says a pending entry is stuck; with the card's `job` too, current says whether a parked or pending schedule change is
 * still what the visit shows (false: it closes untold; null: the card cannot tell, as for an outcome). */
export function ghlTagStatusView(row, { at = NaN, job = null } = {}) {
  const status = GHL_TAG_STATUSES.includes(row?.status) ? row.status : 'pending', open = status !== 'done' && Number.isFinite(at);
  return { status, doneAt: status === 'done' && typeof row.doneAt === 'string' ? row.doneAt : null, skipped: status === 'done' && typeof row.skipped === 'string' ? row.skipped : null,
    attempts: Number.isSafeInteger(row?.attempts) ? row.attempts : 0, nextAttemptAt: status === 'pending' && typeof row.nextAttemptAt === 'string' ? row.nextAttemptAt : null,
    lastError: status === 'parked' && /^[a-z0-9_]{1,64}$/.test(row.lastError || '') ? row.lastError : null,
    overdue: status === 'pending' && open && ghlTagOverdue(row, at),
    current: open && object(job) && object(row.expect) && ['active', 'cancelled', 'no_show'].includes(row.expect.state) ? stillCurrent(row, job, at) : null };
}

/** Adds ghlTags {status, doneAt, ...} to projected dispatch jobs that point at an outbox entry. An unreadable
 * outbox marks them 'unknown' instead of failing the board. Flag off: the jobs come back unchanged. `now` (a Date or
 * ISO string) lets the view say whether a pending entry is overdue and a stuck one still current. `read`, when given
 * (Dispatch's reminder readiness, dispatch-readiness.js), also gets the entries read, with their addTags and
 * previousEntryId, as read.entries (by id), or read.unreadable = true, so a board reads each entry once. */
export async function withGhlTagStatus(store, jobs, now = null, read = null) {
  if (store.ghlTagOutbox !== true) return jobs;
  const ids = [...new Set(jobs.map(job => job?.ghlTagEntry?.id).filter(id => ENTRY_ID.test(id || '')))];
  if (!ids.length) return jobs;
  const at = now === null ? NaN : new Date(now).getTime();
  let rows;
  try { rows = typeof store.readMany === 'function' ? await store.readMany(GHL_TAG_OUTBOX, ids, ['status', 'doneAt', 'skipped', 'attempts', 'nextAttemptAt', 'lastError', 'claimedUntil', 'createdAt', 'expect', ...(read ? ['addTags', 'previousEntryId'] : [])]) : (await Promise.all(ids.map(id => store.read(GHL_TAG_OUTBOX, id)))).filter(Boolean); }
  catch { if (read) read.unreadable = true; return jobs.map(job => ENTRY_ID.test(job?.ghlTagEntry?.id || '') ? { ...job, ghlTags: { status: 'unknown' } } : job); }
  const byId = new Map(rows.map(row => [row.id, row]));
  if (read) read.entries = byId;
  return jobs.map(job => { const row = byId.get(job?.ghlTagEntry?.id); return row ? { ...job, ghlTags: ghlTagStatusView(row, { at, job }) } : ENTRY_ID.test(job?.ghlTagEntry?.id || '') ? { ...job, ghlTags: { status: 'unknown' } } : job; });
}

function decodeRow(document) {
  const prefix = `${ROOT}/${GHL_TAG_OUTBOX}/`, name = document?.name;
  const id = typeof name === 'string' && name.startsWith(prefix) ? name.slice(prefix.length) : '';
  if (!ENTRY_ID.test(id) || typeof document.updateTime !== 'string' || !document.updateTime || document.fields !== undefined && !object(document.fields)) throw fail('ghl_tag_storage_incomplete', 'The HighLevel tag outbox returned an unreadable entry.', 503);
  return { ...decodeFirestoreFields(document.fields || {}), id, revision: document.updateTime };
}

/** Production store: dispatch storage reads and commits, plus the pending and parked queues (a single-field
 * status query). An unreadable or malformed answer is never an empty queue. */
export function ghlTagOutboxStorage(env, fetcher = firestoreFetch) {
  const dispatch = dispatchStorage(env, fetcher);
  async function byStatus(status) {
    const query = { structuredQuery: { from: [{ collectionId: GHL_TAG_OUTBOX }], where: { fieldFilter: { field: { fieldPath: 'status' }, op: 'EQUAL', value: { stringValue: status } } }, limit: GHL_TAG_SCAN_LIMIT + 1 } };
    let response, rows;
    try { response = await fetcher(env, `${BASE}:runQuery`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(query), signal: AbortSignal.timeout(15000) }); }
    catch { throw fail('ghl_tag_storage_unavailable', 'The HighLevel tag outbox could not be read.', 503); }
    if (!response.ok) throw fail('ghl_tag_storage_unavailable', 'The HighLevel tag outbox could not be read.', 503);
    try { rows = await response.json(); } catch { throw fail('ghl_tag_storage_incomplete', 'The HighLevel tag outbox returned an unreadable answer.', 503); }
    if (!Array.isArray(rows) || rows.some(row => !object(row))) throw fail('ghl_tag_storage_incomplete', 'The HighLevel tag outbox returned an unreadable answer.', 503);
    const documents = rows.filter(row => row.document).map(row => decodeRow(row.document)).filter(row => row.status === status);
    return { rows: documents.slice(0, GHL_TAG_SCAN_LIMIT), truncated: documents.length > GHL_TAG_SCAN_LIMIT };
  }
  return { read: (collection, id) => dispatch.read(collection, id), readMany: (collection, ids, fields) => dispatch.readMany(collection, ids, fields), commit: writes => dispatch.commit(writes), due: () => byStatus('pending'), parked: () => byStatus('parked') };
}
