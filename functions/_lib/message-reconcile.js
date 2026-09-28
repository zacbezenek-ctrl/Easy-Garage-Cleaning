import { firestoreFetch } from './firebase-service-account.js';
import { decodeFirestoreFields } from './firestore-job.js';
import { requireDispatcher } from './dispatch-service.js';
import { auditWrite } from './hub-audit.js';
import { preconditionFetcher } from './firestore-precondition.js';
import { messageDigest } from './message-templates.js';
import { messagePolicy } from './message-policies.js';
import { TEMPLATE_KINDS } from './message-template-defaults.js';
import { MESSAGE_OPERATIONS, MESSAGE_SENDS, messagingStorage } from './message-send-store.js';

/**
 * Reconciling approved sends whose outcome nobody knows (MSG-CORE gap).
 * The send ledger never resends an 'uncertain' message or one left in
 * 'sending' by a delivery that never saved its result. A manager checks the
 * HighLevel conversation and records what happened:
 *   delivered     -> 'submitted' (the message counts as sent)
 *   not_delivered -> 'failed'. Within the policy's attempts a person may send
 *                    it again after a new preview and confirm, and a send the
 *                    owner's automation (cron, owner_automation) made may be
 *                    sent again by that automation. With resend:false the
 *                    ledger's attempts are set to the policy maximum, so
 *                    nobody and no automation sends it again.
 * One commit holds the ledger change (its revision), a create-only
 * message_operations/{requestId} receipt and a hub_audit entry. Nothing is
 * sent from here. A 'sending' claim younger than SENDING_STALE_MS may still be
 * in flight and cannot be reconciled yet.
 * If HighLevel answers the reconciled attempt later, approved-send.js keeps
 * that answer as lateResult beside the person's outcome (an accepted message is
 * then never sent again); the list shows those from the last LATE_RESULT_DAYS.
 */
const ROOT = 'projects/egcw-1ec83/databases/(default)/documents';
const BASE = `https://firestore.googleapis.com/v1/${ROOT}`;
export const SENDING_STALE_MS = 10 * 60 * 1000;
export const UNSETTLED_LIMIT = 200;
export const RECONCILE_OUTCOMES = Object.freeze(['delivered', 'not_delivered']);
export const LATE_RESULT_DAYS = 7;
export const LATE_RESULT_LIMIT = 50;
const UNSETTLED = ['uncertain', 'sending'];
const KEYS = ['action', 'requestId', 'ledgerId', 'expectedRevision', 'outcome', 'note', 'resend', 'actorId'];
const FINAL = new Set(['messaging_idempotency_conflict', 'messaging_changed_since_operation', 'messaging_actor_changed']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LEDGER_ID = /^[a-f0-9]{64}$/;
const fail = (code, message, status = 400, details) => Object.assign(new Error(message), { code: 'messaging_' + code, status, ...(details ? { details } : {}) });
const text = (value, max = 200) => typeof value === 'string' ? value.replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, ' ').trim().slice(0, max) : '';
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const safeId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,180}$/.test(value) && !/^(_egc_|secure_)/.test(value);
const newestFirst = (a, b) => String(b.attemptedAt || '').localeCompare(String(a.attemptedAt || '')) || String(a.id).localeCompare(String(b.id));

/**
 * 'sending' within SENDING_STALE_MS of its claim may still reach HighLevel.
 * The claim time is attemptedAt, else the record's last write (its revision,
 * the Firestore updateTime); a row with neither is stale, never stuck forever.
 */
export function sendInFlight(row, now) {
  if (row?.status !== 'sending') return false;
  const claimed = [row.attemptedAt, row.revision].map(value => typeof value === 'string' ? Date.parse(value) : NaN).find(Number.isFinite);
  return claimed !== undefined && Date.parse(now) - claimed < SENDING_STALE_MS;
}
// After 'not delivered' the owner's automation may send it again on its own: it made this send, or
// the kind is one it sends (the ledger is per message, whoever sent it first).
const automationMayResend = (row, policy) => row?.approval === 'owner_automation' || row?.source === 'cron' || Boolean(policy?.approvals?.includes('owner_automation') && policy?.triggers?.includes('cron'));

