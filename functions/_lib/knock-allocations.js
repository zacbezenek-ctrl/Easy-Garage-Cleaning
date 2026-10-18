// Known channel percentages (CHANNEL_PERCENTS, owner-set 2026-10-17), not approval of a
// calculation base or a payout. Each allocation has a stable identity for downstream
// idempotent accounting. rounding 'nearest_cent' (the owner's approved setter terms,
// SETTER_TERMS) rounds each share half up to the cent; without it a share that is not a
// whole number of cents is held.
import { CHANNEL_PERCENTS } from '../../crew/knock-money.js';

export function commissionAllocations({ channel, jobId, serviceClassification, setterKey = '', estimatorKey = '', directRepKey = '', base = null, rounding = null }) {
  const { directSale, setter, estimator } = CHANNEL_PERCENTS;
  const definitions = channel === 'appointment_setter' ? [['setter', setterKey, setter], ['estimator', estimatorKey, estimator]]
    : channel === 'direct_estimator' ? [['estimator', estimatorKey, estimator]]
    : channel === 'direct_sale' ? [['direct_rep', directRepKey, directSale]] : [];
  if (serviceClassification === 'junk_removal') return { state: 'excluded', allocations: [], totalCents: 0, payable: false, reviewReasons: [] };
  const reviewReasons = [];
  if (serviceClassification !== 'garage') reviewReasons.push('service_scope_unverified');
  if (!definitions.length || !/^[A-Za-z0-9_-]{1,120}$/.test(String(jobId || ''))) reviewReasons.push('channel_or_job_unverified');
  if (definitions.some(([, key]) => !/^[a-z0-9._-]{1,64}$/i.test(key))) reviewReasons.push('recipient_unverified');
  if (channel === 'appointment_setter' && setterKey === estimatorKey) reviewReasons.push('recipient_overlap_review');
  if (channel === 'appointment_setter' && directRepKey || channel === 'direct_sale' && (setterKey || estimatorKey) || channel === 'direct_estimator' && (setterKey || directRepKey)) reviewReasons.push('channel_attribution_conflict');
  if (base?.verified !== true || !Number.isSafeInteger(base?.amountCents) || base.amountCents <= 0 || typeof base.reference !== 'string' || !base.reference.trim()) reviewReasons.push('calculation_base_unconfigured');
  const allocations = definitions.map(([role, repKey, percent]) => ({
    id: `${jobId}:${channel}:${role}:${repKey}`, role, repKey: repKey || null, rate: percent / 100,
    amountCents: null,
  }));
  if (!reviewReasons.length) {
    const amounts = definitions.map(([, , percent]) => rounding === 'nearest_cent' ? Math.floor((base.amountCents * percent + 50) / 100) : base.amountCents * percent / 100);
    if (amounts.some(amount => !Number.isSafeInteger(amount))) reviewReasons.push('rounding_policy_unconfigured');
    else allocations.forEach((allocation, index) => { allocation.amountCents = amounts[index]; });
  }
  return { state: reviewReasons.length ? 'review_required' : 'calculated', allocations,
    totalCents: reviewReasons.length ? null : allocations.reduce((total, allocation) => total + allocation.amountCents, 0),
    payable: false, reviewReasons };
}
