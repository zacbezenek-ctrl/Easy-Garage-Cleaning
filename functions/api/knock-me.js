import { getHubSession } from '../_lib/hub-session.js';
import { quoteAuthorAccess } from '../_lib/quote-permissions.js';
import { createKnockStore } from '../_lib/knock-store.js';
import { ensureRep, isAdmin, loadSettings, shiftEligibility } from '../_lib/knock-access.js';
import { repHome } from '../_lib/knock-territory.js';
import { knockJobBridgeEnabled } from '../_lib/knock-bridge.js';
import { repRunsWalkthroughs } from '../_lib/knock-self-walkthrough.js';
import { errorResponse, reply, signInRequired } from '../_lib/knock-http.js';

// GET /api/knock-me: the signed-in rep's canvassing profile, settings, territory summary and
// open shift. A first visit creates a pending profile for an admin to approve.
export function knockMeHandlers({ session = getHubSession, storage = createKnockStore, now = () => new Date() } = {}) {
  return {
    async get({ request, env }) {
      try {
        const viewer = await session(request, env);
        if (!viewer?.user) throw signInRequired();
        const store = storage(env);
        const at = now();
        const nowIso = at.toISOString();
        const [rep, settings] = await Promise.all([ensureRep(store, viewer, nowIso), loadSettings(store)]);
        const body = {
          ok: true, serverTime: nowIso,
          viewer: { user: viewer.user, displayName: viewer.displayName || viewer.user, repKey: rep.repKey, admin: isAdmin(viewer), walkthrough: isAdmin(viewer),
            // KNOCK-BRIDGE: the phone offers crew slots, ZIP and "Walkthrough set" only while EGC_KNOCK_JOB_BRIDGE is on.
            ...(knockJobBridgeEnabled(env) ? { jobBridge: true } : {}),
            // REP-WALKTHROUGH: the phone offers "Do the walkthrough now" to a rep with Walkthroughs on in Knock Admin, and to
            // anyone the walkthrough app opens for (a quote author: an owner, a manager, an estimator); the bridge and the
            // walkthrough check it again.
            ...(knockJobBridgeEnabled(env) && (repRunsWalkthroughs(rep) || quoteAuthorAccess(viewer, env).author) ? { walkthroughNow: true } : {}) },
          rep, settings, eligibility: shiftEligibility(rep),
        };
        if (rep.status === 'active') Object.assign(body, await repHome(store, rep, settings, at.getTime()));
        return reply(200, body);
      } catch (error) {
        return errorResponse(error);
      }
    },
  };
}

const handlers = knockMeHandlers();
export const onRequestGet = handlers.get;
