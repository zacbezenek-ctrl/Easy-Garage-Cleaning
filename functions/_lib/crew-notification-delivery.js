/* Delivery side of crew schedule notices. The messaging cron drains pending
   crewNotifications rows through the approved-send core (crew_assignment,
   crew_unassignment or crew_schedule_change: owner-approved wording, the
   owner's automation switch, quiet hours and the claim-once message_sends
   ledger keyed by the notice), to the employee's own phone from their
   approved encrypted account, only after the employee opted in and only
   through the HighLevel staff contact a dispatcher linked for them (never an
   upserted one). Per job and employee one text goes out for everything that
   changed since what the employee last heard (the crewNoticeHeard record,
   kept in the same commits that close notices, so a change never texted is
   still said next time): it rides on the newest notice, which stands for the
   older untexted ones (closed as superseded with it), and names every day
   taken away as well as the new or changed work. A
   notice is re-checked against the live job, and against newer notices,
   right before its ledger claim. Employees read and acknowledge only their
   own notices through /api/crew-notifications; dispatchers see who can be
   texted, link staff contacts and retry notices that were not texted. */
import { firestoreFetch } from './firebase-service-account.js';
import { decodeFirestoreFields, encodeFirestoreValue } from './firestore-job.js';
import { dispatchStorage } from './dispatch-storage.js';
import { assignmentKey } from './job-assignment.js';
import { denverToday } from './dispatch-time.js';
import { employeeInvitationStore } from './employee-accounts.js';
import { getHubUserProfile } from './hub-session.js';
import { maskRecipient, normalizePhone } from './ghl-messenger.js';
import { MESSAGE_SENDS, ledgerId } from './message-send-store.js';
import { can } from './staff-roles.js';
import { CREW_NOTICE_HEARD, CREW_NOTICE_INTENTS, CREW_NOTIFICATION_PREFS, CREW_NOTIFICATIONS, CREW_SEND_KINDS, REMOVAL_INTENTS, changeKind, crewHeardId, crewNoticeSendKey, crewNotificationsEnabled, employeeSlots, lostSlots, noticeKindValid, sameSlots, scheduleChange, slotUpcoming, validSlot } from './crew-notifications.js';

export const CREW_HUB_LINK = 'https://easygaragecleaning.com/employee.html?view=crew_alerts';
export const MAX_ATTEMPTS = 5;
export const FEED_LIMIT = 100;
export const ATTENTION_LIMIT = 100;
export const TEAM_LIMIT = 60;
const QUERY_LIMIT = 200;
const BACKOFF_MS = 5 * 60000;
const BACKOFF_CAP_MS = 6 * 3600000;
const HISTORY_LIMIT = 20;
const ACK_LIMIT = 50;
const ROOT = 'projects/egcw-1ec83/databases/(default)/documents';
const NOTICE_ID = /^crew_[a-f0-9]{40}$/;
const CONTACT_ID = /^[A-Za-z0-9_-]{1,120}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
// Scheduler outcomes that close a notice. Anything else is retried with backoff.
// A notice a newer one replaced (reason newer_notice) is closed as superseded.
const CLOSED = Object.freeze({ submitted: 'sent', already_sent: 'sent', dry_run: 'dry_run', uncertain: 'uncertain', needs_contact: 'needs_contact', suppressed: 'suppressed', contact_mismatch: 'suppressed', not_eligible: 'stale', attempts_exhausted: 'failed' });
// Not the notice's fault (quiet hours, wording not switched on yet): wait
// without spending one of its attempts.
const WAITING = new Set(['deferred', 'not_ready']);
// Refusals that only mean "not yet": a newer notice for the same job and
// employee is still queued (the next tick sends one text for both), the
// crew roster could not be read to match a legacy display-name crew, or
// another tick changed a visit a grouped text was about to name.
const WAITING_REASONS = new Set(['newer_notice_pending', 'roster_unavailable', 'batch_changed']);
// Refusals the same notice would meet again on every retry: the approved
// wording leaves no room to name every change in one text. The notice fails
// at once, onto the dispatcher's list (Send again after the wording is shortened).
const FAILED_REASONS = new Set(['messaging_sms_too_long']);
// Closed notices the employee heard: texted, maybe texted, or read in the Hub.
const TEXTED = new Set(['sent', 'uncertain']);
// Closed without a text in a way a dispatcher can act on. attentionUntil (the
// slot's last day) keeps the row in their list until the work has passed.
const ATTENTION = new Set(['needs_contact', 'not_opted_in', 'failed', 'suppressed', 'uncertain']);
// A dispatcher may send these again once the cause is fixed; an unconfirmed
// text never is, and a send the ledger already refused three times cannot be.
const RETRYABLE = new Set(['needs_contact', 'not_opted_in', 'suppressed', 'failed']);
// A ledger claim in these states may have reached the employee.
const TOLD = new Set(['submitted', 'uncertain', 'sending']);
// A 'sending' claim this recent may still come back refused: HighLevel
// answers or times out within 15 s and the outcome is saved right after. Until
// then the text is in flight, even when its notice's row already closed.
const CLAIM_SETTLE_MS = 5 * 60000;
const UNREAD = Symbol('roster_unread');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const safeId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,180}$/.test(value) && !/^(secure_|_egc_)/.test(value);
const safeCode = value => /^[a-z][a-z0-9_]{0,63}$/.test(String(value || '')) ? String(value) : '';
const fail = (code, message, status = 400, details) => Object.assign(new Error(message), { code: `crew_notifications_${code}`, status, ...(details ? { details } : {}) });
const conflict = error => /_revision_conflict$/.test(String(error?.code || ''));
const byCreated = (a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')) || a.id.localeCompare(b.id);
// Saves in the order dispatch made them; one save queues at most one notice
// per employee. The job revision each save was made against (a Firestore
// update time; '' for the create) orders them without trusting worker clocks,
// then the save time and request id.
const REVISION_TIME = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?Z$/;
function revisionRank(row) {
  if (row?.baseRevision === '') return '0';
  const match = typeof row?.baseRevision === 'string' ? REVISION_TIME.exec(row.baseRevision) : null;
  return match ? `1${match[1]}.${(match[2] || '').padEnd(9, '0')}` : null;
}
function compareSaves(a, b) {
  const left = revisionRank(a), right = revisionRank(b);
  if (left !== null && right !== null && left !== right) return left < right ? -1 : 1;
  return String(a.createdAt || '').localeCompare(String(b.createdAt || '')) || String(a.dispatchRequestId || '').localeCompare(String(b.dispatchRequestId || ''));
}
const bySave = (a, b) => compareSaves(a, b) || a.id.localeCompare(b.id);
const newerSave = (row, than) => compareSaves(row, than) > 0;
// The queued visits a crew text named, from its message_sends entry: the
// claim records them with the text (noticeBatch; none for a text sent on its
// own), so a visit is only ever closed into a text that named it. An entry
// that records none (or is not there) names no visit.
const namedVisits = send => Array.isArray(send?.noticeBatch) ? send.noticeBatch.filter(id => typeof id === 'string' && NOTICE_ID.test(id)) : [];
const slotList = value => Array.isArray(value) && value.every(validSlot) ? value : null;
// What the employee had heard before a notice: the baseline stored when the
// notice stood for older untexted ones, else the schedule before its own save.
const baseline = row => slotList(row.heardSlots) || slotList(row.previousSlots) || [];
// The work a notice's change reaches at `at`: its own slot, and every new,
// changed or lost slot still ahead of what its text says.
function changeSlots(row, at) {
  if (!validSlot(row?.slot)) return [];
  const { added, lost } = scheduleChange(baseline(row), slotList(row.slots) || [], at);
  return [row.slot, ...added, ...lost];
}
// A later day of the same change can still be ahead once its first has
// passed: a notice closed without a text stays on a dispatcher's list until
// its last day (attentionUntil), and can be sent again while any is ahead.
const slotEnd = (row, at) => changeSlots(row, at).map(slot => slot.endDate).sort().at(-1) || '';
const changeAhead = (row, at) => changeSlots(row, at).some(slot => slotUpcoming(slot, at));
// The crewNoticeHeard record: the newest notice texted to the employee (its
// save's order fields) and its slots, or, before any, the schedule they had
// before their first notice. Every notice saved at or before that one was
// covered by its text (or by the notice they read in the Hub: heardVia
// 'hub'). heardFull is false when what the record holds was worked out from
// an incomplete notice history, so older notices are never shown as covered.
const rankOf = row => ({ id: String(row.id || ''), baseRevision: typeof row.baseRevision === 'string' ? row.baseRevision : null, createdAt: String(row.createdAt || ''), dispatchRequestId: String(row.dispatchRequestId || '') });
const validRank = rank => object(rank) && typeof rank.id === 'string' && Boolean(rank.id);
const heardRank = record => validRank(record?.heardRank) ? record.heardRank : null;
const VIAS = new Set(['text', 'hub']);
const COVERAGE_LIMIT = 20;
// How each stretch of a job's notices reached the employee, oldest first:
// after each run of events of one kind (texts, or notices read in the Hub)
// the newest notice that run covered. A record from before it was kept
// starts from its newest event alone.
function coverageOf(record) {
  if (Array.isArray(record?.coverage)) return record.coverage.filter(entry => object(entry) && VIAS.has(entry.via) && validRank(entry.rank));
  const rank = heardRank(record);
  return rank ? [{ rank, via: record.heardVia === 'hub' ? 'hub' : 'text' }] : [];
}
// The coverage after these events, in order ({row, via}); an event at or
// before what is already recorded changes nothing.
function coverageAfter(record, events) {
  let list = coverageOf(record);
  for (const { row, via } of events) {
    const last = list.at(-1), entry = { rank: rankOf(row), via: via === 'hub' ? 'hub' : 'text' };
    if (last && bySave(row, last.rank) <= 0) continue;
    list = last?.via === entry.via ? [...list.slice(0, -1), entry] : [...list, entry];
  }
  return list.slice(-COVERAGE_LIMIT);
}
// Saved at or before the newest notice the employee heard: the drain never
// sends it again, whatever the record was built from.
const coveredBy = (row, record) => { const rank = heardRank(record); return Boolean(rank) && bySave(row, rank) <= 0; };
/** How an employee heard a closed notice's change without its own text, for
 * the Hub: by the first event that covered it, 'text' when a later text said
 * it, 'hub' when they read a later notice in the Hub (which a text after that
 * does not change), else ''. Only a record built from everything they had
 * heard (heardFull) vouches for older notices. */
function toldVia(row, record) {
  const rank = heardRank(record);
  if (!rank || bySave(row, rank) > 0 || (row.id !== rank.id && record.heardFull === false)) return '';
  const first = coverageOf(record).find(entry => bySave(row, entry.rank) <= 0);
  return first ? first.via : record.heardVia === 'hub' ? 'hub' : 'text';
}
/** The crewNoticeHeard write that goes in the same commit as closing a
 * notice, or null. A text (or a maybe-text, or a Hub acknowledgement: `via`)
 * moves the record to that notice's slots unless a newer one is already
 * recorded; a close without one only starts the record, with what the
 * employee had heard before it, because what they heard did not change.
 * `full` says whether that baseline came from everything they had heard;
 * `prior` lists older notices heard in the same commit ({row, via}). */
function heardWrite(id, record, row, slots, texted, iso, { via = 'text', full = true, prior = [] } = {}) {
  if (texted) { const rank = heardRank(record); if (rank && bySave(row, rank) <= 0) return null; }
  else if (record) return null;
  const how = via === 'hub' ? 'hub' : 'text';
  return { collection: CREW_NOTICE_HEARD, id, ...(record ? { revision: record.revision } : {}),
    patch: { jobId: row.jobId, employeeId: row.employeeId, slots, heardNoticeId: texted ? row.id : '', heardRank: texted ? rankOf(row) : null, heardVia: texted ? how : '', heardFull: full !== false,
      coverage: texted ? coverageAfter(record, [...prior, { row, via: how }]) : [], updatedAt: iso } };
}
// A closed notice the employee heard: texted, maybe texted, read in the Hub,
// or one visit of a grouped text that went out (or may have).
const heardClose = row => TEXTED.has(row.status) || row.status === 'skipped' || (row.status === 'batched' && ['batched', 'uncertain'].includes(row.lastStatus));
// What an employee last heard about a job, from its notices alone (before a
// heard record existed): the newest one they heard, else the schedule before
// their first notice. `full` is false when the history was cut off.
function heardFromHistory(rows, full = true) {
  const sorted = [...rows].sort(bySave), told = sorted.filter(heardClose).at(-1);
  return told ? { slots: slotList(told.slots) || [], row: told, full } : { slots: slotList(sorted[0]?.previousSlots) || [], row: null, full };
}
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : object(value) ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value);
const digest = async value => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical(value))))].map(byte => byte.toString(16).padStart(2, '0')).join('');
const readRows = async (store, collection, ids) => {
  const rows = typeof store.readMany === 'function' ? await store.readMany(collection, ids) : await Promise.all(ids.map(id => store.read(collection, id)));
  return new Map(rows.filter(Boolean).map(row => [row.id, row]));
};