export function messageReconcileStorage(env, fetcher = firestoreFetch) {
  const base = messagingStorage(env, preconditionFetcher(fetcher));
  const unavailable = () => fail('storage_unavailable', 'Message records could not be loaded. Retry.', 503);
  async function call(url, body) {
    let response;
    try { response = await fetcher(env, url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(20000), body: JSON.stringify(body) }); }
    catch { throw unavailable(); }
    if (!response.ok) throw unavailable();
    return response.json().catch(() => null);
  }
  const decode = (document, collection) => {
    const id = String(document?.name || '').split(`/documents/${collection}/`)[1] || '';
    if (!id || id.includes('/') || typeof document.updateTime !== 'string' || !document.updateTime) throw fail('storage_incomplete', 'A message record had no verifiable identity. Retry.', 503);
    return { ...decodeFirestoreFields(document.fields || {}), id, revision: document.updateTime };
  };
  return {
    ...base,
    /** Sends whose outcome is unknown, newest first; complete:false when more than `limit` exist. */
    async unsettled(limit = UNSETTLED_LIMIT) {
      const rows = await call(`${BASE}:runQuery`, { structuredQuery: {
        from: [{ collectionId: MESSAGE_SENDS }], where: { fieldFilter: { field: { fieldPath: 'status' }, op: 'IN', value: { arrayValue: { values: UNSETTLED.map(stringValue => ({ stringValue })) } } } }, limit: limit + 1,
      } });
      if (!Array.isArray(rows)) throw fail('storage_incomplete', 'Message records returned an incomplete response. Retry.', 503);
      const found = rows.filter(row => row?.document).map(row => decode(row.document, MESSAGE_SENDS)), ids = new Set(found.map(row => row.id));
      if (ids.size !== found.length) throw fail('storage_incomplete', 'Message records returned duplicates. Retry.', 503);
      return { rows: found.slice(0, limit), complete: found.length <= limit };
    },
    /** Sends HighLevel answered after a person reconciled them, newest first, since the given instant. */
    async lateResults(since, limit = LATE_RESULT_LIMIT) {
      const rows = await call(`${BASE}:runQuery`, { structuredQuery: {
        from: [{ collectionId: MESSAGE_SENDS }], where: { fieldFilter: { field: { fieldPath: 'lateResult.at' }, op: 'GREATER_THAN_OR_EQUAL', value: { stringValue: since } } },
        orderBy: [{ field: { fieldPath: 'lateResult.at' }, direction: 'DESCENDING' }], limit: limit + 1,
      } });
      if (!Array.isArray(rows)) throw fail('storage_incomplete', 'Message records returned an incomplete response. Retry.', 503);
      const found = rows.filter(row => row?.document).map(row => decode(row.document, MESSAGE_SENDS));
      if (new Set(found.map(row => row.id)).size !== found.length) throw fail('storage_incomplete', 'Message records returned duplicates. Retry.', 503);
      return { rows: found.slice(0, limit), complete: found.length <= limit };
    },
    /** Display names for jobs/customers, reading only the name fields (one request per 100). */
    async names(collection, ids) {
      const names = new Map(), fields = collection === 'jobs' ? ['customer'] : ['name', 'firstName', 'lastName'];
      for (let index = 0; index < ids.length; index += 100) {
        const rows = await call(`${BASE}:batchGet`, { documents: ids.slice(index, index + 100).map(id => `${ROOT}/${collection}/${id}`), mask: { fieldPaths: fields } });
        if (!Array.isArray(rows)) throw fail('storage_incomplete', 'Message recipients returned an incomplete response. Retry.', 503);
        for (const row of rows) if (row?.found) { const value = decode(row.found, collection); names.set(value.id, text(value.customer || value.name || [value.firstName, value.lastName].filter(Boolean).join(' '), 200)); }
      }
      return names;
    },
  };
}

