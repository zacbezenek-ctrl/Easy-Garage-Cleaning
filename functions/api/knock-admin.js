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
import { canSetPay, seesOthersPay } from '../_lib/pay-visibility.js';

/* Pay privacy (docs/FUNNEL-METRICS.md §8.3: a manager sees no per-employee pay). An estimator's 7% on a named job is
   that person's pay: a viewer who does not see others' pay (pay-visibility.js seesOthersPay, the owner by default) gets
   each ledger row without its amounts or the job revenue they come from, which keeps the office's classification work;
   the pay files (view=export) are the owner's, like the payroll export. A rep or estimator still sees their own
   commission in the rep app (knock.js), which this does not touch. */
const ESTIMATOR_ROW_FIELDS = Object.freeze(['id', 'jobId', 'walkthroughId', 'jobDate', 'channel', 'estimatorKey', 'estimatorEvidence', 'setterKey', 'state', 'rate',
  'qualifyingAt', 'earnedAt', 'reviewReasons', 'settlement', 'serviceClassification', 'signedAt', 'recordedAt']);
const only = fields => row => Object.fromEntries(fields.filter(key => Object.hasOwn(row, key)).map(key => [key, row[key]]));
const withoutPay = only(ESTIMATOR_ROW_FIELDS);
// Door-to-door payroll (owner decision 2026-10-21): each rep's period statement and the payouts recorded are pay, seen
// only by seesOthersPay; a manager keeps the counts (sales, training minutes) and what needs review, never an amount or
// the revenue a commission comes from, and only the owner records a payout (canSetPay). A rep's own statement is
// /api/knock-reports?view=my-money, unchanged.
const STATEMENT_ROW_FIELDS = Object.freeze(['repKey', 'name', 'salesBooked', 'trainingMinutes', 'collectionUnknownCount', 'reviewReasons', 'compensationState']);
const statementWithoutPay = only(STATEMENT_ROW_FIELDS);
// Admin > Setters: each record's 13% and 7% shares (allocations, earned/payable/projected amounts, the job revenue and
// any adjustment) are the setter's and estimator's pay; anyone else keeps the record and what needs review.
const SETTER_ROW_FIELDS = Object.freeze(['id', 'walkthroughId', 'jobId', 'jobDate', 'channel', 'setterKey', 'estimatorKey', 'estimatorEvidence', 'serviceClassification', 'state', 'rate',
  'qualifyingAt', 'earnedAt', 'reviewReasons', 'settlement', 'recordedAt']);
const setterWithoutPay = only(SETTER_ROW_FIELDS);
// The training rate is the role's published company rate (owner decision 2026-10-22), not one person's pay: every rep
// sees it on their own statement, and a manager sees it through /api/knock-me and their own My money. It is the owner's
// to set, like the pay period (canSetPay), so the admin payroll card and the admin views of it are the owner's and the
// named pay viewers': anyone else gets the admin views without it, and their save keeps the stored payroll block
// (updateSettings keepPayroll, which also binds the save to the read it took that block from).
const withoutTrainingRate = value => Array.isArray(value) ? value.map(withoutTrainingRate)
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'trainingHourlyRate').map(([key, item]) => [key, withoutTrainingRate(item)])) : value;
async function updateSettingsFor(store, admin, body, nowIso, env) {
  const saved = await updateSettings(store, admin, body || {}, nowIso, { keepPayroll: !canSetPay(admin, env) });
  return seesOthersPay(admin, env) ? saved : withoutTrainingRate(saved);
}
import { officeWalkthroughs } from '../_lib/knock-walkthroughs.js';

// KNOCK-BRIDGE (EGC_KNOCK_JOB_BRIDGE): book (or retry booking) a door sale's Hub job or a door walkthrough from Admin.
const bridged = run => async (store, admin, body, nowIso, env, { dispatch = dispatchStorage } = {}) => {
  if (!knockJobBridgeEnabled(env)) throw knockFailure('Booking from canvassing is not turned on.', 404, 'knock_bridge_off');
  return run(store, dispatch(env), body.saleId || body.walkthroughId, { env, now: new Date(nowIso), rep: null });
};

