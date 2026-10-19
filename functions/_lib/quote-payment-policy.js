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
// D-DEPOSIT for a quote an estimator sends instead of having it signed on the spot (owner, 2026-10-18 evening): the 25%
// deposit is due when the customer approves it (approval_day: the Denver day of the approval, never after the job day) and
// the 75% remainder on the job day, an exact date (the send still waits for a booked job). Every quote sent from now on
// is sent on it (sentQuotePaymentPolicy below, quote-draft.js sendingEstimate): a new quote, an unsent saved draft and a
// new revision of a quote sent earlier. A quote already sent on FINAL_25_75 (or the pending variant) keeps its saved terms
// and dates until a revision of it is sent. Its saved schedule has no deposit date (depositDueDate null): publicQuotePaymentSchedule dates
// the deposit by the approval once there is one.
export const SENT_25_75 = Object.freeze({ version: '2026-10-19-deposit25-on-approval', depositPct: 25, remainderPct: 75, depositDueRule: 'approval_day', remainderDueRule: 'job_day' });
export const PAYMENT_TIME_ZONE = 'America/Denver';
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = (message, code = 'invalid_payment_policy') => Object.assign(new Error(message), { code: `quote_draft_${code}`, status: 409 });
const keys = ['version', 'depositPct', 'remainderPct', 'depositDueRule', 'remainderDueRule'];

