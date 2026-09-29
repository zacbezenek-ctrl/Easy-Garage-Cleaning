/* Server-side automatic messages. One bounded tick reads the Hub jobs (the
   only source of truth), selects the reminders that are due and sends each one
   through the approved-send service in owner_automation mode: an
   owner-approved template version, the owner's per-kind automation switch,
   customerAutomationEnabled, notify !== false, Denver quiet hours and the
   message_sends claim-once ledger. Nothing here writes message text or opens a
   second send path. The one send that is not a template is the portal
   invitation that already goes out automatically on quote acceptance; its
   retry moves here from a manager's browser. Every tick leaves a summary in
   the server-only messaging_runs collection, and the day's undeliverable
   items in messaging_holds. */
import { addDays, denverToday, validDate } from './dispatch-time.js';
import { localInstant } from './operations-portal-records.js';
import { MESSAGE_TIME_ZONE, messagePolicy, quietHoursDecision, reminderWindow } from './message-policies.js';
import { LINK_VARIABLES, templateVariables } from './message-templates.js';
import { templateRegistry } from './message-template-store.js';
import { ledgerId } from './message-send-store.js';
import { moneyStateCents } from './money-core.js';
import { customerPaymentNeedsReview } from './customer-payments.js';
import { readMessagingSettings } from './messaging-settings.js';

export const MESSAGING_RUNS = 'messaging_runs';
export const MESSAGING_HOLDS = 'messaging_holds';
export const HOLDS_ID = 'current';
export const CRON_ACTOR_ID = 'messaging-cron-worker';
export const CRON_ACTOR = Object.freeze({ id: CRON_ACTOR_ID, kind: 'system', source: 'cron' });
export const SCHEDULED_KINDS = Object.freeze(['day_before_reminder', 'deposit_reminder', 'payment_reminder', 'estimate_expiring']);
// The only job fields the scheduler reads. Money and contact fields feed the
// same helpers the portal and checkout use; nothing else leaves storage.
// changeOrders carries the billed change-order lines (change-orders.js): the
// checkout balance (customerMoneyState) bills them, so without them a change
// money-core counts would read as a money_mismatch and never be reminded.
export const SCHEDULER_JOB_FIELDS = Object.freeze([
  'type','recordType','date','time','status','pipelineStatus','notify','customerAutomationEnabled','phone','email',
  'estimate','invoice','payment','deposit','total','priceQuoted','lockedTotal','rate','customerApproval.amount','customerDecisions','approvedChangeTotal','changeOrders',
  'giftWallet.redemptions','refunds','completedAt','postJobChecklist.completedAt','postJobProgress.standardItems',
  'customerPortalInvitationRequestedAt','customerPortalInvitation','communicationLog','automationMilestones',
]);
// Cost model in Cloudflare subrequests, as in /api/messages: an item starts
// only when a whole send fits and a claim only when its provider call and
// ledger write still fit, so nothing is stranded in 'sending'.
export const ITEM_COST = 20;
export const CLAIM_COST = 8;
const PORTAL_COST = 12;
// Kept back after the last item: the holds write, the run summary's read and
// commit in the handler, and one spare.
const HOLD_COST = 1;
const RUN_COST = 2;
const FINISH_COST = HOLD_COST + RUN_COST + 1;
const HOLD_LIMIT = 200;
const CALLS_PER_SEND = 4;
const PORTAL_MAX_ATTEMPTS = 5;
const PORTAL_RETRY_AFTER_MS = 10 * 60000;
const DAY_MS = 86400000;
const RESULT_LIMIT = 60;
const PRIORITY = { day_before_reminder: 0, portal_invitation: 1, crew_assignment: 2, deposit_reminder: 3, payment_reminder: 4, estimate_expiring: 5 };
const TERMINAL = new Set(['cancelled','canceled','completed','invoiced','paid','review_requested','closed','noshow','no_show','no-show','superseded','lost']);
// A dispatch no-show (FUN-02) stops automatic payment and estimate reminders like a cancel; staff collect any fee by hand.
const UNPAYABLE_JOB = new Set(['cancelled','canceled','superseded','lost','noshow','no_show','no-show']);
const UNPAYABLE_INVOICE = new Set(['void','superseded','draft','paid','pending_verification']);
const CLOSED_ESTIMATE = new Set(['accepted','approved','draft','declined','rejected','superseded','void','expired','cancelled','canceled','lost']);
const PORTAL_HELD = new Set(['submitted','sending','uncertain','suppressed','contact_mismatch']);
const HELD = new Set(['submitted','uncertain','sending']);
const SENT = new Set(['submitted','failed','uncertain','dry_run']);
const NOT_READY = new Set(['messaging_template_not_approved','messaging_automation_disabled','messaging_disabled']);
// The Hub's legacy page-load trigger marks these events per anchor; the tick
// sets the same marker so turning server messaging off never repeats them,
// and reads it so turning server messaging on never repeats a legacy send.
const LEGACY_MILESTONES = { estimate_expiring: 'estimate-expiring', payment_reminder: 'invoice-overdue' };
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const safeId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,180}$/.test(value) && !/^(secure_|_egc_)/.test(value);
const stage = job => String(job?.pipelineStatus || job?.status || '').toLowerCase();
const accepted = value => ['accepted','approved'].includes(String(value || '').toLowerCase());
const reachable = job => String(job.phone || '').replace(/\D/g, '').length >= 10 || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(job.email || '').trim());
const fail = (code, message, status = 503) => Object.assign(new Error(message), { code, status });
const safeCode = value => /^[a-z][a-z0-9_]{0,63}$/.test(String(value || '')) ? String(value) : '';
const itemKey = item => `${item.kind}:${item.jobId}:${item.anchor}:${item.step}`;