// KNOCK-BRIDGE: a cancelled or reinstated sale's Hub job follows it (the answer adds hub: what happened to the job; a
// reinstated sale with no Hub job is booked). Running the same status again (Try again) retries what failed.
async function saleStatus(store, admin, body, nowIso, env, { dispatch = dispatchStorage } = {}) {
  let result = await setSaleStatus(store, admin, body, nowIso);
  if (knockJobBridgeEnabled(env)) {
    const followed = await followSaleStatus(store, dispatch(env), result.sale, { now: new Date(nowIso), env });
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
  return { settings, channels: await channelEarnings({ kstore: store, dispatch: dispatch(env), env, terms, nowMs: now.getTime(), period: periodFromParams(params, settings, now.getTime()), payroll: settings.payroll }) };
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
  async settings(store, _params, _now, env, viewer) {
    const view = await readSettings(store, viewer), payrollEditable = canSetPay(viewer, env);
    if (seesOthersPay(viewer, env)) return { ...view, payrollEditable };
    return withoutTrainingRate({ ...view, payrollEditable });
  },
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
  async money(store, params, now, env, viewer, { dispatch = dispatchStorage } = {}) {
    const { settings, channels } = await statementChannels(store, params, now, env, dispatch);
    // exportAllowed: whether this viewer may download the pay files (view=export), so the screen offers them only then.
    const view = await moneyView(store, params, now.getTime(), settings, { channels }), payShown = seesOthersPay(viewer, env);
    const { trainingHourlyRate, ...rest } = view;
    const shown = payShown ? view : { ...rest, statement: view.statement.map(statementWithoutPay), payouts: [], payroll: withoutTrainingRate(view.payroll), rates: withoutTrainingRate(view.rates) };
    return { ...shown, payShown, exportAllowed: canSetPay(viewer, env), payoutAllowed: canSetPay(viewer, env) };
  },
  async setters(store, _params, now, env, viewer, { dispatch = dispatchStorage } = {}) {
    const terms = await loadSetterTerms(store, await loadSettings(store)), payShown = seesOthersPay(viewer, env);
    const view = await setterAttributions(store, env, { nowMs: now.getTime(), terms, readJobs: setterBatchReaderFor(dispatch(env)) });
    return { ...view, rows: payShown ? view.rows : view.rows.map(setterWithoutPay), payShown, reps: await listReps(store) };
  },
  // D6b: every estimator's 7% (door-to-door-set walkthroughs and direct walkthrough sales signed in the last year).
  async estimators(store, _params, now, env, viewer, { dispatch = dispatchStorage } = {}) {
    const terms = await loadSetterTerms(store, await loadSettings(store)), payShown = seesOthersPay(viewer, env);
    const ledger = await estimatorLedger({ kstore: store, dispatch: dispatch(env), env, since: addDays(zonedDate(now.getTime()), -ESTIMATOR_LOOKBACK_DAYS), terms, nowMs: now.getTime() });
    return { rows: payShown ? ledger.rows : ledger.rows.map(withoutPay), payShown, truncated: ledger.truncated, terms: { verified: terms.verified, approvedAt: terms.approvedAt }, lookbackDays: ESTIMATOR_LOOKBACK_DAYS };
  },
  // Every kind (commission, training pay, sales with their commission) is a pay file: refused before anything is read.
  async export(store, params, now, env, viewer, { dispatch = dispatchStorage } = {}) {
    if (!canSetPay(viewer, env)) throw knockFailure('Only the owner downloads canvassing pay files.', 403, 'knock_pay_owner_only');
    const { settings, channels } = (params.get('kind') || 'commission') === 'commission' ? await statementChannels(store, params, now, env, dispatch) : { settings: await loadSettings(store), channels: null };
    const { csv, filename } = await exportCsv(store, params, now.getTime(), settings, { channels });
    return csvResponse(filename, csv);
  },
};

const ACTIONS = {
  'rep.update': updateRep,
  'training.add': addTraining,
  // Payroll settings (training pay, pay period) are the owner's; everyone else's save keeps them (updateSettingsFor).
  'settings.update': updateSettingsFor,
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
  // Recording a rep's payout is the owner's (canSetPay), refused before anything is read or written.
  'payout.add': (store, admin, body, nowIso, env, options) => {
    if (!canSetPay(admin, env)) throw knockFailure('Only the owner records door-to-door payouts.', 403, 'knock_pay_owner_only');
    return addPayout(store, admin, body, nowIso, env, options);
  },
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
