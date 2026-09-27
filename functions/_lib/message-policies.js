/* One policy per message kind. A send is only possible when the caller's
   trigger, role and approval mode appear here; nothing is inferred. */
import { denverToday, addDays, validDate } from './dispatch-time.js';
import { localInstant } from './operations-portal-records.js';
import { moneyCents } from './operations-financials.js';
import { customerDepositState, customerMoneyState, customerPaymentNeedsReview } from './customer-payments.js';

export const MESSAGE_TIME_ZONE = 'America/Denver';
export const QUIET_HOURS = Object.freeze({ start: '08:00', end: '20:00' });
// Approval modes. Human modes require a preview confirm token bound to the
// exact text and recipient; owner_automation requires an approved template
// plus the owner's per-kind automation switch; customer_initiated is limited
// to a customer's own request (e.g. a sign-in link).
export const HUMAN_APPROVALS = Object.freeze(['template+human_trigger', 'preview_confirm', 'task_approval']);
export const APPROVAL_MODES = Object.freeze([...HUMAN_APPROVALS, 'owner_automation', 'customer_initiated']);

const TERMINAL = new Set(['cancelled','canceled','completed','invoiced','paid','review_requested','closed','noshow','no_show','no-show','superseded']);
const DONE = new Set(['completed','invoiced','paid','review_requested','closed']);
const UNPAYABLE_JOB = new Set(['cancelled','canceled','superseded','lost']);
// A missing status is treated as a draft, as the business hub does.
const UNPAYABLE_INVOICE = new Set(['void','superseded','draft','paid','pending_verification']);
const stage = job => String(job?.pipelineStatus || job?.status || '').toLowerCase();
const accepted = value => ['accepted','approved'].includes(String(value || '').toLowerCase());
const reason = (why) => ({ eligible: false, reason: why });
const ok = { eligible: true };
// Amounts come from the helpers the portal and Stripe checkout use, so a
// message never quotes a figure that checkout would not charge.
export const invoiceBalance = job => moneyCents(customerMoneyState(job).balance);
export const depositDue = job => moneyCents(customerDepositState(job).due);
const scheduled = (job, today) => !TERMINAL.has(stage(job)) && typeof job?.date === 'string' && job.date >= today;

// Only an issued, unpaid invoice on a live job can be sent or chased.
export function payableInvoice(job) {
  if (!job?.invoice?.number) return reason('no_invoice');
  if (UNPAYABLE_JOB.has(stage(job)) || UNPAYABLE_INVOICE.has(String(job.invoice.status || 'draft').toLowerCase())) return reason('invoice_not_payable');
  if (customerPaymentNeedsReview(job)) return reason('payment_needs_review');
  return invoiceBalance(job) > 0 ? ok : reason('nothing_due');
}

// Reminders are keyed to fixed windows counted from a stable anchor (the due
// date or service date), so a person or a daily job gets at most one reminder
// per window. The window start is part of the send key.
export function reminderWindow(anchor, day, days) {
  const base = validDate(anchor) ? anchor : '2026-01-01';
  const offset = Math.round((Date.parse(`${day}T12:00:00Z`) - Date.parse(`${base}T12:00:00Z`)) / 86400000);
  return addDays(base, Math.floor(offset / days) * days);
}

function reminder(kind, { cadenceDays, series, anchor, ...options }) {
  const key = (c, shift = 0) => `${series(c)}:${addDays(reminderWindow(anchor(c), c.keyDay, cadenceDays), shift)}`;
  return policy(kind, { ...options, cadenceDays, dedupe: c => key(c), previousKey: c => key(c, -cadenceDays) });
}

function policy(kind, options) {
  return Object.freeze({
    kind, template: kind, audience: 'customer', target: 'job', triggers: ['hub', 'mcp'], roles: ['dispatcher'], approvals: ['preview_confirm'],
    quietHours: false, maxAttempts: 3, overrides: [], customBody: false, adapterOnly: false, billing: false, cadenceDays: 0, previousKey: null, eligible: () => ok, ...options,
  });
}

