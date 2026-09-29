import { getHubSession } from '../_lib/hub-session.js';
import { requireDispatcher } from '../_lib/dispatch-service.js';
import { createJobAssignmentAccess } from '../_lib/job-assignment.js';
import { createGhlMessenger } from '../_lib/ghl-messenger.js';
import { createApprovedSendService } from '../_lib/approved-send.js';
import { messagingStorage, readReceipt, saveReceipt } from '../_lib/message-send-store.js';
import { messageDigest } from '../_lib/message-templates.js';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const ACTIONS = new Set(['preview', 'send', 'status', 'batch_preview', 'batch_send']);
const ITEM_KEYS = ['kind', 'jobId', 'accountId', 'overrides', 'confirmToken'];
const BATCH_LIMIT = 10;
const MAX_BYTES = 64000;
// Cloudflare caps subrequests per invocation (50 on the Free plan). Storage
// and HighLevel calls are counted against a budget; an item is only started
// when a whole send fits, and a claim is only made when the provider call and
// the ledger write still fit, so a claim is never stranded in 'sending'.
const DEFAULT_BUDGET = 45;
const ITEM_COST = 20;
const CLAIM_COST = 8;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const budgetOf = env => { const value = Number(env?.EGC_MESSAGING_SUBREQUEST_BUDGET); return Number.isInteger(value) && value >= 30 && value <= 9500 ? value : DEFAULT_BUDGET; };

function metered(store, messenger, limit) {
  let used = 0;
  const count = (fn, cost = 1) => typeof fn === 'function' ? (...args) => { used += cost; return fn(...args); } : fn;
  return {
    store: { ...store, read: count(store.read), commit: count(store.commit), roster: count(store.roster, 2) },
    messenger: { ...messenger, resolveRecipient: count(messenger.resolveRecipient, 2), send: count(messenger.send) },
    left: () => limit - used,
  };
}
const notAttempted = () => ({ ok: false, code: 'messaging_not_attempted', error: 'This message was not attempted in this batch. Send it again in a new batch.' });

function reply(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
}

function sameOrigin(request) {
  if (request.headers.get('Sec-Fetch-Site') === 'cross-site') return false;
  const source = request.headers.get('Origin') || request.headers.get('Referer');
  if (!source) return true; // SameSite=Strict signed cookie remains required.
  try { return new URL(source).origin === new URL(request.url).origin; } catch { return false; }
}

function errorBody(error) {
  if (/^messaging_[a-z_]+$/.test(error?.code || '')) return { status: error.status || 503, body: { ok: false, code: error.code, error: error.message, ...(error.details ? { details: error.details } : {}) } };
  if (/^dispatch_(sign_in_required|forbidden)$/.test(error?.code || '')) return { status: error.status, body: { ok: false, code: error.code === 'dispatch_forbidden' ? 'messaging_forbidden' : 'messaging_sign_in_required', error: error.code === 'dispatch_forbidden' ? 'Only an operations manager or owner can send batches.' : 'Sign in to the Employee Hub to send messages.' } };
  return { status: 503, body: { ok: false, code: 'messaging_unavailable', error: 'Messaging could not confirm this request. Retry the same request; do not create another.' } };
}
const errorResponse = error => { const { status, body } = errorBody(error); return reply(status, body); };

