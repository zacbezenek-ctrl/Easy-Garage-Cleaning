import { depositCents } from './quote-model.js';
import { addDays, validDate } from './dispatch-time.js';

// Server-owned proposal. Never selected by an HTTP input or a live flag here.
// The owner confirmed the split and job-day remainder, but not the deposit OR.
export const PROPOSED_25_75 = Object.freeze({
  version: '2026-10-14-deposit25-pending', depositPct: 25, remainderPct: 75,
  depositDueRule: null, remainderDueRule: 'job_day',
});
export const FINAL_25_75 = Object.freeze({ version: '2026-10-14-deposit25-v1', depositPct: 25, remainderPct: 75, depositDueRule: 'later_of_walkthrough_or_seven_days_before_job', remainderDueRule: 'job_day' });
export const PAYMENT_TIME_ZONE = 'America/Denver';
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = (message, code = 'invalid_payment_policy') => Object.assign(new Error(message), { code: `quote_draft_${code}`, status: 409 });
const keys = ['version', 'depositPct', 'remainderPct', 'depositDueRule', 'remainderDueRule'];

export function snapshotQuotePaymentPolicy(value) {
  if (!plain(value) || Object.keys(value).some(key => !keys.includes(key)) ||
    typeof value.version !== 'string' || !/^[A-Za-z0-9_.-]{1,80}$/.test(value.version) ||
    value.depositPct !== 25 || value.remainderPct !== 75 || value.remainderDueRule !== 'job_day' ||
    ![null, 'walkthrough_day', 'seven_days_before_job', 'later_of_walkthrough_or_seven_days_before_job'].includes(value.depositDueRule)) {
    throw fail('The new quote payment policy needs a verified version, 25/75 split and explicit due-date rules.');
  }
  // No OR interpretation is inferred. Selecting a non-null rule requires the
  // owner's clarification and a new policy version before production rollout.
  return Object.fromEntries(keys.map(key => [key, value[key]]));
}

export function quotePaymentSchedule(totalCents, policy) {
  const snapshot = snapshotQuotePaymentPolicy(policy);
  const deposit = depositCents(totalCents, snapshot.depositPct);
  return { policy: snapshot, depositCents: deposit, remainderCents: totalCents - deposit, timingReady: snapshot.depositDueRule !== null };
}

export function requireQuotePaymentTiming(policy) {
  if (policy === undefined) return; // legacy quotes retain their existing flow
  if (snapshotQuotePaymentPolicy(policy).depositDueRule === null) {
    throw fail('The 25% deposit due-date rule is not confirmed. Keep this quote as an internal draft.', 'payment_timing_pending');
  }
}

// Preview only: callers must provide dates from verified internal scheduling.
// This does not create invoices, charge a card, or schedule reminders.
export function quotePaymentDates(policy, { walkthroughDate, jobDate } = {}) {
  requireQuotePaymentTiming(policy);
  const snapshot = snapshotQuotePaymentPolicy(policy);
  jobDate = businessPaymentDate(jobDate); walkthroughDate = businessPaymentDate(walkthroughDate);
  const needsWalkthrough = snapshot.depositDueRule !== 'seven_days_before_job';
  if (!validDate(jobDate) || needsWalkthrough && !validDate(walkthroughDate)) {
    throw fail('Verified walkthrough/job dates are needed to resolve payment dates.', 'payment_dates_pending');
  }
  if (needsWalkthrough && walkthroughDate > jobDate) throw fail('The walkthrough cannot occur after the job date.', 'payment_dates_invalid');
  const weekBefore = addDays(jobDate, -7);
  const depositDueDate = snapshot.depositDueRule === 'walkthrough_day' ? walkthroughDate : snapshot.depositDueRule === 'later_of_walkthrough_or_seven_days_before_job' && walkthroughDate > weekBefore ? walkthroughDate : weekBefore;
  return { depositDueDate, remainderDueDate: jobDate };
}
export function businessPaymentDate(value) {
  if (validDate(value)) return value;
  if (typeof value !== 'string' || !/(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) return null;
  return new Intl.DateTimeFormat('en-CA',{timeZone:PAYMENT_TIME_ZONE,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(value));
}
export function quotePaymentSummary(schedule) {
  return `25% deposit ${new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(schedule.depositCents/100)} due ${schedule.depositDueDate}; 75% remainder ${new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(schedule.remainderCents/100)} due ${schedule.remainderDueDate} (${PAYMENT_TIME_ZONE}).`;
}
export function publicQuotePaymentSchedule(estimate) {
  const s=estimate?.paymentSchedule;
  if(!estimate?.commercialPolicy||!s||!validDate(s.depositDueDate)||!validDate(s.remainderDueDate)||s.timeZone!==PAYMENT_TIME_ZONE||!Number.isSafeInteger(s.depositCents)||!Number.isSafeInteger(s.remainderCents))return null;
  return {depositDueDate:s.depositDueDate,remainderDueDate:s.remainderDueDate,timeZone:PAYMENT_TIME_ZONE,depositCents:s.depositCents,remainderCents:s.remainderCents,policyVersion:s.policyVersion};
}
