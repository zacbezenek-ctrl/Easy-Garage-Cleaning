import { getHubSession } from '../_lib/hub-session.js';
import { createKnockStore, knockFailure } from '../_lib/knock-store.js';
import { ensureRep, requireActive } from '../_lib/knock-access.js';
import { dispatchStorage } from '../_lib/dispatch-storage.js';
import { knockJobBridgeEnabled, walkthroughSlotsForRep } from '../_lib/knock-bridge.js';
import { bridgeUnavailable, errorResponse, reply, signInRequired } from '../_lib/knock-http.js';

// GET /api/knock-walkthrough-slots (KNOCK-BRIDGE, EGC_KNOCK_JOB_BRIDGE): the estimator hours an active rep can offer
// at the door over the next 10 days, 9:00 to 5:00. Each slot is {date, time, endTime, estimator, ref}: the estimator's
// first name and an opaque handle the walkthrough event sends back, never a staff key, roster or customer. Estimators
// are staff with the walkthrough_estimating skill (EGC_STAFF_DIRECTORY_ENABLED, once anyone holds it), else staff whose role is sales.
export function knockWalkthroughSlotsHandlers({ session = getHubSession, storage = createKnockStore, dispatch = dispatchStorage, now = () => new Date() } = {}) {
  return {
    async get({ request, env }) {
      try {
        if (!knockJobBridgeEnabled(env)) throw knockFailure('Setting walkthroughs from canvassing is not turned on.', 404, 'knock_bridge_off');
        const viewer = await session(request, env);
        if (!viewer?.user) throw signInRequired();
        const store = storage(env), at = now();
        const rep = requireActive(await ensureRep(store, viewer, at.toISOString()));
        const result = await walkthroughSlotsForRep(dispatch(env), env, rep, at)
          .catch(error => { throw bridgeUnavailable(error, 'Walkthrough times could not be loaded. Pick a day and morning or afternoon; the office confirms the time.'); });
        return reply(200, { ok: true, serverTime: at.toISOString(), ...result });
      } catch (error) {
        return errorResponse(error);
      }
    },
  };
}

const handlers = knockWalkthroughSlotsHandlers();
export const onRequestGet = handlers.get;
