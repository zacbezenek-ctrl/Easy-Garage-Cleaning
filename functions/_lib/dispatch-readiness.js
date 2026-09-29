/* FIX-DISPATCH-READY: what Dispatch shows before a visit about the customer's HighLevel reminder and, for
   managers and the owner only, the visit's price and deposit. Read-only: nothing here writes to HighLevel or
   sends anything; HighLevel owns every confirmation and reminder, and the Hub only tells it the visit's tags.

   Both are added only to GET /api/dispatch's board and job view (dispatchOverview option readiness), never to the
   signed hub.dispatch.overview bridge.

   Reminder readiness (`reminder` on every dispatch visit): with EGC_GHL_TAG_OUTBOX on and a current tag outbox
   entry (GHL-TRACK-1's ghlTagEntry for the visit's current start, the entry scheduleTagOwner hands the tags to),
   it comes from that entry: its tags and its told / waiting / stuck status (source 'ghl_outbox'; a pending entry the
   tag worker is overdue on, GHL-TRACK-1's ghlTagOverdue, is 'stuck' as the card's HighLevel chip says). Otherwise it
   comes from today's browser calendar-sync fields: syncStatus, automationTagSynced, the reminder tag that sync
   reported adding (automationReminderTag, employee-suite.js syncJobRecord), syncLastAttemptAt and the appointment
   link (source 'calendar_sync'). 'set' needs positive evidence that HighLevel got this visit's reminder tag: the
   current entry told it, or the newest sync was the browser's and reported adding it after Notify customer last
   changed in Dispatch (notifySetAt). A sync that added no reminder tag (a Game Plan's job booking, tool=game_plan)
   reads 'not_told'; a row that never recorded one (before this change), whose newest sync was a server mirror
   (syncedAt, which records no tags), or whose page sync left the tags to the tag outbox (automationReminderTag
   'outbox': the page added none, so after the flag is rolled back it cannot say what HighLevel has) reads
   'unknown'. Anything unknown is 'unknown', never 'set'. With reminders off,
   'off_told' says HighLevel may still remind: the current entry carries the reminder tag, or an earlier entry or
   browser sync on the visit told HighLevel one (automationReminderTaggedAt). Nothing takes that tag back, so when
   that cannot be known (an unreadable entry chain, or an outbox-owned page sync) it reads 'unknown', never 'off'.

   Money readiness (`moneyReady`, service jobs only, never walkthroughs or blocks) is computed with money-core and
   added only for a viewer with dispatch.write (owner or manager). A sales or crew session never gets it, and the
   crew DTOs (/api/field-jobs, /api/crew-jobs) are allowlists that never carry it. A recurring plan's visit priced
   at the plan's per-visit price is 'plan' priced: no per-visit approval is asked for, so it raises no no_price.
   A deposit is never 'verified' while the job's payment record has an unreconciled refund or conflicting receipts
   (money-core money_refunds_unreconciled, money_payment_conflict). A Stripe refund recorded only as a payment
   review (payment_reviews, stripe-reviews.js) and not on the job is not seen here. */
import { customerMoneyTotals, moneyCents, paymentLedger } from './money-core.js';
import { customerPaymentNeedsReview } from './customer-payments.js';
import { canDispatch } from './dispatch-permissions.js';
import { addDays, denverToday, scheduleInterval, validDate } from './dispatch-time.js';
import { GHL_TAG_OUTBOX, ghlTagOverdue, withGhlTagStatus } from './ghl-tag-outbox.js';

// The deposit warning starts this many Denver calendar days before the visit (owner decision: warn, never block).
export const DEPOSIT_WARNING_DAYS = 2;
export const REMINDER_STATES = Object.freeze(['set', 'pending', 'stuck', 'not_told', 'off', 'off_told', 'no_contact', 'unknown', 'not_scheduled']);
// The job fields money-core reads for a visit's price and deposit (a batchGet mask: never the signature or notes).
export const MONEY_READY_FIELDS = Object.freeze(['type', 'recordType', 'status', 'pipelineStatus', 'total', 'priceQuoted', 'lockedTotal', 'rate', 'quoteStatus',
  'estimate.amount', 'estimate.depositRequired', 'estimate.status', 'customerApproval.status', 'customerApproval.amount', 'invoice.paid', 'invoice.amountPaid',
  'payment', 'deposit.amount', 'deposit.paidAmount', 'deposit.verified', 'approvedChangeTotal', 'customerDecisions', 'changeOrders', 'giftWallet.redemptions', 'refunds',
  'completedAt', 'postJobChecklist.completedAt', 'postJobProgress.standardItems', 'recurringPlanId']);
