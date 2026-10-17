import { getHubSession } from '../_lib/hub-session.js';
import { createKnockStore, knockFailure } from '../_lib/knock-store.js';
import { ensureRep, loadSettings, requireActive } from '../_lib/knock-access.js';
import { dispatchStorage } from '../_lib/dispatch-storage.js';
import { crewSlotsForRep, knockJobBridgeEnabled } from '../_lib/knock-bridge.js';
import { bridgeUnavailable, errorResponse, reply, signInRequired } from '../_lib/knock-http.js';

// GET /api/knock-crew-openings?from=YYYY-MM-DD&package=...&days=1..14 (KNOCK-BRIDGE, EGC_KNOCK_JOB_BRIDGE): the crew
// starts an active rep can offer at the door, on and after the sale's earliest job date (the day after the right to
// cancel ends), for the package's length. Each slot is {date, time, endTime, crewLabel, priority} and nothing else: no
// roster, no crew members, no other customer. The server re-picks the crew when the sale syncs (knock-bridge.js).
export function knockCrewOpeningsHandlers({ session = getHubSession, storage = createKnockStore, dispatch = dispatchStorage, now = () => new Date() } = {}) {
  return {
    async get({ request, env }) {
      try {
        if (!knockJobBridgeEnabled(env)) throw knockFailure('Booking crews from canvassing is not turned on.', 404, 'knock_bridge_off');
        const viewer = await session(request, env);
        if (!viewer?.user) throw signInRequired();
        const store = storage(env), at = now();
        const [rep, settings] = await Promise.all([ensureRep(store, viewer, at.toISOString()), loadSettings(store)]);
        requireActive(rep);
        const params = new URL(request.url).searchParams;
        const result = await crewSlotsForRep(dispatch(env), settings, { from: params.get('from') || '', package: params.get('package') || '', days: params.get('days') || '' }, at)
          .catch(error => { throw bridgeUnavailable(error, 'Crew openings could not be loaded. Pick a day and morning or afternoon; the office confirms the crew.'); });
        return reply(200, { ok: true, serverTime: at.toISOString(), ...result });
      } catch (error) {
        return errorResponse(error);
      }
    },
  };
}

const handlers = knockCrewOpeningsHandlers();
export const onRequestGet = handlers.get;
