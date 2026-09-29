/** recurring.extend_horizon (P1-DS-11): the scheduled rolling-horizon run for
 * recurring plans, reached only through the signed operations bridge
 * (functions/api/operations-portal.js) from egc-api's hourly timer, as the
 * recurring-horizon-worker integration actor.
 *
 * - Actor: exactly the integration actor recurring-horizon-worker (kind and role
 *   both 'integration'), which egc-api mints (bound to api in bridge-command-policy.ts).
 * - Clock: `now` comes from the signed envelope (iat), never from the command body.
 * - Gate: a no-op unless EGC_RECURRING_PLANS_ENABLED=true on the Hub.
 * - Bounds: at most maxPlans plans (default 10, max 25) and `limit` dispatch or
 *   money writes (default 4, max 20) per call. Plans run in id (code-unit)
 *   order after the optional `after` cursor; the response says whether to call
 *   again (`more`) and from where (`after`, null = from the start). A plan that
 *   spends attempts without progress (a persistent retry) is passed over until
 *   the next cycle, so it never holds back the plans after it. Booked-visit
 *   changes settled without a move ('kept') count as progress.
 * - Money: visits are priced only while MONEY_API_ENABLED=true; the estimate
 *   saves are audited under the plan's manager, via 'cron'.
 * - Authority: each plan's visits are created for the manager who last saved
 *   that plan, if that person is still an owner or manager with business access;
 *   otherwise the plan is recorded as blocked (recurring_plan_manager_inactive).
 * - Idempotency: occurrence, move and price request IDs are derived from the
 *   plan and date, so two runs with the same clock create nothing twice.
 * The response carries counts and ids only: no customer names, addresses or money. */
import { RECURRING_HORIZON_ACTOR, RECURRING_HORIZON_COMMAND } from '../../egc-platform/services/operations/src/hub-command-policy.ts';
import { hasBusinessAccess, listHubAccessProfiles, withStaffRoleAccess } from './hub-session.js';
import { dispatchStorage } from './dispatch-storage.js';
import { moneyApiEnabled } from './money-service.js';
import { extendHorizon, planHasWork, recurringPlansEnabled } from './recurring-plan-service.js';

