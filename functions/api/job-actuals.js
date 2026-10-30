/** Job actuals (owner report): every completed job in the last 90 Denver days with billed versus actual man-hours,
 * truck loads, goods at retail, commission by channel and an estimated margin. Rules: functions/_lib/job-actuals.js;
 * cost settings: functions/_lib/job-actuals-settings.js. Session cookie: business accounts read; only the owner saves
 * the cost settings. Hub > Job actuals (employee-job-actuals.js) shows it.
 * GET /api/job-actuals => {ok, window, rates, totals:{last30,last90}, rows, estimatorAccuracy (estimator-accuracy.js: estimated vs
 *   actual man-hours per job and a 30/90-day scorecard per estimator, hours only), settings:{...,revision,complete,missing},
 *   canEdit, commissionShown, sources:{timecards:'ok'|'unavailable'}, laborCoverage}. Labor is costed at the flat loaded
 *   wage, never an employee's own rate. Commission lines, the commission totals and rates, and the contribution after
 *   commission go to the owner only (jobActualsForViewer, FUNNEL-METRICS §8.3): with estimator accuracy naming the
 *   estimator, a job's commission is that person's pay.
 * POST {action:'job_actuals.settings.set', requestId, expectedRevision, settings} (owner) => {ok, settings, requestId, replayed}.
 * EGC_WINTER_SALE (winter-sale.js): GET also answers winterSale:{enabled:true, settings:{amountCents, signBy,
 *   jobFrom, jobTo, marginFloorBp (owner only), revision, ...}}; POST {action:'winter_sale.settings.set', requestId, expectedRevision,
 *   settings} (owner) saves them => {ok, winterSale, canEdit, requestId, replayed}. Flag off: neither exists.
 * Errors: {ok:false, code, error}; 400, 401, 403, 409 revision/idempotency, 413, 415, 503 retry the same request. */
import { getHubSession, isHubOwner } from '../_lib/hub-session.js';
import { dispatchStorage } from '../_lib/dispatch-storage.js';
import { createKnockStore } from '../_lib/knock-store.js';
import { approvedGarageQuote, approvedWalkthroughQuote, directSalesFor, paidWalkthroughJob, repRanWalkthrough, setterBatchReaderFor, signedGarageHandoff } from '../_lib/knock-setters.js';
import { MONEY_JOB_FIELDS } from '../_lib/money-storage.js';
import { hubEligibilityFields } from '../_lib/funnel-definitions.js';
import { denverWorkDate, overtimePolicy } from '../_lib/timesheet-week.js';
import { addDays } from '../_lib/dispatch-time.js';
import { computeJobLaborCost } from '../_lib/job-labor-cost.js';
import { buildJobActuals, jobActualsForViewer, jobActualsWindow } from '../_lib/job-actuals.js';
import { ESTIMATOR_FIELDS, buildEstimatorAccuracy } from '../_lib/estimator-accuracy.js';
import { jobActualsSettingsStorage, mutateJobActualsSettings, readJobActualsSettings, requireJobActualsOwner, requireJobActualsViewer } from '../_lib/job-actuals-settings.js';
import { readJobCostingTimecards } from './job-costing.js';
import { WINTER_SALE_SETTINGS_ACTION, mutateWinterSaleSettings, readWinterSaleSettings, winterSaleEnabled, winterSaleSettingsStorage } from '../_lib/winter-sale.js';

const LIMIT = 8000;
const ID = /^[A-Za-z0-9_-]{1,180}$/;
export const JOB_ACTUALS_FIELDS = Object.freeze([...new Set([...MONEY_JOB_FIELDS, ...hubEligibilityFields(), 'sourceWalkthroughId', 'acceptance.recordedBy', 'acceptance.firstRecordedBy', 'jobInstructions.laborManHours',
  // Which walkthrough jobs the commission ledgers pay (knock-setters.js paidWalkthroughJob, signedGarageHandoff).
  'handoffVersion', 'handoffRequestId', 'scope.finish', 'quoteDraft.sourceWalkthroughId',
  'compositeQuote.breakdown.labor.manHours', 'compositeQuote.breakdown.lines', 'quoteDraft.breakdown.source', 'quoteDraft.breakdown.labor.manHours', 'quoteDraft.breakdown.lines', 'fieldExecution.completion.crewOnSite', 'fieldExecution.completion.truckLoads', ...ESTIMATOR_FIELDS])]);