const lateView = late => plain(late) ? { status: text(late.status, 20), messageId: text(late.messageId, 120), httpStatus: Number.isInteger(late.httpStatus) ? late.httpStatus : null, reason: text(late.reason, 80), at: text(late.at, 40) } : null;
function sendView(row, now, names = new Map()) {
  const policy = messagePolicy(row.kind), status = text(row.status, 20), attempts = Number.isSafeInteger(row.attempts) ? row.attempts : 0, lateResult = lateView(row.lateResult);
  return {
    id: row.id, revision: text(row.revision, 80), kind: text(row.kind, 60), label: text(TEMPLATE_KINDS[policy?.template]?.label, 80) || text(row.kind, 60), audience: text(row.audience, 20),
    targetType: text(row.targetType, 20), targetId: text(row.targetId, 180), targetName: names.get(`${row.targetType}:${row.targetId}`) || '',
    channel: text(row.channel, 10), recipient: text(row.recipient, 120), status, inFlight: sendInFlight(row, now), attempts,
    approval: text(row.approval, 40), automationMayResend: automationMayResend(row, policy), maxAttempts: Number.isSafeInteger(policy?.maxAttempts) ? policy.maxAttempts : null,
    resendable: status === 'failed' && Number.isSafeInteger(policy?.maxAttempts) && attempts < policy.maxAttempts && lateResult?.status !== 'submitted',
    attemptedAt: text(row.attemptedAt, 40), completedAt: text(row.completedAt, 40), reason: text(row.reason, 80), httpStatus: Number.isInteger(row.httpStatus) ? row.httpStatus : null,
    actorId: text(row.actorId, 80), source: text(row.source, 20), subject: text(row.subject, 200), excerpt: text(String(row.body || '').replace(/\s+/g, ' '), 280),
    reconciled: plain(row.reconciled) ? { outcome: text(row.reconciled.outcome, 20), by: text(row.reconciled.by, 80), at: text(row.reconciled.at, 40), note: text(row.reconciled.note, 500), ...(row.reconciled.outcome === 'not_delivered' ? { resend: row.reconciled.resend !== false } : {}) } : null,
    ...(lateResult ? { lateResult } : {}),
  };
}

/** Owner/manager list of approved sends whose outcome is unknown. `now` is an ISO string. */
export async function unsettledMessageSends(store, actor, now = new Date().toISOString()) {
  requireDispatcher(actor);
  const { rows, complete } = await store.unsettled(UNSETTLED_LIMIT), names = new Map();
  const lookup = async list => {
    for (const [targetType, collection] of [['job', 'jobs'], ['account', 'customers']]) {
      const ids = [...new Set(list.filter(row => row.targetType === targetType && safeId(row.targetId) && !names.has(`${targetType}:${row.targetId}`)).map(row => row.targetId))];
      if (ids.length) for (const [id, name] of await store.names(collection, ids)) names.set(`${targetType}:${id}`, name);
    }
  };
  await lookup(rows);
  const sends = rows.filter(row => UNSETTLED.includes(row.status)).sort(newestFirst).map(row => sendView(row, now, names));
  // HighLevel's answer arrived after a person reconciled the send: shown beside what the person recorded.
  const since = new Date(Date.parse(now) - LATE_RESULT_DAYS * 86400000).toISOString(), late = await store.lateResults(since, LATE_RESULT_LIMIT);
  const lateRows = late.rows.filter(row => plain(row.lateResult) && plain(row.reconciled));
  await lookup(lateRows);
  const lateResults = lateRows.sort((a, b) => String(b.lateResult.at || '').localeCompare(String(a.lateResult.at || '')) || String(a.id).localeCompare(String(b.id))).map(row => sendView(row, now, names));
  return {
    ok: true, authority: 'employee_hub', sends, counts: { unsettled: sends.length, inFlight: sends.filter(row => row.inFlight).length }, staleAfterMinutes: SENDING_STALE_MS / 60000, coverage: { complete, asOf: now },
    lateResults, lateResultCoverage: { complete: late.complete, since, days: LATE_RESULT_DAYS },
  };
}

