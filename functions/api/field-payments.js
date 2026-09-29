import { getHubSession } from '../_lib/hub-session.js';
import { canDispatch } from '../_lib/dispatch-permissions.js';
import { createJobAssignmentAccess } from '../_lib/job-assignment.js';
import { fieldCancelled, fieldFailure, fieldId, fieldRequestId } from '../_lib/field-execution.js';
import { assignedOn, fieldVisitsEnabled } from '../_lib/field-execution-visits.js';
import { fieldJobLead } from '../_lib/field-permissions.js';
import { denverToday } from '../_lib/dispatch-time.js';
import { firebaseServiceAccountConfigured } from '../_lib/firebase-service-account.js';
import { decodeFieldPhoto } from '../_lib/field-execution-photos.js';
import { customerPaymentNeedsReview, checkoutHold, stripeRequest, stripeSecretKey } from '../_lib/customer-payments.js';
import { customerMoneyTotals, moneyTotalsMode, refundsRecorded } from '../_lib/money-core.js';
import { moneyStorage } from '../_lib/money-storage.js';
import { MONEY_RECEIPTS, moneyApiEnabled, moneyJob, mutateMoney, requireMoneyManager } from '../_lib/money-service.js';
import { FIELD_CARD_CHECKOUTS, FIELD_CARD_SESSIONS, activeFieldCard, fieldCardCanRecover, fieldPortalGuard } from '../_lib/field-payment-card.js';
import { syncFieldPayment } from '../_lib/field-payment-sync.js';

// FIELD-PAY. Evidence is server-only in fieldPaymentReceipts/{requestId}; the
// job contains only its current lock and last row pointer. Photo bytes never
// enter fieldExecution.photos or job DTOs.
const SUBMISSIONS = 'fieldPaymentSubmissions';
const RECEIPTS = 'fieldPaymentReceipts';
const MAX_BODY = 600000, MAX_IMAGE_BYTES = 400000;
const UUID = fieldRequestId;
const reply = (status, body) => Response.json(body, { status, headers: { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } });
const fail = (code, message, status = 400) => fieldFailure(message, status, code);
const originAllowed = request => {
  const site = request.headers.get('Sec-Fetch-Site');
  if (site === 'cross-site') return false;
  const source = request.headers.get('Origin') || request.headers.get('Referer');
  if (!source) return true;
  try { return new URL(source).origin === new URL(request.url).origin; } catch { return false; }
};
const fingerprint = async value => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value))))).map(byte => byte.toString(16).padStart(2, '0')).join('');

export const fieldPaymentsReady = env => env?.EGC_FIELD_PAY_ENABLED === 'true' && moneyApiEnabled(env) && moneyTotalsMode(env) === 'unified';
export const fieldPaymentJobEligible = job => moneyJob(job) && ['job', 'cleanout', 'reorg'].includes(job.type) && !job.recordType &&
  !['cancelled', 'canceled', 'no_show', 'no-show', 'noshow', 'superseded', 'lost'].some(state => [job.status, job.pipelineStatus].includes(state)) &&
  !['void', 'superseded'].includes(String(job.invoice?.status || '').toLowerCase()) && !refundsRecorded(job);

function balance(job) {
  const totals = customerMoneyTotals(job, { unified: true });
  return [totals.totalCents, totals.appliedCents, totals.balanceCents].every(Number.isSafeInteger) ? totals.balanceCents : null;
}

function rowView(row, manager) {
  if (!row) return null;
  if (!UUID(row.id) || !fieldId(row.jobId) || !['uploading', 'pending', 'accepted', 'rejected'].includes(row.status) || !row.revision) throw fail('FIELD_PAY_STORAGE_INCOMPLETE', 'A field payment record needs operations review.', 503);
  return { id: row.id, method: row.method, amountCents: row.amountCents, status: row.status, revision: row.revision, submittedAt: row.submittedAt, submittedBy: row.submittedBy,
    ...(manager ? { reference: row.reference, reviewedAt: row.reviewedAt || null, reviewedBy: row.reviewedBy || null, reason: row.reason || '', crmSyncStatus: row.crmSyncStatus || null, crmSyncError: row.crmSyncError || '', receiptUrl: row.receipt?.verified === true ? `/api/field-payments?job_id=${encodeURIComponent(row.jobId)}&receipt_id=${encodeURIComponent(row.id)}` : null } : {}) };
}