export function snapshotQuotePaymentPolicy(value) {
  if (!plain(value) || Object.keys(value).some(key => !keys.includes(key)) ||
    typeof value.version !== 'string' || !/^[A-Za-z0-9_.-]{1,80}$/.test(value.version) ||
    value.depositPct !== 25 || value.remainderPct !== 75 || value.remainderDueRule !== 'job_day' ||
    ![null, 'walkthrough_day', 'approval_day', 'seven_days_before_job', 'later_of_walkthrough_or_seven_days_before_job'].includes(value.depositDueRule) ||
    // The sent-quote terms of 2026-10-19 exist only with their own explicit rule: the deposit due on approval.
    value.version === SENT_25_75.version && value.depositDueRule !== SENT_25_75.depositDueRule) {
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
// approval_day (SENT_25_75) needs only the job date: the deposit is due the Denver day of approvalDate (an ISO instant
// or a Denver date), never after the job day, and has no date (null: due when the customer approves) before then.
export function quotePaymentDates(policy, { walkthroughDate, jobDate, approvalDate } = {}) {
  requireQuotePaymentTiming(policy);
  const snapshot = snapshotQuotePaymentPolicy(policy);
  jobDate = businessPaymentDate(jobDate); walkthroughDate = businessPaymentDate(walkthroughDate);
  if (snapshot.depositDueRule === 'approval_day') {
    if (!validDate(jobDate)) throw fail('A booked job date is needed: the 75% remainder is due on the job day.', 'payment_dates_pending');
    const approved = businessPaymentDate(approvalDate);
    return { depositDueDate: approved ? approved > jobDate ? jobDate : approved : null, remainderDueDate: jobDate };
  }
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
// A deposit due on approval (SENT_25_75, publicQuotePaymentSchedule depositDueOn) is "due on approval", with the
// approval's day once there is one.
export function quotePaymentSummary(schedule) {
  const split = scheduleSplit(schedule), deposit = schedule.depositDueOn === 'approval' ? `on approval${schedule.depositDueDate ? ` (${schedule.depositDueDate})` : ''}` : schedule.depositDueDate;
  return `${split.depositPct}% deposit ${new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(schedule.depositCents/100)} due ${deposit}; ${split.remainderPct}% remainder ${new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(schedule.remainderCents/100)} due ${schedule.remainderDueDate} (${PAYMENT_TIME_ZONE}).`;
}
// The saved schedule a customer surface may show. It fails closed: only while it is still the estimate's own split, its
// deposit the estimate's deposit and the two parts its total (estimate.amount and amountCents, depositRequired and
// depositRequiredCents, whichever are saved, must all agree). An estimate changed after the schedule was saved (the Hub's
// legacy estimate editor writes a new amount and deposit and keeps the rest) shows no schedule, so no surface states two
// different deposits or remainders. A quote sent on SENT_25_75 saved no deposit date (null): its deposit is due on approval
// (depositDueOn 'approval'), dated the Denver day the estimate was approved (acceptedAt, never after the job day) once it
// is, and null (due when the customer approves) before then. The saved schedule itself is never rewritten.
export const approvalDueDate = (estimate, jobDay) => {
  if (!['accepted', 'approved'].includes(String(estimate?.status || '').toLowerCase())) return null;
  const day = businessPaymentDate(estimate.acceptedAt);
  return day ? day > jobDay ? jobDay : day : null;
};
export function publicQuotePaymentSchedule(estimate) {
  const s=estimate?.paymentSchedule,onApproval=estimate?.commercialPolicy?.depositDueRule==='approval_day';
  if(!estimate?.commercialPolicy||!s||!(onApproval?s.depositDueDate===null:validDate(s.depositDueDate))||!validDate(s.remainderDueDate)||s.timeZone!==PAYMENT_TIME_ZONE||!Number.isSafeInteger(s.depositCents)||!Number.isSafeInteger(s.remainderCents)||s.depositCents<0||s.remainderCents<0)return null;
  const saved=(dollars,cents)=>[dollars===undefined||dollars===null?undefined:exactCents(dollars,MAX_TOTAL_CENTS),cents===undefined||cents===null?undefined:cents].filter(value=>value!==undefined);
  const totals=saved(estimate.amount,estimate.amountCents),deposits=saved(estimate.depositRequired,estimate.depositRequiredCents);
  if(!totals.length||!deposits.length||totals.some(value=>value!==s.depositCents+s.remainderCents)||deposits.some(value=>value!==s.depositCents))return null;
  return {depositDueDate:onApproval?approvalDueDate(estimate,s.remainderDueDate):s.depositDueDate,...(onApproval?{depositDueOn:'approval'}:{}),remainderDueDate:s.remainderDueDate,timeZone:PAYMENT_TIME_ZONE,depositCents:s.depositCents,remainderCents:s.remainderCents,policyVersion:s.policyVersion};
}
// The terms a quote is sent on from 2026-10-19: a quote saved on the earlier sent-quote terms (FINAL_25_75, or the pending
// variant) is sent on SENT_25_75; any other policy (SENT_25_75 itself, an in-person signature's, none) is its own.
export const sentQuotePaymentPolicy = policy => [FINAL_25_75.version, PROPOSED_25_75.version].includes(policy?.version) ? SENT_25_75 : policy;
// The 25/75 terms a quote was sent or signed on (estimate.commercialPolicy), without any amount, for a customer surface
// that withholds the quote (quote-model.js unsentQuoteDraft: a signed job held for the owner's prices, or a sent quote's
// unsent revision): the split (its saved schedule's, else the policy's) and, when the schedule names it, the job day the
// remainder is due. A deposit due on approval (SENT_25_75) says so. null for a quote on any other terms: legacy jobs keep
// their own wording.
// signed: a job the homeowner signed in person and held for the owner's prices: it is booked, the team is confirming its
// prices, and nothing is due until the team sends the updated total (releasing it asks for no new approval).
export function withheldQuotePaymentSummary(estimate, { signed = false } = {}) {
  let policy;
  try { policy = snapshotQuotePaymentPolicy(estimate?.commercialPolicy); } catch { return null; }
  const s = plain(estimate?.paymentSchedule) ? estimate.paymentSchedule : null, day = s && s.timeZone === PAYMENT_TIME_ZONE && validDate(s.remainderDueDate) ? s.remainderDueDate : '';
  const split = s && Number.isSafeInteger(s.depositCents) && Number.isSafeInteger(s.remainderCents) && s.depositCents >= 0 && s.remainderCents >= 0 && s.depositCents + s.remainderCents > 0 ? scheduleSplit(s) : policy;
  return { version: policy.version, text: `${split.depositPct}% deposit${policy.depositDueRule === 'approval_day' ? ' due when you approve your estimate' : ''}; ${split.remainderPct}% remainder due on the job day${day ? ` ${day} (${PAYMENT_TIME_ZONE})` : ''}. ${signed ? 'Your job is booked and our team is confirming its prices: the amounts are shown when we send you the updated total' : 'The amounts are shown when your estimate is sent to you'}, and nothing is due before then.` };
}
// A payment due date (YYYY-MM-DD, a Denver business day) as the customer reads it: "Tuesday, October 20, 2026".
export const paymentDateLabel = date => new Intl.DateTimeFormat('en-US', { timeZone: PAYMENT_TIME_ZONE, weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }).format(new Date(`${date}T12:00:00Z`));