function denverClock(now) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: MESSAGE_TIME_ZONE, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now).map(part => [part.type, part.value]));
  return `${parts.hour}:${parts.minute}`;
}

// A stage is due from anchor+offset until the end of the policy's cadence
// window that contains that day, so each stage maps to one claim-once key and
// a tick that missed the first day still catches up inside the window.
export function stageDue(anchor, today, offsets, cadenceDays) {
  let due = null;
  for (const offset of offsets) {
    const start = addDays(anchor, offset);
    if (start && today >= start && reminderWindow(anchor, today, cadenceDays) === reminderWindow(anchor, start, cadenceDays)) due = offset;
  }
  return due;
}

// A legacy page-load reminder for this anchor. `sent` when its automatic log
// entry is there, or its milestone marker is and the tick has not sent this
// kind itself (the tick sets the same marker; its own sends are found in the
// ledger instead). `at` is the latest legacy trigger of the event, including a
// manager's manual one, so the next server reminder keeps the cadence after it.
function legacyReminder(job, kind, anchor) {
  const event = LEGACY_MILESTONES[kind], log = Array.isArray(job.communicationLog) ? job.communicationLog : [], automatic = `communication:${job.id}:${event}:${anchor}`;
  const triggered = log.filter(entry => [automatic, `communication:${job.id}:${event}:manual`].includes(entry?.id) && entry.status === 'triggered');
  const times = triggered.map(entry => Date.parse(entry.attemptedAt || '')).filter(Number.isFinite);
  const marked = plain(job.automationMilestones) && job.automationMilestones[event] === anchor && !log.some(entry => entry?.event === kind && entry.source === 'cron' && HELD.has(entry.status));
  return { sent: marked || triggered.some(entry => entry.id === automatic), at: times.length ? Math.max(...times) : null };
}

// The send path re-checks eligibility with the helpers the portal and
// checkout use. A job they would refuse is reported here instead of being
// selected, and refused, on every tick: for example an approved change order
// that money-core counts but the checkout balance does not.
function refusal(kind, job, today) {
  const result = messagePolicy(kind).eligible({ job, today, automated: true });
  return result.eligible ? '' : result.reason === 'nothing_due' ? 'money_mismatch' : safeCode(result.reason) || 'not_eligible';
}