// A queued row is only acted on when every field the send path relies on is intact.
export function wellFormedNotice(row) {
  return object(row) && NOTICE_ID.test(row.id || '') && safeId(row.jobId) && typeof row.employeeId === 'string' && row.employeeId === assignmentKey(row.employeeId) && Boolean(row.employeeId)
    && CREW_NOTICE_INTENTS.includes(row.intent) && noticeKindValid(row.intent, row.messageKind) && validSlot(row.slot);
}

/** The approved-send key a notice's text is (or would be) recorded under,
 * whichever crew wording it goes out with. */
export const noticeSendKey = row => crewNoticeSendKey({ jobId: row.jobId, employeeId: row.employeeId, id: row.id });

function storageError(error) {
  const code = String(error?.code || '');
  if (code === 'dispatch_revision_conflict') return fail('revision_conflict', 'This notice changed at the same time. Refresh and try again.', 409);
  if (code === 'dispatch_outcome_unknown') return fail('outcome_unknown', 'The save could not be confirmed. Retry the same request.', 503);
  if (code.startsWith('crew_notifications_')) return error;
  return fail('storage_unavailable', 'Schedule notices could not be loaded. Retry.', 503);
}

/** Firestore access for notices: dispatch's revisioned read/commit, the
 * roster, equality-filter queries and the attention range (single-field
 * indexes only). */
export function crewNotificationStorage(env, fetcher = firestoreFetch) {
  const base = dispatchStorage(env, fetcher);
  const wrap = method => async (...args) => { try { return await method(...args); } catch (error) { throw storageError(error); } };
  async function run(structuredQuery, collection) {
    let response;
    try {
      response = await fetcher(env, `https://firestore.googleapis.com/v1/${ROOT}:runQuery`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(20000),
        body: JSON.stringify({ structuredQuery: { from: [{ collectionId: collection }], ...structuredQuery } }) });
    } catch { throw fail('storage_unavailable', 'Schedule notices could not be loaded. Retry.', 503); }
    if (!response.ok) throw fail('storage_unavailable', 'Schedule notices could not be loaded. Retry.', 503);
    const rows = await response.json().catch(() => null);
    if (!Array.isArray(rows)) throw fail('storage_incomplete', 'Schedule notices were incomplete. Retry.', 503);
    const prefix = `/documents/${collection}/`, found = [];
    for (const row of rows) {
      if (!object(row) || row.error) throw fail('storage_incomplete', 'Schedule notices were incomplete. Retry.', 503);
      if (row.document === undefined) continue;
      const name = String(row.document?.name || ''), id = name.includes(prefix) ? name.slice(name.indexOf(prefix) + prefix.length) : '';
      if (!id || id.includes('/') || typeof row.document.updateTime !== 'string' || !row.document.updateTime) throw fail('storage_incomplete', 'Schedule notices were incomplete. Retry.', 503);
      found.push({ ...decodeFirestoreFields(row.document.fields || {}), id, revision: row.document.updateTime });
    }
    return found;
  }
  function query(filters, limit = QUERY_LIMIT, collection = CREW_NOTIFICATIONS) {
    const fieldFilters = filters.map(([field, value]) => ({ fieldFilter: { field: { fieldPath: field }, op: 'EQUAL', value: encodeFirestoreValue(value) } }));
    return run({ where: fieldFilters.length === 1 ? fieldFilters[0] : { compositeFilter: { op: 'AND', filters: fieldFilters } }, limit }, collection);
  }
  // Notices a dispatcher should see: closed without a text, for work that has not passed.
  const attention = (today, limit = ATTENTION_LIMIT + 1) => run({ where: { fieldFilter: { field: { fieldPath: 'attentionUntil' }, op: 'GREATER_THAN_OR_EQUAL', value: { stringValue: today } } },
    orderBy: [{ field: { fieldPath: 'attentionUntil' }, direction: 'ASCENDING' }], limit }, CREW_NOTIFICATIONS);
  return { read: wrap(base.read), commit: wrap(base.commit), readMany: wrap(base.readMany), roster: wrap(base.roster), query, attention };
}

/** The notice row after one scheduler outcome, or null to leave it untouched.
 * Retries back off 5, 10, 20, 40 minutes (capped at 6 hours) from `at`. */
