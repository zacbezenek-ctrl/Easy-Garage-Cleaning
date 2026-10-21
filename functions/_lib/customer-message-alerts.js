/* PORTAL-INBOX: every client portal message reaches the office. The portal's
   send_message writes one customerMessageAlerts entry in the SAME commit as
   the message (id derived from the job and message, created once), so a
   stored message always has its alert and a replayed request never adds a
   second one. The entry stays open on the Hub's Customer messages list (and
   its unread badge) until a person marks it handled.
   Beside it, each entry owes one HighLevel task on the customer's contact,
   due at the send and assigned to EGC_CUSTOMER_MESSAGE_TASK_USER_ID (unset:
   unassigned). The send makes the first attempt after it answers the customer
   (ctx.waitUntil), so HighLevel never delays or fails the customer's send;
   every Hub list read retries due entries with a 1, 5, 15, 60 minute backoff
   and parks an entry after 8 attempts. An attempt claims the entry first
   (compare-and-set), and it reads the contact's tasks before it creates one,
   matching the entry's Ref line, so a retry after a lost response finds the
   task instead of adding another. Nothing here messages the customer. */
import { firestoreFetch } from './firebase-service-account.js';
import { decodeFirestoreFields, encodeFirestoreFields } from './firestore-job.js';
import { cleanMessage } from './customer-messaging.js';

