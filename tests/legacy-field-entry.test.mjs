import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

for (const page of ['prejob', 'postjob']) {
  const html = fs.readFileSync(new URL(`../crew/${page}.html`, import.meta.url), 'utf8');
  const finish = html.slice(html.indexOf('async function finish(){'), html.indexOf('async function loadCentralJob()'));
  test(`${page}: starting or completing opens the exact canonical job without writing evidence or money`, async () => {
    assert.ok(finish.startsWith('async function finish(){'));
    for (const [central, active, target] of [
      ['canonical-job', 'stale-draft', '/crew/job.html?jobId=canonical-job'],
      ['', 'selected-job', '/crew/job.html?jobId=selected-job'],
      ['', '', '/crew/job.html'],
    ]) {
      const calls = [];
      const context = vm.createContext({ CENTRAL_JOB_ID: central, ACTIVE: { jobId: active }, location: { assign: url => calls.push(url) } });
      vm.runInContext(finish, context);
      await vm.runInContext('finish()', context);
      assert.deepEqual(calls, [target]);
    }
    assert.doesNotMatch(finish, /HUBDB|fetch|localStorage|completedAt|payment|status:/);
    assert.match(html, /Open verified job workflow/);
  });
}

test('manager payment return still verifies the exact job through the server before updating displayed balance', async () => {
  const html = fs.readFileSync(new URL('../crew/postjob.html', import.meta.url), 'utf8');
  const start = html.indexOf('async function recordVerifiedStripePayment(');
  const end = html.indexOf('async function syncStripePaymentToHighLevel(', start);
  const context = vm.createContext({ ACTIVE: { jobId: 'job-a' } });
  vm.runInContext(html.slice(start, end), context);
  const verify = data => { context.result = data; return vm.runInContext('recordVerifiedStripePayment(result)', context); };
  await assert.rejects(verify({ jobId: 'job-b', payment: {}, invoice: {}, paymentSyncPayload: {} }), /different job/);
  await assert.rejects(verify({ jobId: 'job-a', payment: {} }), /not recorded/);
  const result = await verify({ jobId: 'job-a', payment: { amount: 123, verified: true }, invoice: { balance: 20 }, paymentSyncPayload: { sessionId: 'cs_verified' } });
  assert.equal(result.payment.amount, 123);
  assert.equal(result.invoice.balance, 20);
  assert.match(html, /await verifyStripeReturn\(\)/);
  assert.match(html, /\/api\/job-payment\?session_id=/);
  assert.doesNotMatch(html, /status:verifiedPaidInFull|verificationSource:'crew_attestation'/);
});
