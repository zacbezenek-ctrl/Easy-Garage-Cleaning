import { getHubSession } from '../_lib/hub-session.js';
import { moneyStorage } from '../_lib/money-storage.js';
import { moneyApiEnabled, requireMoneyManager } from '../_lib/money-service.js';
import { batchBillingHold, issueInvoiceBatch, listInvoiceBatch } from '../_lib/money-batch.js';

/**
 * GET  /api/invoice-batch  manager lists: jobs ready to invoice, closing jobs
 *      whose money needs review and issued invoices still owed (read-only).
 * POST /api/invoice-batch  {action:'issue', requestId, dueDate, items:[{jobId,
 *      expectedRevision}]} issues each job's invoice through /api/money's
 *      service with a derived per-job request ID and reports every job. The
 *      FUN-32 billing hold (EGC_JOBBER_GUARD_BILLING) refuses a held job, as
 *      /api/money does. A retried batch replays its saved receipts first, even
 *      after its due date has passed or while the saved hold check is unreadable.
 * Owner or manager with business access only. Writes stay off unless
 * MONEY_API_ENABLED is exactly 'true', as for /api/money. Nothing here sends
 * anything to a customer or writes to HighLevel: the Invoicing screen starts
 * each issued invoice's HighLevel lifecycle trigger through the suite helper.
 */
const LIMIT = 16000;
const DEFAULT_BUDGET = 45;
const HEADERS = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: HEADERS });
// Cloudflare caps subrequests per invocation (50 on the Free plan); storage
// reads and commits are counted, and a job is only started when it fits.
const budgetOf = env => { const value = Number(env?.MONEY_BATCH_SUBREQUEST_BUDGET); return Number.isInteger(value) && value >= 30 && value <= 9500 ? value : DEFAULT_BUDGET; };

function metered(store, limit) {
  let used = 0;
  const count = fn => (...args) => { used += 1; return fn(...args); };
  return { store: { ...store, read: count(store.read), commit: count(store.commit), jobs: count(store.jobs) }, left: () => limit - used };
}

// Reads also refuse sibling sites; writes refuse cross-site requests. A
// missing Origin is allowed only because the SameSite=Strict cookie is required.
function sameOrigin(request, read = false) {
  const site = request.headers.get('Sec-Fetch-Site');
  if (site === 'cross-site' || read && site && !['same-origin', 'none'].includes(site)) return false;
  const source = request.headers.get('Origin') || request.headers.get('Referer');
  if (!source) return true;
  try { return new URL(source).origin === new URL(request.url).origin; } catch { return false; }
}

function failure(error) {
  if (/^money_[a-z_]+$/.test(error?.code || '')) return reply(error.status || 503, { ok: false, code: error.code, error: error.message, ...(error.details ? { details: error.details } : {}) });
  return reply(503, { ok: false, code: 'money_unavailable', error: 'The invoice batch could not be verified. Keep this request and retry it unchanged; do not create another.' });
}

export function invoiceBatchHandlers({ session = getHubSession, storage = moneyStorage, now = () => new Date(), billing = batchBillingHold } = {}) {
  return {
    async get({ request, env }) {
      if (!sameOrigin(request, true)) return reply(403, { ok: false, code: 'money_origin_forbidden', error: 'Open invoicing in the Employee Hub.' });
      try {
        const actor = await session(request, env); requireMoneyManager(actor);
        if ([...new URL(request.url).searchParams.keys()].length) return reply(400, { ok: false, code: 'money_query_invalid', error: 'This list takes no filters.' });
        const list = await listInvoiceBatch(storage(env), actor, now().toISOString());
        return reply(200, { ...list, enabled: moneyApiEnabled(env), viewer: { id: actor.user } });
      } catch (error) { return failure(error); }
    },
    async post({ request, env }) {
      if (!sameOrigin(request)) return reply(403, { ok: false, code: 'money_origin_forbidden', error: 'Open invoicing in the Employee Hub to issue invoices.' });
      if (!moneyApiEnabled(env)) return reply(404, { ok: false, code: 'money_api_disabled', error: 'Server money actions are turned off. Use the standard finance tools.' });
      try {
        const actor = await session(request, env); requireMoneyManager(actor);
        if (request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json') return reply(415, { ok: false, code: 'money_json_required', error: 'Invoice batches must be sent as JSON.' });
        if (Number(request.headers.get('Content-Length')) > LIMIT) return reply(413, { ok: false, code: 'money_request_too_large', error: 'The invoice batch is too large.' });
        const raw = await request.text();
        if (new TextEncoder().encode(raw).byteLength > LIMIT) return reply(413, { ok: false, code: 'money_request_too_large', error: 'The invoice batch is too large.' });
        let input; try { input = JSON.parse(raw); } catch { return reply(400, { ok: false, code: 'money_json_invalid', error: 'The invoice batch was incomplete. Refresh and try again.' }); }
        const meter = metered(storage(env), budgetOf(env)), at = now().toISOString();
        return reply(200, await issueInvoiceBatch(meter.store, actor, input, at, { left: meter.left, billing: () => billing(meter.store, env, at) }));
      } catch (error) { return failure(error); }
    },
  };
}

const handlers = invoiceBatchHandlers();
export const onRequestGet = handlers.get;
export const onRequestPost = handlers.post;
