import { getHubSession, hasBusinessAccess } from '../_lib/hub-session.js';
import { getCustomerPortalSession } from '../_lib/customer-portal.js';
import { readCustomerPortalContext } from '../_lib/customer-portal-access.js';
import { readJob } from '../_lib/firestore-job.js';
import { MONEY_DOCUMENT_KINDS, moneyDocumentEnabled, moneyDocumentHeaders, moneyDocumentKinds, renderMoneyDocument, renderMoneyDocumentError } from '../_lib/money-document.js';

/**
 * GET /api/money-document?kind=estimate|invoice|receipt[&job_id=...]
 *   Hub business users with an owner or manager role name any customer job
 *   with job_id (hasBusinessAccess plus the role, as requireDispatcher).
 *   Customer portal sessions get their own job only (job_id may be left out;
 *   any other job is 404), re-authorized through readCustomerPortalContext on
 *   every request (P4-15 link versions, collaborator view permission).
 *   Crew and other Hub sessions without business access are denied.
 * GET /api/money-document?probe=1 tells a Hub business session whether the
 *   MONEY_DOCUMENT_ENABLED flag is on. While the flag is off every document
 *   request is 404 money_document_disabled.
 * Documents are text/html with no-store and a strict no-script CSP. Errors are
 * {ok:false, code, error} JSON, or a branded HTML page for browser navigations.
 */

const JOB_ID = /^[A-Za-z0-9_-]{1,180}$/;
const PARAMS = new Set(['job_id', 'kind', 'probe']);
const reply = (status, body) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
const fail = (code, message, status) => Object.assign(new Error(message), { code: `money_document_${code}`, status });
const PORTAL_CODES = { 401: 'sign_in_required', 403: 'forbidden', 404: 'not_found' };
const STAFF_DENIED = 'Only an owner or manager with business access can open customer documents.';
const staffAllowed = staff => hasBusinessAccess(staff) && ['owner', 'manager'].includes(staff.role);

function sameOrigin(request) {
  if (request.headers.get('Sec-Fetch-Site') === 'cross-site') return false;
  const raw = request.headers.get('Origin') || request.headers.get('Referer');
  if (!raw) return true;
  try { return new URL(raw).origin === new URL(request.url).origin; } catch { return false; }
}

function parse(url) {
  const input = {};
  for (const [key, value] of url.searchParams) {
    if (!PARAMS.has(key) || Object.hasOwn(input, key)) throw fail('invalid_request', 'This document link is not valid.', 400);
    input[key] = value;
  }
  if (Object.hasOwn(input, 'probe')) {
    if (input.probe !== '1' || Object.keys(input).length !== 1) throw fail('invalid_request', 'This document link is not valid.', 400);
    return { probe: true };
  }
  if (!MONEY_DOCUMENT_KINDS.includes(input.kind)) throw fail('invalid_kind', 'Choose an estimate, invoice or receipt.', 400);
  if (Object.hasOwn(input, 'job_id') && (!JOB_ID.test(input.job_id) || /^(secure_|_egc_)/.test(input.job_id))) throw fail('invalid_request', 'This document link is not valid.', 400);
  return { kind: input.kind, jobId: input.job_id || '' };
}

function failure(request, error) {
  const known = /^money_document_/.test(error?.code || '');
  const status = known ? error.status || 503 : 503, code = known ? error.code : 'money_document_unavailable';
  const message = known ? error.message : 'This document could not be loaded. Please try again shortly.';
  if (/text\/html/i.test(request.headers.get('Accept') || '')) return new Response(renderMoneyDocumentError(message), { status, headers: moneyDocumentHeaders() });
  return reply(status, { ok: false, code, error: message });
}

// Portal access errors keep their customer-facing message under this route's codes.
function portalFailure(error) {
  if (!/^CUSTOMER_PORTAL_/.test(error?.code || '')) return error;
  const status = error.status || 503;
  return fail(PORTAL_CODES[status] || 'unavailable', error.message, PORTAL_CODES[status] ? status : 503);
}

export function moneyDocumentHandlers({ session = getHubSession, portalSession = getCustomerPortalSession, portalContext = readCustomerPortalContext, read = readJob, now = () => new Date() } = {}) {
  return {
    async get({ request, env }) {
      try {
        const url = new URL(request.url);
        if (!sameOrigin(request)) throw fail('origin_forbidden', 'Open this document from Easy Garage Cleaning.', 403);
        const input = parse(url), clock = now(), at = clock.toISOString();
        const staff = await session(request, env), business = staffAllowed(staff);
        if (input.probe) {
          if (!staff) throw fail('sign_in_required', 'Sign in to the EGC Hub.', 401);
          if (!business) throw fail('forbidden', STAFF_DENIED, 403);
          return reply(200, { ok: true, enabled: moneyDocumentEnabled(env) });
        }
        if (!moneyDocumentEnabled(env)) throw fail('disabled', 'Printable documents are not available yet.', 404);
        if (business && input.jobId) {
          const job = await read(env, input.jobId);
          if (!job || job.id !== input.jobId || job.recordType) throw fail('not_found', 'That job was not found.', 404);
          // Staff copies link to the customer's own portal, never to a portal
          // token, and say the payment needs the private link the customer holds.
          return new Response(renderMoneyDocument(job, { kind: input.kind, now: at, payUrl: `${url.origin}/customer-portal#pay`, contact: true, audience: 'staff' }), { status: 200, headers: moneyDocumentHeaders() });
        }
        const customer = await portalSession(request, env, clock.getTime());
        if (!customer) {
          if (business) throw fail('job_required', 'Choose a job first.', 400);
          if (staff) throw fail('forbidden', STAFF_DENIED, 403);
          throw fail('sign_in_required', 'Open the private project link from Easy Garage Cleaning.', 401);
        }
        if (input.jobId && input.jobId !== customer.jobId) throw fail('not_found', 'That document was not found.', 404);
        let context;
        try { context = await portalContext(env, customer, { read }); } catch (error) { throw portalFailure(error); }
        const viewer = context.session, owner = !viewer.actorId;
        if (viewer.permissions?.view === false) throw fail('forbidden', 'Your access to this private project has changed.', 403);
        if (!moneyDocumentKinds(context.job, at).includes(input.kind)) throw fail('unavailable', `Your ${input.kind} is not available yet.`, 404);
        const payUrl = owner || viewer.permissions?.pay === true ? '/customer-portal#pay' : null;
        return new Response(renderMoneyDocument(context.job, { kind: input.kind, now: at, payUrl, contact: owner }), { status: 200, headers: moneyDocumentHeaders() });
      } catch (error) {
        return failure(request, error);
      }
    },
  };
}

const handlers = moneyDocumentHandlers();
export const onRequestGet = handlers.get;
