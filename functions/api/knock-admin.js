import { getHubSession } from '../_lib/hub-session.js';
import { createKnockStore, knockFailure } from '../_lib/knock-store.js';
import { requireAdmin } from '../_lib/knock-access.js';
import {
  addTraining, clearNoKnock, coverageView, excludeHouses, excludeUnits, importNoKnock, listAssignments, listReps, listTraining,
  neighborhoodHouses, readSettings, seedNeighborhoods, setAssignment, updateNeighborhood, updateRep, updateSettings,
} from '../_lib/knock-admin.js';
import { loadNeighborhoods } from '../_lib/knock-territory.js';
import { allSales, setJobDate, setSaleStatus } from '../_lib/knock-sales.js';
import { customerMessage, integrationStatus, refundSummary, saleHandoff } from '../_lib/knock-handoff.js';
import { loadSettings } from '../_lib/knock-access.js';
import { rebuildDay } from '../_lib/knock-sync.js';
import { errorResponse, forbiddenOrigin, readJson, reply, sameOrigin } from '../_lib/knock-http.js';

// A sale's status changes its rep's booked revenue for the sale day.
async function afterSaleChange(store, result, nowIso) {
  const settings = await loadSettings(store);
  if (result?.sale?.repKey && result.sale.saleDate) await rebuildDay(store, result.sale.repKey, result.sale.saleDate, settings, Date.parse(nowIso));
  return result;
}

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
  async coverage(store, _params, now) { return coverageView(store, now.getTime()); },
  async sales(store, params, now, env) {
    const [sales, reps, settings] = await Promise.all([allSales(store, { from: params.get('from') || '', to: params.get('to') || '' }), listReps(store), loadSettings(store)]);
    return {
      sales: sales.map(sale => ({ ...sale, refund: refundSummary(sale, now.getTime()), message: customerMessage(sale) })),
      reps: reps.map(r => ({ repKey: r.repKey, displayName: r.displayName })),
      integrations: integrationStatus(env || {}, settings),
    };
  },
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
  'sale.status': async (store, admin, body, nowIso) => afterSaleChange(store, await setSaleStatus(store, admin, body, nowIso), nowIso),
  'sale.jobDate': setJobDate,
  'sale.handoff': (store, admin, body, nowIso, env) => saleHandoff(store, admin, body, nowIso, env),
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
