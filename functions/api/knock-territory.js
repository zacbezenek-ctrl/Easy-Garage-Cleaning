import { getHubSession } from '../_lib/hub-session.js';
import { createKnockStore, knockFailure } from '../_lib/knock-store.js';
import { ensureRep, loadSettings, requireActive } from '../_lib/knock-access.js';
import { repTerritory, territoryHouses } from '../_lib/knock-territory.js';
import { errorResponse, reply, signInRequired } from '../_lib/knock-http.js';

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;

// GET /api/knock-territory[?since=ISO]: houses in the signed-in rep's unlocked, assigned territory
// (addresses and outcome summaries only), plus the territory list with lock reasons.
export function knockTerritoryHandlers({ session = getHubSession, storage = createKnockStore, now = () => new Date() } = {}) {
  return {
    async get({ request, env }) {
      try {
        const viewer = await session(request, env);
        if (!viewer?.user) throw signInRequired();
        const store = storage(env);
        const serverTime = now().toISOString();
        const [rep, settings] = await Promise.all([ensureRep(store, viewer, serverTime), loadSettings(store)]);
        requireActive(rep);
        const since = new URL(request.url).searchParams.get('since') || '';
        if (since && !ISO.test(since)) throw knockFailure('Bad sync time.', 400, 'knock_invalid_since');
        const territory = await repTerritory(store, rep, settings);
        // Overlap two minutes so a write that committed while the last read ran is never skipped.
        const houses = await territoryHouses(store, rep, territory, { since: since ? new Date(Date.parse(since) - 120000).toISOString() : '' });
        return reply(200, { ok: true, serverTime, full: !since, neighborhoods: territory.neighborhoods, houses });
      } catch (error) {
        return errorResponse(error);
      }
    },
  };
}

const handlers = knockTerritoryHandlers();
export const onRequestGet = handlers.get;
