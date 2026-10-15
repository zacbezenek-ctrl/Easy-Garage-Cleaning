// Explicit manager release only. It revokes form correlation; it never changes attribution, jobs or money.
import { requireAdmin } from './knock-access.js';
import { knockFailure, safeDocId, write } from './knock-store.js';
import { nativeHouseClaimId, nativeClaimActive, nativeClaimGeneration, formDigest } from './knock-form-claims.js';
import { onlyFormFields } from './knock-form-handoff.js';

const fail = message => knockFailure(message, 409, 'knock_form_recovery_conflict');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function snapshot(store, houseId) {
  safeDocId(houseId);
  const claimId = await nativeHouseClaimId(houseId);
  const [house, claim, fence, all, sales] = await Promise.all([
    store.get('knock_houses', houseId), store.get('knock_receipts', claimId), store.get('knock_form_revisions', houseId),
    store.query('knock_form_handoffs', { where: [['houseId', '==', houseId]], limit: 101 }),
    store.query('knock_sales', { where: [['houseId', '==', houseId]], limit: 1 }),
  ]);
  const generation = nativeClaimGeneration(claim), handoffs = all.filter(h => (h.claimGeneration || 0) === generation);
  const blockers = [];
  if (!house || !nativeClaimActive(claim)) blockers.push('no_active_claim');
  if (all.length > 100) blockers.push('handoff_history_requires_review');
  if (sales.length || handoffs.some(h => h.source.kind === 'sale' || h.jobId || h.walkthroughId)) blockers.push('sale_or_job_requires_review');
  const guards = [], sources = new Map();
  for (const handoff of handoffs) {
    const receiptId = `native_ref_${handoff.reference}`;
    if (await store.get('knock_receipts', receiptId)) blockers.push('verified_submission_requires_review');
    guards.push(write.verifyMissing('knock_receipts', receiptId), write.verify('knock_form_handoffs', handoff.reference, handoff.__updateTime));
    const sourceKey = `${handoff.source.kind}:${handoff.source.id}`;
    if (!sources.has(sourceKey)) {
      const collection = handoff.source.kind === 'sale' ? 'knock_sales' : 'knock_events';
      const source = await store.get(collection, handoff.source.id);
      sources.set(sourceKey, source?.__updateTime || null);
      if (!source) blockers.push('source_requires_review');
      else guards.push(write.verify(collection, handoff.source.id, source.__updateTime));
    }
  }
  const fingerprint = await formDigest([house?.__updateTime, claim?.__updateTime, fence?.__updateTime || null,
    handoffs.map(h => [h.reference, h.__updateTime]).sort(), [...sources].sort(), blockers]);
  return { house, claim, fence, claimId, generation, handoffs, fingerprint, blockers: [...new Set(blockers)], guards };
}

export async function nativeRecoveryContext(store, admin, houseId) {
  requireAdmin(admin);
  const s = await snapshot(store, houseId);
  return { houseId, generation: s.generation, snapshot: s.fingerprint, recoverable: !s.blockers.length, blockers: s.blockers,
    claim: s.claim ? { repKey: s.claim.repKey, channel: s.claim.channel, state: s.claim.state || 'active' } : null,
    references: s.handoffs.map(h => ({ reference: h.reference, createdAt: h.createdAt, expiresAt: h.expiresAt })) };
}

export async function nativeRecoveryQueue(store, admin) {
  requireAdmin(admin);
  const recent = await store.query('knock_form_handoffs', { orderBy: [['createdAt', 'DESCENDING']], limit: 25 });
  const rows = await Promise.all([...new Set(recent.map(h => h.houseId))].map(async houseId => {
    const claim = await store.get('knock_receipts', await nativeHouseClaimId(houseId));
    return { houseId, claim: claim ? { repKey: claim.repKey, channel: claim.channel, state: claim.state || 'active' } : null };
  }));
  return { rows, limited: recent.length === 25 };
}

export async function recoverNativeFormClaim(store, admin, body, nowIso) {
  requireAdmin(admin);
  onlyFormFields(body, ['action', 'houseId', 'expectedGeneration', 'expectedSnapshot', 'requestId', 'reason', 'confirmation']);
  if (!UUID.test(body.requestId || '') || !Number.isSafeInteger(body.expectedGeneration) || body.expectedGeneration < 0 ||
      !/^[0-9a-f]{64}$/.test(body.expectedSnapshot || '') || typeof body.reason !== 'string' || body.reason.trim().length < 10 || body.reason.length > 500 ||
      body.confirmation !== 'release_abandoned_forms') throw knockFailure('Confirm release with a reason and the current claim generation.', 400, 'knock_form_recovery_invalid');
  safeDocId(body.houseId);
  const fingerprint = await formDigest([body.houseId, body.expectedGeneration, body.expectedSnapshot, body.reason.trim(), admin.user]);
  const auditId = `native_recovery_${body.requestId}`;
  const prior = await store.get('knock_receipts', auditId);
  if (prior) {
    if (prior.fingerprint !== fingerprint) throw fail('This recovery request already has different details.');
    return { recovery: prior, duplicate: true };
  }
  const s = await snapshot(store, body.houseId);
  if (s.blockers.length || s.generation !== body.expectedGeneration || s.fingerprint !== body.expectedSnapshot) throw fail('The claim changed or has verified submission, sale or job evidence. Reload; separate review is required.');
  const recovery = { kind: 'native_form_recovery', houseId: body.houseId, requestId: body.requestId, fingerprint,
    fromGeneration: s.generation, toGeneration: s.generation + 1, previousRepKey: s.claim.repKey, previousChannel: s.claim.channel,
    reviewedSnapshot: s.fingerprint,
    reason: body.reason.trim(), recordedBy: admin.user, recordedAt: nowIso, revokedReferences: s.handoffs.map(h => h.reference) };
  try {
    await store.commit([
      write.verify('knock_houses', body.houseId, s.house.__updateTime),
      s.fence ? write.verify('knock_form_revisions', body.houseId, s.fence.__updateTime) : write.verifyMissing('knock_form_revisions', body.houseId),
      ...s.guards,
      write.patch('knock_receipts', s.claimId, { state: 'released', generation: recovery.toGeneration, recoveryId: auditId }, s.claim.__updateTime),
      write.create('knock_receipts', auditId, recovery),
      ...s.handoffs.map(h => write.create('knock_receipts', `native_revoked_${h.reference}`, { kind: 'native_form_revoked', reference: h.reference, recoveryId: auditId, recordedAt: nowIso })),
    ]);
  } catch (error) {
    const saved = await store.get('knock_receipts', auditId);
    if (!saved || saved.fingerprint !== fingerprint) throw error;
    return { recovery: saved, duplicate: true };
  }
  return { recovery, duplicate: false };
}
