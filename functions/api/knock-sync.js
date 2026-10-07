import { getHubSession } from '../_lib/hub-session.js';
import { createKnockStore } from '../_lib/knock-store.js';
import { ensureRep, loadSettings, requireActive } from '../_lib/knock-access.js';
import { applyBatch } from '../_lib/knock-sync.js';
import { errorResponse, forbiddenOrigin, readJson, reply, sameOrigin, signInRequired } from '../_lib/knock-http.js';

// POST /api/knock-sync {events: [...]}: the phone's queued shift, door and sale events, oldest first.
// Each event answers applied, duplicate (already stored) or rejected (with the reason).
export function knockSyncHandlers({ session = getHubSession, storage = createKnockStore, now = () => new Date() } = {}) {
  return {
    async post({ request, env }) {
      try {
        if (!sameOrigin(request)) throw forbiddenOrigin();
        const viewer = await session(request, env);
        if (!viewer?.user) throw signInRequired();
        const body = await readJson(request, 98304);
        const store = storage(env);
        const at = now();
        const [rep, settings] = await Promise.all([ensureRep(store, viewer, at.toISOString()), loadSettings(store)]);
        requireActive(rep);
        const result = await applyBatch(store, rep, settings, body.events, at.getTime());
        return reply(200, { ok: true, serverTime: at.toISOString(), ...result });
      } catch (error) {
        return errorResponse(error);
      }
    },
  };
}

const handlers = knockSyncHandlers();
export const onRequestPost = handlers.post;