// recurring-plan-service.js's plans collection; only the per-visit price is read.
const PLANS = 'recurringPlans';
const MONEY_TYPES = new Set(['job', 'cleanout', 'reorg']), VISIT_TYPES = new Set(['job', 'walkthrough', 'cleanout', 'reorg']);
const TERMINAL = new Set(['cancelled', 'canceled', 'completed', 'invoiced', 'paid', 'review_requested', 'closed', 'noshow', 'no_show', 'no-show']);
const ENTRY_ID = /^gto_[0-9a-f]{40}$/, REMINDER_TAG = /^egc-reminder-\d{1,2}d$/, CHUNK = 100;
// employee-suite.js syncJobRecord saves this as automationReminderTag when the tag outbox owned the visit's tags.
const OUTBOX_OWNED = 'outbox';
// Payment records whose money is not settled: a deposit on them is never shown as verified (money-core paymentLedger).
const UNSETTLED = new Set(['money_refunds_unreconciled', 'money_payment_conflict']);
// Earlier outbox entries followed for a reminders-off visit (as the drain's earlierTimeTold, ghl-tag-outbox.js).
const HOPS = 5, ENTRY_FIELDS = ['status', 'skipped', 'addTags', 'previousEntryId'];
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const lower = value => String(value || '').toLowerCase();
const state = job => lower(job?.pipelineStatus || job?.status || 'unscheduled');
const at = value => typeof value === 'string' && value ? Date.parse(value) : NaN;
const USD = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }), usd = cents => USD.format(cents / 100);
const visit = job => VISIT_TYPES.has(job?.type) && !job.recordType;
const moneyVisit = job => MONEY_TYPES.has(job?.type) && !job.recordType;
const safeId = id => typeof id === 'string' && /^[A-Za-z0-9_-]{1,180}$/.test(id) && !/^(_egc_|secure_)/.test(id);
const hasReminder = tags => Array.isArray(tags) && tags.some(tag => REMINDER_TAG.test(tag));
// A browser sync on this visit reported adding its reminder tag (employee-suite.js syncJobRecord).
const syncReminded = job => Number.isFinite(at(job?.automationReminderTaggedAt));

/** The notify fields a dispatch update adds. notifySetAt records when a person changed Notify customer, or decided it
 * at an imported Jobber job's first booking. With EGC_DISPATCH_NOTIFY_IMPORTED_ON (importedOn, dispatchStorage's
 * notifyImportedOn; owner decision: HighLevel reminders on for every scheduled visit) that first booking also turns
 * reminders on when the dispatcher did not choose. `next` is the job as the update leaves it. {} when unchanged. */
export function notifyPatch(current, changes, next, now, { importedOn = false } = {}) {
  if (!plain(current) || !plain(changes)) return {};
  const firstImported = current.scheduleSource === 'jobber_import' && current.notify === false && !current.notifySetAt && !validDate(current.date) && Boolean(scheduleInterval(next));
  if (typeof changes.notify === 'boolean') return (current.notify !== false) !== changes.notify || firstImported ? { notifySetAt: now } : {};
  return firstImported && importedOn ? { notify: true, notifySetAt: now } : {};
}

const startOf = job => scheduleInterval(job)?.startAt || null;
// The visit's outbox entry is current: it was written for the visit's current start (outboxOwnsScheduleTags).
const currentEntry = (job, start = startOf(job)) => plain(job?.ghlTagEntry) && ENTRY_ID.test(job.ghlTagEntry.id || '') && typeof job.ghlTagEntry.startAt === 'string' && job.ghlTagEntry.startAt === start;

/** A visit's reminder readiness {state, source, jobberImport?}, or null for blocks, closed visits and visits that
 * already started. jobberImport marks an imported Jobber job whose reminder choice nobody has made yet (no
 * notifySetAt). `entry` is the visit's current outbox entry ({status, skipped, addTags}), null when there is none,
 * or 'unreadable'. `earlier` is whether an earlier outbox entry on the visit told HighLevel its reminder tag (null:
 * unknown). `now` is an ISO instant; `startAt` (the projected start, null when invalid) saves recomputing it. */
