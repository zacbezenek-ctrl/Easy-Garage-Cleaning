import { MAX_TOTAL_CENTS, depositCents, exactCents } from './quote-model.js';
import { addDays, validDate } from './dispatch-time.js';

// Server-owned proposal. Never selected by an HTTP input or a live flag here.
// The owner confirmed the split and job-day remainder, but not the deposit OR.
export const PROPOSED_25_75 = Object.freeze({
  version: '2026-10-14-deposit25-pending', depositPct: 25, remainderPct: 75,
  depositDueRule: null, remainderDueRule: 'job_day',
});
export const FINAL_25_75 = Object.freeze({ version: '2026-10-14-deposit25-v1', depositPct: 25, remainderPct: 75, depositDueRule: 'later_of_walkthrough_or_seven_days_before_job', remainderDueRule: 'job_day' });
// D-DEPOSIT (owner, 2026-10-18): a quote the homeowner signs in person on the walkthrough Review step takes the same
// 25/75 split, with the 25% deposit due the day they sign (the walkthrough day: now) and the 75% remainder on the job
// day. Both dates are exact: the estimator books the job time when the homeowner signs. Its version is the terms id the
// walkthrough page shows and sends (terms_version); a job keeps the terms it was signed on (2026-09-deposit50: 50%
// upfront, the rest on completion, is never offered again).
export const SIGNED_25_75 = Object.freeze({ version: '2026-10-deposit25', depositPct: 25, remainderPct: 75, depositDueRule: 'walkthrough_day', remainderDueRule: 'job_day' });
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
// The split a schedule states, in whole percents of its total: 25/75 by the policy, or more upfront when a job signed
// again had already been paid more than the new 25% deposit (walkthrough-handoff.js signedPaymentTerms). Every customer
// surface names the deposit and remainder by it, so the labels always match the amounts.
export function scheduleSplit(schedule) {
  const total = schedule.depositCents + schedule.remainderCents, deposit = total > 0 ? Math.round(schedule.depositCents * 100 / total) : 0;
  return { depositPct: deposit, remainderPct: 100 - deposit };
}
export function quotePaymentSummary(schedule) {
  const split = scheduleSplit(schedule);
  return `${split.depositPct}% deposit ${new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(schedule.depositCents/100)} due ${schedule.depositDueDate}; ${split.remainderPct}% remainder ${new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(schedule.remainderCents/100)} due ${schedule.remainderDueDate} (${PAYMENT_TIME_ZONE}).`;
}
// The saved schedule a customer surface may show. It fails closed: only while it is still the estimate's own split, its
// deposit the estimate's deposit and the two parts its total (estimate.amount and amountCents, depositRequired and
// depositRequiredCents, whichever are saved, must all agree). An estimate changed after the schedule was saved (the Hub's
// legacy estimate editor writes a new amount and deposit and keeps the rest) shows no schedule, so no surface states two
// different deposits or remainders.
export function publicQuotePaymentSchedule(estimate) {
  const s=estimate?.paymentSchedule;
  if(!estimate?.commercialPolicy||!s||!validDate(s.depositDueDate)||!validDate(s.remainderDueDate)||s.timeZone!==PAYMENT_TIME_ZONE||!Number.isSafeInteger(s.depositCents)||!Number.isSafeInteger(s.remainderCents)||s.depositCents<0||s.remainderCents<0)return null;
  const saved=(dollars,cents)=>[dollars===undefined||dollars===null?undefined:exactCents(dollars,MAX_TOTAL_CENTS),cents===undefined||cents===null?undefined:cents].filter(value=>value!==undefined);
  const totals=saved(estimate.amount,estimate.amountCents),deposits=saved(estimate.depositRequired,estimate.depositRequiredCents);
  if(!totals.length||!deposits.length||totals.some(value=>value!==s.depositCents+s.remainderCents)||deposits.some(value=>value!==s.depositCents))return null;
  return {depositDueDate:s.depositDueDate,remainderDueDate:s.remainderDueDate,timeZone:PAYMENT_TIME_ZONE,depositCents:s.depositCents,remainderCents:s.remainderCents,policyVersion:s.policyVersion};
}
// The 25/75 terms a quote was sent or signed on (estimate.commercialPolicy), without any amount, for a customer surface
// that withholds the quote (quote-model.js unsentQuoteDraft: a signed job held for the owner's prices, or a sent quote's
// unsent revision): the split (its saved schedule's, else the policy's) and, when the schedule names it, the job day the
// remainder is due. null for a quote on any other terms: legacy jobs keep their own wording.
export function withheldQuotePaymentSummary(estimate) {
  let policy;
  try { policy = snapshotQuotePaymentPolicy(estimate?.commercialPolicy); } catch { return null; }
  const s = plain(estimate?.paymentSchedule) ? estimate.paymentSchedule : null, day = s && s.timeZone === PAYMENT_TIME_ZONE && validDate(s.remainderDueDate) ? s.remainderDueDate : '';
  const split = s && Number.isSafeInteger(s.depositCents) && Number.isSafeInteger(s.remainderCents) && s.depositCents >= 0 && s.remainderCents >= 0 && s.depositCents + s.remainderCents > 0 ? scheduleSplit(s) : policy;
  return { version: policy.version, text: `${split.depositPct}% deposit; ${split.remainderPct}% remainder due on the job day${day ? ` ${day} (${PAYMENT_TIME_ZONE})` : ''}. The amounts are shown when your estimate is sent to you, and nothing is due before then.` };
}
// A payment due date (YYYY-MM-DD, a Denver business day) as the customer reads it: "Tuesday, October 20, 2026".
export const paymentDateLabel = date => new Intl.DateTimeFormat('en-US', { timeZone: PAYMENT_TIME_ZONE, weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }).format(new Date(`${date}T12:00:00Z`));
