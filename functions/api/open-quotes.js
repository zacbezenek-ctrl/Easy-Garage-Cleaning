/** Open quotes (office report, read only): the estimator quotes out with customers and not yet approved or signed, their
 * age buckets, and each estimator's close rate over the last 30 and 90 days. Rules: functions/_lib/open-quotes.js.
 * Session cookie: business accounts (owner and managers) only; estimators and crew are refused here, not only in the nav.
 * Hub > Open quotes (employee-open-quotes.js) shows it. It writes nothing and sends nothing to customers or HighLevel;
 * the screen's one action, "Copy customer portal link", is the existing POST /api/customer-portal-link.
 * GET /api/open-quotes => {ok, asOf, window, buckets, rows, totals, closeRates:{last30,last90}, sources:{prices}}.
 * READ-BUDGET: one range query on quoteDraft.sentAt (the quotes sent in the last 120 days, masked), one on the signed
 *   walkthrough receipts of the last 90 days (masked to who signed which job when) and, only when an open quote has a
 *   builder breakdown, the owner's two pricing documents. Loaded when the screen opens or is refreshed; never polled.
 * Errors: {ok:false, code, error}; 400, 401, 403, 503 retry. */
import { getHubSession, hasBusinessAccess } from '../_lib/hub-session.js';
import { dispatchStorage } from '../_lib/dispatch-storage.js';
import { catalogStorage, readCompositeState } from '../_lib/catalog-store.js';
import { denverToday } from '../_lib/dispatch-time.js';
import { OPEN_QUOTE_FIELDS, buildOpenQuotes, openQuote, openQuotesWindow } from '../_lib/open-quotes.js';

const reply = (status, body) => Response.json(body, { status, headers: { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } });
const fail = (code, message, status) => Object.assign(new Error(message), { code, status });

export function requireOpenQuotesViewer(session) {
  if (!session?.user) throw fail('open_quotes_sign_in_required', 'Sign in to review open quotes.', 401);
  if (!hasBusinessAccess(session)) throw fail('open_quotes_forbidden', 'Only the owner and managers can review open quotes.', 403);
}

export function openQuotesHandlers({ session = getHubSession, dispatch = dispatchStorage, pricing = env => readCompositeState(catalogStorage(env)), now = () => new Date() } = {}) {
  return {
    async get({ request, env }) {
      try {
        requireOpenQuotesViewer(await session(request, env));
        if ([...new URL(request.url).searchParams.keys()].length) return reply(400, { ok: false, code: 'open_quotes_request_invalid', error: 'Open quotes take no query options.' });
        const at = now(), today = denverToday(at), window = openQuotesWindow(today), store = dispatch(env);
        const [jobs, signed] = await Promise.all([store.sentQuoteJobs(window.since, [...OPEN_QUOTE_FIELDS]), store.handoffLedger({ field: 'createdAt', op: 'GREATER_THAN_OR_EQUAL', value: `${window.last90}T00:00:00.000Z` })]);
        // The owner's menu decides whether a builder quote's prices still wait for approval; without it that flag is unknown.
        let compositeState = null, prices = 'ok';
        if (jobs.some(job => openQuote(job) && job.quoteDraft?.breakdown?.source === 'composite')) {
          try { compositeState = await pricing(env); } catch { prices = 'unavailable'; }
        }
        return reply(200, { ...buildOpenQuotes({ jobs, signed, compositeState, pricesReadable: prices === 'ok', today, asOf: at.toISOString() }), sources: { prices } });
      } catch (error) {
        if (/^open_quotes_/.test(error?.code || '')) return reply(error.status || 503, { ok: false, code: error.code, error: error.message });
        return reply(503, { ok: false, code: 'open_quotes_unavailable', error: 'Open quotes could not be loaded. Retry in a moment.' });
      }
    },
  };
}

const handlers = openQuotesHandlers();
export const onRequestGet = handlers.get;