export function noticeTransition(row, outcome, at) {
  const status = safeCode(outcome?.status), reason = safeCode(outcome?.reason), previous = Number(row?.attempts) || 0;
  if (!status || status === 'not_attempted') return null;
  const later = ms => new Date(Date.parse(at) + ms).toISOString();
  // A newer notice for the same job and employee is still queued (the next
  // tick sends one text for both), or the roster needed to match a legacy
  // crew could not be read: this one waits without an attempt.
  if (WAITING.has(status) || (status === 'not_eligible' && WAITING_REASONS.has(reason))) return { attempts: previous, lastStatus: status, lastReason: reason, updatedAt: at, status: 'pending', nextAttemptAt: later(BACKOFF_MS) };
  const attempts = previous + 1, base = { attempts, lastStatus: status, lastReason: reason, updatedAt: at };
  const attention = closed => ({ attentionUntil: ATTENTION.has(closed) ? slotEnd(row, at) : '' });
  // No approved account (or it was deactivated) is a contact problem, not a retry.
  const closed = reason === 'crew_contact_unavailable' ? 'needs_contact' : reason === 'newer_notice' ? 'superseded' : FAILED_REASONS.has(reason) ? 'failed' : CLOSED[status];
  if (closed) return { ...base, status: closed, nextAttemptAt: '', ...attention(closed), ...(closed === 'sent' ? { deliveredAt: at } : {}) };
  // Another tick holds the ledger claim ('sending'): its own result closes the
  // row; a claim that never finishes is reported as unconfirmed, never resent.
  if (attempts >= MAX_ATTEMPTS) { const final = status === 'sending' ? 'uncertain' : 'failed'; return { ...base, status: final, nextAttemptAt: '', ...attention(final) }; }
  return { ...base, status: 'pending', nextAttemptAt: later(Math.min(BACKOFF_CAP_MS, BACKOFF_MS * 2 ** (attempts - 1))) };
}

/** The scheduler's crew outbox: pending(limit, {kinds, dryRun}) returns
 * deliverable entries and (except in a dry run) closes the rest in one commit;
 * complete(entry, outcome) records the send result on the row with its
 * revision and, in that same commit, closes the other visits a grouped
 * recurring-run text named, then the older notices the text stood for. The
 * visits a grouped text names are stamped with it (batchLead) before it is
 * sent and recorded on its ledger claim (noticeBatch), so a close that never
 * landed is repaired from that ledger on a later tick instead of texting them
 * again, and a visit it did not name is never closed into it. `plans` is shared
 * with crewNoticeProvider for one tick: what each entry's text says. `query`
 * and `readMany` are charged by the caller; store reads and commits are
 * metered by the store. */
