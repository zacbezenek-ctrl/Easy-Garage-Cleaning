import { getHubSession } from '../_lib/hub-session.js';
import { createKnockStore, knockFailure } from '../_lib/knock-store.js';
import { requireAdmin } from '../_lib/knock-access.js';
import {
  addTraining, approveCompensation, approveSetterTerms, clearNoKnock, coverageView, excludeHouses, excludeUnits, flagsView, importNoKnock, listAssignments, listReps, listTraining,
  neighborhoodHouses, readSettings, seedNeighborhoods, setAssignment, updateNeighborhood, updateRep, updateSettings,
} from '../_lib/knock-admin.js';
import { loadNeighborhoods } from '../_lib/knock-territory.js';
import { allSales, repSaleView, setJobDate, setSaleStatus, recordSaleCollection } from '../_lib/knock-sales.js';
import { customerMessage, integrationStatus, refundSummary, saleHandoff, saleSyncSummaries } from '../_lib/knock-handoff.js';
import { loadSettings, loadSetterTerms } from '../_lib/knock-access.js';
import { rebuildDay } from '../_lib/knock-sync.js';
import { addPayout, exportCsv, moneyView, periodFromParams } from '../_lib/knock-reports.js';
import { classifySetter, recordSetterAttribution, setterAttributions, setterBatchReaderFor } from '../_lib/knock-setters.js';
import { ESTIMATOR_LOOKBACK_DAYS, channelEarnings, classifyEstimatorJob, estimatorLedger } from '../_lib/estimator-commission.js';
import { addDays, zonedDate } from '../../crew/knock-time.js';
import { csvResponse, errorResponse, forbiddenOrigin, readJson, reply, sameOrigin } from '../_lib/knock-http.js';
import { dispatchStorage } from '../_lib/dispatch-storage.js';
import { bookSale, bookWalkthrough, followSaleStatus, knockJobBridgeEnabled, moveSaleJob } from '../_lib/knock-bridge.js';
import { officeWalkthroughs } from '../_lib/knock-walkthroughs.js';

// KNOCK-BRIDGE (EGC_KNOCK_JOB_BRIDGE): book (or retry booking) a door sale's Hub job or a door walkthrough from Admin.
const bridged = run => async (store, admin, body, nowIso, env, { dispatch = dispatchStorage } = {}) => {
  if (!knockJobBridgeEnabled(env)) throw knockFailure('Booking from canvassing is not turned on.', 404, 'knock_bridge_off');
  return run(store, dispatch(env), body.saleId || body.walkthroughId, { env, now: new Date(nowIso), rep: null });
};

// KNOCK-BRIDGE: a cancelled or reinstated sale's Hub job follows it (the answer adds hub: what happened to the job).
async function saleStatus(store, admin, body, nowIso, env, { dispatch = dispatchStorage } = {}) {
  let result = await setSaleStatus(store, admin, body, nowIso);
  if (knockJobBridgeEnabled(env)) {
    const followed = await followSaleStatus(store, dispatch(env), result.sale, { now: new Date(nowIso) });
    if (followed) result = { ...result, sale: repSaleView(followed.sale), hub: followed.hub };
  }
  return afterSaleChange(store, result, nowIso);
}

// KNOCK-BRIDGE: a new job date moves the sale's Hub job first (refused when the Hub cannot take it).
const saleJobDate = (store, admin, body, nowIso, env, { dispatch = dispatchStorage } = {}) => (knockJobBridgeEnabled(env)
  ? setJobDate(store, admin, body, nowIso, { jobBridge: true, moveHub: (sale, when) => moveSaleJob(dispatch(env), sale, when, { env, now: new Date(nowIso) }) })
  : setJobDate(store, admin, body, nowIso));

/* D6b: the approved setter and estimator shares a pay period's statement adds (null, and nothing read, before the
   owner approved the setter terms). */