// Server-only collection; firestore.rules denies every browser read and write.
export const CUSTOMER_MESSAGE_ALERTS = 'customerMessageAlerts';
export const ALERT_STATUSES = Object.freeze(['open', 'handled']);
// pending: owed and retried. created: HighLevel holds the task. not_needed: handled before a task was written.
// needs_contact / not_configured / failed (a definite 4xx) / parked are not retried by themselves.
export const TASK_STATUSES = Object.freeze(['pending', 'created', 'not_needed', 'needs_contact', 'not_configured', 'failed', 'parked']);
export const TASK_BACKOFF_MINUTES = Object.freeze([1, 5, 15, 60]);
export const TASK_PARK_ATTEMPTS = 8;
// A claim that never finished (the Worker died mid-attempt) is picked up again after this.
export const TASK_CLAIM_MINUTES = 2;
// Open entries one Hub read lists, and due tasks it retries.
export const ALERT_LIST_LIMIT = 100;
export const TASK_RETRY_LIMIT = 3;
export const TASK_TITLE_PREFIX = 'Reply to client portal message';
const API = 'https://services.leadconnectorhq.com';
const DEFAULT_ORIGIN = 'https://easygaragecleaning.com';
const ROOT = 'projects/egcw-1ec83/databases/(default)/documents';
const BASE = `https://firestore.googleapis.com/v1/${ROOT}`;
const ENTRY_ID = /^cma_[0-9a-f]{40}$/, CONTACT = /^[A-Za-z0-9_-]{1,120}$/, TASK_ID = /^[A-Za-z0-9_-]{1,120}$/;
const inline = (value, max = 180) => String(value ?? '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, max);
const ms = value => { const at = Date.parse(typeof value === 'string' ? value : ''); return Number.isFinite(at) ? at : NaN; };
const plus = (now, minutes) => new Date(ms(now) + minutes * 60000).toISOString();
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const hex = buffer => [...new Uint8Array(buffer)].map(byte => byte.toString(16).padStart(2, '0')).join('');
const fail = (code, message, status = 400) => Object.assign(new Error(message), { code, status });

export const customerMessageTaskUser = env => inline(env?.EGC_CUSTOMER_MESSAGE_TASK_USER_ID, 120);
export const taskBackoffMinutes = attempts => TASK_BACKOFF_MINUTES[Math.min(Math.max(attempts, 1), TASK_BACKOFF_MINUTES.length) - 1];
export const validAlertId = id => typeof id === 'string' && ENTRY_ID.test(id);

/** The entry id for one message: the same job and message always name the same entry. */
export async function customerMessageAlertId(jobId, messageId) {
  return `cma_${hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${jobId}|${messageId}`))).slice(0, 40)}`;
}

/** The entry the portal commits beside a stored customer message. */
export function newCustomerMessageAlert(job = {}, jobId, message = {}, now) {
  const contactId = inline(job.highlevelContactId, 120);
  return {
    jobId: inline(jobId, 180), messageId: inline(message.id, 140), requestId: inline(message.requestId, 120),
    authorName: inline(message.authorName, 120) || 'Customer', customerName: inline(job.customer, 120) || inline(message.authorName, 120) || 'Customer',
    jobType: inline(job.type, 40), serviceType: inline(job.serviceType, 120), jobDate: inline(job.date, 20),
    body: cleanMessage(message.body), createdAt: inline(message.createdAt, 50) || now,
    status: 'open', handledAt: '', handledBy: '',
    highlevelContactId: CONTACT.test(contactId) ? contactId : '',
    task: { status: CONTACT.test(contactId) ? 'pending' : 'needs_contact', attempts: 0, nextAttemptAt: now, claimedUntil: '', lastAttemptAt: '', taskId: '', httpStatus: 0 },
    updatedAt: now,
  };
}

const taskRef = id => `Ref: ${id}`;
export function customerMessageTaskBody(alert, origin = DEFAULT_ORIGIN) {
  const hub = `${/^https:\/\/[A-Za-z0-9.-]+(?::\d+)?$/.test(origin) ? origin : DEFAULT_ORIGIN}/employee.html?view=customer_messages`;
  return [`${alert.authorName} wrote in the client portal:`, '', cleanMessage(alert.body), '', `Reply to the customer, then mark it handled in the Hub: ${hub}`, taskRef(alert.id)].join('\n');
}

// The contact's tasks are read first, so a retry after a lost response finds the task it already created (by the
// entry's Ref line) instead of adding a second one. Outcomes: created/exists (done), not_configured/needs_contact
// (nothing called), failed (a definite 4xx rejection), unavailable (nothing written) and uncertain (the POST may
// have landed; the next attempt reads before writing).
export async function ensureCustomerMessageTask(env = {}, alert = {}, { fetcher = fetch, now = new Date().toISOString(), origin = DEFAULT_ORIGIN } = {}) {
  const token = env.HIGHLEVEL_API_KEY || env.GHL_API_KEY || '', locationId = env.HIGHLEVEL_LOCATION_ID || env.GHL_LOCATION_ID || '';
  if (!token || !locationId) return { status: 'not_configured' };
  const contactId = String(alert.highlevelContactId || '');
  if (!CONTACT.test(contactId) || !validAlertId(alert.id)) return { status: 'needs_contact' };
  const path = `${API}/contacts/${encodeURIComponent(contactId)}/tasks`, headers = { Accept: 'application/json', Authorization: `Bearer ${token}`, Version: 'v3' };
  const rejected = status => status >= 400 && status < 500 && status !== 408 && status !== 429;
  let response;
  try { response = await fetcher(path, { headers, signal: AbortSignal.timeout(15000) }); } catch { return { status: 'unavailable' }; }
  const listed = response.ok ? await response.json().catch(() => null) : null;
  if (!Array.isArray(listed?.tasks)) return { status: rejected(response.status) ? 'failed' : 'unavailable', ...(response.ok ? {} : { httpStatus: response.status }) };
  const existing = listed.tasks.find(task => typeof task?.body === 'string' && task.body.split('\n').includes(taskRef(alert.id)) && TASK_ID.test(String(task.id || '')));
  if (existing) return { status: 'exists', taskId: String(existing.id) };
  const due = new Date(ms(now)); due.setUTCSeconds(0, 0);
  const assignedTo = customerMessageTaskUser(env);
  try {
    response = await fetcher(path, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(15000), body: JSON.stringify({
      title: `${TASK_TITLE_PREFIX}: ${alert.customerName || alert.authorName || 'Customer'}`.slice(0, 160), body: customerMessageTaskBody(alert, origin),
      dueDate: due.toISOString(), completed: false, ...(assignedTo ? { assignedTo } : {}),
    }) });
  } catch { return { status: 'uncertain' }; }
  const created = await response.json().catch(() => ({})), taskId = String(created?.task?.id || created?.id || '');
  if (response.ok && TASK_ID.test(taskId)) return { status: 'created', taskId };
  return { status: response.status === 429 ? 'unavailable' : rejected(response.status) ? 'failed' : 'uncertain', httpStatus: response.status };
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
    /** Open entries, newest first; complete:false when more than `limit` are open. */
    async open(limit = ALERT_LIST_LIMIT) {
      const response = await call(`${BASE}:runQuery`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ structuredQuery: {
        from: [{ collectionId: CUSTOMER_MESSAGE_ALERTS }], where: { fieldFilter: { field: { fieldPath: 'status' }, op: 'EQUAL', value: { stringValue: 'open' } } }, limit: limit + 1,
      } }) });
      const rows = response.ok ? await response.json().catch(() => null) : null;
      if (!Array.isArray(rows)) throw unavailable();
      const found = rows.filter(row => row?.document).map(row => decode(row.document));
      found.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
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

const due = (task, now) => task?.status === 'pending' && !(ms(task.nextAttemptAt) > ms(now)) && !(ms(task.claimedUntil) > ms(now));

/** One attempt at an entry's HighLevel task. Never throws: the outcome is returned and saved on the entry. */
export async function attemptCustomerMessageTask(store, id, { env = {}, now = new Date().toISOString(), fetcher = fetch, origin = DEFAULT_ORIGIN } = {}) {
  try {
    const alert = await store.read(id);
    if (!alert) return { id, outcome: 'missing' };
    const task = object(alert.task) ? alert.task : {};
    if (!due(task, now)) return { id, outcome: 'skipped', task: task.status || '' };
    // Handled before HighLevel heard of it: the office already has it, so no task is written.
    if (alert.status === 'handled') {
      await store.write(id, { task: { ...task, status: 'not_needed', claimedUntil: '' }, updatedAt: now }, alert.revision);
      return { id, outcome: 'not_needed' };
    }
    const claimed = await store.write(id, { task: { ...task, claimedUntil: plus(now, TASK_CLAIM_MINUTES) }, updatedAt: now }, alert.revision);
    if (!claimed) return { id, outcome: 'claimed_elsewhere' };
    const result = await ensureCustomerMessageTask(env, alert, { fetcher, now, origin });
    const attempts = (Number.isSafeInteger(task.attempts) ? task.attempts : 0) + 1;
    const base = { ...task, attempts, claimedUntil: '', lastAttemptAt: now, httpStatus: Number(result.httpStatus) || 0 };
    let next;
    if (result.status === 'created' || result.status === 'exists') next = { ...base, status: 'created', taskId: result.taskId };
    else if (['not_configured', 'needs_contact', 'failed'].includes(result.status)) next = { ...base, status: result.status };
    else next = attempts >= TASK_PARK_ATTEMPTS ? { ...base, status: 'parked' } : { ...base, status: 'pending', nextAttemptAt: plus(now, taskBackoffMinutes(attempts)) };
    // The claim holds the task field, so only it is written: a Mark handled meanwhile is kept.
    await store.write(id, { task: next, updatedAt: now });
    return { id, outcome: next.status, ...(next.taskId ? { taskId: next.taskId } : {}) };
  } catch {
    return { id, outcome: 'error' };
  }
}

/** Retries up to `limit` due tasks among the listed entries, oldest first. */
export async function retryDueCustomerMessageTasks(store, rows, { limit = TASK_RETRY_LIMIT, ...options } = {}) {
  const now = options.now || new Date().toISOString();
  const dueRows = rows.filter(row => due(row.task, now)).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt))).slice(0, limit);
  const results = [];
  for (const row of dueRows) results.push(await attemptCustomerMessageTask(store, row.id, { ...options, now }));
  return results;
}

/** What the Hub list shows for an entry: no contact ids, task ids or request ids. */
export function customerMessageView(alert) {
  const task = object(alert.task) ? alert.task : {};
  return {
    id: alert.id, jobId: inline(alert.jobId, 180), customerName: inline(alert.customerName, 120), authorName: inline(alert.authorName, 120),
    body: cleanMessage(alert.body), createdAt: inline(alert.createdAt, 50), jobType: inline(alert.jobType, 40), serviceType: inline(alert.serviceType, 120), jobDate: inline(alert.jobDate, 20),
    status: ALERT_STATUSES.includes(alert.status) ? alert.status : 'open', revision: inline(alert.revision, 60),
    highLevelTask: TASK_STATUSES.includes(task.status) ? task.status : 'pending',
  };
}

export async function listCustomerMessages(store, { limit = ALERT_LIST_LIMIT } = {}) {
  const { rows, complete } = await store.open(limit);
  return { rows, messages: rows.map(customerMessageView), total: rows.length, complete };
}

/** Marks an entry handled; marking a handled entry again answers alreadyHandled. */
export async function markCustomerMessageHandled(store, input, actor, now) {
  if (!object(input) || input.action !== 'mark_handled' || !validAlertId(input.id)) throw fail('customer_messages_invalid', 'Choose a customer message to mark handled.');
  const by = inline(actor?.displayName || actor?.name || actor?.user, 120) || 'Hub user';
  for (let round = 0; round < 3; round += 1) {
    const alert = await store.read(input.id);
    if (!alert) throw fail('customer_messages_not_found', 'That customer message was not found. Refresh the list.', 404);
    if (alert.status === 'handled') return { ok: true, alreadyHandled: true, message: customerMessageView(alert) };
    const patch = { status: 'handled', handledAt: now, handledBy: by, updatedAt: now };
    const revision = await store.write(input.id, patch, alert.revision);
    if (revision) return { ok: true, message: customerMessageView({ ...alert, ...patch, revision }) };
  }
  throw fail('customer_messages_conflict', 'That message changed while saving. Refresh and try again.', 409);
}