export function createCrewOutbox({ store, query, readMany = null, now, plans = new Map() }) {
  const at = now instanceof Date ? now : new Date(now), iso = at.toISOString();
  const close = (row, status, reason, extra = {}) => ({ collection: CREW_NOTIFICATIONS, id: row.id, revision: row.revision,
    patch: { status, lastStatus: status, lastReason: reason, nextAttemptAt: '', attentionUntil: ATTENTION.has(status) ? slotEnd(row, at) : '', updatedAt: iso, ...extra } });
  // A notice whose own text was sent (or may have been) closes with it.
  const closeTold = (row, ledger) => close(row, ledger === 'submitted' ? 'sent' : 'uncertain', 'send_recorded', { lastStatus: ledger, attentionUntil: '', ...(ledger === 'submitted' ? { deliveredAt: iso } : {}) });
  // One visit a grouped text named, closed with that text: into a text that
  // went out ('batched'), or may have ('uncertain', which stays on the
  // dispatcher's list like the text itself).
  const closeGrouped = (row, leadId, told) => close(row, 'batched', 'grouped_text', { batchedInto: leadId, lastStatus: told === 'uncertain' ? 'uncertain' : 'batched', attentionUntil: told === 'uncertain' ? slotEnd(row, at) : '' });
  const read = (collection, ids) => typeof readMany === 'function' ? readMany(collection, ids) : Promise.all(ids.map(id => store.read(collection, id)));
  const byId = rows => new Map(rows.filter(Boolean).map(row => [row.id, row]));
  async function preferences(ids) {
    if (!ids.length) return new Map();
    return byId(await read(CREW_NOTIFICATION_PREFS, ids));
  }
  // Send ledger by notice id (one batch read): its status, the queued visits
  // the text it holds named (a grouped recurring-run text), and whether a
  // 'sending' claim is recent enough that its outcome may still be saved.
  async function ledgers(rows) {
    if (!rows.length) return new Map();
    const keys = await Promise.all(rows.map(async row => [row.id, await ledgerId(noticeSendKey(row))]));
    const sends = byId(await read(MESSAGE_SENDS, [...new Set(keys.map(([, id]) => id))]));
    return new Map(keys.map(([id, key]) => {
      const send = sends.get(key), status = String(send?.status || '');
      return [id, { status, named: namedVisits(send), inFlight: status === 'sending' && Date.parse(send.attemptedAt || '') > at.getTime() - CLAIM_SETTLE_MS }];
    }));
  }
  // The visits the lead's text that went out (or may have) named, from its
  // ledger; none while it cannot be read, so they are closed on a later tick.
  async function namedBy(entry) {
    try { return namedVisits(await store.read(MESSAGE_SENDS, await ledgerId(noticeSendKey({ jobId: entry.jobId, employeeId: entry.crewId, id: entry.id })))); }
    catch { return []; }
  }
  // Older notices a closed text stood for; one that changed meanwhile is re-read once.
  async function settle(covers) {
    if (!covers.length) return;
    const patch = { status: 'superseded', lastStatus: 'superseded', lastReason: 'newer_notice', nextAttemptAt: '', attentionUntil: '', updatedAt: iso };
    const writes = rows => rows.map(row => ({ collection: CREW_NOTIFICATIONS, id: row.id, revision: row.revision, patch }));
    try { await store.commit(writes(covers)); return; } catch { /* Re-read below. */ }
    const fresh = (await read(CREW_NOTIFICATIONS, covers.map(row => row.id)).catch(() => [])).filter(row => row?.status === 'pending');
    if (fresh.length) await store.commit(writes(fresh)).catch(() => null);
  }
  // The other visits of a grouped text, closed in the same commit as the text:
  // with a text that went out (or may have), which is what the employee heard
  // about them, but only the ones its ledger says it named (`named`); held
  // with it on the dispatcher's list when it could not go out, until Send
  // again groups them again; with a dry run. Any other close (the lead visit
  // changed, was taken away or no longer matches, or HighLevel refused it for
  // good) leaves them queued, to be grouped again.
  function siblingCloses(leadId, siblings, done, named = []) {
    const texted = TEXTED.has(done.status), held = RETRYABLE.has(done.status) && done.lastStatus !== 'attempts_exhausted';
    if (!texted && !held && done.status !== 'dry_run') return [];
    return siblings.filter(item => item.row?.status === 'pending' && item.row.batchLead === leadId && (!texted || named.includes(item.row.id))).flatMap(item => {
      const told = texted ? (done.status === 'uncertain' ? 'uncertain' : 'submitted') : '';
      const write = texted ? closeGrouped(item.row, leadId, told) : { collection: CREW_NOTIFICATIONS, id: item.row.id, revision: item.row.revision,
        patch: { status: 'batched', batchedInto: leadId, lastStatus: done.status, lastReason: done.lastReason || '', nextAttemptAt: '', attentionUntil: held ? slotEnd(item.row, at) : '', updatedAt: iso } };
      const heard = heardWrite(item.heardId, item.record, item.row, texted ? slotList(item.row.slots) || [] : item.heard || baseline(item.row), texted, iso, { full: item.full });
      return [write, ...(heard ? [heard] : [])];
    });
  }
  // The visits of a grouped text as they are now, for a commit that retries.
  async function refresh(leadId, siblings) {
    if (!siblings.length) return siblings;
    const rows = byId(await read(CREW_NOTIFICATIONS, siblings.map(item => item.row.id))), records = byId(await read(CREW_NOTICE_HEARD, siblings.map(item => item.heardId)));
    return siblings.map(item => ({ ...item, row: rows.get(item.row.id) || null, record: records.get(item.heardId) || null })).filter(item => item.row?.status === 'pending' && item.row.batchLead === leadId);
  }
  // Visits an earlier version grouped before its text went out, freed when
  // that text is closed without being sent.
  async function reopen(id) {
    const rows = (await query([['batchedInto', id]], QUERY_LIMIT).catch(() => [])).filter(row => row?.batchedInto === id && row.status === 'batched' && !['batched', 'uncertain'].includes(row.lastStatus));
    if (rows.length) await store.commit(rows.map(row => ({ collection: CREW_NOTIFICATIONS, id: row.id, revision: row.revision, patch: { status: 'pending', batchedInto: '', lastStatus: 'batch_reopened', lastReason: '', nextAttemptAt: '', attentionUntil: '', updatedAt: iso } }))).catch(() => null);
  }
  return {
    async pending(limit = 50, { kinds = CREW_SEND_KINDS, dryRun = false } = {}) {
      const rows = (await query([['status', 'pending']], QUERY_LIMIT)).filter(row => row.status === 'pending');
      const loose = [], groups = new Map(), ready = [];
      for (const row of rows) {
        if (!wellFormedNotice(row)) { loose.push(close(row, 'stale', 'notice_invalid')); continue; }
        const key = `${row.jobId}\n${row.employeeId}`;
        if (!groups.has(key)) groups.set(key, { rows: [], writes: [], told: null, events: [], closed: false, heard: null });
        groups.get(key).rows.push(row);
      }
      const states = [...groups.values()];
      for (const state of states) { state.rows.sort(bySave); state.heardId = await crewHeardId(state.rows[0].jobId, state.rows[0].employeeId); }
      // One batch read: what each employee last heard about each job.
      const records = states.length ? byId(await read(CREW_NOTICE_HEARD, states.map(state => state.heardId))) : new Map();
      for (const state of states) {
        state.record = records.get(state.heardId) || null;
        state.open = state.rows.filter(row => !coveredBy(row, state.record));
        state.covered = state.rows.filter(row => coveredBy(row, state.record));
        state.full = state.record ? state.record.heardFull !== false : true;
      }
      // Notices from before heard records were kept: without a record, what
      // the employee heard comes from the job's notice history (one query per
      // such job and employee; while it cannot be read, that job and employee
      // wait). A notice saved with the job's creation has no history before it.
      for (const state of states.filter(state => !state.record && state.rows[0].baseRevision !== '')) {
        const [first] = state.rows, found = await Promise.resolve().then(() => query([['jobId', first.jobId], ['employeeId', first.employeeId]], QUERY_LIMIT)).catch(() => null);
        if (!Array.isArray(found)) { state.unread = true; continue; }
        const history = found.filter(row => row?.jobId === first.jobId && row.employeeId === first.employeeId && wellFormedNotice(row));
        state.known = heardFromHistory([...history, ...state.rows.filter(row => !history.some(other => other.id === row.id))], found.length < QUERY_LIMIT);
        state.full = state.known.full;
      }
      // Visits stamped with a grouped text (batchLead): that text's own row.
      const pendingById = new Map(states.flatMap(state => state.rows).map(row => [row.id, row])), stamped = states.flatMap(state => state.open.filter(row => row.batchLead && row.batchLead !== row.id));
      const leadIds = [...new Set(stamped.map(row => row.batchLead))], leads = new Map(leadIds.filter(id => pendingById.has(id)).map(id => [id, pendingById.get(id)]));
      const unread = leadIds.filter(id => !leads.has(id) && NOTICE_ID.test(id));
      if (unread.length) for (const row of await read(CREW_NOTIFICATIONS, unread)) if (row && wellFormedNotice(row)) leads.set(row.id, row);
      // One batch read of the send ledgers that say whether a text may already
      // have gone out: older queued notices, the notice the record names (its
      // close may have been lost), stamped visits and their texts, and every
      // visit that could join a grouped text.
      const checked = new Map();
      for (const state of states) {
        for (const row of [...state.open.slice(0, -1), ...state.covered.filter(row => row.id === heardRank(state.record)?.id)]) checked.set(row.id, row);
        const latest = state.open.at(-1);
        if (latest?.intent === 'assigned' && latest.batchKey) checked.set(latest.id, latest);
      }
      for (const row of [...stamped, ...leads.values()]) checked.set(row.id, row);
      const sends = await ledgers([...checked.values()]);
      // A ledger entry decides (a claim another tick left 'failed' was never
      // texted, whatever the row's last outcome says); without one, a row
      // whose last attempt found a claim in flight may have been.
      const toldOf = row => { const status = sends.get(row.id)?.status || ''; return TOLD.has(status) ? status : !status && row.lastStatus === 'sending' ? 'sending' : ''; };
      // Whether the grouped text a visit was stamped with named it and went out
      // ('submitted' or 'uncertain'), is being sent ('sending'), or neither
      // (''). Only a visit its ledger records as named counts; a stamp alone
      // never does. A claim that never finished is in flight while the text's
      // own notice is queued, or for a few minutes after that closed (its
      // outcome, a refusal included, may still be saved); after that the text
      // may have gone out ('uncertain'), or did ('submitted') when its row
      // recorded the send. A visit with a text of its own is never counted
      // into another one.
      const groupedOf = row => {
        if (!row.batchLead || row.batchLead === row.id || toldOf(row)) return '';
        const lead = leads.get(row.batchLead);
        if (!lead) return '';
        const { status = '', named = [], inFlight = false } = sends.get(lead.id) || {};
        if (!named.includes(row.id)) return '';
        if (status === 'submitted' || status === 'uncertain') return status;
        if (status !== 'sending') return '';
        if (lead.status === 'sent') return 'submitted';
        return lead.status === 'pending' || inFlight ? 'sending' : 'uncertain';
      };
      for (const state of states) {
        // Saved at or before the newest notice texted to them: that text covered it.
        for (const row of state.covered) {
          const ledger = row.id === heardRank(state.record).id ? toldOf(row) : '';
          state.writes.push(ledger ? closeTold(row, ledger) : close(row, 'superseded', 'newer_notice'));
          state.closed = true;
        }
      }
      for (const state of states) {
        const group = state.open;
        if (!group.length || state.unread) continue;
        const latest = group.at(-1), covers = [];
        // What the employee last heard: the heard record (kept since their
        // first notice closed), else the job's notice history, else the
        // schedule before the oldest queued change; then the newest queued one
        // that may already have been texted, on its own or in a grouped text.
        let heard = (state.record && slotList(state.record.slots)) || state.known?.slots || baseline(group[0]), waiting = null;
        const heardOf = (row, slots, via) => { state.told = { row, slots, via }; state.events.push({ row, via }); state.closed = true; };
        for (const row of group.slice(0, -1)) {
          const ledger = toldOf(row), grouped = groupedOf(row);
          // Named by a grouped text still being sent, or its own text was
          // claimed moments ago: wait for that outcome.
          if (grouped === 'sending' || (ledger === 'sending' && sends.get(row.id)?.inFlight)) { waiting = row; break; }
          if (!ledger && !grouped) { covers.push(row); continue; }
          heard = slotList(row.slots) || [];
          for (const older of covers.splice(0)) state.writes.push(close(older, 'superseded', 'newer_notice'));
          state.writes.push(ledger ? closeTold(row, ledger) : closeGrouped(row, row.batchLead, grouped));
          heardOf(row, heard, 'text');
        }
        state.heard = heard;
        const final = slotList(latest.slots) || [];
        // The newest notice stands for the older untexted ones: its text says
        // everything since `heard`, which it keeps once it closes.
        const heardSlots = sameSlots(heard, baseline(latest)) ? null : heard, keep = heardSlots ? { heardSlots } : {};
        const closeAll = (status, reason) => {
          state.writes.push(close(latest, status, reason, keep));
          for (const row of covers) state.writes.push(close(row, 'superseded', 'newer_notice'));
          state.closed = true;
          // Read in the Hub before the text went out: that is what they know now.
          if (status === 'skipped') heardOf(latest, final, 'hub');
        };
        // Named by a grouped text that went out (its own close was lost) or is
        // still being sent: never texted again on its own. While it waits, it
        // closes as expired only once nothing it could still have to say is
        // ahead, whether or not that text goes out: not just its first slot,
        // since a later day of the same change may still be to come.
        const grouped = waiting ? 'sending' : groupedOf(latest);
        if (grouped === 'sending') {
          const sent = slotList((waiting || latest).slots) || [];
          if (!slotUpcoming(latest.slot, at) && !changeKind(scheduleChange(heard, final, at)) && !changeKind(scheduleChange(sent, final, at))) closeAll('expired', 'slot_passed');
          continue;
        }
        if (grouped) {
          state.writes.push(closeGrouped(latest, latest.batchLead, grouped));
          for (const row of covers) state.writes.push(close(row, 'superseded', 'newer_notice'));
          heardOf(latest, final, 'text');
          continue;
        }
        const change = scheduleChange(heard, final, at), kind = changeKind(change);
        // Nothing changed since what they last heard (added then removed,
        // cancelled then restored, moved and moved back): no message.
        if (sameSlots(heard, final)) { closeAll('superseded', 'net_unchanged'); continue; }
        if (latest.acknowledged === true) { closeAll('skipped', 'acknowledged'); continue; }
        if (!kind) { if (slotUpcoming(latest.slot, at)) closeAll('superseded', 'net_unchanged'); else closeAll('expired', 'slot_passed'); continue; }
        if (latest.nextAttemptAt && latest.nextAttemptAt > iso) continue;
        ready.push({ row: latest, kind, change, heard, covers, heardSlots, closeAll, state });
      }
      const prefs = await preferences([...new Set(ready.map(item => item.row.employeeId))]);
      const deliverable = [], batches = new Map();
      for (const item of ready) {
        if (prefs.get(item.row.employeeId)?.sms !== true) { item.closeAll('not_opted_in', 'sms_not_opted_in'); continue; }
        if (!kinds.includes(item.kind)) continue;
        if (item.row.intent !== 'assigned' || !item.row.batchKey || item.kind !== 'crew_assignment' || item.covers.length || toldOf(item.row)) { deliverable.push(item); continue; }
        const key = `${item.row.employeeId}\n${item.row.batchKey}`;
        if (!batches.has(key)) batches.set(key, []);
        batches.get(key).push(item);
      }
      // New visits from one recurring run: one text per employee, naming the
      // earliest visit, how many more there are and the last one's date. The
      // others stay queued, stamped with that text, until its outcome is final.
      const lead = item => item.change.added[0];
      for (const batch of batches.values()) {
        batch.sort((a, b) => `${lead(a).date}T${lead(a).time}`.localeCompare(`${lead(b).date}T${lead(b).time}`) || bySave(a.row, b.row));
        const [first, ...others] = batch;
        if (others.length) first.batch = { count: others.length, lastDate: others.map(item => lead(item).endDate).sort().at(-1), ids: others.map(item => item.row.id) };
        first.siblings = others;
        deliverable.push(first);
      }
      // Housekeeping is one commit, each job and employee's closures with its
      // heard record, so the record never disagrees with the notices. A
      // concurrent tick that already closed a row makes it fail as a whole and
      // the next tick repeats it. A dry run only looks.
      const writes = loose.slice(0, 400);
      for (const state of states) {
        const record = state.told ? heardWrite(state.heardId, state.record, state.told.row, state.told.slots, true, iso, { via: state.told.via, full: state.full, prior: state.events.slice(0, -1) })
          : state.closed ? heardWrite(state.heardId, state.record, state.rows[0], state.heard || baseline(state.rows[0]), false, iso, { full: state.full }) : null;
        const chunk = [...state.writes, ...(record ? [record] : [])];
        if (chunk.length && writes.length + chunk.length <= 400) writes.push(...chunk);
      }
      if (writes.length && !dryRun) await store.commit(writes).catch(() => null);
      const chosen = deliverable.sort((a, b) => byCreated(a.row, b.row)).slice(0, Math.max(0, limit));
      // Before a grouped text can go out, every visit it names is stamped with
      // it in its own commit. A stamp that cannot be saved (another tick
      // changed a visit) holds the text back to the next tick.
      if (!dryRun) {
        for (const item of chosen.filter(item => item.siblings?.length)) {
          const stamp = item.siblings.filter(other => other.row.batchLead !== item.row.id);
          if (!stamp.length) continue;
          try { await store.commit(stamp.map(other => ({ collection: CREW_NOTIFICATIONS, id: other.row.id, revision: other.row.revision, patch: { batchLead: item.row.id, updatedAt: iso } }))); }
          catch { item.held = true; continue; }
          const fresh = byId(await read(CREW_NOTIFICATIONS, stamp.map(other => other.row.id)).catch(() => []));
          for (const other of stamp) { const row = fresh.get(other.row.id); if (row?.status === 'pending' && row.batchLead === item.row.id) other.row = row; else item.held = true; }
        }
      }
      const sending = chosen.filter(item => !item.held);
      for (const item of sending) {
        plans.set(item.row.id, { heard: item.heard, kind: item.kind, batch: item.batch || null, row: item.row, heardId: item.state.heardId, record: item.state.record, told: item.state.told, events: item.state.events, full: item.state.full, stamped: !dryRun,
          siblings: (item.siblings || []).map(other => ({ row: other.row, heardId: other.state.heardId, record: other.state.record, heard: other.heard, full: other.state.full })) });
      }
      return sending.map(({ row, kind, covers, heardSlots }) => ({ id: row.id, jobId: row.jobId, crewId: row.employeeId, messageKind: kind, intent: row.intent, revision: row.revision, attempts: Number(row.attempts || 0), slot: row.slot,
        batchKey: row.batchKey || '', heardSlots, covers: covers.map(older => ({ id: older.id, revision: older.revision })) }));
    },
    async complete(entry, outcome) {
      const plan = plans.get(entry.id) || null, heardId = plan?.heardId || await crewHeardId(entry.jobId, entry.crewId), full = plan ? plan.full : true;
      let row = plan?.row || null, record = plan ? plan.record : undefined, siblings = plan?.siblings || [], done = null, named;
      const prior = Array.isArray(plan?.events) ? plan.events : [];
      // A commit whose response was lost may still have landed: the row says.
      const landed = (fresh, patch) => Boolean(fresh) && ['status', 'lastStatus', 'attempts', 'updatedAt'].every(key => fresh[key] === patch[key]);
      for (let attempt = 0; attempt < 3 && !done; attempt += 1) {
        if (attempt || !row) row = await store.read(CREW_NOTIFICATIONS, entry.id);
        if (attempt || record === undefined) record = await store.read(CREW_NOTICE_HEARD, heardId);
        if (attempt) siblings = await refresh(entry.id, siblings);
        if (!row || row.status !== 'pending') return false;
        const patch = noticeTransition(row, outcome, iso);
        if (!patch) return false;
        const writes = [{ collection: CREW_NOTIFICATIONS, id: entry.id, revision: row.revision, patch }];
        if (patch.status !== 'pending') {
          if (Array.isArray(entry.heardSlots)) patch.heardSlots = entry.heardSlots;
          // Closed with a text: the employee now knows this notice's slots.
          // Closed without one: what they heard is unchanged (an older notice
          // this tick found texted, or the baseline this text would have used).
          const heard = TEXTED.has(patch.status) ? heardWrite(heardId, record, { ...row, id: entry.id }, slotList(row.slots) || [], true, iso, { full, prior })
            : plan?.told ? heardWrite(heardId, record, plan.told.row, plan.told.slots, true, iso, { via: plan.told.via, full, prior: prior.slice(0, -1) })
              : heardWrite(heardId, record, { ...row, id: entry.id }, plan ? plan.heard : baseline(row), false, iso, { full });
          if (heard) writes.push(heard);
          // A text closes only the visits its ledger says it named: another
          // tick's text may have gone out instead of this one's.
          if (TEXTED.has(patch.status) && siblings.length && named === undefined) named = await namedBy(entry);
          writes.push(...siblingCloses(entry.id, siblings, patch, named || []));
        }
        try { await store.commit(writes); done = patch; }
        catch (error) {
          if (conflict(error)) continue;
          if (landed(await store.read(CREW_NOTIFICATIONS, entry.id).catch(() => null), patch)) done = patch;
        }
      }
      if (!done) return false;
      if (done.status !== 'pending') {
        await settle(Array.isArray(entry.covers) ? entry.covers : []).catch(() => null);
        if (entry.batchKey && ['stale', 'superseded'].includes(done.status)) await reopen(entry.id).catch(() => null);
      }
      return true;
    },
  };
}