async function readBody(request) {
  if (!/^application\/json(?:;|$)/i.test(request.headers.get('Content-Type') || '')) throw fail('FIELD_PAY_JSON_REQUIRED', 'Send a JSON field payment request.', 415);
  if (Number(request.headers.get('Content-Length') || 0) > MAX_BODY) throw fail('FIELD_PAY_PHOTO_TOO_LARGE', 'The receipt photo is too large.', 413);
  const reader = request.body?.getReader();
  if (!reader) throw fail('FIELD_PAY_REQUEST_INVALID', 'The field payment request is empty.');
  const chunks = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY) { await reader.cancel(); throw fail('FIELD_PAY_PHOTO_TOO_LARGE', 'The receipt photo is too large.', 413); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let value; try { value = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw fail('FIELD_PAY_REQUEST_INVALID', 'The field payment request could not be read.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail('FIELD_PAY_REQUEST_INVALID', 'Choose a supported field payment action.');
  const keys = value.action === 'submit' ? ['action', 'jobId', 'requestId', 'expectedBalanceCents', 'method', 'amountCents', 'reference', 'receiptDataUrl']
    : value.action === 'cancel_card' ? ['action', 'jobId', 'requestId', 'expectedRevision']
    : value.action === 'sync_payment' ? ['action', 'jobId', 'requestId', 'kind', 'sourceId'] : ['action', 'jobId', 'submissionId', 'requestId', 'expectedRevision', 'reason'];
  if (!['submit', 'accept', 'reject', 'cancel_card', 'sync_payment'].includes(value.action) || Object.keys(value).some(key => !keys.includes(key))) throw fail('FIELD_PAY_REQUEST_INVALID', 'The field payment request contains unsupported information.');
  if (!fieldId(value.jobId) || !UUID(value.requestId)) throw fail('FIELD_PAY_REQUEST_INVALID', 'Choose a job and use a new request ID.');
  if (value.action === 'submit') {
    if (!['cash', 'check'].includes(value.method) || !Number.isSafeInteger(value.amountCents) || value.amountCents < 1 || value.amountCents > 100000000 || !Number.isSafeInteger(value.expectedBalanceCents) || value.expectedBalanceCents < 1 || value.expectedBalanceCents > 100000000) throw fail('FIELD_PAY_AMOUNT_INVALID', 'Enter the exact outstanding balance in cents, as cash or check.');
    if (typeof value.reference !== 'string' || value.reference.trim().length < 2 || value.reference.trim().length > 160) throw fail('FIELD_PAY_REFERENCE_REQUIRED', 'Enter a receipt or check reference.');
    if (typeof value.receiptDataUrl !== 'string') throw fail('FIELD_PAY_RECEIPT_REQUIRED', 'Attach a receipt photo before submitting cash or check.');
    value.reference = value.reference.trim();
  } else if (value.action === 'cancel_card') {
    if (typeof value.expectedRevision !== 'string' || !value.expectedRevision || value.expectedRevision.length > 100) throw fail('FIELD_PAY_REVISION_REQUIRED', 'Refresh the card checkout before cancelling it.');
  } else if (value.action === 'sync_payment') {
    if (!['card', 'receipt'].includes(value.kind) || typeof value.sourceId !== 'string' || !(value.kind === 'card' ? /^cs_(?:test_|live_)?[A-Za-z0-9_]+$/.test(value.sourceId) : UUID(value.sourceId))) throw fail('FIELD_PAY_CRM_SOURCE_INVALID', 'Choose a verified field payment to sync.');
  } else {
    if (!UUID(value.submissionId) || typeof value.expectedRevision !== 'string' || !value.expectedRevision || value.expectedRevision.length > 100) throw fail('FIELD_PAY_REVISION_REQUIRED', 'Refresh the field payment before reviewing it.');
    if (value.reason !== undefined && (typeof value.reason !== 'string' || value.reason.trim().length > 500)) throw fail('FIELD_PAY_REASON_INVALID', 'Keep the review reason under 500 characters.');
    value.reason = (value.reason || '').trim();
    if (value.action === 'reject' && value.reason.length < 2) throw fail('FIELD_PAY_REASON_REQUIRED', 'Give a reason for rejecting this payment.');
  }
  return value;
}

export function fieldPaymentHandlers({ session = getHubSession, storage = moneyStorage, now = () => new Date(), hold = checkoutHold } = {}) {
  async function context(request, env) {
    if (!firebaseServiceAccountConfigured(env)) throw fail('FIELD_PAY_STORAGE_UNAVAILABLE', 'Secure job storage is unavailable.', 503);
    const actor = await session(request, env);
    if (!actor) throw fail('FIELD_PAY_AUTH_REQUIRED', 'Sign in to the Employee Hub.', 401);
    return { actor, manager: canDispatch(actor, env), access: createJobAssignmentAccess(env, actor), store: storage(env), env };
  }
  async function authorized(ctx, jobId) {
    if (!fieldId(jobId)) throw fail('FIELD_PAY_JOB_INVALID', 'Choose a valid job.');
    const job = await ctx.store.read('jobs', jobId);
    if (!moneyJob(job) || !['job', 'cleanout', 'reorg'].includes(job.type) || job.recordType) throw fail('FIELD_PAY_JOB_NOT_FOUND', 'This job is unavailable.', 404);
    if (!ctx.manager) {
      if (!await ctx.access.assigned(job) || !await fieldJobLead({ session: ctx.actor, job, access: ctx.access })) throw fail('FIELD_PAY_LEAD_REQUIRED', 'Only the assigned crew lead can collect this balance.', 403);
      if (fieldVisitsEnabled(ctx.env) && !await assignedOn(job, denverToday(now()), ctx.access)) throw fail('FIELD_PAY_NOT_ASSIGNED_TODAY', 'You are not scheduled on this job today.', 403);
    }
    return job;
  }
  async function lastRow(ctx, job) {
    const id = job.fieldPaymentPendingId || job.fieldPaymentLastId;
    if (!id) return null;
    if (!UUID(id)) throw fail('FIELD_PAY_STORAGE_INCOMPLETE', 'A field payment pointer needs operations review.', 503);
    const row = await ctx.store.read(SUBMISSIONS, id.toLowerCase());
    if (!row || row.jobId !== job.id || row.id !== id.toLowerCase()) throw fail('FIELD_PAY_STORAGE_INCOMPLETE', 'A field payment record needs operations review.', 503);
    return row;
  }
  async function listing(ctx, job) {
    const current = await ctx.store.read('jobs', job.id);
    if (!current || current.revision !== job.revision) job = await authorized(ctx, job.id);
    const [row, card] = await Promise.all([lastRow(ctx, job), ctx.store.read(FIELD_CARD_CHECKOUTS, job.id)]), balanceCents = balance(job), pending = Boolean(job.fieldPaymentPendingId), cardOpen = activeFieldCard(card) || Boolean(job.fieldPaymentCardRequestId);
    const enabled = fieldPaymentsReady(ctx.env), submit = enabled && !ctx.manager && balanceCents !== null && balanceCents > 0 && !pending && !cardOpen && fieldPaymentJobEligible(job) && !customerPaymentNeedsReview(job);
    const syncPending = [];
    if (ctx.manager) for (const key of (Array.isArray(job.fieldPaymentSyncPendingIds) ? job.fieldPaymentSyncPendingIds : []).slice(0, 50)) {
      const [kind, ...parts] = String(key).split(':'), sourceId = parts.join(':');
      if (kind === 'card') {
        const item = Array.isArray(job.payment?.stripeSessions) ? job.payment.stripeSessions.find(entry => entry?.sessionId === sourceId && entry.fieldExact === true) : null;
        if (item) syncPending.push({ kind, sourceId, amountCents: Math.round(Number(item.amount) * 100), status: job.paymentSyncPayload?.sessionId === sourceId ? job.paymentSyncStatus || 'pending' : 'pending' });
      } else if (kind === 'receipt' && UUID(sourceId)) {
        const item = await ctx.store.read(SUBMISSIONS, sourceId);
        if (item?.jobId === job.id && item.status === 'accepted') syncPending.push({ kind, sourceId, amountCents: item.amountCents, status: item.crmSyncStatus || 'pending' });
      }
    }
    const latestCard = ctx.manager && Array.isArray(job.payment?.stripeSessions) ? job.payment.stripeSessions.find(entry => entry?.fieldExact === true && entry.sessionId === job.paymentSyncPayload?.sessionId) : null;
    const paymentSync = latestCard ? { status: job.paymentSyncStatus || 'pending', sourceId: latestCard.sessionId, noteId: job.paymentSyncNoteId || null, error: job.paymentSyncError || '' } : null;
    return { jobId: job.id, enabled, currency: 'usd', balanceCents, canCollectCard: submit && balanceCents >= 50 && balanceCents <= 1000000 && Boolean(stripeSecretKey(ctx.env)),
      capabilities: { submit, review: ctx.manager }, submissions: row ? [rowView(row, ctx.manager)] : [], cardCheckout: activeFieldCard(card) ? { status: card.status, sessionId: card.sessionId || null, revision: card.revision, amountCents: card.amountCents } : null, ...(ctx.manager ? { moneyIssues: balanceCents === null ? ['amount_unreadable'] : [], paymentSync, syncPending, syncOverflow: Array.isArray(job.fieldPaymentSyncPendingIds) && job.fieldPaymentSyncPendingIds.length > 50 } : {}) };
  }
  async function submit(ctx, job, input, env) {
    if (!fieldPaymentsReady(env)) throw fail('FIELD_PAY_UNAVAILABLE', 'Field payments are not enabled for new collections.', 404);
    if (ctx.manager) throw fail('FIELD_PAY_LEAD_REQUIRED', 'The assigned crew lead submits cash or check.', 403);
    const id = input.requestId.toLowerCase();
    const image = decodeFieldPhoto(input.receiptDataUrl);
    if (image.bytes.length > MAX_IMAGE_BYTES) throw fail('FIELD_PAY_PHOTO_TOO_LARGE', 'Compress the receipt photo below 400 KB and retry.', 413);
    const proof = await fingerprint({ actor: ctx.actor.user, jobId: job.id, method: input.method, amountCents: input.amountCents, expectedBalanceCents: input.expectedBalanceCents, reference: input.reference, receiptDataUrl: input.receiptDataUrl });
    const savedBase64 = input.receiptDataUrl.slice(input.receiptDataUrl.indexOf(',') + 1);
    let row = await ctx.store.read(SUBMISSIONS, id);
    if (row && (row.jobId !== job.id || row.submittedBy !== ctx.actor.user || row.fingerprint !== proof)) throw fail('FIELD_PAY_IDEMPOTENCY_CONFLICT', 'This request ID was already used for another payment.', 409);
    if (row) return { alreadyApplied: true, row };
    if (!row) {
      if (job.fieldPaymentPendingId) throw fail('FIELD_PAY_PENDING_REVIEW', 'A cash or check receipt is already awaiting review.', 409);
      if (job.fieldPaymentCardRequestId || activeFieldCard(await ctx.store.read(FIELD_CARD_CHECKOUTS, job.id))) throw fail('FIELD_PAY_CARD_OPEN', 'A field card checkout may still be open. Verify or cancel it before collecting cash or check.', 409);
      if (!fieldPaymentJobEligible(job) || customerPaymentNeedsReview(job)) throw fail('FIELD_PAY_JOB_UNAVAILABLE', 'This job cannot take another payment until operations reviews it.', 409);
      const due = balance(job);
      if (due === null || due === 0 || input.amountCents > due || due !== input.expectedBalanceCents) throw fail('FIELD_PAY_BALANCE_CHANGED', 'The balance changed. Refresh before collecting payment.', 409);
      if (await hold(env, job.id, job)) throw fail('FIELD_PAY_PENDING_REVIEW', 'A card payment is awaiting review. Ask operations before collecting another payment.', 409);
      const at = now().toISOString(), portalGuard = await fieldPortalGuard(ctx.store, job.id, at);
      row = { jobId: job.id, submittedBy: ctx.actor.user, method: input.method, amountCents: input.amountCents, balanceAtSubmitCents: due, reference: input.reference, fingerprint: proof, status: 'pending', submittedAt: at, receipt: { verified: true, mime: image.mime, bytes: image.bytes.length } };
      try {
        await ctx.store.commit([
          { collection: 'jobs', id: job.id, revision: job.revision, patch: { fieldPaymentPendingId: id, fieldPaymentLastId: id } },
          { collection: SUBMISSIONS, id, exists: false, patch: row },
          { collection: RECEIPTS, id, exists: false, patch: { jobId: job.id, submissionId: id, mime: image.mime, bytes: image.bytes.length, base64: savedBase64, fingerprint: proof, createdAt: at } },
          portalGuard,
        ]);
      } catch (error) {
        const existing = await ctx.store.read(SUBMISSIONS, id).catch(() => null);
        if (!existing || existing.jobId !== job.id || existing.submittedBy !== ctx.actor.user || existing.fingerprint !== proof) throw error;
        row = existing;
        return { alreadyApplied: true, row };
      }
    }
    return { alreadyApplied: false, row: await ctx.store.read(SUBMISSIONS, id) };
  }
  async function review(ctx, job, input) {
    requireMoneyManager(ctx.actor, ctx.env);
    const id = input.submissionId.toLowerCase(), row = await ctx.store.read(SUBMISSIONS, id);
    if (!row || row.jobId !== job.id) throw fail('FIELD_PAY_SUBMISSION_NOT_FOUND', 'This receipt is not part of this job.', 404);
    const proof = await fingerprint({ actor: ctx.actor.user, action: input.action, jobId: job.id, submissionId: id, requestId: input.requestId.toLowerCase(), expectedRevision: input.expectedRevision, reason: input.reason });
    if (['accepted', 'rejected'].includes(row.status)) {
      if (row.reviewRequestId === input.requestId.toLowerCase() && row.reviewFingerprint === proof) return { alreadyApplied: true, row };
      throw fail('FIELD_PAY_ALREADY_REVIEWED', 'This receipt was already reviewed. Refresh the job.', 409);
    }
    if (job.fieldPaymentLastId !== id) throw fail('FIELD_PAY_SUBMISSION_NOT_FOUND', 'This receipt is not the current field payment.', 404);
    if (row.revision !== input.expectedRevision || job.fieldPaymentPendingId !== id) throw fail('FIELD_PAY_REVISION_CONFLICT', 'The receipt changed. Refresh before reviewing it.', 409);
    if (input.action === 'accept' && (row.status !== 'pending' || row.receipt?.verified !== true)) throw fail('FIELD_PAY_RECEIPT_UNVERIFIED', 'Verify the saved receipt photo before accepting this payment.', 409);
    const at = now().toISOString(), patch = { status: input.action === 'accept' ? 'accepted' : 'rejected', reviewedBy: ctx.actor.user, reviewedAt: at, reviewRequestId: input.requestId.toLowerCase(), reviewFingerprint: proof, reason: input.reason };
    if (input.action === 'reject') {
      try {
        await ctx.store.commit([
          { collection: 'jobs', id: job.id, revision: job.revision, patch: { fieldPaymentPendingId: null } },
          { collection: SUBMISSIONS, id, revision: row.revision, patch },
        ]);
      } catch (error) {
        const saved = await ctx.store.read(SUBMISSIONS, id).catch(() => null);
        if (saved?.reviewRequestId !== input.requestId.toLowerCase() || saved.reviewFingerprint !== proof) throw error;
        return { alreadyApplied: true, row: saved };
      }
    } else {
      if (!moneyApiEnabled(ctx.env) || moneyTotalsMode(ctx.env) !== 'unified') throw fail('FIELD_PAY_MONEY_UNAVAILABLE', 'The unified money service must be enabled before accepting this receipt.', 409);
      const portalGuard = await fieldPortalGuard(ctx.store, job.id, at);
      if (customerPaymentNeedsReview({ ...job, fieldPaymentPendingId: null })) throw fail('FIELD_PAY_MONEY_REVIEW', 'Another payment needs verification before this receipt can be accepted.', 409);
      if (balance(job) !== row.balanceAtSubmitCents) throw fail('FIELD_PAY_BALANCE_CHANGED', 'The balance changed after collection. Review the job before accepting this receipt.', 409);
      // mutateMoney builds the existing verified offline ledger, invoice, audit,
      // request receipt and funnel events. This scoped adapter adds the field
      // receipt decision and releases the lock IN THE SAME Firestore commit.
      let committed = false;
      const guarded = {
        ...ctx.store,
        read: async (collection, key) => {
          const value = await ctx.store.read(collection, key);
          if (collection !== 'jobs' || key !== job.id || !value) return value;
          if (committed && value.fieldPaymentPendingId == null && value.moneyRequestId === input.requestId) return value;
          if (value.fieldPaymentPendingId !== id || balance(value) !== row.balanceAtSubmitCents) throw fail('FIELD_PAY_BALANCE_CHANGED', 'The balance or field receipt changed. Refresh before accepting.', 409);
          return { ...value, fieldPaymentPendingId: null };
        },
        commit: async writes => {
          const money = writes.some(write => write.collection === MONEY_RECEIPTS && write.id === input.requestId.toLowerCase());
          if (!money) return ctx.store.commit(writes);
          const next = writes.map(write => write.collection === 'jobs' && write.id === job.id ? { ...write, patch: { ...write.patch, fieldPaymentPendingId: null, fieldPaymentSyncPendingIds: [...new Set([...(Array.isArray(job.fieldPaymentSyncPendingIds) ? job.fieldPaymentSyncPendingIds : []), `receipt:${id}`])] } } : write);
          const result = await ctx.store.commit([...next, { collection: SUBMISSIONS, id, revision: row.revision, patch: { ...patch, crmSyncStatus: 'pending' } }, portalGuard]);
          committed = true;
          return result;
        },
      };
      try {
        await mutateMoney(guarded, ctx.actor, { action: 'payment.record_offline', requestId: input.requestId, jobId: job.id, expectedRevision: job.revision, amountCents: row.amountCents, method: row.method, reference: row.reference }, at);
      } catch (error) {
        const saved = await ctx.store.read(SUBMISSIONS, id).catch(() => null);
        if (saved?.reviewRequestId !== input.requestId.toLowerCase() || saved.reviewFingerprint !== proof || saved.status !== 'accepted') throw error;
        return { alreadyApplied: true, row: saved };
      }
    }
    return { alreadyApplied: false, row: await ctx.store.read(SUBMISSIONS, id) };
  }
  async function cancelCard(ctx, job, input) {
    const current = await ctx.store.read(FIELD_CARD_CHECKOUTS, job.id), key = input.requestId.toLowerCase();
    if (!current || current.jobId !== job.id) throw fail('FIELD_PAY_CARD_NOT_FOUND', 'There is no field card checkout to cancel.', 404);
    if (current.status === 'expired' && current.cancelRequestId === key) return { alreadyApplied: true };
    if (!activeFieldCard(current)) throw fail('FIELD_PAY_CARD_CLOSED', 'This card checkout is no longer open. Refresh before collecting.', 409);
    if (current.revision !== input.expectedRevision || job.fieldPaymentCardRequestId !== current.requestId) throw fail('FIELD_PAY_CARD_CONFLICT', 'The card checkout changed. Refresh before cancelling it.', 409);
    const secret = stripeSecretKey(ctx.env);
    if (!secret) throw fail('FIELD_PAY_STRIPE_UNAVAILABLE', 'Stripe is unavailable; the earlier card checkout cannot be ruled out.', 503);
    if (!current.sessionId && !fieldCardCanRecover(current)) throw fail('FIELD_PAY_CARD_RECONCILE_REQUIRED', 'This card checkout has an unknown Stripe outcome. Operations must reconcile it before another collection.', 409);
    let checkout = current.sessionId ? await stripeRequest(secret, `checkout/sessions/${encodeURIComponent(current.sessionId)}`)
      : await stripeRequest(secret, 'checkout/sessions', { method: 'POST', headers: { 'Idempotency-Key': current.key }, body: new URLSearchParams(current.params) });
    if (!checkout?.id || checkout.metadata?.kind !== 'egc_job_payment' || checkout.metadata?.job_id !== job.id || checkout.metadata?.field_pay_mode !== 'exact_balance' || checkout.client_reference_id !== job.id) throw fail('FIELD_PAY_CARD_UNVERIFIED', 'The earlier card checkout could not be verified.', 503);
    if (checkout.status === 'complete') throw Object.assign(fail('FIELD_PAY_CARD_PAID', 'Stripe says this card checkout completed. Verify it before collecting cash or check.', 409), { sessionId: checkout.id });
    if (checkout.status === 'open') checkout = await stripeRequest(secret, `checkout/sessions/${encodeURIComponent(checkout.id)}/expire`, { method: 'POST' });
    if (checkout.status !== 'expired') throw fail('FIELD_PAY_CARD_UNVERIFIED', 'Stripe has not confirmed that this card checkout is closed.', 503);
    const session = await ctx.store.read(FIELD_CARD_SESSIONS, checkout.id);
    try {
      await ctx.store.commit([
        { collection: 'jobs', id: job.id, revision: job.revision, patch: { fieldPaymentCardRequestId: null } },
        { collection: FIELD_CARD_CHECKOUTS, id: job.id, revision: current.revision, patch: { status: 'expired', sessionId: checkout.id, url: null, cancelRequestId: key, cancelledAt: now().toISOString() } },
        ...(session?.jobId === job.id && session.sessionId === checkout.id ? [{ collection: FIELD_CARD_SESSIONS, id: checkout.id, revision: session.revision, patch: { status: 'expired' } }] : []),
      ]);
    } catch (error) {
      const saved = await ctx.store.read(FIELD_CARD_CHECKOUTS, job.id).catch(() => null);
      if (saved?.status !== 'expired' || saved.cancelRequestId !== key || saved.sessionId !== checkout.id) throw error;
      return { alreadyApplied: true };
    }
    return { alreadyApplied: false };
  }
  const errorResponse = error => reply(error.status || 503, { ok: false, code: error.code || 'FIELD_PAY_UNAVAILABLE', error: error.code ? error.message : 'Field payment services could not confirm this request. Retry with the same request ID.', ...(error.sessionId ? { sessionId: error.sessionId } : {}) });
  return {
    async get({ request, env }) {
      try {
        if (!originAllowed(request)) throw fail('FIELD_PAY_ORIGIN_FORBIDDEN', 'Open field payments in the Employee Hub.', 403);
        const params = new URL(request.url).searchParams, keys = [...params.keys()];
        if (new Set(keys).size !== keys.length || keys.some(key => !['job_id', 'receipt_id'].includes(key)) || !params.has('job_id')) throw fail('FIELD_PAY_QUERY_INVALID', 'Choose one job.');
        const ctx = await context(request, env), job = await authorized(ctx, params.get('job_id'));
        if (params.has('receipt_id')) {
          if (!ctx.manager) throw fail('FIELD_PAY_RECEIPT_FORBIDDEN', 'Receipt photos are available to operations managers.', 403);
          const id = params.get('receipt_id');
          if (!UUID(id)) throw fail('FIELD_PAY_RECEIPT_NOT_FOUND', 'This receipt is unavailable.', 404);
          const row = await ctx.store.read(SUBMISSIONS, id.toLowerCase());
          if (!row || row.jobId !== job.id || row.receipt?.verified !== true) throw fail('FIELD_PAY_RECEIPT_NOT_FOUND', 'This receipt is unavailable.', 404);
          const receipt = await ctx.store.read(RECEIPTS, id.toLowerCase());
          if (!receipt || receipt.jobId !== job.id || receipt.submissionId !== row.id || receipt.fingerprint !== row.fingerprint || !['image/jpeg', 'image/png', 'image/webp'].includes(receipt.mime) || !Number.isSafeInteger(receipt.bytes) || receipt.bytes < 12 || receipt.bytes > MAX_IMAGE_BYTES || typeof receipt.base64 !== 'string') throw fail('FIELD_PAY_RECEIPT_INVALID', 'This receipt needs operations review.', 503);
          const picture = decodeFieldPhoto(`data:${receipt.mime};base64,${receipt.base64}`);
          if (picture.bytes.length !== receipt.bytes || picture.mime !== row.receipt.mime) throw fail('FIELD_PAY_RECEIPT_INVALID', 'This receipt needs operations review.', 503);
          return new Response(picture.bytes, { status: 200, headers: { 'Content-Type': picture.mime, 'Content-Disposition': 'inline', 'Content-Security-Policy': "default-src 'none'", 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } });
        }
        return reply(200, { ok: true, ...await listing(ctx, job) });
      } catch (error) { return errorResponse(error); }
    },
    async post({ request, env }) {
      try {
        if (!originAllowed(request)) throw fail('FIELD_PAY_ORIGIN_FORBIDDEN', 'Open field payments in the Employee Hub.', 403);
        const ctx = await context(request, env), input = await readBody(request), job = await authorized(ctx, input.jobId);
        const result = input.action === 'submit' ? await submit(ctx, job, input, env) : input.action === 'cancel_card' ? await cancelCard(ctx, job, input)
          : input.action === 'sync_payment' ? (requireMoneyManager(ctx.actor, ctx.env), { alreadyApplied: false }) : await review(ctx, job, input);
        const sync = input.action === 'accept' || input.action === 'sync_payment'
          ? await syncFieldPayment(env, ctx.store, job.id, input.action === 'accept' ? 'receipt' : input.kind, input.action === 'accept' ? input.submissionId.toLowerCase() : input.sourceId).catch(error => ({ synced: false, code: error.code || 'FIELD_PAY_CRM_RETRY_REQUIRED' })) : null;
        return reply(200, { ok: true, alreadyApplied: result.alreadyApplied, ...(sync ? { crmSynced: sync.synced, ...(sync.code ? { crmCode: sync.code } : {}) } : {}), ...await listing(ctx, await authorized(ctx, job.id)) });
      } catch (error) { return errorResponse(error); }
    },
  };
}

const handlers = fieldPaymentHandlers();
export const onRequestGet = handlers.get;
export const onRequestPost = handlers.post;