function validate(input, actor) {
  if (!plain(input) || input.action !== 'reconcile' || typeof input.requestId !== 'string' || !UUID.test(input.requestId)) throw fail('request_invalid', 'Use the reconcile action with a unique request ID.');
  const unknown = Object.keys(input).filter(key => !KEYS.includes(key));
  if (unknown.length) throw fail('request_invalid', 'This request contains unsupported fields. Refresh and try again.', 400, { fields: unknown.slice(0, 10) });
  if (typeof input.ledgerId !== 'string' || !LEDGER_ID.test(input.ledgerId)) throw fail('request_invalid', 'Choose a valid message.');
  if (typeof input.expectedRevision !== 'string' || !input.expectedRevision || input.expectedRevision.length > 100) throw fail('request_invalid', 'Refresh the message list before reconciling.');
  if (!RECONCILE_OUTCOMES.includes(input.outcome)) throw fail('request_invalid', 'Choose whether the message was delivered.');
  if (input.resend !== undefined && (typeof input.resend !== 'boolean' || input.outcome !== 'not_delivered')) throw fail('request_invalid', 'Only a message marked not delivered can be stopped from being sent again.');
  if (input.actorId !== undefined && String(input.actorId).trim().toLowerCase() !== String(actor.user).trim().toLowerCase()) throw fail('actor_changed', 'The signed-in employee changed. Sign in as the original employee to finish this request, or discard it.', 403);
  if (typeof input.note !== 'string') throw fail('request_invalid', 'Say how you checked the message (for example, the HighLevel conversation).');
  const note = input.note.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, ' ').trim();
  if (note.length < 3 || note.length > 500) throw fail('request_invalid', 'Say how you checked the message, in 3 to 500 characters.');
  return note;
}

// Display copy on the job (communication log and the Command Center flag); never repeats a send.
async function mirror(store, send, status, now) {
  if (send.targetType !== 'job' || !safeId(send.targetId)) return 'skipped';
  const entryId = `msg:${send.id.slice(0, 32)}`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const job = await store.read('jobs', send.targetId);
      const log = Array.isArray(job?.communicationLog) ? job.communicationLog : [];
      if (!job || !log.some(item => item?.id === entryId)) return 'skipped';
      const patch = { communicationLog: log.map(item => item?.id === entryId ? { ...item, status, attempt: Number.isSafeInteger(send.attempts) ? send.attempts : item.attempt, reconciledAt: now } : item), updatedAt: now };
      if (status === 'submitted' && job.communicationLastStatus === 'needs_attention' && job.communicationLastEvent === send.kind) Object.assign(patch, { communicationLastStatus: 'submitted', communicationLastAt: now });
      await store.commit([{ collection: 'jobs', id: job.id, revision: job.revision, patch }]);
      return 'saved';
    } catch { /* Display copy only. */ }
  }
  return 'failed';
}