export { RECURRING_HORIZON_ACTOR, RECURRING_HORIZON_COMMAND };
export const RECURRING_HORIZON_BOUNDS = Object.freeze({ plans: 10, maxPlans: 25, limit: 4, maxLimit: 20 });
const SAFE_CODE = /^(?:recurring|dispatch)_[a-z_]+$/;
const fail = (code, status = 400) => Object.assign(new Error(code), { code, status });
const safeId = id => typeof id === 'string' && /^[A-Za-z0-9_-]{1,180}$/.test(id) && !/^(secure_|_egc_)/.test(id);
const count = (value, fallback, max) => { if (value === undefined) return fallback; if (!Number.isInteger(value) || value < 1 || value > max) throw fail('recurring_horizon_invalid'); return value; };
const username = value => typeof value === 'string' ? value.trim().toLowerCase() : '';
const byId = (a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
// Kept: booked-visit changes settled without a move (the visit started, was changed in Dispatch or its new slot is taken).
const COUNTED = ['created','conflicts','adopted','updated','kept','priced'];
const progressed = outcome => COUNTED.some(key => outcome[key]?.length > 0);

/** The dispatcher a plan's generated visits are created for. */
export function planManagerSession(plan, profiles, actor) {
  const user = username(plan?.updatedBy || plan?.createdBy), matches = (Array.isArray(profiles) ? profiles : []).filter(profile => user && username(profile?.user) === user);
  const [profile] = matches;
  if (matches.length !== 1 || !['owner','manager'].includes(profile.role) || !hasBusinessAccess(profile)) throw Object.assign(new Error('The manager who last saved this plan can no longer schedule work. A current manager must open and save the plan before more visits are added.'), { code: 'recurring_plan_manager_inactive', status: 409 });
  return Object.freeze(withStaffRoleAccess(profile, { user: profile.user, displayName: String(profile.displayName || profile.user), role: profile.role, businessAccess: true, source: 'recurring_horizon', via: 'cron', actorId: actor.id, actorKind: 'integration', delegatedBy: actor.id }));
}

const summary = outcome => ({ planId: outcome.planId, created: outcome.created?.length || 0, conflicts: outcome.conflicts?.length || 0, adopted: outcome.adopted?.length || 0, updated: outcome.updated?.length || 0, kept: outcome.kept?.length || 0, priced: (outcome.priced || []).filter(row => row.status === 'applied').length,
  attempts: outcome.attempts || 0, blocked: outcome.blocked?.code || null, complete: outcome.complete === true, retryable: outcome.retryable === true, error: outcome.error?.code || null });

export async function runRecurringHorizonCommand(env, actor, command, { now, runId = null, storage = dispatchStorage, profiles = () => listHubAccessProfiles(env) } = {}) {
  try {
    if (actor?.kind !== 'integration' || actor.role !== 'integration' || actor.id !== RECURRING_HORIZON_ACTOR) throw fail('recurring_horizon_internal_only', 403);
    if (!command || typeof command !== 'object' || Array.isArray(command) || command.command !== RECURRING_HORIZON_COMMAND || Object.keys(command).some(key => !['command','after','maxPlans','limit'].includes(key))) throw fail('recurring_horizon_invalid');
    if (command.after !== undefined && command.after !== null && !safeId(command.after)) throw fail('recurring_horizon_invalid');
    const maxPlans = count(command.maxPlans, RECURRING_HORIZON_BOUNDS.plans, RECURRING_HORIZON_BOUNDS.maxPlans), limit = count(command.limit, RECURRING_HORIZON_BOUNDS.limit, RECURRING_HORIZON_BOUNDS.maxLimit), after = command.after ?? null;
    if (typeof now !== 'string' || !Number.isFinite(Date.parse(now))) throw fail('recurring_clock_invalid', 503);
    const base = { ok: true, authority: 'employee_hub', command: RECURRING_HORIZON_COMMAND, asOf: now, runId };
    if (!recurringPlansEnabled(env)) return { ...base, enabled: false, plans: [], complete: true, more: false, after: null };
    const store = storage(env), pricing = moneyApiEnabled(env), waiting = (await store.recurringPlans()).filter(plan => safeId(plan?.id) && (after === null || plan.id > after) && planHasWork(plan, now, { pricing })).sort(byId);
    const page = waiting.slice(0, maxPlans), people = page.length ? await profiles() : [];
    const run = page.length ? await extendHorizon(store, null, { now, planIds: page.map(plan => plan.id), limit, runId, actorFor: plan => planManagerSession(plan, people, actor), pricing }) : { plans: [] };
    const plans = run.plans.map(summary), attempts = plans.reduce((sum, row) => sum + row.attempts, 0);
    // Resume at the first plan this call ran out of budget on (one that made
    // progress, or never got a turn); otherwise after the page.
    const stopped = run.plans.findIndex(row => !row.complete && !row.blocked && !row.error && (progressed(row) || !row.attempts));
    const resume = stopped >= 0 && attempts > 0 ? { more: true, after: stopped ? page[stopped - 1].id : after } : waiting.length > page.length ? { more: true, after: page[page.length - 1].id } : { more: false, after: null };
    const totals = Object.fromEntries(COUNTED.map(key => [key, plans.reduce((sum, row) => sum + row[key], 0)]));
    return { ...base, enabled: true, plans, totals: { ...totals, blocked: plans.filter(row => row.blocked).length, errors: plans.filter(row => row.error).length, attempts }, complete: plans.every(row => row.complete) && !resume.more, ...resume };
  } catch (error) {
    // The bridge relays only namespaced codes; messages and storage internals stay in the Hub.
    if (SAFE_CODE.test(String(error?.code || '')) && (error.status >= 400 && error.status < 500 || error.status === 503)) throw fail(error.code, error.status);
    throw fail('recurring_horizon_unavailable', 503);
  }
}
