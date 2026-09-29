/* GET /api/jobber-guard (FUN-32): the Jobber coexistence guard for owners and
   managers. It returns the Jobber cutover day from the funnel definitions, each
   surface switch and whether it blocks today, and the last saved check with
   its PII-masked findings (inForce is false once jobber.cutoverDate has moved
   away from the check's day; holds then ignore it). Read-only: the check
   itself runs from scripts/jobber-guard.mjs, which reads Jobber and HighLevel
   and never writes to either. */
import { getHubSession, hasBusinessAccess } from '../_lib/hub-session.js';
import { dispatchStorage } from '../_lib/dispatch-storage.js';
import { funnelDefinitions } from '../_lib/funnel-definitions.js';
import { denverToday } from '../_lib/dispatch-time.js';
import { JOBBER_GUARD_ACTIONS, jobberCutover, readJobberGuardState } from '../_lib/jobber-guard.js';

const STALE_MS = 7 * 86400000;
const reply = (status, body) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
const failure = (status, code, error) => reply(status, { ok: false, code, error });

// Reads refuse cross-site and sibling-site requests. A missing Origin is
// allowed only because the SameSite=Strict session cookie is required.
function sameOrigin(request) {
  const site = request.headers.get('Sec-Fetch-Site');
  if (site && !['same-origin', 'none'].includes(site)) return false;
  const source = request.headers.get('Origin') || request.headers.get('Referer');
  if (!source) return true;
  try { return new URL(source).origin === new URL(request.url).origin; } catch { return false; }
}

export function jobberGuardHandlers({ session = getHubSession, storage = dispatchStorage, now = () => new Date(), definitions = () => funnelDefinitions() } = {}) {
  return {
    async get({ request, env }) {
      if (!sameOrigin(request)) return failure(403, 'jobber_guard_origin_forbidden', 'Open the Jobber guard from the Employee Hub.');
      if ([...new URL(request.url).searchParams.keys()].length) return failure(400, 'jobber_guard_query_invalid', 'The Jobber guard takes no query parameters.');
      try {
        const actor = await session(request, env);
        if (!actor) return failure(401, 'jobber_guard_sign_in_required', 'Sign in to the EGC Hub.');
        if (!hasBusinessAccess(actor)) return failure(403, 'jobber_guard_forbidden', 'Business access is required for the Jobber guard.');
        const at = now(), { date } = jobberCutover(definitions()), reached = Boolean(date) && denverToday(at) >= date;
        const surface = flag => ({ enabled: flag === 'true', blocking: flag === 'true' && reached });
        const state = await readJobberGuardState(storage(env));
        const { findings = [], runId, checkedAt, coverage, counts, truncated, cutoverDate } = state || {};
        return reply(200, { ok: true, authority: 'employee_hub', asOf: at.toISOString(), cutoverDate: date, cutoverReached: reached,
          surfaces: { booking: surface(env?.EGC_JOBBER_GUARD_BOOKING), billing: surface(env?.EGC_JOBBER_GUARD_BILLING), messaging: surface(env?.EGC_JOBBER_GUARD_MESSAGING) },
          check: state ? { runId, checkedAt, cutoverDate, inForce: cutoverDate === date, stale: at.getTime() - Date.parse(checkedAt) > STALE_MS || cutoverDate !== date, coverage, counts, truncated: truncated === true, findings: findings.map(item => ({ ...item, action: JOBBER_GUARD_ACTIONS[item?.code] || null })) } : null });
      } catch {
        return failure(503, 'jobber_guard_unavailable', 'The Jobber guard could not be read. Retry.');
      }
    },
  };
}

const handlers = jobberGuardHandlers();
export const onRequestGet = handlers.get;
