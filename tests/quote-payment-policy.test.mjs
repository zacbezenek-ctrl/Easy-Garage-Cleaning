import test from 'node:test';
import assert from 'node:assert/strict';
import { PROPOSED_25_75, FINAL_25_75, businessPaymentDate, quotePaymentSchedule, quotePaymentDates, requireQuotePaymentTiming, snapshotQuotePaymentPolicy } from '../functions/_lib/quote-payment-policy.js';
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