// Dependency injection permits full request/permission tests without live
// HighLevel, Firestore credentials, cookies or environment flags.
export function messagesHandlers({
  session = getHubSession, storage = messagingStorage, messenger = env => createGhlMessenger({ env }),
  access = createJobAssignmentAccess, now = () => new Date(), links = () => ({}), options = () => ({}),
} = {}) {
  return {
    async get() { return reply(405, { ok: false, code: 'messaging_method_not_allowed', error: 'Use POST from the EGC Hub.' }); },
    async post({ request, env }) {
      if (!sameOrigin(request)) return reply(403, { ok: false, code: 'messaging_origin_forbidden', error: 'Open the Employee Hub to send messages.' });
      try {
        const viewer = await session(request, env);
        if (!viewer?.user) return reply(401, { ok: false, code: 'messaging_sign_in_required', error: 'Sign in to the Employee Hub to send messages.' });
        if (request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json') return reply(415, { ok: false, code: 'messaging_json_required', error: 'Message requests must be JSON.' });
        if (Number(request.headers.get('Content-Length')) > MAX_BYTES) return reply(413, { ok: false, code: 'messaging_request_too_large', error: 'The message request is too large.' });
        const raw = await request.text();
        if (new TextEncoder().encode(raw).byteLength > MAX_BYTES) return reply(413, { ok: false, code: 'messaging_request_too_large', error: 'The message request is too large.' });
        let input; try { input = JSON.parse(raw); } catch { return reply(400, { ok: false, code: 'messaging_json_invalid', error: 'The message request was incomplete. Refresh and try again.' }); }
        if (!object(input) || !ACTIONS.has(input.action) || !UUID.test(input.requestId || '')) return reply(400, { ok: false, code: 'messaging_request_invalid', error: 'Use a supported message action with a unique request ID.' });
        const actor = { ...viewer, kind: 'human', source: 'hub' }, meter = metered(storage(env), messenger(env), budgetOf(env)), store = meter.store;
        const reserve = () => { if (meter.left() < CLAIM_COST) throw Object.assign(new Error('This message was not attempted. Send it again.'), { code: 'messaging_not_attempted', status: 503 }); };
        const service = createApprovedSendService({ store, messenger: meter.messenger, clock: now, env, secret: env?.HUB_SESSION_SECRET || '', links: links(env), assignment: person => access(env, person), reserve, ...options(env) });
        const { action, requestId, items, ...item } = input;
        const batch = action.startsWith('batch_');
        if (batch) {
          requireDispatcher(viewer, env);
          if (Object.keys(item).length || !Array.isArray(items) || !items.length) return reply(400, { ok: false, code: 'messaging_batch_invalid', error: 'Choose at least one message for this batch.' });
          if (items.length > BATCH_LIMIT) return reply(400, { ok: false, code: 'messaging_batch_too_large', error: `Send at most ${BATCH_LIMIT} messages at a time.` });
          if (items.some(entry => !object(entry) || Object.keys(entry).some(key => !ITEM_KEYS.includes(key)))) return reply(400, { ok: false, code: 'messaging_batch_invalid', error: 'A batch item contains unsupported fields.' });
        } else if (items !== undefined) return reply(400, { ok: false, code: 'messaging_request_invalid', error: 'This message request contains unsupported fields.' });
        const mutation = action === 'send' || action === 'batch_send';
        let fingerprint = '';
        if (mutation) {
          fingerprint = await messageDigest({ scope: 'messages', actor: viewer.user, input });
          const prior = await readReceipt(store, requestId);
          if (prior) {
            if (prior.fingerprint !== fingerprint || prior.actorId !== viewer.user) return reply(409, { ok: false, code: 'messaging_idempotency_conflict', error: 'This request ID was already used for a different message. Refresh before sending.' });
            return reply(200, { ...prior.result, replayed: true });
          }
        }
        let result;
        if (batch) {
          const results = [];
          // Sequential on purpose: each item gets its own ledger claim and a
          // failure never hides the outcome of the items before it.
          for (const [index, entry] of items.entries()) {
            if (meter.left() < ITEM_COST) { results.push({ index, ...notAttempted() }); continue; }
            try {
              const value = action === 'batch_send' ? await service.send(actor, { ...entry, requestId }) : await service.preview(actor, entry);
              results.push({ index, ok: true, ...value });
            } catch (error) { results.push({ index, ...(error?.code === 'messaging_not_attempted' ? notAttempted() : errorBody(error).body) }); }
          }
          const skipped = results.filter(row => row.code === 'messaging_not_attempted').length;
          result = { ok: true, requestId, action, results, summary: { total: results.length, failed: results.filter(row => !row.ok).length - skipped, notAttempted: skipped } };
        } else {
          const value = action === 'send' ? await service.send(actor, { ...item, requestId }) : action === 'preview' ? await service.preview(actor, item) : await service.status(actor, item);
          result = { ok: true, requestId, action, ...value };
        }
        if (mutation) await saveReceipt(store, requestId, { scope: 'messages', fingerprint, actorId: viewer.user, action, requestId, createdAt: now().toISOString(), result });
        return reply(200, result);
      } catch (error) { return errorResponse(error); }
    },
  };
}

const handlers = messagesHandlers();
export const onRequestGet = handlers.get;
export const onRequestPost = handlers.post;
