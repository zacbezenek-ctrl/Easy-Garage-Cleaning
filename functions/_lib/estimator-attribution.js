/** Who priced a job: the one estimator attribution both estimator boards use, Open quotes (open-quotes.js, its close
 * rates) and Estimator accuracy (estimator-accuracy.js, its scorecard), so the two never credit different people for
 * the same quote. From what the job record and its setter record say, never a guess:
 *   1. 'walkthrough_signer': the employee who recorded the customer's signature on the walkthrough (acceptance.recordedBy
 *      with method 'in_person_signature', walkthrough-handoff.js). They built that quote on site. A door-to-door rep who
 *      runs and signs their own walkthrough is its signer, so it is credited to them.
 *   2. 'setter_record': a door-to-door setter's walkthrough names its estimator on the setter record (knock_setters
 *      estimatorKey, the key its 7% commission is paid to). As the commission does (knock-setters.js
 *      projectSetterAttribution), an estimator the office recorded or settled (estimatorClassifiedAt) is credited even
 *      when someone else signed; one only the Knock bridge booked, with a different signer, is a conflict the office has
 *      not settled yet (conflict: the signer).
 *   3. 'quote_builder': the employee who built the quote (quoteDraft.createdBy), who priced it.
 *   4. 'quote_sender': the employee who sent it (quoteDraft.sentBy), when nobody is named as its builder.
 * => {key, evidence, conflict?} (key: the lowercase staff key), or null. */
export const ESTIMATOR_FIELDS = Object.freeze(['acceptance.recordedBy', 'acceptance.method', 'quoteDraft.createdBy', 'quoteDraft.sentBy']);
// The staff key the commission ledger uses for the same employee (knock-setters.js handoffSigner).
const STAFF_KEY = /^[a-z0-9._-]{1,64}$/;
export const staffKey = value => {
  const text = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return STAFF_KEY.test(text) ? text : '';
};
// The estimator the Knock bridge booked (knock-setters.js bridgeEstimator), not one the office recorded.
const bridgeBooked = record => record.source === 'knock_walkthrough' || record.recordedBy === 'knock-bridge' || String(record.estimatorReference || '').startsWith('knock-walkthrough:');

export function estimatorOf(job, setter = null) {
  const signer = job?.acceptance?.method === 'in_person_signature' ? staffKey(job.acceptance.recordedBy) : '';
  const recorded = staffKey(setter?.estimatorKey);
  if (recorded) {
    const settled = Boolean(setter.estimatorClassifiedAt) || !bridgeBooked(setter);
    return signer && signer !== recorded && !settled ? { key: recorded, evidence: 'setter_record', conflict: signer } : { key: recorded, evidence: 'setter_record' };
  }
  if (signer) return { key: signer, evidence: 'walkthrough_signer' };
  const builder = staffKey(job?.quoteDraft?.createdBy);
  if (builder) return { key: builder, evidence: 'quote_builder' };
  const sender = staffKey(job?.quoteDraft?.sentBy);
  return sender ? { key: sender, evidence: 'quote_sender' } : null;
}