// Kind-specific rules. Only suppressions of a message that would otherwise be
// due are counted, so the run summary explains them without listing history.
function candidates(job, { today, tomorrow, nowMs, settings, kinds, skip }) {
  const found = [], status = stage(job), add = (kind, anchor, step) => found.push({ kind, jobId: job.id, anchor, step });
  if (kinds.has('day_before_reminder') && job.date === tomorrow && !TERMINAL.has(status)) {
    if (localInstant(job.date, job.time)) add('day_before_reminder', job.date, -1); else skip('no_valid_start_time');
  }
  // Balances come from money-core in integer cents, so reminders stop the
  // tick after the balance reaches zero; a payment awaiting verification is
  // never chased.
  const invoice = plain(job.invoice) ? job.invoice : null;
  const open = invoice?.number && validDate(invoice.dueDate) && !UNPAYABLE_JOB.has(status) && !UNPAYABLE_INVOICE.has(String(invoice.status || 'draft').toLowerCase());
  const payStep = kinds.has('payment_reminder') && open ? stageDue(invoice.dueDate, today, settings.paymentReminderDays, messagePolicy('payment_reminder').cadenceDays) : null;
  if (payStep !== null) {
    const money = moneyStateCents(job);
    if (customerPaymentNeedsReview(job)) skip('payment_needs_review');
    else if (money.balanceCents === null) skip('money_unknown');
    else if (money.balanceCents > 0) {
      // A legacy overdue reminder stands in for the first stage.
      const refused = refusal('payment_reminder', job, today), legacy = legacyReminder(job, 'payment_reminder', invoice.dueDate);
      if (refused) skip(refused);
      else if (legacy.sent && payStep === settings.paymentReminderDays[0]) skip('legacy_sent');
      else if (legacy.at !== null && legacy.at + messagePolicy('payment_reminder').cadenceDays * DAY_MS > nowMs) skip('legacy_cadence');
      else add('payment_reminder', invoice.dueDate, payStep);
    }
  }
  const depositStep = kinds.has('deposit_reminder') && accepted(job.estimate?.status) && validDate(job.date) && job.date > today && !TERMINAL.has(status)
    ? stageDue(job.date, today, settings.depositReminderDaysBefore.map(day => -day), messagePolicy('deposit_reminder').cadenceDays) : null;
  if (depositStep !== null) {
    const money = moneyStateCents(job);
    if (customerPaymentNeedsReview(job)) skip('payment_needs_review');
    else if (money.depositDueCents === null) skip('money_unknown');
    else if (money.purpose === 'deposit' && money.depositDueCents > 0) {
      const refused = refusal('deposit_reminder', job, today);
      if (refused) skip(refused); else add('deposit_reminder', job.date, depositStep);
    }
  }
  const validUntil = job.estimate?.validUntil;
  if (kinds.has('estimate_expiring') && validDate(validUntil) && !CLOSED_ESTIMATE.has(String(job.estimate.status || '').toLowerCase()) && !UNPAYABLE_JOB.has(status)
    && today >= addDays(validUntil, -settings.estimateExpiringDaysBefore) && today <= validUntil) {
    if (legacyReminder(job, 'estimate_expiring', validUntil).sent) skip('legacy_sent');
    else add('estimate_expiring', validUntil, -settings.estimateExpiringDaysBefore);
  }
  return found;
}

/** Pure selection of due scheduled messages. `kinds` limits it to the kinds
 * whose approved template is set to send automatically. */
export function dueMessages(jobs, { now, settings, kinds = new Set(SCHEDULED_KINDS) }) {
  const at = new Date(now), today = denverToday(at), tomorrow = addDays(today, 1), due = [], skipped = {};
  const skip = reason => { skipped[reason] = (skipped[reason] || 0) + 1; };
  for (const job of Array.isArray(jobs) ? jobs : []) {
    if (!safeId(job?.id) || job.recordType || job.type !== 'job') continue;
    const found = candidates(job, { today, tomorrow, nowMs: at.getTime(), settings, kinds, skip });
    if (!found.length) continue;
    // Gates shared by every automatic customer message. The approved-send
    // service checks them again against a fresh read before it claims.
    const gate = job.notify === false ? 'job_notifications_off' : job.customerAutomationEnabled !== true ? 'customer_automation_off' : !reachable(job) ? 'no_contact' : '';
    for (const item of found) if (gate) skip(gate); else due.push(item);
  }
  return { today, due: due.sort(order), skipped };
}

/** The legacy browser rule for retrying the automatic portal invitation. */
export function portalRetries(jobs, { now }) {
  const nowMs = new Date(now).getTime();
  return (Array.isArray(jobs) ? jobs : []).filter(job => {
    if (!safeId(job?.id) || job.recordType || job.type !== 'job' || !job.customerPortalInvitationRequestedAt || !accepted(job.estimate?.status) || job.notify === false) return false;
    const state = job.customerPortalInvitation?.jobId === job.id ? job.customerPortalInvitation : null;
    return !PORTAL_HELD.has(state?.status) && Number(state?.attempts || 0) < PORTAL_MAX_ATTEMPTS && nowMs - (Date.parse(state?.attemptedAt || '') || 0) > PORTAL_RETRY_AFTER_MS;
  }).map(job => ({ kind: 'portal_invitation', jobId: job.id, anchor: '', step: 0 })).sort(order);
}

