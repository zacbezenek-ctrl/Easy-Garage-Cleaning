import { getHubSession } from '../_lib/hub-session.js';
import { createKnockStore, knockFailure } from '../_lib/knock-store.js';
import { ensureRep, loadSettings, requireActive } from '../_lib/knock-access.js';
import { availableNeighborhoods, claimNeighborhood, releaseNeighborhood, repTerritory, territoryHouses } from '../_lib/knock-territory.js';
import { errorResponse, forbiddenOrigin, readJson, reply, sameOrigin, signInRequired } from '../_lib/knock-http.js';

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;

// GET /api/knock-territory[?since=ISO]: houses in the signed-in rep's unlocked, assigned territory
// (addresses and outcome summaries only), plus the territory list with lock reasons.
// GET /api/knock-territory?view=available: the rep's neighborhoods and the ones they may claim, with
// centers for "near me" (no houses, no other rep's name).
// POST /api/knock-territory {action: 'claim'|'release', neighborhoodId}: the rep claims an open
// neighborhood (settings.territory) or releases their own claim.
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
        const params = new URL(request.url).searchParams;
        const view = params.get('view') || '';
        if (view === 'available') return reply(200, { ok: true, serverTime, ...(await availableNeighborhoods(store, rep, settings, serverTime)) });
        if (view) throw knockFailure('Unknown territory view.', 404, 'knock_unknown_view');
        const since = params.get('since') || '';
        if (since && !ISO.test(since)) throw knockFailure('Bad sync time.', 400, 'knock_invalid_since');
        const territory = await repTerritory(store, rep, settings);
        // Overlap two minutes so a write that committed while the last read ran is never skipped.
        const houses = await territoryHouses(store, rep, territory, { since: since ? new Date(Date.parse(since) - 120000).toISOString() : '' });
        return reply(200, { ok: true, serverTime, full: !since, neighborhoods: territory.neighborhoods, houses });
      } catch (error) {
        return errorResponse(error);
      }
    },
    async post({ request, env }) {
      try {
        if (!sameOrigin(request)) throw forbiddenOrigin();
        const viewer = await session(request, env);
        if (!viewer?.user) throw signInRequired();
        const body = await readJson(request, 4096);
        const store = storage(env);
        const nowIso = now().toISOString();
        const [rep, settings] = await Promise.all([ensureRep(store, viewer, nowIso), loadSettings(store)]);
        requireActive(rep);
        const action = String(body.action || '');
        if (action === 'claim') return reply(200, { ok: true, serverTime: nowIso, ...(await claimNeighborhood(store, rep, settings, body, nowIso)) });
        if (action === 'release') return reply(200, { ok: true, serverTime: nowIso, ...(await releaseNeighborhood(store, rep, body, nowIso)) });
        throw knockFailure('Unknown territory action.', 400, 'knock_unknown_action');
      } catch (error) {
        return errorResponse(error);
      }
    },
  };
}

const handlers = knockTerritoryHandlers();
export const onRequestGet = handlers.get;
export const onRequestPost = handlers.post;