/** Record what happened to one unsettled send. `now` is an ISO string. */
export async function reconcileMessageSend(store, actor, input, now = new Date().toISOString()) {
  requireDispatcher(actor);
  const note = validate(input, actor), actorId = String(actor.user).toLowerCase();
  const fingerprint = await messageDigest({ scope: 'message_reconcile', actor: actorId, input }), receiptId = input.requestId.toLowerCase();
  const result = (send, replayed, mirrored = 'skipped') => ({ ok: true, authority: 'employee_hub', requestId: input.requestId, action: 'reconcile', replayed, send: sendView(send, now), mirror: mirrored });
  async function replay(replayed) {
    const receipt = await store.read(MESSAGE_OPERATIONS, receiptId);
    if (!receipt) return null;
    if (receipt.scope !== 'message_reconcile' || receipt.fingerprint !== fingerprint || receipt.actorId !== actorId) throw fail('idempotency_conflict', 'This request ID was already used for a different message change. Refresh before trying again.', 409);
    const send = await store.read(MESSAGE_SENDS, input.ledgerId);
    if (!send || send.reconciled?.requestId !== input.requestId) throw fail('changed_since_operation', 'That reconciliation was saved, but the message has changed since. Refresh the list.', 409);
    return result(send, replayed);
  }
  const prior = await replay(true);
  if (prior) return prior;
  let send;
  try {
    send = await store.read(MESSAGE_SENDS, input.ledgerId);
    if (!send) throw fail('send_not_found', 'This message record no longer exists. Refresh the list.', 404);
    if (!UNSETTLED.includes(send.status)) throw fail('reconcile_not_needed', 'This message already has a known outcome. Refresh the list.', 409, { status: text(send.status, 20) });
    if (send.revision !== input.expectedRevision) throw fail('revision_conflict', 'This message record changed after you opened it. Refresh and check it again.', 409);
    if (sendInFlight(send, now)) throw fail('reconcile_in_flight', `This message may still be sending. Wait ${SENDING_STALE_MS / 60000} minutes from the attempt, then check HighLevel before reconciling.`, 409);
    const status = input.outcome === 'delivered' ? 'submitted' : 'failed', reason = `reconciled_${input.outcome}`, attempts = Number.isSafeInteger(send.attempts) ? send.attempts : 0;
    // Stopping a resend uses the ledger's own rule: a failed send at the policy's maximum attempts is never sent again, by a person or the automation.
    const maxAttempts = messagePolicy(send.kind)?.maxAttempts, stop = input.resend === false, after = stop && Number.isSafeInteger(maxAttempts) ? Math.max(attempts, maxAttempts) : attempts;
    const patch = {
      status, reason, completedAt: send.completedAt || now, ...(after !== attempts ? { attempts: after } : {}),
      // A late result from the original delivery can no longer overwrite this record (its attemptId no longer matches).
      attemptId: `reconcile-${receiptId}`,
      // attemptId names the delivery this settled, so its late answer can be kept (approved-send.js lateResult).
      reconciled: { outcome: input.outcome, previousStatus: send.status, note, by: actorId, at: now, requestId: input.requestId, attemptId: text(send.attemptId, 80), ...(input.outcome === 'not_delivered' ? { resend: !stop } : {}) },
      history: [...(Array.isArray(send.history) ? send.history : []), { attempt: after, status, at: now, actorId, requestId: input.requestId, reconciled: true }].slice(-10),
    };
    const audit = auditWrite({ actor: { id: actorId, kind: 'human', role: actor.role }, via: 'hub', action: 'message.reconcile', entity: { collection: MESSAGE_SENDS, id: send.id },
      before: { status: send.status, reason: send.reason || '', attempts, kind: send.kind, targetType: send.targetType, targetId: send.targetId }, after: { status, reason, attempts: after, outcome: input.outcome, ...(input.outcome === 'not_delivered' ? { resend: !stop } : {}) }, requestId: input.requestId, reason: note, now });
    await store.commit([
      { collection: MESSAGE_SENDS, id: send.id, revision: send.revision, patch },
      { collection: MESSAGE_OPERATIONS, id: receiptId, patch: { scope: 'message_reconcile', fingerprint, actorId, action: 'reconcile', ledgerId: send.id, requestId: input.requestId, auditId: audit.id, createdAt: now } },
      audit,
    ]);
  } catch (error) {
    if (FINAL.has(error.code)) throw error;
    const recovered = await replay(false).catch(replayError => { if (FINAL.has(replayError.code)) throw replayError; return null; });
    if (recovered) return recovered;
    throw error;
  }
  const saved = await store.read(MESSAGE_SENDS, send.id);
  if (!saved) throw fail('outcome_unknown', 'The message record could not be read back. Retry the same request.', 503);
  if (saved.reconciled?.requestId !== input.requestId) throw fail('changed_since_operation', 'The reconciliation saved, but the message has changed again. Refresh the list.', 409);
  return result(saved, false, await mirror(store, saved, saved.status, now));
}