function order(left, right) {
  return PRIORITY[left.kind] - PRIORITY[right.kind] || String(left.anchor).localeCompare(String(right.anchor)) || left.jobId.localeCompare(right.jobId);
}

// The approved-send display copy on the job lets a tick skip a message that
// is already handled without reading the ledger. It is only a shortcut: when
// the copy is missing, the ledger claim in the send path still decides.
async function mirrored(job, key) {
  const id = `msg:${(await ledgerId(key)).slice(0, 32)}`;
  return (Array.isArray(job.communicationLog) ? job.communicationLog : []).find(entry => entry?.id === id) || null;
}

async function handled(item, job, nowMs, flags) {
  const policy = messagePolicy(item.kind), ctx = { job, keyDay: denverToday(new Date(nowMs)), keyMs: nowMs, crewId: '', overrides: {}, bodyHash: '' };
  const entry = await mirrored(job, policy.dedupe(ctx));
  if (HELD.has(entry?.status)) return { status: entry.status === 'submitted' ? 'already_sent' : entry.status, reason: 'ledger_mirror' };
  if (entry?.status === 'dry_run' && flags.dryRun) return { status: 'dry_run', reason: 'ledger_mirror' };
  if (entry?.status === 'failed' && Number(entry.attempt || 0) >= policy.maxAttempts) return { status: 'attempts_exhausted', reason: 'ledger_mirror' };
  if (policy.cadenceDays) {
    const previous = await mirrored(job, policy.previousKey(ctx)), last = Date.parse(previous?.attemptedAt || '');
    if (HELD.has(previous?.status) && Number.isFinite(last) && last + policy.cadenceDays * DAY_MS > nowMs) return { status: 'deferred', reason: 'reminder_cadence' };
  }
  return null;
}

// Dry runs preview even while delivery is switched off, so the owner can see
// what would go out before turning anything on.
async function kindReadiness(kinds, { templates, flags, links, dryRun }) {
  const state = {};
  for (const kind of kinds) {
    if (!flags.enabled && !dryRun) { state[kind] = 'messaging_disabled'; continue; }
    const template = await templates.active(messagePolicy(kind).template);
    const needed = template ? [...templateVariables(template.subject || ''), ...templateVariables(template.body)].filter(name => LINK_VARIABLES.includes(name)) : [];
    state[kind] = !template ? 'template_not_approved' : template.automationEnabled !== true ? 'automation_off' : needed.some(name => typeof links[name] !== 'function') ? 'link_provider_missing' : 'ready';
  }
  return state;
}

async function markLegacyMilestone(store, item) {
  const event = LEGACY_MILESTONES[item.kind];
  if (!event) return;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const job = await store.read('jobs', item.jobId), milestones = plain(job?.automationMilestones) ? job.automationMilestones : {};
      if (!job || milestones[event] === item.anchor) return;
      await store.commit([{ collection: 'jobs', id: item.jobId, revision: job.revision, patch: { automationMilestones: { ...milestones, [event]: item.anchor } } }]);
      return;
    } catch { /* A marker only; the send ledger already holds the message. */ }
  }
}

// Outcomes that never reach the send ledger (a do-not-disturb or missing
// contact, a refused eligibility check, wording too long for SMS, an error)
// would otherwise be retried first on every tick and spend the subrequest
// budget before anything deliverable. For the rest of the Denver day they are
// held behind every other item; the next day they are tried in order again.
// The record only orders items, so a lost read or write changes nothing else.
async function readHolds(store, today) {
  try {
    const doc = await store.read(MESSAGING_HOLDS, HOLDS_ID), entries = doc?.day === today && Array.isArray(doc.entries) ? doc.entries : [];
    return { revision: doc?.revision || '', changed: false, entries: new Map(entries.filter(entry => typeof entry?.key === 'string').map(entry => [entry.key, entry])) };
  } catch {
    return { revision: null, changed: false, entries: new Map() };
  }
}

async function saveHolds(store, holds, today, at) {
  if (!holds.changed || holds.revision === null) return;
  const entries = [...holds.entries.values()].slice(-HOLD_LIMIT);
  try {
    await store.commit([{ collection: MESSAGING_HOLDS, id: HOLDS_ID, ...(holds.revision ? { revision: holds.revision } : {}), patch: { day: today, entries, updatedAt: at } }]);
  } catch { /* A concurrent tick saved its own holds; the order is only a hint. */ }
}

