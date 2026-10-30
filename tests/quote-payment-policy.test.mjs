import test from 'node:test';
import assert from 'node:assert/strict';
import { PROPOSED_25_75, FINAL_25_75, SENT_25_75, SIGNED_25_75, businessPaymentDate, publicQuotePaymentSchedule, quotePaymentSchedule, quotePaymentDates, quotePaymentSummary, requireQuotePaymentTiming, sentQuotePaymentPolicy, snapshotQuotePaymentPolicy, withheldQuotePaymentSummary } from '../functions/_lib/quote-payment-policy.js';
import { estimateFingerprint } from '../functions/_lib/quote-model.js';

test('25/75 uses whole cents and leaves no cent unallocated; timing stays pending', () => {
  for (const total of [1, 3, 99, 100, 100001]) {
    const result = quotePaymentSchedule(total, PROPOSED_25_75);
    assert.equal(result.depositCents, Math.round(total / 4));
    assert.equal(result.depositCents + result.remainderCents, total);
    assert.equal(result.timingReady, false);
  }
  assert.throws(() => requireQuotePaymentTiming(PROPOSED_25_75), error => error.code === 'quote_draft_payment_timing_pending');
  assert.throws(() => quotePaymentDates(PROPOSED_25_75, { jobDate: '2026-11-10' }), /not confirmed/);
});
test('date previews require an explicit rule, verified dates and a policy version', () => {
  const policy = { ...PROPOSED_25_75, version: 'fixture-confirmed-25', depositDueRule: 'seven_days_before_job' };
  assert.deepEqual(quotePaymentDates(policy, { jobDate: '2026-11-10' }), { depositDueDate: '2026-11-03', remainderDueDate: '2026-11-10' });
  policy.depositDueRule = 'walkthrough_day';
  assert.deepEqual(quotePaymentDates(policy, { walkthroughDate: '2026-10-15', jobDate: '2026-11-10' }), { depositDueDate: '2026-10-15', remainderDueDate: '2026-11-10' });
  assert.throws(() => quotePaymentDates(policy, { jobDate: '2026-11-10' }), /Verified/);
  for (const invalid of [null, { ...policy, depositPct: 50 }, { ...policy, remainderPct: 80 }, { ...policy, depositDueRule: 'whichever' }, { ...policy, version: '' }, { ...policy, approved: true }]) assert.throws(() => snapshotQuotePaymentPolicy(invalid));
});
test('new due-date terms affect fingerprints; legacy estimates retain their exact fingerprint shape', () => {
  const estimate = { amount: 100, depositRequired: 25, scope: 'Fixture', lineItems: [] };
  assert.equal(estimateFingerprint(estimate), estimateFingerprint({ ...estimate, commercialPolicy: undefined }));
  const pending = { ...estimate, commercialPolicy: { ...PROPOSED_25_75 } };
  assert.notEqual(estimateFingerprint(estimate), estimateFingerprint(pending));
  assert.notEqual(estimateFingerprint(pending), estimateFingerprint({ ...pending, commercialPolicy: { ...PROPOSED_25_75, depositDueRule: 'walkthrough_day' } }));
});
test('finalized seven-calendar-day boundary never puts the deposit before the walkthrough',()=>{
 for(const [walk,expected] of [['2026-10-01','2026-10-03'],['2026-10-03','2026-10-03'],['2026-10-04','2026-10-04'],['2026-10-10','2026-10-10']]) {
  const dates=quotePaymentDates(FINAL_25_75,{walkthroughDate:walk,jobDate:'2026-10-10'});assert.equal(dates.depositDueDate,expected);assert.ok(dates.depositDueDate>=walk);assert.equal(dates.remainderDueDate,'2026-10-10');
 }
 assert.throws(()=>quotePaymentDates(FINAL_25_75,{walkthroughDate:'2026-10-11',jobDate:'2026-10-10'}),/after/);
 assert.equal(quotePaymentDates(FINAL_25_75,{walkthroughDate:'2026-12-20',jobDate:'2027-01-03'}).depositDueDate,'2026-12-27');
});
test('Denver date conversion and calendar subtraction remain correct across both DST changes',()=>{
 for(const [instant,date]of [['2026-03-08T06:30:00Z','2026-03-07'],['2026-03-09T05:30:00Z','2026-03-08'],['2026-11-01T05:30:00Z','2026-10-31'],['2026-11-02T06:30:00Z','2026-11-01']])assert.equal(businessPaymentDate(instant),date);
 assert.equal(businessPaymentDate('2026-01-01'),'2026-01-01');assert.equal(businessPaymentDate('2026-01-01T12:00:00'),null,'timestamps need an explicit offset');
 for(const [walk,job,due]of [['2026-03-01','2026-03-15T15:00:00Z','2026-03-08'],['2026-10-20','2026-11-08T16:00:00Z','2026-11-01']])assert.equal(quotePaymentDates(FINAL_25_75,{walkthroughDate:walk,jobDate:job}).depositDueDate,due);
});