const reply = (status, body) => Response.json(body, { status, headers: { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } });
function sameOrigin(request) {
  if (request.headers.get('Sec-Fetch-Site') === 'cross-site') return false;
  const source = request.headers.get('Origin') || request.headers.get('Referer');
  if (!source) return true; // SameSite=Strict signed cookie remains required.
  try { return new URL(source).origin === new URL(request.url).origin; } catch { return false; }
}
function errorResponse(error) {
  if (/^(job_actuals|winter_sale)_/.test(error?.code || '')) return reply(error.status || 503, { ok: false, code: error.code, error: error.message, ...(error.details ? { details: error.details } : {}) });
  return reply(503, { ok: false, code: 'job_actuals_unavailable', error: 'Job actuals could not be loaded. Retry in a moment.' });
}
const settingsView = (settings, session) => ({ settings, canEdit: isHubOwner(session) });

export function jobActualsHandlers({ session = getHubSession, dispatch = dispatchStorage, knock = createKnockStore, timecards = readJobCostingTimecards, settingsStore = jobActualsSettingsStorage, saleStore = winterSaleSettingsStorage, now = () => new Date() } = {}) {
  return {
    async get({ request, env }) {
      try {
        const actor = await session(request, env); requireJobActualsViewer(actor);
        if ([...new URL(request.url).searchParams.keys()].length) return reply(400, { ok: false, code: 'job_actuals_request_invalid', error: 'Job actuals take no query options.' });
        const at = now(), asOf = at.toISOString(), window = jobActualsWindow(denverWorkDate(asOf));
        const [jobs, settings] = await Promise.all([dispatch(env).datedJobs(window.start, addDays(window.end, -1), [...JOB_ACTUALS_FIELDS]), readJobActualsSettings(settingsStore(env))]);
        // Timecards are the best actual-hours signal; when they cannot be read the crew lead's count still shows, flagged.
        let labor = { jobs: [] }, timecardSource = 'ok';
        try { labor = computeJobLaborCost({ timecards: await timecards(env), policy: overtimePolicy(env), start: window.start, end: window.end, laborCostHidden: true, now: asOf }); }
        catch { timecardSource = 'unavailable'; }
        const kstore = knock(env), walkthroughs = [...new Set(jobs.map(job => job.sourceWalkthroughId).filter(id => ID.test(String(id || ''))))];
        const [setters, sales] = await Promise.all([walkthroughs.length ? kstore.getMany('knock_setters', walkthroughs) : new Map(), directSalesFor(kstore, jobs.map(job => job.id))]);
        // The commission the ledgers will pay, no more (job-actuals.js channelOf): a quote approved online is paid by its
        // walkthrough's date and estimator (one masked read of those walkthroughs), and the office's junk-removal
        // classification of a direct walkthrough sale pays nothing.
        const online = jobs.filter(job => ID.test(String(job.sourceWalkthroughId || '')) && approvedWalkthroughQuote(job));
        const visits = online.length ? await setterBatchReaderFor(dispatch(env))(online.map(job => job.sourceWalkthroughId)) : new Map();
        const unclassified = jobs.filter(job => ID.test(String(job.sourceWalkthroughId || '')) && !setters.get(job.sourceWalkthroughId) && !signedGarageHandoff(job) && !approvedGarageQuote(job)).map(job => job.id);
        const offices = unclassified.length ? await kstore.getMany('knock_estimator_jobs', unclassified) : new Map();
        const unpaidJobs = new Set(jobs.filter(job => ID.test(String(job.sourceWalkthroughId || '')) && (!paidWalkthroughJob(job, visits.get(job.sourceWalkthroughId))
          || (setters.get(job.sourceWalkthroughId) || offices.get(job.id))?.serviceClassification === 'junk_removal')).map(job => job.id));
        const report = buildJobActuals({ jobs, labor, settings, setterWalkthroughs: new Set([...setters.keys()].filter(id => setters.get(id))), doorSaleJobs: new Set(sales.map(sale => sale?.handoff?.job?.ref).filter(Boolean)),
          repWalkthroughJobs: new Set(jobs.filter(job => !unpaidJobs.has(job.id) && repRanWalkthrough(setters.get(job.sourceWalkthroughId), job, visits.get(job.sourceWalkthroughId) || null)).map(job => job.id)),
          unpaidJobs, timecardsAvailable: timecardSource === 'ok', today: window.today, asOf });
        // EGC_WINTER_SALE: the owner's sale settings (amount, dates, margin floor) beside the cost settings.
        // The margin floor is the owner's alone: a manager sees the sale's terms without it.
        const saleView = settings => { if (isHubOwner(actor)) return settings; const { marginFloorBp, ...rest } = settings; return rest; };
        // A sale settings record that fails verification hides only the sale card (settings null, its plain reason), never the report.
        let sale = {};
        if (winterSaleEnabled(env)) {
          try { sale = { winterSale: { enabled: true, settings: saleView(await readWinterSaleSettings(saleStore(env))) } }; }
          catch (error) { if (error?.code !== 'winter_sale_settings_unreadable') throw error; sale = { winterSale: { enabled: true, settings: null, error: error.message } }; }
        }
        // Estimator accuracy (estimator-accuracy.js): the same jobs and hours, scored per estimator; nothing more is read.
        const estimatorAccuracy = buildEstimatorAccuracy({ rows: report.rows, jobs, setters, shortStart: report.window.shortStart });
        // Commission lines and totals are the owner's only (jobActualsForViewer); accuracy above is hours only.
        return reply(200, { ...jobActualsForViewer(report, { owner: isHubOwner(actor) }), estimatorAccuracy, ...settingsView(settings, actor), ...sale, sources: { timecards: timecardSource } });
      } catch (error) { return errorResponse(error); }
    },
    async post({ request, env }) {
      if (!sameOrigin(request)) return reply(403, { ok: false, code: 'job_actuals_origin_forbidden', error: 'Open Job actuals in the Employee Hub to save cost settings.' });
      try {
        const actor = await session(request, env); requireJobActualsOwner(actor);
        if (request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json') return reply(415, { ok: false, code: 'job_actuals_json_required', error: 'Cost settings must be submitted as JSON.' });
        if (Number(request.headers.get('Content-Length')) > LIMIT) return reply(413, { ok: false, code: 'job_actuals_request_too_large', error: 'The cost-settings request is too large.' });
        const raw = await request.text();
        if (new TextEncoder().encode(raw).byteLength > LIMIT) return reply(413, { ok: false, code: 'job_actuals_request_too_large', error: 'The cost-settings request is too large.' });
        let input; try { input = JSON.parse(raw); } catch { return reply(400, { ok: false, code: 'job_actuals_json_invalid', error: 'The cost-settings request was incomplete. Reload and try again.' }); }
        if (winterSaleEnabled(env) && input?.action === WINTER_SALE_SETTINGS_ACTION) {
          const sale = await mutateWinterSaleSettings(saleStore(env), actor, input, now().toISOString());
          return reply(200, { ok: true, winterSale: { enabled: true, settings: sale.settings }, canEdit: isHubOwner(actor), requestId: sale.requestId, replayed: sale.replayed });
        }
        const result = await mutateJobActualsSettings(settingsStore(env), actor, input, now().toISOString());
        return reply(200, { ok: true, ...settingsView(result.settings, actor), requestId: result.requestId, replayed: result.replayed });
      } catch (error) { return errorResponse(error); }
    },
  };
}

const handlers = jobActualsHandlers();
export const onRequestGet = handlers.get;
export const onRequestPost = handlers.post;