/** approved-send crewNotice hook: the notice must still be pending for this
 * job and employee, no newer notice may exist for them (a pending one makes
 * it wait for one combined text; a handled one replaced it), and the job's
 * live slots for the employee must still be the ones the notice queued. The
 * text then says what changed since what the employee last heard: every day
 * (or hour) taken away, and the first new or changed slot with any others. */
export function crewNoticeProvider({ store, query = null, readMany = null, plans = new Map() }) {
  let roster;
  // null: no roster to consult; UNREAD: the read failed, so a crew stored by
  // display name cannot be matched right now (the notice waits, never closes).
  const staff = () => roster ||= (typeof store.roster === 'function' ? Promise.resolve().then(() => store.roster()).then(rows => Array.isArray(rows) ? rows : UNREAD, () => UNREAD) : Promise.resolve(null));
  return async ({ noticeId, crewId, kind, job, now }) => {
    const at = now instanceof Date ? now : new Date(now), invalid = reason => ({ id: noticeId, valid: false, reason });
    const row = await store.read(CREW_NOTIFICATIONS, noticeId);
    if (!row || !wellFormedNotice({ ...row, id: noticeId }) || row.jobId !== job?.id || row.employeeId !== crewId) return invalid('notice_unavailable');
    if (row.status !== 'pending') return invalid('notice_closed');
    const plan = plans.get(noticeId) || null;
    if (typeof query === 'function') {
      const history = await query([['jobId', row.jobId], ['employeeId', crewId]], QUERY_LIMIT);
      if (!Array.isArray(history) || history.length >= QUERY_LIMIT) return invalid('notice_history_incomplete');
      const newer = history.filter(other => other?.id !== noticeId && other.jobId === row.jobId && other.employeeId === crewId && newerSave(other, { ...row, id: noticeId }));
      if (newer.some(other => other.status === 'pending')) return invalid('newer_notice_pending');
      if (newer.length) return invalid('newer_notice');
    }
    // Upcoming slots only, resolved with the roster as the dispatch diff was.
    const people = await staff(), current = employeeSlots(job, crewId, people === UNREAD ? null : people, at), final = (slotList(row.slots) || []).filter(slot => slotUpcoming(slot, at));
    if (!sameSlots(final, current)) return invalid(people === UNREAD ? 'roster_unavailable' : 'notice_superseded');
    const change = scheduleChange(plan ? plan.heard : baseline(row), final, at), expected = changeKind(change);
    if (!expected) return invalid('notice_superseded');
    if (expected !== kind) return invalid('notice_kind_changed');
    const lead = expected === 'crew_unassignment' ? change.lost[0] : change.added[0];
    // A grouped text names exactly the visits still queued and stamped with
    // it. One another tick closed or regrouped meanwhile makes it wait a tick,
    // and so does a queued visit stamped with it that this tick's plan leaves
    // out (a tick that saw the text being sent planned it alone): the next
    // tick groups them again, so the text never goes out without them. A text
    // whose ledger already holds a send never claims again, so that one goes
    // on to its recorded outcome. (A look-only tick stamps nothing.)
    const named = (plan?.siblings || []).map(item => item.row.id);
    if (row.batchKey && expected === 'crew_assignment' && (!plan || plan.stamped)) {
      let stamped = null;
      if (typeof query === 'function') {
        const found = await query([['batchLead', noticeId]], QUERY_LIMIT);
        if (Array.isArray(found) && found.length < QUERY_LIMIT) stamped = found.filter(other => other?.batchLead === noticeId && other.id !== noticeId);
      } else if (named.length) {
        const rows = typeof readMany === 'function' ? await readMany(CREW_NOTIFICATIONS, named) : await Promise.all(named.map(id => store.read(CREW_NOTIFICATIONS, id)));
        stamped = (Array.isArray(rows) ? rows : []).filter(other => other?.batchLead === noticeId);
      } else stamped = [];
      if (!stamped || named.some(id => !stamped.some(other => other.id === id && other.status === 'pending'))) return invalid('batch_changed');
      if (stamped.some(other => other.status === 'pending' && !named.includes(other.id))) {
        const send = await store.read(MESSAGE_SENDS, await ledgerId(noticeSendKey({ ...row, id: noticeId })));
        if (!TOLD.has(String(send?.status || ''))) return invalid('batch_changed');
      }
    }
    let batch = plan?.batch ? { ...plan.batch, ids: named } : null;
    if (!plan && row.batchKey && expected === 'crew_assignment' && typeof query === 'function') {
      const grouped = (await query([['batchedInto', noticeId]], QUERY_LIMIT)).filter(other => other?.batchedInto === noticeId && other.status === 'batched' && validSlot(other.slot));
      if (grouped.length) batch = { count: grouped.length, lastDate: grouped.map(other => other.slot.endDate).sort().at(-1), ids: grouped.map(other => other.id) };
    }
    const { segmentId, date, time, endDate, endTime } = lead;
    return { id: noticeId, valid: true, intent: row.intent, kind: expected, segmentId, date, time, endDate, endTime, lost: change.lost, added: change.added, slots: final, batch };
  };
}

