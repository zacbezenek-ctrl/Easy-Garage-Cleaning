import { getHubSession } from '../_lib/hub-session.js';
import { moneyStorage } from '../_lib/money-storage.js';
import { MONEY_RECEIPTS, moneyApiEnabled, moneyJob, moneyLaborView, moneyProjection, mutateMoney, requireMoneyManager } from '../_lib/money-service.js';
import { jobberGuardBillingError, jobberGuardHoldView, jobberGuardInvoiceHolds } from '../_lib/jobber-guard.js';
import { MONEY_QUERY_KEYS, listMoney, moneyCsv } from '../_lib/money-reports.js';
import { servedMoneyTotals } from '../_lib/money-core.js';
import { denverToday } from '../_lib/dispatch-time.js';
import { laborCostViewer } from '../_lib/job-labor-private.js';
import { expireStaleCustomerCheckout, stripeSecretKey } from '../_lib/customer-payments.js';

const LIMIT = 64000;
const HEADERS = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
const GET_KEYS = new Set(['jobId', ...MONEY_QUERY_KEYS]);
const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: HEADERS });

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
  return reply(503, { ok: false, code: 'money_unavailable', error: 'The money request could not be verified. Keep this request and retry it unchanged; do not create another.' });
}

// A portal card checkout sized before a change_order.void would still charge
// the voided amount: close it (the portal opens a new one for the new
// balance). Without a Stripe key no portal checkout can have opened.
async function closeStaleCheckout(env, jobId) {
  const secret = stripeSecretKey(env);
  return secret ? expireStaleCustomerCheckout(env, secret, jobId) : 'none';
}

// Best effort after the void is saved: staff are told when a checkout for the
// old balance may still be paid, and never lose the saved void over it.
async function checkoutWarnings(checkouts, env, jobId) {
  let outcome = 'unknown';
  try { outcome = await checkouts(env, jobId); } catch { /* reported below */ }
  if (outcome === 'expired') return [{ code: 'checkout_closed', message: 'The customer’s open card checkout for the old balance was closed; the portal opens a new one for the new balance.' }];
  if (outcome === 'paid') return [{ code: 'checkout_paid', message: 'The customer already paid a card checkout opened for the old balance. It is recorded when Stripe confirms it; refund what exceeds the new total.' }];
  if (outcome === 'none' || outcome === 'current') return [];
  return [{ code: 'checkout_open', message: 'A card checkout opened before this void may still be open for the old balance. If the customer pays it, the extra payment is flagged for review; refund the difference.' }];
}

// Reads take the Date; mutations take its ISO string. Writes stay off unless
// MONEY_API_ENABLED is exactly 'true' (the browser keeps today's tools then).
// Labor dollars are owner-only (EGC_STAFF_PAY_OWNER_ONLY): laborCostViewer resolves
// that from the signed session, and anyone else gets laborCents null (never 0).
// jobberGuard is the FUN-32 billing hold on invoice.issue (EGC_JOBBER_GUARD_BILLING); checkouts closes a portal card
// checkout sized before a change_order.void (CHANGE-ORDERS).
export function moneyHandlers({ session = getHubSession, storage = moneyStorage, now = () => new Date(), jobberGuard = (store, env, input, at) => jobberGuardInvoiceHolds(store, env, input, at, { receipts: MONEY_RECEIPTS }), checkouts = closeStaleCheckout } = {}) {
  return {
    async get({ request, env }) {
      if (!sameOrigin(request, true)) return reply(403, { ok: false, code: 'money_origin_forbidden', error: 'Open job finances in the Employee Hub.' });
      try {
        const actor = laborCostViewer(await session(request, env), env); requireMoneyManager(actor, env);
        const params = new URL(request.url).searchParams, keys = [...params.keys()], at = now(), asOf = at.toISOString();
        if (new Set(keys).size !== keys.length || keys.some(key => !GET_KEYS.has(key)) || params.has('jobId') && keys.length !== 1) return reply(400, { ok: false, code: 'money_query_invalid', error: 'Use only the supported money filters, each at most once.' });
        const store = storage(env);
        if (params.has('jobId')) {
          const jobId = params.get('jobId');
          if (!/^[A-Za-z0-9_-]{1,180}$/.test(jobId) || /^(secure_|_egc_)/.test(jobId)) return reply(400, { ok: false, code: 'money_query_invalid', error: 'Choose a valid job.' });
          const job = await store.read('jobs', jobId);
          if (!moneyJob(job)) return reply(404, { ok: false, code: 'money_job_not_found', error: 'This job is not available for money changes.' });
          // MONEY_UNIFIED_TOTALS: 'true' shows the unified totals; 'shadow' logs where they differ from the ones shown.
          if (store.totalsMode === 'shadow') servedMoneyTotals(job, 'shadow', { surface: 'money_api' });
          return reply(200, { ok: true, authority: 'employee_hub', enabled: moneyApiEnabled(env), viewer: { id: actor.user }, job: moneyProjection(job, asOf, { ...await moneyLaborView(store, actor, jobId), paymentEvents: store.paymentEvents === true, unified: store.totalsMode === 'unified' }), asOf });
        }
        const { rows, ...page } = await listMoney(store, Object.fromEntries(params), asOf);
        if (params.get('format') === 'csv') return new Response(moneyCsv(page.view, rows, { paymentEvents: store.paymentEvents === true }), { status: 200, headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="egc-${page.view}-${denverToday(at)}.csv"`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
        return reply(200, { ok: true, authority: 'employee_hub', enabled: moneyApiEnabled(env), ...page });
      } catch (error) { return failure(error); }
    },
    async post({ request, env }) {
      if (!sameOrigin(request)) return reply(403, { ok: false, code: 'money_origin_forbidden', error: 'Open job finances in the Employee Hub to save changes.' });
      if (!moneyApiEnabled(env)) return reply(404, { ok: false, code: 'money_api_disabled', error: 'Server money actions are turned off. Use the standard finance tools.' });
      try {
        const actor = laborCostViewer(await session(request, env), env); requireMoneyManager(actor, env);
        if (request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json') return reply(415, { ok: false, code: 'money_json_required', error: 'Money changes must be sent as JSON.' });
        if (Number(request.headers.get('Content-Length')) > LIMIT) return reply(413, { ok: false, code: 'money_request_too_large', error: 'The money request is too large.' });
        const raw = await request.text();
        if (new TextEncoder().encode(raw).byteLength > LIMIT) return reply(413, { ok: false, code: 'money_request_too_large', error: 'The money request is too large.' });
        let input; try { input = JSON.parse(raw); } catch { return reply(400, { ok: false, code: 'money_json_invalid', error: 'The money request was incomplete. Refresh the form and try again.' }); }
        const store = storage(env), at = now().toISOString(), guard = await jobberGuard(store, env, input, at);
        if (guard.holds.length) return reply(409, { ok: false, code: 'money_jobber_billing_hold', error: jobberGuardBillingError(guard.holds), details: { checkedAt: guard.state.checkedAt, findings: guard.holds.slice(0, 10).map(jobberGuardHoldView) } });
        const result = await mutateMoney(store, actor, input, at);
        if (input.action === 'change_order.void') result.warnings = [...(result.warnings || []), ...await checkoutWarnings(checkouts, env, input.jobId)];
        return reply(200, result);
      } catch (error) { return failure(error); }
    },
  };
}

const handlers = moneyHandlers();
export const onRequestGet = handlers.get;
export const onRequestPost = handlers.post;