export function reminderReadiness(job, { outbox = false, entry = null, now, startAt = startOf(job), earlier = false } = {}) {
  if (!visit(job) || TERMINAL.has(state(job))) return null;
  const off = job.notify === false, extra = job.scheduleSource === 'jobber_import' && !job.notifySetAt ? { jobberImport: true } : {};
  if (!startAt) return { state: off ? 'off' : 'not_scheduled', source: 'none', ...extra };
  if (at(startAt) <= at(now)) return null;
  // Reminders off: nothing takes a reminder tag back, so HighLevel may still remind once any entry or sync told it one.
  // told null: whether this visit's newest change told HighLevel one cannot be known.
  const offState = told => told === true || earlier === true || syncReminded(job) ? 'off_told' : told === null || earlier === null ? 'unknown' : 'off';
  // As scheduleTagOwner: a missing entry, or one closed without telling HighLevel, leaves the tags to the browser sync.
  if (outbox && currentEntry(job, startAt) && entry && !(plain(entry) && entry.status === 'done' && entry.skipped)) {
    const result = value => ({ state: value, source: 'ghl_outbox', ...extra });
    if (!plain(entry)) return result('unknown');
    const reminder = hasReminder(entry.addTags);
    if (off) return result(offState(reminder));
    if (!reminder) return result('not_told');
    // A pending entry the drain is overdue on (the tag worker stopped) is stuck, as the HighLevel chip shows it.
    if (entry.status === 'pending' && ghlTagOverdue(entry, at(now))) return result('stuck');
    return result({ done: 'set', pending: 'pending', parked: 'stuck' }[entry.status] || 'unknown');
  }
  const result = value => ({ state: value, source: 'calendar_sync', ...extra });
  const told = job.syncStatus === 'synced' && job.automationTagSynced === true && Boolean(job.highlevelAppointmentId);
  // Notify customer changed in Dispatch after the last sync started: HighLevel has not heard the current choice.
  const changed = Number.isFinite(at(job.notifySetAt)) && !(at(job.syncLastAttemptAt) > at(job.notifySetAt));
  // The sync recorded which reminder tag it added ('' for none); a row from before that records nothing. 'outbox': the
  // tag outbox owned the tags at that sync, so the page added none and cannot say whether HighLevel has a reminder.
  const recorded = typeof job.automationReminderTag === 'string', outboxOwned = job.automationReminderTag === OUTBOX_OWNED;
  if (off) return result(offState(outboxOwned ? null : told && (recorded ? REMINDER_TAG.test(job.automationReminderTag) : changed)));
  if (!told) {
    if (['pending', 'syncing'].includes(job.syncStatus)) return result('pending');
    if (job.syncStatus === 'error') return result('stuck');
    if (job.syncStatus !== 'synced' && !job.highlevelContactId && !job.highlevelAppointmentId) return result('no_contact');
    return result('unknown');
  }
  // A server mirror (operations-scheduling.js syncedAt) after the browser's sync wrote the appointment without tags.
  if (!recorded || outboxOwned || at(job.syncedAt) > at(job.syncLastAttemptAt)) return result('unknown');
  return result(REMINDER_TAG.test(job.automationReminderTag) && !changed ? 'set' : 'not_told');
}

// The customer approved this price: a current approval (never superseded) whose amount, when both are saved, is the
// estimate's (money-document approvalOf, operations-financials approved_quote_values_conflict).
function approvedPrice(job) {
  const approval = plain(job.customerApproval) ? job.customerApproval : {}, estimate = plain(job.estimate) ? job.estimate : {};
  if (lower(approval.status) === 'superseded' || !['accepted', 'approved'].includes(lower(approval.status || estimate.status || job.quoteStatus))) return false;
  const approved = moneyCents(approval.amount), quoted = moneyCents(estimate.amount);
  return !(approval.status && approved !== null && quoted !== null && approved !== quoted);
}

/** Money readiness for one service job (null otherwise), in integer cents from money-core: hasApprovedPrice needs a
 * known total above $0 and a current customer approval; a deposit that is unknown stays null, never 0. A deposit
 * counts as verified only when no recorded payment awaits team verification and the payment record has no
 * unreconciled refund or conflicting receipts (UNSETTLED; then it is false). `planCents` is the per-visit price of
 * the recurring plan the visit belongs to: a visit still at that price is priceStatus 'plan' (the plan saved it as
 * a draft estimate with no deposit and asks for no per-visit approval, recurring-plan-price.js). */