/** approved-send crewContact hook. The phone comes only from the employee's
 * approved encrypted account and only while they have opted in; the HighLevel
 * contact only from the staff contact a dispatcher linked (approved-send never
 * creates one for crew). Configured Hub users have no phone on file. Never
 * from the job or customer records. */
export function crewContactProvider({ env = {}, store, charge = () => {}, readAccount = username => employeeInvitationStore(env).read(username) }) {
  return async ({ crewId }) => {
    const key = assignmentKey(crewId);
    if (!key) return null;
    const configured = getHubUserProfile(env, key);
    if (configured) return { name: configured.displayName || key, phone: '', email: '', highlevelContactId: '' };
    const prefs = await store.read(CREW_NOTIFICATION_PREFS, key);
    charge(1);
    const account = (await readAccount(key))?.account;
    if (!object(account) || account.status !== 'approved' || assignmentKey(account.username) !== key) return null;
    const linked = typeof prefs?.staffContactId === 'string' && CONTACT_ID.test(prefs.staffContactId) ? prefs.staffContactId : '';
    return { name: String(account.displayName || account.firstName || key), phone: prefs?.sms === true ? String(account.phone || '') : '', email: '', highlevelContactId: linked };
  };
}

/** Everything the messaging cron needs, or null while the flag is off. */
export function crewNotificationDeps(env, { store, charge = () => {}, now, storage, readAccount } = {}) {
  if (!crewNotificationsEnabled(env)) return null;
  storage ||= crewNotificationStorage(env);
  const charged = fn => typeof fn === 'function' ? (...args) => { charge(1); return fn(...args); } : null;
  // One tick: the outbox plans each text and the send hook reads that plan.
  const plans = new Map(), query = charged(storage.query);
  return {
    outbox: createCrewOutbox({ store, query, readMany: charged(storage.readMany), now, plans }),
    crewNotice: crewNoticeProvider({ store, query, readMany: charged(storage.readMany), plans }),
    crewContact: crewContactProvider({ env, store, charge, ...(readAccount ? { readAccount } : {}) }),
    links: { loginLink: context => context.audience === 'crew' ? CREW_HUB_LINK : undefined },
  };
}

// Schedule facts only: the feed never carries customer contact details or money.
const DELIVERY = Object.freeze({ sent: 'texted', pending: 'queued', uncertain: 'unconfirmed' });
const slotView = slot => validSlot(slot) ? { segmentId: slot.segmentId, date: slot.date, time: slot.time, endDate: slot.endDate, endTime: slot.endTime } : null;
const slotsView = value => (Array.isArray(value) ? value : []).map(slotView).filter(Boolean);
/** How a notice reached the employee: a visit grouped into a recurring-run
 * text reads as that text did ('grouped' once it went out, 'unconfirmed'
 * when HighLevel never confirmed it), and a notice closed without its own
 * text is 'covered' when a later text told them, or 'read_in_hub' when they
 * read a later notice for the job in the Hub instead. */
function deliveryOf(row, record) {
  if (DELIVERY[row.status]) return DELIVERY[row.status];
  if (row.status === 'batched' && row.lastStatus === 'uncertain') return 'unconfirmed';
  if (row.status === 'batched' && row.lastStatus === 'batched') return 'grouped';
  const via = toldVia(row, record);
  return via === 'hub' ? 'read_in_hub' : via ? 'covered' : 'not_texted';
}
// Maybe texted (on its own or in a grouped text): never shown as covered.
const unconfirmed = row => row.status === 'uncertain' || (row.status === 'batched' && row.lastStatus === 'uncertain');
function noticeView(row, at, record = null) {
  // A text that stood for older untexted changes said everything since what
  // the employee had last heard (heardSlots), so its card names the same days.
  // Rows queued before lostSlots existed: a removal lost everything it had.
  const heard = slotList(row.heardSlots);
  const lost = heard ? lostSlots(heard, slotList(row.slots) || [], at) : Array.isArray(row.lostSlots) ? row.lostSlots : REMOVAL_INTENTS.includes(row.intent) ? row.previousSlots : [];
  return {
    id: row.id, intent: row.intent, jobId: row.jobId, jobType: String(row.jobType || '').slice(0, 40), serviceType: String(row.serviceType || '').slice(0, 80),
    slot: slotView(row.slot), slots: slotsView(row.slots), previousSlots: slotsView(row.previousSlots), heardSlots: heard ? slotsView(heard) : null, lostSlots: slotsView(lost),
    createdAt: String(row.createdAt || ''), delivery: deliveryOf(row, record), acknowledged: row.acknowledged === true,
  };
}
// A visit held with a grouped text that could not go out can be sent again
// on its own once that text leaves the list.
const retryable = (row, at) => (RETRYABLE.has(row.status) || (row.status === 'batched' && RETRYABLE.has(row.lastStatus) && Boolean(row.attentionUntil))) && !(row.status === 'failed' && row.lastStatus === 'attempts_exhausted') && changeAhead(row, at);
const noticeKey = row => `${row.jobId}\n${row.employeeId}`;
/** Per-employee feed, acknowledgement and SMS opt-in (the employee is always
 * the signed-in user; no request field can name another person), plus the
 * dispatcher's crew view: who can be texted, staff-contact links and retries. */