export const MESSAGE_POLICIES = Object.freeze({
  on_my_way: policy('on_my_way', {
    roles: ['assigned_crew', 'dispatcher'], approvals: ['template+human_trigger'], overrides: ['etaMinutes'],
    dedupe: c => `on_my_way:${c.job.id}:${c.job.date}`,
    eligible: c => TERMINAL.has(stage(c.job)) ? reason('job_closed') : c.job.date !== c.today ? reason('not_service_day') : ok,
  }),
  day_before_reminder: policy('day_before_reminder', {
    triggers: ['hub', 'mcp', 'cron'], approvals: ['preview_confirm', 'owner_automation'], quietHours: true,
    dedupe: c => `day_before_reminder:${c.job.id}:${c.job.date}:${c.job.time || ''}`,
    eligible: c => !scheduled(c.job, c.today) ? reason('not_upcoming') : c.automated && c.job.date !== addDays(c.today, 1) ? reason('not_tomorrow') : ok,
  }),
  crew_assignment: policy('crew_assignment', {
    audience: 'crew', triggers: ['hub', 'mcp', 'cron'], approvals: ['preview_confirm', 'owner_automation'], quietHours: true, overrides: ['crewId'],
    dedupe: c => `crew_assignment:${c.job.id}:${c.crewId}:${c.job.date}:${c.job.time || ''}`,
    eligible: c => !scheduled(c.job, c.today) ? reason('not_upcoming') : ok,
  }),
  // Billing kinds quote invoice numbers and balances. They are never copied
  // into the customer thread, which assigned crew can read.
  invoice_send: policy('invoice_send', {
    billing: true,
    dedupe: c => `invoice_send:${c.job.id}:${c.job.invoice?.number || ''}:${invoiceBalance(c.job)}:${c.job.invoice?.dueDate || ''}`,
    eligible: c => payableInvoice(c.job),
  }),
  payment_reminder: reminder('payment_reminder', {
    billing: true, triggers: ['hub', 'mcp', 'cron'], approvals: ['preview_confirm', 'owner_automation'], quietHours: true,
    cadenceDays: 7, series: c => `payment_reminder:${c.job.id}:${c.job.invoice?.number || ''}`, anchor: c => c.job.invoice?.dueDate,
    eligible: c => payableInvoice(c.job),
  }),
  deposit_reminder: reminder('deposit_reminder', {
    billing: true, triggers: ['hub', 'mcp', 'cron'], approvals: ['preview_confirm', 'owner_automation'], quietHours: true,
    cadenceDays: 3, series: c => `deposit_reminder:${c.job.id}:${c.job.date || ''}`, anchor: c => c.job.date,
    eligible: c => !accepted(c.job.estimate?.status) ? reason('quote_not_accepted') : !scheduled(c.job, c.today) ? reason('not_upcoming')
      : customerPaymentNeedsReview(c.job) ? reason('payment_needs_review') : customerDepositState(c.job).purpose !== 'deposit' ? reason('balance_due')
      : !(depositDue(c.job) > 0) ? reason('nothing_due') : ok,
  }),
  estimate_expiring: policy('estimate_expiring', {
    triggers: ['hub', 'mcp', 'cron'], approvals: ['preview_confirm', 'owner_automation'], quietHours: true,
    dedupe: c => `estimate_expiring:${c.job.id}:${c.job.estimate?.number || ''}:${c.job.estimate?.validUntil || ''}`,
    eligible: c => !c.job.estimate?.validUntil ? reason('no_estimate') : accepted(c.job.estimate.status) ? reason('estimate_accepted') : c.job.estimate.validUntil < c.today ? reason('estimate_expired') : ok,
  }),
  review_request: policy('review_request', {
    roles: ['business'], triggers: ['hub', 'mcp', 'cron'], approvals: ['preview_confirm', 'owner_automation'], quietHours: true,
    dedupe: c => `review_request:${c.job.id}`,
    eligible: c => !DONE.has(stage(c.job)) ? reason('job_not_complete') : ok,
  }),
  followup_draft: policy('followup_draft', {
    template: 'followup', roles: ['business'], approvals: ['task_approval'], overrides: ['body', 'channel', 'taskId'], customBody: true,
    dedupe: c => `followup:${c.job.id}:${c.overrides.taskId || String(c.bodyHash || '').slice(0, 32)}`,
  }),
  portal_magic_link: policy('portal_magic_link', {
    target: 'account', roles: ['business', 'customer'], triggers: ['hub', 'portal'], approvals: ['preview_confirm', 'customer_initiated'],
    // keyMs is the preview time carried in the signed confirm token, so a
    // confirmed preview keeps its send key across a bucket boundary.
    dedupe: c => `portal_magic_link:${c.account.id}:${Math.floor(c.keyMs / 600000)}`,
  }),
  b2b_invite: policy('b2b_invite', {
    target: 'account', roles: ['business'], triggers: ['hub', 'mcp'],
    dedupe: c => `b2b_invite:${c.account.id}:${c.keyDay}`,
  }),
  // Documents the existing automatic portal invitation on quote acceptance.
  // It keeps running through portal-invitation.js unchanged.
  portal_invitation_adapter: policy('portal_invitation_adapter', {
    template: null, roles: ['business'], triggers: ['portal', 'hub'], approvals: ['customer_initiated'], adapterOnly: true, maxAttempts: 1,
    dedupe: c => `portal_invitation:${c.job.id}`,
  }),
});

export const MESSAGE_KINDS = Object.freeze(Object.keys(MESSAGE_POLICIES));

export function messagePolicy(kind) {
  return typeof kind === 'string' && Object.hasOwn(MESSAGE_POLICIES, kind) ? MESSAGE_POLICIES[kind] : null;
}

function denverClock(now) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: MESSAGE_TIME_ZONE, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now).map(part => [part.type, part.value]));
  return `${parts.hour}:${parts.minute}`;
}

// Automated sends only go out between 08:00 and 20:00 Denver time. Outside
// that window the caller is told when it may try again; nothing is queued.
export function quietHoursDecision(now) {
  const time = denverClock(now), today = denverToday(now);
  if (time >= QUIET_HOURS.start && time < QUIET_HOURS.end) return { allowed: true };
  const date = time < QUIET_HOURS.start ? today : addDays(today, 1);
  return { allowed: false, notBefore: localInstant(date, QUIET_HOURS.start) };
}
