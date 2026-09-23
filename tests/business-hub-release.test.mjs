import test from 'node:test';
import assert from 'node:assert/strict';
import { uid, projectView, requireLinkedJob } from '../functions/_lib/business-hub-core.js';
test('stale sent timestamps and past approvals never publish a drafted revision',()=>{
  const aid=uid(),pid=uid(),account={id:aid,projects:[{jobId:'draft_revision',propertyId:pid}]},link=account.projects[0];
  const job={id:'draft_revision',businessAccountId:aid,businessPropertyId:pid,estimate:{status:'draft',sentAt:'2026-09-22T12:00:00Z'},customerApproval:{status:'approved'}};
  assert.equal(projectView(account,link,job,{total:1500,paid:0,balance:1500},false).total,null);
  assert.throws(()=>requireLinkedJob(account,job.id,job),e=>e.status===409);
  job.estimate.status='sent';assert.equal(requireLinkedJob(account,job.id,job).jobId,job.id);
  job.quoteStatus='withdrawn';assert.throws(()=>requireLinkedJob(account,job.id,job),e=>e.status===409);
});
