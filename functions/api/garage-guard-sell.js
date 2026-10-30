/**
 * GUARD-SELL — /api/garage-guard-sell: the staff Garage Guard sales tool (crew/guard-sell.js) on the crew post-job
 * playbook, the estimator walkthrough after signing, the door-to-door app and the Hub. Any signed-in staff session
 * (getHubSession: crew, estimators, door-to-door reps, the office) may sell; requests must come from the site itself.
 *
 * GET                       → {plans (name, integer cents a year, what is included), configured, textEnabled}
 * GET  ?session=cs_…        → {status: open|complete|expired, member, plan} for a sale this viewer started (a
 *                             dispatcher may read any staff sale); nothing about the customer
 * POST {action:'start', requestId, plan, channel, jobId?, customerId?, email?, address?}
 *                           → {sessionId, link, plan}: a Stripe subscription Checkout session (the public page's
 *                             plans and amounts, functions/_lib/garage-guard-checkout.js) whose session and
 *                             subscription metadata name the seller (staff key), channel, job and customer; link is
 *                             the short signed /api/garage-guard-link the device shows as a QR code. The requestId is
 *                             Stripe's idempotency key, so a retried tap answers the same session.
 * POST {action:'text', requestId, sessionId}
 *                           → {delivery}: texts the link once per session to the sale's job's linked HighLevel contact.
 *                             Only with EGC_GUARD_SALES_TEXT_ENABLED exactly "true" (off by default: the tool then only
 *                             shows the QR code and Copy link), only for the seller of an open sale started from a job
 *                             they work on (a dispatcher, its assigned crew, its walkthrough signer or quote author, or
 *                             its door-to-door rep).
 *
 * Amounts are always the server's. Nothing here reads or returns a job's prices: the text path reads the job only for
 * its HighLevel contact. No commission is paid for Garage Guard; the sale only records who sold it.
 */
import { getHubSession } from '../_lib/hub-session.js';
import { canDispatch } from '../_lib/dispatch-permissions.js';
import { createJobAssignmentAccess } from '../_lib/job-assignment.js';
import { dispatchStorage } from '../_lib/dispatch-storage.js';
import { deliverHighLevelMessage } from '../_lib/customer-messaging.js';
import { firebaseServiceAccountConfigured } from '../_lib/firebase-service-account.js';
import { staffKey } from '../_lib/estimator-attribution.js';
import { GARAGE_GUARD_CHECKOUT_PLANS, createGarageGuardSession, garageGuardCheckoutParams, garageGuardPlan, garageGuardStripeKey } from '../_lib/garage-guard-checkout.js';
import { guardAddress, guardChannel, guardCheckoutState, guardEmail, guardRecordId, guardRequestId, guardSaleFromMetadata, guardSaleLink, guardSaleMetadata, guardSaleText, guardSalesTextEnabled, guardSessionId, readGuardCheckout } from '../_lib/garage-guard-sales.js';

const MAX_BODY = 4096;
// The order the tool shows them: open at the top (the post-job pitch), Lite is the save.
const PLAN_ORDER = ['black', 'guard', 'lite'];
const TEXTS = 'guard_sale_texts';
const START_KEYS = new Set(['action', 'requestId', 'plan', 'channel', 'jobId', 'customerId', 'email', 'address']);
const TEXT_KEYS = new Set(['action', 'requestId', 'sessionId']);

const reply = (status, body) => Response.json(body, { status, headers: { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } });
const fail = (code, error, status = 400) => Object.assign(new Error(error), { code, status });

function sameOrigin(request) {
  if (request.headers.get('Sec-Fetch-Site') === 'cross-site') return false;
  const source = request.headers.get('Origin') || request.headers.get('Referer');
  if (!source) return true;
  try { return new URL(source).origin === new URL(request.url).origin; } catch { return false; }
}

function errorResponse(error) {
  const code = String(error?.code || '');
  if (code.startsWith('guard_sales_')) return reply(error.status || 400, { ok: false, code, error: error.message });
  return reply(503, { ok: false, code: 'guard_sales_unavailable', error: 'Garage Guard sign-up is unavailable right now. Try again in a moment.' });
}

