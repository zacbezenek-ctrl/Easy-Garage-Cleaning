/* PORTAL-INBOX: every client portal message reaches the office's Hub. The
   portal's send_message writes the job's customerMessageAlerts entry in the
   SAME commit as the message, so a stored message always has its entry. A job
   has at most one open entry (the job's customerMessageAlertId points at it):
   the first message opens it (id derived from the job and that message,
   created once), and later ones append to it and raise its count until a
   person marks it handled, so a chatty customer is one Hub row, not one per
   message. A replayed request is answered as a duplicate before any write.
   The Hub lists open entries by their latest message. Nothing here writes to
   HighLevel or messages the customer. */
import { firestoreFetch } from './firebase-service-account.js';
import { decodeFirestoreFields, encodeFirestoreFields } from './firestore-job.js';
import { cleanMessage } from './customer-messaging.js';

// Server-only collection; firestore.rules denies every browser read and write.
export const CUSTOMER_MESSAGE_ALERTS = 'customerMessageAlerts';
export const ALERT_STATUSES = Object.freeze(['open', 'handled']);
// Open entries one Hub read lists.
export const ALERT_LIST_LIMIT = 100;
// Messages an entry keeps (newest last); its messageCount keeps counting past them.
export const ALERT_MESSAGE_LIMIT = 20;
const ROOT = 'projects/egcw-1ec83/databases/(default)/documents';
const BASE = `https://firestore.googleapis.com/v1/${ROOT}`;
const ENTRY_ID = /^cma_[0-9a-f]{40}$/;
const inline = (value, max = 180) => String(value ?? '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, max);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const hex = buffer => [...new Uint8Array(buffer)].map(byte => byte.toString(16).padStart(2, '0')).join('');
const fail = (code, message, status = 400) => Object.assign(new Error(message), { code, status });

export const validAlertId = id => typeof id === 'string' && ENTRY_ID.test(id);

/** The entry id for one message: the same job and message always name the same entry. */
export async function customerMessageAlertId(jobId, messageId) {
  return `cma_${hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${jobId}|${messageId}`))).slice(0, 40)}`;
}

const entryMessage = (message, now) => ({ id: inline(message.id, 140), authorName: inline(message.authorName, 120) || 'Customer', body: cleanMessage(message.body), createdAt: inline(message.createdAt, 50) || now });
const storedMessages = alert => (Array.isArray(alert?.messages) ? alert.messages : []).filter(object).slice(-ALERT_MESSAGE_LIMIT);

/** The entry the portal commits beside the first customer message while none is open for the job. */
export function newCustomerMessageAlert(job = {}, jobId, message = {}, now) {
  const first = entryMessage(message, now);
  return {
    jobId: inline(jobId, 180), messageId: first.id, requestId: inline(message.requestId, 120),
    authorName: first.authorName, customerName: inline(job.customer, 120) || first.authorName,
    jobType: inline(job.type, 40), serviceType: inline(job.serviceType, 120), jobDate: inline(job.date, 20),
    body: first.body, createdAt: first.createdAt, lastMessageAt: first.createdAt, messages: [first], messageCount: 1,
    status: 'open', handledAt: '', handledBy: '', updatedAt: now,
  };
}

/** The patch that adds a later message to the job's open entry: no second Hub row. */
export function appendCustomerMessageAlert(alert = {}, job = {}, message = {}, now) {
  const next = entryMessage(message, now);
  return {
    messages: [...storedMessages(alert), next].slice(-ALERT_MESSAGE_LIMIT),
    messageCount: (Number.isSafeInteger(alert.messageCount) && alert.messageCount > 0 ? alert.messageCount : storedMessages(alert).length || 1) + 1,
    body: next.body, authorName: next.authorName, lastMessageAt: next.createdAt, updatedAt: now,
  };
}

export function customerMessageAlertStorage(env, fetcher = firestoreFetch) {
  const unavailable = () => fail('customer_messages_unavailable', 'Customer messages could not be loaded. Retry.', 503);
  const decode = document => {
    const id = String(document?.name || '').split(`/documents/${CUSTOMER_MESSAGE_ALERTS}/`)[1] || '';
    if (!validAlertId(id) || typeof document.updateTime !== 'string' || !document.updateTime) throw fail('customer_messages_incomplete', 'A customer message had no verifiable identity. Retry.', 503);
    return { ...decodeFirestoreFields(document.fields || {}), id, revision: document.updateTime };
  };
  async function call(url, init) {
    let response;
    try { response = await fetcher(env, url, { ...init, signal: AbortSignal.timeout(20000) }); } catch { throw unavailable(); }
    return response;
  }
  return {
    async read(id) {
      const response = await call(`${BASE}/${CUSTOMER_MESSAGE_ALERTS}/${encodeURIComponent(id)}`, {});
      if (response.status === 404) return null;
      if (!response.ok) throw unavailable();
      return decode(await response.json().catch(() => null));
    },
    async query(where, orderBy, limit) {
      const response = await call(`${BASE}:runQuery`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ structuredQuery: {
        from: [{ collectionId: CUSTOMER_MESSAGE_ALERTS }], where: { fieldFilter: { field: { fieldPath: where[0] }, op: 'EQUAL', value: { stringValue: where[1] } } },
        ...(orderBy ? { orderBy: [{ field: { fieldPath: orderBy[0] }, direction: orderBy[1] }] } : {}), limit,
      } }) });
      if (!response.ok) {
        const detail = await response.json().catch(() => null);
        // A Pages deployment does not deploy Firestore indexes. Recognize only the
        // provider's index precondition; permission/outage errors must still fail.
        if (response.status === 400 && detail?.error?.status === 'FAILED_PRECONDITION'
          && /requires an index|index.*(?:building|not ready)/i.test(String(detail.error.message || ''))) {
          throw fail('customer_messages_index_required', 'Customer messages need a database index. Ask the owner to deploy firestore.indexes.json and wait for the index to finish building.', 503);
        }
        throw unavailable();
      }
      const rows = response.ok ? await response.json().catch(() => null) : null;
      if (!Array.isArray(rows)) throw unavailable();
      return rows.filter(row => row?.document).map(row => decode(row.document));
    },
    /** Open entries, latest message first (index: status, lastMessageAt desc); complete:false when more are open. */
    async open(limit = ALERT_LIST_LIMIT) {
      let found;
      try {
        found = await this.query(['status', 'open'], ['lastMessageAt', 'DESCENDING'], limit + 1);
      } catch (error) {
        if (error?.code !== 'customer_messages_index_required') throw error;
        // Single-field equality needs no composite index. Only sort locally when
        // every open entry fits: a truncated unordered query cannot identify the
        // newest messages. Never replace an incomplete inbox with a false zero.
        found = await this.query(['status', 'open'], null, limit + 1);
        if (found.length > limit) throw error;
        found.sort((a, b) => String(b.lastMessageAt || b.createdAt || '').localeCompare(String(a.lastMessageAt || a.createdAt || '')) || a.id.localeCompare(b.id));
      }
      return { rows: found.slice(0, limit), complete: found.length <= limit };
    },
    /** One field-masked write. revision guards a compare-and-set; without it the entry must exist. Returns the new revision, or null on a lost race. */
    async write(id, patch, revision = '') {
      const response = await call(`${BASE}:commit`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ writes: [{
        update: { name: `${ROOT}/${CUSTOMER_MESSAGE_ALERTS}/${encodeURIComponent(id)}`, fields: encodeFirestoreFields(patch) },
        updateMask: { fieldPaths: Object.keys(patch) },
        currentDocument: revision ? { updateTime: revision } : { exists: true },
      }] }) });
      if (response.ok) { const data = await response.json().catch(() => null); return String(data?.writeResults?.[0]?.updateTime || data?.commitTime || 'written'); }
      if ([400, 404, 409, 412].includes(response.status)) return null;
      throw unavailable();
    },
  };
}

/** What the Hub list shows for an entry: no request ids. */
export function customerMessageView(alert) {
  return {
    id: alert.id, jobId: inline(alert.jobId, 180), customerName: inline(alert.customerName, 120), authorName: inline(alert.authorName, 120),
    body: cleanMessage(alert.body), createdAt: inline(alert.createdAt, 50), lastMessageAt: inline(alert.lastMessageAt || alert.createdAt, 50),
    messageCount: Number.isSafeInteger(alert.messageCount) && alert.messageCount > 0 ? alert.messageCount : 1,
    messages: storedMessages(alert).slice(-5).map(row => ({ authorName: inline(row.authorName, 120), body: cleanMessage(row.body), createdAt: inline(row.createdAt, 50) })),
    jobType: inline(alert.jobType, 40), serviceType: inline(alert.serviceType, 120), jobDate: inline(alert.jobDate, 20),
    status: ALERT_STATUSES.includes(alert.status) ? alert.status : 'open', revision: inline(alert.revision, 60),
  };
}

export async function listCustomerMessages(store, { limit = ALERT_LIST_LIMIT } = {}) {
  const { rows, complete } = await store.open(limit);
  return { rows, messages: rows.map(customerMessageView), total: rows.length, complete };
}

const countOf = alert => Number.isSafeInteger(alert?.messageCount) && alert.messageCount > 0 ? alert.messageCount : 1;

/** Marks an entry handled; marking a handled entry again answers alreadyHandled. seenCount is the messageCount the
 *  person was shown: a message that joined the entry since then (checked on every read, so also one that lands
 *  between the read and the guarded write) is never marked handled unseen; the answer is a 409 to refresh. */
export async function markCustomerMessageHandled(store, input, actor, now) {
  if (!object(input) || input.action !== 'mark_handled' || !validAlertId(input.id) || !Number.isSafeInteger(input.seenCount) || input.seenCount < 1) throw fail('customer_messages_invalid', 'Choose a customer message to mark handled.');
  const by = inline(actor?.displayName || actor?.name || actor?.user, 120) || 'Hub user';
  for (let round = 0; round < 3; round += 1) {
    const alert = await store.read(input.id);
    if (!alert) throw fail('customer_messages_not_found', 'That customer message was not found. Refresh the list.', 404);
    if (alert.status === 'handled') return { ok: true, alreadyHandled: true, message: customerMessageView(alert) };
    if (countOf(alert) > input.seenCount) throw Object.assign(fail('customer_messages_changed', 'A new message arrived. Read it before marking this handled.', 409), { latest: customerMessageView(alert) });
    const patch = { status: 'handled', handledAt: now, handledBy: by, updatedAt: now };
    const revision = await store.write(input.id, patch, alert.revision);
    if (revision) return { ok: true, message: customerMessageView({ ...alert, ...patch, revision }) };
  }
  throw fail('customer_messages_conflict', 'That message changed while saving. Refresh and try again.', 409);
}
