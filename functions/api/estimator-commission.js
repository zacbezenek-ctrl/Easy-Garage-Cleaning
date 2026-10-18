/** GET /api/estimator-commission: the signed-in employee's own estimator 7% (owner decision D6b), read only: each
 * walkthrough they sold (signed in the Hub) or took from a door-to-door rep, with its projected and earned share, and
 * whether the owner approved the terms. Rules and reads: functions/_lib/estimator-commission.js. Never another
 * employee's, a setter's or a customer's details; Hub > My commission (employee-estimator-commission.js) shows it. */
import { getHubSession } from '../_lib/hub-session.js';
import { createKnockStore } from '../_lib/knock-store.js';
import { dispatchStorage } from '../_lib/dispatch-storage.js';
import { loadSettings, loadSetterTerms } from '../_lib/knock-access.js';
import { estimatorLedger, estimatorView } from '../_lib/estimator-commission.js';

const reply = (status, body) => Response.json(body, { status, headers: { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } });

export function estimatorCommissionHandlers({ session = getHubSession, knock = createKnockStore, dispatch = dispatchStorage, now = () => new Date() } = {}) {
  return {
    async get({ request, env }) {
      let viewer;
      try { viewer = await session(request, env); } catch { viewer = null; }
      if (!viewer?.user) return reply(401, { ok: false, code: 'estimator_commission_sign_in', error: 'Sign in to see your commission.' });
      try {
        const kstore = knock(env), at = now();
        const terms = await loadSetterTerms(kstore, await loadSettings(kstore));
        const ledger = await estimatorLedger({ kstore, dispatch: dispatch(env), env, estimatorKey: viewer.user, actorId: viewer.user, terms, nowMs: at.getTime() });
        return reply(200, { ok: true, generatedAt: at.toISOString(), ...estimatorView(ledger, terms) });
      } catch {
        return reply(503, { ok: false, code: 'estimator_commission_unavailable', error: 'Your commission could not be loaded. Retry in a moment.' });
      }
    },
  };
}

const handlers = estimatorCommissionHandlers();
export const onRequestGet = handlers.get;