function failure(error) {
  const code = /^messaging_[a-z_]+$/.test(error?.code || '') ? error.code : 'messaging_unavailable';
  if (code === 'messaging_not_attempted') return { status: 'not_attempted', reason: 'subrequest_budget' };
  if (code === 'messaging_not_eligible') return { status: 'not_eligible', reason: safeCode(error.details?.reason) || code };
  if (NOT_READY.has(code)) return { status: 'not_ready', reason: code };
  return { status: 'error', reason: safeCode(error?.details?.reason) || code };
}

/** One bounded tick. deps: {store, service (approved-send), flags, links,
 * portalInvite(jobId), crewOutbox, budget(), charge(cost)}. */
export async function runDueMessages(deps, { now, dryRun = false, requestId } = {}) {
  const { store, service, flags = { enabled: false, dryRun: true }, links = {}, portalInvite = null, crewOutbox = null, budget = () => Infinity, charge = () => {} } = deps;
  const templates = deps.templates || templateRegistry(store);
  const at = now instanceof Date ? now : new Date(now), nowMs = at.getTime();
  if (!Number.isFinite(nowMs)) throw fail('messaging_clock_invalid', 'The scheduler needs a valid current time.', 500);
  const settings = await readMessagingSettings(store);
  const summary = {
    at: at.toISOString(), today: denverToday(at), dryRun, delivery: { enabled: flags.enabled === true, dryRun: flags.dryRun !== false },
    settings: { source: settings.source, paused: settings.paused }, kinds: {}, scanned: 0, due: 0, attempted: 0, sent: 0, limit: settings.maxSendsPerTick,
    limitReached: false, budgetExhausted: false, held: 0, counts: {}, byKind: {}, skipped: {}, crewOutbox: crewOutbox ? 'configured' : 'not_configured', results: [],
  };
  if (settings.paused) return { ...summary, paused: true };
  // Nothing may reach a customer overnight, so the tick does not even scan.
  const quiet = quietHoursDecision(at);
  if (!quiet.allowed) return { ...summary, deferred: 'quiet_hours', notBefore: quiet.notBefore };
  summary.kinds = await kindReadiness([...SCHEDULED_KINDS, ...(crewOutbox ? ['crew_assignment'] : [])], { templates, flags, links, dryRun });
  summary.kinds.portal_invitation = portalInvite ? 'ready' : 'not_configured';
  const ready = new Set(Object.keys(summary.kinds).filter(kind => summary.kinds[kind] === 'ready' && kind !== 'portal_invitation'));
  if (!ready.size && !portalInvite) return summary;
  const jobs = await store.jobRecords([...SCHEDULER_JOB_FIELDS]), byId = new Map(jobs.map(job => [job.id, job]));
  const selected = dueMessages(jobs, { now: at, settings, kinds: ready });
  const crew = ready.has('crew_assignment') ? (await crewOutbox.pending(settings.maxSendsPerTick * 2)).filter(entry => safeId(entry?.jobId) && byId.has(entry.jobId)).map(entry => ({ kind: 'crew_assignment', jobId: entry.jobId, anchor: '', step: 0, entry })) : [];
  const holds = await readHolds(store, summary.today), heldLast = item => holds.entries.has(itemKey(item)) ? 1 : 0;
  const items = [...selected.due, ...(portalInvite ? portalRetries(jobs, { now: at }) : []), ...crew].sort((left, right) => heldLast(left) - heldLast(right) || order(left, right));
  Object.assign(summary, { scanned: jobs.length, due: items.length, held: items.filter(heldLast).length, skipped: selected.skipped });
  const clock = denverClock(at), window = settings.dayBeforeWindow, outcomes = [];
  let calls = 0;
  for (const item of items) {
    const job = byId.get(item.jobId), record = outcome => { outcomes.push({ ...item, ...outcome }); return outcome; };
    if (summary.sent >= settings.maxSendsPerTick) { summary.limitReached = true; record({ status: 'not_attempted', reason: 'tick_limit' }); continue; }
    if (calls >= settings.maxSendsPerTick * CALLS_PER_SEND) { summary.limitReached = true; record({ status: 'not_attempted', reason: 'call_limit' }); continue; }
    if (item.kind === 'day_before_reminder' && (clock < window.start || clock >= window.end)) { record({ status: 'deferred', reason: 'send_window' }); continue; }
    const approved = item.kind !== 'portal_invitation';
    if (approved && item.kind !== 'crew_assignment') { const shortcut = await handled(item, job, nowMs, flags); if (shortcut) { record(shortcut); continue; } }
    if (budget() < (approved ? ITEM_COST : PORTAL_COST) + FINISH_COST) { summary.budgetExhausted = true; record({ status: 'not_attempted', reason: 'subrequest_budget' }); continue; }
    calls += 1; summary.attempted += 1;
    const input = { kind: item.kind, jobId: item.jobId, ...(item.entry ? { overrides: { crewId: item.entry.crewId } } : {}) };
    let outcome;
    try {
      if (dryRun) {
        if (!approved) outcome = { status: 'would_retry' };
        else { const preview = await service.preview(CRON_ACTOR, input); outcome = { status: preview.status === 'ready' ? 'would_send' : safeCode(preview.status) || 'unknown', reason: safeCode(preview.reason) }; }
      } else if (!approved) {
        charge(PORTAL_COST);
        const state = await portalInvite(item.jobId, at);
        outcome = { status: safeCode(state?.status) || 'unknown', reason: safeCode(state?.reason), sent: SENT.has(state?.status) };
      } else {
        const result = await service.send(CRON_ACTOR, { ...input, ...(requestId ? { requestId } : {}) });
        outcome = { status: safeCode(result.status) || 'unknown', reason: safeCode(result.reason), sent: SENT.has(result.status) && result.alreadyRecorded !== true };
        if (outcome.sent && ['submitted', 'uncertain'].includes(result.status)) await markLegacyMilestone(store, item);
      }
    } catch (error) {
      outcome = failure(error);
      if (outcome.status === 'not_attempted') summary.budgetExhausted = true;
    }
    if (outcome.status === 'would_send' || outcome.status === 'would_retry') outcome.sent = true;
    if (outcome.sent) summary.sent += 1;
    if (!dryRun && outcome.status !== 'not_attempted') {
      const key = itemKey(item), had = holds.entries.delete(key);
      if (!outcome.sent) holds.entries.set(key, { key, status: outcome.status, reason: outcome.reason || '', at: at.toISOString() });
      holds.changed ||= had || !outcome.sent;
    }
    if (item.entry && !dryRun) await crewOutbox.complete(item.entry, { status: outcome.status, reason: outcome.reason || '', at: at.toISOString() }).catch(() => {});
    record(outcome);
  }
  if (budget() >= HOLD_COST + RUN_COST) await saveHolds(store, holds, summary.today, at.toISOString());
  for (const row of outcomes) {
    summary.counts[row.status] = (summary.counts[row.status] || 0) + 1;
    const kind = summary.byKind[row.kind] ||= { due: 0, sent: 0 };
    kind.due += 1;
    if (row.sent) kind.sent += 1;
  }
  summary.results = outcomes.slice(0, RESULT_LIMIT).map(({ kind, jobId, anchor, step, status, reason }) => ({ kind, jobId, anchor, step, status, ...(reason ? { reason } : {}) }));
  return summary;
}

/** Claims messaging_runs/{runId} create-only before any work. */
export async function startRun(store, { runId, attemptId, fingerprint, actorId, dryRun, at }) {
  const existing = await store.read(MESSAGING_RUNS, runId);
  if (existing) return { existing };
  try {
    await store.commit([{ collection: MESSAGING_RUNS, id: runId, patch: { runId, attemptId, fingerprint, actorId, dryRun, status: 'running', startedAt: at, completedAt: '', code: '', summary: null } }]);
  } catch (error) {
    // A lost commit response may still have created the claim for this attempt.
    const latest = await store.read(MESSAGING_RUNS, runId).catch(() => null);
    if (latest?.attemptId === attemptId) return { started: true };
    if (latest) return { existing: latest };
    throw error;
  }
  return { started: true };
}

/** Records the outcome. A lost summary never repeats a send: the ledger holds it. */
export async function finishRun(store, runId, attemptId, patch) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const latest = await store.read(MESSAGING_RUNS, runId);
      if (latest?.attemptId !== attemptId) return false;
      await store.commit([{ collection: MESSAGING_RUNS, id: runId, revision: latest.revision, patch }]);
      return true;
    } catch { /* Retry the summary write only. */ }
  }
  return false;
}
