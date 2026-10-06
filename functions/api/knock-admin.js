import { getHubSession } from '../_lib/hub-session.js';
import { createKnockStore, knockFailure } from '../_lib/knock-store.js';
import { requireAdmin } from '../_lib/knock-access.js';
import {
  addTraining, clearNoKnock, excludeHouses, excludeUnits, importNoKnock, listAssignments, listReps, listTraining,
  neighborhoodHouses, readSettings, seedNeighborhoods, setAssignment, updateNeighborhood, updateRep, updateSettings,
} from '../_lib/knock-admin.js';
import { loadNeighborhoods } from '../_lib/knock-territory.js';
import { errorResponse, forbiddenOrigin, readJson, reply, sameOrigin } from '../_lib/knock-http.js';

const VIEWS = {
  async reps(store) {
    const [reps, training] = await Promise.all([listReps(store), listTraining(store)]);
    return { reps, training: training.slice(0, 300) };
  },
  async settings(store) { return readSettings(store); },
  async territory(store) {
    const [neighborhoods, assignments, reps] = await Promise.all([loadNeighborhoods(store), listAssignments(store), listReps(store)]);
    return { neighborhoods: neighborhoods.map(({ __updateTime, ...n }) => n), assignments, reps };
  },
  async neighborhood(store, params) { return neighborhoodHouses(store, params.get('id')); },
};

const ACTIONS = {
  'rep.update': updateRep,
  'training.add': addTraining,
  'settings.update': updateSettings,
  'territory.seed': (store, _admin, _body, nowIso) => seedNeighborhoods(store, nowIso),
  'neighborhood.update': updateNeighborhood,
  'assignment.set': setAssignment,
  'house.exclude': excludeHouses,
  'neighborhood.excludeUnits': excludeUnits,
  'noknock.import': importNoKnock,
  'noknock.clear': clearNoKnock,
};

// Admin views (GET ?view=...) and changes (POST {action, ...}). Admins are Hub business users.
export function knockAdminHandlers({ session = getHubSession, storage = createKnockStore, now = () => new Date(), views = VIEWS, actions = ACTIONS } = {}) {
  return {
    async get({ request, env }) {
      try {
        requireAdmin(await session(request, env));
        const params = new URL(request.url).searchParams;
        const view = views[params.get('view') || ''];
        if (!view) throw knockFailure('Unknown admin view.', 404, 'knock_unknown_view');
        const result = await view(storage(env), params, now(), env);
        return result instanceof Response ? result : reply(200, { ok: true, serverTime: now().toISOString(), ...result });
      } catch (error) {
        return errorResponse(error);
      }
    },
    async post({ request, env }) {
      try {
        if (!sameOrigin(request)) throw forbiddenOrigin();
        const admin = requireAdmin(await session(request, env));
        const body = await readJson(request, 262144);
        const action = actions[String(body.action || '')];
        if (!action) throw knockFailure('Unknown admin action.', 400, 'knock_unknown_action');
        const result = await action(storage(env), admin, body, now().toISOString(), env);
        return reply(200, { ok: true, ...result });
      } catch (error) {
        return errorResponse(error);
      }
    },
  };
}

const handlers = knockAdminHandlers();
export const onRequestGet = handlers.get;
export const onRequestPost = handlers.post;