export function createCrewNotificationFeed({ store, env = {}, now = () => new Date(), readAccount = username => employeeInvitationStore(env).read(username) }) {
  const viewer = session => {
    const id = assignmentKey(session?.user);
    if (!id) throw fail('sign_in_required', 'Sign in to the Employee Hub to see your schedule notices.', 401);
    return id;
  };
  const dispatcher = session => {
    const id = viewer(session);
    if (!can(session, 'dispatch.write', env)) throw fail('forbidden', 'Only a dispatcher can manage crew schedule texts.', 403);
    return id;
  };
  async function phone(id) {
    try {
      if (getHubUserProfile(env, id)) return { phone: '', phoneStatus: 'missing' };
      const account = (await readAccount(id))?.account, normalized = account?.status === 'approved' ? normalizePhone(account.phone) : '';
      return normalized ? { phone: maskRecipient('SMS', normalized), phoneStatus: 'on_file' } : { phone: '', phoneStatus: 'missing' };
    } catch { return { phone: '', phoneStatus: 'unavailable' }; }
  }
  async function preferences(id, prefs) {
    return { sms: prefs?.sms === true, revision: prefs?.revision || '', updatedAt: String(prefs?.smsUpdatedAt || ''), ...await phone(id) };
  }
  const member = (person, prefs) => ({ id: person.id, name: String(person.name || person.id).slice(0, 120), sms: prefs?.sms === true, smsUpdatedAt: String(prefs?.smsUpdatedAt || ''),
    staffContactId: typeof prefs?.staffContactId === 'string' && CONTACT_ID.test(prefs.staffContactId) ? prefs.staffContactId : '', staffContactLinkedAt: String(prefs?.staffContactLinkedAt || ''), revision: prefs?.revision || '' });
  async function roster() {
    const rows = await store.roster();
    if (!Array.isArray(rows)) throw fail('storage_incomplete', 'The crew roster was incomplete. Retry.', 503);
    return rows.filter(person => object(person) && typeof person.id === 'string' && person.id && person.id === assignmentKey(person.id));
  }
  async function readNotices(ids) { const found = await readRows(store, CREW_NOTIFICATIONS, ids); return ids.map(id => found.get(id) || null); }
  // What each employee last heard about each job, keyed `${jobId}\n${employeeId}` (one batch read).
  async function heardRecords(rows) {
    const keys = new Map();
    for (const row of rows) if (!keys.has(noticeKey(row))) keys.set(noticeKey(row), await crewHeardId(row.jobId, row.employeeId));
    if (!keys.size) return new Map();
    const found = await readRows(store, CREW_NOTICE_HEARD, [...new Set(keys.values())]);
    return new Map([...keys].map(([key, id]) => [key, found.get(id) || null]));
  }
  function noticeIds(input, keys) {
    if (!object(input) || Object.keys(input).some(key => !keys.includes(key)) || !UUID.test(input.requestId || '')) throw fail('request_invalid', 'Use a supported notice action with a unique request ID.');
    const ids = input.ids;
    if (!Array.isArray(ids) || !ids.length || ids.length > ACK_LIMIT || ids.some(value => typeof value !== 'string' || !NOTICE_ID.test(value)) || new Set(ids).size !== ids.length) throw fail('request_invalid', `Choose from 1 to ${ACK_LIMIT} notices.`);
    return ids;
  }
  // Commit, and after a lost response accept only this request's own saved result.
  async function commitOrRecover(writes, saved) {
    try { await store.commit(writes); }
    catch (error) {
      const notices = writes.filter(write => write.collection === CREW_NOTIFICATIONS), rows = await readNotices(notices.map(write => write.id)).catch(() => []);
      if (!notices.length || rows.length !== notices.length || !rows.every(saved)) throw error;
    }
  }
  return {
    async list(session) {
      const id = viewer(session), at = now();
      const rows = (await store.query([['employeeId', id], ['acknowledged', false]], FEED_LIMIT + 1)).filter(row => row.employeeId === id && row.acknowledged !== true && wellFormedNotice(row));
      rows.sort((a, b) => byCreated(b, a));
      const shown = rows.slice(0, FEED_LIMIT), records = await heardRecords(shown);
      const prefs = await store.read(CREW_NOTIFICATION_PREFS, id);
      return { ok: true, authority: 'employee_hub', timeZone: 'America/Denver', viewer: { id }, notices: shown.map(row => noticeView(row, at, records.get(noticeKey(row)))), preferences: await preferences(id, prefs),
        coverage: { complete: rows.length <= FEED_LIMIT, asOf: at.toISOString() } };
    },
    async acknowledge(session, input) {
      const id = viewer(session), iso = now().toISOString(), ids = noticeIds(input, ['action', 'requestId', 'ids']), requestId = input.requestId.toLowerCase();
      const rows = await readNotices(ids);
      // Someone else's notice is indistinguishable from a missing one.
      if (rows.some(row => !row || row.employeeId !== id)) throw fail('not_found', 'A notice could not be found. Refresh your notices.', 404);
      const open = rows.filter(row => row.acknowledged !== true);
      if (open.length) await commitOrRecover(open.map(row => ({ collection: CREW_NOTIFICATIONS, id: row.id, revision: row.revision, patch: { acknowledged: true, acknowledgedAt: iso, acknowledgedRequestId: requestId, updatedAt: iso } })), row => row?.acknowledgedRequestId === requestId);
      return { ok: true, authority: 'employee_hub', requestId: input.requestId, acknowledged: ids, alreadyApplied: !open.length };
    },
    async setPreferences(session, input) {
      const id = viewer(session), iso = now().toISOString();
      if (!object(input) || Object.keys(input).some(key => !['action', 'requestId', 'sms', 'expectedRevision'].includes(key)) || !UUID.test(input.requestId || '')) throw fail('request_invalid', 'Use a supported notice action with a unique request ID.');
      if (typeof input.sms !== 'boolean' || typeof input.expectedRevision !== 'string' || input.expectedRevision.length > 100) throw fail('request_invalid', 'Choose whether schedule texts are on, from the latest settings.');
      const requestId = input.requestId.toLowerCase(), fingerprint = await digest({ actor: id, input: { sms: input.sms, expectedRevision: input.expectedRevision } });
      const current = await store.read(CREW_NOTIFICATION_PREFS, id);
      if (current?.lastRequestId === requestId) {
        if (current.lastFingerprint !== fingerprint) throw fail('idempotency_conflict', 'This request ID was already used for a different change. Refresh before saving.', 409);
        return { ok: true, authority: 'employee_hub', requestId: input.requestId, replayed: true, preferences: await preferences(id, current) };
      }
      if ((current?.revision || '') !== input.expectedRevision) throw fail('revision_conflict', 'Your text settings changed since you opened them. Refresh and try again.', 409);
      if (current && current.sms === input.sms) return { ok: true, authority: 'employee_hub', requestId: input.requestId, unchanged: true, preferences: await preferences(id, current) };
      const patch = { employeeId: id, sms: input.sms, smsUpdatedAt: iso, updatedAt: iso, lastRequestId: requestId, lastFingerprint: fingerprint,
        history: [...(Array.isArray(current?.history) ? current.history : []), { sms: input.sms, at: iso, requestId }].slice(-HISTORY_LIMIT) };
      try { await store.commit([{ collection: CREW_NOTIFICATION_PREFS, id, ...(current ? { revision: current.revision } : {}), patch }]); }
      catch (error) {
        const saved = await store.read(CREW_NOTIFICATION_PREFS, id).catch(() => null);
        if (saved?.lastRequestId !== requestId || saved.lastFingerprint !== fingerprint) throw error;
      }
      return { ok: true, authority: 'employee_hub', requestId: input.requestId, preferences: await preferences(id, await store.read(CREW_NOTIFICATION_PREFS, id)) };
    },
    /** Dispatcher view: each roster member's text opt-in and staff-contact
     * link, and the notices closed without a text for work still ahead. */
    async team(session) {
      const id = dispatcher(session), at = now(), today = denverToday(at);
      const people = await roster(), shown = people.slice(0, TEAM_LIMIT);
      const prefs = shown.length ? await readRows(store, CREW_NOTIFICATION_PREFS, shown.map(person => person.id)) : new Map();
      const listed = (await store.attention(today, ATTENTION_LIMIT + 1)).filter(row => wellFormedNotice(row) && (ATTENTION.has(row.status) || row.status === 'batched') && String(row.attentionUntil || '') >= today);
      // Visits held with a grouped text that could not go out are listed under
      // that text (Send again regroups them) until it leaves the list.
      const leads = new Set(listed.filter(row => row.status !== 'batched').map(row => row.id));
      const rows = listed.filter(row => row.status !== 'batched' || !leads.has(row.batchedInto)).sort((a, b) => byCreated(b, a)), records = await heardRecords(rows.slice(0, ATTENTION_LIMIT));
      const names = new Map(people.map(person => [person.id, String(person.name || person.id).slice(0, 120)]));
      // Only the newest unsent notice per job and employee can be sent again.
      const newest = new Map();
      for (const row of rows) { const key = noticeKey(row); if (!newest.has(key) || newerSave(row, newest.get(key))) newest.set(key, row); }
      return { ok: true, authority: 'employee_hub', timeZone: 'America/Denver', viewer: { id }, team: shown.map(person => member(person, prefs.get(person.id))),
        attention: rows.slice(0, ATTENTION_LIMIT).map(row => { const record = records.get(noticeKey(row)) || null; return { ...noticeView(row, at, record), employeeId: row.employeeId, employeeName: names.get(row.employeeId) || row.employeeId,
          status: row.status === 'batched' ? (ATTENTION.has(row.lastStatus) ? row.lastStatus : 'failed') : row.status, reason: safeCode(row.lastReason), attempts: Number(row.attempts) || 0, updatedAt: String(row.updatedAt || ''),
          // A later text (or a later notice they read in the Hub) already told
          // them this change; Send again closes it instead.
          ...(via => ({ covered: Boolean(via), coveredVia: via }))(unconfirmed(row) ? '' : toldVia(row, record)), canRetry: retryable(row, at) && newest.get(noticeKey(row)) === row }; }),
        coverage: { complete: listed.length <= ATTENTION_LIMIT && people.length <= TEAM_LIMIT, asOf: at.toISOString() } };
    },
    /** Links (or with '' unlinks) the HighLevel staff contact crew texts use.
     * The send still verifies the contact's location, the employee's own
     * number and the egc-staff tag, so a wrong id can only block a text. */
    async linkStaffContact(session, input) {
      const id = dispatcher(session), iso = now().toISOString();
      if (!object(input) || Object.keys(input).some(key => !['action', 'requestId', 'employeeId', 'contactId', 'expectedRevision'].includes(key)) || !UUID.test(input.requestId || '')) throw fail('request_invalid', 'Use a supported notice action with a unique request ID.');
      const employeeId = typeof input.employeeId === 'string' ? assignmentKey(input.employeeId) : '', contactId = typeof input.contactId === 'string' ? input.contactId.trim() : null;
      if (!employeeId || employeeId !== input.employeeId || contactId === null || (contactId && !CONTACT_ID.test(contactId)) || typeof input.expectedRevision !== 'string' || input.expectedRevision.length > 100) throw fail('request_invalid', 'Enter the HighLevel contact ID for this crew member, from the latest settings.');
      const person = (await roster()).find(row => row.id === employeeId);
      if (!person) throw fail('employee_not_found', 'That crew member is not on the roster. Refresh the crew list.', 404);
      const requestId = input.requestId.toLowerCase(), fingerprint = await digest({ actor: id, input: { employeeId, contactId, expectedRevision: input.expectedRevision } });
      const current = await store.read(CREW_NOTIFICATION_PREFS, employeeId);
      if (current?.staffContactRequestId === requestId) {
        if (current.staffContactFingerprint !== fingerprint) throw fail('idempotency_conflict', 'This request ID was already used for a different change. Refresh before saving.', 409);
        return { ok: true, authority: 'employee_hub', requestId: input.requestId, replayed: true, member: member(person, current) };
      }
      if ((current?.revision || '') !== input.expectedRevision) throw fail('revision_conflict', 'This crew member\'s text settings changed. Refresh and try again.', 409);
      if ((current?.staffContactId || '') === contactId) return { ok: true, authority: 'employee_hub', requestId: input.requestId, unchanged: true, member: member(person, current) };
      const patch = { employeeId, staffContactId: contactId, staffContactLinkedBy: id, staffContactLinkedAt: iso, staffContactRequestId: requestId, staffContactFingerprint: fingerprint, updatedAt: iso,
        staffContactHistory: [...(Array.isArray(current?.staffContactHistory) ? current.staffContactHistory : []), { contactId, by: id, at: iso, requestId }].slice(-HISTORY_LIMIT) };
      try { await store.commit([{ collection: CREW_NOTIFICATION_PREFS, id: employeeId, ...(current ? { revision: current.revision } : {}), patch }]); }
      catch (error) {
        const saved = await store.read(CREW_NOTIFICATION_PREFS, employeeId).catch(() => null);
        if (saved?.staffContactRequestId !== requestId || saved.staffContactFingerprint !== fingerprint) throw error;
      }
      return { ok: true, authority: 'employee_hub', requestId: input.requestId, member: member(person, await store.read(CREW_NOTIFICATION_PREFS, employeeId)) };
    },
    /** Queues notices closed without a text again (after a phone, opt-in or
     * contact was fixed). The newest notice for the job and employee carries
     * the text: it says everything since what the employee last heard, so a
     * retried older notice is closed into it, and nothing they were already
     * told is repeated. A notice with nothing left to tell (a later text
     * covered it, or the change was undone) is closed as superseded. The
     * visits a grouped text stood for are queued again with it, and the cron
     * re-checks every one against the live job. */
    async retry(session, input) {
      const id = dispatcher(session), at = now(), iso = at.toISOString(), ids = noticeIds(input, ['action', 'requestId', 'ids']), requestId = input.requestId.toLowerCase();
      const rows = await readNotices(ids);
      if (rows.some(row => !row || !wellFormedNotice(row))) throw fail('not_found', 'A notice could not be found. Refresh the crew list.', 404);
      const open = rows.filter(row => row.retryRequestId !== requestId);
      if (open.some(row => !retryable(row, at))) throw fail('not_retryable', 'A notice can no longer be sent: it was texted, is unconfirmed, or its work has passed. Refresh the crew list.', 409);
      const histories = new Map();
      const history = row => {
        const key = noticeKey(row);
        if (!histories.has(key)) histories.set(key, (async () => {
          const found = await store.query([['jobId', row.jobId], ['employeeId', row.employeeId]], QUERY_LIMIT);
          if (!Array.isArray(found) || found.length >= QUERY_LIMIT) throw fail('storage_incomplete', 'Schedule notices were incomplete. Retry.', 503);
          return found.filter(other => other?.jobId === row.jobId && other.employeeId === row.employeeId && wellFormedNotice(other));
        })());
        return histories.get(key);
      };
      const records = await heardRecords(open);
      const stamp = { retryRequestId: requestId, retriedBy: id, retriedAt: iso, updatedAt: iso }, writes = new Map(), outcomes = new Map();
      const put = write => writes.set(`${write.collection}/${write.id}`, write);
      const queued = row => writes.get(`${CREW_NOTIFICATIONS}/${row.id}`)?.patch.status === 'pending';
      const requeue = (row, heard) => put({ collection: CREW_NOTIFICATIONS, id: row.id, revision: row.revision, patch: { status: 'pending', attempts: 0, nextAttemptAt: '', lastStatus: 'retry_requested', lastReason: '', attentionUntil: '', batchedInto: '', batchLead: '',
        heardSlots: sameSlots(heard, slotList(row.previousSlots) || []) ? null : heard, retryOutcome: 'retried', ...stamp } });
      const close = (row, reason, outcome) => { put({ collection: CREW_NOTIFICATIONS, id: row.id, revision: row.revision, patch: { status: 'superseded', lastStatus: 'superseded', lastReason: reason, nextAttemptAt: '', attentionUntil: '', retryOutcome: outcome, ...stamp } }); outcomes.set(row.id, outcome); };
      // The visits a grouped text that never went out stood for are queued
      // again with it, whether it is sent again or closed (nothing left to
      // tell, or a newer notice carries it): they were never texted. The cron
      // groups them again and re-checks each against the live job.
      const regroup = async leadId => {
        const grouped = await store.query([['batchedInto', leadId]], QUERY_LIMIT);
        if (!Array.isArray(grouped)) throw fail('storage_incomplete', 'Schedule notices were incomplete. Retry.', 503);
        for (const other of grouped) {
          if (other?.batchedInto !== leadId || other.status !== 'batched' || ['batched', 'uncertain', 'dry_run'].includes(other.lastStatus) || writes.has(`${CREW_NOTIFICATIONS}/${other.id}`) || !wellFormedNotice(other) || !changeAhead(other, at)) continue;
          if ((await history(other)).some(later => later.id !== other.id && newerSave(later, other))) continue;
          requeue(other, slotList(other.previousSlots) || []);
        }
      };
      for (const row of open) {
        if (writes.has(`${CREW_NOTIFICATIONS}/${row.id}`)) { outcomes.set(row.id, queued(row) ? 'retried' : outcomes.get(row.id) || 'superseded'); continue; }
        const all = await history(row), newest = [row, ...all.filter(other => other.id !== row.id)].sort(bySave).at(-1);
        // What the employee last heard about this job.
        const record = records.get(noticeKey(row)) || null, known = record && slotList(record.slots) ? { slots: slotList(record.slots), row: null } : heardFromHistory([row, ...all.filter(other => other.id !== row.id)]);
        if (row.batchKey) await regroup(row.id);
        // A newer notice still queued already carries this change. Without a
        // heard record (notices from before it), the cron's baseline can be
        // the oldest queued notice's, so that one keeps what the employee heard.
        if (newest.id !== row.id && newest.status === 'pending') {
          const oldest = all.filter(other => other.status === 'pending').sort(bySave)[0];
          if (!record && !writes.has(`${CREW_NOTIFICATIONS}/${oldest.id}`) && !sameSlots(known.slots, baseline(oldest))) put({ collection: CREW_NOTIFICATIONS, id: oldest.id, revision: oldest.revision, patch: { heardSlots: known.slots, retryRequestId: requestId, updatedAt: iso } });
          close(row, 'newer_notice', 'retried'); continue;
        }
        const final = slotList(newest.slots) || [];
        if (!changeKind(scheduleChange(known.slots, final, at))) { close(row, newest.id === row.id ? 'net_unchanged' : 'newer_notice', 'superseded'); continue; }
        if (newest.id !== row.id) close(row, 'newer_notice', 'retried');
        if (!queued(newest)) requeue(newest, known.slots);
        outcomes.set(row.id, 'retried');
        if (newest.batchKey && newest.id !== row.id) await regroup(newest.id);
      }
      if (writes.size) await commitOrRecover([...writes.values()], row => row?.retryRequestId === requestId);
      // A replay reports what the first request did.
      const outcome = (row, index) => outcomes.get(ids[index]) || row.retryOutcome || (row.status === 'superseded' ? 'superseded' : 'retried');
      const results = rows.map(outcome);
      return { ok: true, authority: 'employee_hub', requestId: input.requestId, retried: ids.filter((_, index) => results[index] === 'retried'), superseded: ids.filter((_, index) => results[index] === 'superseded'),
        regrouped: [...writes.values()].filter(write => write.collection === CREW_NOTIFICATIONS && write.patch.status === 'pending' && !ids.includes(write.id)).map(write => write.id), alreadyApplied: !open.length };
    },
  };
}