async function statementChannels(store, params, now, env, dispatch) {
  const settings = await loadSettings(store), terms = await loadSetterTerms(store, settings);
  return { settings, channels: await channelEarnings({ kstore: store, dispatch: dispatch(env), env, terms, nowMs: now.getTime(), period: periodFromParams(params, settings, now.getTime()) }) };
}

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
  async settings(store, _params, _now, _env, viewer) { return readSettings(store, viewer); },
  async territory(store) {
    const [neighborhoods, assignments, reps] = await Promise.all([loadNeighborhoods(store), listAssignments(store), listReps(store)]);
    return { neighborhoods: neighborhoods.map(({ __updateTime, ...n }) => n), assignments, reps };
  },
  async neighborhood(store, params) { return neighborhoodHouses(store, params.get('id')); },
  async coverage(store, _params, now) { return coverageView(store, now.getTime()); },
  async flags(store) { return flagsView(store); },
  async sales(store, params, now, env) {
    const [sales, reps, settings] = await Promise.all([allSales(store, { from: params.get('from') || '', to: params.get('to') || '' }), listReps(store), loadSettings(store)]);
    const sync = await saleSyncSummaries(store, sales);
    return {
      sales: sales.map(sale => ({ ...sale, sync: sync.get(sale.id), refund: refundSummary(sale, now.getTime()), message: customerMessage(sale) })),
      reps: reps.map(r => ({ repKey: r.repKey, displayName: r.displayName })),
      integrations: integrationStatus(env || {}, settings),
      // KNOCK-BRIDGE: door walkthroughs not in the Hub yet (booking, retrying or refused), for the office to book.
      ...(knockJobBridgeEnabled(env) ? { walkthroughs: await officeWalkthroughs(store) } : {}),
    };
  },
  async money(store, params, now, env, _viewer, { dispatch = dispatchStorage } = {}) {
    const { settings, channels } = await statementChannels(store, params, now, env, dispatch);
    return moneyView(store, params, now.getTime(), settings, { channels });
  },
  async setters(store, _params, now, env, _viewer, { dispatch = dispatchStorage } = {}) {
    const terms = await loadSetterTerms(store, await loadSettings(store));
    return { ...(await setterAttributions(store, env, { nowMs: now.getTime(), terms, readJobs: setterBatchReaderFor(dispatch(env)) })), reps: await listReps(store) };
  },
  // D6b: every estimator's 7% (door-to-door-set walkthroughs and direct walkthrough sales signed in the last year).
  async estimators(store, _params, now, env, _viewer, { dispatch = dispatchStorage } = {}) {
    const terms = await loadSetterTerms(store, await loadSettings(store));
    const ledger = await estimatorLedger({ kstore: store, dispatch: dispatch(env), env, since: addDays(zonedDate(now.getTime()), -ESTIMATOR_LOOKBACK_DAYS), terms, nowMs: now.getTime() });
    return { rows: ledger.rows, truncated: ledger.truncated, terms: { verified: terms.verified, approvedAt: terms.approvedAt }, lookbackDays: ESTIMATOR_LOOKBACK_DAYS };
  },
  async export(store, params, now, env, _viewer, { dispatch = dispatchStorage } = {}) {
    const { settings, channels } = (params.get('kind') || 'commission') === 'commission' ? await statementChannels(store, params, now, env, dispatch) : { settings: await loadSettings(store), channels: null };
    const { csv, filename } = await exportCsv(store, params, now.getTime(), settings, { channels });
    return csvResponse(filename, csv);
  },
};

const ACTIONS = {
  'rep.update': updateRep,
  'training.add': addTraining,
  'settings.update': updateSettings,
  // Owner only (checked inside): records compensationApproval for the saved terms.
  'compensation.approve': approveCompensation,
  // Owner only (checked inside): records setterApproval, the fixed 13% setter + 7% estimator terms (D6b).
  'setter.approve': approveSetterTerms,
  'territory.seed': (store, _admin, _body, nowIso) => seedNeighborhoods(store, nowIso),
  'neighborhood.update': updateNeighborhood,
  'assignment.set': setAssignment,
  'house.exclude': excludeHouses,
  'neighborhood.excludeUnits': excludeUnits,
  'noknock.import': importNoKnock,
  'noknock.clear': clearNoKnock,
  'sale.status': saleStatus,
  'sale.jobDate': saleJobDate,
  'sale.collection': recordSaleCollection,
  'sale.handoff': (store, admin, body, nowIso, env) => saleHandoff(store, admin, body, nowIso, env),
  'setter.record': recordSetterAttribution,
  'setter.classify': classifySetter,
  // D6b: garage or junk for a direct walkthrough sale whose signed handoff does not show garage work.
  'estimator.classify': classifyEstimatorJob,
  'sale.book': bridged(async (...args) => { const { sale, view } = await bookSale(...args); return { sale, booking: view }; }),
  'walkthrough.book': bridged(async (...args) => { const { walkthrough, view } = await bookWalkthrough(...args); return { walkthrough, booking: view }; }),
  'payout.add': addPayout,
};

// Admin views (GET ?view=...) and changes (POST {action, ...}). Admins are Hub business users.
export function knockAdminHandlers({ session = getHubSession, storage = createKnockStore, now = () => new Date(), views = VIEWS, actions = ACTIONS, dispatch = dispatchStorage } = {}) {
  return {
    async get({ request, env }) {
      try {
        const viewer = requireAdmin(await session(request, env));
        const params = new URL(request.url).searchParams;
        const view = views[params.get('view') || ''];
        if (!view) throw knockFailure('Unknown admin view.', 404, 'knock_unknown_view');
        const result = await view(storage(env), params, now(), env, viewer, { dispatch });
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
        const result = await action(storage(env), admin, body, now().toISOString(), env, { dispatch });
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
