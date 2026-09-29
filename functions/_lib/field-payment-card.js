// One durable exact-balance field card checkout claim per job. A claim is
// committed with the current job revision before Stripe is contacted; another
// device cannot create a second session with a different request ID. A lost
// Stripe response reuses the saved key and exact parameters.
export const FIELD_CARD_CHECKOUTS = 'fieldPaymentCardCheckouts';
export const FIELD_CARD_SESSIONS = 'fieldPaymentCardSessions';
const PORTAL_CHECKOUTS = 'customer_payment_checkouts';
export const activeFieldCard = row => row?.status === 'creating' || row?.status === 'open';
// Stripe may prune an idempotency key after 24 hours. Stop recovery early so
// an unknown checkout can never be recreated under the same key after expiry.
const STRIPE_RECOVERY_MS = 23 * 60 * 60 * 1000;
export const fieldCardCanRecover = (row, at = Date.now()) => {
  const created = typeof row?.createdAt === 'string' ? Date.parse(row.createdAt) : NaN;
  return Number.isFinite(created) && created <= at && at - created < STRIPE_RECOVERY_MS;
};
const fail = (code, message, status = 409, extra = {}) => Object.assign(new Error(message), { code, status, ...extra });

// A Firestore precondition on the portal's checkout ledger closes the race
// where a portal request and a field collection both read the same job before
// either has claimed it. An inactive row gets a harmless versioned update;
// an absent row gets an exists:false precondition-only delete.
export async function fieldPortalGuard(store, jobId, now) {
  const row = await store.read(PORTAL_CHECKOUTS, jobId);
  if (!row) return { collection: PORTAL_CHECKOUTS, id: jobId, delete: true, exists: false };
  if (!['expired', 'settled'].includes(row.status)) throw fail('FIELD_PAY_PORTAL_CHECKOUT_OPEN', 'A customer card checkout may still be open. Ask operations to verify or close it before collecting another payment.');
  return { collection: PORTAL_CHECKOUTS, id: jobId, revision: row.revision, patch: { fieldPayGuardAt: now } };
}

export async function fieldCardClaim(store, job, { requestId, amountCents, tipCents, actorId, params, now, guards = [] }) {
  const id = requestId.toLowerCase(), previous = await store.read(FIELD_CARD_CHECKOUTS, job.id);
  if (activeFieldCard(previous)) {
    if (previous.requestId === id && previous.amountCents === amountCents && previous.tipCents === tipCents && previous.actorId === actorId && previous.params === params.toString()) return previous;
    throw fail('FIELD_PAY_CARD_OPEN', 'An earlier card checkout is still open. Verify or cancel it before taking another payment.', 409, { sessionId: previous.sessionId || '' });
  }
  if (previous?.requestId === id) throw fail('FIELD_PAY_REQUEST_REUSED', 'This card request already closed. Refresh and start a new checkout with a new request ID.');
  if (job.fieldPaymentPendingId) throw fail('FIELD_PAY_PENDING_REVIEW', 'A cash or check receipt is awaiting review. Do not charge again.');
  const row = { jobId: job.id, requestId: id, amountCents, tipCents, actorId, params: params.toString(), key: `egc-field-payment:${job.id}:${id}${tipCents ? `:tip:${tipCents}` : ''}`, status: 'creating', sessionId: '', createdAt: now };
  try {
    await store.commit([
      { collection: 'jobs', id: job.id, revision: job.revision, patch: { fieldPaymentCardRequestId: id } },
      { collection: FIELD_CARD_CHECKOUTS, id: job.id, ...(previous ? { revision: previous.revision } : { exists: false }), patch: row },
      ...guards,
    ]);
  } catch (error) {
    const saved = await store.read(FIELD_CARD_CHECKOUTS, job.id).catch(() => null);
    if (!activeFieldCard(saved) || saved.requestId !== id || saved.amountCents !== amountCents || saved.tipCents !== tipCents || saved.actorId !== actorId || saved.params !== params.toString()) throw error;
    return saved;
  }
  return store.read(FIELD_CARD_CHECKOUTS, job.id);
}

export async function fieldCardOpen(store, row, checkout) {
  if (!row || !checkout?.id || !/^https:\/\/checkout\.stripe\.com\//.test(checkout.url || '')) throw fail('FIELD_PAY_CARD_UNVERIFIED', 'Stripe did not confirm a safe field checkout.', 502);
  try {
    await store.commit([
      { collection: FIELD_CARD_CHECKOUTS, id: row.jobId, revision: row.revision, patch: { status: 'open', sessionId: checkout.id, url: checkout.url } },
      { collection: FIELD_CARD_SESSIONS, id: checkout.id, exists: false, patch: { jobId: row.jobId, requestId: row.requestId, amountCents: row.amountCents, tipCents: row.tipCents, sessionId: checkout.id, status: 'open', createdAt: row.createdAt } },
    ]);
  } catch (error) {
    const saved = await store.read(FIELD_CARD_CHECKOUTS, row.jobId).catch(() => null);
    if (saved?.requestId !== row.requestId || saved.sessionId !== checkout.id || saved.status !== 'open') throw error;
    return saved;
  }
  return store.read(FIELD_CARD_CHECKOUTS, row.jobId);
}

export async function fieldCardClose(store, row, status) {
  if (!['expired', 'settled'].includes(status)) throw new Error('Unsupported field card status');
  const job = await store.read('jobs', row.jobId);
  const session = row.sessionId ? await store.read(FIELD_CARD_SESSIONS, row.sessionId) : null;
  try { await store.commit([
    { collection: FIELD_CARD_CHECKOUTS, id: row.jobId, revision: row.revision, patch: { status } },
    ...(job?.fieldPaymentCardRequestId === row.requestId ? [{ collection: 'jobs', id: row.jobId, revision: job.revision, patch: { fieldPaymentCardRequestId: null } }] : []),
    ...(session?.jobId === row.jobId && session.sessionId === row.sessionId ? [{ collection: FIELD_CARD_SESSIONS, id: row.sessionId, revision: session.revision, patch: { status } }] : []),
  ]); }
  catch (error) {
    const saved = await store.read(FIELD_CARD_CHECKOUTS, row.jobId).catch(() => null);
    if (saved?.requestId !== row.requestId || saved.status !== status) throw error;
    return saved;
  }
  return store.read(FIELD_CARD_CHECKOUTS, row.jobId);
}