async function readBody(request) {
  if (!/^application\/json(?:;|$)/i.test(request.headers.get('Content-Type') || '')) throw fail('guard_sales_content_type', 'Send the sign-up as JSON.', 415);
  if (Number(request.headers.get('Content-Length') || 0) > MAX_BODY) throw fail('guard_sales_too_large', 'This request is too large.', 413);
  const raw = await request.text();
  if (new TextEncoder().encode(raw).length > MAX_BODY) throw fail('guard_sales_too_large', 'This request is too large.', 413);
  let body;
  try { body = JSON.parse(raw); } catch { throw fail('guard_sales_json_invalid', 'The request could not be read.'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw fail('guard_sales_json_invalid', 'The request could not be read.');
  return body;
}

const planView = key => {
  const plan = GARAGE_GUARD_CHECKOUT_PLANS[key];
  return { key, name: plan.name, amountCents: plan.amount, interval: 'year', includes: [...plan.includes] };
};

// The people who work on the sale's job: a dispatcher, its assigned crew, the estimator who signed or built its quote,
// or the door-to-door rep whose sale or walkthrough it is.
async function worksOnJob(actor, env, job, now) {
  if (!job) return false;
  if (canDispatch(actor, env)) return true;
  const key = staffKey(actor?.user);
  if (key && [job.acceptance?.recordedBy, job.quoteDraft?.createdBy, job.d2d?.repKey].some(value => staffKey(value) === key)) return true;
  return createJobAssignmentAccess(env, actor, { now }).assigned(job);
}

// fetcher reaches Stripe and HighLevel (tests answer both); storage is Hub storage for the job and the text claim.
export function garageGuardSellHandlers({ session = getHubSession, now = () => new Date(), fetcher = (...args) => fetch(...args), storage = env => dispatchStorage(env) } = {}) {
  async function signedIn(request, env) {
    const actor = await session(request, env);
    if (!actor?.user || !staffKey(actor.user)) throw fail('guard_sales_auth_required', 'Sign in to sell Garage Guard.', 401);
    return actor;
  }

  // The staff sale behind a session id, readable by its seller or a dispatcher.
  async function ownSale(actor, env, sessionId) {
    const id = guardSessionId(sessionId);
    if (!id) throw fail('guard_sales_session_missing', 'That sign-up was not found.', 404);
    const checkout = await readGuardCheckout(env, id, { fetcher });
    const sale = guardSaleFromMetadata(checkout.metadata);
    if (!sale || (sale.staffKey !== staffKey(actor.user) && !canDispatch(actor, env))) throw fail('guard_sales_session_missing', 'That sign-up was not found.', 404);
    return { checkout, sale };
  }

  async function start(actor, env, request, body) {
    if (Object.keys(body).some(key => !START_KEYS.has(key))) throw fail('guard_sales_request_invalid', 'The sign-up request contains unsupported information.');
    const requestId = guardRequestId(body.requestId), plan = garageGuardPlan(body.plan), channel = guardChannel(body.channel);
    if (!requestId) throw fail('guard_sales_request_invalid', 'Use a new request ID.');
    if (!plan) throw fail('guard_sales_plan_invalid', 'Choose Guard Lite, Garage Guard or Guard Black.');
    if (!channel) throw fail('guard_sales_channel_invalid', 'The sign-up must name where it was sold.');
    for (const key of ['jobId', 'customerId']) if (body[key] !== undefined && body[key] !== '' && !guardRecordId(body[key])) throw fail('guard_sales_request_invalid', 'The job or customer could not be read.');
    const email = body.email ? guardEmail(body.email) : '';
    if (body.email && !email) throw fail('guard_sales_email_invalid', 'Check the email address, or leave it empty for the customer to type.');
    const secret = garageGuardStripeKey(env);
    if (!secret) throw fail('guard_sales_stripe_unconfigured', 'Stripe is not set up for Garage Guard yet.', 503);
    const origin = new URL(request.url).origin;
    const params = garageGuardCheckoutParams(body.plan, { origin, env, customerEmail: email, serviceAddress: guardAddress(body.address),
      metadata: guardSaleMetadata({ seller: actor.user, channel, jobId: body.jobId || '', customerId: body.customerId || '', requestId }) });
    const created = await createGarageGuardSession(secret, params, { fetcher, idempotencyKey: `egc-guard-sell-${requestId}` });
    if (!created.ok) throw fail('guard_sales_stripe_unavailable', 'Stripe could not start the sign-up. Try again in a moment.', 502);
    const sessionId = guardSessionId(created.session.id), link = sessionId ? await guardSaleLink(env, origin, sessionId) : '';
    if (!link) throw fail('guard_sales_link_unavailable', 'The sign-up link could not be made. Ask the office to check the Hub setup.', 503);
    return { ok: true, sessionId, link, plan: planView(body.plan), status: 'open' };
  }

  async function text(actor, env, request, body) {
    if (!guardSalesTextEnabled(env)) throw fail('guard_sales_text_off', 'Texting the link is off. Show the code or copy the link instead.', 409);
    if (Object.keys(body).some(key => !TEXT_KEYS.has(key)) || !guardRequestId(body.requestId)) throw fail('guard_sales_request_invalid', 'The text request contains unsupported information.');
    if (!firebaseServiceAccountConfigured(env)) throw fail('guard_sales_storage_unavailable', 'Hub storage is unavailable, so nothing was sent.', 503);
    const { checkout, sale } = await ownSale(actor, env, body.sessionId);
    if (checkout.status !== 'open') throw fail('guard_sales_session_closed', checkout.status === 'complete' ? 'They are already a member.' : 'This sign-up expired. Start a new one.', 409);
    if (!sale.jobId) throw fail('guard_sales_text_needs_job', 'Only a sign-up started from a job can be texted. Show the code or copy the link instead.', 409);
    const store = storage(env), at = now(), job = await store.read('jobs', sale.jobId);
    if (!await worksOnJob(actor, env, job, () => at)) throw fail('guard_sales_text_forbidden', 'Only someone on this job can text its customer.', 403);
    const link = await guardSaleLink(env, new URL(request.url).origin, checkout.id), message = guardSaleText(checkout.metadata?.plan, link);
    if (!message) throw fail('guard_sales_link_unavailable', 'The sign-up link could not be made. Ask the office to check the Hub setup.', 503);
    // One text per sign-up, ever: the claim is durable before HighLevel is called, and an unclear answer is never resent.
    try {
      await store.commit([{ collection: TEXTS, id: checkout.id, patch: { sessionId: checkout.id, jobId: sale.jobId, requestId: body.requestId, sentBy: staffKey(actor.user), status: 'sending', claimedAt: at.toISOString() } }]);
    } catch (error) {
      if (error?.code === 'dispatch_revision_conflict') throw fail('guard_sales_text_already_sent', 'This link was already texted to the customer.', 409);
      throw fail('guard_sales_storage_unavailable', 'Hub storage is unavailable, so nothing was sent.', 503);
    }
    const delivery = await deliverHighLevelMessage(env, job, { body: message, direction: 'to_customer', requestId: `guard-${checkout.id}` }, { fetcher, clock: now });
    const claim = await store.read(TEXTS, checkout.id).catch(() => null);
    if (claim?.revision) await store.commit([{ collection: TEXTS, id: checkout.id, revision: claim.revision, patch: { status: delivery.status, settledAt: now().toISOString() } }]).catch(() => null);
    return { ok: true, delivery: { status: delivery.status } };
  }

  return {
    async get({ request, env }) {
      try {
        const actor = await signedIn(request, env);
        const params = new URL(request.url).searchParams;
        if ([...params.keys()].some(key => key !== 'session')) throw fail('guard_sales_request_invalid', 'Ask for the plans, or one sign-up by its session.');
        if (params.has('session')) {
          const { checkout } = await ownSale(actor, env, params.get('session'));
          return reply(200, { ok: true, ...guardCheckoutState(checkout) });
        }
        return reply(200, { ok: true, configured: Boolean(garageGuardStripeKey(env)), textEnabled: guardSalesTextEnabled(env), plans: PLAN_ORDER.map(planView) });
      } catch (error) { return errorResponse(error); }
    },
    async post({ request, env }) {
      try {
        if (!sameOrigin(request)) throw fail('guard_sales_origin_forbidden', 'Garage Guard sign-ups must come from the EGC apps.', 403);
        const body = await readBody(request);
        const actor = await signedIn(request, env);
        if (body.action === 'start') return reply(200, await start(actor, env, request, body));
        if (body.action === 'text') return reply(200, await text(actor, env, request, body));
        throw fail('guard_sales_request_invalid', 'Choose start or text.');
      } catch (error) { return errorResponse(error); }
    },
  };
}

const handlers = garageGuardSellHandlers();
export const onRequestGet = handlers.get;
export const onRequestPost = handlers.post;
