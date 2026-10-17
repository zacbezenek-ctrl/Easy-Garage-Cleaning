import { getHubSession } from '../_lib/hub-session.js';
import { createKnockStore, knockFailure } from '../_lib/knock-store.js';
import { ensureRep, isAdmin, requireActive } from '../_lib/knock-access.js';
import { dispatchStorage } from '../_lib/dispatch-storage.js';
import { bookSale, bookWalkthrough, knockJobBridgeEnabled } from '../_lib/knock-bridge.js';
import { errorResponse, forbiddenOrigin, readJson, reply, sameOrigin, signInRequired } from '../_lib/knock-http.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// POST /api/knock-job-bridge {kind: 'sale' | 'walkthrough', id} (KNOCK-BRIDGE, EGC_KNOCK_JOB_BRIDGE): books the Hub
// crew job for a synced door sale, or the estimator walkthrough (and its setter attribution) for a synced walkthrough
// set at the door. The phone calls it right after /api/knock-sync answers bridge:{status:'pending'}, and again on
// later syncs until it is booked; an admin can run the same booking from Admin > Sales. Idempotent on the id: a repeat
// answers the first booking. Only the rep's own record (or an admin). The answer is the rep's view only:
// {booking: {kind, id, status, date, time, endTime, crewLabel | estimator, message}}.
export function knockJobBridgeHandlers({ session = getHubSession, storage = createKnockStore, dispatch = dispatchStorage, now = () => new Date() } = {}) {
  return {
    async post({ request, env }) {
      try {
        if (!sameOrigin(request)) throw forbiddenOrigin();
        if (!knockJobBridgeEnabled(env)) throw knockFailure('Booking from canvassing is not turned on.', 404, 'knock_bridge_off');
        const viewer = await session(request, env);
        if (!viewer?.user) throw signInRequired();
        const body = await readJson(request, 4096);
        if (!['sale', 'walkthrough'].includes(body.kind) || !UUID.test(String(body.id || ''))) throw knockFailure('Choose a sale or walkthrough to book.', 400, 'knock_bridge_invalid');
        const store = storage(env), at = now();
        const rep = requireActive(await ensureRep(store, viewer, at.toISOString()));
        const options = { env, now: at, rep: isAdmin(viewer) ? null : rep };
        const result = body.kind === 'sale' ? await bookSale(store, dispatch(env), body.id, options) : await bookWalkthrough(store, dispatch(env), body.id, options);
        return reply(200, { ok: true, serverTime: at.toISOString(), booking: result.view });
      } catch (error) {
        return errorResponse(error);
      }
    },
  };
}

const handlers = knockJobBridgeHandlers();
export const onRequestPost = handlers.post;