export function moneyReadiness(job, { planCents = null } = {}) {
  if (!moneyVisit(job)) return null;
  const totals = customerMoneyTotals(job), cents = value => Number.isSafeInteger(value) ? value : null;
  // customerMoneyTotals keeps the payment ledger's issues to itself today; both are checked so either one decides.
  const unsettled = [...totals.issues, ...paymentLedger(job).issues].some(code => UNSETTLED.has(code));
  const priced = cents(totals.quoteCents) !== null && cents(totals.totalCents) !== null && totals.totalCents > 0;
  const hasApprovedPrice = priced && approvedPrice(job), paid = cents(totals.depositPaidCents);
  const planPrice = !hasApprovedPrice && priced && Number.isSafeInteger(planCents) && totals.quoteCents === planCents && lower(job.customerApproval?.status) !== 'superseded';
  return { checked: true, hasApprovedPrice, priceStatus: hasApprovedPrice ? 'approved' : planPrice ? 'plan' : priced ? 'not_approved' : totals.issues.includes('money_quote_invalid') ? 'unreadable' : 'missing',
    depositRequiredCents: cents(totals.depositRequiredCents), depositPaidCents: paid, depositDueCents: cents(totals.depositDueCents), depositVerified: paid > 0 ? !unsettled && !customerPaymentNeedsReview(job) : null };
}

const UNCHECKED = Object.freeze({ checked: false, hasApprovedPrice: null, priceStatus: 'unknown', depositRequiredCents: null, depositPaidCents: null, depositDueCents: null, depositVerified: null });

/** The last Denver date whose visits get the deposit warning at `now` (DEPOSIT_WARNING_DAYS after today). */
export const depositWarningDate = now => addDays(denverToday(new Date(now)), DEPOSIT_WARNING_DAYS);

/** The money warnings for an active service job: no_price (never for a plan-priced recurring visit), and
 * deposit_unpaid from DEPOSIT_WARNING_DAYS Denver days before its start while deposit money is still due. Nothing when
 * the money could not be read. `until` is depositWarningDate(now), passed in so a board works it out once. */
export function moneyWarnings(job, ready, now, until = depositWarningDate(now)) {
  if (!ready?.checked || !moneyVisit(job) || TERMINAL.has(state(job))) return [];
  const warnings = [];
  if (!ready.hasApprovedPrice && ready.priceStatus !== 'plan') warnings.push({ code: 'no_price', jobId: job.id, message: 'No approved price: price it before the job' });
  if (validDate(job.date) && ready.depositDueCents > 0 && job.date <= until) {
    warnings.push({ code: 'deposit_unpaid', jobId: job.id, message: `Deposit unpaid: ${usd(ready.depositDueCents)} is still due before this job.`, depositDueCents: ready.depositDueCents });
  }
  return warnings;
}

async function readRows(store, collection, ids, fields) {
  if (!ids.length) return [];
  if (typeof store.readMany !== 'function') return (await Promise.all(ids.map(id => store.read(collection, id)))).filter(Boolean);
  const chunks = [];
  for (let index = 0; index < ids.length; index += CHUNK) chunks.push(ids.slice(index, index + CHUNK));
  return (await Promise.all(chunks.map(chunk => store.readMany(collection, chunk, fields)))).flat();
}

// The per-visit price of each recurring plan the money rows belong to, by plan id. An unreadable plan leaves its
// visits to the ordinary rules (no approved price is a warning), never a price nobody can confirm.
async function planPrices(store, rows) {
  const ids = [...new Set(rows.map(row => row?.recurringPlanId).filter(safeId))];
  try { return new Map((await readRows(store, PLANS, ids, ['pricePerVisitCents'])).map(plan => [plan.id, plan.pricePerVisitCents])); }
  catch { return new Map(); }
}