// Owner decision of 2026-10-18 evening: a quote an estimator sends takes its 25% deposit when the customer approves it and
// its 75% on the job day, as new versioned terms (SENT_25_75). The earlier sent-quote terms stay readable for quotes
// already sent on them, and the validator accepts the new terms only with their explicit due rule.
test('SENT_25_75 is accepted only with its explicit approval-day rule; the earlier terms stay readable', () => {
  assert.deepEqual(SENT_25_75, { version: '2026-10-19-deposit25-on-approval', depositPct: 25, remainderPct: 75, depositDueRule: 'approval_day', remainderDueRule: 'job_day' });
  assert.deepEqual(snapshotQuotePaymentPolicy(SENT_25_75), { ...SENT_25_75 });
  for (const policy of [FINAL_25_75, PROPOSED_25_75, SIGNED_25_75]) assert.deepEqual(snapshotQuotePaymentPolicy(policy), { ...policy }, policy.version);
  for (const rule of [null, 'walkthrough_day', 'seven_days_before_job', 'later_of_walkthrough_or_seven_days_before_job', 'approval', 'send_day'])
    assert.throws(() => snapshotQuotePaymentPolicy({ ...SENT_25_75, depositDueRule: rule }), error => error.code === 'quote_draft_invalid_payment_policy', String(rule));
  for (const invalid of [{ ...SENT_25_75, depositPct: 50 }, { ...SENT_25_75, remainderDueRule: 'on_completion' }, { ...SENT_25_75, approvedAt: 'now' }]) assert.throws(() => snapshotQuotePaymentPolicy(invalid), /verified version/);
  assert.doesNotThrow(() => requireQuotePaymentTiming(SENT_25_75));
  // The terms a quote is sent on: the earlier sent-quote terms move to SENT_25_75, and so does a quote draft saved with
  // none (before 2026-10-14: 50% upfront, the rest on completion); nothing else does.
  assert.equal(sentQuotePaymentPolicy(FINAL_25_75), SENT_25_75); assert.equal(sentQuotePaymentPolicy({ ...PROPOSED_25_75 }), SENT_25_75);
  for (const policy of [SENT_25_75, SIGNED_25_75, undefined, null, { ...FINAL_25_75, version: 'fixture-other' }]) assert.equal(sentQuotePaymentPolicy(policy), policy);
  for (const policy of [undefined, null]) assert.equal(sentQuotePaymentPolicy(policy, { quoteDraft: true }), SENT_25_75, String(policy));
  for (const policy of [SENT_25_75, SIGNED_25_75, FINAL_25_75]) assert.equal(sentQuotePaymentPolicy(policy, { quoteDraft: true }), policy === FINAL_25_75 ? SENT_25_75 : policy, policy.version);
});

test('a SENT_25_75 deposit is due the Denver day of the approval, even after the job day, and has no date before it', () => {
  assert.deepEqual(quotePaymentDates(SENT_25_75, { jobDate: '2026-11-10' }), { depositDueDate: null, remainderDueDate: '2026-11-10' }, 'no walkthrough date is needed');
  assert.deepEqual(quotePaymentDates(SENT_25_75, { walkthroughDate: '2026-10-19', jobDate: '2026-11-10', approvalDate: '2026-10-21T03:30:00Z' }), { depositDueDate: '2026-10-20', remainderDueDate: '2026-11-10' }, 'the approval instant read in Denver');
  assert.equal(quotePaymentDates(SENT_25_75, { jobDate: '2026-11-10', approvalDate: '2026-11-12' }).depositDueDate, '2026-11-12', 'approved after the job day: the approval day, never a day the customer did not approve on');
  assert.throws(() => quotePaymentDates(SENT_25_75, { walkthroughDate: '2026-10-19' }), error => error.code === 'quote_draft_payment_dates_pending', 'the send waits for a booked job date');
  // The reviewer's case: walkthrough 2026-10-19, job 2026-11-10. A quote sent earlier on FINAL_25_75 keeps 2026-11-03.
  assert.deepEqual(quotePaymentDates(FINAL_25_75, { walkthroughDate: '2026-10-19', jobDate: '2026-11-10' }), { depositDueDate: '2026-11-03', remainderDueDate: '2026-11-10' });
});