// Reminders off: which of these visits (jobId -> the visit's newest entry id) had an earlier entry tell HighLevel
// its reminder tag, following previousEntryId as the drain's earlierTimeTold does. `entries` holds the entries already
// read. jobId -> true when one did, null when that could not be read or the chain runs past HOPS; absent when none did.
async function remindedEarlier(store, heads, entries) {
  const found = new Map();
  let frontier = heads;
  try {
    for (let hop = 0; hop < HOPS && frontier.size; hop++) {
      const missing = [...new Set(frontier.values())].filter(id => !entries.has(id));
      for (const row of await readRows(store, GHL_TAG_OUTBOX, missing, ENTRY_FIELDS)) entries.set(row.id, row);
      const next = new Map();
      for (const [jobId, id] of frontier) {
        const row = entries.get(id);
        if (row?.status === 'done' && !row.skipped && hasReminder(row.addTags)) found.set(jobId, true);
        else if (ENTRY_ID.test(row?.previousEntryId || '')) next.set(jobId, row.previousEntryId);
      }
      frontier = next;
    }
  } catch { /* An unreadable chain is unknown, never "off". */ }
  for (const jobId of frontier.keys()) found.set(jobId, null);
  return found;
}

/** Adds `reminder` to every projected dispatch job and, for a dispatcher, `moneyReady` to service jobs, plus the money
 * warnings; it also adds the HighLevel chip's ghlTags (withGhlTagStatus), reading each outbox entry once for both.
 * ghlTagRetry is whether the viewer may retry HighLevel tags (retryGhlTags needs dispatch.write; a booker may not).
 * `raws` are the stored jobs the DTOs were projected from (same ids). An unreadable outbox makes those reminders
 * 'unknown' and unreadable money makes moneyReady unchecked; neither fails the board. */
export async function withDispatchReadiness(store, session, raws, jobs, now) {
  const iso = new Date(now).toISOString(), byId = new Map(raws.map(job => [job.id, job])), outbox = store.ghlTagOutbox === true, until = depositWarningDate(iso);
  const starts = new Map(jobs.map(job => [job.id, typeof job.startAt === 'string' ? job.startAt : null]));
  const read = {}, tagged = await withGhlTagStatus(store, jobs, now, read), entries = read.entries || new Map(), unreadable = read.unreadable === true;
  const startFor = job => starts.has(job.id) ? starts.get(job.id) : startOf(job);
  // Reminders-off upcoming visits with an outbox entry and no reminder told yet by their current entry or a browser sync.
  const heads = new Map(outbox && !unreadable ? raws.filter(job => {
    const start = startFor(job);
    return job.notify === false && visit(job) && !TERMINAL.has(state(job)) && start && at(start) > at(iso) && ENTRY_ID.test(job.ghlTagEntry?.id || '') && !syncReminded(job)
      && !(currentEntry(job, start) && hasReminder(entries.get(job.ghlTagEntry.id)?.addTags));
  }).map(job => [job.id, job.ghlTagEntry.id]) : []);
  const earlier = heads.size ? await remindedEarlier(store, heads, entries) : new Map();
  const dispatcher = canDispatch(session), money = dispatcher ? new Map() : null;
  if (money) {
    const ids = [...new Set(raws.filter(moneyVisit).map(job => job.id))];
    try {
      const rows = await readRows(store, 'jobs', ids, MONEY_READY_FIELDS), plans = await planPrices(store, rows);
      for (const row of rows) if (row?.id) money.set(row.id, moneyReadiness({ ...row, id: row.id, type: byId.get(row.id)?.type ?? row.type }, { planCents: plans.get(row.recurringPlanId) ?? null }));
    } catch { for (const id of ids) money.set(id, UNCHECKED); }
  }
  const warnings = [];
  const output = tagged.map(job => {
    const raw = byId.get(job.id);
    if (!raw) return job;
    const startAt = starts.get(job.id), entry = currentEntry(raw, startAt) ? unreadable ? 'unreadable' : entries.get(raw.ghlTagEntry.id) || null : null;
    const reminder = reminderReadiness(raw, { outbox, entry, now: iso, startAt, earlier: outbox && ENTRY_ID.test(raw.ghlTagEntry?.id || '') && unreadable ? null : earlier.has(raw.id) ? earlier.get(raw.id) : false });
    const ready = money && moneyVisit(raw) ? money.get(raw.id) || UNCHECKED : null;
    if (ready) warnings.push(...moneyWarnings(raw, ready, iso, until));
    return { ...job, ...(reminder ? { reminder } : {}), ...(ready ? { moneyReady: ready } : {}) };
  });
  return { jobs: output, warnings, ghlTagRetry: dispatcher };
}