test('the public schedule of a SENT_25_75 quote dates the deposit by the approval without rewriting the saved schedule', () => {
  const schedule = { depositCents: 37500, remainderCents: 112500, depositDueDate: null, remainderDueDate: '2026-11-10', timeZone: 'America/Denver', policyVersion: SENT_25_75.version };
  const estimate = { status: 'sent', amount: 1500, amountCents: 150000, depositRequired: 375, depositRequiredCents: 37500, commercialPolicy: { ...SENT_25_75 }, paymentSchedule: schedule }, saved = structuredClone(estimate);
  const sent = publicQuotePaymentSchedule(estimate);
  assert.deepEqual(sent, { depositDueDate: null, depositDueOn: 'approval', remainderDueDate: '2026-11-10', timeZone: 'America/Denver', depositCents: 37500, remainderCents: 112500, policyVersion: SENT_25_75.version });
  // Owner decision 2026-10-30: the 75% is due when the job is complete, with the job's current day (never the saved one).
  assert.equal(quotePaymentSummary(sent, '2026-11-17'), '25% deposit $375.00 due on approval; 75% remainder $1,125.00 due when the job is complete, scheduled for 2026-11-17 (America/Denver).');
  assert.equal(quotePaymentSummary(sent), '25% deposit $375.00 due on approval; 75% remainder $1,125.00 due when the job is complete.', 'no booked day: none is named');
  const approved = publicQuotePaymentSchedule({ ...estimate, status: 'approved', acceptedAt: '2026-10-21T03:30:00.000Z' });
  assert.equal(approved.depositDueDate, '2026-10-20');
  assert.equal(quotePaymentSummary(approved, '2026-11-10'), '25% deposit $375.00 due on approval (2026-10-20); 75% remainder $1,125.00 due when the job is complete, scheduled for 2026-11-10 (America/Denver).');
  // Approved after the saved job day (a job rescheduled before the quote was sent again): due on the day it was approved.
  const late = publicQuotePaymentSchedule({ ...estimate, status: 'accepted', acceptedAt: '2026-12-01T18:00:00.000Z' });
  assert.equal(late.depositDueDate, '2026-12-01', 'the approval date, not the job day');
  assert.equal(quotePaymentSummary(late), '25% deposit $375.00 due on approval (2026-12-01); 75% remainder $1,125.00 due when the job is complete (America/Denver).');
  assert.deepEqual(estimate, saved, 'the saved schedule is never rewritten');
  // Fail closed: a saved deposit date on these terms, or no deposit date on dated terms, is not a schedule any surface shows.
  assert.equal(publicQuotePaymentSchedule({ ...estimate, paymentSchedule: { ...schedule, depositDueDate: '2026-10-20' } }), null);
  assert.equal(publicQuotePaymentSchedule({ ...estimate, commercialPolicy: { ...FINAL_25_75 } }), null);
  // A quote already sent on FINAL_25_75 keeps its recorded dates exactly.
  const final = { ...estimate, commercialPolicy: { ...FINAL_25_75 }, paymentSchedule: { ...schedule, depositDueDate: '2026-11-03', policyVersion: FINAL_25_75.version } };
  assert.deepEqual(publicQuotePaymentSchedule(final), { depositDueDate: '2026-11-03', remainderDueDate: '2026-11-10', timeZone: 'America/Denver', depositCents: 37500, remainderCents: 112500, policyVersion: FINAL_25_75.version });
  assert.equal(quotePaymentSummary(publicQuotePaymentSchedule({ ...final, status: 'approved', acceptedAt: '2026-10-21T03:30:00.000Z' })), '25% deposit $375.00 due 2026-11-03; 75% remainder $1,125.00 due when the job is complete (America/Denver).');
  assert.equal(withheldQuotePaymentSummary(estimate, { jobDate: '2026-11-17' }).text, '25% deposit due when you approve your estimate; 75% remainder due when your job is complete, scheduled for 2026-11-17 (America/Denver). The amounts are shown when your estimate is sent to you, and nothing is due before then.');
});
